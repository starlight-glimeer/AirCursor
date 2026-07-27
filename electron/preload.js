const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aircursor", {
  platform: process.platform,
  getScreen: () => ipcRenderer.invoke("aircursor:get-screen"),
  openNetease: () => ipcRenderer.invoke("aircursor:open-netease"),
  openAccessibilitySettings: () => ipcRenderer.invoke("aircursor:open-accessibility"),
  pointer: (command) => ipcRenderer.send("aircursor:pointer", command),
  onHelperLog: (handler) => {
    ipcRenderer.on("aircursor:helper-log", (_event, message) => handler(message));
  },
});
