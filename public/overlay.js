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
  saveCapture: () => {},
  onStartCapture: () => {},
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
  disabledActions: {},
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
const {
  WristPath,
  TiltRatchet,
  SwipeDetector,
  SequenceMatcher,
  maxUsableTiltDeg,
  wrapAngle,
  toDegrees,
  buildKeyframes,
  sequenceSpan,
  MIN_KEYFRAMES,
  MIN_SEQUENCE_SPAN,
  RATCHET_MAX_SPEED,
} = window.AirCursorMotion;

const metrics = new TrackingMetrics();
const resolver = new GestureResolver();
const wristPath = new WristPath();

// What each directional action sends. The direction belongs to the action, not to
// the shape of the movement that triggered it.
const ACTION_DIRECTION = { scrollUp: -1, scrollDown: 1, spaceLeft: -1, spaceRight: 1 };

// An action the user has switched off must not fire, but must keep its recording:
// turning something off for now and throwing the recording away are different
// intents, and only one of them is reversible without re-recording.
function actionDisabled(action) {
  return Boolean(settings.disabledActions?.[action]);
}

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
// 3s was set when recording meant one still pose. A dynamic recording now costs
// countdown + hold + the movement, and the whole thing has to be repeated on any
// mistake — reported as "现在的录制变得更加困难了". 2s is still enough time to get
// into frame, and the hold is where accuracy actually comes from.
const COUNTDOWN_MS = 2000;
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
    triggerFromRecording: false,
    wristSpeed: 0,
    scrollBlocked: null,
    scrollAction: null,
    scrollNotches: 0,
    lastScrollAt: 0,
    lastScrollAction: null,
    swipeBlocked: null,
    swipeAction: null,
    swipeSpeedThreshold: 0,
    swipes: 0,
    lastSwipeAt: 0,
    lastSwipeAction: null,
    // Law-less recorded movements, matched as sequences.
    sequences: 0,
    lastSequenceAction: null,
    lastSequenceAt: 0,
    sequenceProgress: 0,
    sequenceBlocked: null,
  },
  // Non-null while a raw landmark capture is running.
  capture: null,
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
  // Nothing matches while recording. The frame loop already skips the trigger
  // calls, but that was not enough: performing a movement takes the hand through
  // a lot of intermediate poses, and those were still being matched here — so on
  // a real Mac with nine gestures recorded, recording a new one exited control
  // mode, opened Terminal and scrolled the page, all mid-capture. It gets worse
  // the more gestures exist, since any movement then almost certainly passes
  // through one of them.
  //
  // Guarding at the top of matching rather than at each consumer, because "which
  // consumer did I forget" is exactly how the first version leaked.
  if (state.recording || !gesture?.poseTemplate) {
    resolver.reset();
    return null;
  }
  const candidates = [];
  for (const [action, mapped] of Object.entries(settings.gestureMap || {})) {
    if (!mapped?.startsWith("custom:")) continue;
    if (actionDisabled(action)) continue;
    const entry = settings.recordedGestures?.[mapped.slice("custom:".length)];
    if (!entry?.template) continue;
    // A sequence gesture's stored template is the pose the movement *starts*
    // from, so treating it as a static candidate would fire the action the moment
    // the user struck the starting pose — before performing the movement at all.
    // Its matching runs through the sequence matcher instead.
    // A sequence's stored template is the pose the movement starts from, so
    // matching it statically would fire the action the moment the user struck the
    // starting pose. A tilt recording is different: the ratchet needs the pose to
    // match in order to read its angle at all.
    if (entry.keyframes?.length && !entry.motion?.measure) continue;
    candidates.push({ action, template: entry.template });
  }
  return resolver.resolve(
    gesture.poseTemplate,
    candidates,
    MATCH_THRESHOLD,
    ROTATION_TOLERANCE,
    (distance, action) => metrics.markMatchDistance(distance, action),
  );
}

// Takes the action so the enable switch is enforced in one place. Built-in poses
// never go through resolveCustomGesture, so gating only there would have left the
// switch working for recorded gestures and silently doing nothing for the default
// pinch/palm/fist ones.
function gestureMatches(gesture, gestureId, action) {
  // Same reason as resolveCustomGesture: the built-in poses (pinch/palm/fist) do
  // not go through it, so without this a recording session could still be
  // interrupted by whichever built-in pose the hand passed through.
  if (state.recording) return false;
  if (action && actionDisabled(action)) return false;
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
    : !settings.controlEnabled && gestureMatches(gesture, settings.gestureMap?.wake, "wake")
      ? "wake"
      : settings.controlEnabled && gestureMatches(gesture, settings.gestureMap?.exit, "exit")
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
// One matcher per action, created on demand: a sequence carries progress state,
// and two actions stepping through the same matcher would corrupt each other.
const sequenceMatchers = new Map();

function sequenceMatcherFor(action) {
  if (!sequenceMatchers.has(action)) sequenceMatchers.set(action, new SequenceMatcher());
  return sequenceMatchers.get(action);
}

// Dynamic gestures with no physical law: the recorded movement itself is the
// trigger. Any action can be bound to one, which is the point — a flick to open
// an app, a circle to right-click. Scroll and desktop switching are excluded
// because they run their own law (they need a direction and they repeat).
//
// Returns the action that completed this frame, or null.
function resolveSequenceGesture(gesture, now) {
  if (state.recording) {
    for (const matcher of sequenceMatchers.values()) matcher.reset();
    return null;
  }
  let fired = null;
  for (const [action, mapped] of Object.entries(settings.gestureMap || {})) {
    if (!mapped?.startsWith("custom:")) continue;
    if (actionDisabled(action)) continue;
    const entry = settings.recordedGestures?.[mapped.slice("custom:".length)];
    const keyframes = entry?.keyframes;
    if (!keyframes?.length) continue;
    // Keyed off what was recorded, not off the action: a scroll direction recorded
    // as a tilt is driven by the ratchet, but the same action recorded as a plain
    // movement has no law and must fall through to here. Keying on the action name
    // would have made that recording impossible to trigger.
    if (entry.motion?.measure) continue;

    const matcher = sequenceMatcherFor(action);
    const done = matcher.update({
      pose: gesture?.poseTemplate,
      keyframes,
      threshold: MATCH_THRESHOLD,
      rotationTolerance: ROTATION_TOLERANCE,
      distance: templateDistance,
      now,
    });
    // First completion wins the frame, but every matcher is still stepped, so a
    // partly-performed gesture keeps its progress instead of being starved by
    // whichever action happens to be earlier in the map.
    if (done && !fired) fired = action;
  }
  return fired;
}

// A sequence has its own ways to do nothing — never reached the starting pose,
// stalled halfway, took too long — and they need opposite fixes, so the furthest
// along matcher reports for the frame. Without this a half-recognised movement is
// indistinguishable from one that was never recognised at all.
function recordSequenceDiagnostics() {
  const m = state.motion;
  let best = null;
  for (const [action, matcher] of sequenceMatchers) {
    if (!best || matcher.progress > best.matcher.progress) best = { action, matcher };
  }
  if (!best) {
    m.sequenceProgress = 0;
    m.sequenceBlocked = sequenceMatchers.size ? null : "notBound";
    m.sequenceAction = null;
    return;
  }
  m.sequenceProgress = Number(best.matcher.progress.toFixed(2));
  m.sequenceBlocked = best.matcher.blocked;
  m.sequenceAction = best.action;
}

// What a completed movement does. A sequence is inherently one-shot — it fires
// when the movement finishes — so the actions that are inherently held (drag) or
// modal (wake/exit) map onto it as a toggle or a single event rather than
// pretending the pose is still being held.
function performSequenceAction(action) {
  state.motion.lastSequenceAction = action;
  state.motion.lastSequenceAt = performance.now();
  state.motion.sequences += 1;

  if (state.ruleIds.includes(action)) {
    aircursor.runRule(action, { fromGesture: true });
    burst(state.cursor.x, state.cursor.y, settings.effects === "rich" ? 32 : 12, "#8affc1");
    return;
  }

  switch (action) {
    case "wake":
      setControlMode(true);
      return;
    case "exit":
      setControlMode(false);
      return;
    // Requires control mode for the same reason the pose versions do: these move
    // or press the real mouse.
    case "click":
      if (!settings.controlEnabled) return;
      sendPointer("click", state.cursor.x, state.cursor.y);
      burst(state.cursor.x, state.cursor.y, settings.effects === "rich" ? 18 : 6, "#ffd76a");
      return;
    case "rightClick":
      if (!settings.controlEnabled) return;
      sendPointer("rightClick", state.cursor.x, state.cursor.y);
      burst(state.cursor.x, state.cursor.y, settings.effects === "rich" ? 24 : 8, "#ffd76a");
      return;
    // Reachable when a directional action is recorded as a plain movement rather
    // than with its law: it then fires once per movement instead of repeating.
    case "spaceLeft":
    case "spaceRight":
      sendKey(action);
      burst(state.cursor.x, state.cursor.y, settings.effects === "rich" ? 28 : 10, "#49e5ff");
      return;
    case "scrollUp":
    case "scrollDown":
      sendScroll(ACTION_DIRECTION[action] * tuning().scrollNotches);
      burst(state.cursor.x, state.cursor.y, settings.effects === "rich" ? 20 : 8, "#8affc1");
      return;
    case "drag":
      // A movement cannot express "keep holding", so it toggles: perform it to
      // pick up, perform it again to drop. Better than a drag that ends the
      // instant the movement does, which would make dragging anywhere impossible.
      if (!settings.controlEnabled) return;
      if (state.drag.active) {
        endDrag();
      } else {
        state.drag.active = true;
        state.drag.missingSince = 0;
        state.pointerDown = true;
        sendPointer("down", state.cursor.x, state.cursor.y);
        burst(state.cursor.x, state.cursor.y, settings.effects === "rich" ? 18 : 6, "#ff4ea3");
      }
      return;
    default:
      return;
  }
}

function updateRuleGestures(gesture) {
  const hold = state.ruleHold;
  const now = Date.now();
  const bound = !gesture
    ? null
    : state.ruleIds.find((id) => {
        const mapped = settings.gestureMap?.[id];
        return mapped?.startsWith("custom:") && gestureMatches(gesture, mapped, id);
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
  aircursor.runRule(target, { fromGesture: true });
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
  const m = state.motion;

  if (!settings.controlEnabled || !gesture) {
    wristPath.reset();
    for (const ratchet of scrollRatchets.values()) ratchet.reset();
    for (const detector of swipeDetectors.values()) detector.reset();
    m.tiltDeg = 0;
    m.wristSpeed = 0;
    m.scrollBlocked = settings.controlEnabled ? "noHand" : "controlOff";
    m.swipeBlocked = m.scrollBlocked;
    return;
  }

  // The wrist, not the fingertip: fingers move within a held pose, and the
  // question here is whether the hand as a whole is parked or travelling. The
  // ratchet needs that to refuse firing while the hand is being carried somewhere.
  const wrist = gesture.wrist;
  wristPath.push(wrist.x, wrist.y, gesture.palmWidth, now);
  const displacement = wristPath.displacement();
  m.wristSpeed = Number((displacement?.speed ?? 0).toFixed(2));

  // Each direction is its own gesture with its own ratchet. Sharing one would
  // make scrolling up latch scrolling down, since the latch exists to stop one
  // held pose from repeating — and these are two different held poses.
  m.scrollBlocked = null;
  let scrollMatched = false;
  for (const action of SCROLL_ACTIONS) {
    if (updateScrollRatchet(action, gesture, displacement, now) !== null) scrollMatched = true;
  }
  if (!scrollMatched) m.tiltDeg = 0;

  m.swipeBlocked = null;
  for (const action of SWIPE_ACTIONS) updateSwipe(action, displacement, gesture, now);
}

const SCROLL_ACTIONS = ["scrollUp", "scrollDown"];
const SWIPE_ACTIONS = ["spaceLeft", "spaceRight"];

// One detector per direction, created on demand. Sharing one across directions
// would let a leftward swipe's cooldown block a rightward one, which are two
// different gestures and have no reason to gate each other.
const scrollRatchets = new Map();
const swipeDetectors = new Map();

function swipeDetectorFor(action) {
  if (!swipeDetectors.has(action)) swipeDetectors.set(action, new SwipeDetector());
  return swipeDetectors.get(action);
}

// A sideways swipe is almost pure translation, and templates normalize translation
// away — measured: every frame of a swipe sits 0.0000 from the first, so recorded
// as a sequence it collapses to one keyframe and gets refused. The information is
// in the wrist path, so this stays a speed law. Only the direction changed: it is
// the action bound to the gesture, not the sign of dx.
function updateSwipe(action, displacement, gesture, now) {
  const active = tuning();
  const m = state.motion;
  const binding = settings.gestureMap?.[action];
  const entry = binding?.startsWith("custom:")
    ? settings.recordedGestures?.[binding.slice("custom:".length)]
    : null;

  if (!entry?.template || actionDisabled(action) || !gestureMatches(gesture, binding)) {
    swipeDetectorFor(action).reset();
    if (!m.swipeBlocked) {
      m.swipeBlocked = !entry?.template ? "notBound" : actionDisabled(action) ? "disabled" : "poseNotMatched";
    }
    return;
  }

  const recorded = entry.motion;
  // Floored above the parked-wrist limit: a threshold below it would let one
  // motion satisfy both the ratchet and the swipe, and that dead band is what
  // spares this from needing an arbitration order.
  const speedThreshold =
    recorded?.measure === "swipe"
      ? Math.max(recorded.trigger, RATCHET_MAX_SPEED + 0.2)
      : active.swipeSpeed;
  m.swipeSpeedThreshold = Number(speedThreshold.toFixed(2));

  const detector = swipeDetectorFor(action);
  // Direction is checked against the action rather than accepted from the
  // detector: swiping left must not switch right just because the detector saw
  // movement, and the user recorded these two separately for exactly that reason.
  const seen = detector.update({ displacement, speedThreshold, now });
  m.swipeBlocked = detector.blocked;
  m.swipeAction = action;
  if (seen && seen === ACTION_DIRECTION[action]) {
    sendKey(action);
    m.swipes += 1;
    m.lastSwipeAt = now;
    m.lastSwipeAction = action;
    burst(state.cursor.x, state.cursor.y, settings.effects === "rich" ? 28 : 10, "#49e5ff");
  } else if (seen) {
    // The gesture matched and the wrist was fast enough, but the hand went the
    // other way. Naming it stops this reading as "the swipe did nothing".
    m.swipeBlocked = "wrongDirection";
  }
}

function scrollRatchetFor(action) {
  if (!scrollRatchets.has(action)) scrollRatchets.set(action, new TiltRatchet());
  return scrollRatchets.get(action);
}

// Returns null when this direction's gesture is not the one being held, so the
// caller can tell "no scroll gesture active" from "active but blocked".
function updateScrollRatchet(action, gesture, displacement, now) {
  const active = tuning();
  const m = state.motion;
  const binding = settings.gestureMap?.[action];
  const entry = binding?.startsWith("custom:")
    ? settings.recordedGestures?.[binding.slice("custom:".length)]
    : null;

  if (!entry?.template || actionDisabled(action) || !gestureMatches(gesture, binding)) {
    scrollRatchetFor(action).reset();
    if (!m.scrollBlocked) {
      m.scrollBlocked = !entry?.template ? "notBound" : actionDisabled(action) ? "disabled" : "poseNotMatched";
    }
    return null;
  }

  // The trigger comes from the movement the user recorded, when there is one:
  // "how far do I tilt" is a question their own recording already answered, and
  // a global slider cannot answer it for two differently-recorded gestures.
  const recorded = entry.motion;
  const wanted = recorded?.measure === "tilt" ? recorded.trigger : active.scrollTriggerDeg;
  // Clamped against the rotation tolerance either way: past that limit the tilted
  // pose no longer matches its own template, so a trigger beyond it would make the
  // gesture disappear at exactly the angle it should fire at. Measured on a
  // hand-shaped pose, leftover rotation costs ~0.0196 distance per degree.
  const ceiling = maxUsableTiltDeg(active.rotationTolerance, active.matchThreshold);
  const trigger = Math.min(wanted, ceiling);
  m.clampedTrigger = trigger < wanted;
  m.triggerFromRecording = recorded?.measure === "tilt";
  m.triggerDeg = Number(trigger.toFixed(1));

  const ratchet = scrollRatchetFor(action);
  const fired = ratchet.update({
    liveAngle: gesture.poseTemplate?.angle,
    templateAngle: entry.template.angle,
    wristSpeed: displacement?.speed ?? 0,
    triggerDeg: trigger,
    now,
  });
  m.tiltDeg = Number(ratchet.deltaDeg.toFixed(1));
  m.scrollBlocked = ratchet.blocked;
  m.scrollAction = action;

  if (fired) {
    // The direction is the action, not the sign of the tilt. Inferring it from the
    // movement meant one recording had to serve both directions mirrored, which is
    // the opposite of "the gesture you recorded is the gesture that fires".
    sendScroll(ACTION_DIRECTION[action] * active.scrollNotches);
    m.scrollNotches += 1;
    m.lastScrollAt = now;
    m.lastScrollAction = action;
    burst(state.cursor.x, state.cursor.y, settings.effects === "rich" ? 20 : 8, "#8affc1");
  }
  return fired;
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

  const rightClickActive = gestureMatches(gesture, settings.gestureMap?.rightClick, "rightClick");
  const clickActive = gestureMatches(gesture, settings.gestureMap?.click, "click");
  const dragActive = gestureMatches(gesture, settings.gestureMap?.drag, "drag");

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

// Motion actions record in two stages, because a motion gesture is not a pose
// and asking someone to hold one still is a contradiction.
//
// Stage 1 captures the rest pose — that one really is static, and it has to be,
// since it is the position the hand returns to in order to re-arm the ratchet.
// Stage 2 records the movement itself: perform the action, and its measured
// extent becomes this gesture's trigger, so "how far do I have to tilt" is
// answered by what the user actually did instead of by guessing at a slider.
// Wording per law, for the actions that keep one. A dynamic recording without a
// law is an arbitrary movement, so it gets generic wording — there is nothing
// specific to say about a gesture the user invented.
const LAW_HINTS = {
  tilt: {
    restHint: "先摆好中位：手掌摆正、手腕别动。这是之后「手回到这儿才能再滚一次」的位置",
    moveHint: "现在把手掌往上抬到你觉得该滚一段的位置，然后停一下",
  },
  swipe: {
    restHint: "先把手停稳，摆好准备挥动的姿势",
    moveHint: "现在横向快速挥一下，像拨开东西那样",
  },
};
const SEQUENCE_HINTS = {
  restHint: "先摆好动作的起始姿势，保持住",
  moveHint: "现在把整个动作做出来，做完停一下",
};

function startRecording(action, wantedHands, kind, law) {
  const dynamic = kind === "dynamic";
  state.recording = {
    action,
    wantedHands,
    // The user's choice, not a lookup by action name. A law only applies to the
    // two actions that need a direction; everything else dynamic is a sequence.
    dynamic,
    law: dynamic ? law || null : null,
    hints: dynamic ? LAW_HINTS[law] || SEQUENCE_HINTS : null,
    // Dynamic recordings run rest -> move; static ones only ever have one stage.
    stage: "rest",
    phase: "countdown",
    startedAt: performance.now(),
    holdStartedAt: 0,
    samples: [],
    reference: null,
    restTemplate: null,
    // Movement stage: the extent seen so far, and how long it has been settling
    // back down, so the stage can end when the movement is clearly over rather
    // than after a fixed timer.
    peak: 0,
    peakAt: 0,
    movedAt: 0,
    // For law-less movements: when the extent last stopped changing, which is how
    // "the movement finished" is detected without demanding the hand come back.
    lastExtent: null,
    stillSince: 0,
    readyUntil: 0,
    trace: [],
    // Every frame of the movement, thinned to keyframes on save. This is what
    // makes the preview an animation instead of a number to imagine, and what
    // lets a movement with no law be matched as a sequence.
    frames: [],
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

function finishRecording(recording, motion, keyframes) {
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
  aircursor.recordingResult({ ok: true, action: recording.action, template, motion, keyframes });
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

  // The movement stage has its own loop: nothing about it is "hold still", so it
  // shares none of the drift/stability logic below.
  if (recording.stage === "move") {
    updateMotionRecording(recording, gesture, handCount, now);
    return;
  }

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
  // Too many hands is a tracker artifact, not a user error: recording a one-hand
  // gesture, MediaPipe intermittently reports a second hand at certain angles —
  // reported while recording the sideways swipes ("某些角度显示了两只手"). Treating
  // that as "wrong hand count" wiped the capture every time it blinked, so only
  // *too few* hands resets. Extra hands are ignored, and the template is built from
  // the hands actually wanted.
  const missingHands = recording.wantedHands && handCount < recording.wantedHands;
  if (!pose || missingHands) {
    recording.holdStartedAt = 0;
    recording.samples = [];
    recording.reference = null;
    aircursor.recordingProgress({
      action: recording.action,
      phase: "capture",
      stage: recording.stage,
      progress: 0,
      hint: !handCount
        ? "没有检测到手，把手放进摄像头画面"
        : missingHands
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
    // A static gesture is done. A dynamic one has only just captured the pose it
    // starts from and returns to; the action itself is still to come.
    if (recording.dynamic) {
      recording.stage = "move";
      recording.restTemplate = medianTemplate(recording.samples);
      recording.startedAt = now;
      // A beat before capture starts, because the previous version began the
      // instant the hold finished: the hand's travel from the rest pose to wherever
      // the movement begins was captured as part of the movement, and the user had
      // no moment to register that the instruction had changed. Real feedback:
      // "录制的动作，这个动作本身的时间太短了".
      recording.readyUntil = now + MOVE_READY_MS;
      recording.peak = 0;
      recording.peakAt = 0;
      recording.movedAt = 0;
      recording.lastExtent = null;
      recording.stillSince = 0;
      recording.trace = [];
      recording.frames = [];
      wristPath.reset();
      return;
    }
    finishRecording(recording);
    return;
  }

  aircursor.recordingProgress({
    action: recording.action,
    phase: "capture",
    stage: recording.stage,
    progress: Math.min(1, held / HOLD_MS),
    hint: recording.hints
      ? `${recording.hints.restHint} · 保持 ${((HOLD_MS - held) / 1000).toFixed(1)}s`
      : `保持不动 ${((HOLD_MS - held) / 1000).toFixed(1)}s`,
  });
}

// Stage 2: record the movement, and let its extent set this gesture's trigger.
//
// This ends when the movement is over, not on a timer — for the ratchet that
// means the tilt stopped growing and came back down, for the swipe it means the
// wrist parked again. A fixed window would either cut a slow movement short or
// make a fast one wait.
// How long the movement must have stopped changing before capture ends.
//
// 450ms was too short against a real hand: a deliberate gesture takes 300-500ms
// to perform, so a brief pause partway through — reaching the far point, changing
// direction — read as "finished". Reported as "这个动作本身的时间太短了", i.e. the
// recording ended before the user thought they were done. 900ms is longer than any
// pause inside one movement and still short enough not to feel stuck.
const MOTION_SETTLE_MS = 900;
// A beat between "your rest pose is captured" and "start moving", so the hand's
// travel to the movement's starting point is not recorded as part of it.
//
// Short, and it ends early once the hand actually moves: 1200ms of forced waiting
// made recording feel worse than the problem it solved ("现在的录制变得更加困难
// 了"). The point is only to not charge the approach to the movement, and a user
// who is already moving has clearly finished approaching.
const MOVE_READY_MS = 400;
// Below this there was no movement worth calling a gesture, so recording says so
// rather than saving a trigger of ~0 that would fire on tracking noise.
const MIN_TILT_DEG = 6;
const MIN_SWIPE_SPEED = 1.4;

// How far the pose must travel from the rest pose for a law-less movement to
// count as having moved at all. In match-threshold units, like every other shape
// distance, so it scales with the tolerance.
const MIN_SHAPE_TRAVEL_RATIO = 1.1;

function updateMotionRecording(recording, gesture, handCount, now) {
  const law = recording.law;

  // The ready beat: say what is about to be asked for, and do not start measuring
  // until it elapses. The timeout clock is reset with it so the pause does not eat
  // into the capture window.
  if (recording.readyUntil && now < recording.readyUntil) {
    // Ends early if the hand has already left the rest pose — waiting out a timer
    // while the user is mid-gesture is exactly what made this feel harder.
    const pose = gesture?.poseTemplate;
    const moving =
      pose && recording.restTemplate
        ? templateDistance(pose, recording.restTemplate, 0) > MATCH_THRESHOLD * 0.5
        : false;
    if (!moving) {
      aircursor.recordingProgress({
        action: recording.action,
        phase: "capture",
        stage: "ready",
        progress: 0,
        hint: `${recording.hints.moveHint}（可以直接开始）`,
      });
      return;
    }
  }
  if (recording.readyUntil) {
    recording.readyUntil = 0;
    recording.startedAt = now;
  }

  if (now - recording.startedAt > CAPTURE_TIMEOUT_MS) {
    // If a real movement was seen, save it instead of throwing the whole session
    // away: the rest pose took 4 seconds to capture and is perfectly good, and
    // making the user redo all of it because the *end* was ambiguous is what makes
    // recording feel punishing. Only a session with no movement at all fails.
    if (recording.peak > 0 && recording.movedAt) {
      saveMotionRecording(recording, law, recording.lastFloor ?? 0);
      return;
    }
    const what = law === "tilt" ? "抬压" : law === "swipe" ? "挥动" : "";
    failRecording(recording, `超时没有捕捉到${what}动作，请重新录制`);
    return;
  }

  const pose = gesture?.poseTemplate;
  // Only too few hands pauses capture, for the same reason as the rest stage: a
  // spurious extra hand is a tracker artifact and pausing on it made a moving hand
  // impossible to record.
  const missingHands = recording.wantedHands && handCount < recording.wantedHands;
  if (!pose || missingHands) {
    // Losing the hand mid-movement does not throw the recording away: what has
    // been captured is still the best evidence of what the user did, and at a
    // 40-60% tracking rate a movement is guaranteed to have gaps.
    aircursor.recordingProgress({
      action: recording.action,
      phase: "capture",
      stage: "move",
      progress: 0,
      hint: !handCount ? "手不见了，回到画面继续这个动作" : `需要 ${recording.wantedHands} 只手`,
      measured: recording.peak,
    });
    return;
  }

  // Every frame of the movement is kept, whatever drives the gesture: this is the
  // recording the preview animates, and it is also what a law-less gesture is
  // matched against. Thinning to keyframes happens once, on save.
  recording.frames.push({ template: pose, at: now });
  if (recording.frames.length > MAX_SAMPLES) recording.frames.shift();

  let extent = 0;
  let floor = 0;
  if (law === "tilt") {
    const rest = recording.restTemplate?.angle;
    const live = pose.angle;
    if (!Number.isFinite(rest) || !Number.isFinite(live)) {
      // No axis on either side: this pose can never drive a tilt gesture. Said
      // here rather than at save time so the user is not asked to perform a
      // movement that cannot possibly be measured.
      failRecording(recording, "这个姿势测不出方向轴（双手镜像会互相抵消），换一个单手姿势");
      return;
    }
    extent = Math.abs(toDegrees(wrapAngle(live - rest)));
    floor = MIN_TILT_DEG;
  } else if (law === "swipe") {
    wristPath.push(gesture.wrist.x, gesture.wrist.y, gesture.palmWidth, now);
    extent = wristPath.displacement()?.speed ?? 0;
    floor = MIN_SWIPE_SPEED;
  } else {
    // No law: "how far along" is how far the shape has travelled from the rest
    // pose, which is also what the sequence matcher will step through.
    extent = templateDistance(pose, recording.restTemplate, 0);
    if (!Number.isFinite(extent)) extent = 0;
    floor = MATCH_THRESHOLD * MIN_SHAPE_TRAVEL_RATIO;
  }

  recording.lastFloor = floor;
  recording.trace.push(Number(extent.toFixed(2)));
  if (recording.trace.length > MAX_SAMPLES) recording.trace.shift();

  if (extent > recording.peak) {
    recording.peak = extent;
    recording.peakAt = now;
  }
  if (extent > floor) recording.movedAt = now;

  // Done when a real movement has happened and has since settled: for the tilt
  // the hand coming down, for the swipe the wrist stopping, for a sequence the
  // shape returning near where it started. A gesture that ends somewhere else
  // entirely still completes — the timeout is the backstop.
  // "Settled" has to mean the movement stopped, not that the hand came back.
  //
  // The two laws genuinely do return: a tilt comes down, a wrist parks. But a
  // law-less movement usually ends somewhere else entirely — a hand opening out, a
  // flick to one side — and requiring `extent < floor` demanded it return near the
  // starting pose. Combined with the round-trip guard at save time, which refuses
  // exactly those returning movements, the two conditions left no shape of
  // movement that could satisfy both: one-way gestures never finished recording
  // and returning ones were rejected once they did.
  //
  // So for a sequence, stopping is measured against recent movement rather than
  // against the origin: the extent has held roughly still for the settle window.
  if (law) {
    recording.lastExtent = extent;
    const returned = recording.movedAt && extent < floor && now - recording.movedAt > MOTION_SETTLE_MS;
    if (recording.peak > floor && returned) {
      saveMotionRecording(recording, law, floor);
      return;
    }
  } else {
    // Track where the extent was when it last changed appreciably. A hand held
    // anywhere — origin, destination, mid-air — stops updating this and the window
    // elapses.
    const drift = Math.abs(extent - (recording.lastExtent ?? extent));
    if (drift > floor * 0.15) recording.stillSince = 0;
    recording.lastExtent = extent;
    if (!recording.stillSince) recording.stillSince = now;
    const stopped = recording.movedAt && now - recording.stillSince > MOTION_SETTLE_MS;
    if (recording.peak > floor && stopped) {
      saveMotionRecording(recording, law, floor);
      return;
    }
  }

  aircursor.recordingProgress({
    action: recording.action,
    phase: "capture",
    stage: "move",
    // Not a countdown: this bar shows how far the movement has got, which is the
    // thing being measured. Filling it is not a goal, it is a readout.
    progress: Math.min(1, extent / Math.max(floor * 3, recording.peak || floor * 3)),
    hint: recording.movedAt
      ? extent < floor
        ? "很好，保持住让它记下来"
        : `记录中：${formatExtent(extent, law)}`
      : recording.hints.moveHint,
    measured: Number(recording.peak.toFixed(2)),
    unit: extentUnit(law),
    frames: recording.frames.length,
  });
}

function extentUnit(law) {
  if (law === "tilt") return "°";
  if (law === "swipe") return " 掌宽/秒";
  return "";
}

function formatExtent(extent, law) {
  if (law === "tilt") return `${extent.toFixed(0)}°`;
  if (law === "swipe") return `${extent.toFixed(1)} 掌宽/秒`;
  return `幅度 ${extent.toFixed(2)}`;
}

function saveMotionRecording(recording, law, floor) {
  const keyframes = buildKeyframes(recording.frames, MATCH_THRESHOLD, templateDistance);
  // A law-driven gesture is still usable with one keyframe: the law decides when
  // it fires. A sequence is not — a single frame is just a static pose, and
  // saving it would produce a gesture that fires without any movement at all.
  if (!law && keyframes.length < MIN_KEYFRAMES) {
    failRecording(recording, "这个动作幅度太小，看起来更像一个静态姿势。换成「静态」录制，或者把动作做大一些");
    return;
  }
  // A movement that ends where it began is genuinely harder to recognise — its
  // final pose is reachable without having moved — but refusing it outright was
  // the wrong call. Most people finish a gesture by putting their hand back, so
  // this rejected the natural way to record, and combined with MIN_KEYFRAMES it
  // left a very narrow window where anything could be saved at all. Being usable
  // and occasionally over-eager beats being correct and unrecordable.
  //
  // So it saves, and the risk is handled where it actually bites: the matcher
  // requires passing the midpoint between keyframes, and a returning sequence is
  // flagged so the panel can say why it might misfire. `roundTrip` rides along on
  // the recording rather than being recomputed, since the templates are already
  // here.
  const span = sequenceSpan(keyframes, MATCH_THRESHOLD, templateDistance);
  const roundTrip = !law && span < MIN_SEQUENCE_SPAN;
  finishRecording(
    recording,
    {
      // null for a sequence: there is no single number that describes an
      // arbitrary movement, and inventing one would be a number nobody can act on.
      measure: law,
      // Fire a little before the extent the user demonstrated, so reproducing the
      // same movement reliably crosses it rather than landing exactly on the edge
      // — the same reason a hold has a grace window.
      trigger: law ? Number((recording.peak * 0.75).toFixed(2)) : null,
      peak: Number(recording.peak.toFixed(2)),
      floor: Number(floor.toFixed(2)),
      // Recorded so the panel can warn instead of the recording being refused.
      span: Number(span.toFixed(2)),
      roundTrip,
      durationMs: keyframes.length ? keyframes[keyframes.length - 1].offsetMs : 0,
    },
    keyframes,
  );
}

// Raw landmark capture: five seconds of exactly what MediaPipe reported.
//
// Every test on both sides of this project — mine and the wallpaper module's — runs
// on synthetic hands, and synthetic hands are missing the one thing that decides
// whether a gesture works: real tracking noise. Not its magnitude (that much is
// measurable from a report) but its *time correlation* — consecutive frames drift
// together, and a re-detection after a dropout jumps. Independent per-frame noise,
// which is what a fixture produces, averages itself out; correlated noise does not.
//
// That difference is not theoretical. It decides whether the sequence matcher's
// midpoint rule holds on a real hand, and neither of us can answer it: I cannot
// build a credible correlated-noise fixture without knowing the structure, and
// guessing a correlation parameter is the same mistake as a fixture that varies a
// dimension the code is insensitive to.
//
// So this records the real thing. One file, replayable offline, no camera needed
// afterwards — which turns every existing probe from "the mechanism is sound" into
// "a real hand can do this".
const CAPTURE_MS = 5000;

function startLandmarkCapture() {
  state.capture = { startedAt: performance.now(), frames: [], tuning: tuning() };
  aircursor.status({ rule: `正在录制原始关键点 ${CAPTURE_MS / 1000} 秒…` });
}

function captureLandmarks(hands, handedness, now) {
  const capture = state.capture;
  if (!capture) return;
  // Stored verbatim, including the frames where nothing was detected: a gap is data.
  // Dropping empty frames would erase exactly the dropout structure this exists to
  // record, and the replay would then be of a hand that was never lost.
  capture.frames.push({
    t: Math.round(now - capture.startedAt),
    hands: hands.map((hand) => hand.map((p) => [round4(p.x), round4(p.y), round4(p.z || 0)])),
    handedness: handedness.map((h) => h?.label || ""),
  });
  if (now - capture.startedAt < CAPTURE_MS) return;

  state.capture = null;
  aircursor.saveCapture({
    v: 1,
    capturedAt: new Date().toISOString(),
    // The tuning in force matters: a replay judged against different constants than
    // the ones that produced it is a different experiment.
    tuning: capture.tuning,
    durationMs: CAPTURE_MS,
    frames: capture.frames,
  });
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
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
  // While recording, build the pose from exactly the number of hands being
  // recorded. Tolerating a spurious extra hand is only useful if it does not then
  // corrupt the template: a one-hand recording that momentarily saw two would
  // otherwise capture a two-hand shape, which can never match afterwards.
  const wanted = state.recording?.wantedHands;
  const posed = wanted && hands.length > wanted ? hands.slice(0, wanted) : hands;
  const gesture = posed[0] ? detectGesture(posed[0], posed) : null;
  // Without this the resolver's sticky winner survives the hand leaving frame,
  // and hysteresis would then bias the next pose toward whatever was held last.
  if (!gesture) resolver.reset();
  state.gesture = gesture;

  updateRecording(gesture, posed.length);
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
    // Sequences last: a completed movement is a one-shot action, and running it
    // after the pointer means it cannot fight a drag or click that is mid-flight.
    const completed = resolveSequenceGesture(gesture, now);
    if (completed) performSequenceAction(completed);
    recordSequenceDiagnostics();
  } else {
    // Recording must not fire the action being recorded, and the motion state
    // must not carry the recording session's hand movement into the next frame.
    wristPath.reset();
    for (const ratchet of scrollRatchets.values()) ratchet.reset();
    for (const detector of swipeDetectors.values()) detector.reset();
    for (const matcher of sequenceMatchers.values()) matcher.reset();
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
    metrics.markHands(state.hands.length, performance.now());
    metrics.markPipeline(state.frameCapturedAt, state.resultAt);
    captureLandmarks(state.hands, state.handedness, state.resultAt);
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
  // A fourth path that bypasses the gesture matcher entirely, and it can exit
  // control mode or launch an app — both of which would derail a capture in
  // progress. Recording is a moment the user is deliberately moving their hands
  // and may well be talking; nothing should fire from either.
  if (state.recording) {
    aircursor.status({ rule: `录制中，已忽略${source}：${rawText.trim()}` });
    return;
  }
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

  // Voice deliberately does not pass fromGesture: the switch turns off the
  // *gesture* binding, and silencing voice with it would remove the fallback the
  // user needs while a gesture is disabled.
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
aircursor.onStartCapture?.(() => startLandmarkCapture());
aircursor.onResetMetrics(() => {
  metrics.reset();
  pointerFilter.reset();
});
aircursor.onRecording((request) => {
  if (!request || request.type === "stop") {
    stopRecording();
    return;
  }
  startRecording(request.action, request.hands, request.kind, request.law);
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
