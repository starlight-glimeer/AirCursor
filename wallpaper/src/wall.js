// The wallpaper window: load the three images, drive the view from mouse or
// gesture, and paint forever.
const { WallScene, createViewState, stepView, applyView } = window.GestureWallLayers;

const canvas = document.getElementById('stage');
const scene = new WallScene(canvas);
const view = createViewState();

// 骨架不画在这里：壁纸在最底层，而录制时 dashboard 在最前面 —— 骨架会在最需要它的
// 那一刻被挡住。它现在是独立窗口（overlay.html），盖在所有东西之上、鼠标穿透。

let config = null;
let strategy = null;
let track = null;
let sensorStatus = null;
let lastGesture = null;
let lastGestureAt = 0;
let mouseSeen = false;

const loader = new THREE.TextureLoader();

// file:// paths with spaces or CJK characters break unless encoded, and a wall
// that silently shows nothing because of a space in a filename is the kind of
// failure that costs an hour.
function fileUrl(p) {
  if (!p) return null;
  return 'file://' + p.split('/').map(encodeURIComponent).join('/');
}

// The loader owns the textures, because it is the only place that knows a path
// changed. Layers borrow them (see layers.js setTexture) — several shards share
// one texture object, so a layer disposing its own would break its siblings.
const loaded = { background: null, subject: null, shard: null };
const textures = { background: null, subject: null, shard: null };

function loadLayer(key, filePath, onDone) {
  if (loaded[key] === filePath) return;
  loaded[key] = filePath;

  // Release the previous image only after deciding to replace it, and only here.
  const previous = textures[key];
  textures[key] = null;
  const releasePrevious = () => {
    if (previous && previous.dispose) previous.dispose();
  };

  if (!filePath) {
    onDone(null, 1);
    releasePrevious();
    return;
  }
  loader.load(
    fileUrl(filePath),
    (texture) => {
      // Wallpapers are photos, so colour space matters: without sRGB they come
      // out visibly washed.
      texture.encoding = THREE.sRGBEncoding;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      const img = texture.image;
      textures[key] = texture;
      onDone(texture, img && img.height ? img.width / img.height : 1);
      // Only now: the layers have let go of the old one.
      releasePrevious();
      note(`${key} 已加载 ${img ? img.width + '×' + img.height : ''}`);
    },
    undefined,
    () => {
      // Report rather than throw: one bad path should not take the other two
      // layers down with it. Clearing `loaded` lets a retry happen if the user
      // picks the same file again after fixing it.
      loaded[key] = null;
      onDone(null, 1);
      releasePrevious();
      note(`⚠️ ${key} 加载失败：${filePath}`);
    },
  );
}

function applyConfig(next) {
  // 把模板的槽位选择摊平成渲染参数。渲染层不认识"模块"，只认数 —— 这一步是唯一需要
  // 知道两者关系的地方（templates.js 里的 resolveSlots）。
  config = {
    ...next,
    modules: window.GestureWallTemplates.resolveSlots(next.template, next.slots),
  };
  loadLayer('background', config.layers.background, (tex, aspect) => {
    if (tex) scene.background.setTexture(tex, aspect); else scene.background.clear();
  });
  loadLayer('subject', config.layers.subject, (tex, aspect) => {
    if (tex) scene.subject.setTexture(tex, aspect); else scene.subject.clear();
  });
  scene.setShardCount(config.shards.count, config.depth.shard);
  loadLayer('shard', config.layers.shard, (tex, aspect) => {
    scene.setShardTexture(tex, aspect);
  });
}

// ---------------------------------------------------------------------------
// Input: mouse first, gestures later, same view state either way
//
// Mouse is deliberately wired before gestures, and both write the same targets:
// it makes "does the arrangement look right" answerable with a known-good input
// before "are the gestures accurate" is even on the table. Debugging both at once
// is how the same symptom ends up having four possible causes.
// ---------------------------------------------------------------------------

// Mouse only reaches the wall on window strategies that accept events. On the
// desktop strategy it never fires — expected, not broken. The HUD reports which
// strategy is live and whether any mouse event arrived, so the two are
// distinguishable without guessing.
let dragging = false;
let dragFrom = { x: 0, y: 0, yaw: 0, pitch: 0 };

window.addEventListener('pointermove', (event) => {
  mouseSeen = true;
  view.target.pointerX = (event.clientX / window.innerWidth) * 2 - 1;
  view.target.pointerY = -((event.clientY / window.innerHeight) * 2 - 1);
  if (!dragging) return;
  const dx = (event.clientX - dragFrom.x) / window.innerWidth;
  const dy = (event.clientY - dragFrom.y) / window.innerHeight;
  view.target.yaw = dragFrom.yaw + dx * 2.4;
  view.target.pitch = dragFrom.pitch - dy * 2.0;
});

window.addEventListener('pointerdown', (event) => {
  dragging = true;
  dragFrom = { x: event.clientX, y: event.clientY, yaw: view.target.yaw, pitch: view.target.pitch };
});
window.addEventListener('pointerup', () => { dragging = false; });
// Releasing outside the window never fires pointerup, which would leave the wall
// stuck in a drag that follows the mouse forever.
window.addEventListener('pointercancel', () => { dragging = false; });
window.addEventListener('blur', () => { dragging = false; });

window.addEventListener('wheel', (event) => {
  view.target.zoom *= event.deltaY < 0 ? 1.06 : 0.945;
}, { passive: true });

// Gesture events carry the same meaning as the mouse actions above, so they write
// the same targets. Nothing downstream knows which one moved the wall.
function onGesture(g) {
  if (!g) return;
  lastGesture = g;
  lastGestureAt = performance.now();
  switch (g.action) {
    case 'zoom':
      // Continuous: hands apart is a distance, not a click. Sent as an absolute
      // 0..1 openness so the wall owns the mapping and the sensor stays dumb.
      if (typeof g.value === 'number') {
        const z = config.zoom || { min: 0.7, max: 2.4 };
        view.target.zoom = z.min + (z.max - z.min) * Math.max(0, Math.min(1, g.value));
      }
      break;
    case 'zoomIn':
      view.target.zoom *= 1 + 0.08 * (g.repeat || 1);
      break;
    case 'zoomOut':
      view.target.zoom *= 1 - 0.07 * (g.repeat || 1);
      break;
    case 'yaw':
      if (typeof g.value === 'number') view.target.yaw = g.value;
      break;
    case 'pitch':
      if (typeof g.value === 'number') view.target.pitch = g.value;
      break;
    case 'swipeLeft':
      view.target.yaw -= 0.34 * (g.repeat || 1);
      break;
    case 'swipeRight':
      view.target.yaw += 0.34 * (g.repeat || 1);
      break;
    case 'tiltUp':
      view.target.pitch += 0.3 * (g.repeat || 1);
      break;
    case 'tiltDown':
      view.target.pitch -= 0.3 * (g.repeat || 1);
      break;
    case 'pointer': {
      // 视差用掌心,不用指尖:要的是"手整体在哪"。指尖会随着屈指乱跳,而两者差 36-38%
      // 屏宽 —— 用指尖做视差会让画面跟着手指头动而不是跟着手动。
      // 用户为「视差跟随」录了手型的话，手型不在场就不动视差（保持在原位，不回中 ——
      // 回中会让画面在手型将断将续时抽动）。`parallax !== false` 而不是 `=== true`：
      // 没带这个字段的事件（旧版/其他来源）照旧放行。
      if (g.parallax === false) break;
      const px = typeof g.palmX === 'number' ? g.palmX : g.x;
      const py = typeof g.palmY === 'number' ? g.palmY : g.y;
      if (typeof px === 'number') view.target.pointerX = px * 2 - 1;
      if (typeof py === 'number') view.target.pointerY = -(py * 2 - 1);
      break;
    }
    case 'reset':
      resetView();
      break;
    default:
      break;
  }
}

function resetView() {
  view.target.zoom = 1;
  view.target.yaw = 0;
  view.target.pitch = 0;
  view.target.pointerX = 0;
  view.target.pointerY = 0;
}

// ---------------------------------------------------------------------------
// Music: mood and tint from the cover art
// ---------------------------------------------------------------------------

// The maths lives in mood.js so it can be exercised without a browser; this only
// does the part that genuinely needs the DOM — turning an <img> into pixels.
const Mood = window.GestureWallMood;

// 48x48 is plenty: this is average colour and contrast, not detail, and scaling a
// 1000px cover down first is far cheaper than reading a million pixels.
function coverPixels(image, size = 48) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size).data;
}

function neutralMood() {
  view.moodTarget = Mood.NEUTRAL;
  view.tintTarget = { r: 1, g: 1, b: 1 };
}

function onTrack(next) {
  track = next;
  if (!config || !config.music.enabled) return;
  if (!track || !track.artworkData || !config.music.moodFromCover) {
    neutralMood();
    return;
  }
  const img = new Image();
  img.onload = () => {
    try {
      const m = Mood.analyzePixels(coverPixels(img));
      if (!m) { neutralMood(); return; }
      view.moodTarget = Mood.moodToBrightnessRange(m.mood);
      view.tintTarget = Mood.blendTint(m.tint, config.music.coverInfluence);
      note(`♪ ${track.title || ''} — 氛围 ${m.mood.toFixed(2)}`);
    } catch (error) {
      note('⚠️ 封面分析失败：' + error.message);
    }
  };
  img.onerror = () => note('⚠️ 封面解码失败');
  img.src = `data:${track.artworkMimeType || 'image/jpeg'};base64,${track.artworkData}`;
}

// ---------------------------------------------------------------------------
// HUD — the only way to tell "not working" from "working, nothing to show"
// ---------------------------------------------------------------------------
const hud = document.getElementById('hud');
const notes = [];

function note(text) {
  notes.push(text);
  if (notes.length > 4) notes.shift();
}

let fps = 0;
let frames = 0;
let fpsAt = performance.now();

// Whether the window got the frame it asked for. The menu bar strip showing through
// is a 25px difference nobody can eyeball, so it gets reported as numbers.
function frameNote() {
  if (!strategy || !strategy.wanted || !strategy.got) return '画面尺寸：未知';
  const w = strategy.wanted;
  const g = strategy.got;
  const dy = g.y - w.y;
  const dh = w.height - g.height;
  if (!dy && !dh && w.width === g.width) {
    return `画面 ${g.width}×${g.height} <span class="ok">全屏 ✓</span>`;
  }
  return `画面 ${g.width}×${g.height} <span class="note">⚠️ 顶部差 ${dy}px 高度差 ${dh}px</span>`;
}

function drawHud() {
  if (!config || !config.debug.showHud) {
    hud.style.display = 'none';
    return;
  }
  hud.style.display = '';
  const missing = ['background', 'subject', 'shard'].filter((k) => !config.layers[k]);
  const gestureAge = lastGesture ? Math.round(performance.now() - lastGestureAt) : null;
  hud.innerHTML = [
    `<b>DreamPaper</b> ${fps} fps`,
    `壁纸层：${strategy ? strategy.label : '?'}`,
    frameNote(),
    `鼠标事件：${mouseSeen ? '收到 ✓' : '没收到（desktop 层的预期）'}`,
    missing.length ? `⚠️ 未设置：${missing.join(' / ')} — ⌃⇧W 打开设置` : '三层已就位',
    `视角 zoom ${view.zoom.toFixed(2)} yaw ${view.yaw.toFixed(2)} pitch ${view.pitch.toFixed(2)}`,
    `情绪 ${view.mood.toFixed(2)}${track ? ` · ♪ ${track.title || ''}` : ' · 无音乐'}`,
    config.gestures.enabled
      ? `手势：${sensorStatus ? sensorStatus.text : '启动中'}${gestureAge !== null ? ` · 上次 ${gestureAge}ms 前 ${lastGesture.action}` : ''}`
      : '手势：关闭',
    ...notes.map((n) => `<span class="note">${n}</span>`),
    `<span class="keys">⌃⇧W 设置 · ⌃⇧L 换层 · ⌃⇧R 复位 · ⌃⇧Q 退出</span>`,
  ].join('<br>');
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
let last = performance.now();

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000) || 0.016;
  last = now;
  frames += 1;
  if (now - fpsAt >= 1000) {
    fps = Math.round((frames * 1000) / (now - fpsAt));
    frames = 0;
    fpsAt = now;
  }
  if (config) {
    stepView(view, dt, config);
    applyView(scene, view, config, now / 1000);
    scene.render();
  }
  drawHud();
  requestAnimationFrame(frame);
}

function syncSize() {
  scene.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio);
}
window.addEventListener('resize', syncSize);
syncSize();

window.gw.onConfig(applyConfig);
window.gw.onStrategy((s) => { strategy = s; mouseSeen = false; });
window.gw.onGesture(onGesture);
window.gw.onTrack(onTrack);
window.gw.onSensorStatus((s) => { sensorStatus = s; });
window.gw.onResetView(resetView);

window.gw.getConfig().then((c) => {
  applyConfig(c);
  requestAnimationFrame(frame);
});
