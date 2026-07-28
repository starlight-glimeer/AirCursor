// GestureWall main process.
//
// Three windows, each with one job:
//   wall     — the wallpaper itself, sits at desktop level, renders the layers
//   settings — a normal window for importing images and tuning; opened on demand
//   sensor   — hidden, owns the camera and turns hands into gesture events
//
// The wall is the only one that has to fight macOS for its window level, and that
// fight is the reason for WALL_STRATEGIES below.
const { app, BrowserWindow, ipcMain, screen, globalShortcut, dialog, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');

let wallWindow = null;
let settingsWindow = null;
let sensorWindow = null;
let currentStrategy = null;

// How to put a window behind everything else on macOS.
//
// There is no documented API for "wallpaper layer". `type: 'desktop'` maps to
// kCGDesktopWindowLevel - 1, which is *below* the desktop picture — if that
// picture is opaque the window may never be visible, and the docs also say such a
// window "will not receive focus, keyboard or mouse events". Neither claim can be
// settled without running it, so all three candidates ship and the app cycles
// through them at runtime (⌃⇧L) instead of betting on one at build time.
//
// Ordered by how close each is to a real wallpaper, best first.
const WALL_STRATEGIES = [
  {
    id: 'desktop',
    label: 'desktop 层（真壁纸层，可能收不到鼠标）',
    options: { type: 'desktop' },
    apply: (win) => {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    },
  },
  {
    id: 'bottom-normal',
    label: '普通窗口压到最底（能收鼠标，会出现在 Mission Control）',
    options: {},
    // Plain windows get clamped to the work area, so this one needs the explicit
    // full-screen pass to reach under the menu bar.
    fullScreen: true,
    apply: (win) => {
      win.setAlwaysOnTop(false);
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    },
  },
  {
    id: 'floating',
    label: '悬浮最上层（一定看得见，用来验渲染，不是壁纸）',
    options: {},
    fullScreen: true,
    apply: (win) => {
      // 'screen-saver' rather than 'floating': floating sits *below* the Dock and
      // the menu bar, which is exactly the strip that was left uncovered. This
      // level is only for checking the rendering, so covering everything is the
      // point.
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    },
  },
];

function strategyIndexById(id) {
  const i = WALL_STRATEGIES.findIndex((s) => s.id === id);
  return i < 0 ? 0 : i;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const defaultConfig = {
  wallStrategy: 'desktop',
  layers: {
    // Absolute paths, not copies: the user picked these files, and duplicating
    // them into userData would go stale the moment they edit the original.
    background: null,
    subject: null,
    shard: null,
  },
  // Depth as a z offset in scene units. The camera sits at z=6, so these are
  // "how far behind the glass" each layer sits.
  depth: { background: -4.5, subject: 0, shard: 2.2 },
  transform: {
    background: { scale: 1.12, x: 0, y: 0 },
    subject: { scale: 1.0, x: 0, y: 0 },
    shard: { scale: 1.0, x: 0, y: 0 },
  },
  shards: { count: 5, spread: 1.7, drift: 1.0 },
  parallax: 1.0,
  tilt: { maxYaw: 30, maxPitch: 18 },
  zoom: { min: 0.7, max: 2.4 },
  music: { enabled: true, moodFromCover: true, coverInfluence: 0.55, pollMs: 1500 },
  gestures: { enabled: false },
  debug: { showHud: true },
};

let config = null;

function readConfig() {
  try {
    return mergeConfig(defaultConfig, JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8')));
  } catch {
    return JSON.parse(JSON.stringify(defaultConfig));
  }
}

// Deep merge so a config written by an older version keeps working when new keys
// appear: a missing key falls back to the new default instead of reading
// undefined downstream. Arrays and primitives are replaced wholesale.
function mergeConfig(base, saved) {
  if (saved === null || saved === undefined) return JSON.parse(JSON.stringify(base));
  if (Array.isArray(base) || typeof base !== 'object') return saved;
  const out = {};
  for (const key of Object.keys(base)) out[key] = mergeConfig(base[key], saved[key]);
  return out;
}

function writeConfig() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE()), { recursive: true });
    fs.writeFileSync(CONFIG_FILE(), JSON.stringify(config, null, 2));
  } catch (error) {
    console.warn('[config] write failed:', error.message);
  }
}

function broadcast(channel, payload) {
  for (const win of [wallWindow, settingsWindow, sensorWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function createWallWindow(strategyId) {
  const strategy = WALL_STRATEGIES[strategyIndexById(strategyId)];
  currentStrategy = strategy;

  // Full display bounds, not workArea: a wallpaper belongs under the menu bar and
  // the Dock, not inside the area left over for windows.
  const { bounds } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    ...strategy.options,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The wall animates continuously, and for a wallpaper "not the focused
      // window" is the normal state — letting Chromium throttle it there would
      // stall the animation permanently.
      backgroundThrottling: false,
    },
  });

  win.loadFile(path.join(__dirname, 'wall.html'));
  try {
    strategy.apply(win);
  } catch (error) {
    console.warn(`[wall] strategy ${strategy.id} apply failed:`, error.message);
  }

  // Reassert the frame after the strategy has run. Constructor bounds are a
  // request, and macOS shrinks a plain window to the work area — measured, the top
  // strip under the menu bar was left uncovered. setBounds afterwards is honoured
  // where the constructor was not.
  //
  // simpleFullScreen rather than setFullScreen: the real fullscreen API moves the
  // window into its own Space, which is the opposite of what a wallpaper wants.
  try {
    win.setBounds(bounds);
    if (typeof win.setSimpleFullScreen === 'function' && strategy.fullScreen) {
      win.setSimpleFullScreen(true);
    }
  } catch (error) {
    console.warn(`[wall] bounds reassert failed:`, error.message);
  }

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('config', config);
    win.webContents.send('strategy', { id: strategy.id, label: strategy.label });
  });

  console.log(`[wall] 壁纸层策略: ${strategy.id} — ${strategy.label}`);
  return win;
}

function recreateWall(strategyId) {
  config.wallStrategy = strategyId;
  writeConfig();
  const old = wallWindow;
  wallWindow = createWallWindow(strategyId);
  if (old && !old.isDestroyed()) old.destroy();
  broadcast('config', config);
  broadcast('strategy', {
    id: currentStrategy.id,
    label: currentStrategy.label,
    all: WALL_STRATEGIES.map((s) => ({ id: s.id, label: s.label })),
  });
}

function cycleStrategy() {
  const next = (strategyIndexById(config.wallStrategy) + 1) % WALL_STRATEGIES.length;
  recreateWall(WALL_STRATEGIES[next].id);
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 480,
    height: 820,
    title: 'GestureWall',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141418' : '#f4f4f6',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.webContents.on('did-finish-load', () => {
    settingsWindow.webContents.send('config', config);
    settingsWindow.webContents.send('strategy', {
      id: currentStrategy && currentStrategy.id,
      label: currentStrategy && currentStrategy.label,
      all: WALL_STRATEGIES.map((s) => ({ id: s.id, label: s.label })),
    });
  });
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// The camera lives in its own hidden window rather than in the wall: a
// desktop-level window may not be focusable, and getUserMedia in a window that
// cannot be focused is a permission prompt nobody can answer. Separating it also
// means the wall keeps rendering if gesture recognition dies.
function ensureSensor() {
  if (sensorWindow && !sensorWindow.isDestroyed()) return sensorWindow;
  sensorWindow = new BrowserWindow({
    width: 360,
    height: 270,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  sensorWindow.loadFile(path.join(__dirname, 'sensor.html'));
  sensorWindow.webContents.on('did-finish-load', () => {
    sensorWindow.webContents.send('config', config);
  });
  sensorWindow.on('closed', () => { sensorWindow = null; });
  return sensorWindow;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('get-config', () => config);

ipcMain.handle('set-config', (_event, patch) => {
  config = mergeConfig(config, patch);
  writeConfig();
  broadcast('config', config);
  return config;
});

const LAYER_LABEL = { background: '背景', subject: '主体', shard: '碎片' };

ipcMain.handle('pick-image', async (_event, layer) => {
  const result = await dialog.showOpenDialog(settingsWindow || undefined, {
    title: `选择${LAYER_LABEL[layer] || ''}图片`,
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  config.layers[layer] = result.filePaths[0];
  writeConfig();
  broadcast('config', config);
  return result.filePaths[0];
});

ipcMain.handle('clear-image', (_event, layer) => {
  config.layers[layer] = null;
  writeConfig();
  broadcast('config', config);
  return config;
});

ipcMain.handle('set-strategy', (_event, id) => {
  recreateWall(id);
  return { ok: true, id };
});

ipcMain.handle('set-gestures', (_event, enabled) => {
  config.gestures.enabled = !!enabled;
  writeConfig();
  if (config.gestures.enabled) ensureSensor();
  else if (sensorWindow && !sensorWindow.isDestroyed()) sensorWindow.destroy();
  broadcast('config', config);
  return config;
});

ipcMain.handle('reset-view', () => {
  broadcast('reset-view', {});
  return { ok: true };
});

// Gesture and music events both land here and go straight through. Main relays
// rather than translates: whoever produces an event decides what it means, so
// there is one place to look when something fires that should not have.
ipcMain.on('gesture', (_event, payload) => {
  if (wallWindow && !wallWindow.isDestroyed()) wallWindow.webContents.send('gesture', payload);
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('gesture', payload);
});

ipcMain.on('sensor-status', (_event, payload) => broadcast('sensor-status', payload));

// ---------------------------------------------------------------------------
// Now playing (macOS)
// ---------------------------------------------------------------------------
require('./nowplaying').install({
  ipcMain,
  getConfig: () => config,
  onTrack: (track) => broadcast('track', track),
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  config = readConfig();
  wallWindow = createWallWindow(config.wallStrategy);
  openSettings();
  if (config.gestures.enabled) ensureSensor();

  // A desktop-level window cannot be clicked, so every escape hatch has to be a
  // global shortcut. Without these the app could become unreachable.
  globalShortcut.register('Control+Shift+W', openSettings);
  globalShortcut.register('Control+Shift+L', cycleStrategy);
  globalShortcut.register('Control+Shift+R', () => broadcast('reset-view', {}));
  globalShortcut.register('Control+Shift+Q', () => app.quit());

  console.log('\n=== GestureWall ===');
  console.log('  ⌃⇧W 设置    ⌃⇧L 换壁纸层    ⌃⇧R 复位视角    ⌃⇧Q 退出\n');
});

// Deliberately does not quit: closing the settings window is not quitting the
// wallpaper. ⌃⇧Q is the way out.
app.on('window-all-closed', () => {});
app.on('will-quit', () => globalShortcut.unregisterAll());
