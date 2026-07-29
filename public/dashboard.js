const controlToggle = document.getElementById("controlToggle");
const accessibilityButton = document.getElementById("accessibilityButton");
const overlayVisible = document.getElementById("overlayVisible");
const showHands = document.getElementById("showHands");
const voiceEnabled = document.getElementById("voiceEnabled");
const twoHands = document.getElementById("twoHands");
const effectsEnabled = document.getElementById("effectsEnabled");
const wakeGesture = document.getElementById("wakeGesture");
const clickGesture = document.getElementById("clickGesture");
const rightClickGesture = document.getElementById("rightClickGesture");
const exitGesture = document.getElementById("exitGesture");
const cameraState = document.getElementById("cameraState");
const handState = document.getElementById("handState");
const voiceState = document.getElementById("voiceState");
const controlState = document.getElementById("controlState");
const ruleState = document.getElementById("ruleState");
const voiceRules = document.getElementById("voiceRules");
const gestureConflicts = document.getElementById("gestureConflicts");
const pointerState = document.getElementById("pointerState");
const pointerBanner = document.getElementById("pointerBanner");
const diagnostics = document.getElementById("diagnostics");
const diagnosticsPanel = document.getElementById("diagnosticsPanel");
const overlayLog = document.getElementById("overlayLog");
const captureLandmarks = document.getElementById("captureLandmarks");
const revealCaptures = document.getElementById("revealCaptures");

let settings = {
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
  disabledActions: {},
  diagnostics: false,
  tuning: {},
};
let rules = [];
let recordingAction = null;

const actionLabels = {
  wake: "唤醒控制",
  click: "点击",
  drag: "拖拽（按住不放）",
  rightClick: "右键",
  scrollUp: "向上滚动",
  scrollDown: "向下滚动",
  spaceLeft: "切到左边桌面",
  spaceRight: "切到右边桌面",
  exit: "退出控制",
};

const actionSelects = {
  wake: wakeGesture,
  click: clickGesture,
  rightClick: rightClickGesture,
  exit: exitGesture,
};

function ensureRecordedOption(action) {
  const select = actionSelects[action];
  const value = `custom:${action}`;
  const existing = Array.from(select.options).find((option) => option.value === value);
  if (settings.recordedGestures?.[action]) {
    if (!existing) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = "使用已录制手势";
      select.prepend(option);
    }
  } else if (existing) {
    existing.remove();
  }
}

// Drawing a saved template back at the user.
//
// A template is 21 landmarks per hand of normalized coordinates. Stored as
// numbers they are unreadable, so the only way to learn what a recording
// captured was to go and perform it and see whether anything happened — which is
// also how a bad recording stayed invisible until it was mistaken for a bug in
// the matching. The preview removes the guesswork: what is drawn is exactly what
// live poses are compared against.
const HAND_LINES = [
  [0, 1, 2, 3, 4],
  [0, 5, 6, 7, 8],
  [0, 9, 10, 11, 12],
  [0, 13, 14, 15, 16],
  [0, 17, 18, 19, 20],
  [5, 9, 13, 17],
];
const LANDMARKS_PER_HAND = 21;

// Templates share one origin and scale across both hands, so a two-hand pose
// keeps the gap between the hands. Fitting to the drawn bounds preserves that.
function templatePoints(template) {
  const values = template?.values;
  const hands = template?.hands;
  if (!Array.isArray(values) || !hands) return null;
  const out = [];
  for (let hand = 0; hand < hands; hand += 1) {
    const offset = hand * LANDMARKS_PER_HAND * 3;
    const points = [];
    for (let id = 0; id < LANDMARKS_PER_HAND; id += 1) {
      points.push({ x: values[offset + id * 3], y: values[offset + id * 3 + 1] });
    }
    out.push(points);
  }
  return out;
}

function drawTemplate(canvas, template, { tiltDeg = 0, accent = "#0f72d4" } = {}) {
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const hands = templatePoints(template);
  if (!hands) {
    canvas.classList.add("is-empty");
    // Cleared, not collapsed: the dashed empty box is how "not recorded yet" looks,
    // and zeroing the backing store would make the element vanish instead.
    canvas.width = Math.round((canvas.clientWidth || 60) * dpr);
    canvas.height = Math.round((canvas.clientHeight || 84) * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.clientWidth || 60, canvas.clientHeight || 84);
    return;
  }
  canvas.classList.remove("is-empty");
  // Decided before measuring, not after: the class is what sets clientWidth, so
  // setting it later meant a two-hand pose was scaled to the one-hand box on its
  // first draw. A two-hand pose is wider than tall and a one-hand pose is the
  // opposite, so the box follows the content.
  canvas.classList.toggle("is-wide", hands.length > 1);
  // Sized from the element so the CSS box is the single source of truth; the
  // fallbacks match the one-hand box in dashboard.css.
  const w = canvas.clientWidth || 60;
  const h = canvas.clientHeight || 84;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);


  // The tilt preview rotates the stored pose by the recorded extent, so the
  // second frame shows the position the movement actually reaches rather than a
  // number the user has to imagine.
  const rot = (tiltDeg * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const placed = hands.map((points) =>
    points.map((p) => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos })),
  );

  const all = placed.flat();
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const spanX = Math.max(...xs) - Math.min(...xs) || 1;
  const spanY = Math.max(...ys) - Math.min(...ys) || 1;
  const pad = 7;
  const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const at = (p) => ({ x: w / 2 + (p.x - cx) * scale, y: h / 2 + (p.y - cy) * scale });

  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const points of placed) {
    ctx.strokeStyle = accent;
    for (const line of HAND_LINES) {
      ctx.beginPath();
      line.forEach((id, i) => {
        const p = at(points[id]);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
    }
    ctx.fillStyle = accent;
    for (const p of points) {
      const q = at(p);
      ctx.beginPath();
      ctx.arc(q.x, q.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// Thresholds that turn a metric amber. They mark "this is what would make the
// experience feel wrong", so a report carries the judgement, not just numbers.
const METRIC_WARN = {
  mCameraFps: (v) => v < 24,
  mDrawFps: (v) => v < 50,
  mInference: (v) => v > 22,
  mPipeline: (v) => v > 45,
  mJitter: (v) => v > 2.5,
  mLag: (v) => v > 26,
  // Judged on the active rate: the all-inclusive one is legitimately ~50% in any
  // session where the user also touched the panel, so warning on it cried wolf.
  mTracking: (v) => v < 85,
};

function setMetric(id, value, text) {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = text;
  const warn = METRIC_WARN[id];
  node.parentElement.classList.toggle("is-warn", Boolean(warn && Number.isFinite(value) && warn(value)));
}

function renderTuning() {
  document.querySelectorAll("[data-tuning]").forEach((input) => {
    const key = input.dataset.tuning;
    const value = settings.tuning?.[key];
    if (value === undefined) return;
    input.value = String(value);
    const label = document.querySelector(`[data-tuning-value="${key}"]`);
    if (label) label.textContent = value;
  });
}

function render() {
  for (const action of Object.keys(actionSelects)) ensureRecordedOption(action);
  diagnostics.checked = Boolean(settings.diagnostics);
  diagnosticsPanel.hidden = !settings.diagnostics;
  renderTuning();
  overlayVisible.checked = settings.overlayVisible;
  showHands.checked = settings.showHands;
  voiceEnabled.checked = settings.voiceEnabled;
  twoHands.checked = settings.twoHands;
  effectsEnabled.checked = settings.effects === "rich";
  wakeGesture.value = settings.gestureMap?.wake || "openPalm";
  clickGesture.value = settings.gestureMap?.click || "pinch";
  rightClickGesture.value = settings.gestureMap?.rightClick || "middlePinch";
  exitGesture.value = settings.gestureMap?.exit || "fist";
  controlState.textContent = settings.controlEnabled ? "开启" : "关闭";
  controlToggle.textContent = settings.controlEnabled ? "关闭控制" : "开启控制";

  document.querySelectorAll(".gesture-recorder .recorder-row").forEach(paintRecorderRow);
  renderRules();
}

// Rule rows are built from the list main owns, so adding a rule there gives it a
// recorder here without touching this file.
function renderRules() {
  if (voiceRules.childElementCount !== rules.length) {
    voiceRules.innerHTML = "";
    for (const rule of rules) voiceRules.append(buildRuleRow(rule));
  }
  for (const rule of rules) {
    const row = voiceRules.querySelector(`[data-action="${rule.id}"]`);
    if (row) paintRecorderRow(row);
  }
}

function buildRuleRow(rule) {
  const row = document.createElement("div");
  row.className = "recorder-row";
  row.dataset.action = rule.id;

  const copy = document.createElement("div");
  const title = document.createElement("b");
  const voice = document.createElement("span");
  title.textContent = rule.label;
  voice.textContent = `语音：${rule.voice}`;
  copy.append(title, voice);

  const toggle = document.createElement("label");
  toggle.className = "recorder-toggle";
  toggle.title = "关掉只是先不触发，录好的手势不会丢";
  const toggleInput = document.createElement("input");
  toggleInput.type = "checkbox";
  toggleInput.dataset.enabledAction = rule.id;
  toggleInput.checked = true;
  toggleInput.addEventListener("change", () => setActionEnabled(rule.id, toggleInput.checked));
  const toggleText = document.createElement("span");
  toggleText.textContent = "启用";
  toggle.append(toggleInput, toggleText);

  // Rules can be dynamic too: "draw a circle to open Chrome" is exactly the kind
  // of thing a recorded movement is for.
  const kindSelect = document.createElement("select");
  kindSelect.dataset.kindAction = rule.id;
  for (const [value, text] of [["static", "静态姿势"], ["dynamic", "动态动作"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    kindSelect.append(option);
  }

  const handsSelect = document.createElement("select");
  handsSelect.dataset.handsAction = rule.id;
  for (const [value, text] of [["1", "单手"], ["2", "双手"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    handsSelect.append(option);
  }

  const recordButton = document.createElement("button");
  recordButton.type = "button";
  recordButton.dataset.recordAction = rule.id;
  recordButton.textContent = "开始录制";
  recordButton.addEventListener("click", () => toggleRecording(rule.id));

  const clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.dataset.clearAction = rule.id;
  clearButton.textContent = "清除";
  clearButton.addEventListener("click", () => clearRecorded(rule.id));

  const testButton = document.createElement("button");
  testButton.type = "button";
  testButton.textContent = "测试";
  testButton.addEventListener("click", async () => {
    ruleState.textContent = `执行中：${rule.label}`;
    const result = await window.aircursor.runRule(rule.id);
    ruleState.textContent = `${result.ok ? "已执行" : "失败"}：${rule.label}`;
  });

  // Same preview as the fixed rows: a rule's gesture is just as invisible.
  const preview = document.createElement("div");
  preview.className = "recorder-preview";
  preview.dataset.previewAction = rule.id;
  const rest = document.createElement("canvas");
  rest.dataset.previewRest = "";
  const move = document.createElement("canvas");
  move.dataset.previewMove = "";
  move.className = "is-move";
  move.hidden = true;
  preview.append(rest, move);

  const feedback = document.createElement("div");
  feedback.className = "recorder-feedback";
  const bar = document.createElement("div");
  bar.className = "recorder-bar";
  const fill = document.createElement("i");
  fill.dataset.progressAction = rule.id;
  bar.append(fill);
  const hint = document.createElement("span");
  hint.dataset.hintAction = rule.id;
  hint.textContent = "未录制";
  feedback.append(bar, hint);

  row.append(toggle, copy, kindSelect, handsSelect, recordButton, clearButton, testButton, preview, feedback);
  return row;
}

// Shared by the four pointer actions and the seven rules: the row markup is the
// same shape, so the state painting is one function instead of two that drift.
function paintRecorderRow(row) {
  const action = row.dataset.action;
  const recorded = settings.recordedGestures?.[action];
  const isRecording = recordingAction === action;
  row.classList.toggle("is-recording", isRecording);
  row.classList.toggle("is-saved", Boolean(recorded));
  row.querySelector("[data-record-action]").textContent = isRecording ? "取消录制" : "开始录制";
  row.querySelector("[data-clear-action]").disabled = !recorded;
  const handsSelect = row.querySelector("[data-hands-action]");
  handsSelect.disabled = Boolean(recordingAction);
  if (recorded?.hands && !recordingAction) handsSelect.value = String(recorded.hands);
  const kindSelect = row.querySelector("[data-kind-action]");
  if (kindSelect) {
    // Left alone for the two actions that can only be dynamic, so the select does
    // not appear to offer a choice that will be overridden.
    const locked = kindSelect.options.length === 1;
    kindSelect.disabled = locked || Boolean(recordingAction);
    if (!locked && recorded && !recordingAction) {
      kindSelect.value = recorded.keyframes?.length ? "dynamic" : "static";
    }
  }
  const toggle = row.querySelector("[data-enabled-action]");
  if (toggle) {
    const enabled = !settings.disabledActions?.[action];
    toggle.checked = enabled;
    toggle.disabled = Boolean(recordingAction);
    // Greyed rather than hidden: a disabled action still has a recording worth
    // looking at, and hiding the row would make the switch feel like a delete.
    row.classList.toggle("is-disabled", !enabled);
  }
  paintPreview(row, recorded);
  if (isRecording) return;
  row.querySelector("[data-progress-action]").style.width = "0%";
  row.querySelector("[data-hint-action]").textContent = recorded ? describeRecorded(recorded) : "未录制";
}

// What was captured, in the terms the user performed it in: a motion gesture is
// described by the movement it measured, not just "已录制".
function describeRecorded(recorded) {
  const hands = recorded.hands === 2 ? "双手" : "单手";
  const motion = recorded.motion;
  if (motion?.measure === "tilt") {
    return `${hands}动态 · 抬压到 ${Math.round(motion.peak)}°，超过 ${Math.round(motion.trigger)}° 就滚一段`;
  }
  if (motion?.measure === "swipe") {
    return `${hands}动态 · 挥动到 ${motion.peak.toFixed(1)} 掌宽/秒，超过 ${motion.trigger.toFixed(1)} 就切桌面`;
  }
  if (recorded.keyframes?.length) {
    const base = `${hands}动态 · ${recorded.keyframes.length} 帧 / ${motion?.durationMs || 0}ms，做完整个动作触发`;
    // Saved rather than refused, but the risk is real and stated: a movement that
    // ends where it began has a final pose the hand can be in without having
    // moved, so it is easier to misfire. Refusing it outright rejected the natural
    // way to record (most people put their hand back), which was worse.
    return motion?.roundTrip ? `${base}｜⚠️ 结束姿势和起始接近，可能误触` : base;
  }
  return `${hands}静态姿势`;
}

// One animation loop per row that has keyframes, driven by rAF. A dynamic gesture
// shown as a still frame is unreadable — the whole content of the gesture is the
// movement — so the preview plays the recording back.
const previewLoops = new Map();

function stopPreviewLoop(action) {
  const handle = previewLoops.get(action);
  if (handle) cancelAnimationFrame(handle);
  previewLoops.delete(action);
}

// Plays the keyframes at their recorded timings, then holds the final pose for a
// beat before looping, so the start and end are distinguishable. Interpolating
// between keyframes rather than cutting: the keyframes are a thinned sample of a
// continuous movement, and cutting between them reads as a stutter that the real
// gesture does not have.
function startPreviewLoop(action, canvas, keyframes) {
  stopPreviewLoop(action);
  if (keyframes.length < 2) return;
  const total = keyframes[keyframes.length - 1].offsetMs || 1;
  const hold = 420;
  const cycle = total + hold;
  let start = null;

  const tick = (nowMs) => {
    // Cheap self-cancel: the loop stops when the canvas leaves the document,
    // rather than needing every caller to remember to tear it down.
    if (!canvas.isConnected) {
      previewLoops.delete(action);
      return;
    }
    if (start === null) start = nowMs;
    const t = (nowMs - start) % cycle;
    const at = Math.min(t, total);

    let i = 0;
    while (i < keyframes.length - 2 && keyframes[i + 1].offsetMs < at) i += 1;
    const a = keyframes[i];
    const b = keyframes[i + 1];
    const span = Math.max(1, b.offsetMs - a.offsetMs);
    const k = Math.max(0, Math.min(1, (at - a.offsetMs) / span));

    drawTemplate(canvas, lerpTemplate(a.template, b.template, k), {
      accent: t > total ? "#1f9d63" : "#0f72d4",
    });
    previewLoops.set(action, requestAnimationFrame(tick));
  };
  previewLoops.set(action, requestAnimationFrame(tick));
}

// Straight-line interpolation in normalized landmark space. Not physically exact
// for a rotating hand, but the keyframes are close enough together that the
// difference is invisible, and it keeps the preview honest: every frame drawn is
// derived from stored data, not synthesised movement.
function lerpTemplate(a, b, k) {
  if (!a?.values || !b?.values || a.values.length !== b.values.length) return a;
  const values = new Array(a.values.length);
  for (let i = 0; i < a.values.length; i += 1) values[i] = a.values[i] + (b.values[i] - a.values[i]) * k;
  return { hands: a.hands, angle: a.angle, values };
}

function paintPreview(row, recorded) {
  const preview = row.querySelector("[data-preview-action]");
  if (!preview) return;
  const action = row.dataset.action;
  const rest = preview.querySelector("[data-preview-rest]");
  const move = preview.querySelector("[data-preview-move]");
  const keyframes = recorded?.keyframes;

  // A recorded movement animates in the first cell; there is no "the pose" to
  // show beside it, since the pose is different in every frame.
  if (keyframes?.length > 1) {
    rest.classList.add("is-animated");
    rest.title = `录下的动作（${keyframes.length} 帧，${recorded.motion?.durationMs || 0}ms），循环播放`;
    startPreviewLoop(action, rest, keyframes);
    move.hidden = true;
    return;
  }

  stopPreviewLoop(action);
  rest.classList.remove("is-animated");
  drawTemplate(rest, recorded?.template);
  rest.title = recorded ? "录下的姿势（匹配就是拿它比的）" : "还没录";
  // A tilt gesture recorded before keyframes existed still has an extent worth
  // drawing as a second frame.
  const tilt = recorded?.motion?.measure === "tilt" ? recorded.motion.peak : null;
  move.hidden = tilt === null;
  if (tilt !== null) {
    drawTemplate(move, recorded.template, { tiltDeg: tilt, accent: "#1f9d63" });
    move.title = `抬压到 ${Math.round(tilt)}° 时的位置`;
  }
}

// Two templates too close together produce the most confusing symptom there is:
// the gesture works, but a different action happens. Naming the pair turns
// "click does nothing" into "click and exit are the same pose".
function renderConflicts(conflicts) {
  gestureConflicts.innerHTML = "";
  gestureConflicts.hidden = !conflicts?.length;
  if (!conflicts?.length) return;
  for (const conflict of conflicts) {
    const line = document.createElement("p");
    const [a, b] = conflict.labels || conflict.actions;
    const head = `「${a}」和「${b}」的手势距离只有 ${conflict.distance}`;
    line.textContent =
      conflict.severity === "advisory"
        ? `${head}（建议 ${conflict.needs} 以上）：一般能分对，但手势摆得不标准时可能认错。`
        : `${head}，已经小于单次摆同一个手势的抖动幅度：会触发哪一个基本是随机的，请重录其中一个。`;
    gestureConflicts.append(line);
  }
}

// "Gesture recognised" and "the OS moved the mouse" are different claims, and
// three real reports were spent conflating them. This renders the second one, so
// a dead click pipeline can no longer look like a gesture-tuning problem.
function renderPointerHealth(health) {
  if (!health) return;
  const dead =
    health.trusted === false ||
    ["compile-failed", "spawn-failed", "write-failed", "exited"].includes(health.state);

  pointerState.textContent = health.trusted === false
    ? "无权限"
    : health.state === "running"
      ? "正常"
      : health.state === "starting"
        ? "启动中"
        : "异常";
  pointerState.classList.toggle("is-bad", dead);

  pointerBanner.hidden = !dead;
  if (!dead) return;

  pointerBanner.innerHTML = "";
  const line = document.createElement("p");
  line.textContent =
    health.trusted === false
      ? "点击通道不可用：AirCursor 没有辅助功能权限，系统会丢弃所有合成的鼠标事件。手势和语音都会「识别成功但毫无反应」。"
      : `点击通道不可用：${health.detail || "helper 未运行"}。手势和语音都会「识别成功但毫无反应」。`;
  const how = document.createElement("p");
  how.textContent =
    health.trusted === false
      ? "点上方「打开辅助功能权限」，勾选 AirCursor（开发模式下条目名可能是 Electron），然后完全退出并重启 AirCursor。"
      : "先看下方诊断面板的日志；若是编译失败，确认已安装 Xcode 命令行工具（xcode-select --install）。";
  pointerBanner.append(line, how);
}

function labelFor(action) {
  return actionLabels[action] || rules.find((rule) => rule.id === action)?.label || action;
}

async function toggleRecording(action) {
  if (recordingAction === action) {
    await window.aircursor.cancelRecording();
    recordingAction = null;
    ruleState.textContent = `已取消录制：${labelFor(action)}`;
    render();
    return;
  }
  if (recordingAction) {
    ruleState.textContent = `请先结束正在进行的录制：${labelFor(recordingAction)}`;
    return;
  }

  const hands = Number(document.querySelector(`[data-hands-action="${action}"]`).value);
  const kindSelect = document.querySelector(`[data-kind-action="${action}"]`);
  const kind = kindSelect?.value || "static";
  const result = await window.aircursor.startRecording(action, hands, kind);
  if (!result.ok) {
    ruleState.textContent = `无法录制：${result.reason}`;
    return;
  }
  recordingAction = action;
  const which = hands === 2 ? "双手" : "单手";
  // Main resolves the kind (the scroll directions default to dynamic), so the
  // instruction comes from what it decided, not from what the select said.
  ruleState.textContent =
    result.kind === "dynamic"
      ? `录制中：${labelFor(action)}。倒计时后先摆好${which}起始姿势保持 2 秒，然后把动作做出来。`
      : `录制中：${labelFor(action)}。倒计时后摆好${which}手势并保持 2 秒。`;
  render();
}

// Enabling writes `null` rather than `false`, so the map only ever holds the
// actions that are actually off. Storing `false` would leave a stale entry behind
// for every action the user ever toggled, and then "absent means enabled" would
// have two spellings.
async function setActionEnabled(action, enabled) {
  const result = await window.aircursor.updateSettings({
    disabledActions: { [action]: enabled ? null : true },
  });
  if (result?.settings) settings = result.settings;
  ruleState.textContent = `${enabled ? "已启用" : "已停用"}：${labelFor(action)}`;
  render();
}

async function clearRecorded(action) {
  const result = await window.aircursor.clearRecordedGesture(action);
  if (result.ok) {
    settings = result.settings;
    if (recordingAction === action) recordingAction = null;
    ruleState.textContent = `已清除录制手势：${labelFor(action)}`;
  } else {
    ruleState.textContent = `清除失败：${result.reason}`;
  }
  render();
}

async function patchSettings(patch) {
  const result = await window.aircursor.updateSettings(patch);
  settings = result.settings;
  render();
}

controlToggle.addEventListener("click", () => {
  patchSettings({ controlEnabled: !settings.controlEnabled, overlayVisible: true });
});
accessibilityButton.addEventListener("click", () => {
  window.aircursor.openAccessibilitySettings();
});
overlayVisible.addEventListener("change", () => {
  patchSettings({ overlayVisible: overlayVisible.checked });
});
showHands.addEventListener("change", () => {
  patchSettings({ showHands: showHands.checked });
});
voiceEnabled.addEventListener("change", () => {
  patchSettings({ voiceEnabled: voiceEnabled.checked });
});
twoHands.addEventListener("change", () => {
  patchSettings({ twoHands: twoHands.checked });
});
effectsEnabled.addEventListener("change", () => {
  patchSettings({ effects: effectsEnabled.checked ? "rich" : "balanced" });
});
diagnostics.addEventListener("change", () => {
  patchSettings({ diagnostics: diagnostics.checked });
});
document.querySelectorAll("[data-tuning]").forEach((input) => {
  input.addEventListener("input", () => {
    const key = input.dataset.tuning;
    const value = Number(input.value);
    const label = document.querySelector(`[data-tuning-value="${key}"]`);
    if (label) label.textContent = value;
    patchSettings({ tuning: { [key]: value } });
  });
});
document.getElementById("saveReport").addEventListener("click", async () => {
  const note = document.getElementById("reportNote").value.trim();
  const result = await window.aircursor.writeReport(note);
  ruleState.textContent = result.ok ? `报告已保存：${result.file}` : "报告保存失败";
});
document.getElementById("revealReports").addEventListener("click", () => {
  window.aircursor.revealReports();
});
document.getElementById("resetMetrics").addEventListener("click", async () => {
  await window.aircursor.resetMetrics();
  overlayLog.textContent = "";
  ruleState.textContent = "指标已重置";
});
document.getElementById("resetTuning").addEventListener("click", async () => {
  const result = await window.aircursor.resetTuning();
  if (result.settings) settings = result.settings;
  render();
  ruleState.textContent = "调参已恢复默认";
});
document.getElementById("overlayDevtools").addEventListener("click", () => {
  window.aircursor.openDevTools("overlay");
});
wakeGesture.addEventListener("change", () => {
  patchSettings({ gestureMap: { wake: wakeGesture.value } });
});
clickGesture.addEventListener("change", () => {
  patchSettings({ gestureMap: { click: clickGesture.value } });
});
rightClickGesture.addEventListener("change", () => {
  patchSettings({ gestureMap: { rightClick: rightClickGesture.value } });
});
exitGesture.addEventListener("change", () => {
  patchSettings({ gestureMap: { exit: exitGesture.value } });
});
// Only the four static rows are wired here; rule rows bind their own handlers as
// they are built, since they do not exist when this runs.
document.querySelectorAll(".gesture-recorder [data-record-action]").forEach((button) => {
  button.addEventListener("click", () => toggleRecording(button.dataset.recordAction));
});
document.querySelectorAll(".gesture-recorder [data-clear-action]").forEach((button) => {
  button.addEventListener("click", () => clearRecorded(button.dataset.clearAction));
});
// Raw landmark capture. Every test on both sides of this project runs on synthetic
// hands, and what they cannot reproduce is the time correlation of real tracking
// noise — consecutive frames drift together, a re-detection jumps. This records the
// real thing so probes can replay it instead of guessing at it.
captureLandmarks.addEventListener("click", async () => {
  const result = await window.aircursor.startCapture();
  ruleState.textContent = result.ok
    ? "正在录制原始关键点 5 秒：把手放进画面，做几个平时会用的动作"
    : `无法录制：${result.reason}`;
});
revealCaptures.addEventListener("click", () => window.aircursor.revealCaptures());

document.querySelectorAll(".gesture-recorder [data-enabled-action]").forEach((input) => {
  input.addEventListener("change", () => setActionEnabled(input.dataset.enabledAction, input.checked));
});

window.aircursor.onMetrics((m) => {
  if (!m) return;
  setMetric("mCameraFps", m.cameraFps, `${m.cameraFps} fps`);
  setMetric("mDrawFps", m.drawFps, `${m.drawFps} fps`);
  setMetric("mInference", m.inferenceMs, `${m.inferenceMs} / p95 ${m.inferenceP95Ms} ms`);
  setMetric("mPipeline", m.pipelineMs, `${m.pipelineMs} / p95 ${m.pipelineP95Ms} ms`);
  setMetric("mJitter", m.jitterPx, `${m.jitterPx} px${m.cursorHeld ? " · 静止锁定" : ""}`);
  setMetric("mLag", m.lagPx, `${m.lagPx} px`);
  // Both rates: a two-hand gesture only matches on frames where both hands were
  // found, so the loose rate can look fine while the gesture is unusable.
  // Two rates, because one could not distinguish a CV fault from a hand that was
  // simply down — and the ambiguous number had already been written up as the
  // top-priority CV problem before an outside review caught it. The active rate
  // only counts frames where a hand was present or had been within the last two
  // seconds, so idle time leaves the denominator instead of looking like misses.
  const active = m.activeTrackingRate;
  setMetric(
    "mTracking",
    active,
    active === null
      ? `${m.trackingRate}% / 双手 ${m.bothHandsRate}% · ${m.hands} 手（还没有有效样本）`
      : `${active}% / 双手 ${m.activeBothHandsRate}% · ${m.hands} 手` +
          `（有效 ${m.activeFrames} 帧；含空闲 ${m.trackingRate}%）`,
  );
  // Which gesture is closest matters as soon as more than one is bound: a
  // distance alone cannot tell you the wrong template is the one winning.
  setMetric(
    "mMatch",
    m.matchDistance,
    m.matchDistance === null
      ? "未使用自定义手势"
      : `${m.matchDistance} / 最近 ${m.matchBestDistance}${m.closestAction ? ` · ${labelFor(m.closestAction)}` : ""}`,
  );
  // Separates "never matched" from "matched but the hold kept restarting": the
  // status line above shows a gesture from a single frame, so without this a
  // gesture that is recognised every frame and still never fires looks the same
  // as one that fires normally.
  setMetric(
    "mHold",
    null,
    m.holdId
      ? `${labelFor(m.holdId)} · ${m.holdMs} ms`
      : m.dragActive
        ? "拖拽中 · 左键按住"
        : m.pinchActive
          ? "捏合中 · 松开即点击"
          : "无保持中的手势",
  );
  renderMotion(m.motion);
});

// Why the motion gestures did nothing. Both of them can fail for several reasons
// that are invisible from the outside — the wrist was moving, the hand has not
// returned to the recorded pose yet, the cooldown is still running, the pose has
// no measurable axis — and every one of them presents as "the gesture shows up on
// the status line and the screen does not move". That symptom has already cost
// three debugging rounds on this project, so each reason gets named here.
const MOTION_BLOCKED_TEXT = {
  controlOff: "控制模式关着",
  noHand: "没有检测到手",
  notBound: "没录手势",
  poseNotMatched: "手势没匹配上",
  noAxis: "姿势测不出方向轴（双手镜像）",
  wristMoving: "手腕在移动，先停稳",
  waitingReturn: "等手回到录制姿势才能再滚",
  waitingStill: "等手停下来才能再挥",
  disabled: "这个动作被关掉了",
  wrongDirection: "挥的方向和这个动作相反",
  cooldown: "冷却中",
  noPath: "轨迹不足",
  tooShort: "挥动距离不够",
  notHorizontal: "不够横向",
  notStraight: "轨迹不够直",
  // Sequence-specific. "Never started" and "stalled halfway" need opposite fixes
  // — a different starting pose versus a movement performed differently — so they
  // are never collapsed into one message.
  waitingStart: "还没摆到动作的起始姿势",
  midMovement: "动作进行中",
  tooSlow: "动作做得太慢，超时重来",
};

function motionReason(blocked) {
  if (!blocked) return "就绪";
  return MOTION_BLOCKED_TEXT[blocked] || blocked;
}

function renderMotion(motion) {
  if (!motion) {
    setMetric("mTilt", null, "-");
    setMetric("mMotion", null, "-");
    return;
  }
  // The clamp is surfaced rather than applied quietly: a trigger angle past the
  // rotation tolerance would make the tilted pose stop matching its own
  // template, so it is capped — and a slider that silently does nothing above
  // some value is its own debugging trap.
  const clamped = motion.clampedTrigger ? `（已压到 ${motion.triggerDeg}°，受旋转容差限制）` : "";
  // Whether the trigger came from the recording or from the slider, because
  // otherwise "I moved the slider and nothing changed" is unexplainable.
  const from = motion.triggerFromRecording ? "录制值" : "滑块值";
  setMetric("mTilt", null, `${motion.tiltDeg}° / 触发 ${motion.triggerDeg}°（${from}）${clamped}`);
  setMetric(
    "mMotion",
    null,
    `${motion.scrollAction ? labelFor(motion.scrollAction) : "滚动"} ${motionReason(motion.scrollBlocked)}` +
      ` · ${motion.swipeAction ? labelFor(motion.swipeAction) : "挥动"} ${motionReason(motion.swipeBlocked)}` +
      ` · 手速 ${motion.wristSpeed}`,
  );
  // Sequence progress is the readout for a recorded movement: a partly-performed
  // gesture shows how far it got, which separates "wrong starting pose" from
  // "started but never finished the movement".
  const pct = Math.round((motion.sequenceProgress || 0) * 100);
  setMetric(
    "mSequence",
    null,
    motion.sequenceAction
      ? `${labelFor(motion.sequenceAction)} ${pct}% · ${motionReason(motion.sequenceBlocked)}`
      : "没有动态动作手势",
  );
}
window.aircursor.onOverlayLog((entry) => {
  if (!entry) return;
  const line = `[${entry.source}] ${entry.message}\n`;
  overlayLog.textContent = (overlayLog.textContent + line).split("\n").slice(-60).join("\n");
  overlayLog.scrollTop = overlayLog.scrollHeight;
});
window.aircursor.onRecordingProgress((payload) => {
  if (!payload || payload.action !== recordingAction) return;
  const bar = document.querySelector(`[data-progress-action="${payload.action}"]`);
  const hint = document.querySelector(`[data-hint-action="${payload.action}"]`);
  if (!bar || !hint) return;
  if (payload.phase === "countdown") {
    bar.style.width = "0%";
    hint.textContent = `准备：${payload.countdown}`;
    return;
  }
  bar.style.width = `${Math.round((payload.progress || 0) * 100)}%`;
  // In the movement stage the bar is a readout of how far the movement has got,
  // not a countdown to a save, and the row says which stage it is in so "hold
  // still" never appears while a movement is being asked for. The ready stage is a
  // beat between the two — it exists so the hand's travel to the movement's
  // starting point is not captured as part of the movement.
  const row = bar.closest(".recorder-row");
  if (row) row.classList.toggle("is-moving", payload.stage === "move" || payload.stage === "ready");
  if (payload.stage === "ready") {
    bar.style.width = "0%";
    hint.textContent = `${payload.countdown}… ${payload.hint || ""}`;
    return;
  }
  const measured =
    payload.stage === "move" && payload.measured ? ` · 最大 ${payload.measured}${payload.unit || ""}` : "";
  hint.textContent = `${payload.hint || ""}${measured}`;
});
window.aircursor.onRecordingResult((result) => {
  if (!result) return;
  if (result.settings) settings = result.settings;
  recordingAction = null;
  document.querySelectorAll(".recorder-row.is-moving").forEach((row) => row.classList.remove("is-moving"));
  ruleState.textContent = result.ok
    ? `已保存：${labelFor(result.action)}${describeSaved(result)}`
    : `录制失败：${result.reason}`;
  render();
});

// Repeat back what the movement measured, so a saved gesture is confirmed by its
// own numbers rather than by going and testing whether it works.
function describeSaved(result) {
  const hands = result.hands === 2 ? "双手" : "单手";
  const motion = result.motion;
  if (motion?.measure === "tilt") return `（${hands}，抬压 ${Math.round(motion.peak)}°）`;
  if (motion?.measure === "swipe") return `（${hands}，挥动 ${motion.peak.toFixed(1)} 掌宽/秒）`;
  if (result.keyframes?.length) {
    const warn = result.motion?.roundTrip ? "，⚠️ 结束姿势和起始接近，可能误触" : "";
    return `（${hands}动态，${result.keyframes.length} 帧${warn}）`;
  }
  return `（${hands}静态）`;
}
window.aircursor.onSettings((nextSettings) => {
  settings = nextSettings;
  render();
});
window.aircursor.onGestureConflicts(renderConflicts);
window.aircursor.onStatus((status) => {
  if (status.camera) cameraState.textContent = status.camera;
  if (status.hand) handState.textContent = status.hand;
  if (status.voice) voiceState.textContent = status.voice;
  if (status.rule) ruleState.textContent = status.rule;
  if (typeof status.controlEnabled === "boolean") {
    settings.controlEnabled = status.controlEnabled;
    render();
  }
});
// Helper output goes to the diagnostics log, NOT to the 识别 line. It used to
// overwrite that line, where the 500ms status loop then erased it — so the
// helper's "缺少辅助功能权限" warning was visible for under half a second and
// three reports never carried it. Permission state now lives in its own row.
window.aircursor.onHelperLog((message) => {
  const line = `[pointer] ${message.trim()}\n`;
  overlayLog.textContent = (overlayLog.textContent + line).split("\n").slice(-60).join("\n");
  overlayLog.scrollTop = overlayLog.scrollHeight;
});
window.aircursor.onPointerHealth(renderPointerHealth);

window.aircursor.getState().then((state) => {
  settings = state.settings;
  rules = state.rules || [];
  if (state.status?.voice) voiceState.textContent = state.status.voice;
  renderConflicts(state.gestureConflicts);
  renderPointerHealth(state.pointer);
  render();
});
