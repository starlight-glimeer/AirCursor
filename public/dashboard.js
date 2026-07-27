const controlToggle = document.getElementById("controlToggle");
const accessibilityButton = document.getElementById("accessibilityButton");
const overlayVisible = document.getElementById("overlayVisible");
const showHands = document.getElementById("showHands");
const voiceEnabled = document.getElementById("voiceEnabled");
const twoHands = document.getElementById("twoHands");
const effectsEnabled = document.getElementById("effectsEnabled");
const cameraState = document.getElementById("cameraState");
const handState = document.getElementById("handState");
const voiceState = document.getElementById("voiceState");
const controlState = document.getElementById("controlState");
const ruleState = document.getElementById("ruleState");
const voiceRules = document.getElementById("voiceRules");

let settings = {
  overlayVisible: true,
  showHands: true,
  controlEnabled: false,
  voiceEnabled: true,
  twoHands: false,
  effects: "balanced",
};
let rules = [];

function render() {
  overlayVisible.checked = settings.overlayVisible;
  showHands.checked = settings.showHands;
  voiceEnabled.checked = settings.voiceEnabled;
  twoHands.checked = settings.twoHands;
  effectsEnabled.checked = settings.effects === "rich";
  controlState.textContent = settings.controlEnabled ? "开启" : "关闭";
  controlToggle.textContent = settings.controlEnabled ? "关闭控制" : "开启控制";

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
