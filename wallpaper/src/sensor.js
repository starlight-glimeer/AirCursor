// 摄像头 → 手势事件。跑在隐藏窗口里，只发不画。
//
// 判定逻辑全在 gestures.js（无 DOM、可跑用例），这里只负责：接 MediaPipe 的结果、
// 节流、把事件发出去、以及把"现在什么情况"报给设置窗口。
const G = window.GestureWallGestures;

// ~30/s。渲染侧自己有平滑，发更快买不到手感。
const SEND_INTERVAL_MS = 33;

let hands = null;
let camera = null;
let lastSend = 0;
const path = new G.WristPath();
const flick = new G.FlickDetector();

function status(text, extra) {
  window.gw.sendSensorStatus({ text, ...(extra || {}) });
}

function send(payload) {
  window.gw.sendGesture({ v: 1, at: Date.now(), ...payload });
}

function onResults(results) {
  const list = results.multiHandLandmarks || [];
  const now = performance.now();

  if (!list.length) {
    status('未检测到手');
    path.reset();
    return;
  }

  if (now - lastSend < SEND_INTERVAL_MS) return;
  lastSend = now;

  const mirrored = list.map(G.mirror);

  // 双手捏合优先：它是主控制，而且做这个手势时单手逻辑没有意义。
  const zoom = G.twoHandZoom(mirrored);
  if (zoom) {
    send({ action: 'zoom', value: zoom.value });
    status(`双手捏合 · 间距 ${zoom.span.toFixed(2)} 掌宽 → ${(zoom.value * 100).toFixed(0)}%`);
    path.reset();
    return;
  }

  const lm = mirrored[0];
  const palm = G.palmCenter(lm);
  send({ action: 'pointer', x: palm.x, y: palm.y });

  path.push(palm.x, palm.y, G.palmWidth(lm), now);
  const direction = flick.update(path.displacement(), now);
  if (direction) {
    path.reset();
    send({ action: direction === 'right' ? 'swipeRight' : 'swipeLeft' });
    status(`挥动 ${direction === 'right' ? '→ 右转' : '← 左转'}`);
    return;
  }

  const hint = mirrored.length >= 2 ? '双手在场（捏合拇指+食指开始缩放）' : '单手跟随';
  status(`${hint} · ${(palm.x * 100).toFixed(0)}%, ${(palm.y * 100).toFixed(0)}%`
    + (flick.blocked && flick.blocked !== 'noPath' ? ` · 挥动:${flick.blocked}` : ''));
}

async function start() {
  status('正在加载手势模型');
  if (!window.Hands || !window.Camera) {
    status('⚠️ MediaPipe 本地脚本未加载');
    return;
  }
  hands = new Hands({ locateFile: (file) => `vendor/mediapipe/hands/${file}` });
  hands.setOptions({
    maxNumHands: 2,
    // 0 而不是 1：这里只要掌心位置和一个捏合判定，不需要精确指尖，而 0 大约省一半
    // 每帧开销。
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
