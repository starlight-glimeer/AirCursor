// mouse-bridge.js：全局鼠标 → 壁纸窗口的坐标换算和事件翻译。
//
//   node test/mouse-bridge.test.js
//
// 为什么这些值得测：这条链上有两处"错了不报错"的地方 ——
// 坐标偏移（窗口通常在 (0,0)，所以不减 bounds 也测不出来，直到接第二块屏）
// 和事件字段名（sendInputEvent 对不认识的字段静默忽略）。
const assert = require('node:assert');
const M = require('../src/mouse-bridge.js');

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

console.log('\nmouse-bridge.js');

console.log('\n  为什么有这个模块');

// macOS 上「真壁纸层能覆盖菜单栏」和「能收到鼠标」本来互斥。
// 我原来做成让用户选一个，而用户否掉了：mac 原生壁纸没有那条缝，
// 而鼠标交互失效对交互式壁纸不可接受。
// ⟹ 正解是窗口留在壁纸层、鼠标靠全局监听转发（Open Wallpaper Engine 那套）。
check('导出了转发链需要的四个纯函数', () => {
  for (const fn of ['parseLines', 'toWindowPoint', 'toInputEvent', 'describeStatus']) {
    assert.strictEqual(typeof M[fn], 'function', `缺 ${fn}`);
  }
});

console.log('\n  坐标换算（错了不报错的一处）');

const bounds = { x: 0, y: 0, width: 1470, height: 956 };

check('窗口在原点时坐标直通', () => {
  assert.deepStrictEqual(M.toWindowPoint({ x: 100, y: 200 }, bounds), { x: 100, y: 200 });
});

// ⚠️ 这条是关键：壁纸窗口通常就在 (0,0)，所以"忘记减偏移"在单屏上**测不出来** ——
// 直到用户接了第二块屏，那时候点击位置会整体偏移一整个屏幕的宽度。
check('窗口不在原点时要减偏移（多显示器才会暴露）', () => {
  const second = { x: 1470, y: 0, width: 1920, height: 1080 };
  assert.deepStrictEqual(M.toWindowPoint({ x: 1500, y: 300 }, second), { x: 30, y: 300 });
});

// 多显示器时鼠标会跑到别的屏上。把负坐标喂给 sendInputEvent 会让渲染进程
// 收到莫名其妙的位置，而那看起来像命中判定有 bug。
check('落在窗口外的事件被丢掉', () => {
  assert.strictEqual(M.toWindowPoint({ x: -10, y: 100 }, bounds), null);
  assert.strictEqual(M.toWindowPoint({ x: 100, y: -1 }, bounds), null);
  assert.strictEqual(M.toWindowPoint({ x: 2000, y: 100 }, bounds), null);
  assert.strictEqual(M.toWindowPoint({ x: 100, y: 1000 }, bounds), null);
});

check('边界值算在窗口内', () => {
  assert.ok(M.toWindowPoint({ x: 0, y: 0 }, bounds));
  assert.ok(M.toWindowPoint({ x: 1470, y: 956 }, bounds));
});

check('缺参数返回 null 而不是抛', () => {
  assert.strictEqual(M.toWindowPoint(null, bounds), null);
  assert.strictEqual(M.toWindowPoint({ x: 1, y: 1 }, null), null);
});

console.log('\n  事件翻译（字段名错了静默失效）');

const point = { x: 10, y: 20 };

check('移动和拖拽都翻成 mouseMove', () => {
  assert.strictEqual(M.toInputEvent({ kind: 'move' }, point).type, 'mouseMove');
  assert.strictEqual(M.toInputEvent({ kind: 'drag' }, point).type, 'mouseMove');
});

// ⚠️ clickCount 缺了的后果：页面只收到 mousedown、**收不到 click** ——
// 而"能按下但不算点击"是个很难查的症状（壁纸的 onClick 处理器不触发，
// 而 pointerdown 却触发了）。
check('按下/抬起带 clickCount（否则页面收不到 click）', () => {
  const down = M.toInputEvent({ kind: 'down', button: 0 }, point);
  assert.strictEqual(down.type, 'mouseDown');
  assert.strictEqual(down.button, 'left');
  assert.strictEqual(down.clickCount, 1, '缺 clickCount，页面收不到 click 事件');
  const up = M.toInputEvent({ kind: 'up', button: 0 }, point);
  assert.strictEqual(up.type, 'mouseUp');
  assert.strictEqual(up.clickCount, 1);
});

check('右键按钮名对得上 Electron 的定义', () => {
  assert.strictEqual(M.toInputEvent({ kind: 'down', button: 2 }, point).button, 'right');
  assert.strictEqual(M.toInputEvent({ kind: 'up', button: 2 }, point).button, 'right');
});

// ⚠️ canScroll 缺了滚动事件会被当成无效丢掉 —— 症状是"滚轮完全没反应"。
check('滚轮带 canScroll 和两个方向的 delta', () => {
  const wheel = M.toInputEvent({ kind: 'scroll', dx: 3, dy: -5 }, point);
  assert.strictEqual(wheel.type, 'mouseWheel');
  assert.strictEqual(wheel.deltaX, 3);
  assert.strictEqual(wheel.deltaY, -5);
  assert.strictEqual(wheel.canScroll, true, '缺 canScroll，滚轮会失效');
});

check('滚轮缺 delta 时给 0 而不是 undefined', () => {
  const wheel = M.toInputEvent({ kind: 'scroll' }, point);
  assert.strictEqual(wheel.deltaX, 0);
  assert.strictEqual(wheel.deltaY, 0);
});

check('认不出的事件返回 null（不发半成品载荷）', () => {
  assert.strictEqual(M.toInputEvent({ kind: '奇怪的东西' }, point), null);
  assert.strictEqual(M.toInputEvent(null, point), null);
  assert.strictEqual(M.toInputEvent({ kind: 'move' }, null), null);
});

console.log('\n  行协议与状态');

check('半行留在 tail 里，下次拼上', () => {
  const first = M.parseLines('', '{"type":"mouse","ki');
  assert.strictEqual(first.messages.length, 0);
  const second = M.parseLines(first.tail, 'nd":"move","x":1,"y":2}\n');
  assert.strictEqual(second.messages.length, 1);
  assert.strictEqual(second.messages[0].kind, 'move');
});

check('一次多行都解析出来', () => {
  const { messages } = M.parseLines('',
    '{"type":"status","state":"running"}\n{"type":"mouse","kind":"down"}\n');
  assert.strictEqual(messages.length, 2);
});

// ⚠️ 这条断言翻过来了，而这是本轮最重要的更正。
//
// 它原来断言"要说清**不是**权限问题"，理由是"监听鼠标不需要辅助功能权限"。
// 那句话我说了三次、**从没验证过**，而 2026-07-30 实测证伪：
//
//   $ swiftc GestureWallMouse.swift -o /tmp/gm && /tmp/gm
//   {"gateOnFinder":false,"state":"running","type":"status"}
//   （动鼠标、点击 —— 零事件）
//
// ⟹ addGlobalMonitorForEvents **返回非 nil**（所以报了 running），
// 而回调一次都不触发。**监听鼠标也要辅助功能授权。**
//
// 教训：这条断言本身把一个未验证的推断**锁进了测试**，
// 于是它从"待验证的假设"变成了"看起来已确认的事实"。
// ⟹ 没验过的前提不该写成断言，该写成注释里的问号。
check('"建立成功"不能当成"能用"（实测：running 之后照样零事件）', () => {
  // 监听建立了但收不到事件 —— 这是最坏的失败：没有任何错误信号。
  const silent = M.describeStatus({
    type: 'status', state: 'silent', trusted: false,
    message: '监听建立了但收不到事件',
  });
  assert.strictEqual(silent.ok, false, 'silent 报成了 ok');
  assert.strictEqual(silent.silent, true);
  // ⚠️ 没授权时必须给出确切的下一步，而不是让用户猜
  assert.match(silent.hint, /打包|\.app/, '没告诉用户要打包才能拿到授权');
});

check('已授权但仍无事件时，不误导成权限问题', () => {
  const out = M.describeStatus({
    type: 'status', state: 'silent', trusted: true, message: '已授权，所以是别的问题',
  });
  assert.strictEqual(out.ok, false);
  // 授权正常时不该再叫用户去打包 —— 那会让他白折腾
  assert.strictEqual(out.hint, null, '已授权还在说打包的事');
});

// ⚠️ running 的措辞不能说"已开/能用"：实测过 running 之后照样零事件。
check('running 时若未授权，措辞要提示大概收不到事件', () => {
  const out = M.describeStatus({
    type: 'status', state: 'running', gateOnFinder: false, trusted: false,
  });
  assert.match(out.text, /授权|收不到/, 'running + 未授权时说得像一切正常');
});

check('监听建不起来时报出来', () => {
  const out = M.describeStatus({ type: 'status', state: 'failed', message: 'x' });
  assert.strictEqual(out.ok, false);
});

// "只在桌面被聚焦时转发"和"一直转发"是不同的行为，用户要知道自己在哪个。
// ⚠️ 字段名从 requireFinder 改成 gateOnFinder 了 —— 连带这条断言也要改。
check('running 状态说明当前是哪种转发模式', () => {
  const gated = M.describeStatus({ type: 'status', state: 'running', gateOnFinder: true });
  const open = M.describeStatus({ type: 'status', state: 'running', gateOnFinder: false });
  assert.ok(gated.ok && open.ok);
  assert.notStrictEqual(gated.text, open.text, '两种模式说的是同一句话');
  assert.match(gated.text, /桌面/);
});

// ⚠️ 这条是这一轮的核心教训。诊断报告显示：
//   mouse: { status: { ok: true }, injected: 0 }
// helper 起来了、状态显示成功、而一个事件都没转发过 —— 因为"只在桌面被聚焦时"
// 那个门把它们全挡了。而用户看到的是 "✅ 鼠标转发已开"。
//
// ⟹ 被门挡掉**必须单独报**，否则"成功"和"完全没用"长得一样。
check('被门挡掉时明确报出来（不能显示成"已开 ✅"）', () => {
  const out = M.describeStatus({
    type: 'status', state: 'gated', blocked: 137, front: 'com.apple.Terminal',
  });
  assert.strictEqual(out.ok, false, '被挡了还报 ok —— 那正是让人白测一轮的原因');
  assert.match(out.text, /挡/, '没说清是被挡了');
  assert.match(out.text, /137/, '没报被挡了多少个');
  assert.match(out.text, /Terminal/, '没说当前前台是谁 —— 那是查因的关键');
  assert.match(out.text, /关掉/, '没告诉用户怎么办');
});

check('helper 源码不在时报错而不是抛', () => {
  const out = M.ensureHelper('/不存在/x.swift', '/tmp');
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /不在/);
});

// ⚠️⚠️⚠️ **全局鼠标监听必须初始化 NSApplication，否则静默收不到事件。**
//
// 用户 0.9.25 实测（打包版、辅助功能已授权）：
//   「监听建立了但 3 秒内零事件 —— **已授权**，所以是别的问题」
//
// 那句话是 helper 自己的探活消息，而它把范围缩到了这里：
//   `AXIsProcessTrusted()` = true      ⟹ 授权没问题
//   `addGlobalMonitorForEvents != nil` ⟹ 注册没失败
//   零事件                              ⟹ **事件压根没派发到我们**
//
// 根因：那是 **AppKit** 的 API，靠 `NSApplication` 的事件派发基础设施。
// 而 helper 是纯命令行进程，从没碰过 `NSApplication.shared`
// ⟹ 基础设施没建起来 ⟹ 注册"成功"但没人送事件。
//
// ⚠️ `RunLoop.main.run()` 不够 —— 它只让进程不退出，
// 而 AppKit 的事件源要 `NSApplication.run()` 的启动序列才挂到 RunLoop 上。
//
// ⚠️⚠️ 这和音频 helper 那边是**同一个形状**：我在那边写过
// 「这个进程没有主 RunLoop 在跑，`Timer.scheduledTimer` 压根不会触发，
//   而那种失败完全静默」⟹ **纯命令行进程用 AppKit API 时，
//   先问"它依赖什么基础设施"**。这是第二次，所以做成守卫。
check('鼠标 helper 初始化 NSApplication（全局监听的前提）', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const src = fs2.readFileSync(
    path2.join(__dirname, '..', 'native', 'GestureWallMouse.swift'), 'utf8',
  );
  // ⚠️ 剥注释 —— 上面那段说明里就写了这些符号，查原文会假阴性
  //（这个项目今天已经踩了四次"注释让守卫失效"）
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  assert.match(code, /NSApplication\.shared/,
    '没初始化 NSApplication ⟹ addGlobalMonitorForEvents 注册"成功"但收不到事件'
    + '（用户 0.9.25 实测：已授权、monitor 非 nil、3 秒零事件）');
  // ⚠️ 顺序：必须在注册监听**之前**
  const appAt = code.indexOf('NSApplication.shared');
  const monAt = code.indexOf('addGlobalMonitorForEvents');
  assert.ok(appAt >= 0 && monAt >= 0, '找不到锚点');
  assert.ok(appAt < monAt,
    'NSApplication 初始化在注册监听之后 ⟹ 注册时那套基础设施还不存在');
  // ⚠️ 后台进程不该有 Dock 图标
  assert.match(code, /setActivationPolicy\(\.prohibited\)/,
    '没设 .prohibited ⟹ helper 会在 Dock 里冒出图标'
    + '（.accessory 仍会出现在 Cmd-Tab 里，只有 .prohibited 是纯后台）');
  // ⚠️ 事件循环要用 app.run()，不是裸 RunLoop
  assert.match(code, /app\.run\(\)/,
    '还在用裸 RunLoop.main.run() ⟹ AppKit 的启动序列没跑，事件源没挂上');
  assert.ok(!/^RunLoop\.main\.run\(\)$/m.test(code),
    '仍有裸 RunLoop.main.run() —— 它不完成 AppKit 的 finishLaunching');
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
