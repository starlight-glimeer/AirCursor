// 骨架运行时的**逻辑**测试（wallpaper/skeleton/）。
//
//   node test/skeleton.test.js
//
// ⚠️⚠️ **这个文件测不了渲染** —— 云端没有 GPU、没有浏览器。
//   它用一个最小 THREE 替身 + 假 DOM 跑一遍，验的是：
//     · 加载顺序对（scene.js 先挂 SCENE，runtime 再读它）
//     · 契约齐（build / frame / reconfig）
//     · 音频 128 段能算出 bass/mid/treble
//     · 连跑 60 帧不抛
//     · 自检会输出、fatal 会被记下
//   ⟹ 而"画面好不好看""真机上流不流畅"**只能用户看**。
//     判据：说不了的就说"这条只能你验"，别包装成事实。
//
// ⚠️ 我第一版跑出 "893fps"，差点当成"限帧没生效" —— 那是**harness 喂了
//   30ms 间隔**造成的假象（真实 rAF 是 16.7ms，会被限到 ~29fps）。
//   ⟹ 判据：**先确认异常是不是自己测试环境造的**，再去改被测代码。

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const B = path.join(__dirname, '..', 'skeleton') + path.sep;

// ⚠️⚠️ **先把真的 console 抓住** —— 下面那个 THREE/DOM 替身会把
//   `global.console` 换掉（它要收集骨架打的日志）⟹ 不抓的话**测试自己的输出
//   也进了那个数组**，跑起来一片空白而退出码是 0（我这轮踩了两次）。
//   ⟹ 判据：**要替换全局的东西，先留一条真的出口。**
const OUT = { log: console.log.bind(console), err: console.error.bind(console) };

let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; OUT.log(`  ✓ ${name}`); }
  catch (error) { OUT.err(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1; }
}

OUT.log('\n骨架运行时');

// ── 最小 THREE 替身（只提供骨架和参考场景用到的）
function V3(){return {x:0,y:0,z:0,set(a,b,c){this.x=a;this.y=b;this.z=c;return this}}}
class Obj3D{constructor(){this.position=V3();this.scale=V3();this.matrix={};this.children=[]}
  updateMatrix(){} add(o){this.children.push(o)} remove(o){this.children=this.children.filter(x=>x!==o)}
  lookAt(){} }
const THREE={ REVISION:'128', DynamicDrawUsage:35048,
  Scene:class extends Obj3D{}, Object3D:Obj3D,
  PerspectiveCamera:class extends Obj3D{constructor(){super();this.aspect=1}updateProjectionMatrix(){}},
  WebGLRenderer:class{constructor(o){this.o=o;this._dpr=1}
    getContext(){return {getParameter:()=>'fake', getError:()=>0, VERSION:1, RENDERER:2}}
    setPixelRatio(v){this._dpr=v} getPixelRatio(){return this._dpr} setSize(){} render(){this.rendered=(this.rendered||0)+1}},
  Fog:class{constructor(){}}, Color:class{constructor(){this.r=0;this.g=0;this.b=0}
    setRGB(r,g,b){this.r=r;this.g=g;this.b=b;return this} multiplyScalar(){return this}},
  AmbientLight:class extends Obj3D{}, DirectionalLight:class extends Obj3D{},
  // ⚠️ Group：0.9.140 起骨架把默认灯光装进一个 Group（让模型能一句话换整套打光）
  Group:class extends Obj3D{},
  BoxGeometry:class{dispose(){}}, MeshStandardMaterial:class{dispose(){}},
  InstancedBufferAttribute:class{constructor(a,n){this.array=a;this.itemSize=n}},
  InstancedMesh:class extends Obj3D{constructor(g,m,n){super();this.geometry=g;this.material=m;this.count=n;
    this.instanceMatrix={setUsage(){},needsUpdate:false};this.instanceColor=null;this._set=0}
    setMatrixAt(){this._set++} setColorAt(){}},
};

// ── 最小 DOM
const listeners={};
const errBox={textContent:'',style:{display:'none'}};
global.window={ innerWidth:1920, innerHeight:1080, devicePixelRatio:2,
  addEventListener:(k,f)=>{(listeners[k]=listeners[k]||[]).push(f)},
  requestAnimationFrame:(f)=>{global.__raf=f; return 1},
};
global.document={ getElementById:(id)=> id==='c' ? {addEventListener(){}} : (id==='err'?errBox:null) };
global.requestAnimationFrame=(f)=>{global.__raf=f; return 1};
global.setTimeout=(f,ms)=>{global.__selfcheck=f; return 1};
global.THREE=THREE;
const logs=[];
const REAL=console;
global.console={log:(...a)=>logs.push(a.join(' ')), warn:()=>{}, error:(...a)=>logs.push('ERR '+a.join(' '))};

// 音频/媒体注册器
let audioCb=null;
window.wallpaperRegisterAudioListener=(cb)=>{audioCb=cb};
window.wallpaperRegisterMediaPropertiesListener=()=>{};
window.wallpaperRegisterMediaThumbnailListener=()=>{};
window.wallpaperRegisterMediaPlaybackListener=()=>{};
let readyCalled=false;
window.wallpaperReady=()=>{readyCalled=true};

// ── 跑：scene 先、runtime 后（和 index.html 的顺序一致）
eval(fs.readFileSync(B+'scene.example.js','utf8'));
eval(fs.readFileSync(B+'runtime.js','utf8'));


// ── 跑起来（上面那段已经 eval 了 scene + runtime）
const feed = (n) => { if (audioCb) for (let k = 0; k < n; k += 1) audioCb(
  Array.from({ length: 128 }, (_, i) => Math.abs(Math.sin(i + k)))); };
const run = (frames, stepMs) => {
  let threw = null;
  try { for (let f = 0; f < frames; f += 1) global.__raf(f * stepMs); }
  catch (e) { threw = e.message; }
  return threw;
};

check('scene.js 先挂 SCENE，runtime 能读到它', () => {
  assert.ok(window.SCENE, 'window.SCENE 没挂上');
  assert.strictEqual(typeof window.SCENE.build, 'function', 'SCENE.build 不是函数');
  assert.strictEqual(typeof window.SCENE.frame, 'function', 'SCENE.frame 不是函数');
});

check('runtime 报告了就绪（那是宿主判断"JS 活着"的唯一信号）', () => {
  assert.ok(readyCalled, 'wallpaperReady() 没被调 ⟹ 宿主会以为壁纸挂了');
});

check('音频注册了，而且 128 段能算出三个频段', () => {
  assert.ok(audioCb, '没注册 wallpaperRegisterAudioListener');
  feed(3);
  assert.ok(logs.some((l) => l.includes('音频接上了')),
    '收到音频却没打日志 ⟹ 用户无从判断"不跟音乐"是哪一段坏了');
});

check('连跑 60 帧不抛', () => {
  // ⚠️ 30ms 间隔（>25ms 的限帧门槛）⟹ 每帧都真的画
  const threw = run(60, 30);
  assert.strictEqual(threw, null, `第几帧抛了：${threw}`);
});

check('3 秒自检会输出（"跑起来了但看不见"的唯一观测点）', () => {
  if (global.__selfcheck) global.__selfcheck();
  const line = logs.find((l) => l.includes('3 秒自检'));
  assert.ok(line, '没有自检输出');
  // ⚠️ 那一行要带够信息：帧数 / 音频 / gl 错误 / 对象数 / 画布尺寸
  for (const k of ['帧', '音频', 'gl.getError', '对象', '画布']) {
    assert.ok(line.includes(k), `自检没报 "${k}" ⟹ 少一项就少一种能定位的失败`);
  }
});

check('全程零 fatal', () => {
  const bad = logs.filter((l) => l.includes('\u274c'));
  assert.deepStrictEqual(bad, [], `骨架自己报了错：${bad.join(' | ')}`);
});

// ---------------------------------------------------------------------------
// ⚠️ 契约与硬约束（读源码，不跑）
// ---------------------------------------------------------------------------
const rt = fs.readFileSync(B + 'runtime.js', 'utf8');
// ⚠️⚠️ **剥注释后的版本** —— 这个文件里注释很多，而它们提到的名字会让
//   `assert.match` 命中注释而不是代码（这轮撞到过八次）。
//   ⚠️ 连**行尾注释**一起剥（只过滤"整行以 // 开头"是不够的：
//     `foo(); // 提到 bar` 那种会留着）。
const rtNoComment = rt.split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
  .map((l) => {
    const at = l.indexOf('//');
    if (at < 0) return l;
    const before = l.slice(0, at);
    const odd = (q) => ((before.match(new RegExp(q, 'g')) || []).length % 2) === 1;
    return (odd("'") || odd('"') || odd('`')) ? l : before;
  })
  .join('\n');
const html = fs.readFileSync(B + 'index.html', 'utf8');

check('限帧 40fps（这个项目为"壁纸吃满 CPU"栽过一轮）', () => {
  assert.match(rt, /MIN_DT = 1000 \/ 40/, '没有 40fps 的限帧门槛');
  assert.match(rt, /if \(now - last < MIN_DT\) return;/, '限帧没真的拦住那一帧');
});

check('dpr 夹上限 2', () => {
  assert.match(rt, /Math\.min\(window\.devicePixelRatio \|\| 1, 2\)/,
    'dpr 没夹上限 ⟹ 3 倍屏上是 2.25 倍像素量');
});

check('index.html 的加载顺序是 three → scene → runtime', () => {
  // ⚠️⚠️ 只看**真的 `<script src>` 标签** —— 文件头那段注释里也写着这三个名字
  //   （在解释加载顺序）⟹ 用 indexOf 找名字会命中注释，而注释里的顺序是
  //   "runtime.js" 先出现 ⟹ 在正确代码上报红（实测过）。
  //   ⚠️ 这是这轮第八次撞到"关键词命中注释"。
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(srcs, ['vendor/three.min.js', 'scene.js', 'runtime.js'],
    `<script> 的顺序/内容不对：${JSON.stringify(srcs)}`
    + ' ⟹ three 要最先（scene 和 runtime 都用它）、scene 要在 runtime 之前'
    + '（runtime 启动时要读 window.SCENE）');
  // ⚠️ 三个都要是**相对路径** —— 壁纸跑在自定义协议下，绝对路径和 CDN 到不了
  for (const src of srcs) {
    assert.ok(!/^(https?:|\/\/|\/)/.test(src), `${src} 不是相对路径`);
  }
});

check('每帧抛异常时会停掉渲染（不能刷屏也不能装作没事）', () => {
  assert.match(rt, /frameErrors <= 3/, '没限制报错次数 ⟹ 每帧报一次会把 IPC 堵死');
  assert.match(rt, /frameErrors > 30/, '没有"持续报错就停"的兜底');
});

check('音频用 Math.max 累积峰值，不是直接赋值', () => {
  // ⚠️ 直接赋值会让两帧之间的峰值被抹掉（症状是"不跟音乐"）
  assert.match(rt, /audio\.bass = Math\.max\(audio\.bass/,
    '音频直接赋值 ⟹ 回调比渲染帧快，峰值会被抹掉');
});

check('契约只有一个重配入口（SCENE.reconfig）', () => {
  // ⚠️ 我第一版同时有 SCENE.reconfig 和 window.SCENE_RECONFIG —— 两个名字一件事，
  //   而多出来的那个必然有一天没人实现（写参考实现时我就把它写成了空函数）。
  assert.match(rt, /typeof SCENE\.reconfig === 'function'/, '没有 SCENE.reconfig 这条路');
  // ⚠️⚠️ **剥注释再查** —— 上面那段注释里就写着 `window.SCENE_RECONFIG`
  //   （在记录"为什么删掉它"）⟹ 不剥的话这条断言永远报红。
  //   ⚠️ 和 gating 那边同一个教训：`codeOnly()` 要连行尾注释一起剥。
  const rtCode = rt.split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .map((l) => {
      const at = l.indexOf('//');
      if (at < 0) return l;
      const before = l.slice(0, at);
      const odd = (q) => ((before.match(new RegExp(q, 'g')) || []).length % 2) === 1;
      return (odd("'") || odd('"') || odd('`')) ? l : before;
    })
    .join('\n');
  assert.ok(!rtCode.includes('SCENE_RECONFIG'),
    '又出现了第二个重配入口 ⟹ 同一件事只留一个名字');
});

// ---------------------------------------------------------------------------
// ⚠️⚠️ 防同质化：骨架不许锁死"影响观感"的东西（0.9.140）
// ---------------------------------------------------------------------------
//
// 用户 2026-08-02：「我主要是不希望同质化很严重，同一种风格的是允许的，
//   但是每次生成给人感觉说这不是一样的吗，这就不行」
//
// ⚠️ 而 0.9.138 我把**底色 / 雾 / 灯光**写死了 —— 那三样正是"第一眼"看到的
//   东西 ⟹ 不放开的话每张壁纸都是"深蓝黑底 + 同一种打光"，必然像。
// ⟹ 判据：**锁"会坏的"，放"影响观感的"。**
check('骨架把环境（底色/雾/灯光/相机）交给模型，不锁死', () => {
  // ① 灯光装在 Group 里 ⟹ 模型一句话能换整套
  assert.match(rtNoComment, /const defaultLights = new THREE\.Group\(\)/,
    '默认灯光没装进 Group ⟹ 模型想换整套打光要逐个找出来删，那太麻烦'
    + '（而"麻烦"等于"它不会做" ⟹ 每张壁纸打光都一样）');
  // ② 而 ctx 要把它交出去 —— 不交的话模型拿不到、删不掉
  assert.match(rtNoComment, /defaultLights,/,
    'ctx 里没有 defaultLights ⟹ 模型拿不到那个 Group，换打光就得瞎猜名字');
  // ③⚠️ 这几样**必须**是"默认值"而不是"最终值" —— 断言它们在 build() 之前设，
  //   那样模型在 build() 里覆盖是有效的
  const bgAt = rtNoComment.indexOf('scene.background =');
  const buildAt = rtNoComment.indexOf('SCENE.build(ctx)');
  assert.ok(bgAt > 0 && buildAt > bgAt,
    '底色是在 SCENE.build() 之后设的 ⟹ 会把模型设的覆盖掉（那就真锁死了）');
});

OUT.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
