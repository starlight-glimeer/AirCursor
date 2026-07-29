// 手势预览：把存下来的模板画成骨架，动态的还能放成动图。
//
// 从 AirCursor 的 dashboard.js 搬过来。它是精华的原因很实际：**录完之后你怎么知道
// 录对了？** 只显示"已录制"的话，用户唯一的验证手段是摆一遍看有没有反应，而那把
// "录错了"和"匹配没过"混成同一个症状。画出来就一眼能看出录的是不是自己想的那个。
//
// 分两层：几何（这里，纯函数、可测）和绘制（needs canvas）。搬的时候保留了原来的
// 几个非显然决定，注释里标了原因 —— 那些都是踩过才知道的。
(function (root) {

const HAND_LINES = [
  [0, 1, 2, 3, 4],
  [0, 5, 6, 7, 8],
  [0, 9, 10, 11, 12],
  [0, 13, 14, 15, 16],
  [0, 17, 18, 19, 20],
  [5, 9, 13, 17],
];
const LANDMARKS_PER_HAND = 21;

// 模板的 values 是扁平数组（每点 x,y,z），拆回成每只手一组点。
//
// 模板在两只手之间共用一个原点和尺度，所以双手姿势里"两手的间距"本身就是签名的
// 一部分 —— 按画出来的包围盒去 fit 才能保住它（各手独立归一化会把间距抹掉）。
function templatePoints(template) {
  const values = template && template.values;
  const hands = template && template.hands;
  if (!Array.isArray(values) || !hands) return null;
  const out = [];
  for (let hand = 0; hand < hands; hand += 1) {
    const offset = hand * LANDMARKS_PER_HAND * 3;
    const points = [];
    for (let id = 0; id < LANDMARKS_PER_HAND; id += 1) {
      points.push({ x: values[offset + id * 3], y: values[offset + id * 3 + 1] });
    }
    out.push(points);
  }
  return out;
}

// 旋转 + 按包围盒 fit 到 w×h。返回可以直接画的点，以及用到的缩放（给点半径用）。
//
// tiltDeg 让倾斜类手势的第二帧显示"动作实际到达的位置"，而不是让用户看一个角度数字
// 自己想象。
function layout(hands, w, h, tiltDeg = 0, pad = 7) {
  const rot = (tiltDeg * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const placed = hands.map((points) =>
    points.map((p) => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos })));

  const all = placed.flat();
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  // `|| 1` 防零除：一只完全退化的手（所有点重合）会让 span 为 0。
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  return {
    scale,
    hands: placed.map((points) => points.map((p) => ({
      x: w / 2 + (p.x - cx) * scale,
      y: h / 2 + (p.y - cy) * scale,
    }))),
  };
}

// 两个模板之间的直线插值。
//
// 对旋转的手来说不是物理精确的，但关键帧之间足够近所以看不出差别，而它保住了一条
// 更重要的性质：**画出来的每一帧都是存下来的数据推出来的，不是合成的运动**。预览
// 骗人的话就失去了全部意义。
function lerpTemplate(a, b, k) {
  if (!a || !b || !a.values || !b.values || a.values.length !== b.values.length) return a;
  const values = new Array(a.values.length);
  for (let i = 0; i < a.values.length; i += 1) {
    values[i] = a.values[i] + (b.values[i] - a.values[i]) * k;
  }
  return { hands: a.hands, angle: a.angle, values };
}

// 按时间在关键帧序列里取一个插值后的姿势。
//
// 插值而不是切帧：关键帧是一段连续动作的抽稀采样，直接切会看成卡顿 —— 而真实手势
// 没有那个卡顿，所以那是预览在说谎。
function sampleAt(keyframes, atMs) {
  if (!keyframes || !keyframes.length) return null;
  if (keyframes.length === 1) return keyframes[0].template;
  let i = 0;
  while (i < keyframes.length - 2 && keyframes[i + 1].offsetMs < atMs) i += 1;
  const a = keyframes[i];
  const b = keyframes[i + 1];
  const span = Math.max(1, b.offsetMs - a.offsetMs);
  const k = Math.max(0, Math.min(1, (atMs - a.offsetMs) / span));
  return lerpTemplate(a.template, b.template, k);
}

// 动图的一个循环：走完动作，然后停一下再重来。
//
// 停顿（hold）是必要的：没有它，一个首尾相近的动作看起来是连续抖动而不是"做一遍
// 然后重放"，用户分不清动作从哪开始。
const PREVIEW_HOLD_MS = 420;

function cycleLength(keyframes) {
  if (!keyframes || keyframes.length < 2) return 0;
  const total = keyframes[keyframes.length - 1].offsetMs || 1;
  return total + PREVIEW_HOLD_MS;
}

// 循环里某个时刻该画什么：{ template, holding }。holding 为 true 时是停顿段，
// 调用方用它换个颜色，这样"动作结束了"是看得见的而不是要数节拍。
function frameAt(keyframes, elapsedMs) {
  const cycle = cycleLength(keyframes);
  if (!cycle) return null;
  const total = keyframes[keyframes.length - 1].offsetMs || 1;
  const t = ((elapsedMs % cycle) + cycle) % cycle;
  const at = Math.min(t, total);
  return { template: sampleAt(keyframes, at), holding: t > total };
}

root.GestureWallPreview = {
  HAND_LINES,
  LANDMARKS_PER_HAND,
  PREVIEW_HOLD_MS,
  templatePoints,
  layout,
  lerpTemplate,
  sampleAt,
  cycleLength,
  frameAt,
};
})(typeof window === 'undefined' ? globalThis : window);
