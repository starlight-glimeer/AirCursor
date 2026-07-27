const video = document.getElementById("camera");
const canvas = document.getElementById("scene");
const ctx = canvas.getContext("2d", { alpha: true });
const stage = document.getElementById("stage");
const statusEl = document.getElementById("status");
const gestureEl = document.getElementById("gesture");
const meterEl = document.getElementById("meter");
const accessibilityButton = document.getElementById("accessibilityButton");

const isDesktop = Boolean(window.aircursor);

const state = {
  hands: [],
  particles: [],
  cameraReady: false,
  controlMode: false,
  holdGesture: null,
  holdStartedAt: 0,
  toggleCooldownUntil: 0,
  pointerDown: false,
  lastPointerSentAt: 0,
  cursor: { x: 0, y: 0, ready: false },
  screen: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
  lastPalm: null,
  palmVelocity: { x: 0, y: 0, speed: 0 },
  voiceReady: false,
};

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
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

function detectGesture(points) {
  const thumb = points[4];
  const index = points[8];
  const middle = points[12];
  const ring = points[16];
  const pinky = points[20];
  const wrist = points[0];
  const indexBase = points[5];
  const pinkyBase = points[17];
  const palm = palmCenter(points);
  const palmWidth = Math.max(60, dist(indexBase, pinkyBase));
  const pinchDistance = dist(thumb, index);
  const middlePinchDistance = dist(thumb, middle);
  const pinch = pinchDistance < palmWidth * 0.45;
  const middlePinch = middlePinchDistance < palmWidth * 0.45 && !pinch;
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

  if (state.lastPalm) {
    state.palmVelocity.x = palm.x - state.lastPalm.x;
    state.palmVelocity.y = palm.y - state.lastPalm.y;
    state.palmVelocity.speed = Math.hypot(state.palmVelocity.x, state.palmVelocity.y);
  }
  state.lastPalm = palm;

  let label = "手已识别";
  if (state.controlMode) label = "控制中";
  if (pinch) label = state.controlMode ? "捏合点击/拖拽" : "捏合";
  if (middlePinch) label = "右键手势";
  if (openPalm) label = state.controlMode ? "已唤醒" : "张开手掌唤醒";
  if (fist) label = state.controlMode ? "握拳退出" : "握拳";

  return {
    label,
    pinch,
    middlePinch,
    openPalm,
    fist,
    palm,
    index,
    thumb,
    middle,
    palmWidth,
  };
}

function setControlMode(enabled, reason) {
  if (Date.now() < state.toggleCooldownUntil) return;
  state.toggleCooldownUntil = Date.now() + 900;
  state.controlMode = enabled;
  stage.classList.toggle("is-control", enabled);
  stage.classList.toggle("is-asleep", !enabled);
  meterEl.style.width = "0%";

  if (!enabled && state.pointerDown) {
    sendPointer("up", state.cursor.x, state.cursor.y);
    state.pointerDown = false;
  }

  burst(state.cursor.x || window.innerWidth / 2, state.cursor.y || window.innerHeight / 2, 60, enabled ? "#49e5ff" : "#ff4ea3");
  statusEl.textContent = reason || (enabled ? "AirCursor 已接管：食指移动，捏合点击，握拳退出" : "AirCursor 已隐藏");
}

function updateHoldGesture(gesture) {
  if (!gesture) {
    state.holdGesture = null;
    state.holdStartedAt = 0;
    meterEl.style.width = "0%";
    return;
  }

  const desired = !state.controlMode && gesture.openPalm ? "wake" : state.controlMode && gesture.fist ? "sleep" : null;
  if (!desired) {
    state.holdGesture = null;
    state.holdStartedAt = 0;
    meterEl.style.width = "0%";
    return;
  }

  const now = Date.now();
  if (state.holdGesture !== desired) {
    state.holdGesture = desired;
    state.holdStartedAt = now;
  }

  const progress = clamp((now - state.holdStartedAt) / 1000, 0, 1);
  meterEl.style.width = `${Math.round(progress * 100)}%`;

  if (progress >= 1) {
    setControlMode(desired === "wake", desired === "wake" ? "AirCursor 已唤醒：食指移动，捏合点击" : "AirCursor 已隐藏");
    state.holdGesture = null;
    state.holdStartedAt = 0;
  }
}

function screenPoint(localX, localY) {
  return {
    x: state.screen.x + clamp(localX, 0, window.innerWidth),
    y: state.screen.y + clamp(localY, 0, window.innerHeight),
  };
}

function sendPointer(type, x, y) {
  if (!isDesktop) return;
  const p = screenPoint(x, y);
  window.aircursor.pointer({ type, x: p.x, y: p.y });
}

function updateSystemCursor(gesture) {
  if (!gesture || !state.controlMode) return;

  const target = gesture.index;
  const smoothing = gesture.pinch ? 0.34 : 0.22;
  state.cursor.x += (target.x - state.cursor.x) * smoothing;
  state.cursor.y += (target.y - state.cursor.y) * smoothing;

  const now = performance.now();
  if (now - state.lastPointerSentAt > 24) {
    sendPointer("move", state.cursor.x, state.cursor.y);
    state.lastPointerSentAt = now;
  }

  if (gesture.middlePinch) {
    sendPointer("rightClick", state.cursor.x, state.cursor.y);
    burst(state.cursor.x, state.cursor.y, 28, "#ffd76a");
    return;
  }

  if (gesture.pinch && !state.pointerDown) {
    state.pointerDown = true;
    sendPointer("down", state.cursor.x, state.cursor.y);
    burst(state.cursor.x, state.cursor.y, 24, "#ff4ea3");
  } else if (!gesture.pinch && state.pointerDown) {
    state.pointerDown = false;
    sendPointer("up", state.cursor.x, state.cursor.y);
    burst(state.cursor.x, state.cursor.y, 18, "#49e5ff");
  }
}

async function launchNetease() {
  statusEl.textContent = "正在打开网易云音乐...";
  burst(state.cursor.x, state.cursor.y, 80, "#ff4ea3");

  try {
    const result = isDesktop
      ? await window.aircursor.openNetease()
      : await fetch("/api/open/netease", { method: "POST" }).then((response) => response.json());
    if (!result.ok) throw new Error("启动失败");
    statusEl.textContent = "已执行：打开网易云音乐";
  } catch (error) {
    statusEl.textContent = `打开失败：${error.message}`;
  }
}

function burst(x, y, count, color) {
  for (let i = 0; i < count; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 2 + Math.random() * 8;
    state.particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0.5 + Math.random() * 0.7,
      age: 0,
      size: 2 + Math.random() * 7,
      color,
    });
  }
}

function drawHand(gesture) {
  if (!gesture) return;
  const points = state.hands[0].map(point);
  const lines = [
    [0, 1, 2, 3, 4],
    [0, 5, 6, 7, 8],
    [0, 9, 10, 11, 12],
    [0, 13, 14, 15, 16],
    [0, 17, 18, 19, 20],
    [5, 9, 13, 17],
  ];

  const t = performance.now() / 1000;
  const hue = gesture.pinch ? 325 : state.controlMode ? 188 + Math.sin(t * 2.2) * 32 : 205;
  const stroke = `hsl(${hue}, 100%, 64%)`;
  const core = `hsl(${hue + 25}, 100%, 82%)`;
  const alpha = state.controlMode ? 0.96 : 0.72;

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = state.controlMode ? 5 : 3;
  ctx.strokeStyle = stroke;
  ctx.shadowColor = stroke;
  ctx.shadowBlur = state.controlMode ? 28 : 16;
  ctx.globalAlpha = alpha;

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
    ctx.arc(p.x, p.y, state.controlMode ? 5 : 3.5, 0, Math.PI * 2);
    ctx.fillStyle = core;
    ctx.fill();
  }

  ctx.restore();
}

function drawCursor(gesture) {
  if (!state.controlMode) return;

  const radius = gesture?.pinch ? 18 : 24;
  const color = gesture?.pinch ? "#ff4ea3" : "#49e5ff";

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.shadowColor = color;
  ctx.shadowBlur = 18;
  ctx.beginPath();
  ctx.arc(state.cursor.x, state.cursor.y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(state.cursor.x - 8, state.cursor.y);
  ctx.lineTo(state.cursor.x + 8, state.cursor.y);
  ctx.moveTo(state.cursor.x, state.cursor.y - 8);
  ctx.lineTo(state.cursor.x, state.cursor.y + 8);
  ctx.stroke();
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

function clearTransparent() {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
}

let lastFrame = performance.now();
function loop(now) {
  const dt = Math.min(0.04, (now - lastFrame) / 1000);
  lastFrame = now;

  clearTransparent();
  const handPoints = state.hands[0] ? state.hands[0].map(point) : null;
  const gesture = handPoints ? detectGesture(handPoints) : null;

  gestureEl.textContent = gesture ? gesture.label : "未检测到手";
  if (!gesture) {
    statusEl.textContent = state.cameraReady ? "把手放进摄像头画面" : "等待摄像头权限";
  } else if (!state.controlMode) {
    statusEl.textContent = "张开手掌保持 1 秒，唤醒透明手势层";
  } else {
    statusEl.textContent = "控制中：食指移动，捏合点击/拖拽，握拳保持退出";
  }

  updateHoldGesture(gesture);
  updateSystemCursor(gesture);
  drawHand(gesture);
  drawCursor(gesture);
  drawParticles(dt);

  requestAnimationFrame(loop);
}

async function setupHands() {
  const hands = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });

  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.72,
    minTrackingConfidence: 0.7,
  });

  hands.onResults((results) => {
    state.hands = results.multiHandLandmarks || [];
  });

  const camera = new Camera(video, {
    onFrame: async () => {
      await hands.send({ image: video });
    },
    width: 1280,
    height: 720,
  });

  await camera.start();
  state.cameraReady = true;
}

function setupVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;

  const recognizer = new SpeechRecognition();
  recognizer.lang = "zh-CN";
  recognizer.continuous = true;
  recognizer.interimResults = false;

  recognizer.onresult = (event) => {
    const result = event.results[event.results.length - 1];
    const text = result[0].transcript.trim();

    if (/启动|唤醒|开始|控制/.test(text)) {
      setControlMode(true, `语音唤醒：${text}`);
    } else if (/退出|停止|隐藏|关闭控制/.test(text)) {
      setControlMode(false, `语音退出：${text}`);
    } else if (/网易云|音乐/.test(text)) {
      launchNetease();
    } else if (/点击/.test(text)) {
      sendPointer("click", state.cursor.x, state.cursor.y);
      burst(state.cursor.x, state.cursor.y, 30, "#ffd76a");
    }
  };

  recognizer.onend = () => recognizer.start();
  recognizer.onerror = () => {
    state.voiceReady = false;
  };

  try {
    recognizer.start();
    state.voiceReady = true;
  } catch {
    state.voiceReady = false;
  }
}

accessibilityButton.addEventListener("click", () => {
  if (isDesktop) window.aircursor.openAccessibilitySettings();
});

window.addEventListener("resize", resize);

async function boot() {
  if (isDesktop) {
    state.screen = await window.aircursor.getScreen();
    window.aircursor.onHelperLog((message) => {
      statusEl.textContent = message;
    });
  }

  resize();
  requestAnimationFrame(loop);
  setupVoice();
  setupHands().catch((error) => {
    statusEl.textContent = `摄像头或手势模型启动失败：${error.message}`;
  });
}

boot();
