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
  return { hands: handList.length, values };
}

function templateDistance(a, b) {
  const left = Array.isArray(a?.values) ? a.values : null;
  const right = Array.isArray(b?.values) ? b.values : null;
  // A one-hand pose must never match a two-hand template, and vice versa.
  if (!left || !right || a.hands !== b.hands || left.length !== right.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < left.length; i += 1) {
    const diff = left[i] - right[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum / left.length);
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
  return { hands: samples[0].hands, values };
}

root.AirCursorPose = { Z_WEIGHT, dist, palmWidthOf, orderHands, buildPoseTemplate, templateDistance, medianTemplate };
})(typeof window === "undefined" ? globalThis : window);
