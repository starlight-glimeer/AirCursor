const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aircursor", {
  platform: process.platform,
  getState: () => ipcRenderer.invoke("aircursor:get-state"),
  getRules: () => ipcRenderer.invoke("aircursor:get-rules"),
  updateSettings: (patch) => ipcRenderer.invoke("aircursor:update-settings", patch),
  startRecording: (action, hands) => ipcRenderer.invoke("aircursor:start-recording", action, hands),
  cancelRecording: () => ipcRenderer.invoke("aircursor:cancel-recording"),
  clearRecordedGesture: (action) => ipcRenderer.invoke("aircursor:clear-recorded-gesture", action),
  runRule: (ruleId) => ipcRenderer.invoke("aircursor:run-rule", ruleId),
  openNetease: () => ipcRenderer.invoke("aircursor:open-netease"),
  openAccessibilitySettings: () => ipcRenderer.invoke("aircursor:open-accessibility"),
  showDashboard: () => ipcRenderer.invoke("aircursor:show-dashboard"),
  pointer: (command) => ipcRenderer.send("aircursor:pointer", command),
  status: (payload) => ipcRenderer.send("aircursor:overlay-status", payload),
  recordingProgress: (payload) => ipcRenderer.send("aircursor:recording-progress", payload),
  recordingResult: (payload) => ipcRenderer.send("aircursor:recording-result", payload),
  metrics: (payload) => ipcRenderer.send("aircursor:metrics", payload),
  writeReport: (note) => ipcRenderer.invoke("aircursor:write-report", note),
  revealReports: () => ipcRenderer.invoke("aircursor:reveal-reports"),
  resetMetrics: () => ipcRenderer.invoke("aircursor:reset-metrics"),
  resetTuning: () => ipcRenderer.invoke("aircursor:reset-tuning"),
  openDevTools: (target) => ipcRenderer.invoke("aircursor:open-devtools", target),
  onSettings: (handler) => {
    ipcRenderer.on("aircursor:settings", (_event, payload) => handler(payload));
  },
  onStatus: (handler) => {
    ipcRenderer.on("aircursor:overlay-status", (_event, payload) => handler(payload));
  },
  onVoiceCommand: (handler) => {
    ipcRenderer.on("aircursor:voice-command", (_event, phrase) => handler(phrase));
  },
  onRecording: (handler) => {
    ipcRenderer.on("aircursor:recording", (_event, payload) => handler(payload));
  },
  onRecordingProgress: (handler) => {
    ipcRenderer.on("aircursor:recording-progress", (_event, payload) => handler(payload));
  },
  onRecordingResult: (handler) => {
    ipcRenderer.on("aircursor:recording-result", (_event, payload) => handler(payload));
  },
  onResetMetrics: (handler) => {
    ipcRenderer.on("aircursor:reset-metrics", (_event, payload) => handler(payload));
  },
  onMetrics: (handler) => {
    ipcRenderer.on("aircursor:metrics", (_event, payload) => handler(payload));
  },
  onOverlayLog: (handler) => {
    ipcRenderer.on("aircursor:overlay-log", (_event, payload) => handler(payload));
  },
  onHelperLog: (handler) => {
    ipcRenderer.on("aircursor:helper-log", (_event, message) => handler(message));
  },
});
