// GestureWall main process.
//
// Three windows, each with one job:
//   wall     — the wallpaper itself, sits at desktop level, renders the layers
//   settings — a normal window for importing images and tuning; opened on demand
//   sensor   — hidden, owns the camera and turns hands into gesture events
//
// The wall is the only one that has to fight macOS for its window level, and that
// fight is the reason for WALL_STRATEGIES below.
const { app, BrowserWindow, ipcMain, screen, globalShortcut, dialog, nativeTheme, protocol, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// 图库的纯逻辑（无 DOM、无 Electron），主进程和 dashboard 共用同一份 —— 两份实现
// 只要有一点不同，就会出现"面板里显示的和实际存的不一样"。
require('./library.js');
const Library = globalThis.GestureWallLibrary;
// 系统动作（打开应用、媒体键）的定义，主进程和 dashboard 共用一份。
require('./system.js');
const System = globalThis.GestureWallSystem;

require('./we-host.js');
const WE = globalThis.GestureWallWE;

const AudioSource = require('./audio-source.js');

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
let overlayWindow = null;
let weWindow = null;
let weProject = null;      // 当前装载的 WE 壁纸（parseProject 的结果）
let weReady = false;       // 壁纸自己调过 wallpaperReady 了吗
// 正在录制哪个动作。主进程要知道，因为录制期间骨架强制显示、其他手势必须屏蔽。
let recordingAction = null;
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
  // 进阶模式：开摄像头手势 + 可录制。默认开 —— 这个产品的卖点就是手势，藏在开关后面
  // 等于默认交付的是一个只能用鼠标的壁纸。普通模式留着给"只想要个好看壁纸"的人。
  proTier: true,
  // 壁纸上画手骨架和指针位置。默认开：录制和调手感时看不见手在哪，反馈只有文字，
  // 而"手势没反应"和"手没被检测到"是两件需要分开的事。
  showHands: true,
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
  // WE 网页壁纸。和我们自己的三层景深壁纸并列，是第二种"壁纸源"。
  we: {
    // 壁纸目录（含 project.json）。null = 用我们自己的三层景深。
    dir: null,
    // 用户在面板上改过的属性覆盖，键对齐 project.json 的 properties。
    // 只存改过的：project.json 的默认值是权威来源，全量复制会在壁纸更新后变陈旧。
    overrides: {},
    fps: 30,
    // 音源。ScreenCaptureKit 抓系统音频，要屏幕录制权限。
    // 'off' 时壁纸会走它自己的空闲动画（样本有 idleWaveEnabled）。
    audioSource: 'off',
  },
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
// overrides 也是不透明字典：键是壁纸自己定的（gridSize/theme/…），我们不认识，
// 按 defaultConfig 的键去递归合并会把用户改过的值全丢掉。
const OPAQUE_DICTS = new Set(['presets', 'slots', 'recorded', 'recordOptions', 'overrides']);

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
  for (const win of [wallWindow, dashboardWindow, sensorWindow, overlayWindow, weWindow]) {
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

// 骨架层：独立窗口，盖在所有东西之上，鼠标穿透。
//
// 第一版把骨架画在壁纸上，那是结构性错误：壁纸在最底层，而**录制时 dashboard 在最前面**
// —— 于是骨架在最需要它的那一刻必然被挡住。而且骨架的用途不只是装饰壁纸：它是"手在
// 哪、有没有被看到"的唯一答案，那个问题在任何窗口在前时都成立。
//
// 三个设置缺一不可（和 AirCursor 的 overlay 一样）：
//   alwaysOnTop 'screen-saver'  盖过普通窗口和 Dock
//   setIgnoreMouseEvents        否则它会吃掉整个屏幕的点击
//   visibleOnAllWorkspaces      切 Space 后还在
function ensureOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
  const { bounds } = screen.getPrimaryDisplay();
  overlayWindow = new BrowserWindow({
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
    focusable: false,
    enableLargerThanScreen: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // forward: true 让鼠标事件继续传给下面的窗口，否则这一层会让整个屏幕点不动。
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  liftOverMenuBar(overlayWindow);
  overlayWindow.on('closed', () => { overlayWindow = null; });
  return overlayWindow;
}

function destroyOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
  overlayWindow = null;
}

// 骨架该不该在：用户开了，**或者正在录制**。
//
// 录制时强制显示而不管用户设置 —— 那是唯一必须看见手的时刻，而"我关了骨架所以录制时
// 什么都看不到"不是一个用户会预期的后果。
function syncOverlayVisibility() {
  const wanted = !!(config && config.gestures.enabled && (config.showHands || recordingAction));
  if (wanted) ensureOverlay();
  else destroyOverlay();
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
  // showHands 或 gestures.enabled 可能变了，骨架窗口要跟着建/拆。无脑同步比逐字段
  // 判断安全：漏一个字段的后果是"开关拨了没反应"。
  syncOverlayVisibility();
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
  syncOverlayVisibility();
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
// 系统动作：打开应用走 /usr/bin/open，媒体键走 osascript。
//
// 两条都**不需要辅助功能授权** —— 这是刻意选的。移动光标/点击那条链需要授权，而缺权限时
// CGEvent 是静默丢弃（不报错、不抛异常），AirCursor 在那上面烧掉四轮 debug。先做零风险
// 的这半，光标控制等有健康状态可查再说。
function runSystemAction(id) {
  const kind = System.systemKindOf(id);
  if (!kind) return { ok: false, error: 'NOT_SYSTEM_ACTION' };

  if (kind === 'app') {
    const args = System.openApp(id, (candidate) => {
      try {
        return spawnSync('/usr/bin/open', candidate, { stdio: 'ignore' }).status === 0;
      } catch {
        return false;
      }
    });
    // 报出用了哪个候选：同一个 App 在不同机器上路径/bundle id/名字都可能不同，而
    // "试了四个都失败"和"第二个成功了"需要分开看。
    if (args) console.log(`[system] ${id} → open ${args.join(' ')}`);
    else console.warn(`[system] ${id} 全部候选都失败了`);
    return { ok: !!args, via: args };
  }

  const meta = System.MEDIA_KEYS[id];
  if (!meta) return { ok: false, error: 'UNKNOWN_MEDIA_KEY' };
  try {
    // System Events 的 key code 走的不是 CGEvent，所以不吃辅助功能授权。
    const script = `tell application "System Events" to key code ${meta.keyCode}`;
    const result = spawnSync('/usr/bin/osascript', ['-e', script], { stdio: 'ignore' });
    if (result.status !== 0) console.warn(`[system] ${id} osascript 失败`);
    return { ok: result.status === 0 };
  } catch (error) {
    console.warn(`[system] ${id} 失败：${error.message}`);
    return { ok: false, error: error.message };
  }
}

ipcMain.on('gesture', (_event, payload) => {
  // 录制期间丢掉所有手势事件。
  //
  // sensor 那边已经有一道守卫（录制时不调 input.update），这里是第二道。两道不是冗余：
  // 那一道防的是"判定被跑了"，这一道防的是"事件从任何路径漏出来"。录制时做动作会经过
  // 各种中间姿势，触发已绑的动作 —— 而那些动作会切模块、转视角、甚至退出模式，把录制
  // 打断。AirCursor 真机上就是这么坏的。
  if (recordingAction) return;

  // 系统动作在主进程执行，不转给壁纸 —— 壁纸不知道怎么打开应用，转过去只是让它
  // 收到一个不认识的 action 然后什么都不做（那正是"手势没反应"的一种）。
  if (payload && System.systemKindOf(payload.action)) {
    const result = runSystemAction(payload.action);
    // dashboard 仍然要知道：它显示"最近事件"，而系统动作的成败是那里唯一的反馈。
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('gesture', { ...payload, system: true, ok: result.ok });
    }
    return;
  }

  if (wallWindow && !wallWindow.isDestroyed()) wallWindow.webContents.send('gesture', payload);
  if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.webContents.send('gesture', payload);
});

// 面板上手动试一个系统动作。录制之前先确认"这个动作在我机器上能用"，否则录完发现
// 打不开应用，分不清是手势没认出来还是 App 找不到。
ipcMain.handle('test-system-action', (_event, id) => runSystemAction(id));

ipcMain.on('sensor-status', (_event, payload) => broadcast('sensor-status', payload));

// 关键点只转给骨架层：dashboard 和壁纸都不画它，而这是 30/s 的高频消息，多发纯浪费。
ipcMain.on('hands', (_event, payload) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('hands', payload);
  }
});

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
  recordingAction = action;
  // 录制时骨架强制显示，不管用户的开关 —— 那是唯一必须看见手的时刻。
  syncOverlayVisibility();
  sensor.webContents.send('start-recording', { action });
  return { ok: true };
});

ipcMain.handle('cancel-recording', () => {
  if (sensorWindow && !sensorWindow.isDestroyed()) {
    sensorWindow.webContents.send('cancel-recording', {});
  }
  recordingAction = null;
  syncOverlayVisibility();
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
  // 无论成败都解除录制态：漏掉这一步会让手势永久屏蔽，而症状是"手势全都不响应"，
  // 那个症状指向的地方和真正的原因差得很远。
  recordingAction = null;
  syncOverlayVisibility();
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
// WE 网页壁纸
// ---------------------------------------------------------------------------

// 为什么不能 loadFile 直接开：那些壁纸是 Vite 打的 ES module
// （`<script type="module" crossorigin>`），而 ES module 在 Chromium 里一律按 CORS
// 语义抓取 —— file:// 的 origin 是 opaque，模块加载直接失败。样本的 bundle 还带
// Vite 的 preload polyfill，对每个 chunk 做 fetch()，在 file:// 下同样抛。
//
// 症状会是**白屏**，而白屏看起来像"这个壁纸不兼容"，不像"协议选错了"。
//
// 自定义 scheme 声明成 standard + secure 之后，模块和 fetch 都按正常 http 语义走，
// 不用关 webSecurity（壁纸是第三方 HTML，不该给它降全局安全等级）。
const WE_SCHEME = 'wall';

protocol.registerSchemesAsPrivileged([{
  scheme: WE_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

// 把 wall://host/<相对路径> 映射到当前壁纸目录下的文件。
//
// ⚠️ 只服务当前壁纸目录，且路径要夹在目录内 —— 第三方 HTML 里一个
// `fetch('../../../../etc/passwd')` 不该读到东西。
function registerWEProtocol() {
  protocol.handle(WE_SCHEME, (request) => {
    if (!weProject || !weProject.dir) return new Response('no wallpaper', { status: 404 });
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || weProject.file;
    const root = path.resolve(weProject.dir);
    const target = path.resolve(root, rel);
    // path.resolve 已经把 .. 折叠掉了，所以这里比较前缀就够。加 path.sep 是为了
    // 不让 /foo/barbaz 通过 /foo/bar 的前缀检查。
    if (target !== root && !target.startsWith(root + path.sep)) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(`file://${target}`);
  });
}

// 读壁纸目录的 project.json。
function loadWEProject(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, 'project.json'), 'utf8');
    const parsed = WE.parseProject(JSON.parse(raw));
    if (!parsed) return { ok: false, error: 'project.json 解析后为空' };
    if (!parsed.supported) {
      // scene / video 要解 WE 的私有 .pkg/.tex 格式。那条路连 Open Wallpaper Engine
      // 都只做到"显示静态底图"（粒子代码是死的、零 shader），不值得走。
      return { ok: false, error: `暂不支持 type=${parsed.type}，只支持 Web 类型` };
    }
    return { ok: true, project: { ...parsed, dir } };
  } catch (error) {
    return { ok: false, error: `读 project.json 失败：${error.message}` };
  }
}

function destroyWEWindow() {
  if (wePropTimer) { clearInterval(wePropTimer); wePropTimer = null; }
  if (weWindow && !weWindow.isDestroyed()) weWindow.destroy();
  weWindow = null;
  weReady = false;
}

function createWEWindow() {
  if (!weProject) return null;
  const strategy = WALL_STRATEGIES[strategyIndexById(config.wallStrategy)];
  const { bounds } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    enableLargerThanScreen: true,
    // 不透明：WE 壁纸自己画满整屏（样本的 body 是 background:#000）。
    // transparent 会让它的 GLSL 混色和我们的透明背景打架。
    backgroundColor: '#000000',
    ...strategy.options,
    webPreferences: {
      preload: path.join(__dirname, 'we-preload.js'),
      // ⚠️ 这里曾经是 contextIsolation: false，因为属性接口是反向的（壁纸自己挂
      // window.wallpaperPropertyListener 等宿主去调），而隔离世界读不到页面挂的东西。
      //
      // 改回 true 了。壁纸是从创意工坊下的第三方 HTML，同世界意味着它可能摸到
      // require ⟹ 能读用户的文件系统。那个风险不值得为一个接口形状承担，而且两个
      // 方向都有不关隔离的办法：
      //   我们→壁纸：contextBridge.exposeInMainWorld（它本来就是往主世界桥）
      //   壁纸→我们：executeJavaScript 跑在主世界（见 sendWEProperties）
      contextIsolation: true,
      nodeIntegration: false,
      // 第三方 HTML 就该按第三方对待。sandbox 会限制 preload 里能 require 的东西，
      // 而 we-preload 只用 electron 的 contextBridge/ipcRenderer，两个都在白名单内。
      sandbox: true,
      // 壁纸持续动画，而"不是焦点窗口"对壁纸是常态 —— 让 Chromium 在那里节流
      // 等于永久卡住动画。
      backgroundThrottling: false,
    },
  });

  win.loadURL(`${WE_SCHEME}://wallpaper/${weProject.file}`);
  try {
    strategy.apply(win);
  } catch (error) {
    console.warn(`[we] strategy ${strategy.id} apply failed:`, error.message);
  }

  // 加载失败要说出来。白屏的原因有好几种（协议没注册、文件名不对、模块加载失败），
  // 而它们在外面看起来一模一样。
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.warn(`[we] 加载失败 ${code} ${desc} ${url}`);
    broadcast('we-status', weStatus(`加载失败：${desc}`));
  });

  win.webContents.on('did-finish-load', () => {
    sendWEProperties();
    // ⚠️ 不在这里判"成功"。did-finish-load 只说 HTML 到了，不说里面的 ES module
    // 跑起来了 —— 而模块加载失败正是 file:// 那个坑的症状。真正的成功信号是壁纸
    // 自己调 wallpaperReady（见 ipcMain.on('we-ready')）。
    broadcast('we-status', weStatus(null));
  });

  return win;
}

// 把 project.json 的属性（叠加用户覆盖）发给壁纸。
//
// ⚠️ 这条是**反向**的：壁纸自己执行 `window.wallpaperPropertyListener = {…}` 然后等
// 宿主去调它。所以不能走 IPC + preload —— 隔离世界里读不到页面挂的对象。
//
// executeJavaScript **默认跑在主世界**（要跑隔离世界得显式用
// executeJavaScriptInIsolatedWorld），所以主进程可以直接在页面世界里调那个对象。
// 这样属性能发进去，而 contextIsolation 保持开着。
//
// 页面可能还没挂上（壁纸的 bundle 是 ES module，加载是异步的），所以脚本里自己判断
// 并把没送到的报回来 —— 由调用方决定要不要重试。
function applyWEProperties(props, general) {
  if (!weWindow || weWindow.isDestroyed()) return Promise.resolve({ applied: false });
  // JSON.stringify 两次：一次把对象变成字面量，外层那次是为了让它作为字符串安全嵌入。
  // 直接拼对象会让壁纸名里的引号或反斜杠把脚本劈开。
  const script = `(() => {
    const listener = window.wallpaperPropertyListener;
    if (!listener) return { applied: false, reason: 'no-listener' };
    let user = false, general = false;
    try {
      if (typeof listener.applyUserProperties === 'function') {
        listener.applyUserProperties(JSON.parse(${JSON.stringify(JSON.stringify(props))}));
        user = true;
      }
      if (typeof listener.applyGeneralProperties === 'function') {
        listener.applyGeneralProperties(JSON.parse(${JSON.stringify(JSON.stringify(general))}));
        general = true;
      }
    } catch (error) {
      return { applied: false, reason: String(error && error.message) };
    }
    return { applied: user || general, user, general };
  })()`;
  return weWindow.webContents.executeJavaScript(script, true)
    .catch((error) => ({ applied: false, reason: String(error && error.message) }));
}

// 发属性，页面还没挂好就重试。
//
// ⚠️ 有上限：不是每个壁纸都有可配置项，无上限重试会对那些壁纸永远转下去。
const WE_PROP_RETRY_MS = 120;
const WE_PROP_TIMEOUT_MS = 8000;
let wePropTimer = null;

function sendWEProperties() {
  if (!weWindow || weWindow.isDestroyed() || !weProject) return;
  const props = WE.userProperties(weProject.properties, config.we.overrides);
  const general = WE.generalProperties(config.we.fps);
  const startedAt = Date.now();

  if (wePropTimer) { clearInterval(wePropTimer); wePropTimer = null; }

  const attempt = async () => {
    const result = await applyWEProperties(props, general);
    if (result.applied) {
      if (wePropTimer) { clearInterval(wePropTimer); wePropTimer = null; }
      return;
    }
    if (Date.now() - startedAt > WE_PROP_TIMEOUT_MS) {
      if (wePropTimer) { clearInterval(wePropTimer); wePropTimer = null; }
      // 说出来而不是静默放弃：'no-listener' 是"这个壁纸没有可配置项"（正常），
      // 别的原因是真出问题了。两者在画面上都看不出来。
      if (result.reason !== 'no-listener') {
        console.warn('[we] 属性发不进去:', result.reason);
      }
    }
  };

  attempt();
  wePropTimer = setInterval(attempt, WE_PROP_RETRY_MS);
}

function weStatus(error) {
  return {
    dir: weProject ? weProject.dir : null,
    title: weProject ? weProject.title : null,
    wantsAudio: weProject ? weProject.wantsAudio : false,
    // ⚠️ ready 是"壁纸里的 JS 真的跑起来了"，不是"窗口开了"。这两件事分开报,
    // 因为白屏时它们的值不同 —— 这是唯一能区分"没加载"和"加载了但没渲染"的观测点。
    ready: weReady,
    audioSource: config && config.we ? config.we.audioSource : 'off',
    // 采集侧的状态（权限、是否真的按 App 过滤成功）单独一层，别和窗口状态混。
    audio: audioStatus,
    error: error || null,
  };
}

// 装载一个 WE 壁纸目录。null = 卸掉，回到我们自己的三层景深。
function setWEWallpaper(dir) {
  if (!dir) {
    weProject = null;
    destroyWEWindow();
    syncAudioSource();
    if (!wallWindow || wallWindow.isDestroyed()) wallWindow = createWallWindow(config.wallStrategy);
    broadcast('we-status', weStatus(null));
    return { ok: true, cleared: true };
  }

  const loaded = loadWEProject(dir);
  if (!loaded.ok) {
    broadcast('we-status', weStatus(loaded.error));
    return { ok: false, error: loaded.error };
  }

  weProject = loaded.project;
  weReady = false;
  // 两种壁纸源互斥：都钉在桌面层会互相遮挡，而"我看到的是哪个"就没法判断了。
  if (wallWindow && !wallWindow.isDestroyed()) wallWindow.destroy();
  wallWindow = null;
  destroyWEWindow();
  weWindow = createWEWindow();
  syncAudioSource();
  return { ok: true, project: { title: weProject.title, dir: weProject.dir } };
}

// 壁纸自己调 wallpaperReady 了 —— 这是"里面的 JS 活着"的唯一证据。
ipcMain.on('we-ready', () => {
  weReady = true;
  broadcast('we-status', weStatus(null));
});

ipcMain.handle('we-pick', async () => {
  const result = await dialog.showOpenDialog(dashboardWindow || undefined, {
    title: '选择 Wallpaper Engine 壁纸目录（含 project.json）',
    properties: ['openDirectory'],
    buttonLabel: '装载',
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
  const out = setWEWallpaper(result.filePaths[0]);
  if (out.ok) {
    config.we.dir = weProject.dir;
    writeConfig(config);
    broadcast('config', config);
  }
  return out;
});

ipcMain.handle('we-clear', () => {
  const out = setWEWallpaper(null);
  config.we.dir = null;
  writeConfig(config);
  broadcast('config', config);
  return out;
});

// 面板上改一项属性。热改：不重载页面，直接发属性 —— 样本的 applyUserProperties 就是
// 为运行时改配置设计的（WE 用户在 Steam 面板上拖滑块就是走这条）。
ipcMain.handle('we-set-property', (_event, key, value) => {
  if (!weProject) return { ok: false, error: '没有装载 WE 壁纸' };
  config.we.overrides[key] = value;
  writeConfig(config);
  if (weWindow && !weWindow.isDestroyed()) {
    // 单项热改也走 executeJavaScript —— 和上面同一条路，不是两套机制。
    applyWEProperties({ [key]: { value } }, WE.generalProperties(config.we.fps));
  }
  return { ok: true };
});

// 面板要渲染配置控件，直接从 project.json 生成 —— 不给每个壁纸手写 UI。
ipcMain.handle('we-controls', () => {
  if (!weProject) return { ok: false, controls: [] };
  return {
    ok: true,
    title: weProject.title,
    controls: WE.controlsOf(weProject.properties),
    overrides: config.we.overrides,
  };
});

ipcMain.handle('we-status', () => ({ ...weStatus(null), audio: audioStatus }));

// 切音源。'netease' / 'system' / 'off'
ipcMain.handle('we-set-audio-source', (_event, source) => {
  if (!['netease', 'system', 'off'].includes(source)) {
    return { ok: false, error: `未知音源 ${source}` };
  }
  config.we.audioSource = source;
  writeConfig(config);
  // 先停再起：换过滤条件要重建 SCStream。
  if (audioTap) { audioTap.stop(); audioTap = null; }
  syncAudioSource();
  broadcast('config', config);
  return { ok: true, source };
});

// 把歌曲信息喂给 WE 壁纸的四个 media 回调。
//
// 四个通道分开发，因为壁纸注册的是四个独立 listener，而它们的更新频率差一个量级
// （歌名换歌才变、进度每秒都变）。合成一个通道会让壁纸每秒重跑换封面的过渡动画。
function sendWEMedia(track) {
  if (!weWindow || weWindow.isDestroyed()) return;
  const wc = weWindow.webContents;
  wc.send('we-media-properties', WE.mediaProperties(track));
  wc.send('we-media-thumbnail', WE.mediaThumbnail(track));
  wc.send('we-media-playback', WE.mediaPlayback(track));
  wc.send('we-media-timeline', WE.mediaTimeline(track));
}

// 音频帧入口。采集在原生 helper 里（Electron 的 desktopCapturer 在 macOS 上不给
// 系统音频），这里只做形状校验和转发。
//
// ⚠️ 静默（全 0）要能被看见：没授权拿到的就是全 0，而全 0 的画面看起来是
// "音频响应坏了"。所以 normalizeAudioFrame 会报 silent，面板拿它显示状态。
let audioTap = null;
let audioStatus = null;

// 启停音频采集。跟着 config.we.audioSource 走：
//   'netease' 只抓网易云（macOS 14.4+，更早会退回全局并报 warning）
//   'system'  全系统混音
//   'off'     不采集（壁纸走它自己的空闲动画）
function syncAudioSource() {
  const want = weProject && weProject.wantsAudio && config.we.audioSource !== 'off';
  if (!want) {
    if (audioTap) { audioTap.stop(); audioTap = null; }
    audioStatus = null;
    return;
  }
  if (audioTap) return;   // 已经在跑

  audioTap = AudioSource.start({
    sourcePath: path.join(__dirname, '..', 'native', 'GestureWallAudio.swift'),
    outDir: path.join(app.getPath('userData'), 'native'),
    bundle: config.we.audioSource === 'netease' ? AudioSource.NETEASE_BUNDLE : null,
    onFrame: pushWEAudio,
    onStatus: (status) => {
      audioStatus = status;
      // ⚠️ 状态一定要送到面板。这条链失败全是静默的（没授权=柱子不动），
      // 而"柱子不动"和"没在放歌"、"壁纸不支持音频"是同一个画面。
      broadcast('we-audio-status', status);
      if (!status.ok) console.warn('[audio]', status.text);
    },
  });
}

let lastAudioSilentAt = 0;
function pushWEAudio(frame) {
  if (!weWindow || weWindow.isDestroyed()) return;
  const result = WE.normalizeAudioFrame(frame);
  weWindow.webContents.send('we-audio', result.data);
  if (result.silent) {
    const now = Date.now();
    // 别每帧都播报，那会把 IPC 灌满。
    if (now - lastAudioSilentAt > 3000) {
      lastAudioSilentAt = now;
      broadcast('we-audio-status', { silent: true, reason: result.reason || 'all-zero' });
    }
  }
}

// ---------------------------------------------------------------------------
// Now playing (macOS)
// ---------------------------------------------------------------------------
require('./nowplaying').install({
  ipcMain,
  getConfig: () => config,
  onTrack: (track) => {
    broadcast('track', track);
    // WE 壁纸走自己的四通道 media 协议，不是我们的 'track' 事件。
    sendWEMedia(track);
  },
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  config = readConfig();
  registerWEProtocol();
  // 上次装的 WE 壁纸还在就恢复它，否则用我们自己的三层景深。
  if (config.we.dir && fs.existsSync(path.join(config.we.dir, 'project.json'))) {
    setWEWallpaper(config.we.dir);
  } else {
    wallWindow = createWallWindow(config.wallStrategy);
  }
  followDisplayChanges();
  openDashboard();
  if (config.gestures.enabled) ensureSensor();
  syncOverlayVisibility();

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
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // helper 是独立进程，不显式杀会留下孤儿继续占着屏幕录制。
  if (audioTap) audioTap.stop();
});
