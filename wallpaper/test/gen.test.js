// AI 生成壁纸：提示词契约 / 机器闸门 / 运行时判定。
//
//   node test/gen.test.js
//
// ⚠️⚠️ **这个文件守的是"闸门准不准"，而那是整个功能的成败所在。**
//
// 用户 2026-08-02 要的是"agent 流程生成壁纸"，而实测证明一轮生成过不了 ——
// 靠的是「机器闸门 → 回喂 → 再检」这个循环收敛。⟹ 闸门错一条，循环就白转：
//   · **漏报**（该逮的没逮）⟹ 坏产物直接进壁纸库，用户看到白屏
//   · **误报**（把对的判成错）⟹ 回喂让模型去改一段本来正确的代码，
//     而它照改之后可能真的改坏 —— **误报比漏报贵**
//
// ⚠️⚠️⚠️ 而"模型审模型"实测判错两次、方向还相反（见 wallpaper-gen.js 顶部注释）：
//   鼠标完全没接它判 pass（漏报）、Math.random 用对了它判 fail（误报）。
//   ⟹ 这就是为什么闸门必须是**代码**。而代码闸门自己也要有守卫 —— 就是这个文件。
//
// ⚠️ 用例的输入用**真实模型产物的形状**（我 2026-08-02 用 Bedrock Sonnet 4.5
//   真跑了三轮，v1 262 行 / v2 334 行 / v3 343 行，最后 0 问题收敛）。
//   凭空编的 HTML 片段会漏掉真实产物才有的写法（比如 `if (e.buttons & 1)` 这种）。

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const G = require(path.join(__dirname, '..', 'src', 'wallpaper-gen.js'));
const LLM = require(path.join(__dirname, '..', 'src', 'llm.js'));

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.message}`);
    process.exitCode = 1;
  }
}

// 语法检查器 —— 和主进程里用的是同一种做法（new Function 不执行代码，只解析）
const syntax = (code) => {
  try { new Function(code); return null; } catch (e) { return e.message; }
};
const run = (html) => G.inspect(html, { checkJsSyntax: syntax });
const ids = (html) => run(html).map((p) => p.id);

// ---------------------------------------------------------------------------
// 一份"什么都对"的最小壁纸 —— 各条用例在它上面**破坏一处**再断言。
// ---------------------------------------------------------------------------
//
// ⚠️⚠️ 判据：**先证明它自己是零问题的**，否则后面每条用例都在一个本来就
//   报错的基线上跑，而"多了一个问题"和"本来就有问题"分不开。
const GOOD = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden;background:#05060a}
canvas{display:block;width:100vw;height:100vh}</style></head>
<body><canvas id="c"></canvas><script>
(function(){
  var c=document.getElementById('c'), ctx=c.getContext('2d');
  var W=0,H=0,dpr=1, bass=0, drag=false, lx=0, yaw=0;
  function resize(){
    dpr=Math.min(window.devicePixelRatio||1,2);
    W=c.clientWidth; H=c.clientHeight;
    c.width=Math.round(W*dpr); c.height=Math.round(H*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);
  }
  window.addEventListener('resize',resize);
  window.addEventListener('mousedown',function(e){drag=true;lx=e.clientX;});
  window.addEventListener('mouseup',function(){drag=false;});
  window.addEventListener('mousemove',function(e){
    var held = drag || (e.buttons & 1)===1;
    if(!held){lx=e.clientX;return;}
    yaw -= (e.clientX-lx)*0.006; lx=e.clientX;
  });
  var last=0, MIN_DT=1000/40;
  function frame(now){
    requestAnimationFrame(frame);
    if(now-last<MIN_DT) return;
    last=now;
    ctx.fillStyle='#05060a'; ctx.fillRect(0,0,W,H);
    ctx.fillStyle='rgba(120,200,255,'+(0.3+bass*0.5)+')';
    ctx.fillRect(0,H*0.6,W,H*0.4);
    bass*=0.92;
  }
  if(window.wallpaperRegisterAudioListener){
    window.wallpaperRegisterAudioListener(function(d){
      if(!d||!d.length) return;
      var b=0; for(var i=0;i<6;i++) b+=(d[i]+(d[i+64]||0))/2;
      bass=Math.max(bass,Math.min(1,b/6));
    });
  }
  if(window.wallpaperRegisterMediaPropertiesListener){
    window.wallpaperRegisterMediaPropertiesListener(function(p){ void p; });
  }
  resize();
  if(window.wallpaperReady) window.wallpaperReady();
  requestAnimationFrame(frame);
})();
</script></body></html>`;

console.log('\nAI 生成壁纸');

check('基线：一份"什么都对"的壁纸零问题（否则后面每条都不可信）', () => {
  const problems = run(GOOD);
  assert.deepStrictEqual(problems, [],
    `基线自己就报错了 ⟹ 后面每条用例都建在坏基线上：\n${
      problems.map((p) => `      [${p.id}] ${p.detail}`).join('\n')}`);
});

// ---------------------------------------------------------------------------
// A. 外部依赖 —— 最致命（无网直接白屏）
// ---------------------------------------------------------------------------
check('A：CDN 脚本被逮到', () => {
  const bad = GOOD.replace('<canvas id="c">',
    '<script src="https://cdn.jsdelivr.net/npm/three@0.160/build/three.min.js"></script><canvas id="c">');
  assert.ok(ids(bad).includes('A-外部依赖'), '外链 <script src> 没被逮到');
});

check('A：外链样式表被逮到', () => {
  const bad = GOOD.replace('<style>', '<link rel="stylesheet" href="https://x.test/a.css"><style>');
  assert.ok(ids(bad).includes('A-外部依赖'), '外链 <link href> 没被逮到');
});

check('A：ES import 被逮到', () => {
  const bad = GOOD.replace('(function(){', 'import * as T from "three";\n(function(){');
  assert.ok(ids(bad).includes('A-外部依赖'), 'import 没被逮到');
});

check('A：fetch 被逮到', () => {
  const bad = GOOD.replace('resize();', 'fetch("/api/x");\n  resize();');
  assert.ok(ids(bad).includes('A-网络请求'), 'fetch 没被逮到');
});

// ⚠️⚠️ **误报守卫** —— 这几条是"看起来像外部依赖但其实不是"。
//   误报会让模型去改一段本来对的代码，而那比漏报贵。
check('A 不误报：data URL 的 img 不算外部依赖', () => {
  const ok = GOOD.replace('<canvas id="c">',
    '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><canvas id="c">');
  assert.ok(!ids(ok).includes('A-外部依赖'), 'data URL 被误判成外部依赖了');
});

check('A 不误报：注释里的网址不算依赖', () => {
  const ok = GOOD.replace('(function(){',
    '// 参考 https://example.com/aurora 的做法\n(function(){');
  assert.ok(!ids(ok).includes('A-外部依赖'), '注释里的 URL 被误判成依赖了');
  assert.ok(!ids(ok).includes('A-网络请求'), '注释里的 URL 被误判成网络请求了');
});

// ---------------------------------------------------------------------------
// B. 语法 —— 白屏最常见的原因，而它 100% 能机器判
// ---------------------------------------------------------------------------
check('B：语法错误被逮到（白屏的头号原因）', () => {
  const bad = GOOD.replace('last=now;', 'last=now;;;}}}(');
  const problems = run(bad);
  assert.ok(problems.some((p) => p.id === 'B-语法错误'), '语法错误没被逮到');
  // ⚠️ 报错原文要带上 —— 那是回喂给模型时它唯一能用来定位的东西
  const err = problems.find((p) => p.id === 'B-语法错误');
  assert.ok(err.detail.length > 30, '语法错误的描述里没带解析器的原始报错');
});

check('B：一个 <script> 都没有 = 静态页面，不是壁纸', () => {
  const bad = GOOD.replace(/<script>[\s\S]*?<\/script>/, '');
  assert.ok(ids(bad).includes('B-没有脚本'), '没有脚本块没被逮到');
});

// ---------------------------------------------------------------------------
// C. 画布 / dpr / resize
// ---------------------------------------------------------------------------
check('C：没有 canvas 被逮到', () => {
  const bad = GOOD.replace('<canvas id="c"></canvas>', '<div id="c"></div>');
  assert.ok(ids(bad).includes('C-没有画布'));
});

check('C：完全没处理 dpr 被逮到（Retina 上是糊的）', () => {
  const bad = GOOD.replace('dpr=Math.min(window.devicePixelRatio||1,2);', 'dpr=1;');
  assert.ok(ids(bad).includes('C-dpr'), '没处理 dpr 没被逮到');
});

check('C：dpr 没夹上限 2 被逮到', () => {
  const bad = GOOD.replace('dpr=Math.min(window.devicePixelRatio||1,2);',
    'dpr=window.devicePixelRatio||1;');
  const got = ids(bad);
  assert.ok(got.includes('C-dpr上限'),
    `用了 devicePixelRatio 但没夹上限，应该报 C-dpr上限，实际报了：${got.join(',')}`);
});

check('C：没监听 resize 被逮到', () => {
  const bad = GOOD.replace("window.addEventListener('resize',resize);", '');
  assert.ok(ids(bad).includes('C-resize'));
});

// ---------------------------------------------------------------------------
// D. 限帧 —— 这个项目为"壁纸吃满 CPU"栽过一轮
// ---------------------------------------------------------------------------
check('D：没有 requestAnimationFrame 被逮到', () => {
  const bad = GOOD.replace(/requestAnimationFrame/g, 'setTimeout');
  assert.ok(ids(bad).includes('D-没有动画循环'));
});

check('D：setInterval 画帧被逮到', () => {
  const bad = GOOD.replace('requestAnimationFrame(frame);\n})();',
    'setInterval(function(){frame(performance.now())},16);\n})();');
  assert.ok(ids(bad).includes('D-setInterval画帧'), 'setInterval 画帧没被逮到');
});

check('D：完全没限帧被逮到', () => {
  const bad = GOOD
    .replace('var last=0, MIN_DT=1000/40;', 'var last=0;')
    .replace('if(now-last<MIN_DT) return;', '');
  assert.ok(ids(bad).includes('D-没限帧'), '没限帧没被逮到');
});

// ⚠️⚠️ **限帧的写法有很多种**，而误报会让模型去改一段对的代码。
//   ⟹ 这几条守"换个写法也认"。判据在 inspect 里写着：宁可漏报也不误报。
check('D 不误报：限帧写成 1000/30 也认', () => {
  const ok = GOOD.replace('MIN_DT=1000/40', 'MIN_DT=1000/30');
  assert.ok(!ids(ok).includes('D-没限帧'), '1000/30 的限帧被误判成没限帧');
});

check('D 不误报：限帧写成 frameInterval 也认', () => {
  const ok = GOOD.replace('MIN_DT=1000/40', 'frameInterval=25')
    .replace('now-last<MIN_DT', 'now-last<frameInterval');
  assert.ok(!ids(ok).includes('D-没限帧'), 'frameInterval 这种命名被误判成没限帧');
});

// ---------------------------------------------------------------------------
// E. 宿主接口 —— 接不上的症状是"画面在动但永远不跟音乐"，比白屏难查
// ---------------------------------------------------------------------------
check('E：没调 wallpaperReady 被逮到', () => {
  const bad = GOOD.replace('if(window.wallpaperReady) window.wallpaperReady();', '');
  assert.ok(ids(bad).includes('E-没报告就绪'));
});

check('E：没接音频被逮到（音乐驱动是这个播放器的核心）', () => {
  const bad = GOOD.replace(/if\(window\.wallpaperRegisterAudioListener\)\{[\s\S]*?\n  \}/, '');
  assert.ok(ids(bad).includes('E-没接音频'), '没接音频没被逮到');
});

check('E：裸调宿主接口被逮到（浏览器直开会白屏）', () => {
  // 去掉 if 保护，直接调
  const bad = GOOD.replace(
    'if(window.wallpaperRegisterMediaPropertiesListener){\n    window.wallpaperRegisterMediaPropertiesListener(function(p){ void p; });\n  }',
    'window.wallpaperRegisterMediaPropertiesListener(function(p){ void p; });');
  assert.ok(ids(bad).includes('E-裸调接口'), '裸调宿主接口没被逮到');
});

check('E 不误报：`window.X && window.X(...)` 这种保护也认', () => {
  const ok = GOOD.replace(
    'if(window.wallpaperRegisterMediaPropertiesListener){\n    window.wallpaperRegisterMediaPropertiesListener(function(p){ void p; });\n  }',
    'window.wallpaperRegisterMediaPropertiesListener && window.wallpaperRegisterMediaPropertiesListener(function(p){ void p; });');
  assert.ok(!ids(ok).includes('E-裸调接口'), '&& 形式的保护被误判成裸调');
});

// ---------------------------------------------------------------------------
// F. 鼠标 —— ⚠️⚠️ 这一组是**真事故**的守卫
// ---------------------------------------------------------------------------
//
// 2026-08-02 实测：模型一轮生成的产物**一个鼠标事件都没接**（全文只有一个
// addEventListener，是 resize），而我让模型审自己的产物时它判 **pass**。
// ⟹ 这条是"模型审模型不可信"的直接证据，也是机器闸门存在的理由。
check('F：一个鼠标事件都没接被逮到（实测漏报过的那条）', () => {
  const bad = GOOD
    .replace(/window\.addEventListener\('mousedown'[\s\S]*?\}\);\n/, '')
    .replace(/window\.addEventListener\('mouseup'[\s\S]*?\}\);\n/, '')
    .replace(/window\.addEventListener\('mousemove'[\s\S]*?\n  \}\);\n/, '');
  const got = ids(bad);
  assert.ok(got.includes('F-没接鼠标'),
    `完全没接鼠标没被逮到（这正是模型自审判 pass 的那条）。实际报了：${got.join(',')}`);
});

check('F：接了 mousemove 但没用 e.buttons 被逮到（拖不动）', () => {
  const bad = GOOD.replace('var held = drag || (e.buttons & 1)===1;', 'var held = drag;');
  assert.ok(ids(bad).includes('F-拖拽判据'), '缺 e.buttons 没被逮到');
});

// ---------------------------------------------------------------------------
// G. 明确禁止
// ---------------------------------------------------------------------------
check('G：alert 被逮到（壁纸层没人能点掉那个框）', () => {
  const bad = GOOD.replace('resize();', 'alert("hi");\n  resize();');
  assert.ok(ids(bad).includes('G-模态框'));
});

check('G：debugger 被逮到', () => {
  const bad = GOOD.replace('last=now;', 'debugger;\n    last=now;');
  assert.ok(ids(bad).includes('G-debugger'));
});

// ---------------------------------------------------------------------------
// extractHtml —— 模型经常不听"不要 markdown 围栏"
// ---------------------------------------------------------------------------
check('extractHtml：剥掉 markdown 围栏', () => {
  const out = G.extractHtml('```html\n<!DOCTYPE html>\n<html><body>x</body></html>\n```');
  assert.ok(out.startsWith('<!DOCTYPE html>'), `没剥掉围栏：${out.slice(0, 40)}`);
  assert.ok(out.endsWith('</html>'), '尾部没切干净');
});

check('extractHtml：剥掉前后的废话', () => {
  const out = G.extractHtml(
    '好的，这是生成的壁纸：\n\n<!DOCTYPE html>\n<html><body>x</body></html>\n\n希望你喜欢！');
  assert.strictEqual(out, '<!DOCTYPE html>\n<html><body>x</body></html>');
});

check('extractHtml：没有 </html> = 被截断，要报错不能静默返回', () => {
  // ⚠️ 截断的 HTML 一定跑不起来，而症状是白屏 ——
  //   如果这里静默返回，用户会去查"为什么壁纸是白的"
  assert.throws(() => G.extractHtml('<!DOCTYPE html>\n<html><body>写到一半就断'),
    /不完整|截断/, '截断的 HTML 没报错');
});

check('extractHtml：模型答非所问要报错并带上它说了什么', () => {
  let msg = '';
  try { G.extractHtml('我不能帮你做这个。'); } catch (e) { msg = e.message; }
  assert.match(msg, /没有输出 HTML/, '没报"不是 HTML"');
  assert.match(msg, /我不能帮你做这个/, '报错里没带上模型实际说的话 ⟹ 用户不知道发生了什么');
});

// ---------------------------------------------------------------------------
// judgeRuntime —— ②真跑闸门的判定（开窗口在 main.js，判定在这里所以能被测）
// ---------------------------------------------------------------------------
check('judgeRuntime：一切正常 ⟹ 零问题', () => {
  const problems = G.judgeRuntime({
    ready: true, errors: [], frames: 120, ms: 3000,
    sampledPixels: { black: 40, total: 400 },
  });
  assert.deepStrictEqual(problems, [], `正常的运行数据被判出问题：${JSON.stringify(problems)}`);
});

check('judgeRuntime：页面报错要原文回喂（那是模型定位的唯一依据）', () => {
  const problems = G.judgeRuntime({
    ready: false, errors: ['Uncaught TypeError: ctx.roundRect is not a function'],
    frames: 0, ms: 3000,
  });
  const txt = problems.map((p) => p.detail).join('\n');
  assert.match(txt, /roundRect is not a function/, '报错原文丢了');
});

check('judgeRuntime：一帧没画被逮到', () => {
  const problems = G.judgeRuntime({ ready: true, errors: [], frames: 0, ms: 3000 });
  assert.ok(problems.some((p) => p.id === 'R-一帧没画' || p.id === 'R-几乎不动'),
    '一帧都没画没被逮到');
});

check('judgeRuntime：画面全黑被逮到（跑起来了但看不见 —— 日志里完全干净）', () => {
  const problems = G.judgeRuntime({
    ready: true, errors: [], frames: 120, ms: 3000,
    sampledPixels: { black: 400, total: 400 },
  });
  assert.ok(problems.some((p) => p.id === 'R-画面全黑'), '全黑没被逮到');
});

// ⚠️⚠️ **误报守卫**：离屏窗口本来就慢（不可见窗口被 Chromium 降频），
//   而一个 20fps 的阈值会把好产物砍掉。
check('judgeRuntime 不误报：离屏窗口 15fps 不算问题', () => {
  const problems = G.judgeRuntime({
    ready: true, errors: [], frames: 45, ms: 3000,
    sampledPixels: { black: 100, total: 400 },
  });
  assert.ok(!problems.some((p) => p.id === 'R-几乎不动'),
    '15fps 被误判成"几乎不动" —— 离屏窗口被降频是正常的，这会砍掉好产物');
});

check('judgeRuntime 不误报：主体很暗但有亮点不算全黑', () => {
  const problems = G.judgeRuntime({
    ready: true, errors: [], frames: 120, ms: 3000,
    sampledPixels: { black: 397, total: 400 },   // 99.25%
  });
  assert.ok(!problems.some((p) => p.id === 'R-画面全黑'),
    '99.25% 近黑被判成全黑 —— 深色壁纸的常态');
});

// ---------------------------------------------------------------------------
// 契约同步 —— ⚠️ 这条守的是"喂给模型的接口说明和真实实现别分叉"
// ---------------------------------------------------------------------------
//
// ⚠️⚠️ 契约错一个字，产出就是"看起来对但接不上" ——
//   画面在动、只是永远不跟音乐，而那种失败比白屏难查得多。
check('契约里的接口名和 we-preload.js 真实暴露的一致', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'we-preload.js'), 'utf8');
  const exposed = [...preload.matchAll(/exposeInMainWorld\(\s*'(wallpaper\w+)'/g)]
    .map((m) => m[1]);
  assert.ok(exposed.length >= 6,
    `we-preload.js 里只找到 ${exposed.length} 个 expose —— 锚点变了，这条守卫要跟着改`);
  for (const api of exposed) {
    assert.ok(G.CONTRACT.includes(api),
      `we-preload.js 暴露了 ${api}，但喂给模型的契约里没说 ⟹ `
      + '生成的壁纸不会用它（而症状是"少一个功能"，不报错）');
  }
});

check('契约里没有我们其实没实现的接口（说了模型就会用，用了就接不上）', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'we-preload.js'), 'utf8');
  // 从契约里抠出所有 window.wallpaperXxx 的调用
  const mentioned = [...G.CONTRACT.matchAll(/window\.(wallpaper\w+)/g)].map((m) => m[1]);
  const unique = [...new Set(mentioned)];
  assert.ok(unique.length >= 6, '契约里提到的接口太少 —— 抠取的正则可能失效了');
  for (const api of unique) {
    assert.ok(preload.includes(api),
      `契约里告诉模型可以用 ${api}，但 we-preload.js 里没有它 ⟹ `
      + '生成的壁纸会调一个不存在的东西');
  }
});

// ---------------------------------------------------------------------------
// project.json —— 生成的壁纸要能被这个播放器认出来
// ---------------------------------------------------------------------------
check('project.json：type 是 Web、file 是 index.html、audio 开着', () => {
  const p = G.buildProjectJson('测试', '说明');
  assert.strictEqual(p.type, 'Web', 'type 不是 Web ⟹ 播放器会选错渲染路径');
  assert.strictEqual(p.file, 'index.html', 'file 字段不对 ⟹ 播放器找不到入口');
  assert.strictEqual(p.audio && p.audio.enabled, true,
    'audio.enabled 没开 ⟹ 音频通道不会打开，壁纸接了回调也永远收不到数据');
});

check('project.json：标记来源（以后要能分辨哪些是 AI 生成的）', () => {
  assert.strictEqual(G.buildProjectJson('x').gwGenerated, true);
});

// ---------------------------------------------------------------------------
// 目录名
// ---------------------------------------------------------------------------
check('目录名：剥掉 macOS 不能用的字符', () => {
  const name = G.slugifyTitle('极光/帷幕:测试*壁纸?', '123');
  assert.ok(!/[/\\:*?"<>|]/.test(name), `目录名里还有非法字符：${name}`);
  assert.ok(name.includes('123'), '时间戳没带上 ⟹ 同一句描述生成两次会互相覆盖');
});

check('目录名：超长描述被截断', () => {
  const name = G.slugifyTitle('这是一句非常非常非常非常非常非常长的壁纸描述'.repeat(10), '1');
  assert.ok(name.length < 40, `目录名太长了（${name.length}）`);
});

check('目录名：空描述有兜底（不能生成一个叫 "-123" 的目录）', () => {
  const name = G.slugifyTitle('   ', '123');
  assert.ok(name.length > 4 && !name.startsWith('-'), `空描述的兜底不对：${name}`);
});

// ---------------------------------------------------------------------------
// LLM：请求拼装 / 响应解析（纯函数，云端唯一能验的部分）
// ---------------------------------------------------------------------------
console.log('\nLLM 调用');

check('Bedrock：URL / bearer / anthropic_version 都对', () => {
  const r = LLM.buildRequest({
    provider: 'bedrock', region: 'us-west-2', apiKey: 'K',
    model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  }, [{ role: 'user', content: 'hi' }]);
  assert.match(r.url, /^https:\/\/bedrock-runtime\.us-west-2\.amazonaws\.com\/model\//);
  assert.match(r.url, /\/invoke$/, 'URL 结尾不是 /invoke');
  assert.strictEqual(r.headers.Authorization, 'Bearer K',
    'Bedrock 那支必须用 bearer token —— 用 SigV4 就要签名算法，'
    + '而"不需要 aws-sdk 依赖"正是走这条路的全部理由');
  const body = JSON.parse(r.body);
  assert.strictEqual(body.anthropic_version, 'bedrock-2023-05-31',
    'anthropic_version 缺了或写错 ⟹ Bedrock 返回 400');
  // ⚠️ 模型 ID 带冒号，必须编码
  assert.ok(r.url.includes('%3A'), '模型 ID 里的冒号没编码');
});

check('OpenAI 兼容：末尾斜杠不会拼出 //chat/completions', () => {
  const r = LLM.buildRequest({
    provider: 'openai', baseUrl: 'https://api.deepseek.com/v1/', apiKey: 'K', model: 'deepseek-chat',
  }, [{ role: 'user', content: 'hi' }]);
  assert.strictEqual(r.url, 'https://api.deepseek.com/v1/chat/completions',
    '末尾斜杠没剥掉 ⟹ 有的网关返回 404，而那看起来像"地址填错了"');
});

check('缺字段要在发请求之前就报（不是等一个看不懂的 4xx）', () => {
  assert.throws(() => LLM.buildRequest({ provider: 'bedrock', apiKey: 'K', model: 'm' }, []),
    /region/, 'Bedrock 缺 region 没提前报');
  assert.throws(() => LLM.buildRequest({ provider: 'openai', apiKey: 'K', model: 'm' }, []),
    /base URL/, 'OpenAI 缺 baseUrl 没提前报');
  assert.throws(() => LLM.buildRequest({ provider: 'bedrock', region: 'r', model: 'm' }, []),
    /API key/, '缺 key 没提前报');
  assert.throws(() => LLM.buildRequest({ provider: '不存在', apiKey: 'K', model: 'm' }, []),
    /不认识的提供方/);
});

check('响应解析：Bedrock 的形状', () => {
  const out = LLM.parseResponse('bedrock', {
    content: [{ type: 'text', text: '通了' }], stop_reason: 'end_turn',
  });
  assert.strictEqual(out.text, '通了');
  assert.strictEqual(out.stopReason, 'end_turn');
});

check('响应解析：Bedrock 有 thinking 块时只取 text', () => {
  // ⚠️ 以后如果开了 thinking，数组第一个是 thinking 块 —— 那不是正文
  const out = LLM.parseResponse('bedrock', {
    content: [{ type: 'thinking', thinking: '让我想想' }, { type: 'text', text: '答案' }],
  });
  assert.strictEqual(out.text, '答案', 'thinking 块被当成正文了');
});

check('响应解析：OpenAI 的形状', () => {
  const out = LLM.parseResponse('openai', {
    choices: [{ message: { content: '通了' }, finish_reason: 'stop' }],
  });
  assert.strictEqual(out.text, '通了');
});

// ---------------------------------------------------------------------------
// ⚠️⚠️⚠️ 推理模型的 reasoning_content —— **真事故**（0.9.125）
// ---------------------------------------------------------------------------
//
// 用户 2026-08-02 实测：「测一下」通了（模型回了「通了」），
// 而生成壁纸报「模型没返回内容（choices[0].message.content 是空的）」。
//
// ⚠️ **那两件事同时成立就是这个形状的指纹**：探针只要几个 token（够写完
//   "通了"），而生成要上万 —— 如果预算在"还在思考"的阶段就烧完了，
//   `content` 是空字符串、`reasoning_content` 满的、`finish_reason=length`。
//
// ⚠️⚠️ 而**我第一版的报错把唯一有用的信息全丢了** —— 只说"content 是空的"，
//   没有 finish_reason、没说有没有 reasoning_content、没有 token 数
//   ⟹ 我只能去猜原因。
//   ⟹ 判据：**一个不带证据的报错，等于把排查成本转给下一轮猜测。**
check('推理模型：content 空而 reasoning_content 满 ⟹ 要说清是"思考烧完了预算"', () => {
  let msg = '';
  try {
    LLM.parseResponse('openai', {
      choices: [{
        message: { content: '', reasoning_content: '让我想想这个壁纸该怎么写…'.repeat(20) },
        finish_reason: 'length',
      }],
      usage: { prompt_tokens: 1200, completion_tokens: 16000 },
    });
  } catch (e) { msg = e.message; }
  assert.match(msg, /reasoning_content|思考/,
    '没提到 reasoning_content —— 那是这次失败唯一的线索，而报错里不说的话没人查得到');
  assert.match(msg, /length/, '没带上 finish_reason');
  assert.match(msg, /16000/, '没带上 token 用量 —— 那是"预算烧在哪了"的直接证据');
  // ⚠️ 而**不许把思考过程当正文返回** —— 那里面没有完整 HTML，
  //   当正文用的话会一路走到"写进文件然后白屏"。
  assert.ok(!/^让我想想/.test(msg), 'reasoning_content 被当成正文了');
});

check('推理模型：reasoning 也没有时，把 message 的字段名列出来', () => {
  // ⚠️ 那是"这家的响应形状和我们预期的不一样"唯一能带回来的线索
  let msg = '';
  try {
    LLM.parseResponse('openai', {
      choices: [{ message: { role: 'assistant', 某个新字段: 'x' }, finish_reason: 'stop' }],
    });
  } catch (e) { msg = e.message; }
  assert.match(msg, /某个新字段/,
    '没列出 message 里实际有哪些字段 ⟹ 换一家网关时无从下手');
});

check('OpenAI 兼容：正文包在 content 数组里也认（Anthropic 形状漏过来）', () => {
  const out = LLM.parseResponse('openai', {
    choices: [{ message: { content: [{ type: 'text', text: '正文' }] }, finish_reason: 'stop' }],
  });
  assert.strictEqual(out.text, '正文', '数组形式的 content 没兜住');
});

check('响应解析：200 但没内容要报人话（不是 TypeError）', () => {
  // ⚠️ 裸访问 data.content[0].text 会抛
  //   "Cannot read properties of undefined" —— 那对用户毫无意义
  for (const [provider, data] of [['bedrock', { content: [] }], ['openai', { choices: [] }]]) {
    let msg = '';
    try { LLM.parseResponse(provider, data); } catch (e) { msg = e.message; }
    assert.ok(/没返回内容|没有 choices/.test(msg),
      `${provider} 的空响应报的不是人话：${msg}`);
    assert.ok(!/Cannot read/.test(msg), `${provider} 抛的是裸 TypeError：${msg}`);
  }
});

check('HTTP 错误要说"该动哪里"，不是只给个状态码', () => {
  // ⚠️ 一个裸的 403 在面板上等于没说话 —— 用户会去重填 key（而那可能是对的）
  assert.match(LLM.explainHttpError(403, '{}'), /模型访问|权限/,
    '403 没说是"没开模型访问权限"');
  assert.match(LLM.explainHttpError(401, '{}'), /key/, '401 没说是 key 的问题');
  assert.match(LLM.explainHttpError(404, '{}'), /base URL|模型 ID/, '404 没说该查什么');
  assert.match(LLM.explainHttpError(429, '{}'), /限流/, '429 没说是限流');
  assert.match(LLM.explainHttpError(503, '{}'), /不是你这边/, '5xx 没说是服务端的问题');
  // 服务端原文要带上 —— 那常常是唯一有用的信息
  assert.match(LLM.explainHttpError(400, 'model not found: xyz'), /model not found: xyz/,
    '服务端返回的原文没带上');
});

// ---------------------------------------------------------------------------
// ⚠️⚠️ 默认配置 + 存量迁移（0.9.124：bedrock → deepseek）
// ---------------------------------------------------------------------------
//
// 用户 2026-08-02：「我填了 deepseek 的 api key 然后呢」
// ⚠️ 换掉 Bedrock 的理由是**拿到 key 的门槛**（AWS 账号 → 申请模型访问权 →
//   区域对上 → 建 key），不是 Bedrock 不好。
//
// ⚠️⚠️ 而**光改 defaultConfig 对存量用户无效** —— `mergeConfig` 会保留用户
//   存过的值（那是对的），而 0.9.123 装过一次就已经把 bedrock 写进磁盘了。
//   ⟹ 必须有显式迁移。这个项目为同一件事栽过（we.strategy 那次）。
check('默认走 DeepSeek，且 base URL 不带 /v1（官方文档的形状）', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const at = main.indexOf('    ai: {');
  assert.ok(at > 0, 'defaultConfig 里找不到 ai 块 —— 锚点变了，这条守卫要跟着改');
  const block = main.slice(at, at + 700);
  assert.match(block, /provider: 'openai'/, '默认提供方不是 openai 兼容那支');
  // ⚠️ 锚定"不带 /v1" —— DeepSeek 官方文档写的是 https://api.deepseek.com。
  //   加了 /v1 的症状是 404，而那看起来像"地址填错了"。
  assert.match(block, /baseUrl: 'https:\/\/api\.deepseek\.com'/,
    'DeepSeek 的 base URL 不对 —— 官方文档是 https://api.deepseek.com（**不带 /v1**）');
  assert.match(block, /model: 'deepseek-v4-flash'/, '默认模型不是 deepseek-v4-flash');
  assert.match(block, /apiKey: null/, 'apiKey 的默认值必须是 null（绝不许硬编码 key）');
});

check('URL 拼装：DeepSeek 的 base URL 拼出正确端点', () => {
  // ⚠️ 这条直接验"配置 + 拼装"这条链的产物，而不是只看配置字符串对不对
  const r = LLM.buildRequest({
    provider: 'openai', baseUrl: 'https://api.deepseek.com',
    apiKey: 'K', model: 'deepseek-v4-flash',
  }, [{ role: 'user', content: 'x' }]);
  assert.strictEqual(r.url, 'https://api.deepseek.com/chat/completions',
    'DeepSeek 的端点拼错了');
});

check('存量迁移：磁盘上存着 bedrock 的会被换成 deepseek，但 apiKey 不动', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const at = main.indexOf('function migrateConfig');
  assert.ok(at > 0, '找不到 migrateConfig');
  const body = main.slice(at, main.indexOf('\n}', at));
  assert.match(body, /ai\.provider === 'bedrock'/,
    'migrateConfig 里没有把存量的 bedrock 迁走 ⟹ 0.9.123 装过的人改了默认值也没用'
    + '（mergeConfig 会保留他们存过的 bedrock）');
  assert.match(body, /ai\.model = 'deepseek-v4-flash'/, '迁移没换模型名');
  // ⚠️⚠️ **apiKey 一个字都不许动** —— 那是用户自己填的东西。
  //   迁移的边界是"旧默认值"，不是"用户的数据"。
  const migLines = body.slice(body.indexOf("ai.provider === 'bedrock'"));
  assert.ok(!/ai\.apiKey\s*=/.test(migLines),
    '迁移里动了 apiKey —— 那是用户自己填的，迁移只该改旧默认值');
});

// ---------------------------------------------------------------------------
// ⚠️⚠️ 探针要测"能不能完成真实任务"，不是"能不能握手"（0.9.126，真事故）
// ---------------------------------------------------------------------------
//
// 用户 2026-08-02：探针通了（模型回「通了」），而生成壁纸返回空正文。
// **账单定性了它**：2 次请求 17,304 token —— 探针约 16、生成输入约 1,240
// ⟹ 输出**正好 16,000**、撞 max_tokens、而 content 是空的
// ⟹ 全烧在 reasoning_content：deepseek-v4-flash 是推理模型，
//   它"想"到上限，一行 HTML 都没开始写。
//
// ⚠️⚠️ 而"探针通了"给了一个**错的安全感** —— 它只证明凭证和网络，
//   而真正会让功能失败的是"模型类型不对"，探针那时对此一无所知。
check('探针问的是"写一行代码"，不是"回两个字"（推理模型才会露出思考）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'llm.js'), 'utf8');
  const at = src.indexOf('async function ping(');
  assert.ok(at > 0, '找不到 ping()');
  const body = src.slice(at, at + 3000);
  assert.match(body, /JavaScript|canvas/,
    '探针还在问"回两个字" —— 推理模型对那种问题可能直接答，测不出它会不会思考。'
    + '要让它写代码（那才是真实任务的形状）');
  // ⚠️ 探针必须**报告**思考情况，否则测出来了也没人知道
  assert.match(body, /reasoning_content/, '探针没读 reasoning_content');
  assert.match(body, /thinks/, '探针没把"会不会思考"报出来 ⟹ 面板无从提醒');
  // ⚠️⚠️ 而它**不能调 parseResponse** —— 那个函数在正文为空时会抛，
  //   而探针恰恰要把"正文空但有思考"当成一个有用的结论报出来。
  //
  // ⚠️⚠️ 这条断言我第一版写成 `!/parseResponse/.test(body)`，而它**当场误报** ——
  //   命中的是我自己那句注释「这里不能用 parseResponse」加上模块导出列表里的
  //   那一行（我切的 3000 字符窗口盖到了文件末尾的 module.exports）。
  //   ⟹ 判据：**"这个词不出现"从来不是一条可靠的断言** ——
  //     注释、导出、字符串里都会出现它。要锚定的是「**调用**」这个形状。
  assert.ok(!/parseResponse\s*\(\s*cfg\.provider/.test(body),
    '探针调了 parseResponse(cfg.provider, …) ⟹ 正文空时它会抛，'
    + '而那正是探针最该报告的情况');
});

check('面板：探针发现是推理模型要当场提醒（"通了"不等于"能用"）', () => {
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  const at = dash.indexOf("aiEl('ai-ping')");
  assert.ok(at > 0, '找不到探针按钮的处理');
  const body = dash.slice(at, at + 2500);
  assert.match(body, /r\.thinks/,
    '面板没检查 thinks ⟹ 用户会看到"通了"然后等几分钟再失败');
  assert.match(body, /推理模型/, '提醒里没说清是"推理模型"这个原因');
});

check('生成的预算是 32000（16000 被实测证明不够）', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const at = main.indexOf("LLM.chat(ai, [{ role: 'user', content: prompt }]");
  assert.ok(at > 0, '找不到生成时的 LLM.chat 调用');
  assert.match(main.slice(at, at + 200), /maxTokens: 32000/,
    '生成预算不是 32000 —— 用户账单实测：输出正好撞在 16000 上而正文是空的');
});

check('提示词里要求"直接写代码、别长篇分析"（生成和回喂两条都要）', () => {
  // ⚠️ 那是我们唯一能对模型行为施加的影响 —— 换模型是用户的事，
  //   而提示词是我们的。
  for (const [name, prompt] of [
    ['生成', G.buildGeneratePrompt('极光')],
    ['回喂', G.buildRepairPrompt('<html></html>', [{ id: 'X', detail: 'y' }])],
  ]) {
    assert.match(prompt, /不要先长篇分析|不要先长篇/,
      `${name}提示词里没要求"直接写代码" ⟹ 推理模型会把预算烧在思考上`);
  }
});

check('⚠️ 这个仓里不许出现任何真凭证', () => {
  // ⚠️⚠️ 用户 2026-08-02：「这些东西肯定是不能上传 GitHub 的」
  //   ⟹ 凭证只在 userData/config.json（仓外）。这条守卫盯着代码里没有硬编码。
  for (const f of ['llm.js', 'wallpaper-gen.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    // AWS bearer token 的前缀 / OpenAI 风格的 key / 长 base64 串
    assert.ok(!/ABSK[A-Za-z0-9+/=]{20,}/.test(src), `${f} 里有 Bedrock token 的样子`);
    assert.ok(!/\bsk-[A-Za-z0-9]{20,}/.test(src), `${f} 里有 sk- 开头的 key`);
    assert.ok(!/AKIA[0-9A-Z]{16}/.test(src), `${f} 里有 AWS access key id`);
  }
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
