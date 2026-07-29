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

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
