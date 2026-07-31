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

// 契约变了:窗口的存在条件是"手势开着",因为摄像头就在这一层(和 AirCursor 3.x 一样)。
// "显示骨架"那个开关只控制**画不画**,不控制建不建窗口 —— 按 showHands 建拆会连摄像头
// 一起拆掉,而"我不想看骨架"不等于"我不想用手势"。
check('手势开 + 开关关 → 窗口还在（摄像头在这一层）', () => {
  assert.strictEqual(wantsOverlay(cfg(true, false), null), true);
});

check('关掉显示骨架时真的不画（否则窗口留着就等于一直显示）', () => {
  const win = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay-window.js'), 'utf8');
  const overlay = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay.js'), 'utf8');
  assert.match(win, /showSkeleton \|\| overlay\.recording/, '帧循环没有按开关决定画不画');
  assert.match(win, /overlay\.clear\(\)/, '不画时没有擦画布 —— 上一帧会留在屏幕上');
  assert.match(overlay, /clear\(\)\s*\{/, 'overlay 没有 clear 方法');
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
// 摄像头和骨架同窗口之后,这条"两个文件判据一致"的守卫换了对象:sendHands 仍要为录制
// 放行(录制时必须看见手),而窗口的存在条件已经和 showHands 解耦。
check('sendHands 为录制放行（录制时必须看见手）', () => {
  const sensor = fs.readFileSync(path.join(__dirname, '..', 'src', 'sensor.js'), 'utf8');
  const send = sensor.slice(sensor.indexOf('function sendHands'), sensor.indexOf('function onResults'));
  assert.ok(/recorder\s*&&\s*recorder\.active/.test(send),
    'sendHands 没有为录制放行 —— 关掉骨架再录制会开出空窗口');

  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const sync = main.slice(main.indexOf('function syncOverlayVisibility'));
  assert.ok(/gestures\.enabled/.test(sync.slice(0, 600)),
    '窗口的存在条件必须是 gestures.enabled —— 摄像头在这一层,按 showHands 拆会连摄像头一起拆');
});

// ── 能力可达性：接线齐了但用户点不到，等于没做 ──────────────────────────
//
// 这四条来自云端 agent，而它们逮到的正是我的错：我把 startCapture / undoRecording /
// pointerHealth 都接了 preload + 主进程 + sensor 三层，面板零入口 —— 而我还跟用户说
// "接进面板了"。三层各自都对，整条链没有入口，所有测试全绿。
//
// pointerHealth 那条最难看：它观测的正是"缺权限时 CGEvent.post 静默丢弃"，而我为那件事
// 烧掉四轮。把观测手段建好却没地方看，等于没建。
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
  // 媒体那条分支要存在，而且它送进去的 URL 也得走 protocol。
  // ⚠️ 判据是 isMediaType（video + image 两种）而不是字面量 'video' ——
  // image 是我们为 legacy 单文件壁纸造的类型，见 we-host.js 的 TYPES 注释。
  assert.match(create, /WE\.isMediaType\(weProject\.type\)/,
    '媒体类和 web 的装载路径没分开');
  assert.match(create, /video-source/, 'video 页面没收到视频 URL');
  // ⚠️ 关键：loadFile 只能出现在 video 分支里
  const videoBranch = create.slice(create.indexOf('WE.isMediaType(weProject.type)'),
    create.indexOf('} else {'));
  const webBranch = create.slice(create.indexOf('} else {'));
  assert.ok(/loadFile/.test(videoBranch), 'video 分支没用 loadFile 装自己的页面');
  assert.ok(!/loadFile/.test(webBranch),
    'web 分支用了 loadFile —— Vite 的 ES module 在 file:// 下加载不了，会白屏');
});

// 两种 preload 不能混：video 是我们自己的页面（要 gw 那套），
// web 是第三方壁纸（只给 WE 的 5 个全局函数，不给主进程通道）。
// ⚠️ 混了的后果：第三方壁纸拿到 gw.* ⟹ 能调我们所有 IPC。
check('媒体类和 web 用不同的 preload（第三方壁纸不该拿到 gw）', () => {
  const create = mainSrc.slice(mainSrc.indexOf('function createWEWindow'),
    mainSrc.indexOf('function sendWEProperties'));
  // 媒体页是我们自己的（要 gw 那套），web 是第三方壁纸（只给 WE 的 5 个全局函数）。
  // ⚠️ 混了的后果：第三方壁纸拿到 gw.* ⟹ 能调我们所有 IPC。
  assert.match(create, /isMediaType[\s\S]{0,120}'preload\.js'/,
    '媒体类没用普通 preload');
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
  // ⚠️ 不用"另一个符号的位置"当终点 —— 那依赖两个东西在文件里的**先后顺序**，
  // 而合并会改变顺序。这条守卫在合并时就是这么失败的：`we-ready` 的重复注册被删掉之后，
  // 它的终点跑到了起点前面（报「切片范围不对：58752..55465」）。
  //
  // 改成从函数起点数括号找它自己的结尾 —— 那只依赖这个函数本身。
  const start = mainSrc.indexOf('function setWEWallpaper');
  assert.ok(start > 0, '找不到 setWEWallpaper');
  let depth = 0;
  let end = start;
  for (let i = mainSrc.indexOf('{', start); i < mainSrc.length; i += 1) {
    if (mainSrc[i] === '{') depth += 1;
    else if (mainSrc[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > start, '数不出函数边界');
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
  // ⚠️ 剥注释再切，而且切到块尾而不是固定 300 字符 ——
  // 我在 will-quit 开头加了拆窗口的代码和一段注释，固定长度的切片就被推走了，
  // 于是这条断言在正确代码上报红。**切片长度是个会漂的锚点。**
  const bare = codeOnly(mainSrc);
  const idx = bare.indexOf("app.on('will-quit'");
  const block = bare.slice(idx, bare.indexOf('});', idx));
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

// ── 和 AirCursor 3.x 的差距：三条都是真机数据逼出来的 ──────────────────────
//
// 用户报"现在不如 3.x 版本丝滑到位"，而那一版有真机报告可比：同一台机器 30fps、推理
// 12ms。这次录的关键点是 14fps。三个根因，全部是这边缺了那边有的东西。

check('推理有 busy 闸门（没有它真机只有 14fps）', () => {
  const sensor = fs.readFileSync(path.join(__dirname, '..', 'src', 'sensor.js'), 'utf8');
  assert.match(sensor, /if \(inferenceBusy \|\|/,
    '每帧无条件 await hands.send 会串行堆积：实际帧率变成 1/(推理+摄像头间隔)，'
    + '而不是取两者较大值。3.x 有这道闸，跑 30fps；没有它实测 14fps');
  assert.match(sensor, /finally \{[\s\S]{0,80}inferenceBusy = false/,
    '解锁必须在 finally：推理抛异常时不解锁会让手势永久停住，症状是"突然就不动了"');
});

check('推理间隔可调，且默认值来自 3.x 的真机报告', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(main, /inferenceIntervalMs: 20/, '20ms 来自 3.x 真机 30fps/推理12ms 那份报告');
  const sensor = fs.readFileSync(path.join(__dirname, '..', 'src', 'sensor.js'), 'utf8');
  assert.match(sensor, /gestureTuning\.inferenceIntervalMs/,
    '从 config 读而不是写死 —— 写死的话真机上想调只能改代码重启');
});

check('指针跟食指指尖，不是掌心', () => {
  const input = fs.readFileSync(path.join(__dirname, '..', 'src', 'input.js'), 'utf8');
  assert.match(input, /const tip = lm\[8\];[\s\S]{0,200}this\.pointer\.update\(tip\.x, tip\.y/,
    '实测同一帧掌心和指尖差 36-38% 屏宽 —— 用掌心等于"指着一处、光标出现在大半个屏幕外"。'
    + '3.x 用的是 gesture.index（指尖），那一版的评价是"很到位"');
});

check('视差用掌心，指针用指尖 —— 两个信号分开发', () => {
  const input = fs.readFileSync(path.join(__dirname, '..', 'src', 'input.js'), 'utf8');
  const wall = fs.readFileSync(path.join(__dirname, '..', 'src', 'wall.js'), 'utf8');
  assert.match(input, /palmX:/, 'pointer 事件要同时带掌心，否则视差只能用指尖');
  assert.match(wall, /g\.palmX/, '视差要用掌心：指尖会随屈指乱跳，画面会跟着手指头而不是手');
});

check('骨架一比一映射，不做"固定手宽"缩放', () => {
  const overlay = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay.js'), 'utf8');
  assert.doesNotMatch(overlay, /function toCanvas\([^)]*center[^)]*scale/,
    'toCanvas 不该再接 center/scale —— 那个缩放把指尖朝掌心收缩了（实测 0.54 倍）');
});


check('改函数签名后调用点都跟上了（JS 不会为多传的参数报错）', () => {
  const overlay = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay.js'), 'utf8');
  // 上一轮我把 toCanvas 从 (p,w,h,center,scale) 改成 (p,w,h)，却漏了两个调用点。
  // 多余的实参被静默忽略 ⟹ 缩放照旧生效，而我以为改完了，用户第二次报"还是偏右"。
  const calls = [...overlay.matchAll(/toCanvas\(([^)]*)\)/g)]
    .map((m) => m[1].split(',').length)
    .filter((n) => n > 3);
  assert.deepStrictEqual(calls, [],
    `toCanvas 有调用点还在传 4 个以上参数 —— 那是旧的缩放签名，JS 不会报错但缩放会照旧生效`);
});

// 摄像头没有独立窗口了 —— 它在骨架层里(和 AirCursor 3.x 一样)。
//
// 那个独立窗口试过三种藏法,三种都失败:show:false 拿不到摄像头授权(macOS 只对可见窗口
// 弹);完全挪到屏幕外被 macOS 钳回来;挪到主屏顶边之上 —— 而用户有外接显示器,那个位置
// 正好落在外接屏上,于是外接屏出现一个黑框。
//
// 靠位置藏在多显示器下没有正确答案:任何"屏幕外"坐标都可能是另一块屏的屏内。所以窗口
// 本身去掉了,而不是继续找藏法。
check('摄像头在骨架层里，没有独立的 sensor 窗口', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const overlayHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay.html'), 'utf8');
  assert.doesNotMatch(main, /sensorWindow/, '还有 sensor 窗口的残留');
  assert.doesNotMatch(main, /ensureSensor/, 'ensureSensor 应该已经删掉');
  assert.match(overlayHtml, /<video id="cam"/, '骨架层里没有 video —— 摄像头没搬过来');
  assert.match(overlayHtml, /src="sensor\.js"/, '骨架层没加载 sensor.js');
});

check('骨架层可聚焦，否则摄像头授权弹窗没人能回答', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const block = main.slice(main.indexOf('function ensureOverlay'), main.indexOf('function destroyOverlay'));
  // 这是那个独立 sensor 窗口原本存在的理由,而正确解法是让骨架层可聚焦 ——
  // AirCursor 3.x 的 overlay 就没设 focusable:false,它靠 setIgnoreMouseEvents 做穿透。
  // 穿透和不可聚焦是两件事。
  // 只看非注释行:文件里有一段注释解释"为什么不设 focusable:false",而按整段文本匹配
  // 会把那段注释当成违规 —— 守卫太宽会逼人删掉解释,而解释正是下次别再犯的唯一依据。
  const code = block.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /focusable:\s*false/,
    '骨架层设了 focusable:false —— getUserMedia 的授权弹窗会没人能回答');
  assert.match(block, /setIgnoreMouseEvents/, '穿透要靠 setIgnoreMouseEvents,不是靠不可聚焦');
});

// ⚠️ 这条守的是一个**能把用户锁在电脑外面**的失败。
//
// 上一版为了让摄像头授权弹窗可点,把穿透做成"拿到授权后才开"。后果:这一层盖在全屏
// 最上层且不穿透 ⟹ 整个屏幕点不动 ⟹ 用户连关掉这个 App 都做不到。实测撞到过
// ("鼠标直接废掉了,屏幕上所有的东西都点不动了")。
//
// 授权不需要**整层**可点,只需要请求发生在一个可交互的窗口里。所以穿透无条件开,
// 而且有三重保险 + 一个不依赖鼠标的逃生开关。
check('骨架层的穿透是无条件的（否则整个屏幕点不动）', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const block = main.slice(main.indexOf('function ensureOverlay'), main.indexOf('function destroyOverlay'));
  const code = block.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  // 不能有任何条件包着它 —— 条件为假的那一刻鼠标就废了。
  assert.doesNotMatch(code, /if\s*\([^)]*\)\s*\{?\s*\n?\s*overlayWindow\.setIgnoreMouseEvents/,
    '穿透被条件包住了 —— 条件不成立时整个屏幕会点不动');
  assert.match(code, /setIgnoreMouseEvents\(true, \{ forward: true \}\)/, '没有开穿透');
  // ready-to-show 后重设:窗口重建时 Electron 可能丢掉之前那次设置。
  assert.match(code, /ready-to-show[\s\S]{0,200}setIgnoreMouseEvents/,
    '没有在 ready-to-show 后重设穿透 —— 那次设置可能被窗口重建丢掉');
});

check('有一个不依赖鼠标的逃生开关，而且告诉了用户', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  // 一个能把自己锁在外面的程序必须有不依赖鼠标的出口,而且不能和"退出"绑在一起 ——
  // 用户可能只想拿回鼠标,不是想关掉壁纸。
  assert.match(main, /Control\+Shift\+X[\s\S]{0,200}destroyOverlay\(\)/,
    '没有"拆掉骨架层"的全局快捷键');
  // 写在代码里但用户不知道,等于没有 —— 出事时他没法查文档。
  //
  // ⚠️ 这条原来查 `wall.html`(壁纸层那个引导浮层里写着它)。而用户要求删掉整个引导页
  // ——「不,这个引导就不该存在」—— 于是这个说明差点跟着消失,**而它是"鼠标全屏点不动"时
  // 唯一的出路**(我曾经真的把用户锁在电脑外面)。这条守卫当场逮住了那个损失。
  //
  // 现在它必须出现在两个地方:启动时的终端输出(那是唯一必然可见的地方,而且出事时
  // 用户手上就有),以及面板。
  // ⚠️ 只看**启动时打印的那几行**,不是整个文件。
  //
  // 第一版用 `/⌃⇧X[^\n]*(拆掉|骨架)/` 匹配整个 main.js —— 而那也命中了拆掉骨架层时
  // 广播的那条日志(它同样含 ⌃⇧X 和"骨架")。于是删掉启动信息里那半句,守卫**依然通过**。
  // 我是靠反向验证发现的:两个方向都验才知道它锚在了别的东西上。
  // ⚠️ 锚点不能用 `=== GestureWall ===` 这个**字面串** —— 那行现在带 build 标识
  // (`=== GestureWall ${buildStamp()} ===`) ⟹ indexOf 返回 -1，slice(-1) 只剩一个字符，
  // 断言就会在正确代码上报红。实测踩到过。用 'GestureWall ' 定位。
  const bannerAt = main.indexOf("=== GestureWall");
  assert.ok(bannerAt > 0, '找不到启动横幅 —— 那几行是出事时唯一必然可见的地方');
  const banner = main.slice(bannerAt);
  assert.match(banner.slice(0, 400), /⌃⇧X/,
    '终端启动信息里没有 ⌃⇧X —— 出事时用户无处可查(那几行是唯一必然可见的地方)');
  assert.match(dash, /⌃⇧X/, '面板没列出这个快捷键');
});

check('语音默认关，且不在启动时抢麦克风', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'src', 'system-bridge.js'), 'utf8');
  assert.match(main, /voice: false/, '语音必须默认关');
  // 用户报："每次打开我们的产品，正在听的音乐音道就变了" —— helper 一启动就占麦克风，
  // 而 macOS 上抢占音频输入会切换输入设备。可选功能不该有这种副作用。
  const start = bridge.slice(bridge.indexOf('    start() {'), bridge.indexOf('    startVoice()'));
  assert.doesNotMatch(start, /startVoiceHelper\(\)/,
    'start() 里还在启动语音 helper —— 那会在打开产品时抢走麦克风');
  assert.match(bridge, /startVoice\(\)/, '语音要能按需启动');
  assert.match(bridge, /stopVoice\(\)/, '关掉时要真的杀掉 helper，否则麦克风一直被占');
});

check('三种权限都有授权入口（麦克风/语音识别单列）', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  for (const [name, handler, button] of [
    ['辅助功能', 'open-accessibility', 'grantAccessibility'],
    ['摄像头', 'open-camera-settings', 'grantCamera'],
    ['麦克风', 'open-microphone-settings', 'grantMic'],
    ['语音识别', 'open-speech-settings', 'grantSpeech'],
  ]) {
    assert.ok(main.includes(handler), `${name} 没有打开设置的处理`);
    assert.ok(html.includes(button), `${name} 没有按钮`);
  }
  // 语音识别授给的是 helper 不是主 App，这条在 AirCursor 上花过时间。
  assert.match(html, /AirCursorVoice/, '没告诉用户语音识别那项要找 helper 的名字');
});


check('canvas 有 CSS 尺寸 —— 缺了整张画布会被压到屏幕左上角', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay.html'), 'utf8');
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  // canvas 是 inline 元素，没有 CSS 尺寸时用默认 300x150，而 resize() 设的是
  // canvas.width（绘制缓冲）—— 两者独立。缓冲 2940x1912 而 CSS 停在 300x150 的后果是
  // 手在 x=0.74 画到屏幕 222px 而不是 1088px。症状是"骨架偏右下角"，而我为此改了两轮
  // 画布内部的坐标计算，全都改错了地方。
  const rules = [...style.matchAll(/#hands\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(rules.length > 0, '#hands 没有任何 CSS 规则');
  // 最后一条规则生效，所以它必须带尺寸 —— 早期这里有两条，后一条没尺寸把前一条覆盖了。
  const winner = rules[rules.length - 1];
  assert.match(winner, /width:\s*100vw/, '生效的那条 #hands 规则没有宽度');
  assert.match(winner, /height:\s*100vh/, '生效的那条 #hands 规则没有高度');
});

check('骨架几何自检存在，而且面板能看到', () => {
  const overlay = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay.js'), 'utf8');
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  // 自检报的是端到端：归一化坐标 → 屏幕像素，加上中间三层尺寸。缺任何一层都定位不到
  // 这次那个 bug，而那个 bug 让两轮修复零效果。
  assert.match(overlay, /selfCheck\(\)/, 'overlay 没有几何自检');
  assert.match(overlay, /consistent:/, '自检没有报"三层尺寸一致吗"');
  assert.match(overlay, /mapped:/, '自检没有报端到端映射');
  // 没人能看的自检等于没有 —— 本轮已经犯过一次（三层接好、面板零入口）。
  assert.match(dash, /onOverlayGeometry/, '面板没有订阅几何自检');
  assert.ok(html.includes('overlay-geom'), '面板没有显示几何自检的地方');
});


// ── 同窗口脚本的顶层声明不能撞名 ─────────────────────────────────────────
//
// 摄像头搬进骨架层之后，sensor.js 和 overlay-window.js 跑在同一个窗口里，而两边都在
// 顶层 `const T = window.GestureWallTemplates` ⟹ "Identifier 'T' has already been
// declared" ⟹ **整层脚本全部停止执行**。
//
// 症状是"摄像头不启动"，和重名没有任何表面关系。我为此猜了两轮，直到把渲染进程的
// console 转出来才看到那一行 —— 而那条日志转发是上一个 commit 才加的。
check('同一个窗口加载的脚本都包在 IIFE 里（顶层声明会互相撞）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay.html'), 'utf8');
  // 取出这个窗口加载的本地脚本（vendor 的不管，那些本来就是库）
  const scripts = [...html.matchAll(/<script src="((?!vendor)[^"]+)"/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 5, `只解析出 ${scripts.length} 个脚本，正则失效了`);

  const naked = [];
  for (const name of scripts) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
    // 去掉开头注释，看第一行实际代码是不是 IIFE
    const firstCode = src.split('\n').find((l) => l.trim() && !l.trim().startsWith('//'));
    if (!firstCode || !firstCode.trim().startsWith('(function')) naked.push(name);
  }
  assert.deepStrictEqual(naked, [],
    `这些脚本没包 IIFE，顶层声明会和同窗口其他脚本相撞：${naked.join(', ')}`);
});

check('渲染进程的报错会转出来（否则这类错误只能靠猜）', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  // 骨架层没有开发者工具、不在视线里。它抛的任何异常如果不转出来，症状就只剩
  // "某个功能不工作"，而那和真正的原因可能毫无关系。
  assert.match(main, /console-message/, '骨架层的 console 没有转发');
  assert.match(main, /render-process-gone/, '崩溃没有上报');
  assert.match(dash, /onHelperLog/, '面板没有订阅日志');
  assert.ok(html.includes('id="log"'), '面板没有显示日志的地方');

  const mainCode = main.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  // ⚠️ 四条通道都要在。**我在一次合并里亲手丢过其中两条**(35d21af:取对方的 main.js
  // 为底,补回自己两条通道的脚本第三步 assert 失败,而我只看了 `node --check` 的
  // "语法 ✅" 就往下走)⟹ 丢了不会红、不会崩,只表现为"日志区少一类东西"。
  //
  // 同一次操作还把下面「四个窗口都接」「监听在装载之前」两条断言一起弄丢了,
  // 而我当时报的是"121 条全绿" —— **守卫写在共享 check 里,取对方的文件为底就会丢。**
  const watch = mainCode.slice(mainCode.indexOf('function watchRendererErrors'),
    mainCode.indexOf('function openDashboard'));
  assert.ok(watch.length > 200, 'watchRendererErrors 函数体没找到，切片失效了');
  for (const [what, re, why] of [
    ['render-process-gone', /render-process-gone/, '渲染进程崩了没上报'],
    ['preload-error', /preload-error/, 'preload 挂了没上报 ⟹ window.gw 整个不存在'],
    ['console-message 新签名', /typeof args\[1\] === 'object'/,
      'Electron 36 起签名变成单 details 对象，只按旧签名解会**静默变哑**'
      + '(level 是对象，`< 2` 恒 false) —— 症状是"日志区什么都不出"，和"没出错"分不开'],
    ['资源 404', /onErrorOccurred/,
      '`<script>` 的 404 不进 console-message，而少一个脚本 = 这一层整个不工作且不说话'],
    ['重复折叠', /\(× \$\{n\}\)/,
      '同一条消息刷几千行会把真问题埋掉(实测某工坊壁纸的 WebGL 报错刷了几千行)'],
  ]) {
    assert.match(watch, re, `watchRendererErrors 少了「${what}」—— ${why}`);
  }
  // ⚠️ 折叠不能变成丢弃:前几次必须照常报,否则看不到上下文。
  //
  // ⚠️ 这条第一版写的是 `assert.match(watch, /n > 3/)` —— 而 `n > 3` 在源码里出现
  // **两次**(早退判断 + 后缀判断),把第一处改坏守卫依然通过。**锚在一个恰好重复的
  // 字符串上等于没锚。**改成直接跑那段逻辑:同一条消息报 50 次,必须**至少**报出
  // 前几次(不能全静音),也必须**远少于** 50(不能不折叠)。
  const early = watch.match(/if \(n > (\d+)[^)]*\) return;/);
  assert.ok(early, '折叠里没有"前 N 次照常报"的早退判断 —— 完全静音会让上下文丢失');
  const keep = Number(early[1]);
  assert.ok(keep >= 1 && keep <= 10,
    `前 ${keep} 次照常报不合理:小于 1 = 第一次就被吞(看不到上下文),`
    + '大于 10 = 刷屏本身没被压住');

  // ⚠️ 404 通道要听**所有加载资源的协议**,而不只是 file://。
  //
  // 实测漏过整整一层:骨架层走 `file://`,而 WE 壁纸整层走自定义协议 `wall://`
  // (`WE_SCHEME`)⟹ 只挂 `file:///*` 时**壁纸的资源失败一条都不上报**。
  //
  // 而漏掉的正好是当时在查的那类:用户报「预览图有山景背景、装载后纯黑」,日志里只有
  // 渲染进程那句 `Not allowed to load local resource: [object Object]` —— 不说是哪个
  // 资源、也不说为什么,因为通道没在听。
  const urls = watch.match(/urls:\s*\[([^\]]+)\]/);
  assert.ok(urls, '404 通道没有 urls 过滤器，切片或写法变了');
  assert.match(urls[1], /file:\/\/\/\*/, '404 通道没听 file:// —— 骨架层的资源全在那');
  assert.match(urls[1], /WE_SCHEME/,
    '404 通道没听 WE_SCHEME(wall://) —— 那是 WE 壁纸整层的协议，'
    + '漏了它壁纸的资源失败一条都不上报');

  // ⚠️ 白名单要收**图片和视频**。壁纸的背景就是图片,而第一版只收脚本和样式
  // ⟹ 背景图 404 被静默过滤掉,而那正是要查的东西。
  //
  // ⚠️ 用 `includes` 而不是 `new RegExp(ext)`:第一版把 `'jpe?g'` 当模式去匹配,而 `?`
  // 让 `e` 可选 ⟹ 它找的是 `jpg`/`jpeg`,而源码里写的是**字面** `jpe?g` ⟹
  // **在正确的代码上报红**(比没有守卫更糟:它在对的时候红、在错的时候可能绿)。
  for (const ext of ['jpe?g', 'png', 'gif', 'webp', 'mp4']) {
    assert.ok(watch.includes(ext),
      `404 白名单少了 ${ext} —— 壁纸的背景/视频就是这些，漏了会被静默过滤`);
  }

  // ⚠️ **四个窗口都要接。**面板窗口曾经一条都没有(只有 did-finish-load / closed),
  // 而它的顶层抛出后果**更隐蔽**:apply() 在最后一行才调,它绑定**所有**开关。
  const calls = [...mainCode.matchAll(/watchRendererErrors\((\w+), '(\w+)'\)/g)];
  assert.deepStrictEqual(calls.map((m) => m[2]).sort(),
    ['dashboard', 'overlay', 'wall', 'we'],
    '四个窗口(壁纸层/面板/骨架层/WE)必须都接错误上报，现在只有:'
    + calls.map((m) => m[2]).join(', '));

  // ⚠️ 监听必须在 loadFile/loadURL **之前**接。装载期的错误(资源 404、preload 挂了)
  // 正是这类失败最常见的形态，接晚了正好错过 —— 两边第一版都把某一处接在了后面。
  const lines = mainCode.split('\n');
  for (const [i, line] of lines.entries()) {
    if (!/\.loadFile\(|\.loadURL\(/.test(line)) continue;
    const recv = line.trim().match(/^(\w+)\./);
    if (!recv) continue;
    const before = lines.slice(Math.max(0, i - 30), i).join('\n');
    assert.ok(new RegExp(`watchRendererErrors\\(${recv[1]},`).test(before),
      `main.js:${i + 1} 的 ${recv[1]} 在装载前没接错误上报 —— 装载期的 404 会丢掉`);
  }
});

// ── 已删掉的窗口不能还有代码在往它发消息 ─────────────────────────────────
//
// sensor 窗口删掉之后，`start-recording` 那个 handler 里还留着
// `sensor.webContents.send(...)` —— 旁边的 cancel-recording / start-capture 都改成了
// overlayWindow，只有这一个漏了。
//
// 它不是语法错误，`node --check` 全绿；只在用户点「录制」的那一刻抛 ReferenceError，
// 而症状是"无法录制"，看不出和一个不存在的变量有关系。这一条和上面那个 `sendStatus`
// 是同一类：**未定义标识符只在运行到那一行时才炸**，而那一行是用户交互才会走到的。
check('主进程里没有向已删窗口发消息的残留（未定义标识符只在点下去那一刻才炸）', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const code = main.split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
  // 收件人必须是真实存在的窗口变量。任何别的名字都是残留。
  // weWindow 是合并 WE 壁纸时加的第四个窗口。名单漏了它的后果是**假阳性** ——
  // 守卫说"这是删窗口的残留",而它其实是个正常窗口。
  const known = ['wallWindow', 'dashboardWindow', 'overlayWindow', 'weWindow',
    'layer', 'win', 'target', 'w'];
  const bad = [...code.matchAll(/(\w+)\.webContents\.send\(/g)]
    .map((m) => m[1])
    .filter((name) => !known.includes(name));
  assert.deepStrictEqual([...new Set(bad)], [],
    `这些收件人不是已知的窗口变量，很可能是删窗口时的残留：${[...new Set(bad)].join(', ')}`);
});

// 同一类的另一半：渲染进程里调了自己没定义的函数。
//
// sensor.js 的 onStartCapture 回调里写的是 `sendStatus(...)`，而这个文件里那个函数
// 叫 `status` —— 于是「录 5 秒关键点」一点就抛 ReferenceError，录不到任何东西。
// 用户看到的是"点了没反应，目录也是空的"。
check('渲染脚本里调用的本地函数都有定义（拼错的函数名 node --check 查不出来）', () => {
  for (const name of ['sensor.js', 'overlay-window.js', 'recorder.js', 'input.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const defined = new Set([
      ...[...code.matchAll(/function\s+(\w+)\s*\(/g)].map((m) => m[1]),
      ...[...code.matchAll(/(?:const|let|var)\s+(\w+)\s*=/g)].map((m) => m[1]),
      ...[...code.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=/g)]
        .flatMap((m) => m[1].split(',').map((x) => x.split(':').pop().trim())),
      ...[...code.matchAll(/class\s+(\w+)/g)].map((m) => m[1]),
      // 类里的方法定义：`  foo(a, b) {`。它们既是定义也长得像调用，不收进来会全体误报。
      ...[...code.matchAll(/^\s{2,}(?:async\s+|get\s+|set\s+)?(\w+)\s*\([^)]*\)\s*\{/gm)].map((m) => m[1]),
    ]);
    // 只查"看起来像本模块自己的辅助函数"的调用：小写开头、不带点。带点的是
    // window.x / T.y 那类，跨模块引用不在这条守卫的范围内。
    const called = [...code.matchAll(/(?<![.\w$])([a-z][a-zA-Z0-9_]{3,})\(/g)].map((m) => m[1]);
    const builtin = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof',
      'require', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'parseInt',
      'parseFloat', 'isNaN', 'fetch', 'atan2', 'hypot', 'round', 'floor', 'ceil', 'sqrt',
      'min', 'max', 'abs', 'push', 'map', 'filter', 'slice', 'splice', 'forEach', 'join',
      'split', 'indexOf', 'includes', 'reduce', 'sort', 'find', 'some', 'every', 'concat',
      'toFixed', 'padEnd', 'padStart', 'match', 'replace', 'test', 'keys', 'values',
      'entries', 'assign', 'stringify', 'parse', 'from', 'now', 'async', 'await', 'else',
      'function', 'await',
      // 浏览器全局(这几个文件跑在渲染进程里)
      'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle']);
    const missing = called.filter((n) => !defined.has(n) && !builtin.has(n));
    assert.deepStrictEqual([...new Set(missing)], [],
      `${name} 里这些函数被调用但没有定义（会在跑到那一行时抛 ReferenceError）：${[...new Set(missing)].join(', ')}`);
  }
});

// ── vendor 副本不能和源头分叉 ────────────────────────────────────────────
//
// pose.js / motion.js / tracking.js 的源头在 ../../public/，`npm run vendor` 拷到
// src/vendor/aircursor/。而 vendor 只在 npm install 时自动跑 ⟹ **改了源头不重跑就静默
// 用旧副本**。
//
// 实测代价：z 归一化的修复提交了、测试全绿，而应用跑的是没修的副本。发现它纯属偶然
// （新加的用例从 vendor 加载，报 0/40，而同一份逻辑在源头上是 39/40）。
check('vendor 里的手势判定和 public/ 源头一致（改了源头不重跑 vendor 会静默用旧的）', () => {
  const root = path.join(__dirname, '..', '..');
  const stale = [];
  for (const name of ['pose.js', 'motion.js', 'tracking.js']) {
    const src = path.join(root, 'public', name);
    const copy = path.join(__dirname, '..', 'src', 'vendor', 'aircursor', name);
    if (!fs.existsSync(copy)) continue;   // 没跑过 vendor，别的用例会报
    if (fs.readFileSync(src, 'utf8') !== fs.readFileSync(copy, 'utf8')) stale.push(name);
  }
  assert.deepStrictEqual(stale, [],
    `这些副本和源头不一致，跑一次 npm run vendor：${stale.join(', ')}`);
});

// ── renderActionGroup 要的容器必须在 HTML 里 ─────────────────────────────
//
// `renderActionGroup` 第一行是 `if (!host) return;`。而 `systemActions` 这个容器在
// dashboard.html 里**根本不存在** ⟹ 8 个系统动作（打开网易云/浏览器/访达、播放暂停、
// 上下一曲…）一个都没渲染，静默地。
//
// 用户报"我希望手势打开网易云这个加进来" —— 而 `open_netease` 早就在动作表里了
// （system.js，4 个候选路径），只是面板上看不到。这和之前那次「三层接好、面板零入口」
// 完全同形：每一层单独看都对，整条链没有出口，所有测试全绿。
check('面板渲染函数要的容器 id 在 HTML 里都存在', () => {
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  // getElementById('x') 和 renderActionGroup('x', …) 两种取法都算
  const ids = new Set([
    ...[...dash.matchAll(/getElementById\('([\w-]+)'\)/g)].map((m) => m[1]),
    ...[...dash.matchAll(/renderActionGroup\('([\w-]+)'/g)].map((m) => m[1]),
  ]);
  assert.ok(ids.size > 10, `只解析出 ${ids.size} 个 id，正则失效了`);
  const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
  assert.deepStrictEqual(missing, [],
    `这些容器在 HTML 里不存在，对应的界面会静默空白：${missing.join(', ')}`);
});

// 系统动作是"手势替代鼠标键盘"这个定位的落点，而它整块消失过一次。
check('系统动作在面板上有自己的区域，而且真的被渲染', () => {
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  assert.match(dash, /renderActionGroup\('systemActions'/, '面板没有渲染系统动作');
  assert.ok(html.includes('id="systemActions"'), '系统动作没有容器');
  // 打开应用不需要辅助功能授权，所以它是"能立刻用来验证手势通不通"的那一类 ——
  // 用户就是要拿它直观测试效果。
  const system = fs.readFileSync(path.join(__dirname, '..', 'src', 'system.js'), 'utf8');
  assert.match(system, /open_netease/, '网易云那条规则没了');
});

// 界面主动说谎在这个项目里有过代价（识别行显示了手势名但动作不发生，因为显示和触发
// 用了两个时间尺度）。这条守的是同一件事的另一半。
check('静态/动态的显示读存下来的字段，不靠 keyframeData 猜', () => {
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  // 猜的后果：**有律的动态动作不产生 keyframes**（recorder.js 里 `s.dynamic && !s.law`
  // 才建关键帧序列），于是录了动态却显示"静态"。四格实测：动态+有律 是唯一说谎的那格。
  const line = dash.split('\n').find((l) => l.includes("? '动态' : '静态'"));
  assert.ok(line, '找不到静态/动态的判断 —— 被改写了');
  assert.match(line, /recorded\.dynamic/,
    '静态/动态是靠 keyframeData 猜的 —— 有律的动态动作不产生关键帧，会显示成静态');

  // 而 recorder 那边必须真的存这个字段，否则读了也是 undefined。
  const rec = fs.readFileSync(path.join(__dirname, '..', 'src', 'recorder.js'), 'utf8');
  assert.match(rec, /dynamic: s\.dynamic/, 'recorder 没有把 dynamic 存进结果');
  const sensor = fs.readFileSync(path.join(__dirname, '..', 'src', 'sensor.js'), 'utf8');
  assert.match(sensor, /dynamic: entry\.dynamic/, 'sensor 转发时把 dynamic 丢了');
});

// ── 诊断埋点必须能被看到 ─────────────────────────────────────────────────
//
// 这个项目已经犯过一次「把观测手段建好却没地方看」（pointerHealth 接了三层、面板零
// 入口）。诊断的价值全在能不能被读到，所以埋点和显示要一起钉住。
check('匹配诊断从 input 一路到面板', () => {
    const input = fs.readFileSync(path.join(__dirname, '..', 'src', 'input.js'), 'utf8');
  const sensor = fs.readFileSync(path.join(__dirname, '..', 'src', 'sensor.js'), 'utf8');
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  assert.match(input, /lastProbe\(\)/, 'input 没有暴露诊断快照');
  assert.match(sensor, /input\.lastProbe/, 'sensor 没有取诊断');
  assert.match(sensor, /probe/, 'sensor 没有把诊断发出去');
  assert.match(dash, /s\.probe/, '面板没有读诊断');
  assert.ok(html.includes('id="match-probe"'), '面板没有显示诊断的地方');
  // 限速：30/s 的数字给人读只会看到一片闪烁，而且白付 26 次序列化。
  assert.match(sensor, /PROBE_INTERVAL_MS/, '诊断没有限速 —— 30/s 的数字没法读');
});

// 「录了没反应」分不清是手势没认出来还是 App 打不开，而两者的下一步完全不同
// （重录 vs 查 App 路径）。所以执行那一段也要自证。
check('系统动作的执行过程可见（含每个候选的失败原因）', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  // 识别到了要说一声：这是"手势那侧全部走通了"的唯一证明。
  assert.match(main, /识别到.*执行系统动作/, '手势走到主进程时没有任何记录');
  // ⚠️ `stdio: 'ignore'` 会把 open 的报错扔掉，而那句报错正是答案：
  // 「Unable to find application named …」和「cannot be opened because it is damaged」
  // 需要完全不同的处理，而退出码把它们压成同一个 1。
  const block = main.slice(main.indexOf("if (kind === 'app')"), main.indexOf("if (kind === 'pointer')"));
  assert.match(block, /encoding: 'utf8'/, "open 还在用 stdio:'ignore' —— 失败原因被扔掉了");
  assert.match(block, /stderr/, '没有读 open 的报错');
  assert.match(block, /helper-log/, '执行结果没进面板日志 —— 用户看不到终端');
});

// 每个手势的开关：用户要"精准使用"，也就是手势串了的时候能先关掉一个试试。
check('单个手势的开关四层都通，而且不需要重录', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  const input = fs.readFileSync(path.join(__dirname, '..', 'src', 'input.js'), 'utf8');
  assert.match(preload, /toggleRecording/, 'preload 没暴露开关');
  assert.match(main, /ipcMain\.handle\('toggle-recording'/, '主进程没注册开关');
  assert.match(dash, /gw\.toggleRecording\(/, '面板上没有按钮 —— 前三层齐了也点不到');
  assert.match(input, /entry\.enabled === false/, '判定侧没读这个字段 —— 开关是假的');

  // ⚠️ 缺字段必须当成"开着"。用 `=== true` 会让存量录制在升级后全部静默失效。
  assert.doesNotMatch(input, /entry\.enabled === true/,
    '用了 `=== true` —— 存量录制没有这个字段，会被静默关掉');

  // 开关存在 recorded[action] 上，跟着模板走：清除录制时一起消失，不留孤儿开关。
  const handler = main.slice(main.indexOf("ipcMain.handle('toggle-recording'"));
  assert.match(handler.slice(0, 500), /config\.recorded/,
    '开关没存在 recorded 上 —— 另开一张表会留下指向已删手势的孤儿');
});

// ── 转发层不做白名单 ─────────────────────────────────────────────────────
//
// ⚠️ **这个错误在同一个文件里犯了三次。**
//
//   sendRecordingProgress   丢掉 extent / extentNeeded（幅度诊断显示不出来）
//   sendRecordingResult(冲突) 丢掉 need / otherDisabled（面板显示「至少要 ?」）
//   sendRecordingResult(失败) 丢掉 peak / need / frames
//
// 前两次是用户报上来的：加了一个诊断字段、测试全绿、真机上那个数字就是不出现。而症状
// 看起来像 UI 的问题，因为产出端和显示端都是对的 —— 中间那层静默地把它删了。
//
// 转发层做白名单，等于给每个新字段埋一个静默失效。这三处传的都是给 UI 看的数据，没有
// 敏感字段要挡，所以整体透传是对的。
check('recorder 的结果整体透传，不逐个列字段', () => {
  const sensor = fs.readFileSync(path.join(__dirname, '..', 'src', 'sensor.js'), 'utf8');
  const calls = [...sensor.matchAll(/sendRecording(?:Result|Progress)\(\{([^}]*)/g)]
    .map((m) => m[1]);
  assert.ok(calls.length >= 3, `只解析出 ${calls.length} 个转发点，正则失效了`);
  // 三类要分开：
  //   透传（带 `...`）                    ✅ 想要的
  //   自己构造的小载荷（<4 个字段）        ✅ 没有上游字段可丢
  //   入库载荷（`entry: {`）              ✅ 故意显式列字段 —— 那是要写盘的结构，
  //                                        多带一个字段会永远留在用户的配置文件里
  // 剩下的才是"转发上游产出却做了白名单"，也就是会静默吃掉新字段的那种。
  const suspect = calls.filter((body) => {
    if (body.includes('...')) return false;
    if (body.includes('entry:')) return false;
    return body.split(',').filter((x) => x.trim()).length >= 4;
  });
  assert.deepStrictEqual(suspect, [],
    `这些转发点在做白名单，上游新增的字段会被静默丢掉：${suspect.map((s) => s.slice(0, 60)).join(' | ')}`);
});

// ── 诊断区的换行必须保留 ─────────────────────────────────────────────────
//
// `#match-probe` 和 `#overlay-geom` 用 `class="state"`，但它们**不在 `.rec` 里**，而
// 唯一那条 state 规则是 `.rec .state` ⟹ 它们一直没有任何样式。
//
// 后果不是"丑"，是**读不到**：`white-space` 默认把 textContent 里的 `\n` 折叠成空格，
// 多个手势的诊断挤成一行长文本。用户原话「我没有看到更多的日志信息」—— 诊断一直在发，
// 只是显示成了一行。
//
// 这个形状是「接线齐了但用不上」的变体：数据到了、元素在、内容也写进去了，而**呈现层
// 把它变成了不可读**。现有那条"CSS 类都有定义"的守卫查的是 `className='x'`，查不到这种。
check('多行诊断的容器保留换行（否则挤成一行 = 看不到）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));

  // 找出所有"往 textContent 里塞 \n"的元素 id —— 那些必须保留换行。
  //
  // ⚠️ 窗口是"到下一个 getElementById 为止"，不是固定字符数。第一版用 400 字符，而
  // `#match-probe` 的写入点在 getElementById 之后 14 行（中间有一段注释和一个 map）
  // ⟹ **它压根没被识别成多行容器,守卫就没检查它** —— 而它正是这次出问题的那个。
  // 一个"全绿但没覆盖到目标"的守卫比没有更糟，因为它让人以为查过了。
  const multiline = new Set();
  const sites = [...dash.matchAll(/getElementById\('([\w-]+)'\)/g)];
  for (let i = 0; i < sites.length; i += 1) {
    const from = sites[i].index;
    const to = i + 1 < sites.length ? sites[i + 1].index : dash.length;
    if (/textContent\s*=\s*`[^`]*\\n/.test(dash.slice(from, to))) multiline.add(sites[i][1]);
  }
  assert.ok(multiline.has('match-probe'),
    '没把 match-probe 识别成多行容器 —— 那正是这条守卫要看的那个，窗口切得太小了');
  assert.ok(multiline.size >= 3, `只解析出 ${multiline.size} 个多行容器，正则失效了`);

  const bad = [...multiline].filter((id) => {
    if (new RegExp(`<pre[^>]*id="${id}"`).test(html)) return false;   // <pre> 默认保留换行
    // ⚠️ 要查**所有**匹配的规则，不是第一条。CSS 里后面的覆盖前面的，而同一个 id 出现
    // 两条规则是常事（`#live` 就有两条）。只看第一条会误判 —— 这正是 `#hands` 那个 bug
    // 的形状（两条规则，后一条没尺寸把前一条盖了），而我写这条守卫时又踩了一次：
    // 加了个重复的 `#live` 规则，以为原来没有。
    const rules = [...style.matchAll(new RegExp(`#${id}\\b[^{]*\\{([^}]*)\\}`, 'g'))]
      .map((m) => m[1]);
    const wraps = rules.some((r) => /white-space:\s*(pre|pre-wrap|pre-line)/.test(r));
    const unwraps = rules.some((r) => /white-space:\s*(normal|nowrap)/.test(r));
    return !(wraps && !unwraps);
  });
  assert.deepStrictEqual(bad, [],
    `这些容器写入多行文本但不保留换行，会挤成一行读不了：${bad.join(', ')}`);
});

// ── 整层静默停摆必须能被看见 ─────────────────────────────────────────────
//
// 用户报「摄像头亮着，但是骨架突然消失了，点击录制也录不了了」，并且**没有任何报错记录**。
//
// `onResults` 是 MediaPipe 从它自己的循环里调的回调 —— 这里抛一次异常，它可能就再也不
// 回调了，而摄像头继续亮着。一次异常让整层永久停摆，却什么都不留下。
//
// 而这类失败的特征恰恰是"**没有输出**"，所以"没有日志"和"一切正常"在面板上长得一模一样。
// 唯一的解法是有个东西**主动**每秒说一次话。
check('骨架层的整层停摆能被观测到', () => {
  const sensor = fs.readFileSync(path.join(__dirname, '..', 'src', 'sensor.js'), 'utf8');
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');

  // ① MediaPipe 的回调必须包 try —— 它抛出去就可能不再回调
  assert.match(sensor, /function onResults\(results\) \{\s*\n\s*try \{/,
    'onResults 没包 try —— 抛一次异常整层可能永久停摆，而摄像头继续亮着');
  assert.match(sensor, /onResultsInner/, '没有分出内层函数');

  // ② 心跳：停了要主动说话
  assert.match(sensor, /heartbeat/, 'sensor 没有心跳');
  assert.match(sensor, /stalled/, '心跳不报"停了"');
  assert.match(dash, /s\.heartbeat/, '面板没读心跳');
  assert.ok(html.includes('id="heartbeat"'), '面板没有显示心跳的地方');

  // ③ 摄像头帧数和推理帧数必须**分开**报：它们背离的那一刻指明是哪一层停的。
  //    一个数说不出"摄像头亮着但骨架没了"是摄像头的问题还是推理的问题。
  assert.match(sensor, /cameraFrameCount/, '没单独计摄像头帧数');
  assert.match(dash, /cameraFrames/, '面板没显示摄像头帧数');

  // ④ 兜底钩子：onResults 之外的路径（定时器、事件、await 链）绕过那个 try
  assert.match(sensor, /addEventListener\('error'/, '没接未捕获异常');
  assert.match(sensor, /addEventListener\('unhandledrejection'/, '没接未处理的 Promise 拒绝');

  // ⑤ 推理失败不能被静默吞掉 —— 原来只有 finally，而 hands.send 失败正是
  //    "摄像头亮着但没有骨架"的另一个候选原因
  const frame = sensor.slice(sensor.indexOf('onFrame: async'), sensor.indexOf('width: 640'));
  assert.match(frame, /catch \(error\)/, 'hands.send 的异常被吞掉了');
});

// ── 壁纸的空状态和调试 HUD:收缩之后它们的理由都过期了 ──────────────────────
//
// 用户报「我的这个产品一打开,即出现这个把壁纸盖住了」——**两个东西同时盖着**:
//
//   ① 空状态引导页,判据是"三张图设了没有",而那个入口(图库/模板 tab)已经砍掉
//      ⟹ 它**永远显示**,还指着一个不存在的功能("按 ⌃⇧W 选三张图")
//   ② 调试 HUD,`showHud: true` 是开发遗留,而它的复选框在「壁纸与音乐」tab 里
//      ⟹ 打开就关不掉
//
// ⟹ **删一个 tab 时要查:有没有别处的逻辑依赖它提供的入口。**这两个都是"功能删了但
// 引导/开关还指着它"。
check('调试 HUD 默认关，而且有不依赖面板的开关', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(main, /showHud: false/, 'HUD 默认开着 —— 它盖在壁纸左上角');
  // ⚠️ "默认关 + 没有开关"等于这个观测手段不存在，而 HUD 报的壁纸层策略/帧率/
  // 鼠标事件收不收到，正是壁纸出问题时第一个该看的东西。原来那个复选框在已删的 tab 里。
  assert.match(main, /Control\+Shift\+H[\s\S]{0,200}showHud/,
    'HUD 没有快捷键开关 —— 默认关之后它就彻底没入口了');
  // 写在代码里但用户不知道等于没有。
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  assert.match(dash, /⌃⇧H/, '面板没列出这个快捷键');
});

check('壁纸层没有引导浮层', () => {
  // ⚠️ 契约变了两次，记下来因为第二次推翻了第一次。
  //
  // 原来有个空状态引导页（"按 ⌃⇧W 选三张图"），判据是三张图设了没有。产品收缩砍掉图库和
  // 模板 tab 之后它永远显示、还指着不存在的操作，我第一版改成"指向创意工坊 + 装载 WE 后
  // 隐藏"——**而用户要的是它根本不存在**：「不，这个引导就不该存在」。
  //
  // 壁纸层就该是壁纸。任何盖在上面的东西都要有一个比"帮助用户"更硬的理由，
  // 而调试 HUD 有（默认关 + ⌃⇧H），引导没有。
  const wall = fs.readFileSync(path.join(__dirname, '..', 'src', 'wall.html'), 'utf8');
  assert.doesNotMatch(wall, /id="empty"/, '壁纸层又加了引导浮层');
  assert.doesNotMatch(wall, /选三张图/, '还在提"选三张图" —— 那个入口早就删了');
  // #hud 是唯一允许盖在壁纸上的东西，而它默认关。
  const overlays = [...wall.matchAll(/<div id="([\w-]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(overlays, ['hud'],
    `壁纸层多了浮层：${overlays.join(', ')} —— 只有 hud 该在这儿（而它默认关）`);
});

console.log('\n  浏览工坊 + 我的壁纸');

// ⚠️ 浏览**故意**用要 key 的 QueryFiles，而详情**故意**用免 key 的那个。
// 两条搞反的后果：浏览永远失败（没 key），或者详情无端要求配 key。
check('浏览用 QueryFiles（要 key），详情用免 key 的那个', () => {
  const browse = mainSrc.slice(mainSrc.indexOf("ipcMain.handle('workshop-browse'"),
    mainSrc.indexOf("ipcMain.handle('workshop-set-key'"));
  assert.match(browse, /QUERY_ENDPOINT/, '浏览没走 QueryFiles');
  assert.match(browse, /needsKey/, '没 key 时没标出来 —— 用户不知道去哪配');
  // 403/401 几乎一定是 key 不对，和网络问题该给不同建议
  assert.match(browse, /403|401/, 'key 被拒和网络失败没分开');
});

// ⚠️ API key 也是凭证：泄漏了别人能用你的额度，而且它绑在你账号上。
check('诊断报告里 API key 被脱敏', () => {
  const fn = mainSrc.slice(mainSrc.indexOf('function redactConfig'),
    mainSrc.indexOf('function redactConfig') + 600);
  assert.match(fn, /apiKey/, 'API key 没脱敏 —— 它和密码一样是凭证');
});

// 用户的原话："不知道从哪里得到的壁纸，反正只要在指定的壁纸存储目录中有的壁纸就在这里"
check('我的壁纸按"有 project.json"判定，不按"我们下载过"', () => {
  const handler = mainSrc.slice(mainSrc.indexOf("ipcMain.handle('workshop-local'"),
    mainSrc.indexOf("ipcMain.handle('workshop-add-dir'"));
  assert.match(handler, /findWallpaperDirs/, '没用目录扫描');
  assert.match(handler, /libraryDirs/, '没扫用户自己加的目录');
  // ⚠️ 一个坏的 project.json 不能让整个列表变空
  assert.match(handler, /broken/, '坏文件没单独标出来 —— 用户会找不到他知道存在的壁纸');
  // ⚠️ 空列表时要报出扫过哪些目录，否则用户不知道我们找过哪儿
  assert.match(handler, /scannedRoots/, '没报出扫过的目录');
});

// 不支持的类型**不隐藏** —— 用户明确说过"预览图是可以看到的吧"。
check('不支持的类型仍然显示（只标出来，不隐藏）', () => {
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  const card = dash.slice(dash.indexOf('function workshopCard'),
    dash.indexOf('async function runBrowse'));
  assert.match(card, /放不了/, '不支持的类型没标出来');
  assert.ok(!/return null|continue/.test(card), '卡片渲染里有跳过逻辑 —— 那会隐藏壁纸');
});

// ⚠️ 点卡片不该直接下载：几百 MB 的误点很贵。
check('点工坊卡片是看详情，不是直接下载', () => {
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  const browse = dash.slice(dash.indexOf('async function runBrowse'),
    dash.indexOf("document.getElementById('br-go')"));
  assert.match(browse, /renderPeek/, '点卡片没走预览');
  assert.ok(!/workshopDownload/.test(browse), '点卡片直接下载了 —— 误点会很贵');
});

check('三个页签都在（创意工坊 / 我的壁纸 / 手势录制）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  for (const tab of ['we', 'mine', 'gesture']) {
    assert.ok(html.includes(`data-tab="${tab}"`), `缺 ${tab} 页签`);
    assert.ok(html.includes(`id="tab-${tab}"`), `缺 ${tab} 的 section`);
  }
});

// ⚠️ 默认值只能有一个来源。面板如果自己写死 ['Everyone']，
// 那 workshop.js 里改了默认值就不生效 —— 而这类"两份默认值"我们已经漂过一次
//（supported 那个判断）。
check('筛选默认值来自 workshop.js，面板不写死', () => {
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  assert.match(dash, /meta\.defaultTags/, '面板没用 meta 里的默认值');
  const init = dash.slice(dash.indexOf('const browse = {'),
    dash.indexOf('const browse = {') + 200);
  assert.ok(!/Everyone/.test(init), '面板把默认标签写死了 —— 和 workshop.js 会漂');
});

// 面板按 filterGroups 渲染 ⟹ 加一组筛选不用改 UI 代码。
check('筛选面板按分组渲染（加一组不用改 UI）', () => {
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  assert.match(dash, /meta\.filterGroups/, '没按分组渲染');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(main, /filterGroups: Workshop\.FILTER_GROUPS/, 'meta 没带分组');
});


// ⚠️ 未声明的变量 —— 这一条是实测烧出来的。
//
// liftOverMenuBar 的 push() 里写了裸的 `want`，而那个名字只存在于 measure() 内部
// ⟹ ReferenceError。它只在窗口真被夹取时才走到，所以尺寸正常时一直没事。
//
// 后果和它的位置完全不成比例：push('create') 在 ensureOverlay() 里同步调，
// 一抛就把整个 ensureOverlay() 带走 —— 而摄像头在那个窗口里。
// 用户看到的是"点开启摄像头没反应，也不报错"，查了好几轮都在手势那边找。
//
// ⟹ 用 node --check 查不出来（语法是合法的），要真的求值才暴露。
// 这里用一个便宜的办法：把可疑的作用域跑一遍。
check('liftOverMenuBar 里没有未声明的变量（曾因此弄死摄像头）', () => {
  // ⚠️ 必须剥注释再匹配 —— 我在这个项目里已经栽过三次同一个形状：
  // 守卫拿 indexOf 找字符串，而**注释里出现同名文字**就假阳性。
  // 而假阳性比漏检更糟：它会让人去修一个不存在的问题。
  // 这一条本身第一版就假阳性了（匹配到我写在注释里解释 bug 的那个 `want`）。
  const src = codeOnly(mainSrc);
  const start = src.indexOf('function liftOverMenuBar');
  assert.ok(start > 0, '找不到 liftOverMenuBar');
  // 取到函数结束
  let depth = 0, end = start;
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  const body = src.slice(start, end);

  // measure() 内部的局部名，不该在 push() 里裸用。
  const localsOfMeasure = ['want', 'got', 'gap'];
  const pushStart = body.indexOf('const push =');
  assert.ok(pushStart > 0, '找不到 push');
  const pushBody = body.slice(pushStart, body.indexOf('\n  };', pushStart));
  for (const name of localsOfMeasure) {
    // `before.want` 是对的，裸 `want` 不是。
    const bare = new RegExp(`(^|[^.\\w])${name}\\s*[?)、,;]`, 'm');
    assert.ok(!bare.test(pushBody),
      `push() 里裸用了 measure() 的局部变量 ${name} —— 那会在窗口被夹取时抛 ReferenceError，`
      + '而 push 是在 ensureOverlay() 里同步调的（摄像头在那个窗口里）');
  }
});

// ⚠️ 对齐失败不该弄死摄像头。这是上一条的**结构性**修复：
// 就算再有人在 push 里写错，也只是对齐没做成，不该把 ensureOverlay 带走。
check('菜单栏对齐的异常被隔离（一个装饰性逻辑不该弄死摄像头）', () => {
  const src = codeOnly(mainSrc);
  assert.match(src, /const safePush/,
    'push 没有被包一层 —— 它在 ensureOverlay() 里同步跑，抛出会让摄像头打不开');
  // 所有注册点都要走 safePush，漏一个就等于没包
  const start = src.indexOf('function liftOverMenuBar');
  const body = src.slice(start, start + 3000);
  for (const hook of ['create', 'ready-to-show', 'show', 'resize']) {
    assert.ok(body.includes(`safePush('${hook}')`),
      `${hook} 这个触发点没走 safePush —— 漏一个就等于没隔离`);
  }
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

// ⚠️ 这条守卫翻过一次，方向值得记。
//
// 原来它断言"默认必须是 bottom-normal（能收鼠标）"，前提是"真壁纸层和鼠标交互
// 互斥，只能选一个"。用户否掉了那个前提：mac 原生壁纸没有顶部那条缝，
// 而鼠标交互失效对交互式壁纸不可接受。
//
// ⟹ 正解是两者兼得（OWE 那套）：窗口留在壁纸层，鼠标靠全局监听 + sendInputEvent
// 转发。所以现在默认是 desktop，而"能收鼠标"由 mouse-bridge 保证。
check('WE 壁纸默认真壁纸层（能覆盖菜单栏），鼠标靠转发补回来', () => {
  const fn = mainSrc.slice(mainSrc.indexOf('function createWEWindow'),
    mainSrc.indexOf('function sendWEProperties'));
  assert.match(fn, /config\.we\.strategy\s*\|\|\s*'desktop'/,
    'WE 窗口默认不是 desktop —— 那样顶部菜单栏区域就没内容');
  const defaults = mainSrc.slice(mainSrc.indexOf('const defaultConfig'),
    mainSrc.indexOf('let config = null'));
  assert.match(defaults, /strategy:\s*'desktop'/, 'we.strategy 的默认值不对');
  assert.match(defaults, /mouseForward:\s*true/,
    '默认没开鼠标转发 —— 那样 desktop 层的壁纸点不动，等于回到了旧的残废状态');
});

// ⚠️ 双份事件是这条链最容易出的错：普通窗口自己就能收鼠标，
// 再转发一次 = 点一下算两下。而"点一下触发两次"看起来像壁纸自己的 bug。
check('只在 desktop 层转发鼠标（普通窗口会变双份事件）', () => {
  const fn = mainSrc.slice(mainSrc.indexOf('function syncMouseForward'),
    mainSrc.indexOf("ipcMain.handle('we-set-mouse-forward'"));
  assert.match(fn, /=== 'desktop'/,
    '没限制只在 desktop 层转发 —— 普通窗口上会变成双份事件');
});

// 换策略时必须重算转发，否则从 desktop 切到普通窗口后转发还开着（双份事件）。
check('换层策略时重算鼠标转发', () => {
  const handler = mainSrc.slice(mainSrc.indexOf("ipcMain.handle('we-set-strategy'"),
    mainSrc.indexOf("// 切音源"));
  assert.match(handler, /syncMouseForward/, '换策略后没重算转发');
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

// ⚠️ 这条守的是刚犯的错：我把 ws-download 按钮换成 ws-peek，但 dashboard.js 里
// 还留着 getElementById('ws-download').onclick ⟹ **启动时抛异常，整个面板挂掉**。
//
// node --check 看不见这个（语法完全合法），而症状是"面板打开一片空白"——
// 和"面板没做好"分不清。另一个模块也栽过同一个形状（删下拉框留下元素引用）。
check('dashboard.js 引用的 element id 在 HTML 里都存在', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  const ids = [...js.matchAll(/getElementById\('([\w-]+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length > 10, `只解析出 ${ids.length} 个 id，正则失效了`);
  const missing = [...new Set(ids)].filter((id) => !html.includes(`id="${id}"`));
  assert.deepStrictEqual(missing, [],
    `这些 id 在 HTML 里不存在 ⟹ 启动时抛异常、整个面板挂掉：${missing.join(', ')}`);
});

console.log('\n  工坊内容展示');

// ⚠️ 只给"填 ID"的输入框等于把命令行搬进 GUI，而工坊的本质是浏览。
// 用户的原话："平时不都是随便浏览着看的吗"。
check('详情接口不需要 API key（所以预览是零门槛的）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'workshop.js'), 'utf8');
  assert.match(src, /ISteamRemoteStorage\/GetPublishedFileDetails/,
    '没用免 key 的详情接口');
  // 主进程调的必须是那个免 key 的，不能是要 key 的 QueryFiles
  // ⚠️ 切片终点用 workshop-set-key 而不是 workshop-local：
  // 中间新插了 workshop-browse，而那条**故意**用要 key 的 QueryFiles。
  // 切片太宽会把它算进来 ⟹ 守卫报假阳性，而我会去"修"一个不存在的问题。
  const handler = mainSrc.slice(mainSrc.indexOf("ipcMain.handle('workshop-details'"),
    mainSrc.indexOf("ipcMain.handle('workshop-browse'"));
  assert.match(handler, /DETAILS_ENDPOINT/, '详情没走免 key 的接口');
  assert.ok(!/QUERY_ENDPOINT/.test(handler), '详情用了要 API key 的 QueryFiles');
});

// 类型在下载**之前**就能知道 —— 靠工坊的 tag。
// ⚠️ 让用户下完几百 MB 才发现装不了，比一开始说清糟得多。
check('下载前就能看出类型，并说清装了会怎样', () => {
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  assert.match(dash, /item\.supported/, '预览卡片没用类型判断');
  assert.match(dash, /只能看静态图|暂不支持/, '不支持的类型没在下载前说清后果');
});

// 预览图挂了不能让卡片塌掉 —— Steam 的 CDN 在国内常要代理，
// 而"图没加载出来"和"这个壁纸有问题"是两件事。
check('预览图加载失败有兜底', () => {
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  assert.match(dash, /img\.onerror/, '预览图没有 onerror 兜底');
});

// 下过的东西要能重新装载，不用每次重填 ID。
check('已下载列表扫本地，不需要网络', () => {
  const handler = mainSrc.slice(mainSrc.indexOf("ipcMain.handle('workshop-local'"),
    mainSrc.indexOf("ipcMain.handle('workshop-load-local'"));
  assert.match(handler, /STEAM_ROOTS/, '没扫所有候选根目录');
  assert.match(handler, /readdirSync/, '没读目录');
  // ⚠️ 一个坏的 project.json 不能挡住整个列表
  assert.match(handler, /catch/, '解析失败没兜底，一个坏文件会让列表全空');
});

console.log('\n  跨桌面行为（实测撞上"壁纸追过来"）');

// ⚠️ 这条来自真机反馈：用户左右切桌面，壁纸"直接追过来覆盖了"。
//
// 根因是**普通窗口 + setVisibleOnAllWorkspaces(true) 这个组合本身是错的**：
// 对普通窗口，"在所有桌面可见"的意思是"这一个窗口跟着你跑"，
// 而不是"每个桌面都有壁纸"。
//
// 真壁纸层（desktop 策略）没这个问题 —— 那一层本来就每个 Space 各自渲染。
//
// macOS 原生要的是 collectionBehavior = [.stationary, .canJoinAllSpaces]，
// 关键在 .stationary（跨 Space 存在但不随切换移动）。
// ⚠️ Electron 只暴露了 canJoinAllSpaces 那半边 ⟹ 拿不到那个组合。
check('bottom-normal 不设跨桌面（普通窗口那么设会跟着你跑）', () => {
  const start = mainSrc.indexOf("id: 'bottom-normal'");
  const end = mainSrc.indexOf("id: 'floating'");
  assert.ok(start > 0 && end > start, '找不到 bottom-normal 策略');
  const strategy = codeOnly(mainSrc.slice(start, end));
  assert.ok(!/setVisibleOnAllWorkspaces/.test(strategy),
    'bottom-normal 又设了 setVisibleOnAllWorkspaces —— 切桌面时壁纸会追过来覆盖');
});

// desktop 是真壁纸层，那里的语义是对的，必须保留。
check('desktop 保留跨桌面（真壁纸层每个 Space 各自渲染）', () => {
  const start = mainSrc.indexOf("id: 'desktop'");
  const end = mainSrc.indexOf("id: 'bottom-normal'");
  const strategy = mainSrc.slice(start, end);
  assert.match(strategy, /setVisibleOnAllWorkspaces\(true/,
    'desktop 层丢了跨桌面 —— 那样别的桌面就没壁纸了');
});

// 坐标换算和事件字段是这条链上"错了不报错"的两处。
check('鼠标事件的坐标换算和字段名有守卫', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'mouse-bridge.js'), 'utf8');
  // ⚠️ 窗口通常就在 (0,0)，所以不减 bounds 也测不出来 —— 直到接第二块屏。
  assert.match(src, /event\.x - bounds\.x/, '没减窗口偏移，多显示器时坐标会错');
  // ⚠️ clickCount 缺了页面只收到 mousedown、收不到 click。
  assert.match(src, /clickCount/, '缺 clickCount —— 页面收不到 click 事件');
  // ⚠️ canScroll 缺了滚动事件会被丢掉。
  assert.match(src, /canScroll/, '缺 canScroll —— 滚轮会失效');
});

console.log('\n  菜单栏那条带子（我在这上面连错三轮）');

// ⚠️ 这一节的历史值得完整记下来，因为它是"修得更用力"和"去测一下"的对比。
//
// 三轮都在修"窗口尺寸不够大"：
//   一版 创建时推三次就不管       → 后来被夹，那三次早跑完了
//   二版 定时轮询，盖住后 stop    → 用户："切桌面回来铺满，点终端就出缝"
//   三版 事件驱动（resize/blur）  → 加了核对实际 bounds
//
// 而三版那个核对**一上线就证明前提是错的**（诊断报告 2026-07-30）：
//   weBounds: { x:0, y:0, width:1470, height:956 }
//   display:  { x:0, y:0, width:1470, height:956 }
//   menuBar:  { ok:true, pushes:0 }
// 窗口一像素不差、压根没被夹过，而用户仍然看到那条带子。
//
// ⟹ 真相：**普通窗口画不到菜单栏那一层**。菜单栏是系统绘制的独立图层，
// bottom-normal / floating 这类普通窗口无论多大都盖不住那 25px。
// 而 desktop（真壁纸层）在菜单栏之下，半透明菜单栏会透出壁纸 ——
// 所以那条策略下用户实测是"铺满"的。
//
// ⟹ 这是**取舍不是 bug**：菜单栏区域有内容 vs 鼠标交互能用，二者不可兼得。
//
// 教训：**尺寸是可测的，而我三次都没去测**。报出可核对的数字 > 修得更用力。
check('尺寸对不对 和 菜单栏区域有没有内容，分开报', () => {
  const fn = mainSrc.slice(mainSrc.indexOf('function liftOverMenuBar'),
    mainSrc.indexOf('// 最近一次覆盖核对的结果'));
  assert.match(fn, /sizeOk/, '没有单独的尺寸判定');
  assert.match(fn, /coversMenuBar/,
    '没区分"尺寸对"和"菜单栏区域有内容" —— 混在一起会把取舍报成 bug');
  // ⚠️ 只有真壁纸层能覆盖菜单栏区域，这个判据不能写反
  assert.match(fn, /coversMenuBar:\s*label === 'desktop'/,
    'coversMenuBar 的判据不对 —— 只有 desktop 层能覆盖那 25px');
});

// 幂等仍然要保留：分辨率变化时需要重设 frame，而无条件设会和 macOS 打架。
check('已经是对的尺寸就不设（幂等，同时断掉 resize 递归）', () => {
  const fn = mainSrc.slice(mainSrc.indexOf('function liftOverMenuBar'),
    mainSrc.indexOf('// 最近一次覆盖核对的结果'));
  assert.match(fn, /if \(!before\.clamped\)[\s\S]{0,300}return/,
    '没有幂等分支 —— 无条件 setBounds 会和 macOS 轮流改 frame，壁纸会抖');
});

// ⚠️ 不该再有重试机制：那是建立在"窗口被夹"这个已被推翻的前提上的。
check('不再有重试轮询（那套建立在错的前提上）', () => {
  const fn = mainSrc.slice(mainSrc.indexOf('function liftOverMenuBar'),
    mainSrc.indexOf('// 最近一次覆盖核对的结果'));
  assert.ok(!/setInterval/.test(fn), '又用上轮询了');
  assert.ok(!/MENU_BAR_RETRIES|MENU_BAR_MAX_PUSHES/.test(fn),
    '又加回重试上限了 —— 诊断报告证明窗口压根没被夹，重试修的是不存在的问题');
});

// 分辨率变化仍然需要重设 frame，所以 resize 要保留。
check('保留 resize（分辨率变化时仍需重设 frame）', () => {
  const fn = mainSrc.slice(mainSrc.indexOf('function liftOverMenuBar'),
    mainSrc.indexOf('// 最近一次覆盖核对的结果'));
  assert.match(fn, /win\.on\('resize'/, '丢了 resize —— 换分辨率后壁纸会是错的尺寸');
});

// 那个取舍要交给用户，不该我替他定。
check('层策略有开关，三条都能选', () => {
  assert.match(mainSrc, /ipcMain\.handle\('we-set-strategy'/, '没有切策略的通道');
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  assert.match(dash, /WE_STRATEGIES/, '面板没有策略选择');
  for (const id of ['desktop', 'bottom-normal', 'floating']) {
    assert.ok(dash.includes(`'${id}'`), `面板缺 ${id} 选项`);
  }
  // ⚠️ 必须说清代价，否则用户不知道为什么要选
  assert.match(dash, /收不到鼠标/, '没说明真壁纸层的代价');
});

check('三条策略都调 liftOverMenuBar 并带策略名', () => {
  const calls = [...mainSrc.matchAll(/liftOverMenuBar\(win, '([a-z-]+)'\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(calls.sort(), ['bottom-normal', 'desktop', 'floating'],
    `策略名不全或没带：${calls.join(', ')}`);
});

console.log('\n  存量配置迁移 + 占位壁纸');

// ⚠️ 这条来自一次真实的"改了默认值但没生效"。
//
// 我把 we.strategy 默认值从 bottom-normal 改成 desktop（因为鼠标转发让两者兼得），
// 而用户的 config.json 里存着旧的 bottom-normal ⟹ 三个现象一个根因：
//   覆盖不了菜单栏 / 点击没反应（转发只在 desktop 层开）/ 切桌面看到原生壁纸
//
// mergeConfig 保留存量值是**对的**（用户改过的不该被覆盖），
// 所以作废的旧值必须显式迁移。
check('存量配置里作废的 strategy 会被迁移', () => {
  assert.match(mainSrc, /function migrateConfig/, '没有迁移函数');
  const fn = mainSrc.slice(mainSrc.indexOf('function migrateConfig'),
    mainSrc.indexOf('function writeConfig'));
  assert.match(fn, /bottom-normal/, '没处理作废的 bottom-normal');
  assert.match(fn, /'desktop'/, '没迁移到 desktop');
});

// ⚠️ 顺序是硬约束：层策略是**创建窗口时**定的，迁移晚了这次启动仍用旧值 ——
// 那样用户重启一次还是老样子，而他会以为修复没用。
check('迁移在建窗口之前跑', () => {
  // ⚠️ 只在启动块里找。`createWallWindow(config.wallStrategy)` 在 setWEWallpaper
  // 里也出现（卸载壁纸时重建），拿全文 indexOf 会命中那个更早的位置 ——
  // 于是断言变成永远失败而代码是对的。切片式守卫都有这个坑。
  const boot = mainSrc.slice(mainSrc.indexOf('app.whenReady().then'));
  const migrate = boot.indexOf('migrateConfig(config)');
  const createWall = boot.indexOf('createWallWindow(config.wallStrategy)');
  const setWE = boot.indexOf('setWEWallpaper(config.we.dir)');
  assert.ok(migrate > 0, '启动时没调迁移');
  assert.ok(migrate < createWall && migrate < setWE,
    '迁移在建窗口之后 —— 这次启动仍会用旧策略，用户重启一次还是老样子');
});

// 切 Space 时我们的窗口重新合成有一帧延迟，那一帧露出下面的系统壁纸。
// OWE 的解法：把系统壁纸设成我们内容的静态帧，露出来也看不出来。
check('装载壁纸时设置系统占位壁纸', () => {
  assert.match(mainSrc, /function setSystemWallpaper/, '没有设置系统壁纸的函数');
  assert.match(mainSrc, /placeholderFromProject/, '没用预览图当占位');
});

// ⚠️ 改了用户的系统设置不还原是很讨人嫌的行为，而且他可能不知道是我们改的。
check('退出时还原用户原来的壁纸', () => {
  assert.match(mainSrc, /originalWallpaper = readSystemWallpaper/, '没记住原来的壁纸');
  const bareQ = codeOnly(mainSrc);
  const quit = bareQ.slice(bareQ.indexOf("app.on('will-quit'"));
  // ⚠️ 允许带超时参数 —— 退出路径上超时缩短到 1.5 秒（默认 8 秒会被当成卡死）。
  assert.match(quit.slice(0, 800), /setSystemWallpaper\(originalWallpaper(, \d+)?\)/,
    '退出时没还原壁纸');
});

// ⚠️ 壁纸目录名是用户可控的，一个引号就能把 AppleScript 劈开（而那会静默失败）。
check('AppleScript 里的路径做了转义', () => {
  const fn = mainSrc.slice(mainSrc.indexOf('function setSystemWallpaper'),
    mainSrc.indexOf('// 用壁纸的预览图当占位'));
  assert.match(fn, /replace\(/, '路径没转义 —— 目录名带引号会静默失败');
});

console.log('\n  "点了没反应"的分辨器');

// ⚠️ 那个症状有三种原因、长得一模一样。没有这一层就只能猜。
check('页面侧有探针报告实际收到了什么', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'we-preload.js'), 'utf8');
  assert.match(src, /we-mouse-seen/, '页面侧没有探针');
  // ⚠️ mouse 和 pointer 两族都要记：我们注入 mouseDown，而很多壁纸监听 pointerdown。
  // Chromium 通常会合成，但没合成时症状就是"点了没反应"而事件其实到了。
  assert.match(src, /pointerdown/, '没记 pointerdown —— 那是最可能的失效点');
  assert.match(src, /mousedown/, '没记 mousedown');
  // capture 阶段：壁纸自己可能 stopPropagation，而我们要测的是"到没到页面"
  assert.match(src, /capture: true/, '没用 capture 阶段 —— 壁纸 stopPropagation 会让探针失灵');
});

check('主进程报注入计数，面板能分辨三种原因', () => {
  assert.match(mainSrc, /mouseInjected/, '没有注入计数');
  assert.match(mainSrc, /pageMouseSeen/, '没收集页面侧的观测');
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  assert.match(dash, /renderMouseDiag/, '面板没有分辨逻辑');
  // 三条分支都要有
  assert.match(dash, /一个鼠标事件都没转发/, '缺"转发没起来"这条');
  assert.match(dash, /页面一个都没收到/, '缺"坐标算错"这条');
  assert.match(dash, /pointerdown 没有/, '缺"事件族不对"这条');
});

// ⚠️ 这条守的是一个**默认值**，而它让整个功能看起来是坏的。
//
// 我把"只在桌面被聚焦（前台是 Finder）时转发"默认设成开。实测（诊断报告）：
//   mouse: { status: { ok: true }, injected: 0 }
// 也就是转发起来了、一个事件都没进去 —— 门把它们全挡了。
//
// OWE 需要那个门是因为它是**纯壁纸应用**（前台是 Finder 约等于在看壁纸），
// 而我们有面板、终端、诊断报告 —— 用户大部分时间前台不是 Finder。
// ⟹ 默认必须放行。副作用（别的应用里滑滚轮壁纸也动）比"点了完全没反应"可接受得多。
check('Finder 那个门默认关（开着会挡掉大部分点击）', () => {
  const defaults = mainSrc.slice(mainSrc.indexOf('const defaultConfig'),
    mainSrc.indexOf('let config = null'));
  assert.match(defaults, /mouseGateFinder:\s*false/,
    'Finder 门默认开着 —— 那会挡掉绝大多数点击，而状态却显示"已开 ✅"');
  // Swift 那边的默认值也要一致，否则改了 JS 没用
  const swift = fs.readFileSync(
    path.join(__dirname, '..', 'native', 'GestureWallMouse.swift'), 'utf8');
  assert.match(swift, /var gateOnFinder = false/,
    'helper 里的默认值还是开着 —— 两边不一致时 JS 那边改了也没用');
});

// ── 打包版才炸的那一类:运行时找的路径 vs extraResources 拷进去的路径 ──────
//
// 四个 Swift helper 的源码在运行时按 `process.resourcesPath/native/X.swift` 找,而
// `asar` 是个归档 ⟹ **只有 `extraResources` 列了才真的在磁盘上。**漏掉的后果是
// `npm start` 一切正常(走 `__dirname/../native/`)、**打包版那个功能整个不存在**。
//
// 实测漏过:`GestureWallMouse.swift` / `GestureWallAudio.swift` 在 `wallpaper/native/`,
// 而 extraResources 只列了顶层 `native/` 那三个 ⟹ 鼠标转发和音频频谱在打包版里
// 连源码都找不到,而这两个功能**只能在打包版验**(要辅助功能/屏幕录制授权)。
check('运行时要的 native 源码都在 extraResources 里（漏了只有打包版会炸）', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const shipped = new Set((pkg.build.extraResources || []).map((r) => r.to));
  // 运行时按 resourcesPath 拼的每一个路径都必须有人拷。
  const wanted = [...main.matchAll(
    /process\.resourcesPath,\s*'([^']+)',\s*'([^']+)'/g,
  )].map((m) => `${m[1]}/${m[2]}`);
  assert.ok(wanted.length >= 2, `只解析出 ${wanted.length} 个 resourcesPath 路径，正则失效了`);
  const missing = wanted.filter((w) => !shipped.has(w));
  assert.deepStrictEqual([...new Set(missing)], [],
    `这些文件运行时会去找，但 extraResources 没拷 ⟹ 打包版里不存在：${missing.join(', ')}`);
});

check('抓系统音频要 NSScreenCaptureUsageDescription（缺了系统不弹窗、直接拒绝）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const info = pkg.build.mac.extendInfo || {};
  // ⚠️ 缺 usage-description 的后果不是"弹窗被拒",是**系统连弹窗都不弹、直接拒绝** ——
  // 症状是那个功能静默不工作,而代码看起来完全正确。麦克风/语音识别都为这条烧过时间。
  //
  // ⚠️ 而抓**系统**音频归「屏幕录制」不归「麦克风」 —— 这两个是不同的权限,
  // 只加麦克风那条一样拿不到系统音频。
  assert.ok(info.NSScreenCaptureUsageDescription,
    '缺 NSScreenCaptureUsageDescription ⟹ 抓系统音频会被系统静默拒绝(不弹窗)');
});

check('⌃⇧D 能开开发者工具（有些东西只有 devtools 有：网络面板/元素树/堆栈）', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  const code = main.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(code, /register\('Control\+Shift\+D'/,
    '没有 devtools 快捷键 —— 那意味着用户看不到 404 是哪个资源、异常在哪一行');
  // 和 ⌃⇧H 同一条道理:默认关且没有开关的观测手段等于不存在。
  assert.match(html, /⌃⇧D/, '面板没列出这个快捷键，用户不会知道它存在');
  // ⚠️ 同上：不能锚在字面 `=== GestureWall ===`，那行带了 build 标识。
  const bannerAt2 = main.indexOf('=== GestureWall');
  assert.ok(bannerAt2 > 0, '找不到启动横幅');
  const banner = main.slice(bannerAt2);
  assert.match(banner.slice(0, 400), /⌃⇧D/, '终端启动信息里没列 ⌃⇧D');
});

// 同一类的第三半:**裸变量读取**,而且在主进程的非 main.js 模块里。
//
// `system-bridge.js` 是从 AirCursor 的 electron/main.js 原样抽出来的,而 `quitting` 是
// **留在那边**的模块级变量 ⟹ `pointerHelper.on('exit')` 里 `if (quitting) return` 抛
// ReferenceError。用户真机上看到的是**退出打包版时弹报错窗**。
//
// ⚠️ 为什么上面两条都逮不到它:
//   · 「已删窗口的残留」只查 `main.js`,而且只查 `x.webContents.send(` 这个形状
//   · 「本地函数有定义」只查渲染层四个文件,而且只查**调用**(`foo(`),而这是**读变量**
//
// ⚠️ 而它躲过 `node --check` 和 `npm start` 的原因是同一个:那一行只在 **helper 真的
// 退出**时执行,而那基本只发生在打包版退出的那一刻。这个修复做过一次(`55abb70`),
// 又跟着打包配置被 revert ⟹ **修过的东西没有守卫就会回来**,这条守卫就是为了它不再回来。
check('主进程模块里 if(裸变量) 的那个变量都有声明（只在特定时刻才炸的那一类）', () => {
  for (const name of ['main.js', 'system-bridge.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
    const code = src.split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    const declared = new Set([
      ...[...code.matchAll(/(?:const|let|var)\s+(\w+)/g)].map((m) => m[1]),
      ...[...code.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=/g)]
        .flatMap((m) => m[1].split(',').map((x) => x.split(':').pop().trim())),
      ...[...code.matchAll(/function\s+(\w+)/g)].map((m) => m[1]),
      // 函数参数。`quitting` 那一类如果是参数传进来的也是合法的。
      ...[...code.matchAll(/function[^(]*\(([^)]*)\)/g)]
        .flatMap((m) => m[1].split(',').map((x) => x.split(/[:=]/)[0].replace(/[{}.\s]/g, ''))),
      ...[...code.matchAll(/\(([\w\s,]*)\)\s*=>/g)]
        .flatMap((m) => m[1].split(',').map((x) => x.trim())),
      ...[...code.matchAll(/(\w+)\s*=>/g)].map((m) => m[1]),
      ...[...code.matchAll(/catch\s*\((\w+)\)/g)].map((m) => m[1]),
    ].filter(Boolean));
    // 只查 `if (foo)` / `if (!foo)` 这个形状:小写开头、单个标识符、不带点不带括号。
    // 带点的(`config.x`)和带括号的(`foo()`)由别的守卫管。
    const read = [...code.matchAll(/if\s*\(\s*!?\s*([a-z][a-zA-Z0-9_]*)\s*\)/g)]
      .map((m) => m[1]);
    const builtin = new Set(['process', 'module', 'require', 'global', 'app', 'e', 'err',
      'error', 'ok', 'v', 'x', 'y', 'i', 'n', 'id', 'val', 'value']);
    const missing = read.filter((k) => !declared.has(k) && !builtin.has(k));
    assert.deepStrictEqual([...new Set(missing)], [],
      `${name} 里 if() 读了没声明的变量（跑到那一行才抛 ReferenceError）：`
      + `${[...new Set(missing)].join(', ')}`);
  }
});
// ── 测试跑批器自己的报告不能骗人 ──────────────────────────────────────────
//
// ⚠️ 两件事都真的发生过:
//
// ① 「环境没装好」报成「有失败」—— 新 worktree 里没跑过 `npm run vendor` ⟹
//    input/recorder 提前退出,而跑批器报「❌ 2/17 个文件有失败」。那句话会让人去找
//    代码 bug,而真相是环境没装好(云端 agent 逮到并修了)。
//
// ② **警告不在最后一行** —— 第一版把警告打在前面、`✅ 其余 15 个文件全绿` 打在后面,
//    而我们俩这一整轮都在用 `node test/run.js | tail -2` 看结果 ⟹ 那正好只看到绿的
//    那行。和 `|| echo` 掩盖退出码是同一个形状:**结论落在视野外**。
check('测试跑批器分得清「环境没装好」和「真失败」，且结论在最后一行', () => {
  const run = fs.readFileSync(path.join(__dirname, 'run.js'), 'utf8');
  const code = run.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  // 判成败一律看退出码。用输出内容判会漏掉"根本没跑起来"(那两个文件提前 exit、
  // 压根没打过 ✗)。
  assert.match(code, /result\.status/,
    '跑批器不是按退出码判成败 —— 用输出内容判会漏掉"根本没跑起来"那一类');
  // ⚠️ 必须锚在**判据常量**上，不能只搜 'npm run vendor' ——
  // 那个字符串在 run.js 里还出现在**提示语**里（「先跑 npm run vendor」）
  // ⟹ 把判据整个删掉，断言照样绿。实测过这个假阴性。
  const notReadyRe = code.match(/NOT_READY\s*=\s*(\/[^\n]+\/)/);
  assert.ok(notReadyRe,
    '找不到 NOT_READY 判据 ⟹ 跑批器会把「环境没装好」报成代码失败，把人引向错误方向');
  assert.match(notReadyRe[1], /vendor/,
    'NOT_READY 判据里没有 vendor —— 那是本项目唯一见过的「跑不起来」原因');
  assert.match(code, /failed \|\| notReady \? 1 : 0/,
    '环境没装好必须也非 0 退出 —— 否则 CI 会把"没跑"读成"通过"');

  // ⚠️ **最坏的情况必须打在最后**，因为所有人（包括我们两个 agent）都在用
  // `| tail -2` 看结果 —— 落在视野外的结论等于没报。
  //
  // 优先级：真失败 > 环境没装好 > 全绿。而这**不是**"警告在绿色之后"那么简单：
  //
  //   第一版守卫锚的是 `警告位置 > 全绿位置`。它挡住了坑①（警告在绿色之前），
  //   但**挡不住坑②**：只把警告挪到最后 ⟹ 真失败 + 缺 vendor 同时存在时，
  //   `tail -2` 只看到「缺 vendor」，那条真失败被推出视野 ⟹ 你去跑
  //   npm run vendor 然后以为好了。
  //
  // ⚠️ **不能在这里 spawn run.js 来验行为** —— run.js 跑所有 *.test.js，
  // **包括这个文件本身** ⟹ 无限递归。我试过，120 秒超时。
  //
  // ⟹ 只能用源码结构兜住。
  // 用源码结构兜住：真失败那句必须是**最后一个** console.log。
  const logs = [...code.matchAll(/console\.log\(/g)].map((m) => m.index);
  const failAt = code.indexOf('个文件有失败');
  const lastLogAt = logs[logs.length - 1];
  assert.ok(failAt > lastLogAt,
    '「有失败」不在最后一个 console.log 里 ⟹ 真失败 + 缺 vendor 同时存在时，'
    + '`| tail -2` 会只看到「缺 vendor」，那条真失败被推出视野');
  const warnAt = code.lastIndexOf('环境没装好');
  assert.ok(warnAt > 0 && warnAt < failAt,
    '「环境没装好」的警告在真失败之后 ⟹ 最坏的情况被推出视野');
});

// ⚠️ 报数必须在**所有** check 之后。
//
// 合并时踩到:这一行原本在文件中间(约 1169 行),而它后面还有几十条 check ⟹ 报
// 「78 项通过」而实际跑了 121 条。**报数少了不会红**,所以它看起来一直是对的,
// 而「守卫数量」正是我们判断有没有丢守卫的依据 —— 口径错了那个判断就全废。

// ⚠️ bind() 的每个 id 必须在 HTML 里真实存在。
//
// 实测烧的一轮：收缩成两个页签时删了 music / showHud / moodFromCover 三个开关的元素，
// 而 renderToggles 里的 bind 调用留着 ⟹ `node.checked` 对 null 抛 TypeError。
//
// 后果和它的样子完全不成比例：renderToggles 是 apply() 的第三步，一抛之后
// **后面所有初始化都不跑** —— 我的壁纸目录列表、鼠标转发勾选、筛选初始状态全空。
// 用户看到的是「功能没反应」，而根因是一个被删掉的 UI 元素。
//
// 这是「删 UI 留调用」这个形状的第 N 次，所以要一条机械守卫。
check('renderToggles 里 bind 的每个 id 都在 HTML 中存在（删 UI 留调用会打断 apply）', () => {
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  const ids = [...codeOnly(dash).matchAll(/bind\('([a-zA-Z]+)'/g)].map((m) => m[1]);
  assert.ok(ids.length >= 4, `只找到 ${ids.length} 个 bind，正则大概失效了`);
  for (const id of ids) {
    assert.ok(html.includes(`id="${id}"`),
      `bind('${id}') 指向的元素不在 dashboard.html 里 —— 会抛 TypeError 并打断 apply()，`
      + '后面所有初始化都不跑');
  }
});

// 就算漏删了，也不该把 apply() 整条带走。
check('bind 对缺失元素跳过而不是抛（一个删掉的开关不该弄死整个面板）', () => {
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  const start = dash.indexOf('const bind = (id');
  assert.ok(start > 0, '找不到 bind');
  const body = dash.slice(start, start + 400);
  assert.match(body, /if \(!node\)/,
    'bind 没有 null 检查 —— 一个被删掉的开关会打断 apply() 的其余部分');
  // 静默跳过会变成查不出的鬼故事，必须报出来
  assert.match(codeOnly(dash), /missing\.push/, '跳过了但没记录，界面不动时查不出原因');
});


// ⚠️ 404 通道的协议和白名单守卫**在上面**（本地 agent 的 `ea22921`，约 717-742 行）。
//
// 我在 `380cc4d` 里也写了两条一样的，后来删掉了 —— 他那版用
// `urls: \[([^\]]+)\]` 精确匹配到过滤器数组内部，我那版是 400 字符切片，
// 更容易假阳性。
//
// ⚠️ 教训不是"谁的好"，是**两个 agent 独立给同一件事加守卫会重复**，
// 而重复守卫的代价是改那段代码时两处都要维护、漏一处就出现"一条红一条绿"。
// ⟹ 加守卫前先 grep 一下同名概念在不在（这次是 `onErrorOccurred`）。


console.log('\n  脚本退出码（&& 链里静默阻断）');

// ⚠️ 纯报告脚本必须显式 exit 0。
//
// 实测烧掉一轮：`fingerprint.sh` 末尾是 `[ "$dirty" -gt 0 ] && echo "有未提交改动"`。
// 干净工作区（dirty=0）时那个条件为假 ⟹ **整个脚本以退出码 1 结束** ⟹
// `npm run sync && npm start` 里的 && **阻断了 npm start**。
//
// 症状极度误导：所有输出都正常（vendor 就绪、指纹、上下文全打了），然后**什么都没发生**
// —— 看起来像 Electron 起不来，而日志里一个错都没有。
// 用户报「npm start 跑了但没反应」，我们只能靠读 package.json 的 && 链才发现。
//
// ⚠️ 这和我记忆里那条「退出码掩盖」是同一族：`|| echo` 让失败变成 exit 0，
// 而这里是反的 —— 一句无害的条件判断让成功变成 exit 1。**两个方向都要防。**
check('纯报告脚本显式 exit 0（否则 && 链会被静默阻断）', () => {
  const dir = path.join(__dirname, '..', 'scripts');
  const REPORTERS = ['fingerprint.sh', 'whatswrong.sh', 'diag-packaged.sh', 'restore-gestures.sh'];
  for (const name of REPORTERS) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#'));
    assert.strictEqual(lines[lines.length - 1].trim(), 'exit 0',
      `${name} 最后一句不是 exit 0 —— 末尾命令的真假会变成退出码，`
      + '而它一旦非 0 就会静默阻断 `xxx && npm start` 这类链');
  }
});

// restore-gestures.sh 是恢复手势的救命脚本，它的失败必须能被看见。
check('restore-gestures.sh 保留「找不到 tag」的失败路径', () => {
  const file = path.join(__dirname, '..', 'scripts', 'restore-gestures.sh');
  if (!fs.existsSync(file)) return;
  const src = fs.readFileSync(file, 'utf8');
  // ⚠️ 用 `lastIndexOf('exit 0')` 是错的 —— 末尾那个 exit 0 永远在最后，
  // 所以中间插一个 exit 0 也检测不出来。第一版就这么写的，反向验证时没逮到。
  // ⟹ 要验的是「exit 1 之前没有任何 exit 0」。
  const failAt = src.indexOf('exit 1');
  assert.ok(failAt > 0, '「找不到 tag」的 exit 1 不见了 —— 那会让失败报成成功');
  const before = src.slice(0, failAt).split('\n')
    .filter((l) => !l.trim().startsWith('#'));
  assert.ok(!before.some((l) => /\bexit 0\b/.test(l)),
    'exit 1 之前出现了 exit 0 ⟹ tag 找不到也会报成功，'
    + '而这是恢复手势的救命脚本，用户会以为手势回来了');
});


console.log('\n  「壁纸要音频但音源关着」的提示');

// ⚠️ 实测烧的一轮：用户装载「完美壁纸」，山景背景出来了，但音频圆环完全不动。
//
// 而 project.json 里 `supportsaudioprocessing: true` ⟹ 我们**知道**它要音频，
// 也知道 `audioSource` 是 'off'（默认值）—— 却什么都没说。
// ⟹ 用户去查一个不存在的 bug，而真相是"没开音源 + 开了也要打包才有授权"。
//
// 这一族问题（我们知道原因却不说）在本项目已经反复出现，所以要机械守卫。
check('壁纸要音频而音源关着时，面板主动说明（否则被当成坏了）', () => {
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  // 元素必须存在 —— 这正是上一轮 bind 那个坑（引用了被删的元素）。
  assert.ok(html.includes('id="we-audio-note"'),
    '缺 #we-audio-note 容器 ⟹ 提示无处可放，而代码里的判断会静默 no-op');
  const code = codeOnly(dash);
  assert.match(code, /weWantsAudio/,
    '面板不知道壁纸要不要音频 ⟹ 无法区分"这壁纸本来就没有音频部分"和"音源没开"');
  assert.match(code, /supportsaudioprocessing/,
    '提示里没点名 project.json 的那个字段 —— 用户无法自己核对');
  assert.match(code, /屏幕录制/,
    '没说清开音源要屏幕录制授权 ⟹ 用户会以为点一下就能用');
});

// wantsAudio 必须真的从主进程送到面板，否则上面那条判断永远是 false。
check('wantsAudio 从 project.json 一路送到面板', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(codeOnly(main), /wantsAudio: weProject \? weProject\.wantsAudio/,
    'weStatus 载荷里没有 wantsAudio ⟹ 面板拿不到，提示永远不出现');
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  assert.match(dash, /weWantsAudio = !!status\.wantsAudio/,
    '面板没读 status.wantsAudio ⟹ 那个变量恒为 false');
  // ⚠️ 赋值必须在早退之前，否则 we-state 容器不存在时提示永远不出现。
  const at = dash.indexOf('weWantsAudio = !!status.wantsAudio');
  const ret = dash.indexOf("const node = document.getElementById('we-state')");
  assert.ok(at > 0 && at < ret,
    'wantsAudio 的赋值在 we-state 早退之后 ⟹ 那个 return 会让音频提示永远不出现');
});


console.log('\n  打包与 build 标识（"我跑的是哪个版本"）');

// ⚠️ 打包版**没有终端** ⟹ build 标识必须能在界面里看到。
//
// 这是打包来回测试的前提：「我跑的是哪个版本」如果靠记，一定会出现
// "改了没生效"的假象 —— 而那会让人去查一个已经修好的问题。
// 用户明确要求过：「不要让我本地测成旧版本了」。
check('build 标识同时报版本、commit、是否打包', () => {
  const src = codeOnly(mainSrc);
  const i = src.indexOf('function buildStamp');
  assert.ok(i > 0, '没有 buildStamp —— 无法分辨跑的是哪个版本');
  const fn = src.slice(i, i + 700);
  assert.match(fn, /getVersion/, 'build 标识里没有版本号');
  assert.match(fn, /gwCommit|GW_COMMIT/, 'build 标识里没有 commit —— 版本号不变时分辨不出来');
  assert.match(fn, /isPackaged/,
    'build 标识没说是否打包 —— 而那决定权限能不能拿到（npm start 拿不到）');
});

check('build 标识送到面板（打包版没有终端）', () => {
  const main = codeOnly(mainSrc);
  assert.match(main, /build: buildStamp\(\)/, 'weStatus 载荷里没有 build');
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  assert.ok(html.includes('id="build-stamp"'),
    '缺 #build-stamp 容器 ⟹ 打包版里根本看不到版本');
  assert.match(codeOnly(dash), /build-stamp/, '面板没渲染 build 标识');
});

// ⚠️ 这两条是用户实测烧出来的：他报「没看到任何类似 v0.9.10 … 的字样」。
// 两个原因叠在一起，而**每一个单独都足以让标识不可见**：
//   ① 我放进了 `#launch`（开屏页），而那个页会 `.gone` 淡出
//   ② 我在 `renderWEStatus()` 里赋值，而那个函数不一定在启动时跑
check('build 标识在常驻容器里（不能放开屏页 —— 那会淡出）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  const at = html.indexOf('id="build-stamp"');
  assert.ok(at > 0, '缺 #build-stamp');
  // 找它落在哪个块里：launch 是开屏页（会淡出），nav 是常驻的。
  const launchAt = html.indexOf('id="launch"');
  const navAt = html.indexOf('<nav>');
  assert.ok(navAt > 0, '找不到 nav —— 锚点变了，这条守卫要跟着改');
  assert.ok(at > navAt,
    'build 标识在 nav 之前 ⟹ 它大概在开屏页 #launch 里，而那个页会 .gone 淡出，'
    + '用户实测报"没看到任何字样"');
  if (launchAt > 0 && launchAt < navAt) {
    const launchBlock = html.slice(launchAt, navAt);
    assert.ok(!launchBlock.includes('id="build-stamp"'),
      'build 标识在 #launch 里 —— 那个开屏页会淡出，标识跟着消失');
  }
});

check('build 标识从 apply() 渲染（不依赖"恰好装载了壁纸"）', () => {
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  assert.match(dash, /function renderBuildStamp/,
    '没有独立的 renderBuildStamp —— 塞在别的函数里会跟着那个函数的时机走');
  // apply() 是配置一到就跑的必然入口
  const applyAt = dash.indexOf('function apply(');
  assert.ok(applyAt > 0, '找不到 apply()');
  const applyBody = dash.slice(applyAt, applyAt + 1500);
  assert.match(applyBody, /renderBuildStamp\(\)/,
    'apply() 里没调 renderBuildStamp ⟹ 标识的出现依赖别的时机，'
    + '而"没装载壁纸时看不到版本"正是用户撞到的');
});

// ⚠️ asar 必须关掉。MediaPipe 的 locateFile 返回**相对路径**，而 asarUnpack 会把
// 文件搬到 app.asar.unpacked/ ⟹ 从 app.asar/ 里的相对路径到不了那儿。
// 症状是"摄像头不启动、什么都不说"，这个项目为它烧过一轮。
check('asar 关掉（否则 MediaPipe 的 wasm 读不出来）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  assert.strictEqual(pkg.build.asar, false,
    'asar 开着 ⟹ MediaPipe 的 locateFile 用相对路径读不到 wasm/tflite，'
    + '症状是摄像头不启动且什么都不说');
});

check('两个 Swift helper 都进 extraResources（不然打包版拿不到它们）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const froms = (pkg.build.extraResources || []).map((r) => (typeof r === 'string' ? r : r.from));
  for (const helper of ['GestureWallMouse.swift', 'GestureWallAudio.swift']) {
    assert.ok(froms.some((f) => f && f.includes(helper)),
      `${helper} 不在 extraResources ⟹ 打包版里没有它，而那两条链正是只能打包版验的`);
  }
});

// 权限声明缺了会**静默拿不到授权**，而症状和"代码坏了"一样。
check('两个权限声明都在（缺了会静默拿不到授权）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const info = (pkg.build.mac && pkg.build.mac.extendInfo) || {};
  assert.ok(info.NSScreenCaptureUsageDescription,
    '缺屏幕录制声明 ⟹ 音频采集静默失败（macOS 不给授权对话框）');
  assert.ok(info.NSCameraUsageDescription, '缺摄像头声明 ⟹ 手势录制拿不到摄像头');
});


console.log('\n  属性发送状态（"圆环为什么不出现"的第一观测点）');

// ⚠️ 实测烧的一轮：用户报「圆环没有、也没交互」，而面板只说
// "页面加载了但壁纸还没报 ready"。
//
// 而 `ready` 只是个**显示信号**（`weReady` 不阻塞任何功能，我核过）——
// 真正该问的是**那 100+ 项属性进去了吗**：这个壁纸的圆环、粒子、时间显示全部
// 由属性驱动（showCircle / visual_audio_model / particles_isParticles…），
// 属性没进去它什么都不画。
//
// 而主进程原来把 `no-listener` **静默吞掉**（只有非 no-listener 才 warn），
// 理由是"这个壁纸没有可配置项（正常）"—— 那个理由错了：
// **有 100+ 项属性却没有 listener，才是最该报的情形。**
check('属性发送状态送到面板（有属性但没 listener 必须报出来）', () => {
  const main = codeOnly(mainSrc);
  assert.match(main, /props: wePropState/,
    'weStatus 载荷里没有属性发送状态 ⟹ 面板无法区分"属性进去了"和"一项都没进"');
  // ⚠️ 不能锚在单行上 —— 那个赋值是跨行的（对象字面量换行了），
  // `/wePropState = \{ state: '已送到'/` 在多行代码上匹配不到。
  // 实测：这条断言第一版就因此在正确代码上报红。
  assert.match(main, /已送到/,
    '成功时不记录状态 —— 那样「送到了」和「还在重试」分不清');
  // 关键：no-listener 且有属性时必须报
  const i = main.indexOf("result.reason === 'no-listener'");
  assert.ok(i > 0, 'no-listener 没有单独分支 ⟹ 又会被当成「正常」静默掉');
  const block = main.slice(i, i + 600);
  assert.match(block, /total > 0/,
    '没区分"有属性但没 listener"和"本来就没属性" —— 前者是故障，后者正常');
});

check('面板把 no-listener 说成故障而不是留白', () => {
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  const code = codeOnly(dash);
  assert.match(code, /function propsLine/, '面板没有属性状态那一行');
  const i = code.indexOf('function propsLine');
  const fn = code.slice(i, i + 1200);
  assert.match(fn, /no-listener/, 'propsLine 没处理 no-listener —— 那是最需要说清的一种');
  assert.match(fn, /⌃⇧D/,
    '没告诉用户下一步去哪看 —— 而 Console 第一条报错才是真正的原因');
  assert.match(fn, /warn/, 'no-listener 没标成警告样式 ⟹ 看起来像正常状态');
});


console.log('\n  退出路径（"点了退出但还在跑"）');

// ⚠️ 用户实测报：「点击了退出，但貌似没有真正关掉，壁纸还是正常运行，
// 然后 app 图标那里也没有退出选项了」。
//
// 而这条在 AirCursor 早期就出过（aircursor-notes/pitfalls.md 第 74-87 行）：
//   「Dock 里不像正常运行中的应用……用户感觉『没开但关不掉』」
//   处理：「菜单栏提供『显示』和『退出』，Command+Q 也能退出」
//
// ⟹ 我们重演了它：整个应用**零菜单**。一个长在桌面层、没有可见窗口的壁纸应用，
// 用户唯一的直觉入口就是 Dock 图标和菜单栏 —— 那两个都必须能退出。
check('有应用菜单，且退出走 role: quit（Cmd+Q 和 Dock 右键都要命中）', () => {
  const src = codeOnly(mainSrc);
  assert.match(src, /Menu\.setApplicationMenu/,
    '零菜单 ⟹ 除了记住 ⌃⇧Q 没有别的出口，而这条 bug AirCursor 早期就出过');
  // ⚠️ 这条断言上一版要求 `role: 'quit'`，而**实测把它证伪了**：
  // 用户报「菜单栏退出之后程序没有停止」，ps 显示主进程 CPU 0.1%/1.51s
  // ⟹ 根本没走到退出逻辑。role 走 Electron 标准链，而我们那两个特殊窗口
  //（type:'desktop' 壁纸层 + screen-saver 骨架层）让那条链停在中途。
  //
  // ⟹ 现在验的是"有自己控制的退出路径"而不是"用了标准 role"。
  assert.match(src, /Command\+Q/,
    '菜单里的退出没绑 Cmd+Q —— 那是 mac 用户的第一反应');
  assert.match(src, /hardQuit/,
    "退出没走自己的路径 —— role: 'quit' 实测在本项目不管用（见 hardQuit 的注释）");
  // 菜单必须在 whenReady 里最先建 —— 后面任何一步抛异常都会让应用"跑着但退不掉"
  const ready = src.indexOf('app.whenReady()');
  const build = src.indexOf('buildAppMenu()', ready);
  assert.ok(build > 0 && build - ready < 200,
    '菜单不是 whenReady 里最先建的 —— 后面任何一步抛异常都会让应用跑着但退不掉');
});

// ⚠️ 退出要**看得见地在发生**。慢活放在拆窗口之后。
check('退出时先拆窗口，再做还原这类慢活', () => {
  const src = codeOnly(mainSrc);
  const i = src.indexOf("app.on('will-quit'");
  assert.ok(i > 0, '没有 will-quit');
  const body = src.slice(i, i + 1200);
  const destroyAt = body.indexOf('.destroy()');
  const restoreAt = body.indexOf('setSystemWallpaper');
  assert.ok(destroyAt > 0,
    'will-quit 里没有拆窗口 ⟹ 慢活期间壁纸还在动，用户以为没退成');
  assert.ok(restoreAt > destroyAt,
    '还原壁纸排在拆窗口之前 ⟹ 那段时间（osascript 最坏几秒）窗口还在、壁纸还在动，'
    + '看起来就是"点了退出没反应"');
});

check('退出路径上的 osascript 超时要短（8 秒会被当成卡死）', () => {
  const src = codeOnly(mainSrc);
  assert.match(src, /setSystemWallpaper\(originalWallpaper, \d+\)/,
    '退出时用了默认超时 —— osascript 最坏 8 秒，那段时间用户会去强制退出，'
    + '而强杀会留下 helper 进程占着摄像头/屏幕录制');
  const m = src.match(/setSystemWallpaper\(originalWallpaper, (\d+)\)/);
  assert.ok(m && Number(m[1]) <= 2000,
    `退出超时 ${m && m[1]}ms 太长 —— 超过 2 秒用户就会认为程序卡死了`);
});


// ⚠️ 退出的每一步都要能观测。
//
// 实测两轮都栽在"退不掉"上，而两轮都**看不到它卡在哪** ——
// 第一轮我以为是慢活拖住（改了顺序），第二轮才从 ps 输出看出
// 主进程 CPU 0.1%/累计 1.51 秒 ⟹ 根本没走到退出逻辑。
// ⟹ 如果第一轮就有分步日志，第二轮不用猜。
check('退出分步打日志（下次退不掉能直接看到卡在哪）', () => {
  const src = codeOnly(mainSrc);
  const i = src.indexOf('function hardQuit');
  assert.ok(i > 0, '没有 hardQuit');
  const fn = src.slice(i, src.indexOf('\nfunction ', i + 10));
  assert.match(fn, /\[quit\]/, '退出过程没有日志 ⟹ 退不掉时只能猜卡在哪');
  // 每一步都要 try 住：一步失败不能挡住后面的，那正是"退不掉"的成因
  assert.match(fn, /catch/,
    '某一步抛异常会挡住后面所有清理 ⟹ 那正是"退不掉"的成因');
  // 最后一定要 app.exit：那是不可阻挡的兜底
  assert.match(fn, /app\.exit\(0\)/,
    '结尾不是 app.exit(0) ⟹ 任何 before-quit/will-quit 钩子都能再次阻止退出，'
    + '而退不掉的壁纸会占着屏幕/摄像头/屏幕录制权限');
});

check('退出用 getAllWindows() 而不是几个变量（漏一个窗口进程就留着）', () => {
  const src = codeOnly(mainSrc);
  const i = src.indexOf('function hardQuit');
  const fn = src.slice(i, src.indexOf('\nfunction ', i + 10));
  assert.match(fn, /BrowserWindow\.getAllWindows\(\)/,
    '按变量名逐个拆窗口 ⟹ 漏掉任何一个（或以后新加的）都会让进程留着');
});

check('重复触发退出是幂等的（用户会连点）', () => {
  const src = codeOnly(mainSrc);
  const i = src.indexOf('function hardQuit');
  const fn = src.slice(i, src.indexOf('\nfunction ', i + 10));
  assert.match(fn, /if \(quitting\)/,
    '没有防重入 ⟹ 用户点两次会跑两遍清理（而"点了没反应"时人一定会再点）');
});


// ⚠️ 属性状态变了必须**推**给面板。
//
// 实测：用户看到「⏳ 正在发 137 项属性…」一直不变 —— 而那是**过期显示**：
// `broadcast('we-status')` 原来只在装载/失败时发，而属性发送是装载**之后**
// 才完成的 ⟹ 面板永远停在装载那一刻的快照。
//
// 过期显示比没有显示更糟：它让人以为"卡在发送中"，而真实状态早就变了。
check('属性状态变化推给面板（否则面板停在装载那一刻的快照）', () => {
  const src = codeOnly(mainSrc);
  const i = src.indexOf('const attempt = async');
  assert.ok(i > 0, '找不到属性发送的重试逻辑');
  const block = src.slice(i, src.indexOf('attempt();', i));
  // ⚠️ 数个数不够 —— 要验**成功那条路径**上有推送。
  // 第一版写的是 `pushes >= 2`，而删掉成功路径那次推送后仍有 2 处（失败路径 + 慢重试）
  // ⟹ 断言照样绿。**计数式断言挡不住"少了关键的那一个"。**
  const successAt = block.indexOf("state: '已送到'");
  assert.ok(successAt > 0, '找不到成功分支');
  // 成功分支到它的 return 之间必须有 broadcast
  const successBlock = block.slice(successAt, block.indexOf('return;', successAt));
  assert.match(successBlock, /broadcast\('we-status'/,
    '属性**发送成功**时没推状态 ⟹ 面板停在"正在发"，而那是过期显示'
    + '（用户实测撞到：「⏳ 正在发 137 项属性…」一直不变）');
});

// ⚠️ 超时之后不能彻底放弃。
check('属性发送超时后转低频长期重试（壁纸挂 listener 是它自己的时序）', () => {
  const src = codeOnly(mainSrc);
  assert.match(src, /weSlowPropTimer/,
    '超时后彻底放弃 ⟹ 壁纸晚挂 listener 时 137 项属性一项都进不去，'
    + '而画面会永久缺一块（圆环/粒子/时间全靠属性驱动）');
  // 超时本身也不能太短
  const m = src.match(/WE_PROP_TIMEOUT_MS = (\d+)/);
  assert.ok(m && Number(m[1]) >= 20000,
    `高频重试只有 ${m && m[1]}ms —— 那个壁纸要加载 jquery + sakura.js + 一个被 CORS `
    + '挡掉的天气 XHR，8 秒之内很可能还没挂上 listener');
});

// ⚠️ 两个定时器都要在卸载和退出时清掉。
check('两个属性定时器在卸载和退出时都清掉', () => {
  const src = codeOnly(mainSrc);
  for (const [where, anchor] of [['destroyWEWindow', 'function destroyWEWindow'],
    ['hardQuit', 'function hardQuit']]) {
    const i = src.indexOf(anchor);
    assert.ok(i > 0, `找不到 ${where}`);
    const body = src.slice(i, i + 1600);
    assert.match(body, /weSlowPropTimer/,
      `${where} 里没清 weSlowPropTimer ⟹ 换壁纸后它还在给**旧壁纸**发属性`
      + '（窗口已销毁 ⟹ 报错刷屏，或者更糟：把旧壁纸的结果报成"已送到"）');
  }
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
