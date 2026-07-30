// 录制期间的屏蔽 + 骨架可见性。
//
//   node test/gating.test.js
//
// 这两条逻辑住在 main.js 里，而 main.js 顶层 require('electron')，跑不了。所以从源码里
// 抠出那两个判断来测 —— 抠而不是手抄，手抄的副本会和源码悄悄分叉。
//
// 值得单独测的理由：这两条各有一个"错了不报错、症状指向别处"的失败模式。
//   屏蔽漏了   → 录制时做动作会触发已绑动作，把录制打断（AirCursor 真机踩过）
//   解除漏了   → 手势永久失效，而症状是"手势全都不响应"，离真正的原因很远
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.message}`);
    process.exitCode = 1;
  }
}

console.log('\n录制屏蔽与骨架可见性');

// ---- 骨架可见性：把 syncOverlayVisibility 的条件抠出来跑 ----
const visibilityMatch = source.match(/const wanted = ([^;]+);/);
assert.ok(visibilityMatch, '在 main.js 里找不到骨架可见性的判断 —— 被改名或删了');
// eslint-disable-next-line no-new-func
const wantsOverlay = new Function('config', 'recordingAction',
  `return ${visibilityMatch[1]};`);

const cfg = (gestures, showHands) => ({ gestures: { enabled: gestures }, showHands });

check('手势关着就不显示骨架（哪怕开关是开的）', () => {
  assert.strictEqual(wantsOverlay(cfg(false, true), null), false);
});

check('手势开 + 开关开 → 显示', () => {
  assert.strictEqual(wantsOverlay(cfg(true, true), null), true);
});

check('手势开 + 开关关 → 不显示', () => {
  assert.strictEqual(wantsOverlay(cfg(true, false), null), false);
});

// 录制是唯一必须看见手的时刻。"我关了骨架所以录制时什么都看不到"不是用户会预期的后果。
check('录制时强制显示，不管开关', () => {
  assert.strictEqual(wantsOverlay(cfg(true, false), 'spin'), true,
    '录制时没有强制显示骨架');
});

check('手势关着时录制也不显示（那时压根录不了）', () => {
  assert.strictEqual(wantsOverlay(cfg(false, false), 'spin'), false);
});

check('config 为空时不崩', () => {
  assert.strictEqual(wantsOverlay(null, null), false);
  assert.strictEqual(wantsOverlay(undefined, 'spin'), false);
});

// ---- 屏蔽：检查那道门确实在 gesture 转发的最前面 ----
console.log('\n  手势屏蔽');

check('gesture 转发的第一个动作是检查录制态', () => {
  const handler = source.match(/ipcMain\.on\('gesture',[\s\S]*?\n\}\);/);
  assert.ok(handler, '找不到 gesture 的转发');
  const body = handler[0];
  const guardAt = body.indexOf('if (recordingAction) return;');
  const sendAt = body.indexOf('webContents.send');
  assert.ok(guardAt > 0, '没有录制屏蔽的守卫');
  assert.ok(guardAt < sendAt, '守卫在转发之后 —— 那就不起作用');
});

// 漏掉解除的症状是"手势全都不响应"，而那个症状指向的地方和真正的原因差得很远。
check('录制结束的三条路都解除屏蔽', () => {
  for (const [name, pattern] of [
    ['取消', /ipcMain\.handle\('cancel-recording'[\s\S]*?\n\}\);/],
    ['结果（成功或失败）', /ipcMain\.on\('recording-result'[\s\S]*?\n\}\);/],
  ]) {
    const block = source.match(pattern);
    assert.ok(block, `找不到${name}的处理`);
    assert.match(block[0], /recordingAction = null/, `${name}没有解除录制态`);
  }
});

check('开始录制会设上录制态并同步骨架', () => {
  const block = source.match(/ipcMain\.handle\('start-recording'[\s\S]*?\n\}\);/);
  assert.ok(block);
  assert.match(block[0], /recordingAction = action/, '没有记录在录哪个动作');
  assert.match(block[0], /syncOverlayVisibility\(\)/, '没有同步骨架可见性');
});

// 两道门不是冗余：sensor 那道防"判定被跑了"，main 这道防"事件从任何路径漏出来"。
check('sensor 侧也有一道守卫（两层都拦）', () => {
  const sensor = fs.readFileSync(path.join(__dirname, '..', 'src', 'sensor.js'), 'utf8');
  assert.match(sensor, /if \(recorder && recorder\.active\)/,
    'sensor 里没有录制守卫');
});

console.log('\n  骨架窗口的三个必需设置');

// 缺一个的后果各不相同，而且都不报错：
//   alwaysOnTop 少了 → 被别的窗口挡住
//   ignoreMouseEvents 少了 → 整个屏幕点不动
//   visibleOnAllWorkspaces 少了 → 切 Space 后消失
check('骨架窗口设了 alwaysOnTop screen-saver', () => {
  const block = source.match(/function ensureOverlay\(\)[\s\S]*?\n\}/);
  assert.ok(block, '找不到 ensureOverlay');
  assert.match(block[0], /setAlwaysOnTop\(true, 'screen-saver'\)/);
});

check('骨架窗口鼠标穿透（否则整个屏幕点不动）', () => {
  const block = source.match(/function ensureOverlay\(\)[\s\S]*?\n\}/);
  assert.match(block[0], /setIgnoreMouseEvents\(true, \{ forward: true \}\)/,
    '没有设鼠标穿透，或者漏了 forward');
});

check('骨架窗口跨 Space 可见', () => {
  const block = source.match(/function ensureOverlay\(\)[\s\S]*?\n\}/);
  assert.match(block[0], /setVisibleOnAllWorkspaces\(true/);
});

check('骨架窗口不可聚焦（不抢焦点）', () => {
  const block = source.match(/function ensureOverlay\(\)[\s\S]*?\n\}/);
  assert.match(block[0], /focusable: false/);
});

// 主进程按 `showHands || recordingAction` 决定开不开骨架窗口，sensor 按自己的条件决定发不发
// 关键点。**这两个判据必须一致** —— 不一致的那半边不报错，只是录制时开出一个空窗口，
// 症状和"骨架坏了"分不清。这条守的是两个文件之间的一致性，不是单个函数的正确性。
check('sensor 发骨架的条件和主进程开窗口的条件一致（录制时都放行）', () => {
  const sensor = fs.readFileSync(path.join(__dirname, '..', 'src', 'sensor.js'), 'utf8');
  const send = sensor.slice(sensor.indexOf('function sendHands'), sensor.indexOf('function onResults'));
  assert.ok(/recorder\s*&&\s*recorder\.active/.test(send),
    'sendHands 没有为录制放行 —— 关掉骨架再录制会开出空窗口');

  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const sync = main.slice(main.indexOf('function syncOverlayVisibility'));
  assert.ok(/showHands\s*\|\|\s*recordingAction/.test(sync.slice(0, 400)),
    '主进程不再按 showHands || recordingAction 开窗口 —— 两边判据已经分叉');
});

console.log('\n  WE 网页壁纸接线');

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

// 去掉整行注释。源码守卫要查"代码里有没有这个写法"，而注释里常常故意写着错法当
// 反例 —— 全文匹配会把解释当违规。我在这上面栽过两次，所以抽出来共用。
function codeOnly(source) {
  return source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
}

// ⚠️ 这一节全部是"接线漏了但测试全绿"那一类的守卫。我在这个项目里反复栽在同一个形状上：
// 配置字段没人读、模块没被 require、IPC 没注册 —— 每次纯逻辑用例都是绿的，
// 而功能是死的（recorded 手势没人读、spawnSync 没导入、录制页面是空的）。

check('we-host.js 被 main.js 加载（否则 WE.* 全是 undefined）', () => {
  assert.match(mainSrc, /require\('\.\/we-host\.js'\)/);
  assert.match(mainSrc, /const WE = globalThis\.GestureWallWE/);
});

check('audio-source.js 被 main.js 加载', () => {
  assert.match(mainSrc, /require\('\.\/audio-source\.js'\)/);
});

// ⚠️ 时序硬约束：registerSchemesAsPrivileged 必须在 app ready 之前调用，
// 否则自定义 scheme 拿不到 standard/secure 特权 —— 而那正是 ES module 能加载的前提。
// 放进 whenReady 里不会报错，只会让壁纸白屏。
check('registerSchemesAsPrivileged 在 app.whenReady 之前', () => {
  const reg = mainSrc.indexOf('registerSchemesAsPrivileged');
  const ready = mainSrc.indexOf('app.whenReady');
  assert.ok(reg > 0, '没有注册特权 scheme —— ES module 会加载失败');
  assert.ok(reg < ready, 'registerSchemesAsPrivileged 在 whenReady 之后，特权不生效');
});

// web 类壁纸是 Vite 的 ES module，file:// 下加载不了（CORS）⟹ 必须走自定义 protocol。
//
// ⚠️ 但 video 类**必须**用 loadFile：那条装的是我们自己的 video.html，
// 而视频文件本身仍然走 wall:// 送进去。所以这条守卫查的是"web 那条分支不许用
// loadFile"，不是"整个函数不许出现 loadFile" —— 后者会把正确的实现判成错。
check('web 类走自定义 protocol，video 类走自己的页面', () => {
  const create = mainSrc.slice(mainSrc.indexOf('function createWEWindow'),
    mainSrc.indexOf('function sendWEProperties'));
  assert.ok(/loadURL\(`\$\{WE_SCHEME\}/.test(create),
    'web 类没走 wall:// protocol —— ES module 会加载失败');
  // video 那条分支要存在，而且它送进去的视频 URL 也得走 protocol
  assert.match(create, /type === 'video'/, 'video 和 web 的装载路径没分开');
  assert.match(create, /video-source/, 'video 页面没收到视频 URL');
  // ⚠️ 关键：loadFile 只能出现在 video 分支里
  const videoBranch = create.slice(create.indexOf("type === 'video'"),
    create.indexOf('} else {'));
  const webBranch = create.slice(create.indexOf('} else {'));
  assert.ok(/loadFile/.test(videoBranch), 'video 分支没用 loadFile 装自己的页面');
  assert.ok(!/loadFile/.test(webBranch),
    'web 分支用了 loadFile —— Vite 的 ES module 在 file:// 下加载不了，会白屏');
});

// 两种 preload 不能混：video 是我们自己的页面（要 gw 那套），
// web 是第三方壁纸（只给 WE 的 5 个全局函数，不给主进程通道）。
// ⚠️ 混了的后果：第三方壁纸拿到 gw.* ⟹ 能调我们所有 IPC。
check('video 和 web 用不同的 preload（第三方壁纸不该拿到 gw）', () => {
  const create = mainSrc.slice(mainSrc.indexOf('function createWEWindow'),
    mainSrc.indexOf('function sendWEProperties'));
  assert.match(create, /type === 'video'\s*\n?\s*\?\s*path\.join\(__dirname, 'preload\.js'\)/,
    'video 没用普通 preload');
  assert.match(create, /'we-preload\.js'/, 'web 没用受限的 we-preload');
});

// ⚠️ 这条翻过一次，翻的方向值得记：我原来为了拿到页面挂的
// window.wallpaperPropertyListener 关掉了 contextIsolation。但壁纸是从创意工坊下的
// 第三方 HTML，同世界意味着它可能摸到 require ⟹ 读用户的文件系统。
// 正确做法是两个方向各用各的桥（contextBridge 出去、executeJavaScript 进去），
// 隔离全程开着。**别为了接口形状退让安全边界。**
check('WE 窗口保持 contextIsolation + sandbox（壁纸是第三方 HTML）', () => {
  const create = mainSrc.slice(mainSrc.indexOf('function createWEWindow'),
    mainSrc.indexOf('function sendWEProperties'));
  assert.match(create, /contextIsolation:\s*true/,
    'WE 窗口关了 contextIsolation —— 第三方壁纸可能拿到 require 读文件系统');
  assert.match(create, /nodeIntegration:\s*false/, 'WE 窗口开了 nodeIntegration');
  assert.match(create, /sandbox:\s*true/, 'WE 窗口没开 sandbox');
});

// 属性是反向的，隔离世界读不到页面挂的对象 ⟹ 必须用 executeJavaScript（跑在主世界）。
// ⚠️ 如果哪天有人把它改回 webContents.send，属性会静默发不进去。
check('属性走 executeJavaScript（主世界）而不是 IPC', () => {
  const fn = mainSrc.slice(mainSrc.indexOf('function applyWEProperties'),
    mainSrc.indexOf('const WE_PROP_RETRY_MS'));
  assert.match(fn, /executeJavaScript/, '属性没走 executeJavaScript，隔离下发不进去');
  assert.match(fn, /wallpaperPropertyListener/, '没去调壁纸挂的那个对象');
  // 拼字符串进 JS 必须转义 —— 壁纸目录名里一个引号就能把脚本劈开。
  assert.match(fn, /JSON\.stringify\(JSON\.stringify/,
    '属性没做双重转义，壁纸名里的引号会把注入脚本劈开');
});

check('we-preload 用 contextBridge 而不是直接改 window', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'we-preload.js'), 'utf8');
  assert.match(src, /contextBridge\.exposeInMainWorld/,
    'we-preload 没用 contextBridge —— 隔离开着时直接赋值 window 页面看不到');
  // 逐个 expose：壁纸检查的是平铺的 window.wallpaperRegisterXxx，不是命名空间。
  for (const name of ['wallpaperRegisterAudioListener', 'wallpaperReady',
    'wallpaperMediaIntegration']) {
    assert.ok(src.includes(`'${name}'`), `we-preload 没暴露 ${name}`);
  }
});

check('自己的三层景深壁纸仍然保持 contextIsolation: true', () => {
  const create = mainSrc.slice(mainSrc.indexOf('function createWallWindow'),
    mainSrc.indexOf('function createDashboard'));
  assert.match(create, /contextIsolation:\s*true/,
    '把自己的壁纸窗口也降到 contextIsolation:false 了');
});

// 两种壁纸源都钉在桌面层会互相遮挡，而"我看到的是哪个"就没法判断了。
check('装载 WE 壁纸时销毁三层景深窗口（两者互斥）', () => {
  // ⚠️ 用 lastIndexOf 找结束标记：那个字符串在上面的注释里也出现过一次，
  // 用 indexOf 会切出空串 —— 断言就变成"永远失败"。切片式的源码守卫都有这个坑。
  const start = mainSrc.indexOf('function setWEWallpaper');
  const end = mainSrc.lastIndexOf("ipcMain.on('we-ready'");
  assert.ok(start > 0 && end > start, `切片范围不对：${start}..${end}`);
  const fn = mainSrc.slice(start, end);
  assert.match(fn, /wallWindow\.destroy\(\)/, '没销毁旧壁纸窗口，两层会叠在一起');
});

check('broadcast 覆盖 weWindow（否则 WE 壁纸收不到任何广播）', () => {
  const fn = mainSrc.slice(mainSrc.indexOf('function broadcast'),
    mainSrc.indexOf('function broadcast') + 400);
  assert.match(fn, /weWindow/, 'broadcast 的窗口列表漏了 weWindow');
});

// 歌曲信息走 WE 自己的四通道协议，不是我们的 'track' 事件 —— 漏接的症状是
// 画面正常、封面永远空白。
check('onTrack 同时喂给 WE 壁纸的 media 通道', () => {
  const idx = mainSrc.indexOf("require('./nowplaying').install");
  const block = mainSrc.slice(idx, idx + 500);
  assert.match(block, /sendWEMedia/, 'onTrack 没喂给 WE 壁纸，封面会永远空白');
});

// WE 壁纸的每个 IPC 通道都要在 preload 里有对应出口，否则面板调不到。
check('WE 的 IPC 通道 preload 里都有出口', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  for (const channel of ['we-pick', 'we-clear', 'we-controls', 'we-status',
    'we-set-property', 'we-set-audio-source']) {
    assert.ok(preload.includes(channel), `preload 缺 ${channel}`);
    assert.ok(mainSrc.includes(channel), `main.js 没注册 ${channel}`);
  }
});

// we-preload 是独立的 preload，不能暴露 ipcRenderer 给第三方 HTML。
check('we-preload 只暴露 wallpaper* 的东西（不给页面主进程通道）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'we-preload.js'), 'utf8');
  const exposed = [...src.matchAll(/exposeInMainWorld\('(\w+)'/g)].map((m) => m[1]);
  assert.ok(exposed.length >= 5, `只暴露了 ${exposed.length} 个，WE 契约要 5 个 register + 常量`);
  for (const name of exposed) {
    assert.ok(/^wallpaper/.test(name),
      `we-preload 暴露了非 WE 的东西：${name} —— 第三方壁纸能拿到它`);
  }
  // 直接赋值 window 在隔离下无效（页面看不到），出现就是没理解隔离模型。
  assert.ok(!/^\s*window\.\w+\s*=/m.test(src),
    'we-preload 里有直接给 window 赋值 —— 隔离开着时页面看不到，属于无效代码');
});

// ⚠️ 时序：那 5 个 register 函数必须在页面脚本之前存在。样本的 index.html 用
// `if (window.wallpaperRegister...)` 判断，晚一步就是全 false —— 画面正常但永远没数据。
check('we-preload 在模块顶层就挂好 register 函数（不等 IPC 或 DOM）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'we-preload.js'), 'utf8');
  const assignIdx = src.indexOf('window.wallpaperRegisterAudioListener');
  assert.ok(assignIdx > 0, '没挂 audio listener');
  // 赋值语句不该在任何回调/函数体里。取赋值之前的代码，括号必须是平衡的。
  const before = src.slice(0, assignIdx);
  const opens = (before.match(/\{/g) || []).length;
  const closes = (before.match(/\}/g) || []).length;
  assert.strictEqual(opens, closes,
    'register 函数的赋值在某个函数体里 —— 页面脚本跑的时候可能还不存在');
});

check('音频 helper 源码存在且 main.js 指向它', () => {
  const swift = path.join(__dirname, '..', 'native', 'GestureWallAudio.swift');
  assert.ok(fs.existsSync(swift), 'helper 源码不在');
  assert.match(mainSrc, /GestureWallAudio\.swift/, 'main.js 没指向 helper 源码');
});

// 静默是这条链的主要失败模式，状态必须播报出去。
check('音频状态会广播到面板', () => {
  assert.match(mainSrc, /we-audio-status/, '音频状态没广播 —— 没授权时用户只看到柱子不动');
});

// helper 是独立进程，不杀会留下孤儿占着屏幕录制权限。
check('退出时杀掉音频 helper', () => {
  const idx = mainSrc.indexOf("app.on('will-quit'");
  const block = mainSrc.slice(idx, idx + 300);
  assert.match(block, /audioTap/, '退出时没停 helper，会留孤儿进程占着屏幕录制');
});

// ⚠️ 这条守的是我刚犯的错：renderWEControls 里用了 .chip / .val 这两个 CSS 里
// 根本不存在的类。后果是控件渲染出来但完全没样式 —— **不报错，测试也全绿**，
// 只有截图才看得出来。和"录制页面是空的"那次同一个形状。
check('dashboard.js 用到的 CSS 类在 dashboard.html 里都有定义', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));

  const used = new Set();
  // className = 'x' / className = 'x y' / el('div', 'x')
  for (const m of js.matchAll(/className\s*=\s*'([a-z0-9 -]+)'/g)) {
    m[1].split(/\s+/).filter(Boolean).forEach((c) => used.add(c));
  }
  for (const m of js.matchAll(/\bel\('[a-z]+',\s*'([a-z0-9 -]+)'/g)) {
    m[1].split(/\s+/).filter(Boolean).forEach((c) => used.add(c));
  }

  const missing = [...used].filter((c) => !style.includes(`.${c}`));
  assert.deepStrictEqual(missing, [],
    `这些类没有样式定义，控件会裸奔：${missing.join(', ')}`);
});

console.log('\n  面板可达性（接线齐了但点不到 = 功能不存在）');

// ⚠️ 这条的由来：录关键点那条链在合并时主进程、preload、sensor 三层都接好了，
// **唯独面板上没有按钮**。每一层单独看都对，整条链却没有入口 ⟹ 功能等于不存在，
// 而且所有测试全绿。
//
// 这是本项目反复出现的那个形状的又一次（未读的 config 字段、没导入的 spawnSync、
// 默认空的录制页）。所以按"preload 暴露了什么"反查"面板用了没有"。
check('preload 暴露的调用，面板里都有地方触发', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  const wall = fs.readFileSync(path.join(__dirname, '..', 'src', 'wall.js'), 'utf8');
  const sensor = fs.readFileSync(path.join(__dirname, '..', 'src', 'sensor.js'), 'utf8');
  const overlay = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay-window.js'), 'utf8');
  // ⚠️ 消费者名单要跟着新页面走。漏一个的后果是**假阳性** —— 守卫说"点不到"
  // 而其实接好了，于是我会去"修"一个不存在的问题。加新渲染进程页面时要加到这里。
  const video = fs.readFileSync(path.join(__dirname, '..', 'src', 'video.js'), 'utf8');
  const consumers = dash + wall + sensor + overlay + video;

  // 只查主动调用（invoke/send 那类），不查 onXxx 监听 —— 监听没人用是浪费，
  // 但主动调用没人用意味着**用户点不到那个功能**。
  const exposed = [...preload.matchAll(/^\s{2}(\w+):\s*\([^)]*\)\s*=>\s*ipcRenderer\.(invoke|send)/gm)]
    .map((m) => m[1]);
  assert.ok(exposed.length > 10, `只解析出 ${exposed.length} 个调用，正则失效了`);

  const unreachable = exposed.filter((name) => !consumers.includes(name));
  assert.deepStrictEqual(unreachable, [],
    `这些通道齐了但没有任何界面能触发 ⟹ 功能点不到：${unreachable.join(', ')}`);
});

// 录关键点是两边共同盲区的唯一出口（所有测试都跑在合成手上，缺真机噪声的时间
// 相关性）。它必须能被点到，而且失败要说得出原因。
check('录关键点的三层都在，且按钮存在', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const sensor = fs.readFileSync(path.join(__dirname, '..', 'src', 'sensor.js'), 'utf8');

  assert.match(html, /id="capture-start"/, '面板没有录关键点的按钮');
  assert.match(dash, /gw\.startCapture\(\)/, '按钮没接 startCapture');
  assert.match(main, /ipcMain\.handle\('start-capture'/, '主进程没注册 start-capture');
  assert.match(sensor, /onStartCapture/, 'sensor 不听 start-capture ⟹ 录不到东西');

  // ⚠️ 字段名对齐：主进程返回 {ok:false, reason:…}，面板读错字段就只会显示兜底文案，
  // 而"摄像头没开"恰恰是最常见的失败原因。
  assert.match(main, /ok:\s*false,\s*reason:/, '主进程的失败载荷不带 reason 了');
  assert.match(dash, /result\.reason/, '面板没读 reason —— 最常见的失败原因会显示不出来');
});

// 0 帧有手也会存出一个"看起来成功"的文件（有大小、能打开），而它完全没用。
check('录完报的是有手的帧数，不只是总帧数', () => {
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  assert.match(dash, /withHands/, '没报有手帧数 —— 0 帧有手的空文件会看起来像成功');
});

// ⚠️ 关键点录制的载荷必须带当时生效的 tuning。
//
// 回放探针的每个门限（挥动速度/倾斜角/匹配阈值）都从 capture.tuning 读，缺了会
// **静默回落到默认常数** ⟹ 用户调过参数的那次回放被拿默认值去判，报出一组自信但
// 错的数字。而这个文件存在的全部目的就是把那些常数从猜变成量 —— 判据错了整件事反过来。
//
// 这条守的是跨文件、跨仓库的一致性（sensor.js 产出 ↔ probes/replay-landmarks.js 消费），
// 任何一侧的单测都看不见。
check('关键点录制带上当时的 tuning（否则探针会拿默认值误判）', () => {
  const sensor = fs.readFileSync(path.join(__dirname, '..', 'src', 'sensor.js'), 'utf8');
  const save = sensor.slice(sensor.indexOf('function captureFrame'),
    sensor.indexOf('function onResults'));
  assert.match(save, /tuning:\s*tuningOf\(\)/,
    'capture 载荷没带 tuning —— 回放探针会静默用默认门限判定');
});

// ⚠️ WE 网页壁纸的交互主体是鼠标（样本 pointerdown ×9、onClick ×8，"点一下掉流星"
// 是它的卖点）。而 desktop 策略是真壁纸层、收不到鼠标 ⟹ 装上去是"画面出来了但点它
// 没反应"，和壁纸本身坏了分不清。所以它必须默认用能收鼠标的策略。
check('WE 壁纸默认用能收鼠标的层策略（不是 desktop）', () => {
  const fn = mainSrc.slice(mainSrc.indexOf('function createWEWindow'),
    mainSrc.indexOf('function sendWEProperties'));
  assert.match(fn, /config\.we\.strategy\s*\|\|\s*'bottom-normal'/,
    'WE 窗口跟着 wallStrategy 走了 —— 默认 desktop 收不到鼠标，交互整个不工作');
  const defaults = mainSrc.slice(mainSrc.indexOf('const defaultConfig'),
    mainSrc.indexOf('let config = null'));
  assert.match(defaults, /strategy:\s*'bottom-normal'/, 'we.strategy 的默认值不对');
});

// 资产解析走 we-host 的纯函数，不在 main.js 里手写 —— 那三种错法（越界/空路径/
// 百分号编码）都是白屏，而白屏在主进程里没法测。
check('protocol 用 WE.resolveAsset 而不是自己拼路径', () => {
  const fn = mainSrc.slice(mainSrc.indexOf('function registerWEProtocol'),
    mainSrc.indexOf('function loadWEProject'));
  assert.match(fn, /WE\.resolveAsset/, 'protocol 没用 resolveAsset');
  // ⚠️ 裸拼 file:// 会让目录名里的 # ? % 静默截断路径 ⟹ 404 ⟹ 白屏。
  // 中文和空格恰好没事，所以"拿中文路径测过"证明不了它安全。
  assert.match(fn, /pathToFileURL/, '裸拼了 file:// —— 目录名带 # ? % 会静默 404');
  // ⚠️ 只看代码行：注释里把错法写成反例了，全文匹配会把解释当违规。
  // 这是我第二次踩（上次是 templateAngle: 0 那条），所以这次直接抽成 helper。
  assert.ok(!/`file:\/\/\$\{/.test(codeOnly(fn)),
    '还在用模板字符串拼 file:// URL');
});

// ⚠️ 打包后 __dirname 在 asar 归档里，而 swiftc 读不了归档里的文件（那不是目录）。
// 症状：开发模式好用，打包后音频静默不工作 —— 而打包正是验音频的唯一途径。
check('helper 源码路径按打包状态分叉（asar 里读不到文件）', () => {
  const idx = mainSrc.indexOf('AudioSource.start(');
  const block = mainSrc.slice(idx, idx + 900);
  assert.match(block, /app\.isPackaged/,
    'helper 源码路径没按打包状态分叉 —— 打包后 swiftc 读不到 asar 里的文件');
  assert.match(block, /process\.resourcesPath/, '打包分支没走 resourcesPath');
});

// 开发模式和打包后是两个授权身份。文案说错会让用户去找一个不存在的列表项，
// 然后合理地怀疑自己操作错了 —— 那比不提示更糟。
check('权限提示按打包状态分叉（npm start 下那个权限不可达）', () => {
  const audio = fs.readFileSync(path.join(__dirname, '..', 'src', 'audio-source.js'), 'utf8');
  assert.match(audio, /function permissionHint\(packaged\)/, '没有分身份的提示函数');
  assert.match(codeOnly(audio), /npm start/, '开发模式那条文案没提到 npm start');
  const idx = mainSrc.indexOf('AudioSource.start(');
  assert.match(mainSrc.slice(idx, idx + 900), /packaged:\s*app\.isPackaged/,
    'main.js 没把打包状态传给音频层');
});

console.log('\n  创意工坊与诊断');

check('workshop.js 被 main.js 加载', () => {
  assert.match(mainSrc, /require\('\.\/workshop\.js'\)/);
  assert.match(mainSrc, /const Workshop = globalThis\.GestureWallWorkshop/);
});

// ⚠️ 这条是安全边界，不是洁癖：诊断报告是设计给用户导出后发给别人看的，
// 而 config 里存着 Steam 明文密码。忘了脱敏 = 让用户把密码贴进聊天记录。
check('诊断报告里的 Steam 密码被脱敏', () => {
  assert.match(mainSrc, /function redactConfig/, '没有脱敏函数');
  const fn = mainSrc.slice(mainSrc.indexOf('function redactConfig'),
    mainSrc.indexOf('function redactConfig') + 500);
  assert.match(fn, /password/, '没处理 password');
  assert.match(fn, /guardCode/, '没处理 guardCode');
  // 报告组装处必须调它，光有函数没用
  const report = mainSrc.slice(mainSrc.indexOf("ipcMain.handle('export-diagnostics'"),
    mainSrc.indexOf("function redactConfig"));
  assert.match(report, /redactConfig\(config\)/, '报告里直接放了原始 config');
});

// 日志里也有密码（steamcmd 的参数）。
check('steamcmd 参数进日志前脱敏', () => {
  const handler = mainSrc.slice(mainSrc.indexOf("ipcMain.handle('workshop-download'"),
    mainSrc.indexOf("ipcMain.handle('workshop-set-steam'"));
  assert.match(handler, /redactArgs/, 'steamcmd 参数没脱敏就进日志了');
});

// ⚠️ steamcmd 说"成功"不等于文件在我们以为的地方 —— 那个根目录是**推断**的
// （steamcmd 所在目录的上两级）。不验证就报成功的话，症状是"下载完了什么都没发生"。
check('下载后验证文件真的落地了，才报成功', () => {
  const handler = mainSrc.slice(mainSrc.indexOf("ipcMain.handle('workshop-download'"),
    mainSrc.indexOf("ipcMain.handle('workshop-set-steam'"));
  // 验证逻辑在 workshop.js 的 findDownloaded 里（纯函数、可测），main 只注入 existsSync。
  assert.match(handler, /findDownloaded\(workshopId, \(p\) => fs\.existsSync\(p\)\)/,
    '没验证文件真的落地了');
  // ⚠️ 找不到时要把找过的**所有**路径报出来。我在这条上栽过：原来按
  // "steamcmd 二进制的上两级"推数据根目录，而 brew 装的话那是 /opt/homebrew，
  // 完全不对（真实位置是 ~/Library/Application Support/Steam）。
  // 不列路径的话，那种失败完全没法查。
  assert.match(handler, /searched/, '找不到文件时没列出找过哪些路径');
});

// 诊断报告的第一要素。⚠️ packaged: false 时权限类结论全都不可信
//（npm start 下屏幕录制/辅助功能根本不可达）—— 这条是另一个模块烧掉四轮的教训。
check('诊断报告带 app.isPackaged', () => {
  const report = mainSrc.slice(mainSrc.indexOf("ipcMain.handle('export-diagnostics'"),
    mainSrc.indexOf('const dir = path.join(app.getPath(\'userData\'), \'diagnostics\')'));
  assert.match(report, /packaged:\s*app\.isPackaged/,
    '报告没带打包状态 —— 权限类结论会被误读');
});

// 报告里要有"实际拿到的窗口尺寸 vs 屏幕尺寸" —— 菜单栏那条缝就是这么看出来的。
check('诊断报告带窗口存活状态和实际尺寸', () => {
  const report = mainSrc.slice(mainSrc.indexOf("ipcMain.handle('export-diagnostics'"), -1);
  assert.match(report, /weBounds/, '没带 WE 窗口的实际尺寸');
  assert.match(report, /display:/, '没带屏幕尺寸，没法比对');
});

// ⚠️ 事件环是兜底：我的关键字分类可能漏，而原始时间戳记录不会。
check('事件有上限（不然长跑会吃内存）', () => {
  assert.match(mainSrc, /EVENT_LIMIT/, '事件环没有上限');
  const fn = mainSrc.slice(mainSrc.indexOf('function logEvent'),
    mainSrc.indexOf('function logEvent') + 400);
  assert.match(fn, /events\.shift\(\)/, '超上限没丢旧的');
});

console.log('\n  video 类');

// ⚠️ 黑屏有五种原因且长得一样。这条守的是"在放但看不见"那个信号 ——
// 没有它，"解码正常但层级不对"和"根本放不了"分不开，而修法完全不同。
check('video 页面汇报分辨率和播放位置（区分"放不了"和"看不见"）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'video.js'), 'utf8');
  assert.match(src, /videoWidth/, '没报分辨率 —— 那是解码成功的硬证据');
  assert.match(src, /currentTime/, '没报播放位置');
  assert.match(src, /timeupdate/, '没监听播放进度');
});

// HEVC 是真实风险：WE 工坊里有 H.265 的视频，而 Electron 的 Chromium 默认不带解码器。
// 那种壁纸黑屏，原因和"我们代码坏了"完全不同。
check('解码失败时点名 HEVC/AV1（最可能的真实原因）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'video.js'), 'utf8');
  assert.match(src, /HEVC/, '没提 HEVC —— 那是工坊视频最常见的放不了原因');
  assert.match(src, /MediaError|video\.error/, '没读 MediaError');
});

check('换源时显式 load（否则旧视频继续放）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'video.js'), 'utf8');
  assert.match(src, /video\.load\(\)/,
    '换源没调 load —— 旧的那段会继续放，看起来像装载失败');
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);