const video = document.getElementById("camera");
const canvas = document.getElementById("scene");
const ctx = canvas.getContext("2d", { alpha: true });
const aircursor = window.aircursor || {
  getState: async () => ({
    settings: {
      overlayVisible: true,
      showHands: true,
      controlEnabled: false,
      voiceEnabled: true,
    },
    screen: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
  }),
  updateSettings: async (patch) => ({ settings: { ...settings, ...patch } }),
  openNetease: async () => fetch("/api/open/netease", { method: "POST" }).then((response) => response.json()),
  pointer: () => {},
  status: () => {},
  onSettings: () => {},
};

const settings = {
  overlayVisible: true,
  showHands: true,
  controlEnabled: false,
  voiceEnabled: true,
};

const state = {
  hands: [],
  particles: [],
  cameraReady: false,
  holdGesture: null,
  holdStartedAt: 0,
  toggleCooldownUntil: 0,
  pointerDown: false,
  lastPointerSentAt: 0,
  cursor: { x: 0, y: 0, ready: false },
  screen: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
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

  return {
    label: settings.controlEnabled
      ? pinch
        ? "捏合点击/拖拽"
        : middlePinch
          ? "右键手势"
          : fist
            ? "握拳退出"
            : "控制中"
      : openPalm
        ? "张开手掌唤醒"
        : "待机",
    pinch,
    middlePinch,
    openPalm,
    fist,
    palm: palmCenter(points),
    index,
    palmWidth,
  };
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

function setControlMode(enabled) {
  if (Date.now() < state.toggleCooldownUntil) return;
  state.toggleCooldownUntil = Date.now() + 900;
  settings.controlEnabled = enabled;

  if (!enabled && state.pointerDown) {
    sendPointer("up", state.cursor.x, state.cursor.y);
    state.pointerDown = false;
  }

  aircursor.updateSettings({ controlEnabled: enabled, overlayVisible: true });
  aircursor.status({ controlEnabled: enabled });
  burst(state.cursor.x, state.cursor.y, 64, enabled ? "#49e5ff" : "#ff4ea3");
}

function updateHoldGesture(gesture) {
  if (!gesture) {
    state.holdGesture = null;
    state.holdStartedAt = 0;
    return;
  }

  const desired = !settings.controlEnabled && gesture.openPalm ? "wake" : settings.controlEnabled && gesture.fist ? "sleep" : null;
  if (!desired) {
    state.holdGesture = null;
    state.holdStartedAt = 0;
    return;
  }

  const now = Date.now();
  if (state.holdGesture !== desired) {
    state.holdGesture = desired;
    state.holdStartedAt = now;
  }

  if ((now - state.holdStartedAt) / 1000 >= 1) {
    setControlMode(desired === "wake");
    state.holdGesture = null;
    state.holdStartedAt = 0;
  }
}

function updateSystemCursor(gesture) {
  if (!gesture || !settings.controlEnabled) return;

  const smoothing = gesture.pinch ? 0.34 : 0.22;
  state.cursor.x += (gesture.index.x - state.cursor.x) * smoothing;
  state.cursor.y += (gesture.index.y - state.cursor.y) * smoothing;

  const now = performance.now();
  if (now - state.lastPointerSentAt > 24) {
    sendPointer("move", state.cursor.x, state.cursor.y);
    state.lastPointerSentAt = now;
  }

  if (gesture.middlePinch) {
    sendPointer("rightClick", state.cursor.x, state.cursor.y);
    burst(state.cursor.x, state.cursor.y, 26, "#ffd76a");
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

function burst(x, y, count, color) {
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
  ctx.shadowBlur = settings.controlEnabled ? 28 : 16;
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

let lastFrame = performance.now();
let lastStatusAt = 0;
function loop(now) {
  const dt = Math.min(0.04, (now - lastFrame) / 1000);
  lastFrame = now;
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  const hands = state.hands.map((hand) => hand.map(point));
  const gesture = hands[0] ? detectGesture(hands[0]) : null;

  updateHoldGesture(gesture);
  updateSystemCursor(gesture);
  hands.forEach((points, index) => drawHand(points, index, index === 0 ? gesture : null));
  drawCursor(gesture);
  drawParticles(dt);

  if (now - lastStatusAt > 180) {
    lastStatusAt = now;
    aircursor.status({
      camera: state.cameraReady ? "已开启" : "等待权限",
      hand: hands.length ? `${hands.length} 只手 / ${gesture?.label || "识别中"}` : "未检测到手",
      controlEnabled: settings.controlEnabled,
    });
  }

  requestAnimationFrame(loop);
}

async function setupHands() {
  const hands = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });

  hands.setOptions({
    maxNumHands: 2,
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
    if (!settings.voiceEnabled) return;
    const result = event.results[event.results.length - 1];
    const text = result[0].transcript.trim();

    if (/启动|唤醒|开始|控制/.test(text)) {
      setControlMode(true);
    } else if (/退出|停止|隐藏|关闭控制/.test(text)) {
      setControlMode(false);
    } else if (/网易云|音乐/.test(text)) {
      aircursor.openNetease();
    } else if (/点击/.test(text)) {
      sendPointer("click", state.cursor.x, state.cursor.y);
      burst(state.cursor.x, state.cursor.y, 30, "#ffd76a");
    }
  };

  recognizer.onend = () => recognizer.start();
  try {
    recognizer.start();
  } catch {
    // Voice stays optional because Chromium speech support can vary.
  }
}

aircursor.onSettings((next) => {
  Object.assign(settings, next);
  if (!settings.controlEnabled && state.pointerDown) {
    sendPointer("up", state.cursor.x, state.cursor.y);
    state.pointerDown = false;
  }
});
window.addEventListener("resize", resize);

async function boot() {
  const bootState = await aircursor.getState();
  Object.assign(settings, bootState.settings);
  state.screen = bootState.screen;
  resize();
  setupVoice();
  requestAnimationFrame(loop);
  setupHands().catch((error) => {
    aircursor.status({ camera: `启动失败：${error.message}` });
  });
}

boot();
