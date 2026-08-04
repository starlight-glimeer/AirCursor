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
  // ⚠️⚠️⚠️ **34 = MP4 视频**（实测 6 张，数据以 ISO BMFF 的 `ftyp` 开头）——
  //   那是 WE 的"视频纹理"：一个图层的内容是一段视频。
  //   ⚠️ 而 `format` 字段的其余取值**不可信**（见下面 PIXEL_BY_FLAGS 那段）。
  34: { name: 'MP4', compressed: false, glFormat: null, video: true },
};

// ═══════════════════════════════════════════════════════════════════════════
//  ⚠️⚠️⚠️ **真实像素格式由 `flags` 定，不是 `format`**（2026-08-04，9 张实测）
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ 我原来信 `format` 字段 ⟹ 实测 178 张 `.tex` 里它**大面积说谎**：
//     format=2（声明 DXT3）的 178 张里，实际是
//       DXT3/5 ×96 · R8 ×28 · RGBA8888 ×22 · DXT1 ×8 · RG88 ×6
//   ⟹ 按它上传纹理会得到"数据长度不匹配"或者一张乱码图。
//
// ⚠️⚠️ 而 `flags` 是干净的判据。怎么确定的（这一步很重要）：
//   ① 先用**长度**反推：`len == ceil(w/4)*ceil(h/4)*16` ⟹ DXT3/5，
//     `len == w*h*4` ⟹ RGBA8888，等等。
//   ② 只取**唯一匹配**的那些样本（80 张）来学 `flags → 格式`；
//     有歧义的（92 张，w/h 都是 4 的倍数时 DXT3/5 和 R8 长度相同）**不参与学**。
//   ③ 学出来的表拿去核**全部** 172 张 ⟹ **一致 172、冲突 0**。
//   ⟹ 判据：**先用无歧义的样本学规则，再用规则解释有歧义的** ——
//     反过来（拿有歧义的去学）会把两种格式混成一个。
//
// ⚠️ 而剩下 6 张长度对不上任何像素格式的，是 `format=34` 的 **MP4 视频**。
const PIXEL_BY_FLAGS = {
  0: 'RGBA8888',
  4: 'DXT3/5',
  7: 'DXT1',
  8: 'RG88',
  9: 'R8',
};

// 每种像素格式的字节数算法（用来交叉验证，也用来上传时算长度）
const PIXEL_BYTES = {
  DXT1: (w, h) => Math.ceil(w / 4) * Math.ceil(h / 4) * 8,
  'DXT3/5': (w, h) => Math.ceil(w / 4) * Math.ceil(h / 4) * 16,
  R8: (w, h) => w * h,
  RG88: (w, h) => w * h * 2,
  RGB888: (w, h) => w * h * 3,
  RGBA8888: (w, h) => w * h * 4,
  RGBA16F: (w, h) => w * h * 8,
};

// ⚠️ 按长度反推候选（事实优先于声明）
function pixelCandidates(w, h, len) {
  return Object.entries(PIXEL_BYTES)
    .filter(([, fn]) => fn(w, h) === len)
    .map(([name]) => name);
}

// ⚠️⚠️ 定像素格式：`flags` 给答案，长度做交叉验证。
//   ⟹ 返回 { format, byFlags, byLength, agreed }
//   ⚠️ 不一致时**以长度为准**并标出来 —— 长度是事实，flags 是声明。
function resolvePixelFormat(flags, w, h, len) {
  const byFlags = PIXEL_BY_FLAGS[flags] || null;
  const byLength = pixelCandidates(w, h, len);
  if (byFlags && byLength.includes(byFlags)) {
    return { format: byFlags, byFlags, byLength, agreed: true };
  }
  // ⚠️ 长度只有一个候选 ⟹ 信它（那种情况 flags 一定是我们还没见过的值）
  if (byLength.length === 1) {
    return { format: byLength[0], byFlags, byLength, agreed: false };
  }
  // ⚠️ 都定不下来 ⟹ 说清是哪一种情况，别蒙一个
  return { format: byFlags || null, byFlags, byLength, agreed: false };
}

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
//  ⚠️⚠️⚠️ **TEXB 块：像素数据到底是什么**（2026-08-04，端到端模拟逼出来的）
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️⚠️⚠️ **`.tex` 的 body 通常不是裸 DXT，而是 PNG / JPEG / LZ4 压缩过的 DXT。**
//
//   我第一版做的是 `raw.slice(head.headerBytes)` 然后当 DXT 直接上传 ——
//   ⚠️ 而实测 34 张纹理里**没有一张**能那么用：
//     · 15 张的 body 是 **PNG**（魔数 89 50 4E 47）
//     · 1 张是 **JPEG**
//     · 其余是 **LZ4 压缩**的 DXT（`isLZ4=1`）或裸 DXT（`isLZ4=0`）
//   ⚠️ 症状会是"WebGL 报 INVALID_VALUE + 一张黑图"，
//     而 `format: DXT3` 的头部字段会让人一直往"DXT 上传"那个方向查。
//   ⟹ 判据：**头部声明的格式说的是"解出来之后是什么"，不是"存储时是什么"。**
//
// 实测的 TEXB 布局（34/34 吻合）：
//
//   [裸串 "TEXB0003"][\0]        ⚠️ 也有 TEXB0004（多一个字段，实测值 0）
//   [4B imageCount]              实测都是 1
//   每个 image：
//     [4B freeImageFormat]       ⚠️ **这是判别键**：13=PNG / 2=JPEG / 0xFFFFFFFF=无容器
//     [4B ?]                     ⚠️ 只有 TEXB0004 有（实测 0）
//     [4B mipCount]              实测 1 / 4 / 5
//     每个 mip：
//       [4B w][4B h][4B isLZ4][4B uncompressedLen][4B compressedLen][数据]
//       ⚠️ PNG/JPEG 的 `uncompressedLen` 是 **0**（那种没有"解压后长度"的概念）
//   [可选 TEXS 块]               ⚠️ 序列帧（sprite sheet）—— 实测 1 张有
//
// ⚠️ 我们只要 **mip 0**（最大那张）—— 壁纸铺满屏幕，用不上小 mip。
const TEXB_FORMATS = { 13: 'PNG', 2: 'JPEG', 0xFFFFFFFF: 'none' };

// 解析 TEXB 块，取出 mip 0 的**原始存储数据** + 它到底是什么编码。
//
// ⚠️ 返回 { ok, container, isLZ4, width, height, data, uncompressedLen, mipCount, hasSprite }
//   `container`：'PNG' / 'JPEG' / 'none'（none 表示解出来直接是 DXT/RGBA 像素）
function parseTexData(buf, head) {
  if (!buf || !head || !head.ok) return { ok: false, error: '.tex 头部没解出来' };
  const tb = buf.indexOf('TEXB', head.headerBytes - 8 > 0 ? 0 : 0, 'latin1');
  if (tb < 0) return { ok: false, error: '找不到 TEXB 块' };
  const texb = buf.toString('latin1', tb, tb + 8);
  let p = tb + 9;   // ⚠️ 裸串 8 字节 + \0
  const u32 = () => {
    if (p + 4 > buf.length) throw new RangeError(`读越界（偏移 ${p}）`);
    const v = buf.readUInt32LE(p) >>> 0;
    p += 4;
    return v;
  };
  try {
    const imageCount = u32();
    if (imageCount < 1 || imageCount > 64) {
      return { ok: false, error: `imageCount 不合理（${imageCount}）` };
    }
    const fmt = u32();
    // ⚠️⚠️ TEXB0004 在 format 之后多一个字段（实测值 0）——
    //   漏了它会把 mipCount 读成 0 ⟹ 一个 mip 都取不出来（症状是黑图）
    if (texb === 'TEXB0004') u32();
    const mipCount = u32();
    if (mipCount < 1 || mipCount > 32) {
      return { ok: false, error: `mipCount 不合理（${mipCount}）—— TEXB 版本是 ${texb}` };
    }
    // mip 0 就是最大那张
    const width = u32();
    const height = u32();
    const isLZ4 = u32();
    const uncompressedLen = u32();
    const compressedLen = u32();
    if (p + compressedLen > buf.length) {
      return { ok: false, error: `mip0 数据越界（需要 ${compressedLen} 字节，只剩 ${buf.length - p}）` };
    }
    const container = TEXB_FORMATS[fmt] || `未知(${fmt})`;
    // ⚠️⚠️ **像素格式**：只有"没有图片容器"（container==='none'）时才需要定它
    //   —— PNG/JPEG 那些浏览器自己认。
    //   ⚠️ 而 `format=34` 是 **MP4 视频**（那既不是像素也不是图片容器）。
    const isVideo = (head.formatName === 'MP4');
    const rawLen = isLZ4 === 1 ? uncompressedLen : compressedLen;
    const pix = (container === 'none' && !isVideo)
      ? resolvePixelFormat(head.flags, width, height, rawLen)
      : null;
    return {
      ok: true,
      texb,
      container,
      freeImageFormat: fmt,
      isLZ4: isLZ4 === 1,
      width,
      height,
      uncompressedLen,
      mipCount,
      // ⚠️ 视频纹理：数据是一整个 MP4 文件
      isVideo,
      // ⚠️⚠️ 头部声明的名字 —— `decodeTexture` 靠它在 **DXT3 / DXT5** 之间选。
      //   ⚠️ 那两个块大小一样（16B）⟹ 长度分不出来，而 alpha 的编码完全不同
      //     （DXT3 是 4bit 直值、DXT5 是 3bit 索引 + 两个端点）。
      //   ⟹ `format` 字段对"压不压缩"说谎，但对**块内布局**这一项可信。
      declaredName: head.formatName,
      // ⚠️ 像素格式（container==='none' 时才有）——
      //   `agreed:false` 意味着 flags 和长度对不上，那要报出来
      pixelFormat: pix ? pix.format : null,
      pixelAgreed: pix ? pix.agreed : null,
      pixelByFlags: pix ? pix.byFlags : null,
      pixelByLength: pix ? pix.byLength : null,
      data: buf.slice(p, p + compressedLen),
    };
  } catch (error) {
    return { ok: false, error: `TEXB 块读不通：${error.message}` };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  ⚠️⚠️⚠️ **LZ4 解压**（2026-08-04：实测 158/232 张贴图是 LZ4 压缩的）
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ 那是**块格式**（LZ4 block，不带帧头）—— WE 自己在 TEXB 里给了
//   `uncompressedLen`，所以不需要帧头里的长度。
//
// ⚠️⚠️ 而这是纯算术 ⟹ 放在这一层（云端可测），不放渲染层。
//   实测 13 张 LZ4 贴图逐张验过：解出来的长度 == 声明的 uncompressedLen。
//
// 格式：[token][literals][offset(2B, 小端)][matchLen 扩展]…
//   token 高 4 位 = 字面量长度、低 4 位 = 匹配长度 - 4
//   两者都用 15 表示"还有更多"，后面跟若干个 255 直到出现非 255
function lz4Decompress(src, destLen) {
  if (!src || !(destLen > 0)) return null;
  const dst = Buffer.alloc(destLen);
  let s = 0;
  let d = 0;
  try {
    while (s < src.length) {
      const token = src[s]; s += 1;
      // 字面量
      let lit = token >> 4;
      if (lit === 15) {
        let b;
        do { b = src[s]; s += 1; lit += b; } while (b === 255);
      }
      if (lit > 0) {
        if (s + lit > src.length || d + lit > destLen) break;
        src.copy(dst, d, s, s + lit);
        s += lit; d += lit;
      }
      // ⚠️ 最后一个序列只有字面量，没有匹配 ⟹ 到这里就结束
      if (s >= src.length) break;
      // 匹配
      const offset = src[s] | (src[s + 1] << 8); s += 2;
      if (offset === 0 || offset > d) break;   // ⚠️ 非法偏移：坏数据，停住而不是崩
      let mlen = token & 15;
      if (mlen === 15) {
        let b;
        do { b = src[s]; s += 1; mlen += b; } while (b === 255);
      }
      mlen += 4;
      // ⚠️⚠️ 匹配可以**重叠**（offset < mlen 时）⟹ 必须逐字节复制，
      //   不能用 copy（那会读到还没写的字节）。
      let r = d - offset;
      for (let i = 0; i < mlen && d < destLen; i += 1) { dst[d] = dst[r]; d += 1; r += 1; }
    }
  } catch {
    return { ok: false, error: 'LZ4 数据读越界', written: d, data: dst };
  }
  return {
    ok: d === destLen,
    // ⚠️ 长度不符要说清 —— 那是"数据坏了"或者"我的解压有 bug"，两种都要能看出
    error: d === destLen ? null : `解出 ${d} 字节，声明 ${destLen}`,
    written: d,
    data: dst,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  ⚠️⚠️ **DXT 解码**（S3TC → RGBA）
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ 为什么在 CPU 解而不用 WebGL 的 s3tc 扩展：
//   ① 那 84 张 DXT 里**大部分是遮罩**（mask），而遮罩要给我们自己的
//     合成/裁剪逻辑用 —— 走 GPU 纹理反而拿不回来。
//   ② s3tc 扩展在部分 mac GPU 上没有（实测要靠运行时探测）。
//   ③ DXT1/3/5 的解码是**几十行定长算术** ⟹ 比"两条路径分别维护"简单。
//   ⚠️ 而它是纯函数 ⟹ 云端能逐块验。
//
// 块布局（每块 4×4 像素）：
//   DXT1: [2B color0][2B color1][4B 2bit/px 索引]                 = 8B
//   DXT3: [8B alpha（4bit/px）][DXT1 的那 8B]                      = 16B
//   DXT5: [1B a0][1B a1][6B 3bit/px alpha 索引][DXT1 的那 8B]      = 16B
function rgb565(v) {
  const r = (v >> 11) & 0x1f;
  const g = (v >> 5) & 0x3f;
  const b = v & 0x1f;
  // ⚠️ 5/6 位扩到 8 位要**按比例**（<<3 会让最大值变 248 而不是 255）
  return [(r * 255 + 15) / 31 | 0, (g * 255 + 31) / 63 | 0, (b * 255 + 15) / 31 | 0];
}

function decodeDXT(src, width, height, variant) {
  const bw = Math.ceil(width / 4);
  const bh = Math.ceil(height / 4);
  const blockBytes = variant === 'DXT1' ? 8 : 16;
  if (src.length < bw * bh * blockBytes) {
    return { ok: false, error: `DXT 数据只有 ${src.length} 字节，`
      + `${width}×${height} 的 ${variant} 需要 ${bw * bh * blockBytes}` };
  }
  const out = Buffer.alloc(width * height * 4);
  let p = 0;
  for (let by = 0; by < bh; by += 1) {
    for (let bx = 0; bx < bw; bx += 1) {
      // ── alpha
      let alpha = null;      // 16 个像素的 alpha
      if (variant === 'DXT3') {
        alpha = new Array(16);
        for (let i = 0; i < 8; i += 1) {
          const b = src[p + i];
          // ⚠️ 4bit → 8bit 也要按比例（*17 = *255/15）
          alpha[i * 2] = (b & 0x0f) * 17;
          alpha[i * 2 + 1] = (b >> 4) * 17;
        }
        p += 8;
      } else if (variant === 'DXT5') {
        const a0 = src[p];
        const a1 = src[p + 1];
        const tab = [a0, a1];
        if (a0 > a1) {
          for (let i = 1; i <= 6; i += 1) tab.push(((7 - i) * a0 + i * a1) / 7 | 0);
        } else {
          for (let i = 1; i <= 4; i += 1) tab.push(((5 - i) * a0 + i * a1) / 5 | 0);
          tab.push(0, 255);
        }
        // 6 字节 = 16 个 3bit 索引
        let bits = 0n;
        for (let i = 0; i < 6; i += 1) bits |= BigInt(src[p + 2 + i]) << BigInt(8 * i);
        alpha = new Array(16);
        for (let i = 0; i < 16; i += 1) {
          alpha[i] = tab[Number((bits >> BigInt(3 * i)) & 7n)];
        }
        p += 8;
      }
      // ── 颜色（DXT1 那 8 字节）
      const c0 = src.readUInt16LE(p);
      const c1 = src.readUInt16LE(p + 2);
      const idx = src.readUInt32LE(p + 4);
      p += 8;
      const p0 = rgb565(c0);
      const p1 = rgb565(c1);
      const pal = [p0, p1];
      // ⚠️⚠️ DXT1 的 c0 <= c1 时第 4 个颜色是**透明黑**（那是 1bit alpha）——
      //   漏了这条的症状是"该透明的地方变成黑块"。
      //   ⚠️ 而 DXT3/5 里 alpha 由单独的块给 ⟹ 颜色永远走 4 色模式。
      const fourColor = (variant !== 'DXT1') || c0 > c1;
      if (fourColor) {
        pal.push([(2 * p0[0] + p1[0]) / 3 | 0, (2 * p0[1] + p1[1]) / 3 | 0, (2 * p0[2] + p1[2]) / 3 | 0]);
        pal.push([(p0[0] + 2 * p1[0]) / 3 | 0, (p0[1] + 2 * p1[1]) / 3 | 0, (p0[2] + 2 * p1[2]) / 3 | 0]);
      } else {
        pal.push([(p0[0] + p1[0]) / 2 | 0, (p0[1] + p1[1]) / 2 | 0, (p0[2] + p1[2]) / 2 | 0]);
        pal.push([0, 0, 0]);   // ⚠️ 这个是透明的（下面 a 会设 0）
      }
      for (let i = 0; i < 16; i += 1) {
        const px = bx * 4 + (i % 4);
        const py = by * 4 + (i / 4 | 0);
        if (px >= width || py >= height) continue;   // ⚠️ 边缘块超出实际尺寸
        const sel = (idx >> (2 * i)) & 3;
        const c = pal[sel];
        const o = (py * width + px) * 4;
        out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2];
        if (alpha) out[o + 3] = alpha[i];
        else out[o + 3] = (!fourColor && sel === 3) ? 0 : 255;
      }
    }
  }
  return { ok: true, data: out, width, height };
}

// ⚠️ 单通道/双通道 → RGBA（遮罩类贴图）
//   ⚠️⚠️ R8 是**灰度遮罩**：它的值该进 alpha 还是 rgb 取决于用途
//     ⟹ 两个都填（rgb=值、a=值），让调用方自己挑通道。
function expandToRGBA(src, width, height, format) {
  const out = Buffer.alloc(width * height * 4);
  const n = width * height;
  if (format === 'R8') {
    for (let i = 0; i < n; i += 1) {
      const v = src[i];
      out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = v;
    }
  } else if (format === 'RG88') {
    for (let i = 0; i < n; i += 1) {
      out[i * 4] = src[i * 2]; out[i * 4 + 1] = src[i * 2 + 1];
      out[i * 4 + 2] = 0; out[i * 4 + 3] = 255;
    }
  } else if (format === 'RGB888') {
    for (let i = 0; i < n; i += 1) {
      out[i * 4] = src[i * 3]; out[i * 4 + 1] = src[i * 3 + 1];
      out[i * 4 + 2] = src[i * 3 + 2]; out[i * 4 + 3] = 255;
    }
  } else if (format === 'RGBA8888') {
    src.copy(out, 0, 0, Math.min(src.length, out.length));
  } else {
    return { ok: false, error: `还不支持把 ${format} 展成 RGBA` };
  }
  return { ok: true, data: out, width, height };
}

// ⚠️⚠️⚠️ **贴图的 alpha 分布** —— 那是"这个图层为什么是一块实心色"的答案。
//
// ⚠️ 用户实测报「一块黑色遮挡了大部分画面」，而诊断里看不出原因：
//   那张贴图的 `container` / 尺寸 / 解码都正常。
//   ⟹ 真正的信息是**它有没有透明区域**：
//     一张 colorType=2（RGB 无 alpha）的 PNG 挂在加色图层上，
//     当普通不透明画就是一块实心的。
// ⟹ 判据：**"这张贴图能不能解出来"和"它长什么样"是两个问题**，
//   而诊断只报了前者 ⟹ 那类问题就查不出来。
function alphaProfile(dec) {
  if (!dec || !dec.ok) return null;
  // ⚠️ PNG/JPEG 这一层解不了（那要浏览器）⟹ 只报 colorType（PNG 头里有）
  if (dec.kind === 'image') {
    if (dec.mime !== 'image/png') return { kind: 'jpeg', hasAlpha: false };
    // PNG: 8 字节签名 + [4B len][IHDR][13B data]，colorType 在 data 的第 9 字节
    const ct = dec.data.length > 26 ? dec.data[25] : -1;
    return {
      kind: 'png',
      colorType: ct,
      // ⚠️ colorType 6=RGBA / 4=灰度+alpha 才有 alpha 通道
      hasAlpha: ct === 6 || ct === 4,
      note: ct === 2 ? 'RGB 无 alpha 通道（整张不透明）'
        : ct === 6 ? 'RGBA' : ct === 3 ? '索引色' : `colorType ${ct}`,
    };
  }
  if (dec.kind === 'video') return { kind: 'video', hasAlpha: false };
  // ⚠️ RGBA 缓冲：直接数
  const n = dec.width * dec.height;
  if (!n || dec.data.length < n * 4) return null;
  let a0 = 0;
  let aMid = 0;
  let a255 = 0;
  let lumSum = 0;
  // ⚠️ 大图抽样 —— 4K 逐像素数要几十毫秒，而这是诊断路径
  const step = n > 500000 ? 7 : 1;
  let counted = 0;
  for (let i = 0; i < n; i += step) {
    const a = dec.data[i * 4 + 3];
    if (a === 0) a0 += 1; else if (a < 255) aMid += 1; else a255 += 1;
    lumSum += (dec.data[i * 4] + dec.data[i * 4 + 1] + dec.data[i * 4 + 2]) / 3;
    counted += 1;
  }
  return {
    kind: 'rgba',
    hasAlpha: a0 + aMid > 0,
    transparent: +(a0 / counted).toFixed(3),
    semi: +(aMid / counted).toFixed(3),
    opaque: +(a255 / counted).toFixed(3),
    avgLum: Math.round(lumSum / counted),
    sampled: step > 1 ? counted : null,
  };
}

// ⚠️⚠️⚠️ **一步到底**：`.tex` 的 body → RGBA 像素（或者 PNG/JPEG/MP4 原样）
//   ⟹ 那让渲染层只需要处理三种输入：RGBA 缓冲 / 图片 blob / 视频 blob。
function decodeTexture(body) {
  if (!body || !body.ok) return { ok: false, error: '.tex 数据没解出来' };
  // ① 图片容器：原样给渲染层（浏览器自己解）
  if (body.container === 'PNG' || body.container === 'JPEG') {
    return { ok: true, kind: 'image', mime: body.container === 'PNG' ? 'image/png' : 'image/jpeg',
      data: body.data, width: body.width, height: body.height };
  }
  // ② 视频
  if (body.isVideo) {
    return { ok: true, kind: 'video', mime: 'video/mp4',
      data: body.data, width: body.width, height: body.height };
  }
  // ③ 像素数据：先解 LZ4，再按格式展成 RGBA
  if (!body.pixelFormat) {
    return { ok: false,
      error: `定不下像素格式（flags 说 ${body.pixelByFlags || '?'}、`
        + `长度允许 ${(body.pixelByLength || []).join('/') || '无'}）` };
  }
  let raw = body.data;
  if (body.isLZ4) {
    const un = lz4Decompress(body.data, body.uncompressedLen);
    if (!un || !un.ok) return { ok: false, error: `LZ4 解压失败：${un ? un.error : '空'}` };
    raw = un.data;
  }
  const f = body.pixelFormat;
  if (f === 'DXT1' || f === 'DXT3/5') {
    // ⚠️⚠️⚠️ **16 字节的那种一律按 DXT5 解**（2026-08-04 实测 61/61）。
    //
    // ⚠️ DXT3 和 DXT5 块大小一样（16B）⟹ 长度分不出来，
    //   而 `format` 字段**对这一项也说谎**（它说 DXT3）。
    // ⚠️⚠️ 怎么定的：同一份数据分别按 DXT3 / DXT5 解，量**块内行周期性**
    //   （真 DXT5 当 DXT3 解，会把 a0/a1 端点当成前 4 个像素的 4bit alpha
    //     ⟹ 每个 4×4 块的第 0 行和第 2 行 alpha 统计上差很远）。
    //   实测 61 张：DXT3 解的行周期差 79-108，DXT5 解只有 0-56
    //   ⟹ **全部指向 DXT5**，而且差距是一个数量级。
    //   ⚠️ 交叉验证：一张纯不透明背景（`h.tex`）按 DXT5 解是 100% alpha=255，
    //     按 DXT3 解出来是 12.5% 的周期性图案 —— 后者显然是错的。
    // ⟹ 判据：**"两种格式长度相同"时，用"哪种解出来更合理"判别** ——
    //   而"合理"要能量化（这里是行周期性），不能靠眼看。
    // ⚠️ 而这条错了的后果很隐蔽：alpha 变成一个 4 行周期的图案
    //   ⟹ 画面像蒙了一层细密的横纹，而那看起来像"这张贴图本来就有质感"。
    const variant = f === 'DXT1' ? 'DXT1' : 'DXT5';
    const r = decodeDXT(raw, body.width, body.height, variant);
    if (!r.ok) return r;
    return { ok: true, kind: 'rgba', data: r.data, width: r.width, height: r.height,
      pixelFormat: variant };
  }
  const r = expandToRGBA(raw, body.width, body.height, f);
  if (!r.ok) return r;
  return { ok: true, kind: 'rgba', data: r.data, width: r.width, height: r.height,
    pixelFormat: f };
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

// ═══════════════════════════════════════════════════════════════════════════
//  ⚠️⚠️⚠️ **属性包装**（2026-08-04 拿真实样本 audit 出来的，五个洞里最深的一个）
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ WE 编辑器里凡是"能被用户属性/脚本驱动"的字段，磁盘上**不是裸值**，
//   而是一个包装对象。实测两个样本一共 913 处包装，四种形状：
//
//     {user, value}                     ×655   绑到 project.json 的用户属性
//     {script, scriptproperties, value} ×187   绑到一段 JS
//     {script, user, value}             ×44
//     {script, value}                   ×27
//
//   ⟹ **四种都带 `value`，那就是静态默认值。**
//
// ⚠️⚠️ 而我第一版直接读裸值 ⟹ 实测后果（样本 A / 样本 B）：
//     · `visible` 219 处被包装（其中 146 处 value=false）
//       ⟹ 132 个图层里**多画 77 个**该隐藏的（一张壁纸有多套皮肤/多语言，
//          靠 visible 只亮一套 ⟹ 全画出来就是几套皮肤糊在一起）
//     · `alpha`/`brightness` 被包装 ⟹ `Number({...})` = **NaN**，
//       而 NaN 乘进颜色是**黑的**（166 个对象）⟹ 那就是"一团黑"的形状
//     · `origin` 63 处被包装 ⟹ 读成 [0,0,0] ⟹ 图层全堆在角上
//
// ⟹ 判据（这个项目已有的教训，这次又验证一次）：
//   **处理真实数据的功能，代码侧对数据形态的假设是理想化的** ——
//   动手就先拿真实数据 audit，每种没预料到的形状 = 一个洞。
function unwrapValue(v) {
  // ⚠️ 只认"对象且有 value 键" —— 数组不算（size 之类可能是数组）
  if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) return v.value;
  return v;
}

// ⚠️ 这个字段是不是被绑定了（有 user 或 script）——
//   那不是错误，但**它意味着静态值只是默认值**，实际运行时会变。
//   ⟹ 报出来让"这张壁纸的时钟不走"这种事有解释。
function isBound(v) {
  return !!(v && typeof v === 'object' && !Array.isArray(v)
    && ('user' in v || 'script' in v));
}

// ═══════════════════════════════════════════════════════════════════════════
//  ⚠️⚠️ **画布尺寸和坐标系**（同一次 audit）
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ 画布在 `general.orthogonalprojection` = `{width, height}`。
//   实测**两个样本都是 3840×2160**。
//   ⚠️ 而我第一版"从最大图层反推" ⟹ 样本 B 最大的图层是 **5760×2880**
//     （故意做得比画布大，留给视差移动的余量）⟹ 反推出来的画布大了 1.5 倍
//     ⟹ 整个画面缩小到 2/3，四周露黑边。
//   ⟹ 判据：**能直接读到的事实不要反推。**
//
// ⚠️⚠️⚠️ 坐标系（实测坐实，不是推的）：
//   `origin` 是**画布像素坐标里的对象中心**，原点在**左下角**，Y 轴向上。
//   三条证据：
//     ① 两个样本的背景层都是 `origin = 1920 1080` = 3840×2160 的正中
//     ② 样本 B 有一对 `遮罩`：x = -3130 和 6969，各 5050 宽
//        ⟹ 对称地贴在画布（0..3840）左右两侧之外
//        ⟹ 那只有"origin 是中心"才对得上（若是左上角则完全不对称）
//     ③ 抽 preview.gif 首帧比对：SUNDAY(y=1124) 在 DECEMBER(y=1074) **之上**，
//        而后者在 TIME IS 02:36(y=980) 之上 ⟹ **y 越大越靠上** = Y 轴向上
//   ⟹ 转成"以画布中心为原点"要减掉半宽半高（渲染层用中心原点）。
function centerOrigin(v, canvasW, canvasH) {
  return [v[0] - canvasW / 2, v[1] - canvasH / 2, v[2]];
}

// 读画布尺寸。⚠️ 读不到才退回默认（而不是反推）
function canvasSize(general) {
  const op = general && general.orthogonalprojection;
  const w = op && Number(unwrapValue(op.width));
  const h = op && Number(unwrapValue(op.height));
  if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) {
    return { width: w, height: h, source: 'general.orthogonalprojection' };
  }
  // ⚠️ 兜底要**说清是兜底** —— 否则"画面缩了 2/3"没人知道是这里
  return { width: 3840, height: 2160, source: '读不到，用默认 3840×2160' };
}

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
function parseVec3(input, fallback) {
  const fb = fallback || [0, 0, 0];
  // ⚠️⚠️ **先拆包装** —— 实测 63 处 `origin` 是 `{script, value}`，
  //   而不拆的话 `typeof v !== 'string'` 会让它走 fallback ⟹ 图层全堆在原点。
  const v = unwrapValue(input);
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
  // ⚠️ 画布先定 —— 后面每个 origin 都要靠它换算成"中心原点"
  const canvas = canvasSize(d.general);

  // ⚠️ 数值字段的统一读法：拆包装 → 转数字 → 非有限就走默认。
  //   ⚠️⚠️ 那个"非有限就走默认"是**防 NaN 传染**：实测 166 个对象的
  //     alpha/brightness 是包装对象，`Number({...})` = NaN，而 NaN 乘进颜色是**黑的**。
  const num = (v, dflt) => {
    const x = Number(unwrapValue(v));
    return Number.isFinite(x) ? x : dflt;
  };

  const objects = [];
  const skipped = [];
  // ⚠️ 有多少字段是被绑定的（用户属性/脚本驱动）—— 那要能报出来，
  //   因为它解释了"静态值只是默认值，实际会变"（时钟不走、皮肤切不了）
  let boundFields = 0;
  for (const o of rawObjects) {
    const kind = objectKind(o);
    // ⚠️ 不认识的类型**记下来但不报错** —— 那让"这张壁纸有 3 个我们不支持的东西"
    //   变成可观测的事实，而不是静默丢掉。
    if (kind === 'unknown' || kind === null) {
      skipped.push({ id: o && o.id, name: o && o.name, reason: '不认识的对象类型' });
      continue;
    }
    for (const v of Object.values(o)) if (isBound(v)) boundFields += 1;
    objects.push({
      id: o.id,
      name: o.name || '',
      kind,
      // ⚠️⚠️ `parent` 是**变换树**的边 —— 子对象的坐标相对父节点。
      //   ⚠️ 漏了它的症状是"图层位置全错"，而那看起来像"解析失败"。
      parent: o.parent === undefined ? null : o.parent,
      // ⚠️⚠️ `visible` 实测**全是包装对象**（两个样本 326 处，0 处裸 true）——
      //   而其中 187 处 `value: false`。
      //   ⚠️ 我第一版写 `o.visible !== false`（对象 !== false ⟹ 恒真）
      //     ⟹ 样本 A 的 132 个图层里**多画 77 个**该隐藏的
      //     ⟹ 那种壁纸有多套皮肤/多语言，全画出来就是几套糊在一起。
      //   ⟹ 拆包装之后只有显式 false 才算隐藏（拆不出值时当可见 —— 保守）
      visible: unwrapValue(o.visible) !== false,
      // ⚠️⚠️⚠️ `origin` **原样保留** —— 它的含义**取决于有没有父节点**：
      //   · 根对象（`parent == null`）：画布像素坐标里的**绝对**位置
      //   · 子对象：**相对父节点**的偏移
      //   ⟹ 所以换算成"画布中心原点"这件事只能在**知道父子关系之后**做
      //     （见下面的 `flattenTransforms`）。
      //   ⚠️ 我第一版在这里无条件减半宽半高 ⟹ 实测样本 A 的 `ripple1440p`
      //     从 (10, -221) 变成 (-1910, -1301) ⟹ 整层被推到画布外看不见。
      //     而样本 A 有 **264/271** 个对象是子对象 ⟹ 那会让几乎所有东西跑掉。
      origin: parseVec3(o.origin),
      angles: parseVec3(o.angles),
      scale: parseVec3(o.scale, [1, 1, 1]),
      size: parseVec3(o.size),
      // ⚠️ 视差深度：那是 scene 类"会动"的一个主要来源
      //   （鼠标移动时不同深度的图层错开）
      parallaxDepth: parseVec3(o.parallaxDepth),
      // ⚠️ 走 num() —— 见上面那段"防 NaN 传染"
      alpha: num(o.alpha, 1),
      brightness: num(o.brightness, 1),
      color: parseVec3(o.color, [1, 1, 1]),
      blendMode: num(o.colorBlendMode, 0),
      // 各类型自己的载荷
      image: kind === 'image' ? unwrapValue(o.image) : null,
      // ⚠️⚠️ `text` 的四种形态实测：裸串 17 / {user,value} 49 /
      //   {script,value} 6 / {script,scriptproperties,value} 25
      //   ⟹ 拆包装之后 84 个有内容、13 个空串、**0 个仍非字符串**
      text: kind === 'text' ? unwrapValue(o.text) : null,
      // ⚠️ 字体两种：`systemfont_xxx`（系统字体）和 `fonts/xxx.ttf`（包里的）
      font: unwrapValue(o.font) || null,
      // ⚠️ 文字排版要的那几个（实测字段名全小写）
      pointSize: num(o.pointsize, 32),
      hAlign: unwrapValue(o.horizontalalign) || 'center',
      vAlign: unwrapValue(o.verticalalign) || 'center',
      particle: kind === 'particle' ? unwrapValue(o.particle) : null,
      // ⚠️ effects 是一个数组，每项指向包里的一个 effect.json
      effects: Array.isArray(o.effects) ? o.effects : [],
      // ⚠️⚠️ tint/opacity 折成乘数（见 foldEffects 那段）——
      //   实测样本 B 的 54 个启用 effect 里 39 个是这两种。
      //   ⚠️ 而**剩下的要真 shader**，`fx.shaderNeeded` 就是那份缺口清单。
      fx: foldEffects(o.effects),
      // ⚠️ 音频柱的参数（没有就是 null）—— 渲染层按它画柱子
      audioBars: parseAudioBars(o.effects),
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
    // ⚠️ 画布尺寸和它的来源都要给出去（来源用来解释"为什么画面缩了"）
    canvas,
    // ⚠️ 有多少字段是被用户属性/脚本驱动的 —— 那解释了"时钟不走"这类事
    boundFields,
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
//  ⚠️⚠️⚠️ **贴图不在 `image` 字段里**（2026-08-04 端到端模拟逮出来的）
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️⚠️ 对象的 `image` 指向的是一个 **model JSON**，不是 `.tex`：
//
//     scene.json 的 image: "models/LonelyCAT.json"
//       ↓ 那个 JSON： { "autosize": true, "material": "materials/LonelyCAT.json" }
//     materials/LonelyCAT.json： { "passes": [ { "textures": ["LonelyCAT"], … } ] }
//       ↓ 贴图名 "LonelyCAT" 是**裸名**（没有目录、没有扩展名）
//     真文件： materials/LonelyCAT.tex
//
// ⚠️⚠️⚠️ 我第一版直接把 `image` 当 `.tex` 路径 ⟹ **两个样本一张纹理都读不出来**
//   （报"不是 .tex 文件 —— 头 4 字节是 `{...`"）⟹ 画面会是全黑。
//   ⚠️ 而这个洞**纯函数测试逮不到** —— 我的合成样本里 `image` 直接指向 `.tex`，
//     那是我按自己的假设造的。
//   ⟹ 判据（这个项目的老教训又验证一次）：
//     **合成测试数据是按代码的假设造的 ⟹ 它只能证明代码自洽，不能证明假设对。**
//     端到端跑一遍真实输入才逮得到。
//
// ⚠️ 而 material 的 `passes[].textures` 是个**数组**：第一个是主贴图，
//   后面是遮罩/法线之类（给 shader 用的）⟹ 我们只取第一个。
//   ⚠️ 它还可能有 `null` 元素（实测 shader 有多个贴图槽位但只填了一部分）。
function resolveImageTexture(buf, pkg, imageRef, readJson) {
  const out = { ok: false, ref: imageRef, chain: [] };
  if (typeof imageRef !== 'string' || !imageRef) {
    out.error = 'image 字段不是字符串';
    return out;
  }
  // ⚠️ 有的对象的 image **直接**指向 .tex（不经 model）⟹ 两种都要认
  if (/\.tex$/i.test(imageRef)) {
    out.chain.push(imageRef);
    out.texPath = imageRef;
    out.ok = true;
    return out;
  }
  // ⚠️⚠️⚠️ **`models/util/composelayer.json` / `projectlayer.json` 是 WE 的内置模型** ——
  //   它们**不在 .pkg 里**（WE 自己的安装目录才有），而且它们**没有自己的贴图**。
  //   ⚠️ 那是"合成层"：它抓取下面已经画好的画面，再套 effect（模糊/色散/音频柱…）。
  //   ⟹ 实测样本 A 有 3 个、样本 B 有 11 个 ⟹ 一共 14 个，占失败总数的全部。
  //   ⚠️⚠️ 所以它们**不是错误**，是"我们不做合成"这件事的必然结果。
  //     ⟹ 判据：**"读不到"和"本来就没有"要分开报** ——
  //       混在一起会让 14 个正常现象看起来像 14 个 bug，而真的 bug 就藏在里面了。
  //   ⚠️ 而挂了音频柱的那几个（Bar 1 / 音频2…）照样要画 —— 柱子是我们自己生成的，
  //     不需要贴图（见渲染层 `o.audioBars` 那条分支）。
  if (/^models\/util\//.test(imageRef)) {
    out.composite = imageRef.replace(/^models\/util\//, '').replace(/\.json$/, '');
    out.error = `合成层（${out.composite}）—— 它没有自己的贴图，`
      + '画面来自它下面的图层 + effect';
    return out;
  }
  const model = readJson(imageRef);
  if (!model) { out.error = `model 读不到：${imageRef}`; return out; }
  out.chain.push(imageRef);
  const matPath = model.material;
  if (typeof matPath !== 'string') {
    out.error = `${imageRef} 里没有 material 字段`;
    return out;
  }
  const mat = readJson(matPath);
  if (!mat) { out.error = `material 读不到：${matPath}`; return out; }
  out.chain.push(matPath);
  const pass = (mat.passes || [])[0];
  const texList = (pass && pass.textures) || [];
  // ⚠️ 取第一个非空的（数组里可能有 null）
  const texName = texList.find((t) => typeof t === 'string' && t);
  if (!texName) {
    out.error = `${matPath} 的 passes[0].textures 里没有贴图名`;
    // ⚠️ shader 也记下来 —— 那解释了"这个图层是程序生成的没有贴图"
    out.shader = pass && pass.shader;
    return out;
  }
  // ⚠️⚠️ 贴图名是**裸名**（"LonelyCAT"）⟹ 要拼成 `materials/<名>.tex`。
  //   ⚠️ 而它**也可能已经带路径**（实测 "workshop/2562725207/particle/Star_04"）
  //     ⟹ 那种直接前缀 materials/ 就对了。
  const candidates = [
    `materials/${texName}.tex`,
    `${texName}.tex`,
    texName,
  ];
  const hit = candidates.find((c) => pkg.entries.some((e) => e.name === c));
  if (!hit) {
    out.error = `贴图 "${texName}" 在包里找不到`
      + `（试过：${candidates.join(' / ')}）`;
    return out;
  }
  out.chain.push(hit);
  out.texPath = hit;
  out.texName = texName;
  out.shader = pass.shader;
  // ⚠️ 混合模式在 material 里（"translucent" / "additive" / "normal"）——
  //   那比 scene.json 的 colorBlendMode 更可靠（后者取值 9/31 我们没坐实）
  out.blending = pass.blending || null;
  out.ok = true;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
//  ⚠️⚠️⚠️ **effect（shader 效果）**（2026-08-04 audit）
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️⚠️ 这一段是本次 audit 最要紧的发现：**scene 类壁纸的动态主要来自 effect，
//   不是视差。**
//   实测样本 A 的 8 个可见对象：**视差深度全是 0**，而它们挂着 15 个 effect
//   （waterripple / cursorripple / pulse / shake / Simple_Audio_Bars…）。
//   ⟹ 我原本以为"视差就能让 scene 活起来"⟹ 那对样本 A **完全不成立**
//     （它会是一张完全静止的图 —— 而那正是 OWE 被我批评的那个形状）。
//   ⚠️ 样本 B 好一些：87 个可见对象里 11 个有视差深度。
//
// ⚠️ 而 effect 的门槛很高：`.frag` 里有 `#include "common.h"`、
//   `[COMBO_OFF]` 预处理宏、`g_Texture0Resolution` 这类宿主注入的 uniform
//   ⟹ 通用 shader 管线是一个独立的大工程（不是这一版能做完的）。
//
// ⟹ 所以分两类：
//   ①**能折进材质的** —— `tint`（乘颜色）和 `opacity`（乘透明度）
//     不需要 shader，它们就是两个乘法。实测样本 B 的 54 个启用 effect 里
//     **39 个是这两种**（tint 一个就占 80 次引用）。
//   ② 其余要真 shader ⟹ **明确报出来**，不静默少画。
const FOLDABLE_EFFECTS = /\/(tint|opacity)\/effect\.json$/;

// ⚠️⚠️⚠️ **音频柱** —— `Simple_Audio_Bars` 是一个例外：它虽然是个 shader，
//   但它的参数是**完全声明式**的（实测），而我们**已经有 WE 那套 128 段频谱**
//   （`audio-bins.js`，逆向自 linux-wallpaperengine 并做成可测规格）。
//   ⟹ 那意味着不用编译它的 `.frag`，用 canvas 按参数画柱子就能还原。
//
// ⚠️ 实测参数（两个样本一共 4 处）：
//     "Bar Count": 35 / 30 / 1        柱子数
//     "Bar Spacing": 0.5 / 0.3        柱间距（占单柱宽的比例）
//     "Lower/Upper Bar Bounds": "0 0.5" / "0.35 0.4" / "0.16 200"
//                                     柱高的下界/上界（占对象高度的比例）
//     "Bar Color": {user, value}      颜色（包装对象）
//   ⚠️⚠️ 而上界会是 **200**（"0.16 200"）—— 那显然不是"占比"而是别的含义
//     ⟹ 判据：**参数的含义不能从一个样本反推**，所以上界要夹住
//       （否则柱子高 200 倍画布 = 整屏一片纯色）。
//
// ⚠️ 而它是"我们能还原的"和"要真 shader 的"之间的分界线上那一个 ——
//   所以它**不算 shader 缺口**，但要在诊断里说清是"按参数近似还原"而不是原版。
const AUDIO_BARS_EFFECT = /Simple_Audio_Bars\/effect\.json$/;

// 解析音频柱的参数。⚠️ 返回 null 表示这个对象没有音频柱
function parseAudioBars(effects) {
  for (const e of effects || []) {
    if (!effectEnabled(e) || !AUDIO_BARS_EFFECT.test(e.file || '')) continue;
    const pass = (e.passes || [])[0] || {};
    const cv = pass.constantshadervalues || {};
    const bounds = String(unwrapValue(cv['Lower/Upper Bar Bounds']) || '0 0.5')
      // ⚠️ 实测两种分隔：`"0 0.5"`（空格）和 `"0.02, 0.02"`（逗号）
      //   ⟹ 两种都要吃，否则解析出 NaN ⟹ 柱子消失
      .split(/[\s,]+/).filter(Boolean).map(Number);
    const lower = Number.isFinite(bounds[0]) ? bounds[0] : 0;
    // ⚠️⚠️ 上界夹在 1 以内 —— 实测见过 200（见上面那段判据）
    const upperRaw = Number.isFinite(bounds[1]) ? bounds[1] : 0.5;
    const count = Math.max(1, Math.min(256,
      Math.round(Number(unwrapValue(cv['Bar Count'])) || 32)));
    const spacing = Math.max(0, Math.min(0.95,
      Number(unwrapValue(cv['Bar Spacing'])) || 0));
    return {
      count,
      spacing,
      lower: Math.max(0, Math.min(1, lower)),
      upper: Math.max(0.02, Math.min(1, upperRaw)),
      // ⚠️ 上界被夹过要记下来 —— 那解释了"柱子比原版短"
      upperClamped: upperRaw > 1 ? upperRaw : null,
      color: parseVec3(cv['Bar Color'], [1, 1, 1]),
      alpha: (() => {
        const a = Number(unwrapValue(cv.ui_editor_properties_opacity));
        return Number.isFinite(a) ? a : 1;
      })(),
      // ⚠️ combos 里的 SHAPE / BLENDMODE 我们没还原 —— 报出来当线索
      combos: pass.combos || {},
      name: e.name || '',
    };
  }
  return null;
}

// ⚠️ effect 自己也有 visible（而且也可能是包装对象）
function effectEnabled(e) {
  return unwrapValue(e && e.visible) !== false;
}

// 把 tint / opacity 折成一对乘数。⚠️ 返回 { color:[r,g,b], alpha, folded, shaderNeeded }
//
// ⚠️ 实测 effect 的参数在 `passes[].constantshadervalues.{color,alpha}`，
//   而它们**也是包装对象**（`{user, value}`）⟹ 同样要拆。
function foldEffects(effects) {
  const color = [1, 1, 1];
  let alpha = 1;
  const folded = [];
  const shaderNeeded = [];
  for (const e of effects || []) {
    if (!effectEnabled(e)) continue;   // ⚠️ 关掉的 effect 不算缺口
    const file = e.file || '';
    // ⚠️⚠️ 音频柱不算缺口 —— 我们按参数画（见 AUDIO_BARS_EFFECT 那段）
    if (AUDIO_BARS_EFFECT.test(file)) continue;
    if (!FOLDABLE_EFFECTS.test(file)) {
      shaderNeeded.push(file.replace(/^effects\/(workshop\/[\d/]+)?/, '')
        .replace(/\/effect\.json$/, ''));
      continue;
    }
    for (const pass of e.passes || []) {
      const cv = pass.constantshadervalues || {};
      if (cv.color !== undefined) {
        const c = parseVec3(cv.color, [1, 1, 1]);
        color[0] *= c[0]; color[1] *= c[1]; color[2] *= c[2];
      }
      if (cv.alpha !== undefined) {
        const a = Number(unwrapValue(cv.alpha));
        if (Number.isFinite(a)) alpha *= a;
      }
    }
    folded.push(file.replace(/\/effect\.json$/, '').replace(/^effects\//, ''));
  }
  return { color, alpha, folded, shaderNeeded };
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
  // ⚠️⚠️ 文字：canvas 画字 → 纹理（实测样本 B 的 97 个文字占 70%
  //   ⟹ 那是图层之后最大的缺口）。包里的 ttf/otf 走 FontFace 注册。
  text: 'full',
  particle: 'none',   // 粒子系统
  shape: 'none',      // 带 effect 的形状层
  light: 'none',      // 灯光
  unknown: 'none',
};

// 给一份"能画多少"的报告。⚠️ 面板和日志都要它。
function renderability(scene) {
  if (!scene || !scene.ok) return { ok: false };
  // ⚠️⚠️ 数的是**继承后仍可见的**对象（`worldVisible`，摊平变换树时算出来的）。
  //   ⚠️ 我第一版数 `counts`（全部对象）⟹ 样本 A 报"能画 222 个"，
  //     而实际该画的只有 **8** 个（其余是 5 套非英语语言 + 备用时钟皮肤，
  //     挂在 visible=false 的父节点下）。
  //   ⟹ 判据：**报给用户的数字要和屏幕上的东西同一个口径。**
  //     "能画 222 个"配一张只有 8 个元素的画面 = 那个数字毫无意义。
  //   ⚠️ 而没摊平过的 scene（没跑 flattenTransforms）退回用 counts —— 但要说清。
  const flattened = (scene.objects || []).some((o) => o.worldVisible !== undefined);
  const counts = flattened
    ? (scene.objects || []).filter((o) => o.worldVisible).reduce((acc, o) => {
      acc[o.kind] = (acc[o.kind] || 0) + 1;
      return acc;
    }, {})
    : (scene.counts || {});
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
  // ⚠️⚠️⚠️ **shader effect 是独立的一维缺口** —— 一个对象可以"画出来了"
  //   但它的水波纹/音频柱效果没有 ⟹ 那是"静止的图"。
  //   ⚠️ 实测样本 A 的 8 个可见对象全都不带视差、动态**全靠 effect**
  //     ⟹ 不报这一项，覆盖率 100% 会是个**假承诺**（画面是静止的）。
  //   ⟹ 判据：**覆盖率要按"用户看到什么"分维度**，不是只数对象。
  const shaderMiss = {};
  let foldedN = 0;
  for (const o of scene.objects || []) {
    if (!o.fx) continue;
    if (o.worldVisible === false) continue;
    foldedN += o.fx.folded.length;
    for (const name of o.fx.shaderNeeded) {
      shaderMiss[name] = (shaderMiss[name] || 0) + 1;
    }
  }
  const shaderNames = Object.keys(shaderMiss);
  const shaderMissN = Object.values(shaderMiss).reduce((a, b) => a + b, 0);

  return {
    ok: true,
    // ⚠️ 口径要跟着数字走出去 —— 否则"8 个"和"271 个"没法对账
    scope: flattened ? '继承父节点 visible 之后仍可见的对象' : '全部对象（变换树没摊平）',
    doneN,
    missN,
    // effect：折进材质的（tint/opacity）和还要 shader 的
    effectsFolded: foldedN,
    shaderMissN,
    shaderMissing: shaderNames.sort((a, b) => shaderMiss[b] - shaderMiss[a])
      .map((n) => `${n}${shaderMiss[n] > 1 ? `×${shaderMiss[n]}` : ''}`),
    // ⚠️ 覆盖率按**对象数**算 —— 那比"种类数"更接近"画面上缺了多少"
    coverage: total > 0 ? doneN / total : 1,
    done,
    missing,
    // ⚠️⚠️ 一句能直接显示给用户的话 —— 而它要**说清缺什么**，
    //   不是"部分支持"这种没信息量的说法
    summary: (missN === 0
      ? `这张 scene 的 ${doneN} 个元素都能画`
      : `能画 ${doneN} 个元素（${done.join(' / ')}），`
        + `还有 ${missN} 个画不了（${missing.join(' / ')}）`)
      // ⚠️⚠️ shader 缺口要**同一句话里说** —— 否则"都能画"读起来像
      //   "效果全有"，而实际可能是一张静止的图。
      + (shaderMissN > 0
        ? `；另有 ${shaderMissN} 个 shader 效果做不了`
          + `（${shaderNames.slice(0, 5).join(' / ')}${shaderNames.length > 5 ? '…' : ''}）`
          + '，那些元素会是静止的'
        : ''),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  ⚠️⚠️⚠️ **变换树摊平**（2026-08-04 实测样本 A 逼出来的）
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ 实测样本 A：271 个对象里 **264 个有 parent**，层级深度分布 {0:7, 1:54, 2:210}
//   ⟹ 绝大多数东西挂在两层之下。
//   而样本 B：140 个对象**全是根**（0 个 parent）⟹ 两种极端都有。
//
// ⚠️⚠️ 而 `origin` 的含义**取决于有没有父节点**：
//     根对象  → 画布像素坐标里的**绝对**位置（实测范围 x:139~1920 y:133~1080）
//     子对象  → **相对父节点**的偏移（实测范围 x:-1555~1774 y:-898~898，绕 0 分布）
//   ⟹ 那两个范围的分布形状本身就是证据。
//
// ⚠️⚠️⚠️ 判据：**"所有对象的坐标都是同一个意思"是个理想化假设。**
//   我第一版对每个对象都减半宽半高 ⟹ 子对象被推出画布（(10,-221) → (-1910,-1301)）。
//   ⟹ 而症状会是"背景在、别的全没了"，那看起来像"纹理没加载"。
//
// ⟹ 这个函数把树摊平成**每个对象一份世界坐标**（渲染层不用管父子）。
//   ⚠️ 缩放要**沿链累乘**，位置要**被父的缩放缩过**再累加。
function flattenTransforms(scene) {
  if (!scene || !scene.ok) return scene;
  const canvas = scene.canvas || { width: 3840, height: 2160 };
  const byId = new Map();
  for (const o of scene.objects) if (o.id !== undefined) byId.set(o.id, o);

  const done = new Map();
  const cycles = [];
  const dangling = [];

  function world(o, chain) {
    if (done.has(o)) return done.get(o);
    let out;
    const pid = o.parent;
    if (pid === null || pid === undefined) {
      // 根：绝对画布坐标 ⟹ 换成中心原点
      out = {
        pos: centerOrigin(o.origin, canvas.width, canvas.height),
        scale: o.scale.slice(),
        angles: o.angles.slice(),
      };
    } else if (!byId.has(pid)) {
      // ⚠️ parent 指向不存在的 id —— 实测 0 例，但坏包会有。
      //   ⟹ 当根处理并**记下来**（静默当根会让位置错得莫名其妙）
      dangling.push({ id: o.id, name: o.name, parent: pid });
      out = {
        pos: centerOrigin(o.origin, canvas.width, canvas.height),
        scale: o.scale.slice(),
        angles: o.angles.slice(),
      };
    } else if (chain.has(o.id)) {
      // ⚠️⚠️ 环 —— 那会让递归爆栈。实测 0 例，但**必须防**：
      //   一个手改过的 scene.json 就能造出来，而爆栈的症状是整个壁纸白屏。
      cycles.push({ id: o.id, name: o.name });
      out = { pos: o.origin.slice(), scale: o.scale.slice(), angles: o.angles.slice() };
    } else {
      chain.add(o.id);
      const p = world(byId.get(pid), chain);
      chain.delete(o.id);
      // ⚠️ 子对象的偏移要被**父的缩放**缩过（那是变换树的定义）
      out = {
        pos: [
          p.pos[0] + o.origin[0] * p.scale[0],
          p.pos[1] + o.origin[1] * p.scale[1],
          p.pos[2] + o.origin[2],
        ],
        scale: [
          o.scale[0] * p.scale[0],
          o.scale[1] * p.scale[1],
          o.scale[2] * p.scale[2],
        ],
        // ⚠️ 旋转只累加 Z —— scene 是 2.5D，实测 angles 的 x/y 几乎全是 0
        angles: [o.angles[0], o.angles[1], o.angles[2] + p.angles[2]],
      };
    }
    done.set(o, out);
    return out;
  }

  for (const o of scene.objects) {
    const w = world(o, new Set());
    o.worldPos = w.pos;
    o.worldScale = w.scale;
    o.worldAngles = w.angles;
    // ⚠️⚠️ 父节点隐藏 ⟹ 子节点也不该画（实测样本 A 靠 visible 切 6 种语言，
    //   而语言组是**父节点** ⟹ 不继承的话 6 套语言的字全糊在一起）
    let vis = o.visible;
    let c = o;
    let guard = 0;
    while (vis && c && c.parent !== null && c.parent !== undefined && byId.has(c.parent)) {
      c = byId.get(c.parent);
      if (!c.visible) vis = false;
      guard += 1;
      if (guard > 32) break;   // ⚠️ 环的兜底（上面已记，这里只防死循环）
    }
    o.worldVisible = vis;
  }

  scene.transformWarnings = [];
  if (cycles.length) {
    scene.transformWarnings.push(`${cycles.length} 个对象的父子关系有环`);
  }
  if (dangling.length) {
    scene.transformWarnings.push(`${dangling.length} 个对象的 parent 指向不存在的 id`);
  }
  return scene;
}

module.exports = {
  KNOWN_VERSIONS,
  PIXEL_BY_FLAGS,
  PIXEL_BYTES,
  pixelCandidates,
  resolvePixelFormat,
  lz4Decompress,
  decodeDXT,
  expandToRGBA,
  decodeTexture,
  alphaProfile,
  flattenTransforms,
  resolveImageTexture,
  FOLDABLE_EFFECTS,
  AUDIO_BARS_EFFECT,
  foldEffects,
  parseAudioBars,
  effectEnabled,
  unwrapValue,
  isBound,
  canvasSize,
  centerOrigin,
  TEX_FORMATS,
  RENDER_SUPPORT,
  renderability,
  parsePkg,
  readEntry,
  summarize,
  parseTexHeader,
  parseTexData,
  TEXB_FORMATS,
  parseScene,
  objectKind,
  parseVec3,
};
