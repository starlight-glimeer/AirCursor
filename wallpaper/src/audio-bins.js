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

// ⚠️ vDSP 的实数 FFT 带 2 倍因子（省了一次除 2）；WE 用 kiss_fftr（标准值）
// ⟹ 抵消它才和 WE 同尺度。**用户 0.9.13 真机量出来的**：
//   理论峰值 424.7（手写 DFT，纯数学）vs 实测 849.4 ⟹ 比值 **2.00**
// ⟹ 身份是"两个 FFT 库的约定差"，不是我调的系数。
const VDSP_SCALE = 0.5;
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

// 一段的输出，**在主瓣宽度上求功率和**（三个 bin），而不是单点取值。
//
// ⚠️⚠️ 为什么不能单点：**stride 2 丢掉一半的 bin**，而那是"细高刺"的根因。
// 实测 200Hz 谐波列：bin3=37.9 / **bin4=144.6（最强）** / bin5=42.8
// ⟹ 只读奇数 bin ⟹ bin4 那个峰完全丢了
// ⟹ 段值序列 `0.48 / 0.09 / 0.49 / 0.06 / 0.46` —— **奇偶交替**
// ⟹ 折线壁纸上一排细高刺，粒子壁纸上满屏孤立高柱（用户在两个壁纸上都看到了）
//
// ⚠️ 更基本的问题：**单点采样本身就抖**（这条不依赖 stride）。
// 实测矩形窗，同一正弦落在不同位置时邻居 bin 的相对值：
//     频率在 bin 20.00 ⟹ [19]0%   [20]100% [21]0%
//     频率在 bin 20.50 ⟹ [19]34%  [20]100% [21]98%
// ⟹ 邻居在 0% 和 98% 之间跳，**只取决于频率落在哪** ⟹ 柱子高度无故抖动
//
// ⟹ 三个 bin = 矩形窗主瓣的物理宽度（不是我调的窗口大小）。
// 云端实测（4 个基频取平均）：单点 13.8 个孤峰 → **3bin 求和 5.8 个**。
// 而 2bin 取 max（13.5）/ 2bin 求和（13.3）几乎没用 ⟹ **必须覆盖整个主瓣**，
// 而 4 个会开始把相邻段的能量混进来（那才是真的抹平频谱结构）。
//
// 功率相加而不是 magnitude 相加 —— 能量可加、幅度不可加（能量守恒）。
function bandValueFromLobe(magnitudes, index, band, bands = BANDS) {
  const half = magnitudes.length;
  let power = 0;
  const lo = Math.max(0, index - 1);
  const hi = Math.min(half - 1, index + 1);
  for (let k = lo; k <= hi; k += 1) {
    const m = (magnitudes[k] || 0) * VDSP_SCALE;
    power += m * m;
  }
  const v = power > 0 ? LOG_SCALE * Math.log10(power) : 0;
  return Math.min(1, Math.max(0, v * bandWeight(band, bands)));
}

// **一路声道的 64 段。** magnitudes 是那一路 FFT 的 |X| 数组。
//
// ⚠️ 镜像拼接**不在这里** —— 见 `mirror(left, right)`。
// 原因：两半现在是**两个不同声道**，而不是同一份数据复制两次。
// 用户 0.9.17 实测「孤峰固定在第59段」+「镜像逐段差 0.0000」⟹
// band 63 写到段 63 和段 64（相邻），而它加权 1.393（最大）
// ⟹ 9 点方向两根精确等高的最长柱子紧挨着 ⟹ 折线壁纸上一个尖顶。
function channelValues(magnitudes, bands = BANDS) {
  const half = magnitudes.length;
  const out = new Array(bands).fill(0);
  for (let band = 0; band < bands; band += 1) {
    // ① 线性取样 **band × 2**（WE 原值），跳过 bin 0（直流分量）。
    //
    // ⚠️ 我曾把这里改成 stride 1，理由是"128 段照抄 band*2 会让频率范围翻倍"——
    // 那个观察对，但**解法错了**：范围翻倍的根源是"用 128 段"这个前提，
    // 不是 stride。前提改成 64+镜像之后，stride 2 就是对的（0-5.4kHz）。
    const index = Math.min(half - 1, band * 2 + 1);
    // ⚠️ 抵消 vDSP 的 2 倍因子（见 VDSP_SCALE）—— 这里也要乘，
    // 否则 JS 规格和 Swift 会漂，而这份规格是云端唯一能跑的验证。
    out[band] = bandValueFromLobe(magnitudes, index, band, bands);
  }
  return out;
}

// 把两路 64 段拼成壁纸要的 128：左声道前半，右声道后半（倒序）。
//
// ⚠️ **段 63 和段 64 相邻，而它们是 band 63 的左右两路。**
// band 63 的加权是 1.393（全场最大）⟹ 那两段天然最长。
// 取平均（两路同一份数据）时它们**精确相等** ⟹ 9 点方向一个等高双柱尖顶。
// 分声道后立体声下不相等 ⟹ 尖顶消失。
// ⚠️ 单声道音源下仍然相等 —— 而那**不是 bug**，WE 也一样。
function mirror(left, right) {
  const bands = left.length;
  const out = new Array(bands * 2).fill(0);
  for (let b = 0; b < bands; b += 1) {
    out[b] = left[b];
    out[bands * 2 - 1 - b] = right[b];
  }
  return out;
}

// 兼容旧用法：单路输入 ⟹ 两半用同一份（等于旧行为）。
// ⚠️ 保留它只为让"取平均会导致等高双柱"这件事可测 —— 生产路径走 mirror()。
function frameValues(magnitudes, bands = BANDS) {
  const one = channelValues(magnitudes, bands);
  return mirror(one, one);
}

module.exports = {
  LOG_SCALE, SMOOTH, VDSP_SCALE, BIN_COUNT, BANDS,
  bandWeight, bandValue, bandValueFromLobe, channelValues, mirror, frameValues,
};
