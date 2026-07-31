// FFT 分箱边界。**这一整个文件是为一串真机 bug 写的。**
//
//   node test/audio-bins.test.js
//
// 分箱在数学上错过**两次**，两次都是纯算术，本来在写下它的那一刻就能算出来：
//
//   第一版：纯对数铺满 bin 1..512
//     ⟹ 38/128 个箱子读**同一个** FFT bin（低索引处 powf 增长极慢）
//     ⟹ 用户截图：一段段等长的阶梯
//
//   第二版：低频改成线性一对一（段 i ↔ bin 1+i）
//     ⟹ 不重复了，但**把音乐能量挤在头几段**：60-250Hz 的鼓和低音只落在段 0..4
//     ⟹ 用户报「3 点到 6 点这个区间的柱子明显更长」
//
// ⟹ 第三版：对数频率分箱 + 低频插值。那是音频可视化的标准做法，
// 也是唯一能同时满足「不重复」和「能量铺满整圈」的。
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

const SWIFT = path.join(__dirname, '..', 'native', 'GestureWallAudio.swift');
const swiftSrc = fs.readFileSync(SWIFT, 'utf8');
const swiftCode = swiftSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

console.log('\nFFT 分箱边界');

console.log('\n  两个真机 bug 各自的性质');

// ⚠️ 第一版的 bug：多个箱子读同一个 bin。
check('宽段不重复（第一版 38/128 读同一个 bin）', () => {
  const { edges } = binEdges();
  // 宽度 >= 1 bin 的段才比较整数范围；不足 1 的靠插值（见下一条）
  const wide = edges.map(([lo, hi], i) => ({ i, lo, hi, w: hi - lo })).filter((x) => x.w >= 1);
  const seen = new Map();
  for (const x of wide) {
    const key = `${Math.trunc(x.lo)}:${Math.trunc(x.hi)}`;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(x.i);
  }
  const dupes = [...seen.values()].filter((v) => v.length > 1).flat();
  assert.strictEqual(dupes.length, 0,
    `${dupes.length} 个宽段读同一个 bin 范围 —— 它们的值必然一样，`
    + `画面上就是等长的柱子。段号：${dupes.slice(0, 6)}`);
});

// ⚠️ 而低频段必然不足 1 个 bin 宽 —— 那不是 bug，是必须靠插值解决的事实。
check('低频段用插值（不足 1 个 bin 宽，取整就会重复）', () => {
  const { edges } = binEdges();
  const narrow = edges.filter(([lo, hi]) => hi - lo < 1);
  assert.ok(narrow.length > 20,
    `只有 ${narrow.length} 段不足 1 bin —— 那说明低频没按对数铺开`
    + '（对数分箱下低频段必然很窄，那是它能铺开鼓和低音的原因）');
  // Swift 里必须真的做了插值
  assert.match(swiftCode, /hi - lo < 1\.0/,
    'Swift 没有"不足 1 bin 就插值"的分支 ⟹ 取整后会大量重复（第一版的 bug）');
  assert.match(swiftCode, /a \+ \(b - a\) \* frac/,
    'Swift 没有线性插值 —— 那是低频不重复的唯一办法');
});

// ⚠️ 第二版的 bug：音乐能量挤在头几段。
check('鼓和低音（60-250Hz）铺开到 20 段以上（第二版只有 5 段）', () => {
  const { edges, hzPerBin } = binEdges();
  const inRange = edges.filter(([lo]) => {
    const f = lo * hzPerBin;
    return f >= 60 && f <= 250;
  });
  assert.ok(inRange.length >= 20,
    `60-250Hz 只占 ${inRange.length} 段 —— 那是鼓和低音的基频，`
    + '挤在头几段就会让圆周上那一小片柱子特别长（用户实测：3 点到 6 点明显更长）');
});

console.log('\n  边界的基本性质');

check('起点单调递增（倒退会让频率顺序乱掉）', () => {
  const { edges } = binEdges();
  for (let i = 1; i < edges.length; i += 1) {
    assert.ok(edges[i][0] >= edges[i - 1][0],
      `第 ${i} 段起点 ${edges[i][0].toFixed(2)} 小于前一段 `
      + `${edges[i - 1][0].toFixed(2)} —— 频率顺序乱了`);
  }
});

check('没有零宽段（对数段和收尾段要衔接上）', () => {
  const { edges } = binEdges();
  const zero = edges.map(([lo, hi], i) => ({ i, w: hi - lo })).filter((x) => x.w < 0.005);
  assert.strictEqual(zero.length, 0,
    `${zero.length} 个零宽段（段号 ${zero.map((x) => x.i)}）—— `
    + '那通常是"对数段和收尾段各算各的"造成的边界断裂');
});

check('不越界（bin 0 是直流分量，不能用）', () => {
  const { edges, half } = binEdges();
  for (const [i, [lo, hi]] of edges.entries()) {
    assert.ok(lo >= 1, `第 ${i} 段起点 ${lo.toFixed(2)} < 1（bin 0 是直流分量）`);
    assert.ok(hi <= half - 1, `第 ${i} 段终点 ${hi.toFixed(2)} 越界`);
  }
});

console.log('\n  和 Swift 那边的参数一致（两份知识会漂）');

// ⚠️ 这个文件是 Swift 那段的**规格**，参数漂了它就失去意义 ——
// 而"两份知识漂掉"是这个项目反复栽的形状（音源列表、支持类型列表）。
check('Swift 和这份规格的参数一致', () => {
  const want = [
    [/let FFT_SIZE = 2048/, 'FFT_SIZE 不是 2048 —— 低频要分辨率（1024 点是 46.9Hz/bin，'
      + '而那是鼓的整个基频范围）'],
    [/let SAMPLE_RATE = 48000/, 'SAMPLE_RATE 不是 48000'],
    [/BIN_COUNT = 128/, 'BIN_COUNT 不是 128'],
    [/let F_MIN: Float = 40\.0/, 'F_MIN 不是 40Hz'],
    [/let F_MAX: Float = 16000\.0/, 'F_MAX 不是 16000Hz'],
    [/let USEFUL_BINS = 120/, 'USEFUL_BINS 不是 120（PWCircle 用 arr[0..119]）'],
  ];
  for (const [re, why] of want) {
    assert.match(swiftSrc, re, why);
  }
});

console.log('\n  平滑与归一化');

// ⚠️ PWCircle 自己就有平滑（`w1 = Math.max(w1, prev*0.75)`）——
// 我们再平滑一次就是双重平滑，那是"拖泥带水"的来源。
check('平滑不和壁纸叠加（ATTACK=1.0，壁纸自己会衰减）', () => {
  assert.match(swiftCode, /prev \+ \(v - prev\) \* alpha/, '没有统一的插值写法');
  assert.match(swiftCode, /let ATTACK: Float = 1\.0/,
    'ATTACK 不是 1.0 ⟹ 和 PWCircle 自己的平滑叠加（它 `Math.max(w1, w2)` '
    + '本来就让上升立刻跟上）—— 那是"拖泥带水"的来源');
});

check('三个手感参数在顶部集中（改它们不该动逻辑）', () => {
  for (const name of ['NORMALIZE', 'ATTACK', 'RELEASE']) {
    assert.match(swiftSrc, new RegExp(`let ${name}: Float = `),
      `${name} 不是顶部的常量 —— 手感参数要能一处调`);
  }
});

// ⚠️ 上限必须是物理上限，不能是某个壁纸的内部数字。
check('上限是物理上限，不是某个壁纸的内部数字', () => {
  assert.match(swiftCode, /let CEILING: Float/, '没有命名的上限常量');
  assert.match(swiftCode, /min\(CEILING, max\(0\.0, v\)\)/,
    'clamp 用了字面量而不是 CEILING —— 那通常意味着它是从某个壁纸抄来的数字');
});

check('这一层没有从单个壁纸抄来的魔数', () => {
  const wallpaperSpecific = [
    ['1.2', 'PWCircle 的 `Math.min(w1, 1.2)`'],
    ['0.75', 'PWCircle 的衰减系数'],
    ['300', 'Sonic Topography 的 `Pe<=300` 消费边界'],
  ];
  for (const [num, from] of wallpaperSpecific) {
    const inCode = new RegExp(`[^\\w.]${num.replace('.', '\\.')}[^\\w]`).test(swiftCode);
    assert.ok(!inCode,
      `代码里出现了 ${num} —— 那是 ${from}，属于单个壁纸的实现细节。`
      + '我们是渲染器：能留在这一层的数必须能从 WE 的行为或信号处理本身推出来');
  }
});

// ⚠️ 归一化要保留动态 —— sqrt/dB 都会压掉它。
check('归一化是线性的（sqrt/dB 会把音乐的动态压掉）', () => {
  assert.match(swiftCode, /var v = mean \* NORMALIZE/,
    '归一化不是线性的 —— sqrt 把实测的 5.6 倍动态压成 2.4 倍，'
    + '用户报"柱子差距不大、动感不强"');
  assert.ok(!/sqrtf\(/.test(swiftCode), 'code 里还有 sqrtf —— 那会压掉动态对比');
  assert.ok(!/log10/.test(swiftCode), 'dB 把动态压到 1.3 倍，比 sqrt 更糟');
});

check('NORMALIZE 的依据写在注释里（三份独立证据）', () => {
  const i = swiftSrc.indexOf('let NORMALIZE');
  assert.ok(i > 0, '找不到 NORMALIZE');
  const before = swiftSrc.slice(Math.max(0, i - 2600), i);
  assert.match(before, /jquery\.audiovisualizer/,
    'NORMALIZE 的注释里没引用 jquery.audiovisualizer.js —— '
    + '那是"WE 会给出 >1 的值"的最强证据（第三方作者的 `Math.min(…, 1.5)`）');
  assert.match(before, /\/ 5/,
    '注释里没记 `param.range = properties.range.value / 5` —— '
    + '漏掉它会让柱子长度算大 5 倍（我犯过）');
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
