// scene 类壁纸的渲染层（0.9.159）。
//
// ⚠️⚠️⚠️ 用户 2026-08-03：「你可以写好探针/日志，方便我给你更加准确具体的信息」
//   ⟹ 这个文件里**每一步都报**，而且报到三个地方：
//     ① `console` → 主进程的 `watchRendererErrors` 会捞走 ⟹ 进终端 + 诊断报告
//     ② 屏幕右上角那个诊断层 ⟹ 用户不用开 devtools 就能看到
//     ③ `window.__dpScene` ⟹ 探针（`probeWallpaperRuntime`）能读
//
// ⚠️ 判据：**壁纸层没有 devtools 入口，而"黑屏"是所有失败的共同外观。**
//   这个项目为"注册成功但功能是死的"栽过七次，每次都是因为中间某段什么都不说。
//
// ── 渲染模型 ──
//
// scene 是**2.5D 图层**：一堆带 Z 深度的平面，正交式地叠在一起，
// 而"会动"来自三处：
//   ① 视差（`parallaxDepth`）—— 鼠标/时间偏移，不同深度的图层错开
//   ② 图层自己的动画（WE 里叫 material animation，我们还没做）
//   ③ effect（shader）—— 还没做
//
// ⚠️ 所以第一版做的是 ①：那已经能让大部分 scene 壁纸"活起来"
//   （实测样本 B 的 41 个图层里，视差深度是它唯一的动态来源）。

(() => {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════
  //  诊断层
  // ═══════════════════════════════════════════════════════════════════
  const diagEl = document.getElementById('diag');
  const fatalEl = document.getElementById('fatal');
  const lines = [];
  let hasProblem = false;

  function paint() {
    if (!diagEl) return;
    diagEl.innerHTML = lines.join('\n');
    // ⚠️ 有问题就不淡出 —— 那是用户最需要看到它的时候
    if (!hasProblem) {
      setTimeout(() => diagEl.classList.add('fade'), 6000);
    } else {
      diagEl.classList.remove('fade');
    }
  }

  function say(text, cls) {
    const tag = cls ? `<span class="${cls}">${text}</span>` : text;
    lines.push(tag);
    if (lines.length > 14) lines.shift();
    console.log(`[scene] ${text.replace(/<[^>]*>/g, '')}`);
    paint();
  }
  function warn(text) {
    hasProblem = true;
    say(`⚠️ ${text}`, 'warn');
    console.warn(`[scene] ⚠️ ${text}`);
  }
  function fatal(title, detail) {
    hasProblem = true;
    say(`❌ ${title}`, 'bad');
    console.error(`[scene] ❌ ${title}：${detail}`);
    if (fatalEl) {
      fatalEl.textContent = `${title}\n\n${detail}`;
      fatalEl.style.display = 'block';
    }
  }

  // ⚠️ 未捕获异常单独接 —— 它比 console.error 更致命（整个脚本停在那里）
  window.addEventListener('error', (e) => {
    fatal('脚本异常', `${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    fatal('Promise 没接住', String((e.reason && e.reason.message) || e.reason));
  });

  // ═══════════════════════════════════════════════════════════════════
  //  WebGL
  // ═══════════════════════════════════════════════════════════════════
  if (typeof THREE === 'undefined') {
    fatal('three.js 没加载', 'vendor/three.r128.min.js 不在'
      + ' —— 跑一次 `npm run vendor`（它不在 git 里，589KB）');
    return;
  }
  say(`three.js r${THREE.REVISION}`);

  const canvas = document.getElementById('c');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  } catch (error) {
    fatal('WebGL 建不起来', `${error.message} —— 这台机器的 GPU 进程有问题`);
    return;
  }
  const gl = renderer.getContext();
  if (!gl) { fatal('WebGL context 是空的', 'renderer 建起来了但 getContext() 返回空'); return; }

  // ⚠️⚠️⚠️ **s3tc 扩展 —— 那是能直接吃 DXT 纹理的关键。**
  //   实测两个真实 scene 壁纸的纹理 30/34 是 DXT3。
  //   ⚠️ 而**没有它就得 CPU 解压**（那是几百毫秒到几秒的活）⟹ 先问一次。
  const s3tc = gl.getExtension('WEBGL_compressed_texture_s3tc')
    || gl.getExtension('MOZ_WEBGL_compressed_texture_s3tc')
    || gl.getExtension('WEBKIT_WEBGL_compressed_texture_s3tc');
  // ⚠️⚠️ 而**这一版用不到它** —— 实测 `.tex` 里存的是 PNG/JPEG（见 makeTexture）。
  //   ⟹ 留着这一行只是为了：哪天要支持裸 DXT 时，真机上有没有这个扩展是已知的。
  say(`s3tc 扩展${s3tc ? '可用' : '不可用'}（这一版用不到 —— 贴图存的是 PNG/JPEG）`);

  // ⚠️ context 丢失要报 —— 症状也是黑屏，而它可能几小时后才发生
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    fatal('WebGL context 丢了', '通常是 GPU 驱动重置或显存不够 —— 换个壁纸看看');
  });

  const scene = new THREE.Scene();
  // ⚠️⚠️ **正交相机** —— scene 类是 2.5D 图层叠加，用透视相机会让
  //   不同深度的图层大小不一致（那是"图层错位"的观感）。
  //   ⚠️ 判据：**2D 图层叠加要用正交投影**，视差靠**偏移**做而不是靠透视。
  let camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);

  let W = 0;
  let H = 0;
  // ⚠️ WE 的场景坐标系：原点在屏幕中心，单位是**像素**，Y 轴向上。
  //   而它的画布基准是壁纸的设计分辨率（一般 1920×1080）。
  let baseW = 1920;
  let baseH = 1080;

  // ⚠️⚠️ **相机偏移和缩放**（`scene.json` 的 `camera.eye` + `general.zoom`）——
  //   实测样本 B 的 eye 是 `(-103.6, 120.9)`，而我原来**整个忽略了它**
  //   ⟹ 画面整体偏了 104 像素（那在"大小不太对"里混着，很难单独看出来）。
  //   ⚠️ 样本 A 的 eye 是 (0,0) ⟹ 只看一个样本发现不了这条。
  const camOffset = { x: 0, y: 0 };
  let camZoom = 1;
  // ⚠️ 偏移被夹过要报出来 —— 那解释了"画面和 WE 里差几十像素"
  let camClamped = false;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    renderer.setPixelRatio(dpr);
    renderer.setSize(W, H, false);
    // ⚠️⚠️ **按"覆盖"缩放**（cover 而不是 contain）——
    //   壁纸铺满屏幕，宁可裁掉边缘也不要留黑边。
    //   ⚠️ 那和 `background-size: cover` 是同一个道理。
    // ⚠️ `camZoom` 来自 `general.zoom`（实测两个样本都是 1，但它是个真参数）
    const scale = Math.max(W / baseW, H / baseH) * camZoom;
    const halfW = W / 2 / scale;
    const halfH = H / 2 / scale;
    camera.left = -halfW;
    camera.right = halfW;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.updateProjectionMatrix();
    // ⚠️⚠️⚠️ **相机偏移要夹在"画布还盖满屏幕"的范围内。**
    //
    // ⚠️ `camera.eye` 已经是以画布中心为原点的（见 build 里那段判据）。
    // ⚠️⚠️ 而偏移会把可见范围推出画布：实测样本 B 的 eye.y=+121 会让
    //   上边界到 1201，而画布顶只到 1080、最大的背景层顶到 1111
    //   ⟹ 露 90 单位的黑边。
    //   ⟹ 判据：**壁纸铺满屏幕是硬需求，露黑边看起来像"坏了"** ——
    //     宁可少偏几十像素，也不要黑边。
    // ⚠️ 夹的范围 = 画布半宽/半高 减去 相机半宽/半高（若相机比画布还大就夹到 0）
    const maxOffX = Math.max(0, baseW / 2 - halfW);
    const maxOffY = Math.max(0, baseH / 2 - halfH);
    const ox = Math.max(-maxOffX, Math.min(maxOffX, camOffset.x));
    const oy = Math.max(-maxOffY, Math.min(maxOffY, camOffset.y));
    camClamped = (ox !== camOffset.x) || (oy !== camOffset.y);
    camera.position.set(ox, oy, 100);
    camera.lookAt(ox, oy, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  // ═══════════════════════════════════════════════════════════════════
  //  纹理
  // ═══════════════════════════════════════════════════════════════════

  const texCache = new Map();
  // ⚠️ 视频纹理的 <video> 元素 —— 3 秒自检要报"它到底在播没有"
  //   （自动播放被拦的症状是"那个图层是静止的第一帧"，而那不报错）
  const videoEls = [];

  // ⚠️⚠️⚠️ **纹理是 PNG / JPEG，不是 DXT。**
  //
  // ⚠️ `.tex` 头部的 `format` 字段说 DXT3，而**实际存储的 body 是 PNG**
  //   （实测：图层真正用到的 11 张贴图里 10 张是 PNG、1 张 JPEG）。
  //   ⟹ 判据：**头部声明的格式说的是"解出来之后是什么"，不是"存储时是什么"。**
  //   ⚠️ 我第一版按 DXT + s3tc 扩展上传 ⟹ 一张都传不上去（画面全黑），
  //     而 `format: DXT3` 会让人一直往"DXT 上传"那个方向查。
  //
  // ⟹ 所以走 `createImageBitmap` —— 浏览器自己解 PNG/JPEG，
  //   而它是**异步**的 ⟹ 图层要等图解完才有内容（见 build() 里 await 那处）。
  // ⚠️ 好处：不需要 s3tc 扩展、不需要 LZ4 解压、不需要 DXT 解码器。
  async function makeTexture(info) {
    if (texCache.has(info.name)) return texCache.get(info.name);
    try {
      const bytes = info.data instanceof Uint8Array
        ? info.data : new Uint8Array(info.data);

      // ──⚠️⚠️⚠️ **三种输入**（0.9.160）：主进程已经把 232 张 `.tex` 归成三类。
      //   ⚠️ 上一版只认 PNG/JPEG ⟹ **放弃了 3/4 的贴图**
      //     （实测 DXT+LZ4 就占 74 张）—— 那就是"有几张壁纸只画出一两个图层"的原因。

      // ① 已经解好的 RGBA 缓冲（DXT / R8 / RG88 / RGBA8888 都归这里）
      if (info.kind === 'rgba') {
        const tex = new THREE.DataTexture(bytes, info.width, info.height, THREE.RGBAFormat);
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        // ⚠️⚠️ **DataTexture 的 flipY 默认是 false**（和 CanvasTexture 相反）——
        //   而我们的 RGBA 是按"第一行在上"存的（DXT 解码就是那个顺序）
        //   ⟹ 要显式翻，否则这些图层上下颠倒**而 PNG 那些是正的**
        //     （又一次"一半正一半反"，和 flipY 对 ImageBitmap 无效那次同一个形状）。
        tex.flipY = true;
        tex.needsUpdate = true;
        texCache.set(info.name, tex);
        return tex;
      }

      // ② 视频纹理（WE 的 format=34：一个图层的内容是一段 MP4）
      if (info.kind === 'video') {
        const blob = new Blob([bytes], { type: info.mime || 'video/mp4' });
        const el = document.createElement('video');
        el.src = URL.createObjectURL(blob);
        el.loop = true;
        el.muted = true;          // ⚠️ 壁纸不该出声（而且不静音自动播放会被拦）
        el.playsInline = true;
        el.autoplay = true;
        // ⚠️ 等第一帧 —— 没有它 VideoTexture 头几帧是黑的
        await new Promise((done) => {
          let settled = false;
          const go = () => { if (!settled) { settled = true; done(); } };
          el.addEventListener('loadeddata', go, { once: true });
          el.addEventListener('error', go, { once: true });
          setTimeout(go, 3000);   // ⚠️ 超时也放行（宁可黑一下也不要卡住整个装载）
        });
        el.play().catch(() => { /* 自动播放被拦：下面会报出来 */ });
        const tex = new THREE.VideoTexture(el);
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        videoEls.push({ el, name: info.name });
        texCache.set(info.name, tex);
        return tex;
      }

      // ③ PNG / JPEG：浏览器自己解
      const mime = info.mime || (info.container === 'JPEG' ? 'image/jpeg' : 'image/png');
      // ⚠️⚠️⚠️ **`imageOrientation: 'flipY'` 必须在这里给**（0.9.159 用户实测）。
      //
      // ⚠️ `texture.flipY` 对 **ImageBitmap 无效** —— three 是靠
      //   `gl.pixelStorei(UNPACK_FLIP_Y_WEBGL, texture.flipY)` 实现翻转的，
      //   而 WebGL 规范说那个 pack 参数**对 ImageBitmap 源不起作用**
      //   （它只作用于 `<img>` / `<canvas>` / ArrayBuffer 那些）。
      //   ⟹ 所以翻转要在**创建位图的时候**做。
      //
      // ⚠️⚠️ 而这个 bug 的形状很有代表性：**文字是正的、图层是反的** ——
      //   因为文字走 `CanvasTexture(canvas)`（flipY 生效），
      //   图层走 `CanvasTexture(ImageBitmap)`（flipY 被忽略）。
      //   ⟹ 判据：**同一个属性在不同的纹理源上行为不同** ——
      //     "这个属性我设过了"不等于"它生效了"。
      //     而"一半正一半反"这个症状恰好指向了那条分界线。
      const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }),
        { imageOrientation: 'flipY' });
      const tex = new THREE.CanvasTexture(bitmap);
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      // ⚠️ 大图要 mipmap —— 一张 5760×2880 缩到 1920 宽不生成 mipmap 会闪
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      texCache.set(info.name, tex);
      return tex;
    } catch (error) {
      // ⚠️ 解码失败要带上尺寸和容器 —— 那让"是不是这张图坏了"能一眼判断
      warn(`${short(info.name)} 解码失败（${info.container} `
        + `${info.width}×${info.height}）：${error.message}`);
      return null;
    }
  }

  function short(name) {
    return String(name).replace(/^.*\//, '');
  }

  // ═══════════════════════════════════════════════════════════════════
  //  建场景
  // ═══════════════════════════════════════════════════════════════════

  // ⚠️⚠️⚠️ `colorBlendMode` —— **非 0 一律走加色**（0.9.161，9 张壁纸实测）
  //
  // ⚠️ 用户实测报「一块黑色遮挡了大部分画面」：那是 `ripple1440p`
  //   （1547×870、`colorBlendMode=9`）被当普通不透明画了。
  //
  // ⚠️⚠️ 而 WE 没公开这个枚举，我拿不到"9 到底是哪种混合"的权威答案。
  //   ⟹ 所以量了一个**能验证的相关性**：
  //     mode ≠ 0 的图层，它的贴图有没有 alpha 通道？
  //       mode 0：108 层，只有 12% 没 alpha
  //       mode 6：1 层，100% 没 alpha
  //       mode 9：1 层，100% 没 alpha
  //       mode 31：2 层，100% 没 alpha
  //     ⟹ **非 0 的那些几乎都没有 alpha** —— 那说明它们靠"混合模式产生透明"
  //       （加色/滤色那类：黑色部分自然消失，不需要 alpha 通道）。
  //   ⟹ 判据：**枚举拿不到时，量"这些值出现在什么样的数据上"** ——
  //     那能定出"该走哪一类混合"，即使定不出"具体是哪一个"。
  //
  // ⚠️ 而加色比普通混合**保守**：猜错的话画面偏亮（能看出是效果不对），
  //   而普通混合猜错是**一整块实心色盖住画面**（那看起来像坏了）。
  //   ⟹ 两种错法里选症状轻的那个。
  // ⚠️⚠️ 见到的值照样报出来 —— 哪天有人看到"某个光效偏亮"，那个数就是线索。
  const seenBlendModes = new Set();
  function blendingFor(mode) {
    if (!mode) return THREE.NormalBlending;
    seenBlendModes.add(mode);
    return THREE.AdditiveBlending;
  }

  // ⚠️ 只有"非有限"才走默认 —— 0 是合法值（见下面 color 那段）
  function num(v, dflt) {
    return Number.isFinite(v) ? v : dflt;
  }

  // 视差目标（鼠标位置，-1..1）
  const parallax = { x: 0, y: 0, tx: 0, ty: 0 };
  // 相机视差（general.cameraparallax）—— 见 build() 里那段
  const cameraParallax = { on: false, gain: 0, ease: 0.06 };
  // 音频柱（Simple_Audio_Bars）—— 逐帧重绘
  const barUnits = [];
  // ⚠️ 最近一帧频谱。128 段（左 64 + 右 64 镜像，见 audio-bins.js）
  let spectrum = null;
  let audioFrames = 0;
  // ⚠️ 没有音频时的替代频谱 —— 画成一排很低的柱子（"在但没声音"），
  //   而不是空白（那和"坏了"分不清）
  const SILENT_SPECTRUM = new Array(128).fill(0.02);
  const layers = [];
  let built = null;

  // ═══════════════════════════════════════════════════════════════════
  //  ⚠️⚠️⚠️ **音频柱**（`Simple_Audio_Bars`）
  // ═══════════════════════════════════════════════════════════════════
  //
  // ⚠️⚠️⚠️ **这两个函数必须在 `build()` 外面** —— 用户实测栽在这里：
  //   我原来把它们写在 `build()` 里面，而渲染循环（`loop()`）在外面
  //   ⟹ 屏幕上刷「Uncaught ReferenceError: drawBars is not defined」，
  //     而它**每帧都抛一次**（那张图上叠了十几个错误框）。
  //   ⚠️ 而 `node --check` 是绿的：函数声明本身没问题，
  //     是"谁能看见谁"错了 —— 那要到**真的跑起来**才暴露。
  //   ⟹ 判据：**逐帧循环调的东西，作用域必须和循环同级或更外**。
  //     `build()` 是一次性的装载函数，把每帧要用的东西定义在它里面
  //     等于"只有装载那一刻能看见"。
  //
  // ⚠️ 那是 shader 里唯一一个我们能还原的 —— 它的参数是**完全声明式**的
  //   （Bar Count / Spacing / Bounds / Color），而我们**已经有 WE 那套 128 段频谱**。
  //   ⟹ 用 canvas 按参数逐帧画，不用编译它的 `.frag`。
  // ⚠️⚠️ 实测两个样本各有 1 / 3 处 ⟹ 它是音乐可视化壁纸的主要视觉元素，
  //   而这也是**这一版唯一会随音乐动的东西**。
  function makeBarsTexture(o) {
    const b = o.audioBars;
    const boxW = Math.max(64, Math.abs(o.size[0]) || 512);
    const boxH = Math.max(64, Math.abs(o.size[1]) || 256);
    const cv = document.createElement('canvas');
    // ⚠️ 柱子是硬边，不用超采样那么多；而太大会拖慢逐帧重绘
    cv.width = Math.min(2048, Math.round(boxW));
    cv.height = Math.min(1024, Math.round(boxH));
    const ctx = cv.getContext('2d');
    const tex = new THREE.CanvasTexture(cv);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    return { tex, cv, ctx, bars: b };
  }

  // ⚠️ 逐帧重绘一个音频柱
  function drawBars(unit, sp) {
    const { cv, ctx, bars: b } = unit;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const n = b.count;
    const slot = cv.width / n;
    const barW = slot * (1 - b.spacing);
    // ⚠️⚠️ **128 段是左 64 + 右 64（镜像）** —— 那是这个项目逆向 WE 时
    //   烧掉十一轮才定的事实（见 audio-bins.js）。
    //   ⟹ 取左声道那 64 段，按柱子数重采样。
    const half = Math.max(1, Math.floor(sp.length / 2));
    ctx.fillStyle = `rgb(${Math.round(b.color[0] * 255)},`
      + `${Math.round(b.color[1] * 255)},${Math.round(b.color[2] * 255)})`;
    ctx.globalAlpha = b.alpha;
    for (let i = 0; i < n; i += 1) {
      // ⚠️ 重采样：n 个柱子摊到 half 段上
      const lo = Math.floor((i / n) * half);
      const hi = Math.max(lo + 1, Math.floor(((i + 1) / n) * half));
      let v = 0;
      for (let k = lo; k < hi && k < sp.length; k += 1) v = Math.max(v, sp[k] || 0);
      // ⚠️ 高度 = lower..upper 之间（占对象高度的比例）
      const frac = b.lower + Math.max(0, Math.min(1, v)) * (b.upper - b.lower);
      const h = frac * cv.height;
      const x = i * slot + (slot - barW) / 2;
      ctx.fillRect(x, cv.height - h, barW, h);
    }
    ctx.globalAlpha = 1;
    unit.tex.needsUpdate = true;
  }

  async function build(payload) {
    // ── 底色
    // ⚠️ `general.clearcolor` 是 "r g b" 三个 0..1 浮点（不是 hex）
    const cc = payload.general && payload.general.clearcolor;
    if (typeof cc === 'string') {
      const p = cc.trim().split(/\s+/).map(Number);
      if (p.length >= 3 && p.every(Number.isFinite)) {
        scene.background = new THREE.Color(p[0], p[1], p[2]);
      }
    }
    if (!scene.background) scene.background = new THREE.Color(0x05060c);

    // ──⚠️⚠️ **相机视差**（`general.cameraparallax`）
    //
    // ⚠️ 那是 WE 的一个**全局**效果：鼠标动 → 整个相机偏移 →
    //   不同 Z 深度的图层错开。它和图层自己的 `parallaxDepth` 是**两件事**，
    //   而实测样本 B 开了它（amount 0.5 / mouseinfluence 0.5 / delay 0.1）。
    // ⚠️⚠️ 而这是我们目前**唯一能忠实还原的动态来源** ——
    //   实测样本 A 的 8 个可见对象 `parallaxDepth` 全是 0、动态全在 effect 里
    //   ⟹ 它会是一张静止的图，而那正是我批评过 OWE 的那个形状。
    //   ⟹ 所以要在诊断里**说清这张壁纸的动态从哪来**，别让"静止"变成无解的谜。
    const g = payload.general || {};
    const camPar = {
      on: g.cameraparallax === true || (g.cameraparallax && g.cameraparallax.value === true),
      amount: Number(g.cameraparallaxamount) || 0,
      influence: Number(g.cameraparallaxmouseinfluence),
      // ⚠️ delay 是"跟随的迟滞"，0..1 ⟹ 越大越黏（我们用它算插值系数）
      delay: Number(g.cameraparallaxdelay) || 0,
    };
    if (!Number.isFinite(camPar.influence)) camPar.influence = 1;
    cameraParallax.on = camPar.on;
    cameraParallax.gain = camPar.amount * camPar.influence;
    // ⚠️ delay 越大 → 跟得越慢。0.1 → 0.09、0.9 → 0.01（经验映射，不是 WE 的公式）
    cameraParallax.ease = Math.max(0.01, 0.1 * (1 - camPar.delay));

    // ⚠️⚠️ **动态来源盘点** —— 那是"为什么这张壁纸不动"的直接答案
    const nParallax = (payload.objects || [])
      .filter((o) => o.worldVisible && (o.parallaxDepth[0] || o.parallaxDepth[1])).length;
    const srcs = [];
    if (camPar.on) srcs.push(`相机视差（幅度 ${camPar.amount}）`);
    if (nParallax > 0) srcs.push(`${nParallax} 个图层有视差深度`);
    const shaderN = (payload.renderability && payload.renderability.shaderMissN) || 0;
    if (srcs.length) {
      say(`动态来源：${srcs.join(' + ')}（都跟鼠标/手势）`, 'ok');
    } else if (shaderN > 0) {
      // ⚠️⚠️⚠️ 这一条是**最要紧的诚实**：这张壁纸的动态全在我们做不了的 shader 里
      say(`⚠️ 这张壁纸没有视差，它的动态全在 ${shaderN} 个 shader 效果里`
        + ' ⟹ 我们画出来会是**静止的图**', 'warn');
      hasProblem = true;
    } else {
      say('⚠️ 这张 scene 没有任何我们能还原的动态来源 ⟹ 会是静止的', 'warn');
      hasProblem = true;
    }

    // ── 画布
    // ⚠️⚠️ **读出来的**（`general.orthogonalprojection`），实测两个样本都是 3840×2160。
    //   ⚠️ 我第一版从最大图层反推 ⟹ 样本 B 最大图层是 5760×2880（故意做得比画布大，
    //     留给视差移动的余量）⟹ 反推出来大 1.5 倍 ⟹ 整个画面缩到 2/3、四周露黑边。
    //   ⟹ 判据：**能直接读到的事实不要反推。**
    if (payload.canvas && payload.canvas.width > 0) {
      baseW = payload.canvas.width;
      baseH = payload.canvas.height;
      say(`画布 ${baseW}×${baseH}（${payload.canvas.source}）`);
    } else {
      warn(`拿不到画布尺寸，用默认 ${baseW}×${baseH}`);
    }
    // ──⚠️⚠️ **相机**（`camera.eye` + `general.zoom`）
    //   ⚠️ 实测样本 B 的 eye 是 (-103.6, 120.9) —— 我原来整个忽略了它
    //     ⟹ 画面整体偏 104 像素。而样本 A 是 (0,0) ⟹ 只看一个样本发现不了。
    const eye = (payload.camera && payload.camera.eye) || null;
    if (typeof eye === 'string') {
      const e = eye.trim().split(/\s+/).map(Number);
      if (e.length >= 2 && e.every(Number.isFinite)) {
        // ⚠️⚠️⚠️ **`camera.eye` 已经是以画布中心为原点的** —— 不要再减半宽半高。
        //
        // ⚠️ 我上一版照 `origin` 的模式减了 `baseW/2` ⟹ **整个画面被推到右上角**
        //   （用户截图：图只占屏幕右上，左边和下边全黑）。
        // ⚠️⚠️ 判据（这次是怎么坐实的）：样本 A 的 `eye` 是 `(0, 0)`，
        //   而它的画面是**居中**的（抽 preview.gif 首帧核过）。
        //   ⟹ 若 eye 是"画布像素坐标（原点左下）"，(0,0) 就意味着相机在左下角
        //     ⟹ 画面会只剩右上 1/4 —— 那正好是这次的症状。
        //   ⟹ 所以 eye 和 origin **不在同一个坐标空间**。
        // ⟹ 判据：**同一个文件里的两个坐标字段可以有不同的原点** ——
        //   "这个字段是画布像素坐标"是从 origin 那里推广过来的，而推广没有依据。
        //   ⚠️ 而它**只有一个样本能证伪**（样本 A 的 0,0 恰好是"默认值正确"，
        //     样本 B 的偏移量小到看不出是不是差了半个画布）
        //     ⟹ 两个样本都要过一遍才敢说。
        camOffset.x = e[0];
        camOffset.y = e[1];
        if (camOffset.x || camOffset.y) {
          // ⚠️⚠️⚠️ **偏移要夹住** —— 否则可见范围会越出"有内容"的区域露黑边。
          //   ⚠️ 实测样本 B：eye.y=+121，而相机可见上边界到 1201，
          //     最大的背景层上边只到 1111 ⟹ **差 90 单位露黑边**。
          //   ⚠️⚠️ 而图层的尺寸是按**画布**做的（背景 4444×2222 vs 画布 3840×2160，
          //     那 1.15 倍是留给视差移动的余量，不是留给相机偏移的）。
          //   ⟹ 判据：**壁纸铺满屏幕是硬需求，露黑边看起来像"坏了"** ——
          //     一个不该看到的黑边比"相机偏移少了几十像素"严重得多。
          //   ⟹ 所以按"画布必须盖满可见范围"夹住它（见 resize 里的 clamp）。
          say(`相机偏移 (${camOffset.x.toFixed(0)}, ${camOffset.y.toFixed(0)})`);
        }
      }
    }
    const z = Number((payload.general || {}).zoom);
    if (Number.isFinite(z) && z > 0 && z !== 1) {
      camZoom = z;
      say(`相机缩放 ${z}`);
    }
    resize();

    // ── 纹理
    // ⚠️⚠️ **并发解码** —— 一张 5760×2880 的 JPEG 要几十毫秒，
    //   串行解 11 张会让首帧晚半秒以上（那段时间画面是黑的）。
    const texByName = new Map();
    const list = payload.textures || [];
    const decoded = await Promise.all(list.map((t) => makeTexture(t)));
    for (let i = 0; i < list.length; i += 1) {
      if (decoded[i]) texByName.set(list[i].name, decoded[i]);
    }
    say(`纹理 ${texByName.size}/${list.length} 张解码成功`,
      texByName.size === list.length ? 'ok' : 'warn');

    // ──⚠️⚠️ 字体
    //
    // ⚠️ 实测两种引用：`systemfont_arial`（系统字体）和 `fonts/xxx.ttf`（包里的）。
    //   样本 B 用了 26 种包里的字体，合计 75MB。
    // ⚠️⚠️ 包里的走 `FontFace` + `document.fonts.add` ——
    //   那是**异步**的，而字要等字体就位才能画（否则回退成默认字体，
    //   而"字体不对"看起来像"这张壁纸本来就这样"）。
    const fontFamilies = new Map();
    const fontJobs = [];
    for (const f of payload.fonts || []) {
      // ⚠️ 字体族名不能带 `/` 和空格里的怪字符 ⟹ 用一个稳定的替身名
      const family = `dpfont${fontFamilies.size}`;
      fontFamilies.set(f.name, family);
      const bytes = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
      try {
        const face = new FontFace(family, bytes.buffer.slice(
          bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        fontJobs.push(face.load().then((loaded) => {
          document.fonts.add(loaded);
          return { ok: true, name: f.name };
        }).catch((error) => ({ ok: false, name: f.name, error: error.message })));
      } catch (error) {
        fontJobs.push(Promise.resolve({ ok: false, name: f.name, error: error.message }));
      }
    }

    // ⚠️ 系统字体：`systemfont_arial` → CSS 字体族。
    //   ⚠️ macOS 上没有 Consolas ⟹ 要给中西文都能用的回退链，
    //     否则中文字变成豆腐块（□□□），而那种失败**不报错**。
    function cssFamily(font) {
      if (!font) return '"PingFang SC", "Helvetica Neue", sans-serif';
      if (fontFamilies.has(font)) {
        return `"${fontFamilies.get(font)}", "PingFang SC", sans-serif`;
      }
      const m = /^systemfont_(.+)$/.exec(font);
      const base = m ? m[1] : font;
      // ⚠️ 回退链里**一定要有中文字体** —— 实测文字里有「凌晨」「壁纸引擎」这类
      return `"${base}", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`;
    }

    // ⚠️⚠️⚠️ **把文字画成纹理**（canvas → THREE.CanvasTexture）
    //
    // ⚠️ 为什么不用 SDF / troika：那要另加一个依赖，而 scene 的文字是**静态排版**
    //   （没有逐字动画）⟹ canvas 画一次就够，缩放靠 dpr 补。
    // ⚠️⚠️ 而 `size` 字段是**排版框**（实测「Now playing ...」是 728×149），
    //   不是字的实际宽高 ⟹ 用它当平面尺寸，字在框里按 align 摆。
    function makeTextTexture(o) {
      const text = String(o.text == null ? '' : o.text);
      if (!text.trim()) return null;   // ⚠️ 空串不画（实测 13 个）
      const boxW = Math.max(1, Math.abs(o.size[0]) || 512);
      const boxH = Math.max(1, Math.abs(o.size[1]) || 128);
      // ⚠️ 超采样 —— canvas 纹理放到 4K 画布上会糊
      const ss = 2;
      const cv = document.createElement('canvas');
      cv.width = Math.min(4096, Math.round(boxW * ss));
      cv.height = Math.min(4096, Math.round(boxH * ss));
      const ctx = cv.getContext('2d');
      if (!ctx) return null;
      const px = (o.pointSize || 32) * ss * 2.2;
      // ⚠️ `pointsize` 实测是 22-33，而排版框有 121-197 高 ⟹ 那不是像素高。
      //   ⚠️⚠️ 这个 2.2 的系数是**估的** —— 真机上如果字明显偏大/偏小，
      //     那就是它。⟹ 所以把算出来的值报到诊断里（见下面那条 log）。
      ctx.font = `${px}px ${cssFamily(o.font)}`;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';   // ⚠️ 白色 —— 颜色靠材质的 color 乘上去
      const lines = text.split('\n');
      const lineH = px * 1.25;
      const totalH = lineH * lines.length;
      let y0;
      if (o.vAlign === 'top') y0 = lineH / 2;
      else if (o.vAlign === 'bottom') y0 = cv.height - totalH + lineH / 2;
      else y0 = (cv.height - totalH) / 2 + lineH / 2;
      for (let i = 0; i < lines.length; i += 1) {
        const w = ctx.measureText(lines[i]).width;
        let x;
        if (o.hAlign === 'left') x = 0;
        else if (o.hAlign === 'right') x = cv.width - w;
        else x = (cv.width - w) / 2;
        ctx.fillText(lines[i], x, y0 + i * lineH);
      }
      const tex = new THREE.CanvasTexture(cv);
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      return tex;
    }

    // ── 图层 + 文字
    // ⚠️⚠️ 按 Z 排序 —— scene.json 里的顺序**不保证**是叠放顺序，
    //   而 origin 的 Z 才是。⚠️ 漏了排序的症状是"图层前后颠倒"。
    // ⚠️ 文字和图层**在同一个队列里排** —— 它们互相遮挡（实测样本 B 的
    //   文字压在图层上面），分两趟画会让顺序错。
    // ⚠️⚠️⚠️ 用 `worldVisible` 而**不是** `visible` ——
    //   前者含"祖先也可见"。实测样本 A：70 个自己 visible，但正确该画的只有 **8** 个
    //   （5 套非英语语言 + 备用时钟皮肤挂在 visible=false 的父节点下）。
    //   ⚠️ 抽 preview.gif 首帧核对过：背景 + 涟漪 + 03:33 + 日期 + PM + 3 条频谱 = 8。
    //   ⟹ 用 `visible` 会把 6 种语言的字叠在一起。
    // ⚠️ 而 `worldPos` 是摊平后的世界坐标（子对象的 origin 是相对父的）
    const drawable = (payload.objects || [])
      .filter((o) => (o.kind === 'image' || o.kind === 'text') && o.worldVisible)
      .sort((a, b) => (a.worldPos[2] || 0) - (b.worldPos[2] || 0));

    let made = 0;
    let noTex = 0;
    let madeText = 0;
    let emptyText = 0;
    // ⚠️ 合成层没贴图是**预期之内**（不是失败）⟹ 单独计数
    let composNoTex = 0;
    for (const o of drawable) {
      let tex;
      let barUnit = null;
      // ⚠️⚠️ 音频柱**替代**那张贴图 —— 原版是 shader 在贴图上画柱子，
      //   而那张贴图本身通常是空白/渐变（实测 Bar 1 的贴图是 1920×1080 的底）。
      //   ⟹ 直接画柱子比"贴图 + 一个画不了的 shader"更接近原版。
      if (o.audioBars) {
        barUnit = makeBarsTexture(o);
        tex = barUnit.tex;
      } else if (o.kind === 'text') {
        tex = makeTextTexture(o);
        // ⚠️ 空串不算失败（实测 13 个空文字对象 —— 那是模板留的占位）
        if (!tex) { emptyText += 1; continue; }
        madeText += 1;
      } else {
        // ⚠️⚠️⚠️ `o.image` **不是**贴图路径 —— 它指向一个 model JSON，
        //   真贴图要走 `model → material → materials/<裸名>.tex`。
        //   ⟹ 主进程解好那条链，这里查它给的映射表。
        //   ⚠️ 值是 `null` 表示"合成层"（WE 内置模型，本来没有贴图）。
        const texPath = (payload.texByImageRef || {})[o.image];
        tex = texPath ? texByName.get(texPath) : null;
        if (!tex) {
          if (texPath === null) composNoTex += 1;   // 合成层：预期之内
          else noTex += 1;
          continue;
        }
      }
      const w = Math.abs(o.size[0]) || baseW;
      const h = Math.abs(o.size[1]) || baseH;
      const geo = new THREE.PlaneGeometry(w, h);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        // ⚠️⚠️ 透明度 = 对象自己的 alpha **×** 折进来的 opacity effect
        //   （实测样本 B 有 10 个 opacity effect，其中「歌手名」α=0.20 ——
        //    漏了它那行字会比设计的显眼 5 倍）
        opacity: (Number.isFinite(o.alpha) ? o.alpha : 1) * (o.fx ? o.fx.alpha : 1),
        blending: blendingFor(o.blendMode),
        // ⚠️ 图层要能互相遮挡，但**不写深度** —— 那让透明区域不会挡住后面的
        depthTest: false,
        depthWrite: false,
        // ⚠️⚠️ `color` 是**染色**（乘上去的），而 brightness 也是乘 ——
        //   两个要合起来，否则亮度调整不起作用
        // ⚠️⚠️ 颜色 = 对象 color × brightness × 折进来的 tint effect
        //   ⚠️ 而 `color` 的分量可以**合法地是 0**（纯黑染色）
        //     ⟹ 不能写 `o.color[0] || 1`（那会把 0 变成 1）。
        //     ⟹ 判据：**`|| 默认值` 对"0 是合法值"的字段是错的。**
        color: new THREE.Color(
          num(o.color[0], 1) * num(o.brightness, 1) * (o.fx ? o.fx.color[0] : 1),
          num(o.color[1], 1) * num(o.brightness, 1) * (o.fx ? o.fx.color[1] : 1),
          num(o.color[2], 1) * num(o.brightness, 1) * (o.fx ? o.fx.color[2] : 1),
        ),
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      // ⚠️ WE 的 Y 轴向上（抽 preview 首帧核对过：y 越大越靠上），
      //   而 `worldPos` 已经是"画布中心为原点"的坐标 ⟹ 直接用
      mesh.position.set(o.worldPos[0], o.worldPos[1], o.worldPos[2]);
      // ⚠️ angles 是度数（不是弧度）
      const d2r = Math.PI / 180;
      const wa = o.worldAngles || o.angles;
      mesh.rotation.set(wa[0] * d2r, wa[1] * d2r, wa[2] * d2r);
      const ws = o.worldScale || o.scale;
      mesh.scale.set(ws[0] || 1, ws[1] || 1, 1);
      // ⚠️⚠️ `renderOrder` 按 Z ——`depthTest: false` 之后，
      //   叠放顺序**只由 renderOrder 决定**（那是这一层最容易错的地方）
      mesh.renderOrder = made;
      scene.add(mesh);
      layers.push({
        mesh,
        home: [o.worldPos[0], o.worldPos[1], o.worldPos[2]],
        // ⚠️ 视差深度：那是"会动"的主要来源
        depth: [o.parallaxDepth[0] || 0, o.parallaxDepth[1] || 0],
        name: o.name,
        // ⚠️ 文字对象留着 —— 字体异步就位之后要拿它重画
        textObj: o.kind === 'text' ? o : null,
        // ⚠️ 音频柱要逐帧重绘 ⟹ 存在循环里能拿到的地方
        barUnit,
      });
      if (barUnit) barUnits.push(barUnit);
      made += 1;
    }
    // ⚠️⚠️⚠️ **和主进程对账** —— 它算过"预计会画多少"，
    //   而两个数不一致就是这一层出了问题（预计 18 实际 0 = 纹理解码全失败）。
    //   ⚠️ 那种失败**不报错**：图层建不起来只是 `continue` 一下。
    //   ⟹ 判据：**跨进程的链路，两端的计数要能对上，对不上要自己喊。**
    const want = payload.willDraw;
    const wantN = want ? want.image + want.text + want.audioBars : null;
    const gotImg = made - madeText - barUnits.length;
    say(`已建 ${made} 个（图层 ${gotImg} · 文字 ${madeText} · 音频柱 ${barUnits.length}）`
      + `，可见对象 ${drawable.length} 个`
      + (wantN !== null ? ` · 主进程预计 ${wantN} 个` : ''),
    made > 0 ? 'ok' : 'bad');
    if (wantN !== null && made !== wantN) {
      warn(`对不上账：主进程预计 ${wantN} 个`
        + `（图层 ${want.image} / 文字 ${want.text} / 柱 ${want.audioBars}）`
        + `，这边实际建了 ${made} 个（图层 ${gotImg} / 文字 ${madeText} / 柱 ${barUnits.length}）`
        + ' ⟹ 差的那些是在渲染层丢的（纹理解码 / 文字排版）');
    }
    if (noTex > 0) warn(`${noTex} 个图层的纹理没上传成功 ⟹ 画不出来`);
    // ⚠️⚠️ 合成层要**说清是预期之内** —— 否则 14 个正常现象看起来像 14 个 bug
    if (composNoTex > 0) {
      const kinds = (payload.diag && payload.diag.compositeKinds) || [];
      say(`${composNoTex} 个合成层没画（${kinds.join(' / ') || 'composelayer'}）`
        + ' —— WE 内置模型、本来没有贴图，它的画面来自下层 + effect');
    }
    if (emptyText > 0) say(`${emptyText} 个空文字（模板占位，不画）`);
    // ⚠️⚠️ 字体是**异步**加载的 ⟹ 字先用回退字体画出来了，
    //   等字体就位要**重画**（否则字体永远是回退的，而那不报错）。
    if (fontJobs.length) {
      Promise.all(fontJobs).then((rs) => {
        const okN = rs.filter((r) => r.ok).length;
        const bad = rs.filter((r) => !r.ok);
        say(`字体 ${okN}/${rs.length} 个加载成功`, okN === rs.length ? 'ok' : 'warn');
        if (bad.length) {
          // ⚠️⚠️⚠️ **这类失败通常是那张字体自己不合规范，不是我们读坏的。**
          //   实测 `迷你简综艺.ttf`：Chromium 的 OTS 报
          //     「cmap: Out of order end range (59299 <= 59299)」
          //   ⟹ 我把它的 cmap format 4 子表逐段解出来核过：
          //     3710 段里有 **8 段** endCode 不是严格递增（59299 后面又是 59299）
          //     ⟹ 那是**字体作者的问题**，规范要求严格递增。
          //   ⚠️ 而字节是完好的（魔数 0x00010000、24 个字体全部合法）——
          //     所以不是解包/切片出错。
          //   ⟹ 判据：**第三方内容不合规范时，要说清"这不是我们的 bug"** ——
          //     否则用户（和下一个我）会去查一个查不出结果的方向。
          //   ⚠️ 而它**不致命**：那几段字回退成系统字体，画面照样有内容。
          warn(`${bad.length} 个字体被浏览器拒了（那是字体本身不合规范，`
            + '不是我们读坏的 —— 那几段字会回退成系统字体）：'
            + `${bad.slice(0, 3).map((b) => `${short(b.name)}(${b.error})`).join(' / ')}`);
        }
        // ⚠️ 重画那些用了包内字体的文字
        let redrawn = 0;
        for (const L of layers) {
          if (!L.textObj || !fontFamilies.has(L.textObj.font)) continue;
          const t = makeTextTexture(L.textObj);
          if (!t) continue;
          const old = L.mesh.material.map;
          L.mesh.material.map = t;
          L.mesh.material.needsUpdate = true;
          if (old) old.dispose();
          redrawn += 1;
        }
        if (redrawn) say(`字体就位后重画了 ${redrawn} 段文字`);
      });
    }

    // ⚠️ 见到的混合模式要报（那是"光效偏亮/偏暗"的唯一线索）
    if (seenBlendModes.size) {
      say(`colorBlendMode = ${[...seenBlendModes].join(' / ')} 的图层按**加色**画`
        + '（实测非 0 的那些贴图都没有 alpha ⟹ 靠混合产生透明；'
        + '若某图层偏亮，线索在这个数）');
    }

    // ── 还没做的那些，要说清
    const cap = payload.renderability;
    if (cap && cap.missN > 0) {
      say(`还画不了：${cap.missing.join(' / ')}`, 'warn');
      hasProblem = true;
    }
    // ⚠️⚠️⚠️ **shader effect 的缺口要单独说** —— 实测样本 A 的 8 个可见对象
    //   视差深度**全是 0**，动态**全靠 effect**（水波纹/音频柱/抖动）。
    //   ⟹ 不说这一句，用户看到的是一张静止的图而以为是我们没画出来。
    if (cap && cap.shaderMissN > 0) {
      say(`⚠️ ${cap.shaderMissN} 个 shader 效果做不了`
        + `（${(cap.shaderMissing || []).slice(0, 6).join(' / ')}）`
        + ' ⟹ 那些元素是静止的', 'warn');
      hasProblem = true;
    }
    if (cap && cap.effectsFolded > 0) {
      say(`${cap.effectsFolded} 个 tint/opacity 效果已折进材质`);
    }
    if (payload.diag && payload.diag.boundFields > 0) {
      // ⚠️ 那解释了"时钟不走 / 皮肤切不了"——静态值只是默认值
      say(`${payload.diag.boundFields} 个字段是用户属性/脚本驱动的`
        + '（我们只用它们的静态默认值 ⟹ 时钟这类不会走）');
    }
    if (payload.diag && payload.diag.skipped > 0) {
      warn(`${payload.diag.skipped} 个不认识的对象（跳过了）`);
    }

    // ⚠️⚠️ 一个图层都没建起来 = 黑屏 ⟹ 那是致命的，要在屏幕中间说
    if (made === 0) {
      fatal('一个图层都没画出来',
        `这张 scene 有 ${drawable.length} 个可见对象，但没有一个能画：\n`
        + `· 纹理上传成功 ${texByName.size}/${(payload.textures || []).length} 张\n`
        + (s3tc ? '' : '· ⚠️ 这台机器没有 s3tc 扩展 ⟹ DXT 纹理全部画不了\n')
        + '\n把终端里 [scene] 开头的那些行发给开发者。');
    }

    built = payload;
    // ⚠️ 探针要读的观测点（`probeWallpaperRuntime` 走 executeJavaScript）
    window.__dpScene = scene;
    window.__dpSceneInfo = {
      layers: made,
      texts: madeText,
      audioBars: barUnits.length,
      fonts: (payload.fonts || []).length,
      boundFields: (payload.diag && payload.diag.boundFields) || 0,
      textures: texByName.size,
      texturesWanted: (payload.textures || []).length,
      s3tc: !!s3tc,
      baseW,
      baseH,
      renderability: cap || null,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  IPC
  // ═══════════════════════════════════════════════════════════════════
  if (!window.gw || !window.gw.onSceneData) {
    fatal('拿不到 IPC 通道', 'window.gw.onSceneData 不在'
      + ' —— preload 没挂上（那是我们这边的 bug，不是壁纸的问题）');
    return;
  }
  window.gw.onSceneData((payload) => {
    try {
      say(`收到场景：${(payload.objects || []).length} 个对象 · `
        + `${(payload.textures || []).length} 张纹理`, 'ok');
      // ⚠️ build 是 async（纹理解码要 await）⟹ 异常要在 .catch 里接，
      //   而不是靠外面那个 try（那个接不到 async 里抛的）
      build(payload).then(() => {
        // ⚠️ 走 `gw.wallpaperReady`（我们自己的 preload）——
        //   `window.wallpaperReady` 是 `we-preload.js` 才有的，
        //   在这里判它等于永远不报（那让面板一直显示"还没报 ready"）。
        if (window.gw.wallpaperReady) window.gw.wallpaperReady();
      }).catch((error) => {
        fatal('建场景时抛异常', `${error.message}\n${(error.stack || '').split('\n')[1] || ''}`);
      });
    } catch (error) {
      fatal('建场景时抛异常', `${error.message}\n${(error.stack || '').split('\n')[1] || ''}`);
    }
  });
  if (window.gw.onSceneError) {
    window.gw.onSceneError((e) => {
      fatal(`主进程那边失败了：${e.step}`, e.detail);
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  音频 → 柱子
  // ═══════════════════════════════════════════════════════════════════
  //
  // ⚠️ 走**裸的** `we-audio` 通道（128 段），不是面板那个 `we-audio-frame`
  //   （那是每半秒一次的抽样诊断数据 ⟹ 拿它驱动柱子会是 2fps 的抖动）。
  if (window.gw.onWeAudio) {
    window.gw.onWeAudio((frame) => {
      // ⚠️ 载荷形状要防一手 —— 实测是数组，但万一改了格式，
      //   "静默不动"比报错难查得多
      if (Array.isArray(frame)) spectrum = frame;
      else if (frame && Array.isArray(frame.data)) spectrum = frame.data;
      else if (audioFrames === 0) {
        warn(`音频帧不是数组（是 ${typeof frame}）⟹ 柱子不会动`);
      }
      audioFrames += 1;
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  鼠标 → 视差
  // ═══════════════════════════════════════════════════════════════════
  //
  // ⚠️ 壁纸层收不到原生鼠标事件 —— 靠 `mouse-bridge` 注入（见那个文件）。
  //   ⟹ 这里监听的是**注入进来的**事件，和 web 类壁纸走同一条通道。
  window.addEventListener('mousemove', (e) => {
    parallax.tx = (e.clientX / Math.max(1, W)) * 2 - 1;
    parallax.ty = (e.clientY / Math.max(1, H)) * 2 - 1;
  });

  // ═══════════════════════════════════════════════════════════════════
  //  渲染循环
  // ═══════════════════════════════════════════════════════════════════
  //
  // ⚠️ 限帧 40 —— 壁纸是常驻后台进程。这个项目为"壁纸吃满 CPU"栽过一轮
  //   （用户报「手势不跟手了」+「开摄像头也好慢」）。
  const MIN_DT = 1000 / 40;
  let last = 0;
  let frames = 0;
  const startedAt = Date.now();

  function loop(now) {
    requestAnimationFrame(loop);
    if (now - last < MIN_DT) return;
    last = now;
    frames += 1;

    // ⚠️ 视差要**平滑跟随**，不是直接跳 —— 直接赋值会让图层抖
    const ease = cameraParallax.on ? cameraParallax.ease : 0.06;
    parallax.x += (parallax.tx - parallax.x) * ease;
    parallax.y += (parallax.ty - parallax.y) * ease;

    for (const L of layers) {
      // ⚠️⚠️ 两个独立的量叠加：
      //   ① 图层自己的 `parallaxDepth`（实测样本 B 有 11 个图层有）
      //   ② `general.cameraparallax` —— 全局的，按图层的 **Z 深度**错开
      // ⚠️ 偏移量按**画布尺寸**算（不是屏幕）⟹ 不同分辨率下幅度一致
      let dx = -parallax.x * L.depth[0] * baseW * 0.06;
      let dy = parallax.y * L.depth[1] * baseH * 0.06;
      if (cameraParallax.on) {
        // ⚠️ Z 归一化到画布的一个尺度 —— 那让"远的动得少"
        const z = L.home[2] / baseH;
        dx += -parallax.x * cameraParallax.gain * baseW * 0.02 * (1 + z);
        dy += parallax.y * cameraParallax.gain * baseH * 0.02 * (1 + z);
      }
      L.mesh.position.x = L.home[0] + dx;
      L.mesh.position.y = L.home[1] + dy;
    }

    // ⚠️ 音频柱逐帧重绘。⚠️⚠️ 没有频谱时**也要画**（画成静止的低柱），
    //   否则"没音乐"和"通道断了"看起来一样（都是空白）。
    if (barUnits.length) {
      const sp = spectrum || SILENT_SPECTRUM;
      for (const u of barUnits) drawBars(u, sp);
    }

    renderer.render(scene, camera);
  }
  requestAnimationFrame(loop);

  // ⚠️⚠️ **3 秒自检** —— 那是"跑起来了但什么都看不见"的唯一观测点，
  //   而那种失败在日志里完全干净（没报错、context 正常）。
  setTimeout(() => {
    const fps = frames / ((Date.now() - startedAt) / 1000);
    const glErr = gl.getError();
    say(`3 秒自检：${frames} 帧（约 ${fps.toFixed(1)}fps）· `
      + `gl.getError=${glErr} · 场景 ${scene.children.length} 个对象 · `
      + `画布 ${W}×${H}`);
    // ⚠️⚠️ 音频柱在不在、动没动，要分开报 —— "柱子不动"有两个原因
    //   （没在放音乐 / 通道断了），而它们的下一步动作完全不同。
    if (barUnits.length) {
      say(`音频柱 ${barUnits.length} 个 · 收到 ${audioFrames} 帧频谱`
        + (audioFrames === 0
          ? '（⟹ 柱子是静止的：没在放音乐，或者设置里音源没开）' : ''),
      audioFrames > 0 ? 'ok' : 'warn');
      if (audioFrames === 0) hasProblem = true;
      if (!window.gw.onWeAudio) warn('gw.onWeAudio 不在 ⟹ preload 没挂音频通道');
    }
    // ⚠️ 相机偏移被夹过要报 —— 那解释了"画面和 WE 里差几十像素"
    if (camClamped) {
      say(`相机偏移被夹住了（原 ${camOffset.x.toFixed(0)},${camOffset.y.toFixed(0)}）`
        + ' —— 不夹会露黑边，宁可少偏几十像素');
    }
    // ⚠️⚠️ 视频纹理要报**在播没有** —— 自动播放被拦的症状是"那个图层是静止的
    //   第一帧"，而那看起来像"这个图层本来就是静态的"。
    if (videoEls.length) {
      const playing = videoEls.filter((v) => !v.el.paused && v.el.currentTime > 0).length;
      say(`视频纹理 ${videoEls.length} 个 · 在播 ${playing} 个`
        + (playing < videoEls.length
          ? '（⚠️ 没在播的那些：自动播放被拦或者解码失败 ⟹ 会停在第一帧）' : ''),
      playing === videoEls.length ? 'ok' : 'warn');
      if (playing < videoEls.length) hasProblem = true;
    }
    if (frames === 0) fatal('一帧都没画', 'requestAnimationFrame 循环没跑起来');
    if (glErr !== 0) fatal('WebGL 报错', `gl.getError()=${glErr}（0 才是正常）`);
    if (built && layers.length === 0) {
      warn('场景收到了但一个图层都没有 ⟹ 看上面的纹理报告');
    }
    // ⚠️ 探针要能读到这些
    window.__dpDiag = lines.map((l) => l.replace(/<[^>]*>/g, ''));
  }, 3000);
})();
