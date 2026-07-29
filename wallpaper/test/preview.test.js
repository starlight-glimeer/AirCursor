// preview.js：手势预览的几何与动画取样。纯逻辑，不需要 canvas。
//
//   node test/preview.test.js
//
// 预览是"录完之后怎么知道录对了"的唯一手段 —— 没有它，用户只能摆一遍看有没有反应，
// 而那把"录错了"和"匹配没过"混成同一个症状。所以这些断言守的是"画出来的东西是不是
// 忠实反映存下来的数据"。
const assert = require('node:assert');
require('../src/preview.js');
const P = globalThis.GestureWallPreview;

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

// 造一个模板：hands 只手，每只 21 点。`offset` 让两只手分开。
function template(hands = 1, spread = 0.8, scale = 1) {
  const values = [];
  for (let h = 0; h < hands; h += 1) {
    for (let i = 0; i < 21; i += 1) {
      values.push(h * spread + Math.cos(i) * 0.2 * scale, Math.sin(i) * 0.3 * scale, 0);
    }
  }
  return { hands, angle: 0, values };
}

console.log('\npreview.js');

check('拆出正确的手数和点数', () => {
  const one = P.templatePoints(template(1));
  assert.strictEqual(one.length, 1);
  assert.strictEqual(one[0].length, 21);
  const two = P.templatePoints(template(2));
  assert.strictEqual(two.length, 2);
  assert.strictEqual(two[1].length, 21);
});

check('无效模板返回 null 而不是抛', () => {
  assert.strictEqual(P.templatePoints(null), null);
  assert.strictEqual(P.templatePoints({}), null);
  assert.strictEqual(P.templatePoints({ hands: 1 }), null);
  assert.strictEqual(P.templatePoints({ values: [1, 2, 3] }), null);
});

check('fit 到画布内且留出 padding', () => {
  const pts = P.templatePoints(template(1));
  const { hands } = P.layout(pts, 76, 62, 0, 7);
  const xs = hands.flat().map((p) => p.x);
  const ys = hands.flat().map((p) => p.y);
  assert.ok(Math.min(...xs) >= 6.9, `左边超出 padding：${Math.min(...xs)}`);
  assert.ok(Math.max(...xs) <= 69.1, `右边超出 padding：${Math.max(...xs)}`);
  assert.ok(Math.min(...ys) >= 6.9);
  assert.ok(Math.max(...ys) <= 55.1);
});

// 模板在两只手之间共用一个原点和尺度，所以"两手的间距"本身就是签名的一部分。
// 各手独立归一化会把它抹掉，而那正是双手手势的区分依据。
check('双手的间距被保留', () => {
  const pts = P.templatePoints(template(2, 0.8));
  const { hands } = P.layout(pts, 96, 76, 0);
  const gap = hands[1][0].x - hands[0][0].x;
  assert.ok(gap > 10, `两手挤在一起了（间距 ${gap.toFixed(1)}px）`);
});

check('间距大的姿势画出来间距也大', () => {
  const near = P.layout(P.templatePoints(template(2, 0.5)), 96, 76, 0);
  const far = P.layout(P.templatePoints(template(2, 1.5)), 96, 76, 0);
  const nearGap = near.hands[1][0].x - near.hands[0][0].x;
  const farGap = far.hands[1][0].x - far.hands[0][0].x;
  assert.ok(farGap > nearGap, `间距没有反映出来：${nearGap.toFixed(1)} vs ${farGap.toFixed(1)}`);
});

// 同一个姿势不管录的时候手离摄像头多远，画出来应该一样大 —— 否则用户会以为自己录错了。
check('缩放不影响画出来的大小（fit 消掉了尺度）', () => {
  const small = P.layout(P.templatePoints(template(1, 0.8, 0.5)), 76, 62, 0);
  const big = P.layout(P.templatePoints(template(1, 0.8, 2)), 76, 62, 0);
  const spanOf = (r) => {
    const xs = r.hands.flat().map((p) => p.x);
    return Math.max(...xs) - Math.min(...xs);
  };
  assert.ok(Math.abs(spanOf(small) - spanOf(big)) < 0.01, '同一姿势不同尺度画出来大小不同');
});

check('退化姿势（所有点重合）不产生 NaN', () => {
  const flat = { hands: 1, angle: 0, values: new Array(63).fill(0.5) };
  const { hands } = P.layout(P.templatePoints(flat), 76, 62, 0);
  for (const p of hands.flat()) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `出现 ${p.x},${p.y}`);
  }
});

check('tiltDeg 旋转姿势', () => {
  const pts = P.templatePoints(template(1));
  const flat = P.layout(pts, 76, 62, 0);
  const tilted = P.layout(pts, 76, 62, 30);
  const differs = flat.hands[0].some((p, i) => Math.abs(p.x - tilted.hands[0][i].x) > 0.5);
  assert.ok(differs, '旋转没有生效');
});

console.log('\n  插值与动画');

// 插值而不是切帧：关键帧是连续动作的抽稀采样，直接切会看成卡顿 —— 而真实手势没有那个
// 卡顿，所以那是预览在说谎。
check('插值取两端的加权平均', () => {
  const a = template(1, 0.8, 1);
  const b = template(1, 0.8, 3);
  const mid = P.lerpTemplate(a, b, 0.5);
  for (let i = 0; i < a.values.length; i += 1) {
    const expected = (a.values[i] + b.values[i]) / 2;
    assert.ok(Math.abs(mid.values[i] - expected) < 1e-9, `第 ${i} 个值不是中点`);
  }
});

check('插值 k=0 / k=1 落在端点上', () => {
  const a = template(1, 0.8, 1);
  const b = template(1, 0.8, 3);
  assert.deepStrictEqual(P.lerpTemplate(a, b, 0).values, a.values);
  assert.deepStrictEqual(P.lerpTemplate(a, b, 1).values, b.values);
});

check('长度不匹配的两个模板不插值（返回第一个）', () => {
  const a = template(1);
  const b = template(2);
  assert.strictEqual(P.lerpTemplate(a, b, 0.5), a);
});

check('按时间取样落在正确的关键帧区间', () => {
  const k0 = template(1, 0.8, 1);
  const k1 = template(1, 0.8, 2);
  const k2 = template(1, 0.8, 3);
  const keyframes = [
    { template: k0, offsetMs: 0 },
    { template: k1, offsetMs: 500 },
    { template: k2, offsetMs: 1000 },
  ];
  // t=250 应该在 k0 和 k1 之间
  const mid = P.sampleAt(keyframes, 250);
  assert.ok(mid.values[0] > k0.values[0] && mid.values[0] < k1.values[0],
    '取样落在了错的区间');
  // t=0 / t=1000 落在端点
  assert.ok(Math.abs(P.sampleAt(keyframes, 0).values[0] - k0.values[0]) < 1e-9);
  assert.ok(Math.abs(P.sampleAt(keyframes, 1000).values[0] - k2.values[0]) < 1e-9);
});

check('单帧序列直接返回那一帧', () => {
  const only = template(1);
  assert.strictEqual(P.sampleAt([{ template: only, offsetMs: 0 }], 999), only);
});

check('空序列返回 null', () => {
  assert.strictEqual(P.sampleAt([], 100), null);
  assert.strictEqual(P.sampleAt(null, 100), null);
});

// 停顿是必要的：没有它，一个首尾相近的动作看起来是连续抖动而不是"做一遍然后重放"，
// 用户分不清动作从哪开始。
check('循环长度 = 动作时长 + 停顿', () => {
  const keyframes = [
    { template: template(1), offsetMs: 0 },
    { template: template(1, 0.8, 2), offsetMs: 600 },
  ];
  assert.strictEqual(P.cycleLength(keyframes), 600 + P.PREVIEW_HOLD_MS);
});

check('停顿段被标出来（好换颜色）', () => {
  const keyframes = [
    { template: template(1), offsetMs: 0 },
    { template: template(1, 0.8, 2), offsetMs: 600 },
  ];
  assert.strictEqual(P.frameAt(keyframes, 300).holding, false);
  assert.strictEqual(P.frameAt(keyframes, 800).holding, true);
});

check('循环会回到起点', () => {
  const keyframes = [
    { template: template(1, 0.8, 1), offsetMs: 0 },
    { template: template(1, 0.8, 2), offsetMs: 600 },
  ];
  const cycle = P.cycleLength(keyframes);
  const first = P.frameAt(keyframes, 0);
  const looped = P.frameAt(keyframes, cycle);
  assert.ok(Math.abs(first.template.values[0] - looped.template.values[0]) < 1e-9,
    '循环没回到起点');
});

check('负时间不产生越界（取模是安全的）', () => {
  const keyframes = [
    { template: template(1), offsetMs: 0 },
    { template: template(1, 0.8, 2), offsetMs: 600 },
  ];
  const frame = P.frameAt(keyframes, -100);
  assert.ok(frame && frame.template, '负时间返回了空');
  assert.ok(Number.isFinite(frame.template.values[0]));
});

check('不足两帧的序列没有动画', () => {
  assert.strictEqual(P.cycleLength([{ template: template(1), offsetMs: 0 }]), 0);
  assert.strictEqual(P.frameAt([{ template: template(1), offsetMs: 0 }], 100), null);
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
