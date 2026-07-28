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
  diagnostics: false,
  tuning: {},
};
let rules = [];
let recordingAction = null;

const actionLabels = {
  wake: "唤醒控制",
  click: "点击/拖拽",
  rightClick: "右键",
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

// Thresholds that turn a metric amber. They mark "this is what would make the
// experience feel wrong", so a report carries the judgement, not just numbers.
const METRIC_WARN = {
  mCameraFps: (v) => v < 24,
  mDrawFps: (v) => v < 50,
  mInference: (v) => v > 22,
  mPipeline: (v) => v > 45,
  mJitter: (v) => v > 2.5,
  mLag: (v) => v > 26,
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

  row.append(copy, handsSelect, recordButton, clearButton, testButton, feedback);
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
  if (isRecording) return;
  row.querySelector("[data-progress-action]").style.width = "0%";
  row.querySelector("[data-hint-action]").textContent = recorded
    ? `已录制${recorded.hands === 2 ? "双手" : "单手"}手势`
    : "未录制";
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
  const result = await window.aircursor.startRecording(action, hands);
  if (!result.ok) {
    ruleState.textContent = `无法录制：${result.reason}`;
    return;
  }
  recordingAction = action;
  ruleState.textContent = `录制中：${labelFor(action)}。倒计时后摆好${hands === 2 ? "双手" : "单手"}手势并保持 2 秒。`;
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
  setMetric("mTracking", m.trackingRate, `${m.trackingRate}% / 双手 ${m.bothHandsRate}% · ${m.hands} 手`);
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
      : m.pinchActive
        ? "捏合中 · 松开即点击"
        : "无保持中的手势",
  );
});
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
  hint.textContent = payload.hint || "";
});
window.aircursor.onRecordingResult((result) => {
  if (!result) return;
  if (result.settings) settings = result.settings;
  recordingAction = null;
  ruleState.textContent = result.ok
    ? `已保存${result.hands === 2 ? "双手" : "单手"}手势：${labelFor(result.action)}`
    : `录制失败：${result.reason}`;
  render();
});
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
