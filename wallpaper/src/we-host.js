// Wallpaper Engine 网页壁纸的宿主逻辑：解析 project.json、翻译属性、校验音频帧。
//
// 为什么单独一层：WE 的接口契约有几处不直观（属性要包 {value:}、音频固定 128 段、
// 属性方向是反的），错了全都是**静默失败** —— 壁纸照样显示，只是永远收不到数据。
// 把契约做成纯函数，才能在没有 Electron、没有 macOS、没有那个壁纸的情况下守住它们。
//
// 这些结论是从样本 bundle（音域回响 / workshop 3747222633）里扒出来的，不是文档 ——
// WE 没有公开的宿主端规范。所以每条都在注释里写了证据。
(function (root) {

// 只在 Node 里有。浏览器窗口加载这个文件时用不到 resolveAsset（那是主进程的事），
// 所以拿不到 path 模块不算错误。
const nodePath = typeof require === 'function' ? require('node:path') : null;

// WE 给壁纸的音频是固定 128 段 FFT。
//
// 证据：样本的 setWallpaperAudioData 里 `const t = e.length || 128`，然后重采样到 512：
//   for (let n = 0; n < 512; n++) { const r = Math.floor(n * t / 512); ... }
// 长度不对不会报错 —— 只会让整个频谱错位，柱子的形状看起来"就是这样"。
const AUDIO_BINS = 128;

// 壁纸内部把 128 段分成 8 个频段（索引是重采样到 512 之后的）。
// 低频驱动波纹、高频驱动流星，这是它视觉效果的来源。
// 证据：`Pe<=6?h+=ce:Pe<=18?d+=ce:...:Pe<=300&&(M+=ce)`
const BANDS = [6, 18, 35, 60, 95, 145, 210, 300];

// project.json 里 type 是 "text" 的项是分隔标题（sep_render_title 那些），不是配置。
const DECORATIVE_TYPES = new Set(['text']);

// WE 一共四种壁纸类型（实测 project.json 的取值，不是猜的）。
//
// 每种的处置和理由：
const TYPES = {
  // 就是 HTML+JS。用户要的"交互式 2D/3D 场景"落在这里（样本用 React+Three.js+GLSL）。
  web: { support: 'full', label: '交互网页' },
  // mp4/webm。一个 <video loop muted> 的事。
  video: { support: 'full', label: '视频' },
  // ⚠️ WE 编辑器的原生格式：私有 PKGV 归档 + TEXV 纹理 + 它自己方言的 GLSL。
  // 不支持，而且**明确说出来比画一张静止的图好** —— 静止的图看起来像坏了。
  //
  // 证据（读 Open Wallpaper Engine 的代码，5 项）：粒子函数定义 1 处调用 0 处、
  // 零 shader、零动画代码、加色层直接 skip、DXT 纹理 return nil。
  // ⟹ 连专门做这件事的开源项目都只画静态底图。
  // 唯一真做了 Scene 渲染的是 linux-wallpaperengine（C++/OpenGL），
  // 移植评估在 aicursor-helper/scene-wallpaper-feasibility.md。
  scene: { support: 'none', label: '场景（WE 编辑器格式）' },
  // 别人编译的 Windows .exe。跑不了也不该跑（用户已明确不做）。
  application: { support: 'none', label: 'Windows 程序' },
};

// GIF 壁纸不是独立类型 —— WE 把它包成 scene，入口文件叫 gifscene.json。
// ⚠️ 这条是查出来的，不是猜的（OWE 的 SceneWallpaperViewModel:49 那行注释）。
// 单独认出来是因为它**可能是 scene 里最简单的一种**（一张会动的图，
// 大概不需要粒子和 shader），将来做 scene 时它是最划算的切入点。
function isGifScene(file) {
  return /^gifscene\./i.test(String(file || ''));
}

// 解析 project.json，取出我们需要的那几样。
function parseProject(json) {
  if (!json || typeof json !== 'object') return null;
  const type = String(json.type || '').toLowerCase();
  const general = json.general || {};
  const spec = TYPES[type] || null;
  const file = json.file || 'index.html';
  return {
    type,
    // 认识但不支持 vs 完全没见过 —— 前者能给出理由，后者只能说"不认识"。
    known: !!spec,
    typeLabel: spec ? spec.label : `未知类型 ${type || '(空)'}`,
    gifScene: type === 'scene' && isGifScene(file),
    supported: !!spec && spec.support === 'full',
    title: json.title || json.name || '未命名壁纸',
    file,
    preview: json.preview || null,
    // 壁纸自己声明要不要音频。没声明就不用费劲去抓系统音频（那要屏幕录制权限）。
    // ⚠️ 外层的 !! 是必须的：`false || undefined` 求值成 undefined 而不是 false，
    // 而这个字段要过 IPC 并被拿去做判断，undefined 和 false 在 JSON 里不是一回事
    // （undefined 会整个键消失）。
    wantsAudio: !!(general.supportsaudioprocessing === true
      || (json.audio && json.audio.enabled === true)),
    properties: general.properties || {},
  };
}

// 把 project.json 的 properties 变成能直接喂给 applyUserProperties 的对象。
//
// ⚠️ 关键在于**保留 {value: …} 那层包装**，不要平铺。
// 证据（样本 bundle）：
//   ((Ns = We.gridSize) == null ? void 0 : Ns.value) !== void 0 && Y(We.gridSize.value)
// 它读的是 props.gridSize.value。平铺发过去，41 项全被判成 undefined，壁纸静默用默认值 ——
// 表现是"我改了配置没反应"，而不是报错。
//
// 所以这个函数几乎是恒等的，只剥掉装饰项。它存在的价值不是转换，是把
// "不要平铺"这件事变成一条有测试守着的契约。
function userProperties(properties, overrides) {
  const out = {};
  for (const [key, spec] of Object.entries(properties || {})) {
    if (!spec || typeof spec !== 'object') continue;
    if (DECORATIVE_TYPES.has(spec.type)) continue;
    const value = overrides && key in overrides ? overrides[key] : spec.value;
    if (value === undefined) continue;
    out[key] = { value };
  }
  return out;
}

// applyGeneralProperties 的形状和上面**不一样** —— 它是平的。
// 证据：`Ux = Tt => { Tt.fps !== void 0 && t(Tt.fps) }`，直接读 .fps 没有 .value。
// 两个接口一个包一个不包，这正是必须写下来的那种不对称。
function generalProperties(fps) {
  return { fps: Number.isFinite(fps) && fps > 0 ? fps : 30 };
}

// 把 project.json 的一项翻译成我们面板能渲染的控件描述。
//
// 这让"支持任意 WE 网页壁纸"成为可能：配置面板从 project.json 自动生成，
// 而不是给每个壁纸手写一遍 UI。
function controlsOf(properties) {
  const list = [];
  for (const [key, spec] of Object.entries(properties || {})) {
    if (!spec || typeof spec !== 'object') continue;
    if (DECORATIVE_TYPES.has(spec.type)) continue;
    const control = {
      key,
      type: spec.type || 'slider',
      // text 是双语的（"音频响应强度 / Audio Intensity"），取中文那半。
      label: String(spec.text || key).split('/')[0].trim() || key,
      value: spec.value,
      order: Number.isFinite(spec.order) ? spec.order : 0,
    };
    if (spec.type === 'slider') {
      control.min = Number.isFinite(spec.min) ? spec.min : 0;
      control.max = Number.isFinite(spec.max) ? spec.max : 1;
      control.step = Number.isFinite(spec.step) ? spec.step : 0.1;
    }
    if (spec.type === 'combo' && Array.isArray(spec.options)) {
      control.options = spec.options.map((o) => ({
        label: String(o.label || o.value).split('/')[0].trim(),
        value: o.value,
      }));
    }
    list.push(control);
  }
  return list.sort((a, b) => a.order - b.order);
}

// 校验并规整一帧音频，返回长度正好 AUDIO_BINS 的数组。
//
// 为什么要这一层：这条链的失败模式全是静默的。没授权拿到的是**全 0**，不是错误 ——
// 而全 0 的画面看起来就是"音频响应坏了"。长度不对则频谱错位，看起来"就是这个效果"。
// 所以宁可在入口把形状锁死，并且让"全 0"变成一个能被上层看见的事实（silent 标志）。
function normalizeAudioFrame(frame) {
  const out = new Array(AUDIO_BINS).fill(0);
  if (!frame || typeof frame.length !== 'number' || frame.length === 0) {
    return { data: out, ok: false, silent: true, reason: 'empty' };
  }
  let peak = 0;
  for (let i = 0; i < AUDIO_BINS; i += 1) {
    // 源长度不等于 128 时按比例重采样，而不是截断或填 0：截断会把高频整段丢掉，
    // 而高频正是流星效果的触发源。
    const src = frame.length === AUDIO_BINS
      ? i
      : Math.floor(i * frame.length / AUDIO_BINS);
    const v = Number(frame[src]);
    // NaN/Infinity 喂进 shader 会让整块画面变黑，比丢一帧糟得多。
    const safe = Number.isFinite(v) ? Math.max(0, v) : 0;
    out[i] = safe;
    if (safe > peak) peak = safe;
  }
  return {
    data: out,
    ok: true,
    // 全 0 是"没授权 / 没在放歌"的signature，不是一个正常的安静瞬间。
    // 上层拿这个决定要不要在面板上报状态。
    silent: peak <= 0,
    peak,
    resampled: frame.length !== AUDIO_BINS,
  };
}

// media 回调的四种载荷。分开是因为壁纸注册了四个独立的 listener，
// 而它们的更新频率完全不同：歌名换歌才变，进度每秒都变。
function mediaProperties(track) {
  return {
    title: (track && track.title) || '',
    artist: (track && track.artist) || '',
    albumTitle: (track && track.album) || '',
  };
}

function mediaThumbnail(track) {
  return {
    thumbnail: (track && track.artwork) || '',
    primaryColor: (track && track.primaryColor) || '',
    textColor: (track && track.textColor) || '',
  };
}

// 样本读的是 `pb.state === wallpaperMediaIntegration.PLAYBACK_PLAYING`，
// 而它自己兜底成 0：`(window.wallpaperMediaIntegration && ...PLAYBACK_PLAYING) || 0`。
// ⚠️ 所以 PLAYING 必须是 0 —— 如果我们把 PLAYING 定成别的数而壁纸走了兜底分支，
// "正在播放"会被判成停止。这是个真实的静默陷阱。
const PLAYBACK = { PLAYBACK_PLAYING: 0, PLAYBACK_PAUSED: 1, PLAYBACK_STOPPED: 2 };

function mediaPlayback(track) {
  if (!track || !track.playing) return { state: PLAYBACK.PLAYBACK_PAUSED };
  return { state: PLAYBACK.PLAYBACK_PLAYING };
}

function mediaTimeline(track) {
  return {
    position: Number.isFinite(track && track.position) ? track.position : 0,
    duration: Number.isFinite(track && track.duration) ? track.duration : 0,
  };
}

// 把 wall:// 的 URL 路径解析成壁纸目录下的真实文件路径。
//
// 抽出来是因为它有三件事会错，而每一件的症状都是白屏（看起来像"壁纸不兼容"）：
//   ① 越界：第三方 HTML 里一个 fetch('../../../etc/passwd') 不该读到东西
//   ② 空路径：wall://wallpaper/ 要落到入口文件，不是目录
//   ③ 百分号编码：URL 里的 %E5%A3%81 要还原成中文，否则找不到文件
//
// 返回 null 表示越界，调用方回 403。
function resolveAsset(pathname, dir, entryFile) {
  if (!dir) return null;
  let rel;
  try {
    rel = decodeURIComponent(pathname || '');
  } catch {
    // 半个百分号（'%E5%'）会让 decodeURIComponent 抛。那不是攻击也不是越界，
    // 是坏链接 —— 但也不能当成合法路径拼下去。
    return null;
  }
  rel = rel.replace(/^\/+/, '');
  const root = nodePath.resolve(dir);
  const target = nodePath.resolve(root, rel || entryFile || 'index.html');
  // resolve 已经折叠了 ..，所以比前缀就够。加分隔符是为了不让 /foo/barbaz
  // 通过 /foo/bar 的前缀检查。
  if (target !== root && !target.startsWith(root + nodePath.sep)) return null;
  return target;
}

// 装载被拒时给一句人话 + 一个可行的下一步。
//
// ⚠️ "不支持"三个字对用户没有价值。他需要知道的是：为什么、以及能不能换一个。
// 而且要说清"这不是坏了" —— 否则他会去排查一个不存在的 bug（我们已经在
// 这类混淆上烧掉过一整天）。
function refusalReason(project) {
  if (!project) return '读不到 project.json —— 这个目录是 WE 壁纸吗？';
  if (!project.known) {
    return `不认识的壁纸类型「${project.type || '(空)'}」—— WE 只有 web / video / scene / application 四种`;
  }
  if (project.type === 'application') {
    return '这是 Windows 程序类壁纸（别人编译的 .exe），macOS 上跑不了';
  }
  if (project.gifScene) {
    return 'GIF 壁纸暂不支持 —— 它在 WE 里被包成 scene 格式（gifscene），'
      + '而 scene 的渲染还没做。下面是它的预览图';
  }
  if (project.type === 'scene') {
    return 'scene 类暂不支持 —— 那是 WE 编辑器的私有格式（含它自己方言的 shader 和粒子），'
      + '需要重新实现渲染引擎。下面是它的预览图';
  }
  return `暂不支持 ${project.typeLabel}`;
}

// video 类的入口文件。⚠️ project.json 的 file 字段就是视频文件名（不是 html），
// 所以 video 和 web 的装载路径必须分开 —— 拿 <video> 去加载 index.html 会静默黑屏。
const VIDEO_EXT = /\.(mp4|webm|m4v|mov)$/i;

// Chromium 能不能解这个视频，只从扩展名看不出来（HEVC 也装在 .mp4 里）。
// 所以这里只做**明显不行**的判断，剩下的交给 <video> 的 error 事件 ——
// 那个能拿到真实的解码失败原因。
function videoHint(file) {
  if (!VIDEO_EXT.test(String(file || ''))) {
    return `入口文件「${file}」不像视频 —— project.json 的 file 字段对吗？`;
  }
  return null;
}

root.GestureWallWE = {
  TYPES,
  isGifScene,
  refusalReason,
  videoHint,
  VIDEO_EXT,
  resolveAsset,
  AUDIO_BINS,
  BANDS,
  PLAYBACK,
  parseProject,
  userProperties,
  generalProperties,
  controlsOf,
  normalizeAudioFrame,
  mediaProperties,
  mediaThumbnail,
  mediaPlayback,
  mediaTimeline,
};
})(typeof window === 'undefined' ? globalThis : window);
