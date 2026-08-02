// AI 生成壁纸 —— 提示词、机器闸门、回喂循环。
//
// ⚠️⚠️⚠️ **这个功能的成败不在"能不能调 API"（那是 30 行），在"生成完怎么收敛"。**
//
// 用户 2026-08-02：「你说做不出来，纯属跟我扯淡呢，这个东西你拆成不烂，
//   找一下性啥的写好提示词设计一套 agent 的那种流程肯定能做出来的呀」
//
// **他说得对，而我原来那句话框错了问题** —— 我说的是"一次性生成做不到"，
// 而他问的是"拆开、设计流程能不能做到"。那是两件事。
// 而他抓的那个点正是关键：**粒子效果不需要素材，它就是代码**
// ⟹ 产物完全在模型能力范围内，瓶颈只在"一轮出不来"，而那是流程问题。
//
// ⚠️⚠️ 实测（2026-08-02，Bedrock Sonnet 4.5，一轮，268 行）：
//   ✅ 单文件 / 零外部依赖 / 语法过 / 限帧 / wallpaperReady / 音频 128 值分段正确
//   ❌ 鼠标**一个事件都没接**（全文只有一个 addEventListener，是 resize）
//   ❌ 没有 dpr 处理
//   ⟹ 一轮已经过了大半硬约束，剩下的全是"清单式缺陷" —— 正好是能收敛的类型。
//
// ⚠️⚠️⚠️ **而"模型审模型"的结论不能直接采信** —— 同一次实测里我让模型审自己的
//   产物，它判错了两次，方向还相反：
//     · 鼠标那条（真的完全没接）它判 **pass** —— 漏报
//     · Math.random 那条（只在粒子诞生时随机，是对的）它判 **fail** —— 误报
//   ⟹ **能用代码判的必须用代码判。** `grep e.buttons` / `node --check` /
//     `grep -c addEventListener` 这几条零成本、零假阳性，而它们当场把漏报逮住了。
//   ⟹ 所以闸门分层，而模型那层**只当建议不当闸门**：
//       ① 机器闸门（这个文件，确定性）
//       ② 真跑闸门（隐藏窗口 3 秒：JS 报错 / fps / 是不是纯黑 —— 在 main.js）
//       ③ 模型审美（"好不好看" —— 只有这层交给模型，且不否决）
//
// 云端能验的：①（纯函数）。云端验不了的：②（要 Electron 窗口）。
// ⟹ ① 全部抽成纯函数放这里，②的判定逻辑也放这里（只收数据不开窗口），
//   这样窗口那边只负责"跑起来收集数据"。

'use strict';

// ---------------------------------------------------------------------------
// ⚠️⚠️⚠️ **骨架契约**（0.9.140 起，模型面对的是这个，不是宿主接口）
// ---------------------------------------------------------------------------
//
// 用户 2026-08-02 定的架构：**固定骨架 + 模型只填变化**。
// ⟹ 模型现在只写一个 `scene.js`（`window.SCENE` 那两三个函数），
//   而 WebGL/相机/渲染循环/限帧/音频算法/宿主接线**全部由骨架管**。
//
// ⚠️ 判据：把"会坏的部分"写死、验过（实测：一次性写整个 index.html 三轮
//   收敛出的是 300 行 canvas，而参考壁纸是作者 v1→v15 迭代出来的）。
//
// ⚠️⚠️ 而这段**必须和 `wallpaper/skeleton/runtime.js` 里真的给出去的 ctx 对得上** ——
//   错一个字段名，模型写的代码就是 `undefined.xxx`（而那是运行时才炸）。
//   ⟹ 有守卫盯着（见 gen.test.js）。
const SKELETON_API = `# 你要写的是 \`scene.js\`，只挂一个 \`window.SCENE\`

\`\`\`js
window.SCENE = {
  build(ctx)     { /* 建元素，加进 ctx.scene */ },
  frame(ctx)     { /* 每帧更新 */ },
  reconfig(ctx)  { /* 可选：参数变了要重建元素个数时 */ },
  layout(ctx)    { /* 可选：窗口尺寸变了要重排时 */ },
};
\`\`\`

## ctx 里有什么（骨架给的，全部可直接用）

| 字段 | 是什么 |
|---|---|
| \`ctx.THREE\` | three.js r128 的全部命名空间（**别自己 import**，它已经在了） |
| \`ctx.scene\` | THREE.Scene（已建好，把你的 Object3D \`add\` 进去） |
| \`ctx.camera\` | THREE.PerspectiveCamera（fov 52，aspect 自动跟着窗口）**你可以改它的位置/fov/lookAt** |
| \`ctx.renderer\` | THREE.WebGLRenderer（已建好、已 setSize，**别自己 render**，骨架每帧会调） |
| \`ctx.defaultLights\` | 装着默认灯光的 Group ⟹ 想换整套打光：\`ctx.scene.remove(ctx.defaultLights)\` 再加自己的 |
| \`ctx.audio\` | \`{ bass, mid, treble }\` 都是 0..1；\`bins[64]\` 是逐段值（低频→高频）；\`everGot\` 有没有收到过音频 |
| \`ctx.track\` | \`{ title, artist, thumbnail, primaryColor, playing }\`；primaryColor 是 \`[r,g,b]\`（0..1）或 null |
| \`ctx.pointer\` | \`{ x, y, down, dragX, dragY }\`；x/y 是 0..1；dragX/dragY 是累计拖拽像素 |
| \`ctx.opts\` | project.json 里那些参数（颜色已转成 \`[r,g,b]\` 数组）**每个都要有默认值** |
| \`ctx.t\` / \`ctx.dt\` | 秒（dt 已经夹了上限 0.1 并乘过 speed） |
| \`ctx.W\` / \`ctx.H\` | 画布 CSS 尺寸 |
| \`ctx.warn(msg)\` | 报一句进诊断报告（出问题时用户能看到） |

## 骨架已经做完的（**你别重做**）
限帧 40fps / dpr 上限 2 / resize / 音频 128 段的解析和峰值累积 / 宿主的
5 个 register 接线 / 未捕获异常上报 / 3 秒自检 / \`wallpaperReady()\`

## ⚠️ 硬要求
1. **只输出 scene.js 的内容**，一个 IIFE 包起来，挂 \`window.SCENE\`。
2. **不许**出现 \`new THREE.WebGLRenderer\` / \`requestAnimationFrame\` /
   \`renderer.render\` / \`addEventListener('resize'\` —— 那些骨架在做，重做会打架。
3. **不许**任何 import / require / fetch / CDN —— three 已经在 \`ctx.THREE\`。
4. 元素数量多时用 \`InstancedMesh\`（N 个 Mesh = N 次 draw call ⟹ 帧率崩）。
   ⚠️ 改了 instance 的 matrix/color 之后**必须**置
   \`needsUpdate = true\`，否则画面完全静止而不报错。
5. **每帧的位置不许用 Math.random()** —— 那看起来是雪花噪点。
   位置要么由索引+时间决定，要么存进数组各自积分运动（诞生时随机是对的）。
6. **没音乐时也要好看**（\`ctx.audio.everGot\` 可能一直是 false）——
   加一个自走的运动（呼吸/漂移/自转），音频只是叠加在上面。
7. 不许 alert / confirm / prompt / debugger。`;

// ---------------------------------------------------------------------------
// 契约：喂给模型的接口说明（宿主层 —— 骨架在用，模型一般不直接碰）
// ---------------------------------------------------------------------------
//
// ⚠️⚠️ 这段**不是我凭记忆写的 prompt** —— 它逐条对应 `we-preload.js` 里
//   `contextBridge.exposeInMainWorld` 真的暴露出去的东西。
//   ⚠️ 判据：喂给模型的契约错一个字，产出就是"看起来对但接不上"，
//     而那种失败查起来比白屏烦得多（画面在动，只是永远不跟音乐）。
//   ⟹ 改 we-preload.js 的接口时**必须同步改这里**，有守卫盯着（见 gen.test.js）。
const CONTRACT = `# 宿主提供的接口（这是真实契约，逐条对应播放器的实现）

window.wallpaperRegisterAudioListener(cb)
  cb(data) —— data 是 128 个 0..1 的数：左声道 0-63、右声道 64-127，每声道低频→高频。
  ⚠️ 取两声道对应位置的平均再分频段。回调比渲染帧快 ⟹ 用 Math.max 累积峰值，
     直接赋值会让两帧之间的峰值被抹掉（症状是"不跟音乐"）。

window.wallpaperRegisterMediaPropertiesListener(cb)
  cb({ title, artist, albumTitle })

window.wallpaperRegisterMediaThumbnailListener(cb)
  cb({ thumbnail, primaryColor, textColor })
  thumbnail 是 data URL（可能是空字符串 —— 拿不到封面是常态，不是异常）
  primaryColor 是 "r g b" 三个 0..1 浮点拼的字符串，不是 #rrggbb

window.wallpaperRegisterMediaPlaybackListener(cb)
  cb({ state }) —— 0=播放 1=暂停 2=停止
  也可以读 window.wallpaperMediaIntegration.PLAYBACK_PLAYING（是 0）

window.wallpaperRegisterMediaTimelineListener(cb)
  cb({ position, duration }) —— 单位是秒

window.wallpaperReady()
  起来了就调它。宿主靠它判断"页面里的 JS 真的活着" ——
  那是区分"白屏因为加载失败"和"白屏因为渲染有问题"的唯一观测点。

鼠标：宿主把桌面上的真鼠标事件注入到 window（壁纸层收不到原生事件）。
  mousemove / mousedown / mouseup / wheel / click
  ⚠️ 拖拽必须靠 e.buttons（位掩码，1=左键）判断，不能只监听 mousemove ——
     宿主把"拖拽中的移动"注入成带 button 的 mouseMove。

可调参数（可选）：挂 window.wallpaperPropertyListener = { applyUserProperties(props) {} }
  props 的每个键是 { value: ... }。这个方向是页面挂给宿主的，和上面几个相反。`;

// ⚠️⚠️ 硬约束 —— 每一条都有**具体的踩坑来历**，所以每条都带上"为什么"。
//   不带理由的约束模型会当成偏好，带了理由它会当成需求。
const CONSTRAINTS = `# 硬约束（每条都不能破）

1. **单个 index.html，自包含。** 不许有 CDN / import / <script src> / <link href> /
   任何网络请求 / 任何外部文件。壁纸跑在自定义协议下，而用户机器可能没网。
   ⟹ 不许用 React / Three.js / p5 等需要打包或外链的库。

2. **只用 canvas 2d 或 WebGL（shader 内联在 HTML 里）。**
   ⚠️ 优先 canvas 2d：WebGL 的失败模式（着色器编译失败 / context 丢失 / 驱动差异）
      全都表现为黑屏，而壁纸层没有 devtools 入口。

3. **必须限帧，上限 40fps。** 它是常驻后台进程。
   写法：requestAnimationFrame 里 if (now - last < 1000/40) return;
   ⚠️ 这个项目为"壁纸吃满 CPU"栽过一轮（ctx.filter 每秒 1.3G 像素，把主线程挤死）。

4. **canvas 尺寸跟随 resize，devicePixelRatio 上限 2。**
   dpr = Math.min(window.devicePixelRatio || 1, 2)
   ⚠️ 3 倍屏上按 3 渲染 = 2.25 倍像素量，对常驻进程不值得。

5. **每个 window.wallpaperXxx 都要 if 保护。** 这个页面可能被直接在浏览器里打开
   （开发时），那时它们全不存在 ⟹ 要能跑（静止也行），不能白屏报错。

6. **每帧的粒子位置不能用 Math.random() 现算。** 随机的话粒子每帧跳到别处，
   看起来是雪花噪点而不是飘浮的尘。
   ⟹ 要么位置由索引和时间决定，要么把粒子存进数组各自积分运动（诞生时随机是对的）。

7. **没有音乐时也要好看。** 拿不到音频/封面/歌名是常态（用户可能没在放歌）。
   ⟹ 静止状态必须是一个完整的画面，不是一个空洞或者一片纯黑。

8. **不许 alert / confirm / prompt / debugger。** 壁纸层没人能点掉那个框。

9. **不许 setInterval 画帧。** 用 requestAnimationFrame ——
   后台标签页里 setInterval 会堆积，而壁纸窗口可能被系统降频。`;

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------
function buildScenePrompt(userWant, recipe, recipeText, historyText, example) {
  return `你在为一个 macOS 动态壁纸播放器写一个 3D 场景。

${SKELETON_API}

# ⚠️⚠️ 这一张要用的"配方"（**必须照它做**）

${recipeText}

⚠️ 这五个维度是**指定的**，不是建议 —— 照着做。
   而在每个维度内部你有充分自由（比如 layout=ring 时，几个环、疏密、
   环之间怎么错开、元素是方块还是细杆，都你定）。

# ⚠️⚠️⚠️ 已经生成过的组合（**避开它们**）

${historyText}

⚠️ 用户的原话：「我不希望同质化很严重，同一种风格的是允许的，但是每次生成
   给人感觉说这不是一样的吗，这就不行」
⟹ 上面那些是已经有的。而**底色、雾、打光**是"第一眼"看到的东西 ——
   照配方里的 palette 和 environment 做，别落回"深蓝黑底 + 一个顶光"那个默认。

# 用户这次想要的
${userWant || '（没特别要求，按配方做一个好看的）'}

# 参考实现（**风格参考，不是照抄** —— 它的配方和你的不一样）
\`\`\`js
${example}
\`\`\`

# 输出
只输出 scene.js 的完整内容（一个 IIFE，挂 window.SCENE）。
⚠️ 在文件开头用注释写一行：\`// 配方：layout=… audioMap=… palette=… motion=… environment=…\`
   那是给人看的（出问题时能对上配方）。
⚠️ 直接开始写代码，不要先长篇分析 —— 预算要留给代码本身。
不要 markdown 围栏、不要解释。`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  ⚠️⚠️⚠️ **拆成三步**（0.9.142）。用户 2026-08-02：
//    「一次有偷看上限，说明他一次干不下来这个活，那我们都已经有骨架了，
//      完全可以把这个活做拆分吗？多用几次模型就 OK 了呀，然后有一个 AI 自己的
//      工作区中间文件到文档留存方便，就是一步一步可以衔接上就行了呀」
//
//  ⚠️ 而这修的是一件**实测发生过**的事：一次调用要模型同时决定
//    "长什么样"+"怎么写代码"，而推理模型在前半件事上就把预算烧光了
//    （69,841 字 reasoning_content、正文一个字没写）。
//
//  ⟹ 三步，每步的产物落在**工作区**里（`plan.md` / `scene.js`）：
//     ① 设计（写 plan.md）—— 只输出文字，几百 token，不写代码
//     ② 实现（读 plan.md 写 scene.js）—— 设计已经定了，它只管翻译成代码
//     ③ 修（读闸门报告 + scene.js）—— 已有
//
//  ⚠️ 判据：**"想"和"写"分成两次调用，各自的预算就不会互相挤。**
//    而中间产物落盘让"上一步到底想了什么"可回看 —— 那是失败时唯一的线索。
//
//  ⚠️ 而**步骤是写死的**（不是让模型决定下一步做什么）⟹ 这仍然是 workflow。
function buildPlanPrompt(userWant, recipeText, historyText) {
  return `你要为一个 macOS 动态壁纸设计一个 3D 场景。**这一步只做设计，不写代码。**

# ⚠️⚠️ 这一张要用的"配方"（**必须照它做**）

${recipeText}

⚠️ 这五个维度是**指定的**，不是建议。而在每个维度内部你有充分自由
   （比如 layout=ring 时，几个环、疏密、环之间怎么错开、元素是方块还是细杆，都你定）。

# ⚠️⚠️⚠️ 已经生成过的组合（**避开它们**）

${historyText}

⚠️ 用户的原话：「我不希望同质化很严重，同一种风格的是允许的，但是每次生成
   给人感觉说这不是一样的吗，这就不行」

# 用户这次想要的
${userWant || '（没特别要求，按配方做一个好看的）'}

# 输出：一份设计说明（markdown，**不要代码**）

按这几个小标题写，每条都要**具体到能直接照着写代码**：

## 元素
几个、什么几何体、多大、怎么排（给出具体的坐标规律或公式）

## 相机
位置、朝向、视野；会不会动（怎么动）

## 环境
底色（给 hex）、雾（用不用、near/far）、灯光（几个、什么类型、颜色、方向、强度）
⚠️ 照配方里的 environment 做，别落回"深蓝黑底 + 一个顶光"那个默认

## 配色
主色和辅色的具体 HSL 范围，怎么随音频/位置变

## 音频映射
bass / mid / treble 各驱动什么，具体的数值范围（比如"bass 0→1 映射到高度 0.2→8"）

## 空闲动画
没有音乐时怎么动（**必须有** —— 否则用户会以为坏了）

⚠️ 300-500 字，别更长。这是给下一步写代码用的规格书，不是文章。`;
}

// ⚠️ 第二步：拿着自己的设计写代码。
//   ⚠️⚠️ 这一步**不再给它配方和历史** —— 那些已经消化进 plan 了，
//     再给一遍会让它重新做设计决定（而那正是我们要避免的"一次干两件事"）。
//   ⚠️ 判据：**每一步只给它这一步需要的东西。** 多给的信息会被当成任务。
function buildImplementPrompt(plan, example) {
  return `照下面这份设计说明写 scene.js。**设计已经定了，你只管把它翻译成代码。**

# 设计说明（你上一步写的）
${plan}

${SKELETON_API}

# 参考实现（**看它的写法，不是抄它的设计** —— 它的设计和你的不一样）
\`\`\`js
${example}
\`\`\`

# 输出
只输出 scene.js 的完整内容（一个 IIFE，挂 window.SCENE）。
⚠️ 在文件开头用注释写一行：\`// 配方：…\`（照设计说明里的）
⚠️ 直接开始写代码，不要复述设计、不要解释 —— 设计已经在上面了。
不要 markdown 围栏。`;
}

// ⚠️⚠️ 回喂：把**机器闸门的原文**给模型，不是我转述的结论。
//   ⚠️ 判据：转述会丢信息（"缺鼠标处理"和"全文只有一个 addEventListener 且是
//     resize"对模型是两种信息量），而丢的那部分正是它需要用来定位的。
function buildRepairPrompt(previousCode, problems, recipeText) {
  return `你上一版写的 scene.js 没通过自动检查。下面是检查器的原始输出。

# 检查器报告
${problems.map((x, i) => `${i + 1}. [${x.id}] ${x.detail}`).join('\n')}

${SKELETON_API}

# 这一张的配方（保持不变）
${recipeText}

# 上一版代码
\`\`\`js
${previousCode}
\`\`\`

# 要做的事
修掉上面每一条。**保留原来的视觉设计和配方** —— 这是修复，不是重写。
只输出修好的 scene.js 完整内容。
⚠️ 直接开始写代码，不要先长篇分析 —— 预算要留给代码本身。
不要 markdown 围栏、不要解释。`;
}

// ---------------------------------------------------------------------------
// 模型输出的清洗
// ---------------------------------------------------------------------------
//
// ⚠️⚠️ 模型**经常**不听"不要 markdown 围栏"（我实测那轮听了，但那不能当保证）。
//   而一个带 ``` 的 HTML 首行会让整个文件白屏 ⟹ 这里必须兜。
//   ⚠️ 而且要兜"围栏 + 前后废话"两种：有时它会写一句"这是生成的壁纸："再给代码。
//   ⟹ 判据：**从 `<!DOCTYPE` 或 `<html` 切到最后一个 `</html>`** ——
//     那是唯一不依赖模型听话的定位方式。
function extractScene(text) {
  const raw = String(text || '');
  let body = raw;
  // ⚠️ 模型经常不听"不要 markdown 围栏"（实测过）⟹ 这里必须兜。
  const fence = body.match(/```(?:js|javascript)?\s*\n([\s\S]*?)```/i);
  if (fence) body = fence[1];
  body = body.trim();

  // ⚠️⚠️ 判据：**必须能看到 `window.SCENE`** —— 那是这个文件唯一的作用。
  //   看不到就说明模型输出的不是我们要的东西（比如它写了整个 HTML，
  //   或者它在解释而不是写代码）。
  if (!/window\.SCENE\s*=/.test(body)) {
    throw new Error('模型没有输出 scene.js（找不到 `window.SCENE =`）。'
      + `它给的开头是：${raw.slice(0, 200)}`);
  }
  // ⚠️ 而如果它写了整个 HTML，那是**理解错了任务** —— 明确报出来，
  //   而不是让一份 HTML 被当成 JS 写进 scene.js（那会白屏）。
  if (/<!DOCTYPE|<html[\s>]|<script[\s>]/i.test(body)) {
    throw new Error('模型输出了 HTML —— 这一版只要 scene.js（骨架那些文件我们自己给）');
  }
  return body;
}

// ---------------------------------------------------------------------------
// ① 机器闸门 —— 确定性检查，零假阳性
// ---------------------------------------------------------------------------
//
// ⚠️⚠️ 每一条的判据都是"**破了必然出事**"，不是"最好这样"。
//   偏好类的东西（配色、构图、节奏）一条都不放这里 —— 那些交给用户的眼睛。
//   ⚠️ 判据来源：实测那轮模型漏掉的正是能机器判的（鼠标、dpr），
//     而它自己审的时候把这些判成 pass。
//
// ⚠️ `checkJsSyntax` 由调用方注入 —— 语法检查要 `new Function` 或 vm，
//   而这个模块要能在测试里被纯粹地跑（不带副作用）。
function inspect(code, hooks) {
  const h = hooks || {};
  const problems = [];
  const add = (id, detail) => problems.push({ id, detail });
  const src = String(code || '');

  // ── A. 语法（白屏最常见的原因，而它 100% 能机器判）
  if (typeof h.checkJsSyntax === 'function') {
    const err = h.checkJsSyntax(src);
    if (err) add('A-语法错误', `scene.js 语法错误：${err}`);
  }

  // ── B. 契约：必须挂 window.SCENE 且有 build/frame
  if (!/window\.SCENE\s*=/.test(src)) {
    add('B-没挂 SCENE', '没有 `window.SCENE = {...}` ⟹ 骨架启动时会报"scene.js 没提供 SCENE"');
  }
  for (const fn of ['build', 'frame']) {
    // ⚠️ 两种写法都认：`build(ctx) {` 和 `build: (ctx) =>`
    if (!new RegExp(`${fn}\\s*[(:]`).test(src)) {
      add('B-缺函数', `SCENE 里没有 ${fn}() ⟹ 骨架会拒绝启动`);
    }
  }

  // ── C.⚠️⚠️ **只拦"会打架"和"会坏"的，不拦"我没想到的写法"**
  //
  // 用户 2026-08-02：「我给你的骨架仅仅是说一种想要在有限空间内高质量的
  //   一种手段，本质上我们其实还是 agent，不要太死板了」
  // ⟹ 判据：**闸门守的是"必然出事"，不是"不符合我的预期"。**
  //   一条拦住了正确写法的闸门比没有闸门更贵 —— 它会让模型去改一段本来对的
  //   代码（而这个项目实测栽过：F 闸门连着三轮误报粒子诞生的 Math.random，
  //   模型每次都是对的）。
  const FORBIDDEN = [
    // ── 会和骨架打架的（两个渲染循环 / 两次 setSize ⟹ 撕裂、帧率减半）
    [/new\s+THREE\.WebGLRenderer/, '自己建了 WebGLRenderer —— 骨架已经建好在 ctx.renderer'],
    [/requestAnimationFrame/, '自己起了渲染循环 —— 骨架每帧会调 SCENE.frame，两个循环会打架'],
    [/renderer\.render\s*\(/, '自己调了 renderer.render —— 骨架每帧会调，重复渲染等于帧率减半'],
    [/addEventListener\s*\(\s*['"]resize/, '自己监听了 resize —— 骨架会调 SCENE.layout'],
    // ── 在这个环境里**跑不起来**的
    [/\bimport\s+[\w{*]/, 'ES import —— scene.js 是普通 script，three 已经在 ctx.THREE'],
    [/\brequire\s*\(/, 'require —— 壁纸跑在浏览器环境，而且 three 已经在 ctx.THREE'],
    [/\b(fetch|XMLHttpRequest)\s*\(/, '网络请求 —— 壁纸不许联网（用户机器可能没网，而失败是静默的）'],
    [/<script|<!DOCTYPE|<html[\s>]/i, 'HTML 标签 —— 这个文件是纯 JS（骨架那些文件我们自己给）'],
    // ── 用户体验上不能有的
    [/\b(alert|confirm|prompt)\s*\(/, '模态框 —— 壁纸层在桌面最底下，没人能点掉'],
    [/\bdebugger\b/, 'debugger 语句'],
  ];
  for (const [re, msg] of FORBIDDEN) {
    if (re.test(src)) add('C-重做骨架/禁用', msg);
  }

  // ⚠️⚠️⚠️ **而下面这些是"允许的"，写在这里防止以后有人把它们加进闸门**：
  //   · 换整套灯光（`scene.remove(ctx.defaultLights)` + 加自己的）—— 那是设计
  //   · 改 `scene.background` / `scene.fog` / 相机的一切 —— 那是设计
  //   · 自己建 Texture / CanvasTexture / ShaderMaterial / 后处理用的 RenderTarget
  //   · `setTimeout`（一次性的延迟，不是画帧）
  //   · 任何数学、噪声函数、自己实现的数据结构
  //   · `Math.random`（粒子诞生位置、初速度、相位都该随机 —— 见 F 那条）
  //   ⟹ 判据：**骨架是"在有限预算里稳定产出"的手段，不是审美的笼子。**
  //     它锁的是"会坏"（渲染循环 / 音频算法 / 错误上报），放的是"长什么样"。

  // ── D.⚠️ InstancedMesh 用了就必须置 needsUpdate
  //   （不置的话画面完全静止而**不报错** —— 这个坑在骨架注释里也写着）
  if (/InstancedMesh/.test(src)) {
    if (/setMatrixAt/.test(src) && !/instanceMatrix\.needsUpdate\s*=\s*true/.test(src)) {
      add('D-忘了 needsUpdate',
        '改了 instance matrix 但没置 `instanceMatrix.needsUpdate = true`'
        + ' ⟹ GPU 上还是上一帧的数据，画面完全静止而不报错');
    }
    if (/setColorAt/.test(src) && !/instanceColor[\s\S]{0,80}needsUpdate/.test(src)) {
      add('D-忘了颜色 needsUpdate',
        '用了 setColorAt 但没置 instanceColor.needsUpdate ⟹ 颜色不会变');
    }
  }

  // ── E.⚠️ 空闲状态：没音乐时也要动
  //   ⚠️ 只能弱判 —— 找"和 ctx.t 有关的运动"。查不到就提醒，不算硬错误。
  if (!/ctx\.t\b|\bt\s*\*|Math\.(sin|cos)\s*\(\s*(ctx\.)?t/.test(src)) {
    add('E-没有空闲动画',
      '看不到任何和时间（ctx.t）相关的运动 ⟹ 没放音乐时画面会完全静止，'
      + '而用户会以为壁纸坏了');
  }

  // ── F.⚠️⚠️⚠️ 每帧 Math.random 决定位置 = 雪花噪点
  //
  // ⚠️⚠️ **这条我第一版写错了，而它连报三轮、模型改不掉**（实测 2026-08-02）：
  //   模型写的是**粒子诞生**（`particles.push({ vx: Math.cos(a)*s, vy: 0.5+Math.random()*1.5 })`）
  //   —— 那正是我自己那条规则说"诞生时随机是对的"的情况，
  //   而我的正则只看"frame() 里有没有 Math.random 挨着 x/y/z"，分不出
  //   "诞生时随机一次"和"每帧重新随机"。
  //   ⟹ 症状：闸门 3 轮报同一条、模型每轮都改一遍别的地方，白烧 60 秒。
  //   ⚠️ 判据：**一条闸门如果模型改不掉，先怀疑闸门错了** ——
  //     它连报三轮而产物在变，那说明它指的不是模型能改的东西。
  //
  // ⟹ 收窄到真正坏的那个形状：**直接给已有对象的坐标赋随机值**
  //   （`p.x = Math.random()` / `obj.position.x = Math.random()`），
  //   而 `push({...Math.random()...})`（诞生）和 `vx: Math.random()`（初速度）都放过。
  //   ⚠️ 宁可漏报也不误报：误报会让模型去改一段本来正确的代码（而实测它改不动，
  //     只会白烧三轮）。
  const frameAt = src.search(/\bframe\s*[(:]/);
  if (frameAt > 0) {
    const frameBody = src.slice(frameAt, frameAt + 6000);
    // ⚠️ 只逮"赋值给某个已存在对象的位置分量"
    const bad = /\.(position\.)?[xyz]\s*=\s*[^;\n]{0,30}Math\.random/.test(frameBody)
      || /\.position\.set\s*\([^)]{0,60}Math\.random/.test(frameBody);
    if (bad) {
      add('F-每帧随机位置',
        'frame() 里把已有元素的位置**赋成**随机值 ⟹ 它每帧跳到别处，'
        + '看起来是雪花噪点而不是运动。'
        + '\n⚠️ 位置要由索引+时间决定，或者存进数组各自积分'
        + '（而"新粒子诞生时随机一次"是对的，那不算）');
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// ② 真跑闸门的判定（只判数据，不开窗口）
// ---------------------------------------------------------------------------
//
// ⚠️⚠️ 开窗口那部分在 main.js（要 Electron）。这里只做**判定** ——
//   那样它就能在云端被测到，而"判定逻辑错了"和"窗口没起来"是两类问题。
//
// ⚠️ 输入：{ ready, errors: [...], frames, ms, sampledPixels: {black, total} }
function judgeRuntime(probe) {
  const p = probe || {};
  const problems = [];
  const add = (id, detail) => problems.push({ id, detail });

  // ⚠️ JS 报错最优先 —— 它是白屏的直接原因，而且报错原文能直接回喂。
  for (const err of (p.errors || []).slice(0, 6)) {
    add('R-运行时报错', `页面里报错：${err}`);
  }

  if (p.ready === false) {
    add('R-没就绪', '页面没调 window.wallpaperReady() —— 要么它没调，'
      + '要么脚本在调到那一行之前就挂了（看上面的报错）');
  }

  // ⚠️ fps：分母是真实耗时，不是我假设的 3 秒 —— 窗口起得慢的话会把 fps 算低。
  if (Number.isFinite(p.frames) && Number.isFinite(p.ms) && p.ms > 500) {
    const fps = p.frames / (p.ms / 1000);
    // ⚠️ 阈值 8 而不是 20：**限帧到 40 的壁纸在离屏窗口里本来就慢**
    //   （不可见窗口会被 Chromium 降频）⟹ 20 那个阈值会把好产物砍掉。
    //   8 只用来逮"根本没在画"。
    if (fps < 8) {
      add('R-几乎不动', `${p.ms}ms 里只画了 ${p.frames} 帧（约 ${fps.toFixed(1)}fps）`
        + ' —— 要么动画循环没起来，要么每帧太重');
    }
  } else if (p.frames === 0) {
    add('R-一帧没画', '一帧都没画出来 —— requestAnimationFrame 循环没跑起来');
  }

  // ⚠️ 纯黑判定：**这是"跑起来了但什么都看不见"的唯一自动判据**，
  //   而那种失败在日志里完全干净（没报错、fps 正常）。
  const px = p.sampledPixels;
  if (px && px.total > 0) {
    const ratio = px.black / px.total;
    // ⚠️ 0.995 而不是 1.0 —— 有的壁纸主体很暗但有几个亮点，
    //   而"几乎全黑"和"全黑"在观感上是同一件事。
    if (ratio > 0.995) {
      add('R-画面全黑', `采样的 ${px.total} 个像素里 ${px.black} 个是近黑色`
        + '（画面基本什么都看不见）—— 常见原因：坐标算错画到屏幕外、'
        + '颜色 alpha 是 0、或者 shader 编译失败');
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// project.json —— 让生成的壁纸变成这个播放器认的东西
// ---------------------------------------------------------------------------
//
// ⚠️ type 必须是 `Web`（WE 的类型名，首字母大写）—— 播放器按它选渲染路径。
// ⚠️ `audio.enabled` 不写的话音频通道不会打开（症状：接了音频回调但永远收不到数据）。
function buildProjectJson(title, description, recipe) {
  return {
    title: title || 'AI 生成壁纸',
    // ⚠️ 这个字段名是 `file`（不是 `main` / `index`），值是相对路径。
    file: 'index.html',
    type: 'Web',
    audio: { enabled: true },
    contentrating: 'Everyone',
    description: description || '',
    // ⚠️ 标记来源 —— 以后要能在面板上分辨"这张是 AI 生成的"，
    //   而且出问题时能知道该去看生成记录。
    //   ⚠️ 这是我们自己加的字段，WE 不认识它（但它容忍未知字段）。
    gwGenerated: true,
    // ⚠️⚠️ **配方进 project.json**（0.9.140）—— 那让"这次是什么组合"可观测。
    //   ⟹ 下次生成时读它来避重（见 wallpaper-recipe.js 的 pickRecipe）；
    //     而用户说"这两张太像了"时，能查出是哪几维撞了（不用靠感觉调）。
    //   ⚠️ 判据：**"多样"要可观测才可控。**
    gwRecipe: recipe || null,
  };
}

// ---------------------------------------------------------------------------
// 目录名
// ---------------------------------------------------------------------------
//
// ⚠️ 用户的描述直接当目录名会炸：斜杠、冒号、换行、几百字。
//   ⚠️ 而 macOS 上 `/` 和 `:` 都不能进文件名（`:` 是历史上的路径分隔符，
//     Finder 里会显示成 `/`）。
function slugifyTitle(text, stamp) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim()
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>| -]/g, '')
    .slice(0, 24)
    .trim();
  const base = cleaned || 'AI壁纸';
  // ⚠️ 带时间戳 —— 同一句描述生成两次要是两个目录，
  //   否则第二次会覆盖第一次（而用户可能还想对比）。
  return stamp ? `${base}-${stamp}` : base;
}

module.exports = {
  buildPlanPrompt,
  buildImplementPrompt,
  CONTRACT,
  CONSTRAINTS,
  SKELETON_API,
  buildScenePrompt,
  buildRepairPrompt,
  extractScene,
  inspect,
  judgeRuntime,
  buildProjectJson,
  slugifyTitle,
};
