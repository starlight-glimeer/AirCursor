// GestureWall main process.
//
// Three windows, each with one job:
//   wall     — the wallpaper itself, sits at desktop level, renders the layers
//   settings — a normal window for importing images and tuning; opened on demand
//   sensor   — hidden, owns the camera and turns hands into gesture events
//
// The wall is the only one that has to fight macOS for its window level, and that
// fight is the reason for WALL_STRATEGIES below.
const { app, BrowserWindow, ipcMain, screen, globalShortcut, dialog, nativeTheme, Menu,
  protocol, net, shell, systemPreferences } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
// spawn 给 steamcmd（长跑、要流式读进度），spawnSync 给一次性的系统动作。
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
// ⚠️ 0.9.111：视频缓存的文件名要按源路径+mtime+size算 key（见 stripCachePath）。
const crypto = require('node:crypto');

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

require('./we-host.js');
const WE = globalThis.GestureWallWE;

require('./workshop.js');
const Workshop = globalThis.GestureWallWorkshop;

const AudioSource = require('./audio-source.js');
const MouseBridge = require('./mouse-bridge.js');
// ⚠️ 0.9.123：AI 生成壁纸。两个模块都是**纯逻辑**（不碰 Electron）——
//   那是有意的：闸门的判定逻辑必须能在测试里跑（见 test/gen.test.js），
//   而"开窗口真跑"那部分留在这个文件里（它绕不开 Electron）。
const LLM = require('./llm.js');
const Gen = require('./wallpaper-gen.js');
// ⚠️ 0.9.140：防同质化的配方表（枚举维度 + 读历史避重）。纯逻辑、有测试。
// ⚠️ 0.9.111：去音轨那个 helper 也走预编译优先那条路（和音频/鼠标一样）。
const { findPrebuilt } = require('./prebuilt-helper.js');

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
      // desktop 是真壁纸层：每个 Space 各自渲染，所以"所有桌面可见"在这里的语义
      // 是对的（每个桌面都有壁纸），不会变成"一个窗口跟着你跑"。
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      // The menu bar strip is the one part a normal window cannot reach: macOS
      // reserves it, and setBounds gets clamped just below it. Verified against the
      // system's own wallpaper, which does cover it — so the window has to be told
      // it may sit outside the visible frame, and then asked again.
      liftOverMenuBar(win, 'desktop');
    },
  },
  {
    id: 'bottom-normal',
    label: '普通窗口压到最底（能收鼠标，只在当前桌面）',
    options: {},
    apply: (win) => {
      win.setAlwaysOnTop(false);
      // ⚠️ **不能**设 setVisibleOnAllWorkspaces(true)。
      //
      // 实测（用户左右切桌面）：壁纸"直接追过来覆盖"了。原因是这是个**普通窗口** ——
      // "在所有桌面可见"对它的意思是"这一个窗口跟着你跑"，而不是"每个桌面都有壁纸"。
      //
      // 真壁纸层（desktop 策略）没这个问题：那一层本来就是每个 Space 各自渲染的，
      // 所以 canJoinAllSpaces 在那里的语义才是对的。
      //
      // macOS 原生的做法是 collectionBehavior = [.stationary, .canJoinAllSpaces]
      //（OWE 就这么写的），关键在 **.stationary**：跨 Space 存在但**不随切换移动**。
      // ⚠️ 而 Electron 只暴露了 canJoinAllSpaces 那半边，没有 stationary。
      // ⟹ 拿不到那个组合，所以这条策略只能待在当前桌面。
      liftOverMenuBar(win, 'bottom-normal');
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
      // ⚠️ 这条**故意**保留跨桌面：它的用途是"一定看得见，用来验渲染"，
      // 那时候跟着切桌面走是符合意图的。而 bottom-normal 那条不行 ——
      // 那是当壁纸用的，壁纸跟着你跑就成了"覆盖别的桌面"。
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      liftOverMenuBar(win, 'floating');
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
// 把窗口推到整块屏幕（含菜单栏那 25px 的区域）。
//
// ⚠️ 这个函数改了三次，而**前三次都在修错的东西**。诊断报告（2026-07-30）证明了这点：
//
//   weBounds: { x:0, y:0, width:1470, height:956 }
//   display:  { x:0, y:0, width:1470, height:956 }
//   menuBar:  { ok: true, pushes: 0 }
//
// 窗口尺寸和屏幕**一像素不差**，pushes:0 说明压根没被夹过。
// 而用户仍然看到顶上那条带子。
//
// ⟹ 真相：那不是"窗口没盖住"，是**普通窗口画不到菜单栏那一层**。
// 菜单栏是系统绘制的独立图层，普通窗口（bottom-normal / floating 策略）无论多大，
// 那 25px 永远画在它上面。而真壁纸层（desktop 策略）在菜单栏**之下**，
// 半透明的菜单栏会透出壁纸 —— 所以那条策略下用户实测过是"铺满"的。
//
// ⟹ 也就是说这是个**取舍**，不是 bug：
//     desktop        菜单栏区域有内容 ✅，收不到鼠标 ❌
//     bottom-normal  能收鼠标 ✅，菜单栏那 25px 是系统的 ⚠️
//
// 我在这上面连错三轮的教训：**尺寸是可测的，而我三次都没去测**。
// 前两版加的是"推得更执着"（重试、事件驱动），第三版才想到核对实际 bounds ——
// 而那个核对一上线就证明前提是错的。⟹ 报出可核对的数字比修得更用力重要。
//
// 现在这个函数只做两件事：把 frame 设成整屏（分辨率变化时仍然需要），
// 以及**如实报告尺寸对不对** —— 后者让"那条带子"不再被误判成尺寸问题。
function liftOverMenuBar(win, label) {
  const measure = () => {
    if (!win || win.isDestroyed()) return null;
    const want = screen.getPrimaryDisplay().bounds;
    const got = win.getBounds();
    // 四个方向都量：只查 y 和 height 的话，多显示器时 x 被夹会漏掉。
    const gap = {
      x: got.x - want.x, y: got.y - want.y,
      width: want.width - got.width, height: want.height - got.height,
    };
    return { want, got, gap, clamped: Object.values(gap).some((v) => v !== 0) };
  };

  const push = (reason) => {
    const before = measure();
    if (!before) return;
    // 幂等：已经对了就不设。无条件 setBounds 会和 macOS 轮流改 frame（壁纸会抖），
    // 而且它让 resize→setBounds→resize 的递归自己断掉。
    if (!before.clamped) {
      menuBarState = {
        sizeOk: true, label, lastReason: reason,
        // ⚠️ 尺寸对 ≠ 菜单栏区域有内容。这两件事必须分开报，
        // 否则"尺寸没问题"会被读成"那条带子是 bug"。
        coversMenuBar: label === 'desktop',
      };
      return;
    }
    try {
      // ⚠️ 用 before.want，不是裸的 `want` —— 那个名字只存在于 measure() 内部。
      //
      // 原来这里写的是 `want ? want : screen…`，而 push() 的作用域里没有 want ⟹
      // **ReferenceError**。而且它只在窗口真被夹取时才走到（没夹取的话上面就 return 了），
      // 所以尺寸正常的窗口一直没事，掩盖了这个错。
      //
      // 后果比看起来严重得多：push('create') 是在 ensureOverlay() 里**同步**调的，
      // 所以它一抛，整个 ensureOverlay() 就抛 —— 而骨架层里装着摄像头。
      // ⟹ 症状是"点开启摄像头完全没反应，也不报错"，看起来像摄像头/手势坏了，
      // 而真正的原因在一个菜单栏对齐的辅助函数里。
      win.setBounds(before.want);
    } catch (error) {
      console.warn('[wall] setBounds failed:', error.message);
      return;
    }
    const after = measure();
    menuBarState = {
      sizeOk: after ? !after.clamped : false,
      gap: after && after.clamped ? after.gap : null,
      label, lastReason: reason,
      coversMenuBar: label === 'desktop',
    };
  };

  // ⚠️ 整个 push 包起来：这是**菜单栏对齐**，而它被用在骨架层上（摄像头在那里面）。
  //
  // 实测教训：push 里一个 ReferenceError 让 ensureOverlay() 整个抛出，
  // 表现成"摄像头打不开、点了没反应、也不报错" —— 一个纯装饰性的对齐逻辑
  // 不该有能力弄死摄像头。⟹ 对齐失败就只是对齐失败，报出来，别往上冒。
  const safePush = (reason) => {
    try {
      push(reason);
    } catch (error) {
      console.warn(`[${label || 'win'}] 菜单栏对齐失败（${reason}）：${error.message}`);
      menuBarState = { sizeOk: false, label, lastReason: reason, error: error.message };
    }
  };

  safePush('create');
  win.once('ready-to-show', () => safePush('ready-to-show'));
  win.on('show', () => safePush('show'));
  // resize 覆盖分辨率变化和 macOS 的夹取 —— 那两件都需要重设 frame。
  win.on('resize', () => safePush('resize'));
  return measure;
}

// 最近一次覆盖核对的结果，进诊断报告。
let menuBarState = null;

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
  // ⚠️ 语音功能 0.9.106 整条删了，这个字段**留着不驱动任何逻辑** ——
  //   用户 config 里已经有它，而 mergeConfig 只遍历 defaultConfig 的键
  //   ⟹ 删了会被静默剥掉（0.9.93 刚为这个形状栽过一次）。
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
    // 默认抓系统音频。
    //
    // 用户定的：「音源应该一开始就默认需要的，你这个音源面板不需要，应该是我们
    // 默认就要音源，壁纸软件都是这样的」+「默认需要权限吧，一次授权，
    // 后面就再也不需要了」。
    //
    // ⟹ 他说得对，而且这里**不会造成莫名其妙的授权框** —— 采集只在
    // `weProject.wantsAudio` 为真时才启动（见 syncAudioSource），也就是只有装载了
    // `supportsaudioprocessing: true` 的壁纸才会碰 ScreenCaptureKit。
    // video / image / 不要音频的 web 壁纸压根不触发。
    //
    // ⚠️ 一次授权就永久有效（macOS 按 App 记），所以"默认要"的代价是一次性的，
    // 而"默认关"的代价是每个新用户都会经历一遍"这个壁纸怎么不动" ——
    // 而那正是本项目查了六轮的那个症状。
    audioSource: 'system',
    // 把系统原生壁纸设成当前壁纸的静态帧。⚠️ 这不是装饰：我们的窗口在壁纸层之上，
    // 切 Space 时有一帧延迟会露出下面那层。设成一样的图就看不出来了。
    // 退出时会还原用户原来的壁纸。
    placeholderWallpaper: true,
    // Steam 创意工坊。⚠️ 密码存在本地配置文件里（明文），诊断报告导出时会脱敏。
    // ⚠️ apiKey 只用于浏览/搜索（QueryFiles 要它），装载壁纸不需要。
    // 导诊断报告时和密码一起脱敏。
    steam: { username: null, password: null, guardCode: null, apiKey: null },
    steamCmdPath: null,
    // ⚠️⚠️ **右栅宽度**（0.9.141）。用户 2026-08-02：
    //   「你其实完全可以设计成那种就是可以左拉右拉吗？…我们不能很精细，
    //     因为我们预览图片是有尺寸的吗？所以说我们这边就是一档一档的，
    //     然后也设置一个壁纸的最小容量宽度」
    //
    // ⚠️ **一档一档**而不是连续拖 —— 用户自己给的理由（预览图有固定比例）。
    // ⚠️ 而它**进 config**（对比：收起状态不进）—— "我喜欢宽一点的右栅"
    //   是真偏好，下次打开该记住；而"现在想多看几张壁纸"是临时动作。
    sideWidth: 340,
    // ⚠️⚠️ **AI 生成壁纸的凭证**（0.9.123）。用户 2026-08-02：
    //   「调用大模型 api，帮我做壁纸」
    //   「这些东西肯定是不能上传 GitHub 的，这个我自己填就行，但是你要支持这个能力」
    //
    // ⚠️ 它们和 Steam 那套走**同一条路**，不需要为 LLM 另开一套：
    //   落盘在 `app.getPath('userData')/config.json`（`~/Library/Application
    //   Support/GestureWall/`）—— 那在仓外，`.gitignore` 都不用管。
    //   而诊断报告里由 `redactConfig` 打码（报告是要发给别人看的）。
    //
    // ⚠️⚠️ **只做一家（Bedrock）**。用户 2026-08-02 明确收窄：
    //   「不能给用户提供，让他自主选择模型，我们就把调用大模型这个打通就行」
    //   ⟹ `provider` 这个字段留着（llm.js 那边两支都实现了、都有测试），
    //     但面板上不给选 —— 那是"以后要换很容易"和"现在别让用户面对选择"
    //     两件事同时成立的写法。
    //
    // ⚠️ region/model 有默认值（能直接用），**只有 apiKey 必须用户自己填** ——
    //   那是唯一的凭证，也是这个功能唯一的门槛。
    // ⚠️⚠️ **默认走 DeepSeek**（0.9.124，从 Bedrock 换过来）。
    //   用户 2026-08-02：「我填了 deepseek 的 api key 然后呢」
    //
    // ⚠️ 换掉 Bedrock 的理由不是"Bedrock 不好"，是**拿到 key 的门槛**：
    //   Bedrock 要 AWS 账号 → 申请模型访问权（可能等审批）→ 区域对上 → 建 key，
    //   而 DeepSeek 注册完就能建。而这个功能的门槛应该只有"填一个 key"。
    // ⚠️ 而我云端实测用的是 Bedrock（那是 Claude Code 注给云端进程的凭证，
    //   **不是用户的**，也不该长期绑进桌面应用）⟹ 用户必须有一个属于自己的 key。
    //
    // ⚠️⚠️ base URL **不带 `/v1`** —— 这是用户贴的 DeepSeek 官方文档说的
    //   （`base_url (OpenAI) = https://api.deepseek.com`）。
    //   而 llm.js 拼的是 `{base}/chat/completions` ⟹ 最终
    //   `https://api.deepseek.com/chat/completions`（已验证拼装结果）。
    //   ⚠️ 我原来在 llm.js 的提示文案里写的是"要带到版本号，例如 .../v1" ——
    //     那是 OpenAI 自己的形状，**照搬到 DeepSeek 上是错的**。
    //
    // ⚠️ 模型名同样来自那份文档：`deepseek-v4-flash` / `deepseek-v4-pro`。
    //   默认用 flash —— 生成壁纸这件事一轮就一万来个 token，
    //   而 flash 便宜得多；不够好再换 pro（改 config 一行）。
    // ⚠️⚠️⚠️ **默认是 Bedrock 上的 Claude**（0.9.143）。用户 2026-08-02：
    //   「我就是想把我们这个默认的模型给他换成 claude」
    //
    // ⚠️ 换的理由是**实测**，不是偏好：deepseek-v4-flash 是**推理小模型**，
    //   两步都把输出预算烧在思考上（6,465 字 / 74,299 字 reasoning_content，
    //   正文一个字没写），靠自动重试才救回来 ⟹ 218 秒出 266 行，
    //   而产物"自己在那转圈"、没跟音乐起伏。
    //   ⟹ 判据：**写 Three.js 场景这件事对模型的要求是"代码强 + 不空转"**，
    //     而推理小模型两条都不满足。换模型比调提示词有用得多。
    ai: {
      provider: 'bedrock',
      // ⚠️ Bedrock 用 region + 模型 ID，不用 baseUrl。
      //   ⚠️ 但字段留着 —— 用户切回 OpenAI 兼容那支时不用改两处。
      baseUrl: 'https://api.deepseek.com',
      // ⚠️ 绝对不许在这里写任何 key。默认 null = "用户还没填"。
      //   ⚠️ 而 `resolveAiConfig()` 会读环境变量 AWS_BEARER_TOKEN_BEDROCK ——
      //     那正是用户 .bashrc 里已经有的那个。
      apiKey: null,
      // ⚠️⚠️ **Opus 4.8**（0.9.144）。用户 2026-08-03：
      //   「这个模型默认应该用 opus 4.8」
      //   ⚠️ 我 0.9.143 选的是 Sonnet 4.5，理由是"快得多"—— 而**那个权衡
      //     不该由我替他做**：这个功能的第一要义是"稳定生成高质量的壁纸"
      //     （用户 2026-08-02 原话），而生成一张壁纸是**一次性的、几十秒的**
      //     操作，不是每帧都要跑的东西 ⟹ 慢一倍换质量是划算的。
      //   ⟹ 判据：**"贵/慢"这类取舍，用户点名了就按他的来** ——
      //     他知道成本，而我不知道他对质量的下限。
      //   ⚠️ 这个 ID **没有版本后缀**（不像 sonnet-4-5-20250929-v1:0）。
      model: 'us.anthropic.claude-opus-4-8',
      region: 'us-west-2',
    },
    // 用户自己加的壁纸存储目录。⚠️ steamcmd 的下载目录是自动扫的，
    // 这里是"我从别处拿到的壁纸放在哪"。
    // ⚠️⚠️ **轮播**（0.9.43）。用户 2026-08-01：
    //   「壁纸应该设置一个播放列表，然后可以设置时间如轮播，
    //     可以选择顺序/随机等」
    //
    // ⚠️ 列表存**目录路径**而不是索引/标题：
    //   索引会随目录内容变（删一个壁纸，后面全错位）
    //   标题会重名（很多壁纸叫"时钟"）
    // ⟹ 路径是唯一稳定的键，而它失效（壁纸被删）时能被检测到并跳过。
    rotate: {
      on: false,
      // 分钟。⚠️ 不用秒 —— 壁纸切换有开销（重建窗口、重载资源），
      // 而秒级轮播只会让画面一直在闪。
      minutes: 30,
      // 'order' | 'random'
      mode: 'order',
      // 手选进列表的壁纸目录（绝对路径）
      list: [],
    },
    // ⚠️ 壁纸目录。**空字符串 = 用默认**（`Documents/GestureWall/Wallpapers`）
    // ⟹ 不写死绝对路径，那样换用户/换机器时自己跟着走。
    wallpaperDir: '',
    // ⚠️ **已废弃**（0.9.31）：原来是"附加壁纸目录列表"，和主目录构成两个模型。
    // 用户 2026-08-01：「反正只有一个路径来源，只是我允许你更改」
    // ⟹ 收成 `wallpaperDir` 一个。这个字段留着只为**读旧配置不报错**，
    //    不再有写入路径，UI 也不再暴露。
    libraryDirs: [],
    // WE 壁纸的层策略。
    //
    // ⚠️ 默认改回 desktop 了（原来是 bottom-normal），因为那两件事现在**不再互斥**：
    // 真壁纸层能覆盖菜单栏，而鼠标事件靠全局监听 + sendInputEvent 转发补回来
    //（mouse-bridge.js）。用户明确否掉了"选一个残废"那个方案 ——
    // mac 原生壁纸没有那条缝，而鼠标交互失效不可接受。他是对的。
    strategy: 'desktop',
    // 鼠标转发。desktop 层收不到鼠标，靠 helper 抓全局事件再注入。
    //
    // ⚠️⚠️⚠️ **默认开回来了**（0.9.97）—— 因为 0.9.88 关掉它的理由**是错的**。
    //
    // 2026-08-02 的探针（`scripts/probe-permissions.sh`，用户真机跑的）给了
    // 决定性证据：
    //     ❌ 辅助功能：未授权（helper 自己报 trusted: false）
    //     ✅ 鼠标事件数：99
    // **没授权，却抓到 99 个事件** ⟹ `NSEvent.addGlobalMonitorForEvents`
    // 监听鼠标**不需要辅助功能授权**。（需要它的是**键盘**事件，以及
    // `CGEvent.post` 那类合成注入 —— 那是 AirCursorPointer 那条链。）
    //
    // ⚠️⚠️ **而我错在哪，git 记录说得很清楚**：
    //   `009995a`「证伪：监听鼠标不需要辅助功能授权」（07-30）
    //   `bd292a4`「初始化 NSApplication —— 全局鼠标监听静默收不到事件的根因」
    //
    //   那次"证伪"实验跑的 Swift 里**零处 `NSApplication.shared`**（查过了）
    //   ⟹ 它的零事件是**那个**造成的，不是没授权。三天后我修了 NSApplication，
    //   **却没回头推翻那个结论** ⟹ 那个错前提一路传到 0.9.88，
    //   成了"把开关默认关掉"的理由，然后又害用户连问六轮"为什么要辅助功能"。
    //
    // ⟹ 教训：**一个"证伪"结论的有效期，只到它依赖的前提被改动为止。**
    //   修 bd292a4 时就该重跑那个实验。
    //
    // ⚠️ 那么"未授权"这个状态还有意义吗？有 —— 权限面板照旧显示它，
    //   因为 **AirCursorPointer**（手势控光标）真的需要它（那条链是注入而非监听）。
    mouseForward: true,
    // ⚠️ 下面这段是 0.9.88 关掉它时写的理由，**留着记录那个错**：
    //
    // 0.9.88 原文：用户 2026-08-02，第五轮：
    //   「点一下壁纸，它会给我弹要辅助功能…关闭程序之后再打开再点一个壁纸，
    //     又会弹。这都需要辅助功能吗？辅助功能起什么作用啊？」
    //
    // ⚠️⚠️ **上面原来那句注释是错的**，而这个 bug 整个建在它上面：
    //   我写「监听鼠标不需要辅助功能权限（键盘才需要）」—— **不对**。
    //   `NSEvent.addGlobalMonitorForEvents` 监听**其他应用**的事件，
    //   macOS 把它算作辅助功能范畴 ⟹ 需要授权。
    //
    // ⚠️⚠️⚠️ 而这也是**前四版修不掉"反复弹"的真正原因**：
    //   那个框**不是我们的代码弹的**。0.9.87 我把所有
    //   `AXIsProcessTrustedWithOptions` 都删了，全仓库零个弹框调用点 ——
    //   而它照样弹，因为 **macOS 自己在未授权进程调用那个 API 时弹**。
    //   ⟹ 只要这个 helper 被启动，就必然弹一次。删弹框调用没用，
    //     唯一的办法是**不启动它**。
    //
    // 而它换来的是什么：让「点一下掉流星」那类**点击特效**能工作。
    // 那是少数壁纸的少数功能 —— 拿"每次开应用点第一个壁纸都被要权限"换它，
    // 完全不值。
    // ⟹ 当时的结论：默认关。
    // ⚠️⚠️ **而那个结论建立在"它要辅助功能授权"上，那句话是错的**（见上面）。
    //   0.9.97 改回默认开。而"每次开应用都弹框"那个真实症状的根因是
    //   **helper 名字带 hash**（0.9.89 修的）——
    //   两件事我当时混成了一件，于是修错了地方。
    // 「只在桌面被聚焦（前台是 Finder）时转发」这个门。
    //
    // ⚠️ 默认**关**。我一开始设成 true，而那让整个功能看起来是坏的 ——
    // 实测诊断报告：status.ok=true 而 injected=0，因为门把事件全挡了。
    //
    // OWE 需要这个门是因为它是纯壁纸应用（前台是 Finder 约等于在看壁纸），
    // 而我们有面板、终端、诊断报告 —— 用户大部分时间前台不是 Finder。
    // ⟹ 默认放行。代价是在别的应用里滑滚轮壁纸也会动，
    // 那比"点壁纸完全没反应"可接受得多。
    mouseGateFinder: false,
    // ⚠️⚠️ `mouseForwardMigrated` —— 0.9.88 那条迁移的"只跑一次"标记。
    //   **那条迁移 0.9.97 删了**（它的前提是错的，见上面 mouseForward 那段），
    //   所以这个字段现在**不驱动任何逻辑**。
    //
    // ⚠️ 但**不能从这里删掉** —— 用户的 config 文件里已经写着它，而
    //   `mergeConfig` 只遍历 defaultConfig 的键 ⟹ 删了它就会被静默剥掉。
    //   那本身无害（没人读），但它同时是 0.9.93 那个 bug 的**活教材**：
    //   0.9.88~0.9.92 期间这个字段不在这儿 ⟹ 每次启动被剥掉 ⟹ 迁移每次都跑
    //   ⟹ 用户开了开关、重开应用又被关掉，而且不报错。
    //   ⟹ 判据：**任何写进 config 的字段都必须在 defaultConfig 里声明。**
    mouseForwardMigrated: false,
  },
  // ⚠️ 默认**关**。这是开发时的遗留:HUD 盖在壁纸左上角,而它报的东西(fps、壁纸层策略、
  // 鼠标事件收不收到、三层设了没)全是调试信息。用户报「一打开就出现这个把壁纸盖住了」。
  //
  // 而且那个开关原来在「壁纸与音乐」tab 里,收缩之后没了入口 ⟹ 打开就关不掉。
  // 要看它的话 ⌃⇧H。
  debug: { showHud: false },
};

let config = null;

// ⚠️⚠️⚠️ **这个 catch 藏了一个真 bug 好几个月**（0.9.122 修）。
//
// 用户 2026-08-02 报「Steam 用户名和 API key 每次打开都要重填」，
// 而我 0.9.120 当成"存下来的没显示出来"，加了回填代码 —— **没用**，
// 因为真相是**存下来的东西在读回来时被整体丢弃了**：
//
//   `mergeConfig` 递归到 `we.steam.apiKey`（默认值 `null`）时，
//   `typeof null === 'object'` ⟹ 躲过 `typeof base !== 'object'` 那道闸
//   ⟹ 走到 `Object.keys(null)` ⟹ **TypeError**
//   ⟹ 这个 catch 吞掉 ⟹ 返回**全套默认值** ⟹ 所有设置回出厂状态。
//
// ⚠️ 而它影响的**远不止凭证** —— 默认值是 null 的字段全在里面：
//   `we.dir`（上次装的壁纸）、`we.steamCmdPath`、`layers.background/subject/shard`。
//   用他 0.9.116 那份诊断报告里的真实 config 直接跑 mergeConfig 就抛。
//
// ⚠️⚠️ 判据：**`catch {}` 不写理由就是在赌"这里只会因为我想到的那个原因失败"**。
//   这个 catch 想兜的是"文件不存在 / JSON 坏了"（那两个确实该回默认），
//   而它顺手把"我们自己的代码抛异常"也兜了 —— 而后者的正确反应是**吵**，
//   不是静默降级。⟹ 分开处理，并且**任何情况下都留下日志**。
function readConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_FILE(), 'utf8');
  } catch (error) {
    // ⚠️ 首次启动没有这个文件 —— 那是正常的，不值得报警。
    if (error.code !== 'ENOENT') {
      console.warn('[config] 读不出来，回默认值：', error.message);
    }
    return JSON.parse(JSON.stringify(defaultConfig));
  }
  let saved;
  try {
    saved = JSON.parse(raw);
  } catch (error) {
    // ⚠️ 文件坏了。回默认是对的，但**必须说出来** ——
    //   否则用户看到的是"我的设置莫名其妙全没了"。
    console.error('[config] JSON 坏了，回默认值（原文件不动）：', error.message);
    return JSON.parse(JSON.stringify(defaultConfig));
  }
  try {
    return mergeConfig(defaultConfig, saved);
  } catch (error) {
    // ⚠️⚠️ 走到这里说明**是我们自己的 bug**（mergeConfig 抛了）——
    //   而这正是上面那个"藏了几个月"的场景。
    //   ⟹ 回默认值仍然是唯一能继续启动的选择，但要**吵到能被发现**：
    //     带堆栈，而且明说"这是 bug 不是配置问题"。
    console.error('[config] ⚠️ mergeConfig 抛异常 —— 这是代码 bug，'
      + '你的设置这次会回到默认值（磁盘上的文件没被改）：', error.stack || error.message);
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
  // ⚠️⚠️⚠️ **`base === null` 必须单独判**（0.9.122）。
  //
  //   `typeof null === 'object'` —— JS 最有名的那个坑。所以下面那道
  //   `typeof base !== 'object'` 的闸**拦不住 null**，会一路走到
  //   `Object.keys(null)` ⟹ TypeError ⟹ readConfig 回默认值
  //   ⟹ **用户所有设置静默丢失**。
  //
  // ⚠️ 而"默认值是 null"在这个 config 里是**常态**，不是边角情况 ——
  //   它的语义就是"还没设过"：
  //     we.dir（上次装的壁纸）、we.steam.{username,password,guardCode,apiKey}、
  //     we.steamCmdPath、layers.{background,subject,shard}
  //   ⟹ 也就是说这条路径**任何一个存了值的用户每次启动都会踩**。
  //   （用户 2026-08-02 报"凭证每次都要重填"就是它；而我 0.9.120 把症状
  //     读成"没回填"，加了回填代码 —— 那读的是一个已经被重置的 config。）
  //
  // ⚠️ 返回 `saved` 是对的：默认 null = "没有默认结构可合并"
  //   ⟹ 用户存的值就是全部信息，整体采用。
  if (base === null) return saved;
  if (Array.isArray(base) || typeof base !== 'object') return saved;
  if (OPAQUE_DICTS.has(key)) return JSON.parse(JSON.stringify(saved));
  const out = {};
  for (const k of Object.keys(base)) out[k] = mergeConfig(base[k], saved[k], k);
  return out;
}

// 一次性迁移：把存量配置里已经作废的选择改掉。
//
// ⚠️ 为什么需要这个：mergeConfig 会**保留**用户存过的值（那是对的 ——
// 用户改过的设置不该被新版本覆盖）。但有些旧值现在是**明确错的**，
// 不是"用户的偏好"。
//
// 实测踩到的那次：我把 we.strategy 的默认值从 bottom-normal 改成 desktop
//（因为鼠标转发让"真壁纸层 + 能点"同时成立了），而用户的 config.json 里
// 存着旧的 bottom-normal ⟹ 三个现象一个根因：
//   覆盖不了菜单栏（普通窗口画不到那层）
//   点击没反应（转发只在 desktop 层开）
//   切桌面看到原生壁纸（普通窗口叠在壁纸层之上，有一帧延迟）
//
// ⟹ 改默认值对存量用户是无效的，必须显式迁移。
function migrateConfig(cfg) {
  let changed = false;
  const we = cfg.we || {};

  // bottom-normal 现在没有存在理由了：它唯一的优势（能收鼠标）已经被
  // desktop + 鼠标转发覆盖，而它的劣势（画不到菜单栏那层）无法弥补。
  if (we.strategy === 'bottom-normal') {
    we.strategy = 'desktop';
    changed = true;
    console.log('[config] 迁移：we.strategy bottom-normal → desktop'
      + '（真壁纸层能覆盖菜单栏，鼠标靠转发补回来）');
  }
  // ⚠️⚠️⚠️ 这里原来有一条迁移：把存量的 `mouseForward: true` 关掉（0.9.88）——
  //   **0.9.97 删了，因为它的理由是错的。**
  //
  // 那条迁移的依据是"鼠标转发要辅助功能授权，而那让每次开应用都被要权限"。
  // 而 2026-08-02 的探针（用户真机）证明**监听鼠标不需要那个授权**：
  //     helper 报 trusted: false，同时抓到 99 个鼠标事件。
  // ⟹ 前提是错的（错的来源见 defaultConfig 里 mouseForward 那段注释），
  //   而"每次开应用都弹框"的真根因是 **helper 名字带 hash**（0.9.89 已修）。
  //
  // ⚠️ 而它还有个附带伤害：`mouseForwardMigrated` 那个标记 0.9.88~0.9.92 期间
  //   **没在 defaultConfig 里声明** ⟹ 被 mergeConfig 静默剥掉 ⟹ 迁移每次启动
  //   都跑一遍 ⟹ 用户开了开关、重开应用又被关掉（他实测撞到，0.9.93 才修）。
  //   ⟹ 一条建立在错前提上的迁移，外加一个静默失效的"只跑一次"，
  //     合起来就是"我明明开了它自己关"。删掉整条最干净。
  // ⚠️ 老配置里没这个键时补默认（现在是 true —— 见 defaultConfig 那段）。
  if (we.mouseForward === undefined) { we.mouseForward = true; changed = true; }
  // ⚠️ 轮播的默认值要逐字段补 —— 老配置里没有这个对象，而代码里到处
  // 读 `config.we.rotate.list` ⟹ 少一层就是 `undefined.list` 崩溃。
  if (!we.rotate || typeof we.rotate !== 'object') {
    we.rotate = { on: false, minutes: 30, mode: 'order', list: [] };
    changed = true;
  } else {
    if (typeof we.rotate.on !== 'boolean') { we.rotate.on = false; changed = true; }
    if (typeof we.rotate.minutes !== 'number' || we.rotate.minutes < 1) {
      we.rotate.minutes = 30; changed = true;
    }
    if (we.rotate.mode !== 'order' && we.rotate.mode !== 'random') {
      we.rotate.mode = 'order'; changed = true;
    }
    if (!Array.isArray(we.rotate.list)) { we.rotate.list = []; changed = true; }
  }

  // ⚠️ 音源默认值从 'off' 改成了 'system'，而**改默认值对存量配置无效** ——
  // `mergeConfig` 保留已存的值，所以老用户会永远停在 'off'。
  //
  // 这个坑我在本项目栽过一次（改了 `wallStrategy` 默认值但没迁移 ⟹ 三个症状
  // 同时出现：菜单栏没覆盖、点击没反应、原生壁纸闪 —— 全是同一个根因）。
  //
  // ⚠️ 只迁移 'off'，不动别的：
  //   'off'    —— 那是**旧的默认值**，绝大多数是"从没选过"而不是"主动关掉"
  //   'netease' / 'synth' —— 用户主动选的，不许覆盖
  //
  // 代价：极少数真的主动关掉音源的人会被重新打开一次。而收益是所有从没选过的人
  // 不用再经历"这个壁纸怎么不动"——那正是本项目查了六轮的症状。
  if (we.audioSource === 'off') {
    we.audioSource = 'system';
    changed = true;
    console.log('[config] 迁移：音源 off → system'
      + '（默认值改了；采集只在壁纸真的要音频时才启动）');
  }

  // ⚠️⚠️ **AI 提供方从 bedrock 迁到 deepseek**（0.9.124）。
  //
  // ⚠️ 为什么必须显式迁移：0.9.123 装过一次之后，磁盘上的 config 里已经存了
  //   `provider: 'bedrock'` + Bedrock 的模型 ID ——而 `mergeConfig` 会**保留
  //   用户存过的值**（那是对的：用户改过的设置不该被新版本覆盖）
  //   ⟹ 光改 defaultConfig 对存量用户**完全无效**。
  //   这个项目为同一件事栽过（we.strategy 那次三个现象一个根因）。
  //
  // ⚠️⚠️ 而判据是"**这个值是从没选过还是主动选的**"：
  //   0.9.123 到 0.9.124 之间**面板上没有任何地方能选提供方**
  //   ⟹ 磁盘上的 'bedrock' 100% 是旧默认值，不可能是用户的选择
  //   ⟹ 迁移它是安全的。
  // ⚠️ 但 **apiKey 一个字都不动** —— 那是用户自己填的东西。
  //   （而 Bedrock 的 key 在 DeepSeek 上会返回 401，
  //     那条错误 llm.js 会说"API key 填错了或者过期了"—— 说得对。）
  // ⚠️⚠️⚠️ **改回 Bedrock Claude**（0.9.143）。用户 2026-08-02：
  //   「我就是想把我们这个默认的模型给他换成 claude」
  //
  // ⚠️⚠️ **光改 `defaultConfig` 对存量用户无效** —— `mergeConfig` 保留磁盘上
  //   已有的值 ⟹ 用户的 config.json 里那个 `deepseek-v4-flash` 会一直用下去。
  //   ⟹ 判据：**改默认值必须配一条显式迁移**，否则"我改了默认"只对新用户成立。
  //     （这个项目为这条栽过：改了 defaultConfig 然后以为生效了。）
  //
  // ⚠️ 而这条迁移**只认那两个我们自己写进去的模型 ID**（0.9.126 那次迁移的产物）
  //   ⟹ 用户自己填过别的模型就不动他的。
  //   ⚠️ 判据：**一次性迁移要硬编码"当时的那个值"**，不能写成活规则
  //     （"凡是 deepseek 就换掉"会把用户以后主动选的 deepseek 也换掉）。
  const ai = we.ai || {};
  const OURS = ['deepseek-v4-flash', 'deepseek-v4-pro'];
  if (ai.provider === 'openai' && OURS.includes(String(ai.model || ''))) {
    ai.provider = 'bedrock';
    ai.model = 'us.anthropic.claude-opus-4-8';
    ai.region = ai.region || 'us-west-2';
    // ⚠️⚠️ **apiKey 清成 null** —— DeepSeek 的 key 在 Bedrock 上是 401，
    //   留着它只会让用户看到一句"key 填错了"而不知道是换了提供方。
    //   ⟹ 清掉之后面板会说"还没填 key"，而那句话是对的。
    //   ⚠️ 而如果环境变量里有 AWS_BEARER_TOKEN_BEDROCK，`resolveAiConfig()`
    //     会自动用上 ⟹ 用户什么都不用填。
    ai.apiKey = null;
    we.ai = ai;
    changed = true;
    console.log('[config] 迁移：AI 模型 deepseek-v4-flash → Bedrock Claude Sonnet 4.5'
      + '（实测推理小模型把预算烧在思考上、产物质量不够；'
      + 'DeepSeek 的 key 在 Bedrock 上无效已清掉，'
      + '环境变量 AWS_BEARER_TOKEN_BEDROCK 会自动用上）');
  }

  // ⚠️⚠️ **0.9.143 那一版存的是 Sonnet 4.5 ⟹ 换成 Opus 4.8**（0.9.144）。
  //   用户 2026-08-03：「这个模型默认应该用 opus 4.8」
  //
  // ⚠️ 这条和上面那条是**两条独立的迁移**，不能合并：
  //   上面那条从 DeepSeek 来（要换提供方 + 清 key），这条只换模型 ID。
  //   ⚠️⚠️ 而这条**绝不动 apiKey** —— 0.9.143 用户已经把 Bedrock 的 token
  //     填进去并且验证通了，清掉它等于让他白填一次。
  //     ⟹ 判据：**同一个提供方内换模型，凭证是有效的，别碰。**
  //       （上面那条清 key 是因为**换了提供方**，两件事不一样。）
  if (ai.provider === 'bedrock'
      && String(ai.model || '') === 'us.anthropic.claude-sonnet-4-5-20250929-v1:0') {
    ai.model = 'us.anthropic.claude-opus-4-8';
    we.ai = ai;
    changed = true;
    console.log('[config] 迁移：AI 模型 Sonnet 4.5 → Opus 4.8'
      + '（用户点名；同一个提供方，已填的 token 继续有效）');
  }

  // ⚠️⚠️⚠️ **清掉壁纸动作的存量录制**（0.9.130）。用户 2026-08-02：
  //   「壁纸动作那些都删掉，只保留系统动作」
  //
  // ⚠️ 光删面板上那一段**会留一个静默的坑**：`input.js` 的 `updateRecorded()`
  //   遍历的是 `config.recorded` 里**所有**条目（不是"面板上显示的那些"）
  //   ⟹ 用户以前录过的壁纸手势会继续匹配、继续触发，
  //     而面板上已经没有任何地方能看到或关掉它们。
  //   ⟹ 症状是"我做某个手势画面就动一下，而设置里找不到这一项" ——
  //     那种"看不见的东西在生效"是这个项目最贵的一类 bug。
  //
  // ⚠️ 判据：**删入口之前先问"这个功能的状态存在哪、谁还在读它"。**
  //   （反过来那次也栽过：三层接好了而面板零入口，功能静默不可用。）
  //
  // ⚠️ 写死这 8 个 id 而不是"凡是 !system 的都清"：
  //   前者在动作表变了之后**行为不变**（多一个壁纸动作不会被这条误清），
  //   后者会把以后任何新加的非系统动作也一起清掉。
  //   ⟹ 一次性迁移要锚定**当时那批具体的东西**，不是一条会继续生效的规则。
  const WALL_ACTIONS = ['zoom', 'parallax', 'yawLeft', 'yawRight',
    'pitchUp', 'pitchDown', 'spin', 'resetView'];
  if (cfg.recorded && typeof cfg.recorded === 'object') {
    const dropped = WALL_ACTIONS.filter((id) => cfg.recorded[id]);
    if (dropped.length) {
      for (const id of dropped) delete cfg.recorded[id];
      changed = true;
      console.log(`[config] 迁移：清掉 ${dropped.length} 个壁纸动作的录制`
        + `（${dropped.join(', ')}）—— 面板上已经没有这一段了，`
        + '留着会继续触发而用户看不到、也关不掉');
    }
  }

  cfg.we = we;
  return changed;
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
  for (const win of [wallWindow, dashboardWindow, overlayWindow, weWindow]) {
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
  // ⚠️ onVoiceText 那个回调 0.9.106 删了（语音整条撤掉）。
});

// ⚠️⚠️⚠️ **语音命令整条删了**（0.9.106）。用户 2026-08-02：
//   「我觉得语音控制这个我们把它删掉吧，不需要」
//
// ⚠️ 而删之前它是坏的，坏在一个我该早看出来的地方：用户说「点」，期望"在指针位置
//   点一下"（**他的理解完全对** —— 骨架那个指针就是鼠标位置）。而
//   `VOICE_PATTERNS` 里**根本没有「点」这一条**，只有网易云/浏览器/访达/暂停/
//   下一首/上一首六个。voice helper 那边倒是有个 `__AIRCURSOR_VOICE_TAP__` 分支
//   会发 `onVoiceText('点')`，可它送进来必然"没匹配上"。
//   ⟹ **一条接了一半的链**：helper 认得那个词，主进程不认，而两边都不报错。
//
// ⟹ 与其补那一条，用户选择整个删掉 —— 而那是对的取舍：语音要占麦克风、要一个
//   额外授权、还有"抢占音频输入会切换正在放的音乐音轨"那个副作用（他 0.9.7x 报过），
//   而它换来的是六个用鼠标一秒能做完的动作。

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

  watchRendererErrors(win, 'wall');
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

// 渲染进程的未捕获异常。
//
// ⚠️ 这是"点了没反应"这类问题的**唯一**观测点：面板的 JS 一旦在顶层抛，
// 后面的初始化全停（包括绑定开关），而异常本身进不了终端也进不了任何界面。
//
// 骨架层更糟 —— 它没有开发者工具、不在视线里，那是另一个模块注释里明说过的坑。
// build 标识：版本 + commit + 是否打包。
//
// ⚠️ commit 从环境变量读，因为**打包产物里没有 .git** —— 打包时由脚本注入。
// 读不到就显示 'dev'，而那本身就是有用的信息（说明不是正式包）。
function buildStamp() {
  const version = app.getVersion();
  // ⚠️ 打包产物里没有 .git，所以 commit 由 build-mac.sh 在打包时注入进
  // package.json 的 extraMetadata ⟹ 这里从 app 的 package.json 读。
  // 读不到就是 'dev'（npm start 直接跑），那本身就是有用的信息。
  let commit = process.env.GW_COMMIT || 'dev';
  try {
    // eslint-disable-next-line global-require
    const meta = require(path.join(app.getAppPath(), 'package.json'));
    if (meta && meta.gwCommit) commit = meta.gwCommit;
  } catch { /* npm start 下读不到也正常 */ }
  return `v${version} ${commit} ${app.isPackaged ? '打包版' : 'npm start'}`;
}

function watchRendererErrors(win, label) {
  if (!win || win.isDestroyed()) return;
  // ⚠️ 重复折叠。同一条消息刷几千行会把真问题埋掉,而日志是我们唯一的观测通道。
  //
  // 实测:某个工坊壁纸的 `sakura.js:657` 调了非法 WebGL 参数(画面照常),报错刷了
  // **几千行** ⟹ 用户那次能找到真正那条 `[object Object]` 有运气成分。
  //
  // ⚠️ 折叠不能"丢弃":前 N 次照常报(那才看得到上下文),之后按指数间隔报一次并带上
  // 累计次数。完全静音会让"这个错还在发生吗"变成没法回答的问题。
  const seen = new Map();
  const emit = (text, extra) => {
    const n = (seen.get(text) || 0) + 1;
    seen.set(text, n);
    // 前 3 次照常;之后 10、100、1000… 各报一次
    if (n > 3 && n !== 10 && n !== 100 && n !== 1000 && n % 10000 !== 0) return;
    const suffix = n > 3 ? ` (× ${n})` : '';
    console.error(`[${label}] ${text}${suffix}`);
    logEvent(label, `${text}${suffix}`, extra);
  };

  win.webContents.on('render-process-gone', (_e, details) => {
    emit(`渲染进程挂了：${details.reason}`);
  });

  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    emit(`preload 出错 ${preloadPath}：${error && error.message} —— window.gw 不存在`);
  });

  // ⚠️ console-message 是把页面里的异常捞出来的主通道。
  //
  // ⚠️ **两种签名都要接。**Electron 36 起从 (event, level, message, line, sourceId)
  // 变成单个 details 对象 ⟹ 只按旧签名解会**静默变哑**(level 是对象,`< 2` 恒为 false,
  // 或者 message 恒为 undefined),而症状是"日志区什么都不出" —— 和"没出错"分不开。
  //
  // 这一层的全部价值就是别再静默,所以它自己尤其不能静默。
  win.webContents.on('console-message', (...args) => {
    const d = args[1] && typeof args[1] === 'object' ? args[1] : null;
    const level = d ? ({ error: 3, warning: 2 }[d.level] ?? 1) : args[1];
    const message = d ? d.message : args[2];
    const line = d ? d.lineNumber : args[3];
    const sourceId = d ? d.sourceId : args[4];
    // level 3 = error、2 = warning。只报这两级,否则日志会被刷屏。
    if (level < 2) return;
    const where = sourceId ? `${String(sourceId).split('/').pop()}:${line}` : '?';
    emit(`${level === 3 ? '错误' : '警告'}：${message} (${where})`, { level });
  });

  // ⚠️ 资源 404。**`<script>` / `<link>` 的加载失败不进 console-message**,而少一个
  // 脚本的症状就是"这一层的功能整个不工作、且什么都不说"。
  //
  // 这个项目为它烧过两轮:一次是 postinstall 掉了(vendor 空 → 404),一次是打包后
  // asar 读不到 wasm(MediaPipe 的 locateFile 返回相对路径,而 asarUnpack 把文件放到
  // app.asar.unpacked/,从 app.asar/ 里的相对路径到不了那儿)。
  // ⚠️ **两个协议都要监听。**只挂 `file:///*` 会漏掉 WE 壁纸的全部资源 ——
  // 那一层走的是自定义协议 `wall://`（`WE_SCHEME`，见 registerSchemesAsPrivileged），
  // 不是 file://。
  //
  // 而漏的正好是最需要看见的那类：用户报「预览图有山景背景、装载后纯黑」时，
  // 日志里只有渲染进程那句 `Not allowed to load local resource: [object Object]`，
  // 它不说是哪个资源、也不说为什么 —— 因为 404 通道压根没在听 wall://。
  //
  // 另外**图片扩展名也要收**（jpg/png/gif/webp）：壁纸的背景就是图片，
  // 而原来的白名单只有脚本和样式 ⟹ 背景图 404 会被静默过滤掉。
  win.webContents.session.webRequest.onErrorOccurred(
    { urls: ['file:///*', `${WE_SCHEME}://*/*`] },
    (details) => {
      if (!/\.(js|wasm|tflite|data|binarypb|css|html|jpe?g|png|gif|webp|mp4|webm|ogg)$/i
        .test(details.url.split('?')[0])) return;
      emit(`加载失败：${decodeURIComponent(details.url.split('/').slice(-2).join('/'))}`
        + ` (${details.error})`);
    },
  );
}

function openDashboard() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.show();
    // ⚠️ 从 Dock 图标 / ⌃⇧W 唤回时要真的到前台。
    // 最小化状态下 show() 不会恢复窗口 ⟹ 要先 restore()。
    if (dashboardWindow.isMinimized()) dashboardWindow.restore();
    dashboardWindow.focus();
    return;
  }
  // ⚠️⚠️ **初始尺寸按屏幕算**（0.9.55）。用户 2026-08-01：
  //   「产品打开的初始大小改一下吧，左侧展示面太小了」
  //
  // 940×700 是 0.9.54 之前那个"左栏 + 单列内容"布局的尺寸。
  // 而现在是"网格 + 右侧详情 340px"⟹ 940 宽下网格只剩 560px（三列卡片），
  // 而**壁纸墙的价值就在于一眼看到很多张**。
  //
  // ⚠️ 但不能写死 1280 —— 那在 MacBook Air 13"（1440×900 逻辑分辨率）上
  // 已经占了 89% 宽度，而在更小的屏上会被 macOS **夹回可见区**，
  // 那时候用户看到的是一个"打开就贴满屏幕"的窗口（比小窗更糟）。
  // ⟹ 取 min(想要的, 工作区的 88%)：想要 1280×820，屏幕小就按比例缩。
  // ⚠️ 用 workAreaSize 而不是 bounds —— 后者含菜单栏和 Dock 占的那部分，
  //   按它算出来的窗口会有一截在 Dock 底下。
  const { workAreaSize } = screen.getPrimaryDisplay();
  const winW = Math.min(1280, Math.round(workAreaSize.width * 0.88));
  const winH = Math.min(820, Math.round(workAreaSize.height * 0.88));
  console.log(`[panel] 窗口 ${winW}×${winH}（工作区 ${workAreaSize.width}×${workAreaSize.height}）`);

  dashboardWindow = new BrowserWindow({
    width: winW,
    height: winH,
    // ⚠️ minWidth 从 780 提到 900：820 以下会触发 CSS 那条 media query
    // （详情面板叠到网格下面），而那是**窄窗口的降级形态**，不该是常态。
    // 900 保证正常情况下总是"网格 + 右侧详情"两列。
    minWidth: 900,
    minHeight: 600,
    title: 'DreamPaper',
    // ⚠️⚠️ **深色标题栏**（0.9.46）。用户 2026-08-01 报：
    //   「wall 这块是用的 Mac 原生的那个条一个白条，因为我是浅色主题吗？
    //     但是我们整体是深色主题，他就不是一个整体，你懂吗？
    //     我们完全就没有设计出一个很完整的一个产品，给我的感觉就像是终端」
    //
    // 根因：原来没设 titleBarStyle ⟹ 用系统默认标题栏，而它跟**系统主题**走。
    // 用户是浅色主题 ⟹ 白条压在我们 #101014 的深色面板上，两截。
    //
    // `hidden` = 标题栏透明、内容延伸到顶部 ⟹ 顶部那条由**我们的 CSS** 画。
    // 这样它必然和面板同色，因为就是同一块。
    //
    // ⚠️⚠️ **红绿灯默认藏起来，鼠标移到顶部才出现**（0.9.58）。用户 2026-08-01：
    //   「mac 的红绿灯不能做成隐藏的吗，我看现在还是为了这个，上方留了空白，
    //     并且我有点什么操作，这个红绿灯就显示出来，不应该这样的，
    //     我鼠标在顶部想要点再显示呗，很多的产品都是这样设计的，
    //     而已一开始的 gesturewall 那个界面，左上角突兀的红绿灯真的很违和」
    //
    // ⟹ `hidden` + `setWindowButtonVisibility(false)`，再由渲染进程在
    //   鼠标进入/离开顶部区域时切换（见 ipcMain.handle('title-bar-hover')）。
    //
    // ⚠️ 为什么不用 `titleBarStyle: 'customButtonsOnHover'` —— 它**正好**是这个
    // 行为（文档：「the traffic light buttons will display when being hovered over」），
    // 但文档同时标着「**This option is currently experimental**」，
    // 而且没说那三个按钮是原生的还是 Electron 自绘的。
    // ⟹ 这个项目栽过七次"注册成功但功能是死的"，而实验性 API 正是那种形状。
    //   `hidden` + `setWindowButtonVisibility` 两个都是稳定 API，
    //   代价只是"什么时候显示"要我们自己判断 —— 那是可控的。
    //
    // ⚠️ 不用 `frame: false` —— 那会连红绿灯一起没掉，我们就得自己画三个按钮，
    // 而"自己画的关闭按钮"是另一个能出 bug 的地方（这个项目刚因为关窗口行为
    // 被用户报过问题）。`hidden` 保留原生按钮，只是先藏起来。
    titleBarStyle: 'hidden',
    // ⚠️ backgroundColor 不能再跟 nativeTheme 走 —— 面板 CSS 是**写死深色**的
    // （`color-scheme: dark` + `--bg: #101014`）。跟着系统给浅色的后果：
    // 窗口出现的那一瞬间闪一下白（CSS 还没生效），而那正是"像终端"的感觉来源之一。
    backgroundColor: '#101014',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // ⚠️⚠️ **建完立刻藏红绿灯**（0.9.58）。
  // ⚠️ 必须在 `new BrowserWindow` **之后**调 —— 它是实例方法，不是构造选项。
  // ⚠️ 用 try 包住：`setWindowButtonVisibility` 是 macOS 专用，
  //   在别的平台上调会抛，而那会把后面的初始化全停掉
  //   （包括 loadFile ⟹ 白窗口）。这个项目为"一处抛异常挡住后面全部"栽过。
  try {
    dashboardWindow.setWindowButtonVisibility(false);
  } catch (error) {
    console.warn('[panel] 藏红绿灯失败（非 macOS？）：', error.message);
  }
  // ⚠️⚠️ 起轮询（0.9.60）—— 见 pollTrafficLights 上面那段：
  // 渲染进程的 mousemove 在窗口未聚焦时不可靠，而"从别的应用把鼠标移过来"
  // 正是最常见的路径。
  startTrafficWatch();

  // ⚠️ 面板的异常最误导：它一抛，后面的初始化全停（包括绑定所有开关），
  // 表现为"某个开关点了完全没反应"—— 而那看起来像那个功能坏了。
  watchRendererErrors(dashboardWindow, 'dashboard');
  dashboardWindow.loadFile(path.join(__dirname, 'dashboard.html'));
  dashboardWindow.webContents.on('did-finish-load', () => {
    dashboardWindow.webContents.send('config', config);
    // Deliberately reports the *wall's* frame, not the settings window's — the
    // settings window has no business being fullscreen.
    sendStrategy(dashboardWindow, currentStrategy, wallWindow);
  });
  // ⚠️⚠️⚠️ **点红色 ✕ = 整个退出**（0.9.47）。用户 2026-08-01：
  //   「点了这个关闭按钮，我是不是所有的程序进程都要结束掉呢？但不是这样子的…
  //     你正常来说就是应该我点了关闭，那就整个进程关闭都关，
  //     我缩小了那程序在运行中，我这个 Dock 图标的圆点应该还在的」
  //
  // ⚠️ 挂 `close`（关闭前）而不是 `closed`（已关闭）—— 我们要在窗口消失**之前**
  // 就开始退出流程，否则中间有一帧"窗口没了但壁纸还在"，那正是用户困惑的画面。
  //
  // ⚠️ 挂这里而不是 `app.on('window-all-closed')` —— 后者在这个应用里永远
  // 不触发（壁纸层和骨架层也是 BrowserWindow，见那个 handler 的注释）。
  //
  // ⚠️ **最小化不走这里** —— minimize 不发 close 事件，所以"缩小 = 还在跑、
  // Dock 圆点还在"是自动成立的，不需要额外代码。这正是标准 Mac 行为。
  dashboardWindow.on('close', () => {
    hardQuit('关闭面板窗口');
  });
  dashboardWindow.on('closed', () => { dashboardWindow = null; stopTrafficWatch(); });
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
  // ⚠️ 骨架层最需要这个：它没有开发者工具、不在视线里，
  // 而摄像头就在这个窗口里 —— 它的加载期错误只会表现成"摄像头打不开"。
  watchRendererErrors(overlayWindow, 'overlay');
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

// ⚠️⚠️ 骨架层的"闸门"（0.9.48）—— 见 whenReady 里那段注释。
// 启动页在的时候不建骨架（它会压在启动页上），等面板说"用户进来了"才放行。
let overlayGate = null;

// ⚠️⚠️⚠️ **壁纸的闸门**（0.9.128）。用户 2026-08-02：
//   「我们的软件打开会出现 gesturewall 这界面，此时壁纸等不应该生效的，
//     等我点击进入才正常改生效，这是方便后面做账号登陆那种东西」
//
// ⟹ 启动页是一道门：点进去之前桌面上什么都不该变。
// ⚠️ 用**同一条信号**（`launch-dismissed`）和同一个兜底形状 ——
//   见 whenReady 里那段判据：已经有一道闸门就挂上去，别开第二道。
let wallpaperGate = null;
let wallpaperStarted = false;

function releaseWallpaperGate() {
  // ⚠️ 幂等：面板每次重开都会再发一次 `launch-dismissed`，而 20 秒兜底定时器
  //   也会调 ⟹ 必须只装一次（`wallpaperStarted`），否则第二次会把当前壁纸
  //   窗口重建一遍（画面闪一下，而且 weProject 状态会错）。
  if (wallpaperGate !== null) { clearTimeout(wallpaperGate); wallpaperGate = null; }
  if (wallpaperStarted) return;
  wallpaperStarted = true;

  // 上次装的 WE 壁纸还在就恢复它，否则用我们自己的三层景深。
  if (config.we.dir && fs.existsSync(path.join(config.we.dir, 'project.json'))) {
    setWEWallpaper(config.we.dir);   // ⚠️ 它自己会 broadcast('we-status')
  } else {
    // ⚠️⚠️ **回落这一支也要广播**（0.9.134）。用户 0.9.133 那轮问到的：
    //   「壁纸不在了 ⟹ 回落到三层景深」这件事面板上也看不到 ——
    //   `createWallWindow` 不发任何通知，而面板首次渲染发生在闸门之前
    //   ⟹ 它以为"还没装壁纸"，而其实已经在放内置那个了。
    // ⚠️ 而**上次存过路径却没恢复成功**是需要说出来的：
    //   用户会问"我上次那张呢"，而答案是"那个目录不在了"。
    if (config.we.dir) {
      console.warn(`[launch] 上次的壁纸目录不在了，回落到内置壁纸：${config.we.dir}`);
      logEvent('launch', `上次的壁纸目录不在了（${config.we.dir}）⟹ 回落到内置的三层景深`);
    }
    wallWindow = createWallWindow(config.wallStrategy);
    // ⚠️ 用**现成的** we-status 广播（setWEWallpaper 那支也发它）——
    //   面板据此知道"壁纸这件事有结论了"，然后重扫列表。
    //   ⚠️ 不新造通道：这个项目为"新造一个没人听的频道"栽过。
    broadcast('we-status', weStatus(null));
  }
  // ⚠️ **轮播要在恢复壁纸之后起** —— `rotateNext()` 靠 `weProject.dir` 判断
  // "当前是列表里的第几个"，而那时 weProject 才有值。
  // 放前面的话第一次切换会从列表开头开始（症状：重启后壁纸跳到第一个）。
  syncRotate();
  console.log('[launch] 用户进来了 ⟹ 壁纸生效');
}

function releaseOverlayGate() {
  // ⚠️ 幂等：两条路径都会调（面板信号 + 20 秒兜底定时器），而且面板每次
  // 重开都会再发一次信号。重复调 syncOverlayVisibility 是安全的
  //（它自己按 gestures.enabled 建拆），但定时器必须清 —— 不清的话
  // 20 秒后那条 console.warn 会在一切正常的情况下也打出来，
  // 而"日志里有警告但其实没事"会让下次排查走错方向。
  if (overlayGate !== null) { clearTimeout(overlayGate); overlayGate = null; }
  syncOverlayVisibility();
}

// 面板：用户点掉启动页了 ⟹ 骨架层和壁纸一起放行。
// ⚠️ 两者共用这一条信号（0.9.128 加了壁纸那条）—— 见 wallpaperGate 那段判据。
ipcMain.handle('launch-dismissed', () => {
  releaseOverlayGate();
  releaseWallpaperGate();
  return true;
});

// ⚠️⚠️ 打开外部链接（0.9.54）。**必须校验协议** ——
// `shell.openExternal` 会照做渲染进程给的任何 URL，包括 `file://`
// （能打开本机任意文件）和自定义 scheme（能唤起别的应用）。
// 而这个面板里的 URL 来自 Steam 的接口返回 ⟹ 不是我们完全控制的输入。
// ⟹ 只放 http/https，其余直接拒。
ipcMain.handle('open-external', async (_event, url) => {
  try {
    const u = new URL(String(url || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      console.error(`[external] 拒绝非 http(s) 链接：${u.protocol}`);
      return { ok: false, error: '只支持 http/https 链接' };
    }
    await shell.openExternal(u.toString());
    return { ok: true };
  } catch (error) {
    // ⚠️ new URL 对畸形字符串会抛 —— 那不该让面板崩，报回去就行
    return { ok: false, error: `打不开这个链接：${error.message}` };
  }
});

// ⚠️⚠️⚠️ **红绿灯的显隐：主进程轮询鼠标位置**（0.9.60 重做）。
//
// 用户 2026-08-01（0.9.59 之后）：
//   「红绿灯这个比刚才好了，但是触发有点迷，我鼠标放到红绿灯那里了，
//     但是没反应。好像必须点击一些窗口最上方，然后才可以显示」
//
// ⚠️⚠️ **那句"必须点击才可以显示"就是根因**：
//   ① 渲染进程的 `mousemove` 在窗口**没聚焦**时派发不可靠 —— 那是浏览器行为，
//      我们改不了。而用户正是**从别的应用把鼠标移过来**的（那时窗口未聚焦）
//      ⟹ 网页收不到任何事件 ⟹ 红绿灯不出现。点一下窗口 = 让它聚焦，
//      之后 mousemove 才开始来 ⟹ 完全对上他描述的现象。
//   ② 而 0.9.59 我还在 `blur` 时主动藏 ⟹ 雪上加霜：从别的应用过来的路径上，
//      窗口是失焦的，那条 handler 刚好把它藏掉。
//
// ⟹ **不能靠渲染进程的鼠标事件。** 改成主进程轮询：
//    `screen.getCursorScreenPoint()` 拿全局鼠标（**不需要任何授权** ——
//    和 mouseTap 那条链不同，那个是"注入点击"才要辅助功能）
//    + `win.getBounds()` 算"在不在窗口顶部那一条"。
//
// ⚠️ 轮询频率 120ms：红绿灯不是需要跟手的东西（用户是"移过去、看到、点它"），
//    而 120ms 在人眼看来就是"立刻"。再快只是白烧 CPU（这个应用常驻）。
// ⚠️ **只在面板可见时轮询** —— 窗口最小化/关掉之后接着轮询是纯浪费，
//    而这个应用会开一整天。
const TRAFFIC_ZONE = 34;     // 窗口顶部这么高的一条（红绿灯占 y=13..25）
const TRAFFIC_POLL = 120;    // ms
let trafficTimer = null;
let trafficShown = false;
// ⚠️ 藏之前的宽限期：鼠标"在红绿灯上"和"刚离开顶部"在坐标上都是一瞬间的事，
// 而立刻藏会让"伸手去点，按钮跑了"（0.9.59 用户报过的原症状）。
// ⚠️ 单位是**轮询次数**不是毫秒 —— 那样只要改 TRAFFIC_POLL 不用同时改这个。
const TRAFFIC_GRACE = 4;     // 4 × 120ms ≈ 0.5s
let trafficOutTicks = 0;

function setTrafficLights(visible) {
  if (visible === trafficShown) return;
  if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
  try {
    dashboardWindow.setWindowButtonVisibility(visible);
    trafficShown = visible;
  } catch {
    // 非 macOS 上这个方法不存在 —— 静默失败（红绿灯本来就是 mac 的东西）
  }
}

function pollTrafficLights() {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
  // ⚠️ 最小化/隐藏时不判断也不藏 —— 窗口不可见，红绿灯的状态无关紧要，
  //   而 getBounds 在最小化状态下返回的位置是没意义的。
  if (!dashboardWindow.isVisible() || dashboardWindow.isMinimized()) return;

  let inZone = false;
  try {
    const pt = screen.getCursorScreenPoint();
    const b = dashboardWindow.getBounds();
    inZone = pt.x >= b.x && pt.x <= b.x + b.width
      && pt.y >= b.y && pt.y <= b.y + TRAFFIC_ZONE;
  } catch {
    // 拿不到坐标就当"不在"—— 但**不要因此藏掉**（见下面的宽限期）
    inZone = trafficShown && trafficOutTicks < TRAFFIC_GRACE;
  }

  if (inZone) {
    trafficOutTicks = 0;
    setTrafficLights(true);
    return;
  }
  // ⚠️ 宽限期：连续几拍不在顶部才藏。
  //   鼠标停在红绿灯上时坐标是在 zone 里的（它们就在 y=13..25），
  //   所以这个宽限主要防的是"移动过程中的抖动"和"刚好压在边界上"。
  if (!trafficShown) return;
  trafficOutTicks += 1;
  if (trafficOutTicks >= TRAFFIC_GRACE) setTrafficLights(false);
}

function startTrafficWatch() {
  if (trafficTimer !== null) return;
  trafficTimer = setInterval(pollTrafficLights, TRAFFIC_POLL);
}

function stopTrafficWatch() {
  if (trafficTimer !== null) { clearInterval(trafficTimer); trafficTimer = null; }
  trafficShown = false;
  trafficOutTicks = 0;
}

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
    // ⚠️⚠️ **在这里才拉起 pointer helper**（0.9.82）——
    // 它一启动就弹辅助功能授权框，而在这一刻用户是**真的在用手势控制鼠标**
    // ⟹ 那时问他要权限是合理的（用户原话：「点壁纸的时候问我要辅助功能，
    //   这是很正常的操作，就是他需要的」）。
    // ⚠️ `startPointer()` 自己幂等（已经在跑就直接返回）⟹ 每帧调它没问题。
    systemBridge.startPointer();
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
// ⚠️ `set-voice`、`open-microphone-settings`、`open-speech-settings` 三条 IPC
//   0.9.106 随语音功能一起删了 —— 麦克风和语音识别那两个授权只有语音在用
//   （系统声音走 CoreAudio 进程 tap，不要麦克风）。

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
    if (!target) {
      // ⚠️ 必须报出**是哪个路径**被拒了。
      //
      // 实测烧的一轮：用户的壁纸只显示花瓣和时钟、背景图不出来，日志里只有
      // 一句 `Not allowed to load local resource: file:///[object Object]` ——
      // 而那是渲染进程说的，它不知道我们这边拒了什么。403 静默返回 ⟹
      // 「背景没加载」和「路径越界」和「文件真不在」三种分不清。
      console.warn(`[we] 资源被拒：${url.pathname}（壁纸目录 ${weProject.dir}）`);
      broadcast('helper-log', { source: 'we', message: `资源路径被拒：${url.pathname}` });
      return new Response('forbidden', { status: 403 });
    }
    // 文件真的不在也要报 —— 否则和上面那种混在一起。
    if (!fs.existsSync(target)) {
      console.warn(`[we] 资源不存在：${url.pathname} → ${target}`);
      broadcast('helper-log', { source: 'we', message: `资源文件不在：${url.pathname}` });
      return new Response('not found', { status: 404 });
    }
    // ⚠️ 必须用 pathToFileURL，不能裸拼 `file://${target}`。
    // 目录名里的 # ? % 会被当成 URL 的片段/查询/转义起点 ⟹ 路径被**静默截断**，
    // 变成 404 ⟹ 白屏，而白屏看起来像"这个壁纸不兼容"。
    // 实测：'a#b' / 'c?d' / 'e%f' 三种都会错；中文和空格恰好没事，
    // 所以拿中文路径测过也证明不了裸拼是安全的。
    return net.fetch(pathToFileURL(target).href);
  });
}

// ---------------------------------------------------------------------------
// 视频壁纸：音轨解码失败时，转一份"没有音轨"的缓存
// ---------------------------------------------------------------------------
// ⚠️⚠️⚠️ 用户 2026-08-02 两次报同一个错（第二次是在我"修好"之后）：
//     code 3: PIPELINE_ERROR_DECODE: Failed to send audio packet for decoding
//
// 挂掉的是**音轨**。而 `<video>` 上有 `muted` ⟹ **Chromium 即使静音也照样解码
// 音轨**（muted 只管"不输出到设备"）⟹ 视频轨完全能放的壁纸整个黑屏。
// 工坊里常见 AC-3 / E-AC-3 / DTS 音轨，Chromium 都不带解码器。
//
// ⚠️⚠️ **而 0.9.109 我在渲染进程里加的"关掉音轨再重试"是空转** ——
//   `video.audioTracks` 在 Chromium 里默认不存在（我自己的注释都写了
//   "大概率拿不到"），而用户的截图证明它真的没救回来。
//   ⟹ 教训：**明知"大概率不管用"的修复不该当成修复发出去**。
//     那一版让用户以为问题解决了，而它只是把同一个错又报了一遍。
//
// ⟹ 真正能修的地方在宿主侧：macOS **自带 AVFoundation**，
//   `AVAssetExportSession` + `passthrough` 只保留视频轨、**不重新编码**
//   （几百 MB 也就几秒）。不用 ffmpeg（那要往包里塞 40MB+）。
//
// ⚠️ **懒转换 + 缓存**：只在真撞到那个错时才转，不是每个视频壁纸都转一遍
//   （绝大多数是 AAC 音轨，Chromium 放得好好的）。
// ⚠️⚠️ **这个 Map 只被写、从来没人读**（0.9.136 查证：全文 grep 只有一处 `.set`，
//   零处 `.get`/`.has`）—— 真正的缓存判定是 `fs.existsSync(out)`，
//   而那比内存 Map 更对：进程重启后缓存文件还在，Map 却空了。
//   ⟹ 留着它没有害处（一个几十字节的 Map），但**别指望它** ——
//     以后要查"转过哪些"请看 `stripCacheDir()` 里的文件，不是这个 Map。
//   ⚠️ 判据：**"只写不读"的状态是一个陷阱** —— 下一个人会以为它是真相来源。
const stripCache = new Map();     // ⚠️ 只写不读，见上面那段。真相在磁盘上。
const stripping = new Set();      // 正在转的，防止重复触发

function stripCacheDir() {
  return path.join(app.getPath('userData'), 'video-cache');
}

// ⚠️ 缓存文件名带**源文件的 mtime+size** —— 用户换了同名文件要能失效。
//   ⚠️ 不用内容 hash：几百 MB 的文件算一遍 sha256 要好几秒，而 mtime+size
//     对"用户换了文件"这个场景够用了。
// ⚠️⚠️ **缓存键要带上模式**（0.9.136）。两种产物完全不同：
//   strip    = 原视频轨 + 去音轨（passthrough，画质无损）
//   reencode = 重编码的视频轨 + 去音轨（有损、慢）
//   ⟹ 键里不带模式的话它们会**撞在同一个文件上** ——
//     症状是"我明明要重编码，它却直接用了上次那个 strip 的结果"（而那个放不了）。
function stripCachePath(src, mode) {
  try {
    const st = fs.statSync(src);
    const key = crypto.createHash('sha256')
      .update(`${src}|${st.mtimeMs}|${st.size}|${mode || 'strip'}`).digest('hex').slice(0, 16);
    return path.join(stripCacheDir(), `${key}.mp4`);
  } catch {
    return null;
  }
}

// 渲染进程报"解码失败" → 这里转一份 → 转好通知它重载。
//
// ⚠️⚠️⚠️ **两种模式**（0.9.136）。用户 2026-08-02 对着 0.9.135 说"还是有问题" ——
//   而他说得对：那一版只是把提示改准了（说清是视频轨），**壁纸还是放不了**，
//   他仍然得自己去跑 ffmpeg。
//   ⟹ 判据：**报得准不等于修好了。** 我们有 AVFoundation，能自己转。
//
//   payload.mode = 'strip'    音轨挂了 ⟹ passthrough 去音轨（秒级、无损）
//   payload.mode = 'reencode' 视频轨挂了 ⟹ 重编码每一帧（分钟级、有损）
//                             那正是"某几帧硬解器不吃"的解法
// ⚠️ 而模式由**渲染进程按错误原文**判（见 video.js 的 decodeHint / audioFail）——
//   主进程不重复那套判断：错误原文只有渲染进程手里有。
ipcMain.on('we-video-audio-failed', (_event, payload) => {
  if (!weProject || !weProject.dir) return;
  const mode = (payload && payload.mode) === 'reencode' ? 'reencode' : 'strip';
  // ⚠️ 只认**当前壁纸目录里**的文件 —— 渲染进程传来的路径不能直接信。
  const rel = String((payload && payload.file) || weProject.file || '');
  const src = WE.resolveAsset(`/${rel}`, weProject.dir, weProject.file);
  if (!src || !fs.existsSync(src)) {
    console.warn(`[video] 解码修复：找不到源文件（${rel}）`);
    return;
  }
  const out = stripCachePath(src, mode);
  if (!out) return;

  // 已经转好了 ⟹ 直接让它用（这条走在"壁纸重载后又报一次"的情况下）
  if (fs.existsSync(out)) {
    broadcast('we-video-use-cache', { url: pathToFileURL(out).href });
    return;
  }
  // ⚠️ 去重的键要带模式 —— 否则"正在 strip"会挡掉"要 reencode"那次请求
  const busyKey = `${src}|${mode}`;
  if (stripping.has(busyKey)) return;
  stripping.add(busyKey);

  broadcast('helper-log', { source: 'we',
    message: mode === 'reencode'
      ? '视频轨有几帧 macOS 的硬件解码器放不了 —— 正在重新编码一份'
        + '（每一帧都要重写，几十秒到几分钟，取决于文件大小）'
      : '视频音轨 Chromium 放不了 —— 正在转一份没有音轨的（不重新编码，通常几秒）' });

  // ⚠️ helper 路径和别的一样：预编译的优先，没有就现场编译（见 prebuilt-helper.js）
  const binary = findPrebuilt('GestureWallStripAudio')
    || path.join(app.getPath('userData'), 'GestureWallStripAudio');
  if (!fs.existsSync(binary)) {
    stripping.delete(busyKey);
    broadcast('helper-log', { source: 'we',
      message: '去音轨的 helper 不在（打包时没编进来）—— 只能手动转：'
        + 'ffmpeg -i 原文件 -c:v copy -an 新文件.mp4' });
    return;
  }

  // ⚠️⚠️ **异步 spawn，不能 spawnSync** —— 几百 MB 的文件要几秒，
  //   同步会把主进程整个卡住（壁纸、面板、快捷键全冻）。
  const child = spawn(binary, [src, out, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => {
    console.warn('[video strip]', chunk.toString().trim().slice(0, 300));
  });
  child.on('exit', () => {
    stripping.delete(busyKey);
    // helper 输出一行 JSON
    let res = null;
    try { res = JSON.parse(stdout.trim().split('\n').pop() || '{}'); } catch { /* 下面兜 */ }
    if (res && res.ok && fs.existsSync(out)) {
      stripCache.set(busyKey, out);
      broadcast('helper-log', { source: 'we',
        message: `${mode === 'reencode' ? '重编码完成' : '音轨去掉了'}`
          + `（${Math.round((res.bytes || 0) / 1048576)}MB，`
          + `${res.ms || '?'}ms）—— 壁纸重新加载` });
      broadcast('we-video-use-cache', { url: pathToFileURL(out).href });
    } else {
      // ⚠️ 失败要说清 —— 静默失败的话用户看到的还是那个原始报错，
      //   而他不知道我们试过了。
      // ⚠️ 而**手动命令要跟模式对上** —— 给错方向的话用户白折腾一遍
      //   （这一整轮的教训就是这个）。
      broadcast('helper-log', { source: 'we',
        message: `${mode === 'reencode' ? '重编码' : '去音轨'}失败：`
          + `${(res && res.error) || 'helper 没给原因'} —— 只能手动转：`
          + (mode === 'reencode'
            ? 'ffmpeg -i 原文件 -c:v libx264 -pix_fmt yuv420p -an 新文件.mp4'
            : 'ffmpeg -i 原文件 -c:v copy -an 新文件.mp4') });
    }
  });
});

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

// 把系统原生壁纸设成我们壁纸的静态帧（占位）。
//
// ⚠️ 这解决的是用户实测的"来回切换桌面会有延迟，看到 mac 的原生壁纸"。
//
// 原因：我们的窗口在壁纸层**之上**，而切 Space 时窗口重新合成有一帧延迟 ——
// 那一帧露出下面的系统壁纸。这不是 bug，是图层顺序的必然结果。
//
// ⟹ Open Wallpaper Engine 的解法很聪明：**把系统壁纸设成我们内容的静态帧**。
// 那样下面那层和我们画的东西长得一样，露出来也看不出来。
//（它的 setPlacehoderWallpaper 就干这个，用视频第一帧。）
//
// Electron 没有 setDesktopImageURL 的等价 API，但 osascript 可以 ——
// 而且 System Events 设桌面图片**不需要任何权限**（标准 AppleScript 词典）。
//
// ⚠️ 必须先存下用户原来的壁纸，退出时还回去。不然我们改了他的系统设置不还原，
// 那是很讨人嫌的行为。
let originalWallpaper = null;

function readSystemWallpaper() {
  const result = spawnSync('/usr/bin/osascript', ['-e',
    'tell application "System Events" to get picture of current desktop'],
    { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) return null;
  const out = String(result.stdout || '').trim();
  return out || null;
}

// timeoutMs 可调：**退出时不该等 8 秒**。
//
// ⚠️ 那 8 秒是"点了退出没反应"的直接来源之一：osascript 走 System Events，
// 而它在系统忙的时候能慢到几秒。退出路径上宁可还原失败（下次启动会再设一次），
// 也不能让用户以为程序卡死了 —— 那会让他去强制退出，而强杀会留下 helper 进程。
function setSystemWallpaper(filePath, timeoutMs = 8000) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  // ⚠️ 路径里的引号要转义 —— 壁纸目录名是用户可控的，
  // 一个引号就能把 AppleScript 劈开（而那会静默失败）。
  const escaped = filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const result = spawnSync('/usr/bin/osascript', ['-e',
    `tell application "System Events" to set picture of every desktop to "${escaped}"`],
    { encoding: 'utf8', timeout: timeoutMs });
  if (result.status !== 0) {
    // 说出来而不是静默 —— 失败的后果是切桌面时仍然闪，
    // 而那看起来像"这个修复没用"。
    logEvent('wallpaper', `设置系统壁纸失败：${(result.stderr || '').trim().slice(0, 150)}`);
    return false;
  }
  return true;
}

// 用壁纸的预览图当占位。
//
// ⚠️ 用 preview 而不是"视频第一帧"：抽第一帧要 ffmpeg，而 preview.gif/jpg
// 工坊物品基本都有，而且它就是这个壁纸的代表画面 —— 正好合用。
function placeholderFromProject(dir, project) {
  const preview = previewPathOf(dir, project);
  if (!preview) return null;
  // ⚠️ GIF 不能直接当桌面图片（macOS 只取第一帧，而且有时候整个失败）。
  // 有 jpg/png 优先用，只有 gif 时也试一下 —— 失败会被 setSystemWallpaper 报出来。
  return preview;
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
  // ⚠️ 两个定时器都要清。漏掉低频那个的后果：换壁纸后它还在给**旧壁纸**发属性，
  // 而那个窗口已经销毁 ⟹ 报错刷屏，或者更糟 —— 它成功了，然后把旧壁纸的属性
  // 报成"已送到"，而面板显示的是新壁纸。
  if (wePropTimer) { clearInterval(wePropTimer); wePropTimer = null; }
  if (weSlowPropTimer) { clearInterval(weSlowPropTimer); weSlowPropTimer = null; }
  if (weWindow && !weWindow.isDestroyed()) weWindow.destroy();
  weWindow = null;
  weReady = false;
  wePropState = { state: '未开始', count: 0 };
}

function createWEWindow() {
  if (!weProject) return null;
  // ⚠️ WE 网页壁纸的交互主体是**鼠标**（这个样本 pointerdown ×9、onClick ×8，
  // "点一下掉流星"就是它的卖点）。而默认策略 desktop 是真壁纸层、**收不到鼠标事件** ——
  // 装上去会是"画面出来了但点它没反应"，和壁纸坏了分不清。
  //
  // 所以 WE 壁纸默认用能收鼠标的那个策略。代价是它会出现在 Mission Control 里，
  // 而那个代价比"交互整个不工作"小得多。用户仍可用 ⌃⇧L 切回去。
  const strategyId = config.we.strategy || 'desktop';
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
      preload: WE.isMediaType(weProject.type)
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

  // ⚠️ 必须在 loadFile/loadURL **之前**接 —— 装载期的错误(资源 404、preload 挂了)
  // 是这一层最常见的失败,接晚了正好错过。原版接在装载之后。
  watchRendererErrors(win, 'we');

  // ⚠️ web 和 video 的装载路径必须分开：video 的 project.file 是视频文件名不是 html，
  // 拿它去 loadURL 会让 Chromium 直接下载或黑屏（不报错）。
  if (WE.isMediaType(weProject.type)) {
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
// ⚠️ 30 秒而不是 8 秒。
//
// 实测的壁纸（884307090「完美壁纸」）要加载 jquery + sakura.js + 一个被 CORS 挡掉的
// 天气 XHR，而那个 XHR 失败前会等 —— 8 秒之内它很可能还没挂上
// `wallpaperPropertyListener`。
//
// ⚠️ 而超时之后**再也不试了**，那是硬缺陷：壁纸挂 listener 是它自己的时序，
// 我们凭什么假设它在 8 秒内完成？放弃得太早的代价是 137 项属性一项都没进去，
// 而症状是"画面缺一大块"（圆环/粒子/时间全靠属性驱动）。
//
// 30 秒 × 120ms 间隔 = 250 次尝试，每次是一个极轻的 executeJavaScript
//（只读一个全局对象），代价可以忽略。
const WE_PROP_TIMEOUT_MS = 30000;
let wePropTimer = null;
let weSlowPropTimer = null;   // 超时后的低频重试（见下）
// 属性发送的结果。⚠️ 必须记下来给面板看：
//
// 实测烧的一轮 —— 用户报「圆环没有、也没交互」，而面板只说"页面加载了但没报 ready"。
// 而真正该问的是「那 100+ 个属性进去了吗」：这个壁纸的圆环、粒子、时间显示全部
// 由属性驱动（`showCircle` / `visual_audio_model` / `particles_isParticles`…），
// 属性没进去它就什么都不画。
//
// 而原来 `no-listener` 是**静默**的（只有非 no-listener 才 console.warn）⟹
// "壁纸没挂 wallpaperPropertyListener" 和 "一切正常" 长得一模一样。
let wePropState = { state: '未开始', count: 0 };

function sendWEProperties() {
  if (!weWindow || weWindow.isDestroyed() || !weProject) return;
  const props = WE.userProperties(weProject.properties, config.we.overrides);
  const general = WE.generalProperties(config.we.fps);
  const startedAt = Date.now();

  if (wePropTimer) { clearInterval(wePropTimer); wePropTimer = null; }
  if (weSlowPropTimer) { clearInterval(weSlowPropTimer); weSlowPropTimer = null; }

  const total = Object.keys(props).length;
  wePropState = { state: '发送中', count: total };

  const attempt = async () => {
    const result = await applyWEProperties(props, general);
    if (result.applied) {
      if (wePropTimer) { clearInterval(wePropTimer); wePropTimer = null; }
      wePropState = {
        state: '已送到', count: total,
        user: !!result.user, general: !!result.general,
      };
      console.log(`[we] ${total} 项属性已送到壁纸`
        + `（user=${result.user} general=${result.general}）`);
      // ⚠️ 必须**推**给面板。属性发送是装载**之后**才完成的，而 broadcast('we-status')
      // 原来只在装载/失败时发 ⟹ 面板永远停在装载那一刻的快照。
      //
      // 实测：用户看到「⏳ 正在发 137 项属性…」一直不变，而真实状态早就变了 ——
      // 那是个**过期显示**，比没有显示更糟：它让人以为卡在发送中。
      broadcast('we-status', weStatus(null));
      return;
    }
    if (Date.now() - startedAt > WE_PROP_TIMEOUT_MS) {
      if (wePropTimer) { clearInterval(wePropTimer); wePropTimer = null; }
      // ⚠️ 高频重试停了，但**不彻底放弃** —— 换成每 5 秒试一次。
      //
      // 理由：壁纸挂 listener 是它自己的时序，可能被一个慢 XHR 或大 bundle 拖到
      // 半分钟以后。彻底放弃的代价是 137 项属性一项都没进去、画面永久缺一块，
      // 而一次尝试只是读一个全局对象 —— 那个代价不对等。
      if (!weSlowPropTimer) {
        weSlowPropTimer = setInterval(async () => {
          if (!weWindow || weWindow.isDestroyed() || !weProject) {
            clearInterval(weSlowPropTimer); weSlowPropTimer = null; return;
          }
          const late = await applyWEProperties(props, general);
          if (late.applied) {
            clearInterval(weSlowPropTimer); weSlowPropTimer = null;
            wePropState = { state: '已送到', count: total, late: true };
            console.log(`[we] ${total} 项属性终于送到了（超过 `
              + `${WE_PROP_TIMEOUT_MS / 1000} 秒才挂上 listener）`);
            broadcast('we-status', weStatus(null));
          }
        }, 5000);
      }
      // ⚠️ `no-listener` 以前是**静默**的，理由是"这个壁纸没有可配置项（正常）"。
      // 那个理由错了：**有 100+ 项属性却没有 listener，才是最该报的情形** ——
      // 它意味着壁纸的脚本没跑到挂 listener 那一步，而症状是"画面缺一大块"
      // （圆环/粒子/时间全靠属性驱动），看起来像那些功能不支持。
      wePropState = { state: '发不进去', count: total, reason: result.reason };
      // 同上：状态变了就推，否则面板停在"正在发"。
      if (result.reason === 'no-listener') {
        if (total > 0) {
          console.warn(`[we] 壁纸有 ${total} 项属性，但它没有挂 `
            + 'wallpaperPropertyListener ⟹ 一项都没送进去。'
            + '常见原因：它的脚本在挂 listener 之前就抛了（⌃⇧D 看 Console）');
        } else {
          wePropState = { state: '这个壁纸没有可配置项', count: 0 };
        }
      } else {
        console.warn('[we] 属性发不进去:', result.reason);
      }
      broadcast('we-status', weStatus(null));
    }
  };

  attempt();
  wePropTimer = setInterval(attempt, WE_PROP_RETRY_MS);
}

function weStatus(error) {
  return {
    // ⚠️⚠️ build 标识跟着状态一起送。**0.9.121 起面板不再把它显示出来**
    //（用户点名删掉：他自己编译打包，终端里就有版本号）——
    //   但这个字段**不能删**：面板那边靠 `status.build.includes('打包版')`
    //   判断"是不是打包版"，而鼠标诊断那段说哪句话取决于它
    //   （见 dashboard.js 的 renderBuildStamp / isPackagedBuild）。
    // ⚠️ 而"我跑的是哪个版本"这件事本身仍然重要（测了旧版本会得出
    //   "改了没生效"的结论，然后去查一个已经修好的问题）——
    //   现在它的出口是终端启动横幅 + 诊断报告的 `app.build`。
    build: buildStamp(),
    // 菜单栏覆盖的核对结果 —— 那条缝和壁纸装载是两件事，但用户看到的是同一块屏幕。
    menuBar: menuBarState,
    dir: weProject ? weProject.dir : null,
    title: weProject ? weProject.title : null,
    wantsAudio: weProject ? weProject.wantsAudio : false,
    // ⚠️ ready 是"壁纸里的 JS 真的跑起来了"，不是"窗口开了"。这两件事分开报,
    // 因为白屏时它们的值不同 —— 这是唯一能区分"没加载"和"加载了但没渲染"的观测点。
    ready: weReady,
    // 属性发送状态。⚠️ 这是"圆环/粒子为什么不出现"的第一观测点 ——
    // 它们全部由属性驱动，属性没进去壁纸就什么都不画。
    props: wePropState,
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
    syncMouseForward();
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
  wePropState = { state: '未开始', count: 0 };
  // 两种壁纸源互斥：都钉在桌面层会互相遮挡，而"我看到的是哪个"就没法判断了。
  if (wallWindow && !wallWindow.isDestroyed()) wallWindow.destroy();
  wallWindow = null;
  destroyWEWindow();
  weWindow = createWEWindow();
  syncAudioSource();
  syncMouseForward();

  // 把系统壁纸换成这个壁纸的静态帧，消掉切桌面时那一帧的闪烁。
  // ⚠️ 先记住原来的，退出时还回去。
  if (originalWallpaper === null) originalWallpaper = readSystemWallpaper();
  const placeholder = placeholderFromProject(weProject.dir, weProject);
  if (placeholder && config.we.placeholderWallpaper !== false) {
    const ok = setSystemWallpaper(placeholder);
    logEvent('wallpaper', ok
      ? `系统壁纸已设为占位图（消掉切桌面那一帧的闪烁）：${path.basename(placeholder)}`
      : '系统壁纸占位图没设上 —— 切桌面时可能会闪一下原生壁纸');
  }
  return { ok: true, project: { title: weProject.title, dir: weProject.dir } };
}

// 壁纸自己调 wallpaperReady 了 —— 这是"里面的 JS 活着"的唯一证据。
// ⚠️⚠️⚠️ **`we-ready` 一直是个死信号**（0.9.114 修）。
//
// `we-preload.js:86` 在壁纸调 `wallpaperReady()` 时 `send('we-ready')`，
// 而**主进程从来没接过它** ⟹ `weReady` 永远是 false
// ⟹ 面板上那个"壁纸就绪"状态一直显示错的（`weStatus().ready`）。
// 而 createWEWindow 里那句注释还写着"见 ipcMain.on('we-ready')" —— **那个 handler
// 压根不存在**。注释指向一个不存在的东西，比没注释更误导。
//
// ⚠️⚠️ 而它同时是**补发媒体数据的最佳时机**：
//   媒体是轮询来的（1.5 秒一次），而壁纸是随时装载的
//   ⟹ 装载那一刻 `window.__mediaState` 还不存在
//   ⟹ 壁纸初始化读到的是它自己的兜底值（全空、position 0）。
//   那个粒子壁纸恰好订阅了 `_callbacks` 所以会被纠正，但**一个只读一次
//   不订阅的壁纸会永远是空的** —— 而那完全合法（契约里
//   `window.__mediaState || {…}` 那个兜底就说明作者预期"可能没有这个对象"）。
ipcMain.on('we-ready', () => {
  weReady = true;
  broadcast('we-status', weStatus(null));
  // ⚠️ 立刻把最近一次的歌曲信息补给它 —— 不等下一轮轮询。
  //   ⚠️ `lastTrack` 可能是 null（没在放歌）—— 那也要发：
  //     发一个全空的 __mediaState 比让对象不存在好，
  //     因为壁纸能区分"有对象但没在放歌"和"宿主不支持这个接口"。
  sendWEMedia(lastTrack);
});

ipcMain.on('we-mouse-seen', (_event, payload) => {
  pageMouseSeen = { ...payload, at: Date.now() };
});

// ⚠️⚠️ 这里原来有 `we-pick`（「装载别处的目录…」）—— **整条链删了**（0.9.37）。
//
// 用户 2026-08-01：「这两个不需要，我们已经有换目录的按钮了，这是冗余的操作」
//
// ⚠️ 而它**确实冗余，还更差**：那条路装载的壁纸**不在网格里**
// ⟹ 用户看不到它、也没法切回来。而「换目录…」换完之后，
//    新目录里的壁纸会出现在网格里 —— 那才符合「我的壁纸」这个模型。
//
// ⟹ 删的是**整条链**（HTML 按钮 + dashboard 绑定 + preload + 这个 IPC）。
// 只删按钮的话 preload 和 IPC 就是死代码，而死代码会让下一个人以为
// "这个功能还在，只是入口丢了"，然后把入口加回来。

// **删掉一个壁纸**（移到废纸篓，不是永久删除）。
//
// ⚠️⚠️ 用户 2026-08-01：
//   「然后应该是卸载，就是这个壁纸的文件直接删除，而不是什么应用这个壁纸，
//     应用之后再来个什么退回内置壁纸，我们的产品关闭了不就壁纸退出运行了，
//     这个逻辑没必要」
//
// **他说得对** —— 关掉应用壁纸就没了，「退回内置壁纸」是个没有价值的中间态。
// 而右键菜单里真正需要的是「删掉这个壁纸」（那是文件管理，不是运行状态管理）。
//
// ⚠️⚠️⚠️ **用 `shell.trashItem` 而不是 `fs.rmSync`。**
//
// 这是**删用户的文件**，而废纸篓和永久删除的差别是"能不能反悔"：
//   · 用户可能点错（右键菜单里「删除」挨着「在 Finder 中打开」）
//   · 壁纸可能是他花钱订阅的、或者改过属性的
//   · 而我们没有"撤销"
// ⟹ `trashItem` 让系统的撤销机制接管。**永久删除在这里是不可接受的风险。**
//
// ⚠️ 而这个项目有一条既有的纪律：**破坏性操作要用户明示**。
// ⟹ 所以确认对话框在渲染进程那边（面板），而这里只负责执行 ——
//    但这里也**再挡一道**：路径必须在我们的壁纸目录树下。
//    那样"传错路径"不会变成"删掉用户的文档"。
// ─────────────────────────────────────────────────────────────────────────
// 轮播（0.9.43）
// ─────────────────────────────────────────────────────────────────────────
//
// 用户 2026-08-01：「壁纸应该设置一个播放列表，然后可以设置时间如轮播，
// 可以选择顺序/随机等」
//
// 两个设计决定（用户拍的）：
//   · 列表是**手选**的（不是"目录里全部"）
//   · 轮播开着时**手动点一个壁纸不打断轮播**，只是从它重新计时
//     ⟹ 那样行为可预测，不会"点了一下轮播就停了"
let rotateTimer = null;
// ⚠️ 随机模式下记住**上一个**，避免连续两次抽到同一个
//（列表只有 2 个时那会变成"根本不换"）。
let rotateLast = null;

// 列表里当前有效的那些（壁纸可能被删了/目录改了）。
//
// ⚠️ **每次都重新过滤，不缓存** —— 用户可能刚删掉列表里的一个，
// 而缓存会让轮播切到一个不存在的路径 ⟹ 症状是"轮播卡住"（切换失败）。
function rotateValid() {
  const list = (config.we.rotate && config.we.rotate.list) || [];
  return list.filter((d) => {
    try {
      return fs.existsSync(path.join(d, 'project.json'));
    } catch (e) {
      return false;
    }
  });
}

// 下一个该放哪个。
function rotateNext() {
  const valid = rotateValid();
  if (!valid.length) return null;
  if (valid.length === 1) return valid[0];

  const mode = (config.we.rotate && config.we.rotate.mode) || 'order';
  const cur = weProject ? path.resolve(weProject.dir) : null;

  if (mode === 'random') {
    // ⚠️ 排除当前和上一个 —— 否则用户会看到"随机了半天还是那张"
    // （列表 3 个时连续撞的概率是 1/3，感知上很明显）。
    const pool = valid.filter((d) => path.resolve(d) !== cur
      && path.resolve(d) !== rotateLast);
    const from = pool.length ? pool : valid.filter((d) => path.resolve(d) !== cur);
    const pick = (from.length ? from : valid)[Math.floor(Math.random() * (from.length ? from.length : valid.length))];
    return pick;
  }

  // 顺序：找当前的位置，取下一个（绕回）
  // ⚠️ 当前那个**可能不在列表里**（用户手动点了列表外的）⟹ 那时从头开始。
  const idx = valid.findIndex((d) => path.resolve(d) === cur);
  return valid[(idx + 1) % valid.length];
}

// 切到下一个。⚠️ 切换失败**不能让轮播停** —— 一个坏壁纸不该卡住整条链。
function rotateStep() {
  const next = rotateNext();
  if (!next) {
    logEvent('wallpaper', '轮播：列表里没有可用的壁纸 —— 停了');
    stopRotate();
    broadcast('config', config);
    return;
  }
  const out = setWEWallpaper(next);
  if (out.ok) {
    rotateLast = weProject ? path.resolve(weProject.dir) : null;
    config.we.dir = next;
    writeConfig(config);
    broadcast('config', config);
    logEvent('wallpaper', `轮播切到：${path.basename(next)}`);
  } else {
    // ⚠️ 报出来但继续 —— 否则用户看到"轮播不动了"而不知道是哪个壁纸坏了
    logEvent('wallpaper', `轮播切换失败（跳过）：${next}`, { error: out.error });
  }
  broadcast('we-status-changed', { rotated: true });
}

function stopRotate() {
  if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
  if (config.we.rotate) config.we.rotate.on = false;
}

// 按配置起停轮播。⚠️ 改任何一项（开关/间隔/列表）都要调它。
function syncRotate() {
  const r = config.we.rotate || {};
  if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
  if (!r.on) return;
  // ⚠️ 列表少于 2 个时不起定时器 —— 一个壁纸"轮播"没有意义，
  // 而起了定时器会每隔 N 分钟重载同一个壁纸（画面白闪一下）。
  if (rotateValid().length < 2) {
    logEvent('wallpaper', '轮播：列表里不足 2 个可用壁纸 —— 不启动');
    return;
  }
  const ms = Math.max(1, Number(r.minutes) || 30) * 60 * 1000;
  rotateTimer = setInterval(rotateStep, ms);
  logEvent('wallpaper', `轮播已启动：每 ${r.minutes} 分钟，${r.mode === 'random' ? '随机' : '顺序'}`);
}

ipcMain.handle('we-set-rotate', (_event, patch) => {
  const r = config.we.rotate || {};
  if (patch && typeof patch === 'object') {
    if (typeof patch.on === 'boolean') r.on = patch.on;
    if (typeof patch.minutes === 'number' && patch.minutes >= 1) {
      r.minutes = Math.round(patch.minutes);
    }
    if (patch.mode === 'order' || patch.mode === 'random') r.mode = patch.mode;
    if (Array.isArray(patch.list)) {
      // ⚠️ 去重 + 只留真实存在的 —— 列表是用户手点出来的，
      // 而"加了一个然后把它删了"会留下死路径。
      r.list = [...new Set(patch.list.filter((d) => typeof d === 'string' && d))];
    }
  }
  config.we.rotate = r;
  writeConfig(config);
  broadcast('config', config);
  syncRotate();
  return { ok: true, rotate: r, valid: rotateValid().length };
});

// 立刻切下一个（面板上的「下一个」按钮）。
//
// ⚠️ 它**不改开关状态** —— 用户点它只是想现在换一张，
// 而"点了一下就把轮播关了/开了"是意外行为。
ipcMain.handle('we-rotate-next', () => {
  rotateStep();
  return { ok: true, dir: weProject ? weProject.dir : null };
});

ipcMain.handle('we-delete-wallpaper', async (_event, dir) => {
  if (!dir || typeof dir !== 'string') return { ok: false, error: '没给路径' };

  // ⚠️⚠️ **只允许删我们目录树下的东西。**
  //
  // 为什么必须挡：这个 IPC 收到什么就删什么，而渲染进程的一个 bug
  // （比如 `item.dir` 是 undefined 拼出了 `/`）就会变成灾难。
  // ⟹ 白名单：我们的壁纸目录 + Steam 的下载目录（工坊原件）。
  //
  // ⚠️ 用 `path.resolve` + 前缀比较，而且前缀要带分隔符 ——
  // 否则 `/Users/x/Wallpapers-evil` 会被 `/Users/x/Wallpapers` 前缀命中。
  const resolved = path.resolve(dir);
  const roots = [
    ourWallpaperDir(),
    ...Workshop.STEAM_ROOTS.map((r) =>
      path.join(r, 'steamapps', 'workshop', 'content', Workshop.WE_APP_ID)),
    ...(config.we.libraryDirs || []),
  ].map((r) => path.resolve(r));
  const inside = roots.some((r) => resolved === r || resolved.startsWith(r + path.sep));
  if (!inside) {
    logEvent('wallpaper', `拒绝删除（不在壁纸目录树下）：${resolved}`, { roots });
    return {
      ok: false,
      error: '这个路径不在壁纸目录里，不删 —— 那是防手滑的护栏',
      dir: resolved,
    };
  }
  // ⚠️ 再挡一道：不能删**根目录本身**（那会把整个壁纸库扔进废纸篓）
  if (roots.includes(resolved)) {
    return { ok: false, error: '这是壁纸目录本身，不是某个壁纸 —— 不删' };
  }

  // ⚠️ **正在用的话先卸载** —— 否则删完文件而窗口还在渲染它，
  // 那时的画面是"文件不在了但还在显示"（资源已经载入内存），
  // 而用户重启应用后才发现壁纸没了 ⟹ 症状和时机脱节，很难查。
  const wasActive = !!(weProject && path.resolve(weProject.dir) === resolved);
  if (wasActive) {
    setWEWallpaper(null);
    config.we.dir = null;
    writeConfig(config);
    broadcast('config', config);
  }

  try {
    await shell.trashItem(resolved);
  } catch (err) {
    // ⚠️ 失败要**说清原因** —— 权限/文件被占用/已经不在了，三种的下一步不同。
    // 而如果上面已经卸载了，要告诉用户"壁纸卸了但文件还在"（那是个中间态）。
    const msg = String(err && err.message ? err.message : err);
    logEvent('wallpaper', `删除失败：${resolved}`, { error: msg, wasActive });
    return {
      ok: false,
      error: `没能移到废纸篓：${msg}`
        + (wasActive ? '（壁纸已经卸载了，但文件还在）' : ''),
      dir: resolved,
    };
  }
  logEvent('wallpaper', `已移到废纸篓：${resolved}`, { wasActive });
  return { ok: true, dir: resolved, wasActive };
});

// 卸载当前壁纸（回到内置的）。
//
// ⚠️ **这个不再是 UI 功能**（0.9.42）—— 用户 2026-08-01 指出
// 「我们的产品关闭了不就壁纸退出运行了，这个逻辑没必要」。
// ⟹ 右键菜单里的「卸载」换成了「删除」（`we-delete-wallpaper`）。
//
// 而这条 IPC **保留**，因为删除时要先卸载（否则删完文件窗口还在渲染它）。
// preload 里也保留 —— 删掉的话删除那条路就得内联一份卸载逻辑。
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
// 最后一次 FFT 自检的结果。⚠️ 面板打开时补发 —— 自检只在 helper 启动时跑一次。
ipcMain.handle('we-selftest', () => ({ ok: !!lastSelfTest, test: lastSelfTest }));

ipcMain.handle('we-controls', () => {
  if (!weProject) return { ok: false, controls: [] };
  const controls = WE.controlsOf(weProject.properties);
  // ⚠️ condition 在**这里**求值，不在面板里。
  //
  // 理由：`evalCondition` 在 we-host.js 里，而面板加载不了那个模块 ——
  // 在面板里重写一份求值就是第二份知识，那个形状我在本项目栽过两次
  //（音源列表、支持类型列表）。
  //
  // ⚠️ 而这一步**决定了用户能不能找到属性**：真实样本（884307090）有 165 个控件，
  // 其中 PWCircle 和 PWLine 各有一套**同名**的（音频样式/音频方向/可视化音频…），
  // 靠 `visual_audio_model.value == 1|2` 二选一。
  // 不过滤 ⟹ 13 组重名 ⟹ 用户报「没有看到你说的这些属性」——
  // 属性在，但埋在一堆同名项里。过滤后 165 → 67，重名降到 1 组。
  const values = {};
  for (const c of controls) {
    values[c.key] = c.key in config.we.overrides ? config.we.overrides[c.key] : c.value;
  }
  return {
    ok: true,
    title: weProject.title,
    controls: controls.map((c) => ({
      ...c,
      visible: WE.evalCondition(c.condition, values),
    })),
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

  // ⚠️⚠️ **下载前清 steamcmd 的账本** —— 因为我们把下载内容移走了。
  //
  // 不清的话 steamcmd 会说"已是最新"然后什么都不做，而它的退出码是 0、
  // 日志里有 Success ⟹ **静默失败**：用户看到"下载成功"但目录里没新东西。
  // ⟹ 见 clearWorkshopManifest() 上面那段。
  const clearedAcf = clearWorkshopManifest();
  if (clearedAcf.length) {
    logEvent('workshop', `已清 steamcmd 下载记录（我们把内容移走了，不清会被跳过）`,
      { cleared: clearedAcf });
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
      // ⚠️ 不从 steamcmd 的路径推数据目录 —— 那条我错过一次：brew 的
      // /opt/homebrew/bin/steamcmd 只是包装脚本（真二进制在 Caskroom/…/MacOS/），
      // 而数据实际落在 ~/Library/Application Support/Steam（steamcmd 自己的启动
      // 输出里写着）。所以逐个候选去找，找到哪个算哪个。
      let dir = Workshop.findDownloaded(workshopId, (p) => fs.existsSync(p));

      // ⚠️ legacy 工坊物品：Steam 对老的单文件上传**不解包**，原样存成
      // <工坊ID>/<数字>_legacy.bin。实测（用户的 3339949060）：
      //   Success. Downloaded item ... to ".../3339949060/…_legacy.bin" (966026 bytes)
      // 也就是下载真的成功了，只是形状不是我们期待的 project.json + 资产。
      //
      // 原来的判据（目录里有 project.json）会把它判成失败 ⟹ 报"下载完了但找不到文件"，
      // 而那会让人去查网络和账号，方向完全错。
      if (!dir) {
        const rawDir = Workshop.findDownloadedDir(workshopId, (p) => fs.existsSync(p));
        if (rawDir) {
          const legacy = Workshop.findLegacyBin(rawDir, (d) => fs.readdirSync(d));
          if (legacy) {
            const unpacked = unpackLegacy(legacy, rawDir);
            logEvent('workshop', `legacy 物品：${unpacked.label}`, { legacy, ok: unpacked.ok });
            if (unpacked.ok) {
              dir = rawDir;
              // 成功但有警告（比如拿到的是缩略图）也要说出来 ——
              // 否则用户看到糊的画面会以为是我们渲染差。
              if (unpacked.warning) {
                logEvent('workshop', unpacked.warning);
                broadcast('workshop-progress', { kind: 'warning', text: unpacked.warning });
              }
            } else {
              resolve({
                ok: false,
                error: unpacked.error,
                legacy: { file: legacy, ...unpacked },
                hint: unpacked.hint,
              });
              return;
            }
          }
        }
      }

      if (dir) {
        logEvent('workshop', `下载成功：${dir}`);
        // ⚠️ **搬进统一的壁纸目录**（用户要求：工坊下载和默认加载都在
        // Documents/GestureWall/Wallpapers）。见 importToOurDir 上面那段。
        //
        // ⚠️ 搬之前先读标题 —— 目录名要带它，否则用户在 Finder 里认不出
        // 一堆纯数字目录是什么。读失败就只用 ID（不阻断）。
        let title = '';
        try {
          const pj = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
          title = pj && typeof pj.title === 'string' ? pj.title : '';
        } catch (e) { title = ''; }
        const moved = importToOurDir(dir, workshopId, title);
        if (moved.ok) {
          logEvent('workshop', `已放入我的壁纸：${moved.dir}`);
          broadcast('workshop-progress', {
            kind: 'info',
            text: `已放入我的壁纸目录：${path.basename(moved.dir)}`,
          });
          dir = moved.dir;
        } else {
          // ⚠️ 降级要说出来 —— 否则"为什么我的壁纸里没有"变成鬼故事。
          logEvent('workshop', `放入我的壁纸失败（仍从 Steam 目录装载）：${moved.error}`);
          broadcast('workshop-progress', {
            kind: 'warning',
            text: `没能复制到我的壁纸目录（${moved.error}）——`
              + '壁纸仍然能用，但「我的壁纸」列表里看不到它',
          });
        }
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
      const searched = Workshop.searchedPaths(workshopId);
      logEvent('workshop', `失败：${reason}`, { searched });
      resolve({
        ok: false,
        error: reason,
        // ⚠️ 把找过的**所有**路径报出来。这条链最可能的失败就是路径不对，
        // 而不给路径的话用户和我都不知道往哪查。
        searched,
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

// 取工坊物品详情（预览图、标题、类型）。
//
// ⚠️ 这条**不需要登录也不需要 API key** —— 用的是 GetPublishedFileDetails。
// 所以"贴个链接先看预览图再决定装不装"是零门槛的，而那正是工坊该有的体验：
// 只给一个填 ID 的输入框等于把命令行搬进 GUI。
ipcMain.handle('workshop-details', async (_event, input) => {
  // 一次可以查多个：用户可能粘一串 ID，或者我们将来做"已订阅列表"。
  const ids = (Array.isArray(input) ? input : [input])
    .map((x) => Workshop.parseWorkshopId(x))
    .filter(Boolean);
  if (!ids.length) {
    return { ok: false, error: '认不出工坊 ID —— 贴数字 ID 或创意工坊页面链接都行' };
  }

  try {
    const response = await net.fetch(Workshop.DETAILS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: Workshop.detailsBody(ids),
    });
    if (!response.ok) {
      logEvent('workshop', `详情请求失败 HTTP ${response.status}`);
      return { ok: false, error: `Steam 接口返回 ${response.status}` };
    }
    // ⚠️ 支持性判断在这里加上，来源是 we-host 的 TYPES（唯一来源）。
    // workshop.js 故意不判 —— 它曾经自己维护一份列表然后漂了。
    const items = Workshop.parseDetailsResponse(await response.json()).map((item) => ({
      ...item,
      supported: item.type ? WE.isSupportedType(item.type) : false,
      refusal: item.type ? WE.typeRefusal(item.type) : null,
    }));
    logEvent('workshop', `取到 ${items.length} 个物品的详情`);
    return { ok: true, items };
  } catch (error) {
    // ⚠️ 网络失败要和"物品不存在"分开说。国内访问 api.steampowered.com 经常需要代理，
    // 而"连不上"和"这个壁纸没了"是完全不同的两件事。
    logEvent('workshop', `详情请求异常：${error.message}`);
    return {
      ok: false,
      error: `连不上 Steam 接口：${error.message}`,
      hint: '这个接口在国内常常要代理。壁纸下载走 steamcmd 是另一条路，可能不受影响。',
    };
  }
});

// 已下载的壁纸列表 —— 本地扫一遍，不需要网络。
//
// ⚠️ 这条补的是另一半体验缺口：下载过的东西要能重新装载，
// 而不是每次都重新填 ID。工坊页面的"已订阅"在本地的对应物就是这个。
// 浏览工坊（仿 Steam 那套：搜索 + 排序 + 类型筛选 + 分页）。
//
// ⚠️ 这条要 Steam Web API key（免费）。和"贴 ID 看详情"那条不同 ——
// 那条免 key。所以没配 key 时要说清怎么弄，不能只报"失败"。
ipcMain.handle('workshop-browse', async (_event, opts) => {
  const key = (config.we.steam && config.we.steam.apiKey) || '';
  if (!key) {
    return { ok: false, needsKey: true, error: Workshop.apiKeyHint() };
  }

  const params = Workshop.browseParams({ key, ...(opts || {}) });
  try {
    const response = await net.fetch(
      `${Workshop.QUERY_ENDPOINT}?${params.toString()}`);
    if (!response.ok) {
      // ⚠️ 403 几乎一定是 key 不对，而那和"网络问题"该给不同建议。
      if (response.status === 403 || response.status === 401) {
        return {
          ok: false, needsKey: true,
          error: `API key 被拒（HTTP ${response.status}）—— key 填错了或者失效了`,
        };
      }
      logEvent('workshop', `浏览请求失败 HTTP ${response.status}`);
      return { ok: false, error: `Steam 接口返回 ${response.status}` };
    }
    const { items, total } = Workshop.parseBrowseResponse(await response.json());
    // 支持性判断只有 we-host 一个来源（workshop.js 故意不判，那条漂过一次）。
    const enriched = items.map((item) => ({
      ...item,
      supported: item.type ? WE.isSupportedType(item.type) : false,
      refusal: item.type ? WE.typeRefusal(item.type) : null,
    }));
    logEvent('workshop', `浏览到 ${enriched.length} 项（共 ${total}）`);
    return { ok: true, items: enriched, total };
  } catch (error) {
    logEvent('workshop', `浏览请求异常：${error.message}`);
    return {
      ok: false,
      error: `连不上 Steam 接口：${error.message}`,
      hint: '这个接口在国内常常要代理。而"贴 ID 装载"走的是另一条路，可能不受影响。',
    };
  }
});

ipcMain.handle('workshop-set-key', (_event, apiKey) => {
  config.we.steam = { ...(config.we.steam || {}), apiKey: apiKey || null };
  writeConfig(config);
  return { ok: true, hasKey: !!apiKey };
});

ipcMain.handle('workshop-browse-meta', () => ({
  sorts: Workshop.SORT_ORDERS,
  // 四组筛选（类型/年龄分级/分辨率/主题）—— 面板照这个渲染，
  // 加一组不用改 UI 代码。
  filterGroups: Workshop.FILTER_GROUPS,
  defaultTags: Workshop.defaultTags(),
  typeTags: Workshop.TYPE_TAGS_QUERY,
  hasKey: !!(config.we.steam && config.we.steam.apiKey),
  keyHint: Workshop.apiKeyHint(),
  // ⚠️⚠️⚠️ **把已存的值送回面板**（0.9.120）。用户 2026-08-02：
  //   「这个能不能缓存一下啊，我每次打开软件都要填一遍」
  //
  // ⚠️ 而它**本来就存着**（`workshop-set-key` 那条一直在 writeConfig）——
  //   问题是面板只拿到 `hasKey`（一个布尔），**从来没拿到值本身**
  //   ⟹ 输入框每次打开都是空的 ⟹ 看起来像"没保存"。
  //   ⟹ 这不是"加缓存"，是**把已经存下来的东西显示出来**。
  //     判据：**能保存的字段就要能回填**，否则用户没法确认它到底存了没有。
  //
  // ⚠️⚠️ 这三个都是凭证，而它们**只在本机的 config.json 里**、只发给我们自己的
  //   面板窗口（contextIsolation + 我们自己的 preload）。而**诊断报告里是打码的**
  //   （`redactConfig` 把 password/guardCode/apiKey 都换成 `***`）——
  //   那条必须保持，因为报告是要发给别人看的。
  steam: {
    apiKey: (config.we.steam && config.we.steam.apiKey) || '',
    username: (config.we.steam && config.we.steam.username) || '',
    // ⚠️ 密码也回填 —— 不回填的话用户每次下载都要重输，而它已经存在磁盘上了
    //   （不回填并不会更安全，只是让人以为没存）。
    password: (config.we.steam && config.we.steam.password) || '',
    // ⚠️ Guard 码**不回填** —— 它是一次性的、几十秒就过期，
    //   回填一个过期的码只会让登录失败得莫名其妙。
  },
}));

// 「我的壁纸」：扫所有存储目录，不管壁纸是怎么来的。
//
// ⚠️ 判据是**目录里有 project.json**，不是"我们下载过"。用户的原话：
// "不知道从哪里得到的壁纸，反正只要在指定的壁纸存储目录中有的壁纸就在这里"
// ⟹ 手动拷进去的、朋友发的、从别的机器搬来的，全都能用。
// 我们自己的壁纸目录 —— **标准壁纸软件的层级**。
//
// ⚠️ 用户要的（2026-07-31）：「你的默认壁纸目录改成标准的壁纸软件的目录层级」。
//
// 为什么不用 userData（`~/Library/Application Support/GestureWall`）：
// 那是**应用私有数据**的位置，Finder 里默认隐藏、用户找不到、也不该往里拖文件。
// 而壁纸是**用户的内容** —— 他要能打开、能拖进去、能备份、能从别的机器搬过来。
//
// ⟹ `~/Documents/GestureWall/Wallpapers/` ——
// Wallpaper Engine 自己也是把壁纸放在可见目录（Steam workshop content 下）。
// 每个子目录一个壁纸，里面有 project.json，和工坊的布局完全一致。
// 我们的壁纸目录 —— **唯一的路径来源，而且用户可以改**。
//
// ⚠️⚠️ 用户 2026-08-01 定的模型：
//   「反正只有一个路径来源，只是我允许你更改」
//
// 原来是两个模型并存：一个固定的主目录（`Documents/GestureWall/Wallpapers`）
// + 一个可加的 `libraryDirs` 列表。而那让面板上出现三种东西
//（主目录、Steam 目录、自定义目录列表）⟹ 用户要问"我的壁纸到底在哪"。
//
// ⟹ 收成一个：默认还是 `Documents/GestureWall/Wallpapers`（跟着用户名自适应），
//    但可以改成任何目录，改完列表就从那里扫。
//
// ⚠️ 默认值**不写进 config** —— 那样换用户/换机器时它自己跟着 `app.getPath`
// 走（`config.we.wallpaperDir` 为空时才用默认）。写死的话配置一旦生成
// 就绑在某个用户名上，而这个项目已经因为"路径从自己环境取"栽过几次。
// ⚠️⚠️ **目录名 0.9.131 从 GestureWall 改成 DreamPaper**。用户 2026-08-02：
//   「壁纸路径也是 gesture 替换成 DreamPaper，之前的不用管，我自己迁移」
//
// ⚠️ 所以这里**不做自动迁移** —— 用户明确说他自己搬。
//   ⟹ 而那意味着他升级之后打开面板会看到**壁纸列表是空的**（新目录还不存在，
//     我们会建一个空的 + 放那个说明文件）。那是预期，不是 bug。
//   ⚠️ 而**已经装载着的那张壁纸不受影响**：`config.we.dir` 存的是绝对路径，
//     指向旧目录里那个子目录 ⟹ 它照样能放。判据：改默认目录只影响"扫哪儿"，
//     不影响"当前在放什么"。
function defaultWallpaperDir() {
  return path.join(app.getPath('documents'), 'DreamPaper', 'Wallpapers');
}

function ourWallpaperDir() {
  const custom = config.we && config.we.wallpaperDir;
  // ⚠️ 只有**非空字符串**才当自定义 —— `''` / null / undefined 都退回默认。
  // 漏了这条判断的话，用户"清空"那个配置会得到 `path.join(undefined)` 崩溃。
  if (typeof custom === 'string' && custom.trim()) return custom;
  return defaultWallpaperDir();
}

// ⚠️⚠️⚠️ **AI 自己的工作区**（0.9.142）。用户 2026-08-02：
//   「其实可以给 AI 自己一个工作区…他该在这写中间产物，然后他认为 OK 了，
//     到时候把那个完整壁纸搬到我们的壁纸目录下面让他生效就行」
//
// ⚠️ 而这**同时修掉一个真问题**：0.9.140-141 是**先落盘到壁纸目录再试跑**
//   ⟹ 三轮都没过的半成品会直接出现在壁纸墙上（partial 那条路），
//     而用户点开它看到的是白屏或者报错框。
//   ⟹ 判据：**"在做"和"能用"要在物理上分开**，不是靠一个字段标记。
//     一个 `partial: true` 字段拦不住用户点它，而不在那个目录里就点不到。
//
// ⚠️ 放在 userData 下而不是壁纸目录下 —— 壁纸目录被扫（2 层深），
//   放里面的话暖场区自己会被当成壁纸扫出来。
//   ⚠️ 我第一版想做成 `Wallpapers/.staging/`，而**点号开头也照样被扫到**
//     （扫描不跳隐藏目录）⟹ 那是"看起来隔离了"而实际没有。
function aiStagingDir() {
  // ⚠️ 在 userData 下（`~/Library/Application Support/aircursor/ai-staging/`）。
  //   ⚠️⚠️ 那个 `aircursor` 是旧产品名，而它**不能改** —— 它由 `package.json`
  //     的 `name` 决定，而那个字段决定 `app.getPath('userData')`
  //     ⟹ 改了用户的 key / 壁纸目录 / 录过的手势全部找不到（见 MODULES.md ①）。
  //   ⚠️ 我 0.9.147 想把工作区搬到 `Documents/DreamPaper/ai-工作区/`（用户提的），
  //     而他知道目录名不能改之后说「那就不管了，不用搬」⟹ 保持原样。
  //   ⚠️ 而它**不能放壁纸目录里面** —— 那个目录会被扫（2 层深），
  //     放里面的话工作区自己会被当成壁纸扫出来（点号开头也照样被扫到）。
  return path.join(app.getPath('userData'), 'ai-staging');
}

// ⚠️ 每次生成一个独立子目录 ⟹ 中间产物不互相覆盖，失败的那次留着能查。
function ensureStagingDir(name) {
  const dir = path.join(aiStagingDir(), name);
  fs.mkdirSync(path.join(dir, 'vendor'), { recursive: true });
  return dir;
}

// ⚠️⚠️ 暖场区要自己清 —— 否则每生成一张留一份，几十张之后是几百 MB。
//   ⚠️ 而**保留最近几个** ：失败那次的中间产物是唯一能回看"模型写了什么"的东西。
function pruneStaging(keep) {
  const root = aiStagingDir();
  let names = [];
  try { names = fs.readdirSync(root); } catch { return 0; }
  const withTime = names.map((n) => {
    let t = 0;
    try { t = fs.statSync(path.join(root, n)).mtimeMs; } catch { /* 用 0 */ }
    return { n, t };
  }).sort((a, b) => b.t - a.t);
  let removed = 0;
  // ⚠️⚠️ `keep` 个**目录** + 那些留档的 `.plan.md`（0.9.143）——
  //   留档是几 KB 的文本，而它是"回看模型怎么想的"唯一入口
  //   ⟹ 单独给它一个更宽的额度（20 份 md 也就几十 KB）。
  const dirs = withTime.filter((x) => !x.n.endsWith('.plan.md'));
  const plans = withTime.filter((x) => x.n.endsWith('.plan.md'));
  const doomed = [...dirs.slice(keep), ...plans.slice(20)];
  for (const { n } of doomed) {
    // ⚠️⚠️ 只删 `ai-staging/` 下面一层 —— 路径是我们自己拼的（userData + 固定名 + readdir 的名字），
    //   不接受任何外部输入 ⟹ 这个 rmSync 的作用域是封闭的。
    try { fs.rmSync(path.join(root, n), { recursive: true, force: true }); removed += 1; }
    catch { /* 删不掉就算了，下次再试 */ }
  }
  return removed;
}

// ⚠️⚠️⚠️ **搬进壁纸目录 —— 这一步才让壁纸"生效"。**
//   只有过了全部闸门（静态检查 + 真跑 3 秒）才会走到这里。
//
// ⚠️ 用 `renameSync` 而不是复制：那是**原子**的 ⟹ 壁纸墙不会扫到一个
//   "文件写了一半"的目录。⚠️ 而跨卷会 EXDEV（userData 和 Documents 通常同卷，
//   但用户可能把壁纸目录设在外置盘）⟹ 退回复制 + 删源。
function promoteFromStaging(stageDir, finalDir) {
  try {
    fs.renameSync(stageDir, finalDir);
    return { moved: true, method: 'rename' };
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.cpSync(stageDir, finalDir, { recursive: true });
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* 留着也无害 */ }
    return { moved: true, method: 'copy（跨卷）' };
  }
}

// 首次启动时建出来 + 放一个说明文件。
//
// ⚠️ 空目录对用户是没有信息的 —— 他不知道往里放什么、什么格式认得出来。
// 而"放了一堆 mp4 结果认不出来"是这个产品最容易撞的墙（每个子目录要有 project.json）。
// 把工坊下载的目录**移进我们统一的壁纸目录**。
//
// ⚠️⚠️ 为什么必须搬：steamcmd 的下载位置是**它自己定的、不可配** ——
//   `~/Library/Application Support/Steam/steamapps/workshop/content/431960/<ID>/`
// 而用户的要求是「统一都在 Documents/GestureWall/Wallpapers」。
//
// ⚠️⚠️⚠️ **0.9.29 起是移动，不是复制。**
//
// 0.9.24 我用的是 `cpSync`（复制），理由是"Steam 目录是 steamcmd 的账本，
// 移走会让下次下载认为已下载却找不到文件"。而用户 0.9.28 实测后说：
//   「那不就是自动两份，太离谱了」
//
// 他说得对 —— **那个理由不足以让用户接受两份**：
//   ① 磁盘占用翻倍，而壁纸可以到几百 MB
//   ② 面板上要解释"这份是原件、那份是副本"，本身就是设计失败的信号
//   ③ 用户删了我们目录那份，Steam 那份还在 ⟹ 下次扫描它又冒出来
//
// ⟹ 改成 `renameSync`（移动）+ **删掉 Steam 那边的空壳目录**。
//
// ⚠️ 而"下次下载被跳过"这个风险是真的（`appworkshop_431960.acf` 记着
// "已下载了哪些物品"）⟹ 用**下载前先删 manifest 条目**来兜：
// 见 `clearWorkshopManifest()`。那样 steamcmd 每次都真的重下。
//
// ⚠️ `renameSync` 跨卷会失败（`EXDEV`）—— Steam 目录和 Documents 通常同卷，
// 但用户可能把 Steam 装在外置盘上 ⟹ 失败时退回"复制 + 删源"。
function importToOurDir(srcDir, workshopId, title) {
  const root = ensureOurWallpaperDir();
  // 标题可能含 / : 等在文件名里非法的字符，也可能是空的
  const safe = String(title || '')
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  const name = safe ? `${workshopId}-${safe}` : String(workshopId);
  const dest = path.join(root, name);
  try {
    // ⚠️ 已存在就先删 —— 重新下载同一个物品时要拿到新内容，
    // 而 rename 到已存在的目录会失败（ENOTEMPTY）。
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    try {
      fs.renameSync(srcDir, dest);
    } catch (err) {
      // ⚠️ 跨卷（EXDEV）⟹ rename 不行，退回复制 + 删源。
      // 判 code 而不是判消息 —— 消息随系统语言变。
      if (err && err.code === 'EXDEV') {
        fs.cpSync(srcDir, dest, { recursive: true });
        fs.rmSync(srcDir, { recursive: true, force: true });
      } else {
        throw err;
      }
    }
    // ⚠️ 顺手清掉 Steam 那边留下的**空壳目录**（rename 之后 <ID>/ 就不在了，
    // 但它的父目录 content/431960/ 可能只剩空壳）。
    // 不清的话面板上那行会报"目录在，但里面没有壁纸"—— 那是噪声。
    try {
      const parent = path.dirname(srcDir);
      if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
        fs.rmdirSync(parent);
      }
    } catch (e) { /* 清不掉不影响功能 */ }
    return { ok: true, dir: dest };
  } catch (err) {
    // ⚠️ 搬失败不能让整个下载算失败 —— 文件还在 Steam 目录里，
    // 直接用那个路径装载仍然能看到画面。**降级而不是报错。**
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

// 下载前清掉这个物品在 steamcmd 账本里的记录。
//
// ⚠️⚠️ 为什么需要：我们把下载的内容**移走**了（见 importToOurDir），
// 而 steamcmd 的 `appworkshop_431960.acf` 仍记着"已下载物品 <ID>，版本 X"
// ⟹ 下次下载同一个物品时它会说"已是最新"然后**什么都不做**
// ⟹ 用户看到"下载成功"但我们目录里没有新东西。
//
// ⚠️ 那是个**静默失败**：steamcmd 的退出码是 0、日志里有 Success。
// ⟹ 所以不能靠"出问题再说"，必须每次下载前主动清。
//
// ⚠️ 做法是删整个 acf 而不是解析它 —— acf 是 Valve 的私有格式（类 VDF），
// 手写解析器去改一个条目，风险比重新下载所有物品高得多。
// 而删掉它的代价只是"steamcmd 忘记了下载历史"，而那正是我们要的。
function clearWorkshopManifest() {
  const cleared = [];
  for (const root of Workshop.STEAM_ROOTS) {
    const acf = path.join(root, 'steamapps', 'workshop', `appworkshop_${Workshop.WE_APP_ID}.acf`);
    try {
      if (fs.existsSync(acf)) {
        fs.rmSync(acf, { force: true });
        cleared.push(acf);
      }
    } catch (e) { /* 删不掉就算了，下载还是会跑 */ }
  }
  return cleared;
}

function ensureOurWallpaperDir() {
  const dir = ourWallpaperDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const readme = path.join(dir, '把壁纸放这里.txt');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme, [
        'DreamPaper 壁纸目录',
        '',
        '把壁纸放进这个目录，DreamPaper 会自动扫到它们。',
        '',
        '⚠️ 每个壁纸是一个【子目录】，里面要有 project.json：',
        '',
        '  Wallpapers/',
        '    我的动态壁纸/',
        '      project.json      ← 必须有，它说明这是什么类型的壁纸',
        '      index.html        ← web 类壁纸的入口',
        '    另一个壁纸/',
        '      project.json',
        '      video.mp4         ← video 类壁纸的文件',
        '',
        '⚠️ 直接把一堆 mp4 扔进 Wallpapers/ 是认不出来的 —— 没有 project.json，',
        '   我们不知道它是壁纸还是普通视频。',
        '',
        '⚠️ 从 Steam 创意工坊下载的壁纸会**自动复制到这里**，',
        '   目录名是「工坊ID-标题」。删掉它们不影响 Steam 那边的下载记录。',
        '',
        '扫描上限：2 层深、500 个 —— 再多会让面板卡住。',
      ].join('\n'), 'utf8');
    }
    return dir;
  } catch (error) {
    console.warn('[wallpaper] 建壁纸目录失败:', error.message);
    return dir;
  }
}

// 把**已经存在于 Steam 目录**的工坊壁纸搬进我们目录。
//
// ⚠️ 为什么需要：0.9.24-0.9.28 用的是复制 ⟹ 用户机器上已经有两份了。
// 而 0.9.29 改成移动只对**新下载**生效 ⟹ 存量的两份不会自己消失。
//
// ⟹ 扫描 Steam 目录，把每个工坊壁纸搬过来（我们目录已有同 ID 的就只删源）。
// 用户 2026-08-01：「那不就是自动两份，太离谱了」—— 存量也得清。
function importExistingFromSteam() {
  const root = ensureOurWallpaperDir();
  const moved = [];
  const failed = [];
  // 我们目录里已有哪些工坊 ID（目录名开头的数字）
  const have = new Set();
  try {
    for (const name of fs.readdirSync(root)) {
      const m = name.match(/^(\d{6,})/);
      if (m) have.add(m[1]);
    }
  } catch (e) { /* 目录刚建、读不到都不影响 */ }

  for (const steamRoot of Workshop.STEAM_ROOTS) {
    const content = path.join(steamRoot, 'steamapps', 'workshop', 'content', Workshop.WE_APP_ID);
    let entries = [];
    try { entries = fs.readdirSync(content); } catch (e) { continue; }
    for (const id of entries) {
      if (!/^\d{6,}$/.test(id)) continue;
      const srcDir = path.join(content, id);
      try { if (!fs.statSync(srcDir).isDirectory()) continue; } catch (e) { continue; }
      // ⚠️ 我们已经有这个 ID 了 ⟹ **只删源**，别覆盖用户目录里那份
      //（他可能已经改过里面的属性/文件）。
      if (have.has(id)) {
        try {
          fs.rmSync(srcDir, { recursive: true, force: true });
          moved.push({ id, action: 'removed-duplicate' });
        } catch (err) {
          failed.push({ id, error: String(err && err.message ? err.message : err) });
        }
        continue;
      }
      // 读标题给目录起名（失败就只用 ID）
      let title = '';
      try {
        const pj = JSON.parse(fs.readFileSync(path.join(srcDir, 'project.json'), 'utf8'));
        title = pj && typeof pj.title === 'string' ? pj.title : '';
      } catch (e) { title = ''; }
      const r = importToOurDir(srcDir, id, title);
      if (r.ok) { moved.push({ id, action: 'moved', dir: r.dir }); have.add(id); }
      else failed.push({ id, error: r.error });
    }
  }
  // ⚠️ 搬完清账本 —— 内容不在了，账本还记着"已下载"会让下次下载被跳过
  if (moved.length) clearWorkshopManifest();
  return { moved, failed };
}

ipcMain.handle('import-existing-from-steam', () => {
  const r = importExistingFromSteam();
  logEvent('workshop', `整理存量：搬了 ${r.moved.length} 个，失败 ${r.failed.length} 个`, r);
  return { ok: true, ...r };
});

ipcMain.handle('workshop-local', () => {
  // 我们自己的目录 + steamcmd 的下载目录 + 用户自己加的目录。
  const roots = [
    // ⚠️ 我们自己的放**最前面** —— 用户自己放的壁纸应该先被看到。
    ensureOurWallpaperDir(),
    ...Workshop.STEAM_ROOTS.map((r) =>
      path.join(r, 'steamapps', 'workshop', 'content', Workshop.WE_APP_ID)),
    // ⚠️ `libraryDirs` 已废弃（0.9.31，收成单一的 `wallpaperDir`）——
    // 但**旧配置里可能还有值** ⟹ 继续扫它们，否则用户的壁纸会突然消失。
    // 只是不再有写入路径、UI 也不再暴露。
    ...(config.we.libraryDirs || []),
  ];

  const { dirs, truncated } = Workshop.findWallpaperDirs(roots, {
    listDir: (d) => fs.readdirSync(d),
    isDir: (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } },
    exists: (f) => fs.existsSync(f),
  });

  // ⚠️ 把**扫了哪些目录**报出来，而不只是结果。
  //
  // 用户报：面板只写「还没加自定义目录（steamcmd 那个是自动扫的）」——
  // 而"那个"到底是哪个路径、存不存在、找到几个，一个字都没说。
  // ⟹ 「我的壁纸是空的」时无从判断是"目录不对"还是"目录对但里面没东西"。
  //
  // 每个根目录单独报：在不在、找到几个壁纸。那三件事决定用户下一步做什么。
  const ourDir = ensureOurWallpaperDir();
  const scanned = roots.map((root) => {
    const here = dirs.filter((d) => d.startsWith(root));
    return {
      path: root,
      exists: fs.existsSync(root),
      found: here.length,
      // ⚠️ **我们自己的目录不算 auto** —— 面板已经在最上面单独显示它了
      //（「我的壁纸目录：… [打开]」），再当成"自动扫描的目录"列一遍就是重复。
      // 用户 2026-08-01 提的：「不用每一张壁纸都这样显示，就这两个地址就行」。
      ours: root === ourDir,
      auto: root !== ourDir && !(config.we.libraryDirs || []).includes(root),
    };
  });

  const items = [];
  for (const dir of dirs) {
    try {
      const project = WE.parseProject(
        JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')));
      if (!project) continue;
      items.push({
        id: path.basename(dir),
        dir,
        title: project.title,
        type: project.type,
        typeLabel: project.typeLabel,
        supported: project.supported,
        gifScene: project.gifScene,
        refusal: project.supported ? null : WE.typeRefusal(project.type),
        preview: previewPathOf(dir, project),
        // 当前装载的是哪个 —— 列表里要能标出来。
        active: !!(weProject && weProject.dir === dir),
      });
    } catch {
      // ⚠️ 一个坏的 project.json 不能让整个列表变空。
      // 但也别静默丢掉 —— 列出来并说明，否则用户找不到他知道存在的那个壁纸。
      items.push({
        id: path.basename(dir), dir, title: path.basename(dir),
        broken: true, refusal: 'project.json 读不出来（文件坏了或格式不对）',
      });
    }
  }

  // 排序：能用的在前、当前装载的最前，其余按标题。
  // ⚠️ 不按目录名排：那是一串工坊 ID，对人没有意义。
  items.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.supported !== b.supported) return a.supported ? -1 : 1;
    return String(a.title).localeCompare(String(b.title), 'zh');
  });

  return {
    ok: true, items, truncated,
    // ⚠️⚠️⚠️ **正在放的那张如果不在列表里，要说出来**（0.9.133）。
    //   用户 2026-08-02：「我点击进以后会自动运行一张壁纸，这张壁纸我不知道
    //   为啥会自动运行，而且我看那里也没有显示正在播放的壁纸」
    //
    // ⚠️ 机制：启动时装的是 `config.we.dir`（一条**绝对路径**），
    //   而列表扫的是当前壁纸目录 ⟹ 两者不一致时（他 0.9.131 改名之后
    //   把壁纸搬到了 `~/Documents/DreamPaper/Wallpapers`，而 config 里存的
    //   还是旧路径）`active` 全是 false
    //   ⟹ **桌面上在放一张壁纸，而面板上没有任何东西对应它**。
    //   那正是"我不知道为啥会自动运行"的来源 —— 不是它乱放，
    //   是面板没告诉他放的是哪个、为什么。
    //
    // ⟹ 判据：**"当前状态"和"可选项列表"是两回事，不能靠"在列表里找一下"
    //   来表示当前状态** —— 找不到时那个状态就消失了，而它其实还在生效。
    // ⟹ 把真实的当前壁纸单独报出来，面板据此提示。
    activeDir: weProject ? weProject.dir : null,
    activeTitle: weProject ? weProject.title : null,
    // 当前那张在不在这次扫到的列表里
    activeListed: !!(weProject && items.some((i) => i.dir === weProject.dir)),
    roots: roots.filter((r) => fs.existsSync(r)),
    // ⚠️ 报出"扫了哪些目录 + 在不在 + 找到几个"。
    //
    // 用户报：面板只写「还没加自定义目录（steamcmd 那个是自动扫的）」——
    // 而"那个"是哪个路径、存不存在、找到几个，一个字都没说
    // ⟹「我的壁纸是空的」时无从判断是"目录不对"还是"目录对但里面没东西"。
    scannedRoots: roots,
    scanned,
  };
});

// **改壁纸目录**（0.9.31 起：不是"加一个"，是改那唯一的一个）。
//
// ⚠️ 用户 2026-08-01：「反正只有一个路径来源，只是我允许你更改」
//
// ⚠️⚠️ **只改指向，不搬文件**（用户明确选的）：
// 新目录空的话列表就空了，要不要把文件拷过去由用户自己决定。
// ⟹ 那样行为可预测 —— "临时看另一个目录"不会把几百 MB 的文件搬走。
ipcMain.handle('workshop-add-dir', async () => {
  const result = await dialog.showOpenDialog(dashboardWindow || undefined, {
    title: '选择壁纸目录（里面每个子目录是一个壁纸）',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '用这个目录',
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
  const dir = result.filePaths[0];
  const before = ourWallpaperDir();
  config.we.wallpaperDir = dir;
  writeConfig(config);
  broadcast('config', config);
  // ⚠️ 换目录后要建好结构（放说明文件）—— 否则新目录空空的，
  // 用户不知道"每个子目录要有 project.json"这条约束。
  ensureOurWallpaperDir();
  logEvent('wallpaper', `壁纸目录改成：${dir}`, { before });
  // ⚠️ 报 `before` 给面板 —— 旧目录里可能还有壁纸，而我们不搬
  // ⟹ 面板要能提示"旧目录还在那儿，文件没动"。
  return { ok: true, dir, before, moved: false };
});

// 恢复默认壁纸目录。
//
// ⚠️ 为什么要有这条：改错了目录之后，用户没有别的办法回到默认
//（默认值不写进 config，所以他不知道该填什么路径）。
ipcMain.handle('workshop-reset-dir', () => {
  const before = ourWallpaperDir();
  config.we.wallpaperDir = '';
  writeConfig(config);
  broadcast('config', config);
  const dir = ensureOurWallpaperDir();
  logEvent('wallpaper', `壁纸目录恢复默认：${dir}`, { before });
  return { ok: true, dir, before };
});

// 删掉一个**旧配置里的**附加目录。
//
// ⚠️ `libraryDirs` 已废弃（0.9.31 收成单一的 `wallpaperDir`），但这条 IPC 保留 ——
// 旧配置里可能还有值，而用户需要能删掉它们。没有这条的话那些目录会一直被扫，
// 而 UI 上没有任何办法处理 ⟹ 那比留一个"只能删不能加"的入口更糟。
ipcMain.handle('workshop-remove-dir', (_event, dir) => {
  config.we.libraryDirs = (config.we.libraryDirs || []).filter((d) => d !== dir);
  writeConfig(config);
  broadcast('config', config);
  return { ok: true };
});

// 装载一个已经下载好的
ipcMain.handle('workshop-load-local', (_event, dir) => {
  if (!dir || !fs.existsSync(path.join(dir, 'project.json'))) {
    return { ok: false, error: '这个目录里没有 project.json' };
  }
  const out = setWEWallpaper(dir);
  if (out.ok) {
    // ⚠️⚠️ **手动点一个壁纸时，轮播计时器重算**（用户 2026-08-01 拍的）。
    //
    // 他选的是「切过去，计时器重算」而不是「自动关掉轮播」——
    // 理由是"点一下就关了一个开关"容易意外，而重新打开要去找那个开关。
    // ⟹ 轮播继续，只是从这个壁纸开始重新计时。
    //
    // ⚠️ 而 `syncRotate()` 会 clearInterval + 重建 ⟹ 那正好就是"重算"。
    // 漏了这一句的话：用户手动切了一张，5 秒后轮播把它换掉了
    // ⟹ 症状是"我刚点的壁纸自己变了"。
    if (config.we.rotate && config.we.rotate.on) syncRotate();
    config.we.dir = dir;
    writeConfig(config);
    broadcast('config', config);
  }
  return out;
});

// 解 legacy.bin。
//
// ⚠️ 里面是什么只能靠魔数判，不能猜 —— 可能是 zip、WE 的 PKGV 私有归档、
// 或者裸的一个视频文件。三种处置完全不同，判错就是又一轮来回。
function unpackLegacy(binPath, targetDir) {
  let head;
  try {
    const fd = fs.openSync(binPath, 'r');
    head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
  } catch (error) {
    return { ok: false, error: `读不了 legacy 文件：${error.message}` };
  }

  const sniff = Workshop.sniffLegacy(head);

  if (sniff.kind === 'zip') {
    // macOS 自带 ditto，比 unzip 更能处理奇怪的归档，而且不需要额外依赖。
    const result = spawnSync('/usr/bin/ditto', ['-x', '-k', binPath, targetDir],
      { encoding: 'utf8', timeout: 120000 });
    if (result.status !== 0) {
      return {
        ok: false, label: sniff.label,
        error: `解压失败：${(result.stderr || '').slice(0, 200)}`,
      };
    }
    // ⚠️ 解出来必须真的有 project.json，否则只是换了个地方失败。
    // 而且 zip 里可能多一层同名目录，所以往下找一层。
    if (fs.existsSync(path.join(targetDir, 'project.json'))) {
      return { ok: true, label: `${sniff.label} → 已解包` };
    }
    for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
      if (entry.isDirectory()
        && fs.existsSync(path.join(targetDir, entry.name, 'project.json'))) {
        return { ok: true, label: `${sniff.label} → 已解包（在子目录 ${entry.name}）`,
          nested: path.join(targetDir, entry.name) };
      }
    }
    return {
      ok: false, label: sniff.label,
      error: '解压成功但里面没有 project.json —— 这个归档可能不是 WE 壁纸',
    };
  }

  // 视频/图片：legacy 时代的单文件壁纸就是一个媒体文件，没有 project.json。
  // ⟹ 我们可以给它造一个，让它走 video 那条已经做好的路。
  if (['mp4', 'webm', 'gif', 'png', 'jpg'].includes(sniff.kind)) {
    const ext = sniff.kind === 'mp4' ? 'mp4' : sniff.kind;
    const media = path.join(targetDir, `wallpaper.${ext}`);
    try {
      fs.copyFileSync(binPath, media);
      // ⚠️ 造 project.json 而不是特殊分支：那样它复用已有的媒体装载路径，不用再写一套。
      const isImage = ['gif', 'png', 'jpg'].includes(sniff.kind);
      fs.writeFileSync(path.join(targetDir, 'project.json'), JSON.stringify({
        type: isImage ? 'image' : 'video',
        file: `wallpaper.${ext}`,
        title: `工坊物品（${sniff.label}）`,
        _generatedBy: 'DreamPaper：legacy 单文件壁纸没有 project.json，这个是我们造的',
        _sourceFile: path.basename(binPath),
      }, null, 2));

      // ⚠️ 文件名里带 preview 的是**缩略图**，不是壁纸本体。
      //
      // 实测：用户下了一个 943KB 的物品，落地文件叫
      //   1727611897_new_preview_preview.gif
      // 画面能动但很糊 —— 因为那是工坊列表用的小图（几百像素宽），
      // 拉到 2940px 屏幕上必然糊。
      //
      // 这件事必须说出来，否则用户会以为是我们的渲染差。而且它指向一个真问题：
      // 那个物品的壁纸本体可能压根不在 legacy.bin 里（作者只上传了预览图，
      // 或者本体在别的地方）。
      const looksLikePreview = /preview/i.test(path.basename(binPath));
      return {
        ok: true,
        label: `${sniff.label} → 已转成${isImage ? '图片' : '视频'}类`,
        warning: looksLikePreview
          ? `⚠️ 这个文件名里带 preview（${path.basename(binPath)}）—— 那通常是工坊的`
            + '**缩略图**而不是壁纸本体，所以放大后会糊。这个物品可能没把本体传上来。'
          : null,
      };
    } catch (error) {
      return { ok: false, label: sniff.label, error: `转换失败：${error.message}` };
    }
  }

  if (sniff.kind === 'pkgv') {
    return {
      ok: false, label: sniff.label,
      error: '这是 WE 的私有 PKGV 归档 —— 需要 scene 渲染，暂不支持',
      hint: 'scene 类是 WE 编辑器的私有格式。详见 scene-wallpaper-feasibility.md',
    };
  }

  // ⚠️ 判不出来时把头几个字节给出来，别只说"不支持"。
  // 那串十六进制能让我直接查出是什么格式，不用来回猜。
  return {
    ok: false, label: sniff.label,
    error: `legacy 文件的格式认不出来：${sniff.label}`,
    hex: sniff.hex,
    hint: `文件在 ${binPath} —— 把上面那串开头字节发给我，我查是什么格式`,
  };
}

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
// AI 生成壁纸（0.9.123）
// ---------------------------------------------------------------------------
//
// 用户 2026-08-02：「调用大模型 api，帮我做壁纸」
//   「就像和 ChatGPT 对话一样，有个对话框，然后他上面会显示一下我的工作目录在哪儿，
//     就是我的壁纸存储目录，他生成壁纸就要放在这儿」
//   「不能给用户提供让他自主选择模型，我们就把调用大模型这个打通就行」
//
// ⚠️⚠️⚠️ **这个功能的成败不在"能不能调 API"（那是 30 行），在"生成完怎么收敛"。**
//
// 用户原话：「这个东西你拆成不烂，找一下性啥的写好提示词设计一套 agent 的
//   那种流程肯定能做出来的呀」—— **他说得对**，而我原来那句"做不出来"框错了问题：
//   我说的是"一次性生成做不到"，他问的是"拆开、设计流程能不能做到"。
//   而他抓的那个点是关键：**粒子效果不需要素材，它就是代码**
//   ⟹ 产物在模型能力范围内，瓶颈只在"一轮出不来"，而那是流程问题。
//
// ⚠️⚠️ 实测（2026-08-02，Bedrock Sonnet 4.5，真跑三轮）：
//     v1 262 行 → 机器闸门报 1 个问题（**鼠标一个事件都没接**）
//     v2 334 行 → 报 1 个（接了 mousemove 但没用 e.buttons）
//     v3 343 行 → **0 个，收敛**。总共约 10k 输出 token。
//   ⟹ 三轮上限是照实测定的，不是拍的。
//
// ⚠️⚠️⚠️ **而"模型审模型"不可信** —— 同一次实测里我让模型审自己的产物，
//   它判错两次、方向还相反：鼠标完全没接它判 pass（漏报）、
//   Math.random 用对了它判 fail（误报）。
//   ⟹ 所以闸门是**代码**（Gen.inspect / Gen.judgeRuntime），模型不参与判定。
//
// 三层闸门：
//   ① 机器闸门（Gen.inspect，纯函数，有 52 项测试）
//   ② 真跑闸门（下面那个隐藏窗口 —— 这一层绕不开 Electron）
//   ③ 用户的眼睛（"好不好看"只有他能判 —— 所以我们不在这上面加任何模型判断）

// 生成过程的进度往面板推。⚠️ 一次生成要几十秒到几分钟（实测三轮约 10k token），
// 而**没有进度的等待和卡死分不开** —— 这个项目为"静默"栽过很多次。
// ⚠️⚠️ `quiet` = 只推面板、不打终端（0.9.143）。
//   用户 2026-08-02：「首先不应该是刷屏的，应该是那种原地刷新状态」
//   ⟹ 心跳（「已等 N 秒」）每 3 秒一条，等 198 秒就是 66 行 ——
//     终端里那 66 行把真正的事件（配方/落盘/试跑结果）全冲掉了。
//   ⟹ 判据：**终端日志要留"发生了什么"，不要留"还在等"。**
//     面板那边是原地刷新的（一行），所以推过去无害；终端是追加的，会淹。
//   ⚠️ 而**超时/失败照样打** —— 那是事件不是状态。
function genProgress(stage, detail, quiet) {
  if (!quiet) console.log(`[gen] ${stage}${detail ? `：${detail}` : ''}`);
  broadcast('gen-progress', { stage, detail: detail || '' });
}

// ⚠️ 语法检查：`new Function` 只**解析**不执行 —— 这点很重要，
//   我们绝不能执行模型生成的代码来判断它对不对。
function checkJsSyntax(code) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(code);
    return null;
  } catch (error) {
    return error.message;
  }
}

// ---------------------------------------------------------------------------
// ② 真跑闸门 —— 在一个隐藏窗口里跑 3 秒，看它到底活不活
// ---------------------------------------------------------------------------
//
// ⚠️⚠️ 这是"静态检查过了但跑起来是白的/黑的/报错的"唯一的判据。
//   而那三种失败**静态检查一个都看不出来**：
//     · ctx.roundRect 在旧 Chromium 上不存在 ⟹ 运行时抛
//     · 坐标算错画到屏幕外 ⟹ 画面全黑，但日志完全干净
//     · shader 编译失败 ⟹ 同上
//
// ⚠️ 用 `show: false` 的独立窗口，**不碰真的壁纸层** ——
//   生成过程中用户的壁纸不该闪一下。
//
// ⚠️⚠️ 而这个函数**我在云端验不了**（要 Electron 窗口）⟹ 它里面
//   **不放判定逻辑**，只负责"跑起来收集数据"，判定全在 `Gen.judgeRuntime`
//   （纯函数，有测试）。这样万一出问题，能分清是"没收集到数据"还是"判错了"。
async function probeWallpaperRuntime(dir) {
  const probe = {
    ready: false,
    errors: [],
    frames: 0,
    ms: 0,
    sampledPixels: null,
  };
  let win = null;
  try {
    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 720,
      webPreferences: {
        // ⚠️ **不挂 we-preload** —— 那样宿主接口全都不存在，
        //   而这恰好测的是"在浏览器里直开也能跑"那条硬约束
        //   （壁纸必须 if 保护每个 window.wallpaperXxx）。
        //   ⟹ 如果它裸调了某个接口，这一层会抓到那个 TypeError。
        offscreen: false,
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    win.webContents.on('console-message', (...args) => {
      const d = args[1] && typeof args[1] === 'object' ? args[1] : null;
      const level = d ? ({ error: 3, warning: 2 }[d.level] ?? 1) : args[1];
      const message = d ? d.message : args[2];
      if (level < 3) return;   // 只收 error
      if (probe.errors.length < 10) probe.errors.push(String(message).slice(0, 300));
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      probe.errors.push(`渲染进程挂了：${details.reason}`);
    });

    // ⚠️⚠️ 用 `file://` 而**不是** `wall://`。我第一版写的是 wall://（想着
    //   "和真装载走同一条路"），而那是错的：`protocol.handle` 那个 handler
    //   **只服务当前装载的壁纸**（`if (!weProject || !weProject.dir) return 404`
    //   —— 见 registerWEProtocol），而我们探测的是一个刚生成、还没装载的目录
    //   ⟹ 必然 404，探针会把每一个产物都判成坏的。
    //
    // ⚠️ 代价说清楚：file:// 漏掉了"wall:// 协议本身有问题"那一类。
    //   而那类问题**不是单个壁纸的问题**（协议对所有壁纸一视同仁），
    //   所以它不该由"这张壁纸行不行"这个闸门来管。
    // ⚠️ 而生成的壁纸是**单文件、零外部资源**（机器闸门 A 组强制了这点）
    //   ⟹ 它根本不会去请求别的资源 ⟹ 两种协议下的行为在这里是一样的。
    await win.loadURL(pathToFileURL(path.join(dir, 'index.html')).href);

    // ⚠️ 在页面里装一个计帧器 + wallpaperReady 的探针。
    //   ⚠️⚠️ 必须在 loadURL **之后** 注入 —— 之前注入的话页面一加载就被冲掉。
    //   而这意味着我们**测不到"页面加载那一瞬间就调了 wallpaperReady"** ——
    //   所以下面用"函数存在与否"而不是"有没有被调过"来判。
    await win.webContents.executeJavaScript(`
      (function(){
        window.__gwProbe = { frames: 0, ready: false, t0: performance.now() };
        var raf = window.requestAnimationFrame;
        window.requestAnimationFrame = function(cb){
          return raf(function(t){ window.__gwProbe.frames++; return cb(t); });
        };
        // ⚠️ 页面可能已经调过 wallpaperReady 了（我们注入得晚）——
        //   那种情况这里补挂一个也没用。⟹ 判据放宽：
        //   只要页面的源码里有 wallpaperReady 调用（①机器闸门已经查过），
        //   这里就不把"没收到"当失败。见下面 ready 的处理。
        if (!window.wallpaperReady) {
          window.wallpaperReady = function(){ window.__gwProbe.ready = true; };
        }
        return true;
      })();
    `);

    // 跑 3 秒。⚠️ 不能太短 —— 有的壁纸头一秒在做初始化（建粒子、编译 shader）。
    const RUN_MS = 3000;
    const t0 = Date.now();
    await new Promise((resolve) => setTimeout(resolve, RUN_MS));
    probe.ms = Date.now() - t0;

    // ⚠️⚠️⚠️ **WebGL 读数**（0.9.140）—— 用户选了 Three.js 路线之后，
    //   黑屏的主因从"canvas 画错了"变成"WebGL 根本没画"，
    //   而那种失败**日志完全干净**（没报错、fps 正常、context 也在）。
    //   ⟹ 直接问页面三件事：context 在不在、gl.getError()、场景里几个对象。
    //
    // ⚠️⚠️ 而 `ready` 这一条**不能靠 wallpaperReady 判** ——
    //   探针**故意不挂 we-preload**（那样能测出"裸调宿主接口"的问题），
    //   ⟹ `window.wallpaperReady` 压根不存在 ⟹ 骨架的 `if` 保护会跳过它
    //   ⟹ 永远是 false ⟹ **每一张都会被误报"没就绪"**。
    //   （我在接线时先算了一遍才发现这条，没等它上线。）
    //   ⟹ 改成问骨架自己：只要 renderer 和 scene 建起来了就算就绪。
    const stat = await win.webContents.executeJavaScript(`
      (function(){
        var p = window.__gwProbe || {};
        var out = { frames: p.frames || 0, webgl: null };
        try {
          var c = document.getElementById('c');
          var gl = c && (c.getContext('webgl2') || c.getContext('webgl'));
          out.webgl = {
            context: !!gl,
            glError: gl ? gl.getError() : null,
            // ⚠️ 骨架把 scene 挂出来给探针看（见 runtime.js 末尾）
            objects: (window.__dpScene && window.__dpScene.children)
              ? window.__dpScene.children.length : -1,
          };
        } catch (e) { out.webgl = { context: false, glError: null, objects: -1, err: String(e && e.message) }; }
        // 骨架报的错（它自己知道 three 没加载 / scene 建不起来这类）
        out.skeleton = (window.__dpDiag || []).slice(-20);
        return out;
      })();
    `);
    probe.frames = stat.frames;
    probe.webgl = stat.webgl;
    probe.skeleton = stat.skeleton || [];
    // ⚠️ "就绪"= WebGL context 在 + 场景里有东西。那比 wallpaperReady 更直接，
    //   而且不依赖 preload（见上面那段判据）。
    probe.ready = !!(stat.webgl && stat.webgl.context && stat.webgl.objects > 0);

    // ⚠️⚠️ **采样像素判"是不是全黑"** —— 这是"跑起来了但什么都看不见"的
    //   唯一自动判据，而那种失败在日志里完全干净。
    //   ⚠️ 用 capturePage 而不是读 canvas：壁纸可能用 WebGL，
    //     而 WebGL 的 canvas 读像素要 preserveDrawingBuffer（我们改不了它的代码）。
    try {
      const image = await win.webContents.capturePage();
      const size = image.getSize();
      if (size.width > 0 && size.height > 0) {
        // ⚠️ 缩到 20×20 再数 —— 400 个采样点足够判"是不是一片黑"，
        //   而全尺寸是 92 万像素（白费）。
        // ⚠️⚠️⚠️ **32×32 而不是 20×20**（0.9.145）—— 要按"上/中/下三分带"
        //   分别算亮度，20 行分不出干净的三等份（20/3 不是整数）。
        //   32 行 ⟹ 每带 10 行还余 2，够用而且开销仍然可忽略。
        const N = 32;
        const small = image.resize({ width: N, height: N, quality: 'good' });
        const bitmap = small.toBitmap();   // BGRA
        let black = 0;
        let bright = 0;
        let total = 0;
        // ⚠️ 三分带的亮度和 —— 这是"构图对不对"的观测点（见下面 judgeComposition）
        const bandSum = [0, 0, 0];
        const bandCount = [0, 0, 0];
        // ⚠️ 主体（亮度 > 30）的饱和度和色相 —— 参考壁纸实测 S 中位 0.30-0.34，
        //   而**模型默认会给高饱和霓虹色**，那是"一眼就俗"的主因。
        const sats = [];
        for (let i = 0; i + 3 < bitmap.length; i += 4) {
          const b = bitmap[i];
          const g = bitmap[i + 1];
          const r = bitmap[i + 2];
          const idx = i / 4;
          const row = Math.floor(idx / N);
          const lum = (r + g + b) / 3;
          total += 1;
          // ⚠️ 阈值 18 而不是 0：深色壁纸的底色常常是 #05060a 这种
          //   （不是纯黑但肉眼看不出区别）⟹ 把它算成"黑"才符合观感。
          if (r < 18 && g < 18 && b < 18) black += 1;
          // ⚠️ 高亮阈值 120（和参考壁纸的量化口径一致）
          if (lum > 120) bright += 1;
          const band = row < N / 3 ? 0 : (row < (2 * N) / 3 ? 1 : 2);
          bandSum[band] += lum;
          bandCount[band] += 1;
          if (lum > 30) {
            const mx = Math.max(r, g, b);
            const mn = Math.min(r, g, b);
            // HSV 的 S = (max - min) / max
            sats.push(mx > 0 ? (mx - mn) / mx : 0);
          }
        }
        sats.sort((x, y) => x - y);
        probe.sampledPixels = {
          black,
          total,
          bright,
          // 三分带平均亮度（0-255）
          bands: bandSum.map((sum, i) => (bandCount[i] ? sum / bandCount[i] : 0)),
          // ⚠️ 中位数而不是平均 —— 平均会被少数极亮点拉high
          satMedian: sats.length ? sats[Math.floor(sats.length / 2)] : null,
          subjectRatio: total ? sats.length / total : 0,
        };
      }
    } catch (error) {
      // ⚠️ 截图失败不算壁纸的问题 —— 那是我们这边的能力缺失。
      //   ⟹ 留 null，`judgeRuntime` 那边会跳过全黑判定（它判 `px && px.total > 0`）。
      console.warn('[gen] 截图失败，跳过全黑判定：', error.message);
    }
  } catch (error) {
    probe.errors.push(`探测本身失败：${error.message}`);
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
  }
  return probe;
}


// ⚠️⚠️ **预览图**（0.9.140）：网格卡片要它，没有就是个空白方块。
//
// ⚠️ 在隐藏窗口里跑 2 秒再截 —— 立刻截会拿到"还没画第一帧"的黑图。
//   ⚠️ 而它**不动用户桌面上正在放的壁纸**（那是用户明确不要的"实时预览"）。
async function savePreview(dir) {
  let win = null;
  try {
    win = new BrowserWindow({
      show: false, width: 1280, height: 800,
      webPreferences: { offscreen: false, backgroundThrottling: false,
        contextIsolation: true, nodeIntegration: false },
    });
    await win.loadURL(pathToFileURL(path.join(dir, 'index.html')).href);
    // ⚠️ 2 秒：够让音频空闲动画走起来（第一帧常常是"元素都在原点"）
    await new Promise((r) => setTimeout(r, 2000));
    const image = await win.webContents.capturePage();
    // ⚠️ 存成 jpg 而不是 png —— 预览图 1280x800 的 png 是几百 KB，
    //   而卡片上显示的尺寸只有 150px 宽。
    const out = path.join(dir, 'preview.jpg');
    fs.writeFileSync(out, image.resize({ width: 640 }).toJPEG(82));
    logEvent('gen', `预览图存好了：${Math.round(fs.statSync(out).size / 1024)}KB`);
    return true;
  } catch (error) {
    // ⚠️ 截图失败不算生成失败 —— 壁纸本身是好的，只是卡片上没缩略图。
    logEvent('gen', `预览图截失败（不影响壁纸）：${error.message}`);
    return false;
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
  }
}

// 一次模型调用：带进度心跳 + "想太多"自动重试。
//
// ⚠️⚠️ 抽成函数是因为现在有**三处**要它（设计 / 实现 / 修）——
//   我第一版把这段内联在循环里，而加了"设计"那一步之后就得抄第二份。
//   ⟹ 判据：**第二个调用点出现时就抽出来**，别等第三个。
//
// ⚠️ `label` 是进度上显示的名字 —— 用户要能看出"现在在哪一步"
//   （用户 2026-08-02：「不知道他是卡在这儿了，还是正在正常运行中」）。
async function callModelWithHeartbeat(ai, prompt, label, opts) {
  const o = opts || {};
  // ⚠️⚠️ **秒数在走 = 它活着**。一个不动的"正在写场景…"和卡死长得一模一样。
  //   ⚠️ 3 秒一跳而不是每秒 —— 每秒会把事件环刷满，而"它活着"3 秒粒度够了。
  let waited = 0;
  const tick = setInterval(() => {
    waited += 3;
    // ⚠️ `quiet` —— 这一条每 3 秒一次，打终端会把真正的事件冲掉
    genProgress(label, `已等 ${waited} 秒` + (o.hint ? `（${o.hint}）` : ''), true);
    // ⚠️⚠️ 但**每 30 秒往终端打一次** —— 完全不打的话，用户从终端看
    //   会觉得程序死了（而这个项目为"静默"栽过很多次）。
    //   ⟹ 状态在面板原地刷新，终端每 30 秒一个"还在跑"的锚点。
    if (waited % 30 === 0) console.log(`[gen] ${label}：已等 ${waited} 秒`);
  }, 3000);
  const t0 = Date.now();
  try {
    let out;
    try {
      out = await LLM.chat(ai, [{ role: 'user', content: prompt }],
        { maxTokens: o.maxTokens || 24000, timeoutMs: o.timeoutMs });
    } catch (error) {
      // ⚠️⚠️⚠️ **推理模型会把整个预算烧在思考上**（用户 2026-08-02 实测：
      //   69,841 字 reasoning_content、正文一个字没写、finish_reason=length）。
      //   我第一版的反应是"报错说清楚，让用户换模型" —— 而那**把唯一一条
      //   能自动救回来的路堵死了**：用户手上可能只有这一个 key。
      //   ⟹ 判据：**能自己救的失败不要转给用户。** 报错说得再清楚，
      //     也不如它自己成功。
      // ⚠️ 而**只重试这一种失败** —— 401/403/网络不通重试一百次也一样。
      if (!error.emptyBody && !error.truncated) throw error;
      const why = error.burnedOnThinking
        ? `思考烧了 ${error.reasoningChars} 字，正文没开始写`
        : '被长度上限截断';
      genProgress('模型想太多，让它少想再来一次', why);
      logEvent('gen', `重试（${label}）：${why} ⟹ 带 reasoning_effort=low 重发`);
      waited = 0;
      out = await LLM.chat(ai, [{ role: 'user', content: prompt }],
        { maxTokens: o.maxTokens || 24000, lessThinking: true, timeoutMs: o.timeoutMs });
    }
    return { text: out.text, ms: Date.now() - t0 };
  } finally {
    // ⚠️⚠️ **`finally` 里清** —— 上面每条 await 都可能抛，而漏清的话
    //   interval 会一直跳（面板上秒数永远在涨，而实际早已失败）
    //   ⟹ 那比没有进度更糟：它在说谎。
    //   ⚠️ 我第一版把 clearInterval 写在 await **之后**（不是 finally）——
    //     那在成功路径上对，在抛异常时漏。
    clearInterval(tick);
  }
}

// ⚠️⚠️⚠️ **生成一张壁纸 = 复制骨架 + 让模型写一个 scene.js**（0.9.140 重写）。
//
// 用户 2026-08-02 定的架构：**固定骨架 + 模型只填变化**，而理由是
//   「我们的第一要义就是我稳定生成高质量的壁纸」
// ⟹ 之前那版是"每次从空写整个 index.html"，实测三轮收敛出的是 300 行 canvas，
//   而参考壁纸（粒子效果_网易云监听）是作者 v1→v15 迭代出来的 1.26MB 打包产物。
//
// ⚠️⚠️ 而**防同质化**是另一条硬需求：
//   「我不希望同质化很严重，同一种风格的是允许的，但是每次生成给人感觉说
//     这不是一样的吗，这就不行」
//   ⚠️⚠️ 0.9.146 **拆掉了配方那套**（wallpaper-recipe.js 已删）：五维枚举 +
//     读历史避重 + 前三张固定配方。它的问题是每次目标都不一样 ⟹ 一次都收不敛，
//     而用户要的是「你把提示词调到能一次出那个效果，然后内置」。
//     ⟹ 多样性靠模型自己（同一套提示词下它每次的实现本来就不同），
//       不靠我们枚举维度。而**不做记忆**是用户明确要的（"先不做记忆系统"）。
ipcMain.handle('gen-wallpaper', async (_event, payload) => {
  const want = String((payload && payload.want) || '').trim();

  const ai = resolveAiConfig();
  if (!ai.apiKey) {
    return {
      ok: false,
      needsKey: true,
      error: '还没填 API key —— 在上面那个框里填一次就行（存在本机，不会上传）'
        + '\n\n⚠️ 或者从终端启动，让它读环境变量：'
        + '\n  export AWS_BEARER_TOKEN_BEDROCK=…（Bedrock 的长期 key）'
        + '\n  open -a DreamPaper 不行 —— 那还是 GUI 启动，读不到 shell 环境'
        + '\n  要用：/Applications/DreamPaper.app/Contents/MacOS/DreamPaper',
    };
  }

  // ⚠️⚠️ **骨架文件必须齐** —— 缺一个生成出来的壁纸就是白屏，
  //   而那时用户会以为是模型写坏了。⟹ 先检查，早失败。
  const skelDir = path.join(__dirname, '..', 'skeleton');
  const threeSrc = path.join(__dirname, 'vendor', 'three.r128.min.js');
  const missing = [];
  for (const f of ['index.html', 'runtime.js']) {
    if (!fs.existsSync(path.join(skelDir, f))) missing.push(`skeleton/${f}`);
  }
  // ⚠️ three.js **不在 git 里**（589KB，被 gitignore，靠 `npm run vendor` 拉）
  //   ⟹ 这条最可能缺，而它的症状是"壁纸全黑" ⟹ 必须显式说。
  if (!fs.existsSync(threeSrc)) missing.push('src/vendor/three.r128.min.js（跑 npm run vendor）');
  if (missing.length) {
    return { ok: false, error: `骨架文件缺了：${missing.join(' / ')}` };
  }

  // ── 配方：读已有壁纸的历史，挑一组避开它们
  const root = ensureOurWallpaperDir();

  // ⚠️⚠️⚠️ **没有"模式"这回事**（0.9.146）。用户 2026-08-03：
  //   「你理解错了，我说的这个是让你去调整提示词的方法…我们要复刻就是那个
  //     粒子效果通过一次把它复刻出来，我们这个就是你不断自己调整内置提示词吗？
  //     以后我说生成，你已经给我个预置提示词…然后我们再泛化，
  //     那这种类型的壁纸不就被我们拿下了吗？我是这个意思，什么复刻模式？不要这样」
  //
  // ⚠️⚠️ 我 0.9.145 把**我调提示词的方法**做成了运行时的状态机
  //   （前 3 张固定配方、第 4 张起随机）—— 那是把开发过程暴露成产品行为。
  //   ⟹ 判据：**"我怎么把它调好"和"用户点一下发生什么"是两件事。**
  //     调好了就内置成默认，不留档、不计数、不看历史张数。
  //
  // ⟹ 现在只有一条路：**内置的那套提示词**（`REFERENCE_SPEC` 里那些实测指标
  //   已经并进 COMPOSITION 和 buildPlanPrompt）。用户说一句话 ⟹ 出一张。
  //
  // ⚠️ 而**每次都是全新任务，不看历史**（用户同一条消息）：
  //   「我理解我们说一句话，然后是一次任务吗？一张壁纸，那我要做下一张壁纸呢，
  //     是不是不应该记忆留存的吧？应该从零开始，就是我们先不做记忆系统」
  //   ⟹ 判据：**没被要求的状态就别引入。** 记忆会让"这次为什么和上次不同"
  //     变成一个要查的问题，而现在它连问题都不是。
  const example = fs.readFileSync(path.join(skelDir, 'scene.example.js'), 'utf8');
  // ⚠️⚠️⚠️ **把骨架的真源码给模型**（0.9.145）。用户 2026-08-03：
  //   「我们这个壁纸渲染器本来就是我们做，所以代码相关的…也可以告诉我们的模型，
  //     这是我们很大的优势」
  //   ⟹ 之前给的是我手写的 `SKELETON_API` 摘要，而它已经漂了
  //     （漏了 MIN_DT / __dpScene / frameErrors 三样）。
  //   ⚠️ 判据：**手写摘要必然漂移，真源码不会。**
  const skeletonSource = Gen.readSkeletonSource();
  if (!skeletonSource) {
    // ⚠️ 读不到会退回摘要 —— 那能跑，但模型看的是二手信息
    //   ⟹ 必须说出来，否则这件事静默发生
    logEvent('gen', '⚠️ 读不到 skeleton/runtime.js ⟹ 退回手写摘要（模型看的是二手信息）');
  } else {
    logEvent('gen', `骨架源码 ${skeletonSource.length} 字节已喂给模型（不是摘要）`);
  }

  genProgress('开始', want ? want.slice(0, 40) : '（按内置的设计做一张）');

  // ⚠️ 目录名带时间戳 —— 同一句描述生成两次要是两个目录
  const stamp = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '');
  const dirName = Gen.slugifyTitle(want || 'wallpaper', stamp);
  // ⚠️⚠️⚠️ **两个目录**（0.9.142）：
  //   `stageDir` = AI 自己的工作区（userData/ai-staging/…）—— 中间产物写这儿
  //   `dir`      = 壁纸目录里的最终位置 —— **只有过了全部闸门才搬进去**
  //   ⟹ 那让"在做"和"能用"在物理上分开：失败的半成品不会出现在壁纸墙上。
  const stageDir = ensureStagingDir(dirName);
  const dir = path.join(root, dirName);
  logEvent('gen', `工作区：${stageDir}`);
  // ⚠️ 顺手清老的，留最近 5 个（失败那次的产物是唯一能回看"模型写了什么"的东西）
  const pruned = pruneStaging(5);
  if (pruned) logEvent('gen', `清掉 ${pruned} 个旧工作区`);

  // ⚠️ 单轮等模型的上限。⚠️ 比 llm.js 的默认 300 秒短 ——
  //   三轮 × 300 秒 = 15 分钟，那对"我说一句话你给我一张壁纸"太久了。
  const GEN_TIMEOUT_MS = 150000;
  const MAX_ROUNDS = 3;
  // ⚠️⚠️ **记住上一轮报了什么** —— 同一个 id 连着出现说明改的方向不对，
  //   而那时要明说"上一轮那样改没用"（见 buildRepairPrompt 那段判据）。
  //   ⚠️ 用户 2026-08-03 那次：三轮都在修，读数 12/9/6 一动没动 ——
  //     因为回喂给的是现象（"太暗"）而不是根因（"删了灯还用需光材质"）。
  let prevIds = [];
  let repeatedIds = [];
  let code = null;
  let problems = [];
  const history_ = [];

  let plan = '';

  try {
    // ═══════════════════════════════════════════════════════════════════
    //  ⚠️⚠️⚠️ **第 1 步：设计**（0.9.142）。用户 2026-08-02：
    //    「一次有偷看上限，说明他一次干不下来这个活，那我们都已经有骨架了，
    //      完全可以把这个活做拆分吗？多用几次模型就 OK 了呀，然后有一个 AI
    //      自己的工作区中间文件到文档留存方便，就是一步一步可以衔接上就行了呀」
    //
    //  ⟹ 设计和实现分成两次调用：这一步只输出**文字**（几百 token），
    //    不写代码 ⟹ 预算烧不掉；下一步拿着它写代码，不用再做设计决定。
    //  ⚠️ 而 `plan.md` **落在工作区里** ⟹ 失败时能回看"它到底想了什么"，
    //    那是唯一能区分"设计就跑偏了"和"设计对但代码写错了"的东西。
    // ═══════════════════════════════════════════════════════════════════
    genProgress('第 1 步：设计这一张长什么样', want ? want.slice(0, 30) : '按内置设计');
    const planOut = await callModelWithHeartbeat(ai,
      Gen.buildPlanPrompt(want),
      '第 1 步：设计这一张长什么样',
      // ⚠️ 设计只要几百字 ⟹ 预算给 4000 就够，而**小预算也让它快**
      //   （推理模型在小预算下会自己收敛，不会长篇大论）。
      { maxTokens: 4000, timeoutMs: GEN_TIMEOUT_MS, hint: '通常 10-30 秒' });
    plan = String(planOut.text || '').trim();
    if (plan.length < 80) {
      // ⚠️ 设计太短说明这一步失败了（模型只回了一句话）⟹ 早停，
      //   别拿一份空规格书去写代码（那等于回到"一次干两件事"）。
      throw new Error(`设计这一步没给出内容（只有 ${plan.length} 字）：${plan.slice(0, 200)}`);
    }
    // ⚠️ 落盘 —— 这是"AI 自己的工作区"里第一份中间产物
    fs.writeFileSync(path.join(stageDir, 'plan.md'),
      `# ${want || '（没特别要求）'}\n\n${plan}\n`);
    logEvent('gen', `设计：${plan.length} 字、${Math.round(planOut.ms / 1000)}s`
      + ` ⟹ 写到 ${path.join(stageDir, 'plan.md')}`);
    genProgress('设计好了', `${plan.length} 字 · ${Math.round(planOut.ms / 1000)}s`);

    for (let round = 1; round <= MAX_ROUNDS; round += 1) {
      const isRepair = round > 1;
      genProgress(isRepair ? `第 ${round} 轮：按检查结果修` : '正在写场景',
        isRepair ? `上一轮 ${problems.length} 个问题` : '照 plan.md 翻译成代码');

      // ⚠️⚠️ **等模型这段要报"已经等了多久"**。用户 2026-08-02：
      //   「这个生成比较耗时间啊，你现在就我看到了，他现在就是这样，
      //     不知道他是卡在这儿了，还是正在正常运行中」
      //   ⟹ 一个不动的"正在写场景…"和卡死**长得一模一样**。
      //   ⟹ 判据：**长任务的进度必须是变化的东西**（秒数在走 = 它活着），
      //     而不是一句静态文案。
      //   ⚠️ 3 秒一跳而不是每秒 —— 每秒会把事件环刷满，而"它活着"这个信息
      //     3 秒的粒度完全够。
      const prompt = isRepair
        ? Gen.buildRepairPrompt(code, problems, { repeated: repeatedIds })
        : Gen.buildImplementPrompt(plan, example, skeletonSource);
      const out = await callModelWithHeartbeat(ai, prompt,
        isRepair ? `第 ${round} 轮：按检查结果修` : '第 2 步：照设计写代码',
        { timeoutMs: GEN_TIMEOUT_MS, hint: '通常 40-90 秒' });
      const ms = out.ms;
      code = Gen.extractScene(out.text);
      const lines = code.split('\n').length;
      genProgress('检查代码', `${lines} 行 · ${Math.round(ms / 1000)}s`);
      logEvent('gen', `第 ${round} 轮：${lines} 行、${Math.round(ms / 1000)}s`);

      // ── ① 机器闸门（纯函数，有测试）
      problems = Gen.inspect(code, { checkJsSyntax });
      for (const x of problems) logEvent('gen', `闸门：[${x.id}] ${x.detail.slice(0, 120)}`);

      // ── ①b⚠️⚠️ **设计检查**（0.9.145）：元素多不多 / 视角高不高 / 动态几种。
      //   ⚠️ 这三条从像素测不出来（俯视和低视角在三带亮度上可以完全一样），
      //     但**能从代码里读** ⟹ 判据：能从代码读的就别猜像素。
      //   ⚠️ 它是**软的**：进 problems 触发下一轮修，但最后一轮之后仍然落盘。
      const designProblems = Gen.inspectDesign(code);
      for (const x of designProblems) logEvent('gen', `设计：[${x.id}] ${x.detail.slice(0, 150)}`);
      // ⚠️⚠️ 硬问题优先 —— 有硬问题时**不带上软的**：
      //   一次回喂里塞七条，模型会挑容易的改。而硬问题不修掉这张壁纸根本跑不起来。
      //   ⟹ 判据：**回喂要聚焦** —— 先让它能跑，再让它好看。
      if (!problems.length && designProblems.length) {
        problems = designProblems;
      }

      if (problems.length && problems.some((x) => !String(x.id).startsWith('C-'))) {
        const ids = problems.map((x) => x.id);
        repeatedIds = ids.filter((id) => prevIds.includes(id));
        if (repeatedIds.length) {
          logEvent('gen', `⚠️ 这些问题上一轮改过但没解决：${repeatedIds.join(' / ')}`);
        }
        prevIds = ids;
        history_.push({ round, lines, problems: ids });
        continue;
      }
      // ⚠️ 只剩软问题（设计层）⟹ **继续落盘 + 真跑**，让构图判定也参与，
      //   然后把两边的软问题一起回喂。那样一轮修能同时改设计和构图。
      const softFromCode = problems.filter((x) => String(x.id).startsWith('C-'));

      // ── 落盘到**工作区**（不是壁纸目录）
      writeWallpaperFiles(stageDir, code, want, dirName, skelDir, threeSrc);

      // ── ② 真跑闸门
      genProgress('试跑 3 秒', '看 WebGL 有没有真的画出东西');
      const probe = await probeWallpaperRuntime(stageDir);
      logEvent('gen', `试跑：${probe.frames} 帧 / ${probe.ms}ms`
        + ` · WebGL ${probe.webgl ? (probe.webgl.context ? 'ok' : '没建起来') : '?'}`
        + ` · 对象 ${probe.webgl ? probe.webgl.objects : '?'}`
        + ` · glError ${probe.webgl ? probe.webgl.glError : '?'}`
        + (probe.sampledPixels ? ` · 近黑 ${probe.sampledPixels.black}/${probe.sampledPixels.total}` : '')
        + (probe.errors.length ? ` · 报错 ${probe.errors.length} 条` : ''));
      for (const e of probe.errors) logEvent('gen', `试跑报错：${String(e).slice(0, 200)}`);

      problems = Gen.judgeRuntime(probe);
      // ⚠️⚠️⚠️ **构图判定**（0.9.145）—— "好不好看"里能机器判的那部分。
      //   ⚠️ 它是**软的**：进 problems（会触发下一轮修），但最后一轮之后
      //     **仍然落盘** —— 构图是审美，判错了不该让用户拿不到壁纸。
      //   ⚠️ 而它的价值在**回喂具体数字**：模型拿到"近黑只有 5%（该 20-45%）"
      //     能真的改，而"不好看"它改不了。
      const compProblems = Gen.judgeComposition(probe);
      if (compProblems.length) {
        logEvent('gen', `构图：${compProblems.map((x) => x.id).join(' / ')}`);
        for (const x of compProblems) logEvent('gen', `构图判定：[${x.id}] ${x.detail.slice(0, 160)}`);
      }
      // ⚠️ 硬问题排在前面 —— 回喂时模型先看到"会坏"的那些
      //   ⚠️⚠️ 而软问题来自**两处**：代码层（inspectDesign）+ 像素层（judgeComposition）
      //     ⟹ 合起来回喂，那样一轮修能同时改设计和构图。
      problems = [...problems, ...softFromCode, ...compProblems];
      // ⚠️ 算"这一轮还在的、上一轮也报过的" ⟹ 下一轮的提示词里点名它们
      const nowIds = problems.map((x) => x.id);
      repeatedIds = nowIds.filter((id) => prevIds.includes(id));
      if (repeatedIds.length) {
        logEvent('gen', `⚠️ 这些问题上一轮改过但没解决：${repeatedIds.join(' / ')}`
          + ' ⟹ 下一轮会明说"别再微调同一个地方"');
      }
      prevIds = nowIds;
      history_.push({ round, lines, probe, problems: problems.map((x) => x.id) });
      if (!problems.length) {
        // ── ④ 预览图：把试跑那一帧存下来（网格卡片要它）
        //   ⚠️ 在**工作区**里生成 —— 搬进去的时候一起带过去
        await savePreview(stageDir);
        // ── ⑤⚠️⚠️ **搬进壁纸目录 —— 这一步才让它生效**
        //
        // ⚠️⚠️ 而**先把 plan.md 留一份在工作区**（0.9.143）。用户 2026-08-02：
        //   「open ~/Library/…/ai-staging/ 这里面没东西」
        //   ⟹ 成功之后整个目录被 rename 走了 ⟹ 工作区是空的。
        //     那**行为是对的**（不留垃圾），但它把"能回看模型怎么想的"也搬走了。
        //   ⟹ 判据：**中间产物的价值在"失败和不满意时能查"**，
        //     而"不满意"恰恰发生在成功之后（用户 2026-08-02：
        //     「最终出了一个壁纸，但是这个壁纸不好看」）。
        //   ⟹ 留一份轻量的（几 KB 的 md），不留整个目录。
        try {
          const keep = path.join(aiStagingDir(), `${dirName}.plan.md`);
          fs.copyFileSync(path.join(stageDir, 'plan.md'), keep);
          logEvent('gen', `设计说明留档：${keep}`);
        } catch (error) {
          // ⚠️ 留档失败不该挡住"这张壁纸能用" ⟹ 只记一句
          logEvent('gen', `设计说明留档失败（不影响壁纸）：${error.message}`);
        }
        const moved = promoteFromStaging(stageDir, dir);
        logEvent('gen', `搬进壁纸目录（${moved.method}）：${dir}`);
        genProgress('done', `${dirName} —— ${round} 轮通过`);
        return { ok: true, dir, dirName, rounds: round, history: history_ };
      }
      for (const x of problems) logEvent('gen', `试跑判定：[${x.id}] ${x.detail.slice(0, 120)}`);
    }

    // ⚠️⚠️ 三轮还没过 —— **仍然落盘并交给用户**，不是丢掉。
    //   判据：闸门是"必然出事"的清单，而剩下的问题可能只影响某个细节。
    //   ⟹ 让用户自己看一眼再决定，比我替他扔掉好。但**必须说清还剩什么**。
    // ⚠️⚠️⚠️ **三轮还没过 ⟹ 留在工作区，不搬进壁纸目录。**
    //
    //   0.9.141 是"仍然落盘并交给用户"，理由是"闸门是必然出事的清单，
    //   剩下的问题可能只影响某个细节"。⚠️ 而那个理由**错了**：
    //   走到这里的 problems 是**真跑之后**的判定（一帧没画 / WebGL 报错 /
    //   画面全黑）—— 那不是"某个细节"，是这张壁纸放上去就是黑的。
    //   ⟹ 用户点开它只会看到白屏，而那时他会以为是软件坏了。
    //
    //   ⟹ 判据：**闸门没过就是没过。** "交给用户自己看"听起来尊重用户，
    //     实际是把我们判定不了的东西推给他 —— 而这次我们判定得很清楚。
    //   ⚠️ 但**产物留着**（在工作区里，路径报出去）⟹ 想看能看，不占壁纸墙。
    if (code && !fs.existsSync(path.join(stageDir, 'scene.js'))) {
      writeWallpaperFiles(stageDir, code, want, dirName, skelDir, threeSrc);
    }

    // ⚠️⚠️⚠️ **只剩构图问题 ⟹ 照样交付**（0.9.145）。
    //   构图判定是**软的**：它判的是审美，而审美判错了不该让用户拿不到壁纸
    //   （"C-上方太亮"在有意做成亮色调的壁纸上就是误报）。
    //   ⟹ 判据：**硬闸门拦"必然出事"（黑屏/报错/不动），软判定只提示。**
    //     而三轮之后还剩软问题 = 模型没改到位，那时把**数字**告诉用户，
    //     让他自己看一眼 —— 他的眼睛是第三层闸门。
    const hard = problems.filter((x) => !String(x.id).startsWith('C-'));
    if (!hard.length) {
      await savePreview(stageDir);
      try {
        const keep = path.join(aiStagingDir(), `${dirName}.plan.md`);
        fs.copyFileSync(path.join(stageDir, 'plan.md'), keep);
      } catch { /* 留档失败不影响交付 */ }
      const moved = promoteFromStaging(stageDir, dir);
      logEvent('gen', `只剩构图问题（${problems.length} 条）⟹ 照样交付（${moved.method}）`);
      genProgress('done', `${dirName} —— 能跑，构图还有 ${problems.length} 处可改`);
      return {
        ok: true,
        softOnly: true,
        dir,
        dirName,
        rounds: MAX_ROUNDS,
        problems,
        history: history_,
        note: `能跑，但构图上还有 ${problems.length} 处和参考壁纸不一样：\n`
          + problems.map((x) => `· ${x.detail.split('⟹')[0].trim()}`).join('\n')
          + '\n\n先看一眼 —— 能接受就用，不行再说一遍要求重生成。',
      };
    }

    genProgress('failed', `${MAX_ROUNDS} 轮还有 ${hard.length} 个硬问题`);
    return {
      ok: false,
      stageDir,
      dirName,
      rounds: MAX_ROUNDS,
      problems,
      history: history_,
      error: `跑了 ${MAX_ROUNDS} 轮，还剩 ${problems.length} 个问题没修掉`
        + `（${problems.map((x) => x.id).join(' / ')}）`
        + '\n⟹ 没放进壁纸目录 —— 那样的壁纸装上去是黑的。'
        + '\n再说一遍要求（换个说法）会重新生成一张，配方也会换。'
        + `\n\n中间产物留在：${stageDir}`,
    };
  } catch (error) {
    genProgress('failed', error.message);
    logEvent('gen', `失败：${error.message}`);
    // ⚠️ 带上工作区路径 —— 那是"模型到底写出了什么"唯一能回看的地方
    return { ok: false, error: error.message, history: history_, stageDir };
  }
});

// 把一张生成好的壁纸落到目录里（骨架 + scene.js + project.json）。
//
// ⚠️⚠️ **写入只发生在这一个函数里**，而 `dir` 只可能是
//   `ensureOurWallpaperDir()` 下面的一层（目录名过了 `Gen.slugifyTitle`，
//   它会把 `../` 之类全洗掉 —— 见 gen.test.js 那 9 条穿越用例）。
//   用户 2026-08-02：「注意写入的地方只能是我们限定的壁纸那个目录，
//     不能做什么危险操作，危害电脑」
//   ⟹ 判据：**收口成一个函数**，那样"会写到哪"是看一眼就能回答的问题，
//     而不是散在两处、下次改动漏掉一处。
function writeWallpaperFiles(dir, code, want, dirName, skelDir, threeSrc) {
  fs.mkdirSync(path.join(dir, 'vendor'), { recursive: true });
  fs.copyFileSync(path.join(skelDir, 'index.html'), path.join(dir, 'index.html'));
  fs.copyFileSync(path.join(skelDir, 'runtime.js'), path.join(dir, 'runtime.js'));

  // ⚠️⚠️ three.js 用**硬链接**而不是复制 —— 589KB × N 张壁纸很快就是几十 MB。
  //   ⚠️ 而硬链接跨卷会失败（EXDEV），壁纸目录和应用资源可能不同卷
  //   ⟹ 失败就退回复制（那只是占空间，不影响功能）。
  const threeDst = path.join(dir, 'vendor', 'three.min.js');
  try {
    if (fs.existsSync(threeDst)) fs.unlinkSync(threeDst);
    fs.linkSync(threeSrc, threeDst);
    logEvent('gen', 'three.js 硬链接成功（不占额外空间）');
  } catch (error) {
    fs.copyFileSync(threeSrc, threeDst);
    logEvent('gen', `three.js 硬链接失败（${error.code}）⟹ 改成复制 589KB`);
  }

  fs.writeFileSync(path.join(dir, 'scene.js'), code);
  // ⚠️ `gwGenerated` 标记"这张是 AI 生成的" —— 面板上要能分辨，出问题时
  //   知道该去看生成记录。
  //   ⚠️ 0.9.146 起**不再写 gwRecipe**：没有配方这个概念了（见上面那段判据）。
  fs.writeFileSync(path.join(dir, 'project.json'),
    JSON.stringify(Gen.buildProjectJson(want.slice(0, 40) || dirName, want), null, 2));
  logEvent('gen', `落盘：${dir}（scene.js ${code.length} 字节）`);
}

// ⚠️⚠️⚠️ **AI 凭证的两条来源**（0.9.142）。用户 2026-08-02：
//   「模型，我感觉就是可以使用 claude 的 /home/moon/.bashrc 这里不就是配置，
//     我在本地电脑也配置一下不就好」
//
// 他云端那份 `.bashrc` 里就是这三个：
//   CLAUDE_CODE_USE_BEDROCK / AWS_BEARER_TOKEN_BEDROCK / AWS_REGION
// ⟹ 而那正好是我们 Bedrock 那条路要的东西（bearer token，不是 AK/SK）。
//
// ⚠️⚠️ 但**GUI 点图标启动的 app 读不到 `.zshrc`/`.bashrc`** ——
//   那是 shell 启动时才加载的文件，Finder/launchd 不读它。
//   ⟹ 症状会是"我明明配了啊"而面板说没填 key。
//   ⟹ 判据：**环境变量只能当"从终端启动时的便利"，不能当唯一来源。**
//     所以是两条：环境变量（终端启动自动带上）+ 面板输入框（点图标也能用）。
//
// ⚠️ 优先级：**面板里填过的赢** —— 那是用户明确的、最近的动作，
//   而环境变量可能是几个月前配的、早过期了。
// ⚠️ 而这个函数**不打印 token 的任何一部分**（连前几位都不打）——
//   诊断报告是要发给别人看的，见 `redactConfig`。
function resolveAiConfig() {
  const saved = (config.we && config.we.ai) || {};
  const env = process.env;

  // 面板里填过 ⟹ 直接用，不看环境变量
  if (saved.apiKey) return saved;

  // ⚠️ Bedrock 那条：bearer token + region
  const token = env.AWS_BEARER_TOKEN_BEDROCK;
  if (token) {
    return {
      ...saved,
      provider: 'bedrock',
      apiKey: token,
      region: saved.region || env.AWS_REGION || 'us-west-2',
      // ⚠️ 模型 ID 给个能用的默认 —— 环境变量里没有它，
      //   而让用户为了"我已经配好了"再去填一个模型 ID 很怪。
      model: saved.model
        || env.DREAMPAPER_AI_MODEL
        || 'us.anthropic.claude-opus-4-8',
      // ⚠️ 标记来源 ⟹ 面板上要说清"这次用的是环境变量里那个"，
      //   否则用户会以为面板那个空框是个 bug。
      fromEnv: 'AWS_BEARER_TOKEN_BEDROCK',
    };
  }

  // ⚠️ OpenAI 兼容那条（DeepSeek 等）
  const openaiKey = env.DREAMPAPER_AI_KEY || env.OPENAI_API_KEY || env.DEEPSEEK_API_KEY;
  if (openaiKey) {
    return {
      ...saved,
      provider: 'openai',
      apiKey: openaiKey,
      baseUrl: saved.baseUrl || env.DREAMPAPER_AI_BASE
        || (env.DEEPSEEK_API_KEY ? 'https://api.deepseek.com' : 'https://api.openai.com/v1'),
      model: saved.model || env.DREAMPAPER_AI_MODEL || 'deepseek-chat',
      fromEnv: env.DREAMPAPER_AI_KEY ? 'DREAMPAPER_AI_KEY'
        : (env.DEEPSEEK_API_KEY ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY'),
    };
  }

  return saved;
}

// ⚠️ 面板要能"先测一下通不通"，而不是把连通性问题混在生成失败里
//   （生成失败有十几种原因，而"key 填错了"应该 3 秒内就知道）。
ipcMain.handle('gen-ping', async () => {
  const ai = resolveAiConfig();
  if (!ai.apiKey) return { ok: false, error: '还没填 API key' };
  try {
    const out = await LLM.ping(ai);
    // ⚠️⚠️ `thinks` 那几个字段要透到面板去（0.9.126）——
    //   用户 2026-08-02 撞到的：探针通了但生成返回空，因为模型是推理型的、
    //   把 16000 输出 token 全烧在思考上。⟹ 探针现在能提前说这件事。
    return {
      ok: true, reply: out.reply, model: ai.model,
      thinks: out.thinks, reasoningChars: out.reasoningChars,
      outputTokens: out.outputTokens, finish: out.finish,
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// ⚠️⚠️ **右栅宽度分档**（0.9.141）。
//
// ⚠️ 挡位**不是固定三个**，是"当前窗口宽度允许的那几个" ——
//   用户点名要"壁纸的最小容量宽度"，而 900px 窗口下右栅 580 会让壁纸区
//   只剩 280px（一列）⟹ 壁纸墙失去意义。
//   ⟹ 算过：窗口 900 只允许 340；1200 起三档都行。
// ⚠️ 判据：**约束是"壁纸区不能太窄"，而挡位是那个约束的结果** ——
//   写死三个按钮的话小窗口上会有一个点不动的按钮（那比没有更糟）。
const SIDE_STEPS = [340, 460, 580];
const GRID_MIN = 460;            // 壁纸区最小宽度（用户点名的那条）
ipcMain.handle('we-set-side-width', (_event, width) => {
  const w = Number(width);
  if (!SIDE_STEPS.includes(w)) return { ok: false, error: `不是挡位：${width}` };
  config.we.sideWidth = w;
  writeConfig();
  broadcast('config', config);
  return { ok: true, sideWidth: w };
});

ipcMain.handle('gen-set-key', (_event, apiKey) => {
  config.we.ai = { ...(config.we.ai || {}), apiKey: apiKey || null };
  writeConfig();
  return { ok: true, hasKey: !!apiKey };
});

// 面板打开时要知道：工作目录在哪、key 填了没。
// ⚠️ 用户点名要显示工作目录（「他上面会显示一下我的工作目录在哪儿」）——
//   那是"生成的东西去哪了"这个问题的答案，而不显示的话它是个黑盒。
ipcMain.handle('gen-meta', () => ({
  dir: ensureOurWallpaperDir(),
  // ⚠️ 挡位和最小宽度交给面板算 —— 它才知道当前窗口多宽
  sideSteps: SIDE_STEPS,
  gridMin: GRID_MIN,
  sideWidth: (config.we && config.we.sideWidth) || 340,
  // ⚠️⚠️ 已有配方的历史 —— 面板上要能说"这张和那张撞了几维"
  //   （用户说"这两张太像了"时，不用靠感觉调）
  // ⚠️ 环境变量里有也算"有 key" —— 否则面板会说"还没填"而它其实能用
  hasKey: !!resolveAiConfig().apiKey,
  // ⚠️ 而要说清是**哪来的** —— 用户看到空输入框会以为是 bug
  keyFromEnv: resolveAiConfig().fromEnv || null,
  // ⚠️ **key 也回填** —— 这个项目刚为"每次打开都要重填"栽过一轮（0.9.122）。
  //   判据：能保存的字段就要能回填，否则用户没法确认它存了没有。
  apiKey: (config.we.ai && config.we.ai.apiKey) || '',
  model: (config.we.ai && config.we.ai.model) || '',
}));

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
    // ⚠️⚠️⚠️ **最近一次 track 的原始字段**（0.9.116）。
    //
    // 用户 2026-08-02：封面和歌手对了，**而进度还是不同步**。而那三个来自
    // **同一个对象**（`__mediaState`）⟹ 问题只在 `position` 那一个值上。
    //
    // ⚠️⚠️ 而我为字段名连栽四次（artwork / 语音的「点」/ position / 这一次），
    //   每次都在**推断 media-control 给什么**，而**从来没有一个地方能看到它
    //   真的给了什么**。这就是那个缺口。
    //   ⟹ 把原始字段名和值直接放进诊断报告：一眼看出
    //     `elapsedTime` 在不在、单位是秒还是毫秒、值有没有在动。
    // ⚠️ 封面那个 base64 要剥掉（几百 KB，而且报告是要发给别人看的）——
    //   只留"有没有"和长度。
    lastTrack: lastTrack ? (() => {
      const out = {};
      for (const [k, v] of Object.entries(lastTrack)) {
        if (k === 'artworkData') { out[k] = `<${String(v || '').length} 字节 base64>`; continue; }
        out[k] = v;
      }
      // ⚠️ 同时给出**我们翻译后**的值 —— 两边并排才看得出是哪一步错的
      out['→ 我们发给壁纸的'] = WE.mediaStatePayload(lastTrack);
      return out;
    })() : '（没在放歌，或者 media-control 不可用）',
    // **音频原始帧**：最近 60 帧的 128 段序列 + 孤峰统计。
    //
    // 为什么在报告里而不是面板上：孤峰要看**连续的段**（"比左右邻居高 30%"），
    // 而面板只报 9 个抽样点 => 看不出孤峰。而我在云端合成信号复现失败过
    //（合成的谱有 45/64 段踩地板，用户实测一个 0 都没有）
    // => 判"孤峰是不是真的"只能用真实帧。
    audioFrames: rawFrames.length ? {
      count: rawFrames.length,
      // 孤峰：比左右邻居都高 30% 以上。统计它在 60 帧里**出现的稳定性** ——
      // 每帧都在同一段 = 结构性问题；位置乱跳 = 音乐本身的瞬态。
      spikes: (() => {
        const bySeg = new Map();
        for (const f of rawFrames) {
          for (let i = 1; i < 63; i += 1) {
            if (f[i] > f[i - 1] * 1.3 && f[i] > f[i + 1] * 1.3 && f[i] > 0.15) {
              const e = bySeg.get(i) || { seg: i, n: 0, maxV: 0, sample: null };
              e.n += 1;
              if (f[i] > e.maxV) {
                e.maxV = f[i];
                e.sample = [f[i - 2], f[i - 1], f[i], f[i + 1], f[i + 2]];
              }
              bySeg.set(i, e);
            }
          }
        }
        return [...bySeg.values()].sort((x, y) => y.n - x.n).slice(0, 12);
      })(),
      // 有多少段踩地板（输出恒 0）—— 折线壁纸下那是"平地拔起的刺"的成因
      floorSegs: (() => {
        const counts = new Array(64).fill(0);
        for (const f of rawFrames) {
          for (let i = 0; i < 64; i += 1) if (f[i] === 0) counts[i] += 1;
        }
        return {
          alwaysZero: counts.filter((c) => c === rawFrames.length).length,
          everZero: counts.filter((c) => c > 0).length,
        };
      })(),
      // 前 3 帧的完整序列 —— 让我能在云端重放，而不是再合成一个假信号
      raw: rawFrames.slice(0, 3),
    } : null,
    app: {
      version: app.getVersion(),
      // ⚠️⚠️ **完整 build 标识**（版本 + commit + 打包与否），0.9.121 加。
      //   面板右上角那行版本标识删掉之后，这里是"报告里能看出跑的是哪一版"的
      //   唯一地方 —— 而 `version` 单独不够：版本号不变时改了几轮 commit 分辨不出，
      //   而这个项目为"测了旧版本"栽过两次。
      build: buildStamp(),
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
      // 摄像头搬进骨架层了,没有独立的 sensor 窗口 —— 报骨架层的状态。
      sensor: !!(overlayWindow && !overlayWindow.isDestroyed()),
      strategy: currentStrategy ? currentStrategy.id : null,
      weStrategy: config.we.strategy,
      // 实际拿到的窗口尺寸 vs 屏幕尺寸 —— 菜单栏那条缝就是这里看出来的。
      display: screen.getPrimaryDisplay().bounds,
      weBounds: weWindow && !weWindow.isDestroyed() ? weWindow.getBounds() : null,
      // ⚠️ 菜单栏那条缝：覆盖到底成没成，试了几次，还差多少。
      // 那条缝用户看得见但查不到原因，所以核对结果必须进报告。
      menuBar: menuBarState,
    },
    we: { ready: weReady },
    video: videoStatus,
    audio: audioStatus,
    mouse: {
      status: mouseStatus, lastEvent: lastMouseEvent, injected: mouseInjected,
      // ⚠️ 页面那边有没有真的收到，只能由页面自己报 —— 见下面的探针。
      pageSaw: pageMouseSeen,
    },
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
    // ⚠️ API key 也是凭证 —— 泄漏了别人能用你的额度、而且它绑在你账号上。
    if (copy.we.steam.apiKey) copy.we.steam.apiKey = '***';
  }
  // ⚠️⚠️ **AI 那个 key 同样要打码**（0.9.123）。它是 Bedrock 的长期凭证，
  //   泄漏了别人能用你的额度调模型。而诊断报告是**要发给别人看的**
  //   ⟹ 漏一个字段就等于把 key 贴出去了。
  //   ⚠️ region/model 不打码 —— 那两个不是秘密，而且"用的哪个模型"
  //     正是排查生成质量时要看的东西。
  if (copy.we && copy.we.ai && copy.we.ai.apiKey) copy.we.ai.apiKey = '***';
  return copy;
}

// 在 Finder 里打开一个壁纸目录（或定位到某个壁纸）。
//
// ⚠️ 用户要的：「我的壁纸这里要能够点开，比如 wallpaper 就是在资源管理器中打开，
// 我要能进到那个目录，看到我的壁纸文件」。
//
// ⚠️ 这不是"顺手加的便利" —— 它是这个产品缺的一环：
// 壁纸是**文件**，而用户对文件的直觉操作是"在 Finder 里看看"。
// 之前面板上连路径都是纯文本，复制出来还得自己去 Finder 粘贴。
ipcMain.handle('reveal-wallpaper-dir', (_event, target) => {
  // 没给路径 = 打开我们自己的壁纸目录（"我的壁纸放哪"这个问题的答案）。
  const dir = target || ensureOurWallpaperDir();
  if (!fs.existsSync(dir)) {
    return { ok: false, error: `目录不存在：${dir}` };
  }
  // ⚠️ openPath 而不是 showItemInFolder：前者**进入**目录，后者只是选中它。
  // 用户说的是"我要能进到那个目录，看到我的壁纸文件" ⟹ 要进去。
  const problem = shell.openPath(dir);
  // openPath 返回 Promise<string>，空字符串 = 成功。
  return Promise.resolve(problem).then((err) => (err
    ? { ok: false, error: err }
    : { ok: true, dir }));
});

// 我们自己的壁纸目录路径（面板要显示它，而且要能点开）。
ipcMain.handle('our-wallpaper-dir', () => ({ ok: true, dir: ensureOurWallpaperDir() }));

ipcMain.handle('reveal-diagnostics', () => {
  const dir = path.join(app.getPath('userData'), 'diagnostics');
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
  return { ok: true, dir };
});

ipcMain.handle('we-status', () => ({
  ...weStatus(null), audio: audioStatus, video: videoStatus,
  mouse: {
    status: mouseStatus, injected: mouseInjected,
    lastEvent: lastMouseEvent, pageSaw: pageMouseSeen,
  },
}));

// ---------------------------------------------------------------------------
// 鼠标转发：让真壁纸层也能收到鼠标
// ---------------------------------------------------------------------------
let mouseTap = null;
let mouseStatus = null;
// 最近一次转发的事件，进诊断报告。
// ⚠️ 没有它，"点了没反应"分不清是：helper 没抓到 / 坐标算错 / 注入了但页面不响应。
let lastMouseEvent = null;
// 注入计数。⚠️ "点了没反应"现在有三种可能，而它们长得一样：
//   ① helper 没抓到事件（转发压根没起来）
//   ② 抓到了、坐标算错，注到窗口外
//   ③ 注进去了，但页面不响应（比如它只听 pointerdown 而我们注的是 mouseDown）
// 计数 + 最近一次的坐标能把 ①② 排掉，剩下的就是 ③。
let mouseInjected = 0;
// 页面那边实际收到了什么（we-preload 的探针报的）。
// ⚠️ 这是分辨"注进去了但页面不响应"的唯一证据 —— 尤其
// "mousedown 收到了但 pointerdown 没有"直接说明是事件族的问题。
let pageMouseSeen = null;

// ---------------------------------------------------------------------------
// ⚠️⚠️⚠️ 这里原来是**权限面板**（0.9.90~0.9.104）—— **0.9.105 整块删了。**
//
// 用户 2026-08-02：「设置这里的权限展示还是有问题，删掉这里的展示吧，没啥用，
//   我们把功能调通就行」
//
// **他说得对，而这是我改了六版还在错的东西：**
//   0.9.90  建了它，六行，每行带我们自己的开关
//   0.9.91  辅助功能两条合一条（他："为什么辅助功能有两个？"）
//   0.9.94  撤掉子开关 + 删掉「自动化」那行（他："那你显示啥呢？删掉这块"）
//   0.9.95  撤掉摄像头/麦克风的开关，改成只读（他："不是我们自己设置的开关"）
//   0.9.102 辅助功能那行读错了 helper，一直显示"未授权"（他："还是显示未授权"）
//   0.9.103 删掉麦克风那行 —— 那条链根本不需要授权，是我编的
//
// ⚠️⚠️ 六版都是他指出来我才改，而每一版我都以为"这次对了"。
//   根因不是某个字段写错，是**这个面板要回答的问题我一直没搞清**：
//   它想说"你有什么权限"，而用户真正想知道的是"我的功能能不能用"。
//   那两件事在这个产品里**几乎不重合** —— 探针最后证明：流星不需要授权、
//   系统声音不需要授权，真正要授权的两条（摄像头/手势控光标）**开了就会自己弹框**。
//   ⟹ 一个面板，六版，回答的是一个用户不需要问的问题。
//
// ⟹ 删掉。授权这件事回归 macOS 自己的机制：**要用到时它自己弹框**。
//   而"某个功能为什么不工作"由各自的诊断段回答（面板「?」页里那些）。
//
// ⚠️ 别再加回来。要加之前先回答：**用户看了它之后会做什么？**
//   如果答案是"什么都不用做"，那它就不该存在。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 清掉 0.9.88 之前那些带 hash 名的 helper 二进制
// ---------------------------------------------------------------------------
// ⚠️⚠️ 它们叫 `GestureWallMouse-1635ebad82ad` 这种，而**每改一次 .swift 源码就多
// 一个** —— 用户机器上现在躺着好几代。而真正的害处不是占空间：
//   **每一个都是系统授权列表里的一条**（TCC 按可执行文件记授权）
//   ⟹ 用户打开「隐私与安全性 → 辅助功能」看到一堆 `GestureWallMouse-xxxx`，
//     完全分不清哪个是当前在跑的那个。
//
// ⚠️ 而删文件**不会**把 TCC 里那些条目删掉（那要 tccutil，而它只认 bundle id、
//   对这些裸二进制无能为力）—— 那些条目会显示成灰色/失效项，得用户自己在列表里
//   点减号删。我们能做的是**不再产生新的**，并且把文件删掉止损。
//
// ⚠️ 只删**我们自己**在 userData/native 和 userData 下按那个规则生成的东西 ——
//   正则钉死了四个 helper 名 + 12 位十六进制后缀，不碰任何别的文件。
const LEGACY_HELPER_RE = /^(AirCursorPointer|AirCursorVoice|GestureWallMouse|GestureWallAudio)-[0-9a-f]{12}$/;

function cleanLegacyHelpers() {
  if (process.platform !== 'darwin') return;
  let removed = 0;
  for (const dir of [app.getPath('userData'), path.join(app.getPath('userData'), 'native')]) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }   // 目录不存在就算了
    for (const name of names) {
      if (!LEGACY_HELPER_RE.test(name)) continue;
      try { fs.unlinkSync(path.join(dir, name)); removed += 1; } catch { /* 删不掉就算了 */ }
    }
  }
  if (removed > 0) {
    console.log(`[helper] 清掉 ${removed} 个旧的带 hash 名的 helper 二进制`
      + '（0.9.89 起用固定名 —— 名字里带 hash 会让 macOS 每次都当成新程序要授权）');
  }
}

function syncMouseForward() {
  // 只有 desktop 层需要转发 —— 普通窗口自己就能收鼠标，
  // 再转发一次会变成**双份事件**（点一下算两下）。
  const need = !!(weProject && config.we.mouseForward
    && (config.we.strategy || 'desktop') === 'desktop');

  if (!need) {
    if (mouseTap) { mouseTap.stop(); mouseTap = null; }
    mouseStatus = null;
    return;
  }
  if (mouseTap) return;

  mouseTap = MouseBridge.start({
    sourcePath: app.isPackaged
      ? path.join(process.resourcesPath, 'native', 'GestureWallMouse.swift')
      : path.join(__dirname, '..', 'native', 'GestureWallMouse.swift'),
    outDir: path.join(app.getPath('userData'), 'native'),
    gateFinder: !!config.we.mouseGateFinder,
    onEvent: (event) => {
      if (!weWindow || weWindow.isDestroyed()) return;
      const point = MouseBridge.toWindowPoint(event, weWindow.getBounds());
      if (!point) return;   // 落在窗口外（多显示器时会）
      const input = MouseBridge.toInputEvent(event, point);
      if (!input) return;
      weWindow.webContents.sendInputEvent(input);
      mouseInjected += 1;
      lastMouseEvent = {
        kind: event.kind, x: point.x, y: point.y,
        injected: input.type, at: Date.now(),
      };
    },
    onStatus: (status) => {
      mouseStatus = status;
      broadcast('mouse-status', status);
      if (!status.ok) console.warn('[mouse]', status.text);
    },
  });
}

ipcMain.handle('we-set-mouse-forward', (_event, patch) => {
  config.we = { ...config.we, ...(patch || {}) };
  writeConfig(config);
  // 改了 always 要重启 helper（那是启动参数）
  if (mouseTap) { mouseTap.stop(); mouseTap = null; }
  syncMouseForward();
  broadcast('config', config);
  return { ok: true };
});

// 切 WE 壁纸的层策略。
//
// ⚠️ 这个开关存在是因为那是个**真取舍**，不该由我替用户决定：
//   desktop        菜单栏区域有内容，但收不到鼠标（点击掉流星那类交互失效）
//   bottom-normal  能收鼠标，但菜单栏那 25px 是系统的
ipcMain.handle('we-set-strategy', (_event, id) => {
  if (!WALL_STRATEGIES.some((s) => s.id === id)) {
    return { ok: false, error: `未知策略 ${id}` };
  }
  config.we.strategy = id;
  writeConfig(config);
  // 层策略是创建时定的，只能重建窗口。
  if (weProject) {
    destroyWEWindow();
    weWindow = createWEWindow();
  }
  // ⚠️ 换策略要重算转发：desktop 需要转发，普通窗口不能转发（会变双份事件）。
  if (mouseTap) { mouseTap.stop(); mouseTap = null; }
  syncMouseForward();
  broadcast('config', config);
  return { ok: true, strategy: id };
});

// 切音源。'netease' / 'system' / 'off'
ipcMain.handle('we-set-audio-source', (_event, source) => {
  // ⚠️ 用 AudioSource.isValidSource 而不是就地写列表 —— 那个列表原来在三处重复，
  // 而我加 'synth' 时只改了面板 ⟹ 这里把它拒了，症状是"点了没反应"。
  if (!AudioSource.isValidSource(source)) {
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
// ⚠️⚠️⚠️ **最近一次的歌曲信息**（0.9.114）。
//
// 媒体数据是**轮询**来的（nowplaying 每 1.5 秒读一次），而壁纸是**随时**装载的
// ⟹ 装载的那一刻 `window.__mediaState` 还不存在
// ⟹ 壁纸初始化时读到的是它自己的兜底值（全空、position 0）。
//
// ⚠️ 而那个壁纸恰好**订阅了** `_callbacks`，所以最多 1.5 秒后会被纠正 ——
//   但**一个只读一次不订阅的壁纸会永远是空的**，而那种壁纸完全合法
//   （契约里 `_callbacks` 是可选的，`window.__mediaState || {…}` 那个兜底
//    就说明作者预期"可能压根没有这个对象"）。
//
// ⟹ 缓存最近一次，装载完立刻补一发。代价是一个变量，收益是"装上就有数据"。
let lastTrack = null;

function sendWEMedia(track) {
  if (!weWindow || weWindow.isDestroyed()) return;
  const wc = weWindow.webContents;
  wc.send('we-media-properties', WE.mediaProperties(track));
  wc.send('we-media-thumbnail', WE.mediaThumbnail(track));
  wc.send('we-media-playback', WE.mediaPlayback(track));
  wc.send('we-media-timeline', WE.mediaTimeline(track));
  sendMediaState(track);
}

// ⚠️⚠️⚠️ **`window.__mediaState` —— 我们一直漏掉的那个接口**（0.9.114）。
//
// 用户 2026-08-02：「我给你们这些壁纸本身都是能正常运行的，出了问题就说明是
//   我们软件这边没做好适配」—— **他说得对。**
//
// 那个粒子壁纸（Steam 工坊「音域回响」）不用 WE 的 `wallpaperRegister*Listener`，
// 它读一个**普通全局对象**：
//     window.__mediaState = { title, artist, thumbnail, primaryColor, textColor,
//                             isPlaying, position, duration, _callbacks: [] }
// 我们从来没设过它 ⟹ 它落到全空的兜底值 ⟹ 进度恒为 0
// ⟹ 壁纸自己造 performance.now() 计时器往前跑、跑到 duration 就重置
//   —— 那正是用户看到的"跑一会儿自己重置"。
//
// ⚠️⚠️ **必须用 executeJavaScript 在主世界建，不能走 contextBridge** ——
//   壁纸要往 `_callbacks` 里 `push`，而 contextBridge 暴露的是**冻结代理**，
//   push 会抛。（这条约束 createWEWindow 那段注释里就写着：
//   "壁纸→我们：executeJavaScript 跑在主世界"。）
//
// ⚠️ 而**对象只建一次**：每次都重建会把壁纸已经 push 进去的回调数组丢掉
//   ⟹ 它订阅了却再也收不到通知（比不实现更糟：看起来接上了）。
//   ⟹ 所以脚本里是"没有才建，有就只改字段 + 逐个调回调"。
function sendMediaState(track) {
  if (!weWindow || weWindow.isDestroyed()) return;
  const payload = WE.mediaStatePayload(track);
  // JSON 双重 stringify：内层变字面量，外层让它作为字符串安全嵌入
  //（歌名里的引号/反斜杠会把脚本劈开 —— sendWEProperties 那边同一个理由）。
  const script = `(() => {
    const next = JSON.parse(${JSON.stringify(JSON.stringify(payload))});
    let s = window.__mediaState;
    if (!s) {
      // ⚠️ _callbacks 必须在**建对象时**就有，因为壁纸可能比我们先跑到订阅那一行
      s = window.__mediaState = { _callbacks: [] };
    }
    if (!Array.isArray(s._callbacks)) s._callbacks = [];
    Object.assign(s, next);
    // ⚠️ 逐个 try —— 一个壁纸回调抛异常不该让后面的收不到，
    //   也不该把异常带回 executeJavaScript 的 Promise 里。
    let ok = 0;
    for (const cb of s._callbacks.slice()) {
      try { cb(s); ok += 1; } catch (e) { /* 壁纸自己的错，不是我们的 */ }
    }
    return { subscribers: s._callbacks.length, notified: ok };
  })()`;
  weWindow.webContents.executeJavaScript(script, true).catch((error) => {
    // ⚠️ 失败要说出来 —— 静默的话"进度不同步"又变成一个查不出来的谜
    console.warn('[we] __mediaState 注入失败：', error && error.message);
  });
}

// 音频帧入口。采集在原生 helper 里（Electron 的 desktopCapturer 在 macOS 上不给
// 系统音频），这里只做形状校验和转发。
//
// ⚠️ 静默（全 0）要能被看见：没授权拿到的就是全 0，而全 0 的画面看起来是
// "音频响应坏了"。所以 normalizeAudioFrame 会报 silent，面板拿它显示状态。
let audioTap = null;
// 合成测试音的状态。⚠️ 和 audioTap 放一起，而且必须在 syncAudioSource() **之前** ——
// `let` 有暂时性死区，声明在使用之后的话，任何在模块顶层执行期到达的调用都会抛
// ReferenceError。现在三个调用点都在函数体内所以安全，但那是"恰好"，不是设计。
// （我这轮刚在 liftOverMenuBar 的 `want` 上栽过同一个形状。）
let synthTimer = null;
let synthPhase = 0;
let audioStatus = null;
// 最后一次 FFT 自检的结果。
//
// ⚠️ 自检只在 helper 启动时跑一次，而用户可能那时候还没打开面板
// ⟹ 那行就永远错过了。存下来，面板一打开就补发。
// （用户实测撞到：他问"这个在哪里"，而我给的位置还是错的。）
let lastSelfTest = null;
let audioFrameCount = 0;   // 抽样计数，见下面的 we-audio-frame

// 把频谱抽样报给面板。
//
// ⚠️ **三个音源都要调它。** 我原来只在真采集路径里发 ⟹ 切到扫描/测试音之后
// 面板上那行是**切之前的残留**，不更新。
//
// 用户实测的后果：他切到「单段扫描」，状态行说"只有第 40 段有值(0.8)"，
// 而下面「实际频谱」显示 `[0]0.148 [5]0.098 [10]0.147 …`（真音频的形状）
// ⟹ **两行自相矛盾**，他有理由以为"两个音源同时在发帧"。
//
// 那正是我记过的「过期显示比没有显示更糟」——
// 而我在同一个功能上又犯了一次（上次是属性状态停在"正在发"）。
//
// ⟹ 顺便报 source，让那行自己说清"这是哪个音源的数据"。
function reportAudioFrame(data, source) {
  audioFrameCount += 1;
  if (audioFrameCount % 15 !== 0) return;   // 每半秒一次
  const arr = Array.isArray(data) ? data : [];
  if (!arr.length) return;
  const sum = (a, b) => a + b;
  broadcast('we-audio-frame', {
    source: source || (config.we && config.we.audioSource) || '?',
    // 只送有代表性的几段 + 统计量，而不是 128 个数 —— 面板要的是"够不够、偏哪边"。
    // ⚠️ 报**最大值所在的段**，而不是固定的 9 个采样点。
    //
    // 用户实测撞到：扫描到第 30 段时，面板显示 `[0]0 [5]0 [10]0 [20]0 [40]0 …`
    // 全是 0 —— 因为固定采样点 [0,5,10,20,40,60,80,100,119] 里**没有 30**。
    // 而值确实存在于第 30 段。
    //
    // ⟹ 那让"数据对的"看起来像"数据全 0"，而他有理由以为扫描没工作。
    // **固定采样点在诊断单段信号时必然漏掉它。**
    //
    // 现在：前几个固定点（看整体形状）+ 最大值那一段（保证单段信号一定被看到）。
    samples: (() => {
      const fixed = [0, 10, 20, 40, 60, 80, 100, 119];
      let peak = 0;
      for (let i = 1; i < arr.length; i += 1) if (arr[i] > arr[peak]) peak = i;
      const keys = fixed.includes(peak) ? fixed : [...fixed, peak].sort((a, b) => a - b);
      return keys.map((i) => ({ i, v: Number((arr[i] || 0).toFixed(3)) }));
    })(),
    // ⚠️ **相邻段的跳变** —— 那是"很多个和周围高度差很大的柱子"的量化。
    //
    // 用户报（2026-07-31）：「他会出现很多个明显和周围高度差很大的……
    // 另一个壁纸里面也会有这种情况，所以这是个共性问题」。
    //
    // 共性 = 两个渲染代码完全不同的壁纸有同样的症状
    // ⟹ 那只能来自相同的输入：我们发的那 128 段。
    //
    // ⚠️ 而我为它猜过两次（跳跃采样、撞天花板），两次都被数据推翻。
    // ⟹ 所以这次先量出来：把"相邻段差值最大的那几个位置"报出来，
    // 那能直接指出是哪些段的值不对，而不是让我继续推理。
    spikes: (() => {
      const jumps = [];
      for (let i = 1; i < arr.length; i += 1) {
        jumps.push({ i, d: Math.abs((arr[i] || 0) - (arr[i - 1] || 0)) });
      }
      jumps.sort((a, b) => b.d - a.d);
      return jumps.slice(0, 5).map((x) => ({
        i: x.i,
        d: Number(x.d.toFixed(3)),
        // 前后各一个值 —— 看是"这段太高"还是"旁边太低"
        prev: Number((arr[x.i - 1] || 0).toFixed(3)),
        cur: Number((arr[x.i] || 0).toFixed(3)),
      }));
    })(),
    // 平均跳变 —— 整体连续性。越小越平滑。
    avgJump: (() => {
      let sum = 0;
      for (let i = 1; i < arr.length; i += 1) sum += Math.abs((arr[i] || 0) - (arr[i - 1] || 0));
      return Number((sum / Math.max(1, arr.length - 1)).toFixed(4));
    })(),
    // 最大值在第几段 —— 单段扫描时这个数应该跟着扫描段号走。
    peakAt: (() => {
      let peak = 0;
      for (let i = 1; i < arr.length; i += 1) if (arr[i] > arr[peak]) peak = i;
      return peak;
    })(),
    max: Number(Math.max(...arr).toFixed(3)),
    mean: Number((arr.reduce(sum, 0) / arr.length).toFixed(3)),
    // ⚠️ **按钟点报活跃度。** 那和用户看到的东西一一对应。
    //
    // 用户十几轮都在用钟表描述（「3 点到 4 点有反应」「12 点到 3 点没反应」
    // 「3 点是很明显的分割线」），而我一直报段号和频率 ——
    // ⟹ **两边说的不是同一种坐标**，每次都要我换算，而我换算错过好几次。
    //
    // PWCircle 的映射：段 i 在 (i*3)° ，canvas 的 0° 是 3 点方向、顺时针。
    // ⟹ 段 0 = 3 点，段 30 = 6 点，段 60 = 9 点，段 90 = 12 点。
    clock: (() => {
      const out = [];
      for (let h = 0; h < 12; h += 1) {
        // 3 点是段 0，每个钟点 10 段
        const from = h * 10;
        const to = Math.min(arr.length, from + 10);
        let sum = 0;
        let peak = 0;
        for (let i = from; i < to; i += 1) {
          sum += arr[i] || 0;
          if ((arr[i] || 0) > peak) peak = arr[i] || 0;
        }
        const hour = ((3 + h) % 12) || 12;
        out.push({
          h: hour,
          seg: from,
          mean: Number((sum / Math.max(1, to - from)).toFixed(3)),
          peak: Number(peak.toFixed(3)),
        });
      }
      return out;
    })(),
    // 前 40 段（线性区，鼓/低音）和后面的对比 —— 形状对不对看这个
    // ⚠️⚠️⚠️ **口径在镜像之后错了：段 80-119 不是高频。**
    //
    // 镜像布局下段 i 对应 band `i<64 ? i : 127-i`
    // ⟹ 段 80-119 = **band 47..8** = 中低频，而面板管它叫"高频段"
    // ⟹ 用户 0.9.14 看到「⚠️ 低高频差不多 —— 大概是白噪声」——
    //    **那句话是我的口径错，不是数据的事**（他在放正常音乐）。
    //
    // 正确的分段按 **band**：低频 band 0-19，高频 band 44-63。
    // 而 band 在圆环上各占两段（镜像）⟹ 只取前半 64 就够（后半一模一样）。
    lowMean: Number((arr.slice(0, 20).reduce(sum, 0) / 20).toFixed(3)),
    highMean: Number((arr.slice(44, 64).reduce(sum, 0) / 20).toFixed(3)),
    // ⚠️⚠️ **动态范围** —— 这是"柱子太长/太平"的真判据。
    //
    // 真 WE 的预览图（作者用真 WE 跑的，唯一独立真值）：
    //   大多数柱子 w1≈0.045，最长 w1≈0.20 ⟹ **动态范围 4.4 倍**
    // 用户 0.9.14 实测：底 0.31（9点）峰 0.736 ⟹ **只有 2.4 倍**
    //
    // ⟹ 我们**太平**，而"太平"和"太长"是同一件事：**底被抬起来了**。
    // ⟹ 那不是乘一个系数能修的（乘 0.1 会让峰 0.07，比真 WE 的底还低）。
    //
    // ⚠️ 而绝对幅度**不能**用预览图定标：magnitude 差 3-6 倍 = 音量差 10-16dB，
    // 完全在"作者录预览图时的音量和用户现在的音量不同"的范围内。
    // ⟹ 预览图只能定**形状**（动态范围），不能定"该乘多少"。
    // ⚠️ 输入电平 —— 这是"该不该降幅度"这个决定的依据。
    //   RMS 0.03-0.1（−30..−20dBFS）= 正常听感 ⟹ 我们的实现偏大
    //   RMS 0.3+（−10dBFS 以上）    = 音量开得很大 ⟹ 不是实现问题
    inputRMS: Number(lastInputRMS.toFixed(4)),
    systemVolume: Number(lastSystemVolume.toFixed(3)),
    // ⚠️ 帧节奏 —— 判"柱子突兀的长"是不是 push 模型的批大小抖动。
    //   multiPct ≈ 0  ⟹ 一次回调只发一帧 ⟹ 节奏稳 ⟹ **这条假设作废，别改**
    //   multiPct 明显 >0 ⟹ 连发多帧，间隔几微秒 ⟹ 平滑速度随批大小漂
    // 孤峰画像 —— 判"突兀的柱子"是结构性的还是音乐的瞬态。
    // ⚠️ 关键是**在多帧里的稳定性**，不是单帧的位置：
    //   固定在同几段 ⟹ 结构性（我们这层的 bug）
    //   位置乱跳     ⟹ 音乐的瞬态（WE 也一样，不该改）
    // 只看一帧分不出来，而那两个结论一个要改代码、一个不能改。
    spikeProfile: rawFrames.length >= 10 ? (() => {
      const bySeg = new Map();
      let total = 0;
      for (const f of rawFrames) {
        for (let i = 1; i < 63; i += 1) {
          if (f[i] > f[i - 1] * 1.3 && f[i] > f[i + 1] * 1.3 && f[i] > 0.15) {
            bySeg.set(i, (bySeg.get(i) || 0) + 1);
            total += 1;
          }
        }
      }
      const top = [...bySeg.entries()]
        .map(([seg, n]) => ({ seg, n }))
        .sort((a, b) => b.n - a.n)
        .slice(0, 3);
      return {
        frames: rawFrames.length,
        count: Number((total / rawFrames.length).toFixed(1)),
        top,
        // 最常出现的那段占了一半以上的帧 ⟹ 固定 ⟹ 结构性
        sticky: top.length > 0 && top[0].n > rawFrames.length * 0.5,
      };
    })() : undefined,
    rhythm: frameRhythm.total > 0 ? {
      multiPct: Number((frameRhythm.multi / frameRhythm.total * 100).toFixed(1)),
      max: frameRhythm.max,
      batchAvg: Math.round(frameRhythm.batchSum / frameRhythm.total),
      batchMax: frameRhythm.batchMax,
    } : undefined,
    inputDbfs: lastInputRMS > 0 ? Number((20 * Math.log10(lastInputRMS)).toFixed(1)) : -99,
    dynRange: (() => {
      const front = arr.slice(0, 64).filter((v) => v > 0);
      if (front.length < 8) return 0;
      const sorted = [...front].sort((a, b) => a - b);
      // 用 10% / 90% 分位而不是 min/max —— 极值对单帧噪声太敏感
      const lo = sorted[Math.floor(sorted.length * 0.1)];
      const hi = sorted[Math.floor(sorted.length * 0.9)];
      return Number((hi / Math.max(1e-6, lo)).toFixed(2));
    })(),
  });
}

// 启停音频采集。跟着 config.we.audioSource 走：
//   'netease' 只抓网易云（macOS 14.4+，更早会退回全局并报 warning）
//   'system'  全系统混音
//   'off'     不采集（壁纸走它自己的空闲动画）
// 合成测试音源。**不需要任何授权。**
//
// ⚠️ 为什么必须有这个：
//
// 用户从"圆环没有"开始查了好几轮，而根因其实很朴素 —— **那个圆环在等音频帧**，
// 而 `audioSource` 默认 'off' ⟹ 我们一帧都不发 ⟹ 它没数据可画。
// 配置全对（visual_audio_model=1 / showCircle=true / wavetransparency=80），
// 属性也确认送到了（137 项 ✅），就是没有数据。
//
// 而真音频要**屏幕录制授权 + 打包**，那条链上任何一步没通，症状都是"圆环不出现" ——
// 和"壁纸不兼容"、"属性没进去"、"代码有 bug"完全分不清。
//
// ⟹ 这个音源把「壁纸能不能画圆环」和「我们能不能拿到系统音频」**拆成两件事**：
//   选它 → 圆环动起来  ⟹ 壁纸侧完全正常，剩下的纯粹是授权/采集问题
//   选它 → 圆环还是没  ⟹ 问题在壁纸侧或我们的数据格式，和授权无关
//
// 它也是标定那两个未验常量（0.012 归一化、FFT 分组）的参照：合成音的频谱是已知的。
// 单段扫描测试音。
//
// ⚠️ 这是"画面和数据矛盾"时唯一能定位的办法。
//
// 实测矛盾（用户 2026-07-31）：面板报的数据是「上方最长、往下递减、i>40 基本为 0」，
// 而画面上是「上方短、下方长」—— **完全相反**。
// 那说明画面上那些长柱子不是我们发的数据画的，或者索引到角度的映射和我算的不同。
//
// ⟹ 每 2 秒只让**一段**有值（0 → 20 → 40 → …），其余全 0。
// 那样画面上会有**一根**柱子动，而它的位置直接告诉我们
// "第 N 段画在圆周的哪个角度" —— 不用再读代码猜。
let sweepIndex = 0;
let sweepTimer = null;
// ⚠️ 30fps 而不是"每 2 秒一帧" —— PWCircle 只在收到帧时重绘，
// 发得太稀画面就静止，而静止的画面里留着的是上一个音源的残影。
const SWEEP_FPS = 30;

function startSweepAudio() {
  if (sweepTimer) return;
  const STEPS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 119];
  // ⚠️ **30fps 连续发**，而不是每 2 秒一帧。
  //
  // 我第一版是每 2 秒发一帧，那有个致命缺陷：**PWCircle 只在收到帧时才重绘**
  //（它没有 requestAnimationFrame 循环）⟹ 画面在两帧之间**完全静止**，
  // 那时候屏幕上留着的是**最后一次真采集**的画面（一圈长短不一的柱子）。
  //
  // ⟹ 用户看到"很多柱子"完全合理 —— 那是残留的旧画面，而不是扫描画的。
  // 而他有理由以为扫描没生效，因为画面确实没变。
  //
  // ⚠️ 这是"诊断工具自己有 bug"，比没有诊断更糟：它让人怀疑一个对的结论。
  // 30fps 连续发 ⟹ 画面每帧都被清+重画 ⟹ **只可能有一根柱子**。
  sweepTimer = setInterval(() => {
    if (!weWindow || weWindow.isDestroyed()) return;
    // ⚠️ **定时器自己检查配置，不依赖外部清理。**
    //
    // 用户实测三轮：扫描状态在更新而画面是真采集的数据 ⟹ 定时器在跑，
    // 但 `config.we.audioSource` 不是 'sweep'。
    //
    // 而清理逻辑（stopSweepAudio）看起来是全的 ——
    // ⟹ 说明有一条我没找到的路径让它残留。**与其继续找，不如让定时器自己兜住**：
    // 一个"只在某个配置下才该跑"的定时器，自己检查那个配置是零成本的。
    if ((config.we && config.we.audioSource) !== 'sweep') {
      console.warn('[audio] 扫描定时器在音源不是 sweep 时还在跑 —— 自己停掉');
      stopSweepAudio();
      return;
    }
    // 每 2 秒换一段（按时间算，不是按帧数）——
    // 帧率和换段速度是两件事，混在一起会让"多久换一次"随帧率漂。
    const at = STEPS[Math.floor(sweepIndex / (2 * SWEEP_FPS)) % STEPS.length];
    const frame = new Array(128).fill(0);
    // 给一个明显的值 —— 0.8 在 PWCircle 里是 0.8*1.8*100 = 144px，看得清
    frame[at] = 0.8;
    // ⚠️ 走闸门（它同时负责上报）—— 三条路径都走同一个出口，
    // 那样"两个源同时发"不可能再发生。
    // ⚠️ 状态行只在帧**真的发出去**时才更新。
    //
    // 用户实测三轮都被这里误导：扫描定时器在跑 ⟹ 状态行说"第 70 段"，
    // 而它的帧被闸门丢了 ⟹ 画面和频谱行都是真采集的。
    // ⟹ 状态行说"扫描在工作"，而实际上它一帧都没发出去。
    //
    // **那是"定时器在跑"和"它的帧被采纳"混为一谈** ——
    // 而后者才是用户关心的。
    const sent = sendAudioFrame(frame, 'sweep');
    audioStatus = sent
      ? {
        ok: true,
        sweep: true,
        text: `扫描测试：只有第 ${at} 段有值（0.8）—— 看画面上哪根柱子在动`,
      }
      : {
        ok: false,
        sweep: true,
        text: '⚠️ 扫描的帧被丢掉了 —— 当前音源不是「单段扫描」。'
          + '点一下上面的「单段扫描（诊断）」按钮',
      };
    broadcast('we-audio-status', audioStatus);
    sweepIndex += 1;
  }, 1000 / SWEEP_FPS);
  console.log(`[audio] 单段扫描测试已启动（${SWEEP_FPS}fps，每 2 秒换一段）`);
}

function stopSweepAudio() {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  sweepIndex = 0;
}

function startSynthAudio() {
  if (synthTimer) return;
  // 30fps 就够 —— 壁纸的视觉更新到不了那么快，而更高只是白烧 CPU。
  synthTimer = setInterval(() => {
    if (!weWindow || weWindow.isDestroyed()) return;
    // ⚠️ 同上：自己检查配置，不依赖外部清理。
    if ((config.we && config.we.audioSource) !== 'synth') {
      console.warn('[audio] 合成音定时器在音源不是 synth 时还在跑 —— 自己停掉');
      stopSynthAudio();
      return;
    }
    synthPhase += 1;
    // 造一个"像音乐"的频谱：低频强、往高频衰减，整体随时间起伏（模拟节拍）。
    //
    // ⚠️ 只填**前 76 段**有意义的值 —— 壁纸只消费 512 空间的 0..300，
    // 反推到 128 段就是前 76 段（`Pe<=300` 没有 else，301..511 被它自己丢掉）。
    // 后面填衰减到 0 的值，那样如果画面在高频区有反应，就说明我这个 76 的推断错了。
    const beat = 0.55 + 0.45 * Math.sin(synthPhase / 9);
    const frame = Array.from({ length: 128 }, (_, i) => {
      if (i >= 76) return 0;
      const decay = Math.exp(-i / 22);
      const wobble = 0.85 + 0.15 * Math.sin(synthPhase / 5 + i / 7);
      return Math.min(1, decay * beat * wobble);
    });
    sendAudioFrame(frame, 'synth');
  }, 1000 / 30);
  audioStatus = {
    ok: true,
    text: '合成测试音（不需要授权）—— 用来确认壁纸能不能画音频可视化',
    synth: true,
  };
  console.log('[audio] 合成测试音已启动（30fps，前 76 段有值）');
}

function stopSynthAudio() {
  if (synthTimer) { clearInterval(synthTimer); synthTimer = null; }
}

function syncAudioSource() {
  // 单段扫描：定位"第 N 段画在哪"。
  if (config.we.audioSource === 'sweep') {
    if (audioTap) { audioTap.stop(); audioTap = null; }
    stopSynthAudio();
    if (weProject && weProject.wantsAudio) startSweepAudio();
    else { stopSweepAudio(); audioStatus = null; }
    return;
  }
  stopSweepAudio();

  // 合成音源单独一条路 —— 它不碰 ScreenCaptureKit，所以和授权完全无关。
  if (config.we.audioSource === 'synth') {
    if (audioTap) { audioTap.stop(); audioTap = null; }
    if (weProject && weProject.wantsAudio) startSynthAudio();
    else { stopSynthAudio(); audioStatus = null; }
    return;
  }
  stopSynthAudio();

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
    // ⚠️ FFT 自检结果 —— 直接送到面板。
    // 那是"单段孤峰"这个现象的判据，而我为它猜错了十次。
    onSelfTest: (t) => {
      lastSelfTest = t;
      // ⚠️⚠️⚠️ **判据改了：删掉"主瓣宽 ≤8"和"主瓣外要干净"。**
      //
      // 用户 0.9.13 实测报了两个 ⚠️，而**两个都是判据错、不是代码错**：
      //   「主瓣宽 64 段」（判据要 ≤8）
      //   「主瓣外最大值 0.706 ⟹ 尖刺来自分箱/平滑」
      //
      // 这两条判据是**为 Hann 窗写的**，而上一轮已经删掉 Hann 窗了
      //（WE 没有窗函数，泄漏是它铺满圆环的机制）。
      //
      // 算术核对（用他的读数）：
      //   第 15 段读 0.706 ⟹ 反解 magnitude **27.5**
      //   峰值 magnitude **849.4**（实测）⟹ 相差 **-29.8dB**
      //   矩形窗理论泄漏（相隔 10 个 bin，-13dB 旁瓣 + 6dB/倍频滚降）
      //     = 849.4 × 10^(-33/20) = **19.2**
      //   ⟹ 反解 27.5 / 理论 19.2 = **1.44 倍，同量级 ⟹ 对上了**
      //
      // ⟹ 那 64 段就是**矩形窗的泄漏**，而且"主瓣外最大跳变仅 0.044"
      //    证明它们是一条**平缓的高原**，不是尖刺。WE 那边纯音也这样。
      //
      // ⚠️ 而"删掉判据"这件事本身危险 —— 它可能掩盖真问题。
      // ⟹ 所以不是删掉不看，是**换成矩形窗下有意义的判据**：
      //    ① 峰值位置对不对（频率映射）—— 这条不受窗影响，保留
      //    ② 泄漏的**衰减速度**：主瓣外的值该随距离单调降下去。
      //       如果远处和近处一样高，那才是真问题（ctoz stride 错 / 缓冲写坏）
      //    ③ 镜像逐段相等（实现自检）
      const mirrorOk = t.mirrorMaxDiff === undefined || t.mirrorMaxDiff < 0.001;
      // 泄漏该随距离衰减。远处和近处一样高 ⟹ FFT 那一层坏了
      // （ctoz stride / 缓冲被写坏），画面上是一圈等长的柱子。
      const falloffOk = t.leakFalloff === undefined || t.leakFalloff > 0.03;
      const ok = Math.abs(t.peakSeg - t.expectSeg) <= 1 && mirrorOk && falloffOk;
      const line = `FFT 自检（${t.tone}Hz 纯音）：峰值在第 ${t.peakSeg} 段`
        + `（应该是 ${t.expectSeg}）　主瓣宽 ${t.segsAboveQuarter} 段`
        + `　邻域 ${(t.neighbors || []).map((v) => Number(v).toFixed(3)).join(' ')}`
        // ⚠️ 稳态信号下的最大跳变 —— 那是"单段孤峰"的直接判据。
        // 纯音的频谱该是光滑钟形，这个数该很小（<0.2）。
        // 如果它很大，说明尖刺来自我们这一层，和音乐无关。
        // ⚠️ 判据改了。第一版用"全局最大跳变 > 0.25"，而那**必然误报** ——
        // 用户实测 0.526 就是爬上峰值那一步（4 段宽的钟形，相邻差值必然接近 0.5）。
        //
        // ⟹ 现在看**主瓣之外**：纯音的频谱该是"一个钟形 + 其余接近 0"，
        // 主瓣外出现明显的值才是真尖刺。
        + (t.outsidePeak !== undefined
          ? `\n　　主瓣外最大值 ${Number(t.outsidePeak).toFixed(3)}（第 ${t.outsideAt} 段）`
            + `　主瓣外最大跳变 ${Number(t.maxJump).toFixed(3)}（第 ${t.jumpAt} 段）`
            // ⚠️ 判据换了（见上面那段）：矩形窗下"主瓣外有值"是**期望行为**，
            // 有问题的是"跳变大"（那才是尖刺）和"远处不衰减"。
            + `${t.maxJump > 0.25
              ? ' ⚠️ 主瓣外跳变大 ⟹ 那是真尖刺（矩形窗的泄漏该是平缓的高原）'
              : ' ✅ 主瓣外平缓 ⟹ 那是矩形窗的泄漏（WE 也一样，'
                + '而泄漏正是它铺满圆环的机制）'}`
          : '')
        + (t.leakFalloff !== undefined
          ? `\n　　泄漏衰减：近处(±5-10段) ${Number(t.leakNear).toFixed(3)}`
            + ` → 远处(±25段外) ${Number(t.leakFar).toFixed(3)}`
            + `　落差 ${Number(t.leakFalloff).toFixed(3)}`
            + `${t.leakFalloff > 0.03
              ? ' ✅ 泄漏随距离衰减（矩形窗该有的样子）'
              : ' ⚠️ 远处和近处一样高 ⟹ FFT 那层坏了'
                + '（ctoz 的 stride / 缓冲被写坏）—— 画面会是一圈等长的柱子'}`
          : '')
        + (t.mirrorMaxDiff !== undefined
          ? `\n　　镜像逐段差 ${Number(t.mirrorMaxDiff).toFixed(4)}`
            + `${t.mirrorMaxDiff < 0.001
              ? ' ✅ 左右两半一致'
              : `（第 ${t.mirrorAt} 段）⚠️ 镜像下标写错了 —— `
                + '症状是"圆环接缝处一根突兀的柱子"'}`
          : '')
        // ⚠️⚠️⚠️ **FFT 的绝对尺度** —— 用户报「整体的柱子都太长了」。
        //
        // 这一行回答的是：**我们的 magnitude 和 WE 的是不是同一个尺度？**
        // 两边输入都是 ±1、N 都是 1024 ⟹ 同一信号应该给同一个 magnitude。
        // 而库不同：WE 是 kiss_fftr，我们是 vDSP_fft_zrip。
        //
        // ⚠️ 我"知道"vDSP 的实数 FFT 带 2 倍因子（省了一次除 2），
        // 但**没在这台机器上验过** ⟹ 不写死 0.5，让它量出来：
        //   ≈1.0 ⟹ 没有那个因子，我记错了，**不要改代码**
        //   ≈2.0 ⟹ 确认有 ⟹ 乘 0.5 是**对齐 WE**，不是调参
        //
        // ⚠️ 报原始值和理论值两个数，不只报比值 ——
        // 比值的分母是我算的（512 × 0.83），我算错了只看比值发现不了。
        + (t.scaleRatio !== undefined
          ? `\n　　FFT 尺度：实测峰值 ${Number(t.peakMagnitude).toFixed(1)}`
            + `（第 ${t.peakBin} 个 bin）　理论 ${Number(t.theoryPeak).toFixed(1)}`
            + `　**比值 ${Number(t.scaleRatio).toFixed(2)}**`
            + `${Math.abs(t.scaleRatio - 2) < 0.35
              ? ' ⟹ vDSP 确实带 2 倍因子，柱子太长是它 ⟹ 该乘 0.5 对齐 kiss_fftr'
              : (Math.abs(t.scaleRatio - 1) < 0.35
                ? ' ⟹ 尺度和标准 FFT 一致 ⟹ **柱子长不是尺度问题，别乘 0.5**'
                : ' ⚠️ 既不是 1 也不是 2 —— 那我的理论期望算错了，'
                  + '拿实测峰值和 512 比一下（满幅正弦的标准峰值）')}`
          : '');
      console.log(`[audio] ${ok ? '✅' : '⚠️'} ${line}`);
      broadcast('helper-log', {
        source: 'audio',
        message: `${ok ? '✅' : '⚠️'} ${line}`
          // ⚠️ 这句提示原来说"主瓣宽度<2 说明窗函数或 stride 有问题"，
          // 而现在没有窗函数、主瓣宽度也不再是判据 ⟹ 那句话会指向错的方向。
          // 用户 0.9.13 就同时看到「比值 2.00 ✅」和这句 ⟸ 提示，两者矛盾。
          + (ok ? '' : ' ⟸ 峰值位置不对 = 频率映射错了（stride / index 算错）；'
            + '镜像差非 0 = out[] 下标写错了'),
      });
    },
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
// 最近一帧输入 PCM 的 RMS（判"柱子太长"是音量还是实现，见 pushWEAudio）
let lastInputRMS = 0;
// 系统输出音量（0..1）。0.9.23 起乘进采样以对齐 WE 抓的音量后信号；
// 也用来区分"静音"和"没授权/没在放歌"（两者都是全 0 帧）。
let lastSystemVolume = 1;
// 帧节奏统计（判"突兀的柱子"是不是 push 模型的批大小抖动造成的）
let frameRhythm = { total: 0, multi: 0, max: 0, batchSum: 0, batchMax: 0 };
// 最近 N 帧的原始 128 段序列。**用户报"孤峰/噪点"时我需要的真值。**
//
// 为什么必须留原始帧：用户 0.9.16 报「有些柱子突兀的高，像噪点」，
// 而我在云端**合成了"像音乐"的信号去复现**，跑出"45/64 段踩地板"
// 就以为找到了根因。而他的实测采样点 `[0]0.414 [10]0.317 … [119]0.4`
// **一个 0 都没有** => 真实音乐下谱是满的 => **合成信号的结论不适用**。
//
// => 我造不出像真音乐的信号（真音乐是连续谱：打击乐/齿音/混响都是宽带的，
//    而我的合成是 14 个纯正弦 + 白噪，其余 bin 全靠泄漏）。
// => 判"孤峰是不是真的"只能用真实帧，而面板的 9 个采样点看不出孤峰
//    （孤峰的定义是"比左右邻居高 30%"，需要**连续**的段）。
//
// 环形缓冲 60 帧（约 1.3 秒）—— 够看清一个孤峰是稳定存在还是一帧的抖动。
const RAW_FRAMES_CAP = 60;
const rawFrames = [];
// 被闸门丢掉的帧数，按 owner 分。⚠️ 报到面板用 —— 打包版看不到终端。
const droppedFrames = {};

// ⚠️⚠️ 发音频帧的**唯一闸门**。所有音源都必须过这里。
//
// 用户实测（2026-07-31）：切到「单段扫描」之后画面上仍有一堆柱子，
// 而面板那行在两个值之间跳：
//
//   实际频谱（**全系统**）最大 2 ⚠️顶天了   ← 真采集在报
//   实际频谱（**单段扫描**）[119] 0.8        ← 扫描在报
//
// ⟹ **两个源同时在发帧。** 真采集的 helper 被 kill 了，但：
//   ① kill 是异步的，缓冲区里的数据仍会触发 stdout 回调
//   ② 而 `pushWEAudio` **压根不检查当前音源是什么** —— helper 吐什么它就发
//
// ⟹ 那就是"好多柱子"：真音频的几十个非零段 + 扫描的一段，全在画。
//
// ⚠️ 根本问题是**没有单一闸门**：三条路径各自 `weWindow.webContents.send('we-audio')`，
// 而"当前该由谁发"这件事没人管。
// ⟹ 现在所有发送都走 sendAudioFrame，它检查 owner 对不对。
function sendAudioFrame(data, owner) {
  if (!weWindow || weWindow.isDestroyed()) return false;
  const current = (config.we && config.we.audioSource) || 'off';
  // 真采集的 owner 是 'system' 或 'netease' —— 两者共用同一条路径。
  const ok = owner === current
    || (owner === 'capture' && (current === 'system' || current === 'netease'));
  if (!ok) {
    // ⚠️ 报出来而不是静默丢 —— "切了音源但旧的还在发"是这次烧掉一整轮的原因，
    // 而它在画面上表现为"柱子莫名其妙地多"，和数据错完全分不清。
    if (!sendAudioFrame.warned || sendAudioFrame.warned !== owner) {
      console.warn(`[audio] 丢掉 ${owner} 的帧 —— 当前音源是 ${current}`);
      sendAudioFrame.warned = owner;
    }
    // ⚠️ 也报到**面板** —— 打包版没有终端，console.warn 谁都看不到。
    //
    // 用户实测三轮都卡在这里：他看到"扫描状态在更新"+"频谱行说全系统"，
    // 两者矛盾，而**闸门到底看到了什么值**没人知道。
    // ⟹ 把 owner 和 current 直接报出来，那一行就能定案。
    droppedFrames[owner] = (droppedFrames[owner] || 0) + 1;
    if (droppedFrames[owner] % 30 === 1) {
      broadcast('we-audio-drop', {
        owner, current, count: droppedFrames[owner],
      });
    }
    return false;
  }
  weWindow.webContents.send('we-audio', data);
  reportAudioFrame(data, owner === 'capture' ? current : owner);
  return true;
}

function pushWEAudio(frame, meta) {
  if (!weWindow || weWindow.isDestroyed()) return;
  // ⚠️ 输入 PCM 的 RMS —— 判"柱子太长"是系统音量还是我们的实现。
  // 真 WE 预览图反解 magnitude 1.2-2.0，我们 2.8-12（差 12dB = 音量差 4 倍）
  // ⟹ 不量 RMS 就改幅度 = 又一次凭猜调系数。
  //
  // ⚠️ 第二个参数从裸 rms 改成了对象 —— 因为"柱子突兀的长"有两个候选原因，
  // 而它们需要不同的观测：整体幅度看 RMS，单帧尖刺看**帧节奏**。
  if (meta && typeof meta.rms === 'number') lastInputRMS = meta.rms;
  if (meta && typeof meta.vol === 'number') lastSystemVolume = meta.vol;
  if (meta && typeof meta.nth === 'number') {
    // ⚠️ 统计分布而不是记最后一个值 —— 一次回调发几帧是**变化的**，
    // 而"最后一次是 1"和"平均 1.02"是完全不同的结论。
    // 我这一轮已经因为"面板显示的是上一个音源的残留"误判过一次。
    frameRhythm.total += 1;
    if (meta.nth >= 2) frameRhythm.multi += 1;
    if (meta.nth > frameRhythm.max) frameRhythm.max = meta.nth;
    if (typeof meta.batch === 'number') {
      frameRhythm.batchSum += meta.batch;
      if (meta.batch > frameRhythm.batchMax) frameRhythm.batchMax = meta.batch;
    }
  }
  const result = WE.normalizeAudioFrame(frame);
  // ⚠️ 走闸门 —— 音源已经切走时这一帧会被丢掉（并报一次）。
  if (!sendAudioFrame(result.data, 'capture')) return;
  // 留原始帧给诊断报告用。**在闸门之后** —— 只留真的送出去了的那些，
  // 否则报告里会混进被丢掉的帧，而那正是我上一轮误判的形状：
  //「状态行说扫描在工作，而它的帧被闸门丢了」。
  rawFrames.push(result.data.map((v) => Number(v.toFixed(4))));
  if (rawFrames.length > RAW_FRAMES_CAP) rawFrames.shift();
  // ⚠️ 把真实频谱抽样送到面板。**这是我早就该做的事。**
  //
  // 我为"幅度/形状不对"改了三轮参数，而**从没看过那 128 个数长什么样** ——
  // 每轮都在从壁纸代码反推"应该是多少"，然后靠用户看截图判断。
  // 用户第三次说"你在干什么" —— 那是对的。
  //
  // ⟹ 有了这个，"该调多少"变成算术：面板直接显示每段的实际值。
  // 抽样而不是每帧发：那是 30fps × 128 个数，全发会把 IPC 灌满。
  // ⚠️⚠️ **静音时全 0 是正常的，不是"没授权/没在放歌"。**
  //
  // 0.9.23 起我们把系统音量乘进采样（对齐 WE 抓的 PulseAudio `.monitor` ——
  // 那是音量之后的信号）⟹ 系统静音时帧就是全 0。
  //
  // 而 `normalizeAudioFrame` 的 `silent` 本来是"没授权/没在放歌"的信号
  // ⟹ 不区分的话，用户一静音面板就报"是不是没在放歌"，那是误导。
  if (result.silent && !(lastSystemVolume <= 0.001)) {
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
    // ⚠️ 记住最近一次 —— 壁纸**装载的瞬间**要能立刻拿到（见 lastTrack 那段注释）。
    lastTrack = track;
    // WE 壁纸走自己的四通道 media 协议，不是我们的 'track' 事件。
    sendWEMedia(track);
  },
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// 应用菜单。⚠️ 这不是装饰，它是**唯一不依赖记住快捷键的退出方式**。
//
// 用户实测报的：「点击了退出，但貌似没有真正关掉，壁纸还是正常运行，
// 然后 app 图标那里也没有退出选项了」。
//
// 而这条 bug 在 AirCursor 早期就出过（`aircursor-notes/pitfalls.md` 第 74-87 行）：
//
//   「App 能打开，但 Dock 里不像正常运行中的应用……
//     用户感觉『没开但关不掉』」
//   处理：「菜单栏提供『显示』和『退出』，`Command+Q` 也能退出」
//
// ⟹ 我们重演了它：整个应用**零菜单**（`Menu.setApplicationMenu` 一次都没调），
// 而 Electron 在没有自定义菜单时用的默认菜单里，`Cmd+Q` 会被
// `globalShortcut` 抢走的那些键干扰，且 Dock 右键没有我们的退出项。
//
// ⚠️ 一个壁纸应用**必须**有正常的退出路径：它长在桌面层、没有可见窗口，
// 用户唯一的直觉入口就是 Dock 图标和菜单栏。
// 退出。**不可阻挡，而且每一步都报出来。**
//
// ⚠️ 为什么不用 `app.quit()` / `role: 'quit'`：实测它们不管用 —— 用户报
// 「菜单栏退出之后程序没有停止，壁纸还是正常运行」，而 `ps` 显示主进程
// CPU 0.1% / 累计 1.51 秒 ⟹ **根本没走到退出逻辑**，不是卡住。
//
// 嫌疑是我们那两个特殊窗口（`type: 'desktop'` 的壁纸层 + `screen-saver` 层的骨架层）
// 让 Electron 的标准退出链停在了中途。但我**没有坐实是哪一步** ——
// ⟹ 所以不去修那条链，改成自己走完，并且**每一步都打日志**：
// 下次如果还退不掉，日志会直接说卡在第几步，不用再猜。
//
// 最后一道是 `app.exit(0)`：它跳过所有 before-quit/will-quit 钩子直接结束进程。
// ⚠️ 那是**故意的**：一个退不掉的壁纸程序会占着屏幕、摄像头、屏幕录制权限，
// 用户唯一的出路是去终端 pkill —— 那比"退出时少还原一次系统壁纸"糟糕得多。
let quitting = false;

function hardQuit(from) {
  if (quitting) {
    console.log(`[quit] 已经在退出中（${from} 又触发了一次）`);
    return;
  }
  quitting = true;
  console.log(`[quit] 开始退出（来自：${from}）`);

  const step = (name, fn) => {
    try {
      fn();
      console.log(`[quit] ✓ ${name}`);
    } catch (error) {
      // ⚠️ 一步失败不能挡住后面的 —— 那正是"退不掉"的成因。
      console.warn(`[quit] ✗ ${name}：${error && error.message}`);
    }
  };

  step('停掉定时器', () => {
    // ⚠️ 定时器不清会在退出过程中继续 fire，而它们碰的是已经拆掉的窗口
    // ⟹ 抛异常、日志刷屏。虽然 app.exit(0) 最后会强制结束，
    // 但"退出时报一堆错"看起来像退出失败。
    if (wePropTimer) { clearInterval(wePropTimer); wePropTimer = null; }
    if (weSlowPropTimer) { clearInterval(weSlowPropTimer); weSlowPropTimer = null; }
    stopSynthAudio();
    stopSweepAudio();
  });
  step('注销全局快捷键', () => globalShortcut.unregisterAll());
  step('拆掉所有窗口', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      // ⚠️ 用 getAllWindows() 而不是我们那四个变量 —— 漏掉任何一个窗口
      // 都会让进程留着。destroy() 不触发 close 事件，所以不会被拦。
      try { if (!win.isDestroyed()) win.destroy(); } catch { /* 已经没了 */ }
    }
  });
  step('停掉 helper 进程', () => {
    // 独立进程，不会跟着主进程死 —— 留着会占住摄像头/麦克风/屏幕录制。
    systemBridge.stop();
    if (audioTap) audioTap.stop();
    if (mouseTap) mouseTap.stop();
  });
  step('还原系统壁纸', () => {
    // ⚠️ 1.5 秒超时：osascript 默认能慢到 8 秒，而那段时间用户会以为卡死了。
    if (originalWallpaper) setSystemWallpaper(originalWallpaper, 1500);
  });

  console.log('[quit] 结束进程');
  // ⚠️ `app.exit(0)` 而不是 `app.quit()` —— 前者跳过所有钩子直接结束。
  // 到这一步该做的都做完了，没有理由再给任何东西阻止退出的机会。
  app.exit(0);
}

function buildAppMenu() {
  const template = [
    {
      label: 'DreamPaper',
      submenu: [
        { label: '关于 DreamPaper', click: () => { openDashboard(); } },
        { type: 'separator' },
        { label: '设置面板', accelerator: 'CmdOrCtrl+,', click: () => { openDashboard(); } },
        { type: 'separator' },
        {
          // ⚠️ 拆掉骨架层要在菜单里，不只在快捷键里 —— 它的用途是
          // "鼠标点不动了"，而那种状态下用户大概也想不起快捷键。
          label: '拆掉骨架层（鼠标点不动时用）',
          click: () => { destroyOverlay(); },
        },
        { type: 'separator' },
        // ⚠️ 不用 role: 'quit'。
        //
        // 实测（用户报「菜单栏退出之后程序没有停止，壁纸还是正常运行」+ ps 输出）：
        //   主进程 PID 66918 还在，CPU 0.1% / 累计 1.51 秒 ⟹ **不是卡在退出，
        //   是根本没走到退出**。而 `GestureWallMouse-1c023582281b` 也还在跑。
        //
        // role: 'quit' 走的是 Electron 的标准链（before-quit → 关所有窗口 →
        // will-quit），而我们有一个 `type: 'desktop'` 的壁纸窗口和一个盖在
        // screen-saver 层的骨架窗口 —— 那条链上任何一步没按预期走，退出就静默停住。
        //
        // ⟹ 不猜它为什么停住，改成**自己控制的、可观测的**退出路径。
        { label: '退出 DreamPaper', accelerator: 'Command+Q', click: () => hardQuit('菜单') },
      ],
    },
    // 编辑菜单：面板里有输入框（工坊搜索、API key），没有这个 Cmd+V 粘贴不了。
    // ⚠️ 这不是"顺手加的" —— 用户要往 API key 输入框里粘贴。
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { label: '设置面板', click: () => { openDashboard(); } },
        { type: 'separator' },
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭窗口' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  // ⚠️ 菜单要**最先**建 —— 它是退出的兜底路径，而后面任何一步抛异常都会让
  // 应用变成"跑着但退不掉"。先有出口，再做别的。
  buildAppMenu();
  // ⚠️⚠️ 这里**没有** buildTray() / app.dock.hide()（0.9.47 撤掉了 0.9.46 加的）。
  // 见下面 `window-all-closed` 那段 —— 用户要的是标准 Mac 应用：
  // 点关闭 = 整个退出，最小化 = 还在跑。托盘和"关窗不退出"是配套的，
  // 一起撤。
  config = readConfig();
  // ⚠️⚠️ **清掉旧的带 hash 名的 helper 二进制**（0.9.89）。
  //   0.9.88 之前它们叫 `GestureWallMouse-1635ebad82ad` 这样，而每改一次源码
  //   就多一个（用户机器上现在躺着好几个）。留着有两个害处：
  //     ① 白占几 MB
  //     ② ⚠️ 更糟：**它们还在系统的辅助功能授权列表里**，用户看到一堆
  //        `GestureWallMouse-xxxx` 分不清哪个是当前的。
  //   ⟹ 删掉。它们已经没人引用了（现在只找固定名那个）。
  cleanLegacyHelpers();
  // ⚠️ 必须在建窗口之前 —— 策略是创建时定的，迁移晚了这次启动仍然用旧值。
  if (migrateConfig(config)) writeConfig();
  registerWEProtocol();
  // ⚠️⚠️⚠️ **壁纸不在这里装了**（0.9.128）。用户 2026-08-02：
  //   「我们的软件打开会出现 gesturewall 这界面，此时壁纸等不应该生效的，
  //     等我点击进入才正常改生效，这是方便后面做账号登陆那种东西」
  //
  // ⚠️ 原来这里直接 `setWEWallpaper()` / `createWallWindow()` ⟹ 壁纸在启动页
  //   还挂着的时候就已经铺在桌面上了。而用户要的是**启动页是一道门**：
  //   点进去之前什么都不生效。⟹ 那是给"以后加账号登录"留的位置
  //   （登录页背后不该已经有东西在跑）。
  //
  // ⟹ 搬到 `releaseWallpaperGate()`（面板发 `launch-dismissed` 时调）。
  // ⚠️ 而**骨架层早就是这么做的**（0.9.48 的 overlayGate，理由是"骨架会压在
  //   启动页上"）⟹ 这里不新造机制，用同一条信号、同一个兜底定时器的形状。
  //   判据：**已经有一道闸门了就挂上去，别开第二道** ——
  //   两道闸门各自超时、各自兜底，那是"启动顺序"这类问题最难查的形状。
  followDisplayChanges();
  openDashboard();
  // ⚠️⚠️ **骨架层要等用户离开启动页再建**。用户 2026-08-01 报：
  //   「如果我把那个摄像头默认是开启状态，我刚看到我那个登录界面啥都没点的时候，
  //     我都能看到我手的骨架吧」
  //
  // 根因：骨架层是 `alwaysOnTop: 'screen-saver'` 的独立窗口（那是它的设计 ——
  // 见 ensureOverlay 的注释，它必须盖过一切，否则在最需要它的时刻被挡住），
  // 而启动页只是面板窗口里的一个 div ⟹ 骨架必然压在启动页上。
  // 这不是"层级设错了"，是**时序**：启动页那段时间骨架没有任何用途。
  //
  // ⚠️⚠️ 0.9.47 是 `setTimeout(2600)` 挡的，而 0.9.48 撤掉了"自动进入"
  // （用户点名不要强制等待）⟹ 启动页会**停留到用户点击为止**，可能几分钟
  // ⟹ 定时器挡不住了，那个 bug 会原样回来。
  // ⟹ 改成等面板的 `launch-dismissed` 信号（见 ipcMain.handle）。
  //
  // ⚠️ 但**定时器要留着当兜底**：面板 JS 挂了的话信号永远不来 ⟹ 手势永久
  // 不可用，而那比"骨架早出现"糟得多。20 秒 —— 长到正常用户早就点进去了，
  // 短到不会让"面板挂了"变成"手势永远坏了"。
  overlayGate = setTimeout(() => {
    console.warn('[overlay] ⚠️ 20 秒没收到 launch-dismissed（面板 JS 可能挂了）—— 兜底建骨架层');
    releaseOverlayGate();
  }, 20000);

  // ⚠️⚠️ **壁纸也要兜底**（0.9.128）—— 而它比骨架那条更要紧：
  //   面板 JS 挂了的话信号永远不来 ⟹ 桌面上**一张壁纸都不会出现**，
  //   而这是一个壁纸播放器。用户看到的是"装了但完全没反应"。
  // ⚠️ 用比骨架**短**的 8 秒：壁纸是这个产品的主功能，
  //   而"启动页多显示几秒"和"壁纸永远不出现"完全不是一个量级的问题。
  //   ⚠️ 而正常路径下它不会触发（用户点一下就放行了），所以这条 warn
  //     出现在日志里就意味着**面板真的有问题** —— 那是它的价值。
  wallpaperGate = setTimeout(() => {
    console.warn('[launch] ⚠️ 8 秒没收到 launch-dismissed（面板 JS 可能挂了）'
      + ' —— 兜底装载壁纸，否则桌面上什么都不会出现');
    releaseWallpaperGate();
  }, 8000);

  // A desktop-level window cannot be clicked, so every escape hatch has to be a
  // global shortcut. Without these the app could become unreachable.
  // ⚠️⚠️ `start()` 现在什么都不做（0.9.82）—— 两个 helper 都改成按需了。
  //
  // 用户 2026-08-01：「第一次打开的时候，他会弹一个要辅助功能…
  //   一开始那个明显是很不需要的，就问我要了，这应该是不可取的」
  //
  // 原来这里会拉起 `AirCursorPointer`，而它一启动就弹辅助功能授权框
  // ⟹ **应用一打开就要权限**，而那时用户什么都没做。
  // 而那个 helper 是给**手势控制鼠标**用的（`config.controlCursor`，默认关）
  // ⟹ 绝大多数用户永远不需要它。
  //
  // ⟹ 判据：**启动时不碰任何需要授权的东西。**
  //   留着这一行调用是为了以后 start() 里若要做无副作用的初始化有地方放。
  systemBridge.start();

  // ⚠️⚠️⚠️ **这里不检测、不弹框辅助功能授权**（0.9.87）。用户 2026-08-01：
  //
  //   「我们就辅助功能这个东西呢，我们不强行给他弹窗啥的也不检测啥的，然后我这在
  //     使用的过程中，我发现哪一个功能是需要的，我们就只对这个功能做一个监控就行了」
  //
  // 0.9.76/0.9.86/0.9.87 我试了三版"主动请求授权"，全被实测否掉（反复弹框）。
  // 而这一版我一度加了启动时的自检 + 自己的对话框 —— 那仍然是"应用替用户操心
  // 一个他还没遇到的问题"。
  //
  // ⟹ 现在的判据：**谁需要谁自己报**。
  //   · 两个 helper 只做 `AXIsProcessTrusted()` 纯查询，**永不弹框**
  //   · 面板把 trusted 显示出来（system-bridge 的 refreshTrustState /
  //     dashboard 的鼠标诊断段）—— 那就是他说的"对这个功能做一个监控"
  //   · 授权这件事由用户在真正撞到某个功能不工作时决定要不要给
  //
  // ⚠️ 所以这里**什么都不做**，是有意的。别再往这儿加自检。
  globalShortcut.register('Control+Shift+W', openDashboard);
  // ⚠️ 面板的 JS 异常**谁都看不到**，而后果是"后面的初始化全停"——
  // 表现为某个开关点了完全没反应（连状态行都不变）。
  //
  // 实测踩到：用户报"摄像头打不开、点了什么反应都没有、也没报错"。
  // 而纯 main 是好的 ⟹ 我这轮往 dashboard.js 顶层加的代码里有一处抛了，
  // 于是 apply()（在最后一行才调，负责绑定所有开关）永远跑不到。
  //
  // ⟹ 有个能看见异常的入口，比逐个猜哪行抛快一个量级。
  globalShortcut.register('Control+Shift+D', () => {
    for (const win of [dashboardWindow, weWindow, wallWindow, overlayWindow]) {
      if (!win || win.isDestroyed()) continue;
      // ⚠️ 要能**关**。原版只有 openDevTools ⟹ 一按就四个 devtools 窗口,再按一次
      // 也关不掉 —— 而它盖在壁纸上,那本身就成了新问题。
      if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
      else win.webContents.openDevTools({ mode: 'detach' });
    }
  });
  globalShortcut.register('Control+Shift+L', cycleStrategy);
  globalShortcut.register('Control+Shift+R', () => broadcast('reset-view', {}));
  globalShortcut.register('Control+Shift+Q', () => hardQuit('⌃⇧Q'));
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

  // 调试 HUD 的开关。默认关(它盖在壁纸上),而原来那个复选框在「壁纸与音乐」tab 里 ——
  // 收缩之后那个 tab 没了 ⟹ 没有快捷键的话它就彻底没入口了。
  //
  // ⚠️ 这条不是可选的:一个"默认关且没有开关"的观测手段等于不存在,而 HUD 报的
  // 壁纸层策略/帧率/鼠标事件收不收到,正是壁纸出问题时第一个该看的东西。
  globalShortcut.register('Control+Shift+H', () => {
    config.debug = { ...config.debug, showHud: !config.debug.showHud };
    writeConfig();
    broadcast('config', config);
  });

  // ⚠️ 打包版**没有终端** —— 所以 build 标识必须能在**界面**里看到，
  // 而不是只打在 console 里。这一步是打包来回测试的前提：
  // 「我跑的是哪个版本」如果靠记，一定会出现"改了没生效"的假象。
  //
  // 版本号 + git commit + 打包与否，三样都要：
  //   版本号   —— dmg 文件名里也有，用来核对装的是哪个包
  //   commit   —— 唯一确定代码，版本号不变时也能分辨
  //   打包与否 —— 决定权限能不能拿到（npm start 拿不到辅助功能/屏幕录制）
  console.log(`\n=== DreamPaper ${buildStamp()} ===`);
  console.log('  ⌃⇧W 设置    ⌃⇧L 换壁纸层    ⌃⇧R 复位视角    ⌃⇧H 调试信息');
  console.log('  ⌃⇧D 开发者工具    ⌃⇧X 拆掉骨架层(鼠标点不动时用)    ⌃⇧Q 退出\n');
});

// ⚠️⚠️⚠️ **关闭 = 整个退出**（0.9.47）。这条推翻了 0.9.46 的托盘方案。
//
// 用户 2026-08-01（第二次说，说得更清楚了）：
//   「我们契约界面左侧不是有一个关闭按钮吗？那点了这个关闭按钮，
//     我是不是所有的程序进程都要结束掉呢？但不是这样子的…
//     你正常来说就是应该我点了关闭，那就整个进程关闭都关，
//     我缩小了那程序在运行中，我这个 Dock 图标的圆点应该还在的…
//     就明显存在一些逻辑不一致」
//
// **他说得对，而且我上一轮修错了方向。**
//
// 原来的设计是「关窗口 ≠ 退出壁纸」，我当时觉得那是对的（壁纸还在桌面上跑），
// 0.9.46 顺着这个思路加了菜单栏图标 —— 那是在**给一个错的前提补台阶**。
//
// 真正的问题是这个前提本身违反 macOS 惯例：
//   · 点红色 ✕ → 用户预期整个应用结束
//   · 点最小化 ➖ → 用户预期还在跑、Dock 圆点还在
// 我们把「关闭」实现成了「隐藏」，于是圆点消失（macOS 判定没窗口了）
// 但进程还在 ⟹ 两个信号互相矛盾，任何补救（托盘）都只是多一个入口，
// 不解决「点了关闭却没关」这件事。
//
// ⟹ 回到标准行为。撤掉的东西：Tray、app.dock.hide()、
//    trayImage()、assets/trayTemplate@2x.png。
//
// ⚠️ 代价（明确的、用户拍过的）：做不到「只关面板、留壁纸在桌面」——
//    要留壁纸就得让窗口**最小化**着而不是关掉。这是用户选的，
//    理由是逻辑一致比多一种用法重要。
// ⚠️⚠️ **不能挂 `window-all-closed`** —— 它在这个应用里**永远不会触发**。
// 壁纸层（wallWindow / weWindow）和骨架层（overlayWindow）都是 BrowserWindow，
// 关掉面板之后它们还在 ⟹ "所有窗口都关了"这个条件不成立。
// 第一版我就是挂在这里的，那是一段**死代码**（不报错，只是关闭还是不退出）。
// ⟹ 退出挂在**面板窗口自己的 close 事件**上（见 openDashboard）。
app.on('window-all-closed', () => {
  // 留一个空实现：默认行为是退出，而如果哪天壁纸层意外全没了，
  // 我们不希望应用在那一刻突然自己退掉（那会掩盖真正的问题）。
});

// ⚠️⚠️ **点 Dock 图标要能唤回窗口**（0.9.48）。
//
// 这是 0.9.47 漏的一块：撤掉 dock.hide() 之后 Dock 图标回来了，但**点它没反应** ——
// macOS 点 Dock 图标发的是 `activate`，Electron 不会自动帮我们恢复窗口。
// 症状：最小化之后点 Dock 图标，窗口不回来，只能靠 ⌃⇧W。
// ⟹ 那正是用户一直在说的"App 和 GUI 中间这个状态不一致"的最后一块。
//
// ⚠️ openDashboard 自己处理了 isMinimized/restore 和"窗口已销毁就重建"，
// 所以这里直接调它就够 —— 不要在这里重写一份判断（同一个事实两个来源会漂）。
app.on('activate', () => {
  openDashboard();
});
// ⚠️ 退出必须**看得见地在发生**，而且不能被任何一步卡住。
//
// 用户实测报「点了退出但没真正关掉，壁纸还在跑」。查到两件事：
//   ① 整个应用零菜单 ⟹ 除了记住 ⌃⇧Q 没有别的出口（已加菜单）
//   ② `will-quit` 里 `setSystemWallpaper` 是同步 osascript，`timeout: 8000`
//      ⟹ 最坏卡 8 秒。那段时间里窗口还在、壁纸还在动，**看起来就是"没退"**。
//
// ⟹ 先把可见的东西拆掉（窗口、壁纸层），再做还原这类慢活。
// 顺序反了用户就会以为点了没用，然后再点一次 / 强制退出。
// ⚠️ will-quit 现在只是**兜底** —— 正常退出走 hardQuit()（它最后 app.exit(0)，
// 压根不会触发这里）。这条路径留给我们控制不到的退出：系统关机、macOS 强制退出、
// 别的代码调了 app.quit()。
//
// ⟹ 两条路径做同一件事，所以清理逻辑要能重复执行而不出错（都是幂等的）。
app.on('will-quit', () => {
  if (quitting) return;   // hardQuit 已经清理过了
  console.log('[quit] will-quit（不是我们主动触发的，可能是系统关机）');
  for (const win of BrowserWindow.getAllWindows()) {
    try { if (!win.isDestroyed()) win.destroy(); } catch { /* 已经没了 */ }
  }
  globalShortcut.unregisterAll();
  // 两个 helper 都是独立进程，不会因为主进程退出而自动结束 —— 留着会占住
  // 摄像头/麦克风/屏幕录制，而且下次启动会看到"两个 helper 在跑"。
  systemBridge.stop();
  if (audioTap) audioTap.stop();
  if (mouseTap) mouseTap.stop();
  // ⚠️ 把用户原来的壁纸还回去。改了别人的系统设置不还原是很讨人嫌的行为，
  // 而且他可能根本不知道是我们改的。
  // ⚠️ 退出路径上用 1.5 秒而不是默认的 8 秒 —— 见 setSystemWallpaper 的注释。
  if (originalWallpaper) setSystemWallpaper(originalWallpaper, 1500);
});
