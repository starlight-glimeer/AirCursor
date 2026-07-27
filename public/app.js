const video = document.getElementById("camera");
const canvas = document.getElementById("scene");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const gestureEl = document.getElementById("gesture");
const meterEl = document.getElementById("meter");
const testButton = document.getElementById("testButton");

const avatar = new Image();
avatar.src = "/avatar_moon.png";

const state = {
  hands: [],
  particles: [],
  familiar: {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    size: 150,
    mood: "idle",
    caught: false,
  },
  pinchStartedAt: 0,
  launchCooldownUntil: 0,
  launched: false,
  lastPalm: null,
  palmVelocity: { x: 0, y: 0, speed: 0 },
  cameraReady: false,
};

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (!state.familiar.x || !state.familiar.y) {
    state.familiar.x = window.innerWidth * 0.52;
    state.familiar.y = window.innerHeight * 0.52;
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
  const wrist = points[0];
  const indexBase = points[5];
  const pinkyBase = points[17];
  const palm = palmCenter(points);
  const palmWidth = Math.max(60, dist(indexBase, pinkyBase));
  const pinchDistance = dist(thumb, index);
  const pinch = pinchDistance < palmWidth * 0.48;
  const openPalm =
    dist(points[8], wrist) > palmWidth * 1.65 &&
    dist(points[12], wrist) > palmWidth * 1.65 &&
    dist(points[16], wrist) > palmWidth * 1.35 &&
    dist(points[20], wrist) > palmWidth * 1.2 &&
    !pinch;

  if (state.lastPalm) {
    state.palmVelocity.x = palm.x - state.lastPalm.x;
    state.palmVelocity.y = palm.y - state.lastPalm.y;
    state.palmVelocity.speed = Math.hypot(state.palmVelocity.x, state.palmVelocity.y);
  }
  state.lastPalm = palm;

  return {
    label: pinch ? "捏合中" : openPalm ? "张开手掌" : "手已识别",
    pinch,
    openPalm,
    palm,
    index,
    thumb,
    middle,
    palmWidth,
    pinchDistance,
  };
}

async function launchNetease() {
  if (Date.now() < state.launchCooldownUntil) return;
  state.launchCooldownUntil = Date.now() + 4500;

  statusEl.textContent = "正在打开网易云音乐...";
  burst(state.familiar.x, state.familiar.y, 80, "#ff4ea3");

  try {
    const response = await fetch("/api/open/netease", { method: "POST" });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || "启动失败");
    statusEl.textContent = "已执行：打开网易云音乐";
    state.launched = true;
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
      life: 0.8 + Math.random() * 0.8,
      age: 0,
      size: 3 + Math.random() * 7,
      color,
    });
  }
}

function updateFamiliar(gesture, dt) {
  const familiar = state.familiar;
  familiar.size = clamp(window.innerWidth * 0.12, 110, 210);

  if (!gesture) {
    familiar.caught = false;
    familiar.mood = "idle";
    familiar.vx += (window.innerWidth * 0.52 - familiar.x) * 0.00045;
    familiar.vy += (window.innerHeight * 0.52 - familiar.y) * 0.00045;
  } else if (gesture.pinch && dist(gesture.index, familiar) < familiar.size * 0.9) {
    familiar.caught = true;
    familiar.mood = "caught";
    familiar.x += (gesture.index.x - familiar.x) * 0.36;
    familiar.y += (gesture.index.y - familiar.y - familiar.size * 0.18) * 0.36;
    familiar.vx = state.palmVelocity.x * 0.32;
    familiar.vy = state.palmVelocity.y * 0.32;
  } else {
    familiar.caught = false;
    const handDistance = dist(gesture.palm, familiar);

    if (gesture.openPalm && handDistance < familiar.size * 1.65) {
      familiar.mood = "shield";
      familiar.vx += (gesture.palm.x - familiar.x) * 0.006;
      familiar.vy += (gesture.palm.y - familiar.y - familiar.size * 0.55) * 0.006;
      if (Math.random() < 0.18) burst(familiar.x, familiar.y, 4, "#49e5ff");
    } else if (handDistance < familiar.size * 1.35) {
      familiar.mood = "dodge";
      const dx = familiar.x - gesture.palm.x;
      const dy = familiar.y - gesture.palm.y;
      const length = Math.max(1, Math.hypot(dx, dy));
      familiar.vx += (dx / length) * 4.2;
      familiar.vy += (dy / length) * 4.2;
    } else {
      familiar.mood = "curious";
      familiar.vx += (gesture.index.x - familiar.x) * 0.0009;
      familiar.vy += (gesture.index.y - familiar.y) * 0.0009;
    }
  }

  familiar.vy += Math.sin(performance.now() / 520) * 0.045;
  familiar.vx *= 0.92;
  familiar.vy *= 0.92;
  familiar.x += familiar.vx * dt * 60;
  familiar.y += familiar.vy * dt * 60;
  familiar.x = clamp(familiar.x, familiar.size * 0.45, window.innerWidth - familiar.size * 0.45);
  familiar.y = clamp(familiar.y, familiar.size * 0.45, window.innerHeight - familiar.size * 0.45);
}

function updateLaunchGesture(gesture) {
  if (!gesture || !gesture.pinch) {
    state.pinchStartedAt = 0;
    meterEl.style.width = "0%";
    return;
  }

  const now = Date.now();
  if (!state.pinchStartedAt) state.pinchStartedAt = now;
  const progress = clamp((now - state.pinchStartedAt) / 1200, 0, 1);
  meterEl.style.width = `${Math.round(progress * 100)}%`;

  if (progress >= 1) {
    launchNetease();
    state.pinchStartedAt = 0;
  }
}

function drawCamera() {
  const videoRatio = video.videoWidth / video.videoHeight || 16 / 9;
  const canvasRatio = window.innerWidth / window.innerHeight;
  let drawWidth = window.innerWidth;
  let drawHeight = window.innerHeight;
  let drawX = 0;
  let drawY = 0;

  if (videoRatio > canvasRatio) {
    drawHeight = window.innerHeight;
    drawWidth = drawHeight * videoRatio;
    drawX = (window.innerWidth - drawWidth) / 2;
  } else {
    drawWidth = window.innerWidth;
    drawHeight = drawWidth / videoRatio;
    drawY = (window.innerHeight - drawHeight) / 2;
  }

  ctx.save();
  ctx.translate(window.innerWidth, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, -drawX - drawWidth, drawY, drawWidth, drawHeight);
  ctx.restore();

  ctx.fillStyle = "rgba(7, 8, 12, 0.12)";
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
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

  ctx.save();
  ctx.lineWidth = 3;
  ctx.strokeStyle = gesture.pinch ? "#ff4ea3" : "#49e5ff";
  ctx.shadowColor = ctx.strokeStyle;
  ctx.shadowBlur = 16;

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
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.fill();
  }

  ctx.restore();
}

function drawFamiliar() {
  const familiar = state.familiar;
  const t = performance.now() / 1000;
  const wobble = Math.sin(t * 7) * (familiar.mood === "caught" ? 8 : 4);
  const scale = familiar.mood === "dodge" ? 1.08 : familiar.mood === "caught" ? 0.95 : 1;
  const size = familiar.size * scale;

  ctx.save();
  ctx.translate(familiar.x, familiar.y);
  ctx.rotate((familiar.vx * 0.01 + wobble * 0.004) * 0.35);

  ctx.globalAlpha = 0.28;
  ctx.fillStyle = "#05050a";
  ctx.beginPath();
  ctx.ellipse(0, size * 0.42, size * 0.34, size * 0.08, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = 1;
  ctx.shadowColor = familiar.mood === "shield" ? "#49e5ff" : "#ff79b5";
  ctx.shadowBlur = familiar.mood === "shield" ? 36 : 24;
  if (avatar.complete) {
    ctx.drawImage(avatar, -size / 2, -size / 2 + wobble, size, size);
  } else {
    ctx.fillStyle = "#ff79b5";
    ctx.beginPath();
    ctx.arc(0, 0, size / 3, 0, Math.PI * 2);
    ctx.fill();
  }

  if (familiar.mood === "shield") {
    ctx.globalAlpha = 0.72;
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#49e5ff";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.62 + Math.sin(t * 8) * 8, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}

function drawParticles(dt) {
  state.particles = state.particles.filter((p) => p.age < p.life);
  for (const p of state.particles) {
    p.age += dt;
    p.x += p.vx * dt * 60;
    p.y += p.vy * dt * 60;
    p.vx *= 0.97;
    p.vy *= 0.97;

    ctx.save();
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
function loop(now) {
  const dt = Math.min(0.04, (now - lastFrame) / 1000);
  lastFrame = now;

  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  if (video.readyState >= 2) drawCamera();
  else {
    ctx.fillStyle = "#07080c";
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
  }

  const handPoints = state.hands[0] ? state.hands[0].map(point) : null;
  const gesture = handPoints ? detectGesture(handPoints) : null;
  gestureEl.textContent = gesture ? gesture.label : "未检测到手";
  if (gesture && !state.launched) {
    statusEl.textContent = "捏合拇指和食指并保持 1.2 秒，打开网易云音乐";
  } else if (!gesture && !state.launched) {
    statusEl.textContent = state.cameraReady ? "把手放进摄像头画面" : "等待摄像头权限";
  }

  updateLaunchGesture(gesture);
  updateFamiliar(gesture, dt);
  drawHand(gesture);
  drawFamiliar();
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

testButton.addEventListener("click", launchNetease);
window.addEventListener("resize", resize);

resize();
requestAnimationFrame(loop);
setupHands().catch((error) => {
  statusEl.textContent = `摄像头或手势模型启动失败：${error.message}`;
});
