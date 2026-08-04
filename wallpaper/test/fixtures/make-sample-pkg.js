// 造 `sample.scene.pkg` —— scene 解析那一层的测试输入。
//
//   node test/fixtures/make-sample-pkg.js
//
// ⚠️⚠️⚠️ **为什么要有这个生成器（而不是手写一个 fixture）**
//
// 2026-08-04 那次 audit 的教训：我第一版的合成样本是**按我自己的假设造的** ——
//   `image` 直接指向 `.tex`、`visible` 是裸 bool、`.tex` 的 body 是裸 DXT。
//   ⟹ 25 项测试全绿，而**真实壁纸一张纹理都读不出来**（画面全黑）。
//
// ⚠️ 判据：**合成测试数据是按代码的假设造的 ⟹ 它只能证明代码自洽，
//   不能证明假设对。** 而那正是"全绿但完全不能用"的成因。
//
// ⟹ 所以这个生成器里的每一种形状都标注了它来自哪个真实样本的实测，
//   而**改它之前要先在真实样本上确认那个形状真的存在**。
//     样本 A：`3299228616`（Lonely Cat，PKGV0022，111 条目，271 对象）
//     样本 B：`2902406982`（麻匪 月半与鬼哭，PKGV0024，129 条目，140 对象）
//   ⚠️ 真实包不进 git（11MB / 123MB）⟹ 这个合成包 ~4KB。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// ── PNG：造一张纯色小图（⚠️ 真实贴图的 body 就是 PNG，见下面那段）
function makePng(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y += 1) {
    raw[p] = 0; p += 1;             // 每行的 filter 字节
    for (let x = 0; x < w; x += 1) {
      raw[p] = rgb[0]; raw[p + 1] = rgb[1]; raw[p + 2] = rgb[2];
      p += 3;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // color type = truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

// ── .tex
//
// ⚠️⚠️ 头部的字符串是**裸串 + \0**（**不带**长度前缀）——
//   和 PKGV 的字符串格式不一样。⟹ 我照 PKGV 假设了长度前缀，
//   把 "TEXV" 读成了 1448625492。
//
// ⚠️⚠️⚠️ 而 body 是 **TEXB 块**，里面装的是 **PNG/JPEG**（不是裸 DXT）：
//   实测 34 张纹理里 15 张 PNG、1 张 JPEG、其余 LZ4 压缩的 DXT，
//   而**图层真正用到的 11 张里 10 张是 PNG**。
//   ⟹ 头部 `format` 说 DXT3 只是"解出来之后是什么"。
function makeTex({ format, texW, texH, imgW, imgH, flags = 0, body, texbVersion = 'TEXB0003' }) {
  const head = Buffer.concat([
    Buffer.from('TEXV0005\0', 'latin1'),
    Buffer.from('TEXI0001\0', 'latin1'),
    u32(flags), u32(format),
    u32(texW), u32(texH),
    u32(imgW), u32(imgH),
    // ⚠️ 实测头部和 TEXB 之间有 4 字节（看着像主色）
    Buffer.from([0xe5, 0xdc, 0xd6, 0xff]),
  ]);
  const mip = Buffer.concat([
    u32(imgW), u32(imgH),
    u32(0),              // isLZ4
    u32(0),              // ⚠️ PNG/JPEG 的 uncompressedLen 实测是 0
    u32(body.length),
    body,
  ]);
  const texb = Buffer.concat([
    Buffer.from(`${texbVersion}\0`, 'latin1'),
    u32(1),              // imageCount
    u32(13),             // ⚠️ freeImageFormat：13=PNG（判别键）
    // ⚠️⚠️ TEXB0004 在这里**多一个字段**（实测 0）——
    //   漏了它会把 mipCount 读成 0 ⟹ 一个 mip 都取不出来（黑图）
    ...(texbVersion === 'TEXB0004' ? [u32(0)] : []),
    u32(1),              // mipCount
    mip,
  ]);
  return Buffer.concat([head, texb]);
}

function u32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
}
function pstr(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([u32(b.length), b]);
}

// ── scene.json
//
// ⚠️⚠️⚠️ 这里每一种形状都是实测来的：
//   · `image` 指向 **model JSON**（不是 .tex）——
//     真链路是 `models/x.json → materials/x.json → 贴图裸名 → materials/<名>.tex`
//   · `visible` / `alpha` / `origin` / `text` 是**包装对象** `{user|script, value}`
//     （两个样本一共 913 处）
//   · 子对象的 `origin` 是**相对父节点**的（样本 A 有 264/271 个子对象）
//   · `models/util/composelayer.json` 是 WE **内置**模型（不在包里、没有贴图）
const scene = {
  version: 1,
  camera: { center: '0 0 -1', eye: '0 0 0', up: '0 1 0' },
  general: {
    clearcolor: '0.05 0.06 0.12',
    // ⚠️⚠️ 画布尺寸在这里（实测两个样本都是 3840×2160）——
    //   而**不要**从最大图层反推：样本 B 最大图层 5760×2880（留给视差的余量）
    orthogonalprojection: { width: 1024, height: 512 },
    cameraparallax: true,
    cameraparallaxamount: 0.5,
    cameraparallaxmouseinfluence: 0.5,
    cameraparallaxdelay: 0.1,
  },
  objects: [
    // ── 根对象：origin 是**绝对**画布坐标（1024/2, 512/2 = 正中）
    {
      id: 1,
      name: '底图',
      image: 'models/bg.json',
      origin: '512 256 0',
      size: '1024 512',
      scale: '1 1 1',
      parallaxDepth: '0.1 0.1',
      colorBlendMode: 31,          // ⚠️ 实测取值是 9 / 31（不是 0/1/2）
    },
    // ── 子对象：origin **相对父节点**，而 visible 被包装
    {
      id: 2,
      name: '前景',
      parent: 1,
      image: 'models/fg.json',
      origin: '100 -50 1',
      size: '256 256',
      scale: '2 2 1',
      parallaxDepth: '0.5 0.5',
      // ⚠️ {user, value}：实测 655 处
      alpha: { user: 'fgopacity', value: 0.8 },
      brightness: 1.2,
      visible: { user: { condition: '1', name: 'language' }, value: true },
    },
    // ──⚠️⚠️ 被父节点关掉的分支（实测样本 A 靠这个切 6 种语言）
    {
      id: 3, name: '备用皮肤组', parent: 1, angles: '0 0 0',
      visible: { user: { condition: '2', name: 'language' }, value: false },
      origin: '0 0 0',
    },
    {
      id: 4,
      name: '备用皮肤里的图',
      parent: 3,
      image: 'models/fg.json',
      origin: '0 0 2',
      size: '256 256',
      // ⚠️ 它自己 visible=true，但**祖先是 false** ⟹ 不该画
      visible: { user: { condition: '2', name: 'language' }, value: true },
    },
    // ── 文字：四种 text 形态（实测 裸串 17 / {user,value} 49 / {script,value} 6 /
    //   {script,scriptproperties,value} 25）
    {
      id: 5, name: '标题', parent: 1,
      text: { user: '_1', value: '壁纸引擎' },
      font: 'fonts/测试字体.ttf',
      pointsize: 32, horizontalalign: 'center', verticalalign: 'center',
      origin: '0 100 3', size: '400 120',
      // ⚠️ origin 被包装（实测 63 处）—— 不拆会读成 [0,0,0]
      color: { script: '// 一段脚本\n', value: '1 0.8 0.6' },
    },
    {
      id: 6, name: '空占位', parent: 1,
      // ⚠️ 空串（实测 13 个）—— 不画，但**不算失败**
      text: '', font: 'systemfont_arial', origin: '0 0 3', size: '2 2',
    },
    // ──⚠️⚠️⚠️ 合成层：WE 内置模型，**不在包里**、本来没有贴图。
    //   它挂着音频柱 ⟹ 照样要画（柱子是我们生成的，不要贴图）
    {
      id: 7, name: '音频柱', parent: 1,
      image: 'models/util/composelayer.json',
      origin: '0 -150 4', size: '800 200',
      effects: [{
        file: 'effects/workshop/2084198056/Simple_Audio_Bars/effect.json',
        passes: [{
          combos: { RESOLUTION: 16 },
          constantshadervalues: {
            'Bar Count': 35,
            'Bar Spacing': 0.5,
            'Lower/Upper Bar Bounds': '0 0.5',
            'Bar Color': { user: 'barcolor', value: '1 1 1' },
          },
        }],
        visible: true,
      }],
    },
    // ── 能折进材质的 effect（tint / opacity）—— 实测 39/54
    {
      id: 8, name: '被染色的图', parent: 1,
      image: 'models/fg.json', origin: '-200 0 5', size: '128 128',
      effects: [
        {
          file: 'effects/tint/effect.json',
          passes: [{ constantshadervalues: { color: { user: 'c', value: '1 0.5 0.5' } } }],
          visible: true,
        },
        {
          file: 'effects/opacity/effect.json',
          passes: [{ constantshadervalues: { alpha: { user: 'a', value: 0.2 } } }],
          visible: true,
        },
        // ⚠️ 关掉的 effect **不算缺口**
        { file: 'effects/blur/effect.json', passes: [], visible: false },
        // ⚠️ 要真 shader 的（报缺口）
        { file: 'effects/waterripple/effect.json', passes: [], visible: true },
      ],
    },
    // ── 声音：有意不做（不算缺口）
    { id: 9, name: '背景音乐', sound: ['sound.mp3'], origin: '0 0 0' },
    // ── 粒子：还没做（算缺口）
    { id: 10, name: '星星', parent: 1, particle: 'particles/star.json', origin: '0 0 6' },
    // ──⚠️ 完全不认识的（记下来但不丢）
    { id: 11, name: '怪东西', weird: true },
  ],
};

// ── 组装
const png = makePng(8, 8, [120, 90, 200]);
const files = [
  ['scene.json', Buffer.from(JSON.stringify(scene, null, 1), 'utf8')],
  // ⚠️⚠️ model → material → 贴图裸名 的那条链（实测）
  ['models/bg.json', Buffer.from(JSON.stringify({ autosize: true, material: 'materials/bg.json' }), 'utf8')],
  ['materials/bg.json', Buffer.from(JSON.stringify({
    passes: [{ blending: 'translucent', shader: 'genericimage4', textures: ['bg'] }],
  }), 'utf8')],
  // ⚠️ 头部声明 DXT3（format=2）而 body 是 PNG —— 那是实测的常态
  ['materials/bg.tex', makeTex({
    format: 2, texW: 1024, texH: 1024, imgW: 8, imgH: 8, body: png,
  })],
  ['models/fg.json', Buffer.from(JSON.stringify({ material: 'materials/fg.json' }), 'utf8')],
  ['materials/fg.json', Buffer.from(JSON.stringify({
    // ⚠️⚠️ `textures` 数组里**第一个可以是 null** —— 那是 shader 的空槽位。
    //   ⟹ 要取"第一个非空的"，而不是 `textures[0]`。
    //   ⚠️ 反向验证逮到过：样本里把真名放在 [0] 的话，
    //     "取 textures[0]" 这个 bug 照样测得绿 ⟹ 那条守卫是假的。
    passes: [{ blending: 'additive', shader: 'genericimage', textures: [null, 'fg', 'mask'] }],
  }), 'utf8')],
  // ⚠️⚠️ TEXB0004 变体（多一个字段）—— 那是 34 张里唯一那张的形状
  ['materials/fg.tex', makeTex({
    format: 0, texW: 8, texH: 8, imgW: 8, imgH: 8, body: png, texbVersion: 'TEXB0004',
  })],
  ['fonts/测试字体.ttf', Buffer.from('假字体数据（真 ttf 太大）', 'utf8')],
  ['effects/tint/effect.json', Buffer.from(JSON.stringify({ replacementkey: 'tint' }), 'utf8')],
  ['effects/waterripple/effect.json', Buffer.from(JSON.stringify({ replacementkey: 'waterripple' }), 'utf8')],
];

// PKGV：[4B长][版本串][4B条目数][条目×N: 4B名长/名/4B偏移/4B长度][数据区]
// ⚠️⚠️ 偏移是**相对数据区起点**，不是文件头 —— 用绝对偏移读出来的是条目表里的
//   字节（看着像乱码的 JSON 片段），而那**不报错**。
const version = 'PKGV0022';
let tableLen = 4 + Buffer.byteLength(version) + 4;
for (const [name] of files) tableLen += 4 + Buffer.byteLength(name, 'utf8') + 8;

const table = [pstr(version), u32(files.length)];
const blobs = [];
let off = 0;
for (const [name, data] of files) {
  table.push(pstr(name), u32(off), u32(data.length));
  blobs.push(data);
  off += data.length;
}
const out = Buffer.concat([...table, ...blobs]);
const dest = path.join(__dirname, 'sample.scene.pkg');
fs.writeFileSync(dest, out);
console.log(`写好 ${dest}`);
console.log(`  ${files.length} 个条目 · ${(out.length / 1024).toFixed(1)} KB`
  + ` · 条目表 ${tableLen} 字节`);
