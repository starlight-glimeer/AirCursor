// Wallpaper Engine 的 scene 类壁纸：`scene.pkg` 归档 + `.tex` 纹理的解析。
//
// ⚠️⚠️⚠️ **这一层的全部结论来自实测两个真实工坊壁纸**，不是文档 ——
//   WE 的 scene 格式没有任何公开规范。
//     样本 A：`3299228616`（Lonely Cat，PKGV0022，111 条目）
//     样本 B：`2902406982`（麻匪 月半与鬼哭，PKGV0024，129 条目）
//
// ⚠️ 而这份实测**推翻了我 2026-07-30 那份可行性评估**。
//   那份评估读的是 `linux-wallpaperengine` 的**代码规模**
//   （粒子 2587 行 + shader 1488 行）⟹ 结论是"移植 30k 行 C++"。
//   ⛔ 而我**量错了对象**：那些行数是为了支持 WE 的**全部**功能，
//     而真实壁纸的主体是"图层 + 文字 + 变换"（实测两个样本）：
//       样本 A：271 个对象 = 132 图片 + 60 文字 + 42 粒子 + 30 分组 + 6 形状
//       样本 B：140 个对象 = 97 文字 + 41 图片 + **1 个**粒子系统，另有 75MB 字体
//   ⟹ 只有**一个**样本的粒子占比高（A 的 42/271），而 B 几乎是纯图层+文字。
//   ⟹ 判据：**评估一件事的工作量，要量"真实输入里有什么"，
//     不是量"那个引擎的代码有多少行"。**
//
// ⚠️ 用户 2026-08-03：「scene 这种类型我们可以支持，后面我们的 agent
//   也支持生成 scene 类型的壁纸」
//   ⟹ 所以这一层不只是"能读"，它还得是**agent 能写**的目标格式
//     ⟹ 那意味着解析和序列化要对称（先做解析，写侧留在 `sceneToJson`）。

'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  PKGV 归档
// ═══════════════════════════════════════════════════════════════════════════
//
// 实测的布局（两个版本一致）：
//
//   [4B 长度][版本串 "PKGV0022"]      ⚠️ 长度是 8，串本身不带 \0
//   [4B 条目数]
//   条目 × N：[4B 名长][名][4B 偏移][4B 长度]
//   [数据区]                          ⚠️ 偏移是**相对数据区起点**，不是文件头
//
// ⚠️⚠️ 那个"偏移相对数据区"是最容易错的一处 —— 用绝对偏移读出来的是
//   条目表里的字节（看起来像乱码的 JSON 片段），而那**不报错**。
//   ⟹ 判据：**偏移的基准点要实测确认**，别假设它是文件头。

// ⚠️ 已知的版本。⚠️ 而**不认识的版本不拒绝** —— 布局一致的话照样能读，
//   而"因为版本号没见过就拒绝"会让一堆能用的壁纸装不上。
//   ⟹ 只在日志里说一句。
const KNOWN_VERSIONS = ['PKGV0022', 'PKGV0024'];

// 解析 scene.pkg。返回 { version, entries, dataStart, warnings }
//
// ⚠️ 只解析**条目表**，不读内容 —— 那让"这个包里有什么"能在毫秒内回答，
//   而内容按需取（`readEntry`）。一个包 11MB，全读进内存没必要。
function parsePkg(buf) {
  if (!buf || buf.length < 16) {
    return { ok: false, error: 'scene.pkg 太小或者读不到（不到 16 字节）' };
  }
  let p = 0;
  const warnings = [];
  const u32 = () => {
    if (p + 4 > buf.length) throw new RangeError(`读越界（偏移 ${p}）`);
    const v = buf.readUInt32LE(p);
    p += 4;
    return v;
  };
  const str = () => {
    const n = u32();
    // ⚠️ 名字长度要有上界 —— 一个损坏的包会给出天文数字，
    //   而 `buf.toString` 会静默截断（那时读出来的是一堆乱码条目）。
    if (n > 4096) throw new RangeError(`字符串长度不合理（${n}）—— 包可能坏了`);
    const s = buf.toString('utf8', p, p + n);
    p += n;
    return s;
  };

  let version;
  let count;
  const entries = [];
  try {
    version = str();
    if (!KNOWN_VERSIONS.includes(version)) {
      // ⚠️ 不拒绝，只记 —— 见上面那段判据
      warnings.push(`版本 ${version} 没见过（已知：${KNOWN_VERSIONS.join(' / ')}）`
        + ' —— 照旧尝试解析');
    }
    count = u32();
    // ⚠️ 条目数也要有上界（同上：损坏的包）
    if (count > 100000) {
      return { ok: false, error: `条目数不合理（${count}）—— 这个 scene.pkg 可能坏了` };
    }
    for (let i = 0; i < count; i += 1) {
      const name = str();
      const off = u32();
      const len = u32();
      entries.push({ name, off, len });
    }
  } catch (error) {
    return { ok: false, error: `scene.pkg 结构读不通：${error.message}` };
  }

  const dataStart = p;
  // ⚠️⚠️ 校验偏移+长度都落在文件内 —— 那让"包坏了"在这里就发现，
  //   而不是在渲染时变成一张黑图。
  for (const e of entries) {
    if (dataStart + e.off + e.len > buf.length) {
      return {
        ok: false,
        error: `条目 ${e.name} 越界（偏移 ${e.off} + 长度 ${e.len} 超过文件尾）`
          + ' —— 这个 scene.pkg 不完整',
      };
    }
  }

  return { ok: true, version, entries, dataStart, warnings };
}

// 取一个条目的内容
function readEntry(buf, pkg, name) {
  const e = (pkg.entries || []).find((x) => x.name === name);
  if (!e) return null;
  return buf.slice(pkg.dataStart + e.off, pkg.dataStart + e.off + e.len);
}

// ⚠️ 按扩展名归类 —— 面板上要能说"这个 scene 里有什么"
function summarize(pkg) {
  const byExt = {};
  for (const e of pkg.entries || []) {
    const m = e.name.match(/\.([a-z0-9]+)$/i);
    const ext = m ? m[1].toLowerCase() : '(无扩展名)';
    if (!byExt[ext]) byExt[ext] = { count: 0, bytes: 0 };
    byExt[ext].count += 1;
    byExt[ext].bytes += e.len;
  }
  return byExt;
}

// ═══════════════════════════════════════════════════════════════════════════
//  .tex 纹理
// ═══════════════════════════════════════════════════════════════════════════
//
// 实测的头部布局：
//
//   [4B 长度][版本 "TEXV0005"][\0]
//   [4B 长度][版本 "TEXI0001"][\0]
//   [4B flags][4B format]
//   [4B texW][4B texH]         ⚠️ 那是**纹理**尺寸（2 的幂）
//   [4B imgW][4B imgH]         ⚠️ 那是**图像**尺寸（真实内容）
//   ... 然后是 TEXB 块（mipmap 数据）
//
// ⚠️⚠️ `texW/texH` 和 `imgW/imgH` **不一样**（实测：4096×4096 的纹理里
//   装 3840×2160 的图）⟹ 采样时要按 imgW/texW 缩 UV，否则图会偏。
//   ⟹ 判据：**两个尺寸都要读出来**，用错一个的症状是"图偏了一点"，
//     而那种偏差看起来像"这张壁纸本来就这样"。

// ⚠️ 格式号。实测 DXT3 是主力（两个样本：15/19 和 15/15）。
//   ⚠️ 而 WebGL 有 `WEBGL_compressed_texture_s3tc` 扩展 ——
//     能**直接吃** DXT1/3/5，不需要 CPU 解压。那是这件事可行的关键。
const TEX_FORMATS = {
  0: { name: 'RGBA8888', compressed: false, glFormat: null },
  1: { name: 'DXT5', compressed: true, glFormat: 'COMPRESSED_RGBA_S3TC_DXT5_EXT' },
  2: { name: 'DXT3', compressed: true, glFormat: 'COMPRESSED_RGBA_S3TC_DXT3_EXT' },
  3: { name: 'DXT1', compressed: true, glFormat: 'COMPRESSED_RGB_S3TC_DXT1_EXT' },
  4: { name: 'RG88', compressed: false, glFormat: null },
  5: { name: 'R8', compressed: false, glFormat: null },
  6: { name: 'RG1616f', compressed: false, glFormat: null },
  7: { name: 'R16f', compressed: false, glFormat: null },
  8: { name: 'RGBA16161616f', compressed: false, glFormat: null },
  9: { name: 'RGB888', compressed: false, glFormat: null },
};

// 解析 .tex 的头部（不解 mipmap 数据 —— 那按需做）
function parseTexHeader(buf) {
  if (!buf || buf.length < 48) {
    return { ok: false, error: '.tex 太小（不到 48 字节）' };
  }
  // ⚠️⚠️ **先判魔数再解析** —— 否则一个非 .tex 文件会报"找不到标签结尾"，
  //   而那句话没有信息量（真正的信息是"这不是 .tex"）。
  //   ⟹ 判据：**报错要说"是什么问题"，不是"我在哪一步失败的"。**
  if (buf.toString('latin1', 0, 4) !== 'TEXV') {
    return {
      ok: false,
      error: `不是 .tex 文件 —— 头 4 字节是 "${buf.toString('latin1', 0, 4)
        .replace(/[^\x20-\x7e]/g, '.')}"，该是 TEXV`,
    };
  }
  let p = 0;
  // ⚠️⚠️⚠️ `.tex` 的标签是**裸串 + `\0`**，**不带长度前缀** ——
  //   和 PKGV 的字符串格式**不一样**。
  //   ⚠️ 我第一版照 PKGV 的模式假设了长度前缀 ⟹ 把 "TEXV" 四个字节当长度读，
  //     得到 1448625492 ⟹ 报"标签长度不合理"。
  //   ⟹ 判据：**同一个文件族里的两种容器可以有不同的字符串编码** ——
  //     别把一处实测的格式推广到另一处。
  const readTag = () => {
    const z = buf.indexOf(0, p);
    if (z < 0 || z - p > 64) throw new RangeError(`找不到标签结尾（偏移 ${p}）`);
    const s = buf.toString('latin1', p, z);
    p = z + 1;
    return s;
  };
  try {
    const texv = readTag();
    if (!/^TEXV/.test(texv)) {
      return { ok: false, error: `不是 .tex 文件（头部是 "${texv}"，该以 TEXV 开头）` };
    }
    const texi = readTag();
    const flags = buf.readUInt32LE(p); p += 4;
    const format = buf.readUInt32LE(p); p += 4;
    const texWidth = buf.readUInt32LE(p); p += 4;
    const texHeight = buf.readUInt32LE(p); p += 4;
    const imgWidth = buf.readUInt32LE(p); p += 4;
    const imgHeight = buf.readUInt32LE(p); p += 4;
    const fmt = TEX_FORMATS[format] || { name: `未知(${format})`, compressed: false, glFormat: null };
    // ⚠️ 尺寸要合理 —— 一个 0 或者天文数字说明偏移错了
    if (!(texWidth > 0 && texWidth <= 16384 && texHeight > 0 && texHeight <= 16384)) {
      return {
        ok: false,
        error: `纹理尺寸不合理（${texWidth}×${texHeight}）—— 头部偏移可能读错了`,
      };
    }
    return {
      ok: true,
      texv,
      texi,
      flags,
      format,
      formatName: fmt.name,
      compressed: fmt.compressed,
      glFormat: fmt.glFormat,
      texWidth,
      texHeight,
      imgWidth,
      imgHeight,
      // ⚠️ UV 缩放：图像只占纹理的一部分（实测 3840/4096）
      //   ⟹ 采样时要乘它，否则图会偏
      uvScaleX: texWidth > 0 ? imgWidth / texWidth : 1,
      uvScaleY: texHeight > 0 ? imgHeight / texHeight : 1,
      headerBytes: p,
    };
  } catch (error) {
    return { ok: false, error: `.tex 头部读不通：${error.message}` };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  scene.json
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ 实测的顶层：`{ camera, general, objects, version }`
//   而 `objects` 里每个对象按它有哪个字段区分类型：
//     `image` → 图层（41 个）
//     `text`  → 文字（84 个）
//     `particle` → 粒子（1 个）
//     `light` → 灯光
//
// ⚠️⚠️ 判据：**类型不是一个 `type` 字段，而是"有哪个键"** ——
//   我第一版按 `o.type` 找，全是 undefined。

// 一个对象是什么类型
function objectKind(o) {
  if (!o || typeof o !== 'object') return null;
  if (o.image !== undefined) return 'image';
  if (o.text !== undefined) return 'text';
  if (o.particle !== undefined) return 'particle';
  if (o.light !== undefined) return 'light';
  if (o.sound !== undefined) return 'sound';
  // ⚠️⚠️ `shape` —— 带 effect 的形状层（实测样本 A 有 6 个，
  //   它们挂着 lightshafts 那类全屏效果）
  if (o.shape !== undefined) return 'shape';
  // ⚠️⚠️⚠️ **纯变换节点**（实测样本 A 有 30 个）：只有 `parent` + 变换字段，
  //   没有任何可见内容 —— 那是**图层组**（WE 编辑器里的分组）。
  //   ⚠️ 我第一版把它们归成 `unknown` 并跳过 ⟹ 而**跳过它们会让子对象的
  //     变换算错**（子对象的坐标是相对父节点的）。
  //   ⟹ 判据：**"没有可见内容"不等于"可以丢掉"** —— 它可能是别人的锚点。
  if (o.parent !== undefined || (o.angles !== undefined && o.name !== undefined)) {
    return 'group';
  }
  return 'unknown';
}

// ⚠️ WE 的坐标是 `"x y z"` 三个数的字符串（不是数组，也不是对象）
//   ⚠️ 而它**可能只有两个数**（2D 图层）⟹ 缺的补 0
function parseVec3(v, fallback) {
  const fb = fallback || [0, 0, 0];
  if (Array.isArray(v)) {
    return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
  }
  if (typeof v !== 'string') return fb.slice();
  const parts = v.trim().split(/\s+/).map(Number);
  if (!parts.length || parts.some((x) => !Number.isFinite(x))) return fb.slice();
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

// 解析 scene.json → 一份**渲染层能直接吃**的结构
//
// ⚠️ 这里做的是"翻译"而不是"透传" —— 那让渲染层不用懂 WE 的字段命名，
//   而这一层的每个决定都能被测（纯函数）。
function parseScene(json) {
  let d = json;
  if (typeof json === 'string') {
    try { d = JSON.parse(json); } catch (error) {
      return { ok: false, error: `scene.json 不是合法 JSON：${error.message}` };
    }
  }
  if (!d || typeof d !== 'object') {
    return { ok: false, error: 'scene.json 不是对象' };
  }
  const rawObjects = Array.isArray(d.objects) ? d.objects : [];

  const objects = [];
  const skipped = [];
  for (const o of rawObjects) {
    const kind = objectKind(o);
    // ⚠️ 不认识的类型**记下来但不报错** —— 那让"这张壁纸有 3 个我们不支持的东西"
    //   变成可观测的事实，而不是静默丢掉。
    if (kind === 'unknown' || kind === null) {
      skipped.push({ id: o && o.id, name: o && o.name, reason: '不认识的对象类型' });
      continue;
    }
    objects.push({
      id: o.id,
      name: o.name || '',
      kind,
      // ⚠️⚠️ `parent` 是**变换树**的边 —— 子对象的坐标相对父节点。
      //   ⚠️ 漏了它的症状是"图层位置全错"，而那看起来像"解析失败"。
      parent: o.parent === undefined ? null : o.parent,
      // ⚠️ `visible` 可能是 bool、字符串、或者一个"绑定表达式"对象
      //   ⟹ 只有显式 false 才算隐藏（表达式当可见处理 —— 保守）
      visible: o.visible !== false,
      origin: parseVec3(o.origin),
      angles: parseVec3(o.angles),
      scale: parseVec3(o.scale, [1, 1, 1]),
      size: parseVec3(o.size),
      // ⚠️ 视差深度：那是 scene 类"会动"的一个主要来源
      //   （鼠标移动时不同深度的图层错开）
      parallaxDepth: parseVec3(o.parallaxDepth),
      alpha: o.alpha === undefined ? 1 : Number(o.alpha),
      brightness: o.brightness === undefined ? 1 : Number(o.brightness),
      color: parseVec3(o.color, [1, 1, 1]),
      blendMode: Number(o.colorBlendMode) || 0,
      // 各类型自己的载荷
      image: kind === 'image' ? o.image : null,
      text: kind === 'text' ? o.text : null,
      font: o.font || null,
      particle: kind === 'particle' ? o.particle : null,
      // ⚠️ effects 是一个数组，每项指向包里的一个 effect.json
      effects: Array.isArray(o.effects) ? o.effects : [],
      // ⚠️ 原始对象留着 —— 渲染层可能需要我们还没翻译的字段，
      //   而"翻译层丢了信息"是很难查的（症状是某个效果不起作用）
      raw: o,
    });
  }

  return {
    ok: true,
    version: d.version,
    camera: d.camera || null,
    general: d.general || null,
    objects,
    skipped,
    // 统计 —— 面板和日志要用
    counts: objects.reduce((acc, o) => {
      acc[o.kind] = (acc[o.kind] || 0) + 1;
      return acc;
    }, {}),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  ⚠️⚠️⚠️ **这张 scene 里有多少是我们现在能画的**
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ `we-host.js` 把 scene 标成了 `support: 'full'`，而**渲染是分阶段的**：
//     已做：图层（image）+ 变换 + 视差 + DXT 纹理 + 分组
//     未做：自定义 shader effect、粒子系统、文字排版
//
// ⚠️⚠️ 那意味着装载一张 scene 时**必须报"这张里有 N 个我们还没支持的东西"** ——
//   而不是静默少画一些。
//   ⟹ 判据：**"部分支持"要说出是哪部分。** 静默少画的症状是"这张壁纸怪怪的"，
//     而用户无从判断是壁纸的问题还是我们的问题。
//     （这个项目为"静默失败"栽过很多次，而这一条是同一个形状。）
//
// ⚠️ 而**它不阻止装载** —— 一张 140 对象里 97 个文字的壁纸，
//   即使文字还没做，那 41 个图层也值得画出来（比"暂不支持"好）。
const RENDER_SUPPORT = {
  image: 'full',      // 图层 + 变换 + 视差 + DXT 纹理
  group: 'full',      // 纯变换节点（子对象的锚点）
  sound: 'skip',      // ⚠️ 故意不做 —— 壁纸自己放声音是打扰（用户没要求过）
  text: 'none',       // 文字排版（要字体加载 + SDF 或 canvas 纹理）
  particle: 'none',   // 粒子系统
  shape: 'none',      // 带 effect 的形状层
  light: 'none',      // 灯光
  unknown: 'none',
};

// 给一份"能画多少"的报告。⚠️ 面板和日志都要它。
function renderability(scene) {
  if (!scene || !scene.ok) return { ok: false };
  const counts = scene.counts || {};
  const done = [];
  const missing = [];
  let doneN = 0;
  let missN = 0;
  for (const [kind, n] of Object.entries(counts)) {
    const level = RENDER_SUPPORT[kind] || 'none';
    if (level === 'full') { done.push(`${kind} ${n}`); doneN += n; }
    else if (level === 'skip') { /* 有意不做，不算缺口 */ }
    else { missing.push(`${kind} ${n}`); missN += n; }
  }
  const total = doneN + missN;
  return {
    ok: true,
    doneN,
    missN,
    // ⚠️ 覆盖率按**对象数**算 —— 那比"种类数"更接近"画面上缺了多少"
    coverage: total > 0 ? doneN / total : 1,
    done,
    missing,
    // ⚠️⚠️ 一句能直接显示给用户的话 —— 而它要**说清缺什么**，
    //   不是"部分支持"这种没信息量的说法
    summary: missN === 0
      ? `这张 scene 的 ${doneN} 个元素都能画`
      : `能画 ${doneN} 个元素（${done.join(' / ')}），`
        + `还有 ${missN} 个画不了（${missing.join(' / ')}）`,
  };
}

module.exports = {
  KNOWN_VERSIONS,
  TEX_FORMATS,
  RENDER_SUPPORT,
  renderability,
  parsePkg,
  readEntry,
  summarize,
  parseTexHeader,
  parseScene,
  objectKind,
  parseVec3,
};
