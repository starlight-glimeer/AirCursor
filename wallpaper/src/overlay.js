// 手骨架和指针，画在壁纸上的一层 2D canvas。
//
// 为什么必须有：没有它，"手势没反应"和"手根本没被检测到"是同一个症状 —— 录制的时候
// 只剩文字提示，用户不知道自己的手在画面里的哪个位置、有没有被看到。AirCursor 一开始
// 就有这个（overlay 的 drawHand + drawCursor），我搬手势判定的时候把它落下了。
//
// 无 DOM 依赖的部分（几何、颜色）抽出来可测；绘制留在类里。
(function (root) {

// One Euro：截止频率随手速自适应 —— 静止时压得住抖，快速移动时不迟钝。
// 指针一直在用它，而骨架路径**一直没有** —— 那就是"骨架很抖"的原因。
const OneEuro = root.AirCursorTracking && root.AirCursorTracking.OneEuroFilter;

// 骨架滤波的参数。比指针**更平滑**，因为两者要的东西不同：
//
//   指针  要"跟手"——它是鼠标，延迟直接体现为"指不准"
//   骨架  要"看着稳"——它是反馈，抖动比几十毫秒的延迟更让人觉得坏了
//
// ⚠️ 真机实测(5 份 capture,21 点在屏幕像素上的帧间跳动,屏宽 1470)：
// 中位 **84px**、90 分位 220px、最大 **1247px** ⟹ 手每帧跳 5.7% 屏宽。
// 用户报的「骨架手很抖」就是这个，而它一直没被处理。
//
// 扫参实测(同一批数据,统一口径 —— 只用连续有手的段):
//
//   minCutoff  beta    抖动中位   抖动最大   滞后中位
//   （不滤波）           85px      1247px       0
//   1.2       0.045      40px       282px    138px    ← 指针在用的参数
//   **0.6     0.02**     26px       159px    165px    ← 取这个
//   0.3       0.01       14px        98px    180px
//   0.15      0.005       7px        55px    188px
//
// 取 0.6/0.02：抖动降 **69%**，而滞后 165px 只比指针那档多 27px。再往下压抖动还能降，
// 但滞后收益已经很小（180→188px 换 14→7px）——**滞后就是"不跟手"**，那是用户报过的另一个问题。
//
// ⚠️ 只有 23 帧连续数据支撑这张表(五份 capture 里手连续在画面的段很短)。方向确定，
// 数值待真机体感确认 —— 如果觉得"跟不上手"就把 minCutoff 调回 1.2。
const SKELETON_FILTER = { minCutoff: 0.6, beta: 0.02, derivativeCutoff: 1 };

const HAND_LINES = [
  [0, 1, 2, 3, 4],
  [0, 5, 6, 7, 8],
  [0, 9, 10, 11, 12],
  [0, 13, 14, 15, 16],
  [0, 17, 18, 19, 20],
  [5, 9, 13, 17],
];

// 手离开画面后的两段处理:先**保持不变暗**,超过宽限才开始淡出。
//
// ⚠️ 单一个淡出时长不够,而这是真机数据逼出来的。实测(5 份 capture)手**在画面里**的时候
// 丢跟踪间隔是 35 / 102 / 284 / 284 / 319 / 319 / 872 ms —— 中位 284ms。而骨架平均只能
// 连续显示 **3 帧(105ms)**就断一次。
//
// 旧的 FADE_MS=420 单段淡出的后果:那些 284–319ms 的间隔里骨架已经淡到 25-30%,
// 下一帧又跳回全亮 ⟹ **明暗闪烁**,也就是用户报的「骨架显示不稳定」。
//
// 分两段:
//   HOLD_MS   这段时间内**完全不变暗** —— 覆盖常见的丢跟踪间隔(中位 284ms)
//   FADE_MS   之后才淡出 —— 手真的放下了就该消失
//
// 400ms 的宽限覆盖 6/7 次实测间隔(那个 872ms 的会淡出,但它更像"手真的移开了")。
const HOLD_MS = 400;
const FADE_MS = 420;

// 两只手不同色调，这样"哪只手在动"一眼看出来。录制时整体转暖色 —— 状态变化要有一个
// 不用读文字就能察觉的信号。
function handHue(index, recording) {
  if (recording) return index === 0 ? 34 : 14;
  return index === 0 ? 188 : 292;
}

// 骨架的目标手宽，屏幕像素。
//
// 第一版把归一化坐标直接乘满屏：手在摄像头画面里占 25%，在 1470px 宽的屏上就画成
// 367px —— 比真手大好几倍，糊住半个屏幕。骨架是叠加信息不是内容，它该像一只手，
// 而不是像一张手的海报。
//
// 200px 大约是一只手在半米外看起来的大小。跟着屏幕缩放（`SKELETON_SCREEN_FRACTION`）
// 而不是写死，因为在 4K 屏上 200px 又太小了。
const SKELETON_WIDTH_PX = 200;
const SKELETON_SCREEN_FRACTION = 0.14;

function skeletonWidth(screenWidth) {
  return Math.max(120, Math.min(SKELETON_WIDTH_PX, screenWidth * SKELETON_SCREEN_FRACTION));
}

// 归一化坐标 → 画布像素，但**按固定手宽缩放，不铺满屏**。
//
// 手的位置仍然映射到全屏（抬手到屏幕右边，骨架就在右边），只有手的**尺寸**被压到固定
// 大小。两者分开是关键：位置要覆盖整个屏幕才能指得到任何地方，尺寸不能跟着屏幕长。
//
// 归一化坐标 → 画布像素。**一比一,不缩放。**
//
// 原来这里把手按"固定手宽"缩放(围绕掌心压到 200px)。那是错的,而且错在一个不显眼的
// 地方:缩放保住了掌心位置,却把**所有其他关键点朝掌心收缩** —— 实测压到 0.54 倍,于是
// 指尖画出来离真实位置差一大截。用户的描述是"骨架位置不对、偏右",而根因不是偏移是收缩。
//
// 骨架的用途是"我的手现在在哪、指着什么",所以它必须和真实位置一一对应。手在画面里
// 占多大,画出来就该占多大 —— 这本来就是摄像头看到的比例,不需要"修正"。
function toCanvas(point, width, height) {
  return { x: point.x * width, y: point.y * height };
}

function handSpan(hand) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of hand) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    width: maxX - minX,
    height: maxY - minY,
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
  };
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

  // 自检:把"画布到底多大、骨架到底画到哪个像素"报出来。
  //
  // 存在的理由是这条链改了两次零好转。我一直在量"手在数据里的位置"(那是对的),而从没量过
  // "骨架落在屏幕的哪个像素" —— 两者之间隔着 canvas 缓冲尺寸、CSS 尺寸、DPR 三层,而错
  // 就在 CSS 那层(canvas 没设 CSS 尺寸,默认 300x150,整张画布被压到屏幕左上角)。
  //
  // 所以这个方法报的是**端到端**:输入归一化坐标 → 输出屏幕像素,以及中间每一层的尺寸。
  // 任何一层不对,数字自己会说出来。
  selfCheck() {
    const cssW = this.canvas.clientWidth;
    const cssH = this.canvas.clientHeight;
    const probes = [
      { name: '左上', x: 0, y: 0 },
      { name: '正中', x: 0.5, y: 0.5 },
      { name: '右下', x: 1, y: 1 },
    ];
    return {
      // 三个尺寸必须一致(乘 dpr 之后)。不一致就是画布被缩放显示了。
      buffer: { w: this.canvas.width, h: this.canvas.height },
      css: { w: cssW, h: cssH },
      logical: { w: this.width, h: this.height },
      dpr: cssW ? Number((this.canvas.width / cssW).toFixed(2)) : null,
      // 缓冲和 CSS 的比值如果不等于 dpr,画布就在被拉伸/压缩。
      consistent: cssW > 0 && Math.abs(this.width - cssW) < 2 && Math.abs(this.height - cssH) < 2,
      // 端到端:归一化坐标画到哪个 CSS 像素。这三个数直接和"你看到骨架在哪"对照。
      mapped: probes.map((p) => {
        const out = toCanvas(p, this.width, this.height);
        return { at: p.name, x: Math.round(out.x), y: Math.round(out.y) };
      }),
    };
  }

  // 擦掉但不销毁:关掉"显示骨架"时用。窗口要留着(摄像头在这一层),所以"不显示"只能
  // 靠不画 —— 而画布上一帧的内容不会自己消失,必须擦。
  clear() {
    if (!this.width) return;
    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  resize(width, height, pixelRatio) {
    const dpr = Math.min(pixelRatio || 1, 2);
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // 把一帧关键点过滤波器。每只手每个点各一对 x/y 滤波器 —— 一共 2×21×2 个。
  //
  // 按"第几只手的第几个点"索引，而不是跟着手的身份：MediaPipe 的手序帧间会换位，
  // 而对骨架来说画错哪只手比抖动更明显。sendHands 那边已经按 handedness 排过序。
  smooth(hands, now) {
    if (!OneEuro) return hands;      // tracking.js 没加载时原样画，不该因此没有骨架
    if (!this.filters) this.filters = [];
    return hands.map((hand, hi) => {
      if (!this.filters[hi]) this.filters[hi] = [];
      const bank = this.filters[hi];
      return hand.map((p, ki) => {
        if (!bank[ki]) {
          bank[ki] = { x: new OneEuro(SKELETON_FILTER), y: new OneEuro(SKELETON_FILTER) };
        }
        return { x: bank[ki].x.filter(p.x, now), y: bank[ki].y.filter(p.y, now) };
      });
    });
  }

  update(payload, now) {
    const next = (payload && payload.hands) || [];
    this.recording = !!(payload && payload.recording);
    if (next.length) {
      // ⚠️ 只有**画**的时候滤波，判定用的是未经滤波的原始坐标。
      //
      // 两者要的东西不同：判定要的是"手真实在哪"（滤波会让快速动作的幅度变小，
      // 而幅度正是动作判据），骨架要的是"看着稳"。同一份数据两个用途，各走各的。
      this.hands = this.smooth(next, now);
      this.lastAt = now;
      return;
    }
    // 手不在了：**保留最后一帧的姿势**，只让它淡出。
    //
    // 第一版直接 `this.hands = []`，于是 opacityAt 立刻返回 0，淡出代码一行都跑不到 ——
    // 骨架瞬间消失。而丢一两帧跟踪很常见，瞬间消失会让骨架频闪，那比没有骨架更让人
    // 以为出问题了。淡出的全部意义就在这里，而我把它写成了死代码。
    if (this.lastAt && now - this.lastAt > HOLD_MS + FADE_MS) {
      this.hands = [];
      // 滤波器一起清掉：留着的话下次举手时骨架会从上次的位置"飞"过来，
      // 而那比抖动更奇怪 —— One Euro 的状态是"上一个位置"，跨越一次手不在的间隔没有意义。
      this.filters = [];
    }
  }

  // 返回 0..1 的不透明度。手在场是 1，离开后先保持 HOLD_MS 再按 FADE_MS 淡出。
  //
  // 两段的理由见 HOLD_MS：真机上手在画面里的时候丢跟踪间隔中位 284ms，单段淡出会让
  // 骨架在那些间隔里淡到 30% 又跳回全亮 —— 那个明暗闪烁比抖动更显眼。
  opacityAt(now) {
    if (!this.hands.length || !this.lastAt) return 0;
    const age = now - this.lastAt;
    if (age <= HOLD_MS) return 1;
    return Math.max(0, 1 - (age - HOLD_MS) / FADE_MS);
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
      // 一比一,不缩放。
      //
      // 这里原来按"固定手宽"围绕掌心缩放。上一轮我改了 toCanvas 的签名却漏了这个调用点 ——
      // 多余的实参被 JS 静默忽略,于是缩放照旧生效,而我以为改完了。用户第二次报"还是偏右"
      // 才发现。⚠️ 改函数签名时必须同时查所有调用点:JS 不会为多传的参数报错。
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
      if (tip) {
        this.drawPointer(toCanvas(tip, this.width, this.height), alpha, t, hue);
      }
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
  HOLD_MS,
  FADE_MS,
  INDEX_TIP,
  SKELETON_WIDTH_PX,
  SKELETON_SCREEN_FRACTION,
  skeletonWidth,
  handSpan,
  handHue,
  toCanvas,
  indexTip,
  HandOverlay,
};
})(typeof window === 'undefined' ? globalThis : window);
