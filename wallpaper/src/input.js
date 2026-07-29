// 手势 → 视角，用 AirCursor 那套判定。
//
// 这个文件取代了我原来自己写的 `gestures.js`（145 行的最小实现）。作废它的理由不是
// 代码重复，是**手感**：用户反馈"有反馈但效果不好"，而我缺的三样正好一一对应 ——
//
//   OneEuroFilter   截止频率随手速自适应。我原来用固定 rate=5 的指数平滑，
//                   慢速够顺但快速迟钝，调快则静止时抖。两头都不讨好，这是
//                   "效果不好"的最大来源。
//   SwipeDetector   除速度外还判净位移、直线度，并且**要求手腕先停下**才重新
//                   武装。我原来只看速度+方向，所以回手会被当成第二次挥动。
//   TiltRatchet     "抬一次动一格"，手回到起始姿势才能再抬。我原来没有任何
//                   可重复的离散输入。
//
// 这些都在 `public/pose.js` / `motion.js` / `tracking.js` 里，是另一个 agent 维护的
// 文件。这里**只读不改** —— 壁纸引用它们，不动那边一行代码，所以两边可以各自演进。
//
// 无 DOM 依赖，和被它引用的那三个文件同一个约定，所以能跑纯逻辑用例。
(function (root) {
const Pose = root.AirCursorPose;
const Motion = root.AirCursorMotion;
const Tracking = root.AirCursorTracking;

if (!Pose || !Motion || !Tracking) {
  throw new Error('input.js 需要先加载 pose.js / motion.js / tracking.js');
}

// 捏合阈值取掌宽的比例，所以离摄像头远近不影响判定。0.45 是 AirCursor 实测值。
const PINCH_RATIO = 0.45;

// 双手间距（掌宽为单位）映射到 zoom 0..1。两手贴着约 1 个掌宽，张开臂约 5-6；
// 上限压在 5.2 是因为再宽摄像头通常就看不全了。
const SPAN_MIN = 0.9;
const SPAN_MAX = 5.2;

// AirCursor 那三个模块全程假设**像素**坐标 —— 它喂的是 window.innerWidth 量级的值。
// 这个假设烧进了常数里，不止一处：
//
//   pose.js  palmWidthOf 有 `Math.max(60, ...)`，60px 的掌宽下限
//   tracking PointerFilter 默认 deadzone 1.6px、maxPrediction 26px
//
// MediaPipe 给的是归一化 0..1，直接喂进去的后果不是"精度差一点"而是**彻底失效**：
// 掌宽被钳到 60，于是所有按掌宽归一的速度都除以 60 变成 0，挥动永远触发不了。
// 实测到 `speed 0.0` 才发现，而我当时正准备去改夹具。
//
// 所以进 AirCursor 模块前统一乘到一个虚拟像素空间，出来再除回去。1000 是量级对的
// 任意值：让下限相当于 6% 屏宽（合理），1.6px 死区相当于 0.16%（合理）。
//
// ⚠️ 那个"60"现在是 AirCursor 导出的 Pose.PALM_WIDTH_FLOOR_PX（他们在 f0d30d5 里
// 把这个像素假设显式导出了，起因就是我在这上面栽过）。下面的断言把两边绑住：
// 如果上游改了下限而这里的 1000 没跟着调，比例会失真而**不会报错** —— 那正是
// 原来那个 bug 的形状（数值悄悄失效，症状是"手势没反应"）。
const FILTER_SPACE = 1000;

// 掌宽下限占虚拟屏宽的比例。太大 ⟹ 真实的手总被判成"最小手"，速度全被压扁；
// 太小 ⟹ 下限形同不存在，抖动会被当成大幅移动。6% 是手举在半米外的量级。
const PALM_FLOOR_FRACTION = Pose.PALM_WIDTH_FLOOR_PX / FILTER_SPACE;
if (!(PALM_FLOOR_FRACTION > 0.01 && PALM_FLOOR_FRACTION < 0.15)) {
  // 启动时就炸，而不是等手势不响。上游改了下限就必须重新想 FILTER_SPACE。
  throw new Error(
    `掌宽下限占屏宽 ${(PALM_FLOOR_FRACTION * 100).toFixed(1)}%，超出合理区间 ——`
    + ` AirCursor 的 PALM_WIDTH_FLOOR_PX 变成 ${Pose.PALM_WIDTH_FLOOR_PX} 了，`
    + ' FILTER_SPACE 要跟着调');
}

// 把一只手的关键点从归一化升到 FILTER_SPACE 的像素空间。
function toPixels(lm) {
  return lm.map((p) => ({ x: p.x * FILTER_SPACE, y: p.y * FILTER_SPACE, z: (p.z || 0) * FILTER_SPACE }));
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// 食指根到小指根：一只手上唯一几乎不随姿势变化的跨度，所以能当尺度基准。
// 直接用 pose.js 的实现而不是自己算 —— 那边对退化情形有下限保护。
function palmWidth(lm) {
  return Math.max(1e-4, Pose.palmWidthOf(lm));
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
// 而 null 是"这个手势不成立"。哨兵值撞进合法取值域是 AirCursor 踩过的坑
// （角度 0 既表示"指向右"又表示"没有轴"）。
function twoHandZoom(hands) {
  if (!hands || hands.length < 2) return null;
  const [a, b] = hands;
  if (!isPinched(a) || !isPinched(b)) return null;
  const scale = (palmWidth(a) + palmWidth(b)) / 2;
  const span = dist(palmCenter(a), palmCenter(b)) / scale;
  return { span, value: clamp01((span - SPAN_MIN) / (SPAN_MAX - SPAN_MIN)) };
}

// 一帧的输入 → 一组事件。
//
// 判定全部委托给 AirCursor 的三个模块，这里只负责：喂数据、把结果翻译成壁纸的事件
// 格式、以及记录"为什么没触发"。最后一项不是可选的 —— 这些手势各有四五种什么都不做
// 的方式，不点名的话症状全都是"识别到了但没反应"，而那正是 AirCursor 烧掉四轮 debug
// 的形状。
class GestureInput {
  constructor(tuning) {
    this.pointer = new Tracking.PointerFilter(this.filterTuning(tuning));
    this.path = new Motion.WristPath();
    this.swipe = new Motion.SwipeDetector();
    // 一个棘轮，不是每方向一个。TiltRatchet 自己按倾斜的正负决定方向并返回 ±1，
    // 所以两个实例喂同样的输入只会同时报同一个方向 —— 我第一版就是那么写的，
    // "各管一个方向"听着合理但机制上不成立。
    this.ratchet = new Motion.TiltRatchet();
    // 用户录的手势：动作 id → 序列匹配器。按需创建，因为序列带进度状态，两个动作
    // 共用一个匹配器会互相污染。
    this.sequences = new Map();
    this.statics = new Map();
    this.blocked = null;
    this.lastSeenAt = 0;
  }

  sequenceFor(action) {
    if (!this.sequences.has(action)) this.sequences.set(action, new Motion.SequenceMatcher());
    return this.sequences.get(action);
  }

  // 静态录制手势的"武装"状态。自己管而不是借 SequenceMatcher.lastFiredAt —— 那个字段
  // 是给序列进度用的，借它的语义会让两种匹配互相干扰（第一版就是这么写的，结果是
  // 保持一个手型会每个冷却期触发一次）。
  staticState(action) {
    if (!this.statics.has(action)) this.statics.set(action, { armed: true });
    return this.statics.get(action);
  }

  // 把壁纸的调参映射成 PointerFilter 的像素量级参数。deadzone / prediction 在配置里
  // 是归一化的（"屏幕的百分之几"），乘 FILTER_SPACE 换算过去。
  filterTuning(tuning) {
    const t = tuning || {};
    return {
      minCutoff: t.minCutoff ?? 1.2,
      beta: t.beta ?? 0.045,
      deadzone: (t.deadzone ?? 0.0016) * FILTER_SPACE,
      prediction: t.prediction ?? 0.35,
      maxPrediction: (t.maxPrediction ?? 0.026) * FILTER_SPACE,
    };
  }

  setTuning(tuning) {
    this.pointer.setTuning(this.filterTuning(tuning));
  }

  reset() {
    this.pointer.reset();
    this.path.reset();
    this.swipe.reset();
    this.ratchet.reset();
    for (const matcher of this.sequences.values()) matcher.reset();
    for (const state of this.statics.values()) state.armed = true;
  }

  // hands: MediaPipe 的 multiHandLandmarks（未镜像）。now: 毫秒。
  // 返回 { events: [...], status: '...' }。
  update(hands, now, config) {
    const list = Array.isArray(hands) ? hands : [];
    if (!list.length) {
      // 手离开了就重置，否则下次举手时会拿旧轨迹算出一次假挥动。
      if (now - this.lastSeenAt > 400) this.reset();
      return { events: [], status: '未检测到手' };
    }
    this.lastSeenAt = now;

    // 镜像后升到像素空间。两步都在这里做完，后面所有代码都在同一个单位下工作 ——
    // 混着用是上面那个 speed 0.0 的根源。
    const mirrored = list.map((lm) => toPixels(mirror(lm)));
    const events = [];

    // 双手捏合优先：它是主控制，而且做这个手势时单手逻辑没有意义。
    const zoom = twoHandZoom(mirrored);
    if (zoom) {
      events.push({ action: 'zoom', value: zoom.value });
      this.path.reset();
      return {
        events,
        status: `双手捏合 · 间距 ${zoom.span.toFixed(2)} 掌宽 → ${(zoom.value * 100).toFixed(0)}%`,
      };
    }

    const lm = mirrored[0];
    const palm = palmCenter(lm);
    const scale = palmWidth(lm);

    // 指针走 One Euro：截止频率随手速自适应，所以静止时不抖、快速移动时不迟钝。
    // 这是替换掉固定平滑的那一步。坐标已在像素空间，滤波完除回归一化交给渲染层。
    const filtered = this.pointer.update(palm.x, palm.y, now);
    events.push({
      action: 'pointer',
      x: clamp01(filtered.x / FILTER_SPACE),
      y: clamp01(filtered.y / FILTER_SPACE),
    });

    // 挥动：交给 SwipeDetector。它比我原来的实现多两道门（净位移、直线度）和一条
    // 关键规则 —— 手腕必须先慢下来才重新武装，所以回手不会算成第二次挥动。
    this.path.push(palm.x, palm.y, scale, now);
    const displacement = this.path.displacement();
    const direction = this.swipe.update({
      displacement,
      speedThreshold: (config && config.swipeSpeed) || Motion.SWIPE_MIN_SPEED,
      now,
    });
    // 显式和 0 比：SwipeDetector 用 0 表示"没触发"、±1 表示方向。`if (direction)`
    // 碰巧也对，但那是依赖 0 的 falsy —— 哪天它改成返回一个对象就静默失效了。
    if (direction === 1 || direction === -1) {
      events.push({ action: direction > 0 ? 'swipeRight' : 'swipeLeft' });
      this.blocked = null;
      return { events, status: `挥动 ${direction > 0 ? '→ 右转' : '← 左转'}` };
    }

    // 用户录的手势：优先于内置律。录了就说明用户要用自己那套，而不是我们猜的。
    const recorded = this.updateRecorded(mirrored, now, config);
    if (recorded) {
      events.push(recorded);
      return { events, status: `触发「${recorded.action}」（录制的手势）` };
    }

    // 棘轮：手掌相对录制姿势倾斜一次 = 动一格，手回到中位才能再来一次。
    // 需要一根轴，而单手的腕→中指根就是；双手镜像会抵消，那时 poseAngle 返回 null，
    // TiltRatchet 自己会报 noAxis 而不是拿假角度算。
    const tilt = this.updateTilt(mirrored, palm, scale, now, config);
    if (tilt) events.push(tilt);

    this.blocked = this.swipe.blocked;
    const hint = mirrored.length >= 2 ? '双手在场（捏合拇指+食指开始缩放）' : '单手跟随';
    const why = this.blocked && this.blocked !== 'noPath' ? ` · 挥动:${this.blocked}` : '';
    return {
      events,
      status: `${hint} · ${(palm.x * 100).toFixed(0)}%, ${(palm.y * 100).toFixed(0)}%${why}`,
    };
  }

  // 匹配用户录的手势。
  //
  // 这一段一开始漏了 —— 录制能存下来，但这里从不读它，所以用户录完手势不生效。
  // "功能打通了但没接上"，而且不报错。是靠 grep `config.recorded` 在 input.js 里
  // 零命中发现的，不是靠读代码。
  //
  // 两类分开处理：
  //   有 keyframeData → 序列匹配（用户录了一段动作）
  //   只有 template   → 静态姿势匹配（用户录了一个手型，配合内置律用）
  updateRecorded(mirrored, now, config) {
    const recorded = config && config.recorded;
    if (!recorded) return null;
    const pose = Pose.buildPoseTemplate(mirrored);
    if (!pose) return null;

    const threshold = (config && config.matchThreshold) || 0.28;
    const rotation = (config && config.rotationTolerance) || 0;

    for (const [action, entry] of Object.entries(recorded)) {
      if (!entry || !entry.template) continue;
      // 手数必须对得上：单手模板不该被双手姿势匹配，反之亦然。templateDistance 自己
      // 会返回 Infinity，但显式跳过省掉一次距离计算。
      if (entry.hands !== mirrored.length) continue;

      if (entry.keyframeData && entry.keyframeData.length) {
        const matcher = this.sequenceFor(action);
        const fired = matcher.update({
          pose,
          keyframes: entry.keyframeData,
          threshold,
          rotationTolerance: rotation,
          distance: Pose.templateDistance,
          now,
        });
        if (fired) return { action };
        continue;
      }

      // 静态姿势：这里只报"姿势对上了"，具体触发交给律（挥动/倾斜）—— 所以有律的
      // 动作录制只是加了一道"必须是这个手型"的门，不改变触发方式。
      // 没有律又没有关键帧的，就当纯静态手势直接触发。
      if (!entry.law) {
        const distance = Pose.templateDistance(pose, entry.template, rotation);
        const state = this.staticState(action);
        if (distance >= threshold) {
          // 离开了姿势才重新武装。这一条是"保持住不连发"的真正机制 —— 光靠时间冷却
          // 不够：一直摆着的手型会每过一个冷却期就再触发一次，而用户只做了一个动作。
          state.armed = true;
          continue;
        }
        if (state.armed) {
          state.armed = false;
          return { action };
        }
      }
    }
    return null;
  }

  // 手掌上下倾斜 → 视角上看/下看，走棘轮所以可重复。
  //
  // 参考角度用"手竖直举起"而不是录制时的姿势：壁纸没有录制流程，用户直接举手就该能用。
  //
  // ⚠️ 这里原来写的是 `templateAngle: 0, // 手掌水平`，那是个真 bug（外援 agent 从
  // 我这边的调用方式反查出来的，f0d30d5）。poseAngle 量的是腕→中指根这根轴，而屏幕
  // y 向下增长 ⟹ **手竖直举起读出的是 -90° 不是 0°**。
  //
  // 实测后果比"角度偏了"严重：delta 恒为 90°，而触发门 22° ⟹ 手一出现就触发一格；
  // 之后 armed=false，而重新武装要 |delta| < 0.45×22 = 9.9°，也就是手要水平指向右侧。
  // 竖着举手永远回不去 ⟹ **一次误触发，然后棘轮永久卡死在 waitingReturn**。
  // 症状是"倾斜手势只响一次就再也不响"，而且不报错。
  //
  // 现在用 Motion.neutralTiltReference()（= -90°，即竖直手）。⚠️ 别再写字面量：
  // 那个约定藏在 poseAngle 的实现里，而参数名叫 templateAngle 会让人以为 0 是中性。
  updateTilt(mirrored, palm, scale, now, config) {
    if (mirrored.length !== 1) return null;
    const angle = Pose.poseAngle(mirrored);
    if (angle === null) return null;

    const wristSpeed = (() => {
      const d = this.path.displacement();
      return d ? d.speed : 0;
    })();
    const triggerDeg = (config && config.tiltTriggerDeg) || 22;

    const fired = this.ratchet.update({
      liveAngle: angle,
      // 没有录制姿势时的中性参考。有录制姿势的话该传它存的 angle —— 那比任何常数
      // 都好，因为那是这个用户的手真正会回到的位置。
      templateAngle: Motion.neutralTiltReference(),
      wristSpeed,
      triggerDeg,
      now,
    });
    // 屏幕 y 向下增长，所以手掌抬起时腕→中指根这根轴逆时针转、delta 变负。
    // TiltRatchet 直接返回这个符号。
    if (fired === -1) return { action: 'tiltUp' };
    if (fired === 1) return { action: 'tiltDown' };
    return null;
  }
}

root.GestureWallInput = {
  PINCH_RATIO,
  SPAN_MIN,
  SPAN_MAX,
  FILTER_SPACE,
  dist,
  palmWidth,
  isPinched,
  palmCenter,
  mirror,
  toPixels,
  clamp01,
  twoHandZoom,
  GestureInput,
};
})(typeof window === 'undefined' ? globalThis : window);
