// The scene: three textured planes at different depths, plus the control law that
// turns view state into transforms.
//
// Deliberately free of Electron and IPC so the whole thing can be driven from a
// script — the same reason AirCursor keeps pose.js DOM-free. `applyView` is a
// pure function of (state, config): given the same numbers it produces the same
// transforms, so "does the arrangement look right" and "do the gestures produce
// the right numbers" are two separately checkable questions.
(function (root) {
const THREE = root.THREE;

// Camera distance. Layer depths in config are offsets from z=0, so a subject at 0
// sits this far from the lens and the background at -4.5 sits well behind it.
const CAMERA_Z = 6;
// Vertical field of view. 40° is narrow enough that parallax reads as depth
// rather than as fisheye distortion when a layer slides sideways.
const FOV = 40;

// Visible height at a given depth, from the FOV. Needed to size a plane so an
// image fills the frame *at its own depth* — a background at -4.5 has to be much
// larger than a subject at 0 to cover the same screen area.
function visibleHeightAt(z) {
  const distance = CAMERA_Z - z;
  return 2 * Math.tan((FOV * Math.PI) / 360) * distance;
}

// Fit an image into the frame at its depth, cover-style (fill, crop the overflow).
// Right for the background: letterboxing a wallpaper is worse than losing the edges
// of the photo.
function coverSize(aspect, z, viewportAspect) {
  const height = visibleHeightAt(z);
  const width = height * viewportAspect;
  // Match the wider axis so the image always covers.
  return aspect > width / height
    ? { width: height * aspect, height }
    : { width, height: width / aspect };
}

// Fit inside the frame instead, preserving aspect. Right for the subject and the
// shards, and the fix for a real failure: a 420x554 portrait cut-out fitted
// cover-style came out 225% of the screen height, so only a slice of the middle was
// on screen and the subject read as missing. A cut-out figure has to be *seen*,
// which is the opposite requirement to a background that has to *fill*.
function containSize(aspect, z, viewportAspect) {
  const height = visibleHeightAt(z);
  const width = height * viewportAspect;
  return aspect > width / height
    ? { width, height: width / aspect }
    : { width: height * aspect, height };
}

class Layer {
  constructor(name, depth) {
    this.name = name;
    this.depth = depth;
    this.aspect = 1;
    this.mesh = null;
    this.material = null;
    this.texture = null;
  }

  // Transparent planes need explicit draw ordering: depth-sorting a subject PNG
  // against a background plane works, but shards overlapping each other do not
  // sort reliably, so renderOrder is set from the layer's place in the stack.
  build(scene, renderOrder) {
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.material = new THREE.MeshBasicMaterial({
      transparent: true,
      // depthWrite off, depthTest off: every layer's order is decided by
      // renderOrder above, and leaving depth writes on made a subject's
      // transparent margin punch a hole in the shards behind it.
      depthWrite: false,
      depthTest: false,
      opacity: 1,
      color: 0xffffff,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
    scene.add(this.mesh);
    return this.mesh;
  }

  // A layer borrows its texture, it does not own it. Every shard is handed the
  // same texture object, so a shard disposing on clear() would pull the image out
  // from under all its siblings — and disposing on replace would kill a texture
  // another layer is still drawing. Whoever loaded the image disposes it; that is
  // the loader in wall.js, which knows when a path is genuinely gone.
  setTexture(texture, aspect) {
    this.texture = texture;
    this.aspect = aspect || 1;
    this.material.map = texture;
    this.material.needsUpdate = true;
    this.mesh.visible = !!texture;
  }

  clear() {
    this.texture = null;
    this.material.map = null;
    this.material.needsUpdate = true;
    this.mesh.visible = false;
  }

  // Called only when the layer itself is being thrown away, so the GPU buffers
  // for its geometry and material go with it. Still not the texture.
  destroy(scene) {
    this.clear();
    if (scene) scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

// A shard is a Layer plus its own resting position and drift phase, so several
// can share one texture and still move independently.
class Shard extends Layer {
  constructor(index, depth) {
    super(`shard${index}`, depth);
    this.index = index;
    // Fixed pseudo-random placement rather than Math.random(): the arrangement
    // has to survive a reload, otherwise every restart reshuffles the wallpaper
    // and the user can never settle on one they like.
    const golden = 2.399963229728653; // golden angle, spreads points evenly
    const t = index * golden;
    this.restX = Math.cos(t) * (0.55 + (index % 3) * 0.28);
    this.restY = Math.sin(t * 1.31) * (0.42 + (index % 2) * 0.22);
    this.restZ = ((index * 37) % 11) / 11 - 0.5;
    this.phase = t;
    this.spin = ((index % 5) - 2) * 0.12;
    this.scaleJitter = 0.62 + ((index * 53) % 7) / 7 * 0.5;
  }
}

class WallScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
    this.camera.position.set(0, 0, CAMERA_Z);

    // Draw order: background behind, subject in the middle, shards in front.
    this.background = new Layer('background', -4.5);
    this.background.build(this.scene, 0);
    this.subject = new Layer('subject', 0);
    this.subject.build(this.scene, 10);

    this.shards = [];
    this.shardTexture = null;
    this.shardAspect = 1;

    this.viewportAspect = 1;
    this.resize(1920, 1080, 1);
  }

  // Viewport size is passed in rather than read from `window`, so the scene can be
  // built and exercised without a DOM. The header of this file promises that; a
  // direct `window.innerWidth` here broke it and made the geometry untestable.
  resize(width, height, pixelRatio) {
    const w = Math.max(1, width || 1920);
    const h = Math.max(1, height || 1080);
    // Cap DPR at 2: past that a fullscreen wallpaper costs more than it gains, and
    // this runs continuously rather than for one session.
    this.renderer.setPixelRatio(Math.min(pixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.viewportAspect = w / h;
    this.camera.aspect = this.viewportAspect;
    this.camera.updateProjectionMatrix();
  }

  setShardCount(count, depth) {
    const target = Math.max(0, Math.min(24, Math.round(count)));
    while (this.shards.length > target) {
      this.shards.pop().destroy(this.scene);
    }
    while (this.shards.length < target) {
      const shard = new Shard(this.shards.length, depth);
      // +20 so shards always draw over the subject; +index keeps them stable
      // relative to each other.
      shard.build(this.scene, 20 + this.shards.length);
      if (this.shardTexture) shard.setTexture(this.shardTexture, this.shardAspect);
      this.shards.push(shard);
    }
    for (const shard of this.shards) shard.depth = depth;
  }

  setShardTexture(texture, aspect) {
    this.shardTexture = texture;
    this.shardAspect = aspect;
    for (const shard of this.shards) {
      if (texture) shard.setTexture(texture, aspect);
      else shard.clear();
    }
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

// The view state a gesture (or the mouse) manipulates. One object, so "what is
// the wall currently showing" has a single answer that can be logged or reset.
function createViewState() {
  return {
    zoom: 1,
    yaw: 0,        // -1..1, maps to maxYaw degrees
    pitch: 0,      // -1..1, maps to maxPitch degrees
    pointerX: 0,   // -1..1, drives parallax
    pointerY: 0,
    // Targets are what input writes; the values above chase them, so every input
    // gets smoothing for free and none of them has to implement it.
    target: { zoom: 1, yaw: 0, pitch: 0, pointerX: 0, pointerY: 0 },
    // Mood, 0 = calm, 1 = intense. Drives shard drift and layer brightness.
    mood: 0.35,
    moodTarget: 0.35,
    tint: { r: 1, g: 1, b: 1 },
    tintTarget: { r: 1, g: 1, b: 1 },
  };
}

// Critically damped-ish follow. Frame-rate independent so a 120Hz display does
// not converge four times faster than a 30Hz one.
function follow(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

function stepView(view, dt, config) {
  const t = view.target;
  view.zoom = follow(view.zoom, t.zoom, 7, dt);
  view.yaw = follow(view.yaw, t.yaw, 6, dt);
  view.pitch = follow(view.pitch, t.pitch, 6, dt);
  view.pointerX = follow(view.pointerX, t.pointerX, 5, dt);
  view.pointerY = follow(view.pointerY, t.pointerY, 5, dt);
  view.mood = follow(view.mood, view.moodTarget, 0.6, dt);
  for (const k of ['r', 'g', 'b']) {
    view.tint[k] = follow(view.tint[k], view.tintTarget[k], 0.8, dt);
  }
  const z = config.zoom || { min: 0.7, max: 2.4 };
  t.zoom = Math.max(z.min, Math.min(z.max, t.zoom));
  t.yaw = Math.max(-1, Math.min(1, t.yaw));
  t.pitch = Math.max(-1, Math.min(1, t.pitch));
}

const DEG = Math.PI / 180;

// Fraction of a cover-fitted plane that one shard occupies before the user's own
// size setting is applied. Calibrated against a real screen: at 0.26 a single
// shard spanned 16-29% of the display and five of them left nothing of the subject
// visible. 0.075 puts them at roughly 5-8%, which reads as debris around a figure.
const SHARD_BASE_SCALE = 0.075;

// Place every layer for the current view. Pure: same inputs, same output.
function applyView(scene, view, config, timeSec) {
  const parallax = config.parallax ?? 1;
  const tilt = config.tilt || { maxYaw: 30, maxPitch: 18 };
  const mood = view.mood;

  // Zoom is the camera moving, not the layers scaling: moving the lens changes
  // the parallax between layers as it goes, which is what makes a push-in read as
  // depth rather than as a picture being enlarged.
  scene.camera.position.z = CAMERA_Z / view.zoom;
  scene.camera.rotation.set(0, 0, 0);
  scene.camera.updateMatrixWorld();

  const place = (layer, depthKey, extra) => {
    if (!layer.mesh.visible) return;
    const depth = (config.depth && config.depth[depthKey]) ?? layer.depth;
    const tf = (config.transform && config.transform[depthKey]) || { scale: 1, x: 0, y: 0 };
    // Only the background fills; everything else fits. See containSize.
    const fit = depthKey === 'background' ? coverSize : containSize;
    const size = fit(layer.aspect, depth, scene.viewportAspect);
    const scale = tf.scale * (extra && extra.scale ? extra.scale : 1);
    layer.mesh.scale.set(size.width * scale, size.height * scale, 1);

    // Parallax strength grows with distance from the subject plane, so the
    // background lags and the shards lead. That difference *is* the depth cue.
    const lever = depth * 0.16 * parallax;
    layer.mesh.position.set(
      tf.x + view.pointerX * lever + (extra && extra.x ? extra.x : 0),
      tf.y + view.pointerY * lever + (extra && extra.y ? extra.y : 0),
      depth + (extra && extra.z ? extra.z : 0),
    );
    // lean：视差偏移也贡献一点转动。视觉上这是"物体跟着视角转"而不是"平移"，而人对
    // 前者的立体感知强得多 —— 所以这是最便宜的立体感来源。
    const lean = (extra && extra.lean) || 0;
    const rotWeight = extra && extra.rotWeight !== undefined ? extra.rotWeight : 1;
    layer.mesh.rotation.set(
      view.pitch * tilt.maxPitch * DEG * rotWeight - view.pointerY * lean * 0.22,
      view.yaw * tilt.maxYaw * DEG * rotWeight + view.pointerX * lean * 0.3,
      (extra && extra.roll) || 0,
    );

    // Mood shows up as brightness: intense tracks light the scene, calm ones let
    // it sit back. Combined with the cover tint this is what makes one wallpaper
    // feel different per song without changing any of the images.
    const lift = 0.82 + mood * 0.34;
    layer.material.color.setRGB(
      view.tint.r * lift,
      view.tint.g * lift,
      view.tint.b * lift,
    );
  };

  // 槽位模块的参数。渲染层不认识"模块"这个概念，只认这些数 —— 换模块就是换数，
  // 所以加一个模块不用改这里。
  const mods = config.modules || {};
  const bgMod = mods.background || {};
  const subjectMod = mods.subject || {};
  const shardMod = mods.shard || {};

  // The background barely rotates: a full-frame photo swinging with the subject
  // looks like the room is tilting, not like the subject is turning.
  //
  // drift 是极慢的整体平移，moodScale 让它随氛围轻微缩放 —— 两者都是"呼吸"感的来源，
  // 频率刻意取得比人注意得到的更低（0.06Hz 上下），否则壁纸会变成一个持续动的东西。
  const bgBreath = bgMod.drift
    ? { x: Math.sin(timeSec * 0.055) * bgMod.drift * 0.16, y: Math.cos(timeSec * 0.041) * bgMod.drift * 0.1 }
    : { x: 0, y: 0 };
  place(scene.background, 'background', {
    rotWeight: 0.12,
    x: bgBreath.x,
    y: bgBreath.y,
    scale: 1 + (bgMod.moodScale || 0) * mood,
  });

  // 主体：float 是缓慢上下浮动（像悬着），leanWithParallax 让它在视差时也侧一点身 ——
  // 后者是"立体感"最便宜的来源，因为人对"物体跟着视角转"比对平移更敏感。
  const floatY = subjectMod.float
    ? Math.sin(timeSec * (subjectMod.floatSpeed || 0.5) * Math.PI) * subjectMod.float
    : 0;
  place(scene.subject, 'subject', {
    rotWeight: 1,
    y: floatY,
    lean: subjectMod.leanWithParallax || 0,
  });

  const cfg = config.shards || { spread: 1.7, drift: 1 };
  const layout = shardMod.layout || 'orbit';
  const drift = (cfg.drift ?? 1) * (shardMod.drift ?? 1);
  // Shards are accents, not a second background. The first default here made each
  // one 16-29% of the screen width, so five of them buried the subject completely —
  // measured against a real screenshot, not guessed. `SHARD_BASE_SCALE` keeps them
  // in the 4-8% range at the default shard size of 1.0, which leaves the subject
  // readable and makes "turn the size up" the user's choice rather than a rescue.
  for (const shard of scene.shards) {
    // Drift speed scales with mood, so shards hang almost still on a calm track
    // and swarm on an intense one.
    const speed = 0.22 + mood * 0.85;
    const t = timeSec * speed * drift + shard.phase;
    const rest = shardRest(shard, layout, cfg.spread);
    place(shard, 'shard', {
      scale: SHARD_BASE_SCALE * shard.scaleJitter,
      x: rest.x + Math.sin(t) * 0.09 * drift,
      y: rest.y + Math.cos(t * 0.83) * 0.11 * drift,
      z: rest.z,
      roll: shard.phase + t * shard.spin,
      rotWeight: 1.35,   // shards react more than the subject — they are closest
    });
  }
}

// 碎片的静止位置，按布局模块决定。
//
// 三种布局都建立在 Shard 那组确定性的 rest 值上（见 Shard 构造函数：不用 Math.random，
// 否则每次重启壁纸都重新洗牌）—— 布局只是把同一组点重新映射，所以切布局是可预测的
// 变化而不是重新抽一次。
function shardRest(shard, layout, spread) {
  const s = spread ?? 1.7;
  if (layout === 'cluster') {
    // 单侧聚集：全部推到右侧，纵向压扁。留出左边给主体，适合主体偏左的构图。
    return {
      x: (0.55 + Math.abs(shard.restX) * 0.8) * s,
      y: shard.restY * s * 0.7,
      z: shard.restZ * 0.5,
    };
  }
  if (layout === 'depth') {
    // 前后穿插：把 z 拉开到主体两侧（有的在前有的在后），x/y 收一点免得散太开。
    // 纵深最强，但也最容易挡住主体，所以横向收窄到 0.8。
    return {
      x: shard.restX * s * 0.8,
      y: shard.restY * s * 0.8,
      z: shard.restZ * 3.2,
    };
  }
  // orbit：均匀散在四周，默认。
  return { x: shard.restX * s, y: shard.restY * s, z: shard.restZ * 0.8 };
}

root.GestureWallLayers = {
  CAMERA_Z,
  FOV,
  visibleHeightAt,
  coverSize,
  shardRest,
  containSize,
  Layer,
  Shard,
  WallScene,
  createViewState,
  stepView,
  applyView,
  follow,
};
})(typeof window === 'undefined' ? globalThis : window);
