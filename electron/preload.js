const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aircursor", {
  platform: process.platform,
  getState: () => ipcRenderer.invoke("aircursor:get-state"),
  updateSettings: (patch) => ipcRenderer.invoke("aircursor:update-settings", patch),
  openNetease: () => ipcRenderer.invoke("aircursor:open-netease"),
  openAccessibilitySettings: () => ipcRenderer.invoke("aircursor:open-accessibility"),
  showDashboard: () => ipcRenderer.invoke("aircursor:show-dashboard"),
  pointer: (command) => ipcRenderer.send("aircursor:pointer", command),
  status: (payload) => ipcRenderer.send("aircursor:overlay-status", payload),
  onSettings: (handler) => {
    ipcRenderer.on("aircursor:settings", (_event, payload) => handler(payload));
  },
  onStatus: (handler) => {
    ipcRenderer.on("aircursor:overlay-status", (_event, payload) => handler(payload));
  },
  onHelperLog: (handler) => {
    ipcRenderer.on("aircursor:helper-log", (_event, message) => handler(message));
  },
});
