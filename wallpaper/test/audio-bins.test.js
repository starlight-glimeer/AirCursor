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
  // ⚠️ 阈值是 0，不是少一点就行 —— 算过 LINEAR_BINS=40 时能做到 0。
  // 任何重复都意味着那几根柱子的值一模一样，而那在画面上是看得见的。
  assert.strictEqual(affected, 0,
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

console.log('\n  两个壁纸的消费边界不一样（我曾把一个的当通用）');

// ⚠️ 这一节整个重写过 —— 原来断言"音乐主体落在前 76 段"，而那个 76 是**错的通用化**。
//
// 76 来自 Sonic Topography：它把数组重采样到 512，按 `Pe<=6/18/…/<=300` 分 8 段，
// 而 `Pe<=300` 之后没有 else ⟹ 301..511 被丢掉 ⟹ 反推 128 段 = 前 76 段。
//
// 而 PWCircle.js（884307090「完美壁纸」，用户 2026-07-31 提供源码）完全不同：
//   for(var i=0; i<120; i++){ var w1 = arr[i] ? arr[i] : 0; ... }
// **不重采样、索引一对一、用 arr[0..119]。**
//
// ⟹ 我拿一个壁纸的约束推到了全体，而那让 76..119 那 44 段（约 8-16kHz）
// 在这个壁纸上全是接近 0 的值 —— 画面上就是"一部分柱子死着"。
check('0..119 都要有音乐频段的值（PWCircle 用 arr[0..119]）', () => {
  const { edges, hzPerBin } = binEdges();
  const top119 = edges[119][1] * hzPerBin;
  assert.ok(top119 >= 12000,
    `第 119 段只到 ${Math.round(top119)} Hz —— PWCircle 用 arr[0..119]，`
    + '这 120 段都要落在音乐频段里，否则后面那些柱子恒为 0');
  // 而前 76 段仍然要覆盖住音乐主体（Sonic Topography 只看那 76 段）
  const top75 = edges[75][1] * hzPerBin;
  assert.ok(top75 >= 2000 && top75 <= 9000,
    `前 76 段覆盖到 ${Math.round(top75)} Hz —— 那是只看前 76 段的壁纸`
    + '（Sonic Topography）的可用范围，人声/主奏要在里面');
});

check('低频每段独占一个 bin（鼓点要有分辨率）', () => {
  const { edges } = binEdges();
  for (let i = 0; i < 40; i += 1) {
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
  assert.match(swift, /let LINEAR_BINS = 40/,
    'Swift 的 LINEAR_BINS 不是 40 —— 算过 40 时重复箱子为 0，改小会让相邻段共用 bin');
  assert.match(swift, /let USEFUL_BINS = 120/,
    'Swift 的 USEFUL_BINS 不是 120 —— PWCircle 用 arr[0..119]，'
    + '写 76 是把另一个壁纸的约束当成了通用规则');
  assert.match(swift, /16000\.0/, 'Swift 里中频上界不是 16000 Hz');
  assert.match(swift, /BIN_COUNT = 128/, 'Swift 的 BIN_COUNT 不是 128');
  assert.match(swift, /FFT_SIZE = 1024/, 'Swift 的 FFT_SIZE 不是 1024');
});

console.log('\n  平滑与归一化（"不丝滑"那条）');

// ⚠️ 这条的理由变了。
//
// 原来我以为"不丝滑"是因为上升沿不插值，于是两边都插值。而读了 PWCircle.js 才知道
// **它自己就有平滑**：
//     w2 = waveArr[i] - waveArr[i]*0.25;  w1 = Math.max(w1, w2);
// 上升立刻跟上、下降每帧 ×0.75 ⟹ 我们再平滑一次就是**双重平滑**，
// 那才是"拖泥带水"的来源。
//
// ⟹ 现在 ATTACK=1.0（不插值上升），RELEASE 只留一点点防 FFT 逐帧抖动。
// 平滑交给壁纸 —— 它比我们更知道自己的帧率。
check('平滑不和壁纸叠加（ATTACK=1.0，壁纸自己会衰减）', () => {
  const swift = fs.readFileSync(
    path.join(__dirname, '..', 'native', 'GestureWallAudio.swift'), 'utf8');
  const code = swift.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(code, /prev \+ \(v - prev\) \* alpha/, '没有统一的插值写法');
  assert.match(code, /let ATTACK: Float = 1\.0/,
    'ATTACK 不是 1.0 ⟹ 和 PWCircle 自己的平滑叠加（它 `Math.max(w1, w2)` '
    + '本来就让上升立刻跟上）—— 那是"拖泥带水"的来源');
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
// ⚠️ 上限必须是**物理上限**，不能是某个壁纸的内部数字。
//
// 我上一版写的是 `min(1.2, …)`，理由是"PWCircle 自己 clamp 到 1.2"——
// 那是照抄单个壁纸的实现细节，而**同一个错我已经犯过一次**
//（把 Sonic Topography 的 76 段边界写成通用常量）。
//
// 用户点出了定位：「我们的产品其实是个壁纸渲染器……而不是来一个适配一个」。
// ⟹ 判据：**如果一个数只能从"某个壁纸的源码"推出来，它就不该在这一层。**
check('上限是物理上限，不是某个壁纸的内部数字', () => {
  const swift = fs.readFileSync(
    path.join(__dirname, '..', 'native', 'GestureWallAudio.swift'), 'utf8');
  const code = swift.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(code, /let CEILING: Float/, '没有命名的上限常量');
  assert.match(code, /min\(CEILING, max\(0\.0, v\)\)/,
    'clamp 用了字面量而不是 CEILING —— 那通常意味着它是从某个壁纸抄来的数字');
  // ⚠️ 1.2 是 PWCircle 的内部上限，不该出现在我们的代码里
  assert.ok(!/min\(1\.2/.test(code),
    'clamp 到 1.2 —— 那是 PWCircle 的实现细节（`Math.min(w1, 1.2)`），'
    + '不是 WE 的契约。我们是渲染器，不适配单个壁纸');
});

// ⚠️ 这条守的是**那个错误形状本身**，不是某个具体的数。
check('这一层没有从单个壁纸抄来的魔数', () => {
  const swift = fs.readFileSync(
    path.join(__dirname, '..', 'native', 'GestureWallAudio.swift'), 'utf8');
  const code = swift.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  // 已知的、只属于某个壁纸的数字。它们出现在这里就说明又照抄了。
  const wallpaperSpecific = [
    ['1.2', 'PWCircle 的 `Math.min(w1, 1.2)`'],
    ['0.75', 'PWCircle 的衰减系数 `waveArr[i]*0.25`'],
    ['300', 'Sonic Topography 的 `Pe<=300` 消费边界'],
  ];
  for (const [num, from] of wallpaperSpecific) {
    // 允许出现在注释里（解释来由），不允许出现在代码里
    const inCode = new RegExp(`[^\\w.]${num.replace('.', '\\.')}[^\\w]`).test(code);
    assert.ok(!inCode,
      `代码里出现了 ${num} —— 那是 ${from}，属于单个壁纸的实现细节。`
      + '我们是渲染器：能留在这一层的数必须能从 WE 的行为或信号处理本身推出来');
  }
});

// ⚠️ 这条断言**翻过来了** —— 原来要求 sqrt，而实测证明 sqrt 是问题本身。
//
// 用户读到的实际频谱（sqrt + NORMALIZE=0.002）：
//   [0]0.433 [10]0.183 [20]0.28 [40]0.301 [60]0.279
// 反推原始幅度 93.7 / 16.7 / 39.2 / 45.3 / 38.9 ⟹ **原始动态 5.6 倍**，
// 而 sqrt 之后只剩 **2.4 倍**。
//
// ⟹ 用户报「柱子之间的差距不大，音乐的动感不强」就是这个。
// sqrt(x) 的性质：x 差 4 倍 ⟹ sqrt 只差 2 倍。而音频可视化要的正是对比。
//
// 也算过 dB（20*log10）—— 更糟，动态压到 1.3 倍。**方向搞反了**：
// 这一层要保留动态，不是压缩它。溢出交给壁纸（PWCircle 自己 `Math.min(w1,1.2)`）。
check('归一化是线性的（sqrt/dB 会把音乐的动态压掉）', () => {
  const swift = fs.readFileSync(
    path.join(__dirname, '..', 'native', 'GestureWallAudio.swift'), 'utf8');
  const code = swift.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(code, /var v = mean \* NORMALIZE/,
    '归一化不是线性的 —— sqrt 把实测的 5.6 倍动态压成 2.4 倍，'
    + '用户报"柱子差距不大、动感不强"');
  assert.ok(!/sqrtf\(/.test(code),
    'code 里还有 sqrtf —— 那会压掉音乐的动态对比');
  assert.ok(!/log10/.test(code),
    'code 里有 log10（dB）—— 算过：dB 把动态压到 1.3 倍，比 sqrt 更糟');
});

// ⚠️ 一条数值断言：拿实测数据跑一遍，确认动态没被压。
check('（数值）实测数据经过这层之后动态不小于 4 倍', () => {
  const swift = fs.readFileSync(
    path.join(__dirname, '..', 'native', 'GestureWallAudio.swift'), 'utf8');
  const m = swift.match(/let NORMALIZE: Float = ([\d.]+)/);
  assert.ok(m, '找不到 NORMALIZE');
  const N = Number(m[1]);
  // 用户实测反推出的原始 FFT 幅度（NORMALIZE=0.002、sqrt 版时读到的）
  const rawFft = [93.7, 81.6, 16.7, 39.2, 45.3, 38.9];
  const out = rawFft.map((x) => Math.min(2.0, x * N));
  const dynamic = Math.max(...out) / Math.min(...out);
  assert.ok(dynamic >= 4,
    `动态只有 ${dynamic.toFixed(1)} 倍 —— 原始信号是 5.6 倍，`
    + '压到 4 倍以下画面上就"差距不大"了（用户实测过 2.4 倍的效果）');
  // 同时不能让常态就顶天
  const maxOut = Math.max(...out);
  assert.ok(maxOut <= 1.0,
    `常态最大值 ${maxOut.toFixed(2)} —— 超过 1.0 说明 NORMALIZE 太大，`
    + '日常音乐就削顶了（削顶会让一片柱子长度相同 ⟹ 那正是"螺旋感"）');
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
