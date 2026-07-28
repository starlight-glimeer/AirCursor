// 手势判定：关键点 → 事件。无 DOM、无 MediaPipe 依赖，所以能在没有摄像头的地方
// 跑用例 —— 和 AirCursor 把 pose.js 抽出来的理由一样。
//
// 主控制是双手捏合间距：两手都捏住拇指+食指，**拉开** = 镜头推进、画面放大，
// **合拢** = 拉远缩小。它是连续量，所以报绝对 0..1，由渲染层决定映射到多少 zoom；
// 这里只报"手在干什么"。
(function (root) {

// 捏合阈值取掌宽的比例，这样离摄像头远近不影响判定。0.45 来自 AirCursor 的实测。
const PINCH_RATIO = 0.45;

// 双手间距（掌宽为单位）到 0..1 的映射区间。两手贴着约 1 个掌宽，张开臂约 5-6，
// 上限压在 5.2 是因为再宽摄像头通常就看不全了。
const SPAN_MIN = 0.9;
const SPAN_MAX = 5.2;

// 挥动的手腕速度门（掌宽/秒）。和 AirCursor 的 swipe 律同一个思路：快才算有意，
// 慢的是在挪手。
const FLICK_SPEED = 2.4;
const FLICK_COOLDOWN_MS = 620;
// 必须是横向：斜着扫通常是把手移到别处，不是手势。
const FLICK_HORIZONTAL_RATIO = 1.6;
// 轨迹窗口。一次挥动大约 150-250ms，取 220ms 既够长又不至于把上一次挥动拖进来。
const PATH_WINDOW_MS = 220;

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// 食指根到小指根：一只手上唯一几乎不随姿势变化的跨度，所以能当尺度基准。
function palmWidth(lm) {
  return Math.max(1e-4, dist(lm[5], lm[17]));
}

function isPinched(lm) {
  return dist(lm[4], lm[8]) < palmWidth(lm) * PINCH_RATIO;
}

function palmCenter(lm) {
  let x = 0;
  let y = 0;
  for (const id of [0, 5, 9, 13, 17]) { x += lm[id].x; y += lm[id].y; }
  return { x: x / 5, y: y / 5 };
}

// 摄像头看到的是镜像：手往右动在画面里是往左，而壁纸跟着反方向动会让人觉得坏了
// 而不是反了。
function mirror(lm) {
  return lm.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z || 0 }));
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// 双手捏合 → zoom 值。任一只手没捏住就返回 null（不是 0）：0 是合法的"最小缩放"，
// 而 null 是"这个手势不成立"。哨兵值撞进合法取值域是 AirCursor 踩过的坑。
function twoHandZoom(hands) {
  if (!hands || hands.length < 2) return null;
  const [a, b] = hands;
  if (!isPinched(a) || !isPinched(b)) return null;
  const scale = (palmWidth(a) + palmWidth(b)) / 2;
  const span = dist(palmCenter(a), palmCenter(b)) / scale;
  return { span, value: clamp01((span - SPAN_MIN) / (SPAN_MAX - SPAN_MIN)) };
}

// 手腕轨迹，用来判挥动。速度按掌宽归一，所以远近一致。
class WristPath {
  constructor(windowMs = PATH_WINDOW_MS) {
    this.windowMs = windowMs;
    this.samples = [];
  }

  reset() { this.samples = []; }

  push(x, y, scale, now) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(scale > 0)) return;
    this.samples.push({ x, y, scale, t: now });
    while (this.samples.length > 2 && this.samples[0].t < now - this.windowMs) {
      this.samples.shift();
    }
  }

  // 窗口内的净位移和速度。净位移而非总路程：手出去又回来的净位移小，不该算挥动。
  displacement() {
    if (this.samples.length < 2) return null;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (!(dt > 0.04)) return null;
    const dx = (last.x - first.x) / last.scale;
    const dy = (last.y - first.y) / last.scale;
    return { dx, dy, dt, speed: Math.hypot(dx, dy) / dt };
  }
}

class FlickDetector {
  constructor() {
    // null 而不是 0："从没触发过"必须和一个合法时间戳不同，否则时钟起点后的第一个
    // 冷却窗口会白吃掉第一次挥动。AirCursor 正好栽过这个（角度 0 既是"指向右"又是
    // "没有轴"）。
    this.lastAt = null;
    this.blocked = null;
  }

  reset() { this.lastAt = null; this.blocked = null; }

  // 返回 'left' / 'right' / null。null 时 blocked 说明为什么 —— 这个手势有四种
  // 什么都不做的方式，不点名的话症状全是"识别到了但没反应"。
  update(displacement, now, speedThreshold = FLICK_SPEED) {
    if (!displacement) { this.blocked = 'noPath'; return null; }
    if (this.lastAt !== null && now - this.lastAt < FLICK_COOLDOWN_MS) {
      this.blocked = 'cooldown';
      return null;
    }
    const { dx, dy, speed } = displacement;
    if (speed < speedThreshold) { this.blocked = 'tooSlow'; return null; }
    if (Math.abs(dx) < Math.abs(dy) * FLICK_HORIZONTAL_RATIO) {
      this.blocked = 'notHorizontal';
      return null;
    }
    this.lastAt = now;
    this.blocked = null;
    return dx > 0 ? 'right' : 'left';
  }
}

root.GestureWallGestures = {
  PINCH_RATIO,
  SPAN_MIN,
  SPAN_MAX,
  FLICK_SPEED,
  FLICK_COOLDOWN_MS,
  PATH_WINDOW_MS,
  dist,
  palmWidth,
  isPinched,
  palmCenter,
  mirror,
  clamp01,
  twoHandZoom,
  WristPath,
  FlickDetector,
};
})(typeof window === 'undefined' ? globalThis : window);
