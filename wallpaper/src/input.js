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

// 从配置里取一个调参值，顶层和 gestureTuning 两层都查。
//
// 存在的理由：这些值住在 `config.gestureTuning` 里，而 `recorded` 住在顶层，所以调用方
// 必须传整个 config。但纯逻辑用例里直接传 `{ matchThreshold: 0.3 }` 更自然，两种都要认。
//
// 写成一个函数而不是每处一条 `||` 链：`matchThreshold` 那两行原本在这个文件里出现
// **两次**（continuousGate 和 updateRecorded 各一份），而漏改一处的后果是那半边悄悄用
// 着默认值 —— 症状是"我调了灵敏度，有的手势跟着变有的没变"。
function tunedValue(config, key, fallback) {
  if (!config) return fallback;
  if (config[key] !== undefined) return config[key];
  const tuning = config.gestureTuning;
  if (tuning && tuning[key] !== undefined) return tuning[key];
  return fallback;
}

// 旋转容忍：配置里存的是**度**，`templateDistance` 要**弧度**。
//
// ⚠️ 这里原来直接把配置值当弧度用 ⟹ 默认 20 被当成 20 弧度 = 1146°，也就是**任何角度
// 的手都匹配**（实测把手转 60°，距离从 0.5327 变成 0.0000）。方向是过于宽松，症状是
// 手势互相串而不是没反应 —— 所以它和"录了没反应"是两个独立的 bug，只是住在相邻两行。
//
// sensor.js 那边一直是对的（`(deg * Math.PI) / 180`），两个文件对同一个配置项的单位理解
// 不同。单位换算不能散落在读取点，所以收进这个函数。
function rotationRadians(config) {
  return (tunedValue(config, 'rotationTolerance', 20) * Math.PI) / 180;
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
    // 上一帧每个录过的动作离触发有多远。面板拿它显示"我现在摆着手，差多少"。
    this.probe = [];
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
  //
  // ⚠️ config 是**整个配置对象**，不是 `config.gestureTuning`。这个函数读的字段跨两层：
  //   顶层            recorded（用户录的手势）
  //   gestureTuning   swipeSpeed / tiltTriggerDeg / matchThreshold / rotationTolerance
  //
  // 曾经这里被喂了 gestureTuning，结果 `config.recorded` 恒为 undefined ⟹ 录过的手势一个
  // 都匹配不上，而挥动/倾斜照常工作（那两个字段恰好在 gestureTuning 里）。**半错比全错
  // 难发现**：全错会立刻被当成"手势坏了"，半错只表现为"我录的那个没反应"。
  //
  // 返回 { events: [...], status: '...' }。
  update(hands, now, config) {
    const list = Array.isArray(hands) ? hands : [];
    if (!list.length) {
      // 手离开了就重置，否则下次举手时会拿旧轨迹算出一次假挥动。
      if (now - this.lastSeenAt > 400) this.reset();
      // 诊断也清掉：留着上一帧的距离会让面板显示几秒前的数字，而那比空白更误导。
      this.probe = [{ why: '手不在画面里' }];
      return { events: [], status: '未检测到手' };
    }
    this.lastSeenAt = now;

    // 镜像后升到像素空间。两步都在这里做完，后面所有代码都在同一个单位下工作 ——
    // 混着用是上面那个 speed 0.0 的根源。
    const mirrored = list.map((lm) => toPixels(mirror(lm)));
    const events = [];

    // 连续控制的门：用户为 zoom/parallax 录了手型的话，手型不在场就不给这个动作。
    //
    // 静态/动态（手势本身是姿势还是动作）和离散/连续（触发一次还是每帧给值）是两个
    // **正交**的维度，原来的代码把它们绑在一起了（continuous ⟹ 不可录）。一个静态手型
    // 完全可以驱动连续推进：摆出它就一直推进，手型变了就停 —— 那正是静态手势的语义。
    //
    // 录了 = 加一道门，不是换驱动方式：捏合仍然决定推进多少，只是必须先摆对手型。
    // 没录 = 和以前一样，内置映射直接可用。
    const gate = this.continuousGate(mirrored, config);

    // 双手捏合优先：它是主控制，而且做这个手势时单手逻辑没有意义。
    const zoom = gate.zoom ? twoHandZoom(mirrored) : null;
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
    // ⚠️ 指针跟**食指指尖**,不是掌心。
    //
    // 实测同一帧两者差 36-38% 屏宽 —— 也就是指着一个地方,光标出现在大半个屏幕之外。
    // AirCursor 3.x 用的是 `gesture.index`(指尖),而那一版用户的评价是"很丝滑很到位";
    // 这里改成掌心之后就成了"不到位"。掌心适合做视差(要的是手整体在哪),指针要的是
    // "我指着什么",而人指东西用的是指尖。
    const tip = lm[8];
    const filtered = this.pointer.update(tip.x, tip.y, now);
    events.push({
      action: 'pointer',
      x: clamp01(filtered.x / FILTER_SPACE),
      y: clamp01(filtered.y / FILTER_SPACE),
      // 视差要的是"手整体在哪",指针要的是"指着什么" —— 两个信号差 36-38% 屏宽,所以
      // 一起发,消费方各取所需。渲染层用 palm 做景深偏移,主进程用 x/y 移光标。
      //
      palmX: clamp01(palm.x / FILTER_SPACE),
      palmY: clamp01(palm.y / FILTER_SPACE),
      // ⚠️ 视差的门是**独立字段**，不是把 palmX 设成 null。
      //
      // 第一版用 null 表示"门关着"，而消费方那句 `typeof g.palmX === 'number' ? … : g.x`
      // 是给"旧版事件没带掌心"准备的兜底 ⟹ 门一关就回落到**指尖**，视差跟着手指头跳。
      // 「门关着」和「这个字段不存在」撞成了同一个值，而后者已经有含义了。
      //
      // 这是哨兵值撞值的第三次（angle:0 既是"指向右"又是"没有轴"、lastFiredAt:0 吃掉
      // 第一次触发）。门是一个新的语义，就给它一个新的字段。
      parallax: gate.parallax,
      // 指针不受这道门影响：它是**鼠标**，不该被壁纸视差的手型开关关掉。两个信号共用
      // 一个事件但归属不同功能，这里是唯一需要知道这件事的地方。
    });

    // 挥动：交给 SwipeDetector。它比我原来的实现多两道门（净位移、直线度）和一条
    // 关键规则 —— 手腕必须先慢下来才重新武装，所以回手不会算成第二次挥动。
    this.path.push(palm.x, palm.y, scale, now);
    const displacement = this.path.displacement();
    const direction = this.swipe.update({
      displacement,
      speedThreshold: tunedValue(config, 'swipeSpeed', Motion.SWIPE_MIN_SPEED),
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

  // 连续动作（zoom / parallax）的门。返回 { zoom: bool, parallax: bool }。
  //
  // 规则很简单，复杂的是**为什么默认放行**：没录过的连续动作必须照旧可用。给它们做了
  // 录制入口之后，如果"没录"变成"不能用"，那就是把一个现成的功能改成了必须先配置 ——
  // 而用户要的是"也变成可录制的，不要现在这样钉死"，不是"必须录"。
  //
  // 手型匹配只看 template，不看 keyframeData：连续控制的门是"现在这只手是不是那个手型"，
  // 是个每帧的判断。录成动态（一段动作）的话取它的起始姿势当门 —— 那是关键帧序列的第
  // 一帧，也就是用户摆好准备做动作时的样子。
  continuousGate(mirrored, config) {
    const out = { zoom: true, parallax: true };
    const recorded = (config && config.recorded) || null;
    if (!recorded) return out;

    const threshold = tunedValue(config, 'matchThreshold', 0.28);
    const rotation = rotationRadians(config);
    let pose = null;

    for (const action of ['zoom', 'parallax']) {
      const entry = recorded[action];
      if (!entry || !entry.template) continue;      // 没录 ⟹ 放行，见上面
      if (entry.hands !== mirrored.length) { out[action] = false; continue; }
      // 惰性建模板：大多数时候两个都没录，那就一次距离计算都不做。
      if (!pose) pose = Pose.buildPoseTemplate(mirrored);
      if (!pose) { out[action] = false; continue; }
      out[action] = Pose.templateDistance(pose, entry.template, rotation) < threshold;
    }
    return out;
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
    if (!recorded || !Object.keys(recorded).length) {
      this.probe = [{ why: '还没录过任何手势' }];
      return null;
    }
    const pose = Pose.buildPoseTemplate(mirrored);
    if (!pose) {
      this.probe = [{ why: '这一帧建不出姿势模板' }];
      return null;
    }

    const threshold = tunedValue(config, 'matchThreshold', 0.28);
    const rotation = rotationRadians(config);

    // 诊断：每个录过的动作，这一帧离它多远、为什么没触发。
    //
    // 存在的理由：「录了没反应」这句话对应六段链路（录制存盘 → 写配置 → 读配置 → 匹配
     // → 发事件 → 主进程执行），而在此之前只有两头可见。中间四段全靠猜，而这一节里
    // 任何一个 continue 都会让手势静默失效 —— 手数不对、距离差一点、armed 没复位，
    // 三种原因指向完全不同的处理，症状却是同一句"没反应"。
    this.probe = [];

    for (const [action, entry] of Object.entries(recorded)) {
      if (!entry || !entry.template) { this.probe.push({ action, why: '没有模板' }); continue; }
      // 连续动作的录制走 continuousGate（每帧的门），不在这里触发一次 —— 否则摆出
      // zoom 的手型会同时"触发一次 zoom 事件"和"开启连续 zoom"，前者是无意义的。
      if (action === 'zoom' || action === 'parallax') continue;
      // 手数必须对得上：单手模板不该被双手姿势匹配，反之亦然。templateDistance 自己
      // 会返回 Infinity，但显式跳过省掉一次距离计算。
      if (entry.hands !== mirrored.length) {
        this.probe.push({ action, why: `要 ${entry.hands} 只手，现在 ${mirrored.length} 只` });
        continue;
      }

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
        this.probe.push({
          action,
          why: fired ? '触发' : `关键帧 ${matcher.index || 0}/${entry.keyframeData.length}`,
          dynamic: true,
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
        // 距离和门一起报：只报"没匹配"说不出是差 0.01 还是差 10 倍，而那决定
        // 是"再摆准一点"还是"这个模板录坏了"。
        this.probe.push({
          action,
          distance: Number(distance.toFixed(3)),
          threshold,
          armed: state.armed,
          why: distance >= threshold ? '姿势不够近'
            : state.armed ? '触发' : '要先离开这个姿势再回来',
        });
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
      } else {
        // 有律的动作：模板只是一道门，触发交给挥动/倾斜。这里报出来是因为
        // "录了有律的动作却没反应"的原因往往是**律那一侧**没触发，而不是姿势不对。
        const distance = Pose.templateDistance(pose, entry.template, rotation);
        this.probe.push({
          action,
          distance: Number(distance.toFixed(3)),
          threshold,
          why: distance < threshold ? `手型对上了，等${entry.law === 'swipe' ? '挥动' : '倾斜'}`
            : '手型不对（有律的动作要手型 + 动作都对）',
        });
      }
    }
    return null;
  }

  // 上一帧的诊断快照。sensor 每隔一段时间取一次发给面板 —— 每帧发是 30/s 的噪声，
  // 而这个数据的用途是"我现在摆着手，它说我差多少"，不需要逐帧。
  lastProbe() {
    return this.probe || [];
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
    const triggerDeg = tunedValue(config, 'tiltTriggerDeg', 22);

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
