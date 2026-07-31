// FFT 分箱边界。**这是 GestureWallAudio.swift 那段分箱的可测规格。**
//
// ⚠️ 为什么要单独一份：那段逻辑在 Swift 里，而云端跑不了 Swift ——
// 而它**在数学上错过一次**，错法是"38 个箱子读同一个 FFT bin"，
// 而症状是画面上一段段等长的阶梯（用户 2026-07-31 的截图）。
//
// 那种错误纯粹是算术，本来应该在写下它的那一刻就能算出来 ——
// ⟹ 所以把边界公式做成能跑的东西，让"每个箱子有自己的 bin"变成一条断言。
//
// ⚠️ 这不是"另一份实现"：它只算边界，不做 FFT、不做归一化、不做平滑。
// 而守卫会核对两边的参数（LINEAR_BINS / USEFUL_BINS / 8000Hz）一致 ——
// 两份知识漂了是这个项目反复栽的形状。

// 复刻 GestureWallAudio.swift 的分箱公式，用来在云端验数学。
// ⚠️ 这不是"另一份实现" —— 它只做分箱边界，且守卫会核对两边的参数一致。
function binEdges({ fftSize = 1024, binCount = 128, linearBins = 20, usefulBins = 76,
  sampleRate = 48000, midHz = 8000 } = {}) {
  const half = fftSize / 2;
  const hzPerBin = sampleRate / 2 / half;
  const midTop = Math.min(half - 1, Math.trunc(midHz / hzPerBin));
  const out = [];
  for (let i = 0; i < binCount; i += 1) {
    let start; let end;
    if (i < linearBins) {
      start = 1 + i; end = start;
    } else if (i < usefulBins) {
      const span = usefulBins - linearBins;
      const base = 1 + linearBins;
      const ratio = midTop / base;
      start = Math.max(base, Math.trunc(base * ratio ** ((i - linearBins) / span)));
      end = Math.min(half - 1, Math.max(start,
        Math.trunc(base * ratio ** ((i + 1 - linearBins) / span)) - 1));
    } else {
      const span = binCount - usefulBins;
      const ratio = half / midTop;
      start = Math.max(midTop, Math.trunc(midTop * ratio ** ((i - usefulBins) / span)));
      end = Math.min(half - 1, Math.max(start,
        Math.trunc(midTop * ratio ** ((i + 1 - usefulBins) / span)) - 1));
    }
    out.push([start, end]);
  }
  return { edges: out, midTop, hzPerBin };
}
module.exports = { binEdges };
