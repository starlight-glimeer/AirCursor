// 手势录制：点录制 → 倒计时 → 保持不动 → （动态的话再做一遍动作）→ 存模板。
//
// 这是从 AirCursor 的 overlay.js 搬过来的状态机，抽掉了它对 IPC 和 settings 的耦合，
// 剩下纯粹的"喂帧进来，问它现在是什么状态"。搬而不是重写，是因为里面有一串**只有真机
// 才能发现**的教训，重写一定会重新踩：
//
//   · 手多了是 tracker 抖动，不是用户错。录单手手势时 MediaPipe 在某些角度会间歇报
//     出第二只手，把那当成"手数不对"会让每次闪动都清空采集。所以只有**手不够**才重置。
//   · 漂移要相对"开窗时那一帧"测，不是相对上一帧 —— 否则缓慢爬行的手势能一帧一帧地
//     积累到很远而不被发现。
//   · 保持完成后到开始录动作之间要给一拍。上一版一保持完就开始录，于是手从静止姿势
//     移到动作起点的那段路被当成动作的一部分，而用户根本没意识到指令变了。
//   · "动作结束"判据是幅度不再变化，而不是手回到起点 —— 大多数人做完动作会把手放回去，
//     用"回到起点"当结束条件会和"拒绝往复动作"的规则打架，两者交集为空。
//
// 无 DOM、无 Electron，所以能跑纯逻辑用例。
(function (root) {
const Pose = root.AirCursorPose;
const Motion = root.AirCursorMotion;

if (!Pose || !Motion) {
  throw new Error('recorder.js 需要先加载 pose.js / motion.js');
}

// 倒计时：给人摆好姿势的时间。3 秒太长（一次尝试的固定开销会让"再试一次"变得昂贵），
// 1 秒太短（手还没到位）。
const COUNTDOWN_MS = 2000;
// 保持多久算稳。1.2 秒足够排除"路过"，又不至于让手酸。
const HOLD_MS = 1200;
// 采集阶段的总超时。超了但已经录到动作就保存而不是作废 —— 作废等于让用户白做一遍。
const CAPTURE_TIMEOUT_MS = 14000;
// 保持完成到开始录动作之间的缓冲。手一动就提前结束，所以它只是"没反应过来"时的兜底。
const MOVE_READY_MS = 400;
// 动作阶段的时长上限。
const MOVE_TIMEOUT_MS = 4000;
// 幅度多久不变算动作结束。
const SETTLE_MS = 320;
// 模板取多少帧的中位数。中位数而不是均值：一帧丢跟踪就会把均值拖走。
const MAX_SAMPLES = 40;
// 允许的漂移，占匹配阈值的比例。真机实测"握住不动"的漂移是阈值的 0.35-0.55 倍，
// 所以 0.5 是"稳"和"永远稳不下来"之间的分界。
const STABLE_TOLERANCE_RATIO = 0.5;
// 动作幅度下限，占匹配阈值的倍数。低于这个是手在原地抖，不是一个动作。
const MIN_MOVE_EXTENT = 1.6;

const PHASE = { COUNTDOWN: 'countdown', CAPTURE: 'capture', READY: 'ready', MOVE: 'move' };

class Recorder {
  // matchThreshold: 匹配阈值，漂移和幅度都相对它衡量。
  // rotationTolerance: 弧度，传给 templateDistance。
  constructor({ matchThreshold = 0.28, rotationTolerance = 0 } = {}) {
    this.threshold = matchThreshold;
    this.rotationTolerance = rotationTolerance;
    this.session = null;
  }

  // action: 动作 id。hands: 需要几只手。dynamic: 是否要录一段动作。law: 'swipe'/'tilt'/null。
  start(action, { hands = 1, dynamic = false, law = null, now = 0 } = {}) {
    this.session = {
      action,
      wantedHands: hands,
      dynamic,
      // 律只对需要方向的动作成立；其余动态动作按关键帧序列匹配。
      law: dynamic ? law : null,
      phase: PHASE.COUNTDOWN,
      startedAt: now,
      holdStartedAt: 0,
      samples: [],
      reference: null,
      restTemplate: null,
      // 动作阶段：见过的最大幅度，以及幅度稳定了多久。
      peak: 0,
      lastExtent: null,
      stillSince: 0,
      readyUntil: 0,
      frames: [],
    };
    return this.session;
  }

  cancel() {
    this.session = null;
  }

  get active() {
    return !!this.session;
  }

  // 喂一帧。pose 是 buildPoseTemplate 的结果（没有手就传 null），handCount 是这一帧
  // 检出几只手。
  //
  // 返回 { phase, progress, hint, done, result, error }。
  // done 为 true 时 result 里是可以存的模板；error 非空表示这次录制失败了。
  update(pose, handCount, now) {
    const s = this.session;
    if (!s) return null;

    if (s.phase === PHASE.COUNTDOWN) {
      const remaining = COUNTDOWN_MS - (now - s.startedAt);
      if (remaining > 0) {
        return {
          phase: PHASE.COUNTDOWN,
          countdown: Math.ceil(remaining / 1000),
          hint: '摆好姿势',
        };
      }
      s.phase = PHASE.CAPTURE;
      s.startedAt = now;
    }

    if (s.phase === PHASE.READY) return this.tickReady(pose, handCount, now);
    if (s.phase === PHASE.MOVE) return this.tickMove(pose, handCount, now);
    return this.tickCapture(pose, handCount, now);
  }

  // 保持不动，采样。
  tickCapture(pose, handCount, now) {
    const s = this.session;

    if (now - s.startedAt > CAPTURE_TIMEOUT_MS) {
      this.session = null;
      return { phase: PHASE.CAPTURE, error: '超时未保持稳定手势，请重新录制' };
    }

    // 只有手**不够**才重置。手多了是 tracker 抖动 —— 见文件头。
    const missingHands = handCount < s.wantedHands;
    if (!pose || missingHands) {
      s.holdStartedAt = 0;
      s.samples = [];
      s.reference = null;
      return {
        phase: PHASE.CAPTURE,
        progress: 0,
        hint: !handCount ? '没有检测到手，把手放进摄像头画面'
          : missingHands ? `需要 ${s.wantedHands} 只手同时入镜`
          : '识别中',
      };
    }

    // 漂移相对开窗那一帧测，不是相对上一帧。
    const drift = s.reference ? Pose.templateDistance(pose, s.reference) : 0;
    if (drift > this.threshold * STABLE_TOLERANCE_RATIO) {
      s.holdStartedAt = now;
      s.samples = [pose];
      s.reference = pose;
      return { phase: PHASE.CAPTURE, progress: 0, hint: '手势有变动，保持不动' };
    }

    if (!s.holdStartedAt) {
      s.holdStartedAt = now;
      s.reference = pose;
    }
    s.samples.push(pose);
    if (s.samples.length > MAX_SAMPLES) s.samples.shift();

    const held = now - s.holdStartedAt;
    if (held < HOLD_MS) {
      return { phase: PHASE.CAPTURE, progress: held / HOLD_MS, hint: '保持不动' };
    }

    // 静态手势到此为止；动态的才刚拿到"起始并回到"的那个姿势。
    if (!s.dynamic) return this.finish();

    s.restTemplate = Pose.medianTemplate(s.samples);
    s.phase = PHASE.READY;
    s.readyUntil = now + MOVE_READY_MS;
    s.peak = 0;
    s.lastExtent = null;
    s.stillSince = 0;
    s.frames = [];
    return { phase: PHASE.READY, hint: '现在做一遍动作' };
  }

  // 保持完成到动作开始之间的一拍。手一动就提前进入动作阶段。
  tickReady(pose, handCount, now) {
    const s = this.session;
    const moved = pose && s.restTemplate
      && Pose.templateDistance(pose, s.restTemplate, this.rotationTolerance) > this.threshold * 0.6;
    if (moved || now >= s.readyUntil) {
      s.phase = PHASE.MOVE;
      s.startedAt = now;
      return { phase: PHASE.MOVE, progress: 0, hint: '做动作' };
    }
    return { phase: PHASE.READY, hint: '现在做一遍动作' };
  }

  // 录动作本身。
  tickMove(pose, handCount, now) {
    const s = this.session;
    const elapsed = now - s.startedAt;

    if (pose && handCount >= s.wantedHands) {
      s.frames.push({ template: pose, at: now });
      const extent = Pose.templateDistance(pose, s.restTemplate, this.rotationTolerance);
      if (extent > s.peak) s.peak = extent;

      // "动作结束" = 幅度不再变化，不是"手回到起点"。见文件头。
      if (s.lastExtent !== null && Math.abs(extent - s.lastExtent) < this.threshold * 0.06) {
        if (!s.stillSince) s.stillSince = now;
      } else {
        s.stillSince = 0;
      }
      s.lastExtent = extent;

      if (s.stillSince && now - s.stillSince > SETTLE_MS && s.peak > this.threshold * MIN_MOVE_EXTENT) {
        return this.finish();
      }
    }

    if (elapsed > MOVE_TIMEOUT_MS) {
      // 超时但已经录到足够幅度就保存 —— 作废等于让用户白做一遍。
      if (s.peak > this.threshold * MIN_MOVE_EXTENT) return this.finish();
      this.session = null;
      return { phase: PHASE.MOVE, error: '动作幅度太小，再做大一点' };
    }

    return {
      phase: PHASE.MOVE,
      progress: Math.min(1, elapsed / MOVE_TIMEOUT_MS),
      extent: s.peak,
      hint: '做动作，做完停住',
    };
  }

  finish() {
    const s = this.session;
    this.session = null;
    const template = Pose.medianTemplate(s.samples);
    if (!template) return { error: '没有采到有效姿势' };

    const result = {
      action: s.action,
      hands: s.wantedHands,
      template,
      dynamic: s.dynamic,
      law: s.law,
    };

    if (s.dynamic && !s.law) {
      // 没有律：按关键帧序列匹配。
      const keyframes = Motion.buildKeyframes(s.frames, this.threshold, Pose.templateDistance);
      if (keyframes.length < Motion.MIN_KEYFRAMES) {
        return { error: '动作太短或幅度太小，没能抽出足够的关键帧' };
      }
      result.keyframes = keyframes;
    }
    if (s.dynamic) {
      // 触发门取实测幅度的 75%：用户做得到的幅度才是合理的门，而不是一个猜的常数。
      result.trigger = Number((s.peak * 0.75).toFixed(4));
    }

    return { phase: 'done', done: true, result };
  }
}

// 两个姿势太近不是两个手势：实时姿势会去离它更近的那个模板，于是用户得到的是另一个
// 动作，而这个看起来就是坏的。宁可在保存时拒绝 —— 那时用户还记得自己刚做了什么。
function conflictingAction(action, template, recorded, threshold, rotationTolerance) {
  for (const [other, entry] of Object.entries(recorded || {})) {
    if (other === action || !entry || !entry.template) continue;
    const distance = Pose.templateDistance(template, entry.template, rotationTolerance);
    if (distance < threshold * Pose.SEPARATION_FACTOR) {
      return { action: other, distance: Number(distance.toFixed(3)) };
    }
  }
  return null;
}

root.GestureWallRecorder = {
  COUNTDOWN_MS,
  HOLD_MS,
  CAPTURE_TIMEOUT_MS,
  MOVE_READY_MS,
  MOVE_TIMEOUT_MS,
  SETTLE_MS,
  MAX_SAMPLES,
  STABLE_TOLERANCE_RATIO,
  MIN_MOVE_EXTENT,
  PHASE,
  Recorder,
  conflictingAction,
};
})(typeof window === 'undefined' ? globalThis : window);
