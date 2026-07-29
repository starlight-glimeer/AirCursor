// templates.js：模板 = 三槽位 × 模块，以及这套模板绑哪些手势。
//
//   node test/templates.test.js
//
// 守的是这个设计的两条硬约束：动作 id 不能改（改了用户已录的手势就失效）、加模板/模块
// 不该需要改渲染或录制代码。
const assert = require('node:assert');
require('../src/templates.js');
const T = globalThis.GestureWallTemplates;

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

console.log('\ntemplates.js');

check('默认模板存在且三个槽位都有默认模块', () => {
  const t = T.template(T.DEFAULT_TEMPLATE);
  assert.ok(t, '默认模板不存在');
  for (const slot of ['background', 'subject', 'shard']) {
    assert.ok(t.slots[slot], `${slot} 没有默认模块`);
    assert.ok(T.MODULES[slot][t.slots[slot]], `${slot} 的默认模块 ${t.slots[slot]} 不在选项里`);
  }
});

check('未知模板 id 落回默认，不返回 undefined', () => {
  const t = T.template('不存在的模板');
  assert.ok(t && t.id === T.DEFAULT_TEMPLATE);
});

// 手势和模板绑定：换模板 = 换一套可用动作。这是用户定的设计。
check('模板决定有哪些动作，分 basic / pro 两档', () => {
  const t = T.template('depthStage');
  assert.ok(t.actions.basic.length > 0, '没有 basic 动作');
  assert.ok(t.actions.pro.length > 0, '没有 pro 动作');
  // 两档不能重叠 —— 同一个动作既基础又进阶说明分档没想清楚
  const overlap = t.actions.basic.filter((id) => t.actions.pro.includes(id));
  assert.strictEqual(overlap.length, 0, `两档重叠：${overlap.join(',')}`);
});

// 回归守卫：第一版把六个可录制动作全塞进 pro 档，于是默认状态下「可录制的动作」
// 整栏是空的，显示"这套模板没有需要录制的动作" —— 用户看到的就是"录制功能不存在"。
// 用例当时全绿，只有真机截图看得出来。
check('basic 档至少有一个可录制动作（否则录制栏默认是空的）', () => {
  for (const id of Object.keys(T.TEMPLATES)) {
    const basic = T.recordableActionsOf(id, false);
    assert.ok(basic.length > 0,
      `模板 ${id} 的 basic 档没有可录制动作 —— 录制栏打开就是空的`);
  }
});

check('pro 档默认不列出（普通用户不该一上来看到八个动作）', () => {
  const basic = T.actionsOf('depthStage', false);
  const all = T.actionsOf('depthStage', true);
  assert.ok(all.length > basic.length, 'pro 档没有被包含进去');
  assert.strictEqual(basic.length, T.template('depthStage').actions.basic.length);
});

check('每个动作 id 都在 ACTIONS 里有定义', () => {
  for (const t of Object.values(T.TEMPLATES)) {
    for (const id of [...t.actions.basic, ...t.actions.pro]) {
      assert.ok(T.ACTIONS[id], `模板 ${t.id} 引用了不存在的动作 ${id}`);
    }
  }
});

// continuous 类动作由手的连续状态直接驱动，录一个静态姿势没有意义 —— 给它们做录制
// 入口只会让用户以为录了才能用。
check('continuous 动作不可录制，discrete 才可以', () => {
  for (const action of Object.values(T.ACTIONS)) {
    if (action.kind === 'continuous') {
      assert.strictEqual(action.recordable, false, `${action.id} 是连续量却标了可录制`);
    }
  }
  const recordable = T.recordableActionsOf('depthStage', true);
  assert.ok(recordable.length > 0, '一个可录制动作都没有');
  assert.ok(recordable.every((a) => a.kind === 'discrete'), '可录制列表里混进了连续量');
});

check('可录制列表随 pro 档变化', () => {
  const basic = T.recordableActionsOf('depthStage', false);
  const all = T.recordableActionsOf('depthStage', true);
  assert.ok(all.length > basic.length, 'pro 档的可录制动作没被算进来');
});

// 动作 id 进配置和手势绑定，改名等于让用户已录的手势静默失效。
check('动作 id 与键名一致（防止改名时漏改一处）', () => {
  for (const [key, action] of Object.entries(T.ACTIONS)) {
    assert.strictEqual(action.id, key, `${key} 的 id 是 ${action.id}`);
  }
});

check('每个动作都有 label 和 hint（UI 不会显示空白）', () => {
  for (const action of Object.values(T.ACTIONS)) {
    assert.ok(action.label, `${action.id} 缺 label`);
    assert.ok(action.hint, `${action.id} 缺 hint`);
  }
});

console.log('\n  槽位与模块');

check('槽位摊平出渲染层要的参数', () => {
  const out = T.resolveSlots('depthStage', {});
  for (const slot of ['background', 'subject', 'shard']) {
    assert.ok(out[slot], `${slot} 没摊平`);
    assert.ok(out[slot].id, `${slot} 缺模块 id`);
  }
});

check('换模块换掉参数，不留上一个的残留', () => {
  const orbit = T.resolveSlots('depthStage', { shard: 'orbit' });
  const cluster = T.resolveSlots('depthStage', { shard: 'cluster' });
  assert.strictEqual(orbit.shard.layout, 'orbit');
  assert.strictEqual(cluster.shard.layout, 'cluster');
  // 两个模块的参数键应该一致 —— 缺键会让渲染层读到 undefined
  assert.deepStrictEqual(Object.keys(orbit.shard).sort(), Object.keys(cluster.shard).sort());
});

check('未知模块落回该槽位的第一个，不返回 undefined', () => {
  const out = T.resolveSlots('depthStage', { subject: '不存在' });
  assert.ok(out.subject && out.subject.id, '未知模块导致槽位为空');
});

check('每个槽位至少两个模块可选（不然"组合"没意义）', () => {
  for (const [slot, options] of Object.entries(T.MODULES)) {
    assert.ok(Object.keys(options).length >= 2, `${slot} 只有一个模块`);
  }
});

check('每个模块都有 label / hint / params', () => {
  for (const [slot, options] of Object.entries(T.MODULES)) {
    for (const [id, mod] of Object.entries(options)) {
      assert.strictEqual(mod.id, id, `${slot}.${id} 的 id 不一致`);
      assert.ok(mod.label, `${slot}.${id} 缺 label`);
      assert.ok(mod.hint, `${slot}.${id} 缺 hint`);
      assert.ok(mod.params && typeof mod.params === 'object', `${slot}.${id} 缺 params`);
    }
  }
});

// 同槽位的模块参数键必须齐 —— 渲染层按键读，缺一个就是 undefined 参与运算。
check('同槽位所有模块的参数键一致', () => {
  for (const [slot, options] of Object.entries(T.MODULES)) {
    const all = Object.values(options).map((m) => Object.keys(m.params).sort().join(','));
    const first = all[0];
    for (let i = 1; i < all.length; i += 1) {
      assert.strictEqual(all[i], first,
        `${slot} 的模块参数键不一致：\n  ${first}\n  ${all[i]}`);
    }
  }
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
