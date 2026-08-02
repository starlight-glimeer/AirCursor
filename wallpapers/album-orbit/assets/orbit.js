// 唱片环绕 —— 专辑封面排成同心圆环，鼠标拖拽 360° 转视角。
//
// ⚠️⚠️ **为什么是 canvas 2d 而不是 WebGL/three.js**
//
// 这个壁纸要做的事是"一堆矩形按 3D 位置排列 + 按深度排序画出来"——
// 那是 2d 变换够用的范围（每个封面是个正对镜头的 quad，不需要任意朝向）。
// 而 WebGL 在这个项目里是**又一个能静默失败的东西**：着色器编译失败、
// context 丢失、驱动差异，每一种的症状都是"黑屏"，而壁纸层没有 devtools 入口。
// ⟹ 用 2d。代价是没有真正的透视贴图，收益是失败模式只有"画错"没有"不画"。
//
// ⚠️ 而**没有网络请求、没有外部依赖** —— 壁纸跑在 file:// 下，
//   而且用户机器上可能没网。封面来自宿主给的 base64/本地路径，拿不到就画渐变。

(() => {
  'use strict';

  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d', { alpha: false });

  // ── 参数（WE 的 project.json 里那几个，用户能在面板上调）─────────
  // ⚠️ 默认值必须和 project.json 里的 value 一致 —— 不一致的话"没碰过滑块"
  //   和"碰过又调回去"表现不同，而那种不一致查起来很烦。
  const opts = {
    ringCount: 3,
    perRing: 14,
    autoSpin: 0.25,
    audioPush: 0.6,
    showTrack: true,
    accent: [0.33, 0.84, 0.98],
  };

  // ── 视角状态 ────────────────────────────────────────────
  // yaw/pitch 是拖拽改的，dist 是滚轮改的。
  let yaw = 0.35;
  let pitch = -0.22;
  let dist = 1.0;          // 1 = 基准距离，越小越近
  let spinning = true;     // 点击切换
  // ⚠️ 惯性：松手之后继续转一小会儿。没有它拖拽手感很"死"，
  //   而这是这个壁纸唯一的"手感"来源。
  let yawVel = 0;
  let pitchVel = 0;

  // ── 音频 ────────────────────────────────────────────────
  // ⚠️ WE 给的是 128 个 bin（左右声道各 64）。而我们只要三个粗粒度的量：
  //   低频推封面、中频转亮度、高频闪粒子 —— 那比"画 128 根柱子"更耐看。
  let bass = 0;
  let mid = 0;
  let treble = 0;

  // ── 歌曲信息 ────────────────────────────────────────────
  let artUrl = '';
  const artCache = new Map();   // url → HTMLImageElement（已 decode）

  // ── 鼠标 ────────────────────────────────────────────────
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  // ⚠️⚠️ **"有没有收到过鼠标事件"是一个要观测的事实**：
  //   如果一直是 false，说明「转发鼠标给壁纸」那个开关没开
  //   ⟹ 提示条一直留着；收到第一个事件就淡出。
  //   （不这么做的话用户看到"拖不动"，而分不清是壁纸不支持还是开关没开。）
  let sawMouse = false;

  // ═══════════════════════════════════════════════════════
  //  尺寸
  // ═══════════════════════════════════════════════════════
  let W = 0;
  let H = 0;
  let dpr = 1;

  function resize() {
    // ⚠️ 上限 2 —— Retina 上 devicePixelRatio 是 2，而 3 倍屏上按 3 渲染
    //   等于 2.25 倍像素量，对一个常驻后台的壁纸不值得。
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);

  // ═══════════════════════════════════════════════════════
  //  封面图：拿得到就用，拿不到画渐变
  // ═══════════════════════════════════════════════════════
  // ⚠️⚠️ **拿不到封面是常态，不是异常** —— 没在放歌、播放器不报封面、
  //   或者宿主那边取不到，都会走这条。所以"没有封面"必须有一个好看的样子，
  //   而不是一个空洞。
  function loadArt(url) {
    if (!url || artCache.has(url)) return;
    const img = new Image();
    // 先占位，避免同一个 url 反复 new Image（换歌时 listener 会连发几次）
    artCache.set(url, null);
    img.onload = () => artCache.set(url, img);
    img.onerror = () => artCache.set(url, false);   // false = 试过且失败
    img.src = url;
  }

  function artOf(url) {
    const v = artCache.get(url);
    return v instanceof HTMLImageElement ? v : null;
  }

  // ═══════════════════════════════════════════════════════
  //  卡片布局：同心圆环
  // ═══════════════════════════════════════════════════════
  // ⚠️ 布局只算一次（参数变了才重算）—— 每帧算 40+ 个卡片的极坐标是白费。
  let cards = [];

  function rebuild() {
    cards = [];
    const rings = Math.max(1, Math.round(opts.ringCount));
    const per = Math.max(4, Math.round(opts.perRing));
    for (let r = 0; r < rings; r += 1) {
      // 半径从内到外，越外的圈越大、越暗（伪深度）
      const radius = 0.9 + r * 0.72;
      // ⚠️ 每圈错开半个间距 —— 不错开的话所有圈的卡片在同一条辐射线上，
      //   转起来会看到"格栅"而不是"环绕"。
      const offset = (r % 2) * (Math.PI / per);
      // 圈越外，y 越低一点（碗状，不是平的）—— 平的看起来像贴纸
      const y = -0.18 + r * 0.14;
      for (let i = 0; i < per; i += 1) {
        const a = (i / per) * Math.PI * 2 + offset;
        cards.push({
          ring: r, idx: i,
          angle: a, radius, y,
          // 每张卡片一个固定的相位，让音频推动看起来不是整体缩放
          phase: (r * 7 + i * 13) % 360 / 360 * Math.PI * 2,
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  //  投影：把 (x, y, z) 变成屏幕坐标 + 缩放
  // ═══════════════════════════════════════════════════════
  // ⚠️ 这是整个壁纸唯一的"3D"部分，而它就是绕 Y 轴转 + 绕 X 轴俯仰 +
  //   一次透视除法。没有矩阵库，因为三行代码不值得一个依赖。
  function project(x, y, z) {
    // 绕 Y（yaw）
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const x1 = x * cy - z * sy;
    const z1 = x * sy + z * cy;
    // 绕 X（pitch）
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const y1 = y * cp - z1 * sp;
    const z2 = y * sp + z1 * cp;

    // 透视。⚠️ camZ 要比最外圈半径大足够多，否则卡片会穿到镜头背后
    //   ⟹ z2 + camZ 接近 0 ⟹ scale 爆炸成一整屏白块（那是最难看的失败）。
    const camZ = 4.6 * dist;
    const denom = z2 + camZ;
    if (denom < 0.25) return null;          // 背后的，不画
    const scale = 3.0 / denom;
    const base = Math.min(W, H);
    return {
      sx: W / 2 + x1 * scale * base * 0.30,
      sy: H / 2 + y1 * scale * base * 0.30,
      scale,
      depth: denom,
    };
  }

  // ═══════════════════════════════════════════════════════
  //  画一帧
  // ═══════════════════════════════════════════════════════
  let last = 0;
  // ⚠️⚠️ **降帧到 40fps**（不是 60）。这个项目为"壁纸吃满 CPU"栽过一轮：
  //   `ctx.filter = blur()` 每秒 1.3G 像素，把手势推理挤死了。
  //   而 40fps 对"缓慢旋转"完全够看，省下 1/3 的功耗。
  const MIN_DT = 1000 / 40;

  function accentStr(alpha) {
    const [r, g, b] = opts.accent;
    return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${alpha})`;
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (now - last < MIN_DT) return;
    const dt = Math.min((now - last) / 1000, 0.1);   // 上限 0.1s：切回前台时别跳
    last = now;

    // ── 视角更新 ──────────────────────────────
    if (spinning) yaw += opts.autoSpin * dt * 0.35;
    // 惯性衰减
    yaw += yawVel * dt;
    pitch += pitchVel * dt;
    yawVel *= 0.90;
    pitchVel *= 0.90;
    // ⚠️ pitch 要夹住 —— 越过 ±90° 会翻转（上下颠倒），而那看起来像 bug
    pitch = Math.max(-1.15, Math.min(0.55, pitch));

    // ── 底 ────────────────────────────────────
    // ⚠️ 不用 clearRect：alpha:false 的 canvas 清成透明会变黑，
    //   而我们要一个带渐变的底（纯黑太死）。
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0a0c14');
    g.addColorStop(0.55, '#06070b');
    g.addColorStop(1, '#04050a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // 中心光晕：跟着低频亮
    const glow = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.min(W, H) * 0.55);
    glow.addColorStop(0, accentStr(0.10 + bass * 0.16));
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // ── 卡片 ──────────────────────────────────
    const img = artOf(artUrl);
    const drawn = [];
    for (const c of cards) {
      // 音频推力：低频把卡片往外推一点，每张卡片相位不同 ⟹ 像波浪扫过
      const push = 1 + bass * opts.audioPush * 0.22 * Math.sin(c.phase + now / 900);
      const r = c.radius * push;
      const p = project(Math.cos(c.angle) * r, c.y, Math.sin(c.angle) * r);
      if (!p) continue;
      drawn.push({ c, p });
    }
    // ⚠️⚠️ **按深度从远到近排序** —— 不排的话近处的卡片会被远处的覆盖
    //   （画的顺序就是叠放顺序）。症状是"转到某个角度就穿模"。
    drawn.sort((a, b) => b.p.depth - a.p.depth);

    for (const { c, p } of drawn) {
      const size = p.scale * Math.min(W, H) * 0.085;
      // 远的暗、近的亮（雾）。⚠️ 也是"深度"的唯一视觉线索 —— 没有它整圈一样亮，
      // 看起来是平的。
      const fog = Math.max(0, Math.min(1, 1.35 - p.depth / (4.6 * dist) * 0.95));
      const alpha = 0.20 + fog * 0.80;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.sx, p.sy);

      const half = size / 2;
      if (img) {
        // ⚠️ 圆角：clip 一个 roundRect 再画图。
        //   `roundRect` 在 Electron 43（Chromium 130+）有，不用手搓路径。
        ctx.beginPath();
        ctx.roundRect(-half, -half, size, size, size * 0.14);
        ctx.clip();
        ctx.drawImage(img, -half, -half, size, size);
        // 顶部一道高光，让它像有厚度的卡片而不是贴图
        const hl = ctx.createLinearGradient(0, -half, 0, half);
        hl.addColorStop(0, 'rgba(255,255,255,.16)');
        hl.addColorStop(0.5, 'rgba(255,255,255,0)');
        ctx.fillStyle = hl;
        ctx.fillRect(-half, -half, size, size);
      } else {
        // 没封面：画一个带主色的渐变方块。⚠️ 每张卡片色相错开一点，
        //   否则一圈同色看起来像加载失败。
        const hue = (c.ring * 40 + c.idx * 9) % 60 - 30;
        ctx.beginPath();
        ctx.roundRect(-half, -half, size, size, size * 0.14);
        const cg = ctx.createLinearGradient(-half, -half, half, half);
        cg.addColorStop(0, accentStr(0.38 + mid * 0.30));
        cg.addColorStop(1, `hsla(${210 + hue},70%,${18 + fog * 14}%,.92)`);
        ctx.fillStyle = cg;
        ctx.fill();
      }
      ctx.restore();

      // 卡片边缘：一条极细的亮线，跟着中频。⚠️ 在 clip 外面画，
      // 否则会被圆角裁掉一半。
      ctx.save();
      ctx.globalAlpha = alpha * (0.25 + mid * 0.45);
      ctx.translate(p.sx, p.sy);
      ctx.beginPath();
      ctx.roundRect(-half, -half, size, size, size * 0.14);
      ctx.strokeStyle = accentStr(0.55);
      ctx.lineWidth = Math.max(0.5, p.scale * 0.7);
      ctx.stroke();
      ctx.restore();
    }

    // ── 高频粒子 ──────────────────────────────
    // ⚠️ 只在高频有能量时画 —— 常驻的话它就是一层噪点。
    if (treble > 0.04) {
      ctx.save();
      ctx.globalAlpha = Math.min(0.7, treble * 2.4);
      ctx.fillStyle = accentStr(0.9);
      const n = Math.round(18 + treble * 40);
      for (let i = 0; i < n; i += 1) {
        // ⚠️ 位置由 i 和时间决定（不是 Math.random）—— 随机的话粒子每帧
        //   跳到别处，看起来是雪花噪点而不是飘浮的尘。
        const t = now / 3000 + i * 0.7;
        const a = i * 2.399963;                       // 黄金角，分布均匀
        const rr = 0.6 + (i % 7) * 0.34;
        const p = project(Math.cos(a + t * 0.2) * rr, -0.5 + ((i * 0.13) % 1.4), Math.sin(a + t * 0.2) * rr);
        if (!p) continue;
        const s = Math.max(0.6, p.scale * 1.1);
        ctx.fillRect(p.sx, p.sy, s, s);
      }
      ctx.restore();
    }

    // 音频衰减：没有新数据时慢慢回落（而不是卡在最后一帧的值）
    bass *= 0.92;
    mid *= 0.92;
    treble *= 0.90;
  }

  // ═══════════════════════════════════════════════════════
  //  鼠标：拖拽 / 滚轮 / 点击
  // ═══════════════════════════════════════════════════════
  // ⚠️⚠️⚠️ **这里是这个壁纸和宿主的接口面** —— 它收到的事件是宿主用
  //   `sendInputEvent` 注入的（真鼠标在桌面上，壁纸层收不到原生事件）。
  //
  // ⚠️ 而**拖拽必须靠 `e.buttons`** 判断，不能只监听 mousemove：
  //   宿主把"拖拽中的移动"注入成带 button 的 mouseMove，页面这边表现为
  //   `mousemove` + `buttons === 1`。这正是 GestureWall 0.9.108 修的那件事
  //   （在那之前 drag 和 move 注入的一样，`buttons` 恒为 0 ⟹ 拖不动）。
  function noteMouse() {
    if (sawMouse) return;
    sawMouse = true;
    const hint = document.getElementById('hint');
    if (hint) hint.classList.remove('on');
  }

  window.addEventListener('mousedown', (e) => {
    noteMouse();
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    yawVel = 0;
    pitchVel = 0;
  });

  window.addEventListener('mouseup', () => { dragging = false; });

  window.addEventListener('mousemove', (e) => {
    noteMouse();
    // ⚠️ `buttons` 是位掩码：1=左键。而 `dragging` 那个标志也留着 ——
    //   两者任一成立就算拖拽，因为 mousedown 可能发生在壁纸拿到焦点之前。
    const held = dragging || (e.buttons & 1) === 1;
    if (!held) { lastX = e.clientX; lastY = e.clientY; return; }
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    const k = 0.006;
    yaw -= dx * k;
    pitch -= dy * k * 0.7;
    // 惯性：把这一帧的速度记下来
    yawVel = -dx * k * 12;
    pitchVel = -dy * k * 8;
  });

  window.addEventListener('wheel', (e) => {
    noteMouse();
    // ⚠️ deltaY 的量级在触控板和滚轮上差很多 ⟹ 用符号 + 固定步长，
    //   不用它的绝对值（否则触控板一下就拉到底）。
    dist *= e.deltaY > 0 ? 1.06 : 0.94;
    dist = Math.max(0.55, Math.min(2.2, dist));
  }, { passive: true });

  window.addEventListener('click', () => {
    noteMouse();
    spinning = !spinning;
  });

  // ═══════════════════════════════════════════════════════
  //  WE 接口
  // ═══════════════════════════════════════════════════════
  // ⚠️⚠️ 每一个都要 `if (window.xxx)` —— 这个壁纸也可能在浏览器里被打开
  //   （开发时直接 open index.html），那时这些全不存在。
  //   ⟹ 没有它们也要能跑（静止 + 无封面），而不是白屏报错。

  if (window.wallpaperRegisterAudioListener) {
    window.wallpaperRegisterAudioListener((data) => {
      if (!data || !data.length) return;
      // ⚠️ WE 给 128 个值：左声道 0-63、右声道 64-127，每声道从低频到高频。
      //   ⟹ 取两声道对应位置的平均，再分三段。
      const n = 64;
      let b = 0;
      let m = 0;
      let t = 0;
      for (let i = 0; i < n; i += 1) {
        const v = (data[i] + (data[i + n] || 0)) / 2;
        if (i < 6) b += v;
        else if (i < 24) m += v;
        else t += v;
      }
      // ⚠️ 取 max 而不是直接赋值 —— 音频回调比渲染帧快，直接赋值会让
      //   两帧之间的峰值被后一帧的低值抹掉（看起来像"不跟音乐"）。
      bass = Math.max(bass, Math.min(1, b / 6));
      mid = Math.max(mid, Math.min(1, m / 18));
      treble = Math.max(treble, Math.min(1, t / 40));
    });
  }

  if (window.wallpaperRegisterMediaPropertiesListener) {
    window.wallpaperRegisterMediaPropertiesListener((p) => {
      if (!opts.showTrack) return;
      const card = document.getElementById('track');
      const title = document.getElementById('title');
      const artist = document.getElementById('artist');
      const t = (p && p.title) || '';
      if (title) title.textContent = t || '—';
      if (artist) {
        artist.textContent = [(p && p.artist) || '', (p && p.albumTitle) || '']
          .filter(Boolean).join(' · ');
      }
      // ⚠️ 没歌名就把卡片收起来 —— 一张写着"—"的卡片是噪声。
      if (card) card.classList.toggle('on', !!t);
    });
  }

  if (window.wallpaperRegisterMediaThumbnailListener) {
    window.wallpaperRegisterMediaThumbnailListener((p) => {
      const url = (p && p.thumbnail) || '';
      if (!url) return;
      artUrl = url;
      loadArt(url);
      const el = document.getElementById('art');
      if (el) el.src = url;
      // ⚠️ 主色跟着封面走（宿主给了的话）—— 那是"这首歌的壁纸"而不是
      //   "一个固定配色的壁纸"，观感差别很大。
      if (p && p.primaryColor) {
        const m = String(p.primaryColor).trim().split(/\s+/).map(Number);
        if (m.length >= 3 && m.every((v) => Number.isFinite(v))) opts.accent = m.slice(0, 3);
      }
    });
  }

  if (window.wallpaperPropertyListener === undefined) {
    // ⚠️ 这个是**页面挂给宿主**的（方向和上面几个相反）。
    window.wallpaperPropertyListener = {
      applyUserProperties(props) {
        if (!props) return;
        const num = (k) => (props[k] && typeof props[k].value === 'number' ? props[k].value : null);
        const bool = (k) => (props[k] && typeof props[k].value === 'boolean' ? props[k].value : null);
        let relayout = false;
        const rc = num('ringCount');
        if (rc !== null && rc !== opts.ringCount) { opts.ringCount = rc; relayout = true; }
        const pr = num('perRing');
        if (pr !== null && pr !== opts.perRing) { opts.perRing = pr; relayout = true; }
        const as = num('autoSpin');
        if (as !== null) opts.autoSpin = as;
        const ap = num('audioPush');
        if (ap !== null) opts.audioPush = ap;
        const st = bool('showTrack');
        if (st !== null) {
          opts.showTrack = st;
          const card = document.getElementById('track');
          if (card && !st) card.classList.remove('on');
        }
        // ⚠️ 颜色 WE 给的是 "r g b" 三个 0..1 的浮点，不是 #rrggbb。
        if (props.accent && typeof props.accent.value === 'string') {
          const m = props.accent.value.trim().split(/\s+/).map(Number);
          if (m.length >= 3 && m.every((v) => Number.isFinite(v))) opts.accent = m.slice(0, 3);
        }
        // ⚠️ 只在真的变了时重算布局 —— 每次 applyUserProperties 都重算
        //   会让拖滑块时画面抖（宿主可能连发）。
        if (relayout) rebuild();
      },
    };
  }

  // ═══════════════════════════════════════════════════════
  //  启动
  // ═══════════════════════════════════════════════════════
  resize();
  rebuild();

  // ⚠️ 提示条：延迟 1.5 秒再出现，而且只在**还没收到鼠标事件**时。
  //   立刻出现的话每次装载都闪一下；而收到事件说明转发是通的、不需要提示。
  setTimeout(() => {
    if (!sawMouse) {
      const hint = document.getElementById('hint');
      if (hint) hint.classList.add('on');
    }
  }, 1500);

  // ⚠️ 告诉宿主"我起来了" —— 那是宿主判断"里面的 JS 活着"的唯一信号。
  if (window.wallpaperReady) window.wallpaperReady();

  requestAnimationFrame(frame);
})();
