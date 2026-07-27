const { app, BrowserWindow, ipcMain, screen, session, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const helperSource = app.isPackaged
  ? path.join(process.resourcesPath, "native", "AirCursorPointer.swift")
  : path.join(root, "native", "AirCursorPointer.swift");

let dashboardWindow;
let overlayWindow;
let pointerHelper;
let quitting = false;

const settings = {
  overlayVisible: true,
  showHands: true,
  controlEnabled: false,
  voiceEnabled: true,
};

function compilePointerHelper() {
  const helperBinary = path.join(app.getPath("userData"), "AirCursorPointer");
  const needsBuild =
    !fs.existsSync(helperBinary) ||
    fs.statSync(helperBinary).mtimeMs < fs.statSync(helperSource).mtimeMs;

  if (!needsBuild) return;

  const result = spawnSync("/usr/bin/swiftc", [helperSource, "-o", helperBinary], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || "Failed to compile AirCursorPointer.");
  }
}

function startPointerHelper() {
  compilePointerHelper();
  const helperBinary = path.join(app.getPath("userData"), "AirCursorPointer");
  pointerHelper = spawn(helperBinary, [], { stdio: ["pipe", "ignore", "pipe"] });
  pointerHelper.stderr.on("data", (chunk) => {
    broadcast("aircursor:helper-log", chunk.toString());
  });
  pointerHelper.on("exit", () => {
    pointerHelper = null;
  });
}

function sendPointer(command) {
  if (!pointerHelper || pointerHelper.killed) startPointerHelper();
  pointerHelper.stdin.write(`${JSON.stringify(command)}\n`);
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

function openNeteaseMusic() {
  const candidates = [
    ["/usr/bin/open", ["/Applications/NeteaseMusic.app"]],
    ["/usr/bin/open", ["-b", "com.netease.163music"]],
    ["/usr/bin/open", ["-a", "NeteaseMusic"]],
    ["/usr/bin/open", ["-a", "网易云音乐"]],
  ];

  for (const [command, args] of candidates) {
    const result = spawnSync(command, args, { stdio: "ignore" });
    if (result.status === 0) return true;
  }
  return false;
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
  dashboardWindow.on("close", (event) => {
    if (process.platform === "darwin" && !quitting) {
      event.preventDefault();
      dashboardWindow.hide();
    }
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
  overlayWindow.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) {
      broadcast("aircursor:overlay-status", { camera: `Overlay: ${message}` });
    }
  });
}

function showDashboard() {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) createDashboardWindow();
  dashboardWindow.show();
  dashboardWindow.focus();
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media" || permission === "camera" || permission === "microphone");
  });

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => (
    permission === "media" || permission === "camera" || permission === "microphone"
  ));

  startPointerHelper();
  createDashboardWindow();
  createOverlayWindow();

  app.on("activate", showDashboard);
});

app.on("before-quit", () => {
  quitting = true;
  if (pointerHelper && !pointerHelper.killed) pointerHelper.kill();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("aircursor:get-state", () => ({
  settings,
  screen: screen.getPrimaryDisplay().bounds,
}));
ipcMain.handle("aircursor:update-settings", (_event, patch) => {
  Object.assign(settings, patch);
  syncSettings();
  return { settings };
});
ipcMain.handle("aircursor:open-netease", () => ({ ok: openNeteaseMusic() }));
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
