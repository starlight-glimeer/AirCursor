// FFT 分箱边界。**这是 GestureWallAudio.swift 那段分箱的可测规格。**
//
// ⚠️ 为什么要单独一份：那段逻辑在 Swift 里，而云端跑不了 Swift ——
// 而它**在数学上错过两次**：
//
//   第一次：纯对数铺满 1..512 ⟹ 38/128 个箱子读同一个 FFT bin
//           症状：画面上一段段等长的阶梯
//   第二次：低频改成线性一对一 ⟹ 不重复了，但**把音乐能量挤在头几段**
//           症状：用户报「3 点到 6 点这个区间的柱子明显更长」
//           （60-250Hz 的鼓和低音全落在段 0..4）
//
// 两次都是纯算术，本来在写下它的那一刻就能算出来。
// ⟹ 这个文件的存在理由：让那些性质变成断言。
//
// ⚠️ 这不是"另一份实现"：它只算边界，不做 FFT、不做归一化、不做平滑。
// 而守卫会核对两边的参数一致 —— 两份知识漂了是这个项目反复栽的形状。

// 分箱边界。**对数频率 + 低频插值**，那是音频可视化的标准做法。
//
// 返回每段的 [lo, hi]（**浮点** bin 索引）——
// 低频段的 lo/hi 差不足 1 个 bin，那时候用相邻 bin 线性插值，
// 而不是"取整后共用同一个 bin"（那正是第一版 38/128 重复的成因）。
function binEdges({ fftSize = 2048, binCount = 128, usefulBins = 120,
  sampleRate = 48000, fMin = 40, fMax = 16000 } = {}) {
  const half = fftSize / 2;
  const hzPerBin = sampleRate / 2 / half;
  const out = [];
  const ratio = fMax / fMin;
  for (let i = 0; i < binCount; i += 1) {
    // ⚠️ 只有前 usefulBins 段按音乐频段铺，之后的收尾到奈奎斯特 ——
    // PWCircle 用 arr[0..119]，而别的壁纸可能用满 128。
    // ⚠️ 前 usefulBins 段按对数铺音乐频段，之后的段线性收尾到奈奎斯特。
    // 两段要**衔接上**，不能各算各的（我第一版让段 119 的宽度变成 0.01）。
    let loHz;
    let hiHz;
    if (i < usefulBins) {
      loHz = fMin * ratio ** (i / usefulBins);
      hiHz = fMin * ratio ** ((i + 1) / usefulBins);
    } else {
      // 收尾段：从 fMax 线性铺到奈奎斯特。
      const tail = binCount - usefulBins;
      const nyq = sampleRate / 2;
      loHz = fMax + (nyq - fMax) * ((i - usefulBins) / tail);
      hiHz = fMax + (nyq - fMax) * ((i - usefulBins + 1) / tail);
    }
    out.push([
      Math.max(1, loHz / hzPerBin),
      Math.min(half - 1, Math.max(loHz / hzPerBin + 0.01, hiHz / hzPerBin)),
    ]);
  }
  return { edges: out, hzPerBin, half };
}

// 每段覆盖多少个整数 bin（<1 表示要插值）。
function binWidths(opts) {
  return binEdges(opts).edges.map(([lo, hi]) => hi - lo);
}

module.exports = { binEdges, binWidths };
