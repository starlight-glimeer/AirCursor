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

  document.querySelectorAll(".recorder-row").forEach((row) => {
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
    if (!isRecording) {
      row.querySelector("[data-progress-action]").style.width = "0%";
      row.querySelector("[data-hint-action]").textContent = recorded
        ? `已录制${recorded.hands === 2 ? "双手" : "单手"}手势`
        : "未录制";
    }
  });

  voiceRules.innerHTML = "";
  for (const rule of rules) {
    const row = document.createElement("div");
    row.className = "rule-row";

    const copy = document.createElement("div");
    const title = document.createElement("b");
    const voice = document.createElement("span");
    title.textContent = rule.label;
    voice.textContent = rule.voice;
    copy.append(title, voice);

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "测试";
    button.addEventListener("click", async () => {
      ruleState.textContent = `执行中：${rule.label}`;
      const result = await window.aircursor.runRule(rule.id);
      ruleState.textContent = `${result.ok ? "已执行" : "失败"}：${rule.label}`;
    });

    row.append(copy, button);
    voiceRules.append(row);
  }
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
document.querySelectorAll("[data-record-action]").forEach((button) => {
  button.addEventListener("click", async () => {
    const action = button.dataset.recordAction;
    if (recordingAction === action) {
      await window.aircursor.cancelRecording();
      recordingAction = null;
      ruleState.textContent = `已取消录制：${actionLabels[action]}`;
      render();
      return;
    }

    const hands = Number(document.querySelector(`[data-hands-action="${action}"]`).value);
    const result = await window.aircursor.startRecording(action, hands);
    if (!result.ok) {
      ruleState.textContent = `无法录制：${result.reason}`;
      return;
    }
    recordingAction = action;
    ruleState.textContent = `录制中：${actionLabels[action]}。倒计时后摆好${hands === 2 ? "双手" : "单手"}手势并保持 2 秒。`;
    render();
  });
});
document.querySelectorAll("[data-clear-action]").forEach((button) => {
  button.addEventListener("click", async () => {
    const action = button.dataset.clearAction;
    const result = await window.aircursor.clearRecordedGesture(action);
    if (result.ok) {
      settings = result.settings;
      if (recordingAction === action) recordingAction = null;
      ruleState.textContent = `已清除录制手势：${actionLabels[action]}`;
    } else {
      ruleState.textContent = `清除失败：${result.reason}`;
    }
    render();
  });
});

window.aircursor.onMetrics((m) => {
  if (!m) return;
  setMetric("mCameraFps", m.cameraFps, `${m.cameraFps} fps`);
  setMetric("mDrawFps", m.drawFps, `${m.drawFps} fps`);
  setMetric("mInference", m.inferenceMs, `${m.inferenceMs} / p95 ${m.inferenceP95Ms} ms`);
  setMetric("mPipeline", m.pipelineMs, `${m.pipelineMs} / p95 ${m.pipelineP95Ms} ms`);
  setMetric("mJitter", m.jitterPx, `${m.jitterPx} px${m.cursorHeld ? " · 静止锁定" : ""}`);
  setMetric("mLag", m.lagPx, `${m.lagPx} px`);
  setMetric("mTracking", m.trackingRate, `${m.trackingRate}% · ${m.hands} 手`);
  setMetric(
    "mMatch",
    m.matchDistance,
    m.matchDistance === null ? "未使用自定义手势" : `${m.matchDistance} / 最近 ${m.matchBestDistance}`,
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
    ? `已保存${result.hands === 2 ? "双手" : "单手"}手势：${actionLabels[result.action]}`
    : `录制失败：${result.reason}`;
  render();
});
window.aircursor.onSettings((nextSettings) => {
  settings = nextSettings;
  render();
});
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
window.aircursor.onHelperLog((message) => {
  handState.textContent = message.trim();
});

window.aircursor.getState().then((state) => {
  settings = state.settings;
  rules = state.rules || [];
  if (state.status?.voice) voiceState.textContent = state.status.voice;
  render();
});
