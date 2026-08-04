// scene 类壁纸的解析（PKGV 归档 + .tex 纹理 + scene.json）。
//
//   node test/scene-pkg.test.js
//
// ⚠️⚠️⚠️ **这一层的每个结论都是实测两个真实工坊壁纸得来的**，
//   而 WE 的 scene 格式**没有任何公开规范**：
//     样本 A：`3299228616`（Lonely Cat，PKGV0022，111 条目，271 对象）
//     样本 B：`2902406982`（麻匪 月半与鬼哭，PKGV0024，129 条目，140 对象）
//
// ⚠️ 而**真实包不进 git**（11MB / 120MB）⟹ 测试用一个**按实测格式手工造的**
//   合成包（`fixtures/sample.scene.pkg`，1.9KB）。
//   ⚠️ 判据：**合成样本要覆盖真实样本里出现过的每一种形状** ——
//     否则它只是"能通过我写的解析器"，那等于没测。
//   ⟹ 所以它里面有：两个版本都有的 image/text/particle/sound、
//     样本 A 独有的 group（纯变换节点）和 shape（带 effect）、
//     两种纹理格式（DXT3 压缩 + RGBA8888 未压缩）、
//     以及一个**故意不认识**的对象类型。

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const S = require(path.join(__dirname, '..', 'src', 'scene-pkg.js'));

let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1; }
}

const PKG_PATH = path.join(__dirname, 'fixtures', 'sample.scene.pkg');
const BUF = fs.existsSync(PKG_PATH) ? fs.readFileSync(PKG_PATH) : null;

console.log('\nscene 类壁纸：PKGV 归档');

check('⚠️ 合成样本在（真实包太大不进 git）', () => {
  assert.ok(BUF, 'fixtures/sample.scene.pkg 不在 —— 那是这整个文件的输入');
  assert.ok(BUF.length > 500, `样本只有 ${BUF.length} 字节，太小了`);
});

check('解析出版本、条目表、数据区起点', () => {
  const pkg = S.parsePkg(BUF);
  assert.ok(pkg.ok, `解析失败：${pkg.error}`);
  assert.strictEqual(pkg.version, 'PKGV0022');
  assert.ok(pkg.entries.length >= 5, `只有 ${pkg.entries.length} 个条目`);
  // ⚠️⚠️ `dataStart` 是**偏移的基准点** —— 这是最容易错的一处。
  //   用绝对偏移（当成文件头）读出来的是条目表里的字节，看起来像乱码的 JSON 片段，
  //   而那**不报错**（我第一次拆真实包时就踩了）。
  assert.ok(pkg.dataStart > 0, 'dataStart 该大于 0');
  // 条目表的长度 = 4(版本长) + 8(版本) + 4(条目数) + Σ(4+名长+4+4)
  const expect = 4 + 8 + 4 + pkg.entries.reduce(
    (n, e) => n + 4 + Buffer.byteLength(e.name, 'utf8') + 8, 0);
  assert.strictEqual(pkg.dataStart, expect,
    `dataStart 是 ${pkg.dataStart}，按条目表算该是 ${expect}`
    + ' ⟹ 偏移基准点算错了，那会让所有内容读成乱码而不报错');
});

check('⚠️ 认识的版本不警告，不认识的**也不拒绝**', () => {
  const pkg = S.parsePkg(BUF);
  assert.deepStrictEqual(pkg.warnings, [], '已知版本不该有警告');
  // ⚠️⚠️ 把版本号改成没见过的 —— 布局一致的话照样该能读
  //   ⟹ 判据：**因为版本号没见过就拒绝，会让一堆能用的壁纸装不上。**
  const fake = Buffer.from(BUF);
  fake.write('PKGV9999', 4, 'latin1');
  const p2 = S.parsePkg(fake);
  assert.ok(p2.ok, `没见过的版本被拒了：${p2.error} ⟹ 该照旧尝试解析`);
  assert.ok(p2.warnings.some((w) => w.includes('PKGV9999')),
    '没见过的版本该记一条警告（但不拒绝）');
  assert.strictEqual(p2.entries.length, pkg.entries.length, '换版本号不该影响条目');
});

check('readEntry 取到的内容和条目表对得上', () => {
  const pkg = S.parsePkg(BUF);
  const raw = S.readEntry(BUF, pkg, 'scene.json');
  assert.ok(raw, 'scene.json 取不到');
  const e = pkg.entries.find((x) => x.name === 'scene.json');
  assert.strictEqual(raw.length, e.len, '取出来的长度和条目表不一致');
  // ⚠️ 内容要真的是 JSON —— 那证明偏移对了（偏移错了会读到乱码）
  assert.doesNotThrow(() => JSON.parse(raw.toString('utf8')),
    'scene.json 解析不了 ⟹ 偏移读错了（那是"不报错的错"）');
  // 不存在的条目返回 null，不抛
  assert.strictEqual(S.readEntry(BUF, pkg, '不存在.json'), null);
});

check('⚠️⚠️ 坏包要在解析时就被逮住（不能留到渲染时变黑屏）', () => {
  // ① 太小
  assert.ok(!S.parsePkg(Buffer.alloc(8)).ok, '8 字节的包该被拒');
  assert.ok(!S.parsePkg(null).ok, 'null 该被拒');
  // ②⚠️ 条目数是天文数字（损坏的包）
  const bad = Buffer.from(BUF);
  bad.writeUInt32LE(999999999, 12);   // 条目数那一格
  const r = S.parsePkg(bad);
  assert.ok(!r.ok, '天文数字的条目数该被拒');
  // ⚠️⚠️ 反向验证发现：**两条上界互为冗余** —— 去掉"条目数 > 100000"那条，
  //   `str()` 里的"字符串长度 > 4096"照样会拦住它（因为读到的是垃圾字节）。
  //   ⟹ 那是设计上的好事（两道独立的界），所以断言**不锚死是哪一条拦的**。
  //   ⚠️ 判据：**冗余的防护要在测试里说清是冗余**，
  //     否则下一个人删掉一条会以为"反正测试还绿"。
  assert.match(r.error, /条目数|字符串长度|不合理/,
    '报错该说清是"某个数不合理"（条目数或字符串长度，两条上界都能拦）');
  // ⚠️ 而**两条都去掉**才该漏 —— 那两条各自守的范围不同：
  //   条目数上界防"表太长"，字符串上界防"某个名字太长"
  assert.ok(!S.parsePkg((() => {
    const b = Buffer.from(BUF);
    b.writeUInt32LE(3, 12);           // 条目数改小（绕过第一条）
    b.writeUInt32LE(999999, 16);      // 但第一个名字长度是天文数字
    return b;
  })()).ok, '名字长度是天文数字时该被拒（那是第二条上界）');
  // ③⚠️⚠️ 偏移越界 —— 那是"包不完整"，症状本来会是渲染时一张黑图
  const pkg = S.parsePkg(BUF);
  const trunc = BUF.slice(0, BUF.length - 200);
  const r2 = S.parsePkg(trunc);
  assert.ok(!r2.ok, '截断的包该被拒');
  assert.match(r2.error, /越界|不完整/,
    '报错该说清"包不完整" ⟹ 否则用户只看到一张黑图');
  assert.ok(pkg.ok, '（对照：完整的包该能过）');
});

check('summarize 按扩展名归类（面板要说"这里面有什么"）', () => {
  const pkg = S.parsePkg(BUF);
  const sum = S.summarize(pkg);
  assert.ok(sum.tex, '没统计 .tex');
  assert.ok(sum.json, '没统计 .json');
  assert.strictEqual(sum.tex.count, 2, `.tex 该有 2 个，实际 ${sum.tex.count}`);
  assert.ok(sum.tex.bytes > 0, '.tex 的字节数该 > 0');
});

console.log('\n.tex 纹理');

check('⚠️⚠️⚠️ 标签是裸串 + \\0（**不带**长度前缀）', () => {
  // ⚠️ 这是我实测栽过的一处：`.tex` 和 PKGV 的字符串编码**不一样**。
  //   我照 PKGV 的模式假设了长度前缀 ⟹ 把 "TEXV" 四个字节当长度读，
  //   得到 1448625492 ⟹ 报"标签长度不合理"。
  //   ⟹ 判据：**同一个文件族里的两种容器可以有不同的字符串编码。**
  const pkg = S.parsePkg(BUF);
  const h = S.parseTexHeader(S.readEntry(BUF, pkg, 'materials/bg.tex'));
  assert.ok(h.ok, `.tex 头部解析失败：${h.error}`);
  assert.strictEqual(h.texv, 'TEXV0005');
  assert.strictEqual(h.texi, 'TEXI0001');
});

check('⚠️⚠️ 纹理尺寸和图像尺寸是**两个**（用错一个图会偏）', () => {
  const pkg = S.parsePkg(BUF);
  const h = S.parseTexHeader(S.readEntry(BUF, pkg, 'materials/bg.tex'));
  // 实测：真实样本里 4096×4096 的纹理装 3840×2160 的图
  assert.strictEqual(h.texWidth, 256, '纹理宽读错了');
  assert.strictEqual(h.imgWidth, 200, '图像宽读错了');
  assert.notStrictEqual(h.texWidth, h.imgWidth,
    '这个样本故意让两个尺寸不同 —— 那是真实壁纸里的常态');
  // ⚠️⚠️ UV 缩放 = 图像/纹理。漏了它的症状是"图偏了一点"，
  //   而那种偏差看起来像"这张壁纸本来就这样"。
  assert.ok(Math.abs(h.uvScaleX - 200 / 256) < 1e-9,
    `uvScaleX 是 ${h.uvScaleX}，该是 ${200 / 256}`);
  assert.ok(Math.abs(h.uvScaleY - 150 / 256) < 1e-9, 'uvScaleY 算错了');
});

check('⚠️⚠️ DXT3 认成压缩格式，而且给出 WebGL 的常量名', () => {
  const pkg = S.parsePkg(BUF);
  const dxt = S.parseTexHeader(S.readEntry(BUF, pkg, 'materials/bg.tex'));
  assert.strictEqual(dxt.formatName, 'DXT3');
  // ⚠️⚠️⚠️ 这一条是**整件事可行的关键**：WebGL 有 s3tc 扩展，
  //   能**直接吃** DXT ⟹ 不需要 CPU 解压。
  //   而实测两个样本的纹理 30/34 是 DXT3。
  assert.strictEqual(dxt.compressed, true, 'DXT3 该是压缩格式');
  assert.strictEqual(dxt.glFormat, 'COMPRESSED_RGBA_S3TC_DXT3_EXT',
    '没给出 WebGL 的常量名 ⟹ 渲染层得自己猜那个映射');

  // 而未压缩的那种要正确区分
  const raw = S.parseTexHeader(S.readEntry(BUF, pkg, 'materials/fg.tex'));
  assert.strictEqual(raw.formatName, 'RGBA8888');
  assert.strictEqual(raw.compressed, false, 'RGBA8888 不是压缩格式');
  assert.strictEqual(raw.glFormat, null, '未压缩格式不该有 s3tc 常量');
});

check('⚠️ 不是 .tex 的东西要明确报出来', () => {
  const pkg = S.parsePkg(BUF);
  // 拿 scene.json 当 .tex 解 —— 该报"不是 .tex"而不是崩
  const r = S.parseTexHeader(S.readEntry(BUF, pkg, 'scene.json'));
  assert.ok(!r.ok, 'scene.json 不该被当成 .tex 解析成功');
  assert.match(r.error, /不是 \.tex|TEXV/, '报错该说清它不是 .tex');
  // 太小的 buffer
  assert.ok(!S.parseTexHeader(Buffer.alloc(10)).ok);
  assert.ok(!S.parseTexHeader(null).ok);
});

console.log('\nscene.json');

check('⚠️⚠️ 类型不是 type 字段，而是"有哪个键"', () => {
  // ⚠️ 我第一版按 `o.type` 找 —— **全是 undefined**。
  //   ⟹ 判据：**别假设 JSON 里有一个 `type` 字段**，实测它有哪些键。
  assert.strictEqual(S.objectKind({ image: 'a.tex' }), 'image');
  assert.strictEqual(S.objectKind({ text: 'hi' }), 'text');
  assert.strictEqual(S.objectKind({ particle: 'p.json' }), 'particle');
  assert.strictEqual(S.objectKind({ light: {} }), 'light');
  assert.strictEqual(S.objectKind({ sound: ['a.mp3'] }), 'sound');
  // ⚠️ 实测样本 A 独有的两种
  assert.strictEqual(S.objectKind({ shape: 'plane' }), 'shape');
  assert.strictEqual(S.objectKind({ parent: 1, angles: '0 0 0', name: 'g' }), 'group');
  // ⚠️ 完全不认识的
  assert.strictEqual(S.objectKind({ weird: true }), 'unknown');
  assert.strictEqual(S.objectKind(null), null);
});

check('⚠️⚠️⚠️ 纯变换节点（group）不能丢 —— 它是子对象的锚点', () => {
  // ⚠️ 实测样本 A 有 **30 个**只带 `parent` + 变换的对象 —— 那是图层组。
  //   我第一版把它们归成 unknown 并跳过 ⟹ 而**跳过它们会让子对象的变换算错**
  //   （子对象的坐标是相对父节点的）。
  //   ⟹ 判据：**"没有可见内容"不等于"可以丢掉"** —— 它可能是别人的锚点。
  const pkg = S.parsePkg(BUF);
  const sc = S.parseScene(S.readEntry(BUF, pkg, 'scene.json').toString('utf8'));
  assert.ok(sc.ok, `scene.json 解析失败：${sc.error}`);
  assert.ok(sc.counts.group >= 1, 'group 类型没被识别出来');
  // ⚠️ 而 parent 必须被保留 —— 那是变换树的边
  const g = sc.objects.find((o) => o.kind === 'group');
  assert.strictEqual(g.parent, 1, `group 的 parent 是 ${g.parent}，该是 1`);
  // 而没有 parent 的对象该是 null（不是 undefined —— 那让 JSON 化时字段不消失）
  const img = sc.objects.find((o) => o.kind === 'image');
  assert.strictEqual(img.parent, null, '没有父节点的该是 null');
});

check('⚠️ 不认识的对象**记下来但不丢**（可观测 > 静默）', () => {
  const pkg = S.parsePkg(BUF);
  const sc = S.parseScene(S.readEntry(BUF, pkg, 'scene.json').toString('utf8'));
  assert.strictEqual(sc.skipped.length, 1, `跳过了 ${sc.skipped.length} 个，该是 1`);
  assert.strictEqual(sc.skipped[0].name, '怪东西');
  assert.ok(sc.skipped[0].reason, '跳过的对象要说清原因');
  // ⚠️⚠️ 判据：**"这张壁纸有 N 个我们不支持的东西"该是可观测的事实**，
  //   而不是静默丢掉 —— 否则用户看到的是"少了点什么"而无从判断。
});

check('⚠️⚠️ 坐标是 "x y z" 字符串（不是数组、不是对象）', () => {
  // ⚠️ 而它**可能只有两个数**（2D 图层）⟹ 缺的补 0
  assert.deepStrictEqual(S.parseVec3('1 2 3'), [1, 2, 3]);
  assert.deepStrictEqual(S.parseVec3('1.5 -2.5 0'), [1.5, -2.5, 0]);
  assert.deepStrictEqual(S.parseVec3('10 20'), [10, 20, 0], '两个数该补第三个为 0');
  // ⚠️ 多余空格（实测真实文件里有 "0.00000 -0.00000 0.00000"）
  assert.deepStrictEqual(S.parseVec3('  1   2   3  '), [1, 2, 3]);
  // ⚠️ 数组形式也认（防它哪天变）
  assert.deepStrictEqual(S.parseVec3([4, 5, 6]), [4, 5, 6]);
  // ⚠️⚠️ 而非法输入要走 fallback，不能返回 NaN ——
  //   一个 NaN 坐标会让那个对象**消失**（WebGL 静默丢弃），而那不报错
  assert.deepStrictEqual(S.parseVec3(undefined), [0, 0, 0]);
  assert.deepStrictEqual(S.parseVec3('abc'), [0, 0, 0]);
  assert.deepStrictEqual(S.parseVec3(null, [1, 1, 1]), [1, 1, 1], 'fallback 没生效');
  assert.deepStrictEqual(S.parseVec3('1 x 3'), [0, 0, 0], '含非数字该走 fallback');
  // scale 的 fallback 是 1 1 1（不是 0 —— 那会让对象缩到看不见）
  const pkg = S.parsePkg(BUF);
  const sc = S.parseScene(S.readEntry(BUF, pkg, 'scene.json').toString('utf8'));
  const noScale = sc.objects.find((o) => o.kind === 'text');
  assert.deepStrictEqual(noScale.scale, [1, 1, 1],
    '没写 scale 的对象该默认 1 1 1 ⟹ 默认 0 会让它缩到看不见');
});

check('⚠️ 视差深度要读出来（那是 scene 类"会动"的主要来源）', () => {
  const pkg = S.parsePkg(BUF);
  const sc = S.parseScene(S.readEntry(BUF, pkg, 'scene.json').toString('utf8'));
  const bg = sc.objects.find((o) => o.name === '底图');
  const fg = sc.objects.find((o) => o.name === '前景');
  assert.deepStrictEqual(bg.parallaxDepth, [0.1, 0.1, 0], '底图的视差深度读错了');
  assert.deepStrictEqual(fg.parallaxDepth, [0.5, 0.5, 0], '前景的视差深度读错了');
  // ⚠️⚠️ 前景的深度该比底图大 —— 那是"鼠标一动图层错开"的来源。
  //   漏了这个字段的症状是"图层都在但完全不动"。
  assert.ok(fg.parallaxDepth[0] > bg.parallaxDepth[0],
    '前景的视差深度该比底图大 ⟹ 那才有错开的效果');
});

check('alpha / brightness / 混合模式有正确的默认值', () => {
  const pkg = S.parsePkg(BUF);
  const sc = S.parseScene(S.readEntry(BUF, pkg, 'scene.json').toString('utf8'));
  const bg = sc.objects.find((o) => o.name === '底图');
  const fg = sc.objects.find((o) => o.name === '前景');
  // ⚠️ 没写的字段要有默认 —— 而默认值错了的症状是"图层全透明"或"全黑"
  assert.strictEqual(bg.alpha, 1, '没写 alpha 该默认 1（不是 0 —— 那会全透明）');
  assert.strictEqual(bg.brightness, 1, '没写 brightness 该默认 1（不是 0 —— 那会全黑）');
  assert.strictEqual(fg.alpha, 0.8, '写了的 alpha 该读出来');
  assert.strictEqual(fg.brightness, 1.2, '写了的 brightness 该读出来');
  assert.deepStrictEqual(bg.color, [1, 1, 1], '没写 color 该默认白（不是黑）');
});

check('⚠️ effects 数组要保留（那是全屏效果的来源）', () => {
  const pkg = S.parsePkg(BUF);
  const sc = S.parseScene(S.readEntry(BUF, pkg, 'scene.json').toString('utf8'));
  const shape = sc.objects.find((o) => o.kind === 'shape');
  assert.ok(Array.isArray(shape.effects) && shape.effects.length === 1,
    'shape 上的 effects 没保留');
  assert.match(shape.effects[0].file, /lightshafts/,
    'effect 的 file 路径没保留 ⟹ 那是去包里找 effect.json 的键');
  // ⚠️ 没有 effects 的对象该是空数组（不是 undefined —— 那让调用方要判两次）
  const img = sc.objects.find((o) => o.kind === 'image');
  assert.deepStrictEqual(img.effects, [], '没有 effects 的该是空数组');
});

check('⚠️ camera / general 要保留（底色和相机在那里）', () => {
  const pkg = S.parsePkg(BUF);
  const sc = S.parseScene(S.readEntry(BUF, pkg, 'scene.json').toString('utf8'));
  assert.ok(sc.camera, 'camera 丢了 ⟹ 那是视角的来源');
  assert.ok(sc.general, 'general 丢了 ⟹ 底色（clearcolor）在那里');
  assert.ok(sc.general.clearcolor, 'clearcolor 丢了 ⟹ 那是画面的底色');
});

check('⚠️ 原始对象留着（翻译层不许丢信息）', () => {
  // ⚠️ 判据：**翻译层丢了信息很难查** —— 症状是某个效果不起作用，
  //   而你会去查渲染而不是查解析。⟹ 留一份 raw。
  const pkg = S.parsePkg(BUF);
  const sc = S.parseScene(S.readEntry(BUF, pkg, 'scene.json').toString('utf8'));
  for (const o of sc.objects) {
    assert.ok(o.raw && typeof o.raw === 'object', `${o.name} 没留 raw`);
  }
});

check('坏的 scene.json 要明确报错', () => {
  assert.ok(!S.parseScene('{ 不是 json').ok, '非法 JSON 该被拒');
  assert.match(S.parseScene('{ bad').error, /JSON/, '报错该说清是 JSON 的问题');
  assert.ok(!S.parseScene(null).ok);
  assert.ok(!S.parseScene(42).ok);
  // ⚠️ 而**没有 objects 的 scene.json 不算错** —— 那是一张空场景（合法）
  const empty = S.parseScene('{"version":1}');
  assert.ok(empty.ok, '空场景该能解析（那是合法的）');
  assert.deepStrictEqual(empty.objects, []);
});


console.log('\n能画多少（部分支持要说清是哪部分）');

check('⚠️⚠️⚠️ 报出"哪些能画、哪些画不了"（不许静默少画）', () => {
  // ⚠️ `we-host.js` 把 scene 标成 `support: 'full'`，而渲染是**分阶段**的。
  //   ⟹ 判据：**"部分支持"要说出是哪部分。**
  //     静默少画的症状是"这张壁纸怪怪的"，而用户无从判断是谁的问题。
  //     （这个项目为"静默失败"栽过很多次，这是同一个形状。）
  const pkg = S.parsePkg(BUF);
  const sc = S.parseScene(S.readEntry(BUF, pkg, 'scene.json').toString('utf8'));
  const r = S.renderability(sc);
  assert.ok(r.ok);
  // 合成样本：2 image + 1 group 能画；1 text + 1 particle + 1 shape 画不了
  assert.strictEqual(r.doneN, 3, `能画的该是 3 个，实际 ${r.doneN}`);
  assert.strictEqual(r.missN, 3, `画不了的该是 3 个，实际 ${r.missN}`);
  // ⚠️⚠️ 那句话要**说清缺什么** —— "部分支持"这种说法没有信息量
  assert.match(r.summary, /text/, '没说清缺的是文字');
  assert.match(r.summary, /particle/, '没说清缺的是粒子');
  assert.ok(!/部分支持/.test(r.summary),
    '用了"部分支持"这种没信息量的说法 ⟹ 该直接列出缺什么');
});

check('⚠️ 覆盖率按**对象数**算，不是按种类数', () => {
  // ⚠️ 判据：**按对象数更接近"画面上缺了多少"** ——
  //   一张 140 对象里 97 个文字的壁纸，按种类算是"缺 2/4"，
  //   按对象算是"缺 70%"，而后者才是用户看到的。
  const sc = S.parseScene(JSON.stringify({
    objects: [
      ...Array.from({ length: 90 }, (_, i) => ({ id: i, text: 'x' })),
      { id: 999, image: 'a.tex' },
    ],
  }));
  const r = S.renderability(sc);
  assert.ok(r.coverage < 0.05,
    `覆盖率 ${r.coverage} —— 90 个文字里只有 1 个图层，该接近 0`
    + '（按种类算会得到 0.5，那会严重高估）');
});

check('⚠️ sound 是"有意不做"，不算缺口', () => {
  // ⚠️ 壁纸自己放声音是打扰（用户从没要求过）⟹ 那是**决定**不是能力缺失。
  //   ⟹ 判据：**"有意不做"和"还没做"要分开** —— 混在一起会让覆盖率
  //     永远上不去，而那个数字就没意义了。
  const sc = S.parseScene(JSON.stringify({
    objects: [{ id: 1, image: 'a.tex' }, { id: 2, sound: ['b.mp3'] }],
  }));
  const r = S.renderability(sc);
  assert.strictEqual(r.missN, 0, 'sound 被算成缺口了');
  assert.strictEqual(r.coverage, 1, '只有 image + sound 时覆盖率该是 1');
  assert.ok(!r.missing.some((m) => m.includes('sound')), 'sound 出现在缺口列表里了');
});

check('⚠️ 全部能画时那句话要说得干脆', () => {
  const sc = S.parseScene(JSON.stringify({
    objects: [{ id: 1, image: 'a.tex' }, { id: 2, image: 'b.tex' }],
  }));
  const r = S.renderability(sc);
  assert.strictEqual(r.coverage, 1);
  assert.match(r.summary, /都能画/, '全部能画时该直接说"都能画"');
  assert.ok(!/画不了/.test(r.summary), '全部能画时不该提"画不了"');
});

check('⚠️ RENDER_SUPPORT 的每个键都是 parseScene 会产出的类型', () => {
  // ⚠️ 判据：**两张表要对得上** —— 一个只在 RENDER_SUPPORT 里的键说明
  //   它拼错了或者过时了，而那会让那类对象**静默归到 none**。
  const kinds = ['image', 'text', 'particle', 'light', 'sound', 'shape', 'group', 'unknown'];
  for (const k of Object.keys(S.RENDER_SUPPORT)) {
    assert.ok(kinds.includes(k),
      `RENDER_SUPPORT 里的 "${k}" 不是 objectKind 会返回的类型 ⟹ 拼错了或者过时了`);
  }
  // ⚠️ 反过来：每个 objectKind 会返回的类型都要在表里（否则默认 none，
  //   而那可能是"其实能画但忘了声明"）
  for (const k of kinds) {
    assert.ok(S.RENDER_SUPPORT[k],
      `objectKind 会返回 "${k}"，但 RENDER_SUPPORT 里没有它 ⟹ 会静默归到 none`);
  }
});


console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
