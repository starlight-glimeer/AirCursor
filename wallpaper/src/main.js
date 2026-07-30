// GestureWall main process.
//
// Three windows, each with one job:
//   wall     — the wallpaper itself, sits at desktop level, renders the layers
//   settings — a normal window for importing images and tuning; opened on demand
//   sensor   — hidden, owns the camera and turns hands into gesture events
//
// The wall is the only one that has to fight macOS for its window level, and that
// fight is the reason for WALL_STRATEGIES below.
const { app, BrowserWindow, ipcMain, screen, globalShortcut, dialog, nativeTheme,
  protocol, net, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
// spawn 给 steamcmd（长跑、要流式读进度），spawnSync 给一次性的系统动作。
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

// 图库的纯逻辑（无 DOM、无 Electron），主进程和 dashboard 共用同一份 —— 两份实现
// 只要有一点不同，就会出现"面板里显示的和实际存的不一样"。
require('./library.js');
const Library = globalThis.GestureWallLibrary;
// 系统动作（打开应用、媒体键）的定义，主进程和 dashboard 共用一份。
require('./system.js');
const System = globalThis.GestureWallSystem;
// 系统投递层(真鼠标/键盘事件 + 本地语音)。整个抽自 AirCursor 的 main.js,不是重写 ——
// 那一层的每条约定都是真机烧出来的,见文件头。
const { createSystemBridge } = require('./system-bridge.js');

require('./we-host.js');
const WE = globalThis.GestureWallWE;

require('./workshop.js');
const Workshop = globalThis.GestureWallWorkshop;

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
  // 手 → 真光标。默认关:一开摄像头就抢走鼠标,用户会没法用鼠标去把它关掉。
  // 需要辅助功能授权,而缺权限时 CGEvent 静默丢弃 —— 所以面板要显示投递层健康状态。
  controlCursor: false,
  // 每个动作上一版的录制,一级回退用。见 rememberPrevious。
  recordUndo: {},
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
    // Steam 创意工坊。⚠️ 密码存在本地配置文件里（明文），诊断报告导出时会脱敏。
    steam: { username: null, password: null, guardCode: null },
    steamCmdPath: null,
    // WE 壁纸单独的层策略：默认 bottom-normal（能收鼠标），不跟 wallStrategy 走。
    // 三层景深那边靠手势控制、不需要鼠标，所以两者的最优选择不一样。
    strategy: 'bottom-normal',
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
// overrides 和 recordUndo 也是不透明字典：键分别是壁纸自己定的（gridSize/theme/…）
// 和动作 id，我们不认识 —— 按 defaultConfig 的键去递归合并会把它们全丢掉。
const OPAQUE_DICTS = new Set([
  'presets', 'slots', 'recorded', 'recordOptions', 'recordUndo', 'overrides',
]);

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

// 一个实例,主进程持有。它需要 broadcast 和"语音说了什么"的回调,所以是工厂而非裸导出。
const systemBridge = createSystemBridge({
  // 仓库根,不是 wallpaper/ —— native/*.swift 只有一份,在根目录。早先我拷了一份到
  // wallpaper/native/ 又删了:两份 Swift 源码意味着两个 hash、两次辅助功能授权。
  root: path.join(__dirname, '..', '..'),
  broadcast,
  // 语音和手势走同一个动作分发:说"打开网易云"和做那个手势应该等价。
  onVoiceText: (phrase) => handleVoiceText(phrase),
});

// 语音文本 → 动作。只认能明确对上的,认不出的报出来而不是静默丢弃 —— 否则"我说了它没反应"
// 和"它没听见"分不开。
const VOICE_PATTERNS = [
  { match: /网易云|音乐/, action: 'open_netease' },
  { match: /浏览器|chrome|谷歌/i, action: 'open_browser' },
  { match: /访达|finder/i, action: 'open_finder' },
  { match: /暂停|播放|停一下/, action: 'media_playpause' },
  { match: /下一首|下一曲/, action: 'media_next' },
  { match: /上一首|上一曲/, action: 'media_prev' },
];

function handleVoiceText(phrase) {
  const text = String(phrase || '').trim();
  if (!text) return;
  const hit = VOICE_PATTERNS.find((p) => p.match.test(text));
  if (!hit) {
    broadcast('voice-status', { text: `没匹配上:${text}` });
    return;
  }
  const result = runSystemAction(hit.action);
  broadcast('voice-status', { text: `${result.ok ? '已执行' : '执行失败'}:${text}` });
}

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
// 拖拽是"按住"语义,而手势事件是一次性的 —— 所以用开关:做一次按下,再做一次放开。
// 直接映射成"手势在就按住"做不到,因为手势事件不带持续状态。
let dragHeld = false;

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

  if (kind === 'pointer') {
    // 这一类走 systemBridge,也就是 CGEvent。缺授权时它静默丢弃,所以健康状态一起返回 ——
    // 让调用方能区分"发出去了"和"系统收到了",那两件事在 AirCursor 上分不开时烧掉四轮。
    const meta = System.POINTER_ACTIONS[id];
    if (!meta) return { ok: false, error: 'UNKNOWN_POINTER_ACTION' };
    if (meta.command === 'dragToggle') {
      dragHeld = !dragHeld;
      systemBridge.send({ type: dragHeld ? 'down' : 'up' });
      return { ok: true, held: dragHeld, health: systemBridge.health() };
    }
    systemBridge.send({ type: meta.command });
    const health = systemBridge.health();
    // 没授权就直说,而不是报 ok:true 让用户以为点了
    if (health.trusted === false) {
      return { ok: false, error: 'NO_ACCESSIBILITY', health };
    }
    return { ok: true, health };
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

  // 连续指针:手 → 真光标。这是"手势替代鼠标"里最实在的一条,也是唯一需要每帧投递的。
  //
  // 默认关着,由 config.controlCursor 开。理由不是保守:一开摄像头就抢走鼠标会让人没法
  // 用电脑去关掉它 —— 那是个能把自己锁在外面的开关。
  if (payload && payload.action === 'pointer' && config.controlCursor) {
    const display = screen.getPrimaryDisplay().bounds;
    systemBridge.send({
      type: 'move',
      x: display.x + payload.x * display.width,
      y: display.y + payload.y * display.height,
    });
  }

  if (wallWindow && !wallWindow.isDestroyed()) wallWindow.webContents.send('gesture', payload);
  if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.webContents.send('gesture', payload);
});

// 面板上手动试一个系统动作。录制之前先确认"这个动作在我机器上能用"，否则录完发现
// 打不开应用，分不清是手势没认出来还是 App 找不到。
ipcMain.handle('test-system-action', (_event, id) => runSystemAction(id));

// 投递层的健康状态。这是"手势没反应"时第一个该看的东西:识别成功和事件送达是两个
// 独立的 claim,而缺权限时 CGEvent 静默丢弃 —— AirCursor 为此烧掉四轮。
ipcMain.handle('pointer-health', () => systemBridge.health());

// 录 5 秒原始关键点。两边所有用例都是合成手,而合成手缺的是真机噪声的**时间相关结构**
// (相邻帧一起漂、丢跟踪后重新检出会跳),而那个差异决定判定层在真手上成不成立。
ipcMain.handle('start-capture', () => {
  if (!sensorWindow || sensorWindow.isDestroyed()) {
    return { ok: false, reason: '摄像头没有开着 —— 先勾上「开启摄像头手势」' };
  }
  sensorWindow.webContents.send('start-capture');
  return { ok: true };
});
ipcMain.on('save-capture', (_event, payload) => {
  try {
    const dir = path.join(app.getPath('userData'), 'captures');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `landmarks-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(payload));
    const frames = payload?.frames?.length ?? 0;
    const withHands = payload?.frames?.filter((f) => f.hands?.length).length ?? 0;
    broadcast('capture-saved', { file, frames, withHands });
  } catch (error) {
    // 报出来而不是吞掉:静默失败会让用户去找一个不存在的文件。
    broadcast('capture-saved', { error: error.message });
  }
});
ipcMain.handle('reveal-captures', () => {
  const dir = path.join(app.getPath('userData'), 'captures');
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
  return { ok: true, dir };
});

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

// 录制前先记住上一版,这样录坏了能退回。
//
// 没有回退,重录就是破坏性的:唯一能知道新的好不好的办法是留下它,而如果更差,旧的已经
// 没了 —— 于是人根本不敢重录。而现在没有内置手型兜底,录制是唯一的路。
//
// 按动作各存一份,不是全局快照:录 B 不该吃掉 A 的回退,那是两件无关的编辑。
function rememberPrevious(action) {
  const undo = { ...(config.recordUndo || {}) };
  // 用 null 表示"之前什么都没有",而不是不存这一条 —— 否则第一次录完点回退会把
  // 刚录的又"恢复"一遍。
  undo[action] = config.recorded?.[action] ?? null;
  config.recordUndo = undo;
}

ipcMain.handle('undo-recording', (_event, action) => {
  const undo = config.recordUndo || {};
  if (!(action in undo)) return { ok: false, reason: '没有可回退的录制' };
  const next = { ...config.recorded };
  const previous = undo[action];
  if (previous) next[action] = previous;
  else delete next[action];
  config.recorded = next;
  // 用掉就删:一级回退,连点两次不该把同一版"恢复"两遍(那看起来生效了但什么都没变)。
  const nextUndo = { ...undo };
  delete nextUndo[action];
  config.recordUndo = nextUndo;
  writeConfig();
  broadcast('config', config);
  return { ok: true, restored: !!previous };
});

ipcMain.handle('clear-recording', (_event, action) => {
  if (!config.recorded || !(action in config.recorded)) return { ok: false };
  // 清除同样是破坏性的,所以一样可回退。
  rememberPrevious(action);
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
    // 先记住上一版再覆盖,否则录坏了没有退路。
    rememberPrevious(payload.action);
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
    // 解析逻辑在 we-host.js 里（纯函数、可测）：越界、空路径、百分号编码这三件
    // 都会错，而每一件的症状都是白屏 —— 看起来像"这个壁纸不兼容"。
    const target = WE.resolveAsset(url.pathname, weProject.dir, weProject.file);
    if (!target) return new Response('forbidden', { status: 403 });
    // ⚠️ 必须用 pathToFileURL，不能裸拼 `file://${target}`。
    // 目录名里的 # ? % 会被当成 URL 的片段/查询/转义起点 ⟹ 路径被**静默截断**，
    // 变成 404 ⟹ 白屏，而白屏看起来像"这个壁纸不兼容"。
    // 实测：'a#b' / 'c?d' / 'e%f' 三种都会错；中文和空格恰好没事，
    // 所以拿中文路径测过也证明不了裸拼是安全的。
    return net.fetch(pathToFileURL(target).href);
  });
}

// 读壁纸目录的 project.json。
function loadWEProject(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, 'project.json'), 'utf8');
    const parsed = WE.parseProject(JSON.parse(raw));
    if (!parsed) return { ok: false, error: 'project.json 解析后为空' };
    if (!parsed.supported) {
      // ⚠️ 不支持时给的是**理由 + 预览图**，不是一句"不支持"。
      // 而且明确说"这不是坏了" —— 否则用户会去排查一个不存在的 bug。
      return {
        ok: false,
        error: WE.refusalReason(parsed),
        project: { ...parsed, dir },
        preview: previewPathOf(dir, parsed),
      };
    }
    // video 类的入口是视频文件不是 html，这里先做个明显性检查。
    if (parsed.type === 'video') {
      const hint = WE.videoHint(parsed.file);
      if (hint) return { ok: false, error: hint, project: { ...parsed, dir } };
    }
    return { ok: true, project: { ...parsed, dir } };
  } catch (error) {
    return { ok: false, error: `读 project.json 失败：${error.message}` };
  }
}

// 找预览图。不支持的类型至少让用户看见"这个壁纸长什么样"，从而知道该不该找替代。
// ⚠️ project.json 的 preview 字段可能指向不存在的文件，所以逐个试。
function previewPathOf(dir, project) {
  const names = [project && project.preview, 'preview.gif', 'preview.jpg', 'preview.png']
    .filter(Boolean);
  for (const name of names) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function destroyWEWindow() {
  if (wePropTimer) { clearInterval(wePropTimer); wePropTimer = null; }
  if (weWindow && !weWindow.isDestroyed()) weWindow.destroy();
  weWindow = null;
  weReady = false;
}

function createWEWindow() {
  if (!weProject) return null;
  // ⚠️ WE 网页壁纸的交互主体是**鼠标**（这个样本 pointerdown ×9、onClick ×8，
  // "点一下掉流星"就是它的卖点）。而默认策略 desktop 是真壁纸层、**收不到鼠标事件** ——
  // 装上去会是"画面出来了但点它没反应"，和壁纸坏了分不清。
  //
  // 所以 WE 壁纸默认用能收鼠标的那个策略。代价是它会出现在 Mission Control 里，
  // 而那个代价比"交互整个不工作"小得多。用户仍可用 ⌃⇧L 切回去。
  const strategyId = config.we.strategy || 'bottom-normal';
  const strategy = WALL_STRATEGIES[strategyIndexById(strategyId)];
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
      // ⚠️ 两种 preload：video 是我们自己的页面（要 gw 那套），
      // web 是第三方壁纸（只给 WE 的 5 个全局函数，见 we-preload.js 的注释）。
      preload: weProject.type === 'video'
        ? path.join(__dirname, 'preload.js')
        : path.join(__dirname, 'we-preload.js'),
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
      // ⚠️ video 那条走我们自己的 preload.js，它 require 的也只有 electron。
      sandbox: true,
      // 壁纸持续动画，而"不是焦点窗口"对壁纸是常态 —— 让 Chromium 在那里节流
      // 等于永久卡住动画。
      backgroundThrottling: false,
    },
  });

  // ⚠️ web 和 video 的装载路径必须分开：video 的 project.file 是视频文件名不是 html，
  // 拿它去 loadURL 会让 Chromium 直接下载或黑屏（不报错）。
  if (weProject.type === 'video') {
    // 页面是我们自己的 video.html，视频文件通过 IPC 把 wall:// 的 URL 送进去。
    win.loadFile(path.join(__dirname, 'video.html'));
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('video-source', {
        url: `${WE_SCHEME}://wallpaper/${encodeURIComponent(weProject.file)}`,
      });
    });
  } else {
    win.loadURL(`${WE_SCHEME}://wallpaper/${weProject.file}`);
  }
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

// ---------------------------------------------------------------------------
// 创意工坊：用用户的 Steam 账号拉壁纸
// ---------------------------------------------------------------------------
//
// 用户买了 Wallpaper Engine（Windows-only），但**工坊内容不是平台相关的** ——
// 那些就是文件，而 steamcmd 有 mac 版。所以账号里的资源能直接用。

// 最近的事件环，进诊断报告。
// ⚠️ 这条链的失败模式又多又静默（没装/没登录/Guard 过期/ID 不存在/下了但目录空），
// 每一种都表现成"壁纸没出来"。所以留一份带时间戳的原始记录，
// 而不是只留最后一句结论 —— 结论是我判断出来的，可能判错。
const EVENT_LIMIT = 200;
const events = [];
function logEvent(source, message, extra) {
  const entry = { at: Date.now(), source, message, ...(extra || {}) };
  events.push(entry);
  if (events.length > EVENT_LIMIT) events.shift();
  // B 层：终端日志。白屏这类问题只有逐环节的时间戳能看出卡在第几步。
  console.log(`[${source}] ${message}`);
  return entry;
}

function findSteamCmd() {
  const custom = config.we.steamCmdPath;
  const candidates = custom ? [custom, ...Workshop.STEAMCMD_CANDIDATES]
    : Workshop.STEAMCMD_CANDIDATES;
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* 权限问题当没找到 */ }
  }
  return null;
}

let downloading = null;

ipcMain.handle('workshop-download', async (_event, input) => {
  const workshopId = Workshop.parseWorkshopId(input);
  if (!workshopId) {
    return { ok: false, error: '认不出工坊 ID —— 贴数字 ID 或者创意工坊页面的链接都行' };
  }
  if (downloading) return { ok: false, error: '已经在下一个了，等它完成' };

  const steamcmd = findSteamCmd();
  if (!steamcmd) {
    logEvent('workshop', 'steamcmd 没找到');
    return { ok: false, error: Workshop.installHint(), needsInstall: true };
  }

  const creds = config.we.steam || {};
  if (!creds.username) {
    return { ok: false, error: '先填 Steam 用户名（工坊物品要登录才能下）', needsLogin: true };
  }

  const args = Workshop.downloadArgs({
    username: creds.username,
    password: creds.password,
    guardCode: creds.guardCode,
    workshopId,
  });
  // ⚠️ 日志里必须脱敏：诊断报告会发给别人看，而 args 里有明文密码。
  logEvent('workshop', `steamcmd ${Workshop.redactArgs(args).join(' ')}`);

  return new Promise((resolve) => {
    const lines = [];
    const child = spawn(steamcmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    downloading = { workshopId, child };

    let buffer = '';
    const onChunk = (chunk) => {
      buffer += String(chunk);
      const parts = buffer.split('\n');
      buffer = parts.pop();
      for (const line of parts) {
        if (!line.trim()) continue;
        lines.push(line);
        const hit = Workshop.classifyLine(line);
        if (hit) {
          logEvent('workshop', hit.text, { kind: hit.kind });
          broadcast('workshop-progress', hit);
        }
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);

    child.on('exit', (code) => {
      downloading = null;
      const summary = Workshop.summarize(lines);
      // steamcmd 的根目录 = 它自己所在目录的上一级（brew 装的话是 libexec）。
      // ⚠️ 这个推断可能错，所以下载完要**验证目录真的存在**再说成功。
      const root = path.dirname(path.dirname(steamcmd));
      const dir = Workshop.contentPath(root, workshopId);
      const landed = dir && fs.existsSync(path.join(dir, 'project.json'));

      if (landed) {
        logEvent('workshop', `下载成功：${dir}`);
        const out = setWEWallpaper(dir);
        config.we.dir = dir;
        writeConfig(config);
        broadcast('config', config);
        resolve({ ok: true, dir, ...out });
        return;
      }
      // ⚠️ 走到这里说明 steamcmd 退出了但我们找不到文件。**分开报两种情况**：
      // 有明确原因（登录/ID）就报那个；没有就报"下载完了但找不到文件"并给出
      // 我们找过的路径 —— 那种情况多半是 steamcmd 的根目录推断错了，
      // 而不给路径的话完全没法查。
      const reason = summary && summary.kind !== 'downloaded'
        ? summary.text
        : `steamcmd 退出（code ${code}）但找不到文件`;
      logEvent('workshop', `失败：${reason}`, { expectedDir: dir });
      resolve({
        ok: false,
        error: reason,
        expectedDir: dir,
        // 最后 30 行原始输出。⚠️ 我的关键字分类可能漏，原文是兜底。
        tail: lines.slice(-30),
      });
    });

    child.on('error', (error) => {
      downloading = null;
      logEvent('workshop', `起不来：${error.message}`);
      resolve({ ok: false, error: `steamcmd 起不来：${error.message}` });
    });
  });
});

ipcMain.handle('workshop-set-steam', (_event, patch) => {
  config.we.steam = { ...(config.we.steam || {}), ...(patch || {}) };
  writeConfig(config);
  return { ok: true, username: config.we.steam.username || null };
});

ipcMain.handle('workshop-probe', () => {
  const steamcmd = findSteamCmd();
  return {
    steamcmd,
    installed: !!steamcmd,
    hint: steamcmd ? null : Workshop.installHint(),
    username: (config.we.steam && config.we.steam.username) || null,
  };
});

// video 页面汇报播放状态。
// ⚠️ 这是"放了但你看不见"的唯一证据：有 currentTime 在涨、有分辨率，
// 就说明解码正常、问题在窗口层级或遮挡 —— 那和"放不了"是两种完全不同的修法。
let videoStatus = null;
ipcMain.on('video-status', (_event, payload) => {
  videoStatus = payload;
  if (payload && payload.ok === false) {
    logEvent('video', `${payload.kind}：${payload.detail || ''}`);
  }
  broadcast('video-status', payload);
});

// ---------------------------------------------------------------------------
// 诊断报告（C 层）
// ---------------------------------------------------------------------------
//
// 用户点一下导出，比自然语言描述准得多。这个形状是另一个模块验证过的 ——
// 他靠诊断报告定位了四个根因，并且明确说"比自然语言描述准得多"。
ipcMain.handle('export-diagnostics', () => {
  const report = {
    v: 1,
    at: new Date().toISOString(),
    app: {
      version: app.getVersion(),
      // ⚠️ packaged 必须在最前面：它决定权限类结论是否可信
      //（npm start 下屏幕录制/辅助功能根本不可达）。
      packaged: app.isPackaged,
      electron: process.versions.electron,
      arch: process.arch,
    },
    wallpaper: weProject ? {
      type: weProject.type,
      typeLabel: weProject.typeLabel,
      supported: weProject.supported,
      gifScene: weProject.gifScene,
      file: weProject.file,
      dir: weProject.dir,
      title: weProject.title,
      wantsAudio: weProject.wantsAudio,
      propertyCount: Object.keys(weProject.properties || {}).length,
    } : null,
    windows: {
      // 哪些窗口活着 —— "画面没出来"时第一件要确认的事。
      wall: !!(wallWindow && !wallWindow.isDestroyed()),
      we: !!(weWindow && !weWindow.isDestroyed()),
      dashboard: !!(dashboardWindow && !dashboardWindow.isDestroyed()),
      sensor: !!(sensorWindow && !sensorWindow.isDestroyed()),
      strategy: currentStrategy ? currentStrategy.id : null,
      weStrategy: config.we.strategy,
      // 实际拿到的窗口尺寸 vs 屏幕尺寸 —— 菜单栏那条缝就是这里看出来的。
      display: screen.getPrimaryDisplay().bounds,
      weBounds: weWindow && !weWindow.isDestroyed() ? weWindow.getBounds() : null,
    },
    we: { ready: weReady },
    video: videoStatus,
    audio: audioStatus,
    workshop: {
      steamcmd: findSteamCmd(),
      username: (config.we.steam && config.we.steam.username) || null,
      downloading: downloading ? downloading.workshopId : null,
    },
    // 配置快照，但**去掉密码**。
    config: redactConfig(config),
    events: events.slice(-EVENT_LIMIT),
  };

  const dir = path.join(app.getPath('userData'), 'diagnostics');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `gesturewall-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  return { ok: true, file };
});

// ⚠️ 诊断报告是要发给别人看的，而 config 里有 Steam 密码和 Guard 码。
// 忘了这一步就等于让用户把密码贴进聊天记录。
function redactConfig(source) {
  const copy = JSON.parse(JSON.stringify(source || {}));
  if (copy.we && copy.we.steam) {
    if (copy.we.steam.password) copy.we.steam.password = '***';
    if (copy.we.steam.guardCode) copy.we.steam.guardCode = '***';
  }
  return copy;
}

ipcMain.handle('reveal-diagnostics', () => {
  const dir = path.join(app.getPath('userData'), 'diagnostics');
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
  return { ok: true, dir };
});

ipcMain.handle('we-status', () => ({
  ...weStatus(null), audio: audioStatus, video: videoStatus,
}));

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
    // ⚠️ 打包后 __dirname 在 asar 包里，而 asar 里的文件 swiftc 读不到（那是个
    // 归档不是目录）。所以 helper 源码要走 extraResources 出来的 resourcesPath。
    // 这和另一个模块的 system-bridge.js 是同一个写法（它已经踩过这条）。
    sourcePath: app.isPackaged
      ? path.join(process.resourcesPath, 'native', 'GestureWallAudio.swift')
      : path.join(__dirname, '..', 'native', 'GestureWallAudio.swift'),
    outDir: path.join(app.getPath('userData'), 'native'),
    bundle: config.we.audioSource === 'netease' ? AudioSource.NETEASE_BUNDLE : null,
    // 开发模式和打包后的 .app 是两个授权身份，提示文案必须分开说。
    packaged: app.isPackaged,
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
  // 投递层最后启动:它要现场编译 Swift,失败不该拖住窗口出现。start() 自己带 try/catch,
  // 因为 AirCursor 上这里抛出去会让 pointerHelper 永远 undefined 而且不报错。
  systemBridge.start();

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
  // 两个 helper 都是独立进程，不会因为主进程退出而自动结束 —— 留着会占住
  // 摄像头/麦克风/屏幕录制，而且下次启动会看到"两个 helper 在跑"。
  systemBridge.stop();
  if (audioTap) audioTap.stop();
});
