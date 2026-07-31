// WE 音频算法的**可测规格**。
//
// ⚠️⚠️ 这不是我设计的算法 —— 它逆向自 `linux-wallpaperengine`：
// `src/WallpaperEngine/Audio/Drivers/Recorders/PulseAudioPlaybackRecorder.cpp`
//
//     for (int band = 0; band < 64; band++) {
//         int index = band * 2;
//         f2 = re*re + im*im;                     // 功率，不开根
//         f1 = 0.35f * log10(f2);
//         dest[band] = min(1.0f, f1 * (2.0f - pow(M_E, (1.0f - band/63.0f) - 0.5f)));
//     }
//     movetowards(current, target, 0.3f);
//
// 为什么要一份 JS 规格：Swift 在云端跑不了，而这套算法我**猜错过八轮**
//（对数分箱 / 线性分箱 / 插值 / sqrt / 去掉 sqrt / 各种系数）。
// ⟹ 把它做成能跑的东西，让"和 WE 一致"变成断言而不是我的说法。
//
// ⚠️ 守卫会核对 Swift 和这里的每个常量一致 —— 两份知识漂了是本项目反复栽的形状。

const LOG_SCALE = 0.35;   // WE: `0.35f * log10(f2)`
const SMOOTH = 0.3;       // WE: `movetowards(cur, target, 0.3f)`
const BIN_COUNT = 128;

// 频段加权：`2 − e^((1 − band/(N−1)) − 0.5)`
//
// ⚠️ **这是"柱子铺满整圈"的唯一原因。** 低频 ×0.351、高频 ×1.393（4 倍差距）——
// WE 主动压低频、抬高频，抵消音乐 1/f 的天然分布。
// 我之前没有任何加权 ⟹ 低频原样保留 ⟹ 用户报「3 点那片特别长」。
function bandWeight(band, binCount = BIN_COUNT) {
  const t = 1 - band / (binCount - 1);
  return 2 - Math.E ** (t - 0.5);
}

// 一段的输出（不含平滑）。magnitude 是 |X| = sqrt(re²+im²)。
function bandValue(magnitude, band, binCount = BIN_COUNT) {
  const power = magnitude * magnitude;
  // ⚠️ power ≤ 0 时 log10 是 -inf，必须挡（WE 那边也判了 f2 > 0）
  const v = power > 0 ? LOG_SCALE * Math.log10(power) : 0;
  // ⚠️ WE 只 `fmin(1.0, …)` 截上界，而 log10 在功率很小时是负数
  // ⟹ 下界也要挡，否则柱子会往反方向长
  return Math.min(1, Math.max(0, v * bandWeight(band, binCount)));
}

// 整帧。magnitudes 是 FFT 的 |X| 数组。
function frameValues(magnitudes, binCount = BIN_COUNT) {
  const half = magnitudes.length;
  const out = [];
  for (let band = 0; band < binCount; band += 1) {
    // ① 线性取样：band × 2（WE 64 段时是 band*2，我们 128 段同样）
    const index = Math.min(half - 1, band * 2);
    out.push(bandValue(magnitudes[index] || 0, band, binCount));
  }
  return out;
}

module.exports = { LOG_SCALE, SMOOTH, BIN_COUNT, bandWeight, bandValue, frameValues };
