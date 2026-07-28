// gestures.js：关键点 → 手势判定。纯逻辑，不需要摄像头。
//
//   node test/gestures.test.js
//
// ⚠️ 这里的"手"是合成的（几个点摆成规则形状），所以它证的是**判定逻辑和常数关系**，
// 不是"真手能不能被认出来"。真手的抖动、丢帧、时间相关噪声都不在这里 —— 那些只能
// 真机看。AirCursor 那边正好在这上面栽过：合成夹具用纯平移，而模板归一化会消掉平移，
// 结论就落在了不敏感维度上。
const assert = require('node:assert');
require('../src/gestures.js');
const G = globalThis.GestureWallGestures;

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

// 造一只手：21 个点。5 和 17 号决定掌宽，4（拇指尖）和 8（食指尖）决定捏合。
// centerX/Y 是掌心位置，palm 是掌宽，pinchGap 是拇指食指间距（掌宽的倍数）。
//
// ⚠️ 5 和 17 必须**同一个 y**：`palmWidth` 取的是两点的欧氏距离，给它们加 y 偏移
// 会让实际掌宽大于 palm。第一版夹具就是这么错的，然后我差点去改源码 —— 夹具的 bug
// 长得和代码的 bug 一模一样。
function hand({ centerX = 0.5, centerY = 0.5, palm = 0.1, pinchGap = 1.0 } = {}) {
  const lm = [];
  for (let i = 0; i < 21; i += 1) lm.push({ x: centerX, y: centerY, z: 0 });

  // 指根一线（y 相同），所以 |5-17| 恰好等于 palm
  lm[5] = { x: centerX - palm / 2, y: centerY, z: 0 };
  lm[9] = { x: centerX, y: centerY, z: 0 };
  lm[13] = { x: centerX + palm * 0.18, y: centerY, z: 0 };
  lm[17] = { x: centerX + palm / 2, y: centerY, z: 0 };
  // 手腕在下方
  lm[0] = { x: centerX, y: centerY + palm * 0.6, z: 0 };

  // 把掌心五点的均值平移回 centerX/Y，这样 palmCenter 有确定值可断言
  const ids = [0, 5, 9, 13, 17];
  const cx = ids.reduce((s, i) => s + lm[i].x, 0) / 5;
  const cy = ids.reduce((s, i) => s + lm[i].y, 0) / 5;
  for (const id of ids) {
    lm[id].x += centerX - cx;
    lm[id].y += centerY - cy;
  }

  // 拇指尖和食指尖：间距 = pinchGap × 掌宽（同 y，所以距离就是 gap）
  const gap = palm * pinchGap;
  lm[4] = { x: centerX - gap / 2, y: centerY - palm, z: 0 };
  lm[8] = { x: centerX + gap / 2, y: centerY - palm, z: 0 };
  return lm;
}

console.log('\ngestures.js');

check('掌宽取 5→17，与姿势无关', () => {
  const a = hand({ palm: 0.1 });
  assert.ok(Math.abs(G.palmWidth(a) - 0.1) < 1e-6, `掌宽算错 (${G.palmWidth(a)})`);
  // 换个捏合程度，掌宽不该变
  const b = hand({ palm: 0.1, pinchGap: 0.1 });
  assert.ok(Math.abs(G.palmWidth(b) - G.palmWidth(a)) < 1e-9, '捏合影响了掌宽');
});

check('掌心是五个点的均值', () => {
  const c = G.palmCenter(hand({ centerX: 0.3, centerY: 0.7, palm: 0.12 }));
  assert.ok(Math.abs(c.x - 0.3) < 1e-6, `x 偏了 (${c.x})`);
  assert.ok(Math.abs(c.y - 0.7) < 1e-6, `y 偏了 (${c.y})`);
});

// 捏合阈值按掌宽的比例，所以离摄像头远近不影响判定 —— 这是关键性质。
check('捏合判定与离摄像头远近无关', () => {
  for (const palm of [0.05, 0.1, 0.25]) {
    assert.strictEqual(G.isPinched(hand({ palm, pinchGap: 0.2 })), true, `palm=${palm} 该判捏合`);
    assert.strictEqual(G.isPinched(hand({ palm, pinchGap: 1.2 })), false, `palm=${palm} 不该判捏合`);
  }
});

check('镜像把左右翻过来，y 不动', () => {
  const m = G.mirror([{ x: 0.2, y: 0.7, z: 0.1 }]);
  assert.strictEqual(m[0].x, 0.8);
  assert.strictEqual(m[0].y, 0.7);
});

// 产品的核心手势：两手捏合，**拉开 = 放大**。方向搞反过一次，所以这条要钉死。
check('双手拉开 → zoom 变大（不是变小）', () => {
  const close = G.twoHandZoom([
    hand({ centerX: 0.45, palm: 0.1, pinchGap: 0.2 }),
    hand({ centerX: 0.55, palm: 0.1, pinchGap: 0.2 }),
  ]);
  const far = G.twoHandZoom([
    hand({ centerX: 0.2, palm: 0.1, pinchGap: 0.2 }),
    hand({ centerX: 0.8, palm: 0.1, pinchGap: 0.2 }),
  ]);
  assert.ok(close && far, '双手捏合没被识别');
  assert.ok(far.value > close.value,
    `拉开该更大：合拢 ${close.value.toFixed(3)} vs 拉开 ${far.value.toFixed(3)}`);
});

check('只有一只手捏住时不出 zoom', () => {
  assert.strictEqual(G.twoHandZoom([
    hand({ centerX: 0.3, pinchGap: 0.2 }),
    hand({ centerX: 0.7, pinchGap: 1.5 }),
  ]), null);
});

// null 而不是 0：0 是合法的"最小缩放"，而"手势不成立"必须是另一个值。哨兵值撞进
// 合法取值域是 AirCursor 踩过的坑（角度 0 既是"指向右"又是"没有轴"）。
check('手势不成立时返回 null 而不是 0', () => {
  assert.strictEqual(G.twoHandZoom([hand()]), null, '单手该返回 null');
  assert.strictEqual(G.twoHandZoom([]), null);
  assert.strictEqual(G.twoHandZoom(null), null);
});

check('zoom 值被夹在 0..1', () => {
  const tooClose = G.twoHandZoom([
    hand({ centerX: 0.5, palm: 0.1, pinchGap: 0.2 }),
    hand({ centerX: 0.5, palm: 0.1, pinchGap: 0.2 }),
  ]);
  assert.strictEqual(tooClose.value, 0, '贴在一起该夹到 0');
  const tooFar = G.twoHandZoom([
    hand({ centerX: 0.0, palm: 0.05, pinchGap: 0.2 }),
    hand({ centerX: 1.0, palm: 0.05, pinchGap: 0.2 }),
  ]);
  assert.strictEqual(tooFar.value, 1, '拉太开该夹到 1');
});

// 间距按掌宽归一：同样的"两手拉开多少"，人离摄像头远近不该改变 zoom 值。
check('zoom 与人离摄像头的距离无关', () => {
  // 近：掌宽大，间距也按比例大
  const near = G.twoHandZoom([
    hand({ centerX: 0.35, palm: 0.16, pinchGap: 0.2 }),
    hand({ centerX: 0.65, palm: 0.16, pinchGap: 0.2 }),
  ]);
  // 远：掌宽小，间距也按比例小 —— 相同的"几个掌宽"
  const far = G.twoHandZoom([
    hand({ centerX: 0.425, palm: 0.08, pinchGap: 0.2 }),
    hand({ centerX: 0.575, palm: 0.08, pinchGap: 0.2 }),
  ]);
  assert.ok(Math.abs(near.value - far.value) < 0.02,
    `远近不一致：${near.value.toFixed(3)} vs ${far.value.toFixed(3)}`);
});

console.log('\n  轨迹与挥动');

check('样本不足时没有位移', () => {
  const p = new G.WristPath();
  assert.strictEqual(p.displacement(), null);
  p.push(0.5, 0.5, 0.1, 0);
  assert.strictEqual(p.displacement(), null, '一个样本不该出位移');
});

check('窗口外的旧样本被丢掉', () => {
  const p = new G.WristPath(220);
  p.push(0.1, 0.5, 0.1, 0);
  p.push(0.2, 0.5, 0.1, 100);
  p.push(0.9, 0.5, 0.1, 500);   // 这时 0ms 那个已经超窗
  assert.ok(p.samples[0].t >= 100, '旧样本没被清掉');
});

check('速度按掌宽归一（远近一致）', () => {
  const near = new G.WristPath();
  near.push(0.3, 0.5, 0.2, 0);
  near.push(0.7, 0.5, 0.2, 100);      // 0.4 屏幕单位 / 0.2 掌宽 = 2 掌宽
  const far = new G.WristPath();
  far.push(0.4, 0.5, 0.1, 0);
  far.push(0.6, 0.5, 0.1, 100);       // 0.2 屏幕单位 / 0.1 掌宽 = 2 掌宽
  assert.ok(Math.abs(near.displacement().speed - far.displacement().speed) < 1e-6,
    '归一化没生效');
});

check('快速横挥能触发，方向正确', () => {
  const p = new G.WristPath();
  const f = new G.FlickDetector();
  p.push(0.3, 0.5, 0.1, 0);
  p.push(0.8, 0.5, 0.1, 100);         // 5 掌宽 / 0.1s = 50 掌宽/秒
  assert.strictEqual(f.update(p.displacement(), 100), 'right');
});

check('慢速移动不触发', () => {
  const p = new G.WristPath();
  const f = new G.FlickDetector();
  p.push(0.5, 0.5, 0.1, 0);
  p.push(0.52, 0.5, 0.1, 200);        // 0.2 掌宽 / 0.2s = 1 掌宽/秒
  assert.strictEqual(f.update(p.displacement(), 200), null);
  assert.strictEqual(f.blocked, 'tooSlow');
});

// 斜着扫通常是把手移到别处，不是手势。
check('斜向快速移动不算挥动', () => {
  const p = new G.WristPath();
  const f = new G.FlickDetector();
  p.push(0.3, 0.3, 0.1, 0);
  p.push(0.6, 0.8, 0.1, 100);         // dx 3 掌宽，dy 5 掌宽 —— 更竖
  assert.strictEqual(f.update(p.displacement(), 100), null);
  assert.strictEqual(f.blocked, 'notHorizontal');
});

check('冷却期内不重复触发', () => {
  const p = new G.WristPath();
  const f = new G.FlickDetector();
  p.push(0.3, 0.5, 0.1, 0);
  p.push(0.8, 0.5, 0.1, 100);
  assert.strictEqual(f.update(p.displacement(), 100), 'right');
  assert.strictEqual(f.update(p.displacement(), 300), null, '冷却期内触发了');
  assert.strictEqual(f.blocked, 'cooldown');
  assert.strictEqual(f.update(p.displacement(), 900), 'right', '冷却期后该能再触发');
});

// lastAt 用 null 而不是 0：用 0 的话，时钟起点后的第一个冷却窗口会白吃掉第一次挥动。
check('第一次挥动不会被"从没发生过的冷却"吃掉', () => {
  const p = new G.WristPath();
  const f = new G.FlickDetector();
  assert.strictEqual(f.lastAt, null, 'lastAt 初始值该是 null');
  p.push(0.3, 0.5, 0.1, 0);
  p.push(0.8, 0.5, 0.1, 50);          // now=50，远小于 620ms 冷却
  assert.strictEqual(f.update(p.displacement(), 50), 'right', '第一次挥动被冷却吃掉了');
});

check('阻塞原因总会被写下（不静默）', () => {
  const f = new G.FlickDetector();
  f.update(null, 100);
  assert.strictEqual(f.blocked, 'noPath');
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
