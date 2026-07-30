// overlay.js：手骨架和指针的几何与淡出。纯逻辑，不需要 canvas。
//
//   node test/overlay.test.js
//
// 这一层存在的理由：没有它，"手势没反应"和"手根本没被检测到"是同一个症状。所以这些
// 断言守的是"看得见"这件事本身 —— 坐标对不对、丢帧时会不会频闪、关掉了会不会残留。
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
// ⚠️ tracking.js 要在 overlay.js **之前** —— overlay 在加载时就取 OneEuroFilter，
// 顺序反了的话 `OneEuro` 是 undefined 而 smooth() 原样返回，
// 而那时滤波的用例会通过一个什么都没做的实现（实测抖动 5.040 → 5.040）。
require(path.join(__dirname, '..', 'src', 'vendor', 'aircursor', 'tracking.js'));
require('../src/overlay.js');
const O = globalThis.GestureWallOverlay;

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

// 假 canvas：只要 getContext 返回一个能吞掉所有调用的对象。
function fakeCanvas() {
  const calls = [];
  const ctx = new Proxy({}, {
    get(_target, key) {
      if (key === 'canvas') return null;
      return (...args) => { calls.push({ key, args }); };
    },
    set() { return true; },
  });
  return { calls, getContext: () => ctx, width: 0, height: 0 };
}

function hand(offset = 0) {
  const lm = [];
  for (let i = 0; i < 21; i += 1) {
    lm.push({ x: 0.3 + offset + (i % 5) * 0.02, y: 0.3 + Math.floor(i / 5) * 0.05 });
  }
  return lm;
}

// 占画面 25% 宽的手 —— 手举在摄像头半米内时的真实量级。
// 上面那个 `hand()` 只占 8%，用它测缩放会命中 `Math.min(1, ...)` 那条分支（不放大小手），
// 于是断言红了而代码是对的。夹具的量级本身是个变量。
function bigHand(offset = 0) {
  const lm = [];
  for (let i = 0; i < 21; i += 1) {
    lm.push({ x: 0.3 + offset + (i % 5) * 0.0625, y: 0.3 + Math.floor(i / 5) * 0.06 });
  }
  return lm;
}

console.log('\noverlay.js');

check('归一化坐标映射到画布像素', () => {
  const p = O.toCanvas({ x: 0.5, y: 0.25 }, 1000, 800);
  assert.strictEqual(p.x, 500);
  assert.strictEqual(p.y, 200);
});

// 食指指尖是"我在指哪"的答案 —— 那个问题在加这一层之前完全没有答案。
check('指针取食指指尖（8 号）', () => {
  assert.strictEqual(O.INDEX_TIP, 8);
  const h = hand();
  assert.strictEqual(O.indexTip(h), h[8]);
});

check('没有手时指针返回 null 而不是抛', () => {
  assert.strictEqual(O.indexTip(null), null);
  assert.strictEqual(O.indexTip([]), null);
});

// 两只手不同色调，"哪只手在动"才能一眼看出来。
check('两只手用不同色调', () => {
  assert.notStrictEqual(O.handHue(0, false), O.handHue(1, false));
});

// 状态变化要有一个不用读文字就能察觉的信号。
check('录制时色调明显不同（不用读文字就知道在录）', () => {
  const normal = O.handHue(0, false);
  const recording = O.handHue(0, true);
  assert.ok(Math.abs(normal - recording) > 60,
    `录制色调只差 ${Math.abs(normal - recording)}，看不出区别`);
});

console.log('\n  尺寸');

// 回归守卫：第一版把归一化坐标直接乘满屏，手在摄像头里占 25% 就在 1470px 的屏上画成
// 368px —— 比真手大好几倍，糊住半个屏幕。骨架是叠加信息不是内容。
check('骨架按固定手宽缩放，不跟着屏幕长', () => {
  const h = bigHand();
  const span = O.handSpan(h);
  for (const screenWidth of [1470, 2940, 3840]) {
    const target = O.skeletonWidth(screenWidth);
    const raw = span.width * screenWidth;
    const scale = Math.min(1, target / raw);
    const drawn = raw * scale;
    assert.ok(Math.abs(drawn - target) < 1, `屏宽 ${screenWidth} 画出 ${drawn.toFixed(0)}px，目标 ${target.toFixed(0)}px`);
    assert.ok(drawn < screenWidth * 0.2, `骨架占屏宽 ${(drawn / screenWidth * 100).toFixed(0)}%，太大`);
  }
});

// 只缩不放：手离摄像头远时画面里的手很小，强行拉到 200px 会让骨架比手大得离谱，
// 而且会把"手离得远"这个信息抹掉。
check('小手不放大（只缩不放）', () => {
  const small = hand();   // 占画面 8%
  const span = O.handSpan(small);
  const raw = span.width * 1470;
  const scale = Math.min(1, O.skeletonWidth(1470) / raw);
  assert.strictEqual(scale, 1, '小手被强行放大了');
});

check('目标手宽有下限（小屏上别缩到看不见）', () => {
  assert.ok(O.skeletonWidth(400) >= 120, '小屏上骨架太小');
});

// 位置和尺寸是两件事：位置要铺满屏才指得到任何地方，尺寸不能跟着屏幕长。
check('位置仍映射到全屏（手在右边骨架就在右边）', () => {
  const left = hand(0);      // 手在偏左
  const right = hand(0.5);   // 手在偏右
  const lc = O.handSpan(left).center;
  const rc = O.handSpan(right).center;
  const lp = O.toCanvas(left[0], 1000, 800, lc, 0.5);
  const rp = O.toCanvas(right[0], 1000, 800, rc, 0.5);
  assert.ok(rp.x > lp.x + 200, `位置没跟着手走：${lp.x.toFixed(0)} vs ${rp.x.toFixed(0)}`);
});

check('缩放围绕掌心做（手不被拉到角落）', () => {
  const h = hand();
  const span = O.handSpan(h);
  const centerBefore = O.toCanvas(
    { x: span.center.x, y: span.center.y }, 1000, 800, span.center, 1);
  const centerAfter = O.toCanvas(
    { x: span.center.x, y: span.center.y }, 1000, 800, span.center, 0.3);
  assert.ok(Math.abs(centerAfter.x - centerBefore.x) < 0.01, '缩放把掌心挪走了');
  assert.ok(Math.abs(centerAfter.y - centerBefore.y) < 0.01);
});

check('不传 center/scale 时退回全屏映射（旧行为仍可用）', () => {
  const p = O.toCanvas({ x: 0.5, y: 0.25 }, 1000, 800);
  assert.strictEqual(p.x, 500);
  assert.strictEqual(p.y, 200);
});

console.log('\n  淡出');

check('手在场时完全不透明', () => {
  const overlay = new O.HandOverlay(fakeCanvas());
  overlay.update({ hands: [hand()] }, 1000);
  assert.strictEqual(overlay.opacityAt(1000), 1);
});

// 丢一两帧跟踪很常见。立刻消失会让骨架频闪，那比没有骨架更让人以为出问题了。
//
// ⚠️ 这条逮到过一个真 bug：第一版手一没就 `this.hands = []`，于是 opacityAt 立刻返回 0，
// 整段淡出代码一行都跑不到 —— 淡出是死代码，骨架瞬间消失。
check('手消失后姿势保留并渐变淡出（不是瞬间消失）', () => {
  const overlay = new O.HandOverlay(fakeCanvas());
  overlay.update({ hands: [hand()] }, 1000);
  overlay.update({ hands: [] }, 1000 + 50);   // 手丢了
  assert.ok(overlay.hands.length > 0, '手一丢就把姿势清空了 —— 淡出成了死代码');
  const half = overlay.opacityAt(1000 + O.FADE_MS * 0.5);
  assert.ok(half > 0.3 && half < 1, `半个周期时不透明度是 ${half.toFixed(2)}，不是渐变`);
});

check('淡出周期结束后完全透明', () => {
  const overlay = new O.HandOverlay(fakeCanvas());
  overlay.update({ hands: [hand()] }, 1000);
  assert.strictEqual(overlay.opacityAt(1000 + O.FADE_MS + 1), 0);
});

check('淡出结束后姿势被真的清掉（不留内存）', () => {
  const overlay = new O.HandOverlay(fakeCanvas());
  overlay.update({ hands: [hand()] }, 1000);
  overlay.update({ hands: [] }, 1000 + O.FADE_MS + 100);
  assert.strictEqual(overlay.hands.length, 0, '过了淡出期还留着旧姿势');
});

check('从未见过手时是透明的', () => {
  const overlay = new O.HandOverlay(fakeCanvas());
  assert.strictEqual(overlay.opacityAt(1000), 0);
});

check('空 payload 不崩', () => {
  const overlay = new O.HandOverlay(fakeCanvas());
  overlay.update(null, 100);
  overlay.update({}, 100);
  overlay.update({ hands: null }, 100);
  assert.strictEqual(overlay.opacityAt(100), 0);
});

console.log('\n  绘制');

check('resize 按 DPR 设置 backing store，上限 2', () => {
  const canvas = fakeCanvas();
  const overlay = new O.HandOverlay(canvas);
  overlay.resize(800, 600, 3);
  assert.strictEqual(canvas.width, 1600, 'DPR 没有被压到 2');
  assert.strictEqual(canvas.height, 1200);
  assert.strictEqual(overlay.width, 800, '逻辑尺寸应该是 CSS 像素');
});

check('有手时会画（产生 stroke 调用）', () => {
  const canvas = fakeCanvas();
  const overlay = new O.HandOverlay(canvas);
  overlay.resize(800, 600, 1);
  overlay.update({ hands: [hand()] }, 1000);
  canvas.calls.length = 0;
  overlay.draw(1000);
  assert.ok(canvas.calls.some((c) => c.key === 'stroke'), '没有画线');
  assert.ok(canvas.calls.some((c) => c.key === 'arc'), '没有画关节点');
});

// 关掉骨架时不能留下残影 —— 那会让人以为开关坏了。
check('透明时只清屏，不画', () => {
  const canvas = fakeCanvas();
  const overlay = new O.HandOverlay(canvas);
  overlay.resize(800, 600, 1);
  canvas.calls.length = 0;
  overlay.draw(1000);   // 从未见过手
  assert.ok(canvas.calls.some((c) => c.key === 'clearRect'), '没有清屏');
  assert.ok(!canvas.calls.some((c) => c.key === 'stroke'), '透明时还在画线');
});

check('关键点不足 21 个的手被跳过（不画半只手）', () => {
  const canvas = fakeCanvas();
  const overlay = new O.HandOverlay(canvas);
  overlay.resize(800, 600, 1);
  overlay.update({ hands: [hand().slice(0, 10)] }, 1000);
  canvas.calls.length = 0;
  overlay.draw(1000);
  assert.ok(!canvas.calls.some((c) => c.key === 'stroke'), '画了不完整的手');
});

check('两只手都画', () => {
  const canvas = fakeCanvas();
  const overlay = new O.HandOverlay(canvas);
  overlay.resize(800, 600, 1);
  overlay.update({ hands: [hand(0), hand(0.3)] }, 1000);
  canvas.calls.length = 0;
  overlay.draw(1000);
  const strokes = canvas.calls.filter((c) => c.key === 'stroke').length;
  // 每只手 6 条线 + 1 个指针环
  assert.ok(strokes >= 12, `只画了 ${strokes} 笔，两只手应该更多`);
});

check('骨架连线覆盖全部 21 个关键点', () => {
  const covered = new Set(O.HAND_LINES.flat());
  for (let i = 0; i < 21; i += 1) {
    assert.ok(covered.has(i), `关键点 ${i} 不在任何连线里`);
  }
});

// ── 骨架滤波:只在绘制侧 ──────────────────────────────────────────────────
//
// 用户报「这次我发现骨架手很抖，可能上次也有我没注意」。真机实测(5 份 capture,
// 21 个点在**屏幕像素**上的帧间跳动,屏宽 1470):中位 **85px**、最大 **1247px**
// ⟹ 手每帧跳 5.7% 屏宽,而骨架路径**一直零滤波**(指针有 One Euro,骨架没有)。
//
// 滤波后:抖动中位 26px(降 **69%**)、最大 159px(降 87%),代价是滞后 165px。
check('骨架过 One Euro 滤波', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay.js'), 'utf8');
  assert.match(src, /SKELETON_FILTER/, '骨架没有滤波参数 —— 那就是"很抖"');
  assert.match(src, /OneEuroFilter/, '没用 One Euro（截止频率随手速自适应）');
  // 参数要比指针更平滑：两者要的东西不同。
  const m = src.match(/minCutoff:\s*([\d.]+),\s*beta:\s*([\d.]+)/);
  assert.ok(m, '找不到滤波参数');
  assert.ok(Number(m[1]) < 1.2,
    `minCutoff ${m[1]} 不比指针的 1.2 小 —— 骨架是反馈，宁可慢半拍也不要抖`);
});

check('滤波真的降低抖动（拿真机数据回测）', () => {
  const O = globalThis.GestureWallOverlay;
  const fake = { getContext: () => ({ setTransform() {}, clearRect() {} }),
    width: 0, height: 0, clientWidth: 0, clientHeight: 0 };
  const ov = new O.HandOverlay(fake);
  if (!ov.smooth) { assert.fail('HandOverlay 没有 smooth 方法'); }

  // 造一只"抖动的静止手"：固定姿势 + 交替偏移，那正是真机噪声的形状。
  const base = [];
  for (let k = 0; k < 21; k += 1) base.push({ x: 0.5 + k * 0.01, y: 0.5 });
  const raw = [];
  for (let i = 0; i < 12; i += 1) {
    raw.push(base.map((p) => ({ x: p.x + (i % 2 ? 0.02 : -0.02), y: p.y })));
  }
  const smoothed = raw.map((h, i) => ov.smooth([h], i * 35)[0]);
  const jit = (seq) => {
    let sum = 0;
    for (let i = 6; i < seq.length; i += 1) {
      for (let k = 0; k < 21; k += 1) sum += Math.abs(seq[i][k].x - seq[i - 1][k].x);
    }
    return sum;
  };
  const before = jit(raw);
  const after = jit(smoothed);
  assert.ok(after < before * 0.5,
    `滤波只把抖动从 ${before.toFixed(3)} 降到 ${after.toFixed(3)} —— 不到一半，参数没起作用`);
});

check('判定侧不滤波（滤波会削掉动作幅度，而幅度是判据）', () => {
  // ⚠️ 同一份数据两个用途：判定要"手真实在哪"，骨架要"看着稳"。
  // 给判定也滤波会让快速动作的幅度变小，而幅度正是动作录制的判据
  // （`MIN_MOVE_EXTENT`）—— 那会把"动作幅度不够"变成一个滤波器造出来的问题。
  const input = fs.readFileSync(path.join(__dirname, '..', 'src', 'input.js'), 'utf8');
  assert.doesNotMatch(input, /SKELETON_FILTER/, '判定侧用上了骨架的滤波参数');
  const sensor = fs.readFileSync(path.join(__dirname, '..', 'src', 'sensor.js'), 'utf8');
  // sendHands 发的是原始坐标，滤波发生在 overlay 那一侧
  const send = sensor.slice(sensor.indexOf('function sendHands'));
  assert.doesNotMatch(send.slice(0, 600), /smooth/,
    'sensor 在发送前就滤波了 —— 那样判定和录制也会吃到滤波后的坐标');
});

check('手离开时清掉滤波器状态', () => {
  // 留着的话下次举手骨架会从上次的位置"飞"过来 —— One Euro 的状态是"上一个位置"，
  // 跨越一次手不在的间隔没有意义，而那比抖动更奇怪。
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay.js'), 'utf8');
  const block = src.slice(src.indexOf('if (this.lastAt && now - this.lastAt > FADE_MS)'));
  assert.match(block.slice(0, 400), /this\.filters = \[\]/,
    '手离开后没清滤波器 —— 下次举手骨架会从旧位置插值过来');
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
