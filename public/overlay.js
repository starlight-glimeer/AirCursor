(function () {
const video = document.getElementById("camera");
const canvas = document.getElementById("scene");
const ctx = canvas.getContext("2d", { alpha: true });
const aircursor = window.aircursor || {
  getState: async () => ({
    settings: {
      overlayVisible: true,
      showHands: false,
      controlEnabled: false,
      voiceEnabled: true,
      twoHands: true,
      effects: "balanced",
      gestureMap: {
        wake: "openPalm",
        click: "pinch",
        rightClick: "middlePinch",
        exit: "fist",
      },
      recordedGestures: {},
    },
    screen: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
  }),
  updateSettings: async (patch) => ({ settings: { ...settings, ...patch } }),
  runRule: async (ruleId) => ({ ok: true, id: ruleId, label: ruleId }),
  openNetease: async () => fetch("/api/open/netease", { method: "POST" }).then((response) => response.json()),
  pointer: () => {},
  status: () => {},
  recordingProgress: () => {},
  recordingResult: () => {},
  metrics: () => {},
  onSettings: () => {},
  onVoiceCommand: () => {},
  onRecording: () => {},
  onResetMetrics: () => {},
};

const settings = {
  overlayVisible: true,
  showHands: false,
  controlEnabled: false,
  voiceEnabled: true,
  twoHands: true,
  effects: "balanced",
  gestureMap: {
    wake: "openPalm",
    click: "pinch",
    rightClick: "middlePinch",
    exit: "fist",
  },
  recordedGestures: {},
  tuning: {},
  diagnostics: false,
};

const GESTURE_LABELS = {
  openPalm: "张开手掌",
  fist: "握拳",
  pinch: "拇指+食指捏合",
  middlePinch: "拇指+中指捏合",
  none: "关闭",
};

const { PointerFilter, TrackingMetrics } = window.AirCursorTracking;
const { orderHands, buildPoseTemplate, templateDistance, medianTemplate, GestureResolver, SEPARATION_FACTOR } =
  window.AirCursorPose;
const { WristPath, TiltRatchet, SwipeDetector, maxUsableTiltDeg } = window.AirCursorMotion;

const metrics = new TrackingMetrics();
const resolver = new GestureResolver();
const wristPath = new WristPath();
const scrollRatchet = new TiltRatchet();
const swipeDetector = new SwipeDetector();

const DEFAULT_TUNING = {
  minCutoff: 1.2,
  beta: 0.045,
  deadzone: 1.6,
  prediction: 0.35,
  matchThreshold: 0.28,
  rotationTolerance: 20,
  inferenceIntervalMs: 20,
  moveIntervalMs: 8,
  scrollTriggerDeg: 16,
  scrollNotches: 3,
  swipeSpeed: 2.6,
};
const pointerFilter = new PointerFilter(DEFAULT_TUNING);

// Recording demands a tighter fit than triggering, so a recorded template stays
// usable when the hand drifts a little at runtime.
let MATCH_THRESHOLD = 0.28;
// Degrees in settings because that is what a tester can reason about; radians
// here because that is what the geometry wants.
let ROTATION_TOLERANCE = 0;
// How far the pose may drift within a hold window before the 2 seconds restart.
// Scaled to the same units as the match threshold: at 0.1 (its value under the
// old whole-hand distance) finger weighting pushed 37% of frames over the limit
// at the landmark noise a real hand produces, so a perfectly still hand could
// sit at "手势有变动" forever. Half the match threshold keeps the template
// tighter than what will later be accepted, without fighting the tracker.
const STABLE_TOLERANCE_RATIO = 0.5;
const COUNTDOWN_MS = 3000;
const HOLD_MS = 2000;
const CAPTURE_TIMEOUT_MS = 15000;
const MAX_SAMPLES = 90;
// Longer than the wake/exit hold: opening an app by accident is more annoying
// than a stray cursor move, so it asks for more intent.
const RULE_HOLD_MS = 1200;
const WAKE_HOLD_MS = 1000;
// How long a hold survives frames that do not match, before the timer restarts.
//
// A hold used to reset on the first such frame, which made it unreachable on real
// hardware: measured tracking rate is 59-68%, so at ~30 fps a run of 3 misses
// (~100 ms) happens more than once per second of holding, and the chance of a
// clean 1000 ms run is effectively zero. The gesture still appeared on the status
// line, which is computed from a single frame — "识别显示出来了但没有反应".
//
// 250 ms covers a run of 7 misses at 29 fps; simulated at the measured rates a
// 1000 ms hold then completes 99.5-99.7% of the time (80 ms: 27-42%). It is also
// short enough that letting the pose go still reads as letting go: the pose has
// to be absent for a quarter second, several times the frame interval.
const HOLD_GRACE_MS = 250;
// Same idea for the click, but shorter: a click fires on release, so this delay
// is added to every click's latency. 140 ms covers a run of 4 missed frames at
// 29 fps (the 250 ms case shows up as a hold that has to be re-formed, which is
// recoverable; a click that is late by a quarter second just feels broken).
const PINCH_GRACE_MS = 140;

const state = {
  hands: [],
  handedness: [],
  gesture: null,
  recording: null,
  particles: [],
  cameraReady: false,
  // Wake/exit and rule holds keep the same shape so both go through trackHold.
  modeHold: { id: null, startedAt: 0, missingSince: 0 },
  toggleCooldownUntil: 0,
  // Which rules exist is main's business; the overlay reads the list it is
  // handed rather than keeping a second copy that can drift out of step.
  ruleIds: [],
  ruleHold: { id: null, startedAt: 0, missingSince: 0 },
  ruleCooldownUntil: 0,
  pointerDown: false,
  // What the motion layer did on the most recent frame, for the diagnostics
  // panel and the report. These gestures have several distinct ways to do
  // nothing (wrist moving, waiting to return to rest, cooling down, no axis),
  // and the symptom of every one of them is "the pose shows up and the screen
  // does not move" — the exact fault that has cost three rounds already.
  motion: {
    tiltDeg: 0,
    triggerDeg: 0,
    clampedTrigger: false,
    wristSpeed: 0,
    scrollBlocked: null,
    swipeBlocked: null,
    scrollNotches: 0,
    swipes: 0,
    lastScrollAt: 0,
    lastSwipeAt: 0,
    lastSwipeDirection: 0,
  },
  drag: { active: false, missingSince: 0 },
  pinch: {
    active: false,
    startedAt: 0,
    startX: 0,
    startY: 0,
    missingSince: 0,
  },
  rightClickCooldownUntil: 0,
  lastPointerSentAt: 0,
  lastInferenceAt: 0,
  inferenceBusy: false,
  frameCapturedAt: 0,
  resultAt: 0,
  handRuntime: null,
  handRestartToken: 0,
  cursor: { x: 0, y: 0, ready: false },
  screen: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
};

const VOICE_RULES = [
  {
    id: "control_off",
    match: /退出|停止|隐藏|关闭控制|关掉控制/,
    run: () => setControlMode(false),
    label: "退出控制模式",
  },
  {
    id: "control_on",
    match: /启动|唤醒|开始|开启控制|打开控制/,
    run: () => setControlMode(true),
    label: "启动控制模式",
  },
  {
    id: "click",
    match: /^(点|选|开|确认|点击|单击|点一下|click|go)$/i,
    run: () => {
      if (!settings.controlEnabled) {
        aircursor.status({ rule: "先开启控制，再用语音点选" });
        return false;
      }
      if (!state.gesture) {
        aircursor.pointer({ type: "clickCurrent" });
        aircursor.status({ rule: "系统语音：点击当前鼠标位置（未检测到手）" });
        return false;
      }
      sendPointer("move", state.cursor.x, state.cursor.y);
      sendPointer("click", state.cursor.x, state.cursor.y);
      burst(state.cursor.x, state.cursor.y, 24, "#ffd76a");
      return true;
    },
    label: "语音点选当前位置",
  },
  { id: "open_netease", match: /网易云|音乐/, label: "打开网易云音乐" },
  { id: "open_wechat", match: /微信|wechat/i, label: "打开微信" },
  { id: "open_chrome", match: /谷歌|chrome|浏览器/i, label: "打开 Chrome" },
  { id: "open_safari", match: /safari/i, label: "打开 Safari" },
  { id: "open_finder", match: /访达|finder/i, label: "打开访达" },
  { id: "open_terminal", match: /终端|terminal/i, label: "打开终端" },
  { id: "open_cursor", match: /cursor/i, label: "打开 Cursor" },
];

function tuning() {
  return { ...DEFAULT_TUNING, ...(settings.tuning || {}) };
}

// Tuning is applied live so the feedback loop is "drag slider, feel the change"
// rather than "edit constant, repackage, reinstall".
function applyTuning() {
  const active = tuning();
  MATCH_THRESHOLD = active.matchThreshold;
  ROTATION_TOLERANCE = ((active.rotationTolerance || 0) * Math.PI) / 180;
  pointerFilter.setTuning(active);
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, settings.effects === "rich" ? 1.5 : 1);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (!state.cursor.ready) {
    state.cursor.x = window.innerWidth * 0.5;
    state.cursor.y = window.innerHeight * 0.5;
    state.cursor.ready = true;
  }
}

function point(landmark) {
  return {
    x: (1 - landmark.x) * window.innerWidth,
    y: landmark.y * window.innerHeight,
    z: landmark.z,
  };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Every custom gesture bound anywhere, resolved together once per frame. Asking
// each consumer "does this match?" in turn let the first asker win a pose that
// belonged to someone else.
function resolveCustomGesture(gesture) {
  if (!gesture?.poseTemplate) {
    resolver.reset();
    return null;
  }
  const candidates = [];
  for (const [action, mapped] of Object.entries(settings.gestureMap || {})) {
    if (!mapped?.startsWith("custom:")) continue;
    const template = settings.recordedGestures?.[mapped.slice("custom:".length)]?.template;
    if (template) candidates.push({ action, template });
  }
  return resolver.resolve(
    gesture.poseTemplate,
    candidates,
    MATCH_THRESHOLD,
    ROTATION_TOLERANCE,
    (distance, action) => metrics.markMatchDistance(distance, action),
  );
}

function gestureMatches(gesture, gestureId) {
  if (!gesture || !gestureId || gestureId === "none") return false;
  if (gestureId.startsWith("custom:")) {
    // The winner is decided for the whole frame and carried on the gesture, so
    // this is a lookup rather than a fresh comparison: two callers can no longer
    // disagree about one pose, and no caller can forget to pass it.
    return gesture.custom?.action === gestureId.slice("custom:".length);
  }
  return Boolean(gesture[gestureId]);
}

function palmCenter(points) {
  const ids = [0, 5, 9, 13, 17];
  const sum = ids.reduce(
    (acc, id) => {
      acc.x += points[id].x;
      acc.y += points[id].y;
      return acc;
    },
    { x: 0, y: 0 },
  );
  return { x: sum.x / ids.length, y: sum.y / ids.length };
}

function detectGesture(points, allHands = [points]) {
  const thumb = points[4];
  const index = points[8];
  const middle = points[12];
  const ring = points[16];
  const pinky = points[20];
  const wrist = points[0];
  const indexBase = points[5];
  const pinkyBase = points[17];
  const palmWidth = Math.max(60, dist(indexBase, pinkyBase));
  const pinch = dist(thumb, index) < palmWidth * 0.45;
  const middlePinch = dist(thumb, middle) < palmWidth * 0.45 && !pinch;
  const openPalm =
    dist(index, wrist) > palmWidth * 1.65 &&
    dist(middle, wrist) > palmWidth * 1.65 &&
    dist(ring, wrist) > palmWidth * 1.35 &&
    dist(pinky, wrist) > palmWidth * 1.2 &&
    !pinch;
  const fist =
    dist(index, wrist) < palmWidth * 1.18 &&
    dist(middle, wrist) < palmWidth * 1.15 &&
    dist(ring, wrist) < palmWidth * 1.12 &&
    dist(pinky, wrist) < palmWidth * 1.1;

  const detected = {
    pinch,
    middlePinch,
    openPalm,
    fist,
    palm: palmCenter(points),
    index,
    // The motion laws track the wrist, not the fingertip: fingers move within a
    // held pose, and what matters there is whether the hand as a whole is parked
    // or travelling.
    wrist,
    palmWidth,
    poseTemplate: buildPoseTemplate(allHands),
  };
  // Resolved before any consumer looks at it, so every consumer this frame sees
  // the same verdict.
  detected.custom = resolveCustomGesture(detected);
  const clickGesture = settings.gestureMap?.click || "pinch";
  const rightClickGesture = settings.gestureMap?.rightClick || "middlePinch";
  const wakeGesture = settings.gestureMap?.wake || "openPalm";
  const exitGesture = settings.gestureMap?.exit || "fist";
  detected.label = settings.controlEnabled
    ? gestureMatches(detected, clickGesture)
      ? `${GESTURE_LABELS[clickGesture] || "手势"}点击/拖拽`
      : gestureMatches(detected, rightClickGesture)
        ? `${GESTURE_LABELS[rightClickGesture] || "手势"}右键`
        : gestureMatches(detected, exitGesture)
          ? `${GESTURE_LABELS[exitGesture] || "手势"}退出`
          : "控制中"
    : gestureMatches(detected, wakeGesture)
      ? `${GESTURE_LABELS[wakeGesture] || "手势"}唤醒`
      : "待机";
  return detected;
}

function screenPoint(localX, localY) {
  return {
    x: state.screen.x + clamp(localX, 0, window.innerWidth),
    y: state.screen.y + clamp(localY, 0, window.innerHeight),
  };
}

function sendPointer(type, x, y) {
  const p = screenPoint(x, y);
  aircursor.pointer({ type, x: p.x, y: p.y });
}

// Scroll and key carry no coordinate: they go to whatever is focused, the same
// way a trackpad two-finger scroll and Ctrl+Arrow do.
function sendScroll(notches) {
  aircursor.pointer({ type: "scroll", dy: notches });
}

function sendKey(key) {
  aircursor.pointer({ type: "key", key });
}

function setControlMode(enabled) {
  if (Date.now() < state.toggleCooldownUntil) return;
  state.toggleCooldownUntil = Date.now() + 900;
  settings.controlEnabled = enabled;

  if (!enabled && state.pointerDown) {
    sendPointer("up", state.cursor.x, state.cursor.y);
    state.pointerDown = false;
  }
  resetPinch();

  aircursor.updateSettings({ controlEnabled: enabled, overlayVisible: true });
  aircursor.status({ controlEnabled: enabled });
  burst(state.cursor.x, state.cursor.y, settings.effects === "rich" ? 48 : 20, enabled ? "#49e5ff" : "#ff4ea3");
}

function moveCursorToward(gesture, timestamp) {
  const raw = gesture.index;
  const next = pointerFilter.update(raw.x, raw.y, timestamp);
  state.cursor.x = next.x;
  state.cursor.y = next.y;
  state.cursor.ready = true;
  state.cursor.held = next.held;
  metrics.markCursor(raw.x, raw.y, next.x, next.y);
  return next;
}

// A hold is measured in wall-clock time, not in consecutive matching frames.
//
// The tracker drops a third of frames on real hardware, so "reset on the first
// non-matching frame" is not a strictness knob — it makes any hold longer than a
// few frames unreachable. Instead the timer keeps running while the gesture is
// missing, and only restarts once it has been missing for HOLD_GRACE_MS. Letting
// go still cancels: the user just has to actually let go rather than blink out
// for one frame.
//
// `hold` carries { id, startedAt, missingSince }. Returns the elapsed hold in ms,
// or 0 when nothing is being held.
function trackHold(hold, id, now) {
  if (!id) {
    // Keep the timer alive across a short dropout, but remember when the gap
    // started so a real release can end it.
    if (!hold.id) return 0;
    if (!hold.missingSince) hold.missingSince = now;
    if (now - hold.missingSince <= HOLD_GRACE_MS) return now - hold.startedAt;
    hold.id = null;
    hold.startedAt = 0;
    hold.missingSince = 0;
    return 0;
  }

  if (hold.id !== id) {
    hold.id = id;
    hold.startedAt = now;
    hold.missingSince = 0;
    return 0;
  }
  hold.missingSince = 0;
  return now - hold.startedAt;
}

function clearHold(hold) {
  hold.id = null;
  hold.startedAt = 0;
  hold.missingSince = 0;
}

// For diagnostics: how long the hold in progress has been running, whichever gate
// owns it. Only one can be active, since a pose maps to one action.
function holdElapsedMs() {
  const hold = state.modeHold.id ? state.modeHold : state.ruleHold;
  return hold.id ? Math.round(Date.now() - hold.startedAt) : 0;
}

function updateHoldGesture(gesture) {
  const desired = !gesture
    ? null
    : !settings.controlEnabled && gestureMatches(gesture, settings.gestureMap?.wake)
      ? "wake"
      : settings.controlEnabled && gestureMatches(gesture, settings.gestureMap?.exit)
        ? "sleep"
        : null;

  const now = Date.now();
  const hold = state.modeHold;
  const held = trackHold(hold, desired, now);
  if (!hold.id || held < WAKE_HOLD_MS) return;

  const target = hold.id;
  clearHold(hold);
  setControlMode(target === "wake");
}

// Launching an app is not a mouse move: it cannot be undone by moving back, and
// a pose held for a second would otherwise fire it every frame. So rules need a
// deliberate hold plus a cooldown, and only ever fire from a recorded gesture —
// the built-in poses stay reserved for the pointer.
function updateRuleGestures(gesture) {
  const hold = state.ruleHold;
  const now = Date.now();
  const bound = !gesture
    ? null
    : state.ruleIds.find((id) => {
        const mapped = settings.gestureMap?.[id];
        return mapped?.startsWith("custom:") && gestureMatches(gesture, mapped);
      });

  const held = trackHold(hold, bound || null, now);
  if (!hold.id) return;
  // Checked after the hold is tracked, so a pose held through the cooldown is
  // still being timed rather than having to be re-formed once it lifts.
  if (now < state.ruleCooldownUntil) return;
  if (held < RULE_HOLD_MS) return;

  const target = hold.id;
  clearHold(hold);
  // Long enough that releasing the pose is not a race, since the launched app
  // takes the foreground and the hand is usually still mid-frame.
  state.ruleCooldownUntil = now + 2500;
  burst(state.cursor.x, state.cursor.y, settings.effects === "rich" ? 32 : 12, "#8affc1");
  // `target`, not `bound`: the hold can complete on a frame where the tracker
  // lost the hand and the grace window is carrying it, and `bound` is null then.
  aircursor.runRule(target);
}

function resetPinch() {
  state.pinch.active = false;
  state.pinch.startedAt = 0;
  state.pinch.startX = 0;
  state.pinch.startY = 0;
  state.pinch.missingSince = 0;
}

// A click fires on release, at the point the pose was formed rather than wherever
// the hand has drifted to since: aiming happens before the click, and charging
// the drift to the click made small targets unhittable.
function releasePinch() {
  sendPointer("click", state.pinch.startX, state.pinch.startY);
  burst(state.pinch.startX, state.pinch.startY, settings.effects === "rich" ? 18 : 6, "#ffd76a");
  resetPinch();
}

function resetDrag() {
  state.drag.active = false;
  state.drag.missingSince = 0;
}

// Drag is its own gesture now, so it is simply "button down while the pose is
// held". It used to be inferred from a click pose that moved far enough, which
// had to guess at intent and, worse, collided with the motion gestures: those
// move the hand deliberately, so any pose still matching click would have
// started dragging mid-scroll.
function endDrag() {
  if (state.pointerDown) {
    sendPointer("up", state.cursor.x, state.cursor.y);
    state.pointerDown = false;
    burst(state.cursor.x, state.cursor.y, settings.effects === "rich" ? 18 : 6, "#49e5ff");
  }
  resetDrag();
}

// The two motion laws. The pose only says which law is active; the movement
// afterwards decides what happens, which is why neither can be expressed as a
// static template match alone.
//
// Wrist speed separates them with no arbitration: the ratchet needs a parked
// wrist, the swipe a travelling one, and the dead band between the thresholds
// means one motion can never satisfy both. Ordering decided a gesture conflict
// once before and the loser could never fire at all — not repeating that.
function updateMotionGestures(gesture, now) {
  const active = tuning();
  const m = state.motion;

  if (!settings.controlEnabled || !gesture) {
    wristPath.reset();
    scrollRatchet.reset();
    swipeDetector.reset();
    m.tiltDeg = 0;
    m.wristSpeed = 0;
    m.scrollBlocked = settings.controlEnabled ? "noHand" : "controlOff";
    m.swipeBlocked = m.scrollBlocked;
    return;
  }

  // The wrist, not the fingertip: fingers move within a held pose, and the
  // question here is whether the hand as a whole is parked or travelling.
  const wrist = gesture.wrist;
  wristPath.push(wrist.x, wrist.y, gesture.palmWidth, now);
  const displacement = wristPath.displacement();
  m.wristSpeed = Number((displacement?.speed ?? 0).toFixed(2));

  const scrollBinding = settings.gestureMap?.scroll;
  const scrollTemplate = scrollBinding?.startsWith("custom:")
    ? settings.recordedGestures?.[scrollBinding.slice("custom:".length)]?.template
    : null;

  if (scrollTemplate && gestureMatches(gesture, scrollBinding)) {
    // Clamped against the rotation tolerance: past that limit the tilted pose no
    // longer matches its own template, so a trigger set beyond it would make the
    // gesture disappear at exactly the angle it should fire at. Measured on a
    // hand-shaped pose, leftover rotation costs ~0.0196 distance per degree.
    const ceiling = maxUsableTiltDeg(active.rotationTolerance, active.matchThreshold);
    const trigger = Math.min(active.scrollTriggerDeg, ceiling);
    m.clampedTrigger = trigger < active.scrollTriggerDeg;
    m.triggerDeg = Number(trigger.toFixed(1));

    const direction = scrollRatchet.update({
      liveAngle: gesture.poseTemplate?.angle,
      templateAngle: scrollTemplate.angle,
      wristSpeed: displacement?.speed ?? 0,
      triggerDeg: trigger,
      now,
    });
    m.tiltDeg = Number(scrollRatchet.deltaDeg.toFixed(1));
    m.scrollBlocked = scrollRatchet.blocked;
    if (direction) {
      sendScroll(direction * active.scrollNotches);
      m.scrollNotches += 1;
      m.lastScrollAt = now;
      burst(state.cursor.x, state.cursor.y, settings.effects === "rich" ? 20 : 8, "#8affc1");
    }
  } else {
    scrollRatchet.reset();
    m.tiltDeg = 0;
    m.scrollBlocked = scrollTemplate ? "poseNotMatched" : "notBound";
  }

  const swipeBinding = settings.gestureMap?.spaceSwitch;
  if (swipeBinding?.startsWith("custom:") && gestureMatches(gesture, swipeBinding)) {
    const direction = swipeDetector.update({
      displacement,
      speedThreshold: active.swipeSpeed,
      now,
    });
    m.swipeBlocked = swipeDetector.blocked;
    if (direction) {
      // A rightward hand sends the desktop rightward, matching the trackpad.
      sendKey(direction > 0 ? "spaceRight" : "spaceLeft");
      m.swipes += 1;
      m.lastSwipeAt = now;
      m.lastSwipeDirection = direction;
      burst(state.cursor.x, state.cursor.y, settings.effects === "rich" ? 28 : 10, "#49e5ff");
    }
  } else {
    swipeDetector.reset();
    m.swipeBlocked = swipeBinding ? "poseNotMatched" : "notBound";
  }
}

function updateSystemCursor(gesture) {
  const now = performance.now();

  // Turning control off is a deliberate abort, so it drops the pinch without
  // clicking. Losing the hand is not: the click fires on release, so treating a
  // dropped frame as "no gesture" threw away a click the user had already made.
  if (!settings.controlEnabled) {
    endDrag();
    resetPinch();
    pointerFilter.reset();
    return;
  }

  // No hand at all: hold both poses through a short dropout, then finish them as
  // if the user had let go — which, if the hand really is gone, they have.
  if (!gesture) {
    if (state.drag.active) {
      if (!state.drag.missingSince) state.drag.missingSince = now;
      if (now - state.drag.missingSince > PINCH_GRACE_MS) endDrag();
    }
    if (!state.pinch.active) {
      pointerFilter.reset();
      return;
    }
    if (!state.pinch.missingSince) state.pinch.missingSince = now;
    if (now - state.pinch.missingSince <= PINCH_GRACE_MS) return;
    releasePinch();
    pointerFilter.reset();
    return;
  }

  const moved = moveCursorToward(gesture, now);

  // A pinch waiting to become a click parks the cursor so the click lands where
  // it was aimed; a drag has to keep moving, that is the point of it.
  const canSendMove = !state.pinch.active || state.drag.active;
  // A held cursor is intentionally parked, so re-sending the same coordinate
  // would only add pointer traffic without moving anything.
  if (canSendMove && !moved.held && now - state.lastPointerSentAt > tuning().moveIntervalMs) {
    sendPointer("move", state.cursor.x, state.cursor.y);
    state.lastPointerSentAt = now;
    metrics.markPointerEvent();
  }

  const rightClickActive = gestureMatches(gesture, settings.gestureMap?.rightClick);
  const clickActive = gestureMatches(gesture, settings.gestureMap?.click);
  const dragActive = gestureMatches(gesture, settings.gestureMap?.drag);

  // Drag runs before the click branches and returns: while the button is down,
  // a frame that also matches click must not start a competing pinch.
  if (dragActive) {
    state.drag.missingSince = 0;
    if (!state.drag.active) {
      state.drag.active = true;
      state.pointerDown = true;
      sendPointer("down", state.cursor.x, state.cursor.y);
      burst(state.cursor.x, state.cursor.y, settings.effects === "rich" ? 18 : 6, "#ff4ea3");
    }
    return;
  }

  if (state.drag.active) {
    // Same grace as the click: a held pose flickers off for a frame or two, and
    // a two-hand pose loses its match whenever either hand is missed. Dropping
    // the button on the first such frame would end the drag mid-movement.
    if (!state.drag.missingSince) state.drag.missingSince = now;
    if (now - state.drag.missingSince <= PINCH_GRACE_MS) return;
    endDrag();
  }

  if (rightClickActive && now > state.rightClickCooldownUntil) {
    state.rightClickCooldownUntil = now + 650;
    sendPointer("rightClick", state.cursor.x, state.cursor.y);
    burst(state.cursor.x, state.cursor.y, settings.effects === "rich" ? 24 : 8, "#ffd76a");
    return;
  }

  if (clickActive && !state.pinch.active) {
    state.pinch.missingSince = 0;
    state.pinch.active = true;
    state.pinch.startedAt = now;
    state.pinch.startX = state.cursor.x;
    state.pinch.startY = state.cursor.y;
    burst(state.pinch.startX, state.pinch.startY, settings.effects === "rich" ? 18 : 6, "#ff4ea3");
    return;
  }

  if (clickActive && state.pinch.active) {
    state.pinch.missingSince = 0;
    return;
  }

  if (!clickActive && state.pinch.active) {
    // The pose is gone this frame, but a recorded gesture flickers off for a
    // frame or two while still being held — a two-hand click loses its match
    // every time either hand is missed. Clicking on the first such frame fired
    // early and then fired again on the real release, so the same grace window
    // applies here: only a gap longer than PINCH_GRACE_MS counts as a release.
    if (!state.pinch.missingSince) state.pinch.missingSince = now;
    if (now - state.pinch.missingSince <= PINCH_GRACE_MS) return;
    releasePinch();
  }
}

function startRecording(action, wantedHands) {
  state.recording = {
    action,
    wantedHands,
    phase: "countdown",
    startedAt: performance.now(),
    holdStartedAt: 0,
    samples: [],
    reference: null,
  };
}

function stopRecording() {
  state.recording = null;
}

// Two poses too close together are not two gestures: a live pose goes to
// whichever template is nearer, so the user gets the other action and this one
// looks broken. Better to refuse at save time, while they still know what they
// just did, than to ship a mapping that misfires.
//
// Only the blocking level refuses here (see SEPARATION_FACTOR): below it the two
// templates sit within the drift of a single held pose, so which one fires is
// arbitrary. Pairs in the advisory band still save — refusing them would reject
// open-palm vs fist — and the dashboard warns about those instead.
function conflictingAction(action, template) {
  const entries = Object.entries(settings.recordedGestures || {});
  for (const [other, entry] of entries) {
    if (other === action || !entry?.template) continue;
    if (!settings.gestureMap?.[other]?.startsWith("custom:")) continue;
    const distance = templateDistance(template, entry.template, ROTATION_TOLERANCE);
    if (distance < MATCH_THRESHOLD * SEPARATION_FACTOR) {
      return { action: other, distance: Number(distance.toFixed(3)) };
    }
  }
  return null;
}

function finishRecording(recording) {
  const template = medianTemplate(recording.samples);
  const conflict = conflictingAction(recording.action, template);
  state.recording = null;
  if (conflict) {
    aircursor.recordingResult({
      ok: false,
      action: recording.action,
      conflictWith: conflict.action,
      distance: conflict.distance,
    });
    return;
  }
  aircursor.recordingResult({ ok: true, action: recording.action, template });
}

function failRecording(recording, reason) {
  state.recording = null;
  aircursor.recordingResult({ ok: false, action: recording.action, reason });
}

// Capture never depends on the user reaching for a button: two-hand poses make
// that impossible. Hold the pose still for HOLD_MS and it saves itself.
function updateRecording(gesture, handCount) {
  const recording = state.recording;
  if (!recording) return;

  const now = performance.now();
  const elapsed = now - recording.startedAt;

  if (recording.phase === "countdown") {
    const remaining = COUNTDOWN_MS - elapsed;
    if (remaining > 0) {
      aircursor.recordingProgress({
        action: recording.action,
        phase: "countdown",
        countdown: Math.ceil(remaining / 1000),
      });
      return;
    }
    recording.phase = "capture";
    recording.startedAt = now;
  }

  if (now - recording.startedAt > CAPTURE_TIMEOUT_MS) {
    failRecording(recording, "超时未保持稳定手势，请重新录制");
    return;
  }

  const pose = gesture?.poseTemplate;
  const wrongHands = recording.wantedHands && handCount !== recording.wantedHands;
  if (!pose || wrongHands) {
    recording.holdStartedAt = 0;
    recording.samples = [];
    recording.reference = null;
    aircursor.recordingProgress({
      action: recording.action,
      phase: "capture",
      progress: 0,
      hint: !handCount
        ? "没有检测到手，把手放进摄像头画面"
        : wrongHands
          ? `需要 ${recording.wantedHands} 只手同时入镜`
          : "识别中",
    });
    return;
  }

  // Drift is measured against the pose that opened this hold window, so slow
  // creeping movement cannot accumulate frame by frame unnoticed.
  const drift = recording.reference ? templateDistance(pose, recording.reference) : 0;
  if (drift > MATCH_THRESHOLD * STABLE_TOLERANCE_RATIO) {
    recording.holdStartedAt = now;
    recording.samples = [pose];
    recording.reference = pose;
    aircursor.recordingProgress({
      action: recording.action,
      phase: "capture",
      progress: 0,
      hint: "手势有变动，保持不动",
    });
    return;
  }

  if (!recording.holdStartedAt) {
    recording.holdStartedAt = now;
    recording.reference = pose;
  }
  recording.samples.push(pose);
  if (recording.samples.length > MAX_SAMPLES) recording.samples.shift();

  const held = now - recording.holdStartedAt;
  if (held >= HOLD_MS) {
    finishRecording(recording);
    return;
  }

  aircursor.recordingProgress({
    action: recording.action,
    phase: "capture",
    progress: Math.min(1, held / HOLD_MS),
    hint: `保持不动 ${((HOLD_MS - held) / 1000).toFixed(1)}s`,
  });
}

function burst(x, y, count, color) {
  const maxParticles = settings.effects === "rich" ? 72 : 28;
  if (state.particles.length > maxParticles) {
    state.particles.splice(0, state.particles.length - maxParticles);
  }

  for (let i = 0; i < count; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 2 + Math.random() * 8;
    state.particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0.5 + Math.random() * 0.8,
      age: 0,
      size: 2 + Math.random() * 7,
      color,
    });
  }
}

function drawHand(points, handIndex, gesture) {
  if (!settings.showHands) return;

  const lines = [
    [0, 1, 2, 3, 4],
    [0, 5, 6, 7, 8],
    [0, 9, 10, 11, 12],
    [0, 13, 14, 15, 16],
    [0, 17, 18, 19, 20],
    [5, 9, 13, 17],
  ];
  const t = performance.now() / 1000;
  const hueBase = handIndex === 0 ? 188 : 292;
  const hue = gesture?.pinch ? 325 : hueBase + Math.sin(t * 2.2 + handIndex) * 32;
  const stroke = `hsl(${hue}, 100%, 64%)`;
  const core = `hsl(${hue + 25}, 100%, 82%)`;

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = settings.controlEnabled ? 5 : 3;
  ctx.strokeStyle = stroke;
  ctx.shadowColor = stroke;
  ctx.shadowBlur = settings.effects === "rich" ? (settings.controlEnabled ? 28 : 16) : 8;
  ctx.globalAlpha = settings.controlEnabled ? 0.96 : 0.72;

  for (const line of lines) {
    ctx.beginPath();
    line.forEach((id, index) => {
      const p = points[id];
      if (index === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
  }

  for (const p of points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, settings.controlEnabled ? 5 : 3.5, 0, Math.PI * 2);
    ctx.fillStyle = core;
    ctx.fill();
  }

  ctx.restore();
}

function drawCursor(gesture) {
  if (!settings.controlEnabled) return;
  const x = state.cursor.x;
  const y = state.cursor.y;
  const t = performance.now() / 1000;
  const eventHorizon = gesture?.pinch ? 7.5 : 6.5;
  const ring = gesture?.pinch ? 13 : 12;
  const glow = gesture?.pinch ? "#ff67ba" : "#f6d986";
  const coolEdge = gesture?.pinch ? "#7cf4ff" : "#dff8ff";

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = 0.42;
  ctx.strokeStyle = coolEdge;
  ctx.lineWidth = 1.2;
  ctx.shadowColor = coolEdge;
  ctx.shadowBlur = settings.effects === "rich" ? 12 : 6;
  for (let i = 0; i < 3; i += 1) {
    const offset = i * 2.6;
    const drift = Math.sin(t * 2.1 + i) * 1.4;
    ctx.beginPath();
    ctx.ellipse(x + drift, y, ring + 5 + offset, ring * 0.55 + offset * 0.2, -0.22, Math.PI * 1.08, Math.PI * 1.9);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(x - drift, y, ring + 5 + offset, ring * 0.55 + offset * 0.2, -0.22, Math.PI * 0.08, Math.PI * 0.9);
    ctx.stroke();
  }

  const diskGradient = ctx.createLinearGradient(x - ring * 2.0, y, x + ring * 2.0, y);
  diskGradient.addColorStop(0, "rgba(255, 236, 145, 0)");
  diskGradient.addColorStop(0.18, "rgba(255, 229, 135, 0.68)");
  diskGradient.addColorStop(0.5, "rgba(255, 247, 196, 0.94)");
  diskGradient.addColorStop(0.82, "rgba(255, 195, 95, 0.62)");
  diskGradient.addColorStop(1, "rgba(255, 212, 116, 0)");
  ctx.globalAlpha = gesture?.pinch ? 0.9 : 0.78;
  ctx.strokeStyle = diskGradient;
  ctx.lineWidth = 3.2;
  ctx.shadowColor = glow;
  ctx.shadowBlur = settings.effects === "rich" ? 18 : 9;
  ctx.beginPath();
  ctx.ellipse(x, y + 0.4, ring * 2.1, ring * 0.34, 0.02, 0, Math.PI * 2);
  ctx.stroke();

  ctx.globalAlpha = 0.92;
  ctx.strokeStyle = glow;
  ctx.lineWidth = 1.4;
  ctx.shadowBlur = settings.effects === "rich" ? 14 : 7;
  ctx.beginPath();
  ctx.ellipse(x, y, ring, ring * 0.82, -0.2, 0, Math.PI * 2);
  ctx.stroke();

  ctx.globalCompositeOperation = "source-over";
  const core = ctx.createRadialGradient(x - 2, y - 2, 1, x, y, eventHorizon + 1.5);
  core.addColorStop(0, "#1b1d23");
  core.addColorStop(0.58, "#030406");
  core.addColorStop(1, "rgba(0, 0, 0, 0.94)");
  ctx.fillStyle = core;
  ctx.shadowColor = "#000000";
  ctx.shadowBlur = 5;
  ctx.beginPath();
  ctx.arc(x, y, eventHorizon, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = gesture?.pinch ? "#ffffff" : "#8ff8ff";
  ctx.shadowColor = ctx.fillStyle;
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.arc(x, y, 1.7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawParticles(dt) {
  state.particles = state.particles.filter((p) => p.age < p.life);
  for (const p of state.particles) {
    p.age += dt;
    p.x += p.vx * dt * 60;
    p.y += p.vy * dt * 60;
    p.vx *= 0.96;
    p.vy *= 0.96;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 1 - p.age / p.life;
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

let lastFrame = performance.now();
let lastStatusAt = 0;
let lastMetricsAt = 0;
let lastDrawAt = 0;
function loop(now) {
  const targetDrawInterval = settings.effects === "rich" ? 8 : 12;
  if (now - lastDrawAt < targetDrawInterval) {
    requestAnimationFrame(loop);
    return;
  }
  lastDrawAt = now;
  metrics.markDraw(now);

  const dt = Math.min(0.04, (now - lastFrame) / 1000);
  lastFrame = now;
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  const hands = orderHands(state.hands, state.handedness).map((hand) => hand.map(point));
  const gesture = hands[0] ? detectGesture(hands[0], hands) : null;
  // Without this the resolver's sticky winner survives the hand leaving frame,
  // and hysteresis would then bias the next pose toward whatever was held last.
  if (!gesture) resolver.reset();
  state.gesture = gesture;

  updateRecording(gesture, hands.length);
  // Recording must not fire the very action being recorded.
  if (!state.recording) {
    updateHoldGesture(gesture);
    // Rules do not require control mode: opening an app should not demand that
    // you wake the pointer first.
    updateRuleGestures(gesture);
    updateSystemCursor(gesture);
    // After the pointer, so a frame that starts a drag has already claimed the
    // pose before the motion laws look at it, and `now` matches the same clock
    // updateSystemCursor used.
    updateMotionGestures(gesture, now);
  } else {
    // Recording must not fire the action being recorded, and the motion state
    // must not carry the recording session's hand movement into the next frame.
    wristPath.reset();
    scrollRatchet.reset();
    swipeDetector.reset();
  }
  // All template comparisons for this frame are done, so the closest one can be
  // recorded as the frame's match distance.
  metrics.commitMatchDistance();
  hands.forEach((points, index) => drawHand(points, index, index === 0 ? gesture : null));
  drawCursor(gesture);
  drawParticles(dt);

  if (settings.diagnostics && now - lastMetricsAt > 500) {
    lastMetricsAt = now;
    aircursor.metrics({
      ...metrics.snapshot(),
      hands: hands.length,
      cursorHeld: Boolean(state.cursor.held),
      controlEnabled: settings.controlEnabled,
      // What the frame loop is actually waiting on. A distance alone cannot tell
      // "nothing matched" from "it matched but the hold never survived long
      // enough to fire", and those need opposite fixes.
      holdId: state.modeHold.id || state.ruleHold.id || null,
      holdMs: holdElapsedMs(),
      pinchActive: state.pinch.active,
      dragActive: state.drag.active,
      // The motion gestures each have several distinct ways to do nothing, and
      // every one of them presents as "the pose is recognised and the screen
      // does not move" — the fault this project has already chased three times.
      // So the reason is reported, not just the numbers.
      motion: { ...state.motion },
      tuning: tuning(),
    });
  }

  if (now - lastStatusAt > 500) {
    lastStatusAt = now;
    aircursor.status({
      camera: state.cameraReady ? "已开启" : "等待权限",
      handCount: hands.length,
      hand: hands.length
        ? `${hands.length} 只手 / ${settings.showHands ? "骨架显示中" : "骨架隐藏"} / ${gesture?.label || "识别中"}`
        : settings.showHands
          ? "骨架已开，等待检测到手"
          : "未检测到手",
      controlEnabled: settings.controlEnabled,
    });
  }

  requestAnimationFrame(loop);
}

async function stopHandsRuntime() {
  const runtime = state.handRuntime;
  state.handRuntime = null;
  state.hands = [];
  state.handedness = [];
  state.cameraReady = false;
  state.inferenceBusy = false;
  resetPinch();

  if (runtime?.camera?.stop) {
    await runtime.camera.stop();
  }
  if (runtime?.hands?.close) {
    runtime.hands.close();
  }
}

async function setupHands() {
  const token = state.handRestartToken + 1;
  state.handRestartToken = token;
  await stopHandsRuntime();
  aircursor.status({ camera: "正在加载手势模型" });

  if (!window.Hands || !window.Camera) {
    throw new Error("MediaPipe 本地脚本未加载");
  }

  const hands = new Hands({
    locateFile: (file) => `./vendor/mediapipe/hands/${file}`,
  });

  hands.setOptions({
    maxNumHands: settings.twoHands ? 2 : 1,
    modelComplexity: 0,
    minDetectionConfidence: 0.48,
    minTrackingConfidence: 0.44,
  });

  hands.onResults((results) => {
    if (token !== state.handRestartToken) return;
    state.hands = results.multiHandLandmarks || [];
    state.handedness = results.multiHandedness || [];
    state.resultAt = performance.now();
    metrics.markHands(state.hands.length);
    metrics.markPipeline(state.frameCapturedAt, state.resultAt);
  });

  const camera = new Camera(video, {
    onFrame: async () => {
      const now = performance.now();
      metrics.markFrame(now);
      const minInterval = tuning().inferenceIntervalMs;
      if (token !== state.handRestartToken || state.inferenceBusy || now - state.lastInferenceAt < minInterval) {
        metrics.markSkippedFrame();
        return;
      }

      state.inferenceBusy = true;
      state.lastInferenceAt = now;
      state.frameCapturedAt = now;
      try {
        await hands.send({ image: video });
        metrics.markInference(performance.now() - now);
      } finally {
        state.inferenceBusy = false;
      }
    },
    width: 640,
    height: settings.twoHands ? 480 : 360,
  });

  state.handRuntime = { hands, camera };
  aircursor.status({ camera: "正在请求摄像头权限" });
  await camera.start();
  if (token !== state.handRestartToken) return;
  state.cameraReady = true;
  aircursor.status({ camera: settings.twoHands ? "已开启（双手）" : "已开启（单手）" });
}

function handleVoiceText(rawText, source = "语音") {
  if (!settings.voiceEnabled) return;
  const text = rawText.trim().replace(/\s+/g, "");
  if (!text) return;

  const rule = VOICE_RULES.find((item) => item.match.test(text));
  if (!rule) {
    aircursor.status({ rule: `未匹配${source}：${text}` });
    return;
  }

  if (rule.run) {
    if (rule.run() !== false) {
      aircursor.status({ rule: `${source}：${rule.label}` });
    }
    return;
  }

  aircursor.runRule(rule.id).then((response) => {
    aircursor.status({
      rule: `${response.ok ? source : `${source}失败`}：${rule.label}`,
    });
  });
}

function setupVoice() {
  if (aircursor.platform === "darwin") {
    aircursor.status({ voice: "使用 macOS 语音 helper" });
    return;
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    aircursor.status({ voice: "浏览器语音不可用，使用 macOS 固定口令" });
    return;
  }

  const recognizer = new SpeechRecognition();
  recognizer.lang = "zh-CN";
  recognizer.continuous = true;
  recognizer.interimResults = false;

  recognizer.onresult = (event) => {
    const result = event.results[event.results.length - 1];
    handleVoiceText(result[0].transcript, "浏览器语音");
  };

  recognizer.onstart = () => aircursor.status({ voice: "浏览器语音已开启" });
  recognizer.onerror = (event) => aircursor.status({ voice: `浏览器语音错误：${event.error}` });
  recognizer.onend = () => {
    if (!settings.voiceEnabled) return;
    try {
      recognizer.start();
    } catch {
      // Voice stays optional because Chromium speech support can vary.
    }
  };
  try {
    recognizer.start();
  } catch {
    // Voice stays optional because Chromium speech support can vary.
  }
}

aircursor.onSettings((next) => {
  const previousTwoHands = settings.twoHands;
  const needsResize = next.effects && next.effects !== settings.effects;
  Object.assign(settings, next, {
    gestureMap: { ...settings.gestureMap, ...(next.gestureMap || {}) },
    recordedGestures: next.recordedGestures || settings.recordedGestures,
    tuning: { ...settings.tuning, ...(next.tuning || {}) },
  });
  applyTuning();
  if (needsResize) resize();
  if (!settings.controlEnabled && state.pointerDown) {
    sendPointer("up", state.cursor.x, state.cursor.y);
    state.pointerDown = false;
  }
  if (!settings.controlEnabled) resetPinch();
  if (typeof next.twoHands === "boolean" && next.twoHands !== previousTwoHands) {
    setupHands().catch((error) => {
      console.error(error);
      aircursor.status({ camera: `切换失败：${error.message}` });
    });
  }
});
// The rolling means live here, so a reset from the dashboard has to reach the
// overlay; clearing only main's log would keep reporting the old numbers.
aircursor.onResetMetrics(() => {
  metrics.reset();
  pointerFilter.reset();
});
aircursor.onRecording((request) => {
  if (!request || request.type === "stop") {
    stopRecording();
    return;
  }
  startRecording(request.action, request.hands);
});
aircursor.onVoiceCommand((phrase) => handleVoiceText(phrase, "系统语音"));
window.addEventListener("resize", resize);

async function boot() {
  const bootState = await aircursor.getState();
  Object.assign(settings, bootState.settings);
  state.screen = bootState.screen;
  state.ruleIds = (bootState.rules || []).map((rule) => rule.id);
  applyTuning();
  resize();
  setupVoice();
  requestAnimationFrame(loop);
  setupHands().catch((error) => {
    console.error(error);
    aircursor.status({ camera: `启动失败：${error.message}` });
  });
}

boot();
})();
