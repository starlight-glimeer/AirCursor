// 手骨架和指针，画在壁纸上的一层 2D canvas。
//
// 为什么必须有：没有它，"手势没反应"和"手根本没被检测到"是同一个症状 —— 录制的时候
// 只剩文字提示，用户不知道自己的手在画面里的哪个位置、有没有被看到。AirCursor 一开始
// 就有这个（overlay 的 drawHand + drawCursor），我搬手势判定的时候把它落下了。
//
// 无 DOM 依赖的部分（几何、颜色）抽出来可测；绘制留在类里。
(function (root) {

const HAND_LINES = [
  [0, 1, 2, 3, 4],
  [0, 5, 6, 7, 8],
  [0, 9, 10, 11, 12],
  [0, 13, 14, 15, 16],
  [0, 17, 18, 19, 20],
  [5, 9, 13, 17],
];

// 手离开画面后多久淡完。不立刻清掉：丢一两帧跟踪很常见，立刻消失会让骨架频闪，
// 那比没有骨架更让人以为出问题了。
const FADE_MS = 420;

// 两只手不同色调，这样"哪只手在动"一眼看出来。录制时整体转暖色 —— 状态变化要有一个
// 不用读文字就能察觉的信号。
function handHue(index, recording) {
  if (recording) return index === 0 ? 34 : 14;
  return index === 0 ? 188 : 292;
}

// 归一化坐标 → 画布像素。
function toCanvas(point, width, height) {
  return { x: point.x * width, y: point.y * height };
}

// 食指指尖（8 号）是指针位置。AirCursor 用它当光标，因为它是手上最容易精确指向的一点。
const INDEX_TIP = 8;

function indexTip(hand) {
  return hand && hand[INDEX_TIP] ? hand[INDEX_TIP] : null;
}

class HandOverlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.hands = [];
    this.recording = false;
    this.lastAt = 0;
    this.width = 0;
    this.height = 0;
  }

  resize(width, height, pixelRatio) {
    const dpr = Math.min(pixelRatio || 1, 2);
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  update(payload, now) {
    const next = (payload && payload.hands) || [];
    this.recording = !!(payload && payload.recording);
    if (next.length) {
      this.hands = next;
      this.lastAt = now;
      return;
    }
    // 手不在了：**保留最后一帧的姿势**，只让它淡出。
    //
    // 第一版直接 `this.hands = []`，于是 opacityAt 立刻返回 0，淡出代码一行都跑不到 ——
    // 骨架瞬间消失。而丢一两帧跟踪很常见，瞬间消失会让骨架频闪，那比没有骨架更让人
    // 以为出问题了。淡出的全部意义就在这里，而我把它写成了死代码。
    if (this.lastAt && now - this.lastAt > FADE_MS) this.hands = [];
  }

  // 返回 0..1 的不透明度。手在场是 1，离开后按 FADE_MS 淡出。
  opacityAt(now) {
    if (!this.hands.length || !this.lastAt) return 0;
    const age = now - this.lastAt;
    if (age <= 0) return 1;
    return Math.max(0, 1 - age / FADE_MS);
  }

  draw(now) {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.width, this.height);
    const alpha = this.opacityAt(now);
    if (alpha <= 0.01) return;

    ctx.save();
    // lighter：骨架叠在壁纸上要发光而不是遮挡 —— 壁纸是内容，骨架是叠加信息。
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const t = now / 1000;
    for (let index = 0; index < this.hands.length; index += 1) {
      const hand = this.hands[index];
      if (!hand || hand.length < 21) continue;
      // 色调随时间轻微游走：静止的手也在呼吸，这样"还活着"和"卡住了"能分开。
      const hue = handHue(index, this.recording) + Math.sin(t * 2.2 + index) * 22;
      const stroke = `hsl(${hue}, 100%, 64%)`;
      const core = `hsl(${hue + 25}, 100%, 82%)`;
      const points = hand.map((p) => toCanvas(p, this.width, this.height));

      ctx.globalAlpha = alpha * 0.9;
      ctx.strokeStyle = stroke;
      ctx.shadowColor = stroke;
      ctx.shadowBlur = this.recording ? 22 : 14;
      ctx.lineWidth = this.recording ? 5 : 3.5;
      for (const line of HAND_LINES) {
        ctx.beginPath();
        line.forEach((id, i) => {
          const p = points[id];
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.stroke();
      }

      ctx.globalAlpha = alpha;
      ctx.fillStyle = core;
      ctx.shadowBlur = 0;
      for (const p of points) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, this.recording ? 4.5 : 3.2, 0, Math.PI * 2);
        ctx.fill();
      }

      // 指针环画在食指指尖：这是"我在指哪"的答案，而那个问题之前完全没有答案。
      const tip = indexTip(hand);
      if (tip) this.drawPointer(toCanvas(tip, this.width, this.height), alpha, t, hue);
    }
    ctx.restore();
  }

  drawPointer(at, alpha, t, hue) {
    const { ctx } = this;
    const pulse = 1 + Math.sin(t * 3.4) * 0.12;
    ctx.globalAlpha = alpha * 0.85;
    ctx.strokeStyle = `hsl(${hue + 40}, 100%, 78%)`;
    ctx.lineWidth = 2;
    ctx.shadowColor = ctx.strokeStyle;
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(at.x, at.y, 13 * pulse, 0, Math.PI * 2);
    ctx.stroke();
    // 中心实点：环会随呼吸变大，需要一个不动的点来读位置。
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#ffffff';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(at.x, at.y, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

root.GestureWallOverlay = {
  HAND_LINES,
  FADE_MS,
  INDEX_TIP,
  handHue,
  toCanvas,
  indexTip,
  HandOverlay,
};
})(typeof window === 'undefined' ? globalThis : window);
