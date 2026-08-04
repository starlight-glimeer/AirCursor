// Dashboard：四个分区（模板 / 图库 / 手势录制 / 壁纸与音乐）。
//
// 每个控件都直接写回主进程，主进程持久化并广播 —— 所以没有"应用"按钮可以忘记按，
// 壁纸也不用被单独通知。
const T = window.GestureWallTemplates;
const Lib = window.GestureWallLibrary;
const P = window.GestureWallPreview;
const Sys = window.GestureWallSystem;

let config = null;
let strategy = null;
let recordingAction = null;

// ---------------------------------------------------------------------------
// 启动页
// ---------------------------------------------------------------------------
const launch = document.getElementById('launch');

// ⚠️⚠️ **没有强制等待**（0.9.48）。用户 2026-08-01：
//   「开局什么强行等待呀，然后什么点击跳过这些都不要，我们现在没有什么让用户
//     强制等待的这个需求，加这个只是以后可能会有而已，所以说设计上应该是
//     出现主界面，然后你点一下进去，不用强行让用户等这个时间」
//
// **他说得对。** 0.9.46 我加了 2.2s 进度条 + 自动进入，那是**假进度** ——
// 我们没有任何可测的加载阶段，那条进度条纯粹是装出来的"在起"。
// 而它的代价是真的：每次启动、每次来回测试都要等 2.2 秒。
//
// ⟹ 撤掉进度条和 setTimeout(enterApp)。启动页仍然在（极光 + logo 是产品的
//   第一印象），但它**等用户**，不是用户等它。
//
// ⚠️ 因此也不再需要「点击跳过」那行提示 —— 没有东西可跳过了。
//   剩下的是纯粹的"点一下进去"，那不需要一行字来说明（整个页面都可点）。
let launchDone = false;
function enterApp() {
  if (launchDone) return;    // ⚠️ 点击和键盘可能同时到
  launchDone = true;
  launch.classList.add('gone');
  stopLaunchParticles();
  // ⚠️⚠️ 告诉主进程可以建骨架层了 —— 它会压在启动页上（用户报过
  // 「登录界面啥都没点的时候，我都能看到我手的骨架」），所以它等这个信号。
  // ⚠️ optional call（`?.()`）—— 打包版之外（比如直接在浏览器里开 dashboard.html
  // 调样式）没有 window.gw，那时候不该整个函数抛异常导致启动页关不掉。
  window.gw?.launchDismissed?.();
}
launch.onclick = enterApp;
// 键盘也能进：点击是主路径，但一个只能点的入口对键盘用户是死路。
window.addEventListener('keydown', (e) => {
  if (!launchDone && (e.key === 'Enter' || e.key === ' ')) enterApp();
});

// ---------------------------------------------------------------------------
// 启动页的动态背景：缓慢流动的极光（0.9.47）
//
// ⚠️⚠️ 这是**第二版**。第一版（0.9.46）是"光点 + 近邻连线"，用户的评价是：
//   「你这个做得太劣质了，还不如没有呢」「有一种非常廉价的感觉，没有质感」
//
// **他说得对。** 点+连线是网页背景里最烂俗的一种（到处都是的
// particles.js 观感），它的问题不是参数没调好，是**这个形式本身**廉价。
// ⟹ 换方向：不画"物体"，画**光**。
//
// 做法 = 五团大面积柔和色斑，各自沿一条很慢的椭圆轨迹漂移，叠加混色。
//   · `filter: blur()` 把硬边化掉 —— 这是"柔光"和"色块"的分界线
//   · `globalCompositeOperation = 'lighter'` 让重叠处**变亮**而不是覆盖
//     ⟹ 那个亮起来的交界处才是极光的观感来源
//   · 轨迹周期 22~40 秒 ⟹ 慢到"看不出在动，但一眨眼不一样了"
//
// ⚠️ 为什么不用纯 CSS（多个 radial-gradient + animation）：
// CSS 没有 `lighter` 混色（`mix-blend-mode: screen` 要每团一个元素 +
// 各自的 keyframes ⟹ 五团就是五套动画，而且叠加处的亮度不可控）。
// canvas 里三行就能做对。
//
// ⚠️ 四个必须做对的地方，否则是"看起来在跑但什么都没有"：
//   ① devicePixelRatio —— 不缩放的话 Retina 上是模糊的一团
//   ② canvas 的 CSS 尺寸是 100%，而 width/height 属性是像素 ⟹ 必须显式设
//      （不设默认 300×150，画出来只占左上角一小块）
//   ③ blur 半径要按 dpr 放大 —— ctx.filter 的单位是**设备像素**不是 CSS 像素，
//      不乘 dpr 的话 Retina 上模糊只有一半，边缘就露出来了
//   ④ 拿不到 2d context 时要**安静地放弃**，不能抛 —— 这个文件顶层抛异常
//      会让后面所有开关的绑定全停（这个项目栽过：面板异常表现为"开关点了没反应"）
// ---------------------------------------------------------------------------
// ⚠️ 每个 canvas 一个 RAF 句柄 —— 共用一个的话进主界面时停启动页那份
// 会把主界面那份也停掉（而症状是"背景不动了"，不报错）。
const auroraRAF = {};

function stopAurora(canvasId) {
  if (auroraRAF[canvasId] != null) {
    cancelAnimationFrame(auroraRAF[canvasId]);
    auroraRAF[canvasId] = null;
  }
}

// 兼容名：启动页那处叫这个（enterApp 里调）
function stopLaunchParticles() { stopAurora('launch-particles'); }

// ⚠️⚠️ **两处在用同一个极光**（0.9.59）：启动页 + 主界面背景。
// 用户 2026-08-01：「我想给产品一开始那个背景动画也加到打开软件之后，作为背景」
//
// ⚠️ `opts.dim` = 主界面那份要**暗得多**（0.28）——
//   启动页上极光是主角，而主界面上它是背景：卡片和文字要压得住它。
//   不调暗的话网格上的文字读不清（而那不报错，只是"看起来乱"）。
// ⚠️ 两份各自一个 RAF 句柄（`auroraRAF` 是个字典）——
//   共用一个的话进主界面时 `stopAurora('launch-particles')` 会把主界面那份也停掉。
function startAurora(canvasId, opts) {
  const cv = document.getElementById(canvasId);
  if (!cv) return;
  const ctx = cv.getContext('2d');
  if (!ctx) return;   // 安静放弃：背景是装饰，不该拖垮整个面板
  const dim = (opts && opts.dim) || 1;
  // ⚠️⚠️⚠️ **诊断模式**（0.9.69）。用户第五次报"没有"，而我五轮里换了
  // 亮度/dim/opacity/模糊位置/底色层级 —— 每一轮都在赌某个环节。
  //
  // ⟹ 停止赌。这个开关让极光**不透明地**画（纯色大块 + 一行文字），
  //   那把问题一刀切成两半：
  //     看到色块 ⟹ canvas 是可见的 ⟹ 问题在亮度/混色（继续调那边）
  //     看不到   ⟹ **canvas 整个不可见** ⟹ 问题在层级/尺寸/遮挡
  //                （那时候调亮度一万年也没用 —— 正是我这五轮做的事）
  // ⚠️ 它由开发者选项里的复选框控制，默认关。
  const loud = !!(opts && opts.loud);

  // 五团光。颜色刻意都偏冷（青/蓝/紫）+ 一点洋红提亮 ——
  // 和面板的 --accent (#6cc7ff) 同一个色系，不是随机好看的颜色。
  // ⚠️ alpha 很低（.10~.20）：`lighter` 会累加，高了就成一团白。
  // ⚠️⚠️ **第二次调参**（0.9.48）。用户 2026-08-01：
  //   「你说你家的什么什么渐变动画，我看起来不是很明显」
  //
  // 0.9.47 那组参数太保守了，两个维度都不够：
  //   · **亮度** a=.09~.20 ⟹ 在近纯黑底上确实是"有点脏"而不是"有光"
  //     ⟹ 提到 .26~.46（`lighter` 是加法，但底色 #07080c 几乎是 0，
  //        所以叠 2~3 团才到 ~.9，还没到糊成白的地步）
  //   · **运动** 轨迹幅度 ax/ay 只有 0.10~0.15（屏宽的 10~15%）+ 周期 22~40s
  //     ⟹ 每秒位移不到一个像素，人眼判定为"静止"
  //     ⟹ 幅度提到 0.22~0.34，周期压到 11~19s
  //
  // ⚠️ 我不再猜"够不够" —— 这一版故意**偏强**。宁可用户说"太晃了"
  //   （那是个明确的方向），也不要再一次"看不出在动"（那说明白做了）。
  // ⚠️⚠️ **第三次调色**（0.9.60）。用户 2026-08-01：
  //   「你现在做的这个效果不是很明显，色调可以来点紫色」
  //
  // 两处改动：
  // ① **紫成为主色** —— 原来五团里只有一团是紫（170,110,255），其余是青蓝，
  //    而青蓝在深色底上本来就"低调"⟹ 整体看起来是"淡淡的蓝"。
  //    现在三团紫（紫罗兰 / 品红紫 / 蓝紫）+ 两团青蓝提亮，紫是主调。
  // ② **亮度整体提一档**（0.30~0.46 → 0.42~0.62）—— 主界面那份还要
  //    再乘 dim × --bg-aurora，链路上每一环都在削弱它（见下面的算式）。
  //
  // ⚠️ 主界面实际亮度 = a × dim × opacity(--bg-aurora)
  //    0.9.59：0.46 × 0.28 × 0.5 = **0.064** ⟹ 几乎看不见，那就是"不明显"。
  //    0.9.60：0.62 × 0.55 × 0.85 = **0.29** ⟹ 约 4.5 倍。
  //    ⟹ 三个系数**串联**，只调一个不够 —— 我上一版只想着调 blobs 的 a。
  // ⚠️⚠️ **第四次调色**（0.9.61）。用户 2026-08-01：
  //   「现在太紫了，其实不加紫色之前的样式稍微明显一些也不错的」
  //
  // ⟹ **色调回到 0.9.48 那版**（青蓝为主 + 一团紫罗兰 + 一团洋红），
  //   而**亮度保留 0.9.60 提上来的那一档**（用户说"稍微明显一些也不错"——
  //   他要的是"原来的颜色 + 现在的亮度"，那两件事是独立的）。
  //
  // ⚠️ 我 0.9.60 把三团都改成紫是**过头了**：用户说"来点紫色"，
  //   而我把主色整个换掉了。"加一点"和"换掉"是两回事。
  //   ⟹ 现在紫只有一团（170,110,255，就是 0.9.48 那个），它在五团里
  //     提供"偏紫的那个方向"，而不是决定整体色调。
  // ⚠️⚠️ **第五次调色**（0.9.71）。用户 2026-08-01：
  //   「颜色的话，不要那个紫色了，这个颜色存在感再降低一些，
  //     若隐若现还挺高级的」
  //
  // ⟹ 三件事：
  //   ① **紫全去掉** —— 五团都在青/蓝/青绿这一段（和 --accent #6cc7ff 同族）。
  //      ⚠️ 那个"品红紫"（255,140,210）也去了 —— 它虽然不是紫，
  //        但在深底上和紫的观感很接近（红分量高）。
  //   ② **存在感降低**：alpha 0.42~0.62 → 0.20~0.30（约一半）。
  //      ⚠️ 不动 dim（那是滑杆管的、用户可以自己调）—— 改这里的基准值，
  //        那样"滑杆在中间时就是若隐若现"，而他要更亮时还有余量。
  //   ③ **拉开层次**：五团的 alpha 差距从 1.5× 拉到 1.5×，但整体压低之后
  //      重叠处的加法混色不会糊成一片 ⟹ 那才是"若隐若现"的关键
  //      （均匀一片淡色 = 脏；有明有暗 = 有光在流动）。
  const blobs = [
    { hue: '108,199,255', a: 0.30, r: 0.56, cx: 0.30, cy: 0.34, ax: 0.28, ay: 0.22, T: 13, ph: 0.0 },
    { hue: '90,180,255',  a: 0.26, r: 0.50, cx: 0.68, cy: 0.30, ax: 0.26, ay: 0.26, T: 17, ph: 1.7 },
    { hue: '90,225,220',  a: 0.24, r: 0.44, cx: 0.50, cy: 0.62, ax: 0.34, ay: 0.20, T: 11, ph: 3.1 },
    { hue: '120,205,240', a: 0.22, r: 0.48, cx: 0.22, cy: 0.68, ax: 0.24, ay: 0.25, T: 19, ph: 4.4 },
    { hue: '80,200,235',  a: 0.20, r: 0.38, cx: 0.78, cy: 0.66, ax: 0.30, ay: 0.23, T: 15, ph: 5.6 },
  ];

  let w = 0;
  let h = 0;
  let dpr = 1;

  // ⚠️⚠️ **画布只用一半分辨率**（0.9.71）。用户 2026-08-01：「可以了，但是卡卡的」
  //
  // "卡"有两种可能，而解法**相反**：
  //   ① 帧率太低（20fps）⟹ 提帧率，但那会加重 CPU
  //   ② CPU 画不动     ⟹ 降负载
  // 算了一遍：20fps 下最快那团每帧跳 12px（T=11s, ax=0.34, 峰值 249 px/s）
  // ⟹ 柔光边缘每帧跳十几像素，人眼看就是"一跳一跳" ⟹ **主因是 ①**。
  //
  // ⟹ 两个一起做：**分辨率降一半**（像素数 ÷4）+ **帧率 20→40**
  //   0.9.70：20fps × 5 fill × 4.2M = 0.42 G 像素/秒
  //   现在：  40fps × 5 fill × 1.05M = 0.21 G 像素/秒（**还降了一半**）
  // ⚠️ 半分辨率看不出差别 —— 极光是**大团柔光 + 90px 模糊**，
  //   它本来就没有需要保留的细节。而 CSS 的 width/height 仍是 100%
  //   ⟹ 浏览器把小画布拉伸上来，那一步是合成器（GPU）做的、几乎免费。
  const RES = 0.5;

  function resize() {
    dpr = (window.devicePixelRatio || 1) * RES;
    // ⚠️⚠️ **`clientWidth` 可能是 0，那时候整个动画白跑**（0.9.67）。
    //
    // 用户第三次报"极光看不到"，而我加的自检**那一行根本没出现在日志里**
    // ⟹ 不是"画布是空的"，是绘制循环压根没产生可见结果。
    // 而 `clientWidth/clientHeight` 是**布局尺寸** —— 一个 `position: fixed`
    // 的 canvas 在某些情况下（父容器是 grid、或者 CSS 还没应用完）
    // 拿到的是 0 ⟹ `cv.width = 0` ⟹ 画布 0×0 ⟹ 画什么都看不见，
    // 而且**不报任何错**（往 0×0 的画布上画是合法的）。
    //
    // ⟹ 用 `window.innerWidth/innerHeight` 兜底：这个 canvas 是
    //   `position: fixed; inset: 0` ⟹ 它就该是**视口大小**，
    //   那不需要问布局。
    // ⚠️ 而不是"取两者较大" —— 明确用视口尺寸，因为那才是它的语义。
    w = cv.clientWidth || window.innerWidth;
    h = cv.clientHeight || window.innerHeight;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    // ⚠️ setTransform 而不是 scale —— 后者会在每次 resize 时**累积**
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  // ⚠️ 用 rAF 给的时间戳而不是 Date.now() —— 前者和帧对齐（动画不会跳），
  // 而且第一帧的值我们拿它当基准，不依赖任何外部时钟。
  let t0 = null;
  // ⚠️ 每个 canvas 各一个 —— 共用的话第二个就不自检了。
  let selfChecked = false;
  // ⚠️⚠️ **降帧到 ~20fps**（0.9.63）。极光的周期是 11~19 秒 ——
  // 那是"慢到看不出在动"的东西，60fps 画它是纯浪费（而这个应用常驻，
  // 浪费会一直累积，和手势推理抢 CPU）。
  // ⚠️ 仍然挂 rAF（而不是 setInterval）：rAF 在窗口不可见时**自动停**，
  //   setInterval 不会 —— 那是"最小化了还在烧 CPU"的来源。
  // ⚠️ 40fps（0.9.70 是 20）—— 见上面 RES 那段：半分辨率省下的给帧率，
  // 总开销比 20fps@全分辨率还低一半，而每帧位移从 12px 降到 6px。
  const MIN_DT = 1000 / 40;
  let lastDraw = 0;

  // ⚠️⚠️⚠️ **整个帧回调包在 try 里**（0.9.70）。
  //
  // 「极光看不到」查了六轮，根因是一行 `const base = ...` 被我 0.9.63 连带删掉，
  // 而 `base` 在下面还在用 ⟹ 第一帧抛 ReferenceError
  // ⟹ **rAF 回调里的异常不往上传播** ⟹ 动画静默停止、没有任何日志。
  // 而"画面没变化"这个症状和"参数太小"**长得完全一样**
  // ⟹ 我在错的方向上调了六轮参数。
  //
  // ⟹ 判据：**长跑的回调必须自己 try/catch 并把异常报出来。**
  //   它死了要能看见 —— 这个项目在"静默失效"上栽过九次，
  //   而每一次的代价都是"在错的地方找原因"。
  // ⚠️ 报错之后**不再排下一帧** —— 一个每帧都抛的循环会刷屏，
  //   而第一条消息已经包含了全部信息。
  let frameError = null;

  function frame(now) {
    try {
    if (t0 === null) t0 = now;
    // ⚠️ 跳帧要在**任何绘制之前** return，而 rAF 得继续排 —— 不然动画就停了。
    if (now - lastDraw < MIN_DT) {
      auroraRAF[canvasId] = requestAnimationFrame(frame);
      return;
    }
    lastDraw = now;
    const t = (now - t0) / 1000;   // 秒

    // ⚠️ 必须清 —— 不清的话 `lighter` 会把每一帧累加成纯白（几秒就白屏）。
    ctx.clearRect(0, 0, w, h);

    // ⚠️⚠️⚠️ **模糊回到 canvas 里**（0.9.68）。
    //
    // 用户 2026-08-01：「我这里不理解的点是我们之前不都有历史的版本吗？
    //   你都知道之前激光这个效果没有问题的时候是怎么样的，
    //   怎么现在调这么多都是还没调好呢？而且感觉你走偏了」
    //
    // **他说得对，而这是我该早两轮想到的。** 0.9.61 他说"太紫了"
    // —— 那意味着**看得见**。而 0.9.63 我把模糊从 `ctx.filter` 搬到 CSS
    // 之后就再也看不到了，之后我调了三轮参数（亮度/dim/opacity）
    // + 加了自检 + 改了底色层级 —— **全都建在"参数不对"这个错前提上**。
    //
    // ⇒ 用 `git diff` 一比就清楚：`a90e3a3` 那次改动是唯一的分界。
    //   而两者**不等价**：
    //     `ctx.filter = blur(N)` —— 在画布**内部**模糊，每个 fill 各自摊开，
    //        `lighter` 混色发生在**模糊之后**（亮度叠加）
    //     CSS `filter: blur(N)` —— 对**整个元素**的最终结果模糊，
    //        而且会被元素边界裁掉、中心亮度大幅摊薄
    //   ⇒ 后者看起来就是"几乎没有"。
    //
    // ⇒ 回到 ctx.filter。而性能那条**用降帧解决**（20fps，见 MIN_DT）：
    //     0.9.63 之前：60fps × 5 fill × 4.2M 像素 = 1.26 G 像素/秒
    //     现在：      20fps × 5 fill × 4.2M 像素 = 0.42 G 像素/秒（**33%**）
    //   ⚠️ 还不够低的话，下一步降的是**画布分辨率**（用0.5× 尺寸画再拉伸，
    //     极光是大团柔光、半分辨率看不出差别，能再省 4 倍），
    //     **而不是再动模糊**。
    // ⚠️ 半径要乘 dpr —— ctx.filter 的单位是**设备像素**（CSS 那个是 CSS 像素，
    //   我搬过去时照抄了数字，那也是一处等价性错误）。
    // ⚠️ 诊断模式：**不模糊、不混色、不透明** —— 只要 canvas 可见就一定看得到。
    if (loud) {
      ctx.filter = 'none';
      ctx.globalCompositeOperation = 'source-over';
      // 三条粗色带 + 一个会动的方块（动的那个证明 rAF 在跑）
      const bands = ['#ff3b6b', '#3bff9e', '#3b9eff'];
      for (let i = 0; i < 3; i += 1) {
        ctx.fillStyle = bands[i];
        ctx.fillRect(0, (h / 3) * i, w, h / 3);
      }
      ctx.fillStyle = '#000';
      const px = ((t * 120) % Math.max(1, w - 60));
      ctx.fillRect(px, h / 2 - 30, 60, 60);
      ctx.fillStyle = '#fff';
      ctx.font = '20px -apple-system, sans-serif';
      ctx.fillText(`${canvasId} ${cv.width}x${cv.height} dpr=${dpr} t=${t.toFixed(1)}s`, 20, 40);
      auroraRAF[canvasId] = requestAnimationFrame(frame);
      return;
    }
    //
    // 用户 2026-08-01 报「手势的部分，不跟手了，卡卡的」+「开启摄像头，
    // 显示骨架，这个过程也好慢」。
    //
    // 根因算得出来：`ctx.filter = blur(262px)` 是**逐 fill 应用**的 ——
    //   画布 1280×820@2x = 4.2M 像素，5 个 fill ⟹ 每帧 21M 像素的模糊运算，
    //   60fps ⟹ **每秒 1.3 G 像素**。
    //   而手势推理（MediaPipe，640×480@30fps）只有 9M 像素/秒 —— **差 140 倍**。
    //   ⟹ 极光把 CPU 吃光了，手势推理和摄像头启动都在跟它抢。
    //
    // ⟹ 两条改动（见 CSS 的 `#app-bg { filter: blur() }` 和下面的降帧）：
    //   ① 模糊交给**合成器**（CSS filter 走 GPU，而且对整层只做一次，
    //      不是每个 fill 一次）⟹ 5 遍变 1 遍，且不占主线程
    //   ② 帧率从 60 降到 ~20（极光是"慢到看不出在动"的东西，60fps 是纯浪费）
    // ⚠️⚠️⚠️ **`base` 的声明**（0.9.70 补回来的）——
    // 这就是"极光看不到"整整六轮的根因。
    //
    // 0.9.63 我把模糊搬到 CSS 时删掉了这两行：
    //     const base = Math.min(w, h);
    //     ctx.filter = `blur(${Math.round(base * 0.16 * dpr)}px)`;
    // 而 `base` 在下面 `const r = base * b.r` **还在用**
    // ⟹ 第一帧就抛 `ReferenceError: base is not defined`
    // ⟹ 而 **rAF 回调里的异常不往上传播** ⟹ 动画静默停止，一帧都没画出来。
    //
    // ⚠️ 这就是为什么我调了六轮参数（亮度/dim/opacity/模糊位置/底色层级/自检）
    //   一点效果都没有 —— **压根没有任何东西在画**。
    // ⚠️ `node --check` 查不出（语法合法）；没有任何日志（异常被 rAF 吞了）；
    //   而"画面上没变化"这个症状和"参数太小"**长得完全一样**。
    //
    // ⟹ 定位它靠的是"`bg-geom` 更新了但 `bg-selfcheck` 停在初始文本"
    //   ⟹ 同步代码跑了、rAF 回调没跑 ⟹ 然后逐个查 frame() 里引用的变量有没有声明。
    // ⟹ 教训：**删代码时要查被删的行有没有定义别处在用的东西。**
    //   我删的是"两行相邻的 filter 相关代码"，而其中一行是别处的依赖。
    const base = Math.min(w, h);
    ctx.filter = `blur(${Math.round(base * 0.16 * dpr)}px)`;
    ctx.globalCompositeOperation = 'lighter';

    for (const b of blobs) {
      // 椭圆轨迹。x 和 y 用不同的相位（+1.3）⟹ 不是正圆，看起来更随机。
      const th = (t / b.T) * Math.PI * 2 + b.ph;
      const x = (b.cx + Math.cos(th) * b.ax) * w;
      const y = (b.cy + Math.sin(th + 1.3) * b.ay) * h;
      const r = base * b.r;

      // ⚠️ 径向渐变而不是纯色圆 —— 纯色圆 blur 之后中心还是一个平的盘，
      // 而渐变让中心亮、边缘化开，那才像光。
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      // ⚠️ `dim` 让主界面那份暗下来（0.28）—— 见函数头的注释。
      const a = b.a * dim;
      g.addColorStop(0, `rgba(${b.hue},${a.toFixed(3)})`);
      g.addColorStop(0.55, `rgba(${b.hue},${(a * 0.42).toFixed(3)})`);
      g.addColorStop(1, `rgba(${b.hue},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // ⚠️ 复位这两个状态 —— 它们是 ctx 的**持久**状态。不复位的话下一帧
    // clearRect 也会带着 filter 跑（clearRect 不受 filter 影响，但 composite
    // 会影响后续任何绘制）。这是"下一帧莫名变样"那类 bug 的来源。
    ctx.filter = 'none';
    ctx.globalCompositeOperation = 'source-over';

    // ⚠️⚠️ **自检**（0.9.66）—— 用户报了三轮"极光看不到"，而我调了三轮参数
    // 都没效果 ⟹ 那本身就是"参数不是原因"的证据。
    //
    // ⟹ 直接**采样画完的画布**，报出"canvas 里到底有没有东西"。
    //   那一下把问题切成两半：
    //     canvas 里有值、屏幕上看不到 ⟹ **层级/遮挡/opacity 的问题**
    //     canvas 里就是全 0        ⟹ **绘制本身没跑**（尺寸为 0、混色错、被清掉）
    // ⚠️ 只在**第一次绘制后**采一次 —— 每帧 getImageData 是很贵的
    //   （它强制 GPU→CPU 回读，那正是我们刚修掉的那类开销）。
    if (!selfChecked) {
      selfChecked = true;
      // ⚠️⚠️ **先报尺寸**，再报采样 —— 尺寸为 0 的话采样必然是 0，
      //   而那两种情况的修法完全不同（一个是布局、一个是绘制）。
      //   我上一版只报了采样峰值 ⟹ 就算它是 0 我也分不清是哪种。
      if (!cv.width || !cv.height) {
        const m = `[aurora] ${canvasId} ⚠️ 画布尺寸是 ${cv.width}×${cv.height}`
          + `（clientWidth=${cv.clientWidth} innerWidth=${window.innerWidth}）`
          + ' ⟹ 画什么都看不见，而且不报错';
        console.error(m);
        if (typeof logLine === 'function') logLine('wall', m);
      }
      try {
        // 采中心和四个偏心点 —— 单采中心的话，正好某一帧那里是暗的会误判
        const pts = [[0.5, 0.5], [0.3, 0.34], [0.68, 0.3], [0.5, 0.62], [0.22, 0.68]];
        let peak = 0;
        for (const [fx, fy] of pts) {
          const d = ctx.getImageData(Math.round(w * fx * dpr), Math.round(h * fy * dpr), 1, 1).data;
          peak = Math.max(peak, d[0], d[1], d[2]);
        }
        const msg = `[aurora] ${canvasId} 自检：画布 ${cv.width}×${cv.height}`
          + ` dpr=${dpr} dim=${dim} 采样峰值=${peak}/255`
          + (peak < 8 ? '  ⚠️ 画布几乎是空的 ⟹ 绘制没跑（不是"不明显"）'
            : '  ✅ 画布里有内容 ⟹ 看不到就是层级/遮挡问题');
        console.log(msg);
        // ⚠️ 也送到面板的日志区 —— 打包版没有终端，控制台看不到
        //   （这个项目在"日志只进 stdout"上栽过：用户报不出数字）。
        // ⚠️ `logLine(source, message)` 是**两个参数** —— 我第一版传了个对象
        //   `logLine({source, message})` ⟹ 会显示成 `[wall] undefined`（不报错）。
        if (typeof logLine === 'function') logLine('wall', msg);
        // ⚠️⚠️ **同时写到「性能」那块的固定位置**（0.9.67）。
        // 用户第一次找这行自检时**没找到** —— 日志区只留最后 N 行，
        // 而 FFT 自检 + `[we] 资源文件不在` 会把它冲掉。
        // ⟹ 关键的一次性诊断要有**固定的落点**，不能只往流式日志里扔。
        const slot = document.getElementById('bg-selfcheck');
        if (slot) slot.textContent = msg.replace('[aurora] ', '');
      } catch (error) {
        // getImageData 在跨域污染的画布上会抛 —— 我们的画布没有外部图片，
        // 但失败也不该影响动画。
        console.warn('[aurora] 自检失败：', error.message);
      }
    }

    auroraRAF[canvasId] = requestAnimationFrame(frame);
    } catch (error) {
      // ⚠️ 只报一次 —— 每帧都抛的话会刷屏，而第一条已经有全部信息。
      if (!frameError) {
        frameError = error;
        const m = `[aurora] ${canvasId} ⚠️⚠️ 绘制抛异常，动画已停：${error.message}`;
        console.error(m, error);
        if (typeof logLine === 'function') logLine('wall', m);
        const slot = document.getElementById('bg-selfcheck');
        if (slot) slot.textContent = m.replace('[aurora] ', '');
      }
      // ⚠️ 不再排下一帧 —— 但**要留下痕迹**（上面那三行）。
      //   静默停止是这次六轮弯路的全部原因。
    }
  }
  auroraRAF[canvasId] = requestAnimationFrame(frame);
}

// ⚠️⚠️ **`bgDim` 必须在这里声明**（0.9.65）—— 下面 `startAurora('app-bg')`
// 是**模块级同步执行**的，而我第一版把它写在开发者模块那一段里（第 2852 行）
// ⟹ `let` 的 TDZ ⟹ `ReferenceError: Cannot access 'bgDim' before initialization`
// ⟹ 后面所有开关的绑定全停（这个项目为"一处抛异常挡住后面全部"栽过三次，
//    而症状是"面板上什么都点不动"，跟 bgDim 一点关系都没有）。
// ⚠️ `node --check` 查不出 TDZ —— 语法是合法的。
//
// 值：0.9（0.9.60 是 .55）。`--bg-aurora` 那一环 0.9.65 撤了（和它完全重复），
// 而算过的实际亮度（0.29 ⟹ 屏幕上 rgb(32,45,58) vs 底色 rgb(16,16,20)）
// 说明原来那档太保守。
// ⚠️ 0.9.72：0.9 → **0.5**。用户 2026-08-01：「一开始的展示界面可以了，
// 然后点进去之后的界面颜色再弱一些吧」
// ⟹ **启动页和主界面的强度是分开的**（启动页那份 dim=1，他说可以了 ⟹ 不动）。
//   那个分离是 0.9.59 就有的设计（`startAurora(id, {dim})`）——
//   在这里正好用上：同一套光、两个场景各自的强度。
// ⟹ 最亮团落到 0.30 × 0.5 = 0.15，比上一版（0.27）弱一半，
//   而守卫下界是 0.08 ⟹ 还有余量，不会撞上"那不是若隐若现是没有"。
let bgDim = 0.5;

startAurora('launch-particles', { dim: 1 });
// ⚠️ dim 0.28 → 0.55（0.9.60）：三个系数串联（a × dim × --bg-aurora），
// 0.28 那一版实际亮度只有 0.064 ⟹ 用户报"不明显"。见 blobs 上面的算式。
startAurora('app-bg', { dim: bgDim });

// ---------------------------------------------------------------------------
// ⚠️ 这里原来有 `applyTheme()` + 主题按钮的绑定（0.9.59）—— 0.9.60 删了。
// 用户：「浅色模式太难看了，我们只保留深色吧，设置里的颜色主题这个撤掉吧」
//
// **他说得对**：那套浅色配色是我一次写出来的、没有实测支撑
// （accent 压暗多少、分隔线基色、极光在白底上怎么办 —— 全是我拍的）。
// 一个深色产品的浅色版不是"把颜色取反"，它要重新设计每一处对比关系。
// ⟹ 做半套比不做糟。
//
// ⚠️ 但颜色仍然全走 CSS 变量（见 dashboard.html 的 :root）——
// 撤掉的是"半套浅色"，不是"变量化"。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ⚠️⚠️ 红绿灯的显隐**不在这里** —— 0.9.60 整段搬到主进程了。
//
// 用户报（0.9.59 之后）：「我鼠标放到红绿灯那里了，但是没反应。
// 好像必须点击一些窗口最上方，然后才可以显示」
//
// 根因：渲染进程的 `mousemove` 在窗口**没聚焦**时派发不可靠，而
// "从别的应用把鼠标移过来"正是最常见的路径 ⟹ 网页收不到事件。
// "点一下才显示" = 点击让窗口聚焦，之后 mousemove 才开始来。
//
// ⟹ 改成主进程轮询 `screen.getCursorScreenPoint()`（见 main.js 的
//    pollTrafficLights）—— 那个不依赖焦点，也不需要任何授权。
// ⟹ 判据：**"窗口未聚焦时也要工作"的东西不能挂在渲染进程的鼠标事件上。**
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 左栏切换
// ---------------------------------------------------------------------------
for (const button of document.querySelectorAll('nav button[data-tab]')) {
  button.onclick = () => {
    for (const b of document.querySelectorAll('nav button[data-tab]')) b.classList.remove('on');
    for (const s of document.querySelectorAll('main section')) s.classList.remove('on');
    button.classList.add('on');
    document.getElementById(`tab-${button.dataset.tab}`).classList.add('on');
    // ⚠️ 切到「我的壁纸」就刷新。
    //
    // 用户报（2026-07-31）：「壁纸存储目录那里应该是自动刷新，不应该是每次我自己
    // 手动点击刷新才能看到」。
    //
    // 他说得对，而且理由比"方便"更硬：壁纸目录是**磁盘上的东西**，
    // 用户会在 Finder 里往里拖文件、删文件 —— 那些变化面板压根不知道。
    // 而"切过去看看"正是他想知道"现在有什么"的时刻。
    //
    // ⚠️ 只在切到那个页签时扫，不做轮询：扫描要遍历磁盘（Steam 那个目录 639MB），
    // 每隔几秒扫一次会一直占着 IO。
    renderTab(button.dataset.tab);
  };
}

// ⚠️⚠️ 切到某个页签时要做的事。**启动时和点击切换共用这一个函数**（0.9.58）——
// 原来这段逻辑内联在 onclick 里，而启动路径没有它
// ⟹ 默认页签（0.9.54 起是「我的壁纸」）打开时是空的。
// ⟹ 两条路径走同一个函数，加新页签的刷新逻辑时不会漏掉启动那条。
let bootRendered = false;

function renderTab(tab) {
  // ⚠️ 切到「我的壁纸」就重扫。
  //
  // 用户报（2026-07-31）：「壁纸存储目录那里应该是自动刷新，不应该是每次我自己
  // 手动点击刷新才能看到」—— 他说得对，理由比"方便"更硬：壁纸目录是**磁盘上的
  // 东西**，用户会在 Finder 里往里拖文件、删文件，那些变化面板压根不知道。
  //
  // ⚠️ 只在切过去时扫，不做轮询：扫描要遍历磁盘（Steam 那个目录 639MB），
  // 每隔几秒扫一次会一直占着 IO。
  if (tab === 'mine') renderMine();
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function get(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

// 点路径 → 嵌套 patch，这样主进程的深合并只碰那一个键。
function patchFor(path, value) {
  const keys = path.split('.');
  const root = {};
  let node = root;
  for (let i = 0; i < keys.length - 1; i += 1) {
    node[keys[i]] = {};
    node = node[keys[i]];
  }
  node[keys[keys.length - 1]] = value;
  return root;
}

function fileUrl(p) {
  if (!p) return '';
  return `file://${String(p).split('/').map(encodeURIComponent).join('/')}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------------------
// 滑块（数据驱动，避免"加了滑块但漏改一处"）
// ---------------------------------------------------------------------------
const TUNING = [
  { path: 'depth.background', label: '背景景深', min: -9, max: -1, step: 0.1 },
  { path: 'depth.shard', label: '碎片景深', min: 0.4, max: 4, step: 0.1 },
  { path: 'parallax', label: '视差强度', min: 0, max: 3, step: 0.05 },
  { path: 'transform.background.scale', label: '背景缩放', min: 0.8, max: 2.2, step: 0.02 },
  { path: 'transform.subject.scale', label: '主体缩放', min: 0.3, max: 2.2, step: 0.02 },
  { path: 'transform.subject.y', label: '主体上下', min: -2, max: 2, step: 0.02 },
  { path: 'shards.count', label: '碎片数量', min: 0, max: 16, step: 1 },
  { path: 'shards.spread', label: '碎片散布', min: 0.2, max: 3.5, step: 0.05 },
  { path: 'transform.shard.scale', label: '碎片大小', min: 0.2, max: 6, step: 0.1 },
  { path: 'tilt.maxYaw', label: '左右转幅度°', min: 0, max: 70, step: 1 },
  { path: 'tilt.maxPitch', label: '上下转幅度°', min: 0, max: 50, step: 1 },
];

const MUSIC_TUNING = [
  { path: 'music.coverInfluence', label: '封面染色强度', min: 0, max: 1, step: 0.05 },
];

const GESTURE_TUNING = [
  { path: 'gestureTuning.minCutoff', label: '平滑强度', min: 0.2, max: 6, step: 0.1 },
  { path: 'gestureTuning.beta', label: '快速跟随', min: 0, max: 0.3, step: 0.005 },
  { path: 'gestureTuning.deadzone', label: '静止死区', min: 0, max: 0.01, step: 0.0002 },
  { path: 'gestureTuning.prediction', label: '预测提前量', min: 0, max: 1.5, step: 0.05 },
  { path: 'gestureTuning.swipeSpeed', label: '挥动速度门', min: 1, max: 6, step: 0.1 },
  { path: 'gestureTuning.tiltTriggerDeg', label: '倾斜触发角°', min: 8, max: 45, step: 1 },
];

function renderSliders(hostId, spec) {
  const host = document.getElementById(hostId);
  host.innerHTML = '';
  for (const item of spec) {
    const row = el('div', 'row2');
    const label = el('label', null, item.label);
    const range = document.createElement('input');
    range.type = 'range';
    range.min = item.min;
    range.max = item.max;
    range.step = item.step;
    range.value = get(config, item.path);
    // 小数位数按步长算：死区滑块步长 0.0002，固定 toFixed(2) 会让整条滑轨都显示 0.00。
    const decimals = Math.max(0, Math.min(4, -Math.floor(Math.log10(item.step))));
    const out = el('output', null, Number(range.value).toFixed(decimals));
    range.oninput = () => {
      out.textContent = Number(range.value).toFixed(decimals);
      window.gw.setConfig(patchFor(item.path, Number(range.value)));
    };
    row.append(label, range, out);
    host.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// 模板分区
// ---------------------------------------------------------------------------
const SLOT_LABEL = {
  background: { name: '背景', hint: '整张壁纸' },
  subject: { name: '主体', hint: '抠好的人物，透明 PNG' },
  shard: { name: '碎片', hint: '壁纸的一小块' },
};
// 应用预设会改掉滑块背后的值，那时必须重建；普通拖动时不能重建，否则会把拖着的
// 滑块从手指下抽走。
let pendingPresetRefresh = false;
// ---------------------------------------------------------------------------
// 图库分区
// ---------------------------------------------------------------------------
const SLOT_OPTIONS = [
  { value: 'any', label: '任意' },
  { value: 'background', label: '背景' },
  { value: 'subject', label: '主体' },
  { value: 'shard', label: '碎片' },
];
// ---------------------------------------------------------------------------
// 手势分区
// ---------------------------------------------------------------------------
// ⚠️⚠️ 这里原来是 `renderGestureLead()` —— **0.9.130 随那句 lead 一起删了**
//   （用户点名）。而它必须**连函数一起删**，不能只删 HTML：
//   `document.getElementById('ges-lead').textContent = …` 对 null 赋值会抛，
//   而它在 `apply()` 里被调 ⟹ 后面所有开关都绑不上，症状是"点什么都没反应"。
//   ⚠️ 这个项目为这件事栽过一轮（见文件末尾 apply() 那段注释）。
//   ⟹ 判据：**删 DOM 元素时同步 grep 它的 id**，光删 HTML 是留一个定时炸弹。

// 录制选项：静态还是动态、几只手。
//
// 静态/动态是**用户的选择**，不是按动作名查表 —— AirCursor 那边一开始是硬编码的，
// 结果既拒绝了"用画圈打开某个功能"（适合动态的动作被强制静态），也在一个静止姿势
// 就够用的地方强加了做动作的步骤。有律的动作（挥动/倾斜）例外：它们的方向由律决定，
// 录制只是加一道"必须是这个手型"的门，所以固定静态。
// 往日志窗格追一行。这是**唯一活得够久**的显示位置 —— `#live` 每帧被 sensor 状态覆盖。
function logLine(source, message) {
  // ⚠️ 音频/壁纸的日志也写到**音源旁边**那一格。
  //
  // 原来只有「手势录制」页签底部有 #log，而音频的输出（FFT 自检、
  // swiftc 编译失败、丢帧报告）都往那里去 ⟹ 用户在「我的壁纸」页签里找不到它。
  // 而我还告诉他"在创意工坊的诊断那块"—— 也是错的。
  //
  // ⟹ 音频的东西要在音频旁边。两处都写（手势页签那个是全量日志，
  // 这个只收 audio/we/wall 的）。
  if (source === 'audio' || source === 'we' || source === 'wall') {
    const box = document.getElementById('audio-log');
    if (box) {
      const line = `[${source}] ${message}`;
      // ⚠️⚠️ **从 15 行提到 60**（0.9.67）。
      // 用户报"没看到你说的那一行"，而我先怀疑是极光的 bug ——
      // 真相是这一格**只留最后 15 行**，而 FFT 自检一次就占 6 行、
      // `[we] 资源文件不在` 又刷了 4 行 ⟹ aurora 的自检被挤掉了。
      // ⟹ **那是观测通道自己的缺陷**：我让用户去看一个会被冲掉的地方。
      // ⚠️ 这个项目在"日志被刷掉/看不到"上栽过两次（一次是只进 stdout、
      //   一次是重复消息刷屏把真问题埋了）—— 都是同一类：
      //   **观测通道不可靠时，所有基于它的结论都不可靠。**
      box.textContent = `${box.textContent}${box.textContent ? '\n' : ''}${line}`
        .split('\n').slice(-60).join('\n');
      box.scrollTop = box.scrollHeight;
    }
  }
  const node = document.getElementById('log');
  if (!node) return;
  const line = `[${source}] ${message}`;
  node.textContent = `${node.textContent}${node.textContent ? '\n' : ''}${line}`
    .split('\n').slice(-40).join('\n');
  node.scrollTop = node.scrollHeight;
}

function recordOptions(action) {
  const stored = (config.recordOptions && config.recordOptions[action.id]) || {};
  return {
    // 默认静态（录得快），动态用户自己选。**有律的也给选** —— 见 templates.js 里
    // `law` 的注释：律只说明默认怎么触发，不该锁死怎么录。
    kind: stored.kind || 'static',
    hands: stored.hands || 1,
  };
}

// 诊断:录关键点 + 投递层健康。
//
// 这一段是补入口 —— 三个能力(startCapture / revealCaptures / pointerHealth)之前
// preload、主进程、sensor 三层都接好了,面板零入口,而我还报告说"接进面板了"。三层各自
// 都对,整条链没有入口 ⟹ 功能等于不存在,而所有测试全绿。逮到它的是一条机械反查守卫。
function wireDiagnostics() {
  const capture = document.getElementById('capture-start');
  const reveal = document.getElementById('revealCaptures');
  const state = document.getElementById('capture-state');

  capture.onclick = async () => {
    const result = await window.gw.startCapture();
    // 失败最常见的原因是摄像头没开,所以直接把原因显示出来而不是只说"失败"。
    state.textContent = result.ok
      ? '正在录制 5 秒:把手放进画面,做几个平时会用的动作'
      : `无法录制:${result.reason || '未知原因'}`;
    state.className = result.ok ? 'state ok' : 'state warn';
  };
  reveal.onclick = () => window.gw.revealCaptures();

  document.getElementById('grantAccessibility').onclick = () => window.gw.openAccessibility();
  document.getElementById('grantCamera').onclick = () => window.gw.openCameraSettings();
  // ⚠️ grantMic / grantSpeech / onVoiceStatus 0.9.106 随语音功能一起删了。
  //   ⚠️⚠️ 而这里有个这个项目栽过的坑：**元素删了 bind/onclick 留着会抛**
  //     （`document.getElementById(...)` 返回 null，`.onclick =` 直接 TypeError，
  //      把 apply() 整个打断 ⟹ 后面所有开关都绑不上）。所以 HTML 和这里必须同时删。

  // 骨架几何:三层尺寸 + 端到端映射。不一致时直接说"画布在被缩放",而不是让人去猜。
  window.gw.onOverlayGeometry((g) => {
    const node = document.getElementById('overlay-geom');
    if (!node || !g) return;
    const m = g.mapped || [];
    const corners = m.map((p) => `${p.at} ${p.x},${p.y}`).join(' · ');
    node.textContent = g.consistent
      ? `骨架几何：正常 · 逻辑 ${g.logical.w}x${g.logical.h} · dpr ${g.dpr} · ${corners}`
      : `骨架几何：⚠️ 画布被缩放显示：缓冲 ${g.buffer.w}x${g.buffer.h} / CSS ${g.css.w}x${g.css.h} / 逻辑 ${g.logical.w}x${g.logical.h}`;
    node.className = g.consistent ? 'state ok' : 'state warn';
  });

  // 骨架层/helper 的报错。只留最近 40 行 —— 它的用途是"刚才出了什么事",不是日志归档。
  window.gw.onHelperLog((entry) => {
    if (!entry) return;
    logLine(entry.source || '?', entry.message);
  });

  window.gw.onCaptureSaved((payload) => {
    if (!payload || payload.error) {
      state.textContent = `保存失败:${payload && payload.error}`;
      state.className = 'state warn';
      return;
    }
    // 报**有手的帧数**而不只是总帧数:一个 0 帧有手的文件看起来存成功了,而它对标定
    // 完全没用 —— 那是"看起来成功"的一种。
    const ok = payload.withHands > 0;
    state.textContent = ok
      ? `已存 ${payload.frames} 帧（其中 ${payload.withHands} 帧有手）`
      : `存了 ${payload.frames} 帧但一帧手都没有：这份没法用来标定,重录一次`;
    state.className = ok ? 'state ok' : 'state warn';
  });
}

// 投递层健康。trusted 单独显示:没授权时 sent 照常增长(CGEvent.post 静默丢弃),
// 只看 sent 会以为一切正常。
function renderPointerHealth(health) {
  const node = document.getElementById('pointer-health');
  const grants = document.getElementById('grant-row');
  if (!node || !health) return;
  // 授权按钮只在真缺的时候出现:常显一个"去授权"会让已经授权的人以为还有事没做。
  if (grants) grants.hidden = health.trusted !== false;
  if (health.trusted === false) {
    node.textContent = '点击通道：无辅助功能授权：手势能识别，但鼠标事件被系统静默丢弃';
    node.className = 'state warn';
    return;
  }
  if (health.state !== 'running') {
    node.textContent = `点击通道：${health.state}${health.detail ? ' · ' + health.detail : ''}`;
    node.className = 'state warn';
    return;
  }
  node.textContent = `点击通道：正常 · 已发 ${health.sent}${health.failed ? ` · 失败 ${health.failed}` : ''}`;
  node.className = 'state ok';
}

function renderRecordables() {
  stopAllPreviews();
  // ⚠️ 第二个参数（includePro）恒传 true —— 0.9.106 起没有"档"这个概念了，
  //   所有动作都在 basic 里。留着这个参数是因为 actionsOf 还有别的调用方。
  const grouped = T.groupedActions(config.template, true);
  // ⚠️⚠️ **只渲染系统动作**（0.9.130）。用户 2026-08-02：
  //   「壁纸动作那些都删掉，只保留系统动作」
  //
  // ⚠️ 这里原来还有一行 `renderActionGroup('recordables', grouped.wall…)` ——
  //   那 8 个动作驱动的是我们自己的三层景深壁纸，而产品重心早就是
  //   "放 Wallpaper Engine 的壁纸"了 ⟹ 它们服务一个用户基本不用的形态。
  // ⚠️ `grouped.wall` 那半边现在没人用了，但 `groupedActions` **保持不动** ——
  //   它是 templates.js 的公开函数、有测试，而"没人用某个返回字段"
  //   不是删它的理由（删了以后想加回壁纸动作要重写）。
  renderActionGroup('systemActions', grouped.system.filter((a) => a.recordable));
}

function renderActionGroup(hostId, actions) {
  const host = document.getElementById(hostId);
  if (!host) return;
  host.innerHTML = '';
  const t = T.template(config.template);
  if (!actions.length) {
    // ⚠️ 这里原来要分辨"真的没有可录制动作"和"进阶模式没开"两种空 ——
    //   0.9.106 那个开关删了（所有动作无条件开放）⟹ 只剩前一种。
    host.append(el('p', 'hint', '这套模板没有需要录制的动作'));
    return;
  }
  for (const action of actions) {
    const recorded = config.recorded && config.recorded[action.id];
    const options = recordOptions(action);
    const row = el('div', 'rec');

    // ---- 左：名字、提示、状态、进度条 ----
    const info = el('div');
    const name = el('span', 'nm', action.label);
    if (t.actions.pro.includes(action.id)) name.append(el('span', 'tier pro', '进阶'));
    info.append(name);
    info.append(el('span', 'hint2', action.hint));

    const state = el('div', 'state');
    if (recordingAction === action.id) {
      state.textContent = '准备中…';
      state.className = 'state ok';
    } else if (recorded) {
      // ⚠️ 读存下来的 `dynamic` 字段，不是靠 keyframeData 的长度猜。
      //
      // 猜的后果：**有律的动态动作不产生 keyframes**（recorder.js 里 `s.dynamic && !s.law`
      // 才建关键帧序列，有律的走律），于是录了动态却显示"静态"。用户报「我点击的动态
      // 动作，录制过程看起来很顺畅，但是怎么显示已录制·静态」—— 录制是对的，显示在说谎。
      //
      // 而"界面主动说谎"在这个项目里已经有过一次代价（识别行显示了手势名但动作不发生，
      // 因为显示和触发用了两个时间尺度）。存了什么就显示什么。
      const kind = recorded.dynamic ? '动态' : '静态';
      // `!== false`：这个字段是后加的，存量录制没有它，缺字段当成"开着"。
      const on = recorded.enabled !== false;
      state.textContent = `${on ? '已录制' : '已关闭'} · ${kind} · ${recorded.hands} 只手`
        + (recorded.keyframes ? ` · ${recorded.keyframes} 关键帧` : '')
        + (recorded.dynamic && recorded.law ? ` · 按${recorded.law === 'swipe' ? '挥动' : '倾斜'}判方向` : '');
      // 关掉的用灰色（默认 state），不用 ok 的绿色 —— 一眼扫过去要能看出哪些在用。
      state.className = on ? 'state ok' : 'state';
    } else if (action.kind === 'continuous') {
      // 连续动作不录也能用（内置的捏合/移动映射），所以"未录制"不是缺陷状态。
      state.textContent = '未录制（在用内置映射，录一个手型可以当开关）';
      state.className = 'state';
    } else {
      state.textContent = action.law ? '未录制（有内置判定，录了更准）' : '未录制';
      state.className = 'state';
    }
    info.append(state);

    const bar = el('div', 'bar');
    const fill = el('i');
    fill.dataset.action = action.id;
    bar.append(fill);
    info.append(bar);
    row.append(info);

    // ---- 中：预览 ----
    row.append(buildPreview(action, recorded));

    // ---- 右：选项 + 按钮 ----
    const right = el('div');
    // 系统动作先给一个"试一下"：确认这个动作在这台机器上能用，再花时间录手势。
    if (action.system) {
      const test = el('button', 'act', '试一下');
      test.onclick = async () => {
        test.textContent = '…';
        const r = await window.gw.testSystemAction(action.id);
        test.textContent = r && r.ok ? '✅ 能用' : '❌ 失败';
        setTimeout(() => { test.textContent = '试一下'; }, 1800);
      };
      right.append(test);
    }
    const opts = el('div', 'opts');
    {
      const kindSelect = document.createElement('select');
      for (const [value, label] of [['static', '静态姿势'], ['dynamic', '动态动作']]) {
        const node = document.createElement('option');
        node.value = value;
        node.textContent = label;
        if (value === options.kind) node.selected = true;
        kindSelect.append(node);
      }
      kindSelect.onchange = () => window.gw.setConfig({
        recordOptions: {
          ...(config.recordOptions || {}),
          [action.id]: { ...options, kind: kindSelect.value },
        },
      });
      opts.append(kindSelect);
    }
    const handsSelect = document.createElement('select');
    for (const [value, label] of [[1, '单手'], [2, '双手']]) {
      const node = document.createElement('option');
      node.value = String(value);
      node.textContent = label;
      if (value === options.hands) node.selected = true;
      handsSelect.append(node);
    }
    handsSelect.onchange = () => window.gw.setConfig({
      recordOptions: {
        ...(config.recordOptions || {}),
        [action.id]: { ...options, hands: Number(handsSelect.value) },
      },
    });
    opts.append(handsSelect);
    right.append(opts);

    const buttons = el('div');
    buttons.style.marginTop = '6px';
    if (recordingAction === action.id) {
      const stop = el('button', 'act danger', '取消');
      stop.onclick = () => window.gw.cancelRecording();
      buttons.append(stop);
    } else {
      const rec = el('button', 'act primary', recorded ? '重录' : '录制');
      rec.disabled = !config.gestures.enabled || !!recordingAction;
      rec.onclick = () => window.gw.startRecording(action.id);
      buttons.append(rec);
      if (recorded) {
        // 单个手势的开关。放在「重录」旁边，因为"先关掉它试试"和"重录一个"是同一个
        // 处境下的两个选择 —— 手势串了的时候。
        const on = recorded.enabled !== false;
        const toggle = el('button', on ? 'act' : 'act primary', on ? '关闭' : '启用');
        toggle.onclick = async () => {
          const r = await window.gw.toggleRecording(action.id, !on);
          // 启用可能被冲突拒绝。不显示的话就是"点了没反应" —— 这个项目里最难查的症状。
          if (r && !r.ok && r.conflictWith) {
            const label = T.ACTIONS[r.conflictWith] ? T.ACTIONS[r.conflictWith].label : r.conflictWith;
            const state = row.querySelector('.state');
            if (state) {
              state.textContent = `打不开：和「${label}」太像（距离 ${r.distance}，至少要 ${r.need}）`;
              state.className = 'state warn';
            }
            logLine('面板', `打不开「${action.label}」：和「${label}」太像（${r.distance}/${r.need}）`
              + '。两个手势里得清除或重录一个');
          } else if (r && !r.ok) {
            logLine('面板', `开关失败：${r.error || '未知原因'}`);
          }
        };
        buttons.append(toggle);

        const clear = el('button', 'act danger', '清除');
        clear.onclick = () => window.gw.clearRecording(action.id);
        buttons.append(clear);
      }
      // 回退:有上一版才出现。常显一个大部分时候没用的按钮会训练人忽略它,而它恰好是
      // 录坏了唯一的退路 —— 没有它,唯一能知道新录的好不好的办法是留下它,而如果更差
      // 旧的已经没了,于是人根本不敢重录。
      if (config.recordUndo && action.id in config.recordUndo) {
        const undo = el('button', 'act', '回退');
        undo.title = config.recordUndo[action.id] ? '回到上一次录的那个手势' : '回到未录制状态';
        undo.onclick = async () => {
          const result = await window.gw.undoRecording(action.id);
          // 说清落到哪个状态:光说"已回退"你不知道现在手上是旧手势还是没有。回退成功后
          // 主进程会广播 config,面板整体重画,所以这里只在失败时留一行。
          if (!result.ok) {
            state.textContent = `回退失败:${result.reason || '未知原因'}`;
            state.className = 'state warn';
          }
        };
        buttons.append(undo);
      }
    }
    right.append(buttons);
    row.append(right);

    host.append(row);
  }
  if (!config.gestures.enabled) {
    host.append(el('p', 'hint warn', '先开启摄像头手势才能录制'));
  }
}

// ---------------------------------------------------------------------------
// 预览
//
// 为什么它是精华：录完之后，用户唯一的验证手段本来是"摆一遍看有没有反应"，而那把
// "录错了"和"匹配没过"混成同一个症状。画出来就一眼看出录的是不是自己想的那个。
// ---------------------------------------------------------------------------
const previewLoops = new Map();

function stopPreview(action) {
  const handle = previewLoops.get(action);
  if (handle) cancelAnimationFrame(handle);
  previewLoops.delete(action);
}

function stopAllPreviews() {
  for (const action of [...previewLoops.keys()]) stopPreview(action);
}

// 把一个模板画到 canvas 上。
function drawTemplate(canvas, template, { tiltDeg = 0, accent = '#6cc7ff' } = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const hands = P.templatePoints(template);

  // 双手比单手宽，所以框跟着内容变。**先加 class 再量尺寸** —— class 决定
  // clientWidth，反过来的话第一次绘制会把双手姿势塞进单手的框里。
  canvas.classList.toggle('is-wide', !!hands && hands.length > 1);

  const w = canvas.clientWidth || 60;
  const h = canvas.clientHeight || 76;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (!hands) {
    // 清空而不是塌掉：虚线空框就是"还没录"的样子，把 backing store 归零会让元素消失。
    canvas.classList.add('is-empty');
    return;
  }
  canvas.classList.remove('is-empty');

  const { hands: placed } = P.layout(hands, w, h, tiltDeg);
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = accent;
  ctx.fillStyle = accent;
  for (const points of placed) {
    for (const line of P.HAND_LINES) {
      ctx.beginPath();
      line.forEach((id, i) => {
        const p = points[id];
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
    }
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// 动图：走完动作，停一下，重来。停顿段换颜色 —— "动作结束了"要看得见而不是靠数节拍。
function startPreviewLoop(action, canvas, keyframes) {
  stopPreview(action);
  if (!keyframes || keyframes.length < 2) return;
  let start = null;
  const tick = (nowMs) => {
    // 自己检查还在不在文档里：省掉每个调用点都要记得拆除。
    if (!canvas.isConnected) { previewLoops.delete(action); return; }
    if (start === null) start = nowMs;
    const frame = P.frameAt(keyframes, nowMs - start);
    if (frame) {
      drawTemplate(canvas, frame.template, { accent: frame.holding ? '#8affc1' : '#6cc7ff' });
    }
    previewLoops.set(action, requestAnimationFrame(tick));
  };
  previewLoops.set(action, requestAnimationFrame(tick));
}

function buildPreview(action, recorded) {
  const wrap = el('div', 'preview');
  const rest = document.createElement('canvas');
  wrap.append(rest);

  const keyframes = recorded && recorded.keyframeData;
  const dynamic = keyframes && keyframes.length > 1;

  if (dynamic) {
    wrap.append(el('span', 'arrow', '→'));
    const move = document.createElement('canvas');
    move.className = 'is-move';
    wrap.append(move);
    // 静止那格画起始姿势，动的那格放动图 —— 两格并排，因为"从哪开始"和"怎么动"
    // 是两个独立的问题，一个动图答不了第一个。
    drawTemplate(rest, keyframes[0].template);
    // 元素进 DOM 之后才能量到尺寸，所以动画在下一帧启动。
    requestAnimationFrame(() => startPreviewLoop(action.id, move, keyframes));
  } else if (recorded && recorded.template) {
    drawTemplate(rest, recorded.template);
    // 倾斜类：第二格画"动作实际到达的位置"，而不是让用户看一个角度数字自己想象。
    if (action.law === 'tilt' && recorded.trigger) {
      wrap.append(el('span', 'arrow', '→'));
      const tilted = document.createElement('canvas');
      tilted.className = 'is-move';
      wrap.append(tilted);
      requestAnimationFrame(() => drawTemplate(tilted, recorded.template, {
        tiltDeg: (config.gestureTuning && config.gestureTuning.tiltTriggerDeg) || 22,
        accent: '#8affc1',
      }));
    }
  } else {
    drawTemplate(rest, null);
  }
  return wrap;
}
// build 标识（版本 + commit + 是否打包）。
//
// ⚠️ 这个函数踩过两个坑，都是"改了但用户看不到"：
//
//   ① 第一版放进 `#launch`（开屏页）—— 那个页会 `.gone` 淡出 ⟹ 看不见。
//      用户报「没看到任何类似 v0.9.10 … 的字样」。现在在 nav 里，所有 tab 常驻。
//   ② 第一版在 `renderWEStatus()` 里赋值 —— 而那个函数**不一定在启动时跑**
//      （它跟着壁纸状态走）⟹ 没装载壁纸时标识是空的。
//      现在从 `apply()` 调，那是配置一到就跑的必然入口。
//
// ⟹ 一句话：**核对版本用的东西，不能依赖任何"恰好发生"的时机。**
// 而它对打包来回测试是刚需 —— 测了旧版本会得出"改了没生效"的假结论。
// ⚠️ 是不是打包版。**没有 `window.gw.isPackaged`** —— 面板拿不到 app.isPackaged，
// 而 `weStatus().build` 里有现成的（main.js 的 buildStamp 拼的
// `v0.9.76 <commit> 打包版` / `… npm start`）。
// ⟹ 用它，不新加一条 IPC（那是第二份知识）。
// ⚠️ 存缓存而不是每次 await —— 这个判断在渲染函数里同步用。
let packagedBuild = null;

function isPackagedBuild() {
  return packagedBuild === true;
}

// ⚠️⚠️⚠️ **版本标识不再显示在界面上**（0.9.121）。用户 2026-08-02：
//   「右上角这句话也删掉 v0.9.119 a910ffa 打包版」
//
// ⚠️ 而**这个函数留着** —— 它有一件不可见但承重的活：
//   从 build 标识里解析出「是不是打包版」（`packagedBuild`），
//   而 `isPackagedBuild()` 决定鼠标诊断那段说哪句话
//   （打包版说"去系统设置找 GestureWallMouse"，开发模式说"要打包成 .app"）。
//   ⟹ 只删 DOM 那两行，数据流照旧。
//
// ⚠️⚠️ 而它原来存在的理由是真的：**打包版没有终端，那是唯一能确认"我跑的是
//   哪一版"的地方**，而这个项目为"测了旧版本"栽过两次（改了没生效 → 去查一个
//   已经修好的问题）。用户 0.9.54 那次点名要求它常驻可见。
//   ⟹ 现在它移到**诊断报告里**（`report.build`，一直都有）——
//     那是"要发给别人看"的场合，也正是需要版本号的场合。
//   ⚠️ 判据：删一个观测点之前，先确认那件事**别处还看得到**。
async function renderBuildStamp() {
  try {
    const status = await window.gw.weStatus();
    // ⚠️ 这一句是这个函数现在唯一的产出 —— 给 renderMouseDiag 用。
    if (status && typeof status.build === 'string') {
      packagedBuild = status.build.includes('打包版');
    }
  } catch {
    // ⚠️ 拿不到就保持 null（"不知道"），别当成 false ——
    //   `isPackagedBuild()` 判的是 `=== true`，所以 null 会走"开发模式"那支说明，
    //   而那在真打包版上是错的话。⟹ 宁可两句都不说，也不说错的那句。
  }
}

function renderToggles() {
  // ⚠️ 元素不在就跳过，而且**说出来**。
  //
  // 实测烧的一轮：收缩成两个页签时删掉了 music / showHud / moodFromCover 三个开关，
  // 但这里的 bind 调用留着 ⟹ `node.checked` 对 null 抛 TypeError。
  //
  // 后果和它的样子完全不成比例：renderToggles 是 apply() 的第三步，它一抛，
  // **后面所有初始化都不跑**（我的壁纸目录列表、鼠标转发勾选、筛选初始状态…）。
  // 用户看到的是「某个功能没反应」，而根因是一个被删掉的 UI 元素。
  //
  // ⟹ 静默跳过是对的（HTML 就是不该有它了），但必须报一句 ——
  // 静默 no-op 会让「配置存了但界面不动」变成查不出的鬼故事。
  const missing = [];
  const bind = (id, get_, set_) => {
    const node = document.getElementById(id);
    if (!node) { missing.push(id); return; }
    node.checked = get_();
    node.onchange = () => set_(node.checked);
  };
  bind('gestures', () => config.gestures.enabled, (v) => window.gw.setGestures(v));
  // ⚠️ proTier 那个绑定 0.9.106 删了（开关本身也删了 —— 见 dashboard.html）。
  bind('showHands', () => config.showHands, (v) => window.gw.setConfig({ showHands: v }));
  // 手控制真鼠标。默认关,而且这不是保守:一开摄像头就抢走鼠标,用户会没法用鼠标去把它
  // 关掉 —— 那是个能把自己锁在外面的开关。
  bind('controlCursor', () => !!config.controlCursor,
    (v) => window.gw.setConfig({ controlCursor: v }));
  // 语音走专用通道而不是 setConfig:开关要同时启停 helper,而 setConfig 只写配置。
  // ⚠️ bind('voice', …) 0.9.106 删了（语音整条撤掉）。
  // ⚠️ 这里曾经还有三个 bind:music / moodFromCover / showHud。
  //
  // 收缩成两个页签时那三个开关的 HTML 元素被删了,而 bind 调用留着 ⟹
  // `node.checked` 对 null 抛 TypeError,把 apply() 整个打断。
  // ⟹ 删掉它们(元素本来就不该回来);上面的 missing 报告负责逮住下一次同类漏删。
  if (missing.length) {
    console.warn(`[dashboard] 这些开关的 HTML 元素不在了,已跳过:${missing.join(', ')}`
      + '：要么补回元素,要么删掉这里的 bind 调用');
  }
}

// ---------------------------------------------------------------------------
// 渲染入口
// ---------------------------------------------------------------------------
let built = false;

function apply(next) {
  config = next;
  // ⚠️ 产品形态收缩之后这里只剩两块:创意工坊 + 手势。
  //
  // 删掉的是模板(三层景深的参数)、图库、壁纸与音乐 —— 那三个 tab 连同它们的
  // renderLayers / renderSlots / renderPresets / renderGallery / renderStrategy 一起走了。
  // 三层景深的**渲染**还在(它是 WE 壁纸未装载时的底),只是不再暴露参数。
  renderBuildStamp();
  // ⚠️ renderGestureLead() 0.9.130 删了（那句 lead 撤了）—— 见它原来的位置。
  renderRecordables();
  renderToggles();
  cursorToggle.checked = !!config.controlCursor;
  renderAudioSource();
  renderWEStrategy();
  renderMineDirs();
  mouseForwardBox.checked = !!(config.we && config.we.mouseForward);
  mouseGateBox.checked = !!(config.we && config.we.mouseGateFinder);
  if (!built) {
    renderSliders('gestureTuning', GESTURE_TUNING);
    // 只接一次:按钮的 onclick 每次 apply 都重设是幂等的,但 onCaptureSaved 是订阅,
    // 重复订阅会让一次保存报好几遍。
    wireDiagnostics();
    refreshPointerHealth();
    built = true;
  }
  if (!config.gestures.enabled) {
    document.getElementById('live').textContent = '手势未开启';
  }

  // ⚠️⚠️ **启动时渲染当前页签**（0.9.58）。用户 2026-08-01：
  //   「每次打开的时候，我的壁纸这里是空白，要过一阵，并且我自己点一下
  //     才会出来东西，这是咋回事」
  //
  // 根因：`renderMine()` **只挂在页签切换的 onclick 上**（dashboard.js:203）。
  // 而 0.9.54 把「我的壁纸」改成了**默认页签** ⟹ 打开面板时那个 onclick
  // 从来没触发过 ⟹ 网格是空的，要点一次别的页签再点回来才出来。
  //
  // ⚠️ `apply` 里原来只调 `renderMineDirs()`（画目录行，**不重扫磁盘**）——
  // 所以目录路径出来了、网格没有 ⟹ 看起来像"加载很慢"而不是"没触发"。
  //
  // ⟹ 判据：**默认页签也是"切到"了** —— 初次显示和点击切换应该走同一条路。
  // ⚠️ 只在 `!built` 时做（第一次 apply）—— 主进程每次改配置都会广播 apply，
  //   每次都重扫磁盘的话，调一个参数就触发一次全盘扫描。
  if (!bootRendered) {
    bootRendered = true;
    const active = document.querySelector('nav button[data-tab].on');
    if (active) renderTab(active.dataset.tab);
  }
}

// 投递层健康:启动查一次,之后主进程状态变了会推过来。轮询会掩盖"从来没查过"这种情形,
// 所以是"一次 + 推送"而不是定时。
function refreshPointerHealth() {
  window.gw.pointerHealth().then(renderPointerHealth).catch(() => {});
}
window.gw.onPointerHealth(renderPointerHealth);

window.gw.onConfig(apply);
// 壁纸层策略仍然由主进程广播（⌃⇧L 能换），只是面板不再展示它 ——
// 那个 UI 在「壁纸与音乐」里，而那个 tab 已经砍掉。记下来是因为 renderWEStrategy
// 还在用 `strategy` 这个变量（创意工坊那页要显示当前壁纸层）。
window.gw.onStrategy((s) => { strategy = s; renderWEStrategy(); });

window.gw.onSensorStatus((s) => {
  document.getElementById('live').textContent = s && s.text ? s.text : '-';
  // 摄像头被拒时也把授权按钮露出来 —— 和辅助功能同一个道理:说了缺什么就得给路径。
  if (s && s.denied) {
    const grants = document.getElementById('grant-row');
    if (grants) grants.hidden = false;
  }

  // 心跳。停了要**主动变红**，因为"没有日志"和"一切正常"在面板上长得一模一样。
  if (s && s.heartbeat) {
    const h = s.heartbeat;
    const node = document.getElementById('heartbeat');
    if (node) {
      // 摄像头帧数和推理帧数分开显示：它们背离的那一刻就指明了是哪一层停的。
      // 摄像头涨、推理不涨 = 卡在推理；两个都不涨 = 摄像头或整层没了。
      node.textContent = `心跳：${h.stalled ? '⚠️ 推理停了' : `${h.fps}/s`}`
        + ` · 推理累计 ${h.frames} 帧 · 摄像头 ${h.cameraFrames} 帧`
        + (h.errors ? ` · 判定异常 ${h.errors} 次` : '')
        + (h.busy ? ' · 上一帧还在推理' : '');
      node.className = h.stalled ? 'state warn' : 'state ok';
    }
    // 停摆要进日志窗格：面板那一格会被下一次心跳覆盖，而"什么时候停的"要留痕。
    if (h.stalled) logLine('骨架层', `推理停了（累计 ${h.frames} 帧，摄像头 ${h.cameraFrames} 帧）`);
  }

  // 异常的堆栈进日志窗格。这一层没有开发者工具，不转出来就只剩"某个功能不工作"。
  if (s && s.error) logLine('骨架层', s.error.split('\n').slice(0, 3).join(' / '));

  // 匹配诊断。每个录过的动作一行：离触发多远、为什么没触发。
  //
  // 报**距离和门限两个数**，不是"匹配/不匹配"：差 0.01 和差 10 倍指向完全不同的处理
  // （再摆准一点 vs 这个模板录坏了重录），而一个布尔值把它们压成同一句话。
  if (s && s.probe) {
    const node = document.getElementById('match-probe');
    if (node) {
      const lines = s.probe.map((p) => {
        if (!p.action) return p.why;                       // "手不在画面里" 这类
        const d = p.distance !== undefined
          ? ` · 距离 ${p.distance} / 门 ${p.threshold}${p.distance < p.threshold ? ' ✓' : ''}`
          : '';
        // 动态手势多报两样：走到第几步，以及"离上一个关键帧多远"。
        //
        // 后者是中点规则的另一半：推进要求离下一帧**比离上一帧近**，所以 `0.31→0.24`
        // （在往前走）和 `0.31→0.09`（还黏在上一帧）是完全不同的处境，而只看 toNext
        // 两者一模一样。
        const step = p.steps ? ` · 第 ${p.step}/${p.steps} 步` : '';
        const back = p.fromPrev !== undefined ? ` · 离上一步 ${p.fromPrev}` : '';
        // 重新武装的进度。「第一次好触发、后面很难」的那个状态就在这里 —— 手够近所以
        // 不算离开、但已经触发过，于是看起来没反应。报出"离开了多久 / 要多久"。
        const rearm = p.reArm !== undefined && !p.armed
          ? ` · 松开门 ${p.reArm}${p.awayMs ? `（已离开 ${p.awayMs}ms）` : ''}`
          : '';
        return `${p.action}${step}${d}${back}${rearm} · ${p.why}`;
      });
      node.textContent = `手势匹配：\n${lines.join('\n')}`;
      // 有任何一个够近就转绿 —— 那说明手势这侧是通的，问题在下游（执行/绑定）。
      node.className = s.probe.some((p) => p.distance !== undefined && p.distance < p.threshold)
        ? 'state ok' : 'state';
    }
  }
});

window.gw.onGesture((g) => {
  if (!g) return;
  const detail = g.value !== undefined ? ` ${(g.value * 100).toFixed(0)}%`
    : g.x !== undefined ? ` ${(g.x * 100).toFixed(0)},${(g.y * 100).toFixed(0)}`
    : '';
  const node = document.getElementById('live');
  const first = node.textContent.split('\n')[0];
  node.textContent = `${first}\n最近事件：${g.action}${detail}`;
});

// 录制进度：只更新那一条的文字和进度条，不重建整个列表 —— 重建会让按钮在点击的
// 瞬间被替换掉。
window.gw.onRecordingProgress((p) => {
  if (!p) return;
  recordingAction = p.action;
  const fill = document.querySelector(`.bar i[data-action="${p.action}"]`);
  if (fill) fill.style.width = `${Math.round((p.progress || 0) * 100)}%`;
  const row = fill && fill.closest('.rec');
  const state = row && row.querySelector('.state');
  if (state) {
    const phase = { countdown: '倒计时', capture: '保持不动', ready: '准备做动作', move: '录动作' }[p.phase] || p.phase;
    // 做动作时把**实测幅度和需要的幅度**显示出来。
    //
    // 之前只有一句"做动作，做完停住"，于是用户做完了、它判定幅度不足、录制退出 ——
    // 而全程没有任何东西告诉他幅度不够。「看着像是意外中断」就是这么来的：失败的原因
    // 在失败之前是可知的，只是没人显示它。
    const extent = p.extent !== undefined && p.extentNeeded !== undefined
      ? ` · 幅度 ${p.extent}/${p.extentNeeded}${p.extent >= p.extentNeeded ? ' ✓' : ''}`
      : '';
    state.textContent = p.countdown
      ? `${phase} ${p.countdown}`
      : `${phase}：${p.hint || ''}${extent}`;
    state.className = 'state ok';
  }
});

window.gw.onRecordingResult((r) => {
  recordingAction = null;
  const node = document.getElementById('live');
  let text;
  if (r && r.ok) text = `✅ ${r.action} 录制成功`;
  else if (r && r.conflictWith) {
    // 报出**要多远才够**，不只是"太像了" —— 后者读不出该改多少。
    // 而如果撞上的那个手势当时是关着的，必须说清楚：否则用户会去找一个自己看不见
    // 在用的东西，而"我明明把它关了"和"它还在挡我"看起来是矛盾的。
    const label = T.ACTIONS[r.conflictWith] ? T.ACTIONS[r.conflictWith].label : r.conflictWith;
    text = `❌ 和「${label}」的手势太像（距离 ${r.distance}，至少要 ${r.need ?? '?'}）`
      + (r.otherDisabled ? '。那个手势现在是关着的，但关掉不代表可以撞：'
        + '重新打开它的时候两个就串了。要么把它清除，要么换一个差别更大的手势'
        : '，换一个差别更大的');
  } else if (r) text = `❌ ${r.error || '录制失败'}`;
  if (text) {
    node.textContent = text;
    // ⚠️ 也写进日志窗格。`#live` 每帧都被 sensor 状态覆盖（~30/s），所以录制失败的
    // 原因写在那里等于**闪一下就没了** —— 用户看到的就只是"录制突然退出了"，而错误
    // 信息其实是有的。
    //
    // 「看着像意外中断」这句描述之所以出现，就是因为唯一说明原因的那行字活不过 33ms。
    // 日志窗格留 40 行，是这个信息该去的地方。
    logLine('录制', text);
  }
  renderRecordables();
});
// ---------------------------------------------------------------------------
// 控制鼠标键盘 + 录原始关键点
// ---------------------------------------------------------------------------
//
// ⚠️ 这两块的主进程、preload、sensor 三层在合并时都接好了，唯独**面板上没有入口** ——
// 整条链齐了但用户点不到，功能等于不存在，而所有测试全绿。这是本项目反复出现的
// 那个形状（未读的 config 字段、没导入的 spawnSync、默认空的录制页）的又一次。
// 现在 gating 里有条守卫按"preload 暴露了什么"反查"面板用了没有"。

const cursorToggle = document.getElementById('controlCursor');
const pointerHealthNode = document.getElementById('pointer-health');

cursorToggle.onchange = () => window.gw.setConfig({ controlCursor: cursorToggle.checked });

function renderPointerHealth(health) {
  if (!health) { pointerHealthNode.textContent = '-'; return; }
  // ⚠️ trusted 是最要紧的一位：false 意味着后面所有 sent 都被系统丢掉了，
  // 而 sent 那个数字照常增长 —— 只看 sent 会以为一切正常。这正是 AirCursor
  // 烧掉四轮的那件事（缺权限时 CGEvent.post 静默丢弃）。
  if (health.trusted === false) {
    pointerHealthNode.innerHTML =
      '<span class="warn">没有辅助功能权限：手势移动光标会被系统静默丢弃</span>\n'
      + '去「系统设置 → 隐私与安全性 → 辅助功能」勾上本应用';
    return;
  }
  const parts = ['✅ 点击通道正常'];
  if (Number.isFinite(health.sent)) parts.push(`已投递 ${health.sent}`);
  // failed 和"没权限"是两回事，分开报。
  if (health.failed) parts.push(`⚠️ 失败 ${health.failed}`);
  if (health.exits) parts.push(`helper 重启 ${health.exits} 次`);
  pointerHealthNode.textContent = parts.join(' · ');
}

if (window.gw.onPointerHealth) window.gw.onPointerHealth(renderPointerHealth);
if (window.gw.pointerHealth) window.gw.pointerHealth().then(renderPointerHealth).catch(() => {});

const captureState = document.getElementById('capture-state');

document.getElementById('capture-start').onclick = async () => {
  captureState.textContent = '正在录 5 秒：就做平时会做的动作，别刻意摆姿势。';
  const result = await window.gw.startCapture();
  // ⚠️ 主进程返回的是 {ok:false, reason:…} 不是 error。读错字段只会显示兜底文案，
  // 而"摄像头没开"恰恰是最常见的失败原因。
  if (result && result.ok === false) {
    captureState.innerHTML = `<span class="warn">${result.reason || result.error || '起不来'}</span>`;
  }
};

// ⚠️ 合并时的 id 分歧:WE 分支那半用 `capture-reveal`,而保留下来的 HTML 里是
// `revealCaptures`(那一段本来就有自己的绑定,见 renderDiagnostics)。
// 这一行是重复绑定 + 用了不存在的 id ⟹ getElementById 返回 null 然后崩。删掉。

window.gw.onCaptureSaved((payload) => {
  if (!payload) return;
  // 写盘失败也走这个通道。不接的话录完什么都不显示，用户会去找一个不存在的文件。
  if (payload.error) {
    captureState.innerHTML = `<span class="warn">存盘失败：${payload.error}</span>`;
    return;
  }
  const { file, frames, withHands } = payload;
  // ⚠️ 报"有手的帧数"而不只是总帧数：0 帧有手也会存出一个看起来成功的文件
  // （有大小、能打开），而它完全没用。这个区别必须说出来。
  const rate = frames ? Math.round(withHands / frames * 100) : 0;
  captureState.innerHTML = rate === 0
    ? `<span class="warn">录完了，但 ${frames} 帧里一帧都没检测到手</span>\n`
      + '摄像头开了吗？手在画面里吗？这个文件没有用，重录一次。'
    : `✅ 存好了：${withHands}/${frames} 帧有手（${rate}%）\n${file}`;
});




// ---------------------------------------------------------------------------
// WE 网页壁纸
// ---------------------------------------------------------------------------

// ⚠️⚠️ 这里原来是 `renderAudioSimple()`（0.9.44 的「让壁纸跟着音乐动」开关）
// —— 0.9.50 整个删了。用户：「这是什么，这应该是默认的，不需要给选项」
//
// 采集的条件本来就是 `weProject.wantsAudio && audioSource !== 'off'`
//（main.js:3790）—— 壁纸自己声明要音频才采集，而默认值已经是 `system`。
// ⟹ 那个开关问的是一个用户不需要做的决定。
// 开发者选项里那五个音源按钮留着（诊断用），见 AUDIO_SOURCES。

const AUDIO_SOURCES = [
  { id: 'netease', label: '网易云', hint: '只抓网易云的声音（需 macOS 14.4+，要屏幕录制授权）' },
  { id: 'system', label: '全系统', hint: '整台机器的输出，要屏幕录制授权' },
  // ⚠️ 合成测试音：**不需要任何授权**，纯代码产生频谱。
  //
  // 它的用途是把「壁纸能不能画音频可视化」和「我们能不能拿到系统音频」拆开 ——
  // 用户从"圆环没有"查了好几轮，而那两件事的症状完全一样。
  // 选它之后圆环动了 ⟹ 壁纸侧正常，剩下的纯粹是授权问题。
  { id: 'synth', label: '测试音（免授权）', hint: '合成频谱，用来确认壁纸能不能画音频可视化' },
  // ⚠️ 诊断用：每 2 秒只让一段有值，看画面上哪根柱子动。
  // 那是画面和数据矛盾时唯一能定位的办法。
  { id: 'sweep', label: '单段扫描（诊断）', hint: '每 2 秒只让一段有值，看哪根柱子动' },
  // ⚠️ 诊断用：每 2 秒只让一段有值，看画面上哪根柱子动。
  // 那是"画面和数据矛盾"时唯一能定位的办法。
  { id: 'sweep', label: '单段扫描（诊断）', hint: '每 2 秒只让一段有值，看哪根柱子动' },
  { id: 'off', label: '关闭', hint: '不抓音频，壁纸走它自己的空闲动画' },
];

// 当前装载的壁纸要不要音频。
//
// ⚠️ 用模块级变量而不是参数：`renderAudioSource` 有三个调用点（apply / 切音源 /
// 装载壁纸后），全都改签名容易漏一个，而漏掉的那个会让提示语消失 ——
// 那是"有时候提示、有时候不提示"，比一直不提示更难查。
let weWantsAudio = false;

function renderAudioSource() {
  const host = document.getElementById('we-audio-source');
  if (!host) return;
  const current = (config.we && config.we.audioSource) || 'off';
  host.className = 'we-src';
  host.innerHTML = '';
  for (const source of AUDIO_SOURCES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = source.id === current ? 'on' : '';
    button.textContent = source.label;
    button.title = source.hint;
    button.onclick = async () => {
      await window.gw.weSetAudioSource(source.id);
      renderWEStatus();
    };
    host.appendChild(button);
  }

  // ⚠️ 装载了「要音频」的壁纸而音源是关，必须**主动说**。
  //
  // 实测：用户装载「完美壁纸」，山景背景出来了，但那个音频圆圈完全不动。
  // 而 project.json 里 `supportsaudioprocessing: true` ⟹ 我们**知道**它要音频，
  // 也知道音源是 'off'（默认值）—— 却什么都没说。
  //
  // ⟹ 那让用户去查一个不存在的 bug。而真相是"没开音源"，
  // 加上"开了也要打包才有屏幕录制授权"这层，不主动讲清就一定会被当成坏了。
  const note = document.getElementById('we-audio-note');
  if (note) {
    if (weWantsAudio && current === 'off') {
      note.innerHTML = '⚠️ <b>这个壁纸要音频</b>（project.json 里 '
        + '<code>supportsaudioprocessing: true</code>），而音源现在是「关」'
        + ' ⟹ 它的音频可视化部分（频谱圆环 / 跳动的柱子）不会动。'
        + '<br>那不是坏了。开音源要<b>屏幕录制</b>授权，而开发模式（<code>npm start</code>）'
        + '拿不到 ⟹ 这一项只能打包版验。';
      note.hidden = false;
    } else {
      note.hidden = true;
    }
  }
}

// 壁纸层策略选择。⚠️ 做成开关而不是我替用户定，因为那是个真取舍：
// 菜单栏区域有内容 vs 鼠标交互能用，两者在 macOS 上不可兼得。
const WE_STRATEGIES = [
  { id: 'desktop', label: '真壁纸层', hint: '菜单栏区域也有内容，但壁纸收不到鼠标' },
  { id: 'bottom-normal', label: '普通窗口压最底', hint: '能收鼠标，顶部 25px 是系统菜单栏' },
  { id: 'floating', label: '悬浮最上层', hint: '只用来验渲染，会盖住所有窗口' },
];

function renderWEStrategy() {
  const host = document.getElementById('we-strategy');
  if (!host) return;
  const current = (config.we && config.we.strategy) || 'bottom-normal';
  host.className = 'we-src';
  host.innerHTML = '';
  for (const s of WE_STRATEGIES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = s.id === current ? 'on' : '';
    button.textContent = s.label;
    button.title = s.hint;
    button.onclick = async () => {
      await window.gw.weSetStrategy(s.id);
      renderWEStatus();
    };
    host.appendChild(button);
  }
}

// 鼠标转发。⚠️ 这是"真壁纸层 + 鼠标交互"能同时成立的关键 ——
// 我原来做成了让用户在两者间选一个，而用户否掉了那个方案（他是对的）。
const mouseForwardBox = document.getElementById('mouseForward');
const mouseGateBox = document.getElementById('mouseGateFinder');
const mouseStateNode = document.getElementById('mouse-state');

mouseForwardBox.onchange = () =>
  window.gw.weSetMouseForward({ mouseForward: mouseForwardBox.checked });
mouseGateBox.onchange = () =>
  window.gw.weSetMouseForward({ mouseGateFinder: mouseGateBox.checked });

window.gw.onMouseStatus((status) => {
  if (!status) { mouseStateNode.textContent = '-'; return; }
  mouseStateNode.innerHTML = status.ok
    ? `✅ ${status.text}`
    : `<span class="warn">${status.text}</span>`;
});

// ⚠️ 这一段是"点了没反应"的分辨器。三种原因长得一样，而这里把它们拆开：
//   注入数 0        → helper 没抓到（转发没起来 / Finder 门挡住了）
//   注入了但页面 0  → 坐标算错，注到窗口外
//   mouse 有 pointer 无 → 事件族问题（壁纸监听 pointerdown 而我们注 mouseDown）
function renderMouseDiag(mouse) {
  if (!mouse) return '';
  const injected = mouse.injected || 0;
  const saw = mouse.pageSaw;
  if (!injected) {
    // ⚠️ 按可能性排序，而且第一条是实测确认过的原因（没授权）。
    // 原来这条写的是"转发没起来或者门挡住了"，而真因是第三种：
    // 监听建立了、门也开着、但没有辅助功能授权 ⟹ 回调一次都不触发。
    const trusted = mouse.status && mouse.status.trusted;
    if (trusted === false) {
      // ⚠️⚠️ **打包版和开发模式要说不同的话**（0.9.76）。
      //
      // 原来这条只讲开发模式（"要打包成 .app"）—— 而**打包版的用户看到的是
      // 同一句** ⟹ 他已经在用 .app 了，那句话对他毫无意义（甚至误导）。
      //
      // ⟹ 打包版：说清**授权之后要重开应用**。那是 macOS 的硬要求 ——
      //   `AXIsProcessTrustedWithOptions` 会弹框（0.9.76 加的），
      //   但用户在系统设置里勾选之后，**进程不会自动获得授权**，必须重启。
      //   不说这句的话用户会"授权了但还是不行"⟹ 以为是 bug。
      // ⚠️ 而**授权列表里显示的是 helper 的名字**（GestureWallMouse），
      //   不是 GestureWall —— TCC 按可执行文件记授权。不说这句他找不到那一项。
      // ⚠️⚠️ 判"是不是打包版"用的是 **build 标识里那三个字**，
      //   而不是 `window.gw.isPackaged`（**那个不存在** —— 我差点直接写上去，
      //   而它会静默 undefined ⟹ 打包版永远走到 else 那支，说"要打包成 .app"）。
      return '\n⚠️ 没有辅助功能授权：监听建立了但收不到任何事件。'
        + (isPackagedBuild()
          ? '\n\n应该已经弹过授权框了。如果错过了：'
            + '\n系统设置 → 隐私与安全性 → 辅助功能 → 找 GestureWallMouse 打开'
            + '\n\n⚠️ 勾选之后**要重开本应用**（⌃⇧Q 退出再打开）：'
            + '那是 macOS 的要求，授权对已经在跑的进程不生效。'
          : '\n开发模式（npm start）拿不到那个授权，要打包成 .app：npm run dist:mac');
    }
    return '\n⚠️ 一个鼠标事件都没转发进去。三种可能：'
      + '\n① 没有辅助功能授权（最常见）：上面那行状态会说'
      + '\n② 「只在桌面被聚焦时」那个开关开着'
      + '\n③ helper 没起来：看上面那行状态';
  }
  if (!saw) {
    return `\n⚠️ 已转发 ${injected} 个事件，但页面一个都没收到：`
      + `坐标可能算错了${mouse.lastEvent ? `（最近注入位置 ${mouse.lastEvent.x},${mouse.lastEvent.y}）` : ''}`;
  }
  const parts = [`已转发 ${injected}`];
  parts.push(`页面收到 mousedown ${saw.mousedown} / pointerdown ${saw.pointerdown} / click ${saw.click}`);
  // ⚠️⚠️ **第四种可能：事件全到了，但壁纸自己的条件不满足。**
  //
  // 用户 0.9.25 报「粒子壁纸的点击触发流星没生效」。查那个壁纸的代码：
  //   `pt = useCallback(We => Ee && K && Pe.current && Pe.current.triggerMeteorAt(…))`
  //   而它挂在 React 的 `onClick` 上
  // ⟹ `triggerMeteorAt` 前面有**两个前置条件 `Ee && K`**（混淆后追不到是什么，
  //    大概率是"某个开关属性"和"3D 场景 ref 就绪"）
  //
  // ⟹ 如果 click 计数 > 0 而画面没反应，那**不是转发的问题** ——
  //    事件到了、click 也合成了，是壁纸自己没往下走。
  //    那时该查的是**属性**（上面那行属性发送状态），而不是鼠标链。
  //
  // ⚠️ 不说清这一点的话，"click 有值"这个好消息会被读成"那还有什么问题"，
  // 而下一步该去哪查完全不明确。
  if (saw.click > 0) {
    parts.push('\n✅ click 已合成 ⟹ 鼠标链是通的。'
      + '若画面仍无反应，那是**壁纸自己的条件没满足**（比如某个开关属性没开、'
      + '或它的 3D 场景还没就绪）⟹ 去看上面那行「属性」状态，不是这里');
  }
  // ⚠️ 这条区分最关键：我们注入的是 mouseDown，而很多壁纸监听 pointerdown。
  // Chromium 通常会合成，但如果没合成，症状就是"点了没反应"而事件其实到了。
  if (saw.mousedown > 0 && saw.pointerdown === 0) {
    parts.push('\n⚠️ mousedown 到了但 pointerdown 没有：'
      + '这个壁纸监听的是 pointer 事件，而注入的 mouse 事件没被合成成 pointer。'
      + '这是个真问题，把这行发给我。');
  }
  return `\n${parts.join(' · ')}`;
}

// 状态分三层显示，因为它们代表不同的失败：
//   装载了没有 → 根本没选壁纸
//   ready 没有 → 页面加载了但里面的 JS 没跑起来（ES module 挂了就是这样）
//   音频不 ok  → 权限或没在放歌
// ⚠️ 这三种在画面上看起来都是"没反应"，分不开的话没法查。
// 属性发送状态那一行。
//
// ⚠️ 这是"圆环/粒子/时间显示为什么不出现"的**第一观测点**，而它以前完全不可见。
//
// 实测：用户报「圆环没有、也没交互」，面板只说"页面加载了但没报 ready" ——
// 而 ready 只是个显示信号（不阻塞任何功能），真正该问的是
// **那 100+ 项属性进去了吗**。这个壁纸的圆环、粒子、时间全由属性驱动
// （showCircle / visual_audio_model / particles_isParticles…），属性没进去它什么都不画。
//
// 而主进程原来把 `no-listener` 静默吞了 ⟹「壁纸没挂 listener」和「一切正常」
// 长得一模一样。
function propsLine(props) {
  if (!props) return '';
  if (props.state === '已送到') {
    return `\n✅ ${props.count} 项属性已送到壁纸`;
  }
  if (props.state === '这个壁纸没有可配置项') {
    return '\n这个壁纸没有可配置项（正常）';
  }
  if (props.state === '发不进去') {
    if (props.reason === 'no-listener') {
      return `\n<span class="warn">⚠️ 有 ${props.count} 项属性，但壁纸没挂`
        + ' wallpaperPropertyListener ⟹ 一项都没进去。'
        + '它的圆环/粒子/时间都靠属性驱动，所以画面会缺一大块。'
        + '常见原因：脚本在挂 listener 之前就抛了：⌃⇧D 看 Console 第一条报错</span>';
    }
    return `\n<span class="warn">⚠️ 属性发不进去：${props.reason}</span>`;
  }
  if (props.state === '发送中') {
    return `\n⏳ 正在发 ${props.count} 项属性…`;
  }
  return '';
}

async function renderWEStatus() {
  const status = await window.gw.weStatus();
  // ⚠️ 先记下"这个壁纸要不要音频"，再重渲染音源区 —— 那句提示依赖它。
  // 放在 `if (!node) return` **之前**：那个 return 是为了 we-state 容器不存在时
  // 早退，但音源提示和它没关系，卡在那里会让提示永远不出现。
  const wasWanting = weWantsAudio;
  weWantsAudio = !!status.wantsAudio;
  if (wasWanting !== weWantsAudio) renderAudioSource();
  const node = document.getElementById('we-state');
  if (!node) return;
  // 菜单栏那条缝：盖住了不用说，盖不住要说清"试了几次、还差多少"。
  // ⚠️ 那条缝是"看得见但查不到"的典型 —— 用户只能看到顶上有一条别的东西。
  // ⚠️ 带上触发原因（lastReason）：那是查因的线索。
  // "因 blur 被夹"意味着点别的应用触发的，"因 resize"是尺寸变化触发的 ——
  // 两者指向不同的 macOS 行为。
  // ⚠️ 尺寸对不对、和菜单栏区域有没有内容，是**两件事**。
  //
  // 诊断报告证明过：窗口 1470×956 一像素不差，而用户仍然看到顶上那条带子 ——
  // 因为普通窗口画不到菜单栏那一层（系统的独立图层）。
  // 所以这里只在**尺寸真的不对**时报警，而"那条带子"用另一句话解释。
  const menuBarNote = status.menuBar && status.menuBar.sizeOk
    && !status.menuBar.coversMenuBar
    ? '\n顶部那 25px 是系统菜单栏画的（我们的窗口已经铺满整屏）：'
      + '想让那块也有内容就切「真壁纸层」，代价是壁纸收不到鼠标。'
    : '';
  const menuBar = menuBarNote || (status.menuBar && !status.menuBar.sizeOk && status.menuBar.gap
    ? `\n⚠️ 顶部菜单栏那条带子盖不住（推了 ${status.menuBar.pushes} 次，`
      + `还差 ${status.menuBar.gap.height || status.menuBar.gap.y}px，`
      + `最近因 ${status.menuBar.lastReason}）：macOS 把窗口夹进了可见区域。`
      + '⌃⇧L 切到 desktop 层能盖住，代价是鼠标交互失效。'
    : '');

  if (!status.dir) {
    // ⚠️ 这句原来是「未装载 —— 现在显示的是**三层景深壁纸**」，用户 2026-08-01 让删。
    //
    // 「三层景深」是我们内部对那个内置壁纸的叫法（`templates.js` 里的
    // "背景 + 主体 + 漂浮碎片"），而用户从没见过那个词 ⟹ 他读到的是
    // "现在显示的是某个我不知道的东西"，那比只说"未装载"更让人迷惑。
    //
    // ⟹ 只说事实：没装壁纸，现在是内置的那个。
    node.innerHTML = '还没装载壁纸：现在显示的是内置壁纸' + menuBar;
  } else if (status.error) {
    // ⚠️ 装载失败时**也要**带上壁纸窗口的报错和 scene 的步骤 ——
    //   "没装上"和"装上了但脚本挂了"经常同时发生，而只显示前者会漏掉真因。
    node.innerHTML = `<span class="warn">${status.error}</span>\n${status.dir}`
      + weErrorLines(status.weErrors)
      + sceneLines(status.scene);
  } else {
    node.innerHTML = `<b>${status.title}</b>\n${status.dir}\n`
      + (status.ready
        ? '✅ 壁纸里的脚本已经跑起来了'
        : '⏳ 页面加载了，但壁纸还没报 ready：如果一直这样，是里面的脚本没跑起来')
      + (status.wantsAudio ? '\n这个壁纸要音频' : '\n这个壁纸不需要音频')
      + propsLine(status.props)
      + weErrorLines(status.weErrors)
      + sceneLines(status.scene)
      + menuBar;
  }
  renderAudioStatus(status.audio);
  if (mouseStateNode && status.mouse) {
    const base = status.mouse.status
      ? (status.mouse.status.ok ? `✅ ${status.mouse.status.text}`
        : `<span class="warn">${status.mouse.status.text}</span>`)
      : '转发未启用（只有「真壁纸层」需要）';
    mouseStateNode.innerHTML = base + renderMouseDiag(status.mouse);
  }
  // ⚠️⚠️ 这里原来有 `await renderWEControls()` —— 0.9.61 撤了。
  // 用户 2026-08-01：「我的壁纸右侧的参数这个不应该是常驻，应该是我点击了
  // 壁纸之后才展示」
  //
  // 根因：`renderWEStatus` 在**每次壁纸状态变化**时跑（装载/卸载/属性推送/
  // 面板打开），而它无条件调 renderWEControls ⟹ 参数区自己就填满了，
  // 不管用户有没有点过卡片。
  // ⟹ 参数只由 `renderMineSide(item)` 在**点了卡片**时渲染（那里判 item.active）。
  // ⚠️ 而"点了卡片之后壁纸的属性又变了"这种情况：属性是我们推给壁纸的，
  //   面板这边的值不会被壁纸改回来 ⟹ 不需要跟着 status 刷。
}

// ⚠️⚠️⚠️ **壁纸窗口自己抛的异常**（0.9.159）
//
// 用户实测两次都撞在这条缝上：屏幕上刷「Uncaught ReferenceError: drawBars is not
// defined」，而「设置 → 开发者选项 → 壁纸状态」那一栏**什么都没有**。
//
// ⚠️ 因为那些报错走的是 `logEvent`（终端 + 诊断报告），而**打包版没有终端**
//   ⟹ 用户唯一能看的那一栏反而是空的。
// ⟹ 判据：**观测通道要通到"用户真的会去看的那个地方"** ——
//   进了日志不等于被看见。
function weErrorLines(errors) {
  if (!errors || !errors.length) return '';
  return `\n${errors.map((e) => `<span class="warn">❌ ${e}</span>`).join('\n')}`;
}

// ⚠️⚠️⚠️ **scene 类壁纸的装载读数**（0.9.159）
//
// 用户实测反馈：「你说的右上角诊断框我不知道在哪里」。
//
// ⚠️ 那个框在**壁纸窗口**里（`scene.html` 的 `#diag`），而壁纸铺在桌面最底层
//   ⟹ 桌面上有别的窗口挡着就看不见；
//   而**装载在送数据之前就崩的话它根本没机会显示**
//   （这次就是：主进程 ReferenceError，页面加载完了但一个字都没送）。
//
// ⟹ 判据：**探针不能只放在"要观测的那个东西"里面** ——
//   它挂了的时候探针跟着挂，而那正是最需要读数的时刻。
//   ⟹ 同一份读数也显示在**面板**上（用户一定能打开的地方）。
function sceneLines(scene) {
  if (!scene) return '';
  const out = [];
  // ⚠️ 错误排最前 —— 那是"为什么是黑的"的答案
  for (const e of scene.errors || []) out.push(`<span class="warn">❌ ${e}</span>`);
  for (const w of scene.warnings || []) out.push(`<span class="warn">⚠️ ${w}</span>`);
  // ⚠️ 只显示后 6 步 —— 全列会把状态行撑得很长，而失败总在最后几步
  const steps = (scene.steps || []).slice(-6);
  for (const st of steps) {
    out.push(`· ${st.name}${st.detail ? `：${st.detail}` : ''}（${st.ms}ms）`);
  }
  if (scene.willDraw) {
    const w = scene.willDraw;
    out.push(`⟹ 预计画：图层 ${w.image} · 文字 ${w.text} · 音频柱 ${w.audioBars}`);
  }
  if (scene.renderability) out.push(scene.renderability);
  return out.length ? `\n${out.join('\n')}` : '';
}

// 实际频谱值。⚠️ **这是"参数该调多少"的唯一依据。**
//
// 我为"幅度/形状不对"改了三轮参数，而从没看过那 128 个数长什么样 ——
// 每轮都从壁纸代码反推"应该是多少"，然后靠用户看截图判断。
// ⟹ 有了这一行，调参从"猜"变成"读数"。
function renderAudioFrame(frame) {
  const node = document.getElementById('we-audio-frame');
  if (!node || !frame) return;
  // ⚠️ 报三件事，每件都直接对应一个可能的问题：
  //   max        —— 顶天了没有（>1.5 说明 NORMALIZE 太大）
  //   low/high   —— 形状对不对（音乐应该低频远大于高频）
  //   逐段值      —— 具体哪一段不对
  const shape = frame.lowMean > frame.highMean * 1.5 ? '✅ 低频>高频（像音乐）'
    : (frame.highMean > frame.lowMean * 1.2
      ? '⚠️ 高频>低频：那不是音乐的形状，分箱或加权有问题'
      : '⚠️ 低高频差不多：大概是白噪声或者加权把差异抹平了');
  // ⚠️ 报出**这是哪个音源的数据**。
  //
  // 用户实测撞到：切到「单段扫描」后，状态行说"只有第 40 段有值"，
  // 而这一行显示的是真音频的形状 ⟹ 两行自相矛盾，他有理由以为两个源同时在发。
  // 真相是这一行**压根没更新**（我只在真采集路径里上报）。
  // ⟹ 带上 source，那样"没更新"会立刻暴露出来。
  const SRC_NAME = {
    system: '全系统', netease: '网易云', synth: '测试音', sweep: '单段扫描', off: '关闭',
  };
  const who = SRC_NAME[frame.source] || frame.source || '?';
  // ⚠️ 这里原来会算「NORMALIZE 该乘多少」——**那个参数已经不存在了**。
  //
  // 音频算法现在整套抄自 WE（linux-wallpaperengine 的逆向成果），
  // 没有"我调的参数"了 ⟹ 不该再有"帮你调参"的建议。
  //
  // 而值该长什么样是可以判断的：WE 的算法把动态压到 5 倍左右
  //（低频 ×0.351、高频 ×1.393 的加权），所以正常音乐下**每段都该有可见的值**。
  // ⟹ 报"形状对不对"，而不是"该调多少"。
  let advice = '';
  if ((frame.source === 'system' || frame.source === 'netease') && frame.max > 0.02) {
    const spread = frame.max / Math.max(0.01, frame.mean);
    if (frame.lowMean > frame.highMean * 4) {
      advice = '<br><span class="warn">⚠️ 低频比高频大 4 倍以上：'
        + 'WE 的频段加权本该把它压平（低频 ×0.351、高频 ×1.393）。'
        + '如果画面上一片长一片没有，说明加权没生效</span>';
    } else if (spread > 25) {
      advice = `<br><span class="warn">⚠️ 峰值是均值的 ${spread.toFixed(0)} 倍：`
        + '太尖了，正常音乐下 WE 的算法应该在 10 倍以内</span>';
    } else {
      advice = '<br>✅ 形状像 WE 的输出（动态压到位、低高频接近）';
    }
  }

  node.innerHTML = `<b>实际频谱</b>（${who}，每半秒刷新）`
    + `<br>最大 ${frame.max}　平均 ${frame.mean}`
    + `　${frame.max > 1.5 ? '<span class="warn">⚠️ 顶天了，NORMALIZE 要调小</span>'
      : (frame.max < 0.05 ? '<span class="warn">⚠️ 太小，NORMALIZE 要调大</span>' : '')}`
    // ⚠️ 段号改了：镜像下段 80-119 是 band 47..8（中低频），不是高频。
    // 现在按 **band** 取前半：低频 band 0-19、高频 band 44-63。
    + `<br>低频(band 0-19) ${frame.lowMean}　高频(band 44-63) ${frame.highMean}　${shape}`
    // ⚠️⚠️ 动态范围 —— 真 WE 预览图是 **4.4 倍**（大多数柱子 0.045、最长 0.20）。
    // 我们 0.9.14 只有 2.4 倍 ⟹ 太平 ⟹ 底被抬起来了（那和"太长"是同一件事）。
    // ⚠️⚠️ 输入电平 —— 判"柱子太长"是系统音量还是我们的实现。
    // 真 WE 预览图反解 magnitude 1.2-2.0，我们 2.8-12 ⟹ 差 12dB，
    // 而 12dB = 音量差 4 倍 ⟹ 完全可能是作者录预览图时音量小。
    + (frame.inputRMS !== undefined
      // ⚠️⚠️⚠️ **这一行现在是一条待验假设的判据，请用户转系统音量看它。**
      //
      // WE 抓的是 PulseAudio 的 `.monitor` 源 —— 那是 sink 的**输出流**，
      // **经过系统音量控制之后**的信号 ⟹ 音量 50% 则 monitor 信号也 50%。
      //
      // 而 macOS 的 ScreenCaptureKit `capturesAudio` 抓的是**应用的音频输出**，
      // 设计上**不受系统音量影响**（录屏时把系统静音也该有声音）。
      //
      // ⟹ 若为真：WE 那边音量小 ⟹ 柱子短；我们这边音量小 ⟹ 柱子照旧长
      //    ⟹ 那就是「整体都太长了」「太敏感」的根因，而它是**能从 WE 的行为
      //       推出来的差异**（不是我调系数）
      //
      // ⚠️ 线索：用户实测 RMS **−9.5 / −11.4 dBFS** —— 那是很大的电平。
      // 一般人听音乐时系统音量 30-50%，对应 −20..−30 dBFS
      // ⟹ 我们读到 −10 左右，像是**没经过音量衰减的原始流**。
      //
      // ⟹ **判法（不用改代码）：把系统音量从大调到小，看这个 RMS 变不变。**
      //    变了 ⟹ 受音量影响 ⟹ 这条假设错，别改
      //    不变 ⟹ 坐实 ⟹ 修法是把系统音量乘进去（CoreAudio 读得到）
      // ⚠️ 这里原来带一句「← 转一下系统音量，看这个数变不变」——
      // 那条假设**已经被用户实测坐实**（系统音量调到 0，柱子还在动）
      // ⟹ 提示撤掉，改成显示实际乘进去的音量。
      ? `<br>输入电平 RMS <b>${frame.inputRMS}</b>（${frame.inputDbfs} dBFS）`
        + (frame.systemVolume !== undefined
          ? `　系统音量 <b>${Math.round(frame.systemVolume * 100)}%</b>`
            + `${frame.systemVolume <= 0.001
              ? '（静音 ⟹ 柱子该完全不动，那是对的）'
              : ''}`
          : '')
        + `${frame.inputRMS > 0.25
          ? ' ⚠️ 音量很大 ⟹ 柱子长可能是音量，不是实现'
          : (frame.inputRMS > 0.02
            ? ' ✅ 正常听感音量 ⟹ 柱子长就是我们的实现偏大'
            : ' ⚠️ 几乎没有声音：是不是没在放歌')}`
      : '')
    // ⚠️ 帧节奏 —— 判"柱子突兀的长"是不是 push 模型的批大小抖动。
    // WE 是 pull 模型（渲染循环主动读）⟹ 节奏恒定；
    // 我们是 push（有多少发多少）⟹ 一次回调连发多帧时 movetowards 连做多次
    // 而时间没走 ⟹ 平滑速度漂，且前面那些帧被 PWCircle 的重绘覆盖 = 等效跳帧。
    // **孤峰**（比左右邻居高 30% 以上）—— 用户 0.9.16 报的「突兀的高、像噪点」。
    //
    // 为什么要报"在 60 帧里出现几次"而不只报位置：
    //   每帧都在同一段 ⟹ **结构性**问题（我们这一层的 bug）
    //   位置乱跳       ⟹ 音乐本身的瞬态（WE 也一样，不该改）
    // 那两个结论一个要改代码、一个不能改，而只看一帧分不出来。
    // ⚠️⚠️ **「圆环左侧能归零、右侧常驻」是可预期的，不是 bug。**
    //
    // 用户 0.9.18 的观察，算出来是这样（镜像布局下段→band 的映射）：
    //   圆环**右侧**（12点→3点→6点）= 段 90-127 + 0-30 = **band 0-37 = 低频**
    //   圆环**左侧**（6点→9点→12点）= 段 30-90        = **band 30-63 = 高频**
    //
    // ⟹ 「右侧常驻」= 低频常驻（鼓/贝斯几乎不断，且离 log10 地板远）
    //    「左侧能归零」= 高频归零（泛音时断时续，且贴着地板）
    // ⟹ 那是音乐能量分布 + log10 地板的必然，**WE 也一样**。
    //
    // ⚠️ 我曾据此怀疑"镜像布局是错的"（因为真 WE 预览图明显不对称，
    // 而镜像必然近似左右对称）—— 但用户同一轮实测「波浪壁纸展现更细腻了」
    // ⟹ 镜像 + 分声道的方向是对的 ⟹ 那个怀疑没有站住。
    + '<br><small>圆环右侧(12→3→6点)=低频 band 0-37，左侧(6→9→12点)=高频 band 30-63'
    + ' ⟹ 「右侧常驻、左侧能归零」是低频不断、高频贴地板，WE 也一样</small>'
    + (frame.spikeProfile
      ? `<br>孤峰：<b>${frame.spikeProfile.count}</b> 个（比邻居高 30%+）`
        + (frame.spikeProfile.top.length
          ? `　最常出现：${frame.spikeProfile.top.map(
            (t) => `第${t.seg}段(${t.n}/${frame.spikeProfile.frames}帧)`,
          ).join('　')}`
          : '')
        + `${frame.spikeProfile.sticky
          ? ' ⚠️ 固定在同几段 ⟹ 结构性问题，是我们这层'
          : ' ✅ 位置在变 ⟹ 音乐本身的瞬态（WE 也一样）'}`
      : '')
    + (frame.rhythm
      ? `<br>帧节奏：一次回调发多帧的比例 <b>${frame.rhythm.multiPct}%</b>`
        + `（最多 ${frame.rhythm.max} 帧）　每批采样 ${frame.rhythm.batchAvg}`
        + `（最大 ${frame.rhythm.batchMax}）`
        + `${frame.rhythm.multiPct < 2
          ? ' ✅ 节奏稳 ⟹ 突兀的柱子不是这个原因'
          : ' ⚠️ 连发多帧 ⟹ 平滑速度随批大小漂（那会让柱子忽长忽短）'}`
      : '')
    + (frame.dynRange !== undefined
      ? `<br>动态范围 <b>${frame.dynRange}</b> 倍（真 WE 预览图约 4.4 倍）`
        + `${frame.dynRange >= 3.5
          ? ' ✅ 有层次'
          : ' ⚠️ 太平：底被抬起来了，柱子会显得又长又齐'}`
        // ⚠️⚠️ **「柱子突兀的长」和「整体太长」是同一个根因** —— 算术如下：
        //
        // 相邻段隔 stride 2 = **94Hz**，而音乐里相邻 94Hz 的能量差 2 倍是常态
        //（一个泛音峰的边缘）⟹ **WE 也是 stride 2，所以它一样有这种落差**。
        //
        // 差别只在幅度：真 WE 的 0.045 vs 0.02 = **8px vs 4px**（看不出）；
        // 我们的 0.736 vs 0.367 = **132px vs 66px**（一眼看出）。
        //
        // ⚠️ 而 PWCircle 自己的平滑（`w2 = waveArr[i]*0.75; w1 = max(arr[i], w2)`）
        // 是**时间**平滑（让柱子下落变慢），**不会让相邻柱子接近** ——
        // 所以"加空间平滑"是错的方向，那会把真实的频谱结构抹掉。
        + '<br><small>相邻段隔 94Hz（stride 2，WE 原值）⟹ 相邻柱子差 2 倍是音乐常态，'
        + 'WE 也一样。「突兀的长」和「整体太长」是同一个根因：幅度偏大把落差放大成像素。'
        + '⟹ 看上面那行 RMS 决定该不该降</small>'
      : '')
    // ⚠️ 按钟点报 —— 用户十几轮都在用钟表描述，而我一直报段号，
    // 两边说的不是同一种坐标，每次都要换算（而我换算错过好几次）。
    + (frame.clock ? `<br><b>按钟点</b>（你看到的位置）：<br>`
      + `<span style="font-family:ui-monospace;font-size:10px">`
      + frame.clock.map((c) => {
        const dead = c.peak < 0.05 ? ' ⚠️' : '';
        return `${c.h}点 ${c.mean}/${c.peak}${dead}`;
      }).join('　') + '</span>' : '')
    + `<br>最大值在第 <b>${frame.peakAt}</b> 段`
    // ⚠️ 尖刺 —— "很多个和周围高度差很大的柱子"的量化。
    // 用户报那是**共性问题**（两个壁纸都有）⟹ 只能来自我们发的数据。
    // 报出"哪几段跳变最大 + 它前后的值"，那能直接指出是哪些段不对。
    + (frame.spikes ? `<br>平均跳变 ${frame.avgJump}　最大跳变的段：`
      + frame.spikes.map((s) => `<b>[${s.i}]</b> ${s.prev}→${s.cur}`).join('　') : '')
    // ⚠️ 单段扫描时这个数应该跟着扫描段号走 —— 那是"扫描真的生效了"的直接证据。
    + `<br><span style="font-family:ui-monospace;font-size:10px">`
    + frame.samples.map((s) => (s.i === frame.peakAt
      ? `<b>[${s.i}] ${s.v}</b>` : `[${s.i}] ${s.v}`)).join('　')
    + '</span>'
    + advice;
  node.hidden = false;
}

function renderAudioStatus(audio) {
  const node = document.getElementById('we-audio-state');
  if (!node) return;
  if (!audio) {
    node.textContent = (config.we && config.we.audioSource === 'off')
      ? '音频已关闭' : '还没有音频状态';
    return;
  }
  node.innerHTML = audio.ok
    ? `✅ ${audio.text}`
    : `<span class="warn">${audio.text}</span>${audio.detail ? '\n' + audio.detail : ''}`;
}

// 控件从 project.json 自动生成 —— 不给每个壁纸手写一遍 UI。
// 这样支持的不是"这一个壁纸"，是任意 WE 网页壁纸。
// ⚠️⚠️ **右侧详情面板**（0.9.54）。用户 2026-08-01 给了 WE 的界面截图：
//   「右边那个就是你点击了哪个壁纸，他的预览图和参数信息」
//   +「装载加显示壁纸参数」
//
// 两页各一个（#mine-side / #we-side），内容不同但形状一致：
//   我的壁纸：预览 + 标题 + 类型/大小 + 操作 + **参数**（读 project.json）
//   创意工坊：预览 + 标题 + 类型/大小/订阅数 + 「下载」（还没下载，没有参数）
//
// ⚠️ 为什么不做成一个函数带 flag：那两边的数据字段不同（本地有 dir/active，
// 工坊有 subscriptions/author），塞进一个函数就是一串 if ⟹ 各写一个更清楚。
// ⚠️ 而**空态**要说清"点左边" —— 一个空白的右半屏看起来像坏了。

function renderMineSide(item) {
  // ⚠️⚠️ 0.9.62：藏的是**整块面板**（#mine-side），不是里面的 body。
  // 用户：「我想默认隐藏，只有我点击了壁纸…这时候再出来」
  // ⟹ 面板不占位时 .split 变单列（见 CSS 的 `:has()`），网格铺满全宽。
  // ⚠️ 原来那个 `#mine-side-empty`（"点左边任意一个壁纸…"）删了 ——
  //   面板不出现时没地方放它。
  const side = document.getElementById('mine-side');
  if (!side) return;

  // ⚠️⚠️ **AI 工坊开着时，右栅归它**（0.9.127）。用户点壁纸仍然会装载
  //   （那是他要的动作），但**参数面板不抢这一栅** —— 否则会出现
  //   "AI 对话和壁纸参数上下叠在同一栏"，而那正是我要避免的拥挤。
  // ⚠️ 参数还是照常渲染（下面那些 DOM 写入都在跑）⟹ 关掉 AI 之后
  //   直接就是最新那张壁纸的参数，不需要重新点一次。
  const aiBody = document.getElementById('ai-body');
  const aiOpen = aiBody && !aiBody.hidden;

  if (!item) {
    // ⚠️ 没选中壁纸时**只有 AI 也没开**才收起整栅
    if (!aiOpen) side.hidden = true;
    const body = document.getElementById('mine-side-body');
    if (body) body.hidden = true;
    return;
  }
  // ⚠️⚠️ **用户手动收起过就别顶开**（0.9.129）。
  //   参数照常渲染（下面那些 DOM 写入都在跑）—— 只是这一栅保持收着，
  //   等他点把手展开时看到的就是最新那张的参数。
  //   ⚠️ 不这么做的话"收起"只活到下一次点壁纸，而那种"我明明关了它又回来"
  //     是最让人烦的一类交互。
  side.hidden = sideCollapsed;
  const body = document.getElementById('mine-side-body');
  if (body) body.hidden = aiOpen;

  const img = document.getElementById('side-preview');
  if (item.preview) {
    img.src = item.preview;
    img.style.visibility = 'visible';
  } else {
    // ⚠️ visibility 而不是 display —— 留住位置，否则"没缩略图"会让下面的
    // 内容跳上来（而用户刚点了一下，那个跳动看起来像点错了）。
    img.removeAttribute('src');
    img.style.visibility = 'hidden';
  }

  document.getElementById('side-title').textContent = item.title || item.id || '(未命名)';

  // 类型 / 大小 / 状态。⚠️ 「暂不支持」要在这里也说 —— 用户点了才知道装不上
  // 的话，他会以为是坏了（而 0.9.53 定的措辞是「暂不支持」不是「放不了」）。
  const meta = [];
  if (item.type) meta.push(item.supported ? item.type : `${item.type} · 暂不支持`);
  if (item.sizeBytes) meta.push(W_FORMAT(item.sizeBytes));
  if (item.active) meta.push('正在放');
  const metaEl = document.getElementById('side-meta');
  metaEl.textContent = meta.join(' · ');
  if (!item.supported && item.refusal) {
    metaEl.innerHTML = `${meta.join(' · ')}\n<span class="warn">${item.refusal}</span>`;
  }

  // 操作：在 Finder 中打开 / 加入或移出播放列表。
  // ⚠️ **没有「装载」按钮** —— 点卡片就已经装载了（用户定的：「装载加显示壁纸参数」）
  //   ⟹ 再放一个按钮是同一个动作两个入口。
  // ⚠️ **也没有「删除」** —— 那是破坏性的，留在右键菜单里（要经过确认）。
  //   右侧面板是"看和调"，不该有一键删。
  const actions = document.getElementById('side-actions');
  actions.innerHTML = '';
  const openBtn = document.createElement('button');
  openBtn.className = 'act';
  openBtn.type = 'button';
  openBtn.textContent = '在 Finder 中打开';
  openBtn.onclick = () => window.gw.revealWallpaperDir(item.dir);
  actions.appendChild(openBtn);

  const list = ((config.we && config.we.rotate) || {}).list || [];
  const inList = list.includes(item.dir);
  const listBtn = document.createElement('button');
  listBtn.className = 'act';
  listBtn.type = 'button';
  listBtn.textContent = inList ? '从播放列表移出' : '加入播放列表';
  listBtn.onclick = () => {
    setRotate({ list: inList ? list.filter((d) => d !== item.dir) : [...list, item.dir] });
    renderMine();
    // ⚠️ 自己也要重渲染 —— 按钮文案要跟着变（"加入"↔"移出"），
    // 不刷的话用户点了看到文案没变，会以为没生效。
    renderMineSide({ ...item });
  };
  actions.appendChild(listBtn);

  // ⚠️⚠️ 参数只对**正在放的那个**有意义 —— `weControls()` 读的是当前装载的壁纸
  // （不是"某个目录的 project.json"）⟹ 点的不是当前那张时不能显示参数，
  // 否则显示的是**别的壁纸的参数**（而那是最难发现的一种错）。
  const head = document.getElementById('side-props-head');
  const host = document.getElementById('we-controls');
  if (item.active) {
    head.hidden = false;
    renderWEControls();
  } else {
    // 点了但还没装完（renderMine 会重跑并把 active 更新）⟹ 先清掉，别留上一张的
    head.hidden = true;
    if (host) host.innerHTML = '';
  }
}

// 工坊侧：还没下载 ⟹ 没有 project.json ⟹ 没有参数，只有详情 + 「下载」。
function renderWeSide(item) {
  const empty = document.getElementById('we-side-empty');
  const body = document.getElementById('we-side-body');
  if (!body) return;

  if (!item) {
    empty.hidden = false;
    body.hidden = true;
    return;
  }
  empty.hidden = true;
  body.hidden = false;

  const img = document.getElementById('wside-preview');
  if (item.preview) {
    img.src = item.preview;
    img.style.visibility = 'visible';
  } else {
    img.removeAttribute('src');
    img.style.visibility = 'hidden';
  }

  document.getElementById('wside-title').textContent = item.title || item.id || '(未命名)';

  const meta = [];
  if (item.type) meta.push(item.supported ? item.type : `${item.type} · 暂不支持`);
  if (item.sizeBytes) meta.push(W_FORMAT(item.sizeBytes));
  if (item.subscriptions) meta.push(`${item.subscriptions} 订阅`);
  document.getElementById('wside-meta').textContent = meta.join(' · ');
  // ⚠️ ID 那一行（0.9.57，用户点名「Wallpaper 壁纸 id:3775463674」）。
  // 它取代了原来那个 `#ws-id` 输入框 —— ID 是点卡片自动来的，用户不用手输，
  // 而他确实需要**看到并能复制**它（去 Steam 页面看、发给别人）。
  document.getElementById('wside-id').textContent = `Wallpaper 壁纸 id:${item.id}`;

  // 「下载」。⚠️ 点卡片**不直接下载** —— 几百 MB 的误点很贵。
  // ⟹ 下载是这个面板上一个明确的按钮，那是"贵操作要有明确动作"。
  const actions = document.getElementById('wside-actions');
  actions.innerHTML = '';
  const dl = document.createElement('button');
  dl.className = 'act primary';
  dl.type = 'button';
  // ⚠️ 文案就叫「下载」（0.9.57，用户点名）。原来是「下载这个壁纸」——
  // "这个壁纸"是多余的：按钮就在那个壁纸的详情下面，指代不会有歧义。
  dl.textContent = item.supported === false ? '仍然下载（暂不支持）' : '下载';
  dl.onclick = () => {
    // ⚠️⚠️ **直接下载**（0.9.57）。用户：「点击了下载这个壁纸（改成下载）
    // 并且也不用再弹一下这个预览图了，本身点击了创意工坊的壁纸不就已经
    // 展示了预览图了」
    //
    // 原来这里做的是：填 ID → 展开折叠区 → 点「看看是什么」→ 出一张预览卡片
    // → 用户再点那张卡片上的「下载并装载」。**四步，而且第一步之后
    // 屏幕上出现了第二张预览图**（右侧面板已经有一张了）。
    // ⟹ 现在一步：直接调 startDownload。
    // ⚠️ 进度和结果报到 `#wside-state`（就在按钮下面），不再报到折叠区里
    //   那个 `#ws-state` —— 那样用户得展开折叠区才看得到"下载到哪了"。
    startDownload(item.id, 'wside-state');
  };
  actions.appendChild(dl);

  const open = document.createElement('button');
  open.className = 'act';
  open.type = 'button';
  open.textContent = '在 Steam 打开';
  open.onclick = () => window.gw.openExternal(
    `https://steamcommunity.com/sharedfiles/filedetails/?id=${item.id}`);
  actions.appendChild(open);
}

async function renderWEControls() {
  const host = document.getElementById('we-controls');
  if (!host) return;
  const result = await window.gw.weControls();
  if (!result.ok || !result.controls.length) {
    // ⚠️ 0.9.54：这块现在在右侧详情面板里，而面板只在"有壁纸在放"时才显示
    // ⟹ 走到这里说明**那个壁纸自己没有可调参数**（很多 video 类就没有），
    //   不是"还没装载"。文案要说对，否则用户会去找一个不存在的装载步骤。
    host.innerHTML = '<span class="hint">这个壁纸没有可调的参数。</span>';
    return;
  }
  host.innerHTML = '';

  // 当前值（用户改过的优先）。渲染每一行要用。
  const values = {};
  for (const c of result.controls) {
    values[c.key] = c.key in result.overrides ? result.overrides[c.key] : c.value;
  }

  // ⚠️⚠️ 按 condition 过滤。**这是"看不到属性"的根因修复。**
  //
  // 用户报「没有看到你说的这些属性」，而他贴的面板输出里「音频样式」「音频方向」
  //「可视化音频」各出现**两次** —— 那是 PWCircle 和 PWLine 各有一套同名控件。
  //
  // 真实数据：`showCircle` 的 condition 是 `visual_audio_model.value == 1`，
  // `PWLineShow` 是 `== 2`。默认 1（圆环）⟹ PWLine 那 20 个本该隐藏。
  // 而我全都显示了 ⟹ 13 组重名 ⟹ 属性在，但埋在一堆同名项里找不到。
  //
  // 过滤后：165 → 67 个，重名从 13 组降到 1 组（实测数据）。
  // ⚠️ 过滤在**主进程**做（那边有 we-host.js，是 condition 求值的单一来源）——
  // 面板加载不了 we-host，而在这里重写一份求值就是第二份知识，
  // 那个形状我在本项目栽过（音源列表、支持类型列表）。
  const visible = result.controls.filter((c) => c.visible !== false);

  let lastWasGroup = false;
  for (const control of visible) {
    // 分组标题：project.json 里 type=text 的项。我原来把它们当装饰扔了，
    // 而作者用它们分段（「----------完美壁纸圆环(PWCircle)----------」）。
    if (control.type === 'group') {
      const h = document.createElement('div');
      h.className = 'we-group';
      h.textContent = control.label;
      host.appendChild(h);
      lastWasGroup = true;
      continue;
    }
    lastWasGroup = false;
    const value = values[control.key];
    const row = document.createElement('div');
    row.className = 'we-row';

    const label = document.createElement('label');
    label.textContent = control.label;
    row.appendChild(label);

    if (control.type === 'bool') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!value;
      input.onchange = async () => {
        await window.gw.weSetProperty(control.key, input.checked);
        // ⚠️ 改一个属性可能让别的控件出现/消失（condition 依赖它）——
        // 比如把 visual_audio_model 从"圆环"改成"直线"，整段控件都要换。
        renderWEControls();
      };
      row.appendChild(input);
      row.appendChild(document.createElement('span'));   // 占住第三列，别让网格错位
    } else if (control.type === 'combo') {
      const select = document.createElement('select');
      for (const option of control.options || []) {
        const el = document.createElement('option');
        el.value = String(option.value);
        el.textContent = option.label;
        if (String(option.value) === String(value)) el.selected = true;
        select.appendChild(el);
      }
      select.onchange = () => {
        // ⚠️ option 的 value 在 DOM 里一律是字符串，但壁纸的 combo 值可能是数字
        // （样本的 gridSize 是 120/160/320…）。原样发字符串过去，壁纸拿它当数字用
        // 会得到 NaN —— 而那是静默的。所以按原始类型还原。
        const original = (control.options || [])
          .find((o) => String(o.value) === select.value);
        window.gw.weSetProperty(control.key, original ? original.value : select.value);
      };
      row.appendChild(select);
      row.appendChild(document.createElement('span'));
    } else if (control.type === 'slider') {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = control.min;
      input.max = control.max;
      input.step = control.step;
      input.value = value;
      const readout = document.createElement('span');
      readout.className = 'val';
      readout.textContent = value;
      input.oninput = () => {
        readout.textContent = input.value;
        window.gw.weSetProperty(control.key, Number(input.value));
      };
      row.appendChild(input);
      row.appendChild(readout);
    } else {
      // color 之类：原样文本编辑。样本的 color 值是 "r g b" 空格分隔的 0..1，
      // 不是 hex —— 用 color picker 会需要来回转换，先给文本框。
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value === undefined ? '' : String(value);
      input.onchange = () => window.gw.weSetProperty(control.key, input.value);
      row.appendChild(input);
      row.appendChild(document.createElement('span'));
    }
    host.appendChild(row);
  }
}

// ⚠️⚠️ 这里原来是 `we-pick` / `we-clear` 两个按钮的绑定 ——
// HTML 里删了（0.9.37，用户说那两个操作冗余），绑定必须跟着删。
//
// ⚠️ 留着的后果不是"没反应"，是 **`null.onclick` 抛 TypeError**
// ⟹ 这个文件在那一行**中断** ⟹ 后面所有初始化都不跑。
//
// 这个项目为**同一个形状**栽过三次：
//   ① 收缩页签时删了三个开关的 HTML，而 `bind('music')` 等留着
//   ② 0.9.31 删「刷新/加目录」按钮时留了绑定（守卫当场逮到）
//   ③ 这次
// ⟹ 守卫（gating.test.js）查的就是"每个 getElementById 的 id 必须在 HTML 里存在"。
//
// ⚠️ `weClear` 那个 IPC **保留** —— 它现在被"点当前壁纸卡片"调
//（见 renderMine 里 `item.active` 那段）。preload 里的 `weClear` 也留着。
// 而 `wePick` 那条**没人调了** ⟹ 见下面那条注释。

// ---------------------------------------------------------------------------
// 创意工坊
// ---------------------------------------------------------------------------

const wsState = document.getElementById('ws-state');
// ⚠️ 当前这次下载的进度往哪写。startDownload 设，onWorkshopProgress 读。
// 两个入口：右侧面板的「下载」→ #wside-state；折叠区那条 → wsState。
let downloadInto = null;

// 用户名/密码/Guard 码改了就存。⚠️ 不做"保存"按钮：那会让人以为填完不点就没生效，
// 而下载失败时又多一个可疑原因。
for (const [id, key] of [['ws-user', 'username'], ['ws-pass', 'password'], ['ws-guard', 'guardCode']]) {
  document.getElementById(id).onchange = (e) => {
    window.gw.workshopSetSteam({ [key]: e.target.value || null });
  };
}

// 先看预览再决定装不装。
//
// ⚠️ 这一步是补一个产品缺口：我原来只做了"填 ID → 下载"，而那等于把命令行搬进 GUI。
// 工坊的本质是浏览，没有预览图就没法挑。而且类型在这里就能看到 ⟹ scene 类可以在
// 下载几百 MB 之前就说清"装了也只能看静态图"。
// ⚠️⚠️ 这里原来是 `peekCard` + `renderPeek()`（「看看是什么」的预览卡片）——
// 0.9.57 整个删了。用户 2026-08-01：「也不用再弹一下这个预览图了，
// 本身点击了创意工坊的壁纸不就已经展示了预览图了」
//
// 他说得对：右侧详情面板（renderWeSide）已经在显示预览图 + 标题 + 类型/大小/订阅数，
// 而 renderPeek 会在它**下面**再画一张 ⟹ 同一个壁纸两张预览图。
//
// ⚠️ 它里面那段"三种情况分开说类型"的逻辑（tag 标的 / 从文件名推的 / 什么都没有）
// **没有丢** —— 那是 0.9.x 的一个真教训（用户当时只能靠猜要不要下）。
// 它在 renderWeSide 里以更短的形式保留：类型 + 「暂不支持」+ refusal 理由。
// ⚠️ 而 `startDownload` 留着（真正干活的那个），只是入口从这张卡片
// 换成了右侧面板的「下载」按钮。

const W_FORMAT = (bytes) => {
  const n = Number(bytes) || 0;
  if (n <= 0) return '大小未知';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};


// ---------------------------------------------------------------------------
// 浏览创意工坊（仿 Steam 排版）
// ---------------------------------------------------------------------------
//
// ⚠️ 不支持的类型（scene / application）**不隐藏** —— 用户明确说过
// "虽然有些类型无法支持现在，但是预览图是可以看到的吧"。
// 隐藏它们会让人以为工坊里没东西；标出来才是诚实的。
// ⚠️ tags 初值由 meta.defaultTags 填（只勾「全年龄」）—— 不在这里写死，
// 因为默认值的依据在 workshop.js（唯一来源）。
// ⚠️⚠️ **默认排序必须和 SORT_ORDERS 的第一项一致**（0.9.118）。
//   用户 2026-08-02：「默认是订阅最多」。
//   ⚠️ 不写死 `'subscribed'` —— 从那张表读第一项，这样改顺序时这里自动跟上。
//     写死的话两处会错开，而症状是"UI 高亮着 A、结果是 B"
//     （用户 2026-08-01 报过一次同形状的：「近期热门一直显示选中状态」）。
// ⚠️ 初值写 'subscribed' 只是"第一帧之前"的占位 —— 真正的默认在下面
//   `renderBrowseMeta` 里从 `meta.sorts[0]` 取（那是主进程给的唯一来源）。
//   ⚠️ workshop.js 跑在**主进程**，面板拿不到它的常量 ⟹ 只能等 meta 到了再对齐。
const browse = { sort: 'subscribed', tags: [], page: 1, total: 0, perPage: 30 };

function renderBrowseControls(meta) {
  const sortHost = document.getElementById('br-sorts');
  sortHost.className = 'we-src';
  sortHost.innerHTML = '';
  // ⚠️⚠️ **把默认排序对齐到主进程那张表的第一项**（0.9.118）。
  //   用户 2026-08-02 要"默认订阅最多"，而顺序和默认值该是同一件事
  //   ⟹ 主进程改 `SORT_ORDERS` 的顺序，面板自动跟上，不用改两处。
  //   ⚠️ 只在"当前的 sort 不在表里"时对齐 —— 否则用户点过别的之后，
  //     每次重渲染都会把他的选择弹回默认（那种"选了自己变回去"很恼人）。
  if (Array.isArray(meta.sorts) && meta.sorts.length
      && !meta.sorts.some((s) => s.id === browse.sort)) {
    browse.sort = meta.sorts[0].id;
  }
  for (const s of meta.sorts) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = s.id === browse.sort ? 'on' : '';
    b.textContent = s.label;
    b.onclick = () => {
      browse.sort = s.id;
      browse.page = 1;
      // ⚠️⚠️ **必须重渲染这一排** —— 用户 2026-08-01 报：
      //   「你的几个标签及其热门 最新发布这些只有近期热门一直显示选中的状态，
      //     点其他的也能生效，但是 ui 的设计还是近期热门有个蓝框选中」
      //
      // 根因：`b.className = s.id === browse.sort ? 'on' : ''` 是在**渲染时**
      // 算的，而 onclick 只改了 browse.sort + 调 runBrowse()（那只重画网格）
      // ⟹ 按钮的 class 永远停在第一次渲染时的样子。
      // ⚠️ 下面筛选组那组 onclick **有** renderBrowseControls(meta)，所以标签的
      //   蓝框是对的 —— 同一个文件里两处写法不一致，而只有一处是坏的。
      renderBrowseControls(meta);
      runBrowse();
    };
    sortHost.appendChild(b);
  }

  // 四组筛选，按 meta.filterGroups 渲染 —— 加一组不用改这里。
  const host = document.getElementById('br-filters');
  host.innerHTML = '';
  for (const group of meta.filterGroups || []) {
    const row = document.createElement('div');
    row.className = 'br-group';

    const label = document.createElement('span');
    label.className = 'br-group-label';
    label.textContent = group.label;
    row.appendChild(label);

    const btns = document.createElement('div');
    btns.className = 'we-src';
    for (const t of group.tags) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = browse.tags.includes(t.id) ? 'on' : '';
      // ⚠️ 类型那组标出能不能跑 —— 那样点进去之前就知道，
      // 而不是筛出一屏全是"放不了"。
      // ⚠️ 「暂不支持」而不是「放不了」（0.9.53，用户点名）——
      // 「放不了」听起来像"坏了/不行"，而这是**我们还没做**（scene 类要另一套
      // 渲染管线）。措辞要说清是谁的限制，而且留出"以后会有"的余地。
      b.textContent = t.supported === false && group.id === 'type'
        ? `${t.label}（暂不支持）` : t.label;
      // ⚠️ 高分级那两项（13+/18+）给个提示，免得误点。
      // ⚠️ title 写「默认不勾」而不是描述内容 —— 和 label 用年龄段是同一个理由
      //（用户 0.9.53：「年龄这里应该是隐晦一些…写年龄吧」）。
      if (group.id === 'age' && !t.defaultOn) b.title = '默认不勾';
      b.onclick = () => {
        browse.tags = browse.tags.includes(t.id)
          ? browse.tags.filter((x) => x !== t.id) : [...browse.tags, t.id];
        browse.page = 1;
        renderBrowseControls(meta);
        runBrowse();
      };
      btns.appendChild(b);
    }
    row.appendChild(btns);
    host.appendChild(row);
  }
}

// 一张工坊卡片。仿 Steam：预览图 + 标题 + 类型 + 订阅数。
// ⚠️⚠️⚠️ **右键菜单** —— 用户 2026-08-01 提的：
//   「我理解这是精准删除，但是就不能设计成右键点击，然后有一个选项是
//     在资源管理器中打开，有一个是卸载吗」
//
// 他说得对，而且这解决了**两个**问题：
//
// ① 0.9.37 我把「卸载」做成了"点当前那张卡片" + 卡片上一行「点击卸载」
//    ⟹ 那是**把一个动作藏在另一个动作里**（左键既是装载又是卸载，看 active 状态）
//    ⟹ 而且要在卡片上常驻一行提示才不隐藏 ⟹ 界面又吵了
//
// ② 「打开目录」2026-07-31 被用户要求删掉（「不是每个壁纸都要显示一下目录的」）
//    —— 他说得对，那时它是**常驻按钮** × N 张卡片。
//    而右键菜单里它不占地方 ⟹ **需要时才出现**，那正是它该在的位置。
//
// ⟹ 判据：**常驻的东西要少，而不是功能要少。**
//
// ⚠️ 只有一个菜单实例（不是每张卡片一个）—— N 张卡片各挂一个 DOM
// 会在滚动时拖慢，而且关闭逻辑要写 N 遍。
let cardMenu = null;

function closeCardMenu() {
  if (cardMenu) { cardMenu.remove(); cardMenu = null; }
}

// ⚠️ 点别处/滚动/Esc 都要关 —— 漏一个的话菜单会"粘"在屏幕上，
// 而用户会以为界面卡住了。
document.addEventListener('click', closeCardMenu);
document.addEventListener('scroll', closeCardMenu, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCardMenu(); });

// items: [{ label, danger?, onClick }]，label 为 null 表示分隔线
function showCardMenu(x, y, items) {
  closeCardMenu();
  const menu = document.createElement('div');
  menu.className = 'card-menu';
  // ⚠️ 用 fixed + clientX/Y —— 卡片在可滚动容器里，用 absolute 会跟着内容跑
  menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:9999`;
  for (const it of items) {
    if (!it || !it.label) {
      const sep = document.createElement('div');
      sep.className = 'card-menu-sep';
      menu.appendChild(sep);
      continue;
    }
    const row = document.createElement('div');
    row.className = it.danger ? 'card-menu-item danger' : 'card-menu-item';
    row.textContent = it.label;
    row.onclick = (e) => {
      e.stopPropagation();
      closeCardMenu();
      it.onClick();
    };
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  // ⚠️ 贴边时要翻转，否则菜单会跑到屏幕外（右下角的卡片必然撞到）
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth) menu.style.left = `${window.innerWidth - r.width - 8}px`;
  if (r.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - r.height - 8}px`;
  cardMenu = menu;
}

function workshopCard(item, onPick, onMenu) {
  const card = document.createElement('div');
  card.className = 'ws-item';
  card.title = item.title || item.id;

  const img = document.createElement('img');
  if (item.preview) img.src = item.preview;
  // ⚠️ 预览图挂了不能让卡片塌掉 —— Steam 的 CDN 在国内常要代理，
  // 而"图没出来"和"这个壁纸有问题"是两件事。
  img.onerror = () => { img.style.display = 'none'; };
  card.appendChild(img);

  const nm = document.createElement('div');
  nm.className = 'nm';
  nm.textContent = item.title || item.id;
  card.appendChild(nm);

  const tp = document.createElement('div');
  tp.className = item.supported ? 'tp' : 'tp no';
  const parts = [];
  // ⚠️ 同上：「暂不支持」不是「放不了」。
  if (item.type) parts.push(item.supported ? item.type : `${item.type}·暂不支持`);
  else parts.push('类型未标');
  if (item.subscriptions) parts.push(`${item.subscriptions} 订阅`);
  if (item.sizeBytes) parts.push(W_FORMAT(item.sizeBytes));
  tp.textContent = parts.join(' · ');
  card.appendChild(tp);

  // ⚠️ 这里原来给每张卡片加了「📁 打开目录」——**去掉了**。
  //
  // 用户报（2026-07-31）：「不是每个壁纸都要显示一下目录的。就保留
  // 我的壁纸目录：/Users/moon/Documents/GestureWall/Wallpapers 这个就行」。
  //
  // 他说得对：**一个入口就够**。壁纸都在同一个目录树下，进去了就能看到全部 ——
  // 每张卡片一个按钮是把"一次操作"重复了 N 遍，而 N 张卡片上的 N 个按钮
  // 只会让界面吵。
  // ⟹ 打开目录的入口留在「存储目录」那块（每个根目录一个）。

  card.onclick = () => onPick(item);
  // ⚠️ 右键菜单是**可选的** —— 「浏览创意工坊」那边的卡片没有本地目录，
  // 也不该有「卸载」⟹ 不传 onMenu 就不挂。
  if (onMenu) {
    card.oncontextmenu = (e) => {
      e.preventDefault();
      // ⚠️ stopPropagation —— 否则冒泡到 document 的 click 监听把菜单立刻关掉
      e.stopPropagation();
      onMenu(item, e.clientX, e.clientY);
    };
  }
  return card;
}

// ⚠️⚠️ **搜索框兼容"贴 ID / 贴创意工坊链接"**（0.9.57）。
//
// 起因：0.9.57 删掉了折叠区里那个 ID 输入框 + 「看看是什么」按钮（用户点名，
// 它们在右侧详情面板下是冗余的）⟹ "别人发我一个壁纸 ID"这条路就没了 UI。
// ⟹ 用户拍的方案：搜索框里贴 ID/链接就直接出那个壁纸，不当关键词去搜。
// ⟹ 零新增控件，而那条路保留了。
//
// ⚠️ 这个正则是 workshop.js:22 `parseWorkshopId` 的**镜像** —— 那是主进程侧的
// 模块，面板拿不到。⟹ 这里只做"**看起来像不像**"的判断（要不要走 details 那条路），
// 真正的解析仍然由 `workshopDetails` → parseWorkshopId 做（唯一来源）。
// ⚠️ 所以这里宁可**松**一点：认错了最坏是 details 返回"认不出 ID"，
//   而认漏了就是用户贴了 ID 却被当关键词去搜（那会搜出一堆无关的）。
function looksLikeWorkshopId(text) {
  return /(?:[?&]id=|CommunityFilePage\/|^)\d{6,20}(?:[^\d]|$)/.test(String(text || '').trim());
}

async function runBrowse() {
  const state = document.getElementById('br-state');
  const grid = document.getElementById('br-grid');
  state.textContent = '查询中…';
  grid.innerHTML = '';

  // 贴了 ID/链接 ⟹ 直接查那一个，右侧出详情（不当关键词搜）
  const q = document.getElementById('br-q').value;
  if (looksLikeWorkshopId(q)) {
    const one = await window.gw.workshopDetails(q);
    if (!one.ok) {
      state.innerHTML = `<span class="warn">${one.error}</span>`
        + (one.hint ? `\n${one.hint}` : '');
      return;
    }
    if (!one.items.length) {
      state.textContent = '没查到这个 ID：它可能已经被作者删了';
      return;
    }
    // ⚠️ 也画到网格里（一张卡片）而不是只填右侧 —— 否则网格是空的，
    // 看起来像"搜索没结果"，而右侧那张详情会让人以为它是上一次点的残留。
    state.textContent = `按 ID 找到 1 个（贴的是 ${q.trim()}）`;
    grid.appendChild(workshopCard(one.items[0], (picked) => renderWeSide(picked)));
    renderWeSide(one.items[0]);
    document.getElementById('br-pager').style.display = 'none';
    return;
  }

  const result = await window.gw.workshopBrowse({
    query: document.getElementById('br-q').value,
    sort: browse.sort, tags: browse.tags,
    page: browse.page, perPage: browse.perPage,
  });

  if (!result.ok) {
    state.innerHTML = `<span class="warn">${result.error}</span>`
      + (result.hint ? `\n${result.hint}` : '');
    // 没 key 时把那块展开 —— 否则用户看到错误但找不到在哪配。
    if (result.needsKey) document.getElementById('br-key-box').open = true;
    document.getElementById('br-pager').style.display = 'none';
    return;
  }

  browse.total = result.total;
  // ⚠️ 空态要写「怎么办」而不是「没有」（0.9.45）。
  //
  // 学 Open Wallpaper Engine 的空态文案 —— 它是：
  //   "No wallpapers found for your search.
  //    Expand or reset the categories in the filter sidebar or try another search term."
  // 两句：①事实 ②**具体的下一步**（去哪儿、改什么）。
  //
  // 我们「我的壁纸」那条已经这么写了（还带一个"打开目录"按钮），
  // 但这条工坊的只有一句小字括号提示 ⟹ 对齐。
  // ⚠️ 用 innerHTML 而不是 textContent —— 要分行和强调。
  //    左边那支是模板串（没有 HTML），继续用 textContent 更安全，所以分开写。
  if (result.items.length) {
    state.textContent = `共 ${result.total} 个，第 ${browse.page} 页`;
  } else {
    const hasQuery = !!document.getElementById('br-q').value.trim();
    const hasTags = !!(browse.tags && browse.tags.length);
    const ways = [];
    if (hasQuery) ways.push('换个搜索词，或者清空搜索框看热门');
    if (hasTags) ways.push('把类型筛选去掉几个');
    if (browse.page > 1) ways.push('回到第 1 页');
    // ⚠️ 三个条件都不成立时（没搜索词、没筛选、第 1 页）说明是 Steam 那边
    // 真的没返回 —— 那时候给"换个搜索词"是**误导**，他没搜索词可换。
    if (!ways.length) ways.push('Steam 这次没返回结果，稍后再试一次');
    state.innerHTML = '没找到壁纸。\n'
      + `<span class="hint">可以试试：${ways.join('；')}</span>`;
  }

  for (const item of result.items) {
    grid.appendChild(workshopCard(item, (picked) => {
      // ⚠️⚠️ 点卡片 = **右侧详情面板出内容**（0.9.54），不直接下载 ——
      // 直接下几百 MB 会让误点变成很贵的操作。
      //
      // ⚠️ 原来是"填到「按 ID 装载」那栏 + renderPeek + scrollIntoView"——
      // 那三步现在只剩一步：右侧面板本来就在视野里，不用滚过去。
      // ⟹ `ws-id` 的填充挪到了「下载」按钮里（见 renderWeSide）——
      //   点卡片不该改那个输入框（用户可能正在手动贴另一个 ID）。
      renderWeSide(picked);
    }));
  }

  const pages = Math.ceil(result.total / browse.perPage) || 1;
  document.getElementById('br-pager').style.display = result.items.length ? 'flex' : 'none';
  document.getElementById('br-page').textContent = `${browse.page} / ${pages}`;
  document.getElementById('br-prev').disabled = browse.page <= 1;
  document.getElementById('br-next').disabled = browse.page >= pages;
}

document.getElementById('br-go').onclick = () => { browse.page = 1; runBrowse(); };
document.getElementById('br-q').onkeydown = (e) => {
  if (e.key === 'Enter') { browse.page = 1; runBrowse(); }
};
document.getElementById('br-prev').onclick = () => { browse.page -= 1; runBrowse(); };
document.getElementById('br-next').onclick = () => { browse.page += 1; runBrowse(); };
document.getElementById('br-key-save').onclick = async () => {
  await window.gw.workshopSetKey(document.getElementById('br-key').value.trim());
  document.getElementById('br-key').value = '';
  runBrowse();
};

// ⚠️ try 住：这是我加的初始化，它抛了不该影响手势那些开关。
try {
window.gw.workshopBrowseMeta().then((meta) => {
  if (!meta) return;
  // 默认只勾「全年龄」。⚠️ 浏览工坊时默认不该出现成人内容，
  // 而"默认全开让用户自己关"在这件事上是错的默认值。
  if (!browse.tags.length) browse.tags = meta.defaultTags || [];
  renderBrowseControls(meta);
  document.getElementById('br-key-hint').textContent = meta.keyHint;
  // ⚠️⚠️⚠️ **回填已存的凭证**（0.9.120）。用户 2026-08-02：
  //   「这个能不能缓存一下啊，我每次打开软件都要填一遍」
  //
  // ⚠️ 它**本来就存着**（`workshop-set-key` / `workshop-set-steam` 都 writeConfig）
  //   —— 问题是这边从来没读回来 ⟹ 输入框每次都是空的 ⟹ 看起来像没保存。
  //   ⟹ 判据：**能保存的字段就要能回填**，否则用户没法确认它存了没有，
  //     而"再填一遍"是他唯一能想到的办法。
  //
  // ⚠️ 用 `if (el && v)` 而不是无条件赋值：
  //   · 元素可能不在（HTML 改过而这里没跟上 ⟹ 对 null 赋值会抛，
  //     把后面的初始化全打断 —— 这个项目栽过）
  //   · 值为空时不覆盖 —— 否则会把用户**正在输入**的内容清掉
  //     （meta 是异步回来的，可能落在他打字之后）
  if (meta.steam) {
    const fill = (id, v) => {
      const el = document.getElementById(id);
      if (el && v) el.value = v;
    };
    fill('br-key', meta.steam.apiKey);
    fill('ws-user', meta.steam.username);
    fill('ws-pass', meta.steam.password);
    // ⚠️ Guard 码有意不回填 —— 它几十秒就过期，填一个过期的只会让登录
    //   失败得莫名其妙（主进程那边也没送它过来）。
  }
  if (!meta.hasKey) {
    document.getElementById('br-state').innerHTML =
      '<span class="hint">配了 API key 才能浏览（下面那块）。'
      + '不配也能用：贴工坊链接到下面「按 ID 装载」。</span>';
  } else {
    runBrowse();
  }
}).catch(() => {});
} catch (error) { console.error('[dashboard] 工坊浏览初始化失败：', error); }

// ---------------------------------------------------------------------------
// 我的壁纸
// ---------------------------------------------------------------------------
//
// 用户的原话："不知道从哪里得到的壁纸，反正只要在指定的壁纸存储目录中有的壁纸
// 就在这里" ⟹ 判据是目录里有 project.json，不是"我们下载过"。
async function renderMine() {
  const state = document.getElementById('mine-state');
  const grid = document.getElementById('mine-grid');
  const result = await window.gw.workshopLocal();
  // ⚠️ 存下扫描结果，给 renderMineDirs 用 —— 那是"目录到底扫了哪儿"的唯一来源。
  // 存下来而不是让它重扫：扫描要遍历磁盘，而它在每次增删目录后都会跑。
  lastScanned = result.scanned || null;

  // ⚠️⚠️ 计数并进**目录行**（0.9.50）。用户 2026-08-01：
  //   「我的壁纸目录：… / 打开 / 换目录… / 6 个壁纸，其中 4 个能跑
  //     这个应该一行，现在是两行」
  // 他说得对：那两行说的是同一件事（这个目录里有什么）。
  //
  // ⚠️ 必须在 renderMineDirs() **之前**赋值 —— 它读这个变量来画那一截。
  //   放后面的话第一次渲染没有计数，要等下一次刷新才出现。
  // ⚠️ 空列表那支（下面的 early return）**也要**设 —— 不设的话
  //   "0 个壁纸"会沿用上一次的计数，显示一个不存在的数字。
  lastMineCount = {
    total: (result.ok && result.items) ? result.items.length : 0,
    usable: (result.ok && result.items)
      ? result.items.filter((i) => i.supported).length : 0,
    truncated: !!result.truncated,
  };
  renderMineDirs();

  // ⚠️⚠️ **存下壁纸清单给轮播用**（0.9.49）。轮播的摘要行和弹窗要显示
  // 缩略图 + 标题 + "正在放哪个"，那些只有这份 items 里有（dir/preview/title/active）。
  // ⚠️ 存下来而不是让轮播自己再调一次 workshopLocal() —— 那要遍历磁盘，
  // 而且两次扫描之间的结果可能不一致（"正在放"的判断就会和网格打架）。
  lastWallpapers = (result.ok && result.items) ? result.items : [];
  // ⚠️⚠️ 右侧详情跟着**正在放的那张**走（0.9.54）。
  // 理由：这一版里"选中"和"正在放"是同一个概念（用户定的「装载加显示壁纸参数」）
  // ⟹ 列表每次刷新都要把右侧同步到 active 那张，否则：
  //   · 刚点了一个壁纸 → renderMine 重跑 → 右侧还是上一张的参数
  //   · 重开面板 → 桌面上在放着某个壁纸，而右侧是空的（看起来像没装载）
  // ⚠️⚠️ 0.9.62：**只在面板已经开着的时候**同步，不主动打开它。
  // 用户：「我想默认隐藏，只有我点击了壁纸…这时候再出来」
  //
  // ⚠️ 这里有个矛盾要解：桌面上通常**正放着**某个壁纸（上次装的会自动恢复）
  //   ⟹ 无条件同步到 active 那张的话，面板一打开右侧就出来了
  //   ⟹ "默认隐藏"根本不成立。
  // ⟹ 判据：**面板的开合由"点击"决定，内容由 active 决定。**
  //   · 面板关着（用户还没点过）⟹ 保持关着
  //   · 面板开着（用户点过了）⟹ 内容跟着 active 走，
  //     否则"点了一下 → renderMine 重跑 → 右侧还是上一张的参数"
  const sideOpen = !document.getElementById('mine-side')?.hidden;
  if (sideOpen) {
    // ⚠️ 没有 active 时传 null ⟹ 面板收起来（而不是留着上一次的内容，
    //   那会让人以为那张还在放）。
    renderMineSide(lastWallpapers.find((w) => w.active) || null);
  }
  // ⚠️ 必须在 lastWallpapers 赋值**之后**渲染 —— 原来 renderRotate() 在
  // `await workshopLocal()` 之前调，那时清单还是空的 ⟹ 摘要行永远显示"—"。
  renderRotate();

  if (!result.ok || !result.items.length) {
    grid.innerHTML = '';
    // ⚠️ 空列表时报出扫过哪些目录 —— 否则用户不知道我们找过哪儿，
    // 而他可能把壁纸放在别的地方。
    // ⚠️ "一个都没找到"是最需要"打开目录"的时刻 —— 用户要去里面放东西。
    // 只报路径让他自己去 Finder 粘贴，那是把最后一步留给了他。
    state.innerHTML = '一个壁纸都没找到。'
      + '<div class="bar-row" style="margin-top:6px">'
      + '<button class="act" id="mine-open-ours" type="button">打开我的壁纸目录</button>'
      + '<span class="hint">把壁纸放进去（每个壁纸一个子目录，里面要有 project.json）</span>'
      + '</div>'
      + '<div class="hint" style="margin-top:6px">扫过这些目录：\n'
      + (result.scannedRoots || []).join('\n') + '</div>';
    // ⚠️ innerHTML 重建了节点 ⟹ 每次都要重新绑（绑在旧节点上等于没绑）。
    const openOurs = document.getElementById('mine-open-ours');
    if (openOurs) {
      openOurs.onclick = async () => {
        // 不传路径 = 打开我们自己的目录（主进程会顺手建出来 + 放说明文件）。
        const out = await window.gw.revealWallpaperDir();
        if (!out.ok) state.innerHTML = `<span class="warn">${out.error}</span>`;
      };
    }
    return;
  }

  // ⚠️ mine-state 现在只用来报**异常**（换目录的提示、删除失败、一个都没找到）。
  //   正常情况下它是空的 —— 计数搬到目录行了，状态行不该在没事时还占一行。
  state.textContent = '';

  // ⚠️⚠️⚠️ **正在放的那张不在列表里 ⟹ 必须说出来**（0.9.133）。
  //   用户 2026-08-02：「我点击进以后会自动运行一张壁纸，这张壁纸我不知道
  //   为啥会自动运行，而且我看那里也没有显示正在播放的壁纸」
  //
  // ⚠️ 那不是"它乱放" —— 启动时装的是 `config.we.dir`（一条绝对路径，
  //   上次装的那个），而列表扫的是**当前**壁纸目录。他 0.9.131 改名之后把壁纸
  //   搬到了新目录，config 里存的还是旧路径 ⟹ 两者不一致 ⟹ 网格里没有一张
  //   能被标"正在放" ⟹ **桌面上在放东西，而面板上零线索**。
  //
  // ⟹ 判据：**一个正在生效的状态，界面上必须有地方能看到它** ——
  //   "在列表里找一下"不算，因为找不到的时候那个状态就从界面上消失了
  //   （而它还在生效）。
  // ⚠️ 而这里要给**可执行的下一步**（点一下就归位），不是只报告异常 ——
  //   光说"不在列表里"用户还得自己想办法。
  if (result.activeDir && !result.activeListed) {
    const shortDir = String(result.activeDir).split('/').slice(-2).join('/');
    state.innerHTML = `⚠️ 正在放的是 <b>${result.activeTitle || shortDir}</b>，`
      + `而它<b>不在当前壁纸目录里</b>（在 <code>${shortDir}</code>）`
      + '\n所以下面的列表里没有一张标着「正在放」。'
      + '\n⟹ 把那个壁纸目录拷进当前目录，或者直接点下面任意一张换掉它。';
  }

  grid.innerHTML = '';

  // ⚠️⚠️ **「新建」卡片是网格的第一格**（0.9.128）。用户 2026-08-02：
  //   「这个按钮本身的设计以及位置还是怪怪的」
  //
  // ⚠️ 前两版都把它当成一个"操作"（通栏按钮 / 实心按钮 + 一句灰字说明，
  //   横在网格上方）⟹ 读起来像广告横幅。
  //   而它其实是**"再来一张壁纸"** —— 和网格里那些是同一类东西，
  //   只是这一张还不存在 ⟹ 它就该在网格里，长得像一张待填的卡片。
  // ⚠️ 每次 renderMine 重建 ⟹ 事件也要每次挂（不能只在启动时挂一次）。
  //   ⚠️ 而它调的是 `aiCloseWorkshop` 的兄弟 —— `aiOpenWorkshop`，
  //     同样是模块级变量：`aiSetOpen` 声明在下面那个 try 块里（块级作用域），
  //     这里看不到它。这个坑 0.9.127 在 Esc 那条上栽过一次。
  const newCard = document.createElement('button');
  newCard.type = 'button';
  newCard.className = 'ws-new';
  newCard.title = '说一句你想要什么效果，AI 写一张壁纸放进壁纸目录';
  const plus = document.createElement('span');
  plus.className = 'plus';
  newCard.appendChild(plus);
  const newLabel = document.createElement('span');
  newLabel.textContent = 'AI 生成一张';
  newCard.appendChild(newLabel);
  // ⚠️⚠️ `aiOpenWorkshop` 的 `let` 声明在这个函数**下面**（约 500 行之后），
  //   而 `let` 没有提升 ⟹ 看起来像 TDZ 隐患。**核过了，不是**：
  //     renderMine 的执行入口是 renderTab（用户点 tab）和 apply()，
  //     而 apply 走 `getConfig().then(apply)` —— 那是 Promise 回调（微任务），
  //     一定在所有同步的顶层语句（包括那个 let）跑完之后才执行。
  //   ⚠️ 判据：**"声明在使用之下"要看的是执行时机，不是文本顺序** ——
  //     函数体内的引用只在调用时求值。而这里我确认了没有任何顶层同步调用
  //     `renderMine()`（grep 过）。
  //   ⚠️ 但 `if (aiOpenWorkshop)` 那个判空**留着**：AI 那个 try 块要是抛了，
  //     这个变量会停在 null ⟹ 点卡片什么都不发生，而不是抛一个红叉。
  newCard.onclick = () => { if (aiOpenWorkshop) aiOpenWorkshop(); };
  grid.appendChild(newCard);

  for (const item of result.items) {
    const card = workshopCard({
      ...item,
      // ⚠️ item.dir 透传下去 —— 卡片靠它决定要不要显示「打开目录」。
      // 本地文件走 file://（自定义 protocol 只服务当前装载的那个）
      preview: item.preview ? `file://${encodeURI(item.preview)}` : null,
    }, async () => {
      if (item.broken) return;
      // ⚠️⚠️ **左键 = 装载 + 右侧显示它的参数**（0.9.54）。
      // 用户 2026-08-01（给了 WE 的截图之后）：「装载加显示壁纸参数」
      //
      // ⟹ "选中"和"正在放"是**同一个概念** —— 没有"选了但没生效"的中间态。
      //   那也是为什么右侧面板不需要一个「装载这个壁纸」按钮。
      //
      // ⚠️ 历史：0.9.37 我让"点当前那张卡片 = 卸载"，那是**把一个动作藏在
      // 另一个动作里**（左键既装载又卸载，看 active 状态）⟹ 卸载搬到了右键菜单。
      //
      // ⚠️ 而"点当前那张"现在**要先把详情填出来再 return** ——
      //   原来是无条件 `if (item.active) return;`，那样点正在放的那张
      //   右侧不会更新（症状："点了没反应"，而这个项目栽过六次同形状）。
      renderMineSide(item);
      if (item.active) return;   // 已经在放了，不重新装载（会让画面闪一下）
      const out = await window.gw.workshopLoadLocal(item.dir);
      if (!out.ok) state.innerHTML = `<span class="warn">${out.error}</span>`;
      renderWEStatus();
      renderMine();
    }, (it, x, y) => {
      // ⚠️⚠️ **右键菜单** —— 见 showCardMenu 上面那段。
      //
      // 「在 Finder 中打开」这一条 2026-07-31 被用户要求删掉过，
      // 而那时它是**常驻按钮 × N 张卡片**（「不是每个壁纸都要显示一下目录的」）。
      // 右键菜单里它不占地方 ⟹ **需要时才出现**，那正是它该在的位置。
      // ⟹ 判据：**常驻的东西要少，而不是功能要少。**
      showCardMenu(x, y, [
        it.active ? null : {
          label: '装载这个壁纸',
          onClick: async () => {
            if (it.broken) return;
            const out = await window.gw.workshopLoadLocal(it.dir);
            if (!out.ok) state.innerHTML = `<span class="warn">${out.error}</span>`;
            renderWEStatus();
            renderMine();
          },
        },
        {
          label: '在 Finder 中打开',
          onClick: () => window.gw.revealWallpaperDir(it.dir),
        },
        // ⚠️⚠️ **播放列表的入口在这里**（0.9.43）——
        // 用户选的是"手选哪几个进列表"而不是"目录里全部"。
        //
        // ⚠️ 放在右键菜单而不是卡片上加勾选框：那会给每张卡片加一个常驻控件，
        // 而这个项目刚因为"常驻的东西太多"被要求删过三轮
        //（每张卡片的「打开目录」按钮、目录行的「刷新」、创意工坊那段说明）。
        // ⟹ 判据：**常驻的东西要少，而不是功能要少。**
        (() => {
          const list = ((config.we && config.we.rotate) || {}).list || [];
          const inList = list.includes(it.dir);
          return {
            label: inList ? '从播放列表移出' : '加入播放列表',
            onClick: () => {
              const next = inList
                ? list.filter((d) => d !== it.dir)
                : [...list, it.dir];
              setRotate({ list: next });
              // ⚠️ 要重渲染网格 —— 卡片上有"在列表里"的标记，
              // 不刷的话用户加了之后卡片没变化，会以为没生效
              //（这个项目栽过六次"做了但用户看不到"）。
              renderMine();
            },
          };
        })(),
        // ⚠️⚠️ **「卸载（回到内置壁纸）」换成了「删除」**（0.9.42）。
        //
        // 用户 2026-08-01：「应该是卸载，就是这个壁纸的文件直接删除，
        // 而不是什么应用这个壁纸，应用之后再来个什么退回内置壁纸，
        // 我们的产品关闭了不就壁纸退出运行了，这个逻辑没必要」
        //
        // **他说得对** —— 关掉应用壁纸就没了，「退回内置」是个没有价值的中间态。
        // 而右键菜单里真正需要的是文件管理（删掉不要的壁纸）。
        //
        // ⚠️ 它对**每张卡片**都出现（不只当前那个）—— 因为"删掉一个不想要的
        // 壁纸"和"它有没有在用"无关。而正在用的那个会先自动卸载再删。
        { label: null },
        {
          label: '删除（移到废纸篓）',
          danger: true,
          onClick: async () => {
            // ⚠️⚠️ **删用户的文件必须确认。** 这个项目的纪律：
            // 破坏性操作要用户明示。而右键菜单里「删除」挨着
            // 「在 Finder 中打开」⟹ 点错的概率不低。
            //
            // ⚠️ 说清三件事：删什么、去哪（废纸篓 ⟹ 能反悔）、正在用的会先卸载。
            const name = it.title || it.id || it.dir;
            const extra = it.active ? '\n\n它正在使用中：会先卸载再删。' : '';
            // eslint-disable-next-line no-alert, no-restricted-globals
            if (!confirm(`把「${name}」移到废纸篓？${extra}\n\n${it.dir}`)) return;
            const out = await window.gw.deleteWallpaper(it.dir);
            if (!out || !out.ok) {
              // ⚠️ 失败要说出来 —— 静默失败时用户会以为删了，
              // 而下次刷新它又在那儿（那看起来像"删不掉"的鬼故事）。
              const st = document.getElementById('mine-state');
              if (st) {
                st.innerHTML = `<span class="warn">${(out && out.error) || '删除失败'}</span>`;
              }
              return;
            }
            renderWEStatus();
            renderMine();
          },
        },
      ].filter(Boolean));
    });
    // ⚠️⚠️ 这里原来给"正在用"的那张卡片加**蓝框高亮** —— 0.9.49 撤了。
    //
    // 用户 2026-08-01：「就是我下载的壁纸这里不用高亮一类的说正在播放这个，
    // 因为在轮播那里会显示」
    //
    // 他说得对：0.9.49 把"正在放哪个"做成了轮播摘要行的**主要内容**
    // （缩略图 + 名字，常驻在页面上方）⟹ 网格里再标一遍是同一个信息说两次。
    // 而这一页的网格是"有哪些壁纸"，不是"哪个在放"。
    //
    // ⚠️ 但 title（悬停提示）留着 —— 那不占视觉空间，而且它回答的是
    // "我点这张会发生什么"（点当前的什么都不做，见上面 onclick 里那句 return），
    // 那和"哪个在放"是两个问题。
    if (item.active) {
      card.title = '正在用（右键有更多操作）';
    }
    // ⚠️ **在播放列表里的要标出来** —— 这个角标**留着**，理由和上面撤掉
    // "正在用"高亮的理由正好相反：
    //   · "哪个在放" 只有一个，而轮播摘要行已经把它当主要内容显示了
    //   · "在播放列表里" 是**多个**，而用户在这一页做的动作就是右键加/移出
    //     ⟹ 加完之后当场看不到反馈，就不知道加成功没有
    //     （这个项目栽过六次"做了但用户看不到"）
    // ⚠️ 弹窗里那排缩略图能看到完整列表，但那要点开 —— 而加/移出发生在这里。
    const rlist = ((config.we && config.we.rotate) || {}).list || [];
    if (rlist.includes(item.dir)) {
      const mark = document.createElement('div');
      mark.textContent = '▶';
      mark.title = '在播放列表里';
      mark.style.cssText = 'position:absolute;top:4px;right:5px;font-size:10px;'
        + 'color:var(--accent);text-shadow:0 0 3px #000';
      // ⚠️ 这里原来有 `card.style.position = 'relative'` —— 删了。
      // 0.9.45 把 relative 提到 .ws-item 的 CSS 里了（标题也要绝对定位，
      // 所以**所有**卡片都需要，不只是在播放列表里的那些）。
      // 留着不算错，但那会让"谁负责定位上下文"有两个来源，而这个项目
      // 在"同一个事实两个来源"上栽过（workshop.js 自己维护过一份类型白名单）。
      card.appendChild(mark);
    }
    grid.appendChild(card);
  }
}

// ⚠️⚠️ **轮播那一块的渲染**（0.9.43）。
//
// 用户 2026-08-01：「壁纸应该设置一个播放列表，然后可以设置时间如轮播，
// 可以选择顺序/随机等」
//
// 两个设计决定（用户拍的）：
//   · 列表是**手选**的（右键菜单里加/移出），不是"目录里全部"
//   · 轮播开着时手动点一个壁纸**不打断轮播**，只是从它重新计时
// ⚠️⚠️ **轮播：一行摘要 + 弹窗**（0.9.49 重做）。用户 2026-08-01：
//   「轮播那里改一下，应该是点击一下出一个弹窗，设计时间，轮播时间，
//     顺序/随机等等，正常的轮播逻辑都要有，并且要有预览图，就是一行，
//     肯定放不下，右滑就行了，然后当前播放的哪个壁纸要有显示」
//
// ⟹ 面板上只剩一行（在放哪个 + 状态），设置全进弹窗。
// 这是"常驻的东西要少，而不是功能要少"的第四次应用。

// 小时/分钟的换算只在 **UI 层**做 —— 配置里存的仍然是 `minutes`，
// 主进程那边（rotateStep / syncRotate）一个字都不用改。
// ⚠️ 存两个字段（数值 + 单位）会引入"120 分钟"和"2 小时"两种表示同一件事
// 的状态，而它们会不同步。⟹ 单一真相是 minutes，单位只是显示方式。
function splitMinutes(minutes) {
  const m = Math.max(1, Math.round(Number(minutes) || 30));
  // 整小时才显示成小时 —— 90 分钟显示"1.5 小时"要么被 step=1 截断成 1，
  // 要么就得允许小数，两个都比"90 分钟"糟。
  if (m >= 60 && m % 60 === 0) return { every: m / 60, unit: 'hour' };
  return { every: m, unit: 'minute' };
}

function joinMinutes(every, unit) {
  const n = Math.max(1, Math.round(Number(every) || 1));
  return unit === 'hour' ? n * 60 : n;
}

// 从 dir 找那个壁纸的信息（缩略图/标题）。找不到返回 null ——
// ⚠️ 列表里的路径可能已经不存在了（用户在 Finder 里删了目录），
// 那不是异常，是要**显示出来**的状态（否则用户不知道为什么轮播跳过它）。
function wallpaperByDir(dir) {
  return lastWallpapers.find((w) => w.dir === dir) || null;
}

function renderRotate() {
  const r = (config.we && config.we.rotate) || {};
  const list = r.list || [];

  // ---- ① 面板上那一行摘要 ----
  const nowImg = document.getElementById('rotate-now-img');
  const nowTitle = document.getElementById('rotate-now-title');
  const nowState = document.getElementById('rotate-now-state');
  if (!nowTitle) return;

  // "正在放的是哪个" —— 唯一来源是 items 里的 active 标记（主进程算的）。
  // ⚠️ 不用 config.we.dir 自己判断：那是"上次装载的路径"，而壁纸可能
  // 已经被卸载/换掉了 ⟹ 会显示一个其实没在放的壁纸。
  const active = lastWallpapers.find((w) => w.active) || null;

  if (active) {
    nowTitle.textContent = active.title || active.id || '(未命名)';
    if (active.preview) {
      nowImg.src = active.preview;
      nowImg.style.visibility = 'visible';
    } else {
      // ⚠️ visibility 而不是 display —— 要**留住位置**，
      // 否则"没有缩略图"和"没在放壁纸"两种状态长得一样。
      nowImg.removeAttribute('src');
      nowImg.style.visibility = 'hidden';
    }
  } else {
    nowTitle.textContent = '没有在放壁纸';
    nowImg.removeAttribute('src');
    nowImg.style.visibility = 'hidden';
  }

  // 状态那半行：轮播开着说清"每多久、什么顺序"，关着就说怎么开。
  const t = splitMinutes(r.minutes);
  const unitText = t.unit === 'hour' ? '小时' : '分钟';
  if (r.on && list.length >= 2) {
    nowState.textContent = `轮播中 · 每 ${t.every} ${unitText} · `
      + `${r.mode === 'random' ? '随机' : '按顺序'} · 列表 ${list.length} 个`;
  } else if (list.length >= 2) {
    nowState.textContent = `轮播关着 · 列表 ${list.length} 个 · 点这里设置`;
  } else if (list.length === 1) {
    nowState.textContent = '播放列表只有 1 个：至少要 2 个才会轮播';
  } else {
    nowState.textContent = '还没有播放列表 · 点这里设置';
  }

  // ---- ② 弹窗里的控件（弹窗关着也要同步，否则打开的一瞬间是旧值）----
  const onBox = document.getElementById('rotateOn');
  const everyBox = document.getElementById('rotateEvery');
  const unitBox = document.getElementById('rotateUnit');
  const modeBox = document.getElementById('rotateMode');
  const countEl = document.getElementById('rotate-list-count');
  const hint = document.getElementById('rotate-modal-hint');
  if (!onBox) return;

  onBox.checked = !!r.on;
  everyBox.value = t.every;
  unitBox.value = t.unit;
  modeBox.value = r.mode || 'order';
  countEl.textContent = list.length ? `${list.length} 个` : '空';

  if (!list.length) {
    hint.innerHTML = '在壁纸上<b>右键 → 「加入播放列表」</b>把壁纸加进来。';
  } else if (list.length === 1) {
    // ⚠️ 一个壁纸"轮播"没有意义，而且主进程那边也不会起定时器
    // ⟹ 要说清，否则用户开了开关发现不动会以为坏了。
    hint.innerHTML = '⚠️ 只有 1 个：至少要 2 个才会轮播'
      + '（一个壁纸"轮播"就是每隔 N 分钟重载它，画面会白闪一下）。';
  } else {
    hint.textContent = r.on
      ? '手动点某个壁纸装载不会打断轮播，只是从它开始重新计时。'
      : '开关打开才会自动换。';
  }

  renderRotateStrip(list);
}

// 播放列表那一排缩略图。横向排，右滑看更多。
function renderRotateStrip(list) {
  const strip = document.getElementById('rotate-strip');
  if (!strip) return;
  strip.innerHTML = '';

  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.style.cssText = 'font-size:11px;padding:8px 2px';
    empty.textContent = '列表是空的';
    strip.appendChild(empty);
    return;
  }

  for (const dir of list) {
    const info = wallpaperByDir(dir);
    const item = document.createElement('div');
    item.className = 'rs-item';
    // ⚠️ 正在放的那个要标出来（用户点名「当前播放的哪个壁纸要有显示」）——
    // 摘要行只给了名字，而在列表里也要能一眼定位到它。
    if (info && info.active) item.classList.add('now');

    const img = document.createElement('img');
    if (info && info.preview) img.src = info.preview;
    img.onerror = () => { img.style.visibility = 'hidden'; };
    item.appendChild(img);

    const nm = document.createElement('div');
    nm.className = 'rs-nm';
    // ⚠️ 找不到 = 目录已经不在了（用户在 Finder 里删了）。
    // 那不是异常，是要**显示出来**的状态 —— 否则用户不知道轮播为什么跳过它。
    nm.textContent = info ? (info.title || info.id) : '⚠️ 已不存在';
    if (!info) nm.style.color = '#ffb4b4';
    item.appendChild(nm);
    item.title = info ? `${info.title || info.id}\n${dir}` : `找不到这个目录：${dir}`;

    // 移出按钮（hover 才显示）
    const del = document.createElement('div');
    del.className = 'rs-del';
    del.textContent = '✕';
    del.title = '从播放列表移出';
    del.onclick = (e) => {
      // ⚠️ stopPropagation —— 否则冒泡到 item.onclick 把这个壁纸装载了
      e.stopPropagation();
      setRotate({ list: list.filter((d) => d !== dir) });
    };
    item.appendChild(del);

    // 点缩略图 = 立刻切到这个壁纸。⚠️ 目录不存在就不给点（会失败）。
    if (info) {
      item.onclick = async () => {
        await window.gw.workshopLoadLocal(dir);
        renderWEStatus();
        renderMine();
      };
    } else {
      item.style.cursor = 'default';
    }

    strip.appendChild(item);
  }
}

// ---- 弹窗的开关 ----
//
// ⚠️ 三条关闭路径：✕ / 点遮罩 / Esc。少任何一条都会让人觉得"关不掉"
// （这个项目在右键菜单上已经踩过一次 —— 那次是漏了滚动时关闭）。
function openRotateModal() {
  const modal = document.getElementById('rotate-modal');
  if (!modal) return;
  // ⚠️ 打开时重渲染一次 —— 弹窗关着的时候壁纸可能被换过/删过，
  // 而"打开看到的是旧状态"是这个项目栽过的形状。
  renderRotate();
  modal.hidden = false;
  // 焦点给关闭按钮 ⟹ Esc 和 Tab 都从一个确定的位置开始
  const close = document.getElementById('rotate-modal-close');
  if (close) close.focus();
}

function closeRotateModal() {
  const modal = document.getElementById('rotate-modal');
  if (modal) modal.hidden = true;
}

// ⚠️ 改任何一项都走同一个入口 —— 三个控件各写一遍 patch 必然漏一个
async function setRotate(patch) {
  const out = await window.gw.weSetRotate(patch);
  if (out && out.ok && config.we) config.we.rotate = out.rotate;
  renderRotate();
}

// ⚠️ 三个控件都走 `setRotate` —— 各写一遍 patch 必然漏一个字段。
// ⚠️ 背景开关（0.9.64）—— 排查性能问题用的，见 HTML 里那段注释。
// ⚠️ 停的时候用 stopAurora（它会 cancelAnimationFrame）+ 清画布 ——
//   只 cancel 不清的话最后一帧会留在屏幕上，那看起来像"关了但还在"。
// ⚠️⚠️ 背景的**当前强度**（0.9.65）—— 开关和滑杆共用它。
// 用户 2026-08-01：「极光看起来还是没有，也可能是不明显？」
//
// ⚠️ "没有"和"不明显"是**两回事**，而我在这台机器上跑不了渲染
// ⟹ 光靠算术调参就是上一轮那个错法（我算出 rgb(32,45,58) vs 底色
//    rgb(16,16,20)，"差异很小"—— 但那推不出"所以只是不明显"）。
// ⟹ 给一个能拉到**明显过头**的滑杆：拉满还是什么都没有 ⟹ 是 bug；
//    拉满能看到 ⟹ 只是默认值太保守，那就调默认值。
//    **一次分清，不用再来回猜。**
(() => {
  const box = document.getElementById('bgOn');
  if (!box) return;
  const slider = document.getElementById('bgDim');
  const readout = document.getElementById('bgDimVal');

  const loudBox = document.getElementById('bgLoud');

  // ⚠️⚠️ **不依赖 canvas 绘制的对照**（0.9.69）。
  // 诊断模式如果也看不到，下一个问题是"canvas 元素本身在不在、多大、被谁盖"。
  // ⟹ 直接量 `getBoundingClientRect()` + `getComputedStyle()` 并写到面板上。
  //   那不经过任何绘制，是"元素可见性"的直接答案。
  // ⚠️ 这三个数是我这五轮一直在赌但从没量过的东西 ——
  //   我改了 z-index、grid-area、body 背景，全靠推理。
  (() => {
    const cv = document.getElementById('app-bg');
    const slot = document.getElementById('bg-geom');
    if (!cv || !slot) return;
    const r = cv.getBoundingClientRect();
    const cs = getComputedStyle(cv);
    // 谁在这个 canvas 的中心点最上面 —— 那就是"盖住它的东西"
    const hit = document.elementFromPoint(Math.round(r.width / 2), Math.round(r.height / 2));
    slot.textContent = `元素 ${Math.round(r.width)}×${Math.round(r.height)}`
      + ` @(${Math.round(r.x)},${Math.round(r.y)})`
      + `  display=${cs.display} opacity=${cs.opacity} z=${cs.zIndex}`
      + `  filter=${cs.filter}`
      + `\n中心点最上层的元素：<${hit ? hit.tagName.toLowerCase() : '?'}`
      + `${hit && hit.id ? ' #' + hit.id : ''}`
      + `${hit && hit.className && typeof hit.className === 'string' ? ' .' + hit.className.split(' ')[0] : ''}>`;
  })();

  function restart() {
    stopAurora('app-bg');
    const cv = document.getElementById('app-bg');
    const ctx = cv && cv.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, cv.width, cv.height);
    if (box.checked) startAurora('app-bg', { dim: bgDim, loud: !!(loudBox && loudBox.checked) });
  }

  if (loudBox) loudBox.onchange = restart;

  if (slider) {
    slider.value = String(Math.round(bgDim * 100));
    if (readout) readout.textContent = slider.value;
    // ⚠️ input 而不是 change —— 拖的时候就要看到效果（这是个用来"找到合适值"
    //   的控件，等松手才变的话得试很多次）。
    slider.oninput = () => {
      bgDim = Number(slider.value) / 100;
      if (readout) readout.textContent = slider.value;
      restart();
    };
  }

  box.onchange = () => {
    const cv = document.getElementById('app-bg');
    if (box.checked) {
      startAurora('app-bg', { dim: bgDim, loud: !!(loudBox && loudBox.checked) });
    } else {
      stopAurora('app-bg');
      // ⚠️ 用 clearRect 而不是 style.display = 'none' —— 后者会让
      //   `startAurora` 下次拿到的 clientWidth 是 0（那时 canvas 不在布局里）
      //   ⟹ 画布尺寸变成 0×0，开回来是空的。
      const ctx = cv && cv.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, cv.width, cv.height);
    }
  };
})();

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  DEV-PANEL-START —— 开发者模块的开关（产品问世时整块删掉）             ║
// ╚═══════════════════════════════════════════════════════════════════════╝
//
// 用户 2026-08-01：「你可以把开发者的东西全部聚合成一个控制面板模块，
// 最后产品问世了，把这个模块直接撤掉就行」
//
// ⟹ 撤掉时删三处：这一段、dashboard.html 里 DEV-PANEL marker 之间的 HTML、
//    以及 .dev-* 的 CSS。守卫（gating.test.js）查这三处的对应关系。
//
// ⚠️ 状态**不落配置** —— 那是个调试开关，不该在 config.json 里留痕迹
// （撤掉模块之后配置里还有个孤儿字段，而下一个人不知道它是干什么的）。
// ⟹ 每次开面板默认收起。
(() => {
  const toggle = document.getElementById('dev-toggle');
  const panel = document.getElementById('dev-panel');
  if (!toggle || !panel) return;
  toggle.onclick = () => {
    panel.hidden = !panel.hidden;
    toggle.textContent = panel.hidden ? '▸ 开发者选项' : '▾ 开发者选项';
  };
})();
// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  DEV-PANEL-END                                                        ║
// ╚═══════════════════════════════════════════════════════════════════════╝

// ---- 轮播（0.9.49：摘要行开弹窗，控件都在弹窗里）----

// 摘要行：整行可点。⚠️ 也要能用键盘（它是 role="button" tabindex="0"，
// 那意味着它会被 Tab 聚焦 —— 聚焦了却按不动是最糟的一种）。
const rotateSummary = document.getElementById('rotate-summary');
rotateSummary.onclick = openRotateModal;
rotateSummary.onkeydown = (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRotateModal(); }
};

// 三条关闭路径：✕ / 点遮罩 / Esc。
document.getElementById('rotate-modal-close').onclick = closeRotateModal;
document.getElementById('rotate-modal-mask').onclick = closeRotateModal;

// ---- 设置弹窗（0.9.51）----
//
// ⚠️⚠️ 用户 2026-08-01：「左下方来个齿轮按钮是设置，设置打开后弹窗，
// 这个弹窗里有{{我的壁纸目录：…}}以及之前的开发者选项」
//
// ⟹ 目录行和开发者选项都搬进来了。判据：**它们不是每天要看的东西**
//   （目录一次设定、开发者选项只在出问题时开），而它们原来常驻在
//   「我的壁纸」页上 ⟹ 那一页有一半不是壁纸。
function openSettingsModal() {
  const modal = document.getElementById('settings-modal');
  if (!modal) return;
  // ⚠️ 打开时重扫一次 —— 目录行里的计数（"6 个，4 个能跑"）来自 renderMine，
  // 而用户可能在 Finder 里加删过壁纸。不刷的话打开看到的是旧数字。
  // ⚠️ 用 renderMine() 而不是 renderMineDirs()：后者不重扫，计数不会更新。
  renderMine();
  modal.hidden = false;
  const close = document.getElementById('settings-modal-close');
  if (close) close.focus();
}

function closeSettingsModal() {
  const modal = document.getElementById('settings-modal');
  if (modal) modal.hidden = true;
}

document.getElementById('settings-open').onclick = openSettingsModal;
document.getElementById('settings-modal-close').onclick = closeSettingsModal;
document.getElementById('settings-modal-mask').onclick = closeSettingsModal;

// ⚠️ Esc 挂在 window 上而不是弹窗上 —— 焦点可能在弹窗里任何一个控件上，
// 而 keydown 冒泡到弹窗要求焦点在它内部，输入框里按 Esc 就不灵了。
// ⚠️ 判 hidden 而不是无条件关 —— 否则和别处的 Esc（右键菜单）抢。
// ⚠️⚠️ AI 工坊的关闭入口（0.9.127）。
//   它的实现在文件后面那个 `try` 块里（`aiSetOpen`），而**那是块级作用域**
//   ⟹ 这里必须用一个模块级变量接住它，否则 Esc 那条永远拿不到。
// ⚠️⚠️⚠️ **右栅的收起状态**（0.9.129）。用户 2026-08-02：
//   「不管我是 AI 界面还是参数界面，我都可以把这一个展示界面给他收缩起来，
//     我们现在默认是只有初次打开、没有点任何壁纸的时候他才是收缩的，
//     那其实打开以后我们应该也有收缩能力的」
//
// ⚠️ 他说得对：0.9.62 做的是"没选中壁纸就不占位"，而那是**自动**的 ——
//   一旦点了壁纸就再也收不回去（除了重开面板）。
//   而收起来的价值很实在：网格从两列变三四列，壁纸墙一眼看到更多。
//
// ⚠️⚠️ 这个状态必须是**粘的**（sticky）：收起之后再点壁纸**不能**把它顶开。
//   否则"收起"只活到下一次点击，而那种"我明明关了它又回来"最让人烦。
//   ⟹ renderMineSide / aiSetOpen 都要先看这个标志。
//   ⚠️ 而它**不进 config**（不跨启动记住）—— 判据：这是一个"我现在想多看几张
//     壁纸"的临时动作，不是一个偏好。存下来的话下次打开发现面板不见了，
//     而那时用户已经不记得自己收过。
let sideCollapsed = false;

function sideSyncCollapse() {
  const side = document.getElementById('mine-side');
  const handle = document.getElementById('side-unfold');
  if (!side) return;
  if (sideCollapsed) side.hidden = true;
  // ⚠️ 把手只在**收起状态**出现。而"收起"和"根本没东西可显示"是两种情况：
  //   后者（没选壁纸、AI 也没开）不该显示把手 —— 点开是一片空白。
  if (handle) handle.hidden = !sideCollapsed;
}

// 收起：两个 body 的按钮都调它。
function sideCollapse() {
  sideCollapsed = true;
  sideSyncCollapse();
}

// 展开：把手调它。⚠️ 展开之后要**决定露出哪个 body** ——
//   AI 开着就还是 AI，否则回到壁纸参数（而没选壁纸的话就没得可露 ⟹ 保持收起）。
function sideExpand() {
  sideCollapsed = false;
  const side = document.getElementById('mine-side');
  const ai = document.getElementById('ai-body');
  const params = document.getElementById('mine-side-body');
  const title = document.getElementById('side-title');
  const aiOpen = ai && !ai.hidden;
  const hasPick = !!(title && title.textContent.trim());
  if (side) side.hidden = !(aiOpen || hasPick);
  if (params) params.hidden = aiOpen || !hasPick;
  sideSyncCollapse();
}

// ⚠️ 重读 AI 工坊那一栏的工作目录 —— 换壁纸目录之后要调它（见 renderMineDirs）。
//   ⚠️ 同样是模块级变量：实现在下面那个 try 块里，而 renderMineDirs 在它之前。
let aiRefreshWorkdir = null;

// ⚠️⚠️⚠️ **右栅宽度：拖拽 + 松手吸附到一档**（0.9.142）。用户 2026-08-02：
//   「右栏拉宽这个功能应该是传统的话，就是他不是有一条数字的分割线吗？
//     应该是我鼠标点到这儿，然后自由的只是说他会自动挡一档两档那样，
//     你现在这个做法太呆了，我就点那个按钮」
//
// ⚠️ 0.9.141 是两个 `‹ ›` 按钮 —— 那是**把连续的操作离散化成点击**，
//   而"改宽度"这件事的天然手势是拖。
//   ⟹ 判据：**一档一档是结果（吸附），不该是交互方式。**
//
// ⚠️ 而"一档一档"的原因没变（用户 0.9.141 说的）：预览图有固定尺寸，
//   无级宽度会让卡片一直停在半格状态。
//   ⟹ 所以是**跟手拖 + 松手吸附**：拖的时候是连续的（跟手），落点是离散的。
let sideSteps = [340, 460, 580];
let gridMin = 460;
let sideWidth = 340;

// 当前窗口宽度下，哪些挡位是允许的
// ⚠️ 挡位**不是固定三个**，是"当前窗口宽度允许的那几个" ——
//   900px 窗口下右栅 580 会让壁纸区只剩 280px（一列）⟹ 壁纸墙失去意义。
//   ⟹ 判据：**约束是"壁纸区不能太窄"，挡位是那个约束的结果**。
function allowedSteps() {
  // ⚠️ 40 是 .pane-grid 的左右内边距（20+20）—— 那部分不算"能放卡片的宽度"
  const win = window.innerWidth;
  const ok = sideSteps.filter((w) => win - w - 40 >= gridMin);
  // ⚠️⚠️ **至少留一档** —— 窗口小到连最窄那档都不允许时，返回空数组会让
  //   拖拽算不出任何落点（`Math.min(...[])` 是 Infinity）⟹ 宽度变成 NaN。
  //   ⟹ 那种情况下就用最窄的那档（壁纸区挤一点，总比布局崩了好）。
  return ok.length ? ok : [sideSteps[0]];
}

// ⚠️ 拖到某个像素宽度 ⟹ 吸附到最近的**允许**挡位
function snapWidth(px) {
  const allowed = allowedSteps();
  let best = allowed[0];
  let bestD = Infinity;
  for (const w of allowed) {
    const d = Math.abs(w - px);
    if (d < bestD) { bestD = d; best = w; }
  }
  return best;
}

function applySideWidth(w) {
  const allowed = allowedSteps();
  // ⚠️⚠️ **窗口变窄时自动退回** —— 存的那一档可能已经不合法了
  //   （用户在大窗口选了 580，然后把窗口拖小）。
  const use = allowed.includes(w) ? w : allowed[allowed.length - 1];
  sideWidth = use;
  document.documentElement.style.setProperty('--side-w', `${use}px`);
  return use;
}

// ═══════════════════════════════════════════════════════════════════════════
//  拖拽
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️⚠️ 用 **pointer 事件 + setPointerCapture**，不是 mousedown/mousemove：
//   捕获之后即使鼠标移出把手（拖得快时必然会）事件也照样送到它身上
//   ⟹ 不用往 document 上挂全局监听、也不会"拖丢"。
//   ⚠️ 这个项目为"拖拽必须看 e.buttons"栽过（壁纸层那次）—— 而 pointer capture
//     从根上避开那类问题。
function bindSideGrips() {
  const grips = document.querySelectorAll('.side-grip');
  if (!grips.length) return 0;
  for (const grip of grips) {
    let dragging = false;
    const split = grip.closest('.split');

    grip.addEventListener('pointerdown', (e) => {
      // ⚠️ 只响应左键 —— 右键拖会和上下文菜单打架
      if (e.button !== 0) return;
      dragging = true;
      grip.setPointerCapture(e.pointerId);
      grip.classList.add('dragging');
      // ⚠️⚠️ 拖拽期间关掉宽度过渡 —— 那条 transition 会让宽度追着鼠标
      //   慢慢走（像有橡皮筋，松手后还在动）。见 dashboard.html 那段注释。
      if (split) split.classList.add('dragging');
      document.body.classList.add('col-resizing');
      e.preventDefault();
    });

    grip.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      // ⚠️ 宽度 = 窗口右边缘到鼠标的距离（右栅贴在右边）
      const raw = Math.round(window.innerWidth - e.clientX);
      const allowed = allowedSteps();
      // ⚠️ 夹在允许范围内 ⟹ 拖过头不会看到一个不可能的数字
      const clamped = Math.max(allowed[0], Math.min(allowed[allowed.length - 1], raw));
      // ⚠️⚠️ 拖动中用**真实像素**（跟手），不是吸附值 ——
      //   拖的时候就吸附的话手感是"一格一格顿"，那正是用户说"太呆了"的那种。
      document.documentElement.style.setProperty('--side-w', `${clamped}px`);
      // ⚠️⚠️ **不显示"→ 吸附 460"那个气泡**（0.9.143）。用户 2026-08-02：
      //   「右侧怎么显示一个什么吸附的叉叉网格，这个对用户来说是不需要的」
      //   ⟹ 我加它的理由是"让一档一档这件事可见" —— 而**松手时它自己会吸**，
      //     那个反馈已经足够（用户看到的是结果，不需要预告）。
      //   ⟹ 判据：**别为了解释机制而在界面上加东西。**
    });

    // ⚠️⚠️ `pointerup` 和 `pointercancel` **两个都要** ——
    //   拖拽过程中窗口失焦 / 触发系统手势时只有 cancel，
    //   漏了它的话会卡在"永远在拖"的状态（body 的 user-select 也解不开）。
    const finish = (e) => {
      if (!dragging) return;
      dragging = false;
      grip.classList.remove('dragging');
      if (split) split.classList.remove('dragging');
      document.body.classList.remove('col-resizing');
      try { grip.releasePointerCapture(e.pointerId); } catch { /* 已经释放了 */ }
      // ── 吸附
      const raw = Math.round(window.innerWidth - e.clientX);
      const use = applySideWidth(snapWidth(raw));
      // ⚠️ 存进 config（真偏好，下次打开要记住）。⚠️ 收起状态不存（那是临时动作）。
      if (window.gw.weSetSideWidth) window.gw.weSetSideWidth(use);
    };
    grip.addEventListener('pointerup', finish);
    grip.addEventListener('pointercancel', finish);

    // ⚠️⚠️ **双击 = 在允许的挡位间循环**（0.9.142）——
    //   那是给"不想拖"的人留的路（也是键盘/触控板不方便拖时的出路）。
    //   ⚠️ 而它不是主交互 ⟹ 不占界面位置。
    grip.addEventListener('dblclick', () => {
      const allowed = allowedSteps();
      const i = allowed.indexOf(sideWidth);
      const use = applySideWidth(allowed[(i + 1) % allowed.length]);
      if (window.gw.weSetSideWidth) window.gw.weSetSideWidth(use);
    });
  }
  return grips.length;
}

// ⚠️ 窗口尺寸变了要重算 —— 否则拖小窗口之后右栅还是 580，壁纸区被挤成一列
window.addEventListener('resize', () => applySideWidth(sideWidth));

// ⚠️⚠️⚠️ **在这里就调用它**（不是"以后某个初始化里"）。
//   这个项目为"注册成功但功能是死的"栽过七次，而形状每次都一样：
//   写了一个 bind 函数，然后没有任何地方调它 —— 而那不报错。
//   ⟹ 判据：**绑定函数写完立刻调，别隔着一段距离。**
//   ⚠️ 而把手是 HTML 里静态存在的（不是 JS 建的）⟹ 这里一定找得到。
const gripsBound = bindSideGrips();
if (!gripsBound) {
  // ⚠️ 一个都没绑上是**结构问题**（HTML 里的 .side-grip 被删了/改名了）
  //   ⟹ 那时拖拽功能整个不存在，而界面上看不出来 ⟹ 必须吵。
  console.warn('[side] 一个 .side-grip 都没找到，拖拽改宽度不可用');
}

let aiCloseWorkshop = null;
// ⚠️ 打开入口同理 —— 网格里那张「新建」卡片是 renderMine 建的，
//   而 renderMine 在这个文件里比 AI 那个 try 块**靠前** ⟹ 也拿不到 aiSetOpen。
let aiOpenWorkshop = null;

// ⚠️⚠️ 两个弹窗**一个 handler 管**，而且 return 一次只关一个 ——
// 各写一个 handler 的话两个都开着时按 Esc 会同时关掉两个
// （虽然眼下不会两个同开，但那是"以后加第三个弹窗就出问题"的形状）。
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const [id, close] of [
    ['settings-modal', closeSettingsModal],
    ['rotate-modal', closeRotateModal],
    // ⚠️ AI 壁纸工坊（0.9.123）。**加在这里而不是另写一个 handler** ——
    //   上面那段注释早就说了另写会出什么问题（两个都开着时 Esc 同时关掉两个），
    //   而"以后加第三个弹窗"就是现在。
    // ⚠️ 它排在最后：生成中按 Esc 更可能是想关掉前面那两个（如果同时开着）。
    // ⚠️ AI 工坊（0.9.127 起是右栅的一个 body，不再是弹窗）——
    //   ⚠️ 它排在最后：另外两个是**真弹窗**（有遮罩、盖住整屏），
    //     同时开着时 Esc 该先关那个盖住东西的。
    //
    // ⚠️⚠️ 走 `aiCloseWorkshop`（一个模块级变量）**而不是直接调 aiSetOpen** ——
    //   后者是**声明在下面那个 try 块里的函数**，而 `function` 声明是
    //   块级作用域 ⟹ 这里看不到它。
    //   ⚠️ 我第一版写的是 `typeof aiSetOpen === 'function' && aiSetOpen(false)`，
    //     那**永远是 false** ⟹ Esc 静默失效（不报错、只是没反应）。
    //     核对方式：比较两处的字符偏移 + 确认 try 块范围（不是靠猜）。
    ['ai-body', () => { if (aiCloseWorkshop) aiCloseWorkshop(); }],
  ]) {
    const modal = document.getElementById(id);
    if (modal && !modal.hidden) { e.stopPropagation(); close(); return; }
  }
});

document.getElementById('rotateOn').onchange = (e) =>
  setRotate({ on: e.target.checked });

// ⚠️ 用 change 而不是 input —— input 会在用户还在敲的时候就触发
// （敲 "15" 的过程中先收到 1 ⟹ 那会让轮播先按 1 分钟起一次定时器）。
// ⚠️⚠️ 数值和单位**必须一起算**：改单位时数值没变，但 minutes 变了
// （2 分钟 → 2 小时 = 120）。各自只发自己那半的话，改单位不会生效。
function pushInterval() {
  const every = Number(document.getElementById('rotateEvery').value);
  const unit = document.getElementById('rotateUnit').value;
  // ⚠️ 挡住非法值 —— 空/0/负数会让主进程那边 fallback 到 30，
  // 而用户看到"我填了 0 它变成 30"会以为没生效。
  if (!Number.isFinite(every) || every < 1) { renderRotate(); return; }
  setRotate({ minutes: joinMinutes(every, unit) });
}
document.getElementById('rotateEvery').onchange = pushInterval;
document.getElementById('rotateUnit').onchange = pushInterval;

document.getElementById('rotateMode').onchange = (e) =>
  setRotate({ mode: e.target.value });
document.getElementById('rotateNext').onclick = async () => {
  await window.gw.weRotateNext();
  renderWEStatus();
  renderMine();
};

// 最近一次扫描的结果（哪些目录、在不在、找到几个）。renderMine 拿到就存下来。
//
// ⚠️ 用模块级变量而不是每次重新扫 —— 扫描要遍历磁盘，而这个函数在
// 每次增删目录后都会跑。
let lastScanned = null;

// ⚠️⚠️ 最近一次扫到的壁纸清单（0.9.49）—— 轮播的摘要行和弹窗靠它拿
// 缩略图 / 标题 / "正在放哪个"。renderMine 拿到就存下来。
//
// ⚠️ 和 lastScanned 一样是**模块级缓存**，理由也一样：扫描要遍历磁盘，
// 而且轮播和网格必须看到同一份数据 —— 各自扫一次的话，两次之间的差异
// 会让"正在放"的判断和网格上的蓝框对不上。
let lastWallpapers = [];

// ⚠️ 「N 个，M 个能跑」的计数（0.9.50）—— 画在**目录行**里（用户点名要一行）。
// ⚠️ 初值 null 而不是 {total:0,usable:0}：那样"还没扫"会显示成"0 个"，
// 而"0 个壁纸"和"还没扫"是两件事（写 0 会让人以为目录是空的）。
let lastMineCount = null;

function renderMineDirs() {
  const host = document.getElementById('mine-dirs');
  const dirs = (config.we && config.we.libraryDirs) || [];
  host.innerHTML = '';

  // ⚠️ **我们自己的壁纸目录放最前面，而且常驻显示。**
  //
  // 用户要的：「你的默认壁纸目录改成标准的壁纸软件的目录层级」+「要能够点开」。
  // ⟹ "我的壁纸放哪"这个问题必须一眼看到答案，而不是等到"一个都没找到"时才出现。
  window.gw.ourWallpaperDir().then((res) => {
    if (!res || !res.ok) return;
    // ⚠️⚠️⚠️ **一行，而且改用 flex**（0.9.130）。用户 2026-08-02：
    //   「那个巨长的更换目录不好看」
    //
    // ⚠️ 根因和 AI 那个入口按钮同一个：这一行原来用 `.bar-row`
    //   （`grid-template-columns: 1fr auto`，**只有两列**），
    //   而它 append 了 **4~5 个**子元素（路径 / 打开 / 更换目录 / 恢复默认 / 计数）
    //   ⟹ 超出的那些落进 grid 的**隐式列**，宽度由剩余空间瓜分
    //   ⟹ 「更换目录」那一格被拉开，看起来就是"一个巨长的按钮"。
    //
    // ⚠️⚠️ 我第一版把它拆成了两行（信息一行 + 操作一行），而**那和用户
    //   0.9.50 明确要求过的"这个应该一行，现在是两行"相冲** ⟹ 问了他，
    //   他要一行。⟹ 回到一行，改的是**布局工具**：
    //     grid（列数固定）→ flex（各自自然宽度、路径吃剩余）
    //   ⚠️ 判据：**子元素个数不固定的时候别用固定列数的 grid。**
    //     而"巨长按钮"这个症状在这个项目里出现三次了，三次都是同一个原因。
    // ⚠️ 代价说清楚：窗口窄时路径会被挤短（`min-width: 0` + ellipsis）——
    //   而完整路径在 `title` 里（悬停可见），且它本来就可以选中复制。
    const box = document.createElement('div');
    box.style.cssText = 'display:flex;align-items:baseline;gap:8px;margin-bottom:8px';
    const label = document.createElement('span');
    label.className = 'hint';
    label.style.cssText = 'font-family:ui-monospace,Menlo,monospace;font-size:11px;'
      + 'user-select:text;flex:1;min-width:0;margin:0;'
      // ⚠️ 一行 + 超出打点：不这么做的话长路径会把按钮挤出容器
      //   （flex 项默认 min-width:auto，内容撑得下就不肯缩）。
      + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    label.textContent = `我的壁纸目录：${res.dir}`;
    label.title = res.dir;

    // 计数：和路径同一行，跟在按钮后面。⚠️ 还没扫完时不显示（而不是显示 0）——
    // "0 个壁纸"和"还没扫"是两件事，而写 0 会让人以为目录是空的。
    const countEl = document.createElement('span');
    countEl.className = 'hint';
    countEl.style.cssText = 'font-size:11px;white-space:nowrap';
    if (lastMineCount) {
      // ⚠️ 「能跑」这个说法 0.9.57 去掉了（用户点名：「"能跑"的这种描述不需要」）。
      // ⟹ 只报总数。而"这张放不了"的信息在**卡片上**（`scene·暂不支持` 那行），
      //   那是用户点下去之前会看到的地方 —— 一个汇总数字帮不了他挑壁纸。
      countEl.textContent = `${lastMineCount.total} 个壁纸`
        + (lastMineCount.truncated ? '（超 500，只列前 500）' : '');
    }
    // ⚠️⚠️ **全部操作都在这一行**（0.9.31）。
    //
    // 用户 2026-08-01：「这个刷新和加一个壁纸目录应该和我们的
    //   『我的壁纸目录：…打开』功能合并…反正只有一个路径来源，只是我允许你更改」
    //
    // ⟹ [打开] [换目录…] [刷新]，而"换目录"改的就是**这一个**路径。
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'act';
    open.textContent = '打开';
    open.title = '在 Finder 里打开';
    open.onclick = () => window.gw.revealWallpaperDir(res.dir);

    const change = document.createElement('button');
    change.type = 'button';
    change.className = 'act';
    // ⚠️ 用户点名叫「更换目录」（原来是「换目录…」）
    change.textContent = '更换目录';
    // ⚠️ title 里说清"不搬文件" —— 用户选的就是这个行为，
    // 而不说的话他会以为壁纸跟着走了（然后发现列表空了以为坏了）。
    change.title = '换成别的目录。⚠️ 只改指向，**不会搬文件**：'
      + '旧目录里的壁纸留在原地';
    change.onclick = async () => {
      const out = await window.gw.workshopAddDir();
      if (!out || !out.ok) return;
      // ⚠️ 换完立刻刷新，而且要提示"旧目录没动" ——
      // 新目录空的话列表会空，用户需要知道那是预期的。
      await renderMine();
      // ⚠️⚠️ **AI 工坊那一栏显示的工作目录也要跟着变**（0.9.130）。
      //   用户 2026-08-02：「AI 的默认工作区是壁纸的存放位置，那我更改了
      //   存放的位置，这里应该同步的吧」
      //
      // ⚠️ 主进程那边**本来就是对的**：`gen-meta` 和生成落盘都走
      //   `ensureOurWallpaperDir()`，而它读 `config.we.wallpaperDir`
      //   ⟹ 生成的壁纸真的会去新目录。
      //   问题只在**面板上那行字是打开 AI 时读一次的** ⟹ 换了目录之后
      //   它还显示旧路径 ⟹ 用户会以为生成的东西去了旧地方。
      //   ⟹ 判据：**一个"显示某个配置"的地方，那个配置变了就要重读** ——
      //     否则界面在说谎，而那比不显示更糟。
      if (aiRefreshWorkdir) await aiRefreshWorkdir();
      if (out.before && out.before !== out.dir) {
        // ⚠️ 我第一版写 `mineState.innerHTML` —— **那个变量不存在**。
        // `renderMine` 里的叫 `state`（局部的），而这里是 `renderMineDirs`。
        // `node --check` 查不出（语法没错），症状是点了「换目录」抛 ReferenceError
        // ⟹ 后面的刷新不跑，用户看到"点了没反应"。
        // ⟹ 现取 —— 那样跨函数也安全。
        const st = document.getElementById('mine-state');
        if (st) st.innerHTML = `已换到 <b>${out.dir}</b>`
          + `\n⚠️ 旧目录 ${out.before} 里的壁纸**没有搬走**，还在原地。`
          + `\n要用它们的话，把那些子目录拷进新目录（或者点「恢复默认」换回去）`;
      }
    };

    // ⚠️ 「恢复默认」只在**用过自定义目录**时出现。
    // 为什么需要它：默认值不写进 config（那样换用户/换机器自适应）
    // ⟹ 用户改错了之后不知道该填什么路径回去。
    const isDefault = !(config.we && config.we.wallpaperDir);
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'act';
    reset.textContent = '恢复默认';
    reset.title = '回到 文档/DreamPaper/Wallpapers';
    reset.onclick = async () => {
      const out = await window.gw.resetWallpaperDir();
      if (out && out.ok) await renderMine();
    };

    // ⚠️⚠️ 这里原来还有一个「刷新」按钮，删了（0.9.43）。
    //
    // 用户 2026-08-01：「刷新我理解是自动刷新的，所以没有也无所谓」
    // —— **他的理解是对的**，代码里两处都会自动扫：
    //   `dashboard.js:46`    切到「我的壁纸」页签时
    //   `dashboard.js:2375`  窗口重新聚焦时（且当前是那个页签）
    // ⟹ 用户从 Finder 拖进一个壁纸再切回来，列表就更新了 ⟹ 那个按钮是冗余的。
    //
    // ⚠️ 而它不做轮询是故意的：扫描要遍历磁盘（Steam 那个目录 639MB），
    // 每隔几秒扫一次会一直占着 IO。
    // ⚠️ 计数和按钮都 `flex:none`（各自自然宽度）—— 只有路径那一格伸缩。
    //   ⚠️ 这正是"巨长按钮"的解法：grid 里没法说"只有这一格伸缩"，
    //     而 flex 里那就是默认（其余项不 grow）。
    countEl.style.cssText += ';margin:0;flex:none';
    for (const b of [open, change, reset]) b.style.flex = 'none';
    box.append(label, countEl, open, change);
    if (!isDefault) box.append(reset);
    // ⚠️ 插到最前面而不是 append —— 这个函数是异步回调，
    // 直接 append 会让它落在已经渲染好的目录列表后面（顺序随机）。
    host.insertBefore(box, host.firstChild);
  });

  // ⚠️ **然后是自动扫的目录。**
  //
  // 用户报：面板只写「还没加自定义目录（steamcmd 那个是自动扫的）」——
  // 而"那个"是哪个路径、存不存在、找到几个，一个字都没说。
  // ⟹「我的壁纸是空的」时，用户没法判断是"目录不对"还是"目录对但里面没东西"，
  // 而那两件事的下一步完全不同（改路径 vs 去下壁纸）。
  // ⚠️⚠️ **只显示真实存在的那个 Steam 目录，不是三个候选都列。**
  //
  // `STEAM_ROOTS` 有三个候选（`~/Library/Application Support/Steam`、
  // `~/steamcmd`、`~/Steam`）—— 因为 steamcmd 的装法不同、数据目录不同，
  // 而我们只能逐个找。但**面板上列三行没有意义**：
  // 两个必然不存在，而"这个目录不存在（正常）"这种行只是噪声。
  //
  // 用户 2026-08-01：「不用每一张壁纸都这样显示，就这两个地址就行」
  // ⟹ 我的壁纸目录（最上面那行）+ Steam 实际那个 = **两行**。
  //
  // ⚠️ 但**全都不存在时要显示一行** —— 否则"没装 Steam"和"扫了但没找到"
  // 在面板上长得一样，而那两件事的下一步完全不同。
  // ⚠️⚠️⚠️ **Steam 那行只在"有残留"时出现。**
  //
  // 用户 2026-08-01 让删掉的就是这一段：
  //   「steamcmd 的临时下载目录（下载完会移走，所以这里通常是空的）：
  //     …/content/431960 空的（正常 —— 下载完会移到上面那个目录）[打开]」
  //
  // 他是对的：0.9.29 起下载会**移动**到我们目录 + 清空壳
  // ⟹ 那个目录**空着才是常态** ⟹ 显示一行"空的（正常）"是纯噪声。
  //
  // ⚠️ 而"没装 steamcmd"那种情况我原来也显示一行 —— 那更没用：
  // 用户没装 steamcmd 就不会用工坊下载，那行只是让面板变长。
  //
  // ⟹ 判据：**只有异常才显示**。这里的异常只有一种 ——
  //    目录里还留着壁纸（= 上次搬运失败，磁盘满/权限/跨卷）。
  //    那时用户需要知道，而且需要那个「搬到我的壁纸目录」按钮。
  const autoAll = (lastScanned || []).filter((x) => x.auto);
  const auto = autoAll.filter((x) => x.exists && x.found);
  if (auto.length) {
    const title = document.createElement('div');
    title.className = 'hint';
    title.style.marginBottom = '4px';
    title.textContent = 'steamcmd 目录里还留着壁纸（上次没搬走）：';
    host.appendChild(title);
    for (const item of auto) {
      const row = document.createElement('div');
      row.className = 'bar-row';
      row.style.cssText = 'align-items:baseline;margin:2px 0 2px 8px';
      const text = document.createElement('span');
      text.className = 'hint';
      text.style.cssText = 'font-family:ui-monospace,Menlo,monospace;font-size:11px;'
        + 'user-select:text;flex:1';
      // 三件事一行说完：路径、在不在、找到几个。
      // ⚠️ 措辞跟着 0.9.24 的改动更新：工坊下载现在会**自动复制**到我们目录
      // ⟹ 这里的数字是"Steam 那边还留着的原件"，而列表里显示的是我们目录那份
      //（去重逻辑保留我们的那份）⟹ 不说清的话"这里有 3 个但列表只有 3 个"
      // 看起来像数字不对。
      // ⚠️ 走到这里的只有"有残留"一种情况（上面已经过滤了）
      // ⟹ 不用再分支。原来那三个分支里两个是"正常"，而正常状态压根不该显示。
      const mark = `${item.found} 个：点右边搬过去`;
      text.textContent = `${item.path}  ${mark}`;
      // 走到这里都是异常状态 ⟹ 一律标黄
      text.style.color = 'var(--warn, #c98)';
      row.appendChild(text);
      // ⚠️ 有残留时给一个「搬过来」按钮。
      //
      // 0.9.24-0.9.28 用的是**复制** ⟹ 用户机器上已经有两份了，
      // 而 0.9.29 改成移动只对**新下载**生效 ⟹ 存量不会自己消失。
      // 用户 2026-08-01：「那不就是自动两份，太离谱了」—— 存量也得能清。
      if (item.exists && item.found) {
        const fix = document.createElement('button');
        fix.type = 'button';
        fix.className = 'act';
        fix.textContent = `搬到我的壁纸目录`;
        fix.title = '把这里的壁纸移进上面那个目录（我们目录已有的就只删这边的副本）';
        fix.onclick = async () => {
          fix.disabled = true;
          fix.textContent = '搬运中…';
          const r = await window.gw.importExistingFromSteam();
          const moved = (r && r.moved) || [];
          const failed = (r && r.failed) || [];
          fix.textContent = failed.length
            ? `搬了 ${moved.length} 个，${failed.length} 个失败`
            : `已搬 ${moved.length} 个`;
          // ⚠️ 刷新列表 —— 不刷的话用户看到按钮变了字但路径行没变，
          // 会以为没生效（这个项目栽过"做了但用户看不到"六次）。
          //
          // ⚠️ 调 `renderMine()` 而不是 `renderMineDirs()` —— 前者会重新扫描
          // （刷新 lastScanned）并自己调后者。只调后者的话它用的还是旧的扫描结果
          // ⟹ 路径行上的数字不变 ⟹ 看起来像没搬。
          //
          // ⚠️ 而我第一版写的是 `refreshLocal()` —— **那个函数不存在**。
          // `node --check` 查不出（它只查语法），而症状是点了按钮后
          // 抛 ReferenceError、列表不刷新 —— 那正是"静默失败"。
          // ⟹ 教训：写调用之前先 grep 函数名，别凭印象。
          await renderMine();
        };
        row.appendChild(fix);
      }
      // ⚠️ **能点开。** 用户要的：「我要能进到那个目录，看到我的壁纸文件」。
      // 只有存在的目录才给按钮 —— 打开一个不存在的目录只会弹错误。
      if (item.exists) {
        const open = document.createElement('button');
        open.type = 'button';
        open.textContent = '打开';
        open.title = '在 Finder 里打开这个目录';
        open.onclick = () => window.gw.revealWallpaperDir(item.path);
        row.appendChild(open);
      }
      host.appendChild(row);
    }
  }

  // ⚠️⚠️ **没加过自定义目录时，这一整段都不显示。**
  //
  // 用户 2026-08-01 让删的另一半：
  //   「还没加自定义目录。
  //     ⚠️ 每个子目录要是一个壁纸（里面有 project.json）…
  //     ⚠️ 最多扫 2 层深、500 个 —— 再多会让面板卡住。」
  //
  // 那三行是**给还没做这件事的人看的说明**，而绝大多数人不需要自定义目录
  //（我们的目录 + 工坊下载已经覆盖了）⟹ 常驻显示等于让每个人都读一遍不相关的约束。
  //
  // ⚠️ 而那两条约束**本身有价值**（"直接放一堆 mp4 认不出来"是真会撞到的）
  // ⟹ 它们没有删，搬到了 `把壁纸放这里.txt` 里（那个文件就在壁纸目录，
  //    用户点「打开」就会看到）+ 「添加目录」按钮的 title 上。
  // ⟹ **在需要的时候出现，而不是一直挂着。**
  if (!dirs.length) return;

  const custom = document.createElement('div');
  custom.className = 'hint';
  custom.style.margin = '10px 0 4px';
  custom.textContent = '我自己加的目录：';
  host.appendChild(custom);
  for (const dir of dirs) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    const label = document.createElement('span');
    label.className = 'hint';
    label.textContent = dir;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'act danger';
    del.textContent = '移除';
    del.onclick = async () => {
      await window.gw.workshopRemoveDir(dir);
      // ⚠️ 只调 renderMine() —— 它自己会调 renderMineDirs（并刷新 lastScanned）。
      // 两个都调会渲染两遍，而且中间那次用的是**过期的** lastScanned。
      //
      // ⚠️ 这里是 onclick 里，所以 renderMine → renderMineDirs → (这个函数只是绑定
      // 不执行) 不构成同步递归。但那是"恰好"—— 别在 renderMineDirs 的**函数体**里
      // 调 renderMine()，那会真的死循环。
      renderMine();
    };
    row.append(label, del);
    host.appendChild(row);
  }
}

// ⚠️⚠️ 这里原来是 `document.getElementById('mine-refresh').onclick = …` 和
// `mine-add-dir` 两个绑定 —— **0.9.31 那两个按钮从 HTML 里删了**
//（合并进目录那一行），而绑定必须跟着删。
//
// ⚠️ 留着的后果不是"没反应"，是 **`null.onclick` 直接抛 TypeError**
// ⟹ 这个文件在那一行**中断** ⟹ 后面所有初始化都不跑。
//
// 这个项目已经为**同一个形状**烧过一轮：收缩页签时删了三个开关的 HTML，
// 而 `bind('music')` / `bind('moodFromCover')` / `bind('showHud')` 留着
// ⟹ `renderToggles()` 第一个就抛 ⟹ 我的壁纸目录列表、鼠标转发勾选、
//    筛选初始状态全都不渲染，而面板日志刷屏 `Cannot set properties of null`。
//
// ⟹ 守卫（gating.test.js）查的就是"每个 getElementById 的 id 必须在 HTML 里存在"。

// 已下载的列表 —— 下过的东西要能重新装载，而不是每次重填 ID。


// ⚠️ `into` = 把进度/结果写到哪个状态区（0.9.57 加的参数）。
// 右侧面板的「下载」按钮传 'wside-state'（就在按钮下面），
// 而折叠区里那条路径不传 ⟹ 沿用 `wsState`。
// ⚠️ 两个入口写同一个 `#ws-state` 的话，从右侧面板点下载的人得**展开折叠区**
// 才看得到"下载到哪了"—— 那是"做了但用户看不到"的第七次。
async function startDownload(id, into) {
  const target = into ? document.getElementById(into) : wsState;
  // ⚠️ 兜底到 wsState —— 传了个不存在的 id 时不该整个函数崩
  //（那会让"点了下载完全没反应"，比报错糟）。
  const box = target || wsState;
  downloadInto = box;   // 进度回调要知道往哪写
  box.textContent = '开始…';
  const result = await window.gw.workshopDownload(id);
  if (result.ok) {
    box.innerHTML = `✅ 下载好了，已经用上\n${result.dir}`;
    renderWEStatus();
    // ⚠️ 刷新「我的壁纸」—— 刚下的那个要出现在网格里。
    // 不刷的话用户切过去看不到它，会以为下载没成功。
    renderMine();
    return;
  }
  let html = `<span class="warn">${result.error}</span>`;
  if (result.searched && result.searched.length) {
    html += `\n找过这些路径：\n${result.searched.join('\n')}`;
  }
  if (result.tail && result.tail.length) {
    html += `\n\nsteamcmd 最后几行：\n${result.tail.slice(-8).join('\n')}`;
  }
  box.innerHTML = html;
}

// 进度实时显示。⚠️ 没有它，下载大壁纸时界面一动不动，和卡死分不清。
// ⚠️⚠️ 进度要写到**发起下载的那个状态区**（0.9.57）。
// 原来写死 `wsState`（折叠区里那个）⟹ 从右侧面板点「下载」的人看不到进度，
// 界面一动不动，和卡死分不清（而下载几百 MB 要好几分钟）。
// ⟹ `downloadInto` 由 startDownload 设，默认还是 wsState。
window.gw.onWorkshopProgress((hit) => {
  if (!hit) return;
  (downloadInto || wsState).textContent = hit.text;
});

// 启动时探一下 steamcmd 在不在 —— 提前说比等下载失败再说好。
window.gw.workshopProbe().then((probe) => {
  if (!probe) return;
  if (!probe.installed) {
    wsState.innerHTML = `<span class="warn">${probe.hint}</span>`;
    return;
  }
  document.getElementById('ws-user').value = probe.username || '';
  wsState.textContent = `steamcmd 就绪：${probe.steamcmd}`;
}).catch(() => {});

// ---------------------------------------------------------------------------
// 诊断报告
// ---------------------------------------------------------------------------

const diagState = document.getElementById('diag-state');

document.getElementById('diag-export').onclick = async () => {
  const result = await window.gw.exportDiagnostics();
  diagState.innerHTML = result.ok
    ? `✅ 已导出\n${result.file}\n把这个文件发过来`
    : `<span class="warn">导出失败：${result.error || '未知'}</span>`;
};

document.getElementById('diag-reveal').onclick = () => window.gw.revealDiagnostics();

// ⚠️⚠️⚠️ **一键复制**（0.9.161）
//
// 用户 2026-08-04：「我这只是随手看了两个壁纸就有这些问题，
//   如果你不能让我一键复制反馈给你的话，太慢了」
//
// ⚠️ 反馈成本是这个协作模型的瓶颈：看一张壁纸 3 秒，而"选中状态行 + 复制 +
//   描述哪里不对"要一分钟 ⟹ 看 10 张的成本绝大部分花在反馈上。
// ⟹ 判据：**探针的价值 = 信息量 ÷ 获取成本**，这里该优化的是分母。
//
// ⚠️⚠️ 而按钮要**说清复制成功了** —— 剪贴板操作没有可见反馈时，
//   用户会以为没生效然后再点一次（那是我们在别处栽过的形状）。
function wireCopy(id, fetchText, label) {
  const btn = document.getElementById(id);
  // ⚠️⚠️ 这里**显式再取一次** `#diag-state` —— 而不是用外层那个 `diagState`。
  //   ⚠️ 那条"多行容器要保留换行"的守卫是按 `getElementById('x')` 的**位置**
  //     切窗口的：我原来的写入点落在 `diag-reveal` 那次取节点之后
  //     ⟹ 它把这些多行写入算到了 `diag-reveal` 名下并报红。
  //   ⟹ 判据：**源码文本守卫靠"锚点之间的窗口"归属代码时，
  //     写入点要紧跟在它自己那次 getElementById 后面。**
  //     （那不是守卫的 bug —— 它逮到的"某个容器会被写多行"这件事是真的，
  //       只是归错了名字；而让它归对比放宽它好。）
  const out = document.getElementById('diag-state');
  if (!btn) return;
  btn.onclick = async () => {
    const original = btn.textContent;
    try {
      const r = await fetchText();
      if (!r || !r.ok) throw new Error((r && r.error) || '没拿到内容');
      await navigator.clipboard.writeText(r.text);
      btn.textContent = `✅ 已复制（${r.text.split('\n').length} 行）`;
      out.innerHTML = `✅ ${label}已复制到剪贴板，直接粘给开发者就行\n`
        + `<span style="opacity:.6">${r.text.split('\n').slice(0, 3).join('\n')}…</span>`;
    } catch (error) {
      // ⚠️ 复制失败也要给出路（选中那段文字手动复制）
      btn.textContent = '⚠️ 复制失败';
      out.innerHTML = `<span class="warn">复制失败：${error.message}</span>\n`
        + '（可以改用「导出诊断报告」那个按钮）';
    }
    setTimeout(() => { btn.textContent = original; }, 2500);
  };
}
wireCopy('scene-copy', () => window.gw.sceneReport(), '壁纸诊断');
wireCopy('scene-copy-objects', () => window.gw.sceneObjects(), '逐图层清单');

// ⚠️⚠️ **在页面上直接显示**（0.9.161）——
//   用户：「你要把你想要的信息这些搞好搞全，都在开发者选项那里，我复制就行了」
//   ⟹ 按钮复制是快路径，而这一块是**保底**：
//     剪贴板 API 在某些情况下会失败（没有焦点、权限），而选中复制永远能用。
//   ⚠️ 判据：**关键的观测手段要有两条独立的路** ——
//     一条挂了另一条还在（这个项目为"唯一的观测点挂了"栽过）。
const sceneShow = document.getElementById('scene-show');
if (sceneShow) {
  sceneShow.onclick = async () => {
    const dump = document.getElementById('scene-dump');
    if (!dump) return;
    if (dump.style.display !== 'none' && dump.textContent) {
      dump.style.display = 'none';
      sceneShow.textContent = '在下面显示';
      return;
    }
    dump.style.display = 'block';
    dump.textContent = '读取中…';
    try {
      const [a, b] = await Promise.all([window.gw.sceneReport(), window.gw.sceneObjects()]);
      dump.textContent = `${(a && a.text) || (a && a.error) || '(没有)'}\n\n`
        + `${'─'.repeat(60)}\n${(b && b.text) || (b && b.error) || '(没有)'}`;
      sceneShow.textContent = '收起';
    } catch (error) {
      dump.textContent = `读取失败：${error.message}`;
    }
  };
}

// 视频播放状态。⚠️ 这是"放了但你看不见"的唯一证据 —— 有分辨率和时间在涨，
// 就说明解码正常、问题在窗口层级或遮挡，那和"放不了"是两种完全不同的修法。
window.gw.onVideoStatus((status) => {
  if (!status) return;
  const node = document.getElementById('we-state');
  if (!node) return;
  if (status.ok === false) {
    node.innerHTML = `<span class="warn">视频：${status.kind}</span>\n${status.hint || ''}`;
    return;
  }
  if (status.loading) return;
  // 图片/GIF 的状态：报出放大倍数，因为"糊"最常见的原因是源图太小。
  // ⚠️ 那和"我们渲染差"是两件事，不说清用户会归错因。
  if (status.kindLoaded === 'image') {
    const up = status.upscale;
    node.innerHTML = `🖼 图片已显示 ${status.width}×${status.height}`
      + (up && up > 1.8
        ? `\n⚠️ 被放大了 ${up} 倍（屏幕 ${status.screenWidth}px）：糊是因为源图小，`
          + `不是渲染问题。已改用 contain 保清晰度。`
        : '');
    return;
  }
  if (status.width) {
    node.innerHTML = `▶ 视频在放 ${status.currentTime}s`
      + `${status.duration ? ' / ' + status.duration + 's' : ''}`
      + `\n${status.width}×${status.height}（有分辨率 = 解码正常；`
      + `如果你看到的是黑屏，那是层级或遮挡问题，不是播放问题）`;
  }
});

// ⚠️ 面板重新获得焦点时刷新「我的壁纸」。
//
// 这是**比切页签更贴合真实动作**的时机：用户点「打开」进 Finder → 拖几个壁纸进去
// → 切回面板。那时候他期望看到新的壁纸，而不是再点一次什么东西。
//
// ⚠️ 只在「我的壁纸」页签是当前页时才扫 —— 否则每次切回窗口都遍历一遍磁盘
//（Steam 那个目录 639MB），而用户可能只是回来看手势设置。
window.addEventListener('focus', () => {
  const mine = document.getElementById('tab-mine');
  if (mine && mine.classList.contains('on')) renderMine();
});

// ⚠️⚠️⚠️ **装载了别的壁纸 ⟹ 壁纸列表也要重扫**（0.9.134）。用户 2026-08-02：
//   「开机之后我看这个默认使用了、其实就是我上一次操作的那个壁纸，
//     然后轮播这块…还是没有正常显示，我自己在点它才能正常的对应起来」
//
// ⚠️⚠️ 根因是我 0.9.128 那个启动闸门引入的**时序缺口**：
//     主进程 whenReady：openDashboard() ⟹ 壁纸**还没装**（等 launch-dismissed）
//     面板加载完：apply() → renderMine() → workshopLocal()
//                 ⟹ 那时 `weProject` 是 null ⟹ 每一项 `active` 都是 false
//     用户点「点击进入」：壁纸**现在才**装上，weProject 有值了
//     ⟹ 而**没有人再跑一次 renderMine** ⟹ `lastWallpapers` 里的 active
//       永远停在 false ⟹ 轮播摘要行一直说"没有在放壁纸"，
//       直到用户手动点一张（那时 renderMine 重跑）—— 正是他描述的现象。
//
// ⟹ 判据：**把一件事推迟之后，要问"谁在它之前已经读过那个状态了"** ——
//   那些读过的地方需要一次重读，而"推迟"本身不会通知它们。
//
// ⚠️ 用**现成的 `we-status` 广播**（`setWEWallpaper` 装完就发），不新造通道 ——
//   这个项目为"新造一个没人听的频道"栽过（0.9.123 的 `library-changed`）。
// ⚠️ 只在「我的壁纸」是当前页时重扫 —— 扫描要遍历磁盘，而在别的 tab 上
//   那份列表没人看（切回去时 renderTab 自己会扫）。
window.gw.onWeStatus(() => {
  renderWEStatus();
  const mine = document.getElementById('tab-mine');
  if (mine && mine.classList.contains('on')) renderMine();
});
// ⚠️ 订阅实际频谱 —— 没有它，"参数调多少"只能靠猜（我猜了三轮）。
if (window.gw.onWeAudioFrame) window.gw.onWeAudioFrame(renderAudioFrame);

// ⚠️ 面板打开时补发最后一次 FFT 自检。
//
// 自检只在音频 helper 启动时跑一次，而用户可能那时候还没打开面板
// ⟹ 那行就永远错过了（他实测撞到，还问"这个在哪里"）。
if (window.gw.weSelfTest) {
  window.gw.weSelfTest().then((r) => {
    if (!r || !r.ok || !r.test) return;
    const t = r.test;
    const ok = t.segsAboveQuarter >= 2 && t.segsAboveQuarter <= 8
      && Math.abs(t.peakSeg - t.expectSeg) <= 1;
    logLine('audio', `${ok ? '✅' : '⚠️'} FFT 自检（${t.tone}Hz）：`
      + `峰值第 ${t.peakSeg} 段（应 ${t.expectSeg}）　主瓣宽 ${t.segsAboveQuarter} 段`
      + `　邻域 ${(t.neighbors || []).map((v) => Number(v).toFixed(3)).join(' ')}`
      + (t.outsidePeak !== undefined
        ? `　主瓣外最大 ${Number(t.outsidePeak).toFixed(3)}(第${t.outsideAt}段)`
          + (t.outsidePeak > 0.2 ? ' ⚠️主瓣外有明显值⟹尖刺在分箱/平滑'
            : ' ✅主瓣外干净⟹尖刺来自音乐瞬态')
        : ''));
  }).catch(() => {});
}
// ⚠️ 闸门丢帧 —— 那说明有旧音源还在发。打包版没终端，只能在这里看。
if (window.gw.onWeAudioDrop) {
  window.gw.onWeAudioDrop((d) => {
    const node = document.getElementById('we-audio-frame');
    if (!node) return;
    const extra = document.createElement('div');
    extra.className = 'warn';
    extra.style.marginTop = '4px';
    extra.textContent = `⚠️ 闸门丢掉了 ${d.count} 帧：owner=${d.owner}，`
      + `而当前音源=${d.current}：旧音源的 helper 还在吐数据`;
    // 只留最后一条
    const old = node.querySelector('.warn');
    if (old) old.remove();
    node.appendChild(extra);
    node.hidden = false;
  });
}
window.gw.onWeAudioStatus((status) => renderAudioStatus(status));

// ⚠️ apply() 必须最先跑，而且不能被任何东西挡住。
//
// 它负责绑定**所有**开关（包括「开启摄像头手势」）。而这个文件顶层有很多初始化代码，
// 任何一处抛异常都会让它永远跑不到 —— 表现是"点开关完全没反应，也没报错"。
//
// 实测踩到：用户报"摄像头打不开、点了什么反应都没有"，而纯 main 是好的 ——
// 也就是我往顶层加的东西里有一处抛了，把 apply() 挡在后面。
//
// ⟹ 两条改动：① apply() 提到最前面 ② 我加的初始化各自 try 住，互不牵连。
// ⚠️⚠️ 这里原来是 `renderPermissions()`（权限面板的渲染）—— **0.9.105 删了。**
//   用户："设置这里的权限展示还是有问题，删掉这里的展示吧，没啥用，
//   我们把功能调通就行"。理由见 main.js 那段（我改了六版还在错，
//   而根因是这个面板回答的是一个用户不需要问的问题）。

// ---------------------------------------------------------------------------
// AI 壁纸工坊（0.9.123）
// ---------------------------------------------------------------------------
//
// 用户 2026-08-02：「就像和 ChatGPT 对话一样，有个对话框，然后他上面会显示一下
//   我的工作目录在哪儿，就是我的壁纸存储目录，他生成壁纸就要放在这儿」
//   「不能给用户提供让他自主选择模型，我们就把调用大模型这个打通就行」
//
// ⚠️⚠️ 整块 try 住 —— 这是我加的初始化，它抛了不该把 apply() 挡在后面
//   （那会让所有开关都绑不上，而症状是"点什么都没反应、也没报错"）。
//   这个项目为这件事栽过一轮，见文件末尾那段注释。
try {
// ⚠️ 每个 getElementById 都可能是 null（HTML 改了而这里没跟上）
//   ⟹ 统一用一个取值器，拿不到就整块不启用，而不是在某一行抛。
const aiEl = (id) => document.getElementById(id);
const aiLog = aiEl('ai-log');

// ⚠️⚠️⚠️ **AI 工坊和壁纸参数共用右栅，互斥**（0.9.127）。用户 2026-08-02：
//   「你现在这种弹窗好难看，我想的是和壁纸参数一样右边显示，
//     但是这个壁纸参数的位置冲突了，我也没太想好」
//
// ⚠️ 不冲突 —— 判据是**时间上互斥**：「壁纸参数」是点了某张壁纸才出现，
//   「AI 工坊」是点按钮才出现，而不会同时想看这两个。
// ⟹ 同一个 `.pane-side`、两个平级 body，谁被打开谁占用。
// ⚠️ 关掉 AI 时要**回到之前那张壁纸的参数**（不是回到空白）——
//   参数那个 body 一直在被 renderMineSide 更新，只是藏着 ⟹ 露出来就是最新的。
function aiSetOpen(open) {
  const side = document.getElementById('mine-side');
  const body = document.getElementById('ai-body');
  const params = document.getElementById('mine-side-body');
  if (!side || !body) return;
  body.hidden = !open;
  if (open) {
    // ⚠️⚠️ 打开 AI 工坊是一个**明确的意图** ⟹ 它可以解掉收起状态。
    //   （对比：点壁纸不解 —— 那时用户要的是"换壁纸"，不是"把面板叫回来"。）
    sideCollapsed = false;
    side.hidden = false;
    if (params) params.hidden = true;
    sideSyncCollapse();
  } else {
    // ⚠️⚠️ 关掉 AI 之后**整栅收不收，取决于有没有选中壁纸** ——
    //   而"有没有选中"的唯一真相是参数 body 里有没有内容（标题非空）。
    //   ⚠️ 不能无条件 `side.hidden = false`：那样关掉 AI 会留下一个空面板，
    //     而用户 0.9.62 点名要求"没选中就整块不占位"。
    const title = document.getElementById('side-title');
    const hasPick = !!(title && title.textContent.trim());
    if (params) params.hidden = !hasPick;
    side.hidden = !hasPick;
  }
  sideSyncCollapse();
}

// 往对话流里加一条。⚠️ 用 textContent 不是 innerHTML ——
//   这些文本里有模型返回的报错原文，而那可能包含 HTML 标签。
function aiSay(kind, text) {
  if (!aiLog) return null;
  const node = document.createElement('div');
  node.className = `ai-msg ${kind}`;
  node.textContent = String(text || '');
  aiLog.appendChild(node);
  // ⚠️ 自动滚到底 —— 不滚的话进度条目在视野外，看起来像"卡住了"
  aiLog.scrollTop = aiLog.scrollHeight;
  return node;
}

let aiBusy = false;

function aiSetBusy(busy) {
  aiBusy = busy;
  const go = aiEl('ai-go');
  if (go) {
    go.disabled = busy;
    // ⚠️ 按钮上要说"在忙什么" —— 一个灰掉的按钮不解释原因是最糟的等待
    go.textContent = busy ? '生成中…' : '生成';
  }
}

// ⚠️⚠️ **只画工作目录那一行**（0.9.130 抽出来的）。
//   换壁纸目录之后要重读它（用户点名："AI 的默认工作区是壁纸的存放位置，
//   那我更改了存放的位置，这里应该同步的吧"），而**不能顺手动别的** ——
//   `aiRefreshMeta()` 还会 `wrap.open = !meta.hasKey`（折叠凭证区）
//   和回填 key 输入框 ⟹ 用户正在里面打字时会被收起来 / 被覆盖。
//   ⚠️ 我第一版就是直接 `aiRefreshWorkdir = () => aiRefreshMeta()`，
//     而注释里写着"只重读目录那一行，不动 key 输入框" —— **那句话是假的**。
//   ⟹ 判据：**注释说了什么，代码就得真的是什么。** 抽出来。
function aiPaintWorkdir(dir) {
  const dirNode = document.getElementById('ai-dir');
  if (!dirNode || !dir) return;
  // ⚠️⚠️ **340px 的栅装不下完整路径**（0.9.127）。原来这里写两行
  //   （"生成的壁纸放在这里：\n<完整路径>"），那在 620px 的弹窗里还行，
  //   在右栅里会折成四行、或者被 ellipsis 砍掉尾巴（而尾巴才是有用的部分）。
  //   ⟹ 只显示**尾部两段**（`GestureWall/Wallpapers`）—— 那足够认出是哪儿，
  //     完整路径进 `title`（悬停可见）。
  // ⚠️ 而"这是干什么的"由那个文件夹图形 + 悬停提示承担，不再占一行正文。
  const segs = String(dir).split('/').filter(Boolean);
  dirNode.textContent = segs.slice(-2).join('/') || dir;
  dirNode.title = `生成的壁纸放在这里，点开在 Finder 里看：\n${dir}`;
}

async function aiRefreshMeta() {
  const meta = await window.gw.genMeta();
  if (!meta) return;
  // ⚠️ 挡位配置来自主进程（它管 config）—— 面板只负责"当前窗口允许哪几档"
  if (Array.isArray(meta.sideSteps) && meta.sideSteps.length) sideSteps = meta.sideSteps;
  if (Number.isFinite(meta.gridMin)) gridMin = meta.gridMin;
  if (Number.isFinite(meta.sideWidth)) applySideWidth(meta.sideWidth);
  aiPaintWorkdir(meta.dir);
  const keyInput = aiEl('ai-key');
  // ⚠️ **回填已存的 key** —— 这个项目刚为"每次打开都要重填"栽过一轮（0.9.122，
  //   根因是 mergeConfig 撞 null 默认值抛异常，整份 config 被静默重置）。
  //   判据：能保存的字段就要能回填，否则用户没法确认它存了没有。
  if (keyInput && meta.apiKey) keyInput.value = meta.apiKey;
  const wrap = aiEl('ai-key-wrap');
  // ⚠️ 只在"还没填"时展开 —— 那时它是唯一的门槛。填过就收起来。
  if (wrap) wrap.open = !meta.hasKey;
  const hint = aiEl('ai-key-hint');
  if (hint) {
    hint.textContent = meta.hasKey
      ? `已存在本机（不会上传、诊断报告里打码）。当前模型：${meta.model}`
      : '还没填。填一次就行：它存在本机的配置文件里，不进代码仓、不上传。';
  }
  return meta;
}

// ⚠️ 打开工坊：网格里那张「新建」卡片调它（见 renderMine）。
//   ⚠️ 原来这里是 `aiEl('ai-open').onclick` —— 那个按钮 0.9.128 删了
//     （改成网格里的卡片），而卡片是每次 renderMine 重建的
//     ⟹ 不能在这里绑一次，要暴露一个函数让它每次挂。
aiOpenWorkshop = async () => {
  {
    aiSetOpen(true);
    try {
      const meta = await aiRefreshMeta();
      // ⚠️ 首次打开给一句引导 —— 空白的对话框不告诉用户该说什么。
      //   ⚠️ 而**只在第一次**说（aiLog 是空的时候），否则每次打开都刷一条。
      if (aiLog && !aiLog.children.length) {
        aiSay('bot', meta && meta.hasKey
          ? '说一句你想要什么效果，我写一张壁纸放进上面那个目录。\n'
            + '会自己检查代码、发现问题自己修，最多三轮。'
          : '先填模型凭证（上面那个折叠区），然后说一句你想要什么效果。');
      }
    } catch (error) {
      aiSay('bad', `读配置失败：${error.message}`);
    }
    const want = aiEl('ai-want');
    if (want) want.focus();
  }
};

// ⚠️ 把关闭入口交给模块级变量 —— Esc 那条 handler 在这个 try 块**外面**，
//   而 `function aiSetOpen` 是块级作用域，它看不到。见上面那段注释。
aiCloseWorkshop = () => aiSetOpen(false);
// ⚠️ **真的只重读目录那一行** —— 不碰 key 输入框、不折叠凭证区
//   （用户可能正在里面打字）。见 aiPaintWorkdir 上面那段。
aiRefreshWorkdir = async () => {
  const meta = await window.gw.genMeta();
  if (meta) aiPaintWorkdir(meta.dir);
};

if (aiEl('ai-close')) aiEl('ai-close').onclick = () => aiSetOpen(false);

// ⚠️⚠️ 参数面板里那条「AI 生成」（0.9.129）——和「返回参数」互为往返。
//   ⚠️ 这个按钮是**静态 DOM**（写在 HTML 里），不像网格那张卡片是每次
//     renderMine 重建的 ⟹ 这里绑一次就够，不需要走 aiOpenWorkshop 那个变量。
if (aiEl('ai-from-params')) aiEl('ai-from-params').onclick = () => aiOpenWorkshop();

// ⚠️⚠️ 收起 / 展开（0.9.129）。三个按钮都是静态 DOM ⟹ 绑一次就够。
//   ⚠️ 两个"收起"分别在两个 body 里，但调的是**同一个函数** ——
//     那保证了两种模式下的行为一致（而各写一份最容易走偏）。
// ⚠️ 分档按钮：两个 body 各一对，调**同一个函数**（各写一份必然走偏）

for (const id of ['side-fold-params', 'side-fold-ai']) {
  const btn = document.getElementById(id);
  if (btn) btn.onclick = () => sideCollapse();
}
{
  const handle = document.getElementById('side-unfold');
  if (handle) handle.onclick = () => sideExpand();
}

// ⚠️⚠️ 工作目录那一行**本身就是按钮**（0.9.127）——
//   原来是"一行说明文字 + 一个「打开」按钮"，而那两个是同一件事
//   （显示目录的唯一用途就是点开看看）⟹ 合成一个控件，省掉一个按钮。
if (aiEl('ai-dir')) {
  aiEl('ai-dir').onclick = async () => {
    // ⚠️ 不传参数 = 打开我们自己的壁纸目录（见 main.js 的 reveal-wallpaper-dir）
    await window.gw.revealWallpaperDir();
  };
}

if (aiEl('ai-key-save')) {
  aiEl('ai-key-save').onclick = async () => {
    const input = aiEl('ai-key');
    const value = input ? input.value.trim() : '';
    const r = await window.gw.genSetKey(value);
    // ⚠️ 保存后**重读一次** —— 那是"真的存下来了"的唯一证据。
    //   这个项目刚为"以为存了其实没存"栽过一轮。
    await aiRefreshMeta();
    aiSay(r && r.hasKey ? 'ok' : 'bad',
      r && r.hasKey ? '存好了（在本机配置文件里）' : '清空了：现在没有凭证');
  };
}

if (aiEl('ai-ping')) {
  aiEl('ai-ping').onclick = async () => {
    // ⚠️ 这个按钮的全部价值是**把连通性问题和生成失败分开** ——
    //   生成失败有十几种原因，而"key 填错了"应该 3 秒内就知道。
    aiSay('step', '测连通…');
    const r = await window.gw.genPing();
    if (!r || !r.ok) { aiSay('bad', `不通：\n${(r && r.error) || '没说原因'}`); return; }
    // ⚠️⚠️ **"通了"不等于"能用"**（0.9.126）。用户 2026-08-02 撞到的：
    //   探针通了，而生成壁纸返回空正文 —— 因为模型是推理型的，把 16000
    //   输出 token 全烧在 reasoning_content 上，一行 HTML 都没写。
    //   账单印证：2 次请求 17,304 token，输出正好 16,000。
    //   ⟹ 探针现在要求它写一行代码并看有没有思考过程，
    //     有的话**当场提醒换模型** —— 那比让用户先等几分钟再失败好得多。
    if (r.thinks) {
      aiSay('bad', `连通没问题（模型回了「${r.reply || '（空）'}」），`
        + `\n⚠️ 但 ${r.model} 是**推理模型**：它写了 ${r.reasoningChars} 字的思考过程。`
        + '\n\n生成一整张壁纸要上千行代码，而推理模型会把输出预算先花在思考上，'
        + '常常思考到上限就结束了、一行代码都没写（症状是"没返回内容"）。'
        + '\n\n⟹ 建议换一个**非推理**模型。改法：设置 → 开发者选项里改配置，'
        + '或者告诉我你想用哪个，我改默认值。'
        + '\n（也可以直接试：预算已经提到 32000，也许够它写完。）');
      return;
    }
    aiSay('ok', `通了：${r.model} 回了「${r.reply}」`
      + (r.outputTokens ? `（输出 ${r.outputTokens} token，没有思考过程 ⟹ 适合写代码）` : ''));
  };
}

// 进度：主进程每一步都推过来。
// ⚠️ 一次生成要几十秒到几分钟，而**没有进度的等待和卡死分不开**。
// ⚠️⚠️⚠️ **同一步的进度要原地刷新，不能每次新增一条**（0.9.143）。
//   用户 2026-08-02：「首先不应该是刷屏的，应该是那种原地刷新状态」
//   ⟹ 我 0.9.142 每 3 秒 aiSay 一条 ⟹ 等 198 秒就是 66 条
//     「已等 N 秒」把对话流冲掉了（终端里也一样）。
//   ⟹ 判据：**"它还活着"是一个状态，不是一串事件。**
//     状态该原地更新；只有"进了下一步"才是新事件。
//
// ⚠️ 做法：记住上一条 step 节点和它的 stage。stage 没变就改那个节点的文字，
//   变了才新建一条 ⟹ 对话流里每一步只留一行，而秒数在原地走。
let aiLastStepNode = null;
let aiLastStepStage = null;

function aiResetSteps() {
  aiLastStepNode = null;
  aiLastStepStage = null;
}

window.gw.onGenProgress((p) => {
  if (!p || !p.stage) return;
  // done / failed 有自己的收尾消息（在 aiGo 里），这里不重复报
  if (p.stage === 'done' || p.stage === 'failed') { aiResetSteps(); return; }
  const text = p.detail ? `${p.stage} · ${p.detail}` : p.stage;
  // ⚠️ 同一步 ⟹ 改原来那条。⚠️ 而要判 `isConnected` —— 用户可能清了对话流
  //   （那时旧节点还在变量里但已经不在文档上，改它等于什么都没做）
  if (aiLastStepStage === p.stage && aiLastStepNode && aiLastStepNode.isConnected) {
    aiLastStepNode.textContent = text;
    return;
  }
  aiLastStepStage = p.stage;
  aiLastStepNode = aiSay('step', text);
});

// ⚠️⚠️ **生成完的四个读数**（0.9.141）。用户 2026-08-02：
//   界面上要能看到"能不能跑"，而"好不好看"由他判。
// ⟹ 判据：**两者要在同一屏上** —— 否则他没法说"它好看但卡"。
let aiLastDir = null;

function aiRenderResult(r) {
  const box = aiEl('ai-checks');
  const img = aiEl('ai-preview');
  const rec = aiEl('ai-recipe');
  const shotWrap = aiEl('ai-preview-wrap');

  // ── 预览图（生成时截的那一帧）
  if (img) {
    if (r && r.dir) {
      // ⚠️ 加时间戳绕开缓存 —— 同一个路径的图换了内容，不加的话显示旧的
      img.src = `file://${encodeURI(r.dir)}/preview.jpg?t=${Date.now()}`;
      // ⚠️ 截图可能失败（那不算生成失败）⟹ 加载不出来就把**整块**收起来，
      //   而不是留一个破图标。⚠️ 0.9.153 起要收的是外层那个可点的 wrap。
      img.onerror = () => { if (shotWrap) shotWrap.hidden = true; };
    }
  }

  // ── 四个读数：全部来自试跑的真实观测，不是我猜的
  if (box) {
    const h = (r && r.history && r.history[r.history.length - 1]) || null;
    const pr = h && h.probe;
    if (!pr) { box.hidden = true; } else {
      const gl = pr.webgl || {};
      const px = pr.sampledPixels;
      const fps = pr.ms > 0 ? (pr.frames / (pr.ms / 1000)) : 0;
      const mark = (ok) => (ok ? '✓' : '✗');
      // ⚠️⚠️ 读数分两组：**能不能跑**（上面四条）和**像不像目标**（下面三条）。
      //   ⚠️ 后者带参考区间 —— 那让"这张和目标差在哪"是看一眼就知道的事，
      //     而不用用户说"不好看"（那句话没法改进任何东西）。
      const lines = [
        `${mark(gl.context)} WebGL      ${gl.context ? '正常' : '建不起来'}`
          + (gl.glError ? `（gl.getError=${gl.glError}）` : ''),
        `${mark(fps >= 8)} 渲染       ${fps.toFixed(1)} fps（${pr.frames} 帧 / ${pr.ms}ms）`,
        `${mark(gl.objects > 0)} 场景       ${gl.objects} 个对象`,
      ];
      if (px && px.total) {
        const blackPct = (100 * px.black) / px.total;
        const brightPct = (100 * (px.bright || 0)) / px.total;
        lines.push(`${mark(px.black / px.total <= 0.995)} 画面       `
          + `${px.total - px.black}/${px.total} 个采样点有内容`);
        // ⚠️ 参考区间来自参考壁纸的实测（见 wallpaper-gen.js 那段）
        lines.push(`${mark(blackPct >= 8)} 留白       ${blackPct.toFixed(0)}%`
          + `（目标 20-45%）`);
        lines.push(`${mark(brightPct <= 45)} 高亮       ${brightPct.toFixed(0)}%`
          + `（目标 5-20%）`);
        if (Number.isFinite(px.satMedian)) {
          lines.push(`${mark(px.satMedian <= 0.72)} 饱和度     ${px.satMedian.toFixed(2)}`
            + `（目标 0.30-0.34，越低越高级）`);
        }
        if (Array.isArray(px.bands)) {
          lines.push(`  明暗       上 ${px.bands[0].toFixed(0)} / 中 `
            + `${px.bands[1].toFixed(0)} / 下 ${px.bands[2].toFixed(0)}`
            + `（目标 25 / 90 / 50）`);
        }
      }
      // ── ⚠️⚠️ **动不动**（0.9.151）—— 用户连着两次说"动态的部分太少了"，
      //   而那件事之前**面板上根本看不到**（我只截一帧）。
      const mo = pr.motion;
      if (mo && mo.frames >= 3) {
        const spread = mo.diffMax > 0 ? 1 - mo.diffMin / mo.diffMax : 0;
        lines.push(`${mark(mo.diffAvg >= 1.5)} 在动       帧间变化 ${mo.diffAvg.toFixed(1)}`
          + `（目标 ~24）`);
        // ⚠️ 这一条是"有没有节奏" —— 匀速运动的波动接近 0
        lines.push(`${mark(spread >= 0.25)} 节奏       变化幅度波动 ${(100 * spread).toFixed(0)}%`
          + `（目标 >25%，参考壁纸 78%）`);
        lines.push(`${mark(mo.lumStd >= 1.2)} 呼吸       亮度起落 ±${mo.lumStd.toFixed(1)}`
          + `（目标 ~13）`);
      } else {
        lines.push('  画面       （没截到图）');
      }
      box.textContent = lines.join('\n');
      box.hidden = false;
    }
  }

  // ── ⚠️ 这里原来显示"配方"（0.9.140-145 那套五维枚举）—— 0.9.146 拆了。
  //   ⟹ 换成显示**还剩哪几处没达标**，那才是用户下一步能用上的信息。
  if (rec) {
    const soft = ((r && r.problems) || []).filter((x) => String(x.id).startsWith('C-'));
    if (soft.length) {
      // ⚠️ 只显示"是什么"，不显示"怎么改" —— 后者是给模型看的（回喂用），
      //   而用户要的是"差在哪"。⟹ 判据：同一份数据给人和给模型的粒度不同。
      rec.textContent = `还差：${soft.map((x) => x.id.replace(/^C-/, '')).join('、')}`;
      rec.hidden = false;
    } else { rec.hidden = true; }
  }

  // ── ⚠️ 装载入口挪到预览图上了（0.9.153，原来那个"用这张"按钮用户说太丑）
  aiLastDir = (r && r.dir) || null;
  if (shotWrap) shotWrap.hidden = !aiLastDir;
}

async function aiGo() {
  if (aiBusy) return;
  const input = aiEl('ai-want');
  const want = input ? input.value.trim() : '';

  // ⚠️⚠️⚠️ **一句话 = 一次任务 = 一张壁纸，从零开始**（0.9.146）。
  //   用户 2026-08-03：「我理解我们说一句话，然后是一次任务吗？一张壁纸，
  //     那我要做下一张壁纸呢，是不是不应该记忆留存的吧？应该从零开始，
  //     就是我们先不做记忆系统」
  //   ⟹ 判据：**没被要求的状态就别引入。** 上一次的对话/配方/历史都不参与
  //     这一次 —— 那让"这次为什么和上次不同"连问题都不是。
  //   ⚠️ 所以每次开始就**清空对话流** —— 留着上一次的记录会让人以为
  //     模型看得到它（而它看不到）。⟹ 界面不该暗示不存在的能力。
  if (aiLog) aiLog.textContent = '';
  aiResetSteps();
  // ⚠️ 上一次的结果也清掉（预览图/读数）
  aiRenderResult(null);

  // ⚠️⚠️ **空着也能生成**（0.9.146）—— 内置提示词本身就是完整的设计，
  //   用户那句话是**补充**不是必需（他可能就想看看默认长什么样）。
  //   ⟹ 我原来是"先说一句你想要什么效果"然后 return，那让"点一下试试"
  //     这条最自然的路走不通。
  aiSay('me', want || '（按内置的设计做一张）');
  // ⚠️⚠️ **立刻清输入框** —— 而不是等成功之后。用户 2026-08-03：
  //   「我一句话发上去，然后那句话留的数框」
  //   ⟹ 消息已经进对话流了，框里再留一份是重复的；而清空之后
  //     他能马上打下一句（生成期间就能想）。
  if (input) input.value = '';
  aiSetBusy(true);
  try {
    const r = await window.gw.genWallpaper({ want });
    if (!r || !r.ok) {
      aiSay('bad', `没做出来：\n${(r && r.error) || '没说原因'}`);
      // ⚠️ 缺 key 是最常见的一种，而它有明确的下一步 ⟹ 把折叠区展开
      if (r && r.needsKey) {
        const wrap = aiEl('ai-key-wrap');
        if (wrap) wrap.open = true;
      }
      return;
    }
    aiRenderResult(r);
    // ⚠️⚠️ `partial` 那个字段 0.9.142 就没了（三轮没过的硬问题现在
    //   **不搬进壁纸目录**，走 `ok: false`）⟹ 这里只剩 `softOnly` 一种：
    //   能跑，但构图上和参考壁纸不一样。
    //   ⚠️ 而它**必须说清是哪几处** —— 否则用户看到一张不满意的壁纸
    //     只能说"不好看"，而那句话没法改进任何东西。
    if (r.softOnly) {
      aiSay('bad', r.note);
    } else {
      aiSay('ok', `做好了：${r.dirName}\n`
        + `（${r.rounds} 轮通过全部检查）\n`
        + '下面的壁纸网格已经刷新：点那张卡片就能装载看效果。');
    }
    // ⚠️⚠️ **刷新网格** —— 这是这个功能的全部反馈来源。
    //   用户原话：「我左边这个预览直接就是指定位置，那我可以看到这个预览图的
    //   就很直观」⟹ 生成完网格立刻多一张卡片。
    //   ⚠️ 主进程那边**没有**广播"库变了"（我第一版写了个 `library-changed`，
    //     而那个频道根本没人听 —— 静默 no-op）⟹ 刷新在这里做，
    //     用现成那条已经在工作的路（renderMine 本来就是重扫磁盘的入口）。
    if (typeof renderMine === 'function') await renderMine();
  } catch (error) {
    aiSay('bad', `出错了：${error.message}`);
  } finally {
    aiSetBusy(false);
  }
}

if (aiEl('ai-go')) aiEl('ai-go').onclick = aiGo;

// ⚠️ **点预览图 = 装载它**（0.9.153）。用户 2026-08-03：
//   「生成好一张图片后不要那个"用这张"按钮，太丑了」
//   ⟹ 而装载这个能力得留 ⟹ 挪到预览图上（图就是那张壁纸，点它 = 用它）。
//   ⚠️ 判据：**一个功能不该因为它的按钮丑就被删掉** —— 该搬到更自然的位置。
// ⚠️ 而**不关闭 AI 工坊** —— 用户可能想接着再生成一张，
//   而"点了就把面板收走"会打断那个节奏。
if (aiEl('ai-preview-wrap')) {
  aiEl('ai-preview-wrap').onclick = async () => {
    if (!aiLastDir) return;
    const out = await window.gw.workshopLoadLocal(aiLastDir);
    if (out && out.ok) {
      aiSay('ok', '装上了，看桌面。不满意就再说一句，会生成新的一张。');
      if (typeof renderMine === 'function') await renderMine();
    } else {
      aiSay('bad', `装载失败：${(out && out.error) || '没说原因'}`);
    }
  };
}
// ⚠️ ⌘↵ / Ctrl+↵ 发送 —— textarea 里裸 Enter 要留给换行（描述常常是两三句）。
if (aiEl('ai-want')) {
  aiEl('ai-want').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); aiGo(); }
  });
}
} catch (error) {
  console.error('[dashboard] AI 壁纸工坊初始化失败：', error);
}

window.gw.getConfig().then(apply).catch((error) => {
  // apply 自己抛的话开关全绑不上，那是最坏的情况 —— 必须能看见。
  console.error('[dashboard] apply() 失败，开关可能都没绑上：', error);
});
renderWEStatus();
