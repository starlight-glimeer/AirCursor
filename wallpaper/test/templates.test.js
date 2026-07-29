// templates.js：模板 = 三槽位 × 模块，以及这套模板绑哪些手势。
//
//   node test/templates.test.js
//
// 守的是这个设计的两条硬约束：动作 id 不能改（改了用户已录的手势就失效）、加模板/模块
// 不该需要改渲染或录制代码。
const assert = require('node:assert');
require('../src/system.js');
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

// 分档不是"手势分两组"，是"有没有手势"：普通版鼠标交互不开摄像头，进阶版全部动作
// 开放且都能录制。我第一版按动作分组做错了，这条守着新语义。
check('进阶档开放全部动作，两档不重叠', () => {
  const t = T.template('depthStage');
  assert.ok(t.actions.pro.length > 0, '进阶档没有动作');
  assert.strictEqual(t.actions.pro.length, Object.keys(T.ACTIONS).length,
    '进阶档没有开放全部动作（新增动作要记得加进模板，否则它存在但没人能用）');
  const overlap = t.actions.basic.filter((id) => t.actions.pro.includes(id));
  assert.strictEqual(overlap.length, 0, `两档重叠：${overlap.join(',')}`);
});

check('TIERS 说明了两档的含义（普通=无手势）', () => {
  assert.ok(T.TIERS.basic && T.TIERS.pro, '缺 TIERS 定义');
  assert.match(T.TIERS.basic.hint, /鼠标|不开摄像头/);
  assert.match(T.TIERS.pro.hint, /手势/);
});

// 回归守卫：曾经把可录制动作全塞进 pro 档而 pro 默认关，于是「可录制的动作」整栏是空的
// —— 用户看到的就是"录制功能不存在"。现在默认就是 pro 档，所以守的是"默认状态下有东西"。
check('默认档位下有可录制动作（录制栏不能打开就是空的）', () => {
  for (const id of Object.keys(T.TEMPLATES)) {
    const actions = T.recordableActionsOf(id, true);
    assert.ok(actions.length > 0, `模板 ${id} 没有任何可录制动作`);
  }
});

// 用户要"功能一致"：每个可录制动作都该有同样的选项，包括有律的那些。
check('所有可录制动作都能选静态/动态（不因为有律就锁死）', () => {
  const actions = T.recordableActionsOf('depthStage', true);
  assert.ok(actions.length >= 6, `可录制动作只有 ${actions.length} 个`);
  for (const action of actions) {
    assert.strictEqual(action.kind, 'discrete', `${action.id} 不是离散动作却可录制`);
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

console.log('\n  系统动作');

// 手势的定位是替代鼠标键盘，所以"控制壁纸"和"控制电脑"是同一批动作里的两类。
check('系统动作接在同一张 ACTIONS 表里', () => {
  const system = Object.values(T.ACTIONS).filter((a) => a.system);
  assert.ok(system.length >= 6, `系统动作只有 ${system.length} 个`);
  for (const action of system) {
    assert.ok(action.label && action.hint, `${action.id} 缺 label/hint`);
    assert.strictEqual(action.recordable, true, `${action.id} 不可录制`);
    assert.strictEqual(action.kind, 'discrete');
  }
});

// 八个壁纸动作和八个系统动作混在一张长列表里找不到东西。
check('分组把壁纸动作和系统动作分开', () => {
  const g = T.groupedActions('depthStage', true);
  assert.ok(g.wall.length > 0 && g.system.length > 0, '有一组是空的');
  assert.ok(g.wall.every((a) => !a.system), '壁纸组里混进了系统动作');
  assert.ok(g.system.every((a) => a.system), '系统组里混进了壁纸动作');
  assert.strictEqual(g.wall.length + g.system.length,
    T.actionsOf('depthStage', true).length, '分组丢了动作');
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
