// 配方（防同质化）的测试。
//
//   node test/recipe.test.js
//
// ⚠️⚠️ **这个文件守的是"每次生成不一样"**。用户 2026-08-02：
//   「我主要是不希望同质化很严重，同一种风格的是允许的，但是每次生成
//     给人感觉说这不是一样的吗，这就不行」
//
// ⚠️ 而**光在提示词里写"请多样化"不管用** —— LLM 有很强的默认偏好。
//   实测（6 张连续生成，200 次采样）：
//     纯随机   最坏撞 4 维、平均最坏 1.38 维
//     避重版   最坏撞 0 维
//   ⟹ 撞 4 维 = 布局+音频映射+配色+运动全一样 = "这不是一样的吗"。

const assert = require('node:assert');
const path = require('node:path');
const R = require(path.join(__dirname, '..', 'src', 'wallpaper-recipe.js'));

let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1; }
}

console.log('\n配方（防同质化）');

const KEYS = Object.keys(R.DIMENSIONS);

check('五个维度，每个至少 6 项（组合空间要够大）', () => {
  assert.ok(KEYS.length >= 5, `只有 ${KEYS.length} 个维度`);
  let total = 1;
  for (const k of KEYS) {
    assert.ok(R.DIMENSIONS[k].length >= 6,
      `${k} 只有 ${R.DIMENSIONS[k].length} 项 ⟹ 连续生成几张必然撞`);
    total *= R.DIMENSIONS[k].length;
  }
  // ⚠️ 组合空间要远大于"用户会生成的张数" —— 否则避重会无路可走
  assert.ok(total > 5000, `组合空间只有 ${total} ⟹ 太小`);
});

check('⚠️⚠️ 每一项都有"怎么做"的说明，不是只有形容词', () => {
  // ⚠️ 判据：写"梦幻的"这种等于没约束 —— 模型会把它翻译成它偏爱的那一种。
  //   ⟹ 每项的说明必须落到具体做法上（有冒号 + 一句实现描述）。
  for (const k of KEYS) {
    for (const [id, desc] of R.DIMENSIONS[k]) {
      assert.ok(desc && desc.length >= 12,
        `${k}.${id} 的说明太短（"${desc}"）⟹ 模型会按自己的默认理解做`);
      // ⚠️⚠️⚠️ 这条断言我改了**两次**都在正确数据上报红：
      //   第一版只认冒号 ⟹ audioMap 用 `→` 的那六项报红
      //   第二版加了箭头和括号数字 ⟹ motion.drift（"整体沿一个方向匀速漂移，
      //     到边界循环回来"）还是报红 —— 而它**已经很具体了**
      //
      //   ⟹ 判据：**我在用"格式"代理"具体不具体"，而那个代理是错的。**
      //     具体与否是语义，没法用标点判。
      //   ⟹ 改成守**真正能机器判的那件事**：说明够长、而且**不是纯形容词**
      //     （黑名单几个空词）。剩下的靠人读。
      assert.ok(desc.length >= 12,
        `${k}.${id} 的说明太短（"${desc}"）`);
      const EMPTY = ['梦幻', '炫酷', '好看', '高级感', '有质感', '很美'];
      const bad = EMPTY.filter((w) => desc.includes(w));
      assert.deepStrictEqual(bad, [],
        `${k}.${id} 的说明里有空词（${bad.join('/')}）`
        + ' ⟹ 那种词模型会翻译成它偏爱的那一种，等于没约束');
    }
  }
});

// ---------------------------------------------------------------------------
// ⚠️⚠️⚠️ 核心：避重真的有效吗
// ---------------------------------------------------------------------------
check('连续 6 张：任意两张撞 0 维', () => {
  const hist = [];
  for (let i = 0; i < 6; i += 1) {
    const r = R.pickRecipe(hist);
    for (const prev of hist) {
      const c = R.collide(prev, r);
      assert.strictEqual(c.length, 0,
        `第 ${i + 1} 张和之前某张撞了 ${c.length} 维（${c.join(',')}）`);
    }
    hist.push(r);
  }
});

check('⚠️ 而纯随机会撞 —— 那证明避重不是运气', () => {
  // ⚠️ 判据：**对照组**。没有它的话"撞 0 维"可能只是这次运气好。
  const keys = KEYS;
  let worst = 0;
  for (let t = 0; t < 300; t += 1) {
    const hist = [];
    for (let i = 0; i < 6; i += 1) {
      const r = Object.fromEntries(keys.map((k) => {
        const opts = R.DIMENSIONS[k];
        return [k, opts[Math.floor(Math.random() * opts.length)][0]];
      }));
      for (const prev of hist) worst = Math.max(worst, R.collide(prev, r).length);
      hist.push(r);
    }
  }
  assert.ok(worst >= 3,
    `纯随机 300 组里最坏只撞 ${worst} 维 —— 那说明这个对照组没意义`
    + '（组合空间可能太大了，或者 collide 算错了）');
});

check('挑出来的每一项都是合法选项（不会编出不存在的）', () => {
  for (let i = 0; i < 20; i += 1) {
    const r = R.pickRecipe([]);
    for (const k of KEYS) {
      const ok = R.DIMENSIONS[k].some(([id]) => id === r[k]);
      assert.ok(ok, `${k}=${r[k]} 不在选项里`);
    }
  }
});

check('历史里有脏数据（缺字段/null）也不崩', () => {
  // ⚠️ 历史是从磁盘上的 project.json 读的 ⟹ 可能是任何东西
  const dirty = [null, {}, { layout: 'ring' }, { layout: null, palette: 'ice' },
    { layout: '不存在的选项' }];
  assert.doesNotThrow(() => R.pickRecipe(dirty));
  const r = R.pickRecipe(dirty);
  for (const k of KEYS) assert.ok(r[k], `脏历史下 ${k} 没挑出来`);
});

check('describeRecipe / describeHistory 输出可读的文字（要喂给模型）', () => {
  const r = R.pickRecipe([]);
  const text = R.describeRecipe(r);
  for (const k of KEYS) {
    assert.ok(text.includes(k), `describeRecipe 里没有 ${k}`);
    assert.ok(text.includes(r[k]), `describeRecipe 里没有挑中的 ${r[k]}`);
  }
  // ⚠️ 空历史要说清"这是第一张" —— 不能给模型一段空白
  assert.match(R.describeHistory([]), /第一张|没有历史/);
  assert.ok(R.describeHistory([r]).includes(r.layout), '历史里没列出配方');
});

check('collide 能定位撞了哪几维（用户说"这两张像"时要能查）', () => {
  const a = { layout: 'ring', audioMap: 'height', palette: 'ice', motion: 'breathe', environment: 'topLight' };
  const b = { ...a, palette: 'ember', motion: 'drift' };
  assert.deepStrictEqual(R.collide(a, b).sort(),
    ['audioMap', 'environment', 'layout'].sort());
});

// ---------------------------------------------------------------------------
// ⚠️ 环境这一维尤其重要（0.9.138 我把它锁死了 ⟹ 每张都"深蓝黑底 + 一个顶光"）
// ---------------------------------------------------------------------------
check('有 environment 这一维，而且它管底色/雾/打光', () => {
  assert.ok(R.DIMENSIONS.environment,
    '没有 environment 维度 ⟹ 每张壁纸的底色和打光都一样，那是"第一眼"就看出的雷同');
  const all = R.DIMENSIONS.environment.map(([, d]) => d).join(' ');
  for (const word of ['雾', '光']) {
    assert.ok(all.includes(word), `environment 的选项里没提到"${word}"`);
  }
});

check('palette 给的是具体色值范围，不是颜色名', () => {
  // ⚠️ 写"冰蓝色"模型会用它偏爱的那个蓝；给 H 范围它才会真的变
  const withNumbers = R.DIMENSIONS.palette.filter(([, d]) => /\d/.test(d));
  assert.ok(withNumbers.length >= R.DIMENSIONS.palette.length - 1,
    `只有 ${withNumbers.length}/${R.DIMENSIONS.palette.length} 个配色给了具体数值`
    + ' ⟹ 没数值的那些模型会按自己的偏好来');
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
