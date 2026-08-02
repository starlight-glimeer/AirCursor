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
check('默认走 DeepSeek，且 base URL 不带 /v1（官方文档的形状）', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const at = main.indexOf('    ai: {');
  assert.ok(at > 0, 'defaultConfig 里找不到 ai 块 —— 锚点变了，这条守卫要跟着改');
  // ⚠️ 切到这个对象字面量的结尾（`\n    },`），不用固定长度 —— 见 gating 里那条守卫
  const block = main.slice(at, main.indexOf('\n    },', at));
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
  const recipe = { layout: 'ring', audioMap: 'height', palette: 'ice',
    motion: 'breathe', environment: 'topLight' };
  const rt = 'layout = ring：同心圆环';
  for (const [name, prompt] of [
    ['生成', G.buildScenePrompt('极光', recipe, rt, '（第一张）', '// example')],
    ['回喂', G.buildRepairPrompt('window.SCENE={}', [{ id: 'X', detail: 'y' }], rt)],
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
