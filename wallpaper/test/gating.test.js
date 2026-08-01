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
  // ⚠️ `we-pick` 0.9.37 整条链删了（用户说它和「换目录…」冗余）
  // ⟹ 从清单里去掉。留着的话这条守卫会要求我们保留死代码。
  for (const channel of ['we-clear', 'we-controls', 'we-status',
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
// ⚠️ 动态创建的 id：用 innerHTML 建出来的节点，HTML 文件里当然没有。
//
// 判据不是白名单，而是**能在 dashboard.js 里找到它的 innerHTML 来源** ——
// 那样"忘了在 HTML 里加容器"仍然会被逮到，而"动态建的"不会假阳性。
//
// 这个盲区撞过两次（audio-yes/audio-no/audio-test、mine-open-ours），
// 两次都是我加了动态按钮然后守卫报红。⟹ 一次解决，而不是每次加白名单。
function dynamicIds(dashSrc) {
  const out = new Set();
  // innerHTML 里的 id="xxx"（模板字符串或普通字符串都行）
  for (const m of dashSrc.matchAll(/id="([\w-]+)"/g)) out.add(m[1]);
  // createElement 之后 .id = 'xxx'
  for (const m of dashSrc.matchAll(/\.id = '([\w-]+)'/g)) out.add(m[1]);
  return out;
}

check('面板渲染函数要的容器 id 在 HTML 里都存在', () => {
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  // getElementById('x') 和 renderActionGroup('x', …) 两种取法都算
  const ids = new Set([
    ...[...dash.matchAll(/getElementById\('([\w-]+)'\)/g)].map((m) => m[1]),
    ...[...dash.matchAll(/renderActionGroup\('([\w-]+)'/g)].map((m) => m[1]),
  ]);
  assert.ok(ids.size > 10, `只解析出 ${ids.size} 个 id，正则失效了`);
  // ⚠️ 排除**动态创建**的（innerHTML / .id = 建出来的）—— 它们在 HTML 里当然没有。
  const dyn = dynamicIds(dash);
  const missing = [...ids].filter((id) => !html.includes(`id="${id}"`) && !dyn.has(id));
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
  const card = codeOnly(dash).slice(codeOnly(dash).indexOf('function workshopCard'),
    codeOnly(dash).indexOf('async function runBrowse'));
  // ⚠️⚠️ 这条断言的意图是**"不支持的类型有标记"**，不是"用了某个具体的词"。
  // 原来写的是 `/放不了/`，而 0.9.53 用户让把文案换成「暂不支持」
  //（「放不了」听起来像坏了，而这是我们还没做）⟹ 断言本该报红。
  // 它**没报**，因为读的是原文而我在原处留了一句解释注释、里面就有"放不了"
  // ⟹ 第 9 次"注释骗过守卫"（假阴性方向）。⟹ 走 codeOnly + 锚到那个三元表达式。
  assert.match(card, /item\.supported \? item\.type : `\$\{item\.type\}·[^`]+`/,
    '不支持的类型没在卡片上标出来 ⟹ 用户点下去才知道');
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
  // ⚠️⚠️ **剥注释** —— 这是今天第五次踩"注释让守卫误判"。
  //
  // 我在删掉 `mine-refresh` 按钮时，注释里写了
  //   「这里原来是 `document.getElementById('mine-refresh').onclick = …`」
  // 而这条守卫读**原文** ⟹ 把注释里那个 id 当成真引用 ⟹ **在正确代码上报红**。
  //
  // 前四次是反方向（注释让守卫假**阴**性：改了代码而断言照样绿）。
  // 这次是假**阳**性 —— 同一个根因，两种表现。
  // ⟹ 规则很简单：**任何"查代码里有什么"的断言，一律先剥注释。**
  const js = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  const ids = [...js.matchAll(/getElementById\('([\w-]+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length > 10, `只解析出 ${ids.length} 个 id，正则失效了`);
  // ⚠️ 排除动态创建的（innerHTML / .id= 建出来的）—— 见 dynamicIds 的注释。
  const dyn2 = dynamicIds(js);
  const missing = [...new Set(ids)].filter((id) => !html.includes(`id="${id}"`) && !dyn2.has(id));
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


// ⚠️ 音源列表只能有一份。
//
// 实测：我加第四种音源（'synth' 合成测试音，免授权）时只改了面板的按钮列表，
// 而 main.js 的校验白名单 `['netease','system','off']` 把它拒了
// ⟹ 症状是"点了那个按钮没反应"。
//
// 同一个形状我在工坊那边栽过：支持类型列表重复，加了 image 之后自己的 dispatcher
// 拒绝自己生成的东西。**知识只能有一份。**
check('音源合法值只有一份（加一种不能只改半边）', () => {
  const main = codeOnly(mainSrc);
  assert.match(main, /AudioSource\.isValidSource/,
    'main.js 就地写了音源白名单 ⟹ 加一种音源时会漏掉这里，症状是"点了没反应"');
  // 禁止第二份硬编码列表
  assert.ok(!/\['netease',\s*'system'/.test(main),
    'main.js 里还有硬编码的音源列表 —— 那就是第二份知识');
  const A = require('../src/audio-source.js');
  assert.ok(Array.isArray(A.SOURCES) && A.SOURCES.includes('synth'),
    'audio-source.js 里没有 SOURCES 单一来源');
  // 面板的按钮必须覆盖全部合法值（少一个 = 那个音源用户点不到）
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  // ⚠️ 'ask' 是**内部默认值**，不是用户可点的按钮 —— 它的语义是"还没问过"，
  // 而问的方式是壁纸装载时的那句邀请，不是让用户在面板里选"询问"。
  // ⟹ 它必须合法（默认值），但不该出现在按钮列表里。
  for (const id of A.SOURCES.filter((x) => x !== 'ask')) {
    assert.ok(dash.includes(`id: '${id}'`),
      `面板没有 ${id} 这个音源按钮 ⟹ 它合法但用户点不到`);
  }
  assert.ok(!dash.includes("{ id: 'ask'"),
    "'ask' 出现在音源按钮列表里 —— 那是内部默认值，"
    + '让用户去选"询问"没有意义');
});

// ⚠️ 合成音源的意义：把"壁纸能不能画"和"我们能不能拿到音频"拆开。
check('有免授权的合成音源（否则圆环不出现和授权问题分不清）', () => {
  const main = codeOnly(mainSrc);
  assert.match(main, /function startSynthAudio/,
    '没有合成音源 ⟹「壁纸画不出圆环」和「拿不到系统音频」的症状完全一样，'
    + '而后者要屏幕录制授权+打包，前者是代码问题');
  // 它不能碰 ScreenCaptureKit —— 那就失去意义了
  const i = main.indexOf('function startSynthAudio');
  const fn = main.slice(i, main.indexOf('\nfunction ', i + 10));
  assert.ok(!/AudioSource\.start/.test(fn),
    '合成音源调了真采集 ⟹ 它又需要授权了，那就失去了拆分的意义');
  // ⚠️ 前 76 段的约束要体现在**代码**里，不能只写在注释里。
  // 第一版断言是 `/76/`，而注释里也有 76 ⟹ 把代码里的 76 改成 128，断言照样绿。
  // 实测过这个假阴性。
  const code = fn.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(code, /i >= 76/,
    '合成频谱没在代码里体现"壁纸只消费前 76 段"—— 而那正是它该用来验证的约束'
    + '（`Pe<=300` 没有 else ⟹ 512 空间的 301..511 被壁纸自己丢掉，反推到 128 段是 76）');
});


console.log('\n  音源默认开（用户定的产品行为）');

// 用户定的：「音源应该一开始就默认需要的，你这个音源面板不需要」
// +「默认需要权限吧，一次授权，后面就再也不需要了」。
//
// ⚠️ 而这不会造成莫名其妙的授权框：采集只在 `weProject.wantsAudio` 为真时启动，
// 也就是只有装载了 `supportsaudioprocessing: true` 的壁纸才碰 ScreenCaptureKit。
check('音源默认 system（不是 off）', () => {
  const src = codeOnly(mainSrc);
  const i = src.indexOf('const defaultConfig');
  const j = src.indexOf('audioSource:', i);
  assert.ok(j > 0, '找不到默认音源');
  const line = src.slice(j, src.indexOf('\n', j));
  assert.match(line, /'system'/,
    `默认音源是 ${line.trim()} —— 用户明确要求默认开，`
    + '而"默认关"的代价是每个新用户都经历一遍"这个壁纸怎么不动"'
    + '（本项目为那个症状查了六轮）');
});

// ⚠️ 采集必须仍然只在壁纸要音频时启动 —— 否则默认开就变成"一启动就弹授权框"。
check('采集只在壁纸真的要音频时启动（否则默认开会乱弹授权框）', () => {
  const src = codeOnly(mainSrc);
  // ⚠️ 锚在 `const want =` 那一行上，不是在整个函数里搜字符串 ——
  // `weProject.wantsAudio` 在合成音那条分支里也出现，
  // 所以搜整段会匹配到它 ⟹ 把真采集的检查删掉，断言照样绿。实测过这个假阴性。
  const i = src.indexOf('function syncAudioSource');
  const fn = src.slice(i, i + 900);
  const wantLine = fn.match(/const want = [^;]+;/);
  assert.ok(wantLine, '找不到 `const want =` —— 真采集的启动条件变了写法');
  assert.match(wantLine[0], /wantsAudio/,
    '真采集的启动条件没检查 wantsAudio ⟹ 默认开之后装载任何壁纸都会弹'
    + '屏幕录制授权框，而 video/image 壁纸压根不需要音频');
});

// ⚠️ 改默认值对存量配置无效 —— 这个坑本项目栽过（wallStrategy 那次）。
check('存量 off 迁移成 system（改默认值不影响已存配置）', () => {
  const src = codeOnly(mainSrc);
  const i = src.indexOf('function migrateConfig');
  const fn = src.slice(i, src.indexOf('\n}', i));
  assert.match(fn, /audioSource === 'off'/,
    '没迁移存量的 off ⟹ 老用户永远停在关闭状态，而改默认值对他们无效'
    + '（mergeConfig 保留已存的值）—— 这个坑 wallStrategy 那次栽过');
  // 只能迁 off，不许动用户主动选的
  assert.ok(!/audioSource === 'netease'/.test(fn) && !/audioSource === 'synth'/.test(fn),
    '迁移动了用户主动选的音源 —— off 是旧默认值（"从没选过"），'
    + 'netease/synth 是主动选择，不许覆盖');
});


console.log('\n  「我的壁纸」的目录要说清扫了哪儿');

// ⚠️ 用户报：面板只写「还没加自定义目录（steamcmd 那个是自动扫的）」——
// 而"那个"是哪个路径、存不存在、找到几个，一个字都没说。
//
// ⟹「我的壁纸是空的」时，用户没法判断是"目录不对"还是"目录对但里面没东西"，
// 而那两件事的下一步完全不同（改路径 vs 去下壁纸）。
check('自动扫描的目录要显示出来（路径 + 在不在 + 找到几个）', () => {
  const main = codeOnly(mainSrc);
  assert.match(main, /scanned,/,
    'workshop-local 没返回扫描详情 ⟹ 面板不知道扫了哪些目录');
  const i = main.indexOf('const scanned = roots.map');
  assert.ok(i > 0, '没有逐目录的扫描信息');
  const block = main.slice(i, i + 400);
  for (const [field, why] of [['exists', '目录在不在'], ['found', '找到几个壁纸'],
    ['auto', '是自动扫的还是用户加的']]) {
    assert.ok(block.includes(field), `扫描详情缺 ${field}（${why}）`);
  }

  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  assert.match(dash, /lastScanned/, '面板没保存扫描结果 ⟹ 目录区渲染不出来');
  // ⚠️ 切到**函数结尾**，不用固定长度 —— 我往 renderMineDirs 里加了三个
  // 操作按钮（换目录/恢复默认/刷新），2200 字符就把 `lastScanned` 推出去了
  // ⟹ **在正确代码上报红**。
  // ⚠️ 这一轮我已经栽过六次固定长度切片 + 一次固定行数窗口，这是第八次。
  //   ⟹ 规则：位置锚一律切到结构边界（`\n}` / `\nfunction ` / 下一个已知锚点）。
  const j = dash.indexOf('function renderMineDirs');
  const jEnd = dash.indexOf('\nfunction ', j + 10);
  const fn = dash.slice(j, jEnd > 0 ? jEnd : undefined);
  assert.match(fn, /lastScanned/,
    'renderMineDirs 没用扫描结果 —— 它只看 config.libraryDirs，'
    + '那样自动扫的目录永远不显示（用户实测撞到）');
  assert.match(fn, /item\.exists/, '没报"目录在不在"');
  assert.match(fn, /item\.found/, '没报"找到几个"');
});

// 两条会撞到的约束要提前说
check('目录为空时说清两条约束（子目录要有 project.json / 扫描上限）', () => {
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  // ⚠️ 切到函数结尾，不用固定长度 —— 我往这个函数里加了新代码（我的壁纸目录 +
  // 打开按钮），2600 字符的切片就被推走了 ⟹ 断言在正确代码上报红。
  // **切片长度是个会漂的锚点**，这轮已经栽过两次。
  const i = dash.indexOf('function renderMineDirs');
  const fn = dash.slice(i, dash.indexOf('\n}\n', i));
  assert.match(fn, /project\.json/,
    '没说"每个子目录要有 project.json" —— 用户会直接放一堆 mp4 然后发现认不出来');
  assert.match(fn, /500|2 层/,
    '没说扫描上限 —— 目录里东西多时结果不全，而用户不知道被截断了');
});

// ⚠️ renderMineDirs 的函数体里不能调 renderMine（会死循环）
check('renderMineDirs 的函数体里不调 renderMine（死循环）', () => {
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  const i = dash.indexOf('function renderMineDirs');
  const end = dash.indexOf('\n}', i);
  const body = dash.slice(i, end);
  // onclick 里调是允许的（那是事件回调，不是同步执行）
  //
  // ⚠️ 判定方式改了：原来往上找**固定 8 行**里有没有 `onclick`
  // ⟹ 我在调用前面加了一段 8 行以上的注释，`onclick` 就被推出窗口
  // ⟹ **在正确代码上报红**（调用确实在 onclick 回调里）。
  //
  // ⟹ 改成往上找**最近的一个** `onclick` / `function` / `=>` 边界：
  //    若最近的边界是 onclick 或箭头函数，那就是在回调里。
  // ⚠️ 这是"固定长度窗口"的又一次 —— 这一轮我已经栽过五次（都是切片长度），
  //    而这次是**行数窗口**，同一个形状换了个样子。
  const lines = body.split('\n');
  for (const [n, line] of lines.entries()) {
    if (!line.includes('renderMine()')) continue;
    // 往上扫到函数体开头，找最近的一个"进入回调"的标志
    let inCallback = false;
    for (let k = n - 1; k >= 0; k -= 1) {
      if (/onclick|addEventListener|\.then\(|=>\s*\{/.test(lines[k])) { inCallback = true; break; }
      // 遇到函数体开头就停（说明是同步路径）
      if (/^function |^const \w+ = function/.test(lines[k])) break;
    }
    assert.ok(inCallback,
      `renderMineDirs 的函数体里直接调了 renderMine()（第 ${n} 行）⟹ 死循环。`
      + '只有 onclick / 事件回调 里可以调');
  }
});


console.log('\n  实际频谱要能看见（调参的唯一依据）');

// ⚠️⚠️ 这一条是三轮调参之后才加的，而它本该是第一件事。
//
// 我为"幅度不对/不丝滑/渲染怪"改了三轮参数（分箱、平滑、归一化、上限），
// 而**从没看过那 128 个数长什么样** —— 每轮都从壁纸源码反推"应该是多少"，
// 然后靠用户看截图判断对不对。
//
// 用户第三次说「你在干什么」。那是准确的：**没有观测的调参就是猜。**
check('实际频谱值送到面板（否则调参只能猜）', () => {
  const main = codeOnly(mainSrc);
  assert.match(main, /we-audio-frame/,
    '没有把实际频谱送出来 ⟹ "NORMALIZE 该调多少"只能从壁纸代码反推，'
    + '而那是我连错三轮的做法');
  // 必须抽样，不能每帧发（30fps × 128 个数会灌满 IPC）
  assert.match(main, /audioFrameCount % \d+/,
    '没有抽样 ⟹ 30fps × 128 个数会把 IPC 灌满');
  // 形状判据：低频 vs 高频。那是"像不像音乐"的最快检查
  assert.match(main, /lowMean/, '没报低频段均值');
  assert.match(main, /highMean/, '没报高频段均值 —— 音乐应该低频远大于高频，'
    + '而那是判断"分箱/加权对不对"的第一眼');

  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  assert.match(dash, /renderAudioFrame/, '面板没渲染频谱');
  assert.match(dash, /onWeAudioFrame/, '面板没订阅频谱通道');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  assert.ok(html.includes('id="we-audio-frame"'), '缺容器 ⟹ 静默不显示');
});

// 面板要直接说"该往哪调"，而不是只报数字
check('频谱面板给出可操作的判断（顶天/太小/形状不对）', () => {
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  const i = dash.indexOf('function renderAudioFrame');
  const fn = dash.slice(i, i + 1800);
  assert.match(fn, /NORMALIZE/,
    '没说该调哪个参数 —— 报一堆数字而不说怎么办等于没报');
  assert.match(fn, /不是音乐的形状|像音乐/,
    '没判断形状 —— "低频>高频"是音乐的基本特征，那是最快的对错检查');
});


console.log('\n  标准壁纸目录 + 能在 Finder 打开');

// ⚠️ 用户要的（2026-07-31）：
// 「你的默认壁纸目录改成标准的壁纸软件的目录层级，然后我的壁纸这里要能够点开，
//   比如 wallpaper 就是在资源管理器中打开，我要能进到那个目录，看到我的壁纸文件」
check('有我们自己的壁纸目录，且在用户可见的位置', () => {
  const src = codeOnly(mainSrc);
  assert.match(src, /function ourWallpaperDir/, '没有我们自己的壁纸目录');
  // ⚠️ 0.9.31 起拆成两个：`defaultWallpaperDir()`（算默认路径）和
  // `ourWallpaperDir()`（读配置，空则退默认）—— 因为目录变成用户可改的了。
  // ⟹ `documents` 的断言要查**默认那个**，而且用**结构边界**切
  //（原来是 `slice(i, i+300)` 固定长度 —— 拆函数后那 300 字符里就没有它了）。
  assert.match(src, /function defaultWallpaperDir/,
    '没有 defaultWallpaperDir —— 默认路径必须单独算，'
    + '那样它能跟着 app.getPath 走（换用户/换机器自适应）');
  const di = src.indexOf('function defaultWallpaperDir');
  const dfn = src.slice(di, src.indexOf('\n}', di));
  // ⚠️ 必须在 documents 而不是 userData：后者是应用私有数据的位置，
  // Finder 里默认隐藏、用户找不到、也不该往里拖文件。
  assert.match(dfn, /getPath\('documents'\)/,
    "壁纸目录不在 documents 下 —— userData 是应用私有数据的位置，"
    + 'Finder 里默认隐藏，而壁纸是**用户的内容**：他要能打开、拖进去、备份');
  assert.ok(!/getPath\('userData'\)/.test(dfn),
    '壁纸目录用了 userData —— 那是私有数据目录，用户找不到');
  // ⚠️ 而**可改**这件事本身要有守卫：读 `config.we.wallpaperDir`，空则退默认
  const oi = src.indexOf('function ourWallpaperDir');
  const ofn = src.slice(oi, src.indexOf('\n}', oi));
  assert.match(ofn, /config\.we && config\.we\.wallpaperDir/,
    'ourWallpaperDir 不读配置 ⟹ 目录改不了（用户 2026-08-01：'
    + '「反正只有一个路径来源，只是我允许你更改」）');
  assert.match(ofn, /trim\(\)/,
    '没判空字符串 ⟹ 用户清空配置时会 path.join(undefined) 崩溃');
});

check('壁纸目录首次会建出来，且放说明文件', () => {
  const src = codeOnly(mainSrc);
  const i = src.indexOf('function ensureOurWallpaperDir');
  assert.ok(i > 0, '没有建目录的逻辑 ⟹ 用户点"打开"会失败');
  const fn = src.slice(i, i + 1600);
  assert.match(fn, /mkdirSync/, '不建目录');
  // ⚠️ 空目录对用户是没有信息的 —— 他不知道往里放什么、什么认得出来
  assert.match(fn, /project\.json/,
    '说明文件里没提 project.json —— 而"放了一堆 mp4 认不出来"是这个产品'
    + '最容易撞的墙');
});

check('每个扫描目录和每个本地壁纸都能在 Finder 打开', () => {
  const main = codeOnly(mainSrc);
  assert.match(main, /reveal-wallpaper-dir/, '没有打开目录的 IPC');
  // ⚠️ openPath 而不是 showItemInFolder：用户说的是"进到那个目录"
  const i = main.indexOf("ipcMain.handle('reveal-wallpaper-dir'");
  const fn = main.slice(i, i + 700);
  assert.match(fn, /shell\.openPath/,
    'showItemInFolder 只是选中目录，用户要的是**进去**看文件');

  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  assert.match(preload, /revealWallpaperDir/, 'preload 没暴露');

  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  // 三处入口：目录列表、壁纸卡片、空状态
  const calls = (dash.match(/revealWallpaperDir/g) || []).length;
  assert.ok(calls >= 3,
    `只有 ${calls} 处能打开目录 —— 该有三处：扫描到的每个目录、每张壁纸卡片、`
    + '以及"一个都没找到"时（那是最需要它的时刻）');
});

// ⚠️ 这里原来有一条「卡片的打开目录按钮必须 stopPropagation」——**删了**。
//
// 用户 2026-07-31 明确否掉了那个功能：「不是每个壁纸都要显示一下目录的。
// 就保留 我的壁纸目录：… 这个就行」。
// ⟹ 一个入口就够；N 张卡片上的 N 个按钮只是把一次操作重复 N 遍。
//
// 守卫也要跟着删 —— **留着它就是在守一个已经被否掉的设计**，
// 而那会让下一次"照守卫做"变成走回头路。



console.log('\n  页签职责 + 自动刷新');

// ⚠️ 用户 2026-07-31：「已下载的壁纸、壁纸层、音源、壁纸自己的参数这些都不应该在
// 创意工坊这个模块，应该在我的壁纸这个模块」。
//
// 他说得对，职责是清楚的：
//   创意工坊 = **找**壁纸（浏览、搜索、按 ID 下载）
//   我的壁纸 = **用**壁纸（有哪些、装哪个、怎么显示、参数、音源）
// 而原来「创意工坊」塞了 7 块、「我的壁纸」只有 1 块。
check('「用壁纸」的四块在「我的壁纸」页签，不在创意工坊', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  const weAt = html.indexOf('id="tab-we"');
  const mineAt = html.indexOf('id="tab-mine"');
  assert.ok(weAt > 0 && mineAt > 0, '找不到两个页签');
  const sectionOf = (start) => html.slice(start, html.indexOf('</section>', start));
  const we = sectionOf(weAt);
  const mine = sectionOf(mineAt);
  // ⚠️ 原来这里有「已下载的壁纸」—— 那块**和「我的壁纸」的列表重复**（同一个
  // workshopLocal()、同一批数据），用户报了之后删掉了旧的那份。
  // ⟹ 搬动区块之后要重新审有没有重复：搬之前它们在两个页签里，各自看起来都合理。
  //
  // ⚠️⚠️ 0.9.51：「壁纸层」「音源」在开发者模块里，而**开发者模块搬进了设置弹窗**
  // （用户：「左下方来个齿轮按钮是设置…这个弹窗里有…以及之前的开发者选项」）
  // ⟹ 判据从"必须在 tab-mine 里"改成"**在 tab-mine 或设置弹窗里**"。
  //   不变的那一半是"不许在创意工坊"—— 那个页签只管"找壁纸"。
  const settingsAt = html.indexOf('id="settings-modal"');
  assert.ok(settingsAt > 0, '找不到设置弹窗');
  const settings = html.slice(settingsAt);
  // ⚠️⚠️ 「壁纸自己的参数」从清单里去掉了（0.9.54）：它不再是一个 `<h3>` 小节，
  // 而是**右侧详情面板里的一段**（`#side-props-head` + `#we-controls`）——
  // 用户给了 WE 的截图：「右边那个就是你点击了哪个壁纸，他的预览图和参数信息」。
  // ⟹ 那两个 id 由下面单独的断言守（查它们在 tab-mine 的右侧面板里）。
  for (const title of ['壁纸层', '音源']) {
    assert.ok(mine.includes(`<h3>${title}</h3>`) || settings.includes(`<h3>${title}</h3>`),
      `「${title}」既不在「我的壁纸」页签也不在设置弹窗 —— 那是"用壁纸"的功能`);
    assert.ok(!we.includes(`<h3>${title}</h3>`),
      `「${title}」还在「创意工坊」—— 那个页签只该管"找壁纸"`);
  }
  // 参数那一段：必须在「我的壁纸」的右侧面板里，不许在创意工坊
  //（工坊壁纸还没下载，读不到 project.json ⟹ 那里放参数是无意义的）
  assert.ok(mine.includes('id="we-controls"'),
    '壁纸参数（#we-controls）不在「我的壁纸」页签 —— 那是"用壁纸"的功能');
  assert.ok(!we.includes('id="we-controls"'),
    '壁纸参数跑到「创意工坊」了 ⟹ 那边的壁纸还没下载，读不到 project.json');
  // 创意工坊要留下"找"相关的。
  // ⚠️ 0.9.54 起判据从"有 `<h3>浏览创意工坊</h3>` 这个标题"改成"**浏览的控件在**" ——
  // 那个 h3 撤了（tab 条上已经写着「创意工坊」，页面里再写一遍是重复），
  // 而这条断言的**意图**是"浏览功能还在"，不是"有那个标题"。
  //（这一轮第 4 次改这类断言：写的是"当时那个位置/那个字"，不是意图。）
  assert.ok(we.includes('id="br-grid"') && we.includes('id="br-q"'),
    '创意工坊没有浏览功能了（搜索框 + 结果网格）');
});

// ⚠️ 用户报：「壁纸存储目录那里应该是自动刷新，不应该是每次我自己手动点击刷新才能看到」。
//
// 理由比"方便"更硬：壁纸目录是**磁盘上的东西**，用户会在 Finder 里拖文件、删文件 ——
// 那些变化面板压根不知道。
check('切到「我的壁纸」自动刷新，而且**启动时也刷**', () => {
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));

  // ⚠️⚠️ 0.9.58 把这段逻辑从 onclick 里抽成了 `renderTab(tab)` ——
  // 原来的断言是 `dash.slice(i, i + 900)` 里查 `dataset.tab === 'mine'`，
  // 抽出去之后那个字符串不在那 900 字符里了 ⟹ **在正确代码上报红**。
  // （固定长度切片 + 锚具体写法，这一轮第 6 次改这类断言。）
  // ⟹ 改成查它的**意图**：有一个函数管"切到某页签要做什么"，而它会调 renderMine。
  const fn = dash.slice(dash.indexOf('function renderTab('),
    dash.indexOf('\n}', dash.indexOf('function renderTab(')));
  assert.ok(fn.length > 20, '找不到 renderTab —— 切页签的刷新逻辑在哪？');
  assert.match(fn, /tab === 'mine'/, "renderTab 里没有 'mine' 的分支");
  assert.match(fn, /renderMine\(\)/, 'renderTab 不调 renderMine ⟹ 切过去看到的是旧数据');
  // 页签按钮要走这个函数（而不是各自内联一份）
  const click = dash.slice(dash.indexOf("nav button[data-tab]"));
  assert.match(click.slice(0, 700), /renderTab\(button\.dataset\.tab\)/,
    '页签按钮没走 renderTab ⟹ 两条路径各写一份，加新页签时会漏掉一条');

  // ⚠️⚠️ **启动时也要渲染当前页签**（0.9.58 修的 bug）。用户报：
  //   「每次打开的时候，我的壁纸这里是空白，要过一阵，并且我自己点一下才会出来」
  // 根因：renderMine 只挂在 onclick 上，而 0.9.54 把「我的壁纸」改成了默认页签
  // ⟹ 那个 onclick 从来没触发过。
  // ⟹ 判据：**默认页签也是"切到"了** —— 初次显示和点击切换走同一条路。
  assert.match(dash, /if \(!bootRendered\)[\s\S]{0,240}?renderTab\(/,
    '启动时不渲染当前页签 ⟹ 默认页签（我的壁纸）打开是空的，要点一下才出来');
  // ⚠️ 只在第一次 apply 时做 —— 主进程每次改配置都广播 apply，
  //   每次都重扫磁盘的话，调一个参数就触发一次全盘扫描。
  assert.match(dash, /bootRendered = true/,
    'bootRendered 没置位 ⟹ 每次 apply 都重扫磁盘（调一个参数就全盘扫一次）');
});

// ⚠️ 更贴合真实动作的时机：点「打开」进 Finder → 拖文件 → 切回面板。
check('面板重新获得焦点时刷新（从 Finder 拖完文件切回来）', () => {
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  assert.match(dash, /addEventListener\('focus'/,
    '焦点回来时不刷新 —— 而"进 Finder 拖文件再切回来"正是最需要刷新的时刻');
  const i = dash.indexOf("addEventListener('focus'");
  const block = dash.slice(i, i + 400);
  // ⚠️ 必须只在那个页签是当前页时扫 —— 否则每次切回窗口都遍历磁盘
  assert.match(block, /classList\.contains\('on'\)/,
    '每次切回窗口都扫磁盘 —— Steam 那个目录 639MB，而用户可能只是回来看手势设置');
});

// ⚠️ 不许轮询。
check('目录不用轮询刷新（扫描要遍历磁盘）', () => {
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  // setInterval 里不该有 renderMine
  for (const m of dash.matchAll(/setInterval\(([^)]*)/g)) {
    assert.ok(!/renderMine/.test(m[1]),
      '用 setInterval 轮询扫目录 ⟹ 一直占着 IO（Steam 那个目录 639MB）。'
      + '该用事件驱动：切页签 + 焦点回来');
  }
});


// ⚠️ 壁纸列表只能有一份。
//
// 用户报（2026-07-31）：「我的壁纸这里，怎么又一个我的壁纸，有一个已经下载的壁纸，
// 这不是重复了吗」。
//
// 根因是我把四块从「创意工坊」搬到「我的壁纸」时**没审重复** ——
// `#ws-local`（旧的"已下载"列表）和 `#mine-grid`（新的"我的壁纸"）
// 调的是同一个 `workshopLocal()`、显示同一批数据。
// 搬之前它们在两个页签里，各自看起来都合理。**搬动之后要重新审。**
check('壁纸列表只有一份（搬动区块后要审重复）', () => {
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  // 旧的那份彻底没了
  assert.ok(!codeOnly(dash).includes('renderLocal'),
    'renderLocal 还在 —— 它和 renderMine 显示同一批数据（都调 workshopLocal）');
  assert.ok(!/id="ws-local"/.test(html),
    '#ws-local 容器还在 —— 那是重复的壁纸列表');
  // 调 workshopLocal 的地方只能有一个渲染入口
  const renderers = (codeOnly(dash).match(/window\.gw\.workshopLocal\(\)/g) || []).length;
  assert.ok(renderers <= 1,
    `有 ${renderers} 处调 workshopLocal() ⟹ 大概又出现了第二份列表`);
});

// ⚠️ 打开目录只有一个入口层级：存储目录那块，不在每张卡片上。
check('打开目录的入口在「存储目录」，不在每张卡片上', () => {
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  assert.match(dash, /revealWallpaperDir/, '没有打开目录的入口了');
  // 卡片构造函数里不该有
  const i = dash.indexOf('function workshopCard');
  const card = dash.slice(i, dash.indexOf('\n}', i));
  assert.ok(!/revealWallpaperDir/.test(card),
    '卡片上又加了「打开目录」—— 用户明确否掉过：「不是每个壁纸都要显示一下目录的」。'
    + '一个入口就够，N 张卡片 N 个按钮只是把一次操作重复 N 遍');
});


console.log('\n  condition 的接线（决定用户找不找到属性）');

// ⚠️ 用户报「没有看到你说的这些属性」，而根因是 condition 完全没实现 ——
// 165 个控件全显示、13 组重名（PWCircle 和 PWLine 各有一套同名的），
// 属性在但埋在一堆同名项里。
//
// ⟹ 这条守整条链：求值在 we-host（单一来源）→ 主进程调它 → 面板按结果过滤。
check('condition 从 we-host 一路接到面板', () => {
  const host = fs.readFileSync(path.join(__dirname, '..', 'src', 'we-host.js'), 'utf8');
  assert.match(host, /function evalCondition/, 'we-host 没有 condition 求值');

  const main = codeOnly(mainSrc);
  assert.match(main, /WE\.evalCondition/,
    '主进程没调 evalCondition ⟹ 控件全部显示，用户在 13 组重名里找不到属性');
  assert.match(main, /visible:/, 'we-controls 载荷里没有 visible 标记');

  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  assert.match(dash, /c\.visible !== false/,
    '面板没按 visible 过滤 ⟹ 主进程算了但没人用');
  // ⚠️ 面板不许自己重写一份求值 —— 那是第二份知识（本项目栽过两次）
  assert.ok(!/function evalCondition/.test(dash),
    '面板里重写了一份 condition 求值 —— 那是第二份知识，会和 we-host 漂');
});

// ⚠️ 改一个属性可能让别的控件出现/消失。
check('改属性后重渲染控件（condition 依赖别的属性值）', () => {
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  const i = dash.indexOf('function renderWEControls');
  const fn = dash.slice(i, dash.indexOf('\n}', i));
  // bool 的 onchange 里要重渲染 —— visual_audio_model 那类开关一改，整段控件都要换
  assert.match(fn, /renderWEControls\(\)/,
    '改属性后不重渲染 ⟹ 把「可视化音频模板」从圆环切到直线，控件列表不会跟着换');
});

// ⚠️ 分组标题要渲染出来，否则 67 个控件仍然是一片平铺。
check('分组标题渲染出来（project.json 用 text 项分段）', () => {
  const host = fs.readFileSync(path.join(__dirname, '..', 'src', 'we-host.js'), 'utf8');
  assert.match(host, /type: 'group'/,
    'text 项没做成分组标题 —— 作者用它们分段'
    + '（「----------完美壁纸圆环(PWCircle)----------」）');
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  assert.match(dash, /'group'/, '面板没渲染分组标题');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  assert.match(html, /\.we-group/, '分组标题没有样式 ⟹ 和普通控件混在一起看不出分段');
});


// ⚠️ 三个发帧的音源都要上报频谱，否则面板那行是**上一个音源的残留**。
//
// 用户实测撞到（2026-07-31）：他切到「单段扫描」，状态行说"只有第 40 段有值(0.8)"，
// 而下面「实际频谱」显示 `[0]0.148 [5]0.098 [10]0.147 …`（真音频的形状）
// ⟹ **两行自相矛盾**，他有理由以为"两个音源同时在发帧"。
//
// 真相：那一行压根没更新 —— 我只在真采集路径里调了上报。
// ⟹ 那正是「过期显示比没有显示更糟」，而我在同一个功能上犯了两次
//（上次是属性发送状态停在"正在发"）。
check('三个音源都上报频谱（否则面板显示上一个音源的残留）', () => {
  const src = codeOnly(mainSrc);
  assert.match(src, /function reportAudioFrame/,
    '频谱上报没抽成函数 ⟹ 只有一条路径会发，别的音源切过去后面板不更新');
  // ⚠️ 这条断言改了。原来要求"3 处调用"，而现在上报**收进了闸门**
  //（`sendAudioFrame` 里统一调）—— 那是更好的结构：
  // 三条路径走同一个出口，上报和发送不可能不一致。
  //
  // ⟹ 现在验的是"上报在闸门里"，而不是"有几处调用"。
  const gate = src.indexOf('function sendAudioFrame');
  assert.ok(gate > 0, '没有闸门函数');
  const gateFn = src.slice(gate, src.indexOf('\nfunction ', gate + 10));
  assert.match(gateFn, /reportAudioFrame/,
    '闸门里不上报 ⟹ 某条路径发了帧但面板不知道，那行就停在上一个音源的值');
  // 必须带 source，否则"没更新"看不出来
  assert.match(src, /source: source \|\|/,
    '上报没带 source ⟹ 面板不知道那行是哪个音源的数据，'
    + '而"没更新"就变成了看不见的错误');

  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  assert.match(dash, /frame\.source/,
    '面板没显示音源来源 ⟹ 两行自相矛盾时用户无从判断哪行是旧的');
});


console.log('\n  音频帧的单一出口（两个源同时发过一整轮）');

// ⚠️⚠️ 用户实测烧掉一整轮：切到「单段扫描」后画面上仍有一堆柱子，
// 而面板那行在两个值之间**跳**：
//
//   实际频谱（**全系统**）最大 2 ⚠️顶天了   ← 真采集在报
//   实际频谱（**单段扫描**）[119] 0.8        ← 扫描在报
//
// ⟹ 两个源同时在发帧。真采集的 helper 被 kill 了，但
//   ① kill 是异步的，缓冲区里的数据仍会触发 stdout 回调
//   ② `pushWEAudio` **压根不检查当前音源** —— helper 吐什么它就发
//
// ⟹ 那就是"好多柱子"：真音频的几十个非零段 + 扫描的一段，全在画。
//
// 根本问题是**没有单一出口**：三条路径各自 `send('we-audio')`，
// 而"当前该由谁发"没人管。
check('发音频帧只有一个出口（sendAudioFrame）', () => {
  const src = codeOnly(mainSrc);
  const sends = [...src.matchAll(/webContents\.send\('we-audio'/g)];
  assert.strictEqual(sends.length, 1,
    `有 ${sends.length} 处直接发 we-audio ⟹ "当前该由谁发"没人管，`
    + '切音源后旧的还在发（用户实测：两个源同时画，柱子莫名其妙地多）');
  assert.match(src, /function sendAudioFrame/, '没有单一出口函数');
});

check('闸门检查 owner 和当前音源一致', () => {
  const src = codeOnly(mainSrc);
  const i = src.indexOf('function sendAudioFrame');
  const fn = src.slice(i, src.indexOf('\nfunction ', i + 10));
  assert.match(fn, /config\.we\.audioSource/,
    '闸门不看当前音源 ⟹ 等于没有闸门');
  // 真采集有两个合法音源（system/netease），要都认
  assert.match(fn, /'system'/, "闸门没认 'system'");
  assert.match(fn, /'netease'/, "闸门没认 'netease' ⟹ 只抓网易云时帧会被全丢");
  // ⚠️ 丢帧要报出来，否则"切了但旧的还在发"又变成静默问题
  assert.match(fn, /console\.warn/,
    '丢帧时不报 ⟹ 那正是这次烧掉一整轮的原因（画面上表现为柱子莫名其妙地多）');
});

check('三条发帧路径都走闸门', () => {
  const src = codeOnly(mainSrc);
  for (const owner of ["'capture'", "'sweep'", "'synth'"]) {
    assert.ok(src.includes(`sendAudioFrame(frame, ${owner})`)
      || src.includes(`sendAudioFrame(result.data, ${owner})`),
    `${owner} 那条路径没走闸门 ⟹ 它切走之后还会继续发`);
  }
});


// ⚠️ "定时器在跑"不等于"它的帧被采纳"。
//
// 用户实测三轮都被这里误导：扫描状态行说"第 70 段"（定时器在跑），
// 而画面和频谱行都是真采集的（它的帧被闸门丢了）。
// ⟹ 状态行说"扫描在工作"，而它一帧都没发出去。
check('扫描状态只在帧真的发出去时才说"在工作"', () => {
  const src = codeOnly(mainSrc);
  const i = src.indexOf('function startSweepAudio');
  const fn = src.slice(i, src.indexOf('\nfunction ', i + 10));
  assert.match(fn, /const sent = sendAudioFrame/,
    '状态行不看发送结果 ⟹ 帧被闸门丢了它照样说"在工作"（用户被误导三轮）');
  assert.match(fn, /扫描的帧被丢掉了|被丢掉/,
    '帧被丢时没有专门的提示 ⟹ 用户看到的是"一切正常"');
});

// ⚠️ 只在某个配置下才该跑的定时器，自己检查那个配置。
check('两个测试音定时器自己检查配置（不依赖外部清理）', () => {
  const src = codeOnly(mainSrc);
  for (const [name, want] of [['startSweepAudio', 'sweep'], ['startSynthAudio', 'synth']]) {
    const i = src.indexOf(`function ${name}`);
    assert.ok(i > 0, `找不到 ${name}`);
    const fn = src.slice(i, src.indexOf('\nfunction ', i + 10));
    assert.ok(fn.includes(`!== '${want}'`),
      `${name} 的定时器不检查 config.we.audioSource ⟹ 清理逻辑漏一条路径`
      + '它就会一直跑（用户实测撞到：扫描定时器在音源已切走后还在发帧）');
    assert.match(fn, /stop\w+Audio\(\)/, `${name} 自检失败时不自己停`);
  }
});

// ⚠️ 闸门丢帧要报到**面板**，不只是 console —— 打包版没有终端。
check('闸门丢帧报到面板（打包版看不到 console）', () => {
  const src = codeOnly(mainSrc);
  const i = src.indexOf('function sendAudioFrame');
  const fn = src.slice(i, src.indexOf('\nfunction ', i + 10));
  assert.match(fn, /broadcast\('we-audio-drop'/,
    '丢帧只写 console ⟹ 打包版里谁都看不到，而"两个音源同时发"就成了看不见的错误'
    + '（用户为它烧掉三轮）');
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  assert.match(dash, /onWeAudioDrop/, '面板没订阅丢帧报告');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  assert.match(preload, /onWeAudioDrop/, 'preload 没暴露丢帧通道');
});


// ⚠️ 诊断工具自己不能有 bug —— 那比没有诊断更糟，它让人怀疑对的结论。
//
// 用户为这两个缺陷又烧掉两轮：
check('扫描以正常帧率连续发（发太稀画面会静止）', () => {
  const src = codeOnly(mainSrc);
  assert.match(src, /SWEEP_FPS/,
    '扫描没有帧率常量 —— 每 2 秒发一帧时 PWCircle 只在收到帧时重绘'
    + '（它没有 requestAnimationFrame 循环）⟹ 画面在两帧之间**完全静止**，'
    + '而静止画面里留着的是上一个音源的残影。用户看到"很多柱子"就是那个残影');
  const m = src.match(/const SWEEP_FPS = (\d+)/);
  assert.ok(m && Number(m[1]) >= 20,
    `扫描帧率 ${m && m[1]} 太低 —— 低于 20fps 画面会看起来是静止的`);
  // 换段要按时间算，不能按帧数
  const i = src.indexOf('function startSweepAudio');
  const fn = src.slice(i, src.indexOf('\nfunction ', i + 10));
  assert.match(fn, /SWEEP_FPS\)\s*%|\/ \(2 \* SWEEP_FPS\)/,
    '换段按帧数算 ⟹ "多久换一次"会随帧率漂');
});

// ⚠️ 固定采样点在诊断**单段**信号时必然漏掉它。
check('频谱上报带峰值段（固定采样点会漏掉单段信号）', () => {
  const src = codeOnly(mainSrc);
  assert.match(src, /peakAt/,
    '上报没带峰值段 ⟹ 扫描到第 30 段时，固定采样点 [0,10,20,40,60,…] 里没有 30，'
    + '面板显示全 0 —— 而值确实存在。那让"数据对的"看起来像"数据全 0"');
  const i = src.indexOf('samples:');
  const block = src.slice(i, i + 600);
  assert.match(block, /includes\(peak\)/,
    '采样点里没有保证包含峰值段 ⟹ 单段信号可能一个采样点都命中不到');

  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  assert.match(dash, /frame\.peakAt/,
    '面板没显示峰值段 —— 单段扫描时那个数该跟着扫描段号走，'
    + '那是"扫描真的生效了"的直接证据');
});


// ⚠️ 面板要**直接算出参数该调多少**，而不是只报数字。
//
// 我为音频幅度改了五轮，每轮都是"我猜一个值 → 用户打包 → 看效果 → 再猜"。
// 而那本来是**算术**：目标峰值 1.1（WE 契约），实测峰值在手上
// ⟹ 新值 = 当前值 × 1.1 / 实测峰值。
check('面板算出 NORMALIZE 该调多少（不是让用户陪着试）', () => {
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  const i = dash.indexOf('function renderAudioFrame');
  const fn = dash.slice(i, dash.indexOf('\n}', i));
  // ⚠️ 这条断言改了。原来要求面板算出「NORMALIZE 该乘多少」，
  // 而那个参数**已经不存在** —— 音频算法整套抄自 WE，没有我调的参数了。
  // ⟹ 现在验的是"报形状对不对"，而不是"报该调多少"。
  assert.match(fn, /WE 的频段加权|像 WE 的输出/,
    '面板不判断形状 ⟹ "低频比高频大 4 倍"这类症状看不出来，'
    + '而那正是加权没生效的信号');
  assert.match(fn, /lowMean > frame\.highMean/,
    '没有低高频对比 —— 那是"加权生效了没有"最直接的判据');
  // ⚠️ 只对真采集给建议：测试音的幅度是我们自己定的，没有调的意义
  assert.match(fn, /'system'|'netease'/,
    '对测试音也给调参建议 —— 那些幅度是我们自己写死的，调它没意义');
});


// ⚠️ 「很多个和周围高度差很大的柱子」要能量出来。
//
// 用户报那是**共性问题**（两个渲染代码完全不同的壁纸都有）
// ⟹ 只能来自相同的输入：我们发的那 128 段。
//
// ⚠️ 而我为这个现象猜过两次（跳跃采样漏掉一半 bin、大量段撞 min(1.0) 天花板），
// **两次都被数据推翻**。⟹ 先量出来，别继续推理。
check('频谱上报带尖刺量化（相邻段跳变）', () => {
  const src = codeOnly(mainSrc);
  assert.match(src, /spikes:/,
    '没报尖刺 ⟹ "很多个高度差很大的柱子"只能靠用户描述，'
    + '而我为它猜了两次都错');
  assert.match(src, /avgJump/, '没报平均跳变 —— 那是整体连续性的判据');
  // ⚠️⚠️ **锚点撞名**：我后来在 `export-diagnostics` 的报告里也加了一个
  // `spikes:` 字段（统计 60 帧原始帧里的孤峰），而它在文件里**更靠前**
  // ⟹ `indexOf('spikes:')` 找到的是**那一个**，切片里当然没有 `prev:`
  // ⟹ **在正确的代码上报红**。
  //
  // ⚠️ 这不是"切片太短"（那是我这一轮栽过四次的形状，我第一反应又是它）——
  // 是**同名字段出现在两处**。加长切片治不了，`indexOf` 还是找错那个。
  // ⟹ 教训：位置锚要锚在**唯一**的东西上。这里用 `reportAudioFrame` 这个
  //    函数名定位，再在函数体内找 —— 函数名是唯一的。
  const fnAt = src.indexOf('function reportAudioFrame');
  assert.ok(fnAt >= 0, '找不到 reportAudioFrame —— 改名了？');
  const fnEnd = src.indexOf('\nfunction ', fnAt + 10);
  const block = src.slice(fnAt, fnEnd > 0 ? fnEnd : undefined);
  assert.match(block, /spikes:/, 'reportAudioFrame 里没有 spikes');
  // 要报前后值 —— 分辨"这段太高"和"旁边太低"
  assert.match(block, /prev:/,
    '只报跳变大小不报前后值 ⟹ 分不清是"这段异常高"还是"旁边异常低"');

  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  assert.match(dash, /frame\.spikes/, '面板没显示尖刺');
});


// ⚠️ 音频的日志要在**音频旁边**。
//
// 用户问「这个在哪里」，而我给的位置是错的（我说"创意工坊的诊断那块"，
// 实际上 #log 在**手势录制**页签底部）。
// ⟹ 音频的输出（FFT 自检、swiftc 编译失败、丢帧）跑到手势页签里去了。
check('音频日志在音源旁边（不是手势页签）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  assert.ok(html.includes('id="audio-log"'), '音源旁边没有日志区');
  // ⚠️⚠️ 这条断言的**本意是"日志和音源在一起"**，而不是"在某个页签里"。
  // 原来写的是"必须在 tab-mine 里"，而 0.9.51 音源和日志**一起**搬进了
  // 设置弹窗的开发者模块 ⟹ 断言在正确代码上报红。
  // ⟹ 改成直接查它想查的那件事：两者在同一个容器里、而且日志紧跟音源。
  //   （判据：断言要表达**意图**，不是当时那个位置。）
  const srcAt = html.indexOf('<h3>音源</h3>');
  const logAt = html.indexOf('id="audio-log"');
  assert.ok(srcAt > 0 && logAt > srcAt,
    '#audio-log 不在「音源」那块后面 —— 音源在哪，日志就该在哪');
  // 中间不许插进另一个 <h3>（那说明日志被推到别的小节里去了）
  const between = html.slice(srcAt + 12, logAt);
  assert.ok(!/<h3>/.test(between),
    '「音源」和 #audio-log 之间插进了另一个小节 ⟹ 日志跑到别处了');

  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  const i = dash.indexOf('function logLine');
  const fn = dash.slice(i, dash.indexOf('\n}', i));
  assert.match(fn, /audio-log/, 'logLine 不写 audio-log ⟹ 那一格永远空的');
  assert.match(fn, /'audio'|'we'|'wall'/,
    'logLine 不按来源过滤 ⟹ 手势的日志也会灌进音频那格');
});

// ⚠️ 自检只在 helper 启动时跑一次 —— 面板后打开就错过了。
check('面板打开时补发最后一次 FFT 自检', () => {
  const main = codeOnly(mainSrc);
  assert.match(main, /lastSelfTest/,
    '不记住自检结果 ⟹ 面板后打开就永远看不到那一行（用户实测撞到）');
  assert.match(main, /we-selftest/, '没有拿自检结果的 IPC');
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  assert.match(dash, /weSelfTest\(\)/, '面板不主动拿自检结果');
});


// ⚠️⚠️ **固定长度的切片是个会漂的锚点。** 这一轮我栽过四次。
//
// 形状：`src.slice(i, i + 2000)` 然后在里面 match 某个东西。
// 而我往那个函数里加代码之后，断言要找的东西被推到切片之外
// ⟹ **在正确的代码上报红**。
//
// 四次分别是：will-quit 块（300 字符）/ renderMineDirs（2600）/
// onSelfTest 回调（900）/ selfTestFFT（2000 和 2500 各一次）。
//
// ⟹ 正确做法：切到**结构边界**（下一个 function / 块尾的 `\n}`），
// 或者干脆在整个文件里 match（如果那个字符串足够独特）。
check('测试里不用固定长度的切片（那个锚点会漂）', () => {
  const testDir = __dirname;
  const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.js'));
  const bad = [];
  for (const file of files) {
    const src = fs.readFileSync(path.join(testDir, file), 'utf8');
    const lines = src.split('\n');
    for (const [n, line] of lines.entries()) {
      // 注释里的例子不算
      if (line.trim().startsWith('//')) continue;
      // `slice(x, x + 数字)` 这个形状
      if (/\.slice\([^,)]+,\s*\w+\s*\+\s*\d{2,}\)/.test(line)) {
        bad.push(`${file}:${n + 1}`);
      }
    }
  }
  // ⚠️ 存量有 22 处（这个形状在整个文件里都是），全改一遍风险比收益大 ——
  // 改 22 个切片会引入新的锚点错误，而它们大多数没实际出问题。
  //
  // ⟹ 守卫**只挡增长**：记下当前基线，多出来的报红。
  // 那样新写的测试会被逼着用结构边界，而存量慢慢改（碰到哪个改哪个）。
  const BASELINE = 22;
  assert.ok(bad.length <= BASELINE,
    `固定长度切片从 ${BASELINE} 处涨到 ${bad.length} 处：`
    + `${bad.slice(BASELINE).join(', ')}\n`
    + '    ⟹ 往被切的函数里加代码就会让断言在正确代码上报红（本轮栽过四次）。\n'
    + '    改成切到结构边界：indexOf(\'\\nfunc \', i) / indexOf(\'\\n}\', i)');
});


// ⚠️⚠️⚠️ **我给用户的每条 `npm run X` 都必须在 package.json 里存在。**
//
// 用户 2026-08-01 跑我给的命令：
//   npm run build:mac  ⟹  `npm error Missing script: "build:mac"`
// 真名是 `dist:mac`。他要打包验一个修复，卡在第一条命令上，一轮往返白烧。
//
// ⚠️ 这个形状在本项目已经不是第一次了 —— 我给过的命令里错过路径
//（`/home/moon/...` vs 用户的 `~/workspace/AirCursor`）、错过 dmg 文件名。
// 共同点：**命令里的每个值我都是从自己环境或记忆里取的，没有一个是查出来的。**
//
// ⟹ 文档里写下的 `npm run X` 就是一份契约，让测试来核。
check('文档里的 npm run 命令都真的存在', () => {
  const root = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const have = new Set(Object.keys(root.scripts || {}));
  const docs = ['MODULES.md', 'TO-LOCAL.md', 'TO-LOCAL-RESUME.md'];
  const missing = [];
  for (const doc of docs) {
    const f = path.join(__dirname, '..', doc);
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/npm run ([a-z][\w:-]*)/g)) {
      if (!have.has(m[1])) missing.push(`${doc}: npm run ${m[1]}`);
    }
  }
  assert.strictEqual(missing.length, 0,
    `文档里的这些命令在 package.json 里不存在：\n    ${missing.join('\n    ')}\n`
    + `    可用的是：${[...have].join(' ')}\n`
    + '    ⟹ 用户照文档跑会撞 `Missing script`，而那是他验修复的第一条命令');
});

// ⚠️ 打包命令有两个名字（`dist:mac` 和 `build:mac`）—— 那是故意的。
// 我在对话里给过 `build:mac`，而真名是 `dist:mac`；加别名比让用户记哪个对更可靠。
check('打包命令 dist:mac 和 build:mac 都在（我给过两个名字）', () => {
  const root = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  for (const name of ['dist:mac', 'build:mac']) {
    assert.ok(root.scripts && root.scripts[name],
      `package.json 里没有 \`${name}\` —— 我在对话里给过这个名字，`
      + '用户照着跑会撞 Missing script');
  }
  assert.strictEqual(root.scripts['dist:mac'], root.scripts['build:mac'],
    '两个名字指向不同的东西 ⟹ 用户跑哪个得到的结果不一样，那比只有一个名字更坏');
});

// ⚠️⚠️⚠️ **工坊下载必须复制进统一的壁纸目录。**
//
// 用户 2026-08-01：「现在的壁纸应该统一都是默认用户下面的
// Documents/GestureWall/Wallpapers（不同用户自适应）…
// 创意工坊的壁纸下载，和默认加载都应该是这样」
//
// ⚠️ 而 steamcmd 的下载位置**不可配**（它自己定的）⟹ 只能下载后复制。
// 不复制的两个后果：①「我的壁纸」列表里看不到刚下载的
// ②用户从 Finder 打开壁纸目录找不到自己下的（Steam 那个路径在「资源库」下，
//   Finder 默认不显示）
// ⚠️ 这条测试原名「工坊下载后**复制**到统一壁纸目录」—— 0.9.29 改成移动了。
// 一个名字说着旧行为的绿色测试是文档级的错：读的人会照它理解代码。
check('工坊下载后移动到统一壁纸目录（不留两份）', () => {
  const src = codeOnly(mainSrc);
  assert.match(src, /function importToOurDir/,
    '没有把工坊下载搬进我们目录的函数 ⟹ 用户在「我的壁纸」里看不到刚下载的');
  // 必须真的被调用 —— 定义了不用等于没有（这个项目栽过好几次）
  const at = src.indexOf("logEvent('workshop', `下载成功");
  assert.ok(at >= 0, '找不到下载成功那段');
  const block = src.slice(at, src.indexOf('setWEWallpaper', at) + 40);
  assert.match(block, /importToOurDir/,
    'importToOurDir 定义了但下载成功后没调用 ⟹ 壁纸还留在 Steam 目录');
  // ⚠️⚠️ **这条断言反过来了（0.9.29）—— 前提变了，不是摇摆。**
  //
  // 0.9.24 我要求 `cpSync`（复制），理由是"移走会破坏 steamcmd 的账本"。
  // 而用户 0.9.28 实测后说：「那不就是自动两份，太离谱了」——**他说得对**：
  //   ① 磁盘占用翻倍（壁纸可以到几百 MB）
  //   ② 面板上要解释"这份是原件、那份是副本"，本身就是设计失败的信号
  //   ③ 用户删了我们那份，Steam 那份还在 ⟹ 下次扫描它又冒出来
  //
  // ⟹ 改成移动，而"下次下载被跳过"那个风险用**下载前清 manifest** 兜。
  // ⟹ 于是这条守卫从"禁止移动"翻成"**移动 + 必须有清 manifest 的兜底**"。
  assert.match(src, /fs\.renameSync/,
    '还在用复制 ⟹ 用户目录和 Steam 目录各一份（用户 0.9.28：「太离谱了」）');
  // ⚠️ 而移动**必须**配清 manifest —— 否则下次下载 steamcmd 说"已是最新"
  // 然后什么都不做，而它的退出码是 0、日志里有 Success ⟹ **静默失败**
  // ⚠️ 用 `\b…\(` 锚住**定义**这个形状 —— 我第一版写 `/function clearWorkshopManifest/`
  // 而把定义改名成 `…X` 后，**调用点**的 `clearWorkshopManifest()` 仍然匹配
  // ⟹ 守卫绿着，而代码其实是坏的（调了不存在的函数）。
  // ⟹ 教训：查"这个函数存在吗"要锚定义的完整形状，不是名字的子串。
  assert.match(src, /function clearWorkshopManifest\s*\(\s*\)/,
    '移走了内容却没有清 steamcmd 账本的函数 ⟹ 下次下载会被静默跳过'
    + '（退出码 0 + 日志有 Success，而我们目录里没有新东西）');
  // 而且要在**下载前**调
  const dlAt = src.indexOf('const args = Workshop.downloadArgs');
  assert.ok(dlAt > 0, '找不到下载入口');
  const before = src.slice(Math.max(0, dlAt - 600), dlAt);
  assert.match(before, /clearWorkshopManifest\(\)/,
    'clearWorkshopManifest 定义了但没在下载前调用 ⟹ 等于没有');
  // ⚠️ 跨卷（EXDEV）要退回复制 + 删源 —— 用户可能把 Steam 装在外置盘上
  assert.match(src, /EXDEV/,
    '没处理跨卷的 EXDEV ⟹ Steam 装在外置盘时 renameSync 直接失败'
    + '（而那会退到"降级：仍从 Steam 目录装载"，用户又变成两份）');
  // ⚠️ 复制失败要**降级不报错**：文件已经在 Steam 目录里，装载仍然能看到画面
  const fnAt = src.indexOf('function importToOurDir');
  const fn = src.slice(fnAt, src.indexOf('\nfunction ', fnAt + 10));
  assert.match(fn, /catch/,
    '复制没有 try/catch ⟹ 磁盘满/权限问题会让整个下载算失败，'
    + '而文件其实已经下好了');
  // ⚠️ 而降级必须**说出来** —— 否则"为什么我的壁纸里没有"变成鬼故事
  assert.match(block, /没能复制到我的壁纸目录|放入我的壁纸失败/,
    '复制失败时没告诉用户 ⟹ 他会以为下载坏了，或者以为列表有 bug');
});

// ⚠️⚠️⚠️ **目录只显示两行：我们的 + Steam 实际那个。**
//
// 用户 2026-08-01：
//   「不用每一张壁纸都这样显示，就这两个地址就行
//     我的壁纸目录：/Users/moon/Documents/GestureWall/Wallpapers
//     /Users/moon/Library/Application Support/Steam/steamapps/workshop/content/」
//
// 两个问题：
// ① `STEAM_ROOTS` 有**三个候选**（`~/Library/Application Support/Steam`、
//    `~/steamcmd`、`~/Steam`）—— steamcmd 装法不同数据目录不同，我们只能逐个找。
//    但面板列三行没意义：两个必然不存在，而"这个目录不存在（正常）"是纯噪声。
// ② 我们自己的目录**同时**出现在最上面那行和"自动扫描"列表里 ⟹ 重复。
check('目录列表只显示存在的 Steam 目录，且不重复列我们自己的', () => {
  const src = codeOnly(mainSrc);
  // ⚠️ 我们的目录不能被标成 auto —— 面板最上面已经单独显示它了
  assert.match(src, /ours: root === ourDir/,
    '没标记"这是我们自己的目录" ⟹ 它会被当成"自动扫描的目录"再列一遍');
  assert.match(src, /auto: root !== ourDir/,
    'auto 的判据没排除我们自己的目录 ⟹ 重复显示');
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  // ⚠️⚠️ **判据从"只显示存在的"收紧成"只显示有残留的"（0.9.30）。**
  //
  // 用户 2026-08-01 让删的正是"正常状态"那些行：
  //   「steamcmd 的临时下载目录（…这里通常是空的）：
  //     …/431960 空的（正常 —— 下载完会移到上面那个目录）[打开]」
  //
  // 0.9.29 起下载会**移动**到我们目录 + 清空壳 ⟹ 那个目录**空着才是常态**
  // ⟹ 显示"空的（正常）"是纯噪声。而"没装 steamcmd"那行更没用
  //   （没装的人不会用工坊下载）。
  //
  // ⟹ **只有异常才显示**，而这里的异常只有一种：目录里还留着壁纸
  //   （= 上次搬运失败）⟹ 那时用户需要知道 + 需要那个搬运按钮。
  assert.match(dash, /autoAll\.filter\(\(x\) => x\.exists && x\.found\)/,
    '面板还在显示"正常状态"的 Steam 目录行 ⟹ 用户 2026-08-01 明确让删'
    + '（0.9.29 起那个目录空着才是常态，显示它是纯噪声）');
  assert.ok(!/没找到 steamcmd 的下载目录/.test(dash),
    '还有"没装 steamcmd"那行 —— 没装的人不会用工坊下载，那行只让面板变长');
  assert.ok(!/空的（正常/.test(dash),
    '还有"空的（正常）"那种文案 ⟹ 正常状态不该占一行');
  // ⚠️ 没加过自定义目录时那一整段（含两条约束）也不该显示
  assert.match(dash, /if \(!dirs\.length\) return;/,
    '没加自定义目录时还在显示"还没加自定义目录 + 两条约束" ⟹ '
    + '绝大多数人不需要自定义目录，常驻显示等于让每个人读一遍不相关的约束');
  // ⚠️ 而那两条约束**不能真的丢** —— 它们搬到了 `把壁纸放这里.txt`
  assert.match(src, /每个壁纸是一个【子目录】/,
    '两条约束从面板删了，但也没写进 把壁纸放这里.txt ⟹ 真的丢了信息。'
    + '"直接放一堆 mp4 认不出来"是用户真会撞到的');
  assert.match(src, /扫描上限：2 层深/, '扫描上限的说明丢了');
  // ⚠️ HTML 里那份写死的说明必须删掉 —— 它和 renderMineDirs 生成的内容重复
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  const htmlCode = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/最多扫 2 层深/.test(htmlCode),
    'dashboard.html 里还有那段写死的说明 ⟹ 和 JS 渲染的内容**重复显示**'
    + '（用户粘回来的截图里那两条约束出现了两遍）。'
    + '⚠️ 同一句说明同时存在于 HTML 和 JS 里，改一处不会让另一处消失');
});

// ⚠️⚠️⚠️ **存量的两份也要能清。**
//
// 0.9.24-0.9.28 用的是**复制** ⟹ 用户机器上已经有两份了，
// 而 0.9.29 改成移动**只对新下载生效** ⟹ 存量不会自己消失。
//
// 用户 2026-08-01：「那不就是自动两份，太离谱了」
// ⟹ 只改新下载不够，要给存量一条出路。
check('存量的 Steam 副本能一键搬走', () => {
  const src = codeOnly(mainSrc);
  assert.match(src, /function importExistingFromSteam\s*\(\s*\)/,
    '没有整理存量的函数 ⟹ 0.9.28 之前下载的壁纸永远是两份');
  assert.match(src, /ipcMain\.handle\('import-existing-from-steam'/,
    'IPC 没注册 ⟹ 面板调不到（这个项目栽过"写了函数但没接线"好几次）');
  // ⚠️ 我们目录已有同 ID 时**只删源，不覆盖** —— 用户可能改过里面的属性/文件
  assert.match(src, /removed-duplicate/,
    '没有"我们已有这个 ID ⟹ 只删源"的分支 ⟹ 会覆盖用户改过的那份');
  // ⚠️ 搬完要清账本（内容不在了，账本还记着"已下载"会让下次下载被跳过）
  const fnAt = src.indexOf('function importExistingFromSteam');
  const fn = src.slice(fnAt, src.indexOf('\nipcMain', fnAt));
  assert.match(fn, /clearWorkshopManifest\(\)/,
    '整理存量后没清 steamcmd 账本 ⟹ 下次下载会被静默跳过');
  // 面板要有按钮，而且只在**有残留时**出现
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  assert.match(dash, /importExistingFromSteam/, '面板没有触发入口');
  assert.match(dash, /if \(item\.exists && item\.found\) \{[\s\S]{0,400}?搬到我的壁纸目录/,
    '「搬到我的壁纸目录」按钮不是只在有残留时出现 ⟹ 目录空着也显示一个没用的按钮');
  // ⚠️ 搬完必须刷新列表 —— 否则用户看到按钮变字但路径行没变，以为没生效
  assert.match(dash, /await renderMine\(\)/,
    '搬完没刷新列表 ⟹ "做了但用户看不到"（这个项目栽过六次）');
});

// ⚠️⚠️⚠️ **单一路径来源，而且可改。**
//
// 用户 2026-08-01：
//   「这个刷新和加一个壁纸目录应该和我们的『我的壁纸目录：…打开』功能合并，
//     就是打开，然后你也可以添加新的目录然后我的壁纸目录就自动更新，
//     **反正只有一个路径来源，只是我允许你更改**」
//
// 改之前是**两个模型并存**：固定主目录 + 可加的 `libraryDirs` 列表
// ⟹ 面板上三种东西（主目录 / Steam 目录 / 自定义目录列表）
// ⟹ 用户要问"我的壁纸到底在哪"、"加的目录和上面那个什么关系"。
check('壁纸目录是单一来源，操作都在那一行', () => {
  const src = codeOnly(mainSrc);
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');

  // ⚠️ 「换目录」必须改 wallpaperDir（那唯一的一个），不是往列表里加
  const addAt = src.indexOf("ipcMain.handle('workshop-add-dir'");
  assert.ok(addAt > 0, '找不到换目录的 IPC');
  const addFn = src.slice(addAt, src.indexOf('\nipcMain', addAt + 10));
  assert.match(addFn, /config\.we\.wallpaperDir = dir/,
    '「换目录」还在往 libraryDirs 里加 ⟹ 又变成两个路径来源');
  assert.ok(!/libraryDirs.*push|push.*libraryDirs/.test(addFn),
    '「换目录」仍在 push 到 libraryDirs');

  // ⚠️ 「恢复默认」必须有 —— 默认值不写进 config（那样换用户自适应），
  // 所以用户改错了之后不知道该填什么路径回去
  assert.match(src, /ipcMain\.handle\('workshop-reset-dir'/,
    '没有恢复默认的通道 ⟹ 用户改错目录后回不去'
    + '（默认值不写进 config，他不知道该填什么）');
  assert.match(dash, /resetWallpaperDir/, '面板没有恢复默认的入口');

  // ⚠️ 那三个操作必须在目录那一行里（不是散在别处）
  const j = dash.indexOf('function renderMineDirs');
  const fn = dash.slice(j, dash.indexOf('\nfunction ', j + 10));
  for (const [needle, why] of [
    [/revealWallpaperDir/, '打开'],
    [/workshopAddDir/, '换目录'],
    [/renderMine\(\)/, '刷新'],
  ]) {
    assert.match(fn, needle, `目录那一行里没有「${why}」操作`);
  }

  // ⚠️ HTML 里那两个独立按钮必须删掉 —— 否则又是两处入口
  assert.ok(!/id="mine-refresh"/.test(html),
    'HTML 里还有独立的「刷新」按钮 ⟹ 和目录行里那个重复');
  assert.ok(!/id="mine-add-dir"/.test(html),
    'HTML 里还有独立的「加一个壁纸目录…」按钮 ⟹ 那是旧模型');

  // ⚠️ 而删了 HTML 就必须删对应的 getElementById —— 否则 null.onclick 抛异常
  // ⟹ 那一行之后所有初始化都不跑（这个项目为同一形状烧过一轮）
  assert.ok(!/getElementById\('mine-refresh'\)/.test(dash),
    "HTML 里删了按钮但 JS 还在 getElementById('mine-refresh') ⟹ "
    + 'null.onclick 抛 TypeError ⟹ 后面所有初始化都不跑');
  assert.ok(!/getElementById\('mine-add-dir'\)/.test(dash),
    '同上（mine-add-dir）');

  // ⚠️ libraryDirs 只读不写：旧配置里可能还有值（要继续扫），但不再有写入路径
  assert.match(src, /\.\.\.\(config\.we\.libraryDirs \|\| \[\]\)/,
    '不再扫 libraryDirs ⟹ 旧配置里的目录会突然消失，用户的壁纸不见了');
});

// ⚠️⚠️⚠️ **「创意工坊」页签不重复壁纸的操作和能力说明。**
//
// 用户 2026-08-01 让删的三段：
//   ①「装载…**网页类**壁纸（project.json 里 type: "Web"）…
//      ⚠️ **scene / video 类不支持** —— 那要解 WE 的私有格式。」
//   ②「选择壁纸目录…」「卸载，回到三层景深」两个按钮
//   ③「未装载 —— 现在显示的是**三层景深壁纸**」
//
// ⚠️ ① **本身已经过期**：video 和 image/GIF 类早就支持了（真机验过 ——
// 龙猫视频壁纸正常播放、legacy 单文件走魔数嗅探造 project.json）
// ⟹ 那句话在劝用户别下他其实能用的东西。
// ⟹ **"不支持 X"这类说明会随功能推进过期，而它比没有说明更坏**（主动误导）。
//   能力矩阵只留在 MODULES.md 一处，UI 上不重复。
//
// ⚠️ ③ 「三层景深」是内部叫法（templates.js 里的"背景+主体+漂浮碎片"），
// 用户从没见过那个词 ⟹ 读到的是"现在显示的是某个我不知道的东西"。
check('创意工坊页签不重复能力说明，壁纸操作在「我的壁纸」', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  const htmlCode = html.replace(/<!--[\s\S]*?-->/g, '');
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));

  // ⚠️ 过期的能力说明不许在 UI 上
  assert.ok(!/scene \/ video 类不支持/.test(htmlCode),
    'UI 上还写着"scene / video 类不支持" —— **video 和 GIF 早就支持了**'
    + '（真机验过）⟹ 那句话在劝用户别下他其实能用的东西');
  assert.ok(!/type: "Web"/.test(htmlCode),
    'UI 上还在说"只支持 type: Web" ⟹ 同上，已过期');

  // ⚠️ 内部叫法不许出现在用户可见的文案里
  assert.ok(!/三层景深/.test(dash),
    'dashboard.js 里还有"三层景深" —— 那是内部对内置壁纸的叫法'
    + '（templates.js 的"背景+主体+漂浮碎片"），用户从没见过那个词');

  // ⚠️⚠️ **那两个按钮 0.9.37 删了** —— 用户 2026-08-01：
  //   「这两个不需要，我们已经有换目录的按钮了，这是冗余的操作」
  //
  // ⟹ 守卫从"必须能点到"翻成"**必须删干净 + 卸载要有别的入口**"。
  //
  // ①「装载别处的目录…」**确实冗余，还更差**：那条路装载的壁纸
  //   **不在网格里** ⟹ 用户看不到它、也没法切回来。
  //   而「换目录…」换完之后新目录里的壁纸会出现在网格里。
  //   ⟹ 删的是**整条链**（HTML + dashboard 绑定 + preload + IPC）——
  //     只删按钮的话剩下的是死代码，而死代码会让下一个人以为
  //     "功能还在只是入口丢了"，然后把入口加回来。
  assert.ok(!/id="we-pick"/.test(htmlCode), 'HTML 里还有「装载别处的目录」按钮');
  assert.ok(!/wePick/.test(dash), 'dashboard.js 里还有 wePick 调用');
  const pre = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8'));
  assert.ok(!/wePick/.test(pre), 'preload 里还有 wePick ⟹ 死代码');
  // ⚠️ 这条测试里读 main.js 的变量是 `mainSrc`（全局），不是 `src` ——
  // 我第一版写了 `src` ⟹ `ReferenceError: src is not defined`
  // ⟹ 而那不是"断言失败"，是**测试自己崩了**（错误信息完全不同方向）。
  assert.ok(!/'we-pick'/.test(codeOnly(mainSrc)),
    'main.js 里还有 we-pick 的 IPC ⟹ 死代码');

  // ②「卸载」**没有别的入口** ⟹ 不能直接删，搬到了网格里当前那张卡片上
  //   （点一个壁纸装载，点当前那个就取消）
  assert.ok(!/id="we-clear"/.test(htmlCode), 'HTML 里还有「卸载」按钮');
  // ⚠️⚠️ 「卸载」的入口改过两次，而**判据一直没变**：它必须存在且可发现。
  //
  //   0.9.36 之前  常驻按钮「卸载（回到内置壁纸）」
  //   0.9.37       点当前那张卡片（+ 卡片上一行「点击卸载」提示）
  //   0.9.38       **右键菜单**
  //
  // 0.9.37 那版的问题（用户 2026-08-01 指出）：那是**把一个动作藏在另一个
  // 动作里**（左键既装载又卸载，看 active 状态），而且要常驻一行提示才不隐藏
  // ⟹ 界面又吵了。
  //
  // ⟹ 右键菜单同时解决两件事：卸载不再藏在左键里、
  //    而「在 Finder 中打开」也不用常驻按钮（它 2026-07-31 因常驻太吵被删过）
  // ⟹ **判据：常驻的东西要少，而不是功能要少。**
  // ⚠️⚠️ 锚 `async function renderMine()` 的**完整函数头**，不是名字前缀。
  // 0.9.54 新加了 `renderMineSide(item)`，而它在文件里**更靠前**
  // ⟹ `indexOf('function renderMine')` 命中的是它，切出来 2116 字符里
  //   当然没有 showCardMenu ⟹ **在正确代码上报红**。
  // 锚点撞名第 7 次（前几次撞注释/字符串/别处同名调用/同类名另一条规则），
  // 这次撞的是**我自己新加的、名字以它为前缀的函数**。
  // ⟹ 判据再收紧：锚"函数声明的完整形状"（含 async / 参数列表）。
  const j2 = dash.indexOf('async function renderMine()');
  assert.ok(j2 > 0, '找不到 renderMine 的定义 ⟹ 下面那条断言失效');
  const mineFn = dash.slice(j2, dash.indexOf('\nfunction ', j2 + 10));
  assert.match(mineFn, /showCardMenu/,
    '卡片没有右键菜单 ⟹ 用户 2026-08-01 明确要求的形态'
    + '（「右键点击，一个选项是在资源管理器中打开，一个是卸载」）');

  // ⚠️⚠️ **「卸载（回到内置壁纸）」这个需求被用户否掉了**（0.9.42）：
  //   「应该是卸载，就是这个壁纸的文件直接删除，而不是什么应用这个壁纸，
  //     应用之后再来个什么退回内置壁纸，**我们的产品关闭了不就壁纸退出运行了**，
  //     这个逻辑没必要」
  //
  // **他说得对** —— 关掉应用壁纸就没了，「退回内置」是个没有价值的中间态。
  // ⟹ 菜单里换成「删除（移到废纸篓）」，那是文件管理而不是运行状态管理。
  //
  // ⚠️ 而 `weClear` 那条 IPC 保留 —— 删除时要先卸载（否则删完文件
  // 窗口还在渲染它，画面是"文件不在了但还在显示"，症状和时机脱节）。
  assert.match(mineFn, /移到废纸篓/,
    '右键菜单里没有「删除」⟹ 那是用户 0.9.42 明确要的功能');
  assert.ok(!/卸载（回到内置壁纸）/.test(mineFn),
    '菜单里还有「卸载（回到内置壁纸）」⟹ 用户明确说那个逻辑没必要');
  // ⚠️ 「在 Finder 中打开」也要在菜单里 —— 那是它 0.9.38 的新家
  assert.match(mineFn, /Finder 中打开/,
    '右键菜单里没有「在 Finder 中打开」⟹ 用户明确提到的两项之一');
  // ⚠️ 而左键**不能**再兼任卸载（那是 0.9.37 被否掉的设计）
  assert.ok(!/if \(item\.active\) \{\s*await window\.gw\.weClear/.test(mineFn),
    '左键点当前卡片还在卸载 ⟹ 那是"把一个动作藏在另一个动作里"，'
    + '用户 2026-08-01 否掉了这个设计');
});

// ⚠️⚠️⚠️ **「正在共享屏幕」现在有出路了 —— 守卫要跟着翻。**
//
// 用户 2026-08-01 的两句话推动了这整条：
//   ①「为什么这个壁纸运行的时候会显示 GestureWall 正在共享屏幕啊」
//   ②「真的吗，必须要这个屏幕录制？我之前的手势那里我记得也操作桌面了，
//      就没有用到这个什么屏幕共享啊」—— **他是对的**
//
// 我原来答「CoreAudio 的进程 tap 同样要屏幕录制权限」——
// **那句话是凭印象说的、从没验过**，而它恰好挡住了一条真出路。
//
// ⟹ 写了两个探针，真机量出四个前提：
//   不需要屏幕录制（`tapErr 0` + `screenRecordingGranted false`）
//   能拿到音频（98% 非零、RMS 0.2013）
//   格式是交错立体声（`bufChannels 2` + `bufBytes 4096` ⟹ 512 帧/声道）
//   音量之前（音量 26%→53% 而 RMS 只涨 6.7%）
//
// ⟹ 0.9.36 换过去了。守卫从"说清那个指示关不掉"翻成
//    "**说清什么时候有、什么时候没有**"。
check('说清两条采集路径的差别（哪条会显示"正在共享屏幕"）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  const htmlCode = html.replace(/<!--[\s\S]*?-->/g, '');

  // ⚠️ 主路径不需要屏幕录制 —— 这是这次改动的全部意义
  assert.match(htmlCode, /不需要屏幕录制权限/,
    '没说「全系统」音源不需要屏幕录制 ⟹ 用户不知道我们修了这个');
  // ⚠️ 而**退回的两种情况必须说** —— 否则用户看到那个指示会以为我们没改
  assert.match(htmlCode, /只抓网易云/,
    '没说「只抓网易云」会退回 ScreenCaptureKit ⟹ 用户选了它看到指示会困惑');
  assert.match(htmlCode, /14\.2/,
    '没说旧系统会退回 ⟹ 那也是会看到指示的情况');
  // ⚠️ 而"当前用哪条"必须能看到 —— 光说规则不够
  assert.match(htmlCode, /状态会写清当前用的是哪条|状态会说原因/,
    '没指向那行状态 ⟹ 用户没法判断自己现在走的是哪条路');

  // ⚠️ 这只影响音频 —— 用户的原始困惑就是"以为整个应用在录屏"
  assert.match(htmlCode, /手势走.{0,6}摄像头/,
    '没说清"这只影响音频，手势/鼠标是别的权限"');
  assert.match(htmlCode, /不亮任何指示/,
    '没说鼠标转发那条不亮指示 ⟹ 那正是用户记忆里"操作桌面没有共享屏幕"的部分');

  // ⚠️ 不许再出现那句没验过的话
  assert.ok(!/进程 tap 要 14\.2\+[^<]*同样要屏幕录制/.test(htmlCode),
    '面板上还写着"进程 tap 同样要屏幕录制权限" —— **那句话已被真机证伪**');
});

// ⚠️⚠️⚠️ **CoreAudio tap 那条路的四个实现坑，都会「建成功但不工作」。**
//
// 探针 2 一共踩了四个，每个都 `noErr` + 功能死：
//   ① `&裸CFString` 取地址 ⟹ UID 读成空 ⟹ tap 挂不上（swiftc **只给警告**）
//   ② `CATapDescription(stereoMixdownOfProcesses: [])` —— 我以为空数组=全部，
//      实际是「混音**这些**进程」⟹ 空 = **没有进程** ⟹ 正解是黑名单那个
//   ③ aggregate device 的 `SubDeviceList` 给空 ⟹ **没有时钟** ⟹ 没有 IO 周期
//   ④ 默认输出设备的 UID 也差点踩 ①
//
// ⟹ 这些都是**纯文本特征**，云端能查 ⟹ 做成守卫比"下次注意"可靠。
check('CoreAudio tap 的四个静默失效点都防住了', () => {
  const swift = fs.readFileSync(
    path.join(__dirname, '..', 'native', 'GestureWallAudio.swift'), 'utf8',
  );
  const code = swift.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  // ① 全局 tap 用黑名单初始化器（白名单传空 = 没有源）
  assert.match(code, /stereoGlobalTapButExcludeProcesses/,
    'tap 用的不是黑名单初始化器 ⟹ `stereoMixdownOfProcesses([])` 是白名单，'
    + '空数组 = **没有进程** ⟹ tap 建成功但不监听任何东西（零回调）');
  assert.ok(!/stereoMixdownOfProcesses/.test(code),
    '代码里还有白名单初始化器 —— 那个传空会让 tap 没有源');

  // ② aggregate device 必须有 subdevice（提供时钟）
  assert.match(code, /kAudioSubDeviceUIDKey/,
    'aggregate device 没有 subdevice ⟹ **没有时钟** ⟹ 不产生 IO 周期（零回调）');
  assert.match(code, /kAudioAggregateDeviceMainSubDeviceKey/,
    '没设 MainSubDevice ⟹ 时钟基准不确定');

  // ③ 交错格式要降成单声道（真机实测 bufChannels=2）
  assert.match(code, /f \* ch \+ c/,
    'tap 的交错格式没降成单声道 ⟹ 真机实测 `bufChannels: 2`，'
    + '按单声道读会让**采样率算错一倍** ⟹ 每个 FFT bin 的频率翻倍 '
    + '⟹ 整圈频率映射错位（而那是"画面看着还行但对不上音乐"，最难发现）');

  // ④ 静音行为要显式 unmuted —— 否则 tap 把音频截走，用户听不到声音
  assert.match(code, /muteBehavior = \.unmuted/,
    '没显式设 unmuted ⟹ 万一默认变了，tap 会把音频截走 '
    + '⟹ 症状是"壁纸能动但没声音"，用户会以为播放器坏了');

  // ⑤ SIGTERM 要清理 —— 上层用 child.kill() 停我们
  // ⚠️ 锚**定义的完整形状** —— 只写 `/func installSignalCleanup/` 时，
  // 把定义改名成 `…X` 后**调用点**仍然匹配 ⟹ 守卫绿着而代码是坏的。
  // （这一轮已经因为"名字子串"栽过一次：clearWorkshopManifest。）
  assert.match(code, /func installSignalCleanup\s*\(\s*\)/,
    '没有信号清理 ⟹ 上层 `child.kill()`（SIGTERM）时 Swift 直接退出，'
    + 'tap 和 aggregate device 留在系统里。而每次切音源都会重启这条链 '
    + '⟹ 残留**累积** ⟹ 可能影响用户的系统音频');
  assert.match(code, /signalSources\.append/,
    'DispatchSource 没被持有 ⟹ 释放后就不再触发（又一个"注册成功但不工作"）');
  // 而它必须在启动采集之前调
  const installAt = code.indexOf('installSignalCleanup()');
  const startAt = code.lastIndexOf('await tap.start()');
  assert.ok(installAt > 0 && startAt > 0 && installAt < startAt,
    'installSignalCleanup 没在启动采集之前调 ⟹ "启动瞬间就被 kill"'
    + '（用户快速切音源）仍会留下残留');

  // ⑥ 退回时要报出来，不能静默
  assert.match(code, /退回 ScreenCaptureKit/,
    'tap 起不来时静默退回 ⟹ 用户看到「正在共享屏幕」会以为我们没改，'
    + '而真因是 tap 起不来');

  // ⑦ 两条路必须共用同一个处理入口，否则必然漂
  assert.match(code, /func feed\(_ mono: \[Float\], batch: Int\)/,
    '两条采集路径没共用处理入口 ⟹ 乘音量/攒帧/FFT 各写一遍必然漂');
  // JS 侧要能看到用的哪条
  const as = fs.readFileSync(path.join(__dirname, '..', 'src', 'audio-source.js'), 'utf8');
  assert.match(as, /coreaudio-tap/,
    'audio-source.js 不认 backend ⟹ 面板上看不到当前用的哪条路');
});

// ⚠️⚠️⚠️ **shell 脚本的引号必须配对（bash -n 能查，但没人跑它）。**
//
// 我在 `build-mac.sh` 的 `echo "…"` 里写了 `「零事件」` 用的 ASCII 双引号
// ⟹ 字符串被提前截断 ⟹ `bash: unexpected EOF while looking for matching '"'`
// ⟹ **整个脚本跑不了**，而它是用户装包的唯一入口。
//
// ⚠️ 而这和 Swift 那两个坑是同一个形状：**在字符串里写引用**。
// Swift 里是中文引号（`"`）编译失败，shell 里是 ASCII 引号截断字符串。
// ⟹ 规则统一：**在字符串里引用文字，一律用「」**。
check('shell 脚本里的引号配对（否则脚本跑不了）', () => {
  const dir = path.join(__dirname, '..', 'scripts');
  const bad = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sh'))) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      // 只查 echo 行 —— 多行 node -e 那种本来就跨行配对
      if (!/^\s*echo\s+"/.test(line)) return;
      let n = 0;
      for (let k = 0; k < line.length; k += 1) {
        if (line[k] === '\\') { k += 1; continue; }
        if (line[k] === '"') n += 1;
      }
      if (n % 2) bad.push(`${f}:${i + 1}`);
    });
  }
  assert.deepStrictEqual(bad, [],
    `这些 echo 行的双引号不配对：${bad.join(', ')}\n`
    + '    ⟹ bash 会报 "unexpected EOF while looking for matching" ⟹ **整个脚本跑不了**\n'
    + '    ⟹ 在字符串里引用文字用 「」，不要用 ASCII 双引号\n'
    + '    （和 Swift 里"中文引号让编译失败"是同一个形状）');
});

// ⚠️⚠️⚠️ **右键菜单的四个必然会踩的坑。**
//
// 用户 2026-08-01 要的形态：「右键点击，一个选项是在资源管理器中打开，
// 一个是卸载」。而右键菜单这东西有几个"不做就一定出问题"的点：
check('卡片右键菜单：单实例 / 会关 / 不越界 / 不被自己的监听吃掉', () => {
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));

  // ① **单实例** —— 每张卡片挂一个 DOM 菜单会在滚动时拖慢，
  //    而且"关闭"逻辑要写 N 遍
  assert.match(dash, /let cardMenu = null/,
    '菜单不是单实例 ⟹ N 张卡片各挂一个 DOM，滚动会卡');

  // ② **点别处/滚动/Esc 都要关** —— 漏一个的话菜单会"粘"在屏幕上，
  //    而用户会以为界面卡住了
  for (const [needle, why] of [
    [/addEventListener\('click', closeCardMenu\)/, '点别处'],
    [/addEventListener\('scroll', closeCardMenu, true\)/, '滚动'],
    [/'Escape'/, 'Esc'],
  ]) {
    assert.match(dash, needle,
      `菜单不会因「${why}」关闭 ⟹ 它会粘在屏幕上，用户以为界面卡住了`);
  }
  // ⚠️ scroll 要 capture（第三个参数 true）—— 卡片在可滚动容器里，
  // 而 scroll 事件**不冒泡** ⟹ 不用 capture 就收不到容器的滚动
  assert.match(dash, /addEventListener\('scroll', closeCardMenu, true\)/,
    'scroll 监听没用 capture ⟹ scroll 不冒泡，容器滚动时收不到');

  // ③ **贴边要翻转** —— 右下角的卡片必然让菜单跑出屏幕
  assert.match(dash, /window\.innerWidth/,
    '菜单没做边界翻转 ⟹ 右边缘的卡片右键时菜单跑到屏幕外（点不到）');
  assert.match(dash, /window\.innerHeight/, '同上（下边缘）');

  // ④ **oncontextmenu 里要 stopPropagation** ——
  //    否则冒泡到 document 的 click 监听，菜单开出来立刻被自己关掉
  const cardFn = dash.slice(dash.indexOf('function workshopCard'),
    dash.indexOf('\nasync function runBrowse'));
  assert.match(cardFn, /oncontextmenu[\s\S]{0,200}?stopPropagation/,
    'oncontextmenu 里没 stopPropagation ⟹ 菜单开出来会被自己的 '
    + 'document click 监听立刻关掉（症状：右键"没反应"）');
  assert.match(cardFn, /preventDefault/,
    '没 preventDefault ⟹ 系统的原生右键菜单会一起弹出来');

  // ⑤ 菜单要**可选** —— 「浏览创意工坊」的卡片没有本地目录，也不该有卸载
  assert.match(cardFn, /if \(onMenu\)/,
    '右键菜单不是可选的 ⟹ 「浏览创意工坊」那边的卡片会挂上一个'
    + '"在 Finder 中打开"（那个壁纸还没下载，没有本地目录）');

  // ⑥ 危险项要能区分 —— 「卸载」和「装载」长得一样的话容易点错
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  assert.match(html, /\.card-menu-item\.danger/,
    '菜单里的危险项没有单独样式 ⟹ 「卸载」和「装载」长得一样，容易点错');
});

// ⚠️⚠️⚠️ **dmg 是主验证路径 —— 那是用户拿到的东西。**
//
// 我 0.9.37 把"直接拷 dist/mac-arm64/GestureWall.app"放成推荐，
// 理由是"不用每次 xattr"。用户 2026-08-01 否掉了：
//   「可是我就是应该验证 dmg 啊，最后别人拿到的也是 dmg，
//     这样才一致性，好测试，好优化啊」
//
// **他是对的，而我搞错了优先级**：
//   我优化的是**我们的往返成本**（少敲一条命令）
//   而他要的是**测试有效性**（测的东西和别人拿到的一样）
//
// ⟹ 跳过 dmg 测出来的「能用」**不保证 dmg 那条路能用**。dmg 的失败模式：
//   quarantine、符号链接/权限没保住、Gatekeeper 对 dmg 内的 .app 校验更严、
//   拖拽时拖错地方。
//
// ⚠️ 而这正是这个项目栽过的形状：我曾在 `npm start` 下验鼠标转发，
// 而它**必须打包才能验**（授权按二进制身份给）。
// ⟹ **测的环境和用户的环境不一样，结论就不可信。**
check('装包走 dmg（不许把"直接拷 .app"当推荐路径）', () => {
  const sh = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'build-mac.sh'), 'utf8',
  );
  // ⚠️ dmg 缺失要**直接失败** —— 而不是"退回拷 .app"
  assert.match(sh, /dist\/\*\.dmg[\s\S]{0,400}?打包失败了/,
    'dmg 不存在时没有直接失败 ⟹ 若退回拷 .app，用户会以为验过了');

  // ⚠️ 有一个自动化脚本，而它**必须真的走 dmg**（挂载+拷+解隔离），
  // 不是偷偷拷构建产物 —— 那样"自动化"就变成"绕过"了
  const inst = path.join(__dirname, '..', 'scripts', 'install-dmg.sh');
  assert.ok(fs.existsSync(inst),
    '没有 install-dmg.sh ⟹ 每次装都要手敲四步（挂载/拖/卸载/xattr），'
    + '而那个麻烦会让人想跳过 dmg');
  const is = fs.readFileSync(inst, 'utf8');
  assert.match(is, /hdiutil attach/,
    'install-dmg.sh 没挂载 dmg ⟹ 它在绕过 dmg，那就失去了意义');
  assert.match(is, /xattr -dr com\.apple\.quarantine/,
    'install-dmg.sh 没解隔离 ⟹ 装完打不开');
  // ⚠️ 挂载点要从 hdiutil 的输出取，不能猜 /Volumes/<名字> ——
  // 同名卷已挂载时 macOS 会加后缀（"GestureWall 1"）⟹ 猜的话拷错地方
  assert.match(is, /mount-point/,
    '挂载点是猜的（/Volumes/…）⟹ 同名卷已挂载时 macOS 会加后缀，会拷错地方');
  // ⚠️ 必须卸载 —— 留着挂载点正是上面那个"加后缀"的成因
  assert.match(is, /hdiutil detach/, '没卸载 dmg ⟹ 下次挂载会加后缀');
  assert.match(is, /trap cleanup EXIT/,
    '卸载不在 trap 里 ⟹ 中途失败就留下挂载点');
  // ⚠️ 先删再拷 —— cp/ditto 到已存在的 .app 是**合并**，旧文件会残留
  assert.match(is, /rm -rf "\$DEST"/,
    '没先删旧的 ⟹ 拷贝是**合并**，旧版本的文件会残留'
    + '（而残留的旧 helper 会被加载 ⟹ 症状是"改了没生效"）');
  // ⚠️ 用 ditto 而不是 cp -R —— 它保留扩展属性/符号链接（Apple 推荐）。
  //
  // ⚠️⚠️ 断言要剥注释 —— 我第一版写 `/ditto /`，而**注释里也有那个词**
  //（"用 ditto 而不是 cp -R"）⟹ 把命令换成 cp 之后断言照样绿。
  // **这是今天第七次踩"注释让守卫失效"** ⟹ shell 也要剥（`#` 开头的行）。
  const isCode = is.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.match(isCode, /^\s*ditto /m,
    '用 cp -R 拷 .app ⟹ 某些情况下会丢符号链接目标，用 ditto');
  // ⚠️ 旧版本在跑时要拦住 —— 否则文件被占用，症状是"装完还是旧行为"
  assert.match(is, /pgrep -x GestureWall/,
    '没检查旧版本在不在跑 ⟹ 文件被占用时症状是"装完还是旧行为"，'
    + '而那和"改了没生效"分不清');

  // ⚠️ 而"直接拷 .app"那条**不能是推荐** —— 它只能是"快速看一眼"
  assert.ok(!/推荐：直接拷/.test(sh),
    '还把"直接拷 .app"当推荐 ⟹ 那绕过了用户实际走的路径');
  assert.match(sh, /不能当验证/,
    '没说清"直接拷 .app 不能当验证" ⟹ 下次又会有人图省事走那条');
});

// ⚠️⚠️⚠️ **`set -e` + 命令替换里的 `ls` = 静默退出。这个项目第二次栽了。**
//
// 形状：`set -euo pipefail` 下
//     DMG=$(ls -t dist/*.dmg 2>/dev/null | head -1)
// `ls` 找不到文件返回非零 ⟹ `pipefail` 让整条管道非零 ⟹ `set -e` **立刻退出**
// ⟹ 下面那句「❌ 没找到 dmg，往上翻输出」**永远看不到**
// ⟹ 用户看到的是"什么都没打印、退出码 2"，而那时他最需要那句提示。
//
// ⚠️ 第一次是 `fingerprint.sh`：`[ "$dirty" -gt 0 ] && echo …`
// 在干净工作区返回 1 ⟹ 整个脚本 exit 1 ⟹ `npm run sync && npm start`
// 的 `&&` 阻断后半段。**工作区越干净越触发**，跟直觉相反。
//
// ⟹ 规则：`set -e` 的脚本里，命令替换里用可能失败的命令一律加 `|| true`
//   （失败要靠**后面的 if 判空**来处理，那样错误信息才发得出去）。
check('shell 脚本：set -e 下的 ls 赋值要有 || true（否则静默退出）', () => {
  const dir = path.join(__dirname, '..', 'scripts');
  const bad = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sh'))) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const lines = raw.split('\n').filter((l) => !l.trim().startsWith('#'));
    const hasE = lines.some((l) => /set -[a-z]*e/.test(l));
    // ⚠️ 用 `continue` 不是 `return` —— 这是 `for…of` 循环，
    // 而我第一版写了 `return`（那是从 forEach 版本改过来时留下的）
    // ⟹ **第一个没开 set -e 的脚本就让整条检查提前结束**
    // ⟹ 反向验证时守卫"没反应"，而我差点以为是判据不对。
    // ⚠️ 那是"守卫自己有 bug"的一种：它不报错，只是**少查了东西**。
    if (!hasE) continue;   // 没开 set -e 的脚本不受这条约束
    lines.forEach((line, i) => {
      // `X=$(可能失败的命令 …)` 且没有 `|| true`
      const m = line.match(/^\s*\w+=\$\((ls|grep|find|pgrep)[^)]*\)/);
      if (m && !/\|\|\s*true/.test(line)) bad.push(`${f}: ${line.trim().slice(0, 70)}`);
    });
  }
  assert.deepStrictEqual(bad, [],
    `这些赋值在 set -e 下会让脚本**静默退出**：\n    ${bad.join('\n    ')}\n`
    + '    ⟹ 命令失败 + pipefail ⟹ set -e 立刻退出 ⟹ '
    + '后面那句友好的错误信息永远看不到\n'
    + '    ⟹ 加 `|| true`，让"失败"靠后面的 if 判空来处理');
});

// ⚠️⚠️⚠️ **`$VAR` 紧跟中文字符 = `unbound variable`（bash -n 查不出）。**
//
// 用户 2026-08-01 真机，两个脚本同时挂在这上面：
//     build-mac.sh: line 120: APP?: unbound variable
//     install-dmg.sh: line 93: DEST?: unbound variable
//
// 原文是：
//     echo "② 覆盖 $DEST（先删旧的 …）"
//     echo "--- ⚠️ 未打包的 .app 也在（$APP）---"
//
// ⟹ bash 读变量名时**不认多字节字符的边界** —— 它把 `（`（UTF-8 三字节）
//    的首字节吞进变量名 ⟹ 变量名变成 `DEST?` ⟹ `set -u` 报 unbound。
//
// ⚠️⚠️ 而这类错 **`bash -n` 查不出**（语法是合法的）——
// 只有**真跑**才暴露，而我在云端跑不了完整脚本（没有 dmg / 没有 /Applications）。
// ⟹ 这正是"云端只能靠守卫兜"的又一类，和 Swift 那两个坑同性质。
//
// ⚠️ 顺带扫出 `restore-gestures.sh` 也有一处（`$TAG，`）——
// **那是恢复手势的救命脚本**，而它挂掉的时机正好是"手势文件已经被覆盖"的时候。
//
// ⟹ 规则：**`$VAR` 后面接非 ASCII 一律写成 `${VAR}`。**
check('shell 里 $VAR 紧跟中文要用 ${VAR}（否则 unbound variable）', () => {
  const dir = path.join(__dirname, '..', 'scripts');
  const bad = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sh'))) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (line.trim().startsWith('#')) return;
      // `$NAME` 紧跟非 ASCII（没有 {} 保护）
      const re = /\$([A-Za-z_][A-Za-z0-9_]*)([^\x00-\x7f])/g;
      let m = re.exec(line);
      while (m) {
        bad.push(`${f}:${i + 1} $${m[1]}${m[2]} ⟹ 写成 \${${m[1]}}`);
        m = re.exec(line);
      }
    });
  }
  assert.deepStrictEqual(bad, [],
    `这些地方 bash 会把中文字符的首字节吞进变量名：\n    ${bad.join('\n    ')}\n`
    + '    ⟹ `set -u` 下报 `unbound variable`，而**`bash -n` 查不出**（语法合法）\n'
    + '    ⟹ 只有真跑才暴露，而云端跑不了完整脚本 ⟹ 只能靠这条守卫');
});

// ⚠️⚠️⚠️ **删壁纸 = 删用户的文件。四道护栏，每一道都不能省。**
//
// 用户 2026-08-01 要的：右键菜单里「这个壁纸的文件直接删除」。
// 而这是这个项目里**唯一一个删用户文件**的功能 ⟹ 护栏要写死。
check('删壁纸：废纸篓 + 路径白名单 + 不删根目录 + 要确认', () => {
  const src = codeOnly(mainSrc);
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));

  // ① **废纸篓，不是永久删除** —— 用户可能点错（菜单里「删除」挨着
  //   「在 Finder 中打开」），而壁纸可能是他订阅的、或者改过属性的。
  //   而我们没有"撤销" ⟹ 让系统的撤销机制接管。
  assert.match(src, /shell\.trashItem/,
    '不是移到废纸篓 ⟹ 永久删除在"删用户文件"这件事上是不可接受的风险'
    + '（用户点错了没法反悔）');
  const delAt = src.indexOf("ipcMain.handle('we-delete-wallpaper'");
  assert.ok(delAt > 0, '没有删除的 IPC');
  const delFn = src.slice(delAt, src.indexOf('\nipcMain', delAt + 10));
  assert.ok(!/fs\.rmSync|fs\.unlinkSync|rimraf/.test(delFn),
    '删除里用了 fs.rmSync/unlinkSync ⟹ 那是永久删除');

  // ② **路径白名单** —— 这个 IPC 收到什么就删什么，而渲染进程的一个 bug
  //   （比如 `item.dir` 是 undefined 拼出了 `/`）就会变成灾难。
  assert.match(delFn, /startsWith\(r \+ path\.sep\)/,
    '没有路径白名单，或者前缀比较没带分隔符 ⟹ '
    + '`/Users/x/Wallpapers-evil` 会被 `/Users/x/Wallpapers` 前缀命中');
  assert.match(delFn, /path\.resolve/,
    '没 resolve 路径 ⟹ `../` 能穿出白名单');

  // ③ **不能删根目录本身** —— 那会把整个壁纸库扔进废纸篓
  assert.match(delFn, /roots\.includes\(resolved\)/,
    '没挡住"删根目录本身" ⟹ 一次误操作能把整个壁纸库扔进废纸篓');

  // ④ **正在用的要先卸载** —— 否则删完文件窗口还在渲染它
  //   （资源已载入内存）⟹ 画面是"文件不在了但还在显示"
  //   ⟹ 用户重启后才发现，症状和时机脱节
  // ⚠️ 锚在**判定那一行**，不是 `wasActive` 这个词 ——
  // 它在日志和返回值里也出现，把判定改成 `false` 后断言照样绿。
  //（这一轮第三次栽在"名字子串"上：clearWorkshopManifest、installSignalCleanup。）
  assert.match(delFn, /weProject && path\.resolve\(weProject\.dir\) === resolved/,
    '删除时没判"是不是正在用" ⟹ 删完文件窗口还在渲染它，'
    + '而用户重启后才发现壁纸没了（症状和时机脱节，很难查）');
  assert.match(delFn, /if \(wasActive\) \{[\s\S]{0,200}?setWEWallpaper\(null\)/,
    '正在用的没先卸载');

  // ⑤ **要确认对话框** —— 这个项目的纪律：破坏性操作要用户明示
  assert.match(dash, /confirm\(/,
    '删除没有确认对话框 ⟹ 破坏性操作必须用户明示'
    + '（而右键菜单里「删除」挨着「在 Finder 中打开」，点错的概率不低）');
  // ⚠️ 确认框要说清"去哪" —— 用户知道是废纸篓才敢点
  assert.match(dash, /移到废纸篓？|移到废纸篓\?/,
    '确认框没说"移到废纸篓" ⟹ 用户不知道能不能反悔');

  // ⑥ **失败要说出来** —— 静默失败时用户以为删了，
  //   而下次刷新它又在那儿（看起来像"删不掉"的鬼故事）
  const delBtn = dash.slice(dash.indexOf('移到废纸篓'),
    dash.indexOf('移到废纸篓') + 1400);
  assert.match(delBtn, /out\.error|删除失败/,
    '删除失败时没报出来 ⟹ 用户以为删了，下次刷新它又在（像"删不掉"的鬼故事）');
});

// ⚠️⚠️⚠️ **轮播（0.9.43）的六个坑，每个都会静默失败。**
//
// 用户 2026-08-01：「壁纸应该设置一个播放列表，然后可以设置时间如轮播，
// 可以选择顺序/随机等」
//
// 他拍的两个设计决定：
//   · 列表是**手选**的（右键菜单里加/移出），不是"目录里全部"
//   · 轮播开着时手动点一个壁纸**不打断轮播**，只是从它重新计时
//     （理由：「点一下就关了一个开关」容易意外，重开还要去找那个开关）
check('轮播：列表存路径 / 手动不打断 / 少于2个不起 / 失败不卡死', () => {
  const src = codeOnly(mainSrc);
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));

  // ① **列表存路径，不是索引或标题**
  //   索引会随目录内容变（删一个壁纸，后面全错位）；标题会重名（很多叫"时钟"）
  assert.match(src, /rotate: \{[\s\S]{0,300}?list: \[\]/,
    '轮播配置里没有 list ⟹ 播放列表存哪儿？');
  // ⚠️ 迁移要**逐字段**补 —— 老配置没有这个对象，而代码里到处读
  //   `config.we.rotate.list` ⟹ 少一层就是 `undefined.list` 崩溃
  assert.match(src, /!we\.rotate \|\| typeof we\.rotate !== 'object'/,
    '老配置里没有 rotate 对象而没补默认值 ⟹ `undefined.list` 崩溃');
  assert.match(src, /Array\.isArray\(we\.rotate\.list\)/,
    'list 不是数组时没兜住 ⟹ `.filter` 崩溃');

  // ② **每次重新过滤有效项，不缓存** —— 用户可能刚删掉列表里的一个，
  //   而缓存会让轮播切到不存在的路径 ⟹ 症状是"轮播卡住"
  // ⚠️ 锚**定义的完整形状** —— 只写 `/function rotateValid/` 时，
  // 把定义改名成 `…X` 后调用点仍然匹配 ⟹ 守卫绿着而代码是坏的。
  // （这一轮第四次栽在"名字子串"上。）
  assert.match(src, /function rotateValid\s*\(\s*\)/,
    '没有"列表里哪些还存在"的过滤 ⟹ 壁纸被删后轮播会切到不存在的路径');
  assert.match(src, /fs\.existsSync\(path\.join\(d, 'project\.json'\)\)/,
    '判"壁纸还在不在"没看 project.json ⟹ 空目录会被当成有效壁纸');

  // ③ **少于 2 个不起定时器** —— 一个壁纸"轮播"就是每隔 N 分钟重载它，
  //   画面会白闪一下，而用户不会理解那是什么
  assert.match(src, /rotateValid\(\)\.length < 2/,
    '列表少于 2 个仍然起定时器 ⟹ 每隔 N 分钟重载同一个壁纸（画面白闪）');
  // 面板也要说清 —— 否则用户开了开关发现不动会以为坏了
  assert.match(dash, /至少要 2 个/,
    '面板没说"至少 2 个才会轮播" ⟹ 用户开了开关发现不动会以为坏了');

  // ④ **随机要避开当前和上一个** —— 列表 3 个时连续撞的概率 1/3，
  //   感知上就是"随机了半天还是那张"
  // ⚠️ 同上：锚**声明**而不是名字（它在赋值和比较处也出现）
  assert.match(src, /let rotateLast = null/,
    '随机模式没记上一个 ⟹ 列表只有 2 个时会"根本不换"');

  // ⑤ **手动装载时重算计时器**（用户拍的行为）
  //   漏了的话：用户手动切了一张，5 秒后轮播把它换掉
  //   ⟹ 症状是"我刚点的壁纸自己变了"
  const loadAt = src.indexOf("ipcMain.handle('workshop-load-local'");
  assert.ok(loadAt > 0, '找不到手动装载的 IPC');
  const loadFn = src.slice(loadAt, src.indexOf('\nipcMain', loadAt + 10));
  assert.match(loadFn, /syncRotate\(\)/,
    '手动装载时没重算轮播计时器 ⟹ 用户刚点的壁纸可能几秒后就被换掉'
    + '（症状："我刚点的壁纸自己变了"）');

  // ⑥ **切换失败不能让轮播停** —— 一个坏壁纸不该卡住整条链
  const stepAt = src.indexOf('function rotateStep');
  const stepFn = src.slice(stepAt, src.indexOf('\nfunction ', stepAt + 10));
  assert.match(stepFn, /轮播切换失败（跳过）/,
    '切换失败时没报出来 ⟹ 用户看到"轮播不动了"而不知道是哪个壁纸坏了');

  // ⑦ 启动时要起轮播，**而且要在恢复壁纸之后**
  //   （rotateNext 靠 weProject.dir 判断"当前是第几个"）
  const readyAt = src.indexOf('app.whenReady()');
  const restoreAt = src.indexOf('setWEWallpaper(config.we.dir)', readyAt);
  const syncAt = src.indexOf('syncRotate()', readyAt);
  assert.ok(restoreAt > 0 && syncAt > 0 && restoreAt < syncAt,
    '启动时 syncRotate 在恢复壁纸之前 ⟹ 第一次切换会从列表开头开始'
    + '（症状：重启后壁纸跳到第一个）');

  // ⑧ 「下一张」不能改开关状态 —— 用户点它只是想现在换一张
  const nextAt = src.indexOf("ipcMain.handle('we-rotate-next'");
  const nextFn = src.slice(nextAt, src.indexOf('\n', src.indexOf('return', nextAt)));
  assert.ok(!/\.on = /.test(nextFn),
    '「下一张」改了开关状态 ⟹ "点一下就把轮播开了/关了"是意外行为');
});

// ⚠️⚠️⚠️ **开发者模块必须能整块撤掉（0.9.44）。**
//
// 用户 2026-08-01：
//   「你的设计太 dashboard 了，我们是一个 2C 的产品」
//   「你可以把开发者的东西全部聚合成一个控制面板模块，
//     最后产品问世了，把这个模块直接撤掉就行」
//
// **他说得对** —— 我一直在加"能观测的东西"，而那是给我自己用的。
// 一个 2C 用户要选壁纸，而「我的壁纸」这一屏给了他：
//   壁纸层策略（真壁纸层/压最底/悬浮 —— 三个他不认识的词）
//   转发鼠标 + 「只在桌面被聚焦时转发」（文案自己写着「开了会挡掉大部分点击」）
//   mouse-state 诊断（「已转发 N · 页面收到 mousedown x」）
//   音源五个按钮（含单段扫描、合成测试音 —— 纯诊断工具）
//   频谱数值 / 钟点 / 孤峰 / 帧节奏 / helper 日志
//
// ⚠️ 但那些**不能删** —— 它们是这几十轮唯一的调试手段（用户报症状 → 面板给数字）。
// ⟹ **物理隔离**成一个模块，撤掉时删三处（HTML marker 之间、JS 那一段、CSS）。
check('开发者模块物理隔离，能整块撤掉', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');

  // ⚠️ 三处都要有配对的 marker —— 少一处的话"撤掉"就变成"到处找"
  for (const [name, text] of [['dashboard.html', html], ['dashboard.js', dash]]) {
    const starts = (text.match(/DEV-PANEL-START/g) || []).length;
    const ends = (text.match(/DEV-PANEL-END/g) || []).length;
    assert.strictEqual(starts, 1, `${name} 里 DEV-PANEL-START 有 ${starts} 个（要 1 个）`);
    assert.strictEqual(ends, 1, `${name} 里 DEV-PANEL-END 有 ${ends} 个（要 1 个）`);
    assert.ok(text.indexOf('DEV-PANEL-START') < text.indexOf('DEV-PANEL-END'),
      `${name} 里 marker 顺序反了`);
  }

  // ⚠️⚠️ **诊断元素必须全在 marker 之间** —— 散在外面的话撤掉模块会留下
  // 孤儿元素，而 `getElementById` 拿到 null 就是 `null.onclick` 崩溃
  // （这个项目为"删 UI 留调用"栽过三次）。
  const devStart = html.indexOf('DEV-PANEL-START');
  const devEnd = html.indexOf('DEV-PANEL-END');
  const devHtml = html.slice(devStart, devEnd);
  const outside = html.slice(0, devStart) + html.slice(devEnd);
  for (const id of ['we-strategy', 'mouseForward', 'mouseGateFinder', 'mouse-state',
    'we-audio-source', 'we-audio-frame', 'audio-log']) {
    assert.ok(devHtml.includes(`id="${id}"`),
      `诊断元素 ${id} 不在开发者模块里 ⟹ 撤掉模块时它会留下（或者被漏掉）`);
    assert.ok(!outside.includes(`id="${id}"`),
      `诊断元素 ${id} 在模块外面也有一份 ⟹ 重复显示`);
  }

  // ⚠️ 而 2C 要的那些**不能**在模块里 —— 撤掉模块不该带走核心功能
  const htmlNoComment = html.replace(/<!--[\s\S]*?-->/g, '');
  const devHtmlNoComment = devHtml.replace(/<!--[\s\S]*?-->/g, '');
  // ⚠️ 0.9.50 从这个清单里去掉了 `audioFollow` —— 那个开关整个撤了
  //（用户：「这是什么，这应该是默认的，不需要给选项」），见下面那条反向断言。
  for (const id of ['mine-dirs', 'mine-grid', 'rotate-summary']) {
    assert.ok(htmlNoComment.includes(`id="${id}"`), `${id} 不见了`);
    assert.ok(!devHtmlNoComment.includes(`id="${id}"`),
      `${id} 被放进开发者模块了 ⟹ 撤掉模块会带走 2C 功能`);
  }

  // ⚠️ **默认收起** —— 否则"聚合"了但用户还是一眼看到全部
  assert.match(devHtml, /id="dev-panel" hidden/,
    '开发者面板默认展开 ⟹ 聚合了但没收起，2C 用户还是一眼看到全部');

  // ⚠️ 状态不落配置 —— 撤掉模块后 config.json 里会留个孤儿字段，
  // 而下一个人不知道它是干什么的
  const jsDevStart = dash.indexOf('DEV-PANEL-START');
  const jsDevEnd = dash.indexOf('DEV-PANEL-END');
  const jsDev = dash.slice(jsDevStart, jsDevEnd);
  assert.ok(!/weSet|writeConfig|config\.we\./.test(jsDev),
    '开发者开关的状态落进了配置 ⟹ 撤掉模块后 config.json 里留下孤儿字段');

  // ⚠️⚠️ **不许再有「让壁纸跟着音乐动」那个开关**（0.9.50 撤掉）。
  // 用户 2026-08-01：「这是什么，这应该是默认的，不需要给选项」
  //
  // 它问的是一个用户不需要做的决定：采集的条件本来就是
  // `weProject.wantsAudio && audioSource !== 'off'`（壁纸自己声明要音频），
  // 而默认值已经是 `system`，还有一条迁移把老配置的 `off` 改回 `system`。
  // ⟹ 装了音乐可视化壁纸的人，唯一合理的期望就是它跟着音乐动。
  // ⚠️⚠️ 这两条必须用**剥掉注释/HTML 注释**的版本 ——
  // 撤掉那个开关时我在原处留了一段注释解释"为什么撤"，而那段注释里就写着
  // `id="audioFollow"` 和 `renderAudioSimple()` ⟹ 查原文的话这两条断言
  // **在正确代码上报红**（第 8 次"注释骗过守卫"，这次是假阳性方向）。
  // 而这条 check 里的 `dash`/`html` 是原文（marker 检查需要原文）⟹ 各自剥。
  const htmlNoC = html.replace(/<!--[\s\S]*?-->/g, '');
  const dashNoC = codeOnly(dash);
  assert.ok(!/id="audioFollow"/.test(htmlNoC),
    '又加了「让壁纸跟着音乐动」开关 ⟹ 那是把实现细节暴露成选项（用户点名撤掉）');
  assert.ok(!/renderAudioSimple\s*\(/.test(dashNoC),
    'renderAudioSimple 又回来了 ⟹ 那个 2C 音频开关整个撤了');

  // ⚠️ 但**默认值必须是 system** —— 撤掉开关之后，如果默认是 off，
  // 壁纸就永远不动了，而用户再也没有地方能打开它（除了开发者选项）。
  // 这是撤掉这个开关的**承重前提**，必须有守卫。
  assert.match(mainSrc, /audioSource: 'system'/,
    "audioSource 默认不是 'system' ⟹ 撤掉开关之后壁纸永远不跟着音乐动");
  assert.match(mainSrc, /we\.audioSource === 'off'[\s\S]{0,120}?we\.audioSource = 'system'/,
    "老配置里的 'off' 没有迁移成 'system' ⟹ 之前关过的人永远打不开了");

  // ⚠️ 而开发者选项里那五个音源按钮要**留着** —— 它们是诊断工具
  //（synth 免授权、sweep 单段扫描，都是把"壁纸能不能画"和"能不能拿到音频"拆开用的）
  assert.match(dash, /const AUDIO_SOURCES = \[/,
    '开发者选项里的音源按钮没了 ⟹ 那是这几十轮唯一的音频诊断手段');
});

// ⚠️⚠️ **壁纸墙式卡片的三个"改坏了不报错"点**（0.9.45）。
//
// 这次把卡片从「图 + 图下文字」改成「图 + 文字压在图上」（学 Open Wallpaper
// Engine 的 ZStack 卡片）。三个东西一旦漏掉，症状都是**看起来正常但信息丢了**：
check('壁纸墙卡片：定位上下文 / 放不了要常显 / \\n 要有 pre-wrap', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');

  // ① 标题/类型行都是 position: absolute ⟹ .ws-item 必须是定位上下文。
  //    漏了的后果：它们跑到**页面**的角上去，而不是卡片的角上。
  const wsItem = html.slice(html.indexOf('.ws-item {'), html.indexOf('.ws-item:hover'));
  assert.match(wsItem, /position:\s*relative/,
    '.ws-item 不是 relative ⟹ 压在图上的标题会相对整个页面定位');

  // ② 而 JS 里那句 `card.style.position = 'relative'` 要**没有** ——
  //    同一个事实两个来源就会漂（这个项目在类型白名单上栽过一次）。
  //    ⚠️⚠️ 必须走 `codeOnly` —— 我删掉那行时**在注释里写了它为什么被删**，
  //    于是这条断言在正确的代码上报红（这一轮第 8 次"注释/字符串骗过守卫"）。
  //    ⟹ 规则：任何"代码里含不含 X"的断言，一律先剥注释。
  assert.ok(!/card\.style\.position\s*=/.test(codeOnly(dash)),
    'JS 又在设 card.style.position ⟹ 定位上下文有两个来源');

  // ③ 「放不了」不能跟着 hover 藏起来 —— .tp 现在默认 opacity 0，
  //    而 .tp.no 是"点下去之前就该知道"的信息。
  //    ⚠️ 锚在 `.ws-item .tp.no {` 这个完整选择器上，不是子串 `tp.no`
  //    （那三个字在 :hover 那条规则里也有，会锚到错的一条）。
  const tpNo = html.slice(html.indexOf('.ws-item .tp.no {'));
  assert.match(tpNo.slice(0, 200), /opacity:\s*1/,
    '.tp.no 没把 opacity 拉回 1 ⟹ 「放不了」被 hover 规则藏了，用户点下去才知道');

  // ④ 用 `\n` 分行的状态区必须有 pre-wrap，否则默认折叠成空格。
  //    这条一直漏着（#mine-state 的多个扫描路径挤成一行），不报错。
  //
  // ⚠️⚠️ **先剥 CSS 注释**。第一版这里有个 `||` 后备分支，正则是
  //   `#br-state[^{]*\{[^}]*white-space:\s*pre-wrap`
  // 而 `[^{]*` 会跨换行 ⟹ 它匹配到了**上面那条 CSS 注释里**提到的
  // "#br-state / #mine-state 是 0.9.45 补上的…"，于是把 pre-wrap 删掉之后
  // 守卫**照样绿**（反向验证第 4 条：报红条数 0）。
  // ⟹ 同一个形状的第 9 次。而这次骗过守卫的是我自己刚写的那段注释。
  //    真正的教训不是"再多加一条剥离"，是：**断言必须先反向验证**，
  //    因为"永久绿的守卫"和"没有守卫"一样，只是更贵。
  const cssOnly = html.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const id of ['br-state', 'mine-state', 'we-state']) {
    // 逐条规则找：选择器列表里含 #id、且同一条规则体里有 pre-wrap。
    const ok = (cssOnly.match(/[^{}]+\{[^{}]*\}/g) || []).some((rule) => {
      const [sel, body] = [rule.slice(0, rule.indexOf('{')), rule.slice(rule.indexOf('{'))];
      return new RegExp(`#${id}\\b`).test(sel) && /white-space:\s*pre-wrap/.test(body);
    });
    assert.ok(ok, `#${id} 里用 \\n 分行但没有 white-space: pre-wrap ⟹ 换行被折叠成空格`);
  }

  // ⑤ 工坊空态要给**具体的下一步**，而且"没搜索词"时不能叫人"换搜索词"。
  const empty = dash.slice(dash.indexOf('const hasQuery'), dash.indexOf('可以试试'));
  assert.match(empty, /if\s*\(!ways\.length\)/,
    '工坊空态没有"三个条件都不成立"的兜底 ⟹ 会叫没搜索词的用户去换搜索词');
});

// ⚠️⚠️ **产品外壳（0.9.46）**。用户 2026-08-01 报的四件事，根因都不是逻辑错，
// 是"没有产品外壳"：
//   ①「wall 这块是用的 Mac 原生的那个条一个白条…他就不是一个整体」
//   ②「我点那个关闭他其实不会关闭，但是 App 图标已经没有下面的小圆圈了」
//   ③「登录界面我们这个只是覆盖了一层什么效果都没有」
//   ④「摄像头默认开启，登录界面啥都没点就能看到我手的骨架」
// 这一节守住那四条的修复，重点是**成对的东西**（改一个不改另一个不报错）。
check('产品外壳：深色标题栏 / 关闭即退出 / 启动页极光 / 骨架不压启动页', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  const main = codeOnly(mainSrc);
  const preloadSrc = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8'));

  // ① hiddenInset 和给红绿灯让位的 padding 是**成对**的。
  //    只设 titleBarStyle：红绿灯压在 brand 上。
  //    只留 padding：白留一块。两个都不报错。
  // ⚠️⚠️ 0.9.58：`hiddenInset` → `hidden` + `setWindowButtonVisibility(false)`
  //（红绿灯默认藏起来，鼠标移到顶部才出现 —— 用户点名）。
  // 两者都能达到"标题栏由我们的 CSS 画"，判据是**不许用系统默认标题栏**
  //（那个跟系统主题走，浅色主题下是白条压在深色面板上）。
  assert.match(main, /titleBarStyle:\s*'hidden(?:Inset)?'/,
    '面板没设 titleBarStyle ⟹ 用系统标题栏，浅色主题下是白条');
  // ⚠️ 红绿灯要默认藏起来 + 有地方能把它显示回来（否则用户找不到关闭按钮）
  assert.match(main, /setWindowButtonVisibility\(false\)/,
    '红绿灯没藏起来 ⟹ 左上角那三个圆点很违和（用户点名）');
  assert.match(main, /ipcMain\.handle\('title-bar-hover'/,
    '没有让红绿灯重新出现的通道 ⟹ 藏了就再也点不到关闭按钮了');
  // ⚠️ 而 `main` 的顶部让位撤了（0.9.54 起 tab 条在最上面，main 不用让）
  // ⚠️⚠️ 必须**同时剥 HTML 注释和 CSS 注释**。
  // 第一版我只剥了 `<!-- -->`，而那段历史写在 `/* */` 里
  //（「原来这个让位写在 nav { padding: 42px … } 和 main { padding: 42px … }」）
  // ⟹ 断言在正确代码上报红，而我还先误判成"真有个 42px 没删"。
  // 第 10 次"注释骗过守卫"，而这次的新形状是：**一个 .html 文件里有两种注释语法**。
  const htmlNoAnyComment = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/main\s*\{[^}]*padding:\s*42px/.test(htmlNoAnyComment),
    'main 还在给标题栏让位 ⟹ 那是左栏布局时代的（现在 tab 条在最上面）');
  // backgroundColor 不能再跟 nativeTheme 走（CSS 是写死深色的）
  const dashWin = main.slice(main.indexOf('dashboardWindow = new BrowserWindow'));
  assert.ok(!/backgroundColor:\s*nativeTheme/.test(dashWin.slice(0, 900)),
    '面板 backgroundColor 跟 nativeTheme 走 ⟹ 浅色主题下开窗闪一下白');

  // ②⚠️⚠️ **关闭 = 整个退出**（0.9.47 推翻了 0.9.46 的托盘方案）。
  //
  // 0.9.46 我加了菜单栏图标 + app.dock.hide()，那是在**给一个错的前提补台阶**：
  // 前提是"关窗口 ≠ 退出壁纸"，而用户要的是标准 Mac 行为
  //   「你正常来说就是应该我点了关闭，那就整个进程关闭都关，
  //     我缩小了那程序在运行中，我这个 Dock 图标的圆点应该还在的」
  // ⟹ 这几条断言现在是**反向**的：有 Tray / dock.hide() 就是回归。
  assert.ok(!/new Tray\(/.test(main),
    '又加了 Tray ⟹ 0.9.47 定的是标准 Mac 行为（关闭即退出），托盘和"关窗不退出"是配套的，一起撤');
  assert.ok(!/app\.dock\.hide\(\)/.test(main),
    '又调了 app.dock.hide() ⟹ Dock 圆点是用户判断"在不在跑"的依据，不能藏');

  // ⚠️ 退出必须挂在面板窗口的 `close` 上，**不能**挂 window-all-closed ——
  // 壁纸层和骨架层也是 BrowserWindow ⟹ 那个事件在这个应用里永远不触发
  // （我第一版就挂错了，那是一段死代码：不报错，只是关闭还是不退出）。
  const dashWinBlock = main.slice(main.indexOf('dashboardWindow = new BrowserWindow'),
    main.indexOf('// 骨架层'));
  assert.match(dashWinBlock, /dashboardWindow\.on\('close',[\s\S]{0,120}?hardQuit\(/,
    '面板窗口的 close 没接 hardQuit ⟹ 点红色 ✕ 关不掉进程（用户报过的原始症状）');
  // ⚠️ 必须是 'close' 不是 'closed' —— 后者在窗口已经消失之后才触发，
  // 中间有一帧"窗口没了但壁纸还在"，那正是用户困惑的画面。
  assert.ok(!/dashboardWindow\.on\('closed',[\s\S]{0,120}?hardQuit\(/.test(dashWinBlock),
    "退出挂在 'closed' 上 ⟹ 窗口先消失再开始退出，中间那帧壁纸还在");
  // ⚠️ 走 hardQuit 而不是 app.quit() —— 后者实测不管用
  assert.ok(!/dashboardWindow\.on\('close',[\s\S]{0,120}?app\.quit\(\)/.test(dashWinBlock),
    'close 里调了 app.quit() ⟹ 实测不管用（用户报过"点了退出但壁纸还在跑"）');
  // 最小化要能唤回（最小化状态下 show() 不恢复窗口）
  assert.match(main, /isMinimized\(\)[\s\S]{0,80}?restore\(\)/,
    '没处理最小化状态 ⟹ 缩到 Dock 之后点图标/⌃⇧W 唤不回来');
  // ⚠️⚠️ **点 Dock 图标要能唤回** —— macOS 发的是 `activate`，Electron 不会
  // 自动帮我们恢复窗口。这是 0.9.47 漏的一块：撤掉 dock.hide() 之后图标回来了，
  // 但点它没反应 ⟹ 那正是用户说的"App 和 GUI 中间这个状态不一致"的最后一块。
  assert.match(main, /app\.on\('activate'/,
    "没处理 'activate' ⟹ 点 Dock 图标窗口不回来，只能靠 ⌃⇧W（标准 Mac 应用必须有）");

  // ③ 启动页背景（0.9.47 = 极光，不再是点+连线）
  assert.match(html, /id="launch-particles"/, '启动页没有背景 canvas');
  assert.match(dash, /devicePixelRatio/,
    'canvas 没按 devicePixelRatio 缩放 ⟹ Retina 上是模糊的一团');
  assert.match(dash, /cv\.width\s*=/,
    '没显式设 canvas.width ⟹ 默认 300×150，只画在左上角一小块');

  // ⚠️⚠️ **不许回到"点 + 连线"**。用户 2026-08-01 的原话：
  //   「你这个做得太劣质了，还不如没有呢」「有一种非常廉价的感觉，没有质感」
  // 那不是参数问题，是形式本身廉价（到处都是的 particles.js 观感）。
  // ⟹ 这条守的是**设计决定**，不是代码正确性。
  assert.ok(!/lineTo\(/.test(dash) || !/LINK/.test(dash),
    '启动页又出现了近邻连线（lineTo + 距离阈值）⟹ 那正是用户判定"廉价"的那一版');

  // 极光的四个承重点：叠加变亮 / 模糊 / blur 乘 dpr / 每帧清屏
  //
  // ⚠️⚠️ 这四条都**切到极光那个函数体里**再查，不查全文。
  // 起因：`clearRect(0, 0, w, h)` 在 dashboard.js:650 早就有一个一模一样的
  // （别的画布用的）⟹ 只查全文的话，把极光那处删掉守卫**照样绿**
  // （反向验证第 7 条：报红 0）。锚点撞名第 4 次，上一次是同一轮里的
  // cancelAnimationFrame —— 所以这里把整组都收窄，而不是只补那一条。
  // ⚠️ 0.9.59 把它改成了通用的 `startAurora(canvasId, opts)` ——
  // 启动页和主界面背景共用一份（用户：「我想给产品一开始那个背景动画
  // 也加到打开软件之后，作为背景」）⟹ 切片的锚跟着改。
  const aurora = dash.slice(dash.indexOf('function startAurora('),
    dash.indexOf("startAurora('launch-particles'"));
  assert.ok(aurora.length > 400, '切不出 startAurora 函数体 ⟹ 下面几条断言全部失效');
  // ⚠️ 两处都要起：启动页（dim 1）+ 主界面背景（dim 更小，否则文字读不清）
  assert.match(dash, /startAurora\('launch-particles', \{ dim: 1 \}\)/,
    '启动页的极光没起');
  assert.match(dash, /startAurora\('app-bg', \{ dim: 0?\.\d+ \}\)/,
    '主界面背景的极光没起，或者 dim 不小于 1（那样文字会被背景干扰）');
  assert.match(aurora, /globalCompositeOperation\s*=\s*'lighter'/,
    "没用 'lighter' 混色 ⟹ 光团只是互相覆盖，缺了极光靠叠加处变亮撑起来的那个观感");
  assert.match(aurora, /ctx\.filter\s*=\s*`blur\(/,
    '没给光团做模糊 ⟹ 是五个硬边色盘，不是柔光');
  // ⚠️ blur 半径要乘 dpr —— ctx.filter 的单位是**设备像素**不是 CSS 像素
  assert.match(aurora, /blur\(\$\{[^}]*dpr[^}]*\}px\)/,
    'blur 半径没乘 dpr ⟹ Retina 上模糊只有一半，光团边缘露出来');
  // ⚠️ 'lighter' 是加法混色 ⟹ 不清屏会几秒内累加成白屏
  assert.match(aurora, /clearRect\(0,\s*0,\s*w,\s*h\)/,
    "极光每帧没清屏，而混色是 'lighter'（加法）⟹ 几秒后整块白屏");
  // ⚠️⚠️ 锚 `cancelAnimationFrame(launchRAF)` 而不是光锚函数名 ——
  // dashboard.js:610 **早就有**一个 `cancelAnimationFrame(handle)`（别的动画用的）
  // ⟹ 只锚函数名的话，把粒子那处删掉守卫**照样绿**（反向验证第 9 条：报红 0）。
  // 这是"锚点撞名"的第 3 次（前两次 `spikes:` 和 `getElementById('audioFollow')`），
  // 前两次撞的是注释/字符串，这次撞的是**别处真实存在的同名调用** —— 更难看出来。
  // ⚠️ 0.9.59：RAF 句柄从单个变量改成**每个 canvas 一个**（auroraRAF 字典）——
  // 共用一个的话进主界面时停启动页那份会把主界面背景也停掉。
  assert.match(dash, /cancelAnimationFrame\(auroraRAF\[canvasId\]\)/,
    '进主界面后没停启动页那份 requestAnimationFrame ⟹ 常驻应用里白烧 CPU');
  assert.match(dash, /const auroraRAF = \{\}/,
    'RAF 句柄不是"每个 canvas 一个" ⟹ 停一份会把另一份也停掉');

  // ④⚠️⚠️ **没有强制等待**（0.9.48）。用户 2026-08-01：
  //   「开局什么强行等待呀，然后什么点击跳过这些都不要…设计上应该是出现主界面，
  //     然后你点一下进去，不用强行让用户等这个时间」
  //
  // 0.9.46 加的那条 2.2s 进度条是**假进度**（我们没有可测的加载阶段），
  // 而代价是每次启动真的等 2.2 秒。⟹ 这几条断言是**反向**的。
  assert.ok(!/setTimeout\(enterApp/.test(dash),
    '又加了自动进入启动页的定时器 ⟹ 用户点名不要强制等待');
  assert.ok(!/launchLoad/.test(html),
    '又加了假进度条动画 ⟹ 我们没有可测的加载阶段，那只是让用户白等');

  // ⑤⚠️⚠️ 骨架层的闸门。0.9.47 用 setTimeout(2600) 挡住"骨架压在启动页上"，
  // 而 0.9.48 撤掉自动进入之后启动页会**停留到用户点击为止**（可能几分钟）
  // ⟹ 定时器挡不住了，必须改成等面板信号。
  assert.match(main, /ipcMain\.handle\('launch-dismissed'/,
    "没有 'launch-dismissed' 通道 ⟹ 骨架层靠定时器建，而启动页会一直等用户点，那个 bug 会回来");
  assert.match(dash, /launchDismissed\?\.\(\)|launchDismissed\(\)/,
    '面板进主界面时没通知主进程 ⟹ 骨架层只能等 20 秒兜底才出现，手势看起来是坏的');
  assert.match(preloadSrc, /launchDismissed:/,
    'preload 没暴露 launchDismissed ⟹ 面板调它是 undefined，信号永远发不出去');
  // ⚠️ 兜底定时器**必须留着** —— 面板 JS 挂了信号永远不来，手势就永久废
  assert.match(main, /overlayGate = setTimeout\(/,
    '骨架层没有兜底定时器 ⟹ 面板 JS 一挂手势就永久不可用（比骨架早出现糟得多）');
  // ⚠️ 放行时要清定时器，否则一切正常也会打出那条 warn
  assert.match(main, /clearTimeout\(overlayGate\)/,
    '放行骨架层时没清兜底定时器 ⟹ 正常情况下也会打出"面板可能挂了"的警告');
});

// ⚠️⚠️ **轮播 UI：摘要行 + 弹窗**（0.9.49）。用户 2026-08-01：
//   「轮播那里改一下，应该是点击一下出一个弹窗，设计时间，轮播时间，
//     顺序/随机等等，正常的轮播逻辑都要有，并且要有预览图，就是一行，
//     肯定放不下，右滑就行了，然后当前播放的哪个壁纸要有显示」
//   +「我下载的壁纸这里不用高亮一类的说正在播放这个，因为在轮播那里会显示」
//
// 上面那条「轮播：列表存路径 / …」守的是**主进程侧**的逻辑，这一轮整块换了
// UI 它照样全绿 —— 那正说明它没在守 UI。这一节补上。
check('轮播 UI：摘要行开弹窗 / 分钟小时 / 横滑预览 / 网格不再高亮', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));

  // ① 摘要行 + 弹窗都在，而旧的常驻控件没了
  assert.match(html, /id="rotate-summary"/, '没有轮播摘要行 ⟹ 面板上没有入口');
  assert.match(html, /id="rotate-modal"[^>]*hidden/,
    '轮播弹窗没有 hidden ⟹ 一开面板它就糊在上面');
  assert.ok(!/id="rotateMinutes"/.test(html),
    '还有旧的 rotateMinutes 常驻输入框 ⟹ 设置应该都在弹窗里');

  // ② 摘要行要能用键盘（它是 role=button tabindex=0 ⟹ 会被 Tab 聚焦，
  //    聚焦了却按不动是最糟的一种）
  assert.match(html, /id="rotate-summary"[\s\S]{0,120}?tabindex="0"/,
    '摘要行不可聚焦 ⟹ 键盘用户到不了轮播设置');
  assert.match(dash, /rotateSummary\.onkeydown/,
    '摘要行没接键盘 ⟹ Tab 能聚焦但回车/空格按不开（比不能聚焦更糟）');

  // ③ 三条关闭路径：✕ / 遮罩 / Esc。少一条都会让人觉得"关不掉"。
  assert.match(dash, /rotate-modal-close'\)\.onclick/, '弹窗没有 ✕ 关闭');
  assert.match(dash, /rotate-modal-mask'\)\.onclick/, '点遮罩关不掉弹窗');
  // ⚠️⚠️ 锚**Esc 那个 handler 的整体**，不用固定长度窗口。
  // 原来写的是 `[\s\S]{0,300}?` —— 0.9.51 把 Esc 改成一个 handler 管两个弹窗
  // （循环 + return 一次只关一个）之后，`closeRotateModal()` 落到了 300 字符外
  // ⟹ 断言在正确代码上报红。**固定长度切片第 9 次**（判据一直是：锚结构边界）。
  const escStart = dash.indexOf("if (e.key !== 'Escape') return;");
  assert.ok(escStart > 0, '没有 Esc 的 handler');
  const escFn = dash.slice(escStart, dash.indexOf('\n});', escStart));
  assert.match(escFn, /closeRotateModal/, 'Esc 关不掉轮播弹窗');
  assert.match(escFn, /closeSettingsModal/, 'Esc 关不掉设置弹窗');
  // ⚠️ 一次只关一个 —— 没有 return 的话两个都开着时会同时关掉两个
  assert.match(escFn, /close\(\); return;/,
    'Esc 的 handler 里没有 return ⟹ 两个弹窗都开着时会一次关掉两个');

  // ④ 分钟/小时：**换算只在 UI 层**，配置里仍然只有 minutes。
  //    存两个字段会引入"120 分钟"和"2 小时"两种表示同一件事的状态，而它们会漂。
  assert.match(dash, /function joinMinutes\s*\(/, '没有单位换算 ⟹ 2 小时要用户填 120');
  assert.match(dash, /setRotate\(\{ minutes: joinMinutes\(/,
    '发给主进程的不是换算后的 minutes ⟹ 主进程侧要跟着改，同一个事实两个来源');
  // ⚠️⚠️ 数值和单位**必须一起算** —— 改单位时数值没变但 minutes 变了
  //    （2 分钟 → 2 小时 = 120）。各自只发自己那半的话，改单位不会生效。
  assert.match(dash, /rotateEvery'\)\.onchange = pushInterval[\s\S]{0,120}?rotateUnit'\)\.onchange = pushInterval/,
    '数值和单位没走同一个入口 ⟹ 改单位不生效（数值没变，但 minutes 变了）');

  // ⑤ 横滑预览条：nowrap + overflow-x 是这个效果的全部
  const strip = html.slice(html.indexOf('#rotate-strip {'));
  assert.match(strip.slice(0, 320), /flex-wrap:\s*nowrap/,
    '预览条没有 flex-wrap: nowrap ⟹ 会换行堆成两排，那就不是"右滑"了');
  assert.match(strip.slice(0, 320), /overflow-x:\s*auto/,
    '预览条不能横向滚动 ⟹ 装不下的壁纸看不到');
  // 正在放的那个在列表里也要标出来（用户点名要"当前播放的哪个壁纸要有显示"）。
  // ⚠️⚠️ 两条规则**都要**查 —— 蓝框（.rs-item.now）和 ▶ 角标
  // （.rs-item.now::before）是这个标记的两半。
  // 第一版只写 `/\.rs-item\.now/`，而那个子串在 `::before` 那条里也有
  // ⟹ 把蓝框那条删掉守卫**照样绿**（反向验证第 11 条：报红 0）。
  // 锚点撞名第 5 次；前几次撞注释、字符串、别处的同名调用，这次撞的是
  // **同一个类名的另一条规则** —— 所以判据是：断言要锚到"规则的完整形状"
  // （选择器 + 花括号），不是类名。
  assert.match(html, /\.rs-item\.now\s*\{/, '预览条里"正在放"没有蓝框');
  assert.match(html, /\.rs-item\.now::before\s*\{/, '预览条里"正在放"没有 ▶ 角标');
  assert.match(dash, /info\.active\)\s*item\.classList\.add\('now'\)/,
    '预览条没标出正在放的那个 ⟹ 用户说的"当前播放的哪个壁纸要有显示"只做了一半');

  // ⑥ 缩略图/标题的数据来自 renderMine 存下的清单，不重扫磁盘 ——
  //    各自扫一次的话，两次之间的差异会让"正在放"和网格对不上。
  assert.match(dash, /lastWallpapers = /, '没有壁纸清单缓存 ⟹ 轮播要自己重扫磁盘');
  assert.match(dash, /lastWallpapers = [\s\S]{0,200}?renderRotate\(\)/,
    'renderRotate 在 lastWallpapers 赋值之前调 ⟹ 摘要行永远显示"—"（我第一版就是这样）');
  // "正在放哪个"只能来自 items 的 active，不能自己用 config.we.dir 判断
  //（那是"上次装载的路径"，壁纸可能已经被卸载了 ⟹ 显示一个没在放的壁纸）
  assert.match(dash, /lastWallpapers\.find\(\(w\) => w\.active\)/,
    '"正在放哪个"不是从 active 标记来的 ⟹ 可能显示一个其实没在放的壁纸');

  // ⑦⚠️ 网格里**不再**给"正在用"加高亮（用户点名撤掉），
  //    但"在播放列表里"的角标要**留着** —— 加/移出发生在网格上，
  //    当场看不到反馈就不知道加成功没有。
  const gridActive = dash.slice(dash.indexOf('if (item.active) {'));
  assert.ok(!/borderColor/.test(gridActive.slice(0, 200)),
    '网格又给"正在用"加边框高亮 ⟹ 和轮播摘要行说的是同一件事（用户点名撤掉）');
  assert.match(dash, /rlist\.includes\(item\.dir\)/,
    '网格没标"在播放列表里" ⟹ 右键加进去之后当场没有反馈');
});

// ⚠️⚠️ **目录行合成一行**（0.9.50）。用户 2026-08-01：
//   「{{扫存储目录里所有含 project.json 的壁纸…}}这句话删掉，然后
//     我的壁纸目录：… / 打开 / 换目录… / 6 个壁纸，其中 4 个能跑
//     这个应该一行，现在是两行」
check('目录行：一行装完 / 计数不写死 0 / 状态行只报异常', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));

  // ① 那句讲实现的 lead 不许回来（它说的是我们怎么扫，而用户在这一页要挑壁纸）
  assert.ok(!/扫存储目录里所有含/.test(html.replace(/<!--[\s\S]*?-->/g, '')),
    '「扫存储目录里所有含 project.json…」那句 lead 又回来了（用户点名删掉）');

  // ② 计数必须画在**目录行**里，不能再写回 mine-state（那会变成第二行）
  // ⚠️ 「能跑」那个说法 0.9.57 去掉了（用户：「"能跑"的这种描述不需要」）
  // ⟹ 断言改成"计数还在"，而不是"用了某个具体的词"。
  //（这一轮第 5 次改这类断言：写的是当时那个字，不是意图。）
  assert.match(dash, /lastMineCount\.total\} 个/, '目录行的计数不见了');
  assert.ok(!/个能跑/.test(dash),
    '「N 个能跑」又回来了 ⟹ 用户点名不要（"这张放不了"的信息在卡片上）');
  // ⚠️⚠️ 锚**完整的赋值形状**，不是变量名。
  // 第一版写的是 `/lastMineCount/`（只查名字在不在这个切片里）——
  // 而把渲染条件改成 `if (false)` 之后那个名字**还在**（声明、注释、别的引用）
  // ⟹ 计数不画了但守卫照样绿（反向验证第 2 条：报红 0）。
  // 这是"锚点太弱"的第 6 次 ⟹ 判据：断言要锚到**产生效果的那一句**。
  const dirFn = dash.slice(dash.indexOf('function renderMineDirs'));
  assert.match(dirFn.slice(0, 3000),
    /if \(lastMineCount\) \{[\s\S]{0,200}?countEl\.textContent = `\$\{lastMineCount\.total\}/,
    '计数没画进目录行 ⟹ 它还在 mine-state 里，那就是第二行（用户点名要一行）');
  assert.match(dirFn.slice(0, 3000), /box\.append\(countEl\)/,
    '计数那一截没 append 进目录行的容器 ⟹ 建了但不显示（本项目第七次"做了但看不到"）');
  assert.ok(!/state\.textContent = `\$\{result\.items\.length\} 个壁纸/.test(dash),
    '计数又写回 mine-state ⟹ 目录行和计数会变成两行');

  // ③⚠️⚠️ 赋值必须在 renderMineDirs() **之前** —— 它读这个变量来画那一截。
  //    放后面的话第一次渲染没有计数，要等下一次刷新才出现（不报错，只是"少了点东西"）。
  const mineFn = dash.slice(dash.indexOf('async function renderMine()'),
    dash.indexOf('// ⚠️ mine-state 现在只用来报'));
  assert.ok(mineFn.indexOf('lastMineCount = {') < mineFn.indexOf('renderMineDirs()'),
    'lastMineCount 在 renderMineDirs() 之后才赋值 ⟹ 第一次渲染看不到计数');

  // ④⚠️ 空列表那支也要设计数 —— 不设的话会沿用上一次的数字，
  //    显示一个不存在的计数（比显示 0 更糟：它看起来是对的）。
  assert.match(dash, /total: \(result\.ok && result\.items\) \? result\.items\.length : 0/,
    '计数没兜住 result.ok 为假的情况 ⟹ 扫描失败时沿用上一次的数字');
  // ⚠️ 但**初值**必须是 null 而不是 0 —— "还没扫"和"0 个壁纸"是两件事
  assert.match(dash, /let lastMineCount = null/,
    'lastMineCount 初值不是 null ⟹ 还没扫完就显示"0 个"，看起来像目录是空的');

  // ⑤ 按钮文案（用户点名叫「更换目录」）
  assert.match(dash, /change\.textContent = '更换目录'/,
    '「更换目录」按钮改名了 ⟹ 用户点名要这个文案');
});

// ⚠️⚠️ **设置弹窗**（0.9.51）。用户 2026-08-01：
//   「我有个很棒的设想，左下方来个齿轮按钮是设置，设置打开后弹窗，
//     这个弹窗里有{{我的壁纸目录：… 打开 更换目录 6 个，4 个能跑}}
//     以及之前的开发者选项」
check('设置弹窗：齿轮入口 / 目录行和开发者选项都在里面 / 撤 dev 不带走目录', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));

  // ① 齿轮在 nav 里（左下角），弹窗默认 hidden
  const nav = html.slice(html.indexOf('<nav>'), html.indexOf('</nav>'));
  assert.match(nav, /id="settings-open"/, '齿轮按钮不在 nav 里 ⟹ 左下角没有入口');
  assert.match(html, /id="settings-modal"[^>]*hidden/,
    '设置弹窗没有 hidden ⟹ 一开面板它就糊在上面');

  // ②⚠️⚠️ 目录行和开发者模块都要在**弹窗里**，而不在「我的壁纸」页签里。
  const smAt = html.indexOf('id="settings-modal"');
  const mineAt = html.indexOf('id="tab-mine"');
  const mineEnd = html.indexOf('</section>', mineAt);
  assert.ok(smAt > 0 && mineAt > 0, '找不到设置弹窗或「我的壁纸」页签');
  const dirsAt = html.indexOf('id="mine-dirs"');
  assert.ok(dirsAt > smAt, '目录行不在设置弹窗里（用户点名搬进去）');
  assert.ok(!(dirsAt > mineAt && dirsAt < mineEnd),
    '目录行还在「我的壁纸」页签里 ⟹ 那一页又有一半不是壁纸');
  assert.ok(html.indexOf('DEV-PANEL-START') > smAt,
    '开发者模块不在设置弹窗里（用户点名搬进去）');

  // ③⚠️⚠️ **目录行必须在 dev marker 之外** —— 两块现在都在同一个弹窗里，
  //    很容易不小心把目录行圈进 marker，而那样"撤掉开发者模块"会**连目录行一起删**
  //    （撤掉之后用户再也找不到"我的壁纸在哪"）。
  //    上面那条「开发者模块物理隔离」已经在查 mine-dirs 不在 devHtml 里，
  //    这里再直接查一次位置关系 —— 那是这次搬动引入的新风险，值得两道。
  const ds = html.indexOf('DEV-PANEL-START');
  const de = html.indexOf('DEV-PANEL-END');
  assert.ok(!(dirsAt > ds && dirsAt < de),
    '目录行被圈进 DEV-PANEL marker 了 ⟹ 撤掉开发者模块会连目录行一起删');

  // ④ 三条关闭路径 + 打开时重扫
  assert.match(dash, /settings-open'\)\.onclick = openSettingsModal/, '齿轮没接开弹窗');
  assert.match(dash, /settings-modal-close'\)\.onclick/, '设置弹窗没有 ✕ 关闭');
  assert.match(dash, /settings-modal-mask'\)\.onclick/, '点遮罩关不掉设置弹窗');
  // ⚠️ 打开时要 renderMine() 而不是 renderMineDirs() —— 后者不重扫，
  //   计数（"6 个，4 个能跑"）不会更新，而用户可能刚在 Finder 里加删过壁纸。
  const openFn = dash.slice(dash.indexOf('function openSettingsModal'),
    dash.indexOf('function closeSettingsModal'));
  assert.match(openFn, /renderMine\(\)/,
    '打开设置时没重扫 ⟹ 目录行里的计数是旧的（用户刚在 Finder 里加了壁纸也看不到）');

  // ⑤ 那句讲实现的提示不许回来
  assert.ok(!/装载壁纸后，这里会按它的 project\.json 自动生成/
    .test(html.replace(/<!--[\s\S]*?-->/g, '')),
    '「装载壁纸后，这里会按它的 project.json 自动生成」又回来了（用户点名删掉）');
});

// ⚠️⚠️ **诊断全部收进设置弹窗的开发者模块**（0.9.52）。用户 2026-08-01：
//   工坊那五行（标题/路径/⏳ready/这个壁纸要音频/✅N 项属性已送到）「删掉」
//   +「最后是诊断{{导出诊断报告…}}这个也收到设置的弹窗里」
//   +「手势那块的诊断也收到设置的弹窗界面」
//
// ⚠️ 上一轮搬东西时三条旧守卫在正确代码上报红（断言写的是"当时那个位置"），
// 而这一轮搬了三块**一条都没红** —— 那正说明没人守这些。这一节补上。
check('诊断都在开发者模块里，不散在功能页上', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));

  const ds = html.indexOf('DEV-PANEL-START');
  const de = html.indexOf('DEV-PANEL-END');
  assert.ok(ds > 0 && de > ds, '找不到 DEV-PANEL marker');

  // ①⚠️⚠️ 这三块必须在 marker 之间 —— 散在外面的话"撤掉开发者模块"会留下
  //    孤儿元素，而 JS 里那些 getElementById 拿到 null 就是 null.onclick 崩溃
  //   （这个项目为"删 UI 留调用"栽过三次）。
  for (const [name, id] of [
    ['壁纸状态', 'we-state'],
    ['导出诊断报告', 'diag-export'],
    ['打开报告目录', 'diag-reveal'],
    ['骨架几何（手势诊断）', 'overlay-geom'],
    ['心跳（手势诊断）', 'heartbeat'],
    ['匹配诊断（手势诊断）', 'match-probe'],
  ]) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > 0, `${name}（#${id}）不见了 —— 那是出问题时唯一的观测手段`);
    assert.ok(at > ds && at < de,
      `${name}（#${id}）不在开发者模块里 ⟹ 它又常驻在功能页上了（用户点名收进设置）`);
  }

  // ②⚠️ 而那三块**不许出现在功能页的 section 里** —— 只查 marker 位置不够：
  //   HTML 里同一个 id 出现两次的话，上面那条查到的可能是模块里那份，
  //   而功能页上还留着一份（重复显示，而且 getElementById 只拿到第一个）。
  for (const id of ['we-state', 'diag-export', 'overlay-geom']) {
    const n = (html.match(new RegExp(`id="${id}"`, 'g')) || []).length;
    assert.strictEqual(n, 1, `#${id} 在 HTML 里有 ${n} 份 ⟹ 重复显示，而且只有第一份会被绑上`);
  }

  // ③ 工坊页只剩"找壁纸"：不许再有壁纸状态和诊断
  const weAt = html.indexOf('id="tab-we"');
  const weSection = html.slice(weAt, html.indexOf('</section>', weAt));
  assert.ok(!weSection.includes('<h3>诊断</h3>'),
    '创意工坊页又有「诊断」小节 ⟹ 那一页只该管"找壁纸"');
  // 手势页同理
  const gesAt = html.indexOf('id="tab-gesture"');
  const gesSection = html.slice(gesAt, html.indexOf('</section>', gesAt));
  assert.ok(!gesSection.includes('<h3>诊断</h3>'),
    '手势页又有「诊断」小节 ⟹ 用户点名收进设置弹窗');

  // ④⚠️ 搬完之后 JS 里的引用要都还在（"搬完点了没反应"是这次搬动的头号风险）。
  //   ⚠️ 光查 HTML 有这个 id 不够 —— 元素在但没人绑，按钮就是死的。
  for (const id of ['diag-export', 'diag-reveal']) {
    assert.match(dash, new RegExp(`getElementById\\('${id}'\\)`),
      `#${id} 搬过去之后 JS 里没人绑 ⟹ 按钮点了没反应`);
  }
});

// ⚠️⚠️ **创意工坊的筛选/排序**（0.9.52 修了两个 bug）。
check('工坊：排序按钮的选中状态会更新 / 多选取并集 / 没有分辨率组', () => {
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));

  // ⚠️⚠️ 措辞：**「暂不支持」而不是「放不了」**（0.9.53，用户点名）。
  // 「放不了」听起来像"坏了/不行"，而这是**我们还没做**（scene 类要另一套渲染管线）
  // ⟹ 说清是谁的限制，而且留出"以后会有"的余地。
  // ⚠️ 两处都要（筛选按钮 + 卡片），而且**反向**锁住旧词 —— 改回去不报错。
  assert.ok(!/放不了/.test(dash),
    '又用回「放不了」⟹ 那听起来像坏了，而这是我们还没做（用户点名改成「暂不支持」）');
  assert.match(dash, /\$\{t\.label\}（暂不支持）/,
    '筛选按钮上不支持的类型没标「暂不支持」');
  assert.match(dash, /\$\{item\.type\}·暂不支持/,
    '卡片上不支持的类型没标「暂不支持」');

  // ①⚠️⚠️ 用户 2026-08-01 报：「你的几个标签及其热门 最新发布这些只有近期热门
  //    一直显示选中的状态，点其他的也能生效，但是 ui 的设计还是近期热门有个蓝框选中」
  //
  // 根因：`className = s.id === browse.sort ? 'on' : ''` 在**渲染时**算，
  // 而 onclick 只改了 browse.sort + runBrowse()（那只重画网格）
  // ⟹ 按钮的 class 停在第一次渲染的样子。
  // ⚠️ 锚到**排序那个 onclick 的函数体**（切到 sortHost 那段），不查全文 ——
  //   下面筛选组的 onclick 里也有 renderBrowseControls(meta)，
  //   查全文的话把排序那处删掉也不报（锚点撞名，这个项目已经栽过 6 次）。
  const sortBlock = dash.slice(dash.indexOf("const sortHost = document.getElementById('br-sorts')"),
    dash.indexOf("const host = document.getElementById('br-filters')"));
  assert.ok(sortBlock.length > 200, '切不出排序按钮那段 ⟹ 下面的断言失效');
  assert.match(sortBlock, /browse\.sort = s\.id/, '排序按钮不改 browse.sort');
  assert.match(sortBlock, /renderBrowseControls\(meta\)/,
    '排序按钮点了不重渲染这一排 ⟹ 蓝框永远停在初始那个（用户报的原始症状）');

  // ② 筛选组那边本来就有，别改坏了
  const filterBlock = dash.slice(dash.indexOf("const host = document.getElementById('br-filters')"));
  assert.match(filterBlock.slice(0, 1600), /renderBrowseControls\(meta\)/,
    '筛选标签点了不重渲染 ⟹ 蓝框不跟着变');
});

// ⚠️⚠️ **package.json 的版本号要跟得上代码里提到的最新版本**。
//
// 起因（2026-08-01）：我在 0.9.45~0.9.53 一路写注释和 commit 说"0.9.4x 改了什么"，
// 而 `package.json` **一直停在 0.9.44** ⟹ 用户每次打包出来的 dmg 都叫
// `GestureWall-0.9.44-arm64.dmg`，面板上的 build 标识也是 v0.9.44。
//
// 后果不是"数字不好看"：**它是用户唯一能确认"我装的是哪一版"的东西**。
// 这一轮已经因此浪费过一整轮 —— 用户报"没看出变化"，而真相是我 commit 了没 push，
// 那次靠 commit hash 才分辨出来。版本号本该是第一道。
//
// ⚠️ 判据不是"必须等于某个值"（那样每次改版本都要改测试），
// 而是"**代码里出现的最大版本号 ≤ package.json 的版本号**"。
check('package.json 的版本号不落后于代码注释里提到的版本', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const cur = String(pkg.version || '');
  assert.match(cur, /^\d+\.\d+\.\d+$/, `package.json 的版本号不是 x.y.z：${cur}`);

  // 扫源码里所有 `0.9.NN` 形式的版本号（注释里写的"（0.9.49）"那种）
  const files = ['src/main.js', 'src/dashboard.js', 'src/dashboard.html',
    'src/workshop.js', 'src/we-host.js'];
  let maxSeen = null;
  let maxWhere = '';
  const toNum = (v) => v.split('.').map(Number)
    .reduce((acc, n) => acc * 10000 + n, 0);
  for (const rel of files) {
    const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    for (const m of text.matchAll(/\b(\d+\.\d+\.\d+)\b/g)) {
      const v = m[1];
      // ⚠️ 只看 0.9.x —— 源码里还有别的三段数字（比如 macOS 14.2、
      //   Electron 版本、色值不会但尺寸可能）。写死这个前缀比"猜哪些是版本号"可靠。
      if (!v.startsWith('0.9.')) continue;
      if (maxSeen === null || toNum(v) > toNum(maxSeen)) { maxSeen = v; maxWhere = rel; }
    }
  }
  assert.ok(maxSeen, '源码里一个 0.9.x 版本号都没找到 ⟹ 这条断言失效了');
  assert.ok(toNum(cur) >= toNum(maxSeen),
    `package.json 是 ${cur}，而 ${maxWhere} 里已经在说 ${maxSeen} ⟹ `
    + '打包出来的 dmg 和面板 build 标识都会是旧版本号，'
    + '而那是用户唯一能确认"我装的是哪一版"的东西');
});

// ⚠️⚠️ **顶部 tab + 网格/详情两列**（0.9.54）。用户 2026-08-01 给了
// Wallpaper Engine 的界面截图：「我感觉我们也应该应用这种，我们现在的布局
// 左侧的菜单栏，右侧展示，太 dashboard 了，这个图我看菜单是在左上角，
// 右边那个就是你点击了哪个壁纸，他的预览图和参数信息」+「装载加显示壁纸参数」
check('布局：顶部 tab / 两列 / 右侧详情 / 滚动归网格列', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));

  // ① body 是"上下两行"（tab 条 + 内容），不是"左右两列"
  const body = html.slice(html.indexOf('  body {'), html.indexOf('}', html.indexOf('  body {')));
  assert.match(body, /grid-template-rows/,
    'body 不是"tab 条 + 内容"两行布局 ⟹ 左侧竖栏又回来了（用户点名太 dashboard）');
  assert.ok(!/grid-template-columns:\s*176px/.test(body),
    'body 又是左栏 176px + 内容 ⟹ 940px 窗口里网格只剩 ~420px（两列卡片）');

  // ②⚠️⚠️ **hiddenInset 的红绿灯让位**：tab 条要同时让出上方和左方。
  //    少了横向那份，第一个 tab 会跑到红绿灯底下（点不动，看起来像 tab 坏了）。
  const nav = html.slice(html.indexOf('  nav {'), html.indexOf('}', html.indexOf('  nav {')));
  // ⚠️ `0` 可以不带单位（CSS 里 `padding: 40px 16px 0 96px` 是合法的）
  //   ⟹ 正则不能要求每个值都带 px，否则读不到而"断言失效"（我第一版就是）。
  const pad = nav.match(/padding:\s*(\d+)(?:px)?\s+(\d+)(?:px)?\s+(\d+)(?:px)?\s+(\d+)(?:px)?/);
  assert.ok(pad, `nav 的 padding 不是四值形式，读不到让位量：${nav.slice(0, 120)}`);
  // ⚠️⚠️ **纵向和横向的约束不一样**（0.9.58）：
  //
  // 0.9.58 起红绿灯**默认藏着**（setWindowButtonVisibility(false)，
  // 鼠标移到顶部才出现）⟹ **纵向不需要给它让位了** ——
  // 用户报过两次"上方有突兀的空白"（40px → 30px → 现在 10px）。
  // ⟹ 纵向只查上界：多让就是空白。
  //
  // ⚠️ 但**横向必须留着** —— 红绿灯出现时占 x=13..70，
  // tab 从 x=16 开始的话它们会**压在第一个 tab 上** ⟹ 那个 tab 点不动
  //（而症状是"这个 tab 坏了"）。
  // ⟹ 判据：**藏起来能省掉纵向让位，但省不掉横向** —— 它出现时仍然要有位置。
  //   我改的时候差点把两个方向一起收掉。
  assert.ok(Number(pad[1]) <= 16,
    `nav 顶部让了 ${pad[1]}px ⟹ 红绿灯默认藏着，不需要让位，多出来的是空白（用户报过两次）`);
  assert.ok(Number(pad[4]) >= 80,
    `nav 左侧只让了 ${pad[4]}px ⟹ 红绿灯出现时会压在第一个 tab 上（那个 tab 点不动）`);
  // titleBarStyle 和这个让位是成对的
  // ⚠️ 0.9.58 起是 `hidden`（红绿灯藏起来），而横向让位仍然必需
  //（它出现时占 x=13..70）⟹ 这条只确认"标题栏是我们自己画的"。
  assert.match(codeOnly(mainSrc), /titleBarStyle:\s*'hidden(?:Inset)?'/,
    '不用自定义标题栏了但 nav 还在给红绿灯让位 ⟹ 那 96px 就是白留的');

  // ③⚠️⚠️ **滚动必须在网格列上，不在 main 上**。
  //    main 滚的话右侧详情面板会跟着滚出视野 —— 而"钉住"正是这个布局的全部意义。
  const main = html.slice(html.indexOf('  main {'), html.indexOf('}', html.indexOf('  main {')));
  assert.match(main, /overflow:\s*hidden/,
    'main 自己在滚 ⟹ 右侧详情面板会跟着滚走（那就白改了这个布局）');
  // ⚠️⚠️ `overflow-y: auto` **不够** —— 它只在高度受限时才产生滚动条。
  // 用户报「手势录制这个界面不能滑动了」，根因：
  //   · 在 `.split`（grid）里，.pane-grid 是 grid 项 ⟹ 被隐式拉伸 ⟹ 能滚
  //   · 而手势页里它直接在 `section`（display: block）下 ⟹ 高度按内容走
  //     ⟹ overflow 无从触发 ⟹ 内容被 `main { overflow: hidden }` 裁掉
  // ⟹ 必须显式 `height: 100%`。
  // ⚠️ 而这正是 0.9.54 那次改布局的漏洞：守卫只查了"手势页有没有 .pane-grid"
  //   （见下面第 ④ 条），而 class 在、能不能滚是两件事。
  assert.match(html, /\.pane-grid\s*\{[^}]*overflow-y:\s*auto/,
    '网格列不能滚 ⟹ 壁纸多了就看不到后面的');
  assert.match(html, /\.pane-grid\s*\{[^}]*height:\s*100%/,
    '.pane-grid 没有 height: 100% ⟹ 在非 grid 父容器下（手势页）高度按内容走，'
    + 'overflow 不触发 ⟹ 那一页滚不动、下半截被裁掉（不报错）');
  // ⚠️ min-height:0 —— flex/grid 子项默认 min-height:auto ⟹ 内容再高也不出滚动条，
  //   而是把父容器撑破（"滚不动、整页被撑长"的经典成因）。三处都要。
  for (const [sel, re] of [
    ['section', /section\s*\{[^}]*min-height:\s*0/],
    ['.split', /\.split\s*\{[^}]*min-height:\s*0/],
    ['.pane-grid', /\.pane-grid\s*\{[^}]*min-height:\s*0/],
  ]) {
    assert.match(html, re, `${sel} 少了 min-height: 0 ⟹ 滚动条不出现，父容器被撑破`);
  }

  // ④ 三个 section 都要有能滚的容器（手势页没有两列模型，但也不能被截断）
  for (const id of ['tab-mine', 'tab-we', 'tab-gesture']) {
    const at = html.indexOf(`id="${id}"`);
    const sec = html.slice(at, html.indexOf('</section>', at));
    assert.match(sec, /class="pane-grid"/,
      `#${id} 里没有 .pane-grid ⟹ main 不滚了，这一页的内容会被直接截断（不报错）`);
  }

  // ⑤ 两页各有右侧详情面板，且**空态要说清"点左边"**（空白的右半屏看起来像坏了）
  for (const [page, emptyId, bodyId] of [
    ['我的壁纸', 'mine-side-empty', 'mine-side-body'],
    ['创意工坊', 'we-side-empty', 'we-side-body'],
  ]) {
    assert.ok(html.includes(`id="${emptyId}"`), `${page}的详情面板没有空态`);
    assert.match(html, new RegExp(`id="${bodyId}"[^>]*hidden`),
      `${page}的详情内容没有 hidden ⟹ 一开面板就是个空壳`);
  }

  // ⑥⚠️⚠️ 点卡片的行为：**我的壁纸 = 装载 + 显示参数**（用户原话「装载加显示壁纸参数」），
  //    而**创意工坊 = 只看详情，不下载**（几百 MB 的误点很贵）。两边不同是有意的。
  const mineFn = dash.slice(dash.indexOf('async function renderMine()'));
  assert.match(mineFn.slice(0, 4000), /renderMineSide\(item\)[\s\S]{0,200}?workshopLoadLocal/,
    '点「我的壁纸」的卡片没有"先填详情再装载" ⟹ 点正在放的那张时右侧不更新');
  const browseFn = dash.slice(dash.indexOf('async function runBrowse()'));
  assert.match(browseFn.slice(0, 3000), /renderWeSide\(picked\)/,
    '点工坊卡片不填右侧详情面板');
  assert.ok(!/workshopDownload/.test(browseFn.slice(0, 3000)),
    '点工坊卡片就直接下载了 ⟹ 几百 MB 的误点很贵（下载要走面板上那个明确的按钮）');

  // ⑦⚠️ 参数只对**正在放的那个**有意义 —— weControls() 读的是当前装载的壁纸，
  //    不是"某个目录的 project.json" ⟹ 点的不是当前那张时不能显示参数，
  //    否则显示的是**别的壁纸的参数**（最难发现的一种错）。
  const sideFn = dash.slice(dash.indexOf('function renderMineSide'),
    dash.indexOf('function renderWeSide'));
  assert.match(sideFn, /if \(item\.active\) \{[\s\S]{0,160}?renderWEControls\(\)/,
    '不管是不是正在放都渲染参数 ⟹ 会显示别的壁纸的参数');

  // ⑧⚠️⚠️ **窗口初始尺寸按屏幕算，不写死**（0.9.55）。用户：「产品打开的初始大小
  //    改一下吧，左侧展示面太小了」—— 940 宽下网格只剩 560px（三列卡片），
  //    而壁纸墙的价值就在于一眼看到很多张。
  //    但写死 1280 会在小屏上被 macOS **夹回可见区** ⟹ 打开就贴满屏幕（比小窗更糟）。
  const win = codeOnly(mainSrc).slice(codeOnly(mainSrc).indexOf('dashboardWindow = new BrowserWindow'));
  assert.ok(!/width:\s*\d{3,4},/.test(win.slice(0, 400)),
    '面板窗口又写死了宽度 ⟹ 小屏上会被 macOS 夹回可见区（打开就贴满屏幕）');
  assert.match(codeOnly(mainSrc), /const winW = Math\.min\(\d+, Math\.round\(workAreaSize\.width/,
    '窗口宽度没按屏幕工作区算');
  // ⚠️ 必须用 workAreaSize 而不是 bounds —— 后者含菜单栏和 Dock 占的那部分，
  //   按它算出来的窗口会有一截在 Dock 底下。
  assert.ok(!/const \{ bounds \} = screen\.getPrimaryDisplay\(\);\s*\n\s*const winW/
    .test(codeOnly(mainSrc)),
    '用 bounds 算面板尺寸 ⟹ 窗口会有一截在 Dock 底下（要用 workAreaSize）');
  // ⚠️ media query 的阈值要**小于** minWidth，否则拖到边缘时两列⇄一列反复跳
  const mw = Number((codeOnly(mainSrc).match(/minWidth:\s*(\d+)/) || [])[1]);
  const mq = Number((html.match(/@media \(max-width:\s*(\d+)px\)/) || [])[1]);
  assert.ok(mw > 0 && mq > 0, `读不到 minWidth(${mw}) 或 media query 阈值(${mq}) ⟹ 断言失效`);
  assert.ok(mq < mw,
    `media query 阈值 ${mq} ≥ minWidth ${mw} ⟹ 拖到窗口边缘时两列⇄一列反复跳`);

  // ⑨ openExternal 三端接线（「在 Steam 打开」按钮）+ 主进程要校验协议
  assert.match(dash, /window\.gw\.openExternal\(/, '右侧面板用了 openExternal');
  assert.match(codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8')),
    /openExternal:/, 'preload 没暴露 openExternal ⟹ 那个按钮点了抛 TypeError');
  assert.match(codeOnly(mainSrc), /ipcMain\.handle\('open-external'/,
    'main 没注册 open-external');
  // ⚠️⚠️ **必须校验协议** —— shell.openExternal 对 file:// 和自定义 scheme 也会执行，
  //   而这里的 URL 来自 Steam 接口返回（不是我们完全控制的输入）。
  assert.match(codeOnly(mainSrc), /u\.protocol !== 'http:' && u\.protocol !== 'https:'/,
    "open-external 没校验协议 ⟹ file:// 能打开本机任意文件、自定义 scheme 能唤起别的应用");
});

// ⚠️⚠️ **搬进 340px 面板的区块，横向布局要重新审**（0.9.56）。
// 用户 2026-08-01 贴了截图：「创意工坊这里你可以看到这里的渲染是有问题的」——
// `#ws-peek-card` 的文字被压成一列竖排单字。
//
// 根因：它原来是 `display: flex` 横排三段（图 160px + 文字 flex:1 + 按钮竖列），
// 那是给**页面正文**（宽约 590px）设计的。0.9.54 把它搬进右侧详情面板
// ⟹ 可用宽度 ~300px：160 图 + 90 按钮列 ⟹ 文字只剩 ~40px ⟹ 每行放不下两个汉字。
//
// ⚠️ 这和 0.9.54 那次"搬完要跑 DOM 引用全检"是同一类教训：
//    **搬动会让原来成立的假设失效，而症状不是报错。**
check('340px 面板里的区块：预览卡片已撤 / 输入框通栏 / 贴 ID 那条路保留', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  const dash2 = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));

  // ①⚠️⚠️ `.ws-card`（「看看是什么」的预览卡片）**0.9.57 整块删了** ——
  //    用户：「也不用再弹一下这个预览图了，本身点击了创意工坊的壁纸
  //    不就已经展示了预览图了」⟹ 右侧详情面板已经在显示预览图。
  //
  // ⚠️ 值得记一笔：0.9.56 我刚花力气把它从横排改成竖排（用户报"渲染有问题"），
  //    而下一轮它就被删了。⟹ **用户报某块"看起来不对"时，先问"这块还需要吗"** ——
  //    有时答案是删掉，那比修好它省一整轮。
  // ⟹ 断言翻成**反向**：整套 CSS 和那个元素都不许回来（回来就是死代码 +
  //    同一个壁纸两张预览图）。
  assert.ok(!/\.ws-card/.test(html.replace(/\/\*[\s\S]*?\*\//g, '')),
    '.ws-card 的样式又回来了 ⟹ 那个预览卡片删了，留着就是死代码');
  assert.ok(!/id="ws-peek-card"/.test(html),
    '「看看是什么」的预览卡片又回来了 ⟹ 会出现同一个壁纸两张预览图');
  assert.ok(!/id="ws-peek"/.test(html), '「看看是什么」按钮又回来了（用户点名不需要）');
  assert.ok(!/id="ws-id"/.test(html),
    'ID 输入框又回来了 ⟹ ID 是点卡片自动来的（用户：「id 号也不用现在这样的文本框显示」）');
  // ⚠️ 而"贴 ID/链接"那条路**必须保留**（用户拍的方案：搜索框兼容）
  assert.match(dash2, /function looksLikeWorkshopId/,
    '搜索框不认 ID 了 ⟹ 删掉输入框之后"别人发我一个 ID"这条路就断了');
  assert.match(dash2, /workshopDetails\(q\)/,
    '搜索框认出 ID 但没走 workshopDetails ⟹ 会把 ID 当关键词去搜');
  assert.match(html, /placeholder="[^"]*ID/,
    '搜索框的 placeholder 没提能贴 ID ⟹ 用户不会知道（那条路没有别的入口）');

  // ②⚠️⚠️ 面板里的输入框要**通栏**（独占第二行），否则被挤成一条。
  //    用户截图里「密码」那行就是：placeholder 贴在右边缘。
  //    根因：那条选择器原来是按类型枚举的（range/select/text），**漏了 password**。
  //    ⟹ 改成反向排除 `:not([type=checkbox])`，加新类型时不用回来改。
  const rule = html.match(/\.pane-side \.we-row > input[^{]*\{[^}]*\}/);
  assert.ok(rule, '找不到"面板里的输入框通栏"那条规则');
  assert.match(rule[0], /input:not\(\[type=checkbox\]\)/,
    '面板里的输入框还在按类型枚举（range/text/…）⟹ 一定会漏（password 就漏过）'
    + '，改成 :not([type=checkbox]) 反向排除');
  assert.match(rule[0], /grid-column:\s*1 \/ -1/,
    '输入框没有通栏 ⟹ 在 `1fr auto` 的第二列里被压成一条');
});

// ⚠️⚠️ **红绿灯默认藏着，鼠标移到顶部才出现**（0.9.58）。用户 2026-08-01：
//   「mac 的红绿灯不能做成隐藏的吗…我鼠标在顶部想要点再显示呗，
//     很多的产品都是这样设计的，而已一开始的 gesturewall 那个界面，
//     左上角突兀的红绿灯真的很违和」
check('红绿灯：默认藏 / 顶部悬停才显 / 三端接线 / 只在状态变化时发', () => {
  const main = codeOnly(mainSrc);
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  const pre = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8'));

  // ① 三端接线（少一端就是"藏了但再也显不出来" —— 那时候用户找不到关闭按钮）
  assert.match(main, /setWindowButtonVisibility\(false\)/, '建窗口时没藏红绿灯');
  assert.match(main, /ipcMain\.handle\('title-bar-hover'/, 'main 没注册显隐通道');
  assert.match(pre, /titleBarHover:/, 'preload 没暴露 titleBarHover');
  assert.match(dash, /titleBarHover\?\.\(|titleBarHover\(/, '面板没调 titleBarHover');

  // ②⚠️⚠️ `setWindowButtonVisibility` 是 **macOS 专用**，别的平台上调会抛。
  //    而这里是在 `new BrowserWindow` 之后、`loadFile` 之前 ⟹ 抛了会让窗口白屏。
  assert.match(main, /try \{\s*\n\s*dashboardWindow\.setWindowButtonVisibility\(false\)/,
    'setWindowButtonVisibility 没被 try 包住 ⟹ 非 macOS 上会抛，把 loadFile 挡在后面（白窗口）');

  // ③ 只在状态**变化**时发 IPC —— 每次 mousemove 都发的话，
  //    移动鼠标就是每秒几十次跨进程调用。
  const zone = dash.slice(dash.indexOf('const ZONE ='));
  assert.ok(zone.length > 200, '找不到红绿灯悬停那段');
  // ⚠️ 0.9.59 重写了这段（见下面 ⑤）⟹ 断言跟着改成新的形状。
  assert.match(zone, /if \(shown\) return/,
    '每次进入顶部都发 IPC ⟹ 移动鼠标就是每秒几十次跨进程调用');
  // ⚠️ 鼠标移出窗口 / 窗口失焦都要处理
  assert.match(zone, /mouseleave/, '鼠标移出窗口时没处理 ⟹ 红绿灯停在显示状态');
  assert.match(zone, /'blur'/, '窗口失焦时不藏');

  // ⑤⚠️⚠️ **隐藏必须有延迟**（0.9.59 修的核心 bug）。用户报：
  //   「我真的要去点击红绿灯，反而隐藏了，点不了」
  //
  // 根因：红绿灯是**原生窗口按钮**，不在网页里 ⟹ 鼠标真的移到它们上面时，
  // 网页收到的是 `mouseleave`（指针离开了文档区域）⟹ 旧代码立刻 setShown(false)
  // ⟹ **按钮在用户要点的那一刻消失**。
  // ⟹ 判据：**藏起来必须有延迟，而且"贴着顶部离开文档"要算成"还在顶部"。**
  // ⚠️⚠️ 锚**定义**而不是名字 —— `HIDE_DELAY` 和 `cancelHide` 各出现两三次
  //（定义 + 使用），只查名字的话把**定义**改掉守卫照样绿
  //（反向验证第 2、4 条都是这样：报红 0）。
  // "锚点太弱"第 7 次 ⟹ 判据还是那条：**锚产生效果的那一句**，
  // 而对一个常量/函数来说，那就是它的**声明**。
  assert.match(zone, /const HIDE_DELAY = \d+/,
    '隐藏没有延迟 ⟹ 鼠标移到原生按钮上时网页收到 mouseleave，按钮会在要点的那一刻消失');
  assert.match(zone, /function scheduleHide\(\)/, '没有延迟隐藏的机制');
  assert.match(zone, /function cancelHide\(\)/, '没有取消延迟隐藏的机制');
  // ⚠️ 而且 show() 里**必须**调它 —— 不调的话延迟就白设了（500ms 后照样藏）
  assert.match(zone, /function show\(\) \{\s*\n\s*cancelHide\(\)/,
    'show() 里不取消待执行的隐藏 ⟹ 回到顶部也会在 500ms 后被藏掉');
  // ⚠️ 从顶部离开文档（去点原生按钮）不能藏
  assert.match(zone, /mouseleave[\s\S]{0,200}?clientY <= ZONE\) return/,
    '从顶部离开文档时也藏 ⟹ 那正是"伸手去点按钮，按钮跑了"的路径');

  // ④ 判定区不能太大 —— 整个 tab 条都算的话，点 tab 时红绿灯会跟着冒出来，
  //    而那正是用户抱怨的「我有点什么操作，这个红绿灯就显示出来」。
  const z = Number((dash.match(/const ZONE = (\d+)/) || [])[1]);
  assert.ok(z > 0, '读不到 ZONE ⟹ 断言失效');
  // ⚠️⚠️ 上界从 70 收到 **40**（0.9.59）。用户报：
  //   「我发现现在是在"我的壁纸，创意工坊"这些 tab 的下划线那里可以触发红绿灯」
  // tab 的下划线在 y≈50（让位 10 + 按钮 9+19+10 + 边框 2）⟹ ZONE=56 把它包住了。
  // 而红绿灯只占 y=13..25 ⟹ 34 就够（底边 25 + 余量）。
  assert.ok(z >= 28 && z <= 40,
    `悬停判定区 ${z}px 不合理 ⟹ 小于 28 会"移过去了才冒出来"（红绿灯占到 y=25），`
    + '大于 40 会盖住 tab 的下划线（y≈50），划过 tab 就触发（用户报过）');
});

// ⚠️⚠️ **主题（深色/浅色）+ 主界面极光背景**（0.9.59）。用户 2026-08-01：
//   「我想给产品一开始那个背景动画也加到打开软件之后，作为背景，
//     然后在设置里多一个主题色彩的选项，可以调整颜色，
//     先做深色和浅色两种模式就好」
check('主题：两套变量齐 / 落配置 / 不闪深色；极光当背景', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  const dash = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));
  const main = codeOnly(mainSrc);

  // ①⚠️⚠️ 两套变量必须**齐** —— 少一个的话浅色主题下那一处沿用深色值，
  //    而"一半没换过来"是最难看的一种（比整个没换更糟）。
  const dark = html.slice(html.indexOf('  :root {'), html.indexOf('}', html.indexOf('  :root {')));
  const li = html.indexOf('html[data-theme="light"]');
  assert.ok(li > 0, '没有浅色主题的变量块');
  const light = html.slice(li, html.indexOf('}', li));
  const varsOf = (block) => new Set((block.match(/--[\w-]+(?=:)/g) || []));
  const dv = varsOf(dark);
  const lv = varsOf(light);
  const missing = [...dv].filter((v) => !lv.has(v));
  assert.deepStrictEqual(missing, [],
    `浅色主题缺这些变量：${missing.join(', ')} ⟹ 那几处会沿用深色值（"一半没换过来"）`);

  // ⚠️ `color-scheme` 也要换 —— 它决定**原生控件**（滚动条、checkbox、
  //    select 的下拉面板）的配色。只改我们的变量不改它 ⟹ 浅色下滚动条还是黑的。
  assert.match(light, /color-scheme:\s*light/,
    '浅色主题没设 color-scheme ⟹ 滚动条/下拉框/checkbox 还是深色的');

  // ②⚠️ 主题要**落配置** —— 换了下次打开还是那个（"设置"的意思就是记住）
  assert.match(main, /theme: 'dark'/, '配置里没有 theme 默认值');
  assert.match(dash, /setConfig\(\{ theme: t \}\)/, '换主题不写配置 ⟹ 下次打开又回去了');
  assert.match(dash, /applyTheme\(config\.theme\)/,
    'apply() 里不同步主题 ⟹ 别处改了/下次启动不跟');

  // ③⚠️⚠️ **不能闪深色**：主题要在第一帧之前定。
  //    等 getConfig() 拿到配置再改是异步的 ⟹ 浅色用户每次开面板先看到深色闪一下。
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, /localStorage\.getItem\('gw-theme'\)/,
    '<head> 里没有同步设主题的 inline script ⟹ 浅色主题每次开面板会闪一下深色');
  assert.match(dash, /localStorage\.setItem\('gw-theme'/,
    '没写 localStorage 镜像 ⟹ 上面那段 inline script 永远读不到值');

  // ④ 极光当主界面背景
  assert.match(html, /id="app-bg"/, '没有主界面的极光背景 canvas');
  // ⚠️⚠️ `z-index: 0` 不能是 -1 —— -1 会把它放到 **body 背景之下**
  //    ⟹ 被 `body { background: var(--bg) }` 完全盖住，什么都看不见（不报错）。
  const bg = html.slice(html.indexOf('  #app-bg {'), html.indexOf('}', html.indexOf('  #app-bg {')));
  assert.match(bg, /z-index:\s*0/,
    '#app-bg 的 z-index 不是 0 ⟹ -1 会被 body 背景盖住，正数会盖住内容');
  assert.match(bg, /pointer-events:\s*none/, '#app-bg 会吃掉整个界面的点击');
  // ⚠️ nav/main 要抬到它之上（文档流里默认同层，而 #app-bg 在 DOM 更前）
  assert.match(html, /nav, main \{ position: relative; z-index: 1; \}/,
    'nav/main 没抬到极光之上 ⟹ 背景会盖住整个界面');
  // ⚠️ 浅色下极光要几乎关掉（加法混色在白底上是脏色，不是"淡淡的好看"）
  // ⚠️ 要连小数点一起取 —— 我第一版写的是 `\.?(\d+)`（把点吃掉只留数字）
  //   ⟹ `.5` 和 `.12` 变成 5 和 12，比出来"浅色比深色亮"⟹ **在正确代码上报红**。
  //   （断言自己的解析错，症状和"代码有问题"一模一样。）
  const la = Number((light.match(/--bg-aurora:\s*(\.?\d*\.?\d+)/) || [])[1]);
  const da = Number((dark.match(/--bg-aurora:\s*(\.?\d*\.?\d+)/) || [])[1]);
  assert.ok(la > 0 && da > 0, '读不到 --bg-aurora ⟹ 断言失效');
  assert.ok(la < da,
    `浅色主题的极光不比深色淡（${la} vs ${da}）⟹ 白底上加法混色是一片灰蒙蒙的脏色`);
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
