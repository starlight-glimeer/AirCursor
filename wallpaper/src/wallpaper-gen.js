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
// 契约：喂给模型的接口说明
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
function buildGeneratePrompt(userWant, style) {
  const extra = style ? `\n\n# 额外偏好\n${style}` : '';
  return `你在为一个 macOS 动态壁纸播放器生成壁纸。产物是一个自包含的 index.html。

${CONSTRAINTS}

${CONTRACT}

# 用户想要的效果
${userWant}${extra}

# 输出格式
⚠️ **直接开始写代码，不要先长篇分析。** 你的输出预算要留给代码本身 ——
把预算花在"思考怎么写"上会导致代码写不完（那等于什么都没产出）。
只输出 index.html 的完整内容，从 <!DOCTYPE html> 开始、到 </html> 结束。
不要任何解释、不要 markdown 代码块围栏。`;
}

// ⚠️⚠️ 回喂：把**机器闸门的原文**给模型，不是我转述的结论。
//   ⚠️ 判据：转述会丢信息（"缺鼠标处理"和"全文只有一个 addEventListener 且是
//     resize"对模型是两种信息量），而丢的那部分正是它需要用来定位的。
function buildRepairPrompt(previousHtml, problems) {
  return `你上一版生成的壁纸没通过自动检查。下面是检查器的原始输出。

# 检查器报告
${problems.map((p, i) => `${i + 1}. [${p.id}] ${p.detail}`).join('\n')}

${CONSTRAINTS}

${CONTRACT}

# 上一版代码
${previousHtml}

# 要做的事
修掉上面每一条。保留原来的视觉效果和整体结构 —— 这是修复，不是重写。
⚠️ **直接开始写代码，不要先长篇分析** —— 预算要留给代码本身。
只输出修好的 index.html 完整内容，从 <!DOCTYPE html> 开始。
不要解释、不要 markdown 围栏。`;
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
function extractHtml(text) {
  const raw = String(text || '');
  // 先剥 markdown 围栏（```html ... ``` 或裸 ```）
  let body = raw;
  const fence = body.match(/```(?:html?)?\s*\n([\s\S]*?)```/i);
  if (fence) body = fence[1];
  // 再按 HTML 的真实边界切
  const startDoctype = body.search(/<!DOCTYPE\s+html/i);
  const startHtml = body.search(/<html[\s>]/i);
  let start = startDoctype >= 0 ? startDoctype : startHtml;
  if (start < 0) {
    // ⚠️ 连 <html 都没有 ⟹ 模型给的不是网页。这要当错误报，
    //   不能返回一个空串让它一路走到"写进文件然后白屏"。
    throw new Error('模型没有输出 HTML（找不到 <!DOCTYPE html> 或 <html>）。'
      + `它说的是：${raw.slice(0, 200)}`);
  }
  const endIdx = body.toLowerCase().lastIndexOf('</html>');
  if (endIdx < 0) {
    throw new Error('模型输出的 HTML 不完整（没有 </html>）—— 大概是被长度上限截断了');
  }
  return body.slice(start, endIdx + '</html>'.length).trim();
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
function inspect(html, hooks) {
  const h = hooks || {};
  const problems = [];
  const add = (id, detail) => problems.push({ id, detail });
  const src = String(html || '');

  // ── A. 外部依赖（最致命：没网直接白屏）
  // ⚠️ 只看**属性里的 URL**，不看正文出现的 http —— 注释里写个网址不算依赖。
  const externalSrc = src.match(/<(?:script|link|img|video|audio|source)[^>]*\s(?:src|href)\s*=\s*["']([^"']+)["']/gi) || [];
  for (const tag of externalSrc) {
    const url = (tag.match(/["']([^"']+)["']/) || [])[1] || '';
    // data URL 和纯锚点不算外部
    if (/^(data:|#|javascript:)/i.test(url)) continue;
    add('A-外部依赖', `有外部资源引用 \`${url}\` —— 壁纸跑在无网环境下会白屏。`
      + '所有东西必须内联在这一个文件里');
  }
  if (/\bimport\s+[\w{*]/.test(src) || /\bfrom\s+["'][^"']+["']/.test(src)) {
    add('A-外部依赖', 'ES module import —— 单文件壁纸不能有模块依赖');
  }
  if (/\b(fetch|XMLHttpRequest)\s*\(/.test(src)) {
    add('A-网络请求', '有 fetch/XHR —— 壁纸不许发网络请求（用户机器可能没网）');
  }

  // ── B. 语法（白屏最常见的原因，而它 100% 能机器判）
  if (typeof h.checkJsSyntax === 'function') {
    const blocks = [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
      .map((m) => m[1]).filter((s) => s.trim());
    if (!blocks.length) {
      add('B-没有脚本', '整个文件里没有 <script> 块 —— 那是一张静态页面，不是动态壁纸');
    }
    blocks.forEach((code, i) => {
      const err = h.checkJsSyntax(code);
      if (err) add('B-语法错误', `第 ${i + 1} 个 <script> 块语法错误：${err}`);
    });
  }

  // ── C. 画布
  if (!/<canvas/i.test(src)) {
    add('C-没有画布', '没有 <canvas> —— 这个播放器要的是 canvas 2d 或 WebGL 壁纸');
  }
  if (!/devicePixelRatio/.test(src)) {
    add('C-dpr', '没有处理 devicePixelRatio —— Retina 屏上画面会是模糊的。'
      + '要 dpr = Math.min(window.devicePixelRatio || 1, 2) 并按它设置 canvas.width/height');
  } else if (!/Math\.min\s*\(\s*(?:window\.)?devicePixelRatio[^)]*,\s*2\s*\)/.test(src)
    && !/Math\.min\s*\(\s*2\s*,/.test(src)) {
    add('C-dpr上限', 'devicePixelRatio 没夹上限 2 —— 3 倍屏上是 2.25 倍像素量，'
      + '对一个常驻后台的壁纸不值得');
  }
  if (!/addEventListener\s*\(\s*["']resize["']/.test(src)) {
    add('C-resize', '没有监听 resize —— 换分辨率/接显示器之后画面会拉伸或者只占一角');
  }

  // ── D. 限帧（这个项目为它栽过一轮）
  if (!/requestAnimationFrame/.test(src)) {
    add('D-没有动画循环', '没有 requestAnimationFrame —— 画面不会动');
  }
  // ⚠️⚠️ 这条正则我写错过一次：原本是 `setInterval\s*\([^)]*\b(frame|draw|…)`，
  //   而 `[^)]*` 在 `setInterval(function(){frame(...)` 里**停在 `function(` 的
  //   那个左括号**上 ⟹ 永远到不了 `frame` ⟹ 断言永久绿（自己的测试逮到的）。
  //   ⟹ 改成 `[\s\S]{0,80}?`：跨括号、有上限（不然会跨整个文件误报）。
  if (/setInterval\s*\([\s\S]{0,80}?\b(draw|render|frame|tick|update|animate)\s*\(/i.test(src)) {
    add('D-setInterval画帧', '用 setInterval 画帧 —— 窗口被系统降频时会堆积。'
      + '改用 requestAnimationFrame');
  }
  // ⚠️ 限帧的写法很多（1000/40、25、MIN_DT…）⟹ 只要出现"和上一帧时间比较"
  //   这个形状就算过。**宁可漏报也不误报** —— 误报会让模型去改一段本来对的代码。
  const hasFrameCap = /1000\s*\/\s*(?:40|3\d|[1-4]\d)\b/.test(src)
    || /\b(?:MIN_DT|minDt|frameInterval|FRAME_MS|targetFps|FPS)\b/.test(src)
    || /now\s*-\s*last\w*\s*<|(?:elapsed|dt|delta)\s*<\s*\d/.test(src);
  if (!hasFrameCap) {
    add('D-没限帧', '没有限帧 —— 它是常驻后台进程，跑满 60fps 会明显吃电。'
      + '加 if (now - last < 1000 / 40) return;');
  }

  // ── E. 宿主接口（接不上的症状是"画面在动但永远不跟音乐"，比白屏难查）
  if (!/wallpaperReady/.test(src)) {
    add('E-没报告就绪', '没调 window.wallpaperReady() —— 播放器靠它判断'
      + '"页面里的 JS 真的活着"，那是区分"加载失败"和"渲染有问题"的唯一信号');
  }
  const usesAudio = /wallpaperRegisterAudioListener/.test(src);
  if (!usesAudio) {
    add('E-没接音频', '没注册 wallpaperRegisterAudioListener —— 音乐驱动是这个'
      + '播放器的核心能力，不接等于放弃它');
  }
  // ⚠️ 接了就要**保护**。裸调（不判存在）在浏览器里直开会抛，
  //   而那时整个脚本停在那一行 ⟹ 白屏。
  for (const api of ['wallpaperRegisterAudioListener',
    'wallpaperRegisterMediaPropertiesListener',
    'wallpaperRegisterMediaThumbnailListener',
    'wallpaperRegisterMediaPlaybackListener',
    'wallpaperRegisterMediaTimelineListener']) {
    if (!new RegExp(api).test(src)) continue;
    // 保护的写法：if (window.X) / window.X && / typeof window.X
    const guarded = new RegExp(`(?:if\\s*\\(|&&\\s*|typeof\\s+)[^\\n]*${api}`).test(src);
    if (!guarded) {
      add('E-裸调接口', `${api} 没有 if 保护 —— 在浏览器里直接打开时它不存在，`
        + '会抛异常并让整个脚本停住（症状是白屏）');
    }
  }

  // ── F. 鼠标（⚠️ 实测那轮模型完全没接，而它自己审的时候判 pass）
  const mouseEvents = (src.match(/addEventListener\s*\(\s*["'](?:mousemove|mousedown|mouseup|click|wheel)["']/g) || []).length;
  if (mouseEvents === 0) {
    add('F-没接鼠标', '一个鼠标事件都没监听 —— 这个播放器会把桌面上的真鼠标'
      + '注入给壁纸，那是它最有意思的能力（点一下出效果、拖一下转视角）');
  } else if (/addEventListener\s*\(\s*["']mousemove["']/.test(src)
    && !/\.buttons\b/.test(src)) {
    add('F-拖拽判据', '监听了 mousemove 但没用 e.buttons —— 宿主把"拖拽中的移动"'
      + '注入成带 button 的 mouseMove，只看 mousemove 的话拖不动');
  }

  // ── G. 明确禁止的东西
  if (/\b(?:alert|confirm|prompt)\s*\(/.test(src)) {
    add('G-模态框', '有 alert/confirm/prompt —— 壁纸层在桌面最底下，没人能点掉那个框');
  }
  if (/\bdebugger\b/.test(src)) add('G-debugger', '有 debugger 语句');

  // ── H. 空闲状态（"没在放歌"是常态）
  //   ⚠️ 这条只能弱判 —— "有没有空闲动画"没法可靠地静态检测。
  //     ⟹ 只查一个必要条件：音频数据缺失时有没有兜底。**查不到就不报**，
  //       因为误报会让模型改一段本来对的代码（这比漏报贵）。

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
function buildProjectJson(title, description) {
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
  CONTRACT,
  CONSTRAINTS,
  buildGeneratePrompt,
  buildRepairPrompt,
  extractHtml,
  inspect,
  judgeRuntime,
  buildProjectJson,
  slugifyTitle,
};
