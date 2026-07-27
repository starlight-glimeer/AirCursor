(function () {
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
      twoHands: false,
      effects: "balanced",
    },
    screen: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
  }),
  updateSettings: async (patch) => ({ settings: { ...settings, ...patch } }),
  runRule: async (ruleId) => ({ ok: true, id: ruleId, label: ruleId }),
  openNetease: async () => fetch("/api/open/netease", { method: "POST" }).then((response) => response.json()),
  pointer: () => {},
  status: () => {},
  onSettings: () => {},
  onVoiceCommand: () => {},
};

const settings = {
  overlayVisible: true,
  showHands: true,
  controlEnabled: false,
  voiceEnabled: true,
  twoHands: false,
  effects: "balanced",
};

const state = {
  hands: [],
  gesture: null,
  particles: [],
  cameraReady: false,
  holdGesture: null,
  holdStartedAt: 0,
  toggleCooldownUntil: 0,
  pointerDown: false,
  pinch: {
    active: false,
    startedAt: 0,
    startX: 0,
    startY: 0,
    dragging: false,
  },
  rightClickCooldownUntil: 0,
  lastPointerSentAt: 0,
  lastInferenceAt: 0,
  inferenceBusy: false,
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
      sendPointer("click", state.cursor.x, state.cursor.y);
      burst(state.cursor.x, state.cursor.y, 18, "#ffd76a");
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
  resetPinch();

  aircursor.updateSettings({ controlEnabled: enabled, overlayVisible: true });
  aircursor.status({ controlEnabled: enabled });
  burst(state.cursor.x, state.cursor.y, settings.effects === "rich" ? 48 : 20, enabled ? "#49e5ff" : "#ff4ea3");
}

function moveCursorToward(gesture, smoothing) {
  state.cursor.x += (gesture.index.x - state.cursor.x) * smoothing;
  state.cursor.y += (gesture.index.y - state.cursor.y) * smoothing;
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

function resetPinch() {
  state.pinch.active = false;
  state.pinch.startedAt = 0;
  state.pinch.startX = 0;
  state.pinch.startY = 0;
  state.pinch.dragging = false;
}

function updateSystemCursor(gesture) {
  if (!gesture || !settings.controlEnabled) {
    if (state.pointerDown) {
      sendPointer("up", state.cursor.x, state.cursor.y);
      state.pointerDown = false;
    }
    resetPinch();
    return;
  }

  const smoothing = state.pinch.dragging ? 0.34 : 0.22;
  moveCursorToward(gesture, smoothing);

  const now = performance.now();
  const canSendMove = !state.pinch.active || state.pinch.dragging;
  if (canSendMove && now - state.lastPointerSentAt > 24) {
    sendPointer("move", state.cursor.x, state.cursor.y);
    state.lastPointerSentAt = now;
  }

  if (gesture.middlePinch && now > state.rightClickCooldownUntil) {
    state.rightClickCooldownUntil = now + 650;
    sendPointer("rightClick", state.cursor.x, state.cursor.y);
    burst(state.cursor.x, state.cursor.y, settings.effects === "rich" ? 24 : 8, "#ffd76a");
    return;
  }

  if (gesture.pinch && !state.pinch.active) {
    state.pinch.active = true;
    state.pinch.startedAt = now;
    state.pinch.startX = state.cursor.x;
    state.pinch.startY = state.cursor.y;
    state.pinch.dragging = false;
    burst(state.pinch.startX, state.pinch.startY, settings.effects === "rich" ? 18 : 6, "#ff4ea3");
    return;
  }

  if (gesture.pinch && state.pinch.active) {
    const moved = Math.hypot(state.cursor.x - state.pinch.startX, state.cursor.y - state.pinch.startY);
    const held = now - state.pinch.startedAt;
    if (!state.pinch.dragging && moved > 28 && held > 140) {
      state.pinch.dragging = true;
      state.pointerDown = true;
      sendPointer("down", state.pinch.startX, state.pinch.startY);
    }
    return;
  }

  if (!gesture.pinch && state.pinch.active) {
    if (state.pinch.dragging || state.pointerDown) {
      sendPointer("up", state.cursor.x, state.cursor.y);
      state.pointerDown = false;
      burst(state.cursor.x, state.cursor.y, settings.effects === "rich" ? 18 : 6, "#49e5ff");
    } else {
      sendPointer("click", state.pinch.startX, state.pinch.startY);
      burst(state.pinch.startX, state.pinch.startY, settings.effects === "rich" ? 18 : 6, "#ffd76a");
    }
    resetPinch();
  }
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
  const radius = gesture?.pinch ? 18 : 24;
  const color = gesture?.pinch ? "#ff4ea3" : "#49e5ff";

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.shadowColor = color;
  ctx.shadowBlur = settings.effects === "rich" ? 18 : 8;
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
let lastDrawAt = 0;
function loop(now) {
  const targetDrawInterval = settings.effects === "rich" ? 16 : 33;
  if (now - lastDrawAt < targetDrawInterval) {
    requestAnimationFrame(loop);
    return;
  }
  lastDrawAt = now;

  const dt = Math.min(0.04, (now - lastFrame) / 1000);
  lastFrame = now;
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  const hands = state.hands.map((hand) => hand.map(point));
  const gesture = hands[0] ? detectGesture(hands[0]) : null;
  state.gesture = gesture;

  updateHoldGesture(gesture);
  updateSystemCursor(gesture);
  hands.forEach((points, index) => drawHand(points, index, index === 0 ? gesture : null));
  drawCursor(gesture);
  drawParticles(dt);

  if (now - lastStatusAt > 500) {
    lastStatusAt = now;
    aircursor.status({
      camera: state.cameraReady ? "已开启" : "等待权限",
      hand: hands.length ? `${hands.length} 只手 / ${gesture?.label || "识别中"}` : "未检测到手",
      controlEnabled: settings.controlEnabled,
    });
  }

  requestAnimationFrame(loop);
}

async function stopHandsRuntime() {
  const runtime = state.handRuntime;
  state.handRuntime = null;
  state.hands = [];
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
    minDetectionConfidence: 0.65,
    minTrackingConfidence: 0.65,
  });

  hands.onResults((results) => {
    if (token !== state.handRestartToken) return;
    state.hands = results.multiHandLandmarks || [];
  });

  const camera = new Camera(video, {
    onFrame: async () => {
      const now = performance.now();
      const minInterval = settings.twoHands ? 50 : 33;
      if (token !== state.handRestartToken || state.inferenceBusy || now - state.lastInferenceAt < minInterval) return;

      state.inferenceBusy = true;
      state.lastInferenceAt = now;
      try {
        await hands.send({ image: video });
      } finally {
        state.inferenceBusy = false;
      }
    },
    width: settings.twoHands ? 960 : 640,
    height: settings.twoHands ? 540 : 480,
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
  Object.assign(settings, next);
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
aircursor.onVoiceCommand((phrase) => handleVoiceText(phrase, "系统语音"));
window.addEventListener("resize", resize);

async function boot() {
  const bootState = await aircursor.getState();
  Object.assign(settings, bootState.settings);
  state.screen = bootState.screen;
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
