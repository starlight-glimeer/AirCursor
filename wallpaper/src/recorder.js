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
// 允许的漂移，占匹配阈值的比例。
//
// ⚠️ 0.5 是错的，而且错得很隐蔽。真机 capture 实测（landmarks-1785328421863，只取手腕
// 帧间移动 < 0.05 掌宽、即"手确实没动"的 21 个帧对）：形状距离**中位 0.058**，看着离
// 0.14 很远 —— 但 **90 分位 0.180、最大 0.222**。丢跟踪后重新检出会跳，这种尖峰必然发生。
//
// 而下面的判据是"1200ms 内每一帧都不越线"，按 23fps 那是 ~28 帧连续。单帧越线率 47%
// ⟹ 28 帧全过的概率是 **0.0000%**。所以症状是"我都没有动，却一直说请保持不动"。
//
// ⚠️ 0.8 是按一个**夸大 5.7 倍**的噪声夹具标的（那个夹具把真机逐帧增量累加到静止基准上，
// 增量累加随机游走式堆积）。用真机绝对帧重扫：
//
//   ratio   成功率    耗时中位
//   0.3     40/40     1935ms
//   0.5     40/40     1505ms    ← 取这个
//   0.8     40/40     1247ms
//
// **真值下 0.3 就已经 100% 成功**，也就是原来那个 0.5（被我改成 0.8 的那个）本来就够用，
// 而 0.8 只是白白放松了判别力。取 0.5：留一倍余量，同时把门收回到能分辨"手真的动了"。
//
// 下面这张旧表留着，因为它记录了一次真实的教训 —— 数值全部作废，但"两个常数的上界互相
// 咬死"这个结构性结论仍然成立：
//
// 旧表（按夸大 5.7 倍的噪声标，数值不可用）：
//
//   ratio   正向成功   耗时中位   爬行的手
//   0.5      0/100        —       正确拒绝     ← 原值，用户症状"一直说请保持不动"
//   0.8     99/100     4214ms     正确拒绝     ← 取这个
//   1.0    100/100     2924ms     **录成了**
//   1.2    100/100     2365ms     **录成了**
//
// 再放就换来一个更糟的 bug：慢慢移动的手会被录成静态模板，而那种模板匹配谁都不像，
// 症状回到"这个手势没反应"—— 那是这个项目里最贵的一类症状。
//
// 代价是名义 1200ms 的保持实际要 ~4 秒（尖峰会把计时往后推）。这是这份噪声下的事实，
// 不是可以靠调参绕开的：真机 90 分位漂移 0.180，而门 0.224 只比它高 24%。要真正缩短
// 得先降噪（给 21 个点加滤波），那是另一件事。
const STABLE_TOLERANCE_RATIO = 0.5;
// 漂移超限多久才真的算"手动了"。
//
// ⚠️ 这是这个项目里同一个错误的**第三次**（主链路 0.3.0 修过、trackingRate 修过，
// 录制器里还是原样）：**帧驱动的门槛，判定单位必须是时间，不能是"连续帧数"**。
// "任何一帧越线就重置"在丢帧率一上来时，会从"严格一点"变成"根本不可达"。
//
// 250ms 是主链路那次仿真出来的值（宽限 0ms 完成率 0%，80ms 27-42%，250ms 99.5%）。
// 真的移开手仍然会重置 —— 要连续越线超过 1/4 秒。
const STABLE_GRACE_MS = 250;
// 动作幅度下限，占匹配阈值的倍数。低于这个是手在原地抖，不是一个动作。
const MIN_MOVE_EXTENT = 1.6;
// 幅度要连续多少帧都够大才算。见 tickMove：单帧最大值由噪声尖峰决定，毫无区分度。
//
// 3 帧 @23fps ≈ 130ms，比任何真实动作都短得多，所以它只挡尖峰不挡动作。
//
// ⚠️ 原来是 5，按那个夸大 5.7 倍的夹具标的。用真机绝对帧重扫：**1 仍然失败**（尖峰问题
// 是真的，不是夹具造出来的），而 **3 就够**。取 3：窗口越短反应越快，而 5 没有额外收益。
//
// 旧表（按夸大的噪声标，数值不可用，但"单帧极值在量噪声"这个结论成立）：
//
//   EXTENT_RUN   不做动作量到   真动作(amp=1)   余量
//   1（原样）      1.498         1.8+          **没有余量，不动也能录成**
//   3             0.429         ✅            差 4% —— 太薄
//   5             0.169         ✅            差 2.7 倍  ← 取这个
//   8             0.121         ✅            没有额外收益，只是更迟钝
//
// 门限 0.448 = matchThreshold 0.28 × MIN_MOVE_EXTENT 1.6。
const EXTENT_RUN = 3;

// 中位数。用在"手停住了"的判定上 —— 均值会被一帧丢跟踪拖走，而那正是最常见的噪声。
function median(list) {
  if (!list.length) return 0;
  const sorted = list.slice().sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

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
      // 漂移/丢帧从哪一刻开始。0 = 现在没有越线。宽限判定要它。
      driftingSince: 0,
      // 越线那一刻已经保持了多久。宽限期报这个值 —— 冻结而不是继续涨。
      frozenHeld: 0,
      // 被打断过几次、最后一次在什么时候。反复打断本身是"手在动"的证据。
      breaks: 0,
      lastBreakAt: 0,
      restTemplate: null,
      // 动作阶段：见过的最大幅度，以及幅度稳定了多久。
      peak: 0,
      // 最近几帧的幅度。取它们的最小值，所以单帧尖峰进不了 peak。
      extentRun: [],
      // 同样最近几帧，但取中位数 —— 用来判"手停住了"。见 tickMove。
      extentSmooth: [],
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
      // 丢跟踪同样走宽限。**这是最常见的尖峰来源**：真机 capture 里 101/118 帧有手，
      // 最长一段丢了 17 帧(726ms)，而短暂的一两帧丢失在每次保持里都会发生。
      // 立刻清空的话，"保持 1.2 秒"要求的是 1.2 秒零丢帧 —— 那不是用户能控制的事。
      if (s.holdStartedAt) {
        if (!s.driftingSince) {
          s.driftingSince = now;
          s.frozenHeld = now - s.holdStartedAt;   // 同样冻结，理由见上面
        }
        if (now - s.driftingSince < STABLE_GRACE_MS) {
          return {
            phase: PHASE.CAPTURE,
            progress: Math.min(1, s.frozenHeld / HOLD_MS),
            hint: '保持不动',
          };
        }
      }
      s.driftingSince = 0;
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

    // 漂移相对开窗那一帧测，不是相对上一帧 —— 否则缓慢爬行的手能一帧一帧积累到很远。
    //
    // ⚠️ 旋转容忍要传：不传等于 rotationTolerance=0，即"手腕角度一点都不许变"。
    // 匹配时容忍 20°，保持时容忍 0°，两个判据对同一只手给出不同答案。
    const drift = s.reference
      ? Pose.templateDistance(pose, s.reference, this.rotationTolerance)
      : 0;
    if (drift > this.threshold * STABLE_TOLERANCE_RATIO) {
      // 越线不立刻重置：记下**从哪一刻开始越线**，连续超过宽限才算手真的动了。
      // 单帧尖峰（丢跟踪后重新检出）会在下一帧回到线内，那不是用户动了手。
      if (!s.driftingSince) {
        s.driftingSince = now;
        // ⚠️ 进度**冻结**在开始越线的那一刻，不是继续涨。
        //
        // 第一版让它继续涨，于是一只持续形变的手也能录成静态模板：每帧都越线，宽限
        // 期照涨 250ms，超限重置，再涨 250ms —— 攒够 1200ms 只是时间问题。实测一个
        // 每帧变化 0.088（低于门 0.224）的连续形变夹具在 3894ms 录成了。
        //
        // 冻结之后宽限只能"扛过尖峰"，不能"喂进度"：坏帧不推进也不倒退，真的连续动
        // 250ms 就重来。这是宽限和"把门放松"的区别所在。
        s.frozenHeld = s.holdStartedAt ? now - s.holdStartedAt : 0;
      }
      if (now - s.driftingSince < STABLE_GRACE_MS) {
        // 这一帧不进样本 —— 它是坏帧，会污染中位模板。
        return {
          phase: PHASE.CAPTURE,
          progress: Math.min(1, s.frozenHeld / HOLD_MS),
          hint: '保持不动',
        };
      }
      // 超宽限 ⟹ 手真的动了。换 reference 重新开始。
      //
      // ⚠️ 这里必须**同时**把攒下的进度清掉，而"清掉"要清得比看起来更彻底：一只持续
      // 爬行的手（每帧变化低于门，但一直朝一个方向走）会走进这个循环 ——
      // 重置 → 涨两三帧 → 越线 → 冻结 250ms → 重置。每轮真的涨掉 ~100ms，攒够 1200ms
      // 只是时间问题。实测每帧 0.088 的连续形变夹具在 3894ms（冻结之后 5511ms）录成了。
      //
      // 所以额外记一笔"连续被打断过多少次"：短时间内反复被打断本身就是"手在动"的
      // 证据，哪怕每一次单独看都在宽限之内。
      s.driftingSince = 0;
      s.holdStartedAt = 0;      // 0 而不是 now：下一帧才重新开窗，那时 reference 也一起换
      s.samples = [];
      s.reference = null;
      s.breaks = (s.breaks || 0) + 1;
      s.lastBreakAt = now;
      return { phase: PHASE.CAPTURE, progress: 0, hint: '手势有变动，保持不动' };
    }

    if (s.driftingSince) {
      // 回到线内：把越线那段时间从计时里扣掉（把 holdStartedAt 往后推）。
      // 不扣的话尖峰期间的挂钟时间会白送进度，而那段时间手并不稳定。
      s.holdStartedAt += now - s.driftingSince;
      s.driftingSince = 0;
    }
    if (!s.holdStartedAt) {
      s.holdStartedAt = now;
      s.reference = pose;
      // 连续被打断过久没有？久了就把计数清掉 —— 偶发尖峰不该永久记账。
      // 阈值取一个保持周期：真正稳下来一次就说明前面那些打断是噪声。
      if (s.lastBreakAt && now - s.lastBreakAt > HOLD_MS) s.breaks = 0;
    }
    s.samples.push(pose);
    if (s.samples.length > MAX_SAMPLES) s.samples.shift();

    // 反复被打断 = 手一直在动，只是每一次都短。
    //
    // 这一条堵的正是"爬行的手也能录成"那个洞：单看每次打断都在宽限内，但 3 次以上
    // 意味着这不是尖峰。
    // 5 是实测的上界：8 会让"每帧 0.088 的连续爬行"重新录成，3 会把真手的 90 分位
    // 拖到 9.5 秒（真手的尖峰本身就能凑到 3 次）。给出的提示也不同 —— "保持不动"重复一百遍不会让用户想到
    // 是自己的手在慢慢移动。
    if ((s.breaks || 0) >= 5) {
      return { phase: PHASE.CAPTURE, progress: 0, hint: '手一直在动，试着把手完全停住' };
    }

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
    s.extentRun = [];
    s.extentSmooth = [];
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

      // 幅度取**连续 EXTENT_RUN 帧的最小值**的最大值，不是单帧最大值。
      //
      // ⚠️ 单帧最大值完全由噪声尖峰决定。实测（静止的手 100 帧对 restTemplate）：中位
      // 0.210、90 分位 0.768、**最大 1.794**，而动作门限是 0.448 —— 100 帧里有 18 帧
      // 单独就超过门限 ⟹ **完全不做动作也能"录成"一个动态手势**（实测 amp=0 量到 1.498）。
      //
      // 这和「保持不动」那个 bug 是同一族：那次是"每一帧都不许越线"（尖峰让人永远过不去），
      // 这次是"任一帧越线就算"（尖峰让人永远能过）。**都是拿单帧极值当判据。**
      //
      // 连续 3 帧都大才算，一个尖峰过不去。实测区分度：不做动作 0.225，真动作 0.526+，
      // 而单帧最大值在这两种情况下都是 1.79（完全没有区分度）。
      s.extentRun.push(extent);
      if (s.extentRun.length > EXTENT_RUN) s.extentRun.shift();
      if (s.extentRun.length === EXTENT_RUN) {
        const sustained = Math.min(...s.extentRun);
        if (sustained > s.peak) s.peak = sustained;
      }

      // "动作结束" = 幅度不再变化，不是"手回到起点"。见文件头。
      //
      // ⚠️ 判据不能是"逐帧变化 < 0.017"。实测静止的手，extent 的逐帧变化中位 **0.173**、
      // 90 分位 0.975 —— 连续 320ms(~7 帧)全部低于 0.017 的概率是 **0.0000%**，
      // 也就是"手停住了"**永远不成立**，于是每次都录到 4 秒超时。
      //
      // 而超时那几秒手其实早就停了 ⟹ 那段的"关键帧"全是噪声跳变 ⟹ 关键帧间距变成噪声
      // 距离(~0.5)，序列谁都走不完。三个 bug 串成一条，这是第一环。
      //
      // 改成比**平滑后的幅度**：拿最近 EXTENT_RUN 帧的中位数当当前幅度，它的帧间变化是
      // 噪声的 1/3 左右。而"不再变化"的门也放宽到匹配阈值的 0.25（0.07），那是实测
      // 静止手在平滑之后的 60 分位。
      //
      // 这是这个项目里"拿单帧值当判据"的第三次（保持不动、动作幅度、这里）。
      s.extentSmooth.push(extent);
      if (s.extentSmooth.length > EXTENT_RUN) s.extentSmooth.shift();
      const smooth = median(s.extentSmooth);
      if (s.lastExtent !== null && Math.abs(smooth - s.lastExtent) < this.threshold * 0.25) {
        if (!s.stillSince) s.stillSince = now;
      } else {
        s.stillSince = 0;
      }
      s.lastExtent = smooth;

      if (s.stillSince && now - s.stillSince > SETTLE_MS && s.peak > this.threshold * MIN_MOVE_EXTENT) {
        return this.finish();
      }
    }

    if (elapsed > MOVE_TIMEOUT_MS) {
      // 超时但已经录到足够幅度就保存 —— 作废等于让用户白做一遍。
      if (s.peak > this.threshold * MIN_MOVE_EXTENT) return this.finish();
      this.session = null;
      // ⚠️ 报出**实测幅度和门限两个数**，不是一句"再做大一点"。
      //
      // 用户报「我动作做完了，结果直接退出了，看着像是意外中断」—— 而"幅度太小"这句话
      // 在用户已经觉得自己做完了动作的时候，读起来就是"莫名失败"。差 5% 和差 10 倍指向
      // 完全不同的处理（再夸张一点 vs 这个动作类型压根测不到），而一句定性文案把两者
      // 压成同一个意思。
      const need = Number((this.threshold * MIN_MOVE_EXTENT).toFixed(3));
      return {
        phase: PHASE.MOVE,
        error: `动作幅度不够：量到 ${s.peak.toFixed(3)}，需要 ${need}（差 ${(need / (s.peak || 1e-6)).toFixed(1)} 倍）`
          + `，收到 ${s.frames.length} 帧`,
        peak: Number(s.peak.toFixed(3)),
        need,
        frames: s.frames.length,
      };
    }

    // 进度里带上"幅度够了没"。做动作的当时就该知道，而不是失败之后才被告知 ——
    // 用户会以为自己做完了，因为没有任何东西告诉他幅度不足。
    const need = this.threshold * MIN_MOVE_EXTENT;
    return {
      phase: PHASE.MOVE,
      progress: Math.min(1, elapsed / MOVE_TIMEOUT_MS),
      extent: Number(s.peak.toFixed(3)),
      extentNeeded: Number(need.toFixed(3)),
      hint: s.peak >= need ? '幅度够了，停住手就保存' : '做动作 —— 幅度还不够，再大一点',
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
        // 同样报数：抽到几个、要几个、原始帧有多少。
        // "动作太短"和"幅度太小"是两个不同的原因，而帧数和关键帧数的比值能分开它们 ——
        // 帧多而关键帧少 = 幅度不够；帧本来就少 = 做得太快。
        return {
          error: `关键帧不够：从 ${s.frames.length} 帧里只抽出 ${keyframes.length} 个，需要 ${Motion.MIN_KEYFRAMES} 个`
            + `（${s.frames.length > 20 ? '帧够多但幅度不足，动作再夸张一点' : '动作做得太快，慢一点'}）`,
          keyframes: keyframes.length,
          frames: s.frames.length,
        };
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
// 和已有手势撞不撞。`againstDisabled` 决定要不要把关掉的手势也算进来。
//
// 录制时**不算**关掉的（用户把 A 关了正是为了腾出那个手型），启用时**要算**（打开的
// 那一刻两个才会真的同时生效）。
//
// 上一版录制时也算关掉的，理由是"防止之后重新打开时互抢"。那个风险是真的，但它把成本
// 放错了时候：用户现在就想用这个手型，而障碍是一个他已经声明不用的动作。检查该发生在
// **真正会出问题的那一刻** —— 也就是重新启用的时候，那时两个手势的关系才是活的。
function conflictingAction(action, template, recorded, threshold, rotationTolerance, {
  againstDisabled = false,
} = {}) {
  for (const [other, entry] of Object.entries(recorded || {})) {
    if (other === action || !entry || !entry.template) continue;
    if (!againstDisabled && entry.enabled === false) continue;
    const distance = Pose.templateDistance(template, entry.template, rotationTolerance);
    // 双手的门放宽一倍，和匹配侧一致。**不一致的后果是自相矛盾的提示**：
    // 录的时候说没冲突（用宽门算间距），跑起来两个手势互抢（宽门也用于匹配）；
    // 或者反过来，能匹配的手势被判成冲突而存不进去。
    const gate = Pose.thresholdFor(template, threshold) * Pose.SEPARATION_FACTOR;
    if (distance < gate) {
      return {
        action: other,
        distance: Number(distance.toFixed(3)),
        // 报出"要多远才够" —— 只说"太像了"用户不知道该改多少。
        need: Number(gate.toFixed(3)),
        otherDisabled: entry.enabled === false,
      };
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
