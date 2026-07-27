const { app, BrowserWindow, ipcMain, screen, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const helperSource = path.join(root, "native", "AirCursorPointer.swift");
const helperBinary = path.join(root, "native", "AirCursorPointer");

let mainWindow;
let pointerHelper;

function compilePointerHelper() {
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
  pointerHelper = spawn(helperBinary, [], { stdio: ["pipe", "ignore", "pipe"] });
  pointerHelper.stderr.on("data", (chunk) => {
    if (mainWindow) {
      mainWindow.webContents.send("aircursor:helper-log", chunk.toString());
    }
  });
  pointerHelper.on("exit", () => {
    pointerHelper = null;
  });
}

function sendPointer(command) {
  if (!pointerHelper || pointerHelper.killed) {
    startPointerHelper();
  }
  pointerHelper.stdin.write(`${JSON.stringify(command)}\n`);
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

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const bounds = display.bounds;

  mainWindow = new BrowserWindow({
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
    skipTaskbar: false,
    title: "AirCursor",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.loadFile(path.join(root, "public", "index.html"));
}

app.whenReady().then(() => {
  startPointerHelper();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (pointerHelper && !pointerHelper.killed) {
    pointerHelper.kill();
  }
});

ipcMain.handle("aircursor:get-screen", () => screen.getPrimaryDisplay().bounds);
ipcMain.handle("aircursor:open-netease", () => ({ ok: openNeteaseMusic() }));
ipcMain.handle("aircursor:open-accessibility", () => {
  shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
  return { ok: true };
});
ipcMain.on("aircursor:pointer", (_event, command) => {
  sendPointer(command);
});
