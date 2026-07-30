// 音频链的**下游**：128 段频谱 → 壁纸能不能用起来。
//
//   node test/audio-downstream.test.js
//
// 为什么单独一个文件：这条链有上下游两段，而它们的**验证条件完全不同**：
//
//   上游  怎么拿到系统音频        ⚠️ 要屏幕录制授权 + 打包，云端和开发模式都验不了
//   下游  128 段 → 壁纸渲染      ✅ 纯数据，喂假频谱就能验
//
// 之前这两段是绑在一起的：音频不出来时，"上游没拿到"和"下游算错了"分不清 ——
// 而它们的修法完全不同。⟹ 拆开之后，下游可以先证明是对的，
// 那样真机上没效果时就只剩上游一个嫌疑。
//
// ⚠️ 这里所有断言的依据都是**真实壁纸的消费代码**（音域回响 / Sonic Topography 的
// bundle，用户装载过、真机跑过），不是我猜的契约。每条都注明了证据。
const assert = require('node:assert');
require('../src/we-host.js');
const WE = globalThis.GestureWallWE;

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

// 复刻真实壁纸对音频的消费逻辑。
//
// ⚠️ 这不是我编的：它抄自 Sonic Topography 的 bundle（setWaveAudioData →
// getAudioData），关键三步是
//   ① 把收到的数组重采样到 512（`const t = e.length || 128`）
//   ② 按 8 个频段累加（Pe<=6 / <=18 / <=35 / <=60 / <=95 / <=145 / <=210 / <=300）
//   ③ 低频段驱动波纹、高频段驱动流星
// 复刻它是为了验"我们发的数据能让它算出该有的东西"，而不是验它自己。
function consumeLikeWallpaper(bins) {
  const resampled = new Array(512).fill(0);
  const len = bins.length || 128;
  for (let i = 0; i < 512; i += 1) {
    resampled[i] = bins[Math.floor(i * len / 512)] || 0;
  }
  const bands = [0, 0, 0, 0, 0, 0, 0, 0];
  const edges = [6, 18, 35, 60, 95, 145, 210, 300];
  for (let i = 0; i < 512; i += 1) {
    const v = resampled[i];
    for (let b = 0; b < edges.length; b += 1) {
      if (i <= edges[b]) { bands[b] += v; break; }
    }
  }
  const total = resampled.reduce((a, b) => a + b, 0);
  return {
    bands,
    energy: total / 512,
    // 低频（前两段）驱动波纹，高频（后三段）驱动流星 —— 那是它视觉效果的来源
    low: bands[0] + bands[1],
    high: bands[5] + bands[6] + bands[7],
  };
}

console.log('\n音频下游（128 段 → 壁纸）');

console.log('\n  形状契约');

// ⚠️ 长度不对不会报错，只会让整个频谱错位 —— 而错位的画面看起来"就是这个效果"。
check('无论上游给多少段，下游拿到的都是 128', () => {
  for (const n of [64, 128, 256, 512, 1024]) {
    const out = WE.normalizeAudioFrame(new Array(n).fill(0.5));
    assert.strictEqual(out.data.length, 128, `${n} 段没归一到 128`);
  }
});

// 这条是"上游坏了"和"下游坏了"的分界线：全 0 是合法帧（没在放歌就是这样），
// 但必须被标出来，否则和"我们算错了"分不清。
check('全 0 是合法帧但标 silent（上游没拿到 vs 下游算错，靠这个分）', () => {
  const out = WE.normalizeAudioFrame(new Array(128).fill(0));
  assert.strictEqual(out.ok, true, '全 0 被判成非法帧');
  assert.strictEqual(out.silent, true, '全 0 没标 silent');
});

console.log('\n  真实壁纸能不能用起来');

// 用一个"像音乐"的频谱：低频强、往高频衰减。
function musicLike(bassBoost = 1) {
  return Array.from({ length: 128 }, (_, i) => {
    const decay = Math.exp(-i / 30);
    return Math.min(1, decay * bassBoost * 0.8);
  });
}

check('音乐样频谱下，八个频段都拿到能量', () => {
  const out = WE.normalizeAudioFrame(musicLike());
  const consumed = consumeLikeWallpaper(out.data);
  // ⚠️ 只验"不是零"而不验具体值：具体值取决于归一化系数，那个还没标定。
  // 但"某个频段恒为 0"意味着那段视觉效果永远不触发，那是硬错误。
  for (let b = 0; b < 8; b += 1) {
    assert.ok(consumed.bands[b] > 0, `第 ${b} 频段能量为 0 —— 那段效果永远不触发`);
  }
});

// ⚠️ 这条守的是重采样方向。如果我把 128 段反着映射到 512，
// 低频会跑到高频段去 —— 表现是"鼓点触发流星、镲片触发波纹"，
// 而那看起来像壁纸自己的判定问题。
check('低频在低频段（重采样方向没反）', () => {
  // 只有前 8 段有能量的频谱
  const bassOnly = Array.from({ length: 128 }, (_, i) => (i < 8 ? 1 : 0));
  const consumed = consumeLikeWallpaper(WE.normalizeAudioFrame(bassOnly).data);
  assert.ok(consumed.low > 0, '低频信号没落到低频段');
  assert.strictEqual(consumed.high, 0, '低频信号泄漏到高频段了 —— 重采样方向反了');
});

// ⚠️ 这条我第一版写错了，而写错的过程查出一个重要约束。
//
// 原来用 `i > 100` 当"高频信号"，断言它落进高频段 —— 失败了。追下去发现
// 不是代码错，是**壁纸只用 512 空间的 0..300**：
//
//   Pe<=6?…:Pe<=210?…:Pe<=300&&(M+=ce)
//                            ↑ 没有 else
//
// 301..511 那 211 段被它自己丢掉。反推到 128 段空间 ⟹
// **只有前 76 段承载全部视觉效果，后 52 段白算。**
//
// ⟹ 这对上游是硬约束：GestureWallAudio.swift 的对数分组如果把有用信号挤到
// 第 76 段以后，画面会几乎不动 —— 而那看起来像"音频没接上"。
check('壁纸只用前 76 段（这是上游分组的硬约束）', () => {
  const inRange = Array.from({ length: 128 }, (_, i) => (i === 70 ? 1 : 0));
  const totalIn = consumeLikeWallpaper(WE.normalizeAudioFrame(inRange).data)
    .bands.reduce((a, b) => a + b, 0);
  assert.ok(totalIn > 0, '第 70 段的能量没被任何频段收到');

  const outRange = Array.from({ length: 128 }, (_, i) => (i === 100 ? 1 : 0));
  const totalOut = consumeLikeWallpaper(WE.normalizeAudioFrame(outRange).data)
    .bands.reduce((a, b) => a + b, 0);
  assert.strictEqual(totalOut, 0,
    '第 100 段被消费了 —— 和壁纸 bundle 里 Pe<=300 的边界不一致，'
    + '说明我复刻的消费逻辑不对');
});

check('有效范围内，高频落在高频段（重采样方向没反）', () => {
  const treble = Array.from({ length: 128 }, (_, i) => (i >= 60 && i <= 75 ? 1 : 0));
  const consumed = consumeLikeWallpaper(WE.normalizeAudioFrame(treble).data);
  assert.ok(consumed.high > 0, '高频信号没落到高频段');
  assert.strictEqual(consumed.low, 0, '高频信号泄漏到低频段了 —— 重采样方向反了');
});

// ⚠️ 截断是最隐蔽的一种错：如果上游给 256 段而我们只取前 128，
// 高频**整段消失** —— 而高频正是流星效果的触发源。
// 症状是"波纹有、流星永远不出现"，而那看起来像流星功能坏了。
check('上游给多于 128 段时按比例重采样，不截断', () => {
  // 用壁纸有效范围内的位置：256 段的 120..150 重采样后落在 60..75
  const long = Array.from({ length: 256 }, (_, i) => (i >= 120 && i <= 150 ? 1 : 0));
  const out = WE.normalizeAudioFrame(long);
  assert.strictEqual(out.resampled, true, '没标记成重采样过');
  const total = consumeLikeWallpaper(out.data).bands.reduce((a, b) => a + b, 0);
  assert.ok(total > 0, '256 段的中段信号丢了 —— 简单截断前 128 段的话这里会是 0');
});

console.log('\n  安静与响度');

check('没在放歌（全 0）时壁纸算出零能量，不是 NaN', () => {
  const consumed = consumeLikeWallpaper(WE.normalizeAudioFrame(new Array(128).fill(0)).data);
  assert.strictEqual(consumed.energy, 0);
  assert.ok(Number.isFinite(consumed.low) && Number.isFinite(consumed.high));
});

// ⚠️ NaN/Infinity 喂进 GLSL 会让整块画面变黑 —— 比丢一帧糟得多，而且不报错。
check('非法值进不到壁纸（NaN/Infinity 会让画面全黑）', () => {
  const dirty = [NaN, Infinity, -Infinity, -5, undefined, null, 'x'];
  const out = WE.normalizeAudioFrame([...dirty, ...new Array(121).fill(0.5)]);
  for (const v of out.data) {
    assert.ok(Number.isFinite(v) && v >= 0, `产出了非法值 ${v}`);
  }
  const consumed = consumeLikeWallpaper(out.data);
  assert.ok(Number.isFinite(consumed.energy), '壁纸算出 NaN 能量');
});

// 响度要能拉开差距，否则"音乐大声小声"在画面上看不出来。
check('响度差异传得下去（大声小声画面要不一样）', () => {
  const quiet = consumeLikeWallpaper(WE.normalizeAudioFrame(musicLike(0.2)).data);
  const loud = consumeLikeWallpaper(WE.normalizeAudioFrame(musicLike(1.0)).data);
  assert.ok(loud.energy > quiet.energy * 1.5,
    `大声(${loud.energy.toFixed(3)}) 和小声(${quiet.energy.toFixed(3)}) 差得太少`);
});

console.log('\n  这个文件证明了什么、没证明什么');

// ⚠️ 这条不是断言，是把范围写进测试输出 —— 免得"下游全绿"被读成"音频功能好了"。
check('（说明）下游对了不代表音频能用', () => {
  assert.ok(true);
});

console.log(`
  ✅ 已证明：128 段进来之后，重采样方向、频段归属、非法值防护、响度传递都对。
     ⟹ 真机上没有音频效果时，可以排除下游，只查上游。

  ⚠️ 没证明：
     · 上游能不能拿到系统音频（要屏幕录制授权 + 打包）
     · GestureWallAudio.swift 里那个 0.012 归一化系数对不对
       —— 它决定柱子是顶天还是几乎不动，而那只能真机调
     · FFT 的对数分组和 WE 原版的感知加权是否一致`);

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
