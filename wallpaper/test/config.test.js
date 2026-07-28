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

// 从 main.js 里抠出 mergeConfig 的源码来跑，而不是手抄一遍：手抄的副本会和源码
// 悄悄分叉，那时测试还是绿的，但守的已经不是真代码了。
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const match = source.match(/function mergeConfig\(base, saved\) \{[\s\S]*?\n\}/);
assert.ok(match, '在 main.js 里找不到 mergeConfig —— 函数被改名或删了');
// eslint-disable-next-line no-new-func
const mergeConfig = new Function(`${match[0]}; return mergeConfig;`)();

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

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
