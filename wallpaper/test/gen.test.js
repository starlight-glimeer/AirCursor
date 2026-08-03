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
// ⚠️⚠️⚠️ **闸门测的是 `scene.js`，不是整个 HTML**（0.9.140 架构变了）
// ---------------------------------------------------------------------------
//
// 用户 2026-08-02 定的架构：**固定骨架 + 模型只填变化**。
// ⟹ 模型现在只写 `scene.js`（`window.SCENE` 那两三个函数），
//   而 WebGL/相机/渲染循环/限帧/dpr/resize/音频算法/宿主接线**全部由骨架管**。
//
// ⚠️ 所以这一节原来那 20 条（查 CDN / canvas / dpr / resize / 限帧 /
//   wallpaperReady / e.buttons…）**整体作废** —— 那些现在是骨架的事，
//   而骨架有自己的测试（`skeleton.test.js`）。
//   ⟹ 判据：**架构变了，守卫要跟着搬家，不是逐条改**。
//     留着它们会变成"守着一个不存在的契约"。

// 一份"什么都对"的 scene.js —— 各条用例在它上面**破坏一处**再断言。
// ⚠️ 判据：先证明它自己零问题，否则后面每条都在坏基线上跑。
const GOOD = `// 配方：layout=ring audioMap=height palette=ice motion=breathe environment=topLight
(() => {
  'use strict';
  let mesh = null;
  const dummy = { o: null };
  window.SCENE = {
    build(ctx) {
      const { THREE } = ctx;
      dummy.o = new THREE.Object3D();
      const geo = new THREE.BoxGeometry(0.5, 1, 0.5);
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.4 });
      mesh = new THREE.InstancedMesh(geo, mat, 240);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      ctx.scene.add(mesh);
      ctx.camera.position.set(0, 12, 24);
      ctx.camera.lookAt(0, 0, 0);
    },
    frame(ctx) {
      if (!mesh) return;
      for (let i = 0; i < 240; i += 1) {
        const a = (i / 240) * Math.PI * 2;
        const h = 0.4 + ctx.audio.bins[i % 64] * 8 + Math.sin(ctx.t + a * 3) * 0.3;
        dummy.o.position.set(Math.cos(a) * 9, h / 2, Math.sin(a) * 9);
        dummy.o.scale.set(1, h, 1);
        dummy.o.updateMatrix();
        mesh.setMatrixAt(i, dummy.o.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
})();`;

console.log('\nscene.js 闸门');

check('基线：一份"什么都对"的 scene.js 零问题（否则后面每条都不可信）', () => {
  const problems = run(GOOD);
  assert.deepStrictEqual(problems, [],
    `基线自己就报错了 ⟹ 后面每条用例都建在坏基线上：\n${
      problems.map((p) => `      [${p.id}] ${p.detail}`).join('\n')}`);
});

check('A：语法错误被逮到（白屏的头号原因）', () => {
  const bad = GOOD.replace('mesh.instanceMatrix.needsUpdate = true;', 'if (((');
  const problems = run(bad);
  assert.ok(problems.some((p) => p.id === 'A-语法错误'), '语法错误没被逮到');
  // ⚠️ 报错原文要带上 —— 那是回喂给模型时它唯一能用来定位的东西
  assert.ok(problems.find((p) => p.id === 'A-语法错误').detail.length > 30,
    '语法错误的描述里没带解析器的原始报错');
});

check('B：没挂 window.SCENE 被逮到（骨架会拒绝启动）', () => {
  const bad = GOOD.replace('window.SCENE =', 'const SCENE_X =');
  assert.ok(ids(bad).includes('B-没挂 SCENE'));
});

check('B：缺 build 或 frame 被逮到', () => {
  for (const fn of ['build', 'frame']) {
    const bad = GOOD.replace(`${fn}(ctx) {`, `${fn}X(ctx) {`);
    assert.ok(ids(bad).includes('B-缺函数'), `缺 ${fn} 没被逮到`);
  }
});

// ---------------------------------------------------------------------------
// ⚠️⚠️ C 组：**不许重做骨架的活**
// ---------------------------------------------------------------------------
//
// 重做会和骨架**打架**（两个渲染循环、两次 setSize），而症状是
// "画面撕裂/闪烁/帧率减半" —— 那比白屏难查得多（画面在动，只是不对）。
check('C：自己建 WebGLRenderer 被逮到', () => {
  const bad = GOOD.replace('dummy.o = new THREE.Object3D();',
    'const r = new THREE.WebGLRenderer({});');
  assert.ok(ids(bad).includes('C-重做骨架/禁用'));
});

check('C：自己起渲染循环被逮到（两个循环会打架）', () => {
  const bad = GOOD.replace('    frame(ctx) {',
    '    frame(ctx) {\n      requestAnimationFrame(() => {});');
  assert.ok(ids(bad).includes('C-重做骨架/禁用'));
});

check('C：自己调 renderer.render 被逮到（等于帧率减半）', () => {
  const bad = GOOD.replace('mesh.instanceMatrix.needsUpdate = true;',
    'ctx.renderer.render(ctx.scene, ctx.camera);');
  assert.ok(ids(bad).includes('C-重做骨架/禁用'));
});

check('C：自己监听 resize 被逮到', () => {
  const bad = GOOD.replace("      dummy.o = new THREE.Object3D();",
    "      window.addEventListener('resize', () => {});");
  assert.ok(ids(bad).includes('C-重做骨架/禁用'));
});

check('C：import / require / fetch 都被逮到', () => {
  for (const line of ["import * as T from 'three';", "require('three');", "fetch('/x');"]) {
    const bad = `${line}\n${GOOD}`;
    assert.ok(ids(bad).includes('C-重做骨架/禁用'), `${line} 没被逮到`);
  }
});

check('C：输出了 HTML 被逮到（那是理解错任务）', () => {
  const bad = `<!DOCTYPE html><html><body></body></html>`;
  // ⚠️ extractScene 会先拦住它，但闸门也要能判（防止别的路径绕过）
  assert.ok(ids(bad).includes('C-重做骨架/禁用') || ids(bad).includes('B-没挂 SCENE'));
});

check('C：alert / debugger 被逮到', () => {
  for (const bad of [GOOD.replace('let mesh = null;', "alert('x');"),
    GOOD.replace('let mesh = null;', 'debugger;')]) {
    assert.ok(ids(bad).includes('C-重做骨架/禁用'));
  }
});

// ---------------------------------------------------------------------------
// ⚠️ D 组：InstancedMesh 的 needsUpdate
// ---------------------------------------------------------------------------
//
// ⚠️ 不置的话 GPU 上还是上一帧的数据 ⟹ **画面完全静止而不报错**。
//   那是这一类里最难查的失败（看起来像"壁纸卡住了"）。
check('D：改了 instance matrix 但忘了 needsUpdate 被逮到', () => {
  const bad = GOOD.replace('      mesh.instanceMatrix.needsUpdate = true;\n', '');
  assert.ok(ids(bad).includes('D-忘了 needsUpdate'),
    '忘了 needsUpdate 没被逮到 ⟹ 画面会完全静止而不报错');
});

check('D：用了 setColorAt 但忘了 instanceColor.needsUpdate 被逮到', () => {
  const bad = GOOD.replace('mesh.setMatrixAt(i, dummy.o.matrix);',
    'mesh.setMatrixAt(i, dummy.o.matrix); mesh.setColorAt(i, new ctx.THREE.Color());');
  assert.ok(ids(bad).includes('D-忘了颜色 needsUpdate'));
});

check('D 不误报：没用 InstancedMesh 时不查 needsUpdate', () => {
  const plain = GOOD
    .replace('mesh = new THREE.InstancedMesh(geo, mat, 240);', 'mesh = new THREE.Mesh(geo, mat);')
    .replace('      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);\n', '')
    .replace('        mesh.setMatrixAt(i, dummy.o.matrix);\n', '')
    .replace('      mesh.instanceMatrix.needsUpdate = true;\n', '');
  assert.ok(!ids(plain).some((x) => x.startsWith('D-')),
    '普通 Mesh 也被要求置 needsUpdate ⟹ 那会让模型去改一段本来对的代码');
});

// ---------------------------------------------------------------------------
// ⚠️ E 组：没音乐时也要动
// ---------------------------------------------------------------------------
check('E：完全没有时间相关的运动被逮到', () => {
  const bad = GOOD.replace('+ Math.sin(ctx.t + a * 3) * 0.3', '');
  assert.ok(ids(bad).includes('E-没有空闲动画'),
    '没有空闲动画没被逮到 ⟹ 没放音乐时画面完全静止，用户会以为壁纸坏了');
});

// ---------------------------------------------------------------------------
// ⚠️⚠️ F 组：每帧随机位置 —— **这一条我第一版写错了，实测连报三轮**
// ---------------------------------------------------------------------------
//
// 模型写的是**粒子诞生**（`particles.push({ vy: 0.5 + Math.random() * 1.5 })`）——
// 那正是规则里说"诞生时随机是对的"的情况，而我的正则分不出
// "诞生时随机一次"和"每帧重新随机"。
// ⟹ 症状：闸门 3 轮报同一条、模型每轮改一遍别的地方，白烧 60 秒。
// ⚠️ 判据：**一条闸门如果模型连改三轮都改不掉，先怀疑闸门错了。**
check('F：每帧把已有元素的位置赋成随机值 被逮到', () => {
  const bad = GOOD.replace('dummy.o.position.set(Math.cos(a) * 9, h / 2, Math.sin(a) * 9);',
    'mesh.position.x = Math.random() * 10;');
  assert.ok(ids(bad).includes('F-每帧随机位置'));
});

check('F 不误报：粒子诞生时随机是对的（实测栽过的那条）', () => {
  const ok = GOOD.replace('    frame(ctx) {', `    frame(ctx) {
      if (ctx.audio.bass > 0.4) {
        parts.push({ vx: (Math.random() - 0.5) * 2, vy: 0.5 + Math.random() * 1.5, life: 1 });
      }`).replace("  let mesh = null;", '  let mesh = null;\n  const parts = [];');
  assert.ok(!ids(ok).includes('F-每帧随机位置'),
    '粒子诞生时用随机被误判成"每帧随机位置" ⟹ 那正是实测连报三轮、'
    + '模型改不掉的那个误报');
});

check('F 不误报：随机的初速度/相位不算', () => {
  const ok = GOOD.replace('    frame(ctx) {', `    frame(ctx) {
      const jitter = Math.random() * 0.01;
      void jitter;`);
  assert.ok(!ids(ok).includes('F-每帧随机位置'));
});

// ---------------------------------------------------------------------------
// extractScene —— 模型经常不听"不要 markdown 围栏"
// ---------------------------------------------------------------------------
check('extractScene：剥掉 markdown 围栏', () => {
  const out = G.extractScene('```js\nwindow.SCENE = { build(){}, frame(){} };\n```');
  assert.ok(out.startsWith('window.SCENE'), `没剥掉围栏：${out.slice(0, 40)}`);
});

check('extractScene：模型输出 HTML 要报错（那是理解错任务）', () => {
  let msg = '';
  try { G.extractScene('<!DOCTYPE html><html><script>window.SCENE={}</script></html>'); }
  catch (e) { msg = e.message; }
  assert.match(msg, /HTML/, '输出 HTML 没被拦住 ⟹ 一份 HTML 会被当成 JS 写进 scene.js（白屏）');
});

check('extractScene：答非所问要报错并带上它说了什么', () => {
  let msg = '';
  try { G.extractScene('我不能帮你做这个。'); } catch (e) { msg = e.message; }
  assert.match(msg, /没有输出 scene\.js/, '没报"不是 scene.js"');
  assert.match(msg, /我不能帮你做这个/, '报错里没带上模型实际说的话');
});

// ---------------------------------------------------------------------------
// ⚠️⚠️ 骨架契约：喂给模型的 ctx 字段必须和骨架真的给出去的一致
// ---------------------------------------------------------------------------
//
// ⚠️ 错一个字段名，模型写的代码就是 `undefined.xxx` —— 而那是**运行时**才炸。
check('SKELETON_API 里的 ctx 字段和骨架真的给的一致', () => {
  const rt = fs.readFileSync(
    path.join(__dirname, '..', 'skeleton', 'runtime.js'), 'utf8');
  // 从 runtime.js 里抠出 ctx 对象的字段名
  const at = rt.indexOf('const ctx = {');
  assert.ok(at > 0, '在 runtime.js 里找不到 ctx —— 锚点变了，这条守卫要跟着改');
  const block = rt.slice(at, rt.indexOf('\n  };', at));
  const fields = [...block.matchAll(/^\s{4}(\w+)[,:]/gm)].map((m) => m[1]);
  // 那些解构出来的（THREE, scene, camera…）在同一行，单独抠
  const inline = (block.match(/^\s{4}([\w, ]+),$/m) || [])[1] || '';
  const all = new Set([...fields, ...inline.split(',').map((x) => x.trim())].filter(Boolean));
  assert.ok(all.size >= 8, `只抠出 ${all.size} 个 ctx 字段 —— 正则可能失效了`);
  for (const f of all) {
    assert.ok(G.SKELETON_API.includes(f),
      `骨架给了 ctx.${f}，但 SKELETON_API 里没说 ⟹ 模型不知道它存在（少一个能力）`);
  }
});

check('SKELETON_API 没说骨架其实不给的东西', () => {
  // ⚠️ 反过来：说了模型就会用，用了就是 undefined
  const rt = fs.readFileSync(
    path.join(__dirname, '..', 'skeleton', 'runtime.js'), 'utf8');
  const mentioned = [...G.SKELETON_API.matchAll(/ctx\.(\w+)/g)].map((m) => m[1]);
  for (const f of new Set(mentioned)) {
    assert.ok(rt.includes(f),
      `SKELETON_API 说有 ctx.${f}，但 runtime.js 里找不到它 ⟹ 模型会写出 undefined.xxx`);
  }
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
check('⚠️ 默认走 Bedrock 上的 Claude Opus（0.9.144 定的）', () => {
  // ⚠️⚠️⚠️ **这条守卫守的决定翻了两次**：
  //   0.9.123 默认 Bedrock → 0.9.126 换 DeepSeek（"Bedrock 要申请模型访问权，
  //     门槛太高"）→ 0.9.143 换回 Bedrock Claude。
  //   ⚠️ 而最后这次是**实测定的**，不是偏好：deepseek-v4-flash 是推理小模型，
  //     两步都把预算烧在思考上（6,465 / 74,299 字 reasoning_content），
  //     218 秒出 266 行，产物"自己在那转圈"。
  //   ⟹ 判据：**模型选型是可测的**（烧不烧思考 / 产物能不能跑 / 好不好看），
  //     而测出来的结论比"门槛高不高"这类推断重。
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const at = main.indexOf('    ai: {');
  assert.ok(at > 0, 'defaultConfig 里找不到 ai 块 —— 锚点变了，这条守卫要跟着改');
  // ⚠️ 切到这个对象字面量的结尾（`\n    },`），不用固定长度
  const block = main.slice(at, main.indexOf('\n    },', at));
  assert.match(block, /provider: 'bedrock'/, '默认提供方不是 bedrock');
  // ⚠️⚠️ **Opus**（0.9.144，用户点名）。我 0.9.143 选的是 Sonnet，理由是
  //   "快得多" —— 而那个权衡不该由我替他做：这个功能的第一要义是
  //   "稳定生成高质量的壁纸"，而生成一张是一次性的几十秒操作，
  //   不是每帧都跑的东西 ⟹ 慢一倍换质量划算。
  //   ⟹ 判据：**"贵/慢"这类取舍，用户点名了就按他的来。**
  // ⚠️ 而**不盯死完整 ID** —— 版本会升（4.8 → 之后的），
  //   盯死它会让每次升版都红一次而那不是错误。守"是 opus"就够。
  assert.match(block, /model: 'us\.anthropic\.claude-opus/,
    '默认模型不是 Bedrock 上的 Claude Opus');
  assert.match(block, /region: 'us-west-2'/, 'Bedrock 那支要 region');
  assert.match(block, /apiKey: null/, 'apiKey 的默认值必须是 null（绝不许硬编码 key）');
  // ⚠️ baseUrl 字段留着（切回 OpenAI 兼容那支时不用改两处），但它对 bedrock 无用
  assert.match(block, /baseUrl:/, 'baseUrl 字段删了 ⟹ 切回 OpenAI 兼容那支要改两处');
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

check('⚠️⚠️ 存量迁移：磁盘上的 deepseek 换成 Claude（光改默认值没用）', () => {
  // ⚠️⚠️⚠️ **这条是"改默认值"这件事的全部要点**：`mergeConfig` 保留磁盘上
  //   已有的值 ⟹ 只改 `defaultConfig` 对**已经装过的人完全无效**。
  //   ⟹ 判据：**改默认值必须配一条显式迁移。**
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const at = main.indexOf('function migrateConfig');
  assert.ok(at > 0, '找不到 migrateConfig');
  const body = main.slice(at, main.indexOf('\n}', at));
  assert.match(body, /ai\.provider === 'openai'/,
    'migrateConfig 里没有把存量的 deepseek 迁走 ⟹ 改了默认值对已装过的人没用'
    + '（mergeConfig 会保留他们存过的 deepseek-v4-flash）');
  assert.match(body, /ai\.model = 'us\.anthropic\.claude-opus/, '迁移没换成 Claude Opus');

  // ⚠️⚠️ **0.9.143 装过的人存的是 Sonnet ⟹ 要有第二条迁移**（0.9.144）。
  //   ⚠️ 而这两条是**独立的**：上面那条从 DeepSeek 来（换提供方 + 清 key），
  //     这条只换模型 ID。
  assert.match(body, /=== 'us\.anthropic\.claude-sonnet-4-5-20250929-v1:0'/,
    '没有"Sonnet → Opus"那条迁移 ⟹ 0.9.143 装过的人会一直用 Sonnet');
  // ⚠️⚠️⚠️ 而这条**绝不许动 apiKey** —— 用户 0.9.143 已经填过 Bedrock token
  //   并且验证通了，清掉等于让他白填一次。
  //   ⟹ 判据：**同一个提供方内换模型，凭证有效，别碰。**
  //     （上面那条清 key 是因为换了提供方 —— 两件事不一样。）
  const sonnetMig = body.slice(body.indexOf("=== 'us.anthropic.claude-sonnet"));
  const nextIf = sonnetMig.indexOf('\n  if (');
  const migBody = sonnetMig.slice(0, nextIf > 0 ? nextIf : 900);
  assert.ok(!/ai\.apiKey\s*=/.test(migBody),
    'Sonnet → Opus 那条迁移动了 apiKey ⟹ 同一个提供方，用户填过的 token 还有效，'
    + '清掉等于让他白填一次');

  // ⚠️⚠️ **迁移只认"我们自己写进去的那两个模型 ID"** ——
  //   写成活规则（"凡是 deepseek 就换"）会把用户以后主动选的 deepseek 也换掉。
  //   ⟹ 判据：**一次性迁移要硬编码"当时的那个值"。**
  assert.match(body, /OURS = \['deepseek-v4-flash', 'deepseek-v4-pro'\]/,
    '迁移没限定在"我们写进去的那两个模型 ID" ⟹ 会覆盖用户主动选的 deepseek');
  assert.match(body, /OURS\.includes\(String\(ai\.model/,
    '迁移的条件没用那张白名单');

  // ⚠️⚠️⚠️ 而这次**apiKey 必须清掉** —— 和 0.9.126 那次相反。
  //   理由：DeepSeek 的 key 在 Bedrock 上返回 401，留着它用户只会看到
  //   "key 填错了或者过期了"，而不知道是换了提供方。
  //   ⟹ 清成 null 之后面板说"还没填 key"，而那句话是**对的**。
  //   ⚠️ 判据：**换提供方时留着旧凭证是在制造一条误导性的报错。**
  const migLines = body.slice(body.indexOf("ai.provider === 'openai'"));
  assert.match(migLines, /ai\.apiKey = null/,
    '换提供方时没清掉旧 key ⟹ DeepSeek 的 key 在 Bedrock 上是 401，'
    + '用户会看到"key 填错了"而不知道是提供方换了');
  // ⚠️ 而日志里要说清这件事（用户会想"我的 key 呢"）
  assert.match(body, /环境变量 AWS_BEARER_TOKEN_BEDROCK 会自动用上|AWS_BEARER_TOKEN_BEDROCK/,
    '迁移日志没提环境变量那条路 ⟹ 用户不知道他 .bashrc 里那个能用');
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
  // ⚠️⚠️ **切到结构边界，不用固定长度** —— gating 里那条守卫逮到了我这三处。
  //   而它不是形式主义：我原来写 `at + 3000`，那个窗口**盖过了函数末尾、
  //   吃到了文件底部的 module.exports**，直接导致下面那条 parseResponse 断言
  //   当场误报。⟹ 固定长度的锚点会漂，而漂了之后断言测的不是它以为的那段代码。
  const end = src.indexOf('\nasync function ', at + 10);
  const body = src.slice(at, end > 0 ? end : src.indexOf('\nmodule.exports', at));
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

check('⚠️⚠️ 探针两家协议都要能读出正文（0.9.144 真事故）', () => {
  // ⚠️⚠️⚠️ 用户 2026-08-02 实测：Bedrock Claude 探针说"通了"而 `回了「」`。
  //   根因：`ping()` 只认 OpenAI 的 `data.choices[0].message.content`，
  //   而 Bedrock 的正文在 `data.content[0].text`。
  //   ⟹ 症状是"通了但看起来什么都没回"，而那**比报错更坏**：
  //     它让人以为模型有问题，而其实是我这边读错了字段。
  //   ⟹ 判据：**一个函数支持两种协议时，两条分支都要有人走过。**
  //     `chat()` 那边一直是分开处理的，而探针漏了 ——
  //     因为它是后加的，而当时默认提供方是 DeepSeek（另一条分支）。
  const llmRaw = fs.readFileSync(path.join(__dirname, '..', 'src', 'llm.js'), 'utf8');
  // ⚠️⚠️⚠️ **必须剥注释**。反向验证逮住这条：我在 ping 上面写的那段注释里
  //   **引用了这些字符串本身**（"Bedrock 的正文在 `data.content[0].text`，
  //   不在 `data.choices[0].message.content`"、"`if (provider === 'bedrock')`"、
  //   "output_tokens 而不是 completion_tokens"）
  //   ⟹ 把真正的代码整个删掉，注释还在，断言照样满足 ⟹ 守卫是死的。
  //   ⟹ 判据：**守卫读的是代码，不是注释** —— 而"我为了说清楚而引用了
  //     那个标识符"恰恰让注释成为最容易骗过守卫的东西。
  //     （这个项目为"关键词撞到注释"栽过多次，这是又一次，而这次是
  //      **我自己刚写的注释**撞的。）
  const llm = llmRaw.split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const at = llm.indexOf('async function ping(');
  assert.ok(at > 0, '找不到 ping');
  const body = llm.slice(at, llm.indexOf('\nmodule.exports', at));
  // ① 要按提供方分支
  assert.match(body, /provider === 'bedrock'/,
    'ping 没有按提供方分支 ⟹ 它只认得一家的响应形状（另一家会"通了但正文空"）');
  // ②⚠️ Bedrock 那支要读 data.content 里的 text 块。
  //   ⚠️⚠️ 锚到**那一整句**，不是 `data.content` 这四个字 ——
  //     它在 ping 里出现在两处代码上（`Array.isArray(data.content) ? data.content`
  //     本身就是两次）⟹ 改坏一处照样绿（反向验证逮到）。
  assert.match(body, /Array\.isArray\(data\.content\) \? data\.content : \[\]/,
    'ping 没读 Bedrock 的 data.content ⟹ Claude 回的正文读不出来'
    + '（症状是"通了但回了「」"，而那比报错更坏：让人以为模型有问题）');
  assert.match(body, /c\.type === 'text'/,
    '没只取 text 块 ⟹ 开了 thinking 之后第一块是 thinking，那不是正文');
  // ③⚠️ 而 OpenAI 那支要还在。同上：锚整句 ——
  //   `data.choices` 在 ping 里出现在**四处**（取 message、取 finish_reason）
  assert.match(body, /const msg = \(data\.choices && data\.choices\[0\] && data\.choices\[0\]\.message\)/,
    'OpenAI 兼容那支的正文解析没了 ⟹ 换回 DeepSeek 的人会看到"通了但回了「」"');
  assert.match(body, /data\.choices\[0\]\.finish_reason/,
    'OpenAI 兼容那支没读 finish_reason ⟹ "被长度截断"这条判不出来');
  // ④⚠️ usage 的字段名两家也不同（completion_tokens vs output_tokens）
  assert.match(body, /output_tokens/,
    'Bedrock 的 usage 字段名是 output_tokens，不是 completion_tokens'
    + ' ⟹ 不认它的话"花了多少 token"永远是 undefined');
  // ⑤⚠️⚠️ 而 thinking 块要当成"这个模型会思考"的信号
  //   （那是 0.9.126 事故的观测点，Anthropic 这边叫 thinking 不叫 reasoning_content）
  assert.match(body, /c\.type === 'thinking'/,
    'Bedrock 那支没认 thinking 块 ⟹ "这个模型会不会空转思考"在 Claude 上测不出来');
});

check('面板：探针发现是推理模型要当场提醒（"通了"不等于"能用"）', () => {
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  const at = dash.indexOf("aiEl('ai-ping')");
  assert.ok(at > 0, '找不到探针按钮的处理');
  // ⚠️ 切到下一个 `aiEl('…')` 的绑定处（那是这一段的天然结尾），不用固定长度
  const end = dash.indexOf('\nwindow.gw.onGenProgress', at);
  assert.ok(end > at, '找不到这一段的结尾锚点（onGenProgress）—— 这条守卫要跟着改');
  const body = dash.slice(at, end);
  assert.match(body, /r\.thinks/,
    '面板没检查 thinks ⟹ 用户会看到"通了"然后等几分钟再失败');
  // ⚠️ 不能只 match /推理模型/ —— 这段里它出现**两次**（提醒的标题句 + 解释句）
  //   ⟹ 破坏任一处另一处照样满足它，断言是死的（反向验证逮到的）。
  //   ⟹ 锚定那句**给用户看的话**的完整形状：`${r.model} 是**推理模型**`。
  assert.match(body, /\$\{r\.model\} 是\*\*推理模型\*\*/,
    '提醒里没点名"这个模型是推理模型" ⟹ 用户不知道该换哪个');
  // ⚠️ 而"为什么这会失败"也要说 —— 只说"是推理模型"用户不知道那有什么问题。
  //   ⚠️⚠️ 而这条不能 match /预算|思考/：这段里"思考"出现 5 次、"预算" 2 次
  //     ⟹ 破坏任一处都还剩一堆，断言是死的（反向验证逮到的）。
  //   ⟹ 锚定那句**完整的因果**：预算先花在思考上 ⟹ 常常一行代码都没写。
  assert.match(body, /输出预算先花在思考上/,
    '没解释"为什么"推理模型会导致生成失败 ⟹ 用户只知道要换、不知道换成什么样的');
  assert.match(body, /一行代码都没写|没返回内容/,
    '没说清失败的症状长什么样 ⟹ 下次撞到同一件事时对不上号');
});

check('⚠️ 生成的预算够用，而"不够"要能自己救回来', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  // ⚠️ 不切窗口 —— 直接用一条正则匹配「那个调用 + 它的 maxTokens」这个整体形状。
  //   ⚠️ 判据：能一条正则锚定的就别切片。切片要选长度，而任何长度都会漂。
  // ⚠️⚠️ 0.9.140 起是 **20000**（不是 32000）—— 架构变了：
  //   模型现在只写 `scene.js`（一两百行），不是整个 index.html
  //   ⟹ 需要的输出预算小得多。而 16000 那次爆掉是因为**推理模型把预算烧在
  //     思考上**（用户账单实测），那和"写多少代码"是两件事。
  //   ⚠️ 20000 仍然远高于实测用量（一两百行约 3k token）⟹ 留足余量。
  // ⚠️⚠️⚠️ 而**盯死一个具体数字是错的守法** —— 我为它红过两次
  //   （20000 → 24000）。这条守卫真正该守的不是"等于某个数"，
  //   是"够用" + "不够的时候有出路"。
  //   ⟹ 判据：**守区间和机制，别守我这次填的那个值。**
  // ⚠️⚠️ 这里要找的是**写代码那一步**的预算。0.9.142 拆成三步之后
  //   文件里有两个 maxTokens：设计那步 4000（只要几百字文字）、
  //   写代码那步是大的。⚠️ 我第一版是"第一个匹配的"⟹ 抓到了 4000 报红。
  //   ⟹ 判据：**有多个同类值时锚到"哪一个"，别靠出现顺序。**
  // ⚠️ 0.9.142 之后写代码那一步用的是**默认值**（`o.maxTokens || 24000`），
  //   而设计那一步显式传 4000 ⟹ 两种写法都要认。
  const budget = Math.max(...[...main.matchAll(/maxTokens: (?:o\.maxTokens \|\| )?(\d+)/g)]
    .map((x) => Number(x[1])));
  assert.ok(Number.isFinite(budget), '找不到生成时的 maxTokens');
  // 一两百行 scene.js 约 3k token ⟹ 万级是充足余量；太大也没意义（成本白涨）
  assert.ok(budget >= 16000 && budget <= 64000,
    `生成预算 ${budget} 不在合理区间 [16000, 64000]`);

  // ⚠️⚠️ 而**"预算不够"必须能自己救** —— 用户 2026-08-02 实测撞到的那次
  //   （69,841 字 reasoning_content、正文一个字没写）不是预算小，是**推理模型
  //   把预算烧在思考上**：调到多大它都可能想到那么大。
  //   ⟹ 光报错让用户换模型是把唯一能自动救回来的路堵死了（他手上可能只有一个 key）。
  assert.match(main, /lessThinking: true/,
    '空正文/截断之后没有"让它少想再来一次"的重试 ⟹ 那把唯一能自动救回来的路堵死了');
  assert.match(main, /error\.emptyBody \|\| .*error\.truncated|!error\.emptyBody && !error\.truncated/,
    '重试没限定在"空正文/截断"这两种 ⟹ 401/网络不通也重试等于白等');
});

check('提示词里要求"直接写代码、别长篇分析"（生成和回喂两条都要）', () => {
  // ⚠️ 那是我们唯一能对模型行为施加的影响 —— 换模型是用户的事，
  //   而提示词是我们的。
  // ⚠️ 0.9.140 改名：buildGeneratePrompt → buildScenePrompt（它现在产的是
  //   "写 scene.js"的提示词，而不是"写整个 index.html"）。
  // ⚠️ `buildScenePrompt` 0.9.148 删了（只剩测试在调它 = 死代码）——
  //   生产流程从 0.9.142 起是两步：设计 → 写代码。⟹ 改成测那两个。
  for (const [name, prompt] of [
    ['设计', G.buildPlanPrompt('极光')],
    ['写代码', G.buildImplementPrompt('设计说明', '// example', null)],
    ['回喂', G.buildRepairPrompt('window.SCENE={}', [{ id: 'X', detail: 'y' }])],
  ]) {
    // ⚠️ 三步的措辞不同：设计那步要"别写成文章"，写代码那步要"别复述设计"
    //   ⟹ 判据：**守"有没有要求它别空转"这件事，不是守某一句话。**
    assert.match(prompt, /不要先长篇分析|不要先长篇|别更长|不要复述设计|别写成文章/,
      `${name}提示词里没要求"别空转" ⟹ 推理模型会把预算烧在思考/复述上`);
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


// ═══════════════════════════════════════════════════════════════════════════
//  构图 / 设计判定（0.9.145 —— "好不好看"里能机器判的那部分）
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n  构图与设计判定');

// ⚠️ 参考壁纸的实测值（preview.gif 200 帧逐帧量化）
const REF_PIXELS = {
  black: 300, total: 1024, bright: 120,
  bands: [25, 90, 50], satMedian: 0.32, subjectRatio: 0.35,
};

check('⚠️⚠️ 参考壁纸的实测值本身零问题（否则这套判定是错的）', () => {
  // ⚠️⚠️⚠️ 这是这套判定器的**校准基准**：目标本身必须通过。
  //   ⟹ 判据：**一条闸门把"公认好的那个"判红，就是闸门错了。**
  const out = G.judgeComposition({ sampledPixels: REF_PIXELS });
  assert.deepStrictEqual(out, [],
    `参考壁纸的实测值被判出 ${out.length} 个问题（${out.map((x) => x.id).join(',')}）`
    + ' ⟹ 阈值定错了：目标本身必须能通过');
});

check('铺满 / 全亮 / 全平 / 荧光色 四种都逮得住', () => {
  const cases = [
    ['C-铺满了', { ...REF_PIXELS, black: 20 }],
    ['C-太亮了', { ...REF_PIXELS, bright: 700 }],
    ['C-上方太亮', { ...REF_PIXELS, bands: [120, 130, 100] }],
    ['C-颜色太艳', { ...REF_PIXELS, satMedian: 0.95 }],
    ['C-没有明暗层次', { ...REF_PIXELS, bands: [80, 82, 79] }],
  ];
  for (const [id, px] of cases) {
    const ids = G.judgeComposition({ sampledPixels: px }).map((x) => x.id);
    assert.ok(ids.includes(id), `${id} 没被逮住（只报了 ${ids.join(',') || '（无）'}）`);
  }
});

check('⚠️ 没有像素数据时不判（截图失败不是壁纸的错）', () => {
  assert.deepStrictEqual(G.judgeComposition({}), []);
  assert.deepStrictEqual(G.judgeComposition({ sampledPixels: { black: 0, total: 0 } }), []);
  // ⚠️ 老版探针没有 bands 字段 ⟹ 也不判（别让升级过程中报一堆假问题）
  assert.deepStrictEqual(
    G.judgeComposition({ sampledPixels: { black: 5, total: 400 } }), []);
});

check('⚠️ 报错里要带**具体数字和参考值**（不然模型改不动）', () => {
  const out = G.judgeComposition({ sampledPixels: { ...REF_PIXELS, black: 20 } });
  const detail = out.map((x) => x.detail).join(' ');
  // ⚠️⚠️ 这是这一层存在的**全部理由**：模型拿到"近黑只占 2%（参考是 20-45%）"
  //   能真的改，而"不好看"它改不了。
  assert.match(detail, /\d+%/, '没给出实测百分比');
  assert.match(detail, /参考壁纸/, '没给出参考值 ⟹ 模型不知道该改到多少');
  // ⚠️ 而要给出**怎么改** —— 只说"不对"等于把问题扔回去
  assert.match(detail, /收缩|没入|雾/, '没说怎么改');
});

check('⚠️⚠️ inspectDesign 逮住"元素太少 / 视角太高 / 只有一种动态"', () => {
  // ⚠️ 这三条从像素测不出来（俯视和低视角在三带亮度上可以完全一样），
  //   但能从代码里读 ⟹ 判据：能从代码读的就别猜像素。
  const bad = [
    'new THREE.InstancedMesh(geo, mat, 16 * 16);',
    'camera.position.set(0, 14, 18);',
    'grid.scale.set(1 + bass, 1, 1 + bass);',
  ].join('\n');
  const ids = G.inspectDesign(bad).map((x) => x.id);
  for (const id of ['C-元素太少', 'C-视角太高', 'C-只有一种动态']) {
    assert.ok(ids.includes(id), `${id} 没被逮住（报了 ${ids.join(',')}）`);
  }
});

check('⚠️⚠️⚠️ 而我们自己那份示例场景零问题（校准基准）', () => {
  // ⚠️⚠️ `scene.example.js` 是**用户在真机上跑过、说"能看"的那份**
  //   （2026-08-02：「深蓝黑底 + 中间一块青色的柱体网格在缓慢起伏」+ 会跟音乐）
  //   ⟹ 判据：**一条闸门把已知可接受的产物判红，就是阈值错了。**
  //     我第一版视角阈值 0.55 就把它判红了（它是 (0,15,26)，y/z=0.58）⟹ 放到 0.75。
  const ex = fs.readFileSync(
    path.join(__dirname, '..', 'skeleton', 'scene.example.js'), 'utf8');
  const out = G.inspectDesign(ex);
  assert.deepStrictEqual(out, [],
    `示例场景被判出 ${out.length} 个问题（${out.map((x) => x.id).join(',')}）`
    + ' ⟹ 那份是用户真机验过能看的，阈值把它判红就是阈值错了');
});

check('⚠️ inspectDesign 不误报：算不出个数时不判', () => {
  // ⚠️ 第三个参数是表达式而没有字面数字 ⟹ **宁可不判也别误判**
  //   （F 闸门为"误报正确写法"栽过：连三轮误报粒子诞生的 Math.random）
  const expr = 'new THREE.InstancedMesh(geo, mat, count * rows);';
  const ids = G.inspectDesign(expr).map((x) => x.id);
  assert.ok(!ids.includes('C-元素太少'),
    '个数是表达式（算不出来）时误报了"元素太少"');
  // ⚠️ 没用 InstancedMesh 的也不判个数（一个大球体可能就是对的）
  assert.ok(!G.inspectDesign('const m = new THREE.Mesh(g, mt);').map((x) => x.id)
    .includes('C-元素太少'), '没用 InstancedMesh 时误报了个数');
  // ⚠️ z 很小时不判视角（那可能是刻意的正视构图）
  assert.ok(!G.inspectDesign('camera.position.set(0, 8, 2);').map((x) => x.id)
    .includes('C-视角太高'), 'z 很小（刻意正视）时误报了视角');
});

check('⚠️ 事件动态的判定认不同的变量名（不是找关键词）', () => {
  // ⚠️⚠️ 判据：找**那个模式的三个动作**（push / 每帧推进 / 到期 filter），
  //   而不是找 `ripples` 这个名字 —— 叫 pulses、waves、shocks 都该认。
  for (const name of ['ripples', 'pulses', 'waves', 'shocks']) {
    const code = `${name}.push({ x: 0, r: 0, life: 1 });\n`
      + `for (const w of ${name}) { w.r += ctx.dt * 12; w.life -= ctx.dt * 0.5; }\n`
      + `${name} = ${name}.filter((w) => w.life > 0);\n`
      + 'camera.position.set(0, 4, 22);';
    const ids = G.inspectDesign(code).map((x) => x.id);
    assert.ok(!ids.includes('C-只有一种动态'),
      `变量叫 ${name} 时没认出事件动态 ⟹ 那条判定在找名字而不是找模式`);
  }
});



// ═══════════════════════════════════════════════════════════════════════════
//  "画面一片黑"的三个根因（0.9.147 —— 用户实测那次）
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n  一片黑的根因');

const OK_SCENE = 'window.SCENE={build(ctx){},frame(ctx){Math.sin(ctx.t);}};';
const H = { checkJsSyntax: () => null };

check('⚠️⚠️⚠️ 删了默认灯还用需光材质 → 拦住（那是纯黑，不是暗）', () => {
  // ⚠️⚠️ 用户 2026-08-03 实测："这次的效果看起来一片黑"，读数是
  //   **场景 1 个对象、高亮 0%、三带 12/9/6**。
  //   "1 个对象"是关键：骨架默认放了一个 defaultLights Group ⟹ 只有 1 个
  //   意味着模型删掉了它（或者一个都没加）。而 MeshStandard/Phong/Lambert
  //   **没有光就是字面的 (0,0,0)** —— 那不是"暗"，是纯黑。
  //   ⚠️ 而这个组合**三轮都没被修掉**，因为回喂里只有"太暗了"这种现象描述。
  //   ⟹ 判据：**回喂要给根因，不是给现象。**
  const bad = `${OK_SCENE}ctx.scene.remove(ctx.defaultLights);`
    + 'const m = new THREE.MeshStandardMaterial({}); ctx.scene.add(x);';
  const ids = G.inspect(bad, H).map((x) => x.id);
  assert.ok(ids.includes('C2-删了灯还用需光材质'),
    `没拦住"删灯+需光材质"（只报了 ${ids.join(',') || '（无）'}）`
    + ' ⟹ 那个组合必然全黑，而它在用户机器上真的发生了');
  // ⚠️ 报错里要给**两条出路**，不是只说"错了"
  const detail = G.inspect(bad, H).find((x) => x.id === 'C2-删了灯还用需光材质').detail;
  assert.match(detail, /MeshBasicMaterial/, '没给"换自发光材质"这条出路');
  assert.match(detail, /AmbientLight|自己加灯/, '没给"自己加灯"这条出路');
  assert.match(detail, /纯黑/, '没说清是"纯黑"而不是"暗" ⟹ 模型会去调亮度系数');
});

check('⚠️ 而三种合法组合都要放过（我们鼓励模型换打光）', () => {
  // ⚠️⚠️ 0.9.140 特意放开了灯光（见 MODULES.md ⑤b）——
  //   这条闸门不是"不许删灯"，是"删了要么自己加、要么换自发光"。
  const cases = [
    ['删灯 + 自发光', 'ctx.scene.remove(ctx.defaultLights);'
      + 'const m = new THREE.MeshBasicMaterial({});'],
    ['删灯 + 自己加灯', 'ctx.scene.remove(ctx.defaultLights);'
      + 'ctx.scene.add(new THREE.AmbientLight(0xffffff, 0.4));'
      + 'const m = new THREE.MeshStandardMaterial({});'],
    ['留着默认灯', 'const m = new THREE.MeshStandardMaterial({}); ctx.scene.add(x);'],
  ];
  for (const [name, code] of cases) {
    const ids = G.inspect(OK_SCENE + code, H).map((x) => x.id);
    assert.ok(!ids.includes('C2-删了灯还用需光材质'),
      `"${name}"被误判了 ⟹ 那是合法组合，闸门不该拦`);
  }
});

check('建了 Mesh 但没 add 进场景 → 拦住（这个不报错）', () => {
  const bad = `${OK_SCENE}const m = new THREE.InstancedMesh(g, mt, 5000);`;
  const ids = G.inspect(bad, H).map((x) => x.id);
  assert.ok(ids.includes('C3-没加进场景'),
    `没拦住"建了不 add"（报了 ${ids.join(',')}）⟹ 那是"什么都不显示"且不报错`);
});

check('⚠️⚠️ 回喂时点名"上一轮改过但没解决"的那些', () => {
  // ⚠️ 用户那次三轮都在修，读数 12/9/6 一动没动 ——
  //   因为模型沿着同一个错方向微调（改颜色的 L 值，而根因是没有光）。
  //   ⟹ 判据：**同一个问题第二次出现时要明说"上一轮那样改没用"。**
  const p1 = G.buildRepairPrompt('code', [{ id: 'C-太暗了', detail: 'x' }], {});
  assert.ok(!/上一轮你已经改过/.test(p1), '第一次出现时不该说"上一轮改过"');

  const p2 = G.buildRepairPrompt('code', [{ id: 'C-太暗了', detail: 'x' }],
    { repeated: ['C-太暗了'] });
  assert.match(p2, /上一轮你已经改过一次了，但没解决/,
    '重复出现的问题没被点名 ⟹ 模型会继续沿着同一个错方向微调');
  assert.match(p2, /C-太暗了/, '没列出是哪些问题重复了');
  // ⚠️⚠️ 而要给**候选根因**，不是只说"换个方向" —— 那句话没有信息量。
  //   ⚠️⚠️⚠️ 反向验证逮住这条：我原来是三条 `assert.match` 各查一个关键词，
  //     而**删掉其中任意一条候选根因，另两条还在 ⟹ 三个断言里只有一个报红**，
  //     而那一个的失败信息说的是"没给 X"，看起来像只丢了一条。
  //     ⟹ 那还算逮住了。但更本质的问题是：**"候选根因够不够多"这件事
  //       我没在守** —— 剩一条也能过。
  //   ⟹ 判据：**守数量下界**，那样删掉任何一条都会报红且说得清。
  // ⚠️⚠️⚠️ **只在"候选根因那份清单"里找**，不是全文找。
  //   反向验证逮住这条（第 11 次同类问题）：`defaultLights` 在整份提示词里
  //   出现 **3 次**（候选根因那行 + SKELETON_API 摘要里的 ctx 字段表）
  //   ⟹ 把候选根因那一行删掉，全文搜索照样命中 ⟹ 守卫是死的。
  //   ⟹ 判据：**先把窗口收到"那件事发生的地方"，再找关键词。**
  const listAt = p2.indexOf('比如"画面太暗"的根因可能是');
  assert.ok(listAt > 0, '找不到候选根因那份清单 ⟹ 它被删了或者改了措辞');
  const list = p2.slice(listAt, p2.indexOf('⚠️ 换一个假设', listAt));
  const rootCauses = ['defaultLights', 'scene.add', '相机背后', 'opacity'];
  const present = rootCauses.filter((k) => list.includes(k));
  // ⚠️ 下界设成 4（提示词里正好有这 4 条）—— 设成 3 的话删掉一条刚好在界上、
  //   不报红（反向验证逮到）。⟹ 判据：**下界要等于当前的数量**，
  //   那样少任何一条都会红；真要减是有意的决定，那时改这个数字。
  assert.strictEqual(present.length, rootCauses.length,
    `候选根因只给了 ${present.length}/${rootCauses.length} 条`
    + `（有：${present.join('/')}）⟹ "太暗"的根因有好几种`
    + '（没光 / 没 add / 在视锥外 / 透明度设错），只给一部分等于把模型往那几个方向推');
});

check('⚠️⚠️ 提示词里讲清"灯光和材质要配套"', () => {
  // ⚠️ 这条陷阱**之前提示词里一个字都没提** —— 我查过：
  //   MeshBasicMaterial / defaultLights / 纯黑 三个词全部缺失。
  //   ⟹ 而它是"一片黑"的头号原因。
  const impl = G.buildImplementPrompt('plan', '// ex', G.readSkeletonSource());
  // ⚠️⚠️ 同上：`MeshBasicMaterial` 在整份提示词里出现 **2 次**
  //   （材质表 + 合法组合清单）⟹ 删掉表格那一行照样绿。
  //   ⟹ 锚到**那张表**（它有表头"需要灯吗"，那是独一无二的）。
  const tableAt = impl.indexOf('| 材质 | 需要灯吗 | 没灯的结果 |');
  assert.ok(tableAt > 0,
    '找不到"材质 vs 需不需要灯"那张表 ⟹ 那是"一片黑"头号原因的唯一说明');
  const table = impl.slice(tableAt, impl.indexOf('⟹ 三条合法组合', tableAt));
  // ⚠️ 表里三类材质都要在（不能只说 Basic 不说 Standard —— 那样模型不知道边界）
  for (const m of ['MeshBasicMaterial', 'MeshStandardMaterial', 'Phong']) {
    assert.ok(table.includes(m), `材质表里没有 ${m}`);
  }
  assert.match(table, /纯黑/, '表里没说清"没光是纯黑不是暗" ⟹ 模型会去调亮度系数');
  assert.match(impl, /三条合法组合/, '没给出合法组合的清单');
  // ⚠️ 另两个"什么都不显示"的原因也要提
  assert.match(impl, /ctx\.scene\.add/, '没提"建了要 add 进场景"');
  assert.match(impl, /相机背后|视锥/, '没提"元素在视锥外"');
  // ⚠️ 设计那步也要要求它说清材质和灯的搭配
  const plan = G.buildPlanPrompt('');
  assert.match(plan, /灯光和材质要配套/,
    '设计那步没要求说清材质和灯的搭配 ⟹ 那个决定在设计阶段就该定了');
});

check('⚠️⚠️ "太暗"也要判 —— 一个区间要判两头', () => {
  // ⚠️⚠️⚠️ 我第一版只判了"太亮"（>45%）和"铺满"（近黑<8%）——
  //   而用户那次是**高亮 0%、三带 12/9/6**，六条构图判定只报了一条
  //   （主体不在中间），"一片黑"这个最显眼的问题一条都没逮住。
  //   ⚠️ 而 R-画面全黑（近黑>99.5%）也没报 —— 它有 50% 近黑，
  //     不是"全黑"，是**"有东西但全都很暗"**。那是两种不同的失败。
  //   ⟹ 判据：**一个区间要判两头。**
  const dark = { black: 514, total: 1024, bright: 0,
    bands: [12, 9, 6], satMedian: 0.4, subjectRatio: 0.5 };
  const ids = G.judgeComposition({ sampledPixels: dark }).map((x) => x.id);
  assert.ok(ids.includes('C-太暗了'),
    `用户那次的真实数据没报"太暗"（只报了 ${ids.join(',')}）`);
  assert.ok(ids.includes('C-整体太暗'), '没报"主体那一带太暗"');
  // ⚠️ 而参考壁纸仍须零问题（校准基准）
  assert.deepStrictEqual(
    G.judgeComposition({ sampledPixels: REF_PIXELS }), [],
    '加了"太暗"判定之后参考壁纸被判红了 ⟹ 阈值错了');
});



// ═══════════════════════════════════════════════════════════════════════════
//  ⚠️⚠️ 拿**真实产物**当测试样本（0.9.148）
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️⚠️⚠️ `fixtures/bad-cone-and-dark.scene.js` 是用户 2026-08-03 在真机上
//   生成出来的那张（`wallpaper-08030114`），他说"生成的不好看"。
//   读数：高亮 **0%**、三带 8/28/9、画面是"中间一个亮尖 + 四周全黑"。
//
// ⚠️ 判据：**闸门要拿真实的失败产物当样本，不是我手写的假代码。**
//   我手写的样本只会命中我想到的那种写法 —— 而这次两条判定的第一版
//   都在真实代码上没逮住（详见 wallpaper-gen.js 里那两段注释）。
console.log('\n  真实失败产物（用户 08030114 那张）');

const BAD_REAL = (() => {
  try {
    return fs.readFileSync(
      path.join(__dirname, 'fixtures', 'bad-cone-and-dark.scene.js'), 'utf8');
  } catch { return null; }
})();

check('⚠️⚠️ 那张"中间一个尖、四周全黑"的要被逮住', () => {
  assert.ok(BAD_REAL, 'fixtures/bad-cone-and-dark.scene.js 不在 ⟹ 那是真实失败样本，别删');
  const ids = G.inspectDesign(BAD_REAL).map((x) => x.id);
  // ① 亮度连乘 —— 它 `lum *= (0.1 + 0.9*(1-dd))` 在平方衰减之后又乘了一次
  assert.ok(ids.includes('C-亮度连乘'),
    `没逮住亮度连乘（报了 ${ids.join(',') || '（无）'}）`
    + ' ⟹ 那张的外圈乘到 0.1，实测高亮占比 0.0%');
  // ② 像个圆锥 —— 高度里 `core * 2.6` 和频谱的 `* 3.5` 同量级
  assert.ok(ids.includes('C-像个圆锥'),
    `没逮住"像个圆锥"（报了 ${ids.join(',')}）`
    + ' ⟹ 那张的高度里硬加了 core * 2.6，不管音乐怎么放中心那个尖都在');
});

check('⚠️⚠️⚠️ 而"有位置噪声"不足以证明它不是圆锥（第一版判错在这）', () => {
  assert.ok(BAD_REAL, '样本不在');
  // ⚠️ 我第一版判的是"高度里有距离变量 && 没有 Math.sin(x)" ——
  //   而那张**两个条件都满足**（它有 `Math.sin(x * 0.3) * Math.cos(z * 0.3)`）
  //   ⟹ 判定没触发。看代码才发现：那个位置噪声**只在"没音频"那条分支里**。
  //   ⟹ 判据：**判"距离项的权重"，不是判"有没有位置噪声"。**
  assert.match(BAD_REAL, /Math\.sin\(x \* 0\.3/,
    '样本里应该有位置噪声（这条测试的全部意义就是"有它也照样是圆锥"）');
  assert.match(BAD_REAL, /core \* 2\.6/,
    '样本里应该有 core * 2.6（那是硬加的圆锥）');
  // ⟹ 所以判定必须靠权重比较才能逮住它
  const ids = G.inspectDesign(BAD_REAL).map((x) => x.id);
  assert.ok(ids.includes('C-像个圆锥'), '权重判定失效了');
});

check('⚠️ 正确写法不误报（距离只选 bin + 位置噪声）', () => {
  const good = [
    'const bin = Math.floor(dist / R * 40);',
    'let target = 0.3 + bins[bin] * 4 + Math.sin(x * 0.3) * Math.cos(z * 0.4) * 0.5;',
    'const lum = 0.85 - 0.6 * d;',
    'camera.position.set(0, 4, 22);',
    'ripples.push({ r: 0, life: 1 });',
    'for (const w of ripples) { w.r += ctx.dt * 12; w.life -= ctx.dt * 0.5; }',
    'ripples = ripples.filter((w) => w.life > 0);',
    'new THREE.InstancedMesh(geo, mat, 8000);',
  ].join('\n');
  assert.deepStrictEqual(G.inspectDesign(good), [],
    '正确写法被误报了 ⟹ 距离只用来选 bin、亮度一次衰减、有位置噪声，那是对的');
});

check('⚠️ 提示词里讲清"地形不是圆锥"和"亮度只衰减一次"', () => {
  const plan = G.buildPlanPrompt('');
  // ⚠️ 这两条**之前提示词里一个字都没提** —— 而实测三次都错在结构上
  assert.match(plan, /一整片起伏的地形/, '没说清它是地形不是几何体');
  assert.match(plan, /中心一个尖锥/, '没点名"中心一个尖锥"这个错法');
  assert.match(plan, /不直接决定高度/,
    '没说清"到中心的距离只用来选频段，不直接决定高度" ⟹ 那是最容易做错的一条');
  assert.match(plan, /不许连乘/, '没警告亮度连乘');
  // ⚠️ 而要给**具体的对的写法**，不是只说"别那样"
  assert.match(plan, /0\.85 - 0\.6 \* d/, '没给出正确的亮度衰减公式');
  assert.match(plan, /sqrt\(i\/N\)/,
    '没点名"中心密外圈疏"那种分布（它会强化圆丘观感）');
});



// ═══════════════════════════════════════════════════════════════════════════
//  ReAct：先给现场，再给结论，要求它说诊断（0.9.149）
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n  ReAct（观察 → 思考 → 行动）');

const REAL_PROBE = {
  frames: 180, ms: 3001, webgl: { context: true, objects: 1, glError: 0 }, errors: [],
  sampledPixels: { black: 777, total: 1024, bright: 0, bands: [8, 28, 9], satMedian: 0.40 },
};

check('⚠️⚠️ 观测报告给的是**事实**，不是我的判断', () => {
  // 用户 2026-08-03：「思考方式 react 可能比较好」
  // ⟹ ReAct 的关键是模型能自己观察，而观察到的要是**原始数据**。
  //   ⚠️ 判据：**给"你写了什么"的事实，比给"你错了"的判断有用。**
  //     我的判断（"太暗了"）会把它往一个方向推；原始数据让它自己连因果。
  assert.ok(BAD_REAL, '真实样本不在');
  const obs = G.buildObservation(REAL_PROBE, BAD_REAL);
  // ① 真实的数字要照抄进去（带目标区间）
  assert.match(obs, /75\.9%/, '近黑占比没照抄真实数字');
  assert.match(obs, /目标 20-45%/, '没给目标区间 ⟹ 一个孤立的数字读不出好坏');
  assert.match(obs, /上 8 \/ 中 28 \/ 下 9/, '三分带亮度没照抄');
  // ②⚠️⚠️ "场景 1 个对象"要点出它的含义（那是最有信息量的一个）
  // ⚠️⚠️ `defaultLights` 在报告里出现 **2 次**（这句提示 + 材质那一行）
  //   ⟹ 全文搜索删一处照样绿（反向验证逮到）⟹ 锚到**那一行**。
  const objLine = obs.split('\n').find((l) => l.includes('顶层对象'));
  assert.ok(objLine, '没报场景对象数');
  assert.match(objLine, /defaultLights/,
    '"1 个对象"那一行没说清它的含义（骨架默认放了一个 defaultLights Group）'
    + ' ⟹ 那个数字本身没有意义，而它恰恰是最有信息量的一个');
  assert.match(objLine, /删了它|什么都没 add/,
    '没说清"只有 1 个"意味着什么 ⟹ 模型读不出这个数的含义');
  // ③⚠️⚠️⚠️ 从它自己代码里量出来的事实
  assert.match(obs, /亮度变量被 `\*=` 了/, '没量"亮度被乘了几次"');
  assert.match(obs, /lum \*= \(0\.1/, '没把那一行原文摆出来 ⟹ 它得自己去找');
  assert.match(obs, /core \* 2\.6/, '没摆出高度算式里的距离项');
  // ⚠️ 那行原文里 `删掉了` 和 `defaultLights` 之间隔着 markdown 的 `**`
  //   ⟹ 连写匹配不上。锚到那两个词各自出现在**同一行**上。
  const matLine = obs.split('\n').find((l) => l.includes('材质：'));
  assert.ok(matLine, '观测报告里没有"材质"那一行');
  assert.match(matLine, /删掉了/, '没报"删了默认灯"这个事实');
  assert.match(matLine, /没有.*自己加灯/, '没报"也没自己加灯"这个事实');
  assert.match(matLine, /MeshBasicMaterial/, '没报用的是什么材质');
  assert.match(obs, /没用播放器提供的 DP\.lum/, '没报"它自己推了公式"');
});

check('⚠️ 观测报告里不许出现我的判断词', () => {
  // ⚠️ 判据：**这一层只报数**。判断留给检查器报告那一段（它在后面）。
  const obs = G.buildObservation(REAL_PROBE, BAD_REAL);
  for (const verdict of ['太暗了', '不好看', '很抽象', '像个圆锥', '铺满了']) {
    assert.ok(!obs.includes(verdict),
      `观测报告里出现了判断词"${verdict}" ⟹ 那会把模型往一个方向推，`
      + '而这一层的全部价值是让它自己发现');
  }
});

check('⚠️⚠️ 观测排在检查器报告**前面**', () => {
  const obs = G.buildObservation(REAL_PROBE, BAD_REAL);
  const p = G.buildRepairPrompt(BAD_REAL, [{ id: 'C-太暗了', detail: 'x' }], {}, obs);
  const obsAt = p.indexOf('实际观测到的数据');
  const verdictAt = p.indexOf('检查器报告');
  assert.ok(obsAt > 0, '观测报告没进提示词');
  assert.ok(obsAt < verdictAt,
    '检查器结论排在观测数据前面 ⟹ 模型会直接跳到"行动"、沿着我指的方向微调'
    + '（实测那次三轮都没修掉就是这样）');
});

check('⚠️⚠️⚠️ 要求先写诊断再给代码，而分隔符能切开', () => {
  const p = G.buildRepairPrompt('code', [{ id: 'X', detail: 'y' }], {}, 'obs');
  assert.match(p, /第一段：诊断/, '没要求先写诊断');
  assert.match(p, /===SCENE===/, '没给分隔符 ⟹ 诊断和代码混在一起没法切');
  // ⚠️ 而要说清"为什么这一步不是形式"
  assert.match(p, /不是形式/,
    '没说清诊断那一步的必要性 ⟹ 模型会敷衍一句然后照旧');

  // ── 切分要对
  const out = '诊断：近黑 76% 太高，是第 165 行造成的。\n===SCENE===\n'
    + 'window.SCENE = { build() {}, frame() {} };';
  assert.match(G.extractScene(out), /^window\.SCENE/, '没把诊断切掉');
  assert.strictEqual(G.extractDiagnosis(out), '诊断：近黑 76% 太高，是第 165 行造成的。');

  // ⚠️⚠️ **没有分隔符时不能报错** —— 第一轮（buildImplementPrompt）不要求诊断
  const plain = 'window.SCENE = { build() {}, frame() {} };';
  assert.match(G.extractScene(plain), /^window\.SCENE/,
    '没有分隔符时把代码切掉了 ⟹ 第一轮就废了');
  assert.strictEqual(G.extractDiagnosis(plain), '', '没有分隔符时诊断该是空字符串');

  // ⚠️ 而代码里**恰好出现** ===SCENE=== 的字样时要取最后一个
  const tricky = 'x\n===SCENE===\n// 说明：===SCENE=== 是分隔符\n'
    + '===SCENE===\nwindow.SCENE = { build() {}, frame() {} };';
  assert.match(G.extractScene(tricky), /^window\.SCENE/, '多个分隔符时没取最后一个');
});

check('⚠️ measureCode 只报数，算不出来就不报', () => {
  // ⚠️ 判据：**宁可少报也别报错的数**（F 闸门为误报栽过）
  assert.deepStrictEqual(G.measureCode(''), [], '空代码不该报任何东西');
  assert.deepStrictEqual(G.measureCode(null), [], 'null 不该崩');
  // ⚠️ 用了 DP 曲线的要给正面确认（那让模型知道"这条我做对了"）
  const good = 'color.setHSL(DP.hue(d, l) / 360, DP.sat(d, l), DP.lum(d, e));';
  assert.ok(G.measureCode(good).some((f) => f.includes('✓ 用了播放器提供的 DP.lum')),
    '用了 DP 曲线没给正面确认 ⟹ 只报错会让模型不确定哪些是对的');
});



// ═══════════════════════════════════════════════════════════════════════════
//  第二张真实失败产物（08030141）—— 雾 / DP / 空闲二选一（0.9.150）
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n  真实失败产物（用户 08030141 那张）');

const BAD_FOG = (() => {
  try {
    return fs.readFileSync(
      path.join(__dirname, 'fixtures', 'bad-fog-and-idle-else.scene.js'), 'utf8');
  } catch { return null; }
})();

check('⚠️⚠️⚠️ 雾太浓 → 逮住（这是那张"很暗淡"的真死因）', () => {
  // ⚠️⚠️ `FogExp2(BG, 0.12)` + 相机在 (0, 3.2, 12)
  //   ⟹ 透光率 = exp(-(0.12*12)²) ≈ **0.13** ⟹ 元素亮度被乘掉 87%
  //   ⟹ 模型把 L 给到 0.85，实际显示 0.11。那就是读数"三带 8/10/10"的来源。
  // ⚠️⚠️⚠️ 而模型**三轮都在调 L**，诊断每轮都很到位（"根因不是系数"、
  //   "亮度没有以离中心距离做强衰减"），但**没有一轮怀疑到雾** ——
  //   因为雾在 `setHSL` 之后作用，它看不见那个乘法。
  //   ⟹ 判据：**当一个参数的效果隔着好几层才显现，模型不可能靠试错找到它。**
  assert.ok(BAD_FOG, 'fixtures/bad-fog-and-idle-else.scene.js 不在 ⟹ 真实样本，别删');
  const ids = G.inspectDesign(BAD_FOG).map((x) => x.id);
  assert.ok(ids.includes('C-雾太浓'), `没逮住雾太浓（报了 ${ids.join(',')}）`);
  const detail = G.inspectDesign(BAD_FOG).find((x) => x.id === 'C-雾太浓').detail;
  // ⚠️ 报错里要把**那个乘法**算出来给它看，不能只说"雾太浓了"
  assert.match(detail, /透光率/, '没算出透光率');
  assert.match(detail, /13%|1[0-9]%/, '没给出具体的百分比');
  assert.match(detail, /setHSL.*之后|之后作用/,
    '没说清"雾在 setHSL 之后作用" ⟹ 模型还会继续调 L');
  assert.match(detail, /DP\.fogDensity/, '没给出正确做法');
});

check('⚠️⚠️ 完全没用 DP 曲线 → 逮住（"我给了它"不等于"它用了"）', () => {
  // ⚠️ 那张里 `DP.` 出现 **0 次** —— 我注入了那段代码、提示词也写了
  //   "原样抄进去然后调它"，而它完全忽略、自己推了一套（那套正是死因）。
  assert.ok(BAD_FOG, '样本不在');
  assert.strictEqual((BAD_FOG.match(/\bDP\./g) || []).length, 0,
    '样本里居然用了 DP ⟹ 那这条测试的前提不成立了');
  const ids = G.inspectDesign(BAD_FOG).map((x) => x.id);
  assert.ok(ids.includes('C-没用给的配色曲线'), `没逮住（报了 ${ids.join(',')}）`);
});

check('⚠️⚠️ 空闲动画写在 else 里 → 逮住（有音乐时动态反而更少）', () => {
  // ⚠️ 用户原话「动态的部分太少了」—— 而它的动态**在有音乐时比静音时更少**，
  //   那是反直觉的，正是 `if (hasAudio) {频谱} else {行波}` 造成的：
  //   有音乐时"整片都在起伏"那一层整个消失，剩下各点各自跟频谱 = 噪点感。
  assert.ok(BAD_FOG, '样本不在');
  const ids = G.inspectDesign(BAD_FOG).map((x) => x.id);
  assert.ok(ids.includes('C-空闲动画二选一'), `没逮住（报了 ${ids.join(',')}）`);
  const detail = G.inspectDesign(BAD_FOG).find((x) => x.id === 'C-空闲动画二选一').detail;
  // ⚠️ 要给出**叠加**的写法，不是只说"别二选一"
  assert.match(detail, /\+=/, '没给出叠加的写法');
  assert.match(detail, /不能变成 0|一直在/, '没说清"空闲波要一直在"');
});

check('⚠️ 两张真实产物的问题都被逮住（而示例仍然零问题）', () => {
  // ⚠️⚠️ 判据：**闸门要拿真实的失败产物当样本。** 我手写的假代码只会命中
  //   我想到的那种写法 —— 而这一轮的 C-雾太浓 / C-空闲动画二选一 两条，
  //   都是**读了真实产物才发现的**（我之前完全没想到雾会是死因）。
  assert.ok(BAD_REAL && BAD_FOG, '两个样本都要在');
  assert.ok(G.inspectDesign(BAD_REAL).length >= 4,
    '08030114 那张该被逮住至少 4 条（亮度连乘 / 圆锥 / 雾 / 没用 DP）');
  assert.ok(G.inspectDesign(BAD_FOG).length >= 3,
    '08030141 那张该被逮住至少 3 条（雾 / 没用 DP / 空闲二选一）');
  // ⚠️⚠️⚠️ 而**我们自己的示例必须零问题** —— 它是喂给模型的范例，
  //   自己违规等于在示范"可以违规"（0.9.150 为此把它改成用 DP 了）
  const ex = fs.readFileSync(
    path.join(__dirname, '..', 'skeleton', 'scene.example.js'), 'utf8');
  assert.deepStrictEqual(G.inspectDesign(ex), [],
    `示例场景被判出问题（${G.inspectDesign(ex).map((x) => x.id).join(',')}）`
    + ' ⟹ 它是范例，自己违规等于在示范"可以违规"');
});

check('⚠️ 提示词：动态五组是硬规则 + 反默认清单', () => {
  // 用户 2026-08-03：「动态的部分太少了」
  const plan = G.buildPlanPrompt('');
  assert.match(plan, /五组，缺一条就是没做完/, '没把动态写成硬规则');
  // ⚠️ 五组每一组都要说清"缺了什么症状" —— 那让它能自查
  for (const kind of ['持续', '事件', '粒子', '慢', '空闲']) {
    assert.ok(plan.includes(kind), `五组里没有"${kind}"`);
  }
  assert.match(plan, /空闲波要一直在/, '没警告"空闲动画写 else 里"这个坑');
  // ⚠️⚠️ 反默认清单（借 taste-skill 的形式：具体禁令而不是形容词）
  assert.match(plan, /别落回这些/, '没有反默认清单');
  for (const trap of ['中心一个尖锥', '雾密度自己填数字', '亮度连乘',
    '高饱和霓虹紫', '俯视看全景']) {
    assert.ok(plan.includes(trap), `反默认清单里没有"${trap}"`);
  }
});

check('⚠️⚠️ 雾密度是算出来的，而参数合理', () => {
  const Pal = require(path.join(__dirname, '..', 'src', 'palette.js'));
  // ⚠️ 相机 22m、场景半径 20 ⟹ 最远 42m 处透光 25%（没入而不是消失）
  const den = Pal.fogDensityFor(22, 20);
  assert.ok(Pal.fogTransmission(den, 8) > 0.9,
    `近处（8m）透光率只有 ${Pal.fogTransmission(den, 8).toFixed(2)} ⟹ 雾太浓`);
  assert.ok(Pal.fogTransmission(den, 22) > 0.5,
    '相机距离处透光率低于 50% ⟹ 主体被压暗（那正是 08030141 的死因）');
  assert.ok(Pal.fogTransmission(den, 42) < 0.35,
    '最远处透光率太高 ⟹ 外圈没"没入底色"，画面会铺满');
  // ⚠️ 而模型那次填的 0.12 必须落在"太浓"那一侧（否则闸门的阈值错了）
  assert.ok(Pal.fogTransmission(0.12, 12) < 0.45,
    '0.12 + 12m 算出来不算"太浓" ⟹ 那闸门的阈值定错了');
  // ⚠️ 极端输入不崩
  for (const [a, b] of [[0, 0], [-1, 5], [NaN, 20], [22, NaN]]) {
    assert.ok(Number.isFinite(Pal.fogDensityFor(a, b)),
      `fogDensityFor(${a}, ${b}) 不是有限数`);
  }
});



// ═══════════════════════════════════════════════════════════════════════════
//  ⚠️⚠️⚠️ 时间维度：动不动 / 有没有节奏（0.9.151）
// ═══════════════════════════════════════════════════════════════════════════
//
// 用户 2026-08-03 连着两次说「动态的部分太少了」——
// ⚠️ 而我之前只截**一帧** ⟹ 这件事**我从来没量过**。
//   我量的全是单帧指标（近黑/三带/饱和度）= 构图；而"活不活"在**帧之间**。
//
// ⚠️ 参考壁纸实测（preview.gif 200 帧）：
//   亮度随时间 29 → 76（差 47、标准差 12.9）
//   帧间变化率 8.3 → 37.3 —— **波动范围本身很大才是"有节奏"**
//   ⟹ 匀速转圈的帧间差是恒定的；有节奏的是忽大忽小的。
console.log('\n  动态与节奏（时间维度）');

// 参考壁纸的 motion 实测值
const REF_PROBE_BASE = {
  frames: 180, ms: 3001, webgl: { context: true, objects: 4, glError: 0 }, errors: [],
  sampledPixels: REF_PIXELS,
};
const REF_MOTION = {
  frames: 5, lumMin: 29, lumMax: 76, lumStd: 12.9,
  diffAvg: 24.2, diffMin: 8.3, diffMax: 37.3,
};

check('⚠️⚠️ 参考壁纸的动态数据零问题（校准基准）', () => {
  const out = G.judgeComposition({ sampledPixels: REF_PIXELS, motion: REF_MOTION });
  assert.deepStrictEqual(out, [],
    `参考壁纸被判出 ${out.length} 个问题（${out.map((x) => x.id).join(',')}）`
    + ' ⟹ 阈值定错了：目标本身必须能通过');
});

check('完全不动 → 逮住', () => {
  const still = { frames: 5, lumMin: 50, lumMax: 50, lumStd: 0,
    diffAvg: 0.3, diffMin: 0.2, diffMax: 0.4 };
  const ids = G.judgeComposition({ sampledPixels: REF_PIXELS, motion: still })
    .map((x) => x.id);
  assert.ok(ids.includes('C-画面几乎不动'), `没逮住（报了 ${ids.join(',')}）`);
  // ⚠️ 报错里要给**候选原因**，不是只说"不动"
  const d = G.judgeComposition({ sampledPixels: REF_PIXELS, motion: still })
    .find((x) => x.id === 'C-画面几乎不动').detail;
  assert.match(d, /else/, '没提"空闲动画写在 else 里"这个最常见的原因');
  assert.match(d, /needsUpdate/, '没提"忘了置 needsUpdate"这个原因');
});

check('⚠️⚠️⚠️ 匀速转圈 → 逮住（"它在那转圈"是用户原话）', () => {
  // ⚠️ 这条是这一轮的**核心**：动得挺多，但**变化幅度恒定**
  //   ⟹ 那正是整体旋转/整体缩放的特征，而它通不过任何单帧指标。
  const spin = { frames: 5, lumMin: 50, lumMax: 51, lumStd: 0.4,
    diffAvg: 20, diffMin: 19, diffMax: 21 };
  const ids = G.judgeComposition({ sampledPixels: REF_PIXELS, motion: spin })
    .map((x) => x.id);
  assert.ok(ids.includes('C-动得没节奏'),
    `没逮住匀速运动（报了 ${ids.join(',')}）`
    + ' ⟹ 它的帧间变化平均值是正常的（20），只有"波动范围"能区分它');
  assert.ok(ids.includes('C-亮度没起落'), '没逮住"明暗不呼吸"');
  const d = G.judgeComposition({ sampledPixels: REF_PIXELS, motion: spin })
    .find((x) => x.id === 'C-动得没节奏').detail;
  // ⚠️ 要说清怎么改 —— 节奏来自事件触发的动态
  assert.match(d, /事件触发/, '没说清"节奏来自事件触发的动态"');
  assert.match(d, /8\.3 - 37\.3/, '没给参考壁纸的实测范围');
});

check('⚠️ 没有 motion 数据时不判（旧探针 / 截图失败）', () => {
  assert.deepStrictEqual(
    G.judgeComposition({ sampledPixels: REF_PIXELS }), [],
    '没有 motion 数据时报了问题 ⟹ 升级过程中会出现一堆假问题');
  assert.deepStrictEqual(
    G.judgeComposition({ sampledPixels: REF_PIXELS, motion: { frames: 1 } }), [],
    '只截到 1 帧时报了问题 ⟹ 那时算不出帧间变化');
});

check('⚠️⚠️ 观测报告里有动态那一节（模型要能看到它）', () => {
  const obs = G.buildObservation({ ...REF_PROBE_BASE, motion: REF_MOTION }, 'x');
  assert.match(obs, /## 动态/, '观测报告里没有动态那一节');
  assert.match(obs, /帧间变化/, '没报帧间变化');
  assert.match(obs, /8\.3-37\.3|8\.3 - 37\.3/, '没给参考壁纸的目标范围');
  assert.match(obs, /范围要宽/, '没说清"范围窄=匀速"这件事');
  // ⚠️ 而这一节**也不许出现判断词**（那是 buildObservation 的规矩）
  for (const v of ['没节奏', '死板', '不好看']) {
    assert.ok(!obs.includes(v), `观测报告里出现了判断词"${v}"`);
  }
});

check('⚠️ 提示词讲清"节奏不是匀速"', () => {
  const plan = G.buildPlanPrompt('');
  assert.match(plan, /要有\*\*节奏\*\*/, '没说"动要有节奏"');
  assert.match(plan, /8\.3 - 37\.3/, '没给参考壁纸的帧间变化范围');
  assert.match(plan, /匀速运动.*恒定|恒定.*匀速/,
    '没说清"匀速运动的帧间变化是恒定的"⟹ 模型不知道为什么转圈不行');
  assert.match(plan, /只能当\*\*背景层\*\*/,
    '没说清"匀速的那些只能当背景层" ⟹ 模型会以为不许用相机公转');
  // ⚠️⚠️ 亮度也要跟音乐走 —— 那是"很暗淡"的另一半
  assert.match(plan, /亮.*这件事本身也要跟音乐走/,
    '没要求"亮度本身跟音乐走" ⟹ 只有几何在动而明暗恒定会发闷');
});



// ═══════════════════════════════════════════════════════════════════════════
//  第三张真实失败产物（08030206）—— vertexColors 纯黑（0.9.152）
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n  真实失败产物（08030206：一排柱子的剪影）');

const BAD_VC = (() => {
  try {
    return fs.readFileSync(
      path.join(__dirname, 'fixtures', 'bad-vertexcolors.scene.js'), 'utf8');
  } catch { return null; }
})();

check('⚠️⚠️⚠️ vertexColors + instanceColor → 逮住（那是纯黑剪影）', () => {
  // ⚠️⚠️ 用户 2026-08-03 第三张：画面是**一排柱子的剪影**，比背景还黑。
  //   读数：中 1/3 亮度 **1**、高亮 0%。
  // ⚠️ 而它的代码里 `L = 0.45 + 0.45*(1-d²) + ...` ⟹ **L 最低 0.45**，
  //   `instanceColor` 建了、`needsUpdate` 也置了 ⟹ 按理该很亮。
  // ⛔ 死因：`MeshBasicMaterial({ color: 0xffffff, vertexColors: true })`
  //   `vertexColors: true` 让 three.js 去读**几何体的顶点色属性**，
  //   而 BoxGeometry 没有 ⟹ shader 读不存在的属性 ⟹ 输出纯黑。
  //   ⟹ 那和 instanceColor 是两套机制，同时开会冲突。
  assert.ok(BAD_VC, 'fixtures/bad-vertexcolors.scene.js 不在 ⟹ 真实样本，别删');
  // ⚠️ 先确认样本的前提：它的 L 本来是够亮的（否则这条测试没意义）
  assert.match(BAD_VC, /L = 0\.45/, '样本里的 L 基线该是 0.45（那说明它不是"算暗了"）');
  assert.match(BAD_VC, /vertexColors: true/, '样本里该有 vertexColors: true');
  const ids = G.inspectDesign(BAD_VC).map((x) => x.id);
  assert.ok(ids.includes('C-vertexColors 冲突'), `没逮住（报了 ${ids.join(',')}）`);
  const d = G.inspectDesign(BAD_VC).find((x) => x.id === 'C-vertexColors 冲突').detail;
  assert.match(d, /纯黑/, '没说清结果是纯黑（模型会以为只是"暗"）');
  assert.match(d, /两套/, '没说清那是两套不同的机制');
  assert.match(d, /去掉/, '没给出修法');
});

check('⚠️ 只用 instanceColor（不开 vertexColors）不误报', () => {
  const ok = 'const m = new THREE.MeshBasicMaterial({});\n'
    + 'grid.instanceColor = new THREE.InstancedBufferAttribute(arr, 3);\n'
    + 'grid.setColorAt(i, c);';
  assert.ok(!G.inspectDesign(ok).map((x) => x.id).includes('C-vertexColors 冲突'),
    '只用 instanceColor 被误报了 ⟹ 那是**正确**做法');
  // ⚠️ 而只开 vertexColors、不用 instanceColor 也不该报
  //   （那可能是刻意给几何体加了 color attribute）
  const vcOnly = 'const m = new THREE.MeshBasicMaterial({ vertexColors: true });\n'
    + 'geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));';
  assert.ok(!G.inspectDesign(vcOnly).map((x) => x.id).includes('C-vertexColors 冲突'),
    '只用 vertexColors（自己加了 color attribute）被误报了');
});

check('⚠️⚠️⚠️ 提示词讲清"这张图在表达什么"（内在逻辑）', () => {
  // 用户 2026-08-03：「我看不懂这有啥意义…他是用柱子上下波动来模拟**波浪**，
  //   你明白吗？…我觉得你就是缺乏一些**内在逻辑**」
  // ⚠️ 而我查过：提示词里"为什么/意义/代表"**一个都没有** ——
  //   全是约束（不许铺满/不许俯视/饱和度别超），没有一句说"那些柱子是什么"。
  // ⟹ 判据：**先决定"它是什么"，再决定"怎么画"。**
  const plan = G.buildPlanPrompt('');
  assert.match(plan, /这张图在表达什么/, '没有"先想清楚它在表达什么"那一节');
  // ⚠️ 要有那张"画面上的东西 → 它表示什么"的对照表
  // ⚠️⚠️ 反向验证逮住这条：`一片水面` 在提示词里出现**多次**
  //   （对照表 + "要做的东西"那节）⟹ 删掉最关键那句照样绿。
  //   ⟹ 锚到**那句话本身**（"柱子不是元素，柱子是水面上的一个点"）——
  //     那是整节的核心，删了它剩下的都是修饰。
  assert.match(plan, /柱子是.{0,6}水面上的一个点/,
    '没说清"柱子不是元素，是水面上的一个点" ⟹ 那是这一节的核心'
    + '（用户原话：「他是用柱子上下波动来模拟波浪，你明白吗」）');
  // ⚠️ 而那张"画面上的东西 → 它表示什么"的对照表也要在
  assert.match(plan, /它表示什么/, '没有"画面上的东西 → 它表示什么"那张对照表');
  assert.match(plan, /冲击波|石子入水/, '对照表里没说清圆环表示什么');
  assert.match(plan, /相邻点的高度连续/,
    '没说清"一片水和一排柱子的区别是相邻点连续" ⟹ 那是唯一可执行的判据');
  assert.match(plan, /先决定.*是什么/, '没给出"先想是什么再想怎么画"这个顺序');
  // ⚠️ 而要允许它换别的东西（沙丘/云海），不是只能做水
  assert.match(plan, /沙丘|云海|星云/,
    '没说"可以换成别的东西" ⟹ 那会把它锁死在一种题材上');
});

check('⚠️⚠️ 而元素尺度只给**算式**，不给数字（两个样本互相矛盾）', () => {
  // ⚠️⚠️⚠️ 我写过两版闸门想判"像不像一片水"，**两次都在校准基准上判错**：
  //   ① 判"有没有空间连续性" ⟹ 08030206 有（sin(x)*cos(z)）被放过，
  //      而我们的示例用 sin(t + dist) 被判红 —— 两个方向都错
  //   ② 判"元素在画面上多少 px" ⟹ 那个数算得很准（19px vs 26px），
  //      但**更粗的那个（示例 26px）用户说能看**，19px 那个说看不懂
  //      ⟹ 元素大小不是原因
  // ⟹ 判据：**一个能算准的数字，不等于它代理的是对的东西。**
  //   ⟹ 那个算式进提示词（信息），不做成闸门（会误伤）。
  const plan = G.buildPlanPrompt('');
  assert.match(plan, /2 × 相机距离 × tan/, '算式没进提示词');
  assert.match(plan, /别照抄我的数字/,
    '没说清"这个数我给不出准值" ⟹ 模型会把我编的阈值当标准');
  // ⚠️ 而要把那两个矛盾的样本摆出来 —— 那才是"我为什么不给数字"的证据
  assert.match(plan, /19px/, '没摆出 19px 那个样本');
  assert.match(plan, /26px/, '没摆出 26px 那个（更粗但用户说能看的）样本');

  // ⚠️⚠️ 而那两条闸门必须**真的不在**（否则会误伤示例）
  const ex = fs.readFileSync(
    path.join(__dirname, '..', 'skeleton', 'scene.example.js'), 'utf8');
  const ids = G.inspectDesign(ex).map((x) => x.id);
  assert.ok(!ids.includes('C-元素太大'), '"元素太大"那条闸门还在 ⟹ 它误伤示例');
  assert.ok(!ids.includes('C-一排柱子不是水面'),
    '"一排柱子"那条闸门还在 ⟹ 它误伤示例');
  assert.deepStrictEqual(ids, [], `示例被判出 ${ids.join(',')} ⟹ 它是校准基准`);
});


console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
