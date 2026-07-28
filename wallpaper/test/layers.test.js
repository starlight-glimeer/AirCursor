// layers.js 的几何与控制律，纯逻辑跑，不需要 Electron / WebGL / 摄像头。
//
//   node test/layers.test.js
//
// 失败时 exit code 非 0 —— 这是守卫不是日志。只打印 ✓/✗ 却永远返回 0 的"测试"
// 在改坏之后仍然一片绿，等于没有。
//
// 用最小 THREE 替身：断言测的是几何和数值，不是渲染，所以不需要真 three.js
// （也因此能在没有 GPU 的地方跑）。⚠️ 反过来说，它证不了"画出来好不好看"。
const assert = require('node:assert');

class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(o) { return this.set(o.x, o.y, o.z); }
}
class Col {
  constructor() { this.r = 1; this.g = 1; this.b = 1; }
  setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; return this; }
}
globalThis.THREE = {
  PlaneGeometry: class { dispose() {} },
  MeshBasicMaterial: class { constructor(o) { Object.assign(this, o); this.color = new Col(); } dispose() {} },
  Mesh: class {
    constructor(geo, mat) {
      this.geometry = geo; this.material = mat;
      this.position = new V3(); this.scale = new V3(1, 1, 1);
      this.rotation = new V3(); this.visible = false;
    }
  },
  Scene: class { constructor() { this.children = []; } add(o) { this.children.push(o); } remove() {} },
  PerspectiveCamera: class {
    constructor(fov, aspect) { this.fov = fov; this.aspect = aspect; this.position = new V3(); this.rotation = new V3(); }
    updateProjectionMatrix() {} updateMatrixWorld() {}
  },
  WebGLRenderer: class { setClearColor() {} setPixelRatio() {} setSize() {} render() {} },
};

require('../src/layers.js');
const L = globalThis.GestureWallLayers;

const VP = 16 / 9;
const baseConfig = () => JSON.parse(JSON.stringify({
  depth: { background: -4.5, subject: 0, shard: 2.2 },
  transform: {
    background: { scale: 1, x: 0, y: 0 },
    subject: { scale: 1, x: 0, y: 0 },
    shard: { scale: 1, x: 0, y: 0 },
  },
  shards: { count: 3, spread: 1.7, drift: 1 },
  parallax: 1,
  tilt: { maxYaw: 30, maxPitch: 18 },
  zoom: { min: 0.7, max: 2.4 },
}));

function buildScene(cfg) {
  const scene = new L.WallScene({});
  scene.resize(1920, 1080, 1);
  scene.background.setTexture({}, VP);
  scene.subject.setTexture({}, 1);
  scene.setShardCount(cfg.shards.count, cfg.depth.shard);
  scene.setShardTexture({}, 1);
  return scene;
}

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.message}`);
    process.exitCode = 1;
  }
}

console.log('\nlayers.js');

// 每层的平面必须在它自己的景深上填满画面，远的层要更大。这条错了就是"背景铺不满"
// 或"主体溢出屏幕"。
check('每层在自己景深上都填满画面', () => {
  for (const z of [-4.5, 0, 2.2]) {
    const h = L.visibleHeightAt(z);
    const s = L.coverSize(VP, z, VP);
    assert.ok(s.width >= h * VP - 1e-6, `z=${z} 宽度不够 (${s.width} < ${h * VP})`);
    assert.ok(s.height >= h - 1e-6, `z=${z} 高度不够`);
  }
});

// 主体是"要被看见"的，背景是"要铺满"的 —— 两个相反的需求。实测踩过：420×554 的
// 竖版人物按 cover 算出来占屏高 225%，只有中间一条在画面里，看起来像主体没加载。
check('主体完整在画面内（不被裁切）', () => {
  const cfg = baseConfig();
  const scene = new L.WallScene({});
  scene.resize(2940, 1724, 1);   // 用户的实际屏幕
  scene.subject.setTexture({}, 420 / 554);   // 用户的实际主体图
  const view = L.createViewState();
  L.applyView(scene, view, cfg, 0);
  const visibleH = L.visibleHeightAt(cfg.depth.subject);
  const visibleW = visibleH * scene.viewportAspect;
  assert.ok(scene.subject.mesh.scale.y <= visibleH + 1e-6,
    `主体高 ${scene.subject.mesh.scale.y.toFixed(2)} 超过可见 ${visibleH.toFixed(2)}`);
  assert.ok(scene.subject.mesh.scale.x <= visibleW + 1e-6, '主体宽超出可见区域');
});

check('背景仍然铺满（不留黑边）', () => {
  const cfg = baseConfig();
  const scene = new L.WallScene({});
  scene.resize(2940, 1724, 1);
  scene.background.setTexture({}, 1080 / 2376);   // 用户的实际背景是竖图
  const view = L.createViewState();
  L.applyView(scene, view, cfg, 0);
  const visibleH = L.visibleHeightAt(cfg.depth.background);
  const visibleW = visibleH * scene.viewportAspect;
  assert.ok(scene.background.mesh.scale.x >= visibleW - 1e-6, '背景宽度不够，会露黑边');
  assert.ok(scene.background.mesh.scale.y >= visibleH - 1e-6, '背景高度不够，会露黑边');
});

check('越远的层平面越大（景深方向正确）', () => {
  const bg = L.coverSize(VP, -4.5, VP);
  const subject = L.coverSize(VP, 0, VP);
  const shard = L.coverSize(VP, 2.2, VP);
  assert.ok(bg.width > subject.width, '背景没有比主体大');
  assert.ok(subject.width > shard.width, '主体没有比碎片大');
});

// 视差的全部意义：三层不能同向等量移动，否则只是一张平图在平移。
check('视差：背景落后、碎片领先（反向）', () => {
  const cfg = baseConfig();
  const scene = buildScene(cfg);
  const view = L.createViewState();
  view.pointerX = 1;
  L.applyView(scene, view, cfg, 0);
  const bgX = scene.background.mesh.position.x;
  const shard = scene.shards[0];
  const offset = shard.mesh.position.x - shard.restX * cfg.shards.spread;
  assert.ok(bgX < -1e-3, `背景没有落后 (x=${bgX})`);
  assert.ok(offset > 1e-3, `碎片没有领先 (偏移=${offset})`);
});

check('视差强度 0 时三层完全不动', () => {
  const cfg = baseConfig();
  cfg.parallax = 0;
  const scene = buildScene(cfg);
  const view = L.createViewState();
  view.pointerX = 1;
  L.applyView(scene, view, cfg, 0);
  assert.strictEqual(scene.background.mesh.position.x, 0);
});

// zoom 必须是相机推进而不是层缩放：推镜头会同时改变层间视差，那才是"进去了"的
// 感觉；缩放层只是把图放大。
check('zoom 是相机推进，层不被缩放', () => {
  const cfg = baseConfig();
  const scene = buildScene(cfg);
  const view = L.createViewState();
  view.zoom = 1;
  L.applyView(scene, view, cfg, 0);
  const z1 = scene.camera.position.z;
  const s1 = scene.subject.mesh.scale.x;
  view.zoom = 2;
  L.applyView(scene, view, cfg, 0);
  assert.ok(scene.camera.position.z < z1, '相机没有推进');
  assert.strictEqual(scene.subject.mesh.scale.x, s1, '层被缩放了（应该只动相机）');
});

// 帧率无关：120Hz 屏上不该比 30Hz 收敛快四倍，否则手感随显示器变。
check('平滑与帧率无关', () => {
  const cfg = baseConfig();
  const converge = (fps) => {
    const v = L.createViewState();
    v.target.zoom = 2;
    for (let i = 0; i < Math.round(fps); i += 1) L.stepView(v, 1 / fps, cfg);
    return v.zoom;
  };
  assert.ok(Math.abs(converge(30) - converge(120)) < 0.01, '30fps 和 120fps 收敛不一致');
});

check('zoom 被夹在上下限内', () => {
  const cfg = baseConfig();
  const hi = L.createViewState();
  hi.target.zoom = 99;
  L.stepView(hi, 0.016, cfg);
  assert.strictEqual(hi.target.zoom, cfg.zoom.max);
  const lo = L.createViewState();
  lo.target.zoom = -5;
  L.stepView(lo, 0.016, cfg);
  assert.strictEqual(lo.target.zoom, cfg.zoom.min);
});

check('yaw / pitch 被夹在 ±1', () => {
  const cfg = baseConfig();
  const v = L.createViewState();
  v.target.yaw = 5;
  v.target.pitch = -5;
  L.stepView(v, 0.016, cfg);
  assert.strictEqual(v.target.yaw, 1);
  assert.strictEqual(v.target.pitch, -1);
});

// 碎片位置必须是 index 的函数，不能用 Math.random()：随机的话每次重启壁纸都
// 重新洗牌，用户永远调不出一个满意的排布。
check('碎片布局确定性（重启不重排）', () => {
  const a = new L.Shard(3, 2.2);
  const b = new L.Shard(3, 2.2);
  assert.strictEqual(a.restX, b.restX);
  assert.strictEqual(a.restY, b.restY);
  assert.notStrictEqual(new L.Shard(4, 2.2).restX, a.restX, '不同 index 应该在不同位置');
});

check('碎片数量增减不泄漏', () => {
  const cfg = baseConfig();
  const scene = buildScene(cfg);
  scene.setShardCount(9, 2.2);
  assert.strictEqual(scene.shards.length, 9);
  scene.setShardCount(2, 2.2);
  assert.strictEqual(scene.shards.length, 2);
  scene.setShardCount(0, 2.2);
  assert.strictEqual(scene.shards.length, 0);
});

// 回归守卫：碎片默认尺寸曾经是 0.26，实测下单片占屏宽 16-29%，5 片把主体埋没了。
// 这条钉的是"碎片是点缀不是第二层背景"。
check('碎片默认尺寸是点缀级（占屏宽 < 12%）', () => {
  const cfg = baseConfig();
  const scene = buildScene(cfg);
  const view = L.createViewState();
  L.applyView(scene, view, cfg, 0);
  const visibleWidth = L.visibleHeightAt(cfg.depth.shard) * scene.viewportAspect;
  for (const shard of scene.shards) {
    const ratio = shard.mesh.scale.x / visibleWidth;
    assert.ok(ratio < 0.12, `碎片 ${shard.index} 占屏宽 ${(ratio * 100).toFixed(1)}% —— 太大了`);
    assert.ok(ratio > 0.01, `碎片 ${shard.index} 只占 ${(ratio * 100).toFixed(1)}% —— 看不见了`);
  }
});

check('调大碎片尺寸设置能真的变大', () => {
  const small = baseConfig();
  const big = baseConfig();
  big.transform.shard.scale = 3;
  const a = buildScene(small);
  const b = buildScene(big);
  const view = L.createViewState();
  L.applyView(a, view, small, 0);
  L.applyView(b, view, big, 0);
  assert.ok(b.shards[0].mesh.scale.x > a.shards[0].mesh.scale.x * 2.5, '尺寸设置没生效');
});

check('情绪越高画面越亮', () => {
  const cfg = baseConfig();
  const scene = buildScene(cfg);
  const view = L.createViewState();
  view.mood = 0;
  L.applyView(scene, view, cfg, 0);
  const dark = scene.subject.material.color.r;
  view.mood = 1;
  L.applyView(scene, view, cfg, 0);
  assert.ok(scene.subject.material.color.r > dark, '情绪没有影响亮度');
});

// 背景整张跟着主体一起摇，看起来会像房间在倾斜而不是主体在转身。
check('背景转动幅度远小于主体', () => {
  const cfg = baseConfig();
  const scene = buildScene(cfg);
  const view = L.createViewState();
  view.yaw = 1;
  L.applyView(scene, view, cfg, 0);
  const bg = Math.abs(scene.background.mesh.rotation.y);
  const subject = Math.abs(scene.subject.mesh.rotation.y);
  assert.ok(bg < subject * 0.3, `背景转太多 (${bg} vs ${subject})`);
  assert.ok(subject > 0.01, '主体没有转');
});

check('缺图的层不参与布局', () => {
  const cfg = baseConfig();
  const scene = buildScene(cfg);
  scene.subject.clear();
  const view = L.createViewState();
  view.pointerX = 1;
  L.applyView(scene, view, cfg, 0);
  assert.strictEqual(scene.subject.mesh.visible, false);
});

// 时间只该驱动碎片漂浮；背景和主体自己动起来会像有鬼。
check('时间只影响碎片，不影响背景和主体', () => {
  const cfg = baseConfig();
  const scene = buildScene(cfg);
  const view = L.createViewState();
  L.applyView(scene, view, cfg, 0);
  const bg0 = scene.background.mesh.position.x;
  const sh0 = scene.shards[0].mesh.position.x;
  L.applyView(scene, view, cfg, 3.7);
  assert.strictEqual(scene.background.mesh.position.x, bg0, '背景随时间动了');
  assert.notStrictEqual(scene.shards[0].mesh.position.x, sh0, '碎片没有漂浮');
});

console.log('\n  槽位模块');

// 三种布局必须产出**明显不同**的排布，否则"组合"这个功能是假的 —— 用户点了换布局
// 看不出变化，比没有这个功能更糟。
check('三种碎片布局产出不同的位置', () => {
  const shard = new L.Shard(3, 2.2);
  const positions = ['orbit', 'cluster', 'depth'].map((layout) => L.shardRest(shard, layout, 1.7));
  const keys = positions.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`);
  assert.strictEqual(new Set(keys).size, 3, `三种布局有重复：${keys.join(' | ')}`);
});

check('cluster 把碎片推到一侧', () => {
  // 取几个 index，全部应该落在正 x 侧 —— 那是"留出主体"的意思
  for (const i of [0, 1, 2, 3, 4]) {
    const rest = L.shardRest(new L.Shard(i, 2.2), 'cluster', 1.7);
    assert.ok(rest.x > 0, `碎片 ${i} 在 x=${rest.x.toFixed(2)}，没聚到一侧`);
  }
});

check('depth 布局的 z 跨度最大（纵深最强）', () => {
  const spans = {};
  for (const layout of ['orbit', 'cluster', 'depth']) {
    const zs = [0, 1, 2, 3, 4, 5].map((i) => L.shardRest(new L.Shard(i, 2.2), layout, 1.7).z);
    spans[layout] = Math.max(...zs) - Math.min(...zs);
  }
  assert.ok(spans.depth > spans.orbit, `depth 的 z 跨度 ${spans.depth.toFixed(2)} 没超过 orbit 的 ${spans.orbit.toFixed(2)}`);
  assert.ok(spans.depth > spans.cluster);
});

check('未知布局落回 orbit，不产生 NaN', () => {
  const rest = L.shardRest(new L.Shard(2, 2.2), '不存在的布局', 1.7);
  for (const v of [rest.x, rest.y, rest.z]) assert.ok(Number.isFinite(v), `出现 ${v}`);
});

// 主体的 float 是缓慢上下浮动。它必须随时间变化，否则"呼吸浮动"这个模块名是骗人的。
check('主体 float 模块让它随时间浮动', () => {
  const cfg = baseConfig();
  cfg.modules = { subject: { float: 0.05, floatSpeed: 0.5, leanWithParallax: 0 } };
  const scene = buildScene(cfg);
  const view = L.createViewState();
  L.applyView(scene, view, cfg, 0);
  const y0 = scene.subject.mesh.position.y;
  L.applyView(scene, view, cfg, 1.0);
  assert.notStrictEqual(scene.subject.mesh.position.y, y0, '主体没有浮动');
});

check('float=0 时主体完全不动', () => {
  const cfg = baseConfig();
  cfg.modules = { subject: { float: 0, floatSpeed: 0, leanWithParallax: 0 } };
  const scene = buildScene(cfg);
  const view = L.createViewState();
  L.applyView(scene, view, cfg, 0);
  const y0 = scene.subject.mesh.position.y;
  L.applyView(scene, view, cfg, 3.7);
  assert.strictEqual(scene.subject.mesh.position.y, y0, '静止模块下主体还在动');
});

// lean 是"物体跟着视角转"，人对它的立体感知比对平移强得多 —— 最便宜的立体感来源。
check('lean 让主体在视差时也转动', () => {
  const cfg = baseConfig();
  const view = L.createViewState();
  view.pointerX = 1;

  cfg.modules = { subject: { float: 0, floatSpeed: 0, leanWithParallax: 0 } };
  const flat = buildScene(cfg);
  L.applyView(flat, view, cfg, 0);

  cfg.modules = { subject: { float: 0, floatSpeed: 0, leanWithParallax: 0.5 } };
  const leaning = buildScene(cfg);
  L.applyView(leaning, view, cfg, 0);

  assert.ok(Math.abs(leaning.subject.mesh.rotation.y) > Math.abs(flat.subject.mesh.rotation.y),
    'lean 没有产生额外转动');
});

check('背景 moodScale 让它随氛围缩放', () => {
  const cfg = baseConfig();
  cfg.modules = { background: { drift: 0, tintFromCover: true, moodScale: 0.06 } };
  const scene = buildScene(cfg);
  const view = L.createViewState();
  view.mood = 0;
  L.applyView(scene, view, cfg, 0);
  const small = scene.background.mesh.scale.x;
  view.mood = 1;
  L.applyView(scene, view, cfg, 0);
  assert.ok(scene.background.mesh.scale.x > small, '氛围没影响背景缩放');
});

check('没有 modules 字段时不崩（旧配置兼容）', () => {
  const cfg = baseConfig();
  delete cfg.modules;
  const scene = buildScene(cfg);
  const view = L.createViewState();
  L.applyView(scene, view, cfg, 1.5);
  for (const v of [scene.subject.mesh.position.y, scene.background.mesh.scale.x]) {
    assert.ok(Number.isFinite(v), `出现 ${v}`);
  }
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
