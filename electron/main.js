const { app, BrowserWindow, Menu, ipcMain, screen, session, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
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
    matchThreshold: 0.22,
    inferenceIntervalMs: 20,
    moveIntervalMs: 8,
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

const recordableActions = ["wake", "click", "rightClick", "exit"];
const defaultGestureMap = {
  wake: "openPalm",
  click: "pinch",
  rightClick: "middlePinch",
  exit: "fist",
};

function mergeSettings(base, incoming) {
  return {
    ...base,
    ...incoming,
    gestureMap: { ...base.gestureMap, ...(incoming?.gestureMap || {}) },
    recordedGestures: { ...base.recordedGestures, ...(incoming?.recordedGestures || {}) },
    tuning: { ...base.tuning, ...(incoming?.tuning || {}) },
  };
}

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    settings = mergeSettings(defaultSettings, saved);
  } catch {
    settings = JSON.parse(JSON.stringify(defaultSettings));
  }
}

function saveSettings() {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

function helperBinaryPath(binaryName) {
  return path.join(app.getPath("userData"), `${binaryName}-${app.getVersion()}`);
}

function compilePointerHelper() {
  const helperBinary = helperBinaryPath("AirCursorPointer");
  const needsBuild =
    !fs.existsSync(helperBinary) ||
    fs.statSync(helperBinary).mtimeMs < fs.statSync(helperSource).mtimeMs;

  if (!needsBuild) return helperBinary;

  const result = spawnSync("/usr/bin/swiftc", [helperSource, "-o", helperBinary], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || "Failed to compile AirCursorPointer.");
  }

  return helperBinary;
}

function startPointerHelper() {
  const helperBinary = compilePointerHelper();
  pointerHelper = spawn(helperBinary, [], { stdio: ["pipe", "ignore", "pipe"] });
  if (systemCursorHidden) {
    pointerHelper.stdin.write(`${JSON.stringify({ type: "hideCursor" })}\n`);
  }
  pointerHelper.stderr.on("data", (chunk) => {
    broadcast("aircursor:helper-log", chunk.toString());
  });
  pointerHelper.on("exit", () => {
    pointerHelper = null;
  });
}

function compileSwiftHelper(source, binaryName) {
  const helperBinary = helperBinaryPath(binaryName);
  const extraInputs = binaryName === "AirCursorVoice" ? [voiceInfoSource] : [];
  const needsBuild =
    !fs.existsSync(helperBinary) ||
    fs.statSync(helperBinary).mtimeMs < fs.statSync(source).mtimeMs ||
    extraInputs.some((file) => fs.statSync(helperBinary).mtimeMs < fs.statSync(file).mtimeMs);

  if (!needsBuild) return helperBinary;

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

function sendPointer(command) {
  if (!pointerHelper || pointerHelper.killed) startPointerHelper();
  pointerHelper.stdin.write(`${JSON.stringify(command)}\n`);
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
  }
}

function updateSettings(patch) {
  const previousControlEnabled = settings.controlEnabled;
  settings = mergeSettings(settings, patch);
  if (settings.controlEnabled !== previousControlEnabled) {
    setSystemCursorHidden(settings.controlEnabled);
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

function saveRecordedTemplate(action, template) {
  if (!recordableActions.includes(action)) return;
  updateSettings({
    gestureMap: { [action]: `custom:${action}` },
    recordedGestures: {
      [action]: { at: Date.now(), hands: template.hands, template },
    },
  });
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
    recordedGestures: Object.fromEntries(
      Object.entries(settings.recordedGestures || {}).map(([action, entry]) => [
        action,
        { hands: entry.hands, dims: entry.template?.values?.length, at: entry.at },
      ]),
    ),
    sampleCount: samples.length,
    metrics: {
      cameraFps: stat("cameraFps"),
      drawFps: stat("drawFps"),
      inferenceMs: stat("inferenceMs"),
      pipelineMs: stat("pipelineMs"),
      jitterPx: stat("jitterPx"),
      lagPx: stat("lagPx"),
      trackingRate: stat("trackingRate"),
      matchDistance: stat("matchDistance"),
      pointerEvents: stat("pointerEvents"),
    },
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
          click: () => dashboardWindow?.webContents.openDevTools({ mode: "right" }),
        },
        {
          label: "透明层开发者工具",
          accelerator: "CommandOrControl+Alt+O",
          click: () => overlayWindow?.webContents.openDevTools({ mode: "detach" }),
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
  const recordedGestures = { ...settings.recordedGestures };
  delete recordedGestures[action];
  settings = {
    ...settings,
    gestureMap: { ...settings.gestureMap, [action]: defaultGestureMap[action] },
    recordedGestures,
  };
  saveSettings();
  syncSettings();
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
  const win = target === "overlay" ? overlayWindow : dashboardWindow;
  if (!win || win.isDestroyed()) return { ok: false, reason: "窗口不存在" };
  win.webContents.openDevTools({ mode: target === "overlay" ? "detach" : "right" });
  return { ok: true, target };
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
  if (result.ok && result.template) saveRecordedTemplate(result.action, result.template);
  recordingSession = null;
  updateSettings(session.restore);
  broadcast("aircursor:recording-result", {
    ok: Boolean(result.ok),
    action: result.action,
    reason: result.reason,
    hands: result.template?.hands,
    settings,
  });
});
