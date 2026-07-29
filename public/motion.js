// Motion gestures: the two control laws a static pose template cannot express.
//
// Kept free of DOM and MediaPipe for the same reason as pose.js — the overlay
// owns capture, this file owns the timing and the geometry, and both run under
// test. pose.js answers "which gesture is this frame"; this file answers "what
// has the hand been doing", which needs history.
//
// Two laws, deliberately not one mechanism:
//
//   Ratchet (scroll)  — wrist parked, palm tilts up or down. Each tilt past the
//     trigger emits exactly one notch, then latches until the hand returns to
//     the recorded pose. Discrete and countable: the hand has a defined rest
//     position, so "scroll a bit more" is one more tilt rather than holding a
//     hand in mid-air and hoping the mapping stops where you want.
//
//   Swipe (switch space) — wrist travels sideways fast. Fires once per stroke.
//
// They are separated by wrist speed alone: the ratchet requires a slow wrist,
// the swipe a fast one, with a dead band between the two so a single motion can
// never satisfy both. No arbitration layer, no priority order — the last time an
// ordering decided between two gestures, the loser could never fire at all.
(function (root) {
// Wrist speed, in palm widths per second, so it means the same thing whatever
// the distance to the camera. Below `RATCHET_MAX_SPEED` the wrist counts as
// parked; above `SWIPE_MIN_SPEED` it counts as travelling. The gap between them
// is the dead band: a tilt that drags the wrist a little does nothing rather
// than scrolling and switching desktops at once.
const RATCHET_MAX_SPEED = 1.1;
const SWIPE_MIN_SPEED = 2.6;

// A tilt has to come back before it can fire again, otherwise one held-up palm
// re-triggers every frame. Re-arming well before the pose is level (rather than
// at 0) keeps a small tremor from unlatching, and keeps repeated scrolling from
// requiring an exact return to the recorded angle.
const RATCHET_REARM_FRACTION = 0.45;

// Fired notches per second, ceiling. A tilt-and-return cycle is a deliberate
// hand movement, so this only bounds pathological input (tracking noise that
// oscillates across the trigger); it is not the normal rate limiter, the return
// requirement is.
const RATCHET_MIN_INTERVAL_MS = 90;

function wrapAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function toDegrees(radians) {
  return (radians * 180) / Math.PI;
}

// How far a pose can tilt and still match its own template.
//
// `templateDistance` de-rotates a live pose onto its template by at most
// `rotationTolerance`; past that the leftover rotation is charged as shape
// error, measured at ~0.0196 distance per degree on a hand-shaped pose. So a
// tilt of `rotationTolerance + threshold / 0.0196` degrees is exactly at the
// match threshold, and anything beyond it stops matching — which for the
// ratchet means the gesture silently disappears at the moment it should fire.
//
// The trigger is therefore clamped to the tolerance plus a conservative slice of
// that headroom, keeping the pose comfortably matched while it is tilted. Half
// the headroom rather than all of it, because the measurement is on a synthetic
// hand and a real one carries tracking noise on top of the tilt.
const DEGREES_PER_DISTANCE = 1 / 0.0196;

// The angle `poseAngle` reports for a hand held upright, fingers up.
//
// It measures the wrist -> middle-knuckle axis, and screen y grows downward, so an
// upright hand is about -90 degrees, not 0. That is not obvious from the name
// `templateAngle`, and a caller with no recorded pose to compare against will
// reasonably pass 0 meaning "neutral" — which makes the delta a constant ~88
// degrees and fires the ratchet permanently from the moment a hand appears.
//
// That is exactly what happened in the wallpaper module: `templateAngle: 0, //
// 手掌水平`. The bug is mine rather than the caller's, since the API offered no way
// to say "neutral" without knowing the convention. So the convention is now a named
// export, and `neutralTiltReference()` is what a caller without a recorded pose
// should use.
const UPRIGHT_HAND_ANGLE = -Math.PI / 2;

// Reference angle for tilt when there is no recorded rest pose to measure against.
// Callers that do have one should pass its stored `angle` instead — the recorded
// pose is a better neutral than any constant, because it is the position this
// particular user's hand actually returns to.
function neutralTiltReference() {
  return UPRIGHT_HAND_ANGLE;
}

function maxUsableTiltDeg(rotationToleranceDeg, matchThreshold) {
  const headroom = (matchThreshold || 0) * DEGREES_PER_DISTANCE;
  return (rotationToleranceDeg || 0) + headroom * 0.5;
}

// Tracks the wrist so both laws can ask "is the hand parked or travelling", and
// so the swipe has a path to look at rather than a single frame.
//
// Speeds are measured over a window rather than frame to frame: at 30 fps with a
// 40-60% tracking rate, consecutive-frame deltas are dominated by dropouts and
// jitter, and a swipe is 150-250ms of movement — long enough that a window is
// both available and more stable.
const PATH_WINDOW_MS = 220;

class WristPath {
  constructor({ windowMs = PATH_WINDOW_MS } = {}) {
    this.windowMs = windowMs;
    this.samples = [];
  }

  reset() {
    this.samples = [];
  }

  // `scale` is the palm width in the same units as x/y, so speeds come out
  // scale-free. Passed per sample rather than fixed at construction because it
  // changes as the hand moves toward or away from the camera.
  push(x, y, scale, now) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(scale > 0)) return;
    this.samples.push({ x, y, scale, t: now });
    const cutoff = now - this.windowMs;
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift();
  }

  // Net movement across the window, plus how much of the total travel it
  // represents. A swipe is nearly all net travel in one direction; a hand that
  // wandered out and back has a large total and a small net, and must not count.
  displacement() {
    if (this.samples.length < 2) return null;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (!(dt > 0)) return null;

    let travel = 0;
    for (let i = 1; i < this.samples.length; i += 1) {
      travel += Math.hypot(this.samples[i].x - this.samples[i - 1].x, this.samples[i].y - this.samples[i - 1].y);
    }
    const scale = last.scale;
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    const net = Math.hypot(dx, dy);
    return {
      dx: dx / scale,
      dy: dy / scale,
      dt,
      speed: net / scale / dt,
      // 1 means dead straight. Guard the divide: a parked hand has no travel.
      straightness: travel > 0 ? net / travel : 0,
    };
  }

  speed() {
    return this.displacement()?.speed ?? 0;
  }
}

// One notch per tilt, then wait for the hand to come back.
//
// The reference is the template's own angle, not the angle captured when the
// pose was first recognised. Capturing a baseline live would treat an already
// tilted hand as neutral, and would race with the frame the gesture appears on.
// The recorded pose *is* the rest position: hold it level, record, then tilt
// from there.
class TiltRatchet {
  constructor() {
    this.reset();
  }

  reset() {
    this.armed = true;
    this.latchedDirection = 0;
    // null, not 0: "never fired" has to be a different value from a legal
    // timestamp. With 0, `now - lastFiredAt < interval` is true for the whole
    // first `interval` of the clock, so the first notch after startup was eaten
    // by a cooldown that had never run. This project already shipped that exact
    // bug once with an angle of 0 meaning both "points right" and "no axis".
    this.lastFiredAt = null;
    this.deltaDeg = 0;
    this.blocked = null;
  }

  // Returns a direction (-1 / +1) on the frame a notch fires, otherwise 0.
  // `blocked` records why nothing fired, for the diagnostics panel: this gesture
  // has four separate ways to do nothing, and without naming them the symptom is
  // the familiar "the pose is recognised and the screen does not move".
  update({ liveAngle, templateAngle, wristSpeed, triggerDeg, now }) {
    if (!Number.isFinite(liveAngle) || !Number.isFinite(templateAngle)) {
      // A mirrored two-hand pose has no usable axis, so tilt cannot be measured
      // at all (poseAngle returns null). Recording refuses to bind such a pose
      // here, so this is the defensive branch, not the expected one.
      this.deltaDeg = 0;
      this.blocked = "noAxis";
      return 0;
    }

    this.deltaDeg = toDegrees(wrapAngle(liveAngle - templateAngle));
    const magnitude = Math.abs(this.deltaDeg);

    if (magnitude < triggerDeg * RATCHET_REARM_FRACTION) {
      this.armed = true;
      this.latchedDirection = 0;
    }

    if (wristSpeed > RATCHET_MAX_SPEED) {
      this.blocked = "wristMoving";
      return 0;
    }
    if (magnitude < triggerDeg) {
      this.blocked = this.armed ? null : "waitingReturn";
      return 0;
    }
    if (!this.armed) {
      this.blocked = "waitingReturn";
      return 0;
    }
    if (this.lastFiredAt !== null && now - this.lastFiredAt < RATCHET_MIN_INTERVAL_MS) {
      this.blocked = "cooldown";
      return 0;
    }

    // Screen y grows downward, so a palm tilting up rotates the wrist-to-knuckle
    // axis counter-clockwise and the delta goes negative. Mapping that to
    // "reveal content below" matches macOS natural scrolling, where fingers
    // moving up show what is further down.
    const direction = this.deltaDeg < 0 ? -1 : 1;
    this.armed = false;
    this.latchedDirection = direction;
    this.lastFiredAt = now;
    this.blocked = null;
    return direction;
  }
}

// One trigger per stroke, with the return stroke explicitly suppressed.
//
// Suppression is the whole difficulty of this gesture: after swiping right the
// hand has to come back, and that return is itself a fast leftward stroke. A
// cooldown alone is not enough (a slow return outlasts it and then the next
// swipe is fine, but a fast return inside the window is silently eaten, which
// looks like a missed gesture); a speed re-arm alone is not enough either (the
// return begins while the hand is still fast). So both apply: after firing, the
// wrist must slow below the parked threshold *and* the cooldown must expire.
const SWIPE_COOLDOWN_MS = 620;
// A swipe has to be sideways. Diagonal strokes are usually a hand being moved
// somewhere, not a gesture.
const SWIPE_HORIZONTAL_RATIO = 1.6;
// Minimum sideways travel across the window, in palm widths.
//
// This must not smuggle in a second speed threshold. Displacement over a fixed
// window is speed times the window, so at a 220ms window a travel requirement of
// T implies a speed of T / 0.22 — and the first value tried here, 0.75, implied
// 3.4 widths/s while `swipeSpeed` said 2.6. Everything in between was refused as
// "too short", which no amount of swiping further can fix (the window slides, so
// a longer swipe raises speed, not travel). The panel would have said "挥动距离
// 不够" and following that advice would not have helped.
//
// So this sits below what the lowest sensible speed threshold produces
// (1.4 widths/s * 0.22 = 0.31) and only exists to reject a wrist trembling in
// place, leaving `swipeSpeed` as the single knob that decides "fast enough".
const SWIPE_MIN_TRAVEL = 0.25;
const SWIPE_MIN_STRAIGHTNESS = 0.8;

class SwipeDetector {
  constructor() {
    this.reset();
  }

  reset() {
    this.armed = true;
    // null for the same reason as the ratchet: 0 would put the first swipe of a
    // session inside a cooldown that never happened.
    this.lastFiredAt = null;
    this.lastDirection = 0;
    this.peakSpeed = 0;
    this.blocked = null;
  }

  // Returns -1 (left) / +1 (right) on the frame a swipe fires, else 0.
  update({ displacement, speedThreshold, now }) {
    if (!displacement) {
      this.blocked = "noPath";
      return 0;
    }
    const { dx, dy, speed, straightness } = displacement;
    if (speed > this.peakSpeed) this.peakSpeed = speed;

    // Re-arm on a parked wrist, not on a timer: this is what stops the return
    // stroke from counting as the next swipe.
    if (speed < RATCHET_MAX_SPEED) this.armed = true;

    if (speed < speedThreshold) {
      this.blocked = this.armed ? null : "waitingStill";
      return 0;
    }
    if (Math.abs(dx) < SWIPE_MIN_TRAVEL) {
      this.blocked = "tooShort";
      return 0;
    }
    if (Math.abs(dx) < Math.abs(dy) * SWIPE_HORIZONTAL_RATIO) {
      this.blocked = "notHorizontal";
      return 0;
    }
    if (straightness < SWIPE_MIN_STRAIGHTNESS) {
      this.blocked = "notStraight";
      return 0;
    }
    if (!this.armed) {
      this.blocked = "waitingStill";
      return 0;
    }
    if (this.lastFiredAt !== null && now - this.lastFiredAt < SWIPE_COOLDOWN_MS) {
      this.blocked = "cooldown";
      return 0;
    }

    const direction = dx > 0 ? 1 : -1;
    this.armed = false;
    this.lastFiredAt = now;
    this.lastDirection = direction;
    this.peakSpeed = 0;
    this.blocked = null;
    return direction;
  }
}

// ---------------------------------------------------------------------------
// Recorded movement as a sequence of poses.
//
// A tilt angle and a swipe speed are two hardcoded physical laws. They are the
// right ones for scrolling and desktop switching — those need a *direction* and
// they need to repeat, which a single trajectory match cannot express — but they
// cannot describe an arbitrary movement, and they cannot be drawn. Storing the
// movement as keyframes fixes both: any action can be driven by any movement, and
// the recording can be played back so the user sees what was captured instead of
// reading a number and imagining it.
// ---------------------------------------------------------------------------

// How different two frames must be to both be kept. A movement recorded at 30fps
// is ~30 frames of which most are nearly identical; keeping them all would store
// a stutter and animate a pose that barely moves. Expressed as a fraction of the
// match threshold so it scales with the tolerance everything else uses.
const KEYFRAME_SPACING = 0.55;
const MAX_KEYFRAMES = 10;
// Below this a "movement" is a hand sitting still, and saving it would produce a
// gesture that fires on tracking noise.
const MIN_KEYFRAMES = 3;

// How far a movement must get from its own starting pose to be recordable as a
// sequence, in units of the match threshold.
//
// A round trip — wave, circle, tap — ends where it started, so its last keyframe
// is a pose the hand can be in without having moved. The midpoint rule below
// stops a still hand from *walking* the sequence, but it cannot help a sequence
// whose destination is its origin: reaching the end is then indistinguishable
// from never having left. Such a movement needs its direction in the feature
// vector to be recognisable at all, which static pose templates do not carry.
//
// So this is refused at record time with an explanation, rather than saved as a
// gesture that could only ever misfire. Measured on shape-changing movements a
// genuine out-and-back reaches 0.45-0.68 at its midpoint while its endpoints sit
// at 0.00-0.23, so requiring the *end* to be clear of the start separates "went
// somewhere" from "came back".
const MIN_SEQUENCE_SPAN = 1.0;

// Whether a recorded movement ends somewhere other than where it began, and by
// enough that arriving is distinguishable from never leaving.
function sequenceSpan(keyframes, threshold, distance) {
  if (!keyframes || keyframes.length < 2) return 0;
  const first = keyframes[0].template;
  const last = keyframes[keyframes.length - 1].template;
  const d = distance(last, first, 0);
  return Number.isFinite(d) ? d / threshold : 0;
}

// Reduce a recorded stream to the frames that carry the shape of the movement.
// Always keeps the first and last: those are where it starts and where it ends,
// which are the two the user is most likely to check in the preview.
function buildKeyframes(samples, threshold, distance) {
  if (!samples?.length) return [];
  const spacing = threshold * KEYFRAME_SPACING;
  const frames = [{ template: samples[0].template, at: samples[0].at }];
  for (const sample of samples.slice(1)) {
    const last = frames[frames.length - 1];
    if (distance(sample.template, last.template, 0) < spacing) continue;
    frames.push({ template: sample.template, at: sample.at });
  }
  const tail = samples[samples.length - 1];
  const last = frames[frames.length - 1];
  if (last.at !== tail.at && distance(tail.template, last.template, 0) > spacing * 0.4) {
    frames.push({ template: tail.template, at: tail.at });
  }
  // Too many frames is a slow or wandering recording. Thin from the middle, never
  // the ends, so the start and end poses survive.
  while (frames.length > MAX_KEYFRAMES) {
    let closest = 1;
    let best = Infinity;
    for (let i = 1; i < frames.length - 1; i += 1) {
      const d = distance(frames[i].template, frames[i + 1].template, 0);
      if (d < best) {
        best = d;
        closest = i;
      }
    }
    frames.splice(closest, 1);
  }
  const start = frames[0].at;
  return frames.map((f) => ({ template: f.template, offsetMs: Math.round(f.at - start) }));
}

// ⚠️ A fixed radius cannot work here, and the reason is arithmetic. Measured on
// real landmarks: consecutive frames of a hand mid-movement are **0.499** apart
// (median), while the match threshold is 0.28. One frame of hand travel already
// exceeds the ball used to decide "reached" — so the sequence could never be
// walked, no matter how the recording went. Diagnostics on a replay of the very
// movement that was recorded: stuck at step 2 of 10 with distance 1.361 against a
// 0.28 gate, while *not moving at all* scored 0.429.
//
// Making keyframes denser does not help: sampling the same movement at 20 frames
// instead of 10 leaves the median gap at 0.510, because the gap is dominated by
// per-frame noise, not by how finely the movement is cut.
//
// So "arrived" has to scale with the local gap. 0.55 of the way from the previous
// keyframe to the next: past the midpoint (which is what the monotonic rule below
// requires anyway) with a little margin for noise.
const KEYFRAME_ARRIVAL = 0.55;

// 单次宽限的上限（毫秒）。见 SequenceMatcher.excuse：它限的是**一次调用**跨越的时长，
// 而逐帧调用时那就是一个帧间隔。250 和保持判定、丢帧宽限用的是同一个值。
const EXCUSE_MAX_GAP_MS = 250;

// Walks a recorded sequence, one keyframe at a time, and fires when the last one
// is reached.
//
// Monotonic progress rather than any kind of elastic matching: it only ever asks
// "has the hand reached the next pose yet", which is naturally immune to dropped
// frames (a missed frame just means the step is recognised slightly later) and
// costs one distance computation per frame. Frame-drop immunity is not optional
// here — the measured tracking rate on real hardware is 40-60%.
class SequenceMatcher {
  constructor() {
    this.reset();
  }

  reset() {
    this.index = 0;
    this.startedAt = null;
    this.lastAdvanceAt = null;
    this.lastFiredAt = null;
    this.blocked = null;
    // Set when a blocked reason must survive the frames after it, so a
    // half-second panel refresh cannot miss the one frame that explained a
    // failure. reset() deliberately leaves it alone — it outlives the attempt.
    this.blockedUntil = 0;
    this.progress = 0;
    // 最近一帧到"下一个关键帧"和"上一个关键帧"的距离，以及当时生效的阈值。
    // 面板拿它显示"卡在第几步、差多少" —— 这条链此前只报得出步数。
    this.toNext = null;
    this.toPrev = null;
    this.threshold = null;
    // 上一次看到有效帧的时刻，以及这次尝试宽限了几帧。见 excuse()。
    this.lastSeenAt = null;
    this.excused = 0;
  }

  // `slack` multiplies the recorded timings: a movement performed a bit slower
  // than it was recorded still counts, one performed at half speed does not (by
  // then it is a different gesture, or the hand is doing something else).
  update(args) {
    // 包一层，只为保证 `lastSeenAt` 在**所有**返回路径上都被更新 —— 那个函数有六个 return，
    // 逐个加赋值必然漏一个，而漏掉的那条路会让 excuse() 算出错误的 gap。
    try {
      return this.updateInner(args);
    } finally {
      this.lastSeenAt = args.now;
    }
  }

  updateInner({ pose, keyframes, threshold, rotationTolerance, distance, now, slack = 2.2, cooldownMs = 500 }) {
    // ⚠️ `lastSeenAt` 在**这个函数末尾**才更新，不是开头。excuse() 要用它算"丢了多久"，
    // 而开头就覆盖等于每次 gap 都是 0 ⟹ 宽限一秒都不给，整件事变成 no-op。
    // （第一版就是这么写的，还留了个用不到的 `sinceSeen` 变量。）
    if (!pose || !keyframes?.length) {
      this.blocked = "notBound";
      return false;
    }
    if (this.lastFiredAt !== null && now - this.lastFiredAt < cooldownMs) {
      this.blocked = "cooldown";
      return false;
    }

    const total = keyframes[keyframes.length - 1].offsetMs || 1;
    const budget = total * slack;

    // Waiting to start: the hand has to arrive at the movement's first pose.
    if (this.index === 0) {
      // 记下这一帧离起始姿势多远。`waitingStart` 只说"还没开始"，说不出是差 0.01 还是
      // 差 10 倍 —— 前者要再摆准一点，后者说明这个起始姿势录坏了或者根本不是这个手势。
      this.toNext = Number(distance(pose, keyframes[0].template, rotationTolerance).toFixed(3));
      this.toPrev = null;
      // ⚠️ 入口的门要和**第一步**一样宽，不能是固定的 threshold。
      //
      // 推进用的是自适应半径（按两个关键帧的间距算），而入口一直用固定 0.28 ——
      // 实测那是后面每一步的 **1/2 到 1/2.6**，也就是**入口比整条路上任何一步都严**。
      // 用户报的「0/10 步，可是我的动作不至于这么差吧」就是这个：进不去，所以永远第 0 步。
      //
      // 真机重做同一段动作：固定 0.28 只有 3/45 帧能进，用第一步的半径是 7/45。
      //
      // 用第一步的间距算，而不是全局最大间距：入口的容忍应该和"从起始姿势到第一个关键帧
      // 有多远"匹配 —— 那两个姿势隔得远，说明这个动作起手幅度大，入口也该宽一点。
      const firstGap = keyframes.length > 1
        ? distance(keyframes[1].template, keyframes[0].template, rotationTolerance)
        : 0;
      const entry = Math.max(threshold, firstGap * KEYFRAME_ARRIVAL);
      this.threshold = Number(entry.toFixed(3));
      if (this.toNext < entry) {
        this.blockedUntil = 0;
        this.index = 1;
        this.startedAt = now;
        this.lastAdvanceAt = now;
        this.progress = 1 / keyframes.length;
        this.blocked = null;
        // A single-keyframe sequence is a static pose; treat reaching it as done.
        if (keyframes.length === 1) return this.fire(now);
        return false;
      }
      if (now >= this.blockedUntil) this.blocked = "waitingStart";
      this.progress = 0;
      return false;
    }

    // Started: too slow overall, or stalled on one step, and it was not this
    // gesture after all. Reported distinctly from "never started", because the
    // two need opposite fixes.
    if (now - this.startedAt > budget) {
      // Reaching here at all means the starting pose already matched (that is
      // what set index to 1), so this is always "started but did not finish in
      // time". Reporting it as waitingStart would send the user to change their
      // starting pose when what they need to change is the speed.
      this.reset();
      this.blocked = "tooSlow";
      // Sticky, because the panel refreshes twice a second and the frames right
      // after a timeout report "waiting for the starting pose" — true, but it
      // overwrites the only frame that said why the attempt failed. The user
      // would see the wrong advice and go change their starting pose.
      this.blockedUntil = now + 1200;
      return false;
    }

    // How close counts as "arrived at a keyframe", as a fraction of the gap between
// the two keyframes rather than a fixed distance.
//


// Advancing needs the hand to be *nearer* the next keyframe than the one it
    // came from — not merely inside the next one's radius.
    //
    // Radius alone was not enough, and the reason is arithmetic rather than
    // taste. Keyframes are kept when they differ by KEYFRAME_SPACING x threshold
    // (0.55 x 0.28 = 0.154), while the radius that counts as "arrived" is the
    // full 0.28. Consecutive keyframes therefore sat closer together than the
    // ball used to detect them, and a completely motionless hand was inside two
    // at once: measured, a still hand walked two steps into every recorded
    // movement without moving at all. That does not present as a gesture that
    // never fires — it presents as one that misfires, since the remaining steps
    // can then be completed by any incidental hand movement.
    //
    // Comparing against the previous keyframe fixes it without having to tune
    // the spacing and the radius against each other: whatever the spacing,
    // "closer to the next than to the last" only becomes true once the hand has
    // actually travelled past the midpoint between them.
    const toNext = distance(pose, keyframes[this.index].template, rotationTolerance);
    const toPrev = distance(pose, keyframes[this.index - 1].template, rotationTolerance);
    // 命中半径按**这两个关键帧之间的距离**算，不是固定 0.28。见 KEYFRAME_ARRIVAL：
    // 真机上一帧手的移动就有 0.499，固定 0.28 的球谁都进不去。
    // 下限保留 threshold，这样间距很小的两帧不会变得比固定阈值还严。
    const gap = distance(keyframes[this.index].template, keyframes[this.index - 1].template,
      rotationTolerance);
    const arrival = Math.max(threshold, gap * KEYFRAME_ARRIVAL);
    // 两个距离都留下。推进要求"进了半径**而且**比上一帧近"，所以卡住有两种原因，而它们
    // 要反方向的处理：`toNext >= threshold` 是没到位（动作做小了），`toNext >= toPrev`
    // 是还没过中点（动作方向不对，或者两个关键帧本来就太近）。
    // 只报一个 `midMovement` 的话这两种分不开。
    this.toNext = Number(toNext.toFixed(3));
    this.toPrev = Number(toPrev.toFixed(3));
    // 报生效的那个半径，不是 threshold —— 面板上显示 `距离 0.4 / 门 0.28` 而它其实过了，
    // 会把人送去查一个不存在的问题。
    this.threshold = Number(arrival.toFixed(3));
    if (toNext < arrival && toNext < toPrev) {
      this.index += 1;
      this.lastAdvanceAt = now;
      this.progress = this.index / keyframes.length;
      this.blocked = null;
      if (this.index >= keyframes.length) return this.fire(now);
      return false;
    }

    // 分开报，因为处理相反：没进半径 = 动作做小了；进了但没过中点 = 方向不对或关键帧太近。
    this.blocked = toNext >= arrival ? "notReached" : "beforeMidpoint";
    return false;
  }

  // 这一帧不算：手数不够（丢跟踪）时把时间还给序列，而不是让超时预算白流。
  //
  // ⚠️ 真机上双手连续段的中位长度只有 3 帧，而一个 10 关键帧的序列要走 10 帧连续双手。
  // 不还这个时间的话，双手动态手势**必然**在中途 tooSlow —— 而那看起来像"判据太严"，
  // 实际是"人做得到的动作在丢帧下走不完"。
  //
  // 只延长预算，不推进进度：丢帧期间手确实可能在动，但我们没看到，所以不能假设它到位了。
  excuse(now, maxGap = EXCUSE_MAX_GAP_MS) {
    if (this.index === 0 || this.startedAt === null) return;
    const gap = this.lastSeenAt ? now - this.lastSeenAt : 0;
    // 单次宽限有上限：真把手放下了不该无限期挂着。
    //
    // ⚠️ 上限是**单次调用**的上限，不是总时长的上限。逐帧调用时每次 gap 只有一个帧间隔
    // （43ms），所以手离开 700ms 会被拆成 16 次小 gap 全额还回 —— 实测 688ms 还回 688ms。
    //
    // 但**摄像头不出帧**时（整个 onResults 不被调用）就走不到这里，等它恢复时是一次性的
    // 大 gap，会被上限挡掉。所以调用方可以传一个更大的 maxGap 说"我知道这段有多久"。
    if (gap > 0 && gap < maxGap) this.startedAt += gap;
    this.lastSeenAt = now;
    this.excused = (this.excused || 0) + 1;
  }

  fire(now) {
    this.reset();
    this.lastFiredAt = now;
    this.blocked = null;
    return true;
  }
}

root.AirCursorMotion = {
  UPRIGHT_HAND_ANGLE,
  neutralTiltReference,
  KEYFRAME_SPACING,
  KEYFRAME_ARRIVAL,
  EXCUSE_MAX_GAP_MS,
  MAX_KEYFRAMES,
  MIN_KEYFRAMES,
  MIN_SEQUENCE_SPAN,
  buildKeyframes,
  sequenceSpan,
  SequenceMatcher,
  RATCHET_MAX_SPEED,
  SWIPE_MIN_SPEED,
  RATCHET_REARM_FRACTION,
  SWIPE_COOLDOWN_MS,
  DEGREES_PER_DISTANCE,
  WristPath,
  TiltRatchet,
  SwipeDetector,
  maxUsableTiltDeg,
  wrapAngle,
  toDegrees,
};
})(typeof window === "undefined" ? globalThis : window);
