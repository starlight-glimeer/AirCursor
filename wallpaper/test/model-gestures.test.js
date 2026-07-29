// model-gestures.js：用模型识别手势（GestureRecognizer 旁路）的纯逻辑部分。
//
//   node test/model-gestures.test.js
//
// ⚠️ 模型本身跑不了 —— 它要浏览器 + WebGL + 19MB wasm。**这批用例只测算术**：
// 置信度门槛、"离开再回来"、绑定表的查找。真机上模型认得准不准，只能来自用户。
//
// 这一层存在的理由（详见 model-gestures.js 文件头）：现在的判定是手写几何（把 21 个点
// 拼成 63 维向量算欧氏距离），它没有"什么叫摊开的手"这种语义。实测手动着的时候一个
// 0.28 的球只能停留 89ms ⟹ 序列匹配要求依次进入 N 个这样的球，结构上走不通。
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// 这个文件在浏览器里跑，`load()` 会用 document.baseURI —— 但这批用例不调 load()，
// 所以给一个壳就够。真要调它会在 import() 那步失败，而那正是"模型跑不了"的地方。
const shim = { document: { baseURI: 'file:///test/' } };
new Function('window', fs.readFileSync(
  path.join(__dirname, '..', 'src', 'model-gestures.js'), 'utf8'))(shim);
const M = shim.GestureWallModelGestures;

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

console.log('\n用模型识别手势（旁路）');

const det = (name, score) => ({
  gestures: name ? [{ name, label: M.LABELS[name], score, hand: 0 }] : [],
  landmarks: [],
});

check('内置手势表和显示名一一对应', () => {
  // 手抄一份名字会和模块悄悄分叉，而分叉的表现是"绑了但永远不触发"（键名对不上），
  // 那个症状完全看不出是名字的问题。所以面板也从这里取表。
  assert.ok(M.CANNED.length >= 7, `内置手势只有 ${M.CANNED.length} 个`);
  const missing = M.CANNED.filter((n) => !M.LABELS[n]);
  assert.deepStrictEqual(missing, [], `这些手势没有中文名，面板会显示英文类名：${missing}`);
  // None 不该在里面：它是"没认出任何手势"，不是一个可绑的动作。
  assert.ok(!M.CANNED.includes('None'), 'None 不该出现在可绑列表里');
});

check('置信度低于门槛不触发', () => {
  const m = new M.ModelGestures();
  const bindings = { Open_Palm: 'open_netease' };
  assert.deepStrictEqual(m.actionsFor(det('Open_Palm', 0.4), bindings, 0.6), [],
    '低于门槛的识别结果触发了动作');
  assert.strictEqual(m.actionsFor(det('Open_Palm', 0.9), bindings, 0.6).length, 1,
    '高于门槛的没触发');
});

check('没绑动作的手势不触发', () => {
  const m = new M.ModelGestures();
  assert.deepStrictEqual(m.actionsFor(det('Victory', 0.9), { Open_Palm: 'x' }), [],
    '认出了一个没绑动作的手势却触发了');
});

check('一直摆着只触发一次，手势消失后重新武装', () => {
  // 和尺子那套同一个道理：一直摆着的手型只该算一个动作。
  // 但**用"没被认出"当离开的信号**，而不是再造一个距离阈值 —— 模型的输出天然是离散的。
  const m = new M.ModelGestures();
  const bindings = { Open_Palm: 'open_netease' };
  assert.strictEqual(m.actionsFor(det('Open_Palm', 0.9), bindings).length, 1, '第一帧该触发');
  assert.strictEqual(m.actionsFor(det('Open_Palm', 0.9), bindings).length, 0, '第二帧不该再触发');
  assert.strictEqual(m.actionsFor(det('Open_Palm', 0.9), bindings).length, 0, '第三帧也不该');
  m.actionsFor(det(null), bindings);                       // 手势消失
  assert.strictEqual(m.actionsFor(det('Open_Palm', 0.9), bindings).length, 1,
    '手势消失后再摆出来，应该能再触发一次');
});

check('低于门槛的帧也算"离开"（否则低分帧会挡住重新武装）', () => {
  // 边界：手势还在但分数掉到门槛下。那一帧不该触发，但也不该让 armed 卡住 ——
  // 否则分数在门槛附近抖动时会永久失效，而症状是"触发过一次就再也不行了"。
  const m = new M.ModelGestures();
  const bindings = { Open_Palm: 'x' };
  m.actionsFor(det('Open_Palm', 0.9), bindings);           // 触发，armed = false
  m.actionsFor(det('Open_Palm', 0.3), bindings);           // 低分帧
  assert.strictEqual(m.actionsFor(det('Open_Palm', 0.9), bindings).length, 1,
    '低分帧之后不能再触发 —— 分数在门槛附近抖动会让手势永久失效');
});

check('空绑定 / 空识别结果不崩', () => {
  const m = new M.ModelGestures();
  assert.deepStrictEqual(m.actionsFor(null, { Open_Palm: 'x' }), []);
  assert.deepStrictEqual(m.actionsFor(det('Open_Palm', 0.9), null), []);
  assert.deepStrictEqual(m.actionsFor(det(null), {}), []);
});

check('模型没加载时 detect 返回 null，不抛', () => {
  // 旁路挂了不该让整层停摆 —— 那是「摄像头亮着但骨架没了」那一族的失败。
  const m = new M.ModelGestures();
  assert.strictEqual(m.detect({}, 1000), null);
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
