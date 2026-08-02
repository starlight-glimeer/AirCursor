// 配置的深合并。这是"改了默认值，存量用户拿不到"那类 bug 的守卫 —— AirCursor 在
// 这上面栽过（存过的 settings.json 永远盖住新默认，真机跑的一直是旧阈值）。
//
//   node test/config.test.js
//
// mergeConfig 在 main.js 里，而 main.js 顶层 require('electron')，云端跑不了。所以
// 这里把那个函数的实现复制过来断言 —— 复制是有代价的（会漂），代价换的是这条逻辑
// 至少有守卫。真正的修法是把它抽成独立模块，那要等 main.js 稳定下来再动。
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// 从 main.js 里抠出 mergeConfig 和它依赖的 OPAQUE_DICTS 来跑，而不是手抄一遍：
// 手抄的副本会和源码悄悄分叉，那时测试还是绿的，但守的已经不是真代码了。
//
// 参数列表用 [^)]* 匹配而不是写死 `(base, saved)`：加 key 参数那次这里精确失败了，
// 报"函数被改名或删了" —— 守卫生效了，但报错指向错的原因。宽松匹配签名、严格匹配
// 函数名，是这里想要的平衡。
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const dicts = source.match(/const OPAQUE_DICTS = new Set\([^)]*\);/);
assert.ok(dicts, '在 main.js 里找不到 OPAQUE_DICTS');
const match = source.match(/function mergeConfig\([^)]*\) \{[\s\S]*?\n\}/);
assert.ok(match, '在 main.js 里找不到 mergeConfig —— 函数被改名或删了');
// eslint-disable-next-line no-new-func
const mergeConfig = new Function(`${dicts[0]}\n${match[0]}; return mergeConfig;`)();

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

console.log('\nconfig 深合并');

check('空存档拿到完整默认值', () => {
  const base = { a: 1, b: { c: 2 } };
  assert.deepStrictEqual(mergeConfig(base, null), base);
  assert.deepStrictEqual(mergeConfig(base, undefined), base);
});

check('返回的是副本，不共享引用', () => {
  const base = { nested: { v: 1 } };
  const out = mergeConfig(base, null);
  out.nested.v = 99;
  assert.strictEqual(base.nested.v, 1, '改返回值污染了默认值');
});

// 核心：新版本加的字段，存量存档里没有，必须拿到新默认而不是 undefined。
check('新增字段落回新默认（存量存档不会读到 undefined）', () => {
  const base = { old: 1, brandNew: { deep: 42 } };
  const saved = { old: 7 };
  const out = mergeConfig(base, saved);
  assert.strictEqual(out.old, 7, '用户设过的值被覆盖了');
  assert.strictEqual(out.brandNew.deep, 42, '新字段没拿到默认值');
});

check('用户设过的值优先于默认', () => {
  const out = mergeConfig({ depth: { background: -4.5 } }, { depth: { background: -8 } });
  assert.strictEqual(out.depth.background, -8);
});

check('部分嵌套：只覆盖存了的那个键', () => {
  const base = { t: { scale: 1, x: 0, y: 0 } };
  const out = mergeConfig(base, { t: { x: 5 } });
  assert.strictEqual(out.x, undefined);
  assert.strictEqual(out.t.x, 5, '存的值没生效');
  assert.strictEqual(out.t.scale, 1, '没存的键该保持默认');
  assert.strictEqual(out.t.y, 0);
});

// false 和 0 是合法值，不能被当成"没设置"而落回默认 —— 这是 falsy 判断的经典陷阱。
check('false 和 0 不被当成未设置', () => {
  const out = mergeConfig(
    { music: { enabled: true }, parallax: 1 },
    { music: { enabled: false }, parallax: 0 },
  );
  assert.strictEqual(out.music.enabled, false, 'false 被吞了');
  assert.strictEqual(out.parallax, 0, '0 被吞了');
});

check('图片路径 null 可以被存下来（清除生效）', () => {
  const out = mergeConfig({ layers: { subject: '/a.png' } }, { layers: { subject: null } });
  // null 走的是"没存"分支，所以会落回默认 —— 记录当前真实行为。
  // 清除功能靠主进程直接改 config.layers[key]=null 再写盘，不经过 merge，所以不受
  // 这条影响；但如果哪天改成走 merge，这个断言会提醒它不成立。
  assert.strictEqual(out.layers.subject, '/a.png',
    'null 的语义变了 —— 如果清除功能改成走 merge，这里要一起改');
});

check('存档里多出来的未知键被忽略', () => {
  const out = mergeConfig({ a: 1 }, { a: 2, removedFeature: { x: 1 } });
  assert.strictEqual(out.a, 2);
  assert.strictEqual(out.removedFeature, undefined, '废弃字段应该被丢掉');
});

check('数组整体替换而不是逐项合并', () => {
  const out = mergeConfig({ list: [1, 2, 3] }, { list: [9] });
  assert.deepStrictEqual(out.list, [9]);
});

// 回归守卫：预设是用户自己起名的字典，默认值是 {}。逐键合并的话每一个存下来的预设
// 都会在下次启动时被静默丢掉 —— 用户存了三套排布，重开发现全没了，而且不报错。
check('presets 整体保留（用户起的名字不会被丢）', () => {
  const out = mergeConfig(
    { presets: {}, depth: { a: 1 } },
    { presets: { 我的一号: { depth: { a: 5 } }, 二号: { depth: { a: 9 } } }, depth: { a: 2 } },
  );
  assert.deepStrictEqual(Object.keys(out.presets).sort(), ['二号', '我的一号'].sort());
  assert.strictEqual(out.presets['我的一号'].depth.a, 5, '预设内容被改了');
});

check('presets 是深拷贝，不与存档共享引用', () => {
  const saved = { presets: { a: { depth: { v: 1 } } } };
  const out = mergeConfig({ presets: {} }, saved);
  out.presets.a.depth.v = 99;
  assert.strictEqual(saved.presets.a.depth.v, 1, '改返回值污染了输入');
});

// ═══════════════════════════════════════════════════════════════════════
//  ⚠️⚠️⚠️ `base === null` —— 这一组是**真事故**的守卫（0.9.122）
//
//  用户 2026-08-02：「Steam 用户名和 API key 每次打开软件都要填一遍」
//
//  根因不是"没缓存"，是 **mergeConfig 抛异常 ⟹ readConfig 的 catch 吞掉
//  ⟹ 返回全套默认值 ⟹ 用户所有设置静默丢失**：
//    `typeof null === 'object'` ⟹ `typeof base !== 'object'` 那道闸拦不住 null
//    ⟹ `Object.keys(null)` ⟹ TypeError。
//
//  ⚠️ 而"默认值是 null"在这个 config 里是**常态**（语义 = "还没设过"）：
//    we.dir / we.steam.* / we.steamCmdPath / layers.background|subject|shard
//    ⟹ 任何存过这些值的用户**每次启动都踩**。
//
//  ⚠️⚠️ 而它躲过了守卫这么久，是因为**原来的用例全用 `base` 有值的结构**
//    （`{ layers: { subject: '/a.png' } }`）—— 那恰好绕开了 null 那支。
//    ⟹ 判据：**用例的"输入形状"要来自真实的 defaultConfig，不是我顺手编的。**
//      所以下面最后一条直接拿源码里真的 defaultConfig 跑。
// ═══════════════════════════════════════════════════════════════════════

check('默认值是 null 时不抛（typeof null === "object" 那个坑）', () => {
  // ⚠️ 这一条单独立着，因为它是**崩不崩**的问题，不是值对不对的问题。
  //   assert.doesNotThrow 而不是比值 —— 抛异常的后果（全部设置丢失）
  //   和"值算错了"完全不是一个量级。
  assert.doesNotThrow(() => mergeConfig({ k: null }, { k: 'v' }),
    'base 是 null 时抛了 ⟹ readConfig 会吞掉它并返回全默认 ⟹ 用户所有设置丢失');
});

check('默认值 null + 用户存了值 ⟹ 采用用户的值', () => {
  const out = mergeConfig({ k: null }, { k: 'v' });
  assert.strictEqual(out.k, 'v',
    '默认 null 的字段存不下来 —— 那正是"每次打开都要重填"的症状');
});

check('默认值 null + 用户存的是对象 ⟹ 整体采用（不按 null 的键去合并）', () => {
  // ⚠️ 默认是 null ⟹ **没有默认结构可参照** ⟹ 用户存的就是全部信息。
  const out = mergeConfig({ k: null }, { k: { a: 1, b: { c: 2 } } });
  assert.deepStrictEqual(out.k, { a: 1, b: { c: 2 } });
});

check('默认值 null + 用户没存 ⟹ 还是 null（不是 undefined）', () => {
  // ⚠️ undefined 和 null 在下游不等价：`config.we.dir` 那些地方是
  //   `if (config.we.dir && ...)` —— 两个都假，但 JSON.stringify 会把
  //   undefined 的键**整个删掉** ⟹ 写回磁盘的 config 少了字段。
  const out = mergeConfig({ k: null, other: 1 }, { other: 2 });
  assert.strictEqual(out.k, null, '没存过的 null 字段变成了别的东西');
  assert.ok('k' in out, 'k 这个键整个没了 ⟹ 写回磁盘时会丢字段');
});

// ⚠️⚠️ 这条是上面那些的**兜底**：不编输入形状，直接拿 main.js 里真的
//   defaultConfig，和一份真实用户 config 的形状跑一遍。
//   ⟹ 以后再有人加一个"默认值是 null 的新字段"，不需要来这里补用例，
//     这条自动覆盖到。
check('真的 defaultConfig × 存了所有 null 字段的存档 ⟹ 不抛且全部保留', () => {
  // 从源码里抠出 defaultConfig 字面量（和上面抠 mergeConfig 一样，不手抄）
  const at = source.indexOf('const defaultConfig = {');
  assert.ok(at > 0, '在 main.js 里找不到 defaultConfig');
  let depth = 0;
  let end = source.indexOf('{', at);
  for (let i = end; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  // eslint-disable-next-line no-new-func
  const defaultConfig = new Function(`return ${source.slice(source.indexOf('{', at), end + 1)};`)();

  // 找出所有默认值是 null 的路径
  const nullPaths = [];
  (function walk(o, prefix) {
    for (const [k, v] of Object.entries(o)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (v === null) nullPaths.push(p);
      else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p);
    }
  }(defaultConfig, ''));

  assert.ok(nullPaths.length > 0,
    'defaultConfig 里一个 null 默认值都没有了 —— 那这条守卫失去意义，'
    + '要么是重构掉了（好事，删掉这条），要么是我抠错了地方');

  // 给每一条都存一个值，模拟"用户设过了"
  const saved = JSON.parse(JSON.stringify(defaultConfig));
  for (const p of nullPaths) {
    const parts = p.split('.');
    let node = saved;
    for (const part of parts.slice(0, -1)) node = node[part];
    node[parts[parts.length - 1]] = `存过的值:${p}`;
  }

  let out;
  assert.doesNotThrow(() => { out = mergeConfig(defaultConfig, saved); },
    `真实 defaultConfig 合并时抛了 —— null 默认值的路径有 ${nullPaths.length} 条：`
    + `${nullPaths.join(', ')}`);

  // 每一条都要真的留下来
  for (const p of nullPaths) {
    const got = p.split('.').reduce((o, k) => (o == null ? o : o[k]), out);
    assert.strictEqual(got, `存过的值:${p}`,
      `${p} 存了值但合并后丢了 ⟹ 用户那一项每次启动都要重设`);
  }
});

check('普通配置块仍然逐键深合并（没被 opaque 波及）', () => {
  const out = mergeConfig(
    { depth: { background: -4.5, shard: 2.2 }, presets: {} },
    { depth: { background: -8 } },
  );
  assert.strictEqual(out.depth.background, -8);
  assert.strictEqual(out.depth.shard, 2.2, '没存的键该保持默认');
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
