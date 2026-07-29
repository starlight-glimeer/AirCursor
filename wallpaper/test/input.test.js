// input.js：手势判定（委托给 AirCursor 的 pose/motion/tracking）。
//
//   node test/input.test.js
//
// 这批用例的重点是**接线对不对**，不是重测 AirCursor 那三个模块 —— 它们在自己那边
// 有 240+ 条用例。这里要证的是：单位换算没错、返回值语义没读反、事件格式对得上、
// 以及"手离开再回来"这类生命周期不会留下脏状态。
//
// ⚠️ 合成的手：几个点摆成规则形状。所以它证不了"真手能不能认出来"，真手的抖动、
// 丢帧、时间相关噪声都在外面。
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// vendor 里的 AirCursor 模块。IIFE 挂 globalThis，所以 require 一次即可。
const vendor = path.join(__dirname, '..', 'src', 'vendor', 'aircursor');
if (!fs.existsSync(path.join(vendor, 'pose.js'))) {
  console.error('\n❌ 缺 src/vendor/aircursor/ —— 先跑 npm run vendor\n');
  process.exit(1);
}
require(path.join(vendor, 'pose.js'));
require(path.join(vendor, 'motion.js'));
require(path.join(vendor, 'tracking.js'));
require('../src/input.js');
const I = globalThis.GestureWallInput;
// 倾斜那一节直接测 TiltRatchet 的契约，所以要拿到 Motion 本身。
const Motion = globalThis.AirCursorMotion;
const P = globalThis.AirCursorPose;

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

// 造一只手。5 和 17 号同 y，所以 |5-17| 恰好是 palm（palmWidthOf 取的是欧氏距离，
// 给它们加 y 偏移会让实际掌宽大于 palm —— 我在上一版夹具里正是这么错的）。
function hand({ centerX = 0.5, centerY = 0.5, palm = 0.12, pinchGap = 1.0, tiltDeg = 0 } = {}) {
  const lm = [];
  for (let i = 0; i < 21; i += 1) lm.push({ x: centerX, y: centerY, z: 0 });
  lm[5] = { x: centerX - palm / 2, y: centerY, z: 0 };
  lm[13] = { x: centerX + palm * 0.18, y: centerY, z: 0 };
  lm[17] = { x: centerX + palm / 2, y: centerY, z: 0 };
  lm[0] = { x: centerX, y: centerY + palm * 0.6, z: 0 };
  // 9 号（中指根）相对 0 号（腕）决定 poseAngle 那根轴。tiltDeg 转它。
  const rad = (tiltDeg * Math.PI) / 180;
  const armLen = palm * 0.9;
  lm[9] = {
    x: lm[0].x + Math.sin(rad) * armLen,
    y: lm[0].y - Math.cos(rad) * armLen,
    z: 0,
  };
  const ids = [0, 5, 9, 13, 17];
  const cx = ids.reduce((s, i) => s + lm[i].x, 0) / 5;
  const cy = ids.reduce((s, i) => s + lm[i].y, 0) / 5;
  for (const id of ids) { lm[id].x += centerX - cx; lm[id].y += centerY - cy; }
  const gap = palm * pinchGap;
  lm[4] = { x: centerX - gap / 2, y: centerY - palm, z: 0 };
  lm[8] = { x: centerX + gap / 2, y: centerY - palm, z: 0 };
  return lm;
}

const pinched = (opts) => hand({ pinchGap: 0.2, ...opts });
const eventsOf = (result, action) => result.events.filter((e) => e.action === action);

// 直接调 isPinched / twoHandZoom 这类底层函数时，手必须先升到像素空间 —— 它们下游是
// AirCursor 的模块，而那些模块的常数是按像素标的（palmWidthOf 有 60px 下限）。
// GestureInput.update 自己会做这一步，所以只有绕过它的用例需要手动转。
const px = (lm) => I.toPixels(lm);

console.log('\ninput.js 几何');

check('掌宽用 pose.js 的实现，与捏合无关', () => {
  const open = hand({ palm: 0.12, pinchGap: 1.2 });
  const shut = hand({ palm: 0.12, pinchGap: 0.2 });
  assert.ok(Math.abs(I.palmWidth(px(open)) - I.palmWidth(px(shut))) < 1e-9, '捏合影响了掌宽');
});

check('捏合判定与离摄像头远近无关', () => {
  for (const palm of [0.06, 0.12, 0.28]) {
    assert.strictEqual(I.isPinched(px(pinched({ palm }))), true, `palm=${palm} 该判捏合`);
    assert.strictEqual(I.isPinched(px(hand({ palm, pinchGap: 1.2 }))), false, `palm=${palm} 不该判`);
  }
});

check('镜像翻 x 不翻 y', () => {
  const m = I.mirror([{ x: 0.2, y: 0.7, z: 0.1 }]);
  assert.strictEqual(m[0].x, 0.8);
  assert.strictEqual(m[0].y, 0.7);
});

// 产品的核心手势，方向曾经实现反过一次，所以钉死。
check('双手拉开 → zoom 变大', () => {
  const close = I.twoHandZoom([pinched({ centerX: 0.45 }), pinched({ centerX: 0.55 })].map(px));
  const far = I.twoHandZoom([pinched({ centerX: 0.2 }), pinched({ centerX: 0.8 })].map(px));
  assert.ok(close && far, '双手捏合没识别');
  assert.ok(far.value > close.value, `拉开该更大：${close.value} vs ${far.value}`);
});

check('只捏一只手不出 zoom，返回 null 不是 0', () => {
  assert.strictEqual(I.twoHandZoom([pinched({ centerX: 0.3 }), hand({ centerX: 0.7 })].map(px)), null);
  assert.strictEqual(I.twoHandZoom([px(pinched())]), null);
  assert.strictEqual(I.twoHandZoom(null), null);
});

check('zoom 与人离摄像头的距离无关', () => {
  const near = I.twoHandZoom([
    pinched({ centerX: 0.35, palm: 0.16 }), pinched({ centerX: 0.65, palm: 0.16 }),
  ].map(px));
  const far = I.twoHandZoom([
    pinched({ centerX: 0.425, palm: 0.08 }), pinched({ centerX: 0.575, palm: 0.08 }),
  ].map(px));
  assert.ok(Math.abs(near.value - far.value) < 0.02,
    `远近不一致：${near.value.toFixed(3)} vs ${far.value.toFixed(3)}`);
});

console.log('\n  接线（这是整合真正要验的部分）');

// PointerFilter 的默认 deadzone 是 1.6 **像素**，而壁纸的指针是 0..1。直接套的话
// 死区会盖住 160% 的屏幕，指针永远不动。FILTER_SPACE 就是为这个存在的。
// ⚠️ 断言要考虑镜像：摄像头看到的是镜像，所以输入 x 递增 → 输出 x 递减。
// 我第一版这三条断言全按"同向"写，全红，然后差点去改 PointerFilter 的死区换算 ——
// 单独测那个滤波器（输入 630 → 输出 632）才发现它跟得好得很，错的是夹具。
check('指针单位换算正确：手动了指针就动（镜像后反向）', () => {
  const input = new I.GestureInput();
  const xs = [];
  for (let f = 0; f < 12; f += 1) {
    const r = input.update([hand({ centerX: 0.3 + f * 0.03 })], f * 33, {});
    const p = eventsOf(r, 'pointer')[0];
    assert.ok(p, '没有 pointer 事件');
    xs.push(p.x);
  }
  // 手从 0.3 移到 0.63，镜像后是 0.7 → 0.37，所以输出该明显下降。
  // 若死区单位算错（把 1.6px 当成 1.6 归一化），指针会一动不动。
  const travelled = xs[0] - xs[xs.length - 1];
  assert.ok(travelled > 0.2,
    `指针只走了 ${travelled.toFixed(3)}（${xs[0].toFixed(2)}→${xs[xs.length - 1].toFixed(2)}）`
    + ' —— 死区单位可能算错了');
});

check('指针输出被夹在 0..1', () => {
  const input = new I.GestureInput();
  for (let f = 0; f < 20; f += 1) {
    // 手冲到画面外，外推可能把值推出边界
    const r = input.update([hand({ centerX: 0.02 })], f * 16, {});
    const p = eventsOf(r, 'pointer')[0];
    assert.ok(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1, `越界 ${p.x},${p.y}`);
  }
});

// One Euro 的意义就在这：静止时不抖，快速移动时不迟钝。固定平滑做不到两者兼得。
check('One Euro 生效：静止时输出比输入更稳', () => {
  const input = new I.GestureInput();
  const xs = [];
  for (let f = 0; f < 40; f += 1) {
    // 手停在 0.5 但带 ±0.01 的抖动
    const jitter = (f % 2 ? 1 : -1) * 0.01;
    const r = input.update([hand({ centerX: 0.5 + jitter })], f * 33, {});
    xs.push(eventsOf(r, 'pointer')[0].x);
  }
  const tail = xs.slice(10);
  const spread = Math.max(...tail) - Math.min(...tail);
  assert.ok(spread < 0.02, `输出抖动 ${spread.toFixed(4)} 没有小于输入的 0.02`);
});

check('双手捏合时发 zoom 而不是 pointer', () => {
  const input = new I.GestureInput();
  const r = input.update(
    [pinched({ centerX: 0.3 }), pinched({ centerX: 0.7 })].map((h) => h.map((p) => ({ ...p, x: 1 - p.x }))),
    100, {},
  );
  assert.strictEqual(eventsOf(r, 'zoom').length, 1, '没发 zoom');
  assert.strictEqual(eventsOf(r, 'pointer').length, 0, '同时还发了 pointer');
});

// SwipeDetector 用 0 表示"没触发"、±1 表示方向。读反的话会把每一帧都当成挥动。
check('慢速移动不触发挥动', () => {
  const input = new I.GestureInput();
  let swipes = 0;
  for (let f = 0; f < 30; f += 1) {
    const r = input.update([hand({ centerX: 0.4 + f * 0.002 })], f * 33, {});
    swipes += eventsOf(r, 'swipeLeft').length + eventsOf(r, 'swipeRight').length;
  }
  assert.strictEqual(swipes, 0, `慢速移动误触发了 ${swipes} 次挥动`);
});

check('快速横挥能触发，方向正确', () => {
  const input = new I.GestureInput();
  const fired = [];
  // 每帧 0.09 屏宽 / 0.12 掌宽 × 30fps ≈ 22 掌宽/秒，远超 2.6 的门
  for (let f = 0; f < 8; f += 1) {
    const r = input.update([hand({ centerX: 0.25 + f * 0.09, palm: 0.12 })], f * 33, {});
    if (eventsOf(r, 'swipeRight').length) fired.push('right');
    if (eventsOf(r, 'swipeLeft').length) fired.push('left');
  }
  assert.ok(fired.length >= 1, '快速横挥完全没触发');
  // 镜像：输入 x 递增 → 镜像后递减 → 向左。
  assert.strictEqual(fired[0], 'left', `方向反了（${fired[0]}）`);
  // 一次连续挥动只该触发一次 —— SwipeDetector 要求手腕先停下才重新武装，这正是
  // 我原来那份实现缺的（回手会算成第二次挥动）。
  assert.strictEqual(fired.length, 1, `一次挥动触发了 ${fired.length} 次`);
});

console.log('\n  生命周期');

// 手离开再回来时若不重置，旧轨迹会和新位置算出一次巨大位移 = 一次假挥动。
check('手离开再回来不产生假挥动', () => {
  const input = new I.GestureInput();
  for (let f = 0; f < 5; f += 1) input.update([hand({ centerX: 0.2 })], f * 33, {});
  // 手消失 1 秒
  for (let f = 5; f < 35; f += 1) input.update([], f * 33, {});
  // 从屏幕另一边回来
  const r = input.update([hand({ centerX: 0.9 })], 35 * 33, {});
  assert.strictEqual(eventsOf(r, 'swipeRight').length + eventsOf(r, 'swipeLeft').length, 0,
    '手回来时产生了假挥动');
});

check('没有手时不发事件，状态明确', () => {
  const input = new I.GestureInput();
  const r = input.update([], 100, {});
  assert.strictEqual(r.events.length, 0);
  assert.match(r.status, /未检测到手/);
});

// 手势有好几种"什么都不做"的方式，不点名的话症状全是"识别到了但没反应"。
//
// 但"速度不够"本身不算被挡：SwipeDetector 在手已武装且速度不够时把 blocked 设成
// null，因为那是正常待机而不是故障（motion.js:268）。真正需要点名的是那些
// **看着该触发却没触发**的情形 —— 挥完还没停手（waitingStill）、冷却期内（cooldown）、
// 挥得不够直（notStraight）。
check('挥完还没停手时，状态点名 waitingStill', () => {
  const input = new I.GestureInput();
  let sawReason = false;
  // 一直快速往一个方向挥：第一次会触发，之后 SwipeDetector 要求手腕先停下才重新
  // 武装，所以后续帧应该报 waitingStill。
  for (let f = 0; f < 10; f += 1) {
    const r = input.update([hand({ centerX: 0.15 + f * 0.08, palm: 0.12 })], f * 33, {});
    if (/挥动:waitingStill/.test(r.status)) sawReason = true;
  }
  assert.ok(sawReason, '连续挥动时没有报出 waitingStill');
});

check('慢速待机不报"被挡"（那不是故障）', () => {
  const input = new I.GestureInput();
  for (let f = 0; f < 20; f += 1) {
    const r = input.update([hand({ centerX: 0.4 + f * 0.002 })], f * 33, {});
    assert.ok(!/挥动:/.test(r.status), `慢速待机被误报成故障：${r.status}`);
  }
});

check('调参可以热改，不用重建', () => {
  const input = new I.GestureInput({ minCutoff: 1.2 });
  input.setTuning({ minCutoff: 5, beta: 0.2 });
  assert.strictEqual(input.pointer.tuning.minCutoff, 5);
  // deadzone 该被换算到像素空间
  input.setTuning({ deadzone: 0.01 });
  assert.strictEqual(input.pointer.tuning.deadzone, 0.01 * I.FILTER_SPACE);
});

check('reset 清掉全部状态', () => {
  const input = new I.GestureInput();
  for (let f = 0; f < 6; f += 1) input.update([hand({ centerX: 0.2 + f * 0.05 })], f * 33, {});
  input.reset();
  assert.strictEqual(input.path.samples.length, 0, '轨迹没清');
  assert.strictEqual(input.pointer.output, null, '指针滤波器没清');
  assert.strictEqual(input.swipe.lastFiredAt, null, '挥动冷却没清');
});

// 单手才有可靠的轴：双手镜像时 poseAngle 返回 null，TiltRatchet 会报 noAxis 而不是
// 拿一个随机角度算 —— 那正是 AirCursor 踩过的"哨兵值撞合法值"。
check('双手在场时不做倾斜判定', () => {
  const input = new I.GestureInput();
  const r = input.update([hand({ centerX: 0.3 }), hand({ centerX: 0.7 })], 100, {});
  assert.strictEqual(eventsOf(r, 'tiltUp').length + eventsOf(r, 'tiltDown').length, 0);
});

console.log('\n  录制的手势（这一段一开始整个漏了）');

// 缺口：录制能存下来，但 input.js 从不读 config.recorded，所以用户录完手势不生效，
// 而且不报错。靠 grep 在 input.js 里零命中发现的，不是靠读代码。
check('录的静态手势能触发', () => {
  const input = new I.GestureInput();
  const target = hand({ centerX: 0.5, palm: 0.12, pinchGap: 1.4 });
  const template = globalThis.AirCursorPose.buildPoseTemplate([px(I.mirror(target))]);
  const config = {
    recorded: { spin: { hands: 1, template, law: null } },
    matchThreshold: 0.28,
  };
  let fired = false;
  for (let f = 0; f < 6 && !fired; f += 1) {
    const r = input.update([target], f * 33, config);
    if (eventsOf(r, 'spin').length) fired = true;
  }
  assert.ok(fired, '录了手势但摆出来不触发 —— 接线又断了');
});

check('不同的姿势不会误触发录的手势', () => {
  const input = new I.GestureInput();
  // ⚠️ 两个姿势的距离必须真的超过阈值。第一版夹具只动了拇指和食指两个点，距离
  // 0.257 < 0.28，所以"完全不同的手型"其实还在匹配范围内 —— 断言红了，但代码是
  // 对的。夹具造的假手太规则，真手的差别大得多。
  const recordedPose = hand({ centerX: 0.5, palm: 0.12, pinchGap: 0.2 });
  const template = globalThis.AirCursorPose.buildPoseTemplate([px(I.mirror(recordedPose))]);
  const Pose = globalThis.AirCursorPose;

  // 换整只手的形状：所有指尖位置都变，不只是捏合那两个点。
  const different = hand({ centerX: 0.5, palm: 0.12, pinchGap: 0.2 });
  for (const id of [4, 8, 12, 16, 20]) {
    different[id] = { x: 0.5 + (id - 12) * 0.03, y: 0.5 + 0.14, z: 0 };
  }
  const otherTemplate = Pose.buildPoseTemplate([px(I.mirror(different))]);
  const gap = Pose.templateDistance(template, otherTemplate, 0);
  assert.ok(gap > 0.28, `夹具的两个姿势只差 ${gap.toFixed(3)}，构造不出"明显不同"`);

  const config = { recorded: { spin: { hands: 1, template, law: null } }, matchThreshold: 0.28 };
  let fired = 0;
  for (let f = 0; f < 10; f += 1) {
    fired += eventsOf(input.update([different], f * 33, config), 'spin').length;
  }
  assert.strictEqual(fired, 0, '不相干的姿势触发了录的手势');
});

// 保持住一个手型不该每帧都触发 —— 那会让一次抬手变成几十次动作。
check('保持住录的手型不会连发', () => {
  const input = new I.GestureInput();
  const target = hand({ centerX: 0.5, palm: 0.12, pinchGap: 1.4 });
  const template = globalThis.AirCursorPose.buildPoseTemplate([px(I.mirror(target))]);
  const config = { recorded: { spin: { hands: 1, template, law: null } }, matchThreshold: 0.28 };
  let fired = 0;
  for (let f = 0; f < 30; f += 1) {
    fired += eventsOf(input.update([target], f * 33, config), 'spin').length;
  }
  assert.strictEqual(fired, 1, `保持一个手型触发了 ${fired} 次`);
});

// 手数必须对得上：单手模板不该被双手姿势匹配。
check('手数不符的录制手势不参与匹配', () => {
  const input = new I.GestureInput();
  const target = hand({ centerX: 0.5, palm: 0.12, pinchGap: 1.4 });
  const template = globalThis.AirCursorPose.buildPoseTemplate([px(I.mirror(target))]);
  const config = {
    // 标成两只手，但只会喂一只
    recorded: { spin: { hands: 2, template, law: null } },
    matchThreshold: 0.28,
  };
  let fired = 0;
  for (let f = 0; f < 10; f += 1) {
    fired += eventsOf(input.update([target], f * 33, config), 'spin').length;
  }
  assert.strictEqual(fired, 0, '单手姿势匹配了双手模板');
});

// 有律的动作（挥动/倾斜）录制只是加一道"必须是这个手型"的门，触发方式仍由律决定 ——
// 所以它不该走静态直接触发那条路。
check('有律的录制手势不走静态触发', () => {
  const input = new I.GestureInput();
  const target = hand({ centerX: 0.5, palm: 0.12, pinchGap: 1.4 });
  const template = globalThis.AirCursorPose.buildPoseTemplate([px(I.mirror(target))]);
  const config = {
    recorded: { yawLeft: { hands: 1, template, law: 'swipe' } },
    matchThreshold: 0.28,
  };
  let fired = 0;
  for (let f = 0; f < 15; f += 1) {
    fired += eventsOf(input.update([target], f * 33, config), 'yawLeft').length;
  }
  assert.strictEqual(fired, 0, '有律的手势被静态直接触发了');
});

check('没有 recorded 字段时不崩', () => {
  const input = new I.GestureInput();
  const r = input.update([hand({ centerX: 0.5 })], 100, {});
  assert.ok(r.events.length > 0, '基本事件都没了');
});

check('reset 清掉序列匹配器的进度', () => {
  const input = new I.GestureInput();
  const matcher = input.sequenceFor('spin');
  matcher.lastFiredAt = 12345;
  input.reset();
  assert.strictEqual(matcher.lastFiredAt, null, '序列匹配器没被重置');
});

console.log('\n  倾斜参考角（真 bug 的回归守卫）');

// ⚠️ 这一节守的是一个真 bug：我原来传 `templateAngle: 0, // 手掌水平`。
// poseAngle 量腕→中指根这根轴，而屏幕 y 向下增长 ⟹ 手竖直举起读的是 **-90° 不是 0**。
//
// 后果比"角度偏了"严重：delta 恒 90° > 门 22° ⟹ 手一出现就触发一格；之后 armed=false，
// 而重新武装要 |delta| < 0.45×22 = 9.9°（手水平指向右）⟹ 竖着举手永远回不去。
// 症状 = "倾斜只响一次就再也不响"，不报错。
//
// 是外援 agent 从我这边的调用方式反查出来的（AirCursor f0d30d5），我这边实测坐实。
check('竖直举手时 delta 是 0，不是 90（参考角用 neutralTiltReference）', () => {
  const upright = Motion.neutralTiltReference();
  const ratchet = new Motion.TiltRatchet();
  const fired = ratchet.update({
    liveAngle: upright, templateAngle: upright,
    wristSpeed: 0, triggerDeg: 22, now: 1000,
  });
  assert.strictEqual(fired, 0, '手竖着举着静止不动就触发了');
  assert.ok(Math.abs(ratchet.deltaDeg) < 0.01,
    `竖直手的 delta 是 ${ratchet.deltaDeg.toFixed(1)}° —— 参考角搞错了`);
});

// 反例：把旧的错值钉住。这条不是重复上一条 —— 它证明那个值**确实**会坏，
// 所以如果哪天有人"顺手简化"回 0，失败信息会直接说清为什么不行。
check('反例：参考角写 0 会让手一出现就误触发', () => {
  const ratchet = new Motion.TiltRatchet();
  const fired = ratchet.update({
    liveAngle: Motion.neutralTiltReference(),   // 竖直手 = -90°
    templateAngle: 0,                          // 旧的错值
    wristSpeed: 0, triggerDeg: 22, now: 1000,
  });
  assert.notStrictEqual(fired, 0,
    '旧的错值现在不会误触发了？那约定变了，上一条的理由要重写');
  assert.ok(Math.abs(ratchet.deltaDeg) > 80,
    `旧值的 delta 只有 ${ratchet.deltaDeg.toFixed(1)}°，和 90 差太多`);
});

// 误触发之后棘轮会永久卡死 —— 这是"只响一次"那个症状的机制。
check('反例续：误触发后棘轮卡死（竖手回不到 9.9° 以内）', () => {
  const ratchet = new Motion.TiltRatchet();
  const args = {
    liveAngle: Motion.neutralTiltReference(), templateAngle: 0,
    wristSpeed: 0, triggerDeg: 22,
  };
  ratchet.update({ ...args, now: 1000 });          // 首帧误触发
  const second = ratchet.update({ ...args, now: 2000 });
  assert.strictEqual(second, 0);
  assert.strictEqual(ratchet.blocked, 'waitingReturn',
    '卡死的原因不是 waitingReturn 了，机制解释要更新');
});

check('修好后棘轮能反复触发（抬→回中→再抬）', () => {
  const upright = Motion.neutralTiltReference();
  const lifted = upright + 30 * Math.PI / 180;
  const ratchet = new Motion.TiltRatchet();
  const base = { templateAngle: upright, wristSpeed: 0, triggerDeg: 22 };
  assert.notStrictEqual(ratchet.update({ ...base, liveAngle: lifted, now: 1000 }), 0,
    '抬 30° 没触发');
  ratchet.update({ ...base, liveAngle: upright, now: 1200 });   // 回中重新武装
  assert.notStrictEqual(ratchet.update({ ...base, liveAngle: lifted, now: 1400 }), 0,
    '回中之后再抬不触发 —— 棘轮死了');
});

// ⚠️ input.js 里不能再出现字面量参考角。那个约定藏在 poseAngle 的实现里，
// 而参数名叫 templateAngle 会让人以为 0 是"中性"。
check('input.js 用 neutralTiltReference 而不是字面量', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'input.js'), 'utf8');
  assert.match(src, /templateAngle:\s*Motion\.neutralTiltReference\(\)/,
    'input.js 没用 neutralTiltReference');
  // ⚠️ 只看代码行，不看注释：上面那段注释里就写着 `templateAngle: 0` 当反例，
  // 直接全文匹配会把解释当违规（我第一版就是这样红的）。
  const code = src.split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.ok(!/templateAngle:\s*0\b/.test(code), 'input.js 的代码里还有 templateAngle: 0');
});

// ── 连续控制的门：录了才需要手型，没录照旧可用 ─────────────────────────────
//
// zoom / parallax 原来是 `recordable: false`，理由是"录一个静态姿势没有意义"。那把两个
// **正交**的维度绑在一起了：静态/动态说的是"手势本身是姿势还是动作"，离散/连续说的是
// "触发一次还是每帧给值"。一个静态手型完全可以驱动连续推进 —— 摆出它就一直推进，手型
// 变了就停。用户原话：「一个特定的静态手势画面连续推进放大，这也是可以实现的啊，手势
// 变了不就停了」。
//
// 这一节守两件事，而**第二件比第一件重要**：门要真的起作用；没录时绝不能挡。
// 把一个现成能用的功能改成"必须先配置"是回归，而它不会报错 —— 只会表现为"推进拉远
// 突然不好用了"。

// 双手捏合的一帧。zoom 要求两只手都捏住（拇指+食指靠拢）。
function pinchPair(gap) {
  return [hand({ centerX: 0.35, pinchGap: gap }), hand({ centerX: 0.65, pinchGap: gap })];
}

// 把一只手屈指，用来构造"手型不同"。
//
// ⚠️ 这个 helper 存在是因为**我第四次用了无效的反向夹具**。前三次：纯平移（模板按腕
// 平移归一化，2000px 距离仍是 0.0000）、只改一个点（63 维 RMS 摊平）、变化到某帧就
// 停（之后是一只静止的手）。这次是第四种：**只改 `palm`**。
//
// 掌宽正是尺度归一化的**分母** ⟹ `palm: 0.12` 和 `palm: 0.30` 的模板距离恰好 0.0000。
// 一只"大手"和一只"小手"在模板空间里是同一个手型，这是设计如此（手离摄像头远近不该
// 改变手势），而我拿它当"手型不同"。
//
// 实测能拉开距离的量：屈指 0.9 → 0.3001，刚过阈值 0.28。捏合 vs 张开只有 0.1867，
// **不够** —— 反向夹具必须实测超过阈值，不能看着不一样就算。
function curled(lm, amount) {
  const wrist = lm[0];
  return lm.map((p, k) => {
    if (k < 5) return p;
    const w = [8, 12, 16, 20].includes(k) ? 1 : [7, 11, 15, 19].includes(k) ? 0.6 : 0.25;
    return {
      x: p.x + (wrist.x - p.x) * amount * w,
      y: p.y + (wrist.y - p.y) * amount * w,
      z: p.z,
    };
  });
}

check('没录 zoom 时，捏合照旧驱动推进（不能变成必须先录）', () => {
  const input = new I.GestureInput({});
  const { events } = input.update(pinchPair(0.2), 1000, {});   // config 里没有 recorded
  assert.ok(events.some((e) => e.action === 'zoom'),
    '没录过就不给 zoom 了 —— 那是把现成的功能改成必须先配置');
});

check('录了 zoom 的手型：手型对上才给推进', () => {
  const input = new I.GestureInput({});
  // 用"两只手都捏住"那个姿势本身当模板 —— 那是用户会摆的手型
  const pose = P.buildPoseTemplate(pinchPair(0.2).map((lm) => I.toPixels(I.mirror(lm))));
  const config = { recorded: { zoom: { hands: 2, template: pose, dynamic: false, law: null } } };

  const on = input.update(pinchPair(0.2), 1000, config);
  assert.ok(on.events.some((e) => e.action === 'zoom'), '录的手型就在场，却不给推进');
});

check('录了 zoom 的手型：手型不对就不给推进（这才叫门）', () => {
  const input = new I.GestureInput({});
  // 模板是"屈指"的姿势，实时是"伸开捏合"。
  //
  // ⚠️ 屈指幅度从 0.9 提到 1.4：**双手的门是 0.56**（单手 0.28 的两倍，见 pose.js 的
  // thresholdFor），而 curl 0.9 只有 0.369 —— 落在门内了。curl 1.4 = 0.685 才够。
  //
  // 这条记下来是因为它是个陷阱：反向夹具的幅度必须跟着**实际生效的那个门**走，而这里
  // 生效的门取决于手数。按 matchThreshold 去算会得到一个"看着够但其实不够"的夹具。
  const template = P.buildPoseTemplate(
    pinchPair(0.2).map((lm) => I.toPixels(I.mirror(curled(lm, 1.4)))),
  );
  const config = { recorded: { zoom: { hands: 2, template, dynamic: false, law: null } } };
  const off = input.update(pinchPair(0.2), 1000, config);
  // 门关着时不该有 zoom 事件。**也不该报错、不该退化成别的动作。**
  assert.ok(!off.events.some((e) => e.action === 'zoom'),
    '手型完全不同却照样推进 —— 门没起作用');
});

check('视差的门是独立字段，不是把 palmX 设成 null', () => {
  // ⚠️ 第一版用 `palmX: null` 表示"门关着"，而消费方那句
  //   `typeof g.palmX === 'number' ? g.palmX : g.x`
  // 是给"旧版事件没带掌心"准备的兜底 ⟹ 门一关就回落到**指尖**，视差跟着手指头跳。
  // 「门关着」和「这个字段不存在」撞成了同一个值，而后者早就有含义了。
  //
  // 这是哨兵值撞值的第三次（angle:0 既是"指向右"又是"没有轴"、lastFiredAt:0 吃掉第一
  // 次触发）。所以：门是新语义，就给它新字段，而 palmX 永远是个坐标。
  const input = new I.GestureInput({});
  const template = P.buildPoseTemplate(
    [curled(hand({ palm: 0.12 }), 0.9)].map((lm) => I.toPixels(I.mirror(lm))),
  );
  const config = { recorded: { parallax: { hands: 1, template, dynamic: false, law: null } } };
  const out = input.update([hand({ palm: 0.12 })], 1000, config);
  const pointer = out.events.find((e) => e.action === 'pointer');
  assert.ok(pointer, '没有 pointer 事件');
  assert.strictEqual(typeof pointer.palmX, 'number',
    'palmX 被设成了 null —— 消费方会回落到指尖，视差跟着手指头跳');
  assert.strictEqual(pointer.parallax, false, '门关着，但事件里没说');
  // 指针本身不受这道门影响：它是鼠标，不该被壁纸视差的手型开关关掉。
  assert.strictEqual(typeof pointer.x, 'number', '指针被视差的门挡住了');
});

check('壁纸端认这个门，而且缺字段时放行', () => {
  const wall = fs.readFileSync(path.join(__dirname, '..', 'src', 'wall.js'), 'utf8');
  // `!== false` 而不是 `=== true`：不带这个字段的事件（旧版/其他来源）照旧放行。
  assert.match(wall, /g\.parallax === false/,
    '壁纸端没读这道门 —— 那门就只存在于事件里，不影响画面');
});

check('连续动作不走"触发一次"那条路', () => {
  // 摆出 zoom 的手型不该同时"触发一次 zoom 事件"和"开启连续 zoom"。前者没有意义 ——
  // zoom 消费的是 value，一个不带 value 的 zoom 事件会被当成 value=undefined。
  const input = new I.GestureInput({});
  const pose = P.buildPoseTemplate([hand({ palm: 0.12 })].map((lm) => I.toPixels(I.mirror(lm))));
  const config = { recorded: { parallax: { hands: 1, template: pose, dynamic: false, law: null } } };
  const out = input.update([hand({ palm: 0.12 })], 1000, config);
  const bare = out.events.filter((e) => e.action === 'parallax');
  assert.deepStrictEqual(bare, [],
    'parallax 被当成离散手势触发了一次 —— 它是连续量，没有"触发一次"的语义');
});

// ── 匹配诊断：「录了没反应」必须能说出断在哪 ──────────────────────────────
//
// 这条链有六段（录制 → 存盘 → 写配置 → 匹配 → 发事件 → 主进程执行），而在此之前只有
// 两头可见。用户报「我录制了打开网易云，预览图看着没问题，但是没反应」，而这一句对应
// 六个完全不同的处理 —— 中间四段全靠猜。
//
// `updateRecorded` 里每一个 continue 都会让手势静默失效：手数不对、距离差一点、armed
// 没复位。三种原因指向完全不同的下一步（换手数 / 摆准一点 / 先松手），症状是同一句
// "没反应"。所以诊断要报**距离和门限两个数**，不是一个布尔值。
check('诊断报出每个录过动作的距离和原因', () => {
  const input = new I.GestureInput({});
  const target = hand({ palm: 0.12 });
  const template = P.buildPoseTemplate([px(I.mirror(target))]);
  const config = {
    recorded: { open_netease: { hands: 1, template, dynamic: false, law: null } },
    matchThreshold: 0.28,
  };
  input.update([target], 1000, config);
  const probe = input.lastProbe();
  assert.strictEqual(probe.length, 1, `诊断应该有 1 条，实际 ${probe.length}`);
  assert.strictEqual(probe[0].action, 'open_netease');
  assert.strictEqual(typeof probe[0].distance, 'number', '没报距离 —— 差 0.01 和差 10 倍分不开');
  assert.strictEqual(typeof probe[0].threshold, 'number', '没报门限 —— 光有距离读不出远近');
  assert.ok(probe[0].why, '没说原因');
});

check('手数不对时诊断直接说手数（而不是报一个距离）', () => {
  const input = new I.GestureInput({});
  const template = P.buildPoseTemplate([px(I.mirror(hand())), px(I.mirror(hand({ centerX: 0.7 })))]);
  const config = { recorded: { spin: { hands: 2, template, dynamic: false, law: null } } };
  input.update([hand()], 1000, config);      // 只举一只手
  const probe = input.lastProbe();
  assert.match(probe[0].why, /2 只手/, `手数不对却报了别的原因：${probe[0].why}`);
  // 距离在这种情况下是 Infinity，报出来只会误导 —— 所以不报。
  assert.strictEqual(probe[0].distance, undefined, '手数不对时不该报距离');
});

check('姿势够近但没触发时，说得出是"要先离开再回来"', () => {
  // 这一条是静态手势"保持住不连发"的机制，而它的副作用是：用户摆着手不动会看到
  // "没反应"。诊断必须把这种情况和"姿势不够近"分开 —— 前者是正常的，后者要重录。
  const input = new I.GestureInput({});
  const target = hand({ palm: 0.12 });
  const template = P.buildPoseTemplate([px(I.mirror(target))]);
  const config = { recorded: { spin: { hands: 1, template, dynamic: false, law: null } } };
  const first = input.update([target], 1000, config);
  assert.ok(first.events.some((e) => e.action === 'spin'), '第一帧就该触发');
  input.update([target], 1100, config);      // 手一直不动
  const probe = input.lastProbe();
  assert.strictEqual(probe[0].armed, false, 'armed 没被清掉');
  assert.match(probe[0].why, /离开/, `没说清为什么不再触发：${probe[0].why}`);
});

check('有律的动作：手型对上了要说"等挥动"，不是"没反应"', () => {
  // 「录了有律的动作却没反应」的原因往往在**律那一侧**（没挥够快/没倾斜够），而不是
  // 姿势不对。之前这一格根本不报，于是它和"姿势不对"完全分不开。
  const input = new I.GestureInput({});
  const target = hand({ palm: 0.12 });
  const template = P.buildPoseTemplate([px(I.mirror(target))]);
  const config = { recorded: { yawLeft: { hands: 1, template, dynamic: false, law: 'swipe' } } };
  input.update([target], 1000, config);
  const probe = input.lastProbe();
  assert.ok(probe.length, '有律的动作一条诊断都没报');
  assert.match(probe[0].why, /挥动/, `没说在等什么：${probe[0].why}`);
});

check('手不在画面里时诊断清掉，不留上一帧的数字', () => {
  // 留着旧数字比空白更误导：用户会以为"手明明放下了，它还说差 0.1"。
  const input = new I.GestureInput({});
  const target = hand({ palm: 0.12 });
  const template = P.buildPoseTemplate([px(I.mirror(target))]);
  const config = { recorded: { spin: { hands: 1, template, dynamic: false, law: null } } };
  input.update([target], 1000, config);
  assert.ok(input.lastProbe()[0].distance !== undefined, '有手时该有距离');
  input.update([], 1500, config);
  const probe = input.lastProbe();
  assert.strictEqual(probe[0].distance, undefined, '手不在了还留着距离');
  assert.match(probe[0].why, /手不在/, `没说手不在：${probe[0].why}`);
});

check('什么都没录时说"还没录过"，不是空白', () => {
  const input = new I.GestureInput({});
  input.update([hand()], 1000, { recorded: {} });
  assert.match(input.lastProbe()[0].why, /还没录/, '空配置时诊断是空的 —— 那和"坏了"分不开');
});

// ── 配置形状：input 读的字段跨两层 ────────────────────────────────────────
//
// **这是「录了打开网易云没反应」的根因。** sensor 把 `config.gestureTuning` 传给
// `input.update`，而 `updateRecorded` 读 `config.recorded` —— 那个字段在配置的**顶层**，
// 是 gestureTuning 的兄弟。于是录过的手势永远读不到，一个都匹配不上。
//
// 它藏了很久，因为**一半的字段恰好能读到**：input 读 5 个字段，swipeSpeed / tiltTriggerDeg
// 真在 gestureTuning 里，所以挥动和倾斜一直好使，只有"用户录的手势"这一类静默失效。
// 全错会立刻被当成"手势坏了"，半错只表现为"我录的那个没反应"。
check('用真实的配置形状（顶层 recorded + 嵌套 gestureTuning）能匹配', () => {
  const target = hand({ palm: 0.12 });
  const template = P.buildPoseTemplate([px(I.mirror(target))]);
  // ⚠️ 这个形状必须和 main.js 的 defaultConfig 一致，否则这条用例就是在测一个想象中的配置
  const config = {
    recorded: { open_netease: { hands: 1, template, dynamic: false, law: null } },
    gestureTuning: { matchThreshold: 0.28, rotationTolerance: 20, swipeSpeed: 2.6 },
  };
  const input = new I.GestureInput(config);
  const out = input.update([target], 1000, config);
  assert.ok(out.events.some((e) => e.action === 'open_netease'),
    '真实配置下录过的手势没触发 —— 这正是"录了没反应"');
});

check('sensor 传的是整个 config，不是它的某个子对象', () => {
  const sensor = fs.readFileSync(path.join(__dirname, '..', 'src', 'sensor.js'), 'utf8');
  const call = sensor.split('\n').find((l) => l.includes('input.update(list'));
  assert.ok(call, '找不到 input.update 的调用');
  assert.doesNotMatch(call, /tuningOf\(\)/,
    'input.update 又被喂了 gestureTuning —— config.recorded 会读不到，录过的手势全部失效');
  assert.match(call, /config/, 'input.update 没有拿到 config');
});

check('调参项在 gestureTuning 里也读得到（两种传法都认）', () => {
  // 纯逻辑用例里直接传 `{ matchThreshold: 0.3 }` 更自然，真实链路传的是嵌套形状。
  // 两种都要认，否则改一边就会把另一边悄悄打回默认值。
  const target = hand({ palm: 0.12 });
  const template = P.buildPoseTemplate([px(I.mirror(target))]);
  const entry = { hands: 1, template, dynamic: false, law: null };
  // 门限设成 0：任何姿势都不该匹配（距离 >= 0 恒成立）
  for (const config of [
    { recorded: { spin: entry }, matchThreshold: 0 },
    { recorded: { spin: entry }, gestureTuning: { matchThreshold: 0 } },
  ]) {
    const input = new I.GestureInput(config);
    const out = input.update([target], 1000, config);
    assert.ok(!out.events.some((e) => e.action === 'spin'),
      `门限 0 却触发了 —— 这层的 matchThreshold 没读到：${JSON.stringify(Object.keys(config))}`);
  }
});

check('旋转容忍按度解释，不是弧度', () => {
  // ⚠️ 原来直接把配置值当弧度 ⟹ 默认 20 被当成 20 弧度 = 1146°，也就是**任何角度的手都
  // 匹配**（实测把手转 60°，距离从 0.5327 掉到 0.0000）。方向是过于宽松，症状是手势互相
  // 串，而不是没反应 —— 和上面那条是两个独立的 bug，只是住在相邻两行。
  const upright = hand({ palm: 0.12 });
  const template = P.buildPoseTemplate([px(I.mirror(upright))]);
  const rotated = rotateHand(upright, 60);
  const config = {
    recorded: { spin: { hands: 1, template, dynamic: false, law: null } },
    gestureTuning: { matchThreshold: 0.28, rotationTolerance: 20 },
  };
  const input = new I.GestureInput(config);
  const out = input.update([rotated], 1000, config);
  assert.ok(!out.events.some((e) => e.action === 'spin'),
    '手转了 60° 还匹配 —— rotationTolerance 被当成弧度了（20 弧度 = 1146°，等于不设限）');
});

// 绕手心转一只手，度数入。测旋转容忍必须真的转手，而不是改别的量。
function rotateHand(lm, deg) {
  const rad = (deg * Math.PI) / 180;
  const cx = lm[0].x;
  const cy = lm[0].y;
  const c = Math.cos(rad);
  const sn = Math.sin(rad);
  return lm.map((p) => ({
    x: cx + (p.x - cx) * c - (p.y - cy) * sn,
    y: cy + (p.x - cx) * sn + (p.y - cy) * c,
    z: p.z,
  }));
}

// ── 单个手势的开关 ───────────────────────────────────────────────────────
//
// 用户要"每个手势的启动和关闭按钮，方便精准使用"。真实处境是手势串了：想先关掉一个
// 看看是不是它在抢，而"清除"是破坏性的（录一次要 4 秒保持 + 一次动作）。
check('关掉的手势不参与匹配', () => {
  const target = hand({ palm: 0.12 });
  const template = P.buildPoseTemplate([px(I.mirror(target))]);
  const input = new I.GestureInput({});
  const config = {
    recorded: { spin: { hands: 1, template, dynamic: false, law: null, enabled: false } },
    gestureTuning: { matchThreshold: 0.28 },
  };
  const out = input.update([target], 1000, config);
  assert.ok(!out.events.some((e) => e.action === 'spin'), '关掉的手势还在触发');
  assert.match(input.lastProbe()[0].why, /已关闭/,
    '诊断没说是被关掉了 —— 那会和"姿势不够近"混起来，用户会去重录一个本来好的手势');
});

check('缺 enabled 字段当成开着（存量录制不能被静默关掉）', () => {
  // ⚠️ `!== false` 而不是 `=== true`。这个字段是后加的，用户已经录好的手势里没有它 ——
  // 判成"关闭"等于升级之后所有手势静默失效，而那看起来就是"新版本坏了"。
  const target = hand({ palm: 0.12 });
  const template = P.buildPoseTemplate([px(I.mirror(target))]);
  const input = new I.GestureInput({});
  const config = {
    recorded: { spin: { hands: 1, template, dynamic: false, law: null } },   // 没有 enabled
    gestureTuning: { matchThreshold: 0.28 },
  };
  const out = input.update([target], 1000, config);
  assert.ok(out.events.some((e) => e.action === 'spin'), '存量录制被当成关闭了');
});

check('关掉连续动作的手型 = 回到内置映射，不是禁用那个动作', () => {
  // 关掉 zoom 的手型门之后，捏合应该照旧能用（回到"没录"的状态），而不是 zoom 失效。
  const input = new I.GestureInput({});
  const template = P.buildPoseTemplate(
    pinchPair(0.2).map((lm) => I.toPixels(I.mirror(curled(lm, 0.9)))),
  );
  const config = {
    recorded: { zoom: { hands: 2, template, dynamic: false, law: null, enabled: false } },
    gestureTuning: { matchThreshold: 0.28 },
  };
  const out = input.update(pinchPair(0.2), 1000, config);
  assert.ok(out.events.some((e) => e.action === 'zoom'),
    '关掉手型门之后捏合也不给推进了 —— 那是把开关变成了"禁用这个动作"');
});

// ── 双手的匹配门**不**放宽（一个被证伪的结论） ────────────────────────────
//
// 曾经这里断言"双手门 = 单手 × 2"，依据是"双手命中率只有 51%、单手 67%"。
// **那两个数是假的。**它们来自一个把真机逐帧增量累加到静止基准上的夹具，而增量累加会
// 随机游走式堆积 ⟹ 实测抖动被夸大 **5.7 倍**（相邻帧距离中位 0.275，真机 0.048）。
//
// 用真机绝对帧重测（各取手最静止的窗口）：
//
//            离自己模板   门 0.28 的命中率
//   单手     中位 0.050      **100%**
//   双手     中位 0.079      **100%**
//
// 双手只比单手噪声大 1.6 倍，0.28 对两者都够。而放宽一倍还直接引出了下一个 bug：
// 那个门同时是"离开姿势"的判据 ⟹ 双手触发一次就要把手完全放开才能再触发。
//
// 双手真正难触发的原因是**丢跟踪**（双手帧占 69%，连续段中位 3 帧），单独修了。
check('匹配阈值不按手数放宽（那个结论来自被夸大 5.7 倍的夹具）', () => {
  assert.strictEqual(P.thresholdFor({ hands: 1 }, 0.28), 0.28);
  assert.strictEqual(P.thresholdFor({ hands: 2 }, 0.28), 0.28,
    '双手门又被放宽了 —— 真机实测 0.28 对双手也是 100% 命中，放宽只会降低判别力');
  assert.strictEqual(P.thresholdFor(null, 0.28), 0.28, '缺模板时不该崩');
});

check('真机静止帧下双手和单手都能稳定命中', () => {
  // 直接用真机绝对帧，不合成 —— 这条用例存在的理由就是上面那个假数据。
  const S = 1000;
  const px2 = (h) => h.map(([x, y, z]) => ({ x: x * S, y: y * S, z: z * S }));
  const fixture = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'real-landmark-noise.json'), 'utf8'));
  const two = fixture.twoHandFrames.slice(6, 16);       // stillWindow 附近最静止的双手段
  assert.ok(two.length >= 8, '夹具里的双手帧不够');
  const tpl = P.medianTemplate(two.map((hs) => P.buildPoseTemplate(hs.map(px2))));
  const rot = (20 * Math.PI) / 180;
  const hits = two.filter((hs) => P.templateDistance(P.buildPoseTemplate(hs.map(px2)), tpl, rot) < 0.28);
  assert.ok(hits.length >= two.length * 0.8,
    `双手真机静止帧在门 0.28 下只命中 ${hits.length}/${two.length} —— `
    + '如果这条红了，说明放宽门的理由重新成立，但要先确认夹具是绝对帧');
});

check('匹配、序列、冲突三处用同一个门（不一致会给出自相矛盾的提示）', () => {
  const input = fs.readFileSync(path.join(__dirname, '..', 'src', 'input.js'), 'utf8');
  const rec = fs.readFileSync(path.join(__dirname, '..', 'src', 'recorder.js'), 'utf8');
  // 漏掉任何一处的后果：录的时候说没冲突、跑起来两个手势互抢；或者反过来，
  // 能匹配的手势被判成冲突而存不进去。
  assert.ok((input.match(/thresholdFor/g) || []).length >= 4,
    `input.js 只有 ${(input.match(/thresholdFor/g) || []).length} 处用了 thresholdFor —— `
    + '静态/有律/序列/连续四条路都要用');
  assert.match(rec, /Pose\.thresholdFor/, '冲突检测没用放宽后的门');
});

// ── 丢跟踪不该消耗序列的超时预算 ──────────────────────────────────────────
//
// 真机 capture 实测：双手帧只占 69%（单手 86%），而**双手连续段的中位长度只有 3 帧**。
// 一个 10 关键帧的序列要走 10 帧连续双手，只有 2/4 段够长。
//
// 掉的那些帧既不能推进序列、又照样消耗超时预算 ⟹ 必然 tooSlow。这是「帧驱动的判定要给
// 丢帧宽限」在这个项目里的第四次（保持判定、点击、trackingRate、这里）。
check('手数不够时把时间还给序列，不让预算白流', () => {
  const m = new Motion.SequenceMatcher();
  const a = { hands: 1, angle: 0, values: new Array(63).fill(0) };
  const b = { hands: 1, angle: 0, values: new Array(63).fill(0.5) };
  const keyframes = [{ template: a, offsetMs: 0 }, { template: b, offsetMs: 400 }];
  m.update({ pose: a, keyframes, threshold: 0.28, rotationTolerance: 0,
    distance: P.templateDistance, now: 1000 });
  assert.strictEqual(m.index, 1, '起始姿势没命中，后面的比较没意义');
  const started = m.startedAt;

  m.excuse(1100);                       // 丢了 100ms
  assert.strictEqual(m.startedAt, started + 100, '宽限没把时间还回来');
  assert.strictEqual(m.excused, 1, '没记宽限次数');

  m.excuse(1500);                       // 丢了 400ms，超过 250ms 上限
  assert.strictEqual(m.startedAt, started + 100,
    '丢了 400ms 还在宽限 —— 真把手放下了不该无限期挂着');
});

check('还没开始的序列不宽限（没有预算可还）', () => {
  const m = new Motion.SequenceMatcher();
  m.excuse(1000);
  assert.strictEqual(m.startedAt, null, 'index 0 时 excuse 应该是 no-op');
});

// ── 重新武装:门要比触发低,而且要带时间 ────────────────────────────────────
//
// 用户报「确实是容易触发了，但是体感上是第一次好触发，后面又很难触发了」。
//
// 根因:触发和重新武装**共用一个门**。触发要 `距离 < gate`,重新武装要 `距离 >= gate`
// ⟹ 双手把门放宽一倍之后,"离开姿势"也要离开一倍远。实测:
//
//   动作        单手(门 0.28)  双手(门 0.56)
//   手指微松      0.303 ✅       0.342 ❌ 仍算"没离开"
//   明显松开      0.547 ✅       0.600 ✅（只比门高 7%）
//
// 也就是双手触发一次之后要把手**完全放开**才能再触发,而没人会那么做。
//
// ⚠️ 这批用例钉的是**机制**,不是参数值 —— 那两个常数没标定成功(见 input.js 的注释)。
check('重新武装的门低于触发的门', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'input.js'), 'utf8');
  const m = src.match(/const RE_ARM_RATIO = ([\d.]+);/);
  assert.ok(m, '找不到 RE_ARM_RATIO');
  assert.ok(Number(m[1]) < 1,
    '重新武装和触发共用一个门 —— 双手放宽后手指微松跨不过去，触发一次就要完全放开');
  assert.ok(Number(m[1]) > 0.3, '松开门太低了 —— 手稍微一抖就重新武装，会连发');
});

check('真机噪声下手一直保持姿势不会连发', () => {
  // ⚠️ 这条替代了一条被证伪的用例（"重新武装要求持续离开 250ms"）。那条的依据是
  // "手不动时距离在 0.12–1.33 抖、24 帧穿越门 5 次"，而那个测量来自一个把真机逐帧增量
  // 累加到静止基准上的夹具 —— 增量累加随机游走式堆积，抖动被夸大 **5.7 倍**。
  //
  // 真机绝对帧重测：保持段距离 **0.011–0.155，穿越门 0 次**。所以位置滞回够用，
  // 那个时间机制在解决一个不存在的问题。
  const fixture = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'real-landmark-noise.json'), 'utf8'));
  const raw = fixture.frames
    .slice(fixture.stillWindow.from, fixture.stillWindow.from + fixture.stillWindow.count)
    .map((h) => h.map(([x, y, z]) => ({ x, y, z })));
  const template = P.medianTemplate(raw.map((h) => P.buildPoseTemplate([px(I.mirror(h))])));
  const config = {
    recorded: { spin: { hands: 1, template, dynamic: false, law: null } },
    gestureTuning: { matchThreshold: 0.28 },
  };
  const input = new I.GestureInput(config);
  let fires = 0;
  // 200 帧 ≈ 8.6 秒，手一直保持不松开
  for (let i = 0; i < 200; i += 1) {
    const out = input.update([raw[i % raw.length]], 1000 + i * 43, config);
    if (out.events.some((e) => e.action === 'spin')) fires += 1;
  }
  assert.strictEqual(fires, 1,
    `保持姿势 8.6 秒触发了 ${fires} 次 —— armed 机制失效了（应该只有第一次）`);
});

check('持续离开够久之后能再触发', () => {
  const target = hand({ palm: 0.12 });
  const template = P.buildPoseTemplate([px(I.mirror(target))]);
  const config = {
    recorded: { spin: { hands: 1, template, dynamic: false, law: null } },
    gestureTuning: { matchThreshold: 0.28 },
  };
  const input = new I.GestureInput(config);
  input.update([target], 1000, config);
  // 离开 600ms（远超 RE_ARM_MS），期间一直保持远
  const away = curled(hand({ palm: 0.12 }), 1.4);
  for (let t = 1040; t <= 1640; t += 40) input.update([away], t, config);
  const again = input.update([target], 1700, config);
  assert.ok(again.events.some((e) => e.action === 'spin'),
    '手离开了 600ms 还不能再触发 —— 那就是"第一次好触发，后面很难"');
});

check('诊断报出松开门（否则用户不知道该松多少）', () => {
  // 「后面很难触发」那个状态在诊断里必须说得出来：手够近所以不算离开、但已经触发过，
  // 于是看起来没反应。只说"要先离开"用户不知道该松到什么程度。
  const target = hand({ palm: 0.12 });
  const template = P.buildPoseTemplate([px(I.mirror(target))]);
  const config = {
    recorded: { spin: { hands: 1, template, dynamic: false, law: null } },
    gestureTuning: { matchThreshold: 0.28 },
  };
  const input = new I.GestureInput(config);
  input.update([target], 1000, config);      // 触发，之后 armed = false
  input.update([target], 1040, config);
  const probe = input.lastProbe()[0];
  assert.strictEqual(probe.armed, false, 'armed 没被清掉');
  assert.strictEqual(typeof probe.reArm, 'number', '没报松开门');
  assert.match(probe.why, /离开到 [\d.]+/, `没说要松到多少：${probe.why}`);
});


// ── 手做动作时离开画面 ───────────────────────────────────────────────────
//
// 用户的观察：「如果录制的动态手势在做动作的时候离开了屏幕，好像这个动作的触发就很困难了」。
// **成立，而且有两个独立的原因。**
//
// ① `reset()` 的门是 400ms —— 对指针/挥动是对的（旧轨迹会算出假挥动），但它同时清掉了
//    序列的进度。实测一个 3 关键帧的动态手势中途丢 516ms 就整个归零，而真机 capture 里
//    最长的丢跟踪段是 **726ms**。
// ② 那段时间里序列的超时预算照走 ⟹ 恢复后直接 tooSlow。上一轮给"手数不够"加过宽限，
//    但**手完全不在画面走的是另一条分支**，压根没经过那段代码。同一个修法漏了一半，
//    而漏掉的这半是更常见的情形。
const LEAVE_FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'real-landmark-noise.json'), 'utf8'));

// 用真机轨迹造一个 3 关键帧的动态手势，然后中途让手消失。
function runWithGap(mode, gapMs) {
  const raw = LEAVE_FIXTURE.frames.map((h) => h.map(([x, y, z]) => ({ x, y, z })));
  const traj = raw.slice(30, 55);
  const tpl = (h) => P.buildPoseTemplate([px(I.mirror(h))]);
  const keyframes = [0, 12, 24].map((i) => ({ template: tpl(traj[i]), offsetMs: i * 43 }));
  const config = {
    recorded: { spin: { hands: 1, template: keyframes[0].template, dynamic: true, law: null,
      keyframeData: keyframes } },
    gestureTuning: { matchThreshold: 0.28, rotationTolerance: 20 },
  };
  const input = new I.GestureInput(config);
  let now = 1000;
  for (let i = 0; i < traj.length; i += 1) {
    if (i === 13) {
      if (mode === 'frames') {
        // 摄像头在出帧但检不到手 —— 走"手不在画面"那条分支
        for (let k = 0; k < Math.round(gapMs / 43); k += 1, now += 43) input.update([], now, config);
      } else {
        // 摄像头整段不出帧（睡眠/切后台/推理卡住）—— update 压根不被调用
        now += gapMs;
      }
    }
    const out = input.update([traj[i]], now, config);
    now += 43;
    if (out.events.some((e) => e.action === 'spin')) return true;
  }
  return false;
}

check('做动作时手短暂离开画面，序列接着走', () => {
  // 700ms 超过 reset() 的 400ms 门，但远小于真机最长丢跟踪 726ms 的量级 ——
  // 这种情形必须能继续，否则"做动作时手挥出画面边缘"就永远触发不了。
  assert.ok(runWithGap('frames', 700), '手离开 700ms 之后序列断了');
  assert.ok(runWithGap('frames', 1400), '手离开 1400ms 之后序列断了（放弃门是 1500ms）');
});

check('摄像头整段不出帧时也还时间（两种丢法结果要一致）', () => {
  // ⚠️ 这一格漏过：摄像头不出帧时 `update` 压根不被调用，所以"手不在画面"那条分支一次
  // 都走不到 ⟹ 恢复后第一帧直接判 tooSlow。实测同样 1400ms，逐帧丢能触发、整段不出帧
  // 不能 —— **同样的时间跨度两种丢法结果不同，那就是漏了一处**。
  assert.ok(runWithGap('jump', 700), '摄像头停 700ms 之后序列断了');
  assert.ok(runWithGap('jump', 1400), '摄像头停 1400ms 之后序列断了');
});

check('离开太久要放弃（否则序列永远不过期）', () => {
  // 宽限的另一半：手真的放下去做别的事了，这次动作就该作废。不放弃的话下次举手会接上
  // 一个几秒前的半成品序列，而用户会得到一个他没做过的动作。
  assert.ok(!runWithGap('frames', 2500), '手离开 2500ms 还在接着走 —— 序列永远不过期');
  assert.ok(!runWithGap('jump', 2500), '摄像头停 2500ms 还在接着走');
});

check('宽限的上限是"单次调用"的，不是总时长的', () => {
  // 逐帧调用时每次 gap 只有一个帧间隔，所以 700ms 会被拆成 16 次小 gap 全额还回。
  // 而调用方明确知道这段有多久时可以传一个更大的上限 —— 否则整段不出帧那种一次性大 gap
  // 会被默认的 250ms 挡掉，等于宽限没生效。
  const m = new Motion.SequenceMatcher();
  const a = { hands: 1, angle: 0, values: new Array(63).fill(0) };
  const keyframes = [{ template: a, offsetMs: 0 },
    { template: { hands: 1, angle: 0, values: new Array(63).fill(0.5) }, offsetMs: 400 }];
  m.update({ pose: a, keyframes, threshold: 0.28, rotationTolerance: 0,
    distance: P.templateDistance, now: 1000 });
  const started = m.startedAt;

  // 逐帧：16 次 × 43ms
  let t = 1000;
  for (let i = 0; i < 16; i += 1) { t += 43; m.excuse(t); }
  assert.ok(Math.abs((m.startedAt - started) - 688) < 50,
    `逐帧宽限 688ms 只还回 ${m.startedAt - started}ms`);

  // 一次性大 gap：默认上限挡掉，传大上限则放行
  const m2 = new Motion.SequenceMatcher();
  m2.update({ pose: a, keyframes, threshold: 0.28, rotationTolerance: 0,
    distance: P.templateDistance, now: 1000 });
  m2.excuse(1700);
  assert.strictEqual(m2.startedAt, 1000, '一次性 700ms 该被默认上限挡掉');
  const m3 = new Motion.SequenceMatcher();
  m3.update({ pose: a, keyframes, threshold: 0.28, rotationTolerance: 0,
    distance: P.templateDistance, now: 1000 });
  m3.excuse(1700, 1500);
  assert.strictEqual(m3.startedAt, 1700, '传了 1500 的上限却没放行');
});

check('手离开时诊断说清序列还在等，而不是只说"手不在画面"', () => {
  // "手不在画面里"和"这次动作已经作废"是两回事，而用户看到的都是没反应。
  const raw = LEAVE_FIXTURE.frames.map((h) => h.map(([x, y, z]) => ({ x, y, z })));
  const traj = raw.slice(30, 55);
  const tpl = (h) => P.buildPoseTemplate([px(I.mirror(h))]);
  const keyframes = [0, 12, 24].map((i) => ({ template: tpl(traj[i]), offsetMs: i * 43 }));
  const config = {
    recorded: { spin: { hands: 1, template: keyframes[0].template, dynamic: true, law: null,
      keyframeData: keyframes } },
    gestureTuning: { matchThreshold: 0.28, rotationTolerance: 20 },
  };
  const input = new I.GestureInput(config);
  let now = 1000;
  for (let i = 0; i < 14; i += 1, now += 43) input.update([traj[i]], now, config);
  input.update([], now + 200, config);
  assert.match(input.lastProbe()[0].why, /还在等/,
    `手离开时没说序列还在等：${input.lastProbe()[0].why}`);
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
