// 摄像头 → 手势事件，以及录制。跑在隐藏窗口里，只发不画。
//
// 判定在 input.js，录制在 recorder.js，这里只负责：接 MediaPipe 的结果、按当前模式
// 分流（正常 or 录制）、发事件、报状态。
//
// ⚠️ 包在 IIFE 里,不是风格问题。这个文件和 sensor.js / overlay-window.js 现在跑在
// **同一个窗口**(摄像头搬进骨架层之后),两边都在顶层 `const T = ...` ⟹
// "Identifier 'T' has already been declared" ⟹ **整层脚本全部停止执行**,
// 而症状只是"摄像头不启动",看不出和重名有任何关系。
//
// 同窗口的脚本之间没有作用域隔离,所以每个都得自己包。
(function () {
const { GestureInput, toPixels, mirror } = window.GestureWallInput;
const { Recorder, conflictingAction } = window.GestureWallRecorder;
const T = window.GestureWallTemplates;
const Pose = window.AirCursorPose;

// ~30/s。渲染侧自己有平滑，发更快买不到手感。
// 骨架发送间隔:从 config 读,不再写死 —— 写死的话真机上想调只能改代码重启。
function sendIntervalMs() {
  return (config && config.gestureTuning && config.gestureTuning.handIntervalMs) || 33;
}
// 推理闸门的状态。没有它们时真机只有 14fps(串行堆积),见 onFrame。
let inferenceBusy = false;
let lastInferenceAt = 0;
// 匹配诊断的发送间隔。给人读的数字不需要 30/s —— 那样面板上只会看到一片闪烁。
const PROBE_INTERVAL_MS = 250;
let lastProbeAt = 0;

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
  // 录制时无条件发：主进程那边（syncOverlayVisibility）是按 `showHands || recordingAction`
  // 开骨架窗口的，如果这里只看 showHands，关掉骨架再去录制就会开出一个空窗口 ——
  // 症状是"录制时什么都看不见"，和骨架坏了一模一样。两边的判据必须一致。
  if (!config) return;
  if (!config.showHands && !(recorder && recorder.active)) return;
  const payload = {
    // 镜像后发：壁纸上看到的手要和自己的手同向，否则抬右手屏幕上左边亮，人会以为坏了。
    hands: list.map((lm) => lm.map((p) => ({ x: 1 - p.x, y: p.y }))),
    recording: !!(recorder && recorder.active),
    at: Date.now(),
  };
  // 摄像头和骨架现在在同一个窗口里,所以直接喂 —— 走 IPC 会绕出进程再绕回来,白付一次
  // 序列化和一次往返,而这是 30/s 的消息。
  if (window.__gwOverlay) window.__gwOverlay.ingest(payload);
  else window.gw.sendHands(payload);
}

// 录 5 秒原始关键点。
//
// 从 AirCursor 搬过来的,而它存在的理由对两边都成立:所有用例都是合成手,而合成手缺的
// 不是噪声的**大小**(那从报告里能算)而是它的**时间相关结构** —— 相邻帧一起漂、丢跟踪
// 后重新检出会跳。独立同分布的噪声(夹具产的那种)会自己平均掉,相关噪声不会。
//
// 这个差异决定判定层在真手上成不成立,而两边都答不了:没有真机 landmark 就造不出可信的
// 相关噪声夹具,硬猜一个相关性参数就是"夹具落在不敏感维度上"那个坑。
const CAPTURE_MS = 5000;
let capture = null;

if (window.gw.onStartCapture) {
  window.gw.onStartCapture(() => {
    capture = { startedAt: performance.now(), frames: [] };
    status('正在录制原始关键点 5 秒…');
  });
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

function captureFrame(list, now) {
  if (!capture) return;
  // 空帧也存:丢跟踪本身就是数据,滤掉它等于把要记录的结构擦掉,回放出来的会是一只
  // 从没丢过的手。
  capture.frames.push({
    t: Math.round(now - capture.startedAt),
    hands: list.map((hand) => hand.map((p) => [round4(p.x), round4(p.y), round4(p.z || 0)])),
  });
  if (now - capture.startedAt < CAPTURE_MS) return;
  // ⚠️ tuning 必须一起存,而且这不是"顺手带上"。
  //
  // 回放探针的每个门限都从这个字段读。缺了不会崩 —— 会**静默回落到默认常数**,然后报出
  // 一组看起来精确的数字。所以在面板上调过灵敏度之后录的那次,会被拿默认值判定:实测同
  // 一段数据,带 tuning 报 3.1/30/0.31,不带报 2.6/22/0.28。
  //
  // 而这个文件存在的全部目的就是把那些常数从猜变成量。判据错了,整件事反过来 ——
  // 比崩掉糟,因为崩掉你会知道。
  const payload = {
    v: 1,
    capturedAt: new Date().toISOString(),
    durationMs: CAPTURE_MS,
    // 空对象和缺字段一样会让探针回落默认值,所以显式记下"配置当时到没到" ——
    // 一份 tuningReady:false 的 capture 该被丢掉重录,而不是拿去标定。
    tuning: tuningOf(),
    tuningReady: !!(config && config.gestureTuning),
    frames: capture.frames,
  };
  capture = null;
  window.gw.saveCapture(payload);
}

function onResults(results) {
  const now = performance.now();
  const list = results.multiHandLandmarks || [];

  // 关键点录制在最前面,而且**在录制守卫之前** —— 它记的是原始输入,和手势判定无关,
  // 所以做录制动作那段时间的数据同样有价值(那正是真手在做动作的样子)。
  captureFrame(list, now);

  // 录制中：整帧交给 recorder，不发任何手势事件 —— 否则做录制动作时会顺带触发
  // 已绑的动作，那正是 AirCursor 真机踩过的"录制被已有手势打断"。
  if (recorder && recorder.active) {
    // 骨架照发：录制时看不见手在哪，反馈就只剩文字。
    if (now - lastSend >= sendIntervalMs()) { lastSend = now; sendHands(list); }
    tickRecording(list, now);
    return;
  }

  if (now - lastSend < sendIntervalMs()) return;
  lastSend = now;

  sendHands(list);
  // ⚠️ 传**整个 config**，不是 tuningOf()。
  //
  // 这是「录了手势没反应」的根因：`input.update` 的第三个参数被喂了
  // `config.gestureTuning`，而 `updateRecorded` 读的是 `config.recorded` —— 那个字段在
  // 配置的**顶层**，是 gestureTuning 的兄弟。于是录过的手势永远读不到，一个都匹配不上。
  //
  // 它没有早点爆出来，是因为**一半的字段恰好能读到**：input 读 5 个字段，其中
  // swipeSpeed / tiltTriggerDeg 真在 gestureTuning 里，所以挥动和倾斜一直是好的，只有
  // "用户录的手势"这一类静默失效。全错会立刻被发现，半错才能藏住。
  //
  // 构造函数和 setTuning 仍然可以吃整个 config —— filterTuning 只挑滤波那 5 个字段。
  const { events, status: text } = input.update(list, now, config || {});
  for (const event of events) window.gw.sendGesture({ v: 1, at: Date.now(), ...event });

  // 匹配诊断：每个录过的动作，这一帧离触发有多远。
  //
  // 走已有的 sensor-status 通道，不新开 IPC。**限速到 ~4/s**：这是给人读的数字，而
  // 30/s 会让面板上的数字糊成一片，还白付 26 次序列化。
  const probe = input.lastProbe ? input.lastProbe() : null;
  if (probe && now - lastProbeAt >= PROBE_INTERVAL_MS) {
    lastProbeAt = now;
    status(text, { probe });
  } else {
    status(text);
  }
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

  // 透传 recorder 报的全部字段，只补上 action。
  //
  // ⚠️ 原来是白名单（一个个列字段），于是 recorder 新加的 extent/extentNeeded 被静默
  // 丢掉 —— 加一个诊断字段要改两个文件，而漏掉这一处不会报错，只会让面板永远显示不出
  // 那个数字。这个形状本身就是坑：**转发层做白名单，等于给每个新字段埋一个静默失效**。
  //
  // recorder 的返回值全部是给 UI 看的（phase/progress/hint/extent/…），没有敏感字段要挡，
  // 所以整体透传是对的。
  window.gw.sendRecordingProgress({ ...result, action: recordingAction, progress: result.progress || 0 });
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
    // 说清是哪个文件缺,以及怎么修 —— "未加载"三个字治不了任何问题。全新 clone 之后
    // 最常见的原因是 vendor 步骤没跑(根目录的 postinstall 一度漏了这一步)。
    const which = window.__mpMissing ? `(${window.__mpMissing}.js 404)` : '';
    status(`⚠️ MediaPipe 没加载 ${which} —— 在仓库根目录跑一次 npm run vendor,然后重启`);
    return;
  }

  config = await window.gw.getConfig();
  input = new GestureInput(config || {});

  window.gw.onConfig((next) => {
    config = next;
    if (input) input.setTuning(config || {});
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
    // ⚠️ 两道闸,少任何一道帧率会掉一半以上。
    //
    // 实测:没有闸门时真机 14fps,而同一台机器上 AirCursor 3.x 跑 30fps、推理只花 12ms。
    // 推理不是瓶颈 —— 瓶颈是**串行堆积**:每帧无条件 await 上一次 send,于是实际帧率变成
    // 1/(推理 + 摄像头间隔) 而不是取两者较大值。
    //
    //   busy 闸  上一帧还在推理就直接丢掉这一帧。摄像头不会等我们,丢一帧的代价远小于
    //            让整条链排队 —— 而排队会一路累积成"不灵敏"。
    //   间隔闸   两次推理至少隔 inferenceIntervalMs。省下的 CPU 留给绘制。
    onFrame: async () => {
      if (!hands) return;
      const now = performance.now();
      const minInterval = (config && config.gestureTuning && config.gestureTuning.inferenceIntervalMs) || 20;
      if (inferenceBusy || now - lastInferenceAt < minInterval) return;
      inferenceBusy = true;
      lastInferenceAt = now;
      try {
        await hands.send({ image: video });
      } finally {
        // finally,不是 then:推理抛异常时不解锁会让手势永久停住,而症状是"突然就不动了"。
        inferenceBusy = false;
      }
    },
    width: 640,
    height: 480,
  });
  try {
    await camera.start();
    // ready:true 是显式信号,不让主进程去匹配这句中文 —— 改一个字就会让"摄像头到底
    // 开了没有"的判断静默失效,而那个判断决定 start-capture 放不放行。
    status('摄像头已开启', { ready: true });
  } catch (error) {
    // 点名原因：「没给权限」和「摄像头被占用」需要完全不同的处理，把其中一个报成
    // 另一个会浪费真实时间。
    status(`⚠️ 摄像头启动失败：${error.name || error.message || error}`, { ready: false, denied: /NotAllowed|Permission/i.test(String(error.name || error)) });
  }
}

start();
})();
