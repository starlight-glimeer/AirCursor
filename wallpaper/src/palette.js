// 配色和亮度曲线 —— **算出来的，不让模型猜**。
//
// ⚠️⚠️⚠️ 用户 2026-08-03：「不一定就是纯靠 prompt 去驱动 agent，
//   你也可以适当增加一些脚本什么的」
//
// ⚠️ 而这次的数据正好证明了它：模型三轮都在猜亮度系数，写出了
//   `lum = 0.4*(1-dd)*(1-dd)` 然后又 `lum *= (0.1+0.9*(1-dd))`
//   ⟹ 三次衰减、外圈纯黑、高亮占比 **0.0%**。
//   而它自己的注释里写着"根因分析：上一版把 lum 一路乘小" ——
//   **诊断对了，改的时候又犯了一次**。
//
// ⟹ 判据：**能用公式算准的，别让模型猜。**
//   模型该决定的是"什么形状、什么运动"（那是设计）；
//   而"距离 0.7 处的亮度该是多少"是**算术**，算术交给代码。
//
// ⚠️ 这个文件是**纯函数**（没有 THREE、没有 DOM）⟹ 云端能测。
//   而它同时被两处用：
//     ① 生成时**注入进 scene.js 的顶部**（模型直接调，不用自己推公式）
//     ② 测试里验"这条曲线真的落在目标区间内"

'use strict';

// ⚠️ 参考壁纸的实测值（preview.gif 200 帧逐帧量化）——
//   这些是**目标**，不是我的审美主张。
const TARGET = {
  // 底色：近黑偏蓝紫
  bg: 0x070815,
  // 主色相：安静时洋红紫，激烈时偏蓝紫
  hueCalm: 310,
  hueLoud: 235,
  // ⚠️⚠️ 饱和度中位 0.30-0.34（激烈时才到 0.65）——
  //   **低饱和是"高级感"的关键**，而模型默认给高饱和霓虹色。
  satBase: 0.32,
  satLoud: 0.62,
  // 亮度：中心偏白 → 外围没入底色
  lumCenter: 0.86,
  lumEdge: 0.18,
  // 三分带的目标平均亮度（0-255）
  bands: [25, 90, 50],
  // 近黑 / 高亮 的目标占比
  blackRatio: [0.20, 0.45],
  brightRatio: [0.05, 0.20],
};

// ⚠️⚠️⚠️ **亮度只衰减一次**（这是"一片黑"的头号成因）。
//
// ⚠️ 判据：**一条曲线，一个出口。** 模型那次是先平方再乘一次 ——
//   而只要提供**一个函数**，它就没有"再乘一次"的位置。
//
// @param d 0..1，到画面中心的归一化距离
// @param energy 0..1，该点的音频能量（可选，让亮的地方跟着音乐)
// ⚠️⚠️ **NaN 会传染** —— `Math.max(0, Math.min(1, NaN))` 是 NaN，
//   而一个 NaN 亮度会让 `setHSL` 静默失败（那个元素不显示，不报错）。
//   ⚠️ 模型可能传任何东西进来（未初始化的数组元素、除零的结果）
//   ⟹ 判据：**边界函数要把非数字当成 0，不能让它往下游传。**
function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : (n > 1 ? 1 : n);
}

function lumAt(d, energy) {
  const dd = clamp01(d);
  const e = clamp01(energy);
  // ⚠️ 线性插值 + 一点 ease（`dd*dd*0.35` 让中心那片更宽）——
  //   ⚠️ 不用纯平方：那样中心太尖、高亮占比上不去（目标 5-20%）。
  const t = dd * 0.65 + dd * dd * 0.35;
  const base = TARGET.lumCenter + (TARGET.lumEdge - TARGET.lumCenter) * t;
  // ⚠️ 音频只**加**不乘 —— 乘法会把外圈本来就低的亮度压到 0
  return Math.max(0, Math.min(1, base + e * 0.12));
}

// 饱和度：中心低（偏白）→ 外围高（偏紫），音乐激烈时整体升
// ⚠️ 那是参考壁纸的规律：中心暖白、中层紫、外围没入底色
function satAt(d, loudness) {
  const dd = clamp01(d);
  const l = clamp01(loudness);
  const base = TARGET.satBase * (0.55 + 0.75 * dd);
  return Math.max(0, Math.min(0.85, base + l * (TARGET.satLoud - TARGET.satBase)));
}

// 色相：安静洋红紫 → 激烈蓝紫，外圈略微偏移（让画面有色彩层次）
function hueAt(d, loudness) {
  const dd = clamp01(d);
  const l = clamp01(loudness);
  // ⚠️ 走**短弧** —— 310 → 235 直接线性插值是对的（差 75 度，不跨 0）
  const h = TARGET.hueCalm + (TARGET.hueLoud - TARGET.hueCalm) * l;
  return (h + dd * 18) % 360;
}

// ⚠️⚠️ **注入进 scene.js 的那段代码**（0.9.148）。
//
// ⚠️ 判据：**给模型现成的函数，比在提示词里描述公式可靠。**
//   描述公式它要自己实现一遍（而那次它实现错了）；给函数它只要调。
//   ⚠️ 而这段是**字符串常量**，和上面那三个函数是同一套数字 ——
//     测试里验两边一致（否则注入的和我们测的是两回事）。
const INJECT = `// ── 配色/亮度：由播放器提供的曲线（别自己推公式，那次三轮都推错了）
// ⚠️ NaN 会传染（一个 NaN 亮度会让 setHSL 静默失败）⟹ 非数字当 0
const _c01 = (v) => { const n = Number(v); return !Number.isFinite(n) ? 0 : (n < 0 ? 0 : (n > 1 ? 1 : n)); };
const DP = {
  bg: 0x${TARGET.bg.toString(16).padStart(6, '0')},
  // 亮度：d 是到中心的归一化距离(0..1)，energy 是该点音频能量(0..1)
  // ⚠️ 这条曲线已经把"中心偏白、外围没入底色"算好了 ⟹ **别再乘任何系数**
  lum(d, energy) {
    const dd = _c01(d);
    const e = _c01(energy);
    const t = dd * 0.65 + dd * dd * 0.35;
    return Math.max(0, Math.min(1, ${TARGET.lumCenter} + (${TARGET.lumEdge} - ${TARGET.lumCenter}) * t + e * 0.12));
  },
  // 饱和度：中心低(偏白)、外围高(偏紫)；loudness 是整体响度(0..1)
  sat(d, loudness) {
    const dd = _c01(d);
    const l = _c01(loudness);
    return Math.max(0, Math.min(0.85, ${TARGET.satBase} * (0.55 + 0.75 * dd) + l * ${(TARGET.satLoud - TARGET.satBase).toFixed(2)}));
  },
  // 色相(度)：安静洋红紫 → 激烈蓝紫
  hue(d, loudness) {
    const dd = _c01(d);
    const l = _c01(loudness);
    return (${TARGET.hueCalm} + (${TARGET.hueLoud} - ${TARGET.hueCalm}) * l + dd * 18) % 360;
  },
};
`;

module.exports = { TARGET, lumAt, satAt, hueAt, INJECT };
