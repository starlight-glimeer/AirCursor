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

function palmWidthOf(points) {
  return Math.max(60, dist(points[5], points[17]));
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
  // Mirrored hands can cancel out. An axis much shorter than the mean hand span
  // is noise, so leave the pose unrotated instead of spinning it on an angle
  // that flips between frames.
  if (span <= 0 || Math.hypot(vx, vy) < span * 0.34) return 0;
  return Math.atan2(vy, vx);
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
      Number(((p.z || 0) * Z_WEIGHT).toFixed(4)),
    ]),
  );
  // The angle rides along instead of being baked in: matching decides how much
  // rotation to forgive, and a stored template keeps working when that changes.
  return { hands: handList.length, angle: Number(poseAngle(handList).toFixed(4)), values };
}

function rms(left, right) {
  let sum = 0;
  for (let i = 0; i < left.length; i += 1) {
    const diff = left[i] - right[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum / left.length);
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
  if (!(rotationTolerance > 0)) return rms(left, right);

  // Templates recorded before angles existed have none; without a reference
  // axis there is nothing to align to, so compare as-is rather than guessing.
  if (!Number.isFinite(a.angle) || !Number.isFinite(b.angle)) return rms(left, right);
  const delta = wrapAngle(b.angle - a.angle);
  const applied = clamp(delta, -rotationTolerance, rotationTolerance);
  return rms(rotateValues(left, applied), right);
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
function medianAngle(samples) {
  const angles = samples.map((s) => s.angle).filter((a) => Number.isFinite(a));
  if (!angles.length) return 0;
  const reference = angles[0];
  const offsets = angles.map((a) => wrapAngle(a - reference)).sort((x, y) => x - y);
  const mid = Math.floor(offsets.length / 2);
  const offset = offsets.length % 2 ? offsets[mid] : (offsets[mid - 1] + offsets[mid]) / 2;
  return Number(wrapAngle(reference + offset).toFixed(4));
}

root.AirCursorPose = {
  Z_WEIGHT,
  dist,
  palmWidthOf,
  orderHands,
  poseAngle,
  buildPoseTemplate,
  templateDistance,
  medianTemplate,
  medianAngle,
};
})(typeof window === "undefined" ? globalThis : window);
