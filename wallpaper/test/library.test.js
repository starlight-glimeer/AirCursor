// library.js：图库素材管理。纯逻辑。
//
//   node test/library.test.js
const assert = require('node:assert');
require('../src/library.js');
const L = globalThis.GestureWallLibrary;

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

console.log('\nlibrary.js');

check('添加素材', () => {
  const items = L.add([], '/a/bg.jpg', 'background');
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].name, 'bg.jpg');
  assert.strictEqual(items[0].slot, 'background');
});

// 路径当 id 而不是递增数字：同一个文件加两次应该是同一条，"我怎么有两张一样的图"
// 是会真的发生的困惑。
check('同一个文件加两次不产生两条', () => {
  let items = L.add([], '/a/bg.jpg', 'background');
  items = L.add(items, '/a/bg.jpg', 'background');
  assert.strictEqual(items.length, 1);
});

check('重复添加会更新槽位标注', () => {
  let items = L.add([], '/a/x.png', 'background');
  items = L.add(items, '/a/x.png', 'subject');
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].slot, 'subject');
});

check('空路径不产生条目', () => {
  assert.strictEqual(L.add([], '', 'background').length, 0);
  assert.strictEqual(L.add([], null, 'background').length, 0);
});

check('文件名从路径末段取', () => {
  assert.strictEqual(L.nameOf('/a/b/c/face.png'), 'face.png');
  assert.strictEqual(L.nameOf('face.png'), 'face.png');
  assert.strictEqual(L.nameOf(''), '未命名');
});

check('移除按 id', () => {
  let items = L.add([], '/a/1.jpg', 'background');
  items = L.add(items, '/a/2.jpg', 'subject');
  items = L.remove(items, '/a/1.jpg');
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].id, '/a/2.jpg');
});

check('改槽位不动其他条目', () => {
  let items = L.add([], '/a/1.jpg', 'background');
  items = L.add(items, '/a/2.jpg', 'background');
  items = L.setSlot(items, '/a/1.jpg', 'shard');
  assert.strictEqual(items.find((i) => i.id === '/a/1.jpg').slot, 'shard');
  assert.strictEqual(items.find((i) => i.id === '/a/2.jpg').slot, 'background');
});

// 把 any 也算进来是刻意的：上传时逼用户先决定"这是主体还是碎片"是多余的一步，而很多
// 图两个槽位都能用（一张脸既能当主体也能切成碎片）。
check('槽位筛选包含未标注的（any）', () => {
  let items = L.add([], '/a/bg.jpg', 'background');
  items = L.add(items, '/a/face.png', 'any');
  items = L.add(items, '/a/sub.png', 'subject');
  const forSubject = L.forSlot(items, 'subject').map((i) => i.name).sort();
  assert.deepStrictEqual(forSubject, ['face.png', 'sub.png']);
  const forBackground = L.forSlot(items, 'background').map((i) => i.name).sort();
  assert.deepStrictEqual(forBackground, ['bg.jpg', 'face.png']);
});

// 存路径不存副本，所以文件会消失。标出来而不是静默不显示 —— 一个消失的条目比一个
// 标着"文件不在了"的条目更难查。
check('标出缺失的文件而不是静默丢掉', () => {
  let items = L.add([], '/a/gone.jpg', 'background');
  items = L.add(items, '/a/here.jpg', 'background');
  const marked = L.markMissing(items, (p) => p === '/a/here.jpg');
  assert.strictEqual(marked.length, 2, '缺失的条目被丢掉了');
  assert.strictEqual(marked.find((i) => i.id === '/a/gone.jpg').missing, true);
  assert.strictEqual(marked.find((i) => i.id === '/a/here.jpg').missing, false);
});

check('markMissing 不改原数组', () => {
  const items = L.add([], '/a/x.jpg', 'background');
  L.markMissing(items, () => false);
  assert.strictEqual(items[0].missing, undefined);
});

check('SLOTS 是三层，顺序是渲染顺序', () => {
  assert.deepStrictEqual(L.SLOTS, ['background', 'subject', 'shard']);
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
