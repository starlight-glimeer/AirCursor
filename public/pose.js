// Static pose templates: build, compare, and average recorded hand poses.
//
// Kept free of DOM and MediaPipe so the same code runs in the overlay and under
// test; the overlay owns capture, this file owns the geometry.
(function (root) {
// MediaPipe depth is the noisiest axis, so it is weighted below the in-plane
// axes instead of being amplified.
const Z_WEIGHT = 0.5;

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Index-knuckle to pinky-knuckle: the one span on a hand that barely changes with
// pose, so it works as the scale reference.
//
// ⚠️ The floor is in PIXELS. This whole file assumes pixel-scale coordinates, and
// that assumption is baked into constants rather than stated anywhere — which cost
// the wallpaper module real debugging time: feeding MediaPipe's normalized 0..1
// landmarks straight in does not degrade accuracy, it clamps every palm width to 60,
// so every speed normalized by palm width divides by 60 and comes out ~0. Swipes
// then never fire, and the symptom is silence rather than an error.
//
// Callers working in normalized space must scale up first (the wallpaper module
// multiplies by 1000 on the way in and divides on the way out). Exported as
// PALM_WIDTH_FLOOR_PX so that requirement is at least discoverable.
const PALM_WIDTH_FLOOR_PX = 60;

function palmWidthOf(points) {
  return Math.max(PALM_WIDTH_FLOOR_PX, dist(points[5], points[17]));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function wrapAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

// Rotation reference: wrist -> middle-finger base, averaged over the hands in
// the pose. One global axis rather than one per hand, so the hands' relative
// orientation stays part of the signature.
//
// Returns null when the pose has no usable axis. That has to be a separate value
// from a number: 0 rad is a perfectly ordinary axis (hand pointing right), so
// reporting "no axis" as 0 made a degenerate pose claim it pointed right. Two
// mirrored hands cancel to a near-zero vector whose direction is pure noise, so
// consecutive frames of one held pose alternated between "no axis" and a random
// angle, and matching de-rotated the live pose by that random angle. Measured on
// a stored two-hand template: an identical pose scored 0.52 instead of 0.00, far
// past any threshold, while the frames that happened to agree still matched — so
// the gesture appeared on the status line yet almost never fired.
function poseAngle(handList) {
  let vx = 0;
  let vy = 0;
  let span = 0;
  for (const points of handList) {
    const dx = points[9].x - points[0].x;
    const dy = points[9].y - points[0].y;
    vx += dx / handList.length;
    vy += dy / handList.length;
    span += Math.hypot(dx, dy) / handList.length;
  }
  // An axis much shorter than the mean hand span is cancellation, not a
  // direction. Say so, rather than picking an angle that flips between frames.
  if (span <= 0 || Math.hypot(vx, vy) < span * 0.34) return null;
  return Math.atan2(vy, vx);
}

// The same axis, recovered from an already-built template. Normalization is a
// uniform translate and scale, both angle-preserving, so this reproduces what
// `poseAngle` saw at capture time. Used to repair templates saved while "no
// axis" was still written as 0, without asking anyone to re-record.
function templateAngle(template) {
  const values = template?.values;
  const hands = template?.hands;
  if (!Array.isArray(values) || !hands || values.length !== hands * LANDMARKS_PER_HAND * 3) return null;
  const handList = [];
  for (let hand = 0; hand < hands; hand += 1) {
    const offset = hand * LANDMARKS_PER_HAND * 3;
    const points = [];
    for (let id = 0; id < LANDMARKS_PER_HAND; id += 1) {
      points.push({ x: values[offset + id * 3], y: values[offset + id * 3 + 1], z: 0 });
    }
    handList.push(points);
  }
  const angle = poseAngle(handList);
  return angle === null ? null : Number(angle.toFixed(4));
}

function rotateValues(values, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i += 3) {
    const x = values[i];
    const y = values[i + 1];
    out[i] = x * cos - y * sin;
    out[i + 1] = x * sin + y * cos;
    out[i + 2] = values[i + 2];
  }
  return out;
}

// Templates are position-sensitive, so hands must always arrive in the same
// slot order. MediaPipe emits detection order, which swaps between frames;
// handedness labels (Left before Right) are stable.
function orderHands(handList, handedness) {
  if (handList.length < 2) return handList;
  return handList
    .map((points, index) => ({ points, label: handedness?.[index]?.label || "" }))
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((item) => item.points);
}

// One shared origin and one shared scale across every hand in the pose, so a
// two-hand template keeps the distance between the hands as part of its
// signature. Anchoring each hand on its own wrist would erase exactly the
// information that makes a two-hand gesture distinct, and using the wrist gap as
// the scale would divide it away.
function buildPoseTemplate(handList) {
  if (!handList?.length) return null;
  const origin = handList.reduce(
    (acc, points) => ({
      x: acc.x + points[0].x / handList.length,
      y: acc.y + points[0].y / handList.length,
    }),
    { x: 0, y: 0 },
  );
  const scale = Math.max(
    40,
    handList.reduce((acc, points) => acc + palmWidthOf(points) / handList.length, 0),
  );
  const values = handList.flatMap((points) =>
    points.flatMap((p) => [
      Number(((p.x - origin.x) / scale).toFixed(4)),
      Number(((p.y - origin.y) / scale).toFixed(4)),
      // ⚠️ z divided by `scale` too, exactly like x and y.
      //
      // It was not, and the raw value went straight in. Callers hand this
      // function pixel-space points (`palmWidthOf` has a 60px floor, so they
      // must), which means they scale z by the same factor — and z then arrived
      // ~86x larger than x/y on real landmarks. The distance between two
      // consecutive frames of a *motionless* hand measured 7.3 against a 0.28
      // threshold: every pose comparison was really a depth-noise comparison.
      //
      // The symptom was "recording is impossible" — the hold check never once
      // passed, so it just kept saying 请保持手不动. Nothing errored.
      Number((((p.z || 0) / scale) * Z_WEIGHT).toFixed(4)),
    ]),
  );
  // The angle rides along instead of being baked in: matching decides how much
  // rotation to forgive, and a stored template keeps working when that changes.
  // null means "this pose has no reliable axis" and travels as null, so matching
  // can skip de-rotation instead of rotating onto a noise direction.
  const angle = poseAngle(handList);
  return { hands: handList.length, angle: angle === null ? null : Number(angle.toFixed(4)), values };
}

function rms(left, right) {
  let sum = 0;
  for (let i = 0; i < left.length; i += 1) {
    const diff = left[i] - right[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum / left.length);
}

// Landmark ids per finger, thumb first. The wrist (0) belongs to no finger and
// only participates in the whole-hand term.
const FINGERS = [
  [1, 2, 3, 4],
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
];
const LANDMARKS_PER_HAND = 21;

// RMS over a subset of landmarks, across every hand in the pose.
function rmsOver(left, right, ids, hands) {
  let sum = 0;
  let count = 0;
  for (let hand = 0; hand < hands; hand += 1) {
    const offset = hand * LANDMARKS_PER_HAND * 3;
    for (const id of ids) {
      for (let axis = 0; axis < 3; axis += 1) {
        const i = offset + id * 3 + axis;
        const diff = left[i] - right[i];
        sum += diff * diff;
        count += 1;
      }
    }
  }
  return count ? Math.sqrt(sum / count) : 0;
}

// How much of the distance comes from the single worst finger rather than the
// whole hand. Plain RMS over all 63 dimensions dilutes a one-finger difference:
// the thumb is 4 of 21 landmarks, so even a large thumb movement shrinks by
// about sqrt(4/21). Measured over eight distinct poses, that put fist and
// thumbs-up 0.210 apart — under the 0.22 default threshold, i.e. not
// distinguishable at all, while a held pose drifts 0.10-0.16 on real hardware.
//
// Blending in the worst finger raises that closest pair to 0.346 and costs only
// 13% more drift (0.099 -> 0.112 at the same simulated noise), so the margin
// between "different pose" and "same pose, shaky" roughly doubles. 0.5 is where
// that ratio flattens out; going further mostly amplifies noise.
const FINGER_WEIGHT = 0.5;
const ALL_LANDMARKS = Array.from({ length: LANDMARKS_PER_HAND }, (_, i) => i);

// One finger in the wrong place should read as a different gesture even when the
// other four agree, so the whole-hand term and the worst single finger are
// blended rather than the whole hand alone deciding.
function poseDistance(left, right, hands) {
  const whole = rmsOver(left, right, ALL_LANDMARKS, hands);
  let worst = 0;
  for (const finger of FINGERS) {
    const value = rmsOver(left, right, finger, hands);
    if (value > worst) worst = value;
  }
  return (1 - FINGER_WEIGHT) * whole + FINGER_WEIGHT * worst;
}

// Rotation is forgiven up to a limit, not ignored. Full invariance would make
// thumbs-up and thumbs-down the same gesture; zero tolerance makes a tilted
// wrist a miss. `rotationTolerance` is the half-width in radians: the live pose
// is de-rotated onto the template's axis, but only by as much as allowed.
function templateDistance(a, b, rotationTolerance = 0) {
  const left = Array.isArray(a?.values) ? a.values : null;
  const right = Array.isArray(b?.values) ? b.values : null;
  // A one-hand pose must never match a two-hand template, and vice versa.
  if (!left || !right || a.hands !== b.hands || left.length !== right.length) return Infinity;
  if (!(rotationTolerance > 0)) return poseDistance(left, right, a.hands);

  // Either side may have no axis: templates recorded before angles existed have
  // none, and a mirrored two-hand pose cancels out (`poseAngle` returns null).
  // Without a reference on both sides there is nothing to align to, so compare
  // as-is. Treating a missing axis as 0 rad instead would de-rotate by the full
  // difference to the other side's real angle and reject the pose it matches.
  if (!Number.isFinite(a.angle) || !Number.isFinite(b.angle)) return poseDistance(left, right, a.hands);
  const delta = wrapAngle(b.angle - a.angle);
  const applied = clamp(delta, -rotationTolerance, rotationTolerance);
  return poseDistance(rotateValues(left, applied), right, a.hands);
}

// Median rather than mean: a single mistracked frame inside the hold window
// would drag a mean template off the pose the user actually held.
function medianTemplate(samples) {
  if (!samples?.length) return null;
  const length = samples[0].values.length;
  const values = new Array(length);
  const column = new Array(samples.length);
  for (let i = 0; i < length; i += 1) {
    for (let s = 0; s < samples.length; s += 1) column[s] = samples[s].values[i];
    column.sort((a, b) => a - b);
    const mid = Math.floor(column.length / 2);
    const value = column.length % 2 ? column[mid] : (column[mid - 1] + column[mid]) / 2;
    values[i] = Number(value.toFixed(4));
  }
  return { hands: samples[0].hands, angle: medianAngle(samples), values };
}

// Angles wrap, so a plain median of samples straddling ±π lands near zero — the
// opposite direction. Take the median of the offsets from one reference angle.
//
// Returns null when no sample had a usable axis, so a two-hand pose whose axis
// cancels stores "no axis" rather than "points right".
function medianAngle(samples) {
  const angles = samples.map((s) => s.angle).filter((a) => Number.isFinite(a));
  if (!angles.length) return null;
  const reference = angles[0];
  const offsets = angles.map((a) => wrapAngle(a - reference)).sort((x, y) => x - y);
  const mid = Math.floor(offsets.length / 2);
  const offset = offsets.length % 2 ? offsets[mid] : (offsets[mid - 1] + offsets[mid]) / 2;
  return Number(wrapAngle(reference + offset).toFixed(4));
}

// A pose is whatever template it sits closest to — not whatever happens to be
// checked first. With a fixed check order, a click pose that landed slightly
// nearer the exit template fired exit instead, and since exit is checked first
// in the frame, the click could never win no matter how the user held it.
class GestureResolver {
  // `hysteresis` is a fraction of the match threshold. A pose sitting between
  // two templates would otherwise flip winners frame to frame, and every flip
  // away from the click gesture releases the pinch and fires a stray click.
  constructor({ hysteresis = 0.18 } = {}) {
    this.hysteresis = hysteresis;
    this.current = null;
  }

  reset() {
    this.current = null;
  }

  // candidates: [{ action, template }]. onDistance sees every comparison so the
  // diagnostics get one distance per template per frame, computed once.
  resolve(pose, candidates, threshold, rotationTolerance, onDistance) {
    let best = null;
    let currentDistance = Infinity;
    for (const candidate of candidates) {
      const distance = templateDistance(pose, candidate.template, rotationTolerance);
      if (onDistance) onDistance(distance, candidate.action);
      if (candidate.action === this.current) currentDistance = distance;
      if (!best || distance < best.distance) best = { action: candidate.action, distance };
    }

    // best is the minimum, so if it misses the threshold nothing matches.
    if (!best || !(best.distance < threshold)) {
      this.current = null;
      return null;
    }
    if (
      this.current !== best.action &&
      currentDistance < threshold &&
      best.distance > currentDistance - threshold * this.hysteresis
    ) {
      return { action: this.current, distance: currentDistance };
    }
    this.current = best.action;
    return best;
  }
}

// How far apart two templates have to be, as a multiple of the match threshold.
//
// Guaranteeing no misassignment needs a gap of 2x the threshold: a pose is
// accepted within `threshold` of its own template, so by the triangle inequality
// only a gap of 2x makes it provably nearer the right one. That guarantee is not
// available here — measured across eight distinct single-hand poses (palm, fist,
// point, peace, thumbs-up, rock, three, pinky-out) the whole space spans 0.21 to
// 0.54, so at the default 0.22 threshold a 2x rule refuses 21 of 28 legitimate
// pairs, open-palm vs fist (0.364) among them.
//
// So the two levels are split. Below 1x the templates are closer than the drift
// of a single held pose, which on a real Mac measured 0.094-0.16 while holding
// still: those are not two gestures and saving one is refused. Between 1x and 2x
// the guarantee is gone but the nearest-match resolver still picks correctly most
// of the time, so it saves and warns instead of blocking a pose the user wants.
const SEPARATION_FACTOR = 1;
const ADVISORY_FACTOR = 2;

root.AirCursorPose = {
  Z_WEIGHT,
  PALM_WIDTH_FLOOR_PX,
  GestureResolver,
  SEPARATION_FACTOR,
  ADVISORY_FACTOR,
  dist,
  palmWidthOf,
  orderHands,
  poseAngle,
  templateAngle,
  buildPoseTemplate,
  templateDistance,
  medianTemplate,
  medianAngle,
};
})(typeof window === "undefined" ? globalThis : window);
