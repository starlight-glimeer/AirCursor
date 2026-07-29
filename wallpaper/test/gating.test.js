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

// 壁纸是 Vite 的 ES module，file:// 下加载不了（CORS）。所以必须走自定义 protocol。
check('WE 壁纸走自定义 protocol 而不是 loadFile', () => {
  const create = mainSrc.slice(mainSrc.indexOf('function createWEWindow'),
    mainSrc.indexOf('function sendWEProperties'));
  assert.ok(/loadURL/.test(create), 'WE 窗口没用 loadURL');
  assert.ok(!/loadFile/.test(create),
    'WE 窗口用了 loadFile —— Vite 的 ES module 在 file:// 下加载不了，会白屏');
});

// ⚠️ 反向调用那条：壁纸自己挂 window.wallpaperPropertyListener 等我们去调，
// contextIsolation:true 下我们看不见它 ⟹ 41 项配置永远发不进去且不报错。
check('WE 窗口 contextIsolation 为 false（属性接口是反向的）', () => {
  const create = mainSrc.slice(mainSrc.indexOf('function createWEWindow'),
    mainSrc.indexOf('function sendWEProperties'));
  assert.match(create, /contextIsolation:\s*false/,
    'WE 窗口开了 contextIsolation —— 壁纸挂的 wallpaperPropertyListener 我们看不见');
  // 但 nodeIntegration 不能开：壁纸是第三方 HTML。
  assert.match(create, /nodeIntegration:\s*false/, 'WE 窗口开了 nodeIntegration');
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
check('we-preload 不把 ipcRenderer / require 暴露给页面', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'we-preload.js'), 'utf8');
  assert.ok(!/window\.(ipcRenderer|require|electron)\s*=/.test(src),
    'we-preload 把 ipcRenderer 或 require 挂到 window 上了 —— 第三方 HTML 能拿到主进程通道');
  // 只该挂 WE 那几个函数
  const assigned = [...src.matchAll(/window\.(\w+)\s*=/g)].map((m) => m[1]);
  for (const name of assigned) {
    assert.ok(/^wallpaper/.test(name), `we-preload 挂了非 WE 的全局：window.${name}`);
  }
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

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);