// system.js：手势 → 系统动作（打开应用、媒体键）。
//
//   node test/system.test.js
//
// 手势的定位是替代鼠标键盘，所以"控制电脑"和"控制壁纸"是同一批动作里的两类。这批用例
// 守的是那些"错了不报错"的地方：候选回退、以及没有导入 spawnSync 这类漏洞（下面最后
// 一节）。
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
require('../src/system.js');
const S = globalThis.GestureWallSystem;

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

console.log('\nsystem.js');

check('每条应用规则都有多个候选', () => {
  for (const rule of S.APP_RULES) {
    assert.ok(rule.id && rule.label, '规则缺 id 或 label');
    assert.ok(rule.candidates.length >= 1, `${rule.id} 没有候选`);
    for (const args of rule.candidates) {
      assert.ok(Array.isArray(args) && args.length, `${rule.id} 的候选不是参数数组`);
    }
  }
});

// 同一个 App 在不同机器上可能是不同路径、不同 bundle id、中文名或英文名。写死一个的话
// "在我机器上能用"就是全部的测试覆盖。
check('网易云有路径 / bundle id / 中英文名多种候选', () => {
  const rule = S.ruleById('open_netease');
  const flat = rule.candidates.map((c) => c.join(' ')).join(' | ');
  assert.match(flat, /\.app/, '没有绝对路径候选');
  assert.match(flat, /-b /, '没有 bundle id 候选');
  assert.match(flat, /网易云|NeteaseMusic/, '没有按名字打开的候选');
});

check('依次试候选，第一个成功就停', () => {
  const tried = [];
  const got = S.openApp('open_netease', (args) => {
    tried.push(args.join(' '));
    return args[0] === '-b';   // 第二个候选才成功
  });
  assert.strictEqual(tried.length, 2, `试了 ${tried.length} 次，应该在第二个就停`);
  assert.deepStrictEqual(got, ['-b', 'com.netease.163music']);
});

check('全部候选失败时返回 null（不假装成功）', () => {
  assert.strictEqual(S.openApp('open_netease', () => false), null);
});

check('未知 id 返回 null 而不是抛', () => {
  assert.strictEqual(S.openApp('不存在的动作', () => true), null);
  assert.strictEqual(S.ruleById('不存在的动作'), null);
});

check('媒体键有 keyCode 和 label', () => {
  for (const [id, meta] of Object.entries(S.MEDIA_KEYS)) {
    assert.ok(meta.label, `${id} 缺 label`);
    assert.ok(Number.isInteger(meta.keyCode), `${id} 的 keyCode 不是整数`);
  }
});

check('systemKindOf 能分辨三种情况', () => {
  assert.strictEqual(S.systemKindOf('open_netease'), 'app');
  assert.strictEqual(S.systemKindOf('media_toggle'), 'media');
  assert.strictEqual(S.systemKindOf('zoom'), null, '壁纸动作被当成系统动作了');
  assert.strictEqual(S.systemKindOf('不存在'), null);
});

check('systemActions 全部标了 system 字段', () => {
  const actions = S.systemActions();
  assert.ok(Object.keys(actions).length >= 6);
  for (const [id, action] of Object.entries(actions)) {
    assert.strictEqual(action.id, id, 'id 和键名不一致');
    assert.ok(action.system, `${id} 没标 system —— UI 会把它归到壁纸动作里`);
    assert.strictEqual(action.recordable, true);
  }
});

console.log('\n  main.js 的导入完整性');

// 这一节的由来：我写完 runSystemAction 才发现 spawnSync 根本没导入。`node --check` 只查
// 语法，查不出未定义的标识符 —— 那要等运行时才炸，而炸的位置是"手势触发了但什么都没
// 发生"，和缺权限的症状一模一样。
//
// 所以按名字检查：main.js 里调用了的 Node/Electron API，必须在文件顶部被导入。
function declaredNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/const \{([^}]+)\} = require/g)) {
    m[1].split(',').forEach((n) => names.add(n.trim().split(':')[0].trim()));
  }
  for (const m of source.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  return names;
}

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const declared = declaredNames(mainSource);

check('main.js 用到的 Node / Electron API 都导入了', () => {
  // 只查这些：它们是"忘了导入"的高发区。
  // ⚠️ 而它们**也可能是别的对象的方法**（`/re/.exec()`、`img.resize()`）
  //   ⟹ 正则要排除"前面是点号"的情况（见下面那段判据）。
  const suspects = [
    // ⚠️ 名单要**穷举那一族** —— 0.9.162 我漏引入 `execFileSync`，
    //   而它不在名单里 ⟹ 守卫沉默，真机上才会抛 ReferenceError。
    //   ⟹ 判据：**"高发区名单"漏一个就等于那一个没守。**
    'spawnSync', 'spawn', 'exec', 'execFile', 'execSync', 'execFileSync',
    'shell', 'clipboard', 'nativeImage', 'powerMonitor', 'Notification',
    'Tray', 'Menu', 'globalShortcut', 'dialog', 'screen', 'nativeTheme',
  ];
  // ⚠️⚠️ **前面不能是点号** —— `\b` 挡不住属性访问。
  //   实测（0.9.162）：`/pattern/.exec(str)` 里的 `exec` 被这条守卫报成
  //   "未导入却在用 exec"，而它是**正则的方法**，不是 child_process 的 API。
  //   ⚠️ 而上面那句注释还写着"正则不会误报成属性访问" —— 那句话本身是错的。
  //   ⟹ 判据：**`\b` 只管词边界，而点号是词边界** ⟹ 要显式排除 `.name`。
  const missing = suspects.filter((name) =>
    new RegExp(`(^|[^.\\w$])${name}\\s*\\(`, 'm').test(mainSource) && !declared.has(name));
  assert.deepStrictEqual(missing, [], `未导入却在用：${missing.join(', ')}`);
});

check('system.js 被 main.js 加载（否则系统动作全不认识）', () => {
  assert.match(mainSource, /require\('\.\/system\.js'\)/);
  assert.ok(declared.has('System'), 'System 没被赋值');
});

// templates.js 依赖 system.js 先加载。少一个 script 标签的后果是那八个动作静默消失，
// 而 UI 上看到的是"控制电脑那一栏是空的"。
check('每个加载 templates.js 的窗口都先加载 system.js', () => {
  const dir = path.join(__dirname, '..', 'src');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(dir, file), 'utf8');
    // ⚠️⚠️ 只看 **<script> 标签**，不看"文件里提到过这个名字"。
    //   原来用 `html.indexOf('templates.js')` ⟹ 它会匹配到**注释里**提到的文件名
    //   （0.9.106 我在 dashboard.html 加了段注释解释"templates.js 里 basic 是
    //    空数组"）⟹ 那个位置在真正的 <script> 之前 ⟹ **断言在正确代码上报红**。
    //   第 16 次栽在"注释和守卫互相干扰"。
    const tag = (name) => html.indexOf(`<script src="${name}"`);
    if (tag('templates.js') < 0) continue;
    assert.ok(tag('system.js') >= 0, `${file} 加载了 templates.js 但没加载 system.js`);
    assert.ok(tag('system.js') < tag('templates.js'),
      `${file} 里 system.js 在 templates.js 之后 —— 那时系统动作还不存在`);
  }
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
