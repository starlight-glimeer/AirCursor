// FFT 分箱边界。**这一整个文件是为一个真机 bug 写的。**
//
//   node test/audio-bins.test.js
//
// 用户 2026-07-31 的截图：音频圆环的柱子长度随索引**单调递增**，还带一段段
// 等长的阶梯 —— 那不是音乐的形状。
//
// 算出来才明白原因：原来的分箱是 `lo = powf(512, i/128)` 纯对数铺满 1..512，
// 而低索引处它增长极慢 ⟹ **i=0..13 的 (start,end) 全是 (1,1)**，
// 14 个箱子读同一个 FFT bin，一共 38/128 个箱子在读完全相同的 bin。
//
// ⚠️ 那是**纯算术错误** —— 写下它的那一刻就能算出来，而它活到了真机截图。
// ⟹ 这个文件的存在理由：让"每个箱子有自己的 bin"从一句注释变成一条断言。
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { binEdges } = require('../src/audio-bins.js');

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

console.log('\nFFT 分箱边界');

console.log('\n  那个真机 bug 本身');

// ⚠️ 这条是整个文件的核心。
check('不同的箱子不读同一个 FFT bin（原来 38/128 读重复的）', () => {
  const { edges } = binEdges();
  const seen = new Map();
  edges.forEach(([s, e], i) => {
    const key = `${s}:${e}`;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(i);
  });
  const dupes = [...seen.values()].filter((v) => v.length > 1);
  const affected = dupes.flat().length;
  // 允许极少量（相邻两段共用一个 bin 在边界上不可避免），但不能成片。
  assert.ok(affected <= 4,
    `${affected}/128 个箱子在读完全相同的 FFT bin —— 它们的值必然一模一样，`
    + `画面上就是一段段等长的柱子（原来是 38 个，用户截图见得到）。重复组：`
    + JSON.stringify(dupes.slice(0, 3)));
});

// ⚠️ 旧公式必须报红 —— 否则这条守卫等于没有。
check('（自检）旧的纯对数公式会被上面那条逮到', () => {
  const half = 512;
  const old = [];
  for (let i = 0; i < 128; i += 1) {
    const lo = half ** (i / 128);
    const hi = half ** ((i + 1) / 128);
    const s = Math.max(1, Math.trunc(lo));
    old.push([s, Math.min(half - 1, Math.max(s, Math.trunc(hi)))]);
  }
  const seen = new Map();
  old.forEach(([s, e], i) => {
    const k = `${s}:${e}`;
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(i);
  });
  const affected = [...seen.values()].filter((v) => v.length > 1).flat().length;
  assert.ok(affected >= 30,
    `旧公式只有 ${affected} 个重复箱子 —— 那说明我对这个 bug 的分析是错的`);
});

check('每个箱子的起点单调递增（倒退会让频率顺序乱掉）', () => {
  const { edges } = binEdges();
  for (let i = 1; i < edges.length; i += 1) {
    assert.ok(edges[i][0] >= edges[i - 1][0],
      `第 ${i} 段的起点 ${edges[i][0]} 比前一段 ${edges[i - 1][0]} 小 —— 频率顺序乱了`);
  }
});

check('start <= end，且不越界', () => {
  const { edges } = binEdges();
  for (const [i, [s, e]] of edges.entries()) {
    assert.ok(s >= 1, `第 ${i} 段起点 ${s} < 1（bin 0 是直流分量，不能用）`);
    assert.ok(e <= 511, `第 ${i} 段终点 ${e} 越界`);
    assert.ok(s <= e, `第 ${i} 段 start(${s}) > end(${e}) —— Swift 里那是崩溃`);
  }
});

console.log('\n  壁纸只消费前 76 段（硬约束）');

// ⚠️ 这条是从壁纸 bundle 里查出来的：它把数组重采样到 512 后按
// Pe<=6/18/35/60/95/145/210/300 分 8 段，而 `Pe<=300` **没有 else**
// ⟹ 512 空间的 301..511 被丢掉，反推到 128 段就是只有前 76 段有用。
check('音乐主体（人声/主奏）落在前 76 段里', () => {
  const { edges, hzPerBin } = binEdges();
  const topOfUseful = edges[75][1] * hzPerBin;
  assert.ok(topOfUseful >= 6000,
    `前 76 段只覆盖到 ${Math.round(topOfUseful)} Hz —— 人声和主奏（250-4000Hz）`
    + '要留在这段里，否则壁纸看到的全是低频');
  assert.ok(topOfUseful <= 12000,
    `前 76 段覆盖到 ${Math.round(topOfUseful)} Hz —— 铺太宽会让低频分辨率不够，`
    + '鼓点驱动不了波纹');
});

check('低频每段独占一个 bin（鼓点要有分辨率）', () => {
  const { edges } = binEdges();
  for (let i = 0; i < 20; i += 1) {
    assert.strictEqual(edges[i][1] - edges[i][0], 0,
      `第 ${i} 段宽度 ${edges[i][1] - edges[i][0] + 1} —— 低频段要一对一，`
      + '否则鼓和低音混在一格里');
  }
});

console.log('\n  和 Swift 那边的参数一致（两份知识会漂）');

// ⚠️ 这个文件是 Swift 那段的**规格**，参数漂了它就失去意义 ——
// 而"两份知识漂掉"是这个项目反复栽的形状（音源列表、支持类型列表）。
check('Swift 和这里的分箱参数一致', () => {
  const swift = fs.readFileSync(
    path.join(__dirname, '..', 'native', 'GestureWallAudio.swift'), 'utf8');
  assert.match(swift, /let LINEAR_BINS = 20/,
    'Swift 的 LINEAR_BINS 不是 20 —— 和这份规格漂了');
  assert.match(swift, /let USEFUL_BINS = 76/,
    'Swift 的 USEFUL_BINS 不是 76 —— 那是壁纸的消费边界，不能随便改');
  assert.match(swift, /8000\.0/, 'Swift 里中频上界不是 8000 Hz');
  assert.match(swift, /BIN_COUNT = 128/, 'Swift 的 BIN_COUNT 不是 128');
  assert.match(swift, /FFT_SIZE = 1024/, 'Swift 的 FFT_SIZE 不是 1024');
});

console.log('\n  平滑与归一化（"不丝滑"那条）');

// ⚠️ 原来是 `v > prev ? v : prev*0.82 + v*0.18` —— **上升沿直接跳到新值**，
// 只有下降平滑 ⟹ 鼓点让柱子瞬间弹到顶，那正是用户报的"不丝滑"。
check('上升沿也要插值（原来直接跳到新值 = 不丝滑）', () => {
  const swift = fs.readFileSync(
    path.join(__dirname, '..', 'native', 'GestureWallAudio.swift'), 'utf8');
  const code = swift.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/smoothed\[i\] = v > prev \? v :/.test(code),
    '上升时直接赋值 v ⟹ 鼓点让柱子瞬间弹到顶，那就是"不丝滑"');
  assert.match(code, /prev \+ \(v - prev\) \* alpha/,
    '没有统一的插值 —— 两个方向都该插值，只是快慢不同');
  assert.match(code, /ATTACK|RELEASE/, '攻击和释放没有分开的参数');
});

// 手感参数要能一处调，而不是散在代码里。
check('三个手感参数在顶部集中（改它们不该动逻辑）', () => {
  const swift = fs.readFileSync(
    path.join(__dirname, '..', 'native', 'GestureWallAudio.swift'), 'utf8');
  for (const name of ['NORMALIZE', 'ATTACK', 'RELEASE']) {
    assert.match(swift, new RegExp(`let ${name}: Float = `),
      `${name} 不是顶部的常量 —— 手感参数要能一处调`);
  }
});

// ⚠️ sqrt：FFT 幅度的动态范围有两个数量级，线性映射要么全 0 要么全顶天。
check('归一化用 sqrt 压缩动态范围（"幅度不对"那条）', () => {
  const swift = fs.readFileSync(
    path.join(__dirname, '..', 'native', 'GestureWallAudio.swift'), 'utf8');
  const code = swift.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(code, /sqrtf\(mean \* NORMALIZE\)/,
    '线性归一化 ⟹ 安静时全是 0、鼓点时全部顶天（用户报的"幅度不对"）；'
    + 'sqrt 接近人耳的对数感知，是音频可视化的常规做法');
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
