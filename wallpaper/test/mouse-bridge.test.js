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

// ⚠️ 这条要说清"不是权限问题"，否则用户会去翻辅助功能设置浪费时间 ——
// 监听鼠标本来就不需要那个权限（键盘才需要）。
check('监听建不起来时说清不是权限问题', () => {
  const out = M.describeStatus({ type: 'status', state: 'failed', message: 'x' });
  assert.strictEqual(out.ok, false);
  const generic = M.describeStatus({ type: 'status', state: 'failed' });
  assert.match(generic.text, /不是权限/, '没说明这不是权限问题');
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

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
