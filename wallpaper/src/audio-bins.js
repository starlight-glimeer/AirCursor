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

// ⚠️⚠️⚠️ **BANDS = 64。128 = 左声道 64 + 右声道 64（右半镜像）。**
//
// 这是这一层最关键的一个判断，我前十一轮全建立在"128 个连续频段"上。
//
// 证据（三条互相独立，都指向 64）：
//   ① WE 的循环是 `for (int band = 0; band < 64; band++)`，
//      数组是 `audio16[16]/audio32[32]/audio64[64]` —— **没有任何 128 的数组**
//   ② shader uniform 是 `g_AudioSpectrum64Left` / `64Right` —— **两个 64**
//   ③ 壁纸侧两种取样都假设**两端对称**：
//      `jquery.audiovisualizer.js:91` 的 `getRingArray` 交替 shift/pop 从两端往里削；
//      `PWLine.js:147` 的 `iv = (120-密度)/2` 从中心往两边取
//
// 反证（一条）：粒子壁纸把 128 线性重采样到 512 —— 当连续数组用。
// ⟹ **读代码分不出来**，也无法从我们自己的数据判（数据能说"我发的效果好不好"，
//    不能说"WE 发什么"）⟹ 判据是用户看画面，而这个改动是可逆的。
//
// ⚠️ 最强的一条支持：**镜像让所有常量回到 WE 原值。**
//   加权分母 63（我改成过 127）、stride 2（我用过 2 又改 1，两轮都错）、
//   覆盖 0-5.9kHz（我搞成过 11.2kHz）
// ⟹ 我过去每个错都出自"把 64 段公式适配到 128 段"。前提换掉，补丁全都不需要了。
const BANDS = BIN_COUNT / 2;

// 频段加权：`2 − e^((1 − band/63) − 0.5)`
//
// ⚠️ **这是"柱子铺满整圈"的唯一原因。** 低频 ×0.351、高频 ×1.393（4 倍差距）——
// WE 主动压低频、抬高频，抵消音乐 1/f 的天然分布。
// 我之前没有任何加权 ⟹ 低频原样保留 ⟹ 用户报「3 点那片特别长」。
//
// ⚠️ 分母默认 `BANDS-1` = **63**（WE 原值）。我曾传 127 去适配 128 段。
function bandWeight(band, bands = BANDS) {
  const t = 1 - band / (bands - 1);
  return 2 - Math.E ** (t - 0.5);
}

// 一段的输出（不含平滑）。magnitude 是 |X| = sqrt(re²+im²)。
//
// ⚠️ 下界那个 `max(0, …)` 是一道**硬地板**：power < 1 ⟹ log10 为负 ⟹ 输出恒 0，
// 而频段加权是**乘法、乘不动 0**。那是"高段完全不动"的根因，
// 靠矩形窗的泄漏把整条谱抬到地板之上（WE 没有窗函数，见 GestureWallAudio.swift）。
function bandValue(magnitude, band, bands = BANDS) {
  const power = magnitude * magnitude;
  // ⚠️ power ≤ 0 时 log10 是 -inf，必须挡（WE 那边也判了 f2 > 0）
  const v = power > 0 ? LOG_SCALE * Math.log10(power) : 0;
  // ⚠️ WE 只 `fmin(1.0, …)` 截上界，而 log10 在功率很小时是负数
  // ⟹ 下界也要挡，否则柱子会往反方向长
  return Math.min(1, Math.max(0, v * bandWeight(band, bands)));
}

// 整帧：64 段算出来，镜像成 128。magnitudes 是 FFT 的 |X| 数组。
function frameValues(magnitudes, bands = BANDS) {
  const half = magnitudes.length;
  const total = bands * 2;
  const out = new Array(total).fill(0);
  for (let band = 0; band < bands; band += 1) {
    // ① 线性取样 **band × 2**（WE 原值），跳过 bin 0（直流分量）。
    //
    // ⚠️ 我曾把这里改成 stride 1，理由是"128 段照抄 band*2 会让频率范围翻倍"——
    // 那个观察对，但**解法错了**：范围翻倍的根源是"用 128 段"这个前提，
    // 不是 stride。前提改成 64+镜像之后，stride 2 就是对的（0-5.4kHz）。
    const index = Math.min(half - 1, band * 2 + 1);
    const v = bandValue(magnitudes[index] || 0, band, bands);
    // ② 镜像：左声道写前半，右声道写后半（倒序）。
    //
    // ⚠️ 我们的输入是双声道**取平均**（一路 PCM）⟹ 两半是同一份数据。
    // 那和 WE 在单声道音源下一致；立体声下 WE 两半会有细微差别，
    // 而我们拿不到分声道 FFT ⟹ **已知的简化**，成本是两倍 FFT。
    out[band] = v;
    out[total - 1 - band] = v;
  }
  return out;
}

module.exports = {
  LOG_SCALE, SMOOTH, BIN_COUNT, BANDS, bandWeight, bandValue, frameValues,
};
