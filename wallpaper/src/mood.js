// 从封面像素推断氛围。
//
// 为什么用封面而不是音频：歌在网易云自己的客户端里播，我们拿不到音频流 —— 没有
// 频谱、没有 BPM。封面是系统唯一交出来的丰富信号，而唱片封面和歌的气质相关是设计
// 惯例，不是巧合。
//
// 输出连续值而不是"激情/舒缓/悲伤"这类标签，是刻意的：标签错了很显眼（"这首明明
// 很燃你说是舒缓"），连续值错了只是氛围偏一点。这一条和"别一开始就追求某块做对"
// 是同一个取舍。
//
// 只接受 RGBA 像素数组，不碰 DOM —— 取像素归调用方（wall.js 用 canvas），算数归
// 这里，所以这段能在没有浏览器的地方跑用例。
(function (root) {

// 中性氛围。没有封面、或封面读不出来时用它，比猜一个极端值安全。
const NEUTRAL = 0.35;

function analyzePixels(data) {
  if (!data || !data.length) return null;
  let rs = 0, gs = 0, bs = 0, n = 0;
  let satSum = 0, lumSum = 0, lumSqSum = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    // Rec.709 亮度，不是 (r+g+b)/3：人眼对绿最敏感，平均值会把绿色封面判暗。
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    satSum += max === 0 ? 0 : (max - min) / max;
    lumSum += lum;
    lumSqSum += lum * lum;
    rs += r; gs += g; bs += b; n += 1;
  }

  const sat = satSum / n;
  const lum = lumSum / n;
  // 对比度取亮度标准差：花哨高对比的封面读作有劲，平的读作氛围曲。
  const contrast = Math.sqrt(Math.max(0, lumSqSum / n - lum * lum));
  const warmth = (rs - bs) / n;   // -1..1，暖色封面偏正

  const mood = clamp01(sat * 0.42 + contrast * 1.5 + Math.max(0, warmth) * 0.5 + lum * 0.12);

  // 染色 = 平均色相对灰的偏移。归一化到"提亮"而不是"压暗"：会让整幅壁纸变暗的
  // 染色，在每张深色封面下都像 bug。
  const avg = { r: rs / n, g: gs / n, b: bs / n };
  const mean = (avg.r + avg.g + avg.b) / 3;
  const tint = mean > 1e-6
    ? { r: avg.r / mean, g: avg.g / mean, b: avg.b / mean }
    : { r: 1, g: 1, b: 1 };

  return { mood, tint, sat, lum, contrast, warmth };
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// 把染色朝中性回拉，所以那个滑块真的表示"这首歌给我的壁纸上多少色"。
function blendTint(tint, influence) {
  const k = clamp01(influence === undefined ? 1 : influence);
  return {
    r: 1 + (tint.r - 1) * k,
    g: 1 + (tint.g - 1) * k,
    b: 1 + (tint.b - 1) * k,
  };
}

// 压进 0.2..1.0 而不是 0..1：氛围为 0 会让画面暗到看不清主体，而那从来不是
// "这首歌很安静"该有的表现。
function moodToBrightnessRange(mood) {
  return 0.2 + clamp01(mood) * 0.8;
}

root.GestureWallMood = { NEUTRAL, analyzePixels, blendTint, moodToBrightnessRange, clamp01 };
})(typeof window === 'undefined' ? globalThis : window);
