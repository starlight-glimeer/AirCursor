// scene 类壁纸的解析（PKGV 归档 + .tex 纹理 + scene.json + 变换树 + effect）。
//
//   node test/scene-pkg.test.js
//
// ⚠️⚠️⚠️ **这一层的每个结论都是实测两个真实工坊壁纸得来的**，
//   而 WE 的 scene 格式**没有任何公开规范**：
//     样本 A：`3299228616`（Lonely Cat，PKGV0022，111 条目，271 对象）
//     样本 B：`2902406982`（麻匪 月半与鬼哭，PKGV0024，129 条目，140 对象）
//
// ⚠️⚠️⚠️ **2026-08-04 的教训（这个文件存在的理由变了）**
//
// 这个文件第一版 25 项全绿，而真实壁纸**一张纹理都读不出来、画面全黑**。
// 因为合成样本是**按我自己的假设造的**：`image` 直接指向 `.tex`、
// `visible` 是裸 bool、`.tex` 的 body 是裸 DXT —— 三条全错。
//
// ⟹ 判据：**合成测试数据是按代码的假设造的 ⟹ 它只能证明代码自洽，
//   不能证明假设对。** 真实输入跑一遍才逮得到。
//
// ⟹ 所以现在：
//   ① 合成样本由 `fixtures/make-sample-pkg.js` **生成**，
//     而那个文件里每种形状都标了它来自哪个真实样本的实测；
//   ② 下面每一项测试都对应一个**真实数据逮出来的洞**（注释里写了症状）。
//   ⚠️ 真实包不进 git（11MB / 123MB）⟹ 合成包 4.5KB。

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
  assert.strictEqual(h.texWidth, 1024, '纹理宽读错了');
  assert.strictEqual(h.imgWidth, 8, '图像宽读错了');
  assert.notStrictEqual(h.texWidth, h.imgWidth,
    '这个样本故意让两个尺寸不同 —— 那是真实壁纸里的常态');
  // ⚠️⚠️⚠️ 而 **PNG/JPEG 那条路上 UV 不用缩** —— 解出来就是图片本身的尺寸
  //   （实测 mip0 尺寸 = imgWidth/imgHeight，不是 texWidth）。
  //   ⟹ `uvScale` 只对"DXT 装在 2 的幂纹理里"那种有意义，
  //     而实测图层真正用到的 11 张里 10 张是 PNG ⟹ 这一版用不上它。
  //   ⚠️ 判据：**别把一处实测的换算套到另一条路上。**
  const body = S.parseTexData(S.readEntry(BUF, pkg, 'materials/bg.tex'), h);
  assert.strictEqual(body.width, h.imgWidth,
    'mip0 的尺寸该等于 imgWidth（那是"不用缩 UV"的依据）');
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
  const tinted = sc.objects.find((o) => o.name === '被染色的图');
  assert.ok(Array.isArray(tinted.effects) && tinted.effects.length === 4,
    `effects 没保留（${tinted.effects.length} 个）`);
  assert.match(tinted.effects[0].file, /tint/,
    'effect 的 file 路径没保留 ⟹ 那是去包里找 effect.json 的键');
  // ⚠️ 没有 effects 的对象该是空数组（不是 undefined —— 那让调用方要判两次）
  const plain = sc.objects.find((o) => o.name === '底图');
  assert.deepStrictEqual(plain.effects, [], '没有 effects 的该是空数组');
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
  // ⚠️ 合成样本（**没**跑 flattenTransforms ⟹ 口径是"全部对象"）：
  //   5 image + 1 group + 2 text 能画；1 particle 画不了；1 sound 有意不做
  //   ⚠️⚠️ text 是 2026-08-04 从 'none' 改成 'full' 的（canvas 画字 → 纹理）——
  //     实测样本 B 的 97 个文字占 70%，那是图层之后最大的缺口。
  //   ⚠️ 而"摊平之后"的口径由下面那条「覆盖率的口径」管（那两个数不一样，
  //     不一样本身就是要守的东西）。
  assert.strictEqual(r.doneN, 8, `能画的该是 8 个，实际 ${r.doneN}`);
  assert.strictEqual(r.missN, 1, `画不了的该是 1 个（particle），实际 ${r.missN}`);
  assert.match(r.scope, /全部对象/, '没摊平时口径该说清是"全部对象"');
  // ⚠️⚠️ 那句话要**说清缺什么** —— "部分支持"这种说法没有信息量
  assert.match(r.summary, /particle/, '没说清缺的是粒子');
  assert.ok(!/部分支持/.test(r.summary), '用了"部分支持"这种没信息量的说法');
  assert.ok(!/部分支持/.test(r.summary),
    '用了"部分支持"这种没信息量的说法 ⟹ 该直接列出缺什么');
});

check('⚠️ 覆盖率按**对象数**算，不是按种类数', () => {
  // ⚠️ 判据：**按对象数更接近"画面上缺了多少"** ——
  //   一张 140 对象里 97 个文字的壁纸，按种类算是"缺 2/4"，
  //   按对象算是"缺 70%"，而后者才是用户看到的。
  // ⚠️ 用 particle 当"画不了"的那一类（text 现在能画了）
  const sc = S.parseScene(JSON.stringify({
    objects: [
      ...Array.from({ length: 90 }, (_, i) => ({ id: i, particle: 'p.json' })),
      { id: 999, image: 'a.tex' },
    ],
  }));
  const r = S.renderability(sc);
  assert.ok(r.coverage < 0.05,
    `覆盖率 ${r.coverage} —— 90 个粒子里只有 1 个图层，该接近 0`
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


console.log('\n⚠️⚠️⚠️ 真实数据逮出来的洞（每一条都曾让画面全黑或错位）');

check('⚠️⚠️⚠️ 属性是包装对象 —— 拆不出来 visible 会多画一堆', () => {
  // ⚠️ 实测两个样本一共 **913 处**包装，四种形状都带 `value`：
  //   {user,value} 655 / {script,scriptproperties,value} 187 /
  //   {script,user,value} 44 / {script,value} 27
  // ⚠️⚠️ 而我第一版写 `o.visible !== false` —— **对象 !== false 恒真**
  //   ⟹ 样本 A 的 132 个图层里多画 77 个（多套皮肤/多语言全糊在一起）。
  assert.strictEqual(S.unwrapValue({ user: 'x', value: false }), false);
  assert.strictEqual(S.unwrapValue({ script: 'code', value: 0.8 }), 0.8);
  assert.strictEqual(S.unwrapValue('裸值'), '裸值');
  // ⚠️ 数组不能当包装对象拆（size 之类可能是数组）
  assert.deepStrictEqual(S.unwrapValue([1, 2, 3]), [1, 2, 3]);
  // ⚠️ 没有 value 键的对象**原样返回**（那是别的东西，不是包装）
  const other = { a: 1 };
  assert.strictEqual(S.unwrapValue(other), other);
  assert.strictEqual(S.isBound({ user: 'x', value: 1 }), true);
  assert.strictEqual(S.isBound({ value: 1 }), false, '只有 value 不算"被绑定"');
});

check('⚠️⚠️ NaN 传染 —— 包装的 alpha/brightness 会让图层变黑', () => {
  // ⚠️ 实测 166 个对象的 alpha/brightness 是包装对象，
  //   而 `Number({...})` = **NaN**，NaN 乘进颜色是**黑的**。
  const sc = S.parseScene(JSON.stringify({
    objects: [{
      id: 1, image: 'a.tex',
      alpha: { user: 'x', value: 0.5 },
      brightness: { script: 'c', value: 2 },
    }],
  }));
  const o = sc.objects[0];
  assert.strictEqual(o.alpha, 0.5, 'alpha 没拆包装');
  assert.strictEqual(o.brightness, 2, 'brightness 没拆包装');
  // ⚠️⚠️ 而**拆不出数字时要走默认**，绝不能留 NaN
  const sc2 = S.parseScene(JSON.stringify({
    objects: [{ id: 1, image: 'a.tex', alpha: { user: 'x' }, brightness: 'abc' }],
  }));
  assert.strictEqual(sc2.objects[0].alpha, 1,
    '拆不出数字该默认 1 ⟹ NaN 会让这个图层变黑');
  assert.ok(Number.isFinite(sc2.objects[0].brightness), 'brightness 是 NaN');
});

check('⚠️⚠️ 画布尺寸要**读**不要反推', () => {
  // ⚠️ 实测样本 B 最大图层 5760×2880，而画布是 3840×2160
  //   （图层故意做得比画布大，留给视差移动的余量）
  //   ⟹ 反推会让画面缩到 2/3、四周露黑边。
  const c = S.canvasSize({ orthogonalprojection: { width: 3840, height: 2160 } });
  assert.strictEqual(c.width, 3840);
  assert.match(c.source, /orthogonalprojection/, '来源要说清是读出来的');
  // ⚠️ 读不到才兜底，而**兜底要说清是兜底**（否则"画面缩了"没人知道是这里）
  const fb = S.canvasSize(null);
  assert.strictEqual(fb.width, 3840);
  assert.match(fb.source, /默认|读不到/, '兜底没说清');
  // ⚠️ 包装过的也要能读
  assert.strictEqual(
    S.canvasSize({ orthogonalprojection: { width: { value: 1920 }, height: { value: 1080 } } }).width,
    1920, 'orthogonalprojection 的值被包装时读不出来');
});

check('⚠️⚠️⚠️ 子对象的 origin 是相对父的 —— 无条件换算会把它们推出画布', () => {
  // ⚠️ 实测样本 A 有 **264/271** 个子对象。
  //   根对象 origin 范围 x:139~1920（绝对画布坐标），
  //   子对象 x:-1555~1774（绕 0 分布）—— 那两个分布形状本身就是证据。
  // ⚠️⚠️ 我第一版对每个对象都减半宽半高 ⟹ `ripple1440p` 从 (10,-221)
  //   变成 (-1910,-1301) ⟹ 整层跑到画布外。
  //   而症状是"背景在、别的全没了"，那看起来像"纹理没加载"。
  const sc = S.flattenTransforms(S.parseScene(JSON.stringify({
    general: { orthogonalprojection: { width: 1000, height: 500 } },
    objects: [
      { id: 1, image: 'bg.tex', origin: '500 250 0', scale: '2 2 1' },
      { id: 2, parent: 1, image: 'fg.tex', origin: '10 -20 1', scale: '3 1 1' },
    ],
  })));
  const [root, kid] = sc.objects;
  // 根：绝对坐标 → 中心原点
  assert.deepStrictEqual(root.worldPos, [0, 0, 0], '根对象该落在画布正中');
  // ⚠️⚠️ 子：父的位置 + 自己的偏移 × **父的缩放**
  assert.deepStrictEqual(kid.worldPos, [20, -40, 1],
    '子对象的偏移该被父的缩放缩过（10×2, -20×2）');
  assert.deepStrictEqual(kid.worldScale, [6, 2, 1], '缩放该沿链累乘（3×2, 1×2）');
});

check('⚠️⚠️⚠️ visible 要继承祖先 —— 不继承就是 6 种语言叠在一起', () => {
  // ⚠️ 实测样本 A：70 个对象自己 visible，而正确该画的只有 **8** 个。
  //   凶手是 5 个语言根（各砍 7 个）+ 一堆备用时钟皮肤。
  //   ⚠️ 抽 preview.gif 首帧核对过：背景 + 涟漪 + 03:33 + 日期 + PM + 3 条频谱 = 8。
  const sc = S.flattenTransforms(S.parseScene(JSON.stringify({
    objects: [
      { id: 1, name: '英语组', image: 'a.tex', origin: '0 0 0', visible: { user: 'lang', value: true } },
      { id: 2, name: '英语字', parent: 1, text: 'hi', origin: '0 0 0' },
      { id: 3, name: '中文组', image: 'b.tex', origin: '0 0 0', visible: { user: 'lang', value: false } },
      // ⚠️ 它自己 visible=true，但祖先是 false
      { id: 4, name: '中文字', parent: 3, text: '你好', origin: '0 0 0', visible: true },
    ],
  })));
  const vis = sc.objects.filter((o) => o.worldVisible).map((o) => o.name);
  assert.deepStrictEqual(vis, ['英语组', '英语字'],
    `继承后可见的该只有英语那两个，实际 ${vis.join('/')}`);
  // ⚠️ 而"自己 visible"那个口径下会是 3 个 ⟹ 两个数都要能报出来
  assert.strictEqual(sc.objects.filter((o) => o.visible).length, 3);
});

check('⚠️ 变换树的环和野指针不能爆栈', () => {
  // ⚠️ 实测 0 例，但**必须防** —— 一个手改过的 scene.json 就能造出来，
  //   而爆栈的症状是整个壁纸白屏（比黑屏更难查）。
  const cyc = S.flattenTransforms(S.parseScene(JSON.stringify({
    objects: [
      { id: 1, parent: 2, image: 'a.tex', origin: '0 0 0' },
      { id: 2, parent: 1, image: 'b.tex', origin: '0 0 0' },
    ],
  })));
  assert.ok(cyc.transformWarnings.some((w) => /环/.test(w)), '环没被记下来');
  const dang = S.flattenTransforms(S.parseScene(JSON.stringify({
    objects: [{ id: 1, parent: 999, image: 'a.tex', origin: '0 0 0' }],
  })));
  assert.ok(dang.transformWarnings.some((w) => /不存在/.test(w)),
    'parent 指向不存在的 id 没被记下来（静默当根会让位置错得莫名其妙）');
});

check('⚠️⚠️⚠️ image 指向 model JSON 不是 .tex（这条错了整个画面全黑）', () => {
  // ⚠️ 真链路：`models/x.json` → `materials/x.json` → 贴图**裸名** → `materials/<名>.tex`
  //   ⚠️ 我第一版直接把 `image` 当 `.tex` 路径 ⟹ 两个样本一张纹理都读不出来
  //     （全报"不是 .tex 文件 —— 头 4 字节是 `{...`"）。
  const pkg = S.parsePkg(BUF);
  const readJson = (n) => {
    const r = S.readEntry(BUF, pkg, n);
    if (!r) return null;
    try { return JSON.parse(r.toString('utf8')); } catch { return null; }
  };
  const r = S.resolveImageTexture(BUF, pkg, 'models/bg.json', readJson);
  assert.ok(r.ok, `解析失败：${r.error}`);
  assert.strictEqual(r.texPath, 'materials/bg.tex');
  // ⚠️ 整条链要留下来 —— 那让"断在哪一环"能一眼看出
  assert.deepStrictEqual(r.chain,
    ['models/bg.json', 'materials/bg.json', 'materials/bg.tex']);
  // ⚠️ material 里的 blending 比 scene.json 的 colorBlendMode 可靠
  assert.strictEqual(r.blending, 'translucent');
  // ⚠️ textures 数组里有 null（shader 的空槽位）⟹ 要跳过取第一个非空的
  const r2 = S.resolveImageTexture(BUF, pkg, 'models/fg.json', readJson);
  assert.ok(r2.ok, `fg 解析失败：${r2.error}`);
  assert.strictEqual(r2.texPath, 'materials/fg.tex');
  // ⚠️ 直接指向 .tex 的也要认（两种都有）
  const r3 = S.resolveImageTexture(BUF, pkg, 'materials/bg.tex', readJson);
  assert.ok(r3.ok && r3.texPath === 'materials/bg.tex', '直接指向 .tex 的没认出来');
});

check('⚠️⚠️ 合成层要和"读不到"分开报', () => {
  // ⚠️ `models/util/composelayer.json` 是 WE **内置**模型：不在包里、
  //   而且**本来没有贴图**（画面来自它下面的图层 + effect）。
  //   ⟹ 实测两个样本一共 14 个 ⟹ 它们占了"失败"的全部。
  //   ⚠️⚠️ 判据：**"读不到"和"本来就没有"要分开** ——
  //     混在一起会让 14 个正常现象看起来像 14 个 bug，真 bug 就藏在里面了。
  const pkg = S.parsePkg(BUF);
  const r = S.resolveImageTexture(BUF, pkg, 'models/util/composelayer.json', () => null);
  assert.ok(!r.ok, '合成层没有贴图，不该 ok');
  assert.strictEqual(r.composite, 'composelayer',
    '没标出它是合成层 ⟹ 那会被当成"读不到"报成错误');
  assert.match(r.error, /没有自己的贴图/, '报错该说清它本来就没有贴图');
});

check('⚠️⚠️⚠️ .tex 的 body 是 PNG/JPEG，不是头部声明的 DXT', () => {
  // ⚠️⚠️ 实测 34 张纹理：15 张 PNG、1 张 JPEG、其余 LZ4 压缩的 DXT 或裸 DXT。
  //   而**图层真正用到的 11 张里 10 张是 PNG**。
  //   ⚠️ 我第一版做 `raw.slice(headerBytes)` 然后按 DXT 上传 ⟹ 一张也传不上去。
  //   ⟹ 判据：**头部声明的格式说的是"解出来之后是什么"，不是"存储时是什么"。**
  const pkg = S.parsePkg(BUF);
  const raw = S.readEntry(BUF, pkg, 'materials/bg.tex');
  const head = S.parseTexHeader(raw);
  assert.strictEqual(head.formatName, 'DXT3', '头部该声明 DXT3');
  const body = S.parseTexData(raw, head);
  assert.ok(body.ok, `TEXB 解析失败：${body.error}`);
  assert.strictEqual(body.container, 'PNG',
    '⚠️ body 该是 PNG —— 头部声明 DXT3 只是"解出来之后是什么"');
  // ⚠️ 数据要真的以 PNG 魔数开头（那证明偏移对了）
  assert.deepStrictEqual([...body.data.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47],
    'mip0 数据不是 PNG 魔数开头 ⟹ TEXB 的偏移读错了');
  assert.strictEqual(body.mipCount, 1);
  // ⚠️ PNG 的 uncompressedLen 实测是 0（那种没有"解压后长度"的概念）
  assert.strictEqual(body.uncompressedLen, 0);
});

check('⚠️⚠️ TEXB0004 比 0003 多一个字段（漏了就一个 mip 都取不出来）', () => {
  // ⚠️ 实测 34 张里 1 张是 TEXB0004。漏掉那个字段会把 mipCount 读成 0
  //   ⟹ 取不到任何 mip ⟹ 那张图是黑的，而**不报错**。
  const pkg = S.parsePkg(BUF);
  const raw = S.readEntry(BUF, pkg, 'materials/fg.tex');
  const body = S.parseTexData(raw, S.parseTexHeader(raw));
  assert.ok(body.ok, `TEXB0004 解析失败：${body.error}`);
  assert.strictEqual(body.texb, 'TEXB0004');
  assert.strictEqual(body.mipCount, 1,
    'TEXB0004 的 mipCount 读错了 ⟹ 多出来那个字段没跳过');
  assert.strictEqual(body.container, 'PNG');
});

check('⚠️⚠️ tint/opacity 折进材质，其余报成 shader 缺口', () => {
  // ⚠️ 实测样本 B 的 54 个启用 effect 里 **39 个**是 tint/opacity
  //   ⟹ 那两种就是两个乘法，不需要 shader。
  const pkg = S.parsePkg(BUF);
  const sc = S.parseScene(S.readEntry(BUF, pkg, 'scene.json').toString('utf8'));
  const o = sc.objects.find((x) => x.name === '被染色的图');
  assert.ok(o, '样本里该有"被染色的图"');
  assert.ok(Math.abs(o.fx.alpha - 0.2) < 1e-6, `opacity 没折进来（α=${o.fx.alpha}）`);
  assert.ok(Math.abs(o.fx.color[1] - 0.5) < 1e-6, 'tint 的颜色没折进来');
  // ⚠️ 关掉的 effect **不算缺口**（visible: false）
  assert.ok(!o.fx.shaderNeeded.includes('blur'),
    '关掉的 effect 被算成缺口了 ⟹ 那会让覆盖率永远上不去');
  // ⚠️ 要真 shader 的要报出来
  assert.ok(o.fx.shaderNeeded.includes('waterripple'), 'waterripple 该报成缺口');
});

check('⚠️⚠️⚠️ 音频柱按参数还原（那是唯一会随音乐动的东西）', () => {
  // ⚠️⚠️ 实测样本 A 的 8 个可见对象**视差深度全是 0** ——
  //   它的动态**全靠 effect**（水波纹/音频柱/抖动）。
  //   ⟹ 而 `Simple_Audio_Bars` 的参数是**完全声明式**的，
  //     加上我们已有的 128 段频谱（audio-bins.js）⟹ 不用编译它的 .frag。
  const pkg = S.parsePkg(BUF);
  const sc = S.parseScene(S.readEntry(BUF, pkg, 'scene.json').toString('utf8'));
  const bars = sc.objects.find((x) => x.audioBars);
  assert.ok(bars, '音频柱没解析出来');
  assert.strictEqual(bars.audioBars.count, 35, '柱子数读错了');
  assert.strictEqual(bars.audioBars.spacing, 0.5, '柱间距读错了');
  assert.strictEqual(bars.audioBars.lower, 0);
  assert.strictEqual(bars.audioBars.upper, 0.5);
  // ⚠️⚠️ 上界实测见过 **200** ⟹ 必须夹住（否则柱子高 200 倍画布 = 整屏纯色）
  const wild = S.parseAudioBars([{
    file: 'effects/workshop/x/Simple_Audio_Bars/effect.json',
    visible: true,
    passes: [{ constantshadervalues: { 'Lower/Upper Bar Bounds': '0.16 200' } }],
  }]);
  assert.ok(wild.upper <= 1, `上界 ${wild.upper} 没夹住 ⟹ 整屏会是一片纯色`);
  assert.strictEqual(wild.upperClamped, 200, '夹过要记下来（那解释了"柱子比原版短"）');
  // ⚠️ 分隔符两种都有：`"0 0.5"`（空格）和 `"0.02, 0.02"`（逗号）
  const comma = S.parseAudioBars([{
    file: 'x/Simple_Audio_Bars/effect.json',
    visible: true,
    passes: [{ constantshadervalues: { 'Lower/Upper Bar Bounds': '0.1, 0.6' } }],
  }]);
  assert.ok(Math.abs(comma.lower - 0.1) < 1e-6 && Math.abs(comma.upper - 0.6) < 1e-6,
    '逗号分隔的边界解析成了 NaN ⟹ 柱子会消失');
  // ⚠️ 而音频柱**不算 shader 缺口**（我们能还原）
  assert.ok(!bars.fx.shaderNeeded.some((n) => /Audio_Bars/.test(n)),
    '音频柱被算成缺口了');
});

check('⚠️ 相机视差的参数要读出来（那是我们能还原的另一个动态来源）', () => {
  const pkg = S.parsePkg(BUF);
  const sc = S.parseScene(S.readEntry(BUF, pkg, 'scene.json').toString('utf8'));
  assert.strictEqual(sc.general.cameraparallax, true);
  assert.strictEqual(sc.general.cameraparallaxamount, 0.5);
  // ⚠️ 那三个字段缺一个，视差幅度就算错（而"不动"和"动得太少"看起来一样）
  assert.ok(Number.isFinite(sc.general.cameraparallaxmouseinfluence));
  assert.ok(Number.isFinite(sc.general.cameraparallaxdelay));
});

check('⚠️ 文字的四种形态拆完都是字符串', () => {
  // ⚠️ 实测样本 B 的 97 个文字：裸串 17 / {user,value} 49 /
  //   {script,value} 6 / {script,scriptproperties,value} 25
  //   ⟹ 拆完 84 个有内容、13 个空串、**0 个仍非字符串**
  const pkg = S.parsePkg(BUF);
  const sc = S.parseScene(S.readEntry(BUF, pkg, 'scene.json').toString('utf8'));
  const texts = sc.objects.filter((o) => o.kind === 'text');
  for (const o of texts) {
    assert.strictEqual(typeof o.text, 'string',
      `${o.name} 的 text 拆完还是 ${typeof o.text} ⟹ 会画出 [object Object]`);
  }
  const titled = texts.find((o) => o.name === '标题');
  assert.strictEqual(titled.text, '壁纸引擎', '{user,value} 形态的文字没拆出来');
  // ⚠️ 排版字段（实测全小写）
  assert.strictEqual(titled.pointSize, 32);
  assert.strictEqual(titled.hAlign, 'center');
  // ⚠️ 包里的字体 vs 系统字体，两种引用都有
  assert.match(titled.font, /^fonts\//, '包内字体的引用没读出来');
  const sys = texts.find((o) => o.name === '空占位');
  assert.match(sys.font, /^systemfont_/, '系统字体的引用没读出来');
  // ⚠️ 空串不是错误（模板留的占位，实测 13 个）
  assert.strictEqual(sys.text, '');
});

check('⚠️⚠️ 覆盖率的口径要和屏幕上的东西一致', () => {
  // ⚠️ 我第一版数**全部对象** ⟹ 样本 A 报"能画 222 个"，
  //   而实际该画的只有 8 个（其余被父节点关掉）。
  //   ⟹ 判据：**报给用户的数字要和屏幕上的东西同一个口径。**
  const pkg = S.parsePkg(BUF);
  const flat = S.flattenTransforms(
    S.parseScene(S.readEntry(BUF, pkg, 'scene.json').toString('utf8')));
  const r = S.renderability(flat);
  assert.match(r.scope, /继承/, '口径没说清');
  // 合成样本继承后可见：image 4（底图/前景/音频柱/被染色的图）+ text 2
  assert.strictEqual(r.doneN, 6, `能画的该是 6 个，实际 ${r.doneN}`);
  // ⚠️ 而"备用皮肤里的图"被父节点关掉 ⟹ 不该出现在任何计数里
  assert.ok(!flat.objects.find((o) => o.name === '备用皮肤里的图').worldVisible);
  // ⚠️⚠️ shader 缺口要在同一句话里说 —— 否则"都能画"读起来像"效果全有"
  assert.match(r.summary, /shader/, 'shader 缺口没在 summary 里说');
  assert.match(r.summary, /静止/, '没说清那些元素会是静止的');
});



console.log('\n⚠️⚠️⚠️ 像素格式 / LZ4 / DXT（2026-08-04，9 张真实壁纸 232 张贴图实测）');

check('⚠️⚠️⚠️ 像素格式由 flags 定，`format` 字段大面积说谎', () => {
  // ⚠️ 实测：`format=2`（声明 DXT3）的贴图里，实际是
  //   DXT3/5 ×96 · R8 ×28 · RGBA8888 ×22 · DXT1 ×8 · RG88 ×6
  //   ⟹ 按 `format` 上传会得到"长度不匹配"或者一张乱码图。
  // ⚠️⚠️ 而 flags 是干净的判据，怎么定的：
  //   ① 用**长度**反推候选；② 只取唯一匹配的 80 张来学 flags→格式；
  //   ③ 学出来的表核全部 172 张 ⟹ 一致 172、冲突 0。
  //   ⟹ 判据：**先用无歧义的样本学规则，再用规则解释有歧义的。**
  assert.strictEqual(S.PIXEL_BY_FLAGS[0], 'RGBA8888');
  assert.strictEqual(S.PIXEL_BY_FLAGS[4], 'DXT3/5');
  assert.strictEqual(S.PIXEL_BY_FLAGS[7], 'DXT1');
  assert.strictEqual(S.PIXEL_BY_FLAGS[8], 'RG88');
  assert.strictEqual(S.PIXEL_BY_FLAGS[9], 'R8');
  // ⚠️ 长度反推：4 的倍数时 DXT3/5 和 R8 会撞（那正是要靠 flags 的地方）
  assert.deepStrictEqual(S.pixelCandidates(64, 64, 64 * 64), ['DXT3/5', 'R8'],
    '64×64 时 DXT3/5 和 R8 长度相同 ⟹ 那是歧义，必须靠 flags 分');
  // ⚠️ 而非 4 倍数时长度就能定（22×20 那两张就是这么认出是 R8 的）
  assert.deepStrictEqual(S.pixelCandidates(22, 20, 440), ['R8'],
    '22×20 的 440 字节该唯一匹配 R8');
  // ⚠️⚠️ flags 和长度冲突时**以长度为准**（长度是事实，flags 是声明）
  const r = S.resolvePixelFormat(9, 22, 20, 440);
  assert.strictEqual(r.format, 'R8');
  assert.strictEqual(r.byFlags, 'R8');
  const bad = S.resolvePixelFormat(4, 22, 20, 440);   // flags 说 DXT3/5，长度说 R8
  assert.strictEqual(bad.format, 'R8', 'flags 和长度冲突时该信长度');
  assert.strictEqual(bad.agreed, false, '冲突要标出来');
});

check('⚠️⚠️ LZ4 解压（实测 158/232 张贴图是压缩的）', () => {
  // ⚠️ LZ4 **block** 格式（不带帧头）—— WE 在 TEXB 里给了 uncompressedLen
  const lit = (buf) => {
    const out = [];
    let n = buf.length;
    if (n < 15) out.push(n << 4);
    else { out.push(0xf0); n -= 15; while (n >= 255) { out.push(255); n -= 255; } out.push(n); }
    return Buffer.concat([Buffer.from(out), buf]);
  };
  const src = Buffer.from('DreamPaper scene renderer 0123456789');
  const r = S.lz4Decompress(lit(src), src.length);
  assert.ok(r.ok, `全字面量解压失败：${r && r.error}`);
  assert.ok(r.data.equals(src), '全字面量解出来的内容不对');
  // ⚠️⚠️ **重叠匹配**：offset < matchLen 时要逐字节复制（copy 会读到没写的字节）
  //   ⟹ 造一个：literal "AB" + match(offset=2, len=4) ⟹ "ABABAB"
  const token = (2 << 4) | (4 - 4);         // 2 个字面量、匹配长 4
  const seq = Buffer.concat([Buffer.from([token]), Buffer.from('AB'), Buffer.from([2, 0])]);
  const ov = S.lz4Decompress(seq, 6);
  assert.strictEqual(ov.data.toString('latin1'), 'ABABAB',
    '重叠匹配解错了 ⟹ 用 copy 会读到还没写的字节');
  // ⚠️ 坏数据要停住而不是崩
  assert.doesNotThrow(() => S.lz4Decompress(Buffer.from([0xff, 0xff, 0xff]), 100));
  const short = S.lz4Decompress(lit(Buffer.from('AB')), 100);
  assert.ok(!short.ok && /解出 2 字节/.test(short.error),
    '长度不符要说清（那分辨"数据坏了"和"我的解压有 bug"）');
});

check('⚠️⚠️⚠️ DXT 解码（对着手算的值验，不是"看起来对"）', () => {
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  const RED = 0xF800;
  const BLUE = 0x001F;
  const blk = (c0, c1, idx) => Buffer.concat([u16(c0), u16(c1), Buffer.from(idx)]);
  const px = (r, i = 0) => [...r.data.slice(i * 4, i * 4 + 4)];

  // 索引全 0 ⟹ color0
  assert.deepStrictEqual(px(S.decodeDXT(blk(RED, BLUE, [0, 0, 0, 0]), 4, 4, 'DXT1')),
    [255, 0, 0, 255], 'DXT1 color0 解错');
  // ⚠️ 索引 0x55555555 = 每 2bit 都是 1 ⟹ color1
  assert.deepStrictEqual(px(S.decodeDXT(blk(RED, BLUE, [0x55, 0x55, 0x55, 0x55]), 4, 4, 'DXT1')),
    [0, 0, 255, 255], 'DXT1 color1 解错');
  // ⚠️ 索引 3 ⟹ (c0 + 2·c1)/3
  assert.deepStrictEqual(px(S.decodeDXT(blk(RED, BLUE, [0xff, 0xff, 0xff, 0xff]), 4, 4, 'DXT1')),
    [85, 0, 170, 255], 'DXT1 插值色解错（该是 (c0+2c1)/3）');
  // ⚠️⚠️ **5/6 位要按比例扩到 8 位** —— `<<3` 会让纯白变成 248,252,248
  assert.deepStrictEqual(
    px(S.decodeDXT(blk(0xFFFF, 0, [0, 0, 0, 0]), 4, 4, 'DXT1')).slice(0, 3),
    [255, 255, 255], '565→888 没按比例扩 ⟹ 纯白会变成 248,252,248（整体偏暗）');
  // ⚠️⚠️⚠️ DXT1 的 c0 <= c1 ⟹ 第 4 个颜色是**透明**（1bit alpha）
  assert.strictEqual(
    px(S.decodeDXT(blk(BLUE, RED, [0xff, 0xff, 0xff, 0xff]), 4, 4, 'DXT1'))[3], 0,
    'DXT1 的 c0<=c1 模式下索引 3 该是透明 ⟹ 漏了会让该透明的地方变黑块');
  // DXT3：alpha 是 4bit 直值（*17 扩到 8bit）
  const dxt3 = (a, idx) => Buffer.concat([Buffer.alloc(8, a), u16(RED), u16(BLUE), Buffer.from(idx)]);
  assert.strictEqual(px(S.decodeDXT(dxt3(0xff, [0, 0, 0, 0]), 4, 4, 'DXT3'))[3], 255);
  assert.strictEqual(px(S.decodeDXT(dxt3(0x00, [0, 0, 0, 0]), 4, 4, 'DXT3'))[3], 0);
  // ⚠️ 4bit 的 0x8 该扩成 136（8*17），不是 128 —— 那是"按比例"和"左移"的差别
  assert.strictEqual(px(S.decodeDXT(dxt3(0x88, [0, 0, 0, 0]), 4, 4, 'DXT3'))[3], 136,
    '4bit alpha 没按 *17 扩 ⟹ 半透明会偏');
  // DXT5：a0/a1 + 3bit 索引
  const dxt5 = (a0, a1, bits, idx) => Buffer.concat([
    Buffer.from([a0, a1]), Buffer.alloc(6, bits), u16(RED), u16(BLUE), Buffer.from(idx)]);
  assert.strictEqual(px(S.decodeDXT(dxt5(255, 0, 0, [0, 0, 0, 0]), 4, 4, 'DXT5'))[3], 255,
    'DXT5 索引 0 该取 a0');
  // ⚠️⚠️ 边缘块：非 4 倍数尺寸时最后一块只有部分像素在图内。
  //   ⚠️ 只查输出长度**逮不到**这个 bug —— Buffer 写越界是**静默丢弃**的，
  //     长度永远是 w*h*4。⟹ 要查**像素落在了正确的位置**。
  //     （反向验证逮到的：删掉那个 `continue` 之后长度还是对的。）
  //   ⟹ 造一个 5×5：4 个块，每块一个不同的颜色 ⟹ 检查 (4,4) 那个像素
  //     来自**右下**那块（若越界写，它会被上一块的数据盖掉）。
  const GREEN = 0x07E0;
  const edge = S.decodeDXT(Buffer.concat([
    blk(RED, RED, [0, 0, 0, 0]),      // 块(0,0)：左上 4×4 全红
    blk(BLUE, BLUE, [0, 0, 0, 0]),    // 块(1,0)：x=4 那一列全蓝
    blk(GREEN, GREEN, [0, 0, 0, 0]),  // 块(0,1)：y=4 那一行全绿
    blk(0xFFFF, 0xFFFF, [0, 0, 0, 0]), // 块(1,1)：只有 (4,4) 这一个像素在图内
  ]), 5, 5, 'DXT1');
  assert.ok(edge.ok);
  assert.strictEqual(edge.data.length, 5 * 5 * 4, '5×5 的输出长度不对');
  const at = (x, y) => [...edge.data.slice((y * 5 + x) * 4, (y * 5 + x) * 4 + 3)];
  // ⚠️⚠️ 检查点要选**会被冲掉**的那些。反向验证逮到过：
  //   `(4,4)` 恰好是"越界写也不变"的那个点（右下块最后一个像素本来就该落那儿），
  //   所以拿它当锚点的话，删掉边界检查照样绿。
  //   ⟹ 判据：**验边界处理要挑"越界时会变"的位置**，
  //     而那要先想清楚"越界之后数据会跑到哪"。
  //     （实测删掉检查之后：y=1..3 的 x=0..2 从红变蓝 —— 右上那块的像素
  //       按 `py*width+px` 算落到了上一行的中间。）
  assert.deepStrictEqual(at(0, 0), [255, 0, 0], '(0,0) 该来自左上块');
  assert.deepStrictEqual(at(1, 1), [255, 0, 0],
    '(1,1) 该还是左上块的红 ⟹ 变蓝说明右上那块越界写，冲掉了左上块的像素');
  assert.deepStrictEqual(at(2, 3), [255, 0, 0], '(2,3) 同上');
  assert.deepStrictEqual(at(4, 0), [0, 0, 255], '(4,0) 该来自右上块');
  assert.deepStrictEqual(at(0, 4), [0, 255, 0], '(0,4) 该来自左下块');
  assert.deepStrictEqual(at(4, 4), [255, 255, 255], '(4,4) 该来自右下块');
  // ⚠️ 数据不够要报清楚
  const tiny = S.decodeDXT(Buffer.alloc(4), 64, 64, 'DXT3');
  assert.ok(!tiny.ok && /需要/.test(tiny.error), '数据不够时该说清需要多少');
});

check('⚠️ 单/双通道展成 RGBA（遮罩类贴图）', () => {
  // ⚠️ R8 是灰度遮罩 ⟹ rgb 和 a 都填那个值（让调用方自己挑通道）
  const r8 = S.expandToRGBA(Buffer.from([128, 255]), 2, 1, 'R8');
  assert.deepStrictEqual([...r8.data], [128, 128, 128, 128, 255, 255, 255, 255]);
  const rg = S.expandToRGBA(Buffer.from([10, 20]), 1, 1, 'RG88');
  assert.deepStrictEqual([...rg.data], [10, 20, 0, 255]);
  assert.ok(!S.expandToRGBA(Buffer.alloc(4), 1, 1, 'RGBA16F').ok,
    '还不支持的格式该明确报错，不是蒙一个');
});

check('⚠️⚠️ decodeTexture 把三类输入分清（image / rgba / video）', () => {
  // ⚠️ 渲染层只该处理三种输入 ⟹ 这一层要把 11 种存储形态归成 3 类
  const png = S.decodeTexture({ ok: true, container: 'PNG', data: Buffer.from([1, 2]),
    width: 4, height: 4 });
  assert.strictEqual(png.kind, 'image');
  assert.strictEqual(png.mime, 'image/png');
  const mp4 = S.decodeTexture({ ok: true, container: 'none', isVideo: true,
    data: Buffer.from([1]), width: 8, height: 8 });
  assert.strictEqual(mp4.kind, 'video');
  assert.strictEqual(mp4.mime, 'video/mp4');
  const rgba = S.decodeTexture({ ok: true, container: 'none', isLZ4: false,
    pixelFormat: 'RGBA8888', data: Buffer.alloc(4), width: 1, height: 1 });
  assert.strictEqual(rgba.kind, 'rgba');
  // ⚠️ 定不下格式时要说清是哪种情况，不能蒙
  const un = S.decodeTexture({ ok: true, container: 'none', pixelFormat: null,
    pixelByFlags: null, pixelByLength: [], data: Buffer.alloc(4), width: 1, height: 1 });
  assert.ok(!un.ok && /定不下/.test(un.error));
});

check('⚠️ format=34 是 MP4 视频（不是像素格式）', () => {
  // ⚠️ 实测 6 张：数据以 ISO BMFF 的 `ftyp` box 开头
  assert.strictEqual(S.TEX_FORMATS[34].name, 'MP4');
  assert.strictEqual(S.TEX_FORMATS[34].video, true);
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
