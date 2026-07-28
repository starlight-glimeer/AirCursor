// 摄像头 → 手势事件。跑在隐藏窗口里，只发不画。
//
// 判定全部在 input.js（它委托给 AirCursor 的 pose/motion/tracking），这里只负责：
// 接 MediaPipe 的结果、节流、发事件、把"现在什么情况"报给设置窗口。
const { GestureInput } = window.GestureWallInput;

// ~30/s。渲染侧自己有平滑，发更快买不到手感。
const SEND_INTERVAL_MS = 33;

let hands = null;
let camera = null;
let lastSend = 0;
let input = null;
let tuning = null;

function status(text, extra) {
  window.gw.sendSensorStatus({ text, ...(extra || {}) });
}

function onResults(results) {
  const now = performance.now();
  if (now - lastSend < SEND_INTERVAL_MS) return;
  lastSend = now;

  const { events, status: text } = input.update(results.multiHandLandmarks, now, tuning);
  for (const event of events) window.gw.sendGesture({ v: 1, at: Date.now(), ...event });
  status(text);
}

async function start() {
  status('正在加载手势模型');
  if (!window.Hands || !window.Camera) {
    status('⚠️ MediaPipe 本地脚本未加载');
    return;
  }

  const config = await window.gw.getConfig();
  tuning = config && config.gestureTuning;
  input = new GestureInput(tuning);

  window.gw.onConfig((next) => {
    tuning = next && next.gestureTuning;
    if (input) input.setTuning(tuning);
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
