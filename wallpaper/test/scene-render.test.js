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

check('⚠️⚠️⚠️ colorBlendMode 非 0 走加色（拿不到枚举时量相关性）', () => {
  // ⚠️ 用户实测报「一块黑色遮挡了大部分画面」：那是 `ripple1440p`
  //   （`colorBlendMode=9`、贴图**没有 alpha**）被当普通不透明画了。
  //
  // ⚠️⚠️ WE 没公开这个枚举 ⟹ 我拿不到"9 是哪种混合"的权威答案。
  //   ⟹ 所以量了一个**能验证的相关性**（9 张壁纸）：
  //       mode 0：108 层，只有 12% 没 alpha
  //       mode 6/9/31：各 1-2 层，**100% 没 alpha**
  //     ⟹ 非 0 的那些靠"混合产生透明"（加色那类：黑色部分自然消失）。
  //   ⟹ 判据：**枚举拿不到时，量"这些值出现在什么样的数据上"** ——
  //     那能定出"该走哪一类混合"，即使定不出"具体是哪一个"。
  //
  // ⚠️ 而**这条断言原来写的是"不许猜、全走普通混合"**，当时是绿的 ——
  //   因为那时我只有 2 张样本、看不出这个相关性。
  //   ⟹ 判据（这个项目第二次撞到）：**守卫锁住的是我当时的理解**，
  //     而样本变多之后理解会变，守卫要跟着改。
  assert.match(renderCode, /if \(!mode\) return THREE\.NormalBlending;/,
    'mode 0 该走普通混合');
  assert.match(renderCode, /return THREE\.AdditiveBlending;/,
    'mode 非 0 没走加色 ⟹ 那些没有 alpha 的图层会变成实心色块盖住画面');
  assert.match(renderCode, /seenBlendModes/,
    '没把见到的 colorBlendMode 报出来 ⟹ "某图层偏亮"就没有线索');
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

check('⚠️⚠️⚠️ 逐帧循环调的函数不能定义在 build() 里面', () => {
  // ⚠️⚠️ **用户实测栽在这里**（0.9.159 第二次）：
  //   我把 `drawBars` / `makeBarsTexture` 写在 `build()` 里面，
  //   而渲染循环 `loop()` 在外面 ⟹ 屏幕上刷
  //   「Uncaught ReferenceError: drawBars is not defined @ scene-render.js:769」，
  //   而它**每帧抛一次**（截图上叠了十几个错误框）。
  //
  // ⚠️ 而 `node --check` 是绿的：函数声明本身没问题，
  //   是"谁能看见谁"错了 —— 那要**真的跑起来**才暴露。
  //   ⟹ 判据：**逐帧循环调的东西，作用域必须和循环同级或更外。**
  //     `build()` 是一次性的装载函数，把每帧要用的东西定义在它里面
  //     等于"只有装载那一刻能看见"。
  //
  // ⟹ 这条守卫做的是：抠出 `build()` 的函数体，列出它内部声明的名字，
  //   再确认**渲染循环和 3 秒自检里没有一个用到它们**。
  const bi = render.indexOf('  async function build(payload) {');
  assert.ok(bi > 0, 'build() 找不到了 —— 锚点变了，这条守卫要跟着改');
  // 配对大括号找函数体
  const bodyEnd = (from) => {
    let depth = 0;
    for (let j = render.indexOf('{', from); j < render.length; j += 1) {
      if (render[j] === '{') depth += 1;
      else if (render[j] === '}') { depth -= 1; if (!depth) return j; }
    }
    return -1;
  };
  const be = bodyEnd(bi);
  assert.ok(be > bi, 'build() 的函数体配不上括号');
  const buildBody = render.slice(bi, be + 1);
  const after = render.slice(be + 1);

  // build() 内部**顶层缩进**（4 空格）声明的名字
  const inner = [];
  for (const m of buildBody.matchAll(/^ {4}(?:function|const|let)\s+([A-Za-z_$][\w$]*)/gm)) {
    inner.push(m[1]);
  }
  assert.ok(inner.length > 3,
    `build() 里只找到 ${inner.length} 个声明 —— 缩进变了？这条守卫要跟着改`);

  // ⚠️ build() 之后的代码（渲染循环 / 自检 / IPC 回调）里不许出现它们
  const outside = after
    .replace(/\/\/[^\n]*/g, '')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/(['"])(?:[^\\'"\n]|\\.)*\1/g, "''");
  const leaked = inner.filter(
    (n) => new RegExp(`(^|[^.\\w$])${n}\\s*[([.]`).test(outside));
  assert.deepStrictEqual(leaked, [],
    `这些定义在 build() 里的名字被 build() 外面用了：${leaked.join(' ')}`
    + ' ⟹ 真机上每帧抛 ReferenceError（而 node --check 是绿的）');
});

check('⚠️⚠️⚠️ 壁纸窗口的报错要通到面板（进日志不等于被看见）', () => {
  // ⚠️ 用户实测**两次**都撞在这条缝上：屏幕上刷 ReferenceError，
  //   而「设置 → 开发者选项 → 壁纸状态」那一栏什么都没有。
  //   ⚠️⚠️ 因为那些报错走 `logEvent`（终端 + 诊断报告），
  //     而**打包版没有终端** ⟹ 用户唯一能看的那一栏反而是空的。
  //   ⟹ 判据：**观测通道要通到"用户真的会去看的那个地方"。**
  const emitFn = /const emit = \(text, extra\) => \{[\s\S]*?\n  \};/.exec(mainCode);
  assert.ok(emitFn, 'watchRendererErrors 的 emit 抠不出来 —— 锚点变了');
  assert.match(emitFn[0], /lastWeErrors\.push/,
    '壁纸窗口的报错没存下来 ⟹ 面板拿不到它');
  assert.match(emitFn[0], /broadcast\('we-status'/,
    '存了但没广播 ⟹ 面板要等下一次状态变化才看到（而那可能永远不来）');
  // ⚠️ 面板三个分支都要显示（"没装上"和"装上了但脚本挂了"经常同时发生）
  assert.match(dash, /function weErrorLines\(/, '面板没有渲染壁纸报错的地方');
  const calls = (dash.match(/weErrorLines\(status\.weErrors\)/g) || []).length;
  assert.strictEqual(calls, 2,
    `weErrorLines 被调了 ${calls} 次，该是 2 次（装载失败那支 + 正常那支）`
    + ' ⟹ 少一支就会在那种情况下看不到报错');
  // ⚠️⚠️ 换壁纸时要清掉上一张的报错（否则查错对象）
  //   ⚠️ 锚到 `weProject = loaded.project;` **之后那几行** ——
  //     `lastWeErrors = []` 和模块级声明 `let lastWeErrors = []` 长得一样，
  //     只查全文的话删掉清空那处、声明还在 ⟹ 守卫照样绿（反向验证逮到的）。
  const onLoad = /weProject = loaded\.project;[\s\S]{0,400}?destroyWEWindow\(\);/
    .exec(mainCode);
  assert.ok(onLoad, '装载壁纸那段抠不出来 —— 锚点变了，这条守卫要跟着改');
  assert.match(onLoad[0], /lastWeErrors = \[\];/,
    '装载新壁纸时没清空上一张的报错 ⟹ 会让人查错对象');
  assert.match(onLoad[0], /lastSceneDiag = null;/,
    '装载新壁纸时没清空上一张的 scene 读数');
});

check('⚠️⚠️⚠️ 我们自己的页面要能报 ready（否则面板永远说"没跑起来"）', () => {
  // ⚠️ 用户实测：面板显示「⏳ 页面加载了，但壁纸还没报 ready」——
  //   而脚本明明跑起来了（后面那些步骤全有读数）。
  //   ⚠️⚠️ 根因：`wallpaperReady` 是 `we-preload.js` 暴露的（给第三方壁纸），
  //     而 `scene.html` 走的是 `preload.js` ⟹ `window.wallpaperReady`
  //     压根不存在 ⟹ 那句 `if` 直接跳过，**静默 no-op**。
  //   ⟹ 判据：**"我们自己的页面"和"第三方壁纸"用两套 preload 时，
  //     两边都要有的那些通道要逐个核**（这次漏 ready，上次漏 onSceneData）。
  assert.match(preload, /wallpaperReady:\s*\(\)\s*=>\s*ipcRenderer\.send\('we-ready'\)/,
    "preload.js 没暴露 wallpaperReady ⟹ scene 永远报不了 ready");
  // ⚠️ 而渲染层要调**这一个**，不是 window.wallpaperReady
  assert.match(renderCode, /window\.gw\.wallpaperReady\(\)/,
    '渲染层调的不是 gw.wallpaperReady ⟹ 判 window.wallpaperReady 等于永远不报');
  assert.ok(!/if \(window\.wallpaperReady\)/.test(renderCode),
    '还在判 window.wallpaperReady ⟹ 那是 we-preload 才有的，这里恒为假');
});

check('⚠️⚠️⚠️ 属性推送不该套到 scene / video 上（诊断话术会变成误导）', () => {
  // ⚠️ 用户实测那行：「⚠️ 有 138 项属性，但壁纸没挂 wallpaperPropertyListener
  //   ⟹ 一项都没进去。它的圆环/粒子/时间都靠属性驱动，所以画面会缺一大块」
  //   ⚠️⚠️ 而那句话对 scene 是**错的**：画面不缺（18 图层 + 44 文字 + 3 柱子都画了），
  //     是那条诊断的前提不成立 —— 属性那条链是给**第三方 web 壁纸**的
  //     （它们自己挂 `wallpaperPropertyListener`），而 scene / video 走
  //     我们自己的页面、参数在 scene.json 里、解析时就用了。
  //   ⟹ 判据：**给 A 写的诊断话术套到 B 上，会变成误导** ——
  //     它比没有诊断更糟（用户会去查一个不存在的问题）。
  assert.match(mainCode,
    /if \(!WE\.isMediaType\(weProject\.type\) && weProject\.type !== 'scene'\) \{\s*sendWEProperties\(\);/,
    'did-finish-load 里无条件调 sendWEProperties ⟹ 它会对 scene 轮询 30 秒'
    + '然后报一句"画面会缺一大块"的错话');
  // ⚠️ 而要说清"为什么这里没有属性状态"（空着会让人以为漏了）
  assert.match(mainCode, /state: `不适用（\$\{weProject\.type\} 类走我们自己的页面）`/,
    '跳过属性推送时没说明原因 ⟹ 那一栏空着会让人以为是漏了');
});

check('⚠️⚠️ 同一屏上的两个数字要能互相解释', () => {
  // ⚠️ 用户那份读数里：「能画 87 个元素（image 30 / text 57）」
  //   vs 「预计画：图层 18 · 文字 44」 ⟹ 差 12 + 13。
  //   ⚠️⚠️ **两个数都对**（57−13 空串=44、30−12 合成层=18），
  //     但差额没解释 ⟹ 会让人以为哪个是 bug。
  //   ⟹ 判据：**同一屏上的两个数字必须能互相解释。**
  assert.match(mainCode, /上面那句"能画 \$\{cap\.doneN\} 个"减去/,
    '"屏幕上会有"那行没说清它和"能画 N 个"的差额从哪来');
  assert.match(mainCode, /合成层 \$\{skip\.composite\}（本来没贴图）/,
    '差额里没标明合成层是"本来没贴图"⟹ 读起来像我们画不出来');
  assert.match(mainCode, /空文字 \$\{skip\.emptyText\}（模板占位）/,
    '差额里没标明空文字是模板占位');
  // ⚠️⚠️ 而"种类"和"实例"不能都叫「个」（实测 3 种 vs 12 个实例）
  assert.match(mainCode, /\$\{composNames\.length\} 种/,
    '合成层那行用「个」报种类数 ⟹ 和下面的实例数撞词，看起来像对不上账');
});

check('⚠️⚠️⚠️ ImageBitmap 的翻转要在创建时给（texture.flipY 对它无效）', () => {
  // ⚠️⚠️ **用户实测**：「有图，但是是上下颠倒的」——
  //   而**文字是正的**。那个"一半正一半反"恰好指出了分界线：
  //     文字 → `CanvasTexture(canvas)`      ⟹ flipY 生效  ✅
  //     图层 → `CanvasTexture(ImageBitmap)` ⟹ flipY 被忽略 ❌
  //   ⚠️ 因为 three 是靠 `gl.pixelStorei(UNPACK_FLIP_Y_WEBGL, texture.flipY)`
  //     实现翻转的，而 WebGL 规范说那个 pack 参数**对 ImageBitmap 源不起作用**。
  //   ⟹ 判据：**同一个属性在不同的纹理源上行为不同** ——
  //     "这个属性我设过了"不等于"它生效了"。
  assert.match(renderCode, /createImageBitmap\([\s\S]{0,80}?\{ imageOrientation: 'flipY' \}\)/,
    "createImageBitmap 没给 imageOrientation: 'flipY' ⟹ 所有图层上下颠倒"
    + '（而文字是正的 —— 那两条路径的 flipY 行为不同）');
  // ⚠️⚠️ 而**不能**指望 texture.flipY 去修 ImageBitmap（那条对它是死的）。
  //   ⚠️ 但 `flipY` 对 **DataTexture** 是**必需**的（0.9.160）——
  //     DataTexture 的默认值是 `false`（和 CanvasTexture 相反），
  //     而我们的 RGBA 是"第一行在上"存的 ⟹ 不翻就上下颠倒。
  //   ⟹ 判据：**同一个属性在不同的纹理类上默认值不同、生效性也不同** ——
  //     所以这条守卫只能管"ImageBitmap 那条路径"，不能全文禁用 flipY。
  //     （我第一版写成全文禁用 ⟹ 加 DataTexture 时它当场误报。）
  const bitmapPath = /const bitmap = await createImageBitmap[\s\S]{0,600}?texCache\.set/.exec(renderCode);
  assert.ok(bitmapPath, 'ImageBitmap 那段抠不出来 —— 锚点变了');
  assert.ok(!/tex\.flipY\s*=/.test(bitmapPath[0]),
    'ImageBitmap 那条路径上设了 tex.flipY ⟹ 那对它无效，会让人以为已经处理了');
  // ⚠️ 而 DataTexture 那条**必须**设
  const dataPath = /new THREE\.DataTexture\([\s\S]{0,400}?texCache\.set/.exec(renderCode);
  if (dataPath) {
    assert.match(dataPath[0], /tex\.flipY = true;/,
      'DataTexture 没设 flipY=true ⟹ 那些图层会上下颠倒（而 PNG 那些是正的）');
  }
});

check('⚠️⚠️ 相机偏移和 zoom 要读出来（只看一个样本发现不了）', () => {
  // ⚠️ 实测样本 B 的 `camera.eye` 是 `(-103.6, 120.9)`，而我原来**整个忽略了它**
  //   ⟹ 画面整体偏 104 像素（混在"大小不太对"里，很难单独看出来）。
  //   ⚠️⚠️ 而样本 A 的 eye 是 `(0, 0)` ⟹ **只看一个样本发现不了这条**。
  //   ⟹ 判据：**"默认值恰好正确"的样本会掩盖漏读的字段。**
  assert.match(renderCode, /payload\.camera && payload\.camera\.eye/,
    '没读 camera.eye ⟹ 相机偏移的壁纸会整体偏几百像素');
  // ⚠️⚠️⚠️ 这条断言原来写的是 `camOffset.x = e[0] - baseW / 2` ——
  //   **它把上一版的 bug 写成了要守的东西**，而且当时是绿的。
  //   ⟹ 判据：**守卫锁住的是我当时的理解，而理解错了守卫就跟着错。**
  //     一条断言的价值上限 = 写它的时候我对那件事的理解。
  //   ⟹ 现在改成守"直接用"（正确的语义在下面那条专门的守卫里）。
  assert.match(renderCode, /camOffset\.x = e\[0\];/,
    'camera.eye 没被读进 camOffset');
  // ⚠️ 相机用的是**夹住之后**的值（`ox/oy`）—— 见下面那条专门的守卫
  assert.match(renderCode, /camera\.position\.set\(ox, oy, 100\)/,
    '算了偏移但没作用到相机上 ⟹ 那是个静默 no-op');
  // ⚠️ zoom 也要读（实测两样本都是 1，但它是个真参数）
  assert.match(renderCode, /Number\(\(payload\.general \|\| \{\}\)\.zoom\)/,
    '没读 general.zoom');
  assert.match(renderCode, /Math\.max\(W \/ baseW, H \/ baseH\) \* camZoom/,
    'zoom 读了但没进投影计算 ⟹ 静默 no-op');
});

check('⚠️⚠️ 第三方内容不合规范时要说清"不是我们的 bug"', () => {
  // ⚠️ 实测 `迷你简综艺.ttf`：Chromium 的 OTS 报
  //   「cmap: Out of order end range (59299 <= 59299)」。
  //   ⚠️ 我把它的 cmap format 4 逐段解出来核过：3710 段里 **8 段**
  //     endCode 不是严格递增 ⟹ 那是**字体作者的问题**。
  //   而字节完好（24 个字体魔数全合法）⟹ 不是解包出错。
  //   ⟹ 判据：**第三方内容不合规范时，要说清"这不是我们的 bug"** ——
  //     否则用户（和下一个我）会去查一个查不出结果的方向。
  assert.match(renderCode, /那是字体本身不合规范/,
    '字体加载失败的提示没说清归属 ⟹ 会让人往"我们读坏了"的方向查');
  assert.match(renderCode, /回退成系统字体/,
    '没说清后果（不致命，那几段字回退）⟹ 读起来像画面废了');
});

check('⚠️⚠️⚠️ camera.eye 已经是中心原点（再减半画布会把画面推到角上）', () => {
  // ⚠️⚠️ **用户实测**：上一版我照 `origin` 的模式给 eye 减了 `baseW/2`
  //   ⟹ 画面**只出现在屏幕右上角**，左边和下边全黑。
  //   ⚠️ 怎么坐实的：样本 A 的 `eye` 是 `(0, 0)`，而它的画面是**居中**的
  //     （抽 preview.gif 首帧核过）⟹ 若 eye 是"画布像素坐标（原点左下）"，
  //     (0,0) 就意味着相机在左下角 ⟹ 画面只剩右上 1/4 —— 正是那个症状。
  //   ⟹ 判据：**同一个文件里的两个坐标字段可以有不同的原点** ——
  //     "这个字段是画布像素坐标"是从 origin 推广过来的，而推广没有依据。
  assert.ok(!/camOffset\.x = e\[0\] - baseW \/ 2/.test(renderCode),
    'camera.eye 又减了半个画布 ⟹ 画面会被推到屏幕右上角（那是实测过的回归）');
  assert.match(renderCode, /camOffset\.x = e\[0\];/,
    'camera.eye 该直接用（它已经是以画布中心为原点的）');
});

check('⚠️⚠️ 相机偏移要夹住（露黑边比少偏几十像素严重）', () => {
  // ⚠️ 实测样本 B：eye.y=+121 会让可见上边界到 1201，
  //   而最大的背景层顶只到 1111 ⟹ **露 90 单位黑边**。
  //   ⚠️ 而图层尺寸是按**画布**做的（背景 4444×2222 vs 画布 3840×2160，
  //     那 1.15 倍是留给视差的余量，不是留给相机偏移的）。
  //   ⟹ 判据：**壁纸铺满屏幕是硬需求，露黑边看起来像"坏了"。**
  assert.match(renderCode, /const maxOffX = Math\.max\(0, baseW \/ 2 - halfW\)/,
    '相机偏移没夹在"画布还盖满屏幕"的范围内 ⟹ 会露黑边');
  assert.match(renderCode, /camera\.position\.set\(ox, oy, 100\)/,
    '算了夹住后的值但没用它 ⟹ 那是个静默 no-op');
  // ⚠️ 夹过要报出来（那解释了"和 WE 里差几十像素"）
  assert.match(renderCode, /camClamped/, '夹住这件事没报出来');
});

check('⚠️⚠️⚠️ scene 装载**只读**壁纸目录，一个字节都不写', () => {
  // ⚠️ 用户 2026-08-04：「不动壁纸本身」
  //   （而更早那条一直在：「写入的地方只能是我们限定的壁纸那个目录，
  //     不能做什么危险操作」—— 这里是**更严**的一条：工坊壁纸是**别人的内容**，
  //     我们是播放器，连它自己的目录都不该改。）
  //
  // ⚠️⚠️ 判据：**渲染器对输入只读。**
  //   一旦写进去，"这张壁纸本来是什么样"就永久丢了（用户重下才能恢复），
  //   而那种损坏是不可逆的 —— 比任何渲染 bug 都严重。
  //
  // ⟹ 这条守卫穷举 scene 装载路径里的每个 `fs.*` 调用，
  //   只允许读操作（existsSync / readFileSync / statSync / readdirSync）。
  const bodyOf = (name) => {
    const i = main.indexOf(`async function ${name}(`);
    if (i < 0) return null;
    let depth = 0;
    for (let j = main.indexOf('{', i); j < main.length; j += 1) {
      if (main[j] === '{') depth += 1;
      else if (main[j] === '}') { depth -= 1; if (!depth) return main.slice(i, j + 1); }
    }
    return null;
  };
  const READ_ONLY = new Set(['existsSync', 'readFileSync', 'statSync', 'readdirSync']);
  for (const name of ['sendSceneData', 'sendSceneLoose']) {
    const b = bodyOf(name);
    assert.ok(b, `${name} 找不到了 —— 锚点变了，这条守卫要跟着改`);
    const calls = [...new Set([...b.matchAll(/fs\.(\w+)\(/g)].map((m) => m[1]))];
    const writes = calls.filter((c) => !READ_ONLY.has(c));
    assert.deepStrictEqual(writes, [],
      `${name} 里有非只读的 fs 调用：${writes.join(', ')}`
      + ' ⟹ 那会改动用户的工坊壁纸（不可逆，重下才能恢复）');
  }
  // ⚠️ 解析层和渲染层**一个 fs 调用都不该有**
  //   （解析是纯函数；渲染进程是 sandbox，本来也读不了文件）
  const parse = fs.readFileSync(path.join(SRC, 'scene-pkg.js'), 'utf8');
  assert.ok(!/require\(['"]node:fs['"]\)|require\(['"]fs['"]\)/.test(parse),
    'scene-pkg.js 引了 fs ⟹ 它该是纯函数（云端可测的前提）');
  assert.ok(!/\bfs\./.test(renderCode),
    'scene-render.js 里有 fs 调用 ⟹ 渲染进程是 sandbox，那本来就不该有');
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
