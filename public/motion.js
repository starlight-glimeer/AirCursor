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

root.AirCursorMotion = {
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
