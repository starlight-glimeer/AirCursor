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

function render() {
  for (const action of Object.keys(actionSelects)) ensureRecordedOption(action);
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
