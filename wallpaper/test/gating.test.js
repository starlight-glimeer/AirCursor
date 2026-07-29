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
  const wall = fs.readFileSync(path.join(__dirname, '..', 'src', 'wall.html'), 'utf8');
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
  // 一个能把自己锁在外面的程序必须有不依赖鼠标的出口,而且不能和"退出"绑在一起 ——
  // 用户可能只想拿回鼠标,不是想关掉壁纸。
  assert.match(main, /Control\+Shift\+X[\s\S]{0,200}destroyOverlay\(\)/,
    '没有"拆掉骨架层"的全局快捷键');
  // 写在代码里但用户不知道,等于没有 —— 出事时他没法查文档。
  assert.match(wall, /⌃⇧X/, '启动页没告诉用户鼠标点不动时按什么');
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
  const known = ['wallWindow', 'dashboardWindow', 'overlayWindow', 'layer', 'win', 'target', 'w'];
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

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
