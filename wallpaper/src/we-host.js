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
  // ⚠️⚠️⚠️ **0.9.158 起支持**（用户 2026-08-03：「scene 这种类型我们可以支持，
  //   后面我们的 agent 也支持生成 scene 类型的壁纸」）。
  //   见下面那段"我 07-30 的评估错在哪"。
  scene: { support: 'full', label: '场景（WE 编辑器格式）' },
  // 别人编译的 Windows .exe。跑不了也不该跑（用户已明确不做）。
  application: { support: 'none', label: 'Windows 程序' },
  // ⚠️⚠️⚠️ **用户 2026-08-02 的提法值得记下来**：
  //   「优化器的开发原则不应该是针对某一张壁纸，而是一个类型。你看我们已经支持
  //     web 和 video 了，那 scene 其实就相当于支持一种这样的类型」
  //
  // **这个原则完全对，而它正是这张表存在的理由** —— 我们支持的是**类型**
  // （每种一条渲染路径），不是"某个壁纸"。
  //
  // ⚠️⚠️⚠️ **而 scene 那一行 0.9.158 从 `none` 改成了 `full`** ——
  //   因为我 2026-07-30 那份评估的**结论是错的**，而错的原因值得记：
  //
  //   那份评估读的是 `linux-wallpaperengine` 的**代码规模**
  //   （粒子 2587 行 + shader 1488 行、全项目 30470 行 C++）
  //   ⟹ 结论"性质是移植一个没人在 mac 上构建过的 30k 行 C++ 项目"。
  //
  //   ⛔ **我量错了对象。** 那些行数是为了支持 WE 的**全部**功能，
  //     而 2026-08-03 实测两个真实工坊壁纸之后：
  //       样本 A（3299228616）：271 个对象 = 132 图片 + 60 文字 + 42 粒子
  //                             + 30 分组 + 6 形状
  //       样本 B（2902406982）：140 个对象 = 97 文字 + 41 图片 + **1 个**粒子
  //                             另有 75MB 字体
  //     ⟹ **主体是"图层 + 文字 + 变换"**，不是自定义渲染。
  //
  //   而三件真正的技术前提全部验过（`scene-pkg.js` + 20 项测试）：
  //     ① PKGV 归档：20 行代码读出 111/129 个条目，两个版本布局一致
  //     ② `.tex` 纹理：DXT3 是主力（30/34），而 WebGL 有
  //        `WEBGL_compressed_texture_s3tc` 扩展 —— **能直接吃 DXT，不用 CPU 解压**
  //     ③ shader 是标准 GLSL（waterripple / blur / tint …），WebGL 原生就吃
  //
  //   ⟹ 判据：**评估一件事的工作量，要量"真实输入里有什么"，
  //     不是量"那个引擎的代码有多少行"。**
  //     一个通用引擎的代码量反映的是它支持的**功能上界**，
  //     而我们要支持的是**真实内容的分布**。
  //
  // ⚠️ 而**渲染的完成度是分阶段的**（这一点要说清，别让 `full` 变成假承诺）：
  //   已做：PKGV 解包 / scene.json 解析 / DXT 纹理 / 图层 + 变换 + 视差
  //   未做：自定义 shader effect（那 17 个 .frag 里两个样本只重合 6 个
  //         ⟹ "内置一套就够"这个假设不成立）、粒子系统、文字排版
  //   ⟹ 所以装载 scene 壁纸时**面板要报"这张里有 N 个我们还没支持的东西"**，
  //     而不是静默少画一些（那看起来像坏了）。

  // ⚠️ 而**我们自己写的壁纸（`wallpapers/album-orbit`）走的是 `web` 那条**——
  //   它就是 HTML+JS，和工坊里那些交互式壁纸同一条路径。
  //   ⟹ 那不是"给某张壁纸开的特例"，它验的正是 web 这个类型的能力
  //     （拖拽 → 0.9.108 那个修复、音频 → wantsAudio、封面 → mediaThumbnail）。
  //   ⟹ 所以"拿它当实验开刀"的收益是**修 web 这条通路上的洞**，
  //     而这一轮已经修出两个：drag 不带按键状态、mediaThumbnail 字段名写错。

  // ⚠️ image **不是 WE 的类型** —— WE 只有上面四种。
  //
  // 这一项是**我们自己造的**：legacy 时代的工坊物品是单文件上传（Steam 存成
  // _legacy.bin 不解包），里面可能就是一个 gif/png/jpg，没有 project.json。
  // 那种我们给它造一个 project.json 并标成 image，从而复用一条渲染路径。
  //
  // 用户明确要求支持 GIF，而 GIF 在 WE 自己那边是包成 scene（gifscene.json）——
  // 那条要 scene 渲染。但 legacy 的裸 GIF 不需要，一个 <img> 就够。
  image: { support: 'full', label: '图片 / GIF' },
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
// 这些类型「没有 value」是合法状态（用户还没选文件/目录/没填字）,
// 而壁纸仍然会去读 .value 并和 '' 比较 ⟹ 必须发空字符串而不是不发。
const EMPTY_STRING_TYPES = new Set(['file', 'directory', 'textinput']);

function userProperties(properties, overrides) {
  const out = {};
  for (const [key, spec] of Object.entries(properties || {})) {
    if (!spec || typeof spec !== 'object') continue;
    if (DECORATIVE_TYPES.has(spec.type)) continue;
    let value = overrides && key in overrides ? overrides[key] : spec.value;
    // ⚠️ file / directory / textinput 类型在 project.json 里**没有 value 字段** ——
    // 那是"用户还没选文件"的正常状态，不是数据缺损。
    //
    // 实测（884307090 完美壁纸的真实 project.json）：
    //   "image":       { "type": "file", "condition": "wallpapermode.value == 1" }   ← 无 value
    //   "selectvideo": { "type": "file", "fileType": "video" }                        ← 无 value
    //   还有 selectmusic / particles_image / customdirectory / weather_CityText
    //
    // 原来这里 `value === undefined` 就 continue，于是这些键**根本不发给壁纸**。
    // 而壁纸假设它们存在且是字符串 —— 同一个文件里的 condition 就是证据：
    //   "condition": "MuiscModel.value != 0 || selectmusic.value != '' "
    //                                          ↑ 拿 .value 和空字符串比
    //
    // ⟹ 键不存在时 `props.selectmusic.value` 读的是 undefined 的属性，
    // 那个 condition 和所有依赖它的分支全部走错。而症状是**画面不对**
    // （背景不加载、只剩特效层），不是报错 —— 看起来像"这个壁纸不兼容"。
    //
    // WE 原版发的是空字符串。⟹ 补齐成 ''，让"没选文件"这个状态可表达。
    if (value === undefined) {
      if (!EMPTY_STRING_TYPES.has(spec.type)) continue;
      value = '';
    }
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
// 从 project.json 的 `text` 里取一个能显示的名字。
//
// ⚠️ `text` 是 **HTML**，不是纯文本。真实样本（884307090「完美壁纸」）：
//
//   "<br />多边形变换<br />Polygon<br /><small>用波峰音频效果更明显</small><br />"
//   "<br />音频方向<br />Wave direction<br />"
//   "<br/><h4>●  背景选项(Background Options)</h4><small>...</small><br/>"
//
// 我原来只写了 `.split('/')[0]` —— 那是按"双语用斜杠分隔"的假设写的，
// 而真实数据里第一个 `/` 出现在 **`<br />`** 里面
// ⟹ **137 个控件的名字全都变成 `"<br"`**，用户在面板上一个都分辨不出来。
//
// ⚠️ 这是我记忆里那条"载荷假设必先验"的又一次：`text` 的格式我从没验过。
// 真实数据一直在手边（那个 project.json 68KB），而我按想象写了解析。
//
// ⟹ 现在的做法：剥掉标签 → 拿第一段有意义的中文/文字 → 兜底用 key。
function labelOf(text, key) {
  if (!text) return key;
  const raw = String(text);
  // ① 把标签换成分隔符（不是直接删 —— `A<br/>B` 删了会粘成 `AB`）
  const plain = raw.replace(/<[^>]*>/g, '\n');
  // ② 逐段找第一个非空的
  const parts = plain.split('\n').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return key;
  // ③ 两种真实格式都要支持：
  //
  //   带标签的（884307090）：`<br />音频方向<br />Wave direction<br />`
  //      ⟹ 剥标签后分成两段，取第一段
  //   纯文本双语（另一个样本）：`渲染精度 / Render Resolution`
  //      ⟹ 只有一段，要按 ` / ` 再拆
  //
  // ⚠️ 而"斜杠"只在**两侧有空格**时才是双语分隔符 ——
  // `向上/左-Upward-Left` 里那个斜杠是名字的一部分，切了就变成"向上"。
  // 这两种斜杠的区别是我第一版漏掉的（改完之后一条旧测试报红，
  // 那条测的正是纯文本双语的样本）。
  const first = parts[0];
  const bilingual = first.split(/\s+\/\s+/);
  return bilingual[0].trim() || first;
}

function controlsOf(properties) {
  const list = [];
  for (const [key, spec] of Object.entries(properties || {})) {
    if (!spec || typeof spec !== 'object') continue;
    // ⚠️ `text` 类型不是"装饰"，它是**分组标题** —— 我原来一律扔掉，那是错的。
    //
    // 用户报（2026-07-31）：「没有看到你说的这些属性」——
    // 而属性其实都在，问题是 **137 个控件平铺、13 组名字还重复**：
    //   「音频样式」→ style(圆环的) 和 PWLineStyle(直线的)
    //   「音频方向」→ direction 和 PWLineDirection
    //   「可视化音频」→ showCircle 和 PWLineShow
    // ⟹ 用户看到两个同名的控件，分不清哪个属于圆环。
    //
    // 而分组信息**一直在数据里**（真实样本 884307090）：
    //   order=40   「●  可视化音频(Visual Audio)」
    //   order=42   「----------完美壁纸圆环(PWCircle)----------」
    //   order=43   「----------完美壁纸直线(PWLine)----------」
    //   order=83   「---------爱丽丝圆环(Alice Circle)-----------」
    // ⟹ 按 order 排序后，这些标题正好把控件分成一段一段。
    //
    // ⚠️ 又是"载荷假设必先验"：我把 `text` 当装饰是想当然，而作者用它做分组。
    if (spec.type === 'text') {
      const label = labelOf(spec.text, key);
      // 纯分隔线（`________` / `--------`）不当标题 —— 那才是真装饰。
      if (/^[\s_\-—=]+$/.test(label)) continue;
      list.push({
        key,
        type: 'group',
        label,
        order: Number.isFinite(spec.order) ? spec.order : 0,
        condition: spec.condition || null,
      });
      continue;
    }
    if (DECORATIVE_TYPES.has(spec.type)) continue;
    const control = {
      key,
      type: spec.type || 'slider',
      label: labelOf(spec.text, key),
      value: spec.value,
      order: Number.isFinite(spec.order) ? spec.order : 0,
      // ⚠️ condition 必须带出来 —— 见下面 evalCondition 的注释。
      // 我原来只在 text 分支带了它，普通控件全丢了 ⟹ 165 个控件里
      // 只有 18 个有 condition，而真实数据里带 condition 的远多于此。
      condition: spec.condition || null,
    };
    if (spec.type === 'slider') {
      control.min = Number.isFinite(spec.min) ? spec.min : 0;
      control.max = Number.isFinite(spec.max) ? spec.max : 1;
      control.step = Number.isFinite(spec.step) ? spec.step : 0.1;
    }
    if (spec.type === 'combo' && Array.isArray(spec.options)) {
      control.options = spec.options.map((o) => ({
        // ⚠️ 选项的 label 是纯文本（"向上/左-Upward-Left"），斜杠是名字的一部分，
        // 不能按它切 —— 切了就变成"向上"。只剥标签。
        label: String(o.label || o.value).replace(/<[^>]*>/g, '').trim(),
        value: o.value,
      }));
    }
    list.push(control);
  }
  return list.sort((a, b) => a.order - b.order);
}

// 求值 project.json 的 `condition`，决定一个控件该不该显示。
//
// ⚠️⚠️ **这是"用户找不到属性"的根因。** 我压根没实现它。
//
// 用户报（2026-07-31）：「没有看到你说的这些属性」+ 他贴的面板输出里
// 「音频样式」「音频方向」「可视化音频」各出现**两次**。
//
// 真实数据（884307090）：
//   showCircle   condition: "visual_audio_model.value == 1"   ← 圆环的
//   PWLineShow   condition: "visual_audio_model.value == 2"   ← 直线的
//   PolygonAngle condition: "visual_audio_model.value == 1 && showSemiCircle.value == false"
//
// `visual_audio_model` 默认 1（圆环）⟹ PWLine 那 20 个控件**本该全部隐藏**。
// 而我全都显示了 ⟹ 13 组同名控件 ⟹ 用户分不清哪个属于圆环，
// 于是"看不到"那些属性 —— 它们在，但埋在一堆同名项里。
//
// ⚠️ 这也解释了三个分组标题（PWCircle/PWLine/敬请期待）为什么挤在 order 42/43/44：
// 它们是**互斥**的，靠 condition 二选一，不是顺序分组。
//
// ## 为什么手写求值而不用 eval
//
// condition 是**第三方壁纸提供的字符串**。用 eval/new Function 等于让工坊里
// 任意一个壁纸在我们的渲染进程里执行代码 —— 那和我们为了安全开着
// contextIsolation 的努力自相矛盾。
//
// ⟹ 只支持真实数据里出现的形状（我统计过 884307090 的全部 condition）：
//   `key.value == 数字`  `key.value != 数字`
//   `key.value == true`  `key.value == false`
//   `key.value != ''`
//   以上用 `&&` / `||` 连接
// 认不出来的一律**返回 true（显示）** —— 宁可多显示一个，
// 也不要因为解析不了而把用户需要的控件藏起来。
function evalCondition(condition, values) {
  if (!condition) return true;
  const text = String(condition);

  // 单个比较式。返回 null 表示"看不懂"。
  const one = (expr) => {
    const m = expr.trim().match(/^([\w.]+)\.value\s*(==|!=)\s*(.+)$/);
    if (!m) return null;
    const [, key, op, rawWanted] = m;
    const actual = values ? values[key] : undefined;
    let wanted = rawWanted.trim();
    // 去掉引号
    if (/^'.*'$/.test(wanted) || /^".*"$/.test(wanted)) wanted = wanted.slice(1, -1);
    let eq;
    if (wanted === 'true') eq = actual === true;
    else if (wanted === 'false') eq = actual === false;
    else if (wanted === '') eq = actual === '' || actual == null;
    else if (/^-?[\d.]+$/.test(wanted)) eq = Number(actual) === Number(wanted);
    else eq = String(actual) === wanted;
    return op === '==' ? eq : !eq;
  };

  // ⚠️ `||` 的优先级低于 `&&`，所以先按 `||` 拆。
  // 真实数据里有 `(A && B)||(C && D)` 这种形状（PWLineBlurColor 的 condition）。
  const orParts = text.split('||');
  for (const orPart of orParts) {
    const andParts = orPart.split('&&');
    let all = true;
    let understood = false;
    for (const andPart of andParts) {
      // 去掉包裹的括号
      const cleaned = andPart.trim().replace(/^\(+/, '').replace(/\)+$/, '');
      const r = one(cleaned);
      if (r === null) continue;   // 看不懂的那一项跳过（不让它否掉整条）
      understood = true;
      if (!r) { all = false; break; }
    }
    // 有一条 or 分支成立就显示
    if (understood && all) return true;
    // 完全看不懂 ⟹ 显示（宁可多显示，不要藏掉用户要的控件）
    if (!understood) return true;
  }
  return false;
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
  // ⚠️⚠️⚠️ **字段名一直是错的**（0.9.110 修）。用户 2026-08-02 的截图里
  //   左下角歌曲卡的封面框是**空的**（歌名/歌手都对）。
  //
  // 这里原来读 `track.artwork` —— 而 `nowplaying.js` 给出的字段叫
  // **`artworkData`（base64）+ `artworkMimeType`**，压根没有 `artwork`
  // ⟹ `track.artwork` 恒为 undefined ⟹ thumbnail 恒为 `''`
  // ⟹ **所有向我们要封面的壁纸都拿不到封面**（不止我们自己那个，
  //   工坊里那些 Media Integration 壁纸也一样）。
  //
  // ⚠️ 而它**不报任何错**：壁纸收到空字符串，通常就是不画封面
  //   ⟹ 症状是"有歌名没封面"，而那看起来像"这首歌没有封面图"。
  //   ⟹ 这就是那种"接了一半的链"，和语音那个「点」是同一个形状。
  //
  // ⚠️⚠️ WE 的契约里 thumbnail 是**可以直接塞进 `img.src` 的字符串**
  //   ⟹ 必须拼成 data URL（`wall.js` 里那处就是这么用的）。
  const data = track && track.artworkData;
  const mime = (track && track.artworkMimeType) || 'image/jpeg';
  return {
    thumbnail: data ? `data:${mime};base64,${data}` : '',
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

// ⚠️⚠️⚠️ **`window.__mediaState` —— 我们一直没适配的那个接口**（0.9.114）。
//
// 用户 2026-08-02 报"网易云的进度和壁纸显示的进度不同步"，而他的推论是对的：
//   「我给你们这些壁纸本身都是能正常运行的，出了问题就说明是我们软件这边没做好适配」
//
// ⚠️⚠️ 而我查了三轮才找对地方，前两轮都在错的前提上：
//   ① 先查"它注册了哪些 wallpaperRegister*Listener" ⟹ **只有 Audio 一个**
//      ⟹ 我据此说"它不听进度，所以我们没法喂"—— **那个结论错了**
//   ② 又查 `applyGeneralProperties` ⟹ 它的回调只读 `fps`
//   ③ 最后顺着 `title:` 这个字面量才找到真相：
//        `_t = window.__mediaState || { title:"", artist:"", …, position:0, duration:0 }`
//
// **它读的是一个普通全局对象，不是 WE 的回调接口。** 而我们从来没设过它
// ⟹ 每次都落到那个全空的兜底值 ⟹ 进度恒为 0、封面为空
// ⟹ 壁纸自己造 `performance.now()` 计时器往前跑，跑到 duration 就重置
//   —— **那正是用户看到的"跑一会儿自己重置"**。
//
// ⚠️ 教训：**"它没注册我们的接口"不等于"它不要这个数据"。**
//   第三方壁纸可以用任何形式取数据，而我按"WE 官方接口"这一种可能就下了结论。
//   ⟹ 找不到的时候，顺着**它要显示的那个字段名**（title/position）去搜，
//     而不是顺着"我提供的接口名"。
//
// 契约（从 `index-DbT3gAaX.js` 的字面量抄下来，一个字段都不许改名）：
//     window.__mediaState = {
//       title, artist, thumbnail, primaryColor, textColor,
//       isPlaying, position, duration,
//       _callbacks: []      // 壁纸 push 自己的回调进来；我们变更时逐个调
//     }
// ⚠️ `_callbacks` 是**壁纸往里 push** 的 ⟹ 这个对象必须是**可写的普通对象**，
//   不能走 contextBridge（那边暴露的是冻结代理，push 会抛）
//   ⟹ 只能用 `executeJavaScript` 在主世界建（和 sendWEProperties 同一手法）。
//
// ⚠️⚠️ 字段名**不是**我们内部那套：这里是 `position`，而 media-control 给的是
//   `elapsedTime`；这里是 `thumbnail`（data URL），而我们内部是 `artworkData`。
//   ⟹ 这个函数就是那道翻译，而"两边名字不一样"正是前三次栽跟头的地方。
function mediaStatePayload(track) {
  const t = mediaThumbnail(track);
  const line = mediaTimeline(track);
  return {
    title: (track && track.title) || '',
    artist: (track && track.artist) || '',
    thumbnail: t.thumbnail,
    primaryColor: t.primaryColor,
    textColor: t.textColor,
    // ⚠️ 壁纸读的是布尔 `isPlaying`，而我们内部是三态的 playback.state
    //   ⟹ 只有 PLAYING(0) 算 true。
    // ⚠️ 不写 `=== PLAYBACK.PLAYBACK_PLAYING` —— `PLAYBACK` 那个 const 声明在
    //   这个函数**下面**（431 行），而 const 没有提升 ⟹ 调用时会抛
    //   "Cannot access before initialization"。而那种错只在真跑到时才炸，
    //   node --check 查不出来（语法是合法的）。
    //   ⟹ 直接比 0（PLAYBACK_PLAYING 的值，而它由 wallpaperMediaIntegration 契约定死）。
    isPlaying: mediaPlayback(track).state === 0,
    position: line.position,
    duration: line.duration,
  };
}

// ⚠️⚠️⚠️ **`elapsedTime` 是快照，不是当前位置**（0.9.117，真实数据坐实）。
//
// 用户 2026-08-02 的诊断报告（网易云正在放《无情画》）：
//     "elapsedTime": 0.046439909297052155      ← 47 毫秒
//     "duration":    230.69025                 ← 230 秒（对的）
//     "timestamp":   "2026-08-02T13:50:33Z"
//     "playing":     true
// 而报告导出时刻是 `13:52:17.893` —— 比 timestamp **晚 104.9 秒**。
//     0.046 + 104.9 = **104.9 秒 / 230.7** ⟹ 那才是真实位置。
//
// ⟹ **MediaRemote 给的是"在 `timestamp` 那一刻的播放位置"**。
//   播放器只在**状态变化时**（换歌/暂停/拖动进度）才 publish 一次，
//   而 `elapsedTime` 冻结在那一刻 ⟹ 直接用它，进度条永远停在开头附近。
//
// ⚠️⚠️ 而我为这个 bug 猜了四轮（字段名 → 单位 → 频率 → 采集方式），
//   **每一轮都在推断，而真实数据一次就给出了答案**。
//   ⟹ 判据：**"值不对"和"字段名不对"是两类问题，先看到真实值再决定改哪个。**
//     前三次栽在字段名上，让我形成了"又是名字错了"的惯性，而这次名字是对的。
//
// ⚠️ 三个前提，缺一个就不能外推：
//   ① `playing` 为 false 时**不许外推** —— 暂停了时间就不走，
//     外推会让进度条在暂停时继续爬（那比停在开头更像坏了）
//   ② `timestamp` 解析不出来就退回裸值（比外推一个错的量好）
//   ③ 外推结果要**夹在 [0, duration]** —— 播放器暂停很久没 publish 时，
//     外推会超过总长，而那会让进度条冲出轨道
function mediaTimeline(track) {
  // ⚠️⚠️⚠️ **字段名又错了一处**（0.9.113）。用户 2026-08-02：
  //   「粒子壁纸会显示音乐的进度条，但是到达一定时间会自动重置，
  //     反正不是和真实的音乐时间同步的」
  //
  // 这里原来读 `track.position` —— 而 media-control 给的字段叫 **`elapsedTime`**
  //（证据：`test/nowplaying.test.js:34` 的 fixture 用的就是它，而 src 里
  //  **零处**读过那个名字）⟹ `position` 恒为 undefined ⟹ 我们一直在发 0。
  //
  // ⚠️ 而壁纸拿到恒为 0 的进度时，通常自己造一个计时器往前跑
  //   ⟹ 症状正是用户说的"跑一会儿自己重置"（它每次收到 0 就归零重来）。
  //
  // ⚠️⚠️ **这是同一个形状的第三次**：
  //   ① `mediaThumbnail` 读 `track.artwork`（真名 artworkData）—— 0.9.110 修
  //   ② 语音的「点」helper 发了主进程不认 —— 0.9.106 删掉
  //   ③ 这一处
  //   ⟹ 判据：**跨模块传数据时，字段名要有一处单一来源**。
  //     而现在 nowplaying 是 `...data` 直接透传 media-control 的原始字段，
  //     we-host 这边全靠"我记得它叫什么" —— 那必然会漂。
  //   ⟹ 下面把两个名字都读，而且**测试 fixture 必须用真实字段名**
  //     （0.9.110 那次就是 fixture 用了假名字，让 bug 活着还让修的人报红）。
  const base = track && (track.elapsedTime !== undefined
    ? track.elapsedTime : track.position);
  const duration = Number.isFinite(track && track.duration) ? track.duration : 0;
  let position = Number.isFinite(base) ? base : 0;

  // ⚠️ 只在**正在播放**时外推（见上面那段的前提①）
  if (track && track.playing && track.timestamp) {
    const snap = Date.parse(track.timestamp);
    // ⚠️ Date.parse 失败给 NaN ⟹ 不外推（前提②）。
    // ⚠️⚠️ 实测过：这个 `isFinite` **在结果上是冗余的** —— `NaN > 0` 已经是 false，
    //   所以下面那个 `drift > 0` 自己就兜住了。反向验证里"删掉它"显示永久绿，
    //   而那不是守卫弱，是**这个判断真的改不动结果**。
    //   ⟹ 但**留着**：它表达的是意图（"解析失败就别算"），而靠 NaN 比较的假值行为
    //     是那种"能工作但下一个人看不懂为什么"的代码。宁可多一行显式的。
    if (Number.isFinite(snap)) {
      const drift = (Date.now() - snap) / 1000;
      // ⚠️ drift 为负说明时钟对不上（或者 timestamp 是未来的）⟹ 不外推
      if (drift > 0) position += drift;
    }
  }
  // ⚠️ 夹在 [0, duration]（前提③）——暂停很久没 publish 时外推会超过总长，
  //   而那会让进度条冲出轨道。duration 为 0（拿不到总长）时不夹上限。
  if (position < 0) position = 0;
  if (duration > 0 && position > duration) position = duration;

  return { position, duration };
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

// 某个类型支不支持。⚠️ 这是**唯一**的判定来源。
//
// workshop.js 曾经自己维护过一份 `type === 'web' || type === 'video'`，
// 然后加 image 时没跟着改 ⟹ 支持的类型被报成"大概不支持"。
// 同一个事实有两个来源就一定会漂。
function isSupportedType(type) {
  const spec = TYPES[String(type || '').toLowerCase()];
  return !!spec && spec.support === 'full';
}

// 某个类型为什么不支持 —— 给下载**之前**用（那时还没有 project.json）。
//
// ⚠️ 原来面板里写的是个两分支三元表达式：不是 scene 就说"application 类是
// Windows 程序" —— 于是 image 被报成 Windows 程序。少一个分支的后果不是
// "少说一句"，是**说错**，而说错比不说糟。所以做成查表，加类型时不会漏。
const TYPE_REFUSALS = {
  scene: 'scene 类是 WE 编辑器的私有格式（含它自己方言的 shader 和粒子），装了也只能看静态图',
  application: 'application 类是 Windows 程序，macOS 上跑不了',
};

function typeRefusal(type) {
  const key = String(type || '').toLowerCase();
  if (isSupportedType(key)) return null;
  return TYPE_REFUSALS[key] || `暂不支持「${type}」类型`;
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
const IMAGE_EXT = /\.(gif|png|jpe?g|webp)$/i;

// 媒体类（video / image）走同一个渲染页，因为 <video> 和 <img> 的容器逻辑一样
// （铺满、cover、居中）。区别只是标签，所以让页面自己按扩展名选。
function isMediaType(type) {
  return type === 'video' || type === 'image';
}

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
  isSupportedType,
  typeRefusal,
  IMAGE_EXT,
  isMediaType,
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
  evalCondition,
  normalizeAudioFrame,
  mediaProperties,
  mediaThumbnail,
  mediaPlayback,
  mediaTimeline,
  mediaStatePayload,
};
})(typeof window === 'undefined' ? globalThis : window);
