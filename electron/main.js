const { app, BrowserWindow, Menu, ipcMain, screen, session, shell, systemPreferences } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
// pose.js attaches to globalThis when there is no window, so main can reuse the
// exact geometry the overlay matches with. A second implementation here would be
// free to disagree with the one that actually decides what fires.
require("../public/pose.js");
const { templateDistance, templateAngle, SEPARATION_FACTOR, ADVISORY_FACTOR } = globalThis.AirCursorPose;
const helperSource = app.isPackaged
  ? path.join(process.resourcesPath, "native", "AirCursorPointer.swift")
  : path.join(root, "native", "AirCursorPointer.swift");
const voiceSource = app.isPackaged
  ? path.join(process.resourcesPath, "native", "AirCursorVoice.swift")
  : path.join(root, "native", "AirCursorVoice.swift");
const voiceInfoSource = app.isPackaged
  ? path.join(process.resourcesPath, "native", "AirCursorVoiceInfo.plist")
  : path.join(root, "native", "AirCursorVoiceInfo.plist");

let dashboardWindow;
let overlayWindow;
let pointerHelper;
let voiceHelper;
let voiceBuffer = "";
let voiceStatus = "等待";
let quitting = false;
let systemCursorHidden = false;
let recordingSession = null;
// Everything about the process that actually delivers clicks. Without this a
// dead helper is indistinguishable from a gesture that never matched: the
// overlay draws its own click animation and returns, so the UI looks identical
// either way. Three real reports were spent on the CV layer because of that.
let pointerHealth = {
  state: "starting",
  detail: "尚未启动",
  binary: null,
  compiled: null,
  trusted: null,
  sent: 0,
  failed: 0,
  lastError: null,
  startedAt: null,
  exitedAt: null,
  exits: 0,
};

const defaultSettings = {
  overlayVisible: true,
  showHands: false,
  controlEnabled: false,
  voiceEnabled: true,
  twoHands: true,
  effects: "balanced",
  gestureMap: {
    wake: "openPalm",
    click: "pinch",
    rightClick: "middlePinch",
    exit: "fist",
  },
  recordedGestures: {},
  diagnostics: false,
  tuning: {
    minCutoff: 1.2,
    beta: 0.045,
    deadzone: 1.6,
    prediction: 0.35,
    matchThreshold: 0.28,
    rotationTolerance: 20,
    inferenceIntervalMs: 20,
    moveIntervalMs: 8,
    // Palm tilt, in degrees from the recorded pose, that emits one scroll notch.
    // Clamped at use against the rotation tolerance: past that the tilted pose
    // stops matching its own template, so a larger value here would make the
    // gesture vanish exactly when it should fire (see motion.js).
    scrollTriggerDeg: 16,
    // Screenfuls-ish per notch is decided in the helper; this is how many
    // notches one tilt sends, so a single flick can move more than one step.
    scrollNotches: 3,
    // Wrist speed, palm widths per second, for a sideways stroke to count as a
    // desktop switch.
    swipeSpeed: 2.6,
  },
};
let settings = JSON.parse(JSON.stringify(defaultSettings));
let latestMetrics = null;
let metricsLog = [];

const ruleDefinitions = [
  {
    id: "open_netease",
    label: "打开网易云音乐",
    voice: "打开网易云 / 打开音乐",
    candidates: [
      ["/Applications/NeteaseMusic.app"],
      ["-b", "com.netease.163music"],
      ["-a", "NeteaseMusic"],
      ["-a", "网易云音乐"],
    ],
  },
  {
    id: "open_wechat",
    label: "打开微信",
    voice: "打开微信",
    candidates: [
      ["/Applications/WeChat.app"],
      ["-b", "com.tencent.xinWeChat"],
      ["-a", "WeChat"],
      ["-a", "微信"],
    ],
  },
  {
    id: "open_chrome",
    label: "打开 Chrome",
    voice: "打开浏览器 / 打开 Chrome",
    candidates: [["/Applications/Google Chrome.app"], ["-a", "Google Chrome"], ["-a", "Chrome"]],
  },
  {
    id: "open_safari",
    label: "打开 Safari",
    voice: "打开 Safari",
    candidates: [["-a", "Safari"]],
  },
  {
    id: "open_finder",
    label: "打开访达",
    voice: "打开访达 / 打开 Finder",
    candidates: [["-a", "Finder"]],
  },
  {
    id: "open_terminal",
    label: "打开终端",
    voice: "打开终端 / 打开 Terminal",
    candidates: [["-a", "Terminal"], ["-a", "终端"]],
  },
  {
    id: "open_cursor",
    label: "打开 Cursor",
    voice: "打开 Cursor",
    candidates: [["/Applications/Cursor.app"], ["-a", "Cursor"]],
  },
];

const publicRules = ruleDefinitions.map(({ id, label, voice }) => ({ id, label, voice }));

// Pointer actions have a built-in gesture to fall back on; rules only ever fire
// from a recorded one, so they have no default and get removed on clear.
// `drag` is its own action rather than a long `click`: holding the mouse button
// down is a distinct intent (move a file, select text), and inferring it from
// "click pose plus movement" collided with the motion gestures — those move the
// hand on purpose, so any pose still matching click would have started a drag.
//
// `scroll` and `spaceSwitch` are motion gestures: the pose only selects which
// control law is active, and the movement afterwards decides what happens. They
// need an axis to measure tilt against, so a pose with no usable axis (mirrored
// two-hand) is refused for `scroll` at record time.
const coreActions = ["wake", "click", "drag", "rightClick", "scroll", "spaceSwitch", "exit"];
const ruleActions = ruleDefinitions.map((rule) => rule.id);
const recordableActions = [...coreActions, ...ruleActions];
const motionActions = ["scroll", "spaceSwitch"];
// Actions whose gesture must have a measurable rotation axis, because the action
// is driven by how far the pose tilts away from the recorded one.
const axisRequiredActions = ["scroll"];
const actionLabels = {
  wake: "唤醒控制",
  click: "点击",
  drag: "拖拽（按住不放）",
  rightClick: "右键",
  scroll: "上下滚动（手掌抬压）",
  spaceSwitch: "左右切换桌面（横向挥动）",
  exit: "退出控制",
  ...Object.fromEntries(ruleDefinitions.map((rule) => [rule.id, rule.label])),
};
// Motion gestures have no built-in pose: there is no sensible default palm shape
// for "scroll", and picking one would silently steal a pose from click or wake.
const defaultGestureMap = {
  wake: "openPalm",
  click: "pinch",
  rightClick: "middlePinch",
  exit: "fist",
};

// A spread can only add or overwrite keys, and clearing a rule's gesture has to
// remove one: leaving `open_chrome: null` behind would keep the entry alive in
// settings.json forever. An explicit null in a patch means delete.
function mergeMap(base, incoming) {
  const merged = { ...base, ...(incoming || {}) };
  for (const [key, value] of Object.entries(merged)) {
    if (value === null || value === undefined) delete merged[key];
  }
  return merged;
}

function mergeSettings(base, incoming) {
  return {
    ...base,
    ...incoming,
    gestureMap: mergeMap(base.gestureMap, incoming?.gestureMap),
    recordedGestures: mergeMap(base.recordedGestures, incoming?.recordedGestures),
    tuning: { ...base.tuning, ...(incoming?.tuning || {}) },
  };
}

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

// Superseded tuning defaults, per key. A saved file always wins over a new
// default — that is what makes a slider stick — but a value the user never chose
// is not a preference, it is the old default frozen in place. `matchThreshold`
// moved 0.22 -> 0.28 when the distance metric started weighting the worst finger,
// and a real report came back still running 0.22 with its closest frame at 0.239:
// every pose was a near miss, on a version whose default would have matched.
//
// So a saved value equal to a superseded default is replaced; anything else,
// including a deliberate 0.22 set after this ships, is left alone.
const supersededTuning = { matchThreshold: [0.22] };

function migrateTuning(saved) {
  const tuning = saved?.tuning;
  if (!tuning) return saved;
  for (const [key, oldDefaults] of Object.entries(supersededTuning)) {
    if (oldDefaults.includes(tuning[key])) delete tuning[key];
  }
  return saved;
}

// Angle 0 used to mean both "points right" and "has no usable axis" (see
// poseAngle). Templates saved under that ambiguity are re-derived from their own
// landmarks, so a two-hand pose whose axis cancels stops being de-rotated by the
// difference to a live frame's real angle — which is what made a held two-hand
// gesture show up on the status line and still never fire.
function migrateRecordedTemplates(saved) {
  for (const entry of Object.values(saved?.recordedGestures || {})) {
    if (!entry?.template || entry.template.angle !== 0) continue;
    entry.template.angle = templateAngle(entry.template);
  }
  return saved;
}

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    settings = mergeSettings(defaultSettings, migrateRecordedTemplates(migrateTuning(saved)));
  } catch {
    settings = JSON.parse(JSON.stringify(defaultSettings));
  }
}

function saveSettings() {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

// Keyed on the source contents, NOT on the app version.
//
// Version-keying (v0.2.16-v0.3.1) meant every release wrote a brand-new binary
// path even when the Swift source was byte-identical. On macOS the Accessibility
// grant is per-binary, so each bump silently dropped the permission that makes
// CGEvent.post work — the helper still ran and still posted events, and the
// system discarded every one of them. That is why clicking worked on v0.2.x and
// then "stopped working" with no error: nothing was broken in the CV layer.
// Hashing the source means an unchanged helper keeps one path (and one grant)
// forever, and a genuinely edited helper gets a new one exactly once.
function helperBinaryPath(binaryName, ...sources) {
  const hash = crypto.createHash("sha256");
  for (const file of sources) hash.update(fs.readFileSync(file));
  return path.join(app.getPath("userData"), `${binaryName}-${hash.digest("hex").slice(0, 12)}`);
}

function compilePointerHelper() {
  const helperBinary = helperBinaryPath("AirCursorPointer", helperSource);
  // Existence is the whole gate: the path already encodes the source contents,
  // so a file at that path cannot be stale. mtime comparison would rebuild on
  // every `git checkout`, which is what made this churn constantly.
  if (fs.existsSync(helperBinary)) return { helperBinary, compiled: false };

  const result = spawnSync("/usr/bin/swiftc", [helperSource, "-o", helperBinary], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || "swiftc 编译 AirCursorPointer 失败");
  }

  return { helperBinary, compiled: true };
}

function setPointerHealth(patch) {
  pointerHealth = { ...pointerHealth, ...patch };
  broadcast("aircursor:pointer-health", pointerHealth);
}

// Reports whether this process may post synthetic events at all. Without the
// Accessibility grant CGEvent.post is silently dropped by the OS: the helper
// sees no error, so this is the only place the truth is available.
function refreshTrustState() {
  if (process.platform !== "darwin") return true;
  const trusted = systemPreferences.isTrustedAccessibilityClient(false);
  if (trusted !== pointerHealth.trusted) {
    setPointerHealth({
      trusted,
      ...(trusted
        ? {}
        : { state: "untrusted", detail: "缺少辅助功能权限：点击不会生效，请在系统设置里勾选后重启 AirCursor" }),
    });
  }
  return trusted;
}

function startPointerHelper() {
  let helperBinary;
  let compiled;
  try {
    ({ helperBinary, compiled } = compilePointerHelper());
  } catch (error) {
    // Used to throw out of app.whenReady() and leave pointerHelper undefined
    // forever, so every later click threw inside an ipcMain handler where
    // nothing was listening. The UI kept drawing click animations regardless.
    setPointerHealth({
      state: "compile-failed",
      detail: `编译失败：${error.message}`,
      lastError: error.message,
      binary: null,
    });
    return false;
  }

  try {
    pointerHelper = spawn(helperBinary, [], { stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    setPointerHealth({
      state: "spawn-failed",
      detail: `无法启动 helper：${error.message}`,
      lastError: error.message,
      binary: helperBinary,
    });
    return false;
  }

  setPointerHealth({
    state: "running",
    detail: compiled ? "helper 已重新编译并启动" : "helper 已启动（复用已授权的二进制）",
    binary: helperBinary,
    compiled,
    lastError: null,
    startedAt: Date.now(),
  });

  if (systemCursorHidden) {
    pointerHelper.stdin.write(`${JSON.stringify({ type: "hideCursor" })}\n`);
  }
  // The helper answers a ping with its AXIsProcessTrusted() verdict, so "can we
  // actually click" is a fact from the process that posts the events rather than
  // an inference from this side of the pipe.
  pointerHelper.stdin.write(`${JSON.stringify({ type: "ping" })}\n`);
  pointerHelper.stdout.on("data", (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      const text = line.trim();
      if (!text.startsWith("{")) continue;
      try {
        const message = JSON.parse(text);
        if (message.type === "pong") {
          setPointerHealth({
            trusted: Boolean(message.trusted),
            ...(message.trusted
              ? { state: "running", detail: "helper 正常，已获辅助功能权限" }
              : {
                  state: "untrusted",
                  detail: "helper 在运行，但缺少辅助功能权限：系统会丢弃所有点击事件",
                }),
          });
        }
      } catch {
        // A malformed line is not worth killing the pipe over.
      }
    }
  });
  pointerHelper.stderr.on("data", (chunk) => {
    const message = chunk.toString().trim();
    setPointerHealth({ lastError: message });
    broadcast("aircursor:helper-log", message);
  });
  pointerHelper.on("exit", (code, signal) => {
    pointerHelper = null;
    if (quitting) return;
    setPointerHealth({
      state: "exited",
      detail: `helper 退出（code ${code ?? "null"} / signal ${signal ?? "null"}）`,
      exitedAt: Date.now(),
      exits: pointerHealth.exits + 1,
    });
  });
  return true;
}

// Same contract as compilePointerHelper: the voice helper holds Microphone and
// Speech Recognition grants, which macOS also keys per binary. Rebuilding it at
// an mtime-triggered moment rewrote those bytes and dropped both grants, and
// mtime moves on every `git checkout` — so the source contents decide the path
// here too, and existence alone decides whether to build.
function compileSwiftHelper(source, binaryName) {
  const extraInputs = binaryName === "AirCursorVoice" ? [voiceInfoSource] : [];
  const helperBinary = helperBinaryPath(binaryName, source, ...extraInputs);
  if (fs.existsSync(helperBinary)) return helperBinary;

  const args = [source, "-o", helperBinary];
  if (binaryName === "AirCursorVoice") {
    args.push("-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", voiceInfoSource);
  }

  const result = spawnSync("/usr/bin/swiftc", args, {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || `Failed to compile ${binaryName}.`);
  }

  return helperBinary;
}

function startVoiceHelper() {
  if (process.platform !== "darwin") return;

  let helperBinary;
  try {
    helperBinary = compileSwiftHelper(voiceSource, "AirCursorVoice");
  } catch (error) {
    voiceStatus = `系统语音不可用：${error.message}`;
    broadcast("aircursor:overlay-status", { voice: voiceStatus });
    return;
  }

  voiceHelper = spawn(helperBinary, [], { stdio: ["ignore", "pipe", "pipe"] });
  voiceHelper.stdout.on("data", (chunk) => {
    voiceBuffer += chunk.toString();
    const lines = voiceBuffer.split(/\r?\n/);
    voiceBuffer = lines.pop() || "";
    for (const line of lines) {
      const phrase = line.trim();
      if (!phrase) continue;
      if (phrase === "__AIRCURSOR_VOICE_READY__") {
        voiceStatus = "macOS 语音已开启";
        broadcast("aircursor:overlay-status", { voice: voiceStatus });
      } else if (phrase.startsWith("__AIRCURSOR_VOICE_ERROR__:")) {
        voiceStatus = phrase.replace("__AIRCURSOR_VOICE_ERROR__:", "");
        broadcast("aircursor:overlay-status", { voice: voiceStatus });
      } else if (phrase.startsWith("__AIRCURSOR_VOICE_HEARD__:")) {
        const heard = phrase.replace("__AIRCURSOR_VOICE_HEARD__:", "");
        voiceStatus = `听到：${heard}`;
        broadcast("aircursor:overlay-status", { voice: voiceStatus });
      } else if (phrase === "__AIRCURSOR_VOICE_TAP__") {
        voiceStatus = "听到：短促确认";
        broadcast("aircursor:overlay-status", { voice: voiceStatus });
        broadcast("aircursor:voice-command", "点");
      } else {
        broadcast("aircursor:voice-command", phrase);
      }
    }
  });
  voiceHelper.stderr.on("data", (chunk) => {
    voiceStatus = chunk.toString().trim();
    broadcast("aircursor:overlay-status", { voice: voiceStatus });
  });
  voiceHelper.on("exit", () => {
    voiceHelper = null;
  });
}

// Returns whether the command reached the helper's stdin. Callers used to get no
// signal at all: this threw a TypeError inside an ipcMain listener when the
// helper was missing, which Electron swallows, so a completely dead pointer
// pipeline looked exactly like a working one from the renderer.
function sendPointer(command) {
  if (!pointerHelper || pointerHelper.killed) {
    if (!startPointerHelper()) {
      pointerHealth.failed += 1;
      return false;
    }
  }
  try {
    pointerHelper.stdin.write(`${JSON.stringify(command)}\n`);
    pointerHealth.sent += 1;
    return true;
  } catch (error) {
    setPointerHealth({
      state: "write-failed",
      detail: `写入 helper 失败：${error.message}`,
      lastError: error.message,
      failed: pointerHealth.failed + 1,
    });
    return false;
  }
}

function setSystemCursorHidden(hidden) {
  if (systemCursorHidden === hidden) return;
  systemCursorHidden = hidden;
  sendPointer({ type: hidden ? "hideCursor" : "showCursor" });
}

function broadcast(channel, payload) {
  for (const win of [dashboardWindow, overlayWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function syncSettings() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send("aircursor:settings", settings);
    if (settings.overlayVisible) overlayWindow.showInactive();
    else overlayWindow.hide();
  }
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send("aircursor:settings", settings);
    // Sent alongside settings rather than computed in the renderer: the geometry
    // and the threshold both live here, and a conflict has to surface the moment
    // it exists, not when someone thinks to save a report.
    dashboardWindow.webContents.send("aircursor:gesture-conflicts", gestureConflicts());
  }
}

function updateSettings(patch) {
  const previousControlEnabled = settings.controlEnabled;
  settings = mergeSettings(settings, patch);
  if (settings.controlEnabled !== previousControlEnabled) {
    setSystemCursorHidden(settings.controlEnabled);
    // Turning control on is the moment the permission starts mattering, and it
    // is also when the user is most likely to have just granted it.
    if (settings.controlEnabled) refreshTrustState();
  }
  saveSettings();
  syncSettings();
  return settings;
}

// Recording needs both hands visible with the skeleton on, whatever the user's
// normal settings are; the previous values come back when the session ends.
function beginRecording(action, hands) {
  if (!recordableActions.includes(action)) return { ok: false, reason: "未知动作" };
  if (recordingSession) endRecording();

  recordingSession = {
    action,
    hands,
    restore: { twoHands: settings.twoHands, showHands: settings.showHands, controlEnabled: settings.controlEnabled },
  };
  updateSettings({ overlayVisible: true, showHands: true, twoHands: hands > 1 || settings.twoHands, controlEnabled: false });
  broadcast("aircursor:recording", { type: "start", action, hands });
  return { ok: true, action, hands };
}

function endRecording() {
  const session = recordingSession;
  recordingSession = null;
  if (!session) return;
  broadcast("aircursor:recording", { type: "stop", action: session.action });
  updateSettings(session.restore);
}

// A tilt-driven action measures the live pose's axis against the template's, so
// a template with no axis makes the action unmeasurable — and it would fail the
// way this project has already been bitten by three times: pose recognised,
// nothing happens, nothing to look at. Two mirrored hands cancel to no axis
// (poseAngle returns null), and both two-hand templates in the last real report
// were exactly that, so this is the common case for two-hand recordings rather
// than an edge case. Refuse at save time, while the user still knows what they
// just held.
function axisRejection(action, template) {
  if (!axisRequiredActions.includes(action)) return null;
  if (Number.isFinite(template?.angle)) return null;
  return "这个动作靠手掌抬压的角度触发，但刚录的姿势测不出方向轴（双手镜像姿势会互相抵消）。换一个单手姿势，或让两手不对称。";
}

function saveRecordedTemplate(action, template) {
  if (!recordableActions.includes(action)) return;
  updateSettings({
    gestureMap: { [action]: `custom:${action}` },
    recordedGestures: {
      [action]: { at: Date.now(), hands: template.hands, template },
    },
  });
}

// Templates that are too close to each other are the one fault that looks like
// every other fault: the action fires, just the wrong one. The report says so
// outright rather than leaving it to be inferred from distances, because the
// symptom the user reports will be "click does nothing".
function gestureConflicts() {
  const bound = Object.entries(settings.recordedGestures || {})
    .filter(([action, entry]) => entry?.template && settings.gestureMap?.[action] === `custom:${action}`)
    .map(([action, entry]) => ({ action, template: entry.template }));
  const tolerance = ((settings.tuning?.rotationTolerance || 0) * Math.PI) / 180;
  const threshold = settings.tuning?.matchThreshold ?? defaultSettings.tuning.matchThreshold;
  const conflicts = [];
  for (let i = 0; i < bound.length; i += 1) {
    for (let j = i + 1; j < bound.length; j += 1) {
      const distance = templateDistance(bound[i].template, bound[j].template, tolerance);
      if (!Number.isFinite(distance) || distance >= threshold * ADVISORY_FACTOR) continue;
      conflicts.push({
        actions: [bound[i].action, bound[j].action],
        labels: [actionLabels[bound[i].action] || bound[i].action, actionLabels[bound[j].action] || bound[j].action],
        distance: Number(distance.toFixed(3)),
        needs: Number((threshold * ADVISORY_FACTOR).toFixed(3)),
        // Below 1x the two are within the drift of one held pose, so which one
        // fires is effectively arbitrary. Between 1x and 2x the resolver still
        // picks the nearer template; it is just no longer provably right.
        severity: distance < threshold * SEPARATION_FACTOR ? "blocking" : "advisory",
      });
    }
  }
  return conflicts;
}

// Counts of why each motion gesture was blocked, over the sample window, plus
// how far the tilt actually got. "It never fired" needs the reason to be
// actionable, and the reason changes frame to frame.
function motionSummary(samples) {
  const frames = samples.map((s) => s.motion).filter(Boolean);
  if (!frames.length) return null;
  const tally = (key) => {
    const counts = {};
    for (const frame of frames) {
      const reason = frame[key] || "ok";
      counts[reason] = (counts[reason] || 0) + 1;
    }
    return counts;
  };
  const tilts = frames.map((f) => Math.abs(f.tiltDeg)).filter((v) => Number.isFinite(v));
  const speeds = frames.map((f) => f.wristSpeed).filter((v) => Number.isFinite(v));
  const last = frames[frames.length - 1];
  return {
    frames: frames.length,
    scrollBlocked: tally("scrollBlocked"),
    swipeBlocked: tally("swipeBlocked"),
    // Peak tilt against the trigger is the whole diagnosis for "scrolling never
    // happens": short of the trigger is a threshold problem, past it with nothing
    // firing is a latch or matching problem.
    maxTiltDeg: tilts.length ? Number(Math.max(...tilts).toFixed(1)) : null,
    triggerDeg: last?.triggerDeg ?? null,
    triggerClamped: Boolean(last?.clampedTrigger),
    maxWristSpeed: speeds.length ? Number(Math.max(...speeds).toFixed(2)) : null,
    scrollNotches: last?.scrollNotches ?? 0,
    swipes: last?.swipes ?? 0,
  };
}

// A tuning report is the unit of feedback from a real Mac: numbers plus the
// exact tuning that produced them, so a "feels laggy" observation arrives with
// the frame rate, pipeline latency and jitter that caused it.
function buildReport(note) {
  const samples = metricsLog.slice(-120);
  const field = (key) => samples.map((s) => s[key]).filter((v) => typeof v === "number");
  const stat = (key) => {
    const values = field(key);
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return {
      mean: Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)),
      min: Number(sorted[0].toFixed(2)),
      max: Number(sorted[sorted.length - 1].toFixed(2)),
      p95: Number(sorted[Math.min(sorted.length - 1, Math.round(0.95 * (sorted.length - 1)))].toFixed(2)),
    };
  };

  return {
    generatedAt: new Date().toISOString(),
    note: note || "",
    app: { version: app.getVersion(), packaged: app.isPackaged },
    system: { platform: process.platform, arch: process.arch, electron: process.versions.electron, chrome: process.versions.chrome },
    display: screen.getPrimaryDisplay().bounds,
    settings: { twoHands: settings.twoHands, effects: settings.effects, showHands: settings.showHands, controlEnabled: settings.controlEnabled },
    tuning: settings.tuning,
    gestureMap: settings.gestureMap,
    recordedGestures: Object.fromEntries(
      Object.entries(settings.recordedGestures || {}).map(([action, entry]) => [
        action,
        {
          hands: entry.hands,
          dims: entry.template?.values?.length,
          // The angle explains rotation-tolerance behaviour after the fact, so
          // it belongs in the report rather than only in settings.json.
          angle: entry.template?.angle,
          at: entry.at,
        },
      ]),
    ),
    gestureConflicts: gestureConflicts(),
    // The single most load-bearing fact in a "nothing happens" report, and the
    // one three earlier reports had no field for: whether the process that posts
    // the clicks is alive, and whether the OS will honour what it posts.
    pointer: { ...pointerHealth, trusted: refreshTrustState() },
    sampleCount: samples.length,
    metrics: {
      cameraFps: stat("cameraFps"),
      drawFps: stat("drawFps"),
      inferenceMs: stat("inferenceMs"),
      pipelineMs: stat("pipelineMs"),
      jitterPx: stat("jitterPx"),
      lagPx: stat("lagPx"),
      trackingRate: stat("trackingRate"),
      bothHandsRate: stat("bothHandsRate"),
      matchDistance: stat("matchDistance"),
      holdMs: stat("holdMs"),
      pointerEvents: stat("pointerEvents"),
    },
    // The motion gestures fail silently by nature: every blocked reason presents
    // as "the pose is recognised and nothing moves". A single `latest` snapshot
    // catches whatever the last frame happened to say, so the reasons seen across
    // the whole sample window are counted — a gesture that never fired because
    // the wrist was always moving looks completely different from one that was
    // never bound, and the tally distinguishes them without a live session.
    motion: motionSummary(samples),
    latest: latestMetrics,
  };
}

function writeReport(note) {
  const report = buildReport(note);
  const dir = path.join(app.getPath("userData"), "reports");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `aircursor-report-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  return { ok: true, file, report };
}

function openWithCandidates(candidates) {
  for (const args of candidates) {
    const result = spawnSync("/usr/bin/open", args, { stdio: "ignore" });
    if (result.status === 0) return true;
  }
  return false;
}

function runRule(ruleId) {
  const rule = ruleDefinitions.find((item) => item.id === ruleId);
  if (!rule) return { ok: false, id: ruleId, label: "未知规则" };

  const ok = openWithCandidates(rule.candidates);
  const result = { ok, id: rule.id, label: rule.label };
  broadcast("aircursor:overlay-status", {
    rule: `${ok ? "已执行" : "执行失败"}：${rule.label}`,
  });
  return result;
}

function quitApp() {
  quitting = true;
  app.quit();
}

// A destroyed window still answers to `?.`, so guard on isDestroyed or the
// shortcut throws instead of doing nothing.
function openDevTools(win, mode) {
  if (!win || win.isDestroyed()) return { ok: false, reason: "窗口不存在" };
  win.webContents.openDevTools({ mode });
  return { ok: true };
}

function createApplicationMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { label: "显示 AirCursor", accelerator: "CommandOrControl+0", click: showDashboard },
              { type: "separator" },
              { label: "退出 AirCursor", accelerator: "CommandOrControl+Q", click: quitApp },
            ],
          },
        ]
      : []),
    {
      label: "窗口",
      submenu: [
        { label: "显示 AirCursor", accelerator: "CommandOrControl+0", click: showDashboard },
        { type: "separator" },
        { role: "minimize", label: "最小化" },
        { label: "退出 AirCursor", accelerator: isMac ? undefined : "Alt+F4", click: quitApp },
      ],
    },
    {
      label: "调试",
      submenu: [
        {
          label: "诊断面板",
          accelerator: "CommandOrControl+D",
          click: () => {
            updateSettings({ diagnostics: !settings.diagnostics });
            showDashboard();
          },
        },
        {
          label: "保存调参报告",
          accelerator: "CommandOrControl+S",
          click: () => {
            const result = writeReport("menu");
            broadcast("aircursor:overlay-status", { rule: `报告已保存：${result.file}` });
          },
        },
        { type: "separator" },
        {
          label: "主窗口开发者工具",
          accelerator: "CommandOrControl+Alt+I",
          click: () => openDevTools(dashboardWindow, "right"),
        },
        {
          label: "透明层开发者工具",
          accelerator: "CommandOrControl+Alt+O",
          click: () => openDevTools(overlayWindow, "detach"),
        },
        { role: "reload", label: "重新加载" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createDashboardWindow() {
  dashboardWindow = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 880,
    minHeight: 640,
    show: false,
    title: "AirCursor",
    backgroundColor: "#f6f7fb",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  dashboardWindow.loadFile(path.join(root, "public", "dashboard.html"));
  dashboardWindow.once("ready-to-show", () => {
    dashboardWindow.show();
    syncSettings();
  });
  dashboardWindow.on("close", () => {
    if (!quitting) quitApp();
  });
}

function createOverlayWindow() {
  const bounds = screen.getPrimaryDisplay().bounds;

  overlayWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    fullscreenable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: "AirCursor Overlay",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.loadFile(path.join(root, "public", "overlay.html"));
  overlayWindow.once("ready-to-show", syncSettings);
  // Electron 36 replaced the positional (event, level, message, line, sourceId)
  // signature with a single details object and a string level. Accepting both
  // keeps the overlay console visible instead of silently going quiet.
  overlayWindow.webContents.on("console-message", (...args) => {
    const details = args[1] && typeof args[1] === "object" ? args[1] : null;
    const level = details ? details.level : args[1];
    const message = details ? details.message : args[2];
    const line = details ? details.lineNumber : args[3];
    const sourceId = details ? details.sourceId : args[4];
    const isError = level === "error" || level === "warning" || (typeof level === "number" && level >= 2);
    if (isError) {
      broadcast("aircursor:overlay-status", { camera: `Overlay: ${message}` });
    }
    if (settings.diagnostics && dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send("aircursor:overlay-log", {
        level: String(level),
        message,
        source: `${(sourceId || "").split("/").pop()}:${line ?? 0}`,
      });
    }
  });
}

function showDashboard() {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) createDashboardWindow();
  dashboardWindow.show();
  dashboardWindow.focus();
}

app.whenReady().then(() => {
  loadSettings();
  if (process.platform === "darwin") {
    app.setActivationPolicy?.("regular");
    app.dock?.show();
  }
  createApplicationMenu();

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media" || permission === "camera" || permission === "microphone");
  });

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => (
    permission === "media" || permission === "camera" || permission === "microphone"
  ));

  createDashboardWindow();
  createOverlayWindow();
  startPointerHelper();
  refreshTrustState();
  startVoiceHelper();

  app.on("activate", showDashboard);
});

app.on("before-quit", () => {
  quitting = true;
  setSystemCursorHidden(false);
  if (pointerHelper && !pointerHelper.killed) pointerHelper.kill();
  if (voiceHelper && !voiceHelper.killed) voiceHelper.kill();
});

app.on("window-all-closed", () => {
  app.quit();
});

ipcMain.handle("aircursor:get-state", () => ({
  settings,
  screen: screen.getPrimaryDisplay().bounds,
  rules: publicRules,
  status: { voice: voiceStatus },
  // A conflict recorded in an earlier run is still a conflict on launch, so the
  // dashboard must not have to wait for a settings change to hear about it.
  gestureConflicts: gestureConflicts(),
  pointer: { ...pointerHealth, trusted: refreshTrustState() },
}));
ipcMain.handle("aircursor:update-settings", (_event, patch) => {
  updateSettings(patch);
  return { settings };
});
ipcMain.handle("aircursor:start-recording", (_event, action, hands) => beginRecording(action, hands === 2 ? 2 : 1));
ipcMain.handle("aircursor:cancel-recording", () => {
  endRecording();
  return { ok: true };
});
ipcMain.handle("aircursor:clear-recorded-gesture", (_event, action) => {
  if (!recordableActions.includes(action)) {
    return { ok: false, reason: "未知动作" };
  }
  // Core actions fall back to their built-in gesture; a rule has none, so its
  // mapping goes away entirely and the rule becomes voice-only again.
  updateSettings({
    gestureMap: { [action]: defaultGestureMap[action] ?? null },
    recordedGestures: { [action]: null },
  });
  return { ok: true, settings };
});
ipcMain.handle("aircursor:get-rules", () => ({ rules: publicRules }));
ipcMain.handle("aircursor:run-rule", (_event, ruleId) => runRule(ruleId));
ipcMain.handle("aircursor:open-netease", () => runRule("open_netease"));
ipcMain.handle("aircursor:open-accessibility", () => {
  shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
  return { ok: true };
});
ipcMain.handle("aircursor:show-dashboard", () => {
  showDashboard();
  return { ok: true };
});
ipcMain.on("aircursor:pointer", (_event, command) => {
  sendPointer(command);
});
ipcMain.on("aircursor:overlay-status", (_event, status) => {
  broadcast("aircursor:overlay-status", status);
});
ipcMain.on("aircursor:metrics", (_event, payload) => {
  latestMetrics = payload;
  metricsLog.push(payload);
  if (metricsLog.length > 600) metricsLog.shift();
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send("aircursor:metrics", payload);
  }
});
ipcMain.handle("aircursor:write-report", (_event, note) => writeReport(note));
ipcMain.handle("aircursor:reveal-reports", () => {
  const dir = path.join(app.getPath("userData"), "reports");
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
  return { ok: true, dir };
});
ipcMain.handle("aircursor:reset-metrics", () => {
  metricsLog = [];
  latestMetrics = null;
  broadcast("aircursor:reset-metrics", {});
  return { ok: true };
});
ipcMain.handle("aircursor:open-devtools", (_event, target) => {
  const overlay = target === "overlay";
  return { ...openDevTools(overlay ? overlayWindow : dashboardWindow, overlay ? "detach" : "right"), target };
});
ipcMain.handle("aircursor:reset-tuning", () => {
  settings = { ...settings, tuning: { ...defaultSettings.tuning } };
  saveSettings();
  syncSettings();
  return { ok: true, settings };
});
ipcMain.on("aircursor:recording-progress", (_event, payload) => {
  if (!recordingSession) return;
  broadcast("aircursor:recording-progress", payload);
});
ipcMain.on("aircursor:recording-result", (_event, result) => {
  const session = recordingSession;
  if (!session || result?.action !== session.action) return;
  // Checked here rather than in the overlay: the overlay owns geometry, main
  // owns which actions exist and what they require.
  const axisReason = result.ok && result.template ? axisRejection(result.action, result.template) : null;
  const ok = Boolean(result.ok) && !axisReason;
  if (ok && result.template) saveRecordedTemplate(result.action, result.template);
  recordingSession = null;
  updateSettings(session.restore);
  // The overlay knows the geometry but not the labels, so it reports which
  // action clashed and main turns that into something readable.
  const reason = axisReason
    ? axisReason
    : result.conflictWith
      ? `与「${actionLabels[result.conflictWith] || result.conflictWith}」的手势太接近（距离 ${result.distance}），换一个差别更大的姿势`
      : result.reason;
  broadcast("aircursor:recording-result", {
    ok,
    action: result.action,
    reason,
    hands: result.template?.hands,
    settings,
  });
});
