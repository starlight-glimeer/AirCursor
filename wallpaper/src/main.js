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

// 图库的纯逻辑（无 DOM、无 Electron），主进程和 dashboard 共用同一份 —— 两份实现
// 只要有一点不同，就会出现"面板里显示的和实际存的不一样"。
require('./library.js');
const Library = globalThis.GestureWallLibrary;

const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');

// 广播前给图库条目标上"文件还在不在"。
//
// 不在写盘的配置里存这个标记：它是运行时事实，存下来就会过期（用户在别处删了文件，
// 配置里还写着 missing: false）。每次广播现算，代价是几个 statSync。
function withLibraryStatus(cfg) {
  if (!cfg.library || !cfg.library.length) return cfg;
  return {
    ...cfg,
    library: Library.markMissing(cfg.library, (p) => {
      try { return fs.existsSync(p); } catch { return false; }
    }),
  };
}

let wallWindow = null;
let dashboardWindow = null;
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
    label: 'desktop 层（真壁纸层，收不到鼠标）',
    options: { type: 'desktop' },
    apply: (win) => {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      // The menu bar strip is the one part a normal window cannot reach: macOS
      // reserves it, and setBounds gets clamped just below it. Verified against the
      // system's own wallpaper, which does cover it — so the window has to be told
      // it may sit outside the visible frame, and then asked again.
      liftOverMenuBar(win);
    },
  },
  {
    id: 'bottom-normal',
    label: '普通窗口压到最底（能收鼠标，会出现在 Mission Control）',
    options: {},
    apply: (win) => {
      win.setAlwaysOnTop(false);
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      liftOverMenuBar(win);
    },
  },
  {
    id: 'floating',
    label: '悬浮最上层（一定看得见，用来验渲染，不是壁纸）',
    options: {},
    apply: (win) => {
      // 'screen-saver' rather than 'floating': floating sits *below* the Dock and
      // the menu bar, which is exactly the strip that was left uncovered. This
      // level is only for checking the rendering, so covering everything is the
      // point.
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      liftOverMenuBar(win);
    },
  },
];

// Push a window over the full display, menu bar strip included.
//
// macOS clamps setBounds to the visible frame, so a wallpaper ends up ~25 px short
// at the top and the real desktop picture shows through. Two things are needed:
// enableLargerThanScreen at construction, and a second setBounds after the window
// exists — the first one alone gets clamped, and the second one alone has nothing
// to permit it.
//
// The retry on a timer is not superstition: the clamp is applied when the window
// joins a Space, which happens after apply() returns.
//
// Bounds are read fresh on every call rather than captured once, because this is
// also what runs when the display changes resolution.
function liftOverMenuBar(win) {
  const push = () => {
    if (!win || win.isDestroyed()) return;
    try {
      win.setBounds(screen.getPrimaryDisplay().bounds);
    } catch (error) {
      console.warn('[wall] setBounds failed:', error.message);
    }
  };
  push();
  win.once('ready-to-show', push);
  setTimeout(push, 350);
}

// Follow the display when it changes.
//
// Without this the wallpaper keeps the frame it was born with: change resolution,
// plug in a monitor, or open the lid on a clamshell setup, and it is suddenly the
// wrong size — either leaving a strip of real desktop showing or hanging off the
// edge. The renderer already handles its own canvas on resize, so this only has to
// fix the window frame; the canvas follows.
//
// Debounced because macOS emits a burst of these during a resolution change, and
// each setBounds during the burst is work thrown away.
let displayFollowTimer = null;

function followDisplayChanges() {
  const schedule = (reason) => {
    if (displayFollowTimer) clearTimeout(displayFollowTimer);
    displayFollowTimer = setTimeout(() => {
      displayFollowTimer = null;
      if (!wallWindow || wallWindow.isDestroyed()) return;
      const { bounds } = screen.getPrimaryDisplay();
      liftOverMenuBar(wallWindow);
      console.log(`[wall] 屏幕变化（${reason}）→ ${bounds.width}x${bounds.height}`);
      // Re-send so the HUD's frame line reflects the new display rather than the
      // one the window was created on.
      sendStrategy(wallWindow, currentStrategy);
    }, 220);
  };
  screen.on('display-metrics-changed', () => schedule('metrics'));
  screen.on('display-added', () => schedule('added'));
  screen.on('display-removed', () => schedule('removed'));
}

function strategyIndexById(id) {
  const i = WALL_STRATEGIES.findIndex((s) => s.id === id);
  return i < 0 ? 0 : i;
}

// Tell a window which strategy is live, and what frame it actually got versus what
// was asked for. The HUD names the gap in pixels — a 25px shortfall under the menu
// bar is not something anyone can eyeball from a screenshot, and one round was
// already spent comparing images when a number would have said it outright.
// `frameOf` defaults to the recipient, but the settings window needs the *wall's*
// frame reported — its own has no business being fullscreen.
function sendStrategy(win, strategy, frameOf) {
  if (!win || win.isDestroyed() || !strategy) return;
  const measured = frameOf && !frameOf.isDestroyed() ? frameOf : win;
  let got = null;
  try { got = measured.getBounds(); } catch { /* window may be gone */ }
  win.webContents.send('strategy', {
    id: strategy.id,
    label: strategy.label,
    wanted: screen.getPrimaryDisplay().bounds,
    got,
    all: WALL_STRATEGIES.map((s) => ({ id: s.id, label: s.label })),
  });
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
  // 手势判定的调参，透给 AirCursor 的 PointerFilter / SwipeDetector / TiltRatchet。
  //
  // deadzone 和 maxPrediction 在这里是**归一化**的（占屏幕的比例），input.js 会换算
  // 成 PointerFilter 期望的像素量级 —— 那边的默认值 1.6px / 26px 是给屏幕指针标的，
  // 直接套在 0..1 坐标上等于死区盖住半个屏幕。
  gestureTuning: {
    minCutoff: 1.2,       // One Euro 静止时的截止频率，越小越稳越迟钝
    beta: 0.045,          // 手速对截止频率的影响，越大越跟手
    deadzone: 0.0016,     // 低于这个位移算手停住了
    prediction: 0.35,     // 按速度外推补延迟
    maxPrediction: 0.026, // 外推上限，防止一次丢跟踪把画面甩出去
    swipeSpeed: 2.6,      // 挥动速度门，掌宽/秒
    tiltTriggerDeg: 22,   // 手掌倾斜多少度算一格
  },
  // 用户存的排布预设，名字 → 视觉参数。必须在这里声明，因为 mergeConfig 只遍历
  // defaultConfig 的键 —— 不声明的话存进去的预设在下次启动时被静默丢掉。
  presets: {},
  // 当前模板，以及三个槽位各选了哪个模块。空对象表示用模板自己的默认。
  template: 'depthStage',
  slots: {},
  // 进阶动作是否显示。默认关：普通用户不该一上来看到八个动作。
  proTier: false,
  // 图库：用户上传的素材。数组而不是字典，因为顺序有意义（新加的在后面）。
  library: [],
  // 已录制的手势，动作 id → { hands, template, keyframes, trigger, ... }。
  recorded: {},
  // 每个动作的录制选项：静态还是动态、几只手。
  //
  // 静态/动态是**用户的选择**而不是按动作名查表。AirCursor 那边一开始硬编码，结果既
  // 拒绝了"用画圈打开某个功能"（适合动态的被强制静态），也在静止姿势就够用的地方
  // 强加了做动作的步骤。
  recordOptions: {},
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

// 键名任意的字典：这些整体替换，不逐键合并。
//
// mergeConfig 只遍历 default 的键 —— 那对"字段固定的配置块"是对的（新版本加的键能
// 落回默认），但对 presets 这种用户自己起名的字典是灾难：默认是 {}，于是存下的每一个
// 预设都在下次启动时被静默丢掉。
const OPAQUE_DICTS = new Set(['presets', 'slots', 'recorded', 'recordOptions']);

// Deep merge so a config written by an older version keeps working when new keys
// appear: a missing key falls back to the new default instead of reading
// undefined downstream. Arrays and primitives are replaced wholesale.
function mergeConfig(base, saved, key) {
  if (saved === null || saved === undefined) return JSON.parse(JSON.stringify(base));
  if (Array.isArray(base) || typeof base !== 'object') return saved;
  if (OPAQUE_DICTS.has(key)) return JSON.parse(JSON.stringify(saved));
  const out = {};
  for (const k of Object.keys(base)) out[k] = mergeConfig(base[k], saved[k], k);
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

// config 的图库状态在这里统一附加，而不是在每个调用点 —— 那有十几处，漏一处就是
// "面板上有的条目不标缺失"，而那种不一致查起来比缺功能烦。
function broadcast(channel, payload) {
  const body = channel === 'config' ? withLibraryStatus(payload) : payload;
  for (const win of [wallWindow, dashboardWindow, sensorWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, body);
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
    // Without this macOS clamps the window to the visible frame, which stops below
    // the menu bar. The system's own wallpaper covers the full display, so ours has
    // to be allowed to as well.
    enableLargerThanScreen: true,
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

  // Reassert the frame after the strategy has run, and report what actually stuck.
  //
  // Constructor bounds are a request. macOS clamps a window to the visible frame,
  // which excludes the menu bar strip — measured on a 1470x956 display, the top ~25
  // px stayed uncovered and the real desktop picture showed through. So: allow the
  // window to exceed the screen, ask again, then log the delta. A wallpaper that
  // silently sits 25 px short is exactly the kind of thing that gets argued about
  // instead of measured.
  try {
    win.setBounds(bounds);
    const got = win.getBounds();
    const short = bounds.y !== got.y || bounds.height !== got.height
      || bounds.x !== got.x || bounds.width !== got.width;
    if (short) {
      console.log(`[wall] bounds 请求 ${bounds.width}x${bounds.height}@${bounds.x},${bounds.y}`
        + ` 实得 ${got.width}x${got.height}@${got.x},${got.y}`);
    }
  } catch (error) {
    console.warn('[wall] bounds reassert failed:', error.message);
  }

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('config', config);
    sendStrategy(win, strategy);
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
  // Both windows, one builder: this payload was assembled by hand in three places
  // and one of them left out the strategy list, so the settings dropdown silently
  // emptied itself after a ⌃⇧L press.
  sendStrategy(wallWindow, currentStrategy);
  sendStrategy(dashboardWindow, currentStrategy, wallWindow);
}

function cycleStrategy() {
  const next = (strategyIndexById(config.wallStrategy) + 1) % WALL_STRATEGIES.length;
  recreateWall(WALL_STRATEGIES[next].id);
}

function openDashboard() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.show();
    dashboardWindow.focus();
    return;
  }
  dashboardWindow = new BrowserWindow({
    width: 940,
    height: 700,
    minWidth: 780,
    minHeight: 560,
    title: 'GestureWall',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141418' : '#f4f4f6',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  dashboardWindow.loadFile(path.join(__dirname, 'dashboard.html'));
  dashboardWindow.webContents.on('did-finish-load', () => {
    dashboardWindow.webContents.send('config', config);
    // Deliberately reports the *wall's* frame, not the settings window's — the
    // settings window has no business being fullscreen.
    sendStrategy(dashboardWindow, currentStrategy, wallWindow);
  });
  dashboardWindow.on('closed', () => { dashboardWindow = null; });
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
  const result = await dialog.showOpenDialog(dashboardWindow || undefined, {
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

// 从图库直接指派到某一层，不开文件对话框。
ipcMain.handle('set-layer', (_event, layer, filePath) => {
  if (!LAYER_LABEL[layer]) return { ok: false };
  config.layers[layer] = filePath || null;
  writeConfig();
  broadcast('config', config);
  return { ok: true };
});

// ---------------------------------------------------------------------------
// 图库
// ---------------------------------------------------------------------------

// 一次多选：攒素材这件事是批量的，一张一张开对话框是纯摩擦。
ipcMain.handle('library-add', async () => {
  const result = await dialog.showOpenDialog(dashboardWindow || undefined, {
    title: '添加素材到图库',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
  });
  if (result.canceled) return { ok: false };
  let items = config.library || [];
  for (const filePath of result.filePaths) {
    // 按文件名猜槽位：带 alpha 的 PNG 大概率是抠好的主体。猜错代价很小（用户在下拉里
    // 改一下），而每张都要手选槽位的代价是真实的。
    const guess = /\.png$/i.test(filePath) ? 'subject' : 'background';
    items = Library.add(items, filePath, guess);
  }
  config.library = items;
  writeConfig();
  broadcast('config', config);
  return { ok: true, added: result.filePaths.length };
});

ipcMain.handle('library-remove', (_event, id) => {
  config.library = Library.remove(config.library || [], id);
  writeConfig();
  broadcast('config', config);
  return { ok: true };
});

ipcMain.handle('library-set-slot', (_event, id, slot) => {
  config.library = Library.setSlot(config.library || [], id, slot);
  writeConfig();
  broadcast('config', config);
  return { ok: true };
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

// 预设：存几套排布，一键切换对比。
//
// 存在的理由是沟通效率而不是功能：调壁纸手感的循环是"我改一个数 → 用户看 → 用户用
// 文字描述哪里不对"，而形容词（"太大""不够立体"）在两个人脑中的画面可能差很远。
// 能存三套并当场切，用户就能直接说"第二套那个感觉对" —— 那是精确的。
//
// 只存视觉参数不存图片路径：三张图是"我的壁纸"的身份，不该被切预设换掉。
const PRESET_KEYS = ['depth', 'transform', 'shards', 'parallax', 'tilt', 'zoom'];

function currentPreset() {
  const out = {};
  for (const key of PRESET_KEYS) out[key] = JSON.parse(JSON.stringify(config[key]));
  return out;
}

ipcMain.handle('save-preset', (_event, name) => {
  const label = String(name || '').trim() || `预设 ${Object.keys(config.presets || {}).length + 1}`;
  config.presets = { ...(config.presets || {}), [label]: currentPreset() };
  writeConfig();
  broadcast('config', config);
  return { ok: true, name: label };
});

ipcMain.handle('load-preset', (_event, name) => {
  const preset = config.presets && config.presets[name];
  if (!preset) return { ok: false, error: 'NOT_FOUND' };
  config = mergeConfig(config, preset);
  writeConfig();
  broadcast('config', config);
  return { ok: true };
});

ipcMain.handle('delete-preset', (_event, name) => {
  if (!config.presets || !(name in config.presets)) return { ok: false };
  const next = { ...config.presets };
  delete next[name];
  // 整个替换而不是改单键：mergeConfig 是深合并，传一个缺了某键的对象删不掉它。
  config.presets = next;
  writeConfig();
  broadcast('config', config);
  return { ok: true };
});

// Gesture and music events both land here and go straight through. Main relays
// rather than translates: whoever produces an event decides what it means, so
// there is one place to look when something fires that should not have.
ipcMain.on('gesture', (_event, payload) => {
  if (wallWindow && !wallWindow.isDestroyed()) wallWindow.webContents.send('gesture', payload);
  if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.webContents.send('gesture', payload);
});

ipcMain.on('sensor-status', (_event, payload) => broadcast('sensor-status', payload));

// ---------------------------------------------------------------------------
// 手势录制
//
// 录制发生在 sensor 窗口（它有摄像头），UI 在 dashboard。主进程转发指令、转发进度、
// 并在成功时把模板写进配置 —— 写盘归主进程，因为 sensor 那边没有配置的所有权。
// ---------------------------------------------------------------------------

ipcMain.handle('start-recording', (_event, action) => {
  if (!config.gestures.enabled) return { ok: false, error: '先开启摄像头手势' };
  const sensor = ensureSensor();
  if (!sensor || sensor.isDestroyed()) return { ok: false, error: '摄像头窗口没起来' };
  sensor.webContents.send('start-recording', { action });
  return { ok: true };
});

ipcMain.handle('cancel-recording', () => {
  if (sensorWindow && !sensorWindow.isDestroyed()) {
    sensorWindow.webContents.send('cancel-recording', {});
  }
  broadcast('recording-result', { ok: false, cancelled: true });
  return { ok: true };
});

ipcMain.handle('clear-recording', (_event, action) => {
  if (!config.recorded || !(action in config.recorded)) return { ok: false };
  const next = { ...config.recorded };
  delete next[action];
  // 整个替换：recorded 在 OPAQUE_DICTS 里，传一个缺键的对象删不掉它。
  config.recorded = next;
  writeConfig();
  broadcast('config', config);
  return { ok: true };
});

ipcMain.on('recording-progress', (_event, payload) => {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send('recording-progress', payload);
  }
});

ipcMain.on('recording-result', (_event, payload) => {
  // 成功就落盘。sensor 只负责产出模板，不碰配置 —— 两边都能写配置的话，"谁把它改了"
  // 就会变成一个需要查的问题。
  if (payload && payload.ok && payload.action && payload.entry) {
    config.recorded = { ...(config.recorded || {}), [payload.action]: payload.entry };
    writeConfig();
    broadcast('config', config);
  }
  broadcast('recording-result', payload);
});

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
  followDisplayChanges();
  openDashboard();
  if (config.gestures.enabled) ensureSensor();

  // A desktop-level window cannot be clicked, so every escape hatch has to be a
  // global shortcut. Without these the app could become unreachable.
  globalShortcut.register('Control+Shift+W', openDashboard);
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
