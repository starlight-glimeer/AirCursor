const { app, BrowserWindow, Menu, ipcMain, screen, session, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const helperSource = app.isPackaged
  ? path.join(process.resourcesPath, "native", "AirCursorPointer.swift")
  : path.join(root, "native", "AirCursorPointer.swift");
const voiceSource = app.isPackaged
  ? path.join(process.resourcesPath, "native", "AirCursorVoice.swift")
  : path.join(root, "native", "AirCursorVoice.swift");
const voiceInfoSource = app.isPackaged
  ? path.join(process.resourcesPath, "native", "AirCursorVoiceInfo.plist")
  : path.join(root, "native", "AirCursorVoiceInfo.plist");

let dashboardWindow;
let overlayWindow;
let pointerHelper;
let voiceHelper;
let voiceBuffer = "";
let voiceStatus = "等待";
let quitting = false;
let systemCursorHidden = false;
let recordingSession = null;

const defaultSettings = {
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
let settings = JSON.parse(JSON.stringify(defaultSettings));

const ruleDefinitions = [
  {
    id: "open_netease",
    label: "打开网易云音乐",
    voice: "打开网易云 / 打开音乐",
    candidates: [
      ["/Applications/NeteaseMusic.app"],
      ["-b", "com.netease.163music"],
      ["-a", "NeteaseMusic"],
      ["-a", "网易云音乐"],
    ],
  },
  {
    id: "open_wechat",
    label: "打开微信",
    voice: "打开微信",
    candidates: [
      ["/Applications/WeChat.app"],
      ["-b", "com.tencent.xinWeChat"],
      ["-a", "WeChat"],
      ["-a", "微信"],
    ],
  },
  {
    id: "open_chrome",
    label: "打开 Chrome",
    voice: "打开浏览器 / 打开 Chrome",
    candidates: [["/Applications/Google Chrome.app"], ["-a", "Google Chrome"], ["-a", "Chrome"]],
  },
  {
    id: "open_safari",
    label: "打开 Safari",
    voice: "打开 Safari",
    candidates: [["-a", "Safari"]],
  },
  {
    id: "open_finder",
    label: "打开访达",
    voice: "打开访达 / 打开 Finder",
    candidates: [["-a", "Finder"]],
  },
  {
    id: "open_terminal",
    label: "打开终端",
    voice: "打开终端 / 打开 Terminal",
    candidates: [["-a", "Terminal"], ["-a", "终端"]],
  },
  {
    id: "open_cursor",
    label: "打开 Cursor",
    voice: "打开 Cursor",
    candidates: [["/Applications/Cursor.app"], ["-a", "Cursor"]],
  },
];

const publicRules = ruleDefinitions.map(({ id, label, voice }) => ({ id, label, voice }));

const recordableActions = ["wake", "click", "rightClick", "exit"];
const defaultGestureMap = {
  wake: "openPalm",
  click: "pinch",
  rightClick: "middlePinch",
  exit: "fist",
};

function mergeSettings(base, incoming) {
  return {
    ...base,
    ...incoming,
    gestureMap: { ...base.gestureMap, ...(incoming?.gestureMap || {}) },
    recordedGestures: { ...base.recordedGestures, ...(incoming?.recordedGestures || {}) },
  };
}

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    settings = mergeSettings(defaultSettings, saved);
  } catch {
    settings = JSON.parse(JSON.stringify(defaultSettings));
  }
}

function saveSettings() {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

function helperBinaryPath(binaryName) {
  return path.join(app.getPath("userData"), `${binaryName}-${app.getVersion()}`);
}

function compilePointerHelper() {
  const helperBinary = helperBinaryPath("AirCursorPointer");
  const needsBuild =
    !fs.existsSync(helperBinary) ||
    fs.statSync(helperBinary).mtimeMs < fs.statSync(helperSource).mtimeMs;

  if (!needsBuild) return helperBinary;

  const result = spawnSync("/usr/bin/swiftc", [helperSource, "-o", helperBinary], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || "Failed to compile AirCursorPointer.");
  }

  return helperBinary;
}

function startPointerHelper() {
  const helperBinary = compilePointerHelper();
  pointerHelper = spawn(helperBinary, [], { stdio: ["pipe", "ignore", "pipe"] });
  if (systemCursorHidden) {
    pointerHelper.stdin.write(`${JSON.stringify({ type: "hideCursor" })}\n`);
  }
  pointerHelper.stderr.on("data", (chunk) => {
    broadcast("aircursor:helper-log", chunk.toString());
  });
  pointerHelper.on("exit", () => {
    pointerHelper = null;
  });
}

function compileSwiftHelper(source, binaryName) {
  const helperBinary = helperBinaryPath(binaryName);
  const extraInputs = binaryName === "AirCursorVoice" ? [voiceInfoSource] : [];
  const needsBuild =
    !fs.existsSync(helperBinary) ||
    fs.statSync(helperBinary).mtimeMs < fs.statSync(source).mtimeMs ||
    extraInputs.some((file) => fs.statSync(helperBinary).mtimeMs < fs.statSync(file).mtimeMs);

  if (!needsBuild) return helperBinary;

  const args = [source, "-o", helperBinary];
  if (binaryName === "AirCursorVoice") {
    args.push("-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", voiceInfoSource);
  }

  const result = spawnSync("/usr/bin/swiftc", args, {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || `Failed to compile ${binaryName}.`);
  }

  return helperBinary;
}

function startVoiceHelper() {
  if (process.platform !== "darwin") return;

  let helperBinary;
  try {
    helperBinary = compileSwiftHelper(voiceSource, "AirCursorVoice");
  } catch (error) {
    voiceStatus = `系统语音不可用：${error.message}`;
    broadcast("aircursor:overlay-status", { voice: voiceStatus });
    return;
  }

  voiceHelper = spawn(helperBinary, [], { stdio: ["ignore", "pipe", "pipe"] });
  voiceHelper.stdout.on("data", (chunk) => {
    voiceBuffer += chunk.toString();
    const lines = voiceBuffer.split(/\r?\n/);
    voiceBuffer = lines.pop() || "";
    for (const line of lines) {
      const phrase = line.trim();
      if (!phrase) continue;
      if (phrase === "__AIRCURSOR_VOICE_READY__") {
        voiceStatus = "macOS 语音已开启";
        broadcast("aircursor:overlay-status", { voice: voiceStatus });
      } else if (phrase.startsWith("__AIRCURSOR_VOICE_ERROR__:")) {
        voiceStatus = phrase.replace("__AIRCURSOR_VOICE_ERROR__:", "");
        broadcast("aircursor:overlay-status", { voice: voiceStatus });
      } else if (phrase.startsWith("__AIRCURSOR_VOICE_HEARD__:")) {
        const heard = phrase.replace("__AIRCURSOR_VOICE_HEARD__:", "");
        voiceStatus = `听到：${heard}`;
        broadcast("aircursor:overlay-status", { voice: voiceStatus });
      } else if (phrase === "__AIRCURSOR_VOICE_TAP__") {
        voiceStatus = "听到：短促确认";
        broadcast("aircursor:overlay-status", { voice: voiceStatus });
        broadcast("aircursor:voice-command", "点");
      } else {
        broadcast("aircursor:voice-command", phrase);
      }
    }
  });
  voiceHelper.stderr.on("data", (chunk) => {
    voiceStatus = chunk.toString().trim();
    broadcast("aircursor:overlay-status", { voice: voiceStatus });
  });
  voiceHelper.on("exit", () => {
    voiceHelper = null;
  });
}

function sendPointer(command) {
  if (!pointerHelper || pointerHelper.killed) startPointerHelper();
  pointerHelper.stdin.write(`${JSON.stringify(command)}\n`);
}

function setSystemCursorHidden(hidden) {
  if (systemCursorHidden === hidden) return;
  systemCursorHidden = hidden;
  sendPointer({ type: hidden ? "hideCursor" : "showCursor" });
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

function updateSettings(patch) {
  const previousControlEnabled = settings.controlEnabled;
  settings = mergeSettings(settings, patch);
  if (settings.controlEnabled !== previousControlEnabled) {
    setSystemCursorHidden(settings.controlEnabled);
  }
  saveSettings();
  syncSettings();
  return settings;
}

// Recording needs both hands visible with the skeleton on, whatever the user's
// normal settings are; the previous values come back when the session ends.
function beginRecording(action, hands) {
  if (!recordableActions.includes(action)) return { ok: false, reason: "未知动作" };
  if (recordingSession) endRecording();

  recordingSession = {
    action,
    hands,
    restore: { twoHands: settings.twoHands, showHands: settings.showHands, controlEnabled: settings.controlEnabled },
  };
  updateSettings({ overlayVisible: true, showHands: true, twoHands: hands > 1 || settings.twoHands, controlEnabled: false });
  broadcast("aircursor:recording", { type: "start", action, hands });
  return { ok: true, action, hands };
}

function endRecording() {
  const session = recordingSession;
  recordingSession = null;
  if (!session) return;
  broadcast("aircursor:recording", { type: "stop", action: session.action });
  updateSettings(session.restore);
}

function saveRecordedTemplate(action, template) {
  if (!recordableActions.includes(action)) return;
  updateSettings({
    gestureMap: { [action]: `custom:${action}` },
    recordedGestures: {
      [action]: { at: Date.now(), hands: template.hands, template },
    },
  });
}

function openWithCandidates(candidates) {
  for (const args of candidates) {
    const result = spawnSync("/usr/bin/open", args, { stdio: "ignore" });
    if (result.status === 0) return true;
  }
  return false;
}

function runRule(ruleId) {
  const rule = ruleDefinitions.find((item) => item.id === ruleId);
  if (!rule) return { ok: false, id: ruleId, label: "未知规则" };

  const ok = openWithCandidates(rule.candidates);
  const result = { ok, id: rule.id, label: rule.label };
  broadcast("aircursor:overlay-status", {
    rule: `${ok ? "已执行" : "执行失败"}：${rule.label}`,
  });
  return result;
}

function quitApp() {
  quitting = true;
  app.quit();
}

function createApplicationMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { label: "显示 AirCursor", accelerator: "CommandOrControl+0", click: showDashboard },
              { type: "separator" },
              { label: "退出 AirCursor", accelerator: "CommandOrControl+Q", click: quitApp },
            ],
          },
        ]
      : []),
    {
      label: "窗口",
      submenu: [
        { label: "显示 AirCursor", accelerator: "CommandOrControl+0", click: showDashboard },
        { type: "separator" },
        { role: "minimize", label: "最小化" },
        { label: "退出 AirCursor", accelerator: isMac ? undefined : "Alt+F4", click: quitApp },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
  dashboardWindow.on("close", () => {
    if (!quitting) quitApp();
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
  loadSettings();
  if (process.platform === "darwin") {
    app.setActivationPolicy?.("regular");
    app.dock?.show();
  }
  createApplicationMenu();

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media" || permission === "camera" || permission === "microphone");
  });

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => (
    permission === "media" || permission === "camera" || permission === "microphone"
  ));

  createDashboardWindow();
  createOverlayWindow();
  startPointerHelper();
  startVoiceHelper();

  app.on("activate", showDashboard);
});

app.on("before-quit", () => {
  quitting = true;
  setSystemCursorHidden(false);
  if (pointerHelper && !pointerHelper.killed) pointerHelper.kill();
  if (voiceHelper && !voiceHelper.killed) voiceHelper.kill();
});

app.on("window-all-closed", () => {
  app.quit();
});

ipcMain.handle("aircursor:get-state", () => ({
  settings,
  screen: screen.getPrimaryDisplay().bounds,
  rules: publicRules,
  status: { voice: voiceStatus },
}));
ipcMain.handle("aircursor:update-settings", (_event, patch) => {
  updateSettings(patch);
  return { settings };
});
ipcMain.handle("aircursor:start-recording", (_event, action, hands) => beginRecording(action, hands === 2 ? 2 : 1));
ipcMain.handle("aircursor:cancel-recording", () => {
  endRecording();
  return { ok: true };
});
ipcMain.handle("aircursor:clear-recorded-gesture", (_event, action) => {
  if (!recordableActions.includes(action)) {
    return { ok: false, reason: "未知动作" };
  }
  const recordedGestures = { ...settings.recordedGestures };
  delete recordedGestures[action];
  settings = {
    ...settings,
    gestureMap: { ...settings.gestureMap, [action]: defaultGestureMap[action] },
    recordedGestures,
  };
  saveSettings();
  syncSettings();
  return { ok: true, settings };
});
ipcMain.handle("aircursor:get-rules", () => ({ rules: publicRules }));
ipcMain.handle("aircursor:run-rule", (_event, ruleId) => runRule(ruleId));
ipcMain.handle("aircursor:open-netease", () => runRule("open_netease"));
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
ipcMain.on("aircursor:recording-progress", (_event, payload) => {
  if (!recordingSession) return;
  broadcast("aircursor:recording-progress", payload);
});
ipcMain.on("aircursor:recording-result", (_event, result) => {
  const session = recordingSession;
  if (!session || result?.action !== session.action) return;
  if (result.ok && result.template) saveRecordedTemplate(result.action, result.template);
  recordingSession = null;
  updateSettings(session.restore);
  broadcast("aircursor:recording-result", {
    ok: Boolean(result.ok),
    action: result.action,
    reason: result.reason,
    hands: result.template?.hands,
    settings,
  });
});
