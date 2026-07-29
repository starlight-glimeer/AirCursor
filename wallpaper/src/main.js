// GestureWall main process.
//
// Three windows, each with one job:
//   wall     — the wallpaper itself, sits at desktop level, renders the layers
//   settings — a normal window for importing images and tuning; opened on demand
//   sensor   — hidden, owns the camera and turns hands into gesture events
//
// The wall is the only one that has to fight macOS for its window level, and that
// fight is the reason for WALL_STRATEGIES below.
const { app, BrowserWindow, ipcMain, screen, globalShortcut, dialog, nativeTheme, shell } = require('electron');
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
// 冲突检测。主进程也要用它 —— 重新启用一个手势时得先确认它和在用的手势不撞，而那个
// 判断只能在这里做（只有主进程手上有全部录制）。
//
// 直接 require 而不是重实现：两份实现只要有一点不同，就会出现"录的时候说没冲突、启用时
// 说有冲突"这种自相矛盾的提示。这几个模块都挂 globalThis，在 node 里能直接跑。
require(path.join(__dirname, 'vendor', 'aircursor', 'pose.js'));
require(path.join(__dirname, 'vendor', 'aircursor', 'motion.js'));
require('./recorder.js');
const Recorder = globalThis.GestureWallRecorder;
// 系统投递层(真鼠标/键盘事件 + 本地语音)。整个抽自 AirCursor 的 main.js,不是重写 ——
// 那一层的每条约定都是真机烧出来的,见文件头。
const { createSystemBridge } = require('./system-bridge.js');

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
let overlayWindow = null;
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
    // 两次推理最少间隔。20ms 来自 AirCursor 3.x 的真机报告:那一版在同一台机器上
    // 30fps、推理 12ms。太小会让推理挤掉绘制,太大直接变成帧率上限。
    inferenceIntervalMs: 20,
    // 骨架发送间隔。和摄像头同频(30fps),不额外降 —— 骨架的用途是"我的手在哪",
    // 而降频在这上面直接表现为"不跟手"。
    handIntervalMs: 33,
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
  // 语音命令。默认关:开着会占麦克风,而那会切换音频输入设备、影响正在播放的音乐。
  voice: false,
  // 摄像头授权拿到过没有。决定骨架层一开始要不要鼠标穿透 —— 授权弹窗在穿透窗口上
  // 点不动,所以第一次必须留着可交互。
  cameraGranted: false,
  // 手 → 真光标。默认关:一开摄像头就抢走鼠标,用户会没法用鼠标去把它关掉。
  // 需要辅助功能授权,而缺权限时 CGEvent 静默丢弃 —— 所以面板要显示投递层健康状态。
  controlCursor: false,
  // 每个动作上一版的录制,一级回退用。见 rememberPrevious。
  recordUndo: {},
  // 图库：用户上传的素材。数组而不是字典，因为顺序有意义（新加的在后面）。
  library: [],
  // 已录制的手势，动作 id → { hands, template, keyframes, trigger, ... }。
  recorded: {},
  // 用模型识别手势（GestureRecognizer 旁路）。默认关：11MB wasm + 8MB 模型，不用就不该付。
  //
  // 存在的理由见 model-gestures.js 的文件头 —— 简短版：现在的判定是手写几何（逐点距离），
  // 它没有"什么叫摊开的手"这种语义，而实测一个 0.28 的球手只能停留 89ms ⟹ 动态手势
  // 结构上走不通。模型学过那 8 个手势，所以手大一点小一点都认。
  modelGestures: {
    enabled: false,
    numHands: 2,
    minScore: 0.6,
    // { 内置手势名: 动作 id }。绑了的那个动作就不需要录制。
    bindings: {},
  },
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
// `bindings` 也在里面：它的键是用户选的（内置手势名 → 动作），而深合并会把"删掉一个
// 绑定"变成"那个键保留旧值" —— 传一个缺键的对象删不掉它。
const OPAQUE_DICTS = new Set(['presets', 'slots', 'recorded', 'recordOptions', 'recordUndo',
  'bindings']);

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
  for (const win of [wallWindow, dashboardWindow, overlayWindow, overlayWindow]) {
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
  const result = runSystemAction(hit.action, '语音');
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
    // ⚠️ 不设 focusable: false。
    //
    // 摄像头现在就在这个窗口里(和 AirCursor 3.x 一样),而 getUserMedia 的授权弹窗
    // 出现在一个不可聚焦的窗口上时**没人能回答它**。3.x 的 overlay 也没设这个 ——
    // 它靠 setIgnoreMouseEvents 做穿透,那是正确的做法:穿透和不可聚焦是两件事。
    enableLargerThanScreen: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  // 渲染进程的 console 转到主进程 + 面板。
  //
  // 摄像头搬进这一层之后没启动,而我花了几轮在推断原因 —— 因为这个窗口里抛的任何异常
  // **谁都看不到**:它没有开发者工具、不在视线里,而 sensor.js 的加载期错误只会让摄像头
  // 静默不起。AirCursor 3.x 转了这个,他的没转。
  //
  // Electron 36 起签名从 (event, level, message, line, sourceId) 变成单个 details
  // 对象,两种都接才不会静默变哑。
  overlayWindow.webContents.on('console-message', (...args) => {
    const d = args[1] && typeof args[1] === 'object' ? args[1] : null;
    const level = d ? d.level : args[1];
    const message = d ? d.message : args[2];
    if (level === 'error' || level === 'warning' || /⚠️|失败|Error/.test(String(message))) {
      broadcast('helper-log', { source: 'overlay', message: String(message) });
    }
  });
  // 未捕获异常单独报:它比 console.error 更致命(整个脚本停在那里),而 console-message
  // 在某些 Electron 版本上拿不到它。
  overlayWindow.webContents.on('render-process-gone', (_e, details) => {
    broadcast('helper-log', { source: 'overlay', message: `骨架层崩了:${details.reason}` });
  });
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // forward: true 让鼠标事件继续传给下面的窗口，否则这一层会让整个屏幕点不动。
  // 穿透**永远开**,没有例外。
  //
  // 上一版为了让摄像头授权弹窗可点,把穿透做成了"拿到授权后才开" —— 结果这一层盖在
  // 全屏最上层且不穿透,吃掉了用户所有的点击,连启动页的按钮都点不进去。用户报
  // "开头的 gesturewall 我点不进去了"。
  //
  // 那个取舍本身就是错的:摄像头授权不需要**整层**可点,只需要请求发生在一个可交互的
  // 窗口里。所以授权改由 dashboard 发起(它是普通窗口),拿到之后骨架层直接用 —— 权限是
  // 授给整个 App 的,不是授给某个窗口。
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  // 三重保险。这一层盖在全屏最上层,任何一条失效的后果都是**整个屏幕点不动** ——
  // 用户实测到过("鼠标直接废掉了,屏幕上所有的东西都点不动了"),而那种状态下他连
  // 关掉这个 App 都做不到。所以不依赖任何单一机制:
  //
  //   setIgnoreMouseEvents  Electron 层面的穿透
  //   ready-to-show 后重设   窗口重建/显示时 Electron 有可能丢掉上面那次设置
  //   body pointer-events    CSS 层面,即使 Electron 那边失效也不会吃掉点击
  overlayWindow.once('ready-to-show', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    }
  });
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
// 骨架窗口的存在条件 = 手势开着。**不再看 showHands。**
//
// 因为摄像头就在这个窗口里(和 AirCursor 3.x 一样),而"我不想看骨架"不等于"我不想用
// 手势" —— 按 showHands 建拆窗口会连摄像头一起拆掉。
//
// "显示不显示骨架"改成只控制画不画:窗口本来就是全屏透明的,不画就等于不存在。这样
// 也顺带去掉了那个独立的 sensor 窗口 —— 而它在外接显示器上表现为一个黑框(用户拍了照),
// 因为我三次都在靠"位置"藏它,而多屏下任何"屏幕外"的坐标都可能是另一块屏的屏内。
function syncOverlayVisibility() {
  const wanted = !!(config && config.gestures.enabled);
  if (wanted) ensureOverlay();
  else destroyOverlay();
  // 画不画由 overlay 自己按 config 决定,这里只负责把 config 送到。
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('config', config);
  }
}

// 摄像头没有独立窗口了 —— 它在骨架层里(和 AirCursor 3.x 一样)。
//
// 原来那个 sensor 窗口的存在理由是"骨架层 focusable:false,授权弹窗没人能回答",而正确
// 解法是让骨架层可聚焦(3.x 就没设那个),不是造第二个窗口。那个窗口在外接显示器上表现为
// 一个黑框,而我三次靠"位置"藏它都失败:多屏下任何"屏幕外"的坐标都可能是另一块屏的屏内。

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
  // 建/拆窗口交给 syncOverlayVisibility 一处管 —— 两处都能拆窗口时,"谁拆的"会变成
  // 一个需要查的问题。
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

// `source` 说明是谁触发的：'手势' 还是 '试一下' 按钮。
//
// ⚠️ 不带这个参数时两条路径打出**一模一样**的日志，而用户点了「试一下」看到
// `open_netease → ok` 会以为手势通了 —— 实测发生过，而它把排查方向整个带偏：那条 ok
// 只证明 App 能打开，手势那侧可能一步都没走。
//
// 日志的第一要务是说清"这是谁干的"，否则它自己就是一个误导源。
function runSystemAction(id, source = '?') {
  const kind = System.systemKindOf(id);
  if (!kind) return { ok: false, error: 'NOT_SYSTEM_ACTION' };

  if (kind === 'app') {
    // 每个候选的失败原因都留下来。`stdio: 'ignore'` 会把 open 的报错扔掉，而那句报错
    // 正是答案：「Unable to find application named …」和「The application cannot be
    // opened because it is damaged」需要完全不同的处理，而退出码把它们压成同一个 1。
    const tried = [];
    const args = System.openApp(id, (candidate) => {
      try {
        const r = spawnSync('/usr/bin/open', candidate, { encoding: 'utf8' });
        const why = r.status === 0 ? 'ok'
          : (String(r.stderr || '').trim().split('\n')[0] || `退出码 ${r.status}`);
        tried.push(`open ${candidate.join(' ')} → ${why}`);
        return r.status === 0;
      } catch (error) {
        tried.push(`open ${candidate.join(' ')} → ${error.message}`);
        return false;
      }
    });
    // 报出用了哪个候选：同一个 App 在不同机器上路径/bundle id/名字都可能不同，而
    // "试了四个都失败"和"第二个成功了"需要分开看。
    //
    // 送进面板的日志窗格，不只是 console —— 用户看不到终端时 console.log 等于不存在，
    // 而这条链（录制 → 匹配 → 事件 → 执行）里"执行"是唯一能自证成败的一段。
    for (const line of tried) {
      broadcast('helper-log', { source: `system/${source}`, message: `${id} ${line}` });
    }
    if (!args) {
      broadcast('helper-log', {
        source: `system/${source}`,
        message: `⚠️ ${id}：${tried.length} 个候选全失败 —— 这台机器上找不到那个 App，`
          + '和手势没关系（手势那侧已经走到这里了）',
      });
    }
    return { ok: !!args, via: args, tried };
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
    // 这一行是"手势那侧全部走通了"的证明。没有它，「录了没反应」分不清是手势没认出来
    // 还是 App 打不开 —— 而两者的下一步完全不同（重录 vs 查 App 路径）。
    broadcast('helper-log', { source: 'gesture', message: `识别到「${payload.action}」→ 执行系统动作` });
    const result = runSystemAction(payload.action, '手势');
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
ipcMain.handle('test-system-action', (_event, id) => {
  broadcast('helper-log', { source: '面板', message: `「试一下」${id} —— 这条不代表手势通了` });
  return runSystemAction(id, '试一下');
});

// 投递层的健康状态。这是"手势没反应"时第一个该看的东西:识别成功和事件送达是两个
// 独立的 claim,而缺权限时 CGEvent 静默丢弃 —— AirCursor 为此烧掉四轮。
ipcMain.handle('pointer-health', () => systemBridge.health());

// 打开系统设置的辅助功能页。
//
// 之前只显示"无辅助功能授权"然后就没了 —— 用户知道缺什么,不知道去哪给。而 macOS 的
// 那个面板藏在系统设置三层下面,报出问题却不给路径等于把活推给用户。
ipcMain.handle('open-accessibility', () => {
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  return { ok: true };
});

// 打开摄像头授权页。同理:摄像头被拒之后光说"启动失败"没用。
// 语音按需开关。默认关,而且这不是保守 —— helper 一启动就占麦克风,而 macOS 上抢占音频
// 输入会切换输入设备、连带影响正在播放的音轨(用户报过:"每次打开我们的产品音道就变了")。
// 一个可选功能不该有这种副作用。
ipcMain.handle('set-voice', (_event, enabled) => {
  config.voice = !!enabled;
  writeConfig();
  const result = enabled ? systemBridge.startVoice() : systemBridge.stopVoice();
  broadcast('config', config);
  return result;
});

// 麦克风授权页。和辅助功能/摄像头同一个原则:说了缺什么就得给路径。
ipcMain.handle('open-microphone-settings', () => {
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
  return { ok: true };
});
// 语音识别单独一项授权,而且授给的是 AirCursorVoice 那个 helper 不是主 App ——
// 这一条在 AirCursor 上花过时间,写下来免得再查。
ipcMain.handle('open-speech-settings', () => {
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition');
  return { ok: true };
});

ipcMain.handle('open-camera-settings', () => {
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Camera');
  return { ok: true };
});

// 录 5 秒原始关键点。两边所有用例都是合成手,而合成手缺的是真机噪声的**时间相关结构**
// (相邻帧一起漂、丢跟踪后重新检出会跳),而那个差异决定判定层在真手上成不成立。
ipcMain.handle('start-capture', () => {
  // 窗口存在 ≠ 摄像头在跑。用户报过一次:点了按钮显示"正在录制 5 秒",然后什么都没发生、
  // 目录也是空的 —— 那次是 MediaPipe 没加载(vendor 步骤没跑),窗口好好地开着。
  // 只查窗口是不够的。
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return { ok: false, reason: '摄像头没有开着 —— 先勾上「开启摄像头手势」' };
  }
  if (!sensorReady) {
    return { ok: false, reason: `摄像头还没就绪:${sensorStatusText || '正在启动'}` };
  }
  overlayWindow.webContents.send('start-capture');
  // 兜底:5 秒后该有文件了。没有就说出来 —— 一个只说"正在录制"然后永远不再说话的
  // 界面,和坏掉没有区别。
  const expectBy = Date.now();
  setTimeout(() => {
    if (lastCaptureAt >= expectBy) return;
    broadcast('capture-saved', { error: '5 秒过去了但没有产出文件 —— 摄像头可能没真的在出帧' });
  }, 7000);
  return { ok: true };
});
// sensor 的就绪状态。摄像头真的在出帧才算就绪 —— 窗口开着但模型没加载时它是 false。
let overlayGeometry = null;
let sensorReady = false;   // sensor 显式报的,不靠猜文案
let sensorStatusText = '';
let lastCaptureAt = 0;

ipcMain.on('save-capture', (_event, payload) => {
  lastCaptureAt = Date.now();
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

// 骨架的几何自检。转给面板显示 —— 一个没人能看的自检和没有自检是一回事,
// 而这个项目本轮已经犯过那个错(三层接好、面板零入口)。
ipcMain.on('overlay-geometry', (_event, payload) => {
  overlayGeometry = payload;
  broadcast('overlay-geometry', payload);
});

ipcMain.on('sensor-status', (_event, payload) => {
  // 记下来源状态,让 start-capture 能判断"摄像头是不是真的在出帧"。判据是文本里没有
  // ⚠️ 且已经报到"已开启" —— sensor 自己在成功那一刻才发这句。
  sensorStatusText = (payload && payload.text) || '';
  if (payload && typeof payload.ready === 'boolean') sensorReady = payload.ready;
  // 记下"授权拿到过",面板用它决定要不要显示"先去授权"那一步。不再和穿透挂钩。
  if (payload && payload.ready && !config.cameraGranted) {
    config.cameraGranted = true;
    writeConfig();
  }
  broadcast('sensor-status', payload);
});

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
  // 摄像头在骨架层里,所以确保那一层在。
  const layer = ensureOverlay();
  if (!layer || layer.isDestroyed()) return { ok: false, error: '骨架层没起来' };
  recordingAction = action;
  // 录制时骨架强制显示，不管用户的开关 —— 那是唯一必须看见手的时刻。
  syncOverlayVisibility();
  layer.webContents.send('start-recording', { action });
  return { ok: true };
});

ipcMain.handle('cancel-recording', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('cancel-recording', {});
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

// 单个手势的开关。
//
// 存在 `recorded[action].enabled` 上而不是另开一张表：它跟着模板走，清除录制时一起消失，
// 不会留下一堆指向已删手势的孤儿开关。
//
// 不需要回退：这个操作本身是可逆的（再点一下就回来），而 rememberPrevious 是给破坏性
// 操作准备的。给可逆操作也存快照会把真正需要回退的那一版挤掉。
ipcMain.handle('toggle-recording', (_event, action, enabled) => {
  const entry = config.recorded && config.recorded[action];
  if (!entry) return { ok: false, error: '这个动作还没录过' };

  // 重新启用时才检查冲突 —— 那是两个手势真正开始同时生效的那一刻。
  //
  // 录制时不检查关掉的手势（用户把 A 关了正是为了腾出那个手型），代价就是这里必须拦：
  // 不拦的话打开的瞬间两个撞在一起的手势同时活着，而用户得到的是"另一个动作"。
  // 把成本放在这里，因为这一刻他正在主动打开它，因果关系是清楚的。
  if (enabled && entry.template) {
    const tuning = config.gestureTuning || {};
    const hit = Recorder.conflictingAction(
      action,
      entry.template,
      config.recorded,
      tuning.matchThreshold || 0.28,
      ((tuning.rotationTolerance || 20) * Math.PI) / 180,
      // 只和**在用的**手势比：另一个关着的手势不构成障碍，它自己被打开时也会走这道检查。
      { againstDisabled: false },
    );
    if (hit) {
      const other = System.systemKindOf(hit.action) || hit.action;
      broadcast('helper-log', {
        source: '面板',
        message: `⚠️ 打不开手势「${action}」：和「${hit.action}」太像（距离 ${hit.distance}，`
          + `至少要 ${hit.need}）。要用它得先清除或重录其中一个`,
      });
      return { ok: false, conflictWith: hit.action, distance: hit.distance, need: hit.need, other };
    }
  }

  config.recorded = { ...config.recorded, [action]: { ...entry, enabled: !!enabled } };
  writeConfig();
  broadcast('config', config);
  broadcast('helper-log', {
    source: '面板',
    message: `${enabled ? '启用' : '关闭'}手势「${action}」`,
  });
  return { ok: true, enabled: !!enabled };
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
  // syncOverlayVisibility 自己按 gestures.enabled 建拆,不用在这里重复判断。
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
  // 逃生开关:把骨架层直接拆掉。
  //
  // 这一层盖在全屏最上层,如果穿透因为任何原因失效,后果是**整个屏幕点不动** —— 用户
  // 实测撞到过,而那种状态下鼠标废掉、连关掉这个 App 都做不到。一个能把自己锁在外面的
  // 程序必须有一个不依赖鼠标的出口,而且这个出口不能和"退出"绑在一起(用户可能只是想
  // 拿回鼠标,不是想关掉壁纸)。
  globalShortcut.register('Control+Shift+X', () => {
    destroyOverlay();
    broadcast('helper-log', { source: 'main', message: '骨架层已拆掉(⌃⇧X) —— 鼠标恢复。重新勾选「显示手骨架」可以再开' });
  });

  console.log('\n=== GestureWall ===');
  console.log('  ⌃⇧W 设置    ⌃⇧L 换壁纸层    ⌃⇧R 复位视角');
  console.log('  ⌃⇧X 拆掉骨架层(鼠标点不动时用)    ⌃⇧Q 退出\n');
});

// Deliberately does not quit: closing the settings window is not quitting the
// wallpaper. ⌃⇧Q is the way out.
app.on('window-all-closed', () => {});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // helper 是独立进程,不会因为主进程退出而自动结束 —— 留着会占住摄像头/麦克风,
  // 而且下次启动会看到"两个 helper 在跑"。
  systemBridge.stop();
});
