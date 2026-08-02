// AI 生成壁纸的**骨架运行时**。
//
// ⚠️⚠️⚠️ **模型不写这个文件。** 它是"稳定"的地基。
//
// 用户 2026-08-02：「我跟你说一句话你给过我，甚至让壁纸这张壁纸质量要高…
//   我们的第一要义就是我稳定生成高质量的壁纸」
// ⟹ 而实测证明"每次从空写整个 index.html"做不到稳定（三轮收敛出的是 300 行
//   canvas，而参考壁纸是作者 v1→v15 迭代出来的）。
// ⟹ 判据：**把"会坏的部分"写死、验过，让模型只填"变化的部分"。**
//   骨架管：WebGL 上下文、相机、渲染循环、限帧、resize、dpr、音频接线、
//           宿主接口、错误上报、参数读取
//   模型管：元素怎么摆、音频映射到什么、配色、运动规律（`scene.js` 里那几个函数）
//
// ⚠️ 这个文件里每一条 `⚠️` 都是这个项目**实测栽过**的坑，别删。

/* global THREE */
(() => {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════
  //  ⚠️ 诊断：所有异常都要能从终端和诊断报告里看到
  // ═══════════════════════════════════════════════════════════════════
  //
  // 用户 2026-08-02：「你其实不知道我 Mac 本地的情况，你就可以写写日志这种方式
  //   来获取更多有用的信息」
  // ⟹ 这一层的全部价值就是**别静默**。而这个项目为"注册成功但功能是死的"
  //   栽过七次 —— 每次都是因为中间某一段什么都不说。
  const DIAG = { started: Date.now(), frames: 0, audioFrames: 0, errors: [] };

  function say(kind, detail) {
    // ⚠️ console 会被宿主的 console-message 捞走（见 main.js 那段）⟹ 进终端 + 事件环
    console.log(`[skeleton] ${kind}${detail ? `: ${detail}` : ''}`);
    if (window.gw && window.gw.sendVideoStatus) {
      // ⚠️ 复用 video 那条通道 —— 主进程已经在听它、已经进诊断报告。
      //   ⚠️ 判据：别新造一个没人听的频道（这个项目为 `library-changed` 栽过）。
      try { window.gw.sendVideoStatus({ skeleton: true, kind, detail, at: Date.now() }); }
      catch { /* 宿主不在（浏览器里直开）⟹ 忽略 */ }
    }
  }

  function fatal(kind, detail) {
    DIAG.errors.push(`${kind}: ${detail}`);
    say(`❌ ${kind}`, detail);
    // ⚠️ 屏幕上也要说 —— 壁纸层没有 devtools 入口，而"黑屏"是所有失败的共同外观
    const box = document.getElementById('err');
    if (box) {
      box.textContent = `${kind}\n${detail}`;
      box.style.display = 'block';
    }
  }

  // ⚠️ 未捕获异常单独接：它比 console.error 更致命（整个脚本停在那里）
  window.addEventListener('error', (e) => {
    fatal('脚本异常', `${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    fatal('Promise 没接住', String((e.reason && e.reason.message) || e.reason));
  });

  // ═══════════════════════════════════════════════════════════════════
  //  ⚠️⚠️ WebGL：失败模式是**黑屏而日志干净**，所以每一步都要显式检查
  // ═══════════════════════════════════════════════════════════════════
  if (typeof THREE === 'undefined') {
    fatal('three.js 没加载', 'vendor/three.min.js 不在或者被拦了 —— 检查那个文件在不在壁纸目录里');
    return;
  }
  say('three.js 就绪', `r${THREE.REVISION}`);

  const canvas = document.getElementById('c');
  if (!canvas) { fatal('没有画布', '#c 不在（index.html 被改坏了）'); return; }

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      // ⚠️ `alpha: false` —— 壁纸铺满整屏，不需要透明，而关掉它省一次合成
      alpha: false,
      // ⚠️⚠️ `powerPreference: 'low-power'` —— 它是**常驻后台进程**。
      //   这个项目为"壁纸吃满 CPU"栽过一轮（用户报"手势不跟手了"）。
      powerPreference: 'low-power',
    });
  } catch (error) {
    fatal('WebGL 建不起来', `${error.message} —— 这台机器的驱动或者 Electron 的 GPU 进程有问题`);
    return;
  }
  // ⚠️ 构造成功不代表 context 真的活着 —— 显式问一次
  const gl = renderer.getContext();
  if (!gl) { fatal('WebGL context 是空的', 'renderer 建起来了但 getContext() 返回空'); return; }
  say('WebGL 就绪', `${gl.getParameter(gl.VERSION)} | ${gl.getParameter(gl.RENDERER)}`);

  // ⚠️⚠️ context 丢失要报 —— 它的症状也是黑屏，而它可能在跑了几小时之后才发生
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    fatal('WebGL context 丢了', '通常是 GPU 驱动重置或者显存不够 —— 换个壁纸看看');
  });

  // ═══════════════════════════════════════════════════════════════════
  //  尺寸 / dpr
  // ═══════════════════════════════════════════════════════════════════
  let W = 0;
  let H = 0;
  function resize() {
    // ⚠️ dpr 上限 2 —— 3 倍屏上按 3 渲染等于 2.25 倍像素量，对常驻进程不值得
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    renderer.setPixelRatio(dpr);
    renderer.setSize(W, H, false);
    if (camera) {
      camera.aspect = W / Math.max(1, H);
      camera.updateProjectionMatrix();
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  场景 / 相机 / 灯光
  // ═══════════════════════════════════════════════════════════════════
  //
  // ⚠️⚠️⚠️ **这些是"默认值"，不是"锁死的"** —— 模型可以在 `SCENE.build()` 里
  //   全部替换掉。用户 2026-08-02：
  //     「我主要是不希望同质化很严重，同一种风格的是允许的，但是每次生成
  //       给人感觉说这不是一样的吗，这就不行」
  //
  // ⚠️ 而我 0.9.138 把**底色 / 雾 / 灯光**写死了 —— 那三样正是"第一眼"
  //   看到的东西 ⟹ 不放开的话每张壁纸都是"深蓝黑底 + 同一种打光"，
  //   必然像。审计的时候才发现这条。
  //
  // ⟹ 判据：**锁"会坏的"，放"影响观感的"。**
  //   锁：限帧 / dpr / 音频算法 / 错误上报 / 宿主接线（坏了壁纸就废了，
  //       而它们没有"风格"可言）
  //   放：底色 / 雾 / 灯光 / 相机 / 布局 / 配色 / 运动（那是设计，不是地基）
  //
  // ⚠️ 骨架只保证这些东西**存在且合法**（相机的 aspect 会跟着 resize 更新、
  //   scene 一定有），不规定它们长什么样。
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 400);
  // 默认环境：一个能看的起点。⚠️ 模型该覆盖它 —— 不覆盖就会和别的壁纸像。
  scene.fog = new THREE.Fog(0x05060c, 30, 150);
  scene.background = new THREE.Color(0x05060c);
  // ⚠️ 默认灯光挂在一个 Group 里 ⟹ 模型想换整套打光时一句
  //   `ctx.scene.remove(ctx.defaultLights)` 就够，不用逐个找出来删。
  const defaultLights = new THREE.Group();
  defaultLights.add(new THREE.AmbientLight(0xffffff, 0.35));
  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.position.set(6, 14, 8);
  defaultLights.add(key);
  scene.add(defaultLights);

  // ═══════════════════════════════════════════════════════════════════
  //  ⚠️ 音频：宿主给 128 段，而这里做的三件事都是实测踩出来的
  // ═══════════════════════════════════════════════════════════════════
  const audio = {
    bass: 0, mid: 0, treble: 0,
    // ⚠️ `bins` 给模型用（想画频谱柱就需要逐段值）
    bins: new Array(64).fill(0),
    // ⚠️ "有没有收到过音频"是要观测的事实 —— 一直是 0 的话是宿主那边没开
    everGot: false,
  };

  if (window.wallpaperRegisterAudioListener) {
    window.wallpaperRegisterAudioListener((data) => {
      if (!data || !data.length) return;
      DIAG.audioFrames += 1;
      if (!audio.everGot) { audio.everGot = true; say('音频接上了', `${data.length} 段`); }
      // ⚠️ WE 给 128 个：左声道 0-63、右声道 64-127 ⟹ 取两声道平均
      const n = 64;
      let b = 0;
      let m = 0;
      let t = 0;
      for (let i = 0; i < n; i += 1) {
        const v = (data[i] + (data[i + n] || 0)) / 2;
        audio.bins[i] = v;
        if (i < 6) b += v;
        else if (i < 24) m += v;
        else t += v;
      }
      // ⚠️⚠️ 用 `Math.max` 累积峰值，**不能直接赋值** —— 音频回调比渲染帧快，
      //   直接赋值会让两帧之间的峰值被后一帧的低值抹掉（症状是"不跟音乐"）。
      audio.bass = Math.max(audio.bass, Math.min(1, b / 6));
      audio.mid = Math.max(audio.mid, Math.min(1, m / 18));
      audio.treble = Math.max(audio.treble, Math.min(1, t / 40));
    });
  }

  // 歌曲信息（模型想用就用）
  const track = { title: '', artist: '', thumbnail: '', primaryColor: null, playing: false };
  if (window.wallpaperRegisterMediaPropertiesListener) {
    window.wallpaperRegisterMediaPropertiesListener((p) => {
      track.title = (p && p.title) || '';
      track.artist = (p && p.artist) || '';
    });
  }
  if (window.wallpaperRegisterMediaThumbnailListener) {
    window.wallpaperRegisterMediaThumbnailListener((p) => {
      track.thumbnail = (p && p.thumbnail) || '';
      // ⚠️ WE 给的 primaryColor 是 "r g b" 三个 0..1 浮点，不是 #rrggbb
      if (p && p.primaryColor) {
        const m = String(p.primaryColor).trim().split(/\s+/).map(Number);
        if (m.length >= 3 && m.every(Number.isFinite)) track.primaryColor = m.slice(0, 3);
      }
    });
  }
  if (window.wallpaperRegisterMediaPlaybackListener) {
    window.wallpaperRegisterMediaPlaybackListener((pb) => {
      const PLAYING = (window.wallpaperMediaIntegration
        && window.wallpaperMediaIntegration.PLAYBACK_PLAYING) || 0;
      track.playing = pb && pb.state === PLAYING;
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  ⚠️ 鼠标：宿主注入的（壁纸层收不到原生事件）
  // ═══════════════════════════════════════════════════════════════════
  const pointer = { x: 0.5, y: 0.5, down: false, dragX: 0, dragY: 0 };
  let lastX = 0;
  let lastY = 0;
  window.addEventListener('mousedown', (e) => {
    pointer.down = true; lastX = e.clientX; lastY = e.clientY;
  });
  window.addEventListener('mouseup', () => { pointer.down = false; });
  window.addEventListener('mousemove', (e) => {
    pointer.x = e.clientX / Math.max(1, W);
    pointer.y = e.clientY / Math.max(1, H);
    // ⚠️⚠️ 拖拽必须靠 `e.buttons`（位掩码，1=左键）—— 宿主把"拖拽中的移动"
    //   注入成带 button 的 mouseMove，只看 mousemove 的话拖不动。
    const held = pointer.down || (e.buttons & 1) === 1;
    if (held) { pointer.dragX += e.clientX - lastX; pointer.dragY += e.clientY - lastY; }
    lastX = e.clientX; lastY = e.clientY;
  });

  // ═══════════════════════════════════════════════════════════════════
  //  ⚠️ 参数：WE 的 project.json 属性 → 模型的 opts
  // ═══════════════════════════════════════════════════════════════════
  const opts = Object.create(null);
  // 骨架自己要的两个（每张壁纸都有）
  opts.intensity = 1.0;      // 音频响应强度
  opts.speed = 1.0;          // 整体速度

  window.wallpaperPropertyListener = {
    applyUserProperties(props) {
      if (!props) return;
      let changed = 0;
      for (const [k, v] of Object.entries(props)) {
        if (!v || v.value === undefined) continue;
        // ⚠️ 颜色 WE 给的是 "r g b" 三个 0..1 浮点 ⟹ 转成数组，模型直接用
        if (typeof v.value === 'string' && /^[\d.]+\s+[\d.]+\s+[\d.]+$/.test(v.value)) {
          opts[k] = v.value.trim().split(/\s+/).map(Number);
        } else {
          opts[k] = v.value;
        }
        changed += 1;
      }
      say('参数更新', `${changed} 项`);
      // ⚠️⚠️ 让模型那边有机会重建（改"元素个数"这类参数必须重建）。
      //   ⚠️ 契约名只有**一个**：`SCENE.reconfig`。
      //     我第一版同时有 `SCENE.reconfig` 和 `window.SCENE_RECONFIG` 两个 ——
      //     那是两个名字一件事，而多出来的那个必然有一天没人实现
      //     （写这份参考实现时我就把它写成了空函数）。
      //   ⚠️ 判据：**同一件事只留一个入口。**
      //   ⚠️ 而它是**可选**的：不改元素个数的场景不需要重建。
      if (typeof SCENE.reconfig === 'function') {
        try { SCENE.reconfig(ctx); }
        catch (error) { fatal('场景重配失败', error.message); }
      }
    },
  };

  // ═══════════════════════════════════════════════════════════════════
  //  模型写的那部分：window.SCENE
  // ═══════════════════════════════════════════════════════════════════
  //
  // ⚠️⚠️ 契约就三个函数（`scene.js` 里）：
  //   SCENE.build(ctx)     建元素，把 Object3D 加进 ctx.scene
  //   SCENE.frame(ctx)     每帧更新（ctx.audio / ctx.t / ctx.dt / ctx.pointer）
  //   SCENE.layout(ctx)    可选：窗口尺寸变了要重排时
  //   SCENE.reconfig(ctx)  可选：参数变了要重建时（改"元素个数"这类）
  const SCENE = window.SCENE;
  if (!SCENE || typeof SCENE.build !== 'function' || typeof SCENE.frame !== 'function') {
    fatal('scene.js 没提供 SCENE', '要有 window.SCENE = { build(ctx), frame(ctx) }');
    return;
  }

  const ctx = {
    THREE, scene, camera, renderer, audio, track, pointer, opts,
    // ⚠️ 换整套打光时：`ctx.scene.remove(ctx.defaultLights)` 再加自己的
    defaultLights,
    t: 0, dt: 0, W: 0, H: 0,
    // ⚠️ 给模型一个能报错的口子 —— 否则它只能 console.log，而那不进诊断报告
    warn: (msg) => say('⚠️ 场景', String(msg)),
  };

  resize();
  ctx.W = W; ctx.H = H;
  try {
    SCENE.build(ctx);
  } catch (error) {
    fatal('场景建不起来', `${error.message}`);
    return;
  }
  say('场景建好了', `${scene.children.length} 个对象`);

  window.addEventListener('resize', () => {
    resize();
    ctx.W = W; ctx.H = H;
    if (typeof SCENE.layout === 'function') {
      try { SCENE.layout(ctx); } catch (error) { fatal('重排失败', error.message); }
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  //  ⚠️ 渲染循环：限帧 40fps
  // ═══════════════════════════════════════════════════════════════════
  //
  // 这个项目为"壁纸吃满 CPU"栽过一轮（`ctx.filter` 每秒 1.3G 像素，把手势推理
  // 挤死了，用户报「手势不跟手了」+「开摄像头也好慢」）。
  const MIN_DT = 1000 / 40;
  let last = 0;
  let frameErrors = 0;

  function loop(now) {
    requestAnimationFrame(loop);
    if (now - last < MIN_DT) return;
    // ⚠️ dt 上限 0.1s —— 切回前台时时间戳会跳一大步，不夹的话动画会瞬移
    ctx.dt = Math.min((now - last) / 1000, 0.1) * opts.speed;
    last = now;
    ctx.t += ctx.dt;
    DIAG.frames += 1;

    try {
      SCENE.frame(ctx);
    } catch (error) {
      frameErrors += 1;
      // ⚠️⚠️ 每帧都抛的话不能每帧都报 —— 那会把日志灌满、把主进程 IPC 堵死。
      //   ⟹ 只报前三次，然后停掉渲染（一个每帧抛异常的壁纸不该继续跑）。
      if (frameErrors <= 3) fatal('每帧更新出错', `第 ${frameErrors} 次：${error.message}`);
      if (frameErrors > 30) {
        fatal('场景持续报错，停止渲染', `已经 ${frameErrors} 帧了 —— 这张壁纸有 bug`);
        return;   // ⚠️ 不再 requestAnimationFrame ⟹ 循环真的停了
      }
    }

    renderer.render(scene, camera);

    // ⚠️ 音频衰减：没有新数据时慢慢回落，而不是卡在最后一帧的值
    audio.bass *= 0.92;
    audio.mid *= 0.92;
    audio.treble *= 0.90;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  ⚠️⚠️ 给"试跑探针"留的观测点（0.9.140）
  // ═══════════════════════════════════════════════════════════════════
  //
  // 生成一张壁纸之后，宿主会在一个隐藏窗口里跑它 3 秒，然后判"能不能用"。
  // ⚠️ 而那个探针**故意不挂 we-preload**（那样能测出"裸调宿主接口"的问题）
  //   ⟹ `window.wallpaperReady` 在它那里不存在 ⟹ 不能靠那个信号判就绪。
  //   ⟹ 判据：**"就绪"要问看得见的事实** —— WebGL context 在不在、
  //     场景里有没有东西。那两个不依赖任何 preload。
  //
  // ⚠️ 挂在 window 上是为了让探针的 `executeJavaScript` 能读到（它在主世界跑）。
  //   ⚠️ 而这**不是给第三方壁纸用的接口** —— 是我们自己骨架的内部观测点，
  //     所以不进 we-preload 的契约（那里只放 `wallpaper*`）。
  window.__dpScene = scene;
  window.__dpDiag = DIAG.errors;

  // ═══════════════════════════════════════════════════════════════════
  //  ⚠️ 就绪信号 + 自检
  // ═══════════════════════════════════════════════════════════════════
  if (window.wallpaperReady) window.wallpaperReady();
  requestAnimationFrame(loop);

  // ⚠️⚠️ **3 秒自检**：这是"跑起来了但什么都看不见"的唯一观测点。
  //   而那种失败在日志里完全干净（没报错、context 正常）⟹ 必须主动查。
  setTimeout(() => {
    const fps = DIAG.frames / ((Date.now() - DIAG.started) / 1000);
    const glErr = gl.getError();
    say('3 秒自检',
      `${DIAG.frames} 帧（约 ${fps.toFixed(1)}fps）`
      + ` | 音频 ${DIAG.audioFrames} 帧${audio.everGot ? '' : '（一次都没收到）'}`
      + ` | gl.getError=${glErr}`
      + ` | 场景 ${scene.children.length} 个对象`
      + ` | 画布 ${W}x${H} dpr=${renderer.getPixelRatio()}`);
    if (DIAG.frames === 0) fatal('一帧都没画', 'requestAnimationFrame 循环没跑起来');
    if (glErr !== 0) fatal('WebGL 报错', `gl.getError()=${glErr}（0 才是正常）`);
  }, 3000);
})();
