// scene 渲染层（`scene-render.js` / `scene.html` / 主进程那条装载路径）的守卫。
//
//   node test/scene-render.test.js
//
// ⚠️⚠️ 这一层**跑不起来**（要 WebGL + Electron IPC + 真壁纸窗口）——
//   而它的失败模式全是"静默"：窗口开了、页面加载了、一个错都没有，画面是黑的。
//   ⟹ 所以守的是**源码里那些"错了就全黑"的具体决定**。
//
// ⚠️⚠️⚠️ 而**源码文本守卫有一个已知的陷阱**（这个项目栽过 11 次）：
//   关键词可能撞到注释。⟹ 所以下面每一条都尽量：
//     ① 锚到**语法结构**而不是散词（例如 `worldVisible)` 带括号）
//     ② 或者**数出现次数**并说清期望几次
//   而写完之后要把它守的东西**故意改坏**确认见红（见 commit 说明里的反向验证）。

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1; }
}

const SRC = path.join(__dirname, '..', 'src');
const render = fs.readFileSync(path.join(SRC, 'scene-render.js'), 'utf8');
const html = fs.readFileSync(path.join(SRC, 'scene.html'), 'utf8');
const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8');
const dash = fs.readFileSync(path.join(SRC, 'dashboard.js'), 'utf8');
// ⚠️ 去掉注释再找 —— 那是"关键词撞注释"的正面解法
const renderCode = render.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const mainCode = main.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

console.log('\nscene 渲染层：装载路径');

check('⚠️⚠️⚠️ scene 走我们自己的 preload（isMediaType 认不出它）', () => {
  // ⚠️ `WE.isMediaType('scene')` 是 **false**（它只认 video/gif）
  //   ⟹ 光靠那个判断会给 scene 挂 `we-preload.js`，
  //     而那里面**没有** `onSceneData` ⟹ 场景数据永远送不到，画面全黑。
  //   ⚠️⚠️ 而那种失败**完全静默**：窗口开了、页面加载了、一个错误都没有。
  const WE = (() => { require(path.join(SRC, 'we-host.js')); return globalThis.GestureWallWE; })();
  assert.strictEqual(WE.isMediaType('scene'), false,
    'isMediaType 现在认 scene 了 ⟹ 下面那条守卫的理由变了，要重新想');
  // 选 preload 那一处必须**同时**判 isMediaType 和 scene
  // ⚠️ 锚到"从 `preload:` 到 `we-preload.js`"这一整段 ——
  //   而**不能**用 `\(([^)]*)\)`：那会停在 `isMediaType(...)` 的那个右括号上
  //   ⟹ 拿到的片段里没有 scene 那一项，守卫会误报。
  //   （反向验证时逮到的：代码是对的，是我的正则错了。）
  const pick = /preload:[\s\S]{0,240}?we-preload\.js/.exec(mainCode);
  assert.ok(pick, '找不到选 preload 的那个三元表达式 —— 锚点变了，这条守卫要跟着改');
  assert.match(pick[0], /isMediaType/, '选 preload 时没判 isMediaType');
  assert.match(pick[0], /=== 'scene'/,
    "选 preload 时没单独判 'scene' ⟹ 它会拿到 we-preload.js（没有 onSceneData）⟹ 全黑");
});

check('⚠️ preload 暴露了 scene 要的三条通道', () => {
  for (const ch of ['onSceneData', 'onSceneError', 'onWeAudio']) {
    assert.ok(new RegExp(`${ch}:\\s*on\\(`).test(preload),
      `preload.js 没暴露 ${ch} ⟹ 渲染层拿不到它`);
  }
  // ⚠️⚠️ 音频要走**裸的** we-audio（128 段），不是面板那个抽样诊断通道
  assert.match(preload, /onWeAudio:\s*on\('we-audio'\)/,
    "onWeAudio 该接 'we-audio' —— 接成 'we-audio-frame' 会拿到每半秒一次的"
    + '抽样诊断数据 ⟹ 柱子变成 2fps 的抖动');
});

check('⚠️⚠️ 场景数据在主进程解、按需送（包是 11-123MB）', () => {
  // ⚠️ 渲染进程是 sandbox（读不了文件系统）⟹ 主进程解包再 IPC 送。
  //   ⚠️⚠️ 而**不整包送** —— 120MB 塞进 IPC 会把 Electron 卡死。
  assert.match(mainCode, /webContents\.send\('scene-data'/,
    '主进程没发 scene-data');
  // 只送继承后可见的对象要的东西
  assert.ok(/o\.worldVisible\b/.test(mainCode),
    '收集纹理/字体时没按 worldVisible 过滤 ⟹ 会白送几十 MB');
  // ⚠️ raw 要剥掉（每个对象带一份原始 JSON 会让载荷翻几倍）
  assert.ok(/raw:\s*_r,|\{\s*raw,\s*\.\.\.rest\s*\}/.test(mainCode),
    '送出去之前没剥掉对象的 raw 字段 ⟹ IPC 载荷翻几倍');
});

check('⚠️⚠️⚠️ 装载失败要送到屏幕上，不能只 console', () => {
  // ⚠️ 壁纸层**没有 devtools 入口**，而"黑屏"是所有失败的共同外观。
  assert.match(mainCode, /webContents\.send\('scene-error'/,
    "主进程失败时没发 scene-error ⟹ 用户只看到一片黑，屏幕上什么都不说");
  assert.match(renderCode, /onSceneError\(/, '渲染层没接 scene-error');
  // 渲染层要有一个居中的致命错误框
  assert.match(html, /id="fatal"/, 'scene.html 里没有 #fatal 那个致命错误框');
  assert.match(html, /id="diag"/, 'scene.html 里没有 #diag 那个诊断层');
});

console.log('\n探针 / 诊断');

check('⚠️⚠️ 诊断层默认可见，出问题时不淡出', () => {
  // ⚠️ 判据：**探针要默认可见** —— 藏在快捷键后面的诊断，
  //   在"我不知道出了什么事"的时候没人会去按。
  assert.ok(!/id="diag"[^>]*hidden/.test(html), '#diag 默认藏起来了');
  assert.match(renderCode, /if\s*\(!hasProblem\)\s*\{[\s\S]{0,120}classList\.add\('fade'\)/,
    '淡出没判 hasProblem ⟹ 有问题时那些行会自己消失（那正是最需要它的时候）');
});

check('⚠️⚠️ 三个读数点都在（终端 / 屏幕 / 探针）', () => {
  // ① console → 主进程的 watchRendererErrors 捞走 ⟹ 进终端 + 诊断报告
  assert.match(renderCode, /console\.log\(`\[scene\]/, '没往 console 报（终端和诊断报告都读它）');
  // ③ window.__dpSceneInfo → 主进程 executeJavaScript 读
  assert.match(renderCode, /window\.__dpSceneInfo\s*=/, '没挂 __dpSceneInfo ⟹ 探针读不到渲染侧读数');
  assert.match(renderCode, /window\.__dpDiag\s*=/, '没挂 __dpDiag');
  // 主进程那条探针
  assert.match(mainCode, /__dpSceneInfo/,
    '诊断报告没读渲染侧的 __dpSceneInfo ⟹ "送了多少"和"画了多少"对不上账');
  assert.match(mainCode, /scene:\s*lastSceneDiag/,
    '诊断报告里没带 scene 那一份（每一步耗时/纹理/字体/能力都在里面）');
});

check('⚠️⚠️⚠️ "画了 0 个"要报成致命，而不是安静地黑着', () => {
  assert.match(renderCode, /if\s*\(made === 0\)\s*\{[\s\S]{0,200}fatal\(/,
    '一个图层都没建起来时没报 fatal ⟹ 那就是一片黑加零信息');
  // 3 秒自检：帧数 / gl.getError / 音频帧
  assert.match(renderCode, /getError\(\)/, '自检没查 gl.getError()');
  assert.match(renderCode, /frames === 0/, '自检没查"一帧都没画"');
  assert.match(renderCode, /audioFrames === 0/,
    '没报"收到 0 帧频谱" ⟹ "柱子不动"的两个原因（没音乐 / 通道断）分不开');
});

check('⚠️ 能力缺口三项都要说（画不了的类型 / shader / 合成层）', () => {
  // ⚠️⚠️ 锚到**判断条件**而不是标识符 —— 反向验证逮到过：
  //   把 `if (cap.shaderMissN > 0)` 改成 `if (false)`，
  //   而 `cap.shaderMissN` 这个词还在别处（送出去那份 payload 里）⟹ 守卫照样绿。
  //   ⟹ 判据：**"这个词出现过"证明不了"那段代码会跑"。**
  assert.match(renderCode, /if\s*\(cap && cap\.missN > 0\)/,
    '没在 missN > 0 时报"画不了的对象"');
  assert.match(renderCode, /if\s*\(cap && cap\.shaderMissN > 0\)/,
    '没在 shaderMissN > 0 时报 shader 缺口'
    + ' ⟹ 实测样本 A 的动态全在 effect 里，不说这句用户会以为是我们没画');
  assert.match(renderCode, /if\s*\(composNoTex > 0\)/,
    '没在有合成层时单独报 ⟹ 14 个正常现象看起来像 14 个 bug');
});

console.log('\n渲染的那些"错了就看不出来"的决定');

check('⚠️⚠️⚠️ 用 worldVisible / worldPos，不是 visible / origin', () => {
  // ⚠️ 实测样本 A：70 个自己 visible，正确该画的只有 8 个。
  //   而子对象的 origin 是**相对父节点**的。
  assert.match(renderCode, /\.filter\(\(o\) => \(o\.kind === 'image' \|\| o\.kind === 'text'\) && o\.worldVisible\)/,
    '筛可见对象时用的不是 worldVisible ⟹ 6 种语言的字会叠在一起');
  assert.match(renderCode, /mesh\.position\.set\(o\.worldPos\[0\]/,
    '摆位置时用的不是 worldPos ⟹ 子对象的坐标全错');
  // ⚠️ 排序也要按 worldPos 的 Z
  assert.match(renderCode, /sort\(\(a, b\) => \(a\.worldPos\[2\]/,
    '按 Z 排序时用的不是 worldPos ⟹ 图层前后颠倒');
});

check('⚠️⚠️ depthTest 关掉之后，叠放顺序只由 renderOrder 决定', () => {
  assert.match(renderCode, /depthTest:\s*false/, '没关 depthTest（透明区域会挡住后面的）');
  assert.match(renderCode, /renderOrder\s*=/,
    '关了 depthTest 却没设 renderOrder ⟹ 叠放顺序变成不确定的');
});

check('⚠️⚠️⚠️ `|| 1` 对"0 是合法值"的字段是错的', () => {
  // ⚠️ `color` 的分量可以合法地是 0（纯黑染色）⟹ `o.color[0] || 1` 会把 0 变成 1。
  assert.ok(!/\(o\.color\[0\]\s*\|\|\s*1\)/.test(renderCode),
    "颜色分量用了 `|| 1` ⟹ 合法的 0（纯黑染色）会被当成 1");
  assert.match(renderCode, /num\(o\.color\[0\], 1\)/,
    '颜色分量该走 num()（只有非有限才走默认）');
  // num() 的定义要真的只挡非有限值
  assert.match(renderCode, /function num\(v, dflt\)\s*\{\s*return Number\.isFinite\(v\)/,
    'num() 不是用 Number.isFinite 判的 ⟹ 它会把 0 也当成"要走默认"');
});

check('⚠️⚠️ 折进来的 tint / opacity 要真的乘上去', () => {
  // ⚠️ 实测样本 B 有 10 个 opacity effect，其中「歌手名」α=0.20 ——
  //   漏了它那行字会比设计的显眼 5 倍。
  assert.match(renderCode, /\*\s*\(o\.fx \? o\.fx\.alpha : 1\)/,
    'opacity effect 没乘进材质的 opacity');
  assert.match(renderCode, /o\.fx\.color\[0\]/, 'tint effect 没乘进材质的 color');
});

check('⚠️⚠️⚠️ 贴图查映射表，不能把 image 当路径用', () => {
  assert.match(renderCode, /payload\.texByImageRef/,
    '没用主进程给的 image→texPath 映射 ⟹ 把 model JSON 当 .tex 用 ⟹ 全黑');
  assert.ok(!/texByName\.get\(o\.image\)/.test(renderCode),
    '还在用 o.image 直接查纹理 ⟹ 那是那个"整个画面全黑"的 bug');
});

check('⚠️⚠️⚠️ 纹理走 createImageBitmap（body 是 PNG/JPEG 不是 DXT）', () => {
  // ⚠️ 实测图层真正用到的 11 张贴图里 10 张是 PNG、1 张 JPEG。
  assert.match(renderCode, /createImageBitmap\(/,
    '没用 createImageBitmap ⟹ 按 DXT 上传一张也传不上去');
  // ⚠️ 那些 DXT 专用的东西**不该还在**（留着会误导下一个人）
  assert.ok(!/CompressedTexture/.test(renderCode),
    'CompressedTexture 还在 ⟹ 那条路实测一张也走不通，留着会误导');
  assert.ok(!/uvScale/.test(renderCode),
    'uvScale 还在 ⟹ PNG/JPEG 解出来就是图片本身的尺寸，缩 UV 会让图偏');
  // ⚠️ 并发解码 —— 一张 5760×2880 的 JPEG 要几十毫秒
  assert.match(renderCode, /await Promise\.all\(list\.map/,
    '纹理是串行解的 ⟹ 11 张会让首帧晚半秒以上（那段时间是黑的）');
});

check('⚠️⚠️ build 是 async ⟹ 异常要在 .catch 里接', () => {
  // ⚠️ 外层那个 try 接不到 async 函数里抛的东西 —— 那种失败会变成
  //   unhandledrejection（而画面已经黑了）。
  assert.match(renderCode, /async function build\(/, 'build 不是 async（纹理解码要 await）');
  assert.match(renderCode, /build\(payload\)[\s\S]{0,200}\.catch\(/,
    '调 build 时没接 .catch ⟹ 建场景抛的异常没人报');
});

check('⚠️⚠️ 画布尺寸读 payload.canvas，不反推', () => {
  // ⚠️ 同样锚到条件 —— `payload.canvas` 那个词在别处也有
  assert.match(renderCode, /if\s*\(payload\.canvas && payload\.canvas\.width > 0\)/,
    '没在有画布尺寸时用它 ⟹ 反推会让实测样本 B 的画面缩到 2/3、四周露黑边');
  assert.match(renderCode, /baseW = payload\.canvas\.width/, '没把画布宽赋给 baseW');
  assert.ok(!/maxW = Math\.max/.test(renderCode),
    '还在从最大图层反推画布 ⟹ 实测样本 B 最大图层比画布大 1.5 倍');
});

check('⚠️ 字体异步就位之后要重画文字', () => {
  // ⚠️ 不重画的话字体永远是回退的，而"字体不对"看起来像"这张壁纸本来就这样"
  assert.match(renderCode, /FontFace\(/, '包内字体没走 FontFace 注册');
  // ⚠️⚠️ 锚到那次重画的**完整动作**（判该不该重画 → 重做纹理 → 换 map）——
  //   反向验证逮到过：只查 `L.textObj` 的话，把那个 continue 改成无条件
  //   （等于不重画）照样绿，因为 `L.textObj` 在建 layers 时也出现。
  assert.match(renderCode, /if\s*\(!L\.textObj \|\| !fontFamilies\.has\(L\.textObj\.font\)\)\s*continue;/,
    '重画循环里没判"这一条是不是用了包内字体"');
  assert.match(renderCode, /L\.mesh\.material\.map = t;/,
    '字体就位后没把新纹理换上去 ⟹ 字体永远是回退的（而那不报错）');
});

check('⚠️⚠️ 中文回退字体必须在（否则中文变豆腐块）', () => {
  // ⚠️ macOS 上没有 Consolas / 微软雅黑 ⟹ 回退链里一定要有中文字体，
  //   而实测文字里有「凌晨」「壁纸引擎」这类。
  assert.match(renderCode, /PingFang SC/,
    '字体回退链里没有中文字体 ⟹ 中文会变成 □□□，而那种失败不报错');
});

check('⚠️⚠️ 混合模式没坐实就不猜（但要报出见到的值）', () => {
  // ⚠️ 实测 `colorBlendMode` 取值是 **9 和 31**，不是 0/1/2。
  //   ⚠️ 而 9/31 具体对应哪种混合**没有证据** ⟹ 猜错的症状是"图层发白/发灰"，
  //     那看起来像"这张壁纸本来就这样"，比不做更难查。
  assert.ok(!/mode === 1\s*\)\s*return THREE\.AdditiveBlending/.test(renderCode),
    'blendingFor 还在按 mode===1 判加色 ⟹ 实测永远命中不到，那段是死代码');
  assert.match(renderCode, /seenBlendModes/,
    '没把见到的 colorBlendMode 报出来 ⟹ "某图层光效不对"就没有线索');
});

check('⚠️ 限帧 40（壁纸是常驻后台进程）', () => {
  // ⚠️ 这个项目为"壁纸吃满 CPU"栽过一轮（用户报「手势不跟手了」）
  assert.match(renderCode, /1000 \/ 40/, '没限帧 ⟹ 壁纸会吃满 CPU');
});

check('⚠️⚠️ 没音频时柱子也要画（空白和"坏了"分不清）', () => {
  assert.match(renderCode, /SILENT_SPECTRUM/,
    '没有替代频谱 ⟹ "没在放音乐"和"通道断了"都是空白，分不开');
  assert.match(renderCode, /spectrum \|\| SILENT_SPECTRUM/, '循环里没用替代频谱');
});

check('⚠️⚠️ 频谱是左 64 + 右 64 镜像（不是 128 段连续）', () => {
  // ⚠️ 那是这个项目逆向 WE 时烧掉十一轮才定的事实（见 audio-bins.js）
  assert.match(renderCode, /sp\.length \/ 2/,
    '音频柱把 128 段当连续频段用了 ⟹ 右半是左半的镜像，柱子会对称重复');
});

check('⚠️⚠️⚠️ 两端要能对账（"预计画多少" vs "实际画了多少"）', () => {
  // ⚠️ `renderability()` 说的是"这些类型我们支持"，而它看不到贴图解析失败 /
  //   合成层 / 空文字 ⟹ 实测样本 A 它说"能画 9 个"，屏幕上只会有 6 个。
  //   ⚠️⚠️ 而"预计 18 实际 0"（纹理解码全失败）这种事**不报错** ——
  //     图层建不起来只是 continue 一下。
  //   ⟹ 判据：**跨进程的链路，两端的计数要能对上，对不上要自己喊。**
  assert.match(mainCode, /step\('屏幕上会有'/,
    '主进程没算"预计会画多少" ⟹ 只有 renderability 那个数字 = 假承诺');
  assert.match(mainCode, /willDraw: diag\.willDraw/, '预计值没送给渲染层 ⟹ 没法对账');
  assert.match(renderCode, /made !== wantN/,
    '渲染层没和主进程的预计值对账 ⟹ "纹理解码全失败"会安静地变成黑屏');
});

check('⚠️⚠️ 动态来源要盘点（"为什么不动"的直接答案）', () => {
  // ⚠️ 实测样本 A 的 8 个可见对象视差深度**全是 0**、动态全在 shader effect 里
  //   ⟹ 我们画出来接近静止，而那必须主动说出来。
  assert.match(mainCode, /diag\.motion\s*=/, '主进程没盘点动态来源');
  assert.match(mainCode, /cameraparallax/,
    '没读 general.cameraparallax ⟹ 那是我们能还原的动态来源之一');
  assert.match(renderCode, /没有任何我们能还原的动态来源|动态全在/,
    '渲染层没在"一个动态来源都没有"时说出来 ⟹ 用户会以为是我们没画完');
});

check('⚠️⚠️ 字体有总量上限，而丢掉的要报出来', () => {
  // ⚠️ 实测样本 B 用到的 10 个字体合计 **33.8MB**（最大一个 16.6MB），
  //   而那些字节要过 IPC ⟹ 无上限会让装载卡几秒。
  //   ⚠️⚠️ 判据：**要设上限就得说清丢了什么** ——
  //     静默截断读起来像"全都送了"。
  // ⚠️ 锚到**那个循环**而不是常量名 —— 反向验证逮到：把常量改名之后
  //   `FONT_BUDGET` 这个词还在注释里 ⟹ 守卫照样绿。
  //   ⚠️⚠️ 而**别用 `[^)]*`** —— 条件里有 `fonts[...].data.length` 那层括号，
  //     它会提前停住（这是我今天第二次踩它）。
  assert.match(mainCode, /while\s*\(fonts\.length &&[\s\S]{0,80}?FONT_BUDGET\)/,
    '字体没有总量上限 ⟹ 实测 33.8MB 过 IPC 会让装载卡几秒');
  assert.match(mainCode, /fontDropped\.push/, '超预算丢掉的字体没记下来');
  assert.match(mainCode, /fontDropped\.length\)/,
    '丢掉字体时没报出来 ⟹ "某几段字的字体不对"会是无解的谜');
  // ⚠️ 要**从小到大**装（丢大的）—— 反过来会让一个 16MB 的字体吃掉全部预算
  assert.match(mainCode, /fonts\.sort\(\(a, b\) => a\.data\.length - b\.data\.length\)/,
    '装字体前没按体积从小到大排 ⟹ 一个 16MB 的字体会吃掉全部预算');
});

check('⚠️⚠️⚠️ 装载回调里不能出现模块级不存在的裸标识符', () => {
  // ⚠️⚠️ **用户实测栽在这里**（0.9.159）：我在 `did-finish-load` 回调里写了
  //   `sendSceneData(win, dir)`，而 `createWEWindow()` **没有 dir 参数** ——
  //   壁纸目录挂在模块级的 `weProject` 上。
  //   ⟹ 用户一点 scene 就弹「ReferenceError: dir is not defined」。
  //
  // ⚠️⚠️⚠️ 而 `node --check` 和当时全部 65 项守卫**都是绿的**：
  //   语法没问题，而那一行只在"真的装载一张 scene"时才执行 ——
  //   那一步云端跑不了（要 Electron 窗口 + did-finish-load 事件）。
  //   ⟹ 判据：**"云端能测的"和"真机才跑到的"之间有一条缝，
  //     而回调里的自由变量正好落在缝里。**
  //
  // ⟹ 所以这条守卫做的是**穷举那个分支里的裸标识符**，
  //   逐个确认它在模块级或者局部有定义。
  //   ⚠️ 它只覆盖 scene 那个分支（那是这次出事的地方）——
  //     全文件扫会有大量假阳性（对象字面量的键、解构、模板串），
  //     而假阳性多的守卫会被忽略，那等于没有。
  const branch = /if \(weProject\.type === 'scene'\) \{[\s\S]*?\n  \} else if/.exec(mainCode);
  assert.ok(branch, 'scene 那个分支找不到了 —— 锚点变了，这条守卫要跟着改');
  const code = branch[0]
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/(['"])(?:[^\\'"\n]|\\.)*\1/g, "''");
  // 模块级绑定
  const modLevel = new Set();
  for (const m of main.matchAll(/^(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    modLevel.add(m[1]);
  }
  // 这个分支里自己声明的 + 回调参数
  const local = new Set(['win', 'error']);
  for (const m of code.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
  for (const m of code.matchAll(/\(([A-Za-z_$][\w$,\s]*)\)\s*=>/g)) {
    m[1].split(',').forEach((x) => local.add(x.trim()));
  }
  const KEYWORDS = new Set(['if', 'else', 'const', 'let', 'return', 'new', 'await',
    'async', 'function', 'true', 'false', 'null', 'undefined', 'typeof', 'catch', 'try']);
  const GLOBALS = new Set(['console', 'path', 'fs', 'Buffer', 'JSON', 'Math', 'Number',
    'String', 'Object', 'Array', 'Set', 'Map', 'Promise', 'Date', '__dirname']);
  const undef = [];
  // ⚠️ `[^.\w$]` 前缀 = 不在点号后面（那些是属性名）；`(?!\s*:)` = 不是对象键
  for (const m of code.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)(?!\s*:)/g)) {
    const id = m[1];
    if (KEYWORDS.has(id) || GLOBALS.has(id)) continue;
    if (modLevel.has(id) || local.has(id)) continue;
    undef.push(id);
  }
  assert.deepStrictEqual([...new Set(undef)], [],
    `scene 装载分支里这些标识符在模块级和局部都找不到：${[...new Set(undef)].join(' ')}`
    + ' ⟹ 真机一装载就会 ReferenceError（而 node --check 是绿的）');
});

check('⚠️⚠️⚠️ 探针不能只放在壁纸窗口里（它挂了探针跟着挂）', () => {
  // ⚠️ 用户实测反馈：「你说的右上角诊断框我不知道在哪里」。
  //   ⚠️⚠️ 两个原因：① 那个框在**壁纸窗口**里，而壁纸铺在桌面最底层
  //     ⟹ 有别的窗口挡着就看不见；
  //     ② 而**装载在送数据之前就崩的话，它根本没机会显示**
  //       （那次就是主进程 ReferenceError，页面加载完了但一个字都没送）。
  //   ⟹ 判据：**探针不能只放在"要观测的那个东西"里面。**
  // ⚠️⚠️ 锚到 **weStatus 函数体内** —— `scene: lastSceneDiag` 有两处
  //   （这里 + 诊断报告那份）⟹ 只查那个片段的话，改坏一处另一处还能让它变绿。
  //   （反向验证逮到的。）
  const weStatusFn = /function weStatus\(error\)[\s\S]*?\n\}/.exec(mainCode);
  assert.ok(weStatusFn, 'weStatus 抠不出来 —— 锚点变了，这条守卫要跟着改');
  //   ⚠️⚠️ 而键名前面要卡住行首空白 —— `_scene:` **含有** `scene:` 这个子串，
  //     不卡的话把键改名（等于面板读不到）照样绿。（同一条守卫上栽的第二次。）
  assert.match(weStatusFn[0], /\n\s*scene: lastSceneDiag \?/,
    'weStatus 没带 scene 读数 ⟹ 面板上看不到，而壁纸窗口那个框可能被挡住/来不及显示');
  assert.match(dash, /function sceneLines\(/, '面板没有渲染 scene 读数的地方');
  assert.match(dash, /\+ sceneLines\(status\.scene\)/,
    'sceneLines 定义了但没被调用 ⟹ 那是个静默 no-op');
  // ⚠️ 装载失败要广播 —— 否则面板停在装载前的状态，而屏幕上一片黑
  assert.match(mainCode, /broadcast\('we-status', weStatus\(`scene 装载失败/,
    'scene 装载失败时没广播 ⟹ 面板和屏幕两边都不说话');
});

check('⚠️⚠️⚠️ 主进程未捕获异常要先记进诊断报告再显示', () => {
  // ⚠️ 用户实测撞到 macOS 那个原生框：
  //   「A JavaScript error occurred in the main process: ReferenceError: dir is not defined」
  //   ⚠️⚠️ 那是 Electron 的默认行为，而它**不进 logEvent** ⟹ 诊断报告里没有它
  //     ⟹ 用户把报告发过来，最要紧的那次崩溃反而看不到。
  assert.match(mainCode, /process\.on\('uncaughtException'/,
    '主进程没有未捕获异常的兜底 ⟹ 崩溃不进诊断报告');
  assert.match(mainCode, /process\.on\('unhandledRejection'/,
    '主进程没接 unhandledRejection');
  // ⚠️ 要 logEvent（那才进报告的 events）
  const handler = /process\.on\('uncaughtException'[\s\S]{0,900}?\n\}\);/.exec(mainCode);
  assert.ok(handler, 'uncaughtException 的 handler 抠不出来 —— 锚点变了');
  assert.match(handler[0], /logEvent\(/, '崩溃没记进 logEvent ⟹ 诊断报告里看不到');
  // ⚠️⚠️ 而**不能吞掉它** —— 一个坏掉的主进程继续跑会产生更难查的后续症状
  assert.match(handler[0], /throw error;/,
    '未捕获异常被吞掉了 ⟹ 坏掉的主进程继续跑，后续症状更难查');
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
