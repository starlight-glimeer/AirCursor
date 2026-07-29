// recorder.js：手势录制状态机。纯逻辑，不需要摄像头。
//
//   node test/recorder.test.js
//
// 这批用例守的是那些**只有真机才会发现**的行为 —— 它们是从 AirCursor 搬过来的，每一条
// 背后都有一次踩坑。重写录制流程一定会重新踩，所以这里把它们钉住。
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const vendor = path.join(__dirname, '..', 'src', 'vendor', 'aircursor');
if (!fs.existsSync(path.join(vendor, 'pose.js'))) {
  console.error('\n❌ 缺 src/vendor/aircursor/ —— 先跑 npm run vendor\n');
  process.exit(1);
}
require(path.join(vendor, 'pose.js'));
require(path.join(vendor, 'motion.js'));
require('../src/recorder.js');
const R = globalThis.GestureWallRecorder;
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

// 像素量级的手（AirCursor 的模块按像素标定）。`spread` 控制指尖张开程度 —— 用形变
// 而不是平移来制造距离变化，因为模板归一化会把平移消掉。
function hand({ cx = 500, spread = 120 } = {}) {
  const lm = [];
  for (let i = 0; i < 21; i += 1) lm.push({ x: cx, y: 500, z: 0 });
  lm[5] = { x: cx - 60, y: 500, z: 0 };
  lm[13] = { x: cx + 11, y: 500, z: 0 };
  lm[17] = { x: cx + 60, y: 500, z: 0 };
  lm[0] = { x: cx, y: 572, z: 0 };
  lm[9] = { x: cx, y: 392, z: 0 };
  lm[4] = { x: cx - spread / 2, y: 500 - spread, z: 0 };
  lm[8] = { x: cx + spread / 2, y: 500 - spread, z: 0 };
  lm[12] = { x: cx, y: 500 - spread * 1.1, z: 0 };
  lm[16] = { x: cx + spread * 0.3, y: 500 - spread * 0.9, z: 0 };
  return lm;
}

const poseOf = (opts) => P.buildPoseTemplate([hand(opts)]);

// 跑一段录制。frameAt(t) 返回 {pose, hands}，null pose 表示这一帧没手。
function run(rec, frameAt, { until = 15000, step = 33 } = {}) {
  const seen = {};
  let final = null;
  for (let t = 0; t <= until; t += step) {
    const frame = frameAt(t);
    const r = rec.update(frame.pose, frame.hands, t);
    if (!r) break;
    seen[r.phase] = (seen[r.phase] || 0) + 1;
    if (r.done || r.error) { final = { ...r, t }; break; }
  }
  return { seen, final };
}

console.log('\nrecorder.js');

check('静态录制：倒计时 → 保持 → 完成', () => {
  const rec = new R.Recorder({ matchThreshold: 0.28 });
  rec.start('yawLeft', { hands: 1, dynamic: false, now: 0 });
  const { seen, final } = run(rec, () => ({ pose: poseOf(), hands: 1 }));
  assert.ok(seen.countdown > 0, '没有倒计时阶段');
  assert.ok(seen.capture > 0, '没有采集阶段');
  assert.ok(final && final.done, `没完成：${JSON.stringify(final)}`);
  assert.ok(final.result.template, '没产出模板');
  assert.strictEqual(final.result.template.hands, 1);
  // 倒计时 2s + 保持 1.2s，所以 3.2s 上下完成；明显更久说明保持判定出问题了。
  assert.ok(final.t > 3000 && final.t < 4200, `耗时异常 ${final.t}ms`);
});

check('动态录制：走完四个阶段并抽出关键帧', () => {
  const rec = new R.Recorder({ matchThreshold: 0.28 });
  rec.start('spin', { hands: 1, dynamic: true, law: null, now: 0 });
  const { seen, final } = run(rec, (t) => {
    // 3.3s 前保持静止，之后指尖张开（做动作），然后停住
    let spread = 120;
    if (t > 3300 && t < 4600) spread = 120 + ((t - 3300) / 1300) * 260;
    else if (t >= 4600) spread = 380;
    return { pose: poseOf({ spread }), hands: 1 };
  });
  for (const phase of ['countdown', 'capture', 'ready', 'move']) {
    assert.ok(seen[phase] > 0, `缺少 ${phase} 阶段`);
  }
  assert.ok(final && final.done, `没完成：${JSON.stringify(final)}`);
  assert.ok(final.result.keyframes.length >= 3, `关键帧只有 ${final.result.keyframes?.length}`);
  assert.ok(final.result.trigger > 0, '没算出触发门');
});

// 录单手手势时 MediaPipe 在某些角度会间歇报出第二只手。把那当成"手数不对"会让每次
// 闪动都清空采集，用户永远录不完 —— AirCursor 真机踩过。
check('手多了不打断采集（tracker 抖动不是用户错）', () => {
  const rec = new R.Recorder({ matchThreshold: 0.28 });
  rec.start('yawLeft', { hands: 1, dynamic: false, now: 0 });
  const { final } = run(rec, (t) => ({
    pose: poseOf(),
    // 每隔几帧假装看到两只手
    hands: t % 200 < 33 ? 2 : 1,
  }));
  assert.ok(final && final.done, '手多了导致录制失败 —— 这条回归了');
});

check('手不够会重置进度', () => {
  const rec = new R.Recorder({ matchThreshold: 0.28 });
  rec.start('zoom2', { hands: 2, dynamic: false, now: 0 });
  let sawReset = false;
  for (let t = 0; t <= 6000; t += 33) {
    const r = rec.update(poseOf(), 1, t);   // 只有一只手，但要求两只
    if (r && r.phase === 'capture' && /需要 2 只手/.test(r.hint || '')) sawReset = true;
  }
  assert.ok(sawReset, '手不够时没有提示');
});

check('没有手时提示明确', () => {
  const rec = new R.Recorder({ matchThreshold: 0.28 });
  rec.start('yawLeft', { hands: 1, dynamic: false, now: 0 });
  let hint = null;
  for (let t = 0; t <= 3000; t += 33) {
    const r = rec.update(null, 0, t);
    if (r && r.phase === 'capture') hint = r.hint;
  }
  assert.match(hint || '', /没有检测到手/);
});

// 漂移相对"开窗那一帧"测，不是相对上一帧 —— 否则缓慢爬行的手能一帧一帧积累到很远。
check('缓慢漂移会被逮住并重置', () => {
  const rec = new R.Recorder({ matchThreshold: 0.28 });
  rec.start('yawLeft', { hands: 1, dynamic: false, now: 0 });
  let sawDrift = false;
  let done = false;
  for (let t = 0; t <= 8000 && !done; t += 33) {
    // 每帧都极缓慢地变形：相对上一帧几乎为 0，但累积起来很远
    const r = rec.update(poseOf({ spread: 120 + t * 0.05 }), 1, t);
    if (!r) break;
    if (/保持不动/.test(r.hint || '') && r.progress === 0) sawDrift = true;
    if (r.done) done = true;
  }
  assert.ok(sawDrift, '缓慢漂移没被逮住 —— 参考帧可能取错了');
});

// 保持完成到开始录动作之间要给一拍：上一版一保持完就开始录，手从静止姿势移到动作
// 起点的那段路被当成动作的一部分。
check('动态录制在保持后有一拍缓冲', () => {
  const rec = new R.Recorder({ matchThreshold: 0.28 });
  rec.start('spin', { hands: 1, dynamic: true, law: null, now: 0 });
  let readyFrames = 0;
  for (let t = 0; t <= 4000; t += 33) {
    const r = rec.update(poseOf(), 1, t);
    if (r && r.phase === 'ready') readyFrames += 1;
    if (r && (r.done || r.error)) break;
  }
  assert.ok(readyFrames > 0, '没有 ready 阶段 —— 缓冲被去掉了');
});

check('手一动就跳过缓冲，不用等满', () => {
  const rec = new R.Recorder({ matchThreshold: 0.28 });
  rec.start('spin', { hands: 1, dynamic: true, law: null, now: 0 });
  let readyEndedAt = null;
  let readyStartedAt = null;
  for (let t = 0; t <= 6000; t += 33) {
    // 保持完成后立刻大幅动作
    const spread = t > 3300 ? 380 : 120;
    const r = rec.update(poseOf({ spread }), 1, t);
    if (!r) break;
    if (r.phase === 'ready' && readyStartedAt === null) readyStartedAt = t;
    if (r.phase === 'move' && readyStartedAt !== null && readyEndedAt === null) readyEndedAt = t;
    if (r.done || r.error) break;
  }
  assert.ok(readyEndedAt !== null, '没进入动作阶段');
  const waited = readyEndedAt - readyStartedAt;
  assert.ok(waited < R.MOVE_READY_MS, `等了 ${waited}ms，没有提前跳过缓冲`);
});

check('幅度太小的动作被拒绝，并说明原因', () => {
  const rec = new R.Recorder({ matchThreshold: 0.28 });
  rec.start('spin', { hands: 1, dynamic: true, law: null, now: 0 });
  const { final } = run(rec, (t) => ({
    // 保持完成后只做极小的动作
    pose: poseOf({ spread: t > 3300 ? 128 : 120 }),
    hands: 1,
  }));
  assert.ok(final && final.error, '幅度太小却通过了');
  assert.match(final.error, /幅度/);
});

check('采集阶段超时会失败并给出原因', () => {
  const rec = new R.Recorder({ matchThreshold: 0.28 });
  rec.start('yawLeft', { hands: 1, dynamic: false, now: 0 });
  // 从不给出稳定姿势
  let error = null;
  for (let t = 0; t <= 20000; t += 33) {
    const r = rec.update(poseOf({ spread: 120 + (t % 400) }), 1, t);
    if (r && r.error) { error = r.error; break; }
  }
  assert.match(error || '', /超时/);
});

check('cancel 之后 update 返回 null', () => {
  const rec = new R.Recorder({});
  rec.start('yawLeft', { now: 0 });
  assert.strictEqual(rec.active, true);
  rec.cancel();
  assert.strictEqual(rec.active, false);
  assert.strictEqual(rec.update(poseOf(), 1, 100), null);
});

console.log('\n  冲突检测');

// 两个姿势太近不是两个手势：实时姿势会去离它更近的那个，用户得到的是另一个动作，
// 而这个看起来就是坏的。
check('太近的两个手势被判冲突', () => {
  const a = poseOf({ spread: 120 });
  const b = poseOf({ spread: 122 });
  const hit = R.conflictingAction('spin', a, { yawLeft: { template: b } }, 0.28, 0);
  assert.ok(hit, '几乎相同的姿势没被判冲突');
  assert.strictEqual(hit.action, 'yawLeft');
});

check('明显不同的两个手势不算冲突', () => {
  const a = poseOf({ spread: 120 });
  const b = poseOf({ spread: 420 });
  assert.strictEqual(R.conflictingAction('spin', a, { yawLeft: { template: b } }, 0.28, 0), null);
});

check('不和自己比冲突', () => {
  const a = poseOf({ spread: 120 });
  assert.strictEqual(R.conflictingAction('spin', a, { spin: { template: a } }, 0.28, 0), null);
});

// ── 保持不动:用真机噪声,而不是合成手 ──────────────────────────────────────
//
// 上面所有用例喂的是合成手,而合成手造不出决定这件事成败的那个东西:**尖峰**。
// 真机 capture 实测(只取手腕帧间移动<0.05掌宽、即手确实没动的 21 个帧对):
// 形状距离中位 0.058,看着离门很远 —— 但 90 分位 0.180、最大 0.222。丢跟踪后重新
// 检出会跳,而"1200ms 内每一帧都不越线"= ~28 帧连续,单帧越线率 47% ⟹ 全过概率 0%。
//
// 用户症状:「录制的时候卡在请保持不动,我都没有动」。0 次成功,不是"偶尔失败"。
//
// 夹具是真机 landmark 提炼的:基准姿势 + 帧间噪声序列 + 丢帧模式,回放时把噪声叠到
// 一个**完全静止**的基准姿势上。这样"用户确实没动"是构造出来的事实,而噪声的时间
// 相关结构(自相关 0.303)和尖峰来自真手。
const NOISE = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'real-landmark-noise.json'), 'utf8'));

const S = 1000;
const basePose = NOISE.basePose.map(([x, y, z]) => ({ x: x * S, y: y * S, z: z * S }));

// 第 seed 次试验的第 i 帧。shape 可选:改变手形(用来构造"手真的动了")。
function noisyFrame(i, seed, shape) {
  const n = NOISE.frameNoise[(i * 7 + seed) % NOISE.frameNoise.length];
  const src = shape ? shape(basePose, i) : basePose;
  return src.map((p, k) => ({
    x: p.x + n[k][0] * S, y: p.y + n[k][1] * S, z: p.z + n[k][2] * S,
  }));
}

// 跑一次完整的"保持不动",返回是否录成。dt/丢帧模式都来自真机。
function runHold(seed, { frames = 200, shape = null } = {}) {
  const rec = new R.Recorder({ matchThreshold: 0.28, rotationTolerance: (20 * Math.PI) / 180 });
  rec.start('click', { hands: 1, dynamic: false, law: null, now: 0 });
  for (let i = 0; i < frames; i += 1) {
    const now = (i + 1) * NOISE.dtMs + 2000;   // +2000 跳过倒计时
    // 丢帧照真机的模式来 —— 这是最常见的尖峰来源,101/118 帧有手,最长丢 726ms。
    if (!NOISE.handPresent[(i + seed) % NOISE.handPresent.length]) {
      const out = rec.update(null, 0, now);
      if (out && out.done) return { ok: true, at: now - 2000 };
      if (out && out.error) return { ok: false, error: out.error };
      continue;
    }
    const out = rec.update(P.buildPoseTemplate([noisyFrame(i, seed, shape)]), 1, now);
    if (out && out.done) return { ok: true, at: now - 2000 };
    if (out && out.error) return { ok: false, error: out.error };
  }
  return { ok: false, error: '没收尾' };
}

check('真机噪声下"保持不动"能录成(修复前是 0/40)', () => {
  let ok = 0;
  const times = [];
  for (let seed = 0; seed < 40; seed += 1) { const r = runHold(seed); if (r.ok) { ok += 1; times.push(r.at); } }
  times.sort((a, b) => a - b);
  if (process.env.VERBOSE) console.log(`      成功 ${ok}/40, 耗时中位 ${times[times.length >> 1]}ms 最长 ${times[times.length - 1]}ms`);
  // 门槛定在 90%:低于这个用户就会遇到"要试好几次",而那和"不能用"体感上没差别。
  assert.ok(ok >= 36, `40 次里只成功 ${ok} 次 —— 真机上就是"一直说请保持不动"`);
});

check('手形持续变化时不能录成(否则门就是假的)', () => {
  // ⚠️ 反向夹具踩过三次,每次都是"看着在动其实没在动":
  //   ① 纯平移 —— 模板按手腕归一化,平移 2000px 距离仍是 0.0000
  //   ② curl=min(1,i/25) —— 第 25 帧到底,之后 175 帧是完全静止的手
  //   ③ 只改一个点 —— 63 维 RMS 会摊平
  // 有效的反向夹具必须**全程**改变手形,所以用往复。
  const curl = (base, i) => {
    const c = (1 - Math.cos((i / 25) * Math.PI)) / 2;
    return base.map((p, k) => {
      if (k < 5) return p;
      const w = [8, 12, 16, 20].includes(k) ? 1
        : [7, 11, 15, 19].includes(k) ? 0.6 : 0.25;
      return { x: p.x + (base[0].x - p.x) * c * w * 0.9,
               y: p.y + (base[0].y - p.y) * c * w * 0.9, z: p.z };
    });
  };
  for (let seed = 0; seed < 6; seed += 1) {
    const r = runHold(seed, { shape: curl });
    assert.ok(!r.ok, `手形一直在变却录成了(seed ${seed}) —— 门太松,任何动作都会被当成静止`);
  }
});

check('短暂丢帧不清空进度,长时间丢手才重来', () => {
  const rec = new R.Recorder({ matchThreshold: 0.28, rotationTolerance: 0 });
  rec.start('click', { hands: 1, dynamic: false, law: null, now: 0 });
  // 先攒够一点进度
  let out = null;
  for (let i = 0; i < 10; i += 1) out = rec.update(P.buildPoseTemplate([basePose]), 1, 2000 + i * 43);
  const before = out.progress;
  assert.ok(before > 0, '没有攒到进度,后面的比较没意义');
  // 丢 3 帧(~129ms,宽限内):进度必须继续涨,不能归零
  for (let i = 0; i < 3; i += 1) out = rec.update(null, 0, 2500 + i * 43);
  assert.ok(out.progress >= before, `丢 3 帧就把进度清了(${before} → ${out.progress})`);
  // 丢够 400ms(超宽限):这才是真的把手拿走了
  for (let i = 0; i < 12; i += 1) out = rec.update(null, 0, 2700 + i * 43);
  assert.strictEqual(out.progress, 0, '手拿走 400ms 之后仍然在计时 —— 那门就没意义了');
});

check('保持判定和匹配用同一个旋转容忍', () => {
  // 不传第三个参数等于 rotationTolerance=0,即"手腕角度一点都不许变",而匹配时容忍
  // 20° ⟹ 两个判据对同一只手给出不同答案。源码里查,因为这是一个**漏参数**的错,
  // 行为上只表现为"更严格一点",测不出来。
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'recorder.js'), 'utf8');
  const line = src.split('\n').find((l) => l.includes('Pose.templateDistance(pose, s.reference'));
  assert.ok(line, '找不到漂移判定那一行 —— 被改写了');
  assert.match(line, /this\.rotationTolerance/,
    '漂移判定没传 rotationTolerance ⟹ 保持时容忍 0°、匹配时容忍 20°,两个判据不一致');
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
