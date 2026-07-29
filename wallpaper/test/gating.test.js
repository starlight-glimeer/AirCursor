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

// ── 能力可达性：接线齐了但用户点不到，等于没做 ──────────────────────────
//
// 这四条来自云端 agent，而它们逮到的正是我的错：我把 startCapture / undoRecording /
// pointerHealth 都接了 preload + 主进程 + sensor 三层，面板零入口 —— 而我还跟用户说
// "接进面板了"。三层各自都对，整条链没有入口，所有测试全绿。
//
// pointerHealth 那条最难看：它观测的正是"缺权限时 CGEvent.post 静默丢弃"，而我为那件事
// 烧掉四轮。把观测手段建好却没地方看，等于没建。
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
  const consumers = dash + wall + sensor + overlay;

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

check('摄像头窗口不可见，但不是用 show:false 或 1x1 做的', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const block = main.slice(main.indexOf('function ensureSensor'), main.indexOf('function ensureSensor') + 1400);
  // show:false → macOS 不给摄像头授权（只对可见窗口弹）
  // 1x1      → <video> 可能被判定不可见而停止解码，而 MediaPipe 要一个真在播的 video
  // 纯屏幕外 → macOS 把窗口钳回可见区域（实测：用户两次都看到它）
  assert.doesNotMatch(block, /show: false/, 'show:false 拿不到摄像头授权');
  assert.match(block, /width: 360/, '尺寸不能压到 1x1，video 会停止解码');
  assert.match(block, /transparent: true/, '靠透明而不是靠尺寸来隐藏');
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

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
