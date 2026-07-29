// 摄像头 → 手势事件，以及录制。跑在隐藏窗口里，只发不画。
//
// 判定在 input.js，录制在 recorder.js，这里只负责：接 MediaPipe 的结果、按当前模式
// 分流（正常 or 录制）、发事件、报状态。
const { GestureInput, toPixels, mirror } = window.GestureWallInput;
const { Recorder, conflictingAction } = window.GestureWallRecorder;
const T = window.GestureWallTemplates;
const Pose = window.AirCursorPose;

// ~30/s。渲染侧自己有平滑，发更快买不到手感。
const SEND_INTERVAL_MS = 33;

let hands = null;
let camera = null;
let lastSend = 0;
let input = null;
let recorder = null;
let config = null;

function status(text, extra) {
  window.gw.sendSensorStatus({ text, ...(extra || {}) });
}

function tuningOf() {
  return (config && config.gestureTuning) || {};
}

// 把关键点发给壁纸去画骨架。
//
// 只发归一化的 x/y，不发 z：画的是 2D 骨架，而 z 是最噪的一轴，带上它只是白占带宽。
// 录制期间也发 —— 录制时最需要看见手在哪，那是"录制反馈很差"的核心。
function sendHands(list) {
  if (!config || !config.showHands) return;
  window.gw.sendHands({
    // 镜像后发：壁纸上看到的手要和自己的手同向，否则抬右手屏幕上左边亮，人会以为坏了。
    hands: list.map((lm) => lm.map((p) => ({ x: 1 - p.x, y: p.y }))),
    recording: !!(recorder && recorder.active),
    at: Date.now(),
  });
}

function onResults(results) {
  const now = performance.now();
  const list = results.multiHandLandmarks || [];

  // 录制中：整帧交给 recorder，不发任何手势事件 —— 否则做录制动作时会顺带触发
  // 已绑的动作，那正是 AirCursor 真机踩过的"录制被已有手势打断"。
  if (recorder && recorder.active) {
    // 骨架照发：录制时看不见手在哪，反馈就只剩文字。
    if (now - lastSend >= SEND_INTERVAL_MS) { lastSend = now; sendHands(list); }
    tickRecording(list, now);
    return;
  }

  if (now - lastSend < SEND_INTERVAL_MS) return;
  lastSend = now;

  sendHands(list);
  const { events, status: text } = input.update(list, now, tuningOf());
  for (const event of events) window.gw.sendGesture({ v: 1, at: Date.now(), ...event });
  status(text);
}

// ---------------------------------------------------------------------------
// 录制
// ---------------------------------------------------------------------------
let recordingAction = null;

function tickRecording(list, now) {
  // 关键点升到像素空间：recorder 下游是 AirCursor 的模块，那些常数按像素标定
  // （palmWidthOf 有 60px 下限）。和 input.js 同一个理由。
  const mirrored = list.map((lm) => toPixels(mirror(lm)));
  const pose = mirrored.length ? Pose.buildPoseTemplate(mirrored) : null;
  const result = recorder.update(pose, mirrored.length, now);
  if (!result) return;

  if (result.error) {
    window.gw.sendRecordingResult({ ok: false, action: recordingAction, error: result.error });
    recordingAction = null;
    return;
  }

  if (result.done) {
    finishRecording(result.result);
    return;
  }

  window.gw.sendRecordingProgress({
    action: recordingAction,
    phase: result.phase,
    progress: result.progress || 0,
    countdown: result.countdown,
    hint: result.hint,
  });
}

function finishRecording(entry) {
  const action = recordingAction;
  recordingAction = null;

  // 冲突检测：两个姿势太近不是两个手势，实时姿势会去离它更近的那个，于是用户得到的
  // 是另一个动作，而这个看起来就是坏的。在保存时拒绝 —— 那时用户还记得自己刚做了什么。
  const conflict = conflictingAction(
    action,
    entry.template,
    config && config.recorded,
    matchThreshold(),
    rotationTolerance(),
  );
  if (conflict) {
    window.gw.sendRecordingResult({
      ok: false,
      action,
      conflictWith: conflict.action,
      distance: conflict.distance,
    });
    return;
  }

  window.gw.sendRecordingResult({
    ok: true,
    action,
    entry: {
      hands: entry.hands,
      template: entry.template,
      dynamic: entry.dynamic,
      law: entry.law,
      // 只存关键帧数量给 UI 显示，完整关键帧也一起存 —— 匹配时要用。
      keyframes: entry.keyframes ? entry.keyframes.length : 0,
      keyframeData: entry.keyframes || null,
      trigger: entry.trigger || 0,
    },
  });
}

function matchThreshold() {
  return (config && config.gestureTuning && config.gestureTuning.matchThreshold) || 0.28;
}

function rotationTolerance() {
  const deg = (config && config.gestureTuning && config.gestureTuning.rotationTolerance) || 20;
  return (deg * Math.PI) / 180;
}

window.gw.onStartRecording(({ action }) => {
  const meta = T.ACTIONS[action];
  if (!meta) {
    window.gw.sendRecordingResult({ ok: false, action, error: '未知动作' });
    return;
  }
  recordingAction = action;
  recorder = new Recorder({
    matchThreshold: matchThreshold(),
    rotationTolerance: rotationTolerance(),
  });

  // 静态/动态和手数完全取用户在面板里选的，不按动作名查表，**有律的也一样**。
  //
  // 第一版给有律的动作强制静态（连下拉都不给），理由是"方向由律决定"。但用户要的是
  // 功能一致：选了动态就走关键帧序列，那时律让位。锁死选项是替用户做决定。
  const options = (config && config.recordOptions && config.recordOptions[action]) || {};
  const dynamic = options.kind === 'dynamic';
  recorder.start(action, {
    hands: options.hands || 1,
    dynamic,
    law: meta.law,
    now: performance.now(),
  });
  status(`开始录制「${meta.label}」（${dynamic ? '动态' : '静态'} · ${options.hands || 1} 只手）`);
});

window.gw.onCancelRecording(() => {
  if (recorder) recorder.cancel();
  recordingAction = null;
  status('录制已取消');
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
async function start() {
  status('正在加载手势模型');
  if (!window.Hands || !window.Camera) {
    status('⚠️ MediaPipe 本地脚本未加载');
    return;
  }

  config = await window.gw.getConfig();
  input = new GestureInput(tuningOf());

  window.gw.onConfig((next) => {
    config = next;
    if (input) input.setTuning(tuningOf());
  });

  hands = new Hands({ locateFile: (file) => `vendor/mediapipe/hands/${file}` });
  hands.setOptions({
    maxNumHands: 2,
    // 0 而不是 1：这里只要掌心位置、掌宽和一个捏合判定，不需要精确指尖，而 0 大约
    // 省一半每帧开销。
    modelComplexity: 0,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  hands.onResults(onResults);

  const video = document.getElementById('cam');
  status('正在请求摄像头权限');
  camera = new Camera(video, {
    onFrame: async () => { if (hands) await hands.send({ image: video }); },
    width: 640,
    height: 480,
  });
  try {
    await camera.start();
    status('摄像头已开启');
  } catch (error) {
    // 点名原因：「没给权限」和「摄像头被占用」需要完全不同的处理，把其中一个报成
    // 另一个会浪费真实时间。
    status(`⚠️ 摄像头启动失败：${error.name || error.message || error}`);
  }
}

start();
