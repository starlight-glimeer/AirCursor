// mood.js：从封面像素推氛围。纯数学，不需要浏览器。
//
//   node test/mood.test.js
//
// 这些断言测的是"方向对不对"（红比蓝暖、高对比比平的有劲），不是"数值等于多少" ——
// 具体数值是待标定的常数，真机看了效果才知道该调哪边。钉死数值会让每次调参都
// 变成改测试。
const assert = require('node:assert');
require('../src/mood.js');
const M = globalThis.GestureWallMood;

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

// 造一张纯色图的像素数组
function solid(r, g, b, count = 64) {
  const data = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i += 1) {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
  }
  return data;
}

// 造一张两色相间的图（用来制造对比度）
function checker(c1, c2, count = 64) {
  const data = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i += 1) {
    const c = i % 2 === 0 ? c1 : c2;
    data[i * 4] = c[0]; data[i * 4 + 1] = c[1]; data[i * 4 + 2] = c[2]; data[i * 4 + 3] = 255;
  }
  return data;
}

console.log('\nmood.js');

check('空输入返回 null，不抛', () => {
  assert.strictEqual(M.analyzePixels(null), null);
  assert.strictEqual(M.analyzePixels(new Uint8ClampedArray(0)), null);
});

check('纯灰：无饱和、无对比、氛围低', () => {
  const m = M.analyzePixels(solid(128, 128, 128));
  assert.ok(m.sat < 0.01, `灰色不该有饱和度 (${m.sat})`);
  assert.ok(m.contrast < 0.01, `纯色不该有对比度 (${m.contrast})`);
  assert.ok(m.mood < 0.3, `灰色氛围该低 (${m.mood})`);
});

check('纯灰的染色是中性（不偏色）', () => {
  const m = M.analyzePixels(solid(128, 128, 128));
  for (const k of ['r', 'g', 'b']) {
    assert.ok(Math.abs(m.tint[k] - 1) < 0.01, `${k} 偏了 (${m.tint[k]})`);
  }
});

check('高饱和比低饱和氛围高', () => {
  const vivid = M.analyzePixels(solid(255, 40, 0));
  const dull = M.analyzePixels(solid(150, 140, 135));
  assert.ok(vivid.mood > dull.mood, `${vivid.mood} 应该 > ${dull.mood}`);
});

check('高对比比平坦氛围高', () => {
  const busy = M.analyzePixels(checker([250, 250, 250], [5, 5, 5]));
  const flat = M.analyzePixels(solid(128, 128, 128));
  assert.ok(busy.contrast > flat.contrast, '对比度没算出来');
  assert.ok(busy.mood > flat.mood, `${busy.mood} 应该 > ${flat.mood}`);
});

check('暖色比冷色氛围高（同饱和同亮度）', () => {
  const warm = M.analyzePixels(solid(220, 60, 40));
  const cool = M.analyzePixels(solid(40, 60, 220));
  assert.ok(warm.warmth > 0, `暖色 warmth 该为正 (${warm.warmth})`);
  assert.ok(cool.warmth < 0, `冷色 warmth 该为负 (${cool.warmth})`);
  assert.ok(warm.mood > cool.mood, `${warm.mood} 应该 > ${cool.mood}`);
});

check('氛围永远在 0..1', () => {
  const samples = [
    solid(0, 0, 0), solid(255, 255, 255), solid(255, 0, 0),
    checker([255, 255, 0], [0, 0, 255]), solid(1, 254, 3),
  ];
  for (const data of samples) {
    const m = M.analyzePixels(data);
    assert.ok(m.mood >= 0 && m.mood <= 1, `越界 ${m.mood}`);
  }
});

// 染色必须提亮而不是压暗：一个会让整幅壁纸变暗的染色，在每张深色封面下都像 bug。
check('染色是提亮不是压暗（三通道均值≈1）', () => {
  for (const data of [solid(200, 40, 30), solid(20, 20, 90), solid(10, 90, 10)]) {
    const m = M.analyzePixels(data);
    const mean = (m.tint.r + m.tint.g + m.tint.b) / 3;
    assert.ok(Math.abs(mean - 1) < 0.02, `均值偏离 1 (${mean})`);
  }
});

check('染色方向跟随主色', () => {
  const red = M.analyzePixels(solid(220, 40, 40));
  assert.ok(red.tint.r > red.tint.g && red.tint.r > red.tint.b, '红色封面染色没偏红');
  const blue = M.analyzePixels(solid(40, 40, 220));
  assert.ok(blue.tint.b > blue.tint.r, '蓝色封面染色没偏蓝');
});

check('纯黑不产生 NaN', () => {
  const m = M.analyzePixels(solid(0, 0, 0));
  for (const v of [m.mood, m.sat, m.lum, m.contrast, m.warmth, m.tint.r, m.tint.g, m.tint.b]) {
    assert.ok(Number.isFinite(v), `出现 NaN/Inf: ${v}`);
  }
});

check('influence=0 时染色完全中性', () => {
  const m = M.analyzePixels(solid(230, 30, 30));
  const t = M.blendTint(m.tint, 0);
  assert.deepStrictEqual(t, { r: 1, g: 1, b: 1 });
});

check('influence=1 时染色原样透过', () => {
  const m = M.analyzePixels(solid(230, 30, 30));
  const t = M.blendTint(m.tint, 1);
  assert.ok(Math.abs(t.r - m.tint.r) < 1e-9);
});

check('influence 单调：越大越偏色', () => {
  const m = M.analyzePixels(solid(230, 30, 30));
  const weak = M.blendTint(m.tint, 0.25);
  const strong = M.blendTint(m.tint, 0.9);
  assert.ok(strong.r > weak.r, '强染色没有更偏');
});

// 氛围 0 若映射到亮度 0，画面会暗到看不清主体 —— 而那从来不是"这首歌很安静"
// 该有的表现。
check('亮度范围不会把画面压到全黑', () => {
  assert.ok(M.moodToBrightnessRange(0) >= 0.2, '氛围 0 时太暗');
  assert.ok(M.moodToBrightnessRange(1) <= 1.0);
  assert.ok(M.moodToBrightnessRange(1) > M.moodToBrightnessRange(0), '不单调');
});

check('中性值在合理区间', () => {
  assert.ok(M.NEUTRAL > 0.1 && M.NEUTRAL < 0.6, `中性值可疑 (${M.NEUTRAL})`);
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
