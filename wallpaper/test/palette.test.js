// 配色/亮度曲线的测试。
//
//   node test/palette.test.js
//
// ⚠️⚠️⚠️ 这个文件守的是**"算出来的比猜的准"**。用户 2026-08-03：
//   「不一定就是纯靠 prompt 去驱动 agent，你也可以适当增加一些脚本什么的」
//
// ⚠️ 而它的必要性是**实测出来的**：模型自己推亮度公式时写成了
//   `lum = 0.4*(1-dd)*(1-dd)` 然后又 `lum *= (0.1+0.9*(1-dd))`
//   ⟹ 三次衰减、外圈纯黑、画面高亮占比 **0.0%**。
//   而它自己的注释里写着"根因分析：上一版把 lum 一路乘小" ——
//   **诊断对了，改的时候又犯了一次**。
//   ⟹ 判据：**能用公式算准的，别让模型猜。**

const assert = require('node:assert');
const path = require('node:path');
const P = require(path.join(__dirname, '..', 'src', 'palette.js'));

let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1; }
}

console.log('\n配色与亮度曲线');

check('⚠️⚠️ 亮度单调下降，而且**永不到 0**（那是"一片黑"的根因）', () => {
  let prev = Infinity;
  for (let d = 0; d <= 1.0001; d += 0.05) {
    const l = P.lumAt(d, 0);
    assert.ok(l < prev, `d=${d.toFixed(2)} 的亮度 ${l} 没比上一档低 ⟹ 曲线不单调`);
    // ⚠️⚠️ **下界** —— 外围要"没入底色"，不是"变成纯黑"。
    //   实测那次外圈乘到 0.1 ⟹ 画面高亮 0%、观感是"中间一个尖四周全黑"。
    assert.ok(l >= 0.15,
      `d=${d.toFixed(2)} 的亮度只有 ${l.toFixed(3)} ⟹ 那已经是纯黑了`
      + '（外围该"没入底色"而不是"消失"）');
    prev = l;
  }
});

check('中心足够亮（要能形成视觉焦点）', () => {
  // ⚠️ 目标：高亮像素占 5-20% ⟹ 中心那片得真的亮
  assert.ok(P.lumAt(0, 0) >= 0.8, `中心亮度只有 ${P.lumAt(0, 0)} ⟹ 形不成焦点`);
  // ⚠️⚠️ 而**中间那一带要宽** —— 不是只有正中心一个点亮
  //   （实测那次就是"一个亮尖"）⟹ d=0.3 处还该有 0.7 以上
  assert.ok(P.lumAt(0.3, 0) >= 0.68,
    `d=0.3 处只有 ${P.lumAt(0.3, 0).toFixed(2)} ⟹ 亮的那片太窄，会变成"一个尖"`);
});

check('⚠️ 音频只**加**不乘（乘法会把外圈压到 0）', () => {
  const edgeQuiet = P.lumAt(1, 0);
  const edgeLoud = P.lumAt(1, 1);
  assert.ok(edgeLoud > edgeQuiet, '音频没让亮度上升');
  // ⚠️⚠️ 关键：**能量为 0 时外围也不该变暗** —— 那正是"乘法"的坏处
  assert.ok(edgeQuiet >= 0.15,
    `没有音频时外围亮度 ${edgeQuiet.toFixed(3)} ⟹ 安静的时候画面会是黑的`);
});

check('⚠️⚠️ 饱和度落在目标区间（低饱和才是"高级感"）', () => {
  // ⚠️⚠️⚠️ **口径**（0.9.155 澄清）：我早先记的"S 中位 0.30-0.34"是用
  //   `lum>30` 量整幅得到的。而按 `lum>25` 分圈量：
  //     中心 r<15  面积 5-7%   S 0.30-0.48
  //     中层 15-35 面积 23-26% S 0.41-0.58
  //     外围 r>35  面积 67-72% S 0.58
  //   ⟹ 整幅中位是 **0.58**（外围占七成面积）。
  //   ⚠️ 那两个数**不矛盾，是不同口径** ——
  //     而我原来的断言写的是"中间那圈 0.25-0.40"，那其实对应的是**中心区**。
  //   ⟹ 判据：**报一个统计量必须带口径**（阈值 + 区域 + 分母），
  //     否则下一个人（包括我自己）会拿它去校准错的东西。
  //     这个项目为"报数不交代口径"栽过。
  //
  // ⟹ 现在按分圈实测守：
  const center = P.satAt(0, 0);
  assert.ok(center >= 0.28 && center <= 0.40,
    `中心的饱和度 ${center.toFixed(2)} 不在 0.28-0.40（实测中心区 0.30-0.48，取低段）`
    + ' ⟹ 中心该偏白（低饱和），那是"高级感"的来源');
  const mid = P.satAt(0.5, 0);
  assert.ok(mid >= 0.38 && mid <= 0.56,
    `中层的饱和度 ${mid.toFixed(2)} 不在 0.38-0.56（实测中层 0.41-0.58）`);
  const edge = P.satAt(1, 0);
  assert.ok(edge >= 0.52 && edge <= 0.66,
    `外围的饱和度 ${edge.toFixed(2)} 不在 0.52-0.66（实测外围 0.58）`);
  // ⚠️⚠️ 而**方向**是这一条真正要守的：中心低、外围高
  assert.ok(edge > center + 0.15,
    `外围(${edge.toFixed(2)}) 没比中心(${center.toFixed(2)}) 高出 0.15 以上`
    + ' ⟹ 那个梯度是"中心暖白、中层紫、外围没入"这个观感的来源');
  // ⚠️ 上界：任何情况下都不许超过 0.85（那是荧光色）
  for (const d of [0, 0.5, 1]) {
    for (const l of [0, 0.5, 1]) {
      assert.ok(P.satAt(d, l) <= 0.85,
        `d=${d} loud=${l} 时饱和度 ${P.satAt(d, l)} 超过 0.85 ⟹ 那是荧光色`);
    }
  }
});

check('⚠️⚠️ 色相：中心洋红紫 → 外围蓝紫（空间方向不能反）', () => {
  const calm = P.hueAt(0, 0);
  const loud = P.hueAt(0, 1);
  // ⚠️ 实测：中心色相中位 **294**，激烈时整体偏向蓝紫 210-260
  assert.ok(calm >= 288 && calm <= 300,
    `中心色相 ${calm} 不在 288-300（分圈实测中心是 294）`);
  assert.ok(loud >= 210 && loud <= 260, `激烈时色相 ${loud} 不在 210-260`);

  // ⚠️⚠️⚠️ **空间方向**（0.9.155 修的，我原来写反了）：
  //   实测中心 294 → 外围 251，**往下偏 43 度**（越往外越蓝）。
  //   而我原来是 `+ dd * 18` ⟹ 越往外越红 —— **方向反了**。
  //   ⟹ 判据：**一个"梯度"要守方向，不只守两端的值。**
  const edge = P.hueAt(1, 0);
  assert.ok(edge < calm - 30,
    `外围色相 ${edge} 没比中心 ${calm} 低 30 度以上`
    + ' ⟹ 空间方向反了（该是"中心洋红紫、外围蓝紫"，实测差 43 度）');
  assert.ok(edge >= 245 && edge <= 258,
    `外围色相 ${edge} 不在 245-258（实测 251）`);
  // ⚠️ 所有取值都要在 0-360（`% 360` 别算错）
  for (const d of [0, 0.5, 1]) {
    for (const l of [0, 0.5, 1]) {
      const h = P.hueAt(d, l);
      assert.ok(h >= 0 && h < 360, `d=${d} loud=${l} 的色相 ${h} 越界`);
    }
  }
});

check('⚠️⚠️⚠️ 注入给模型的那段代码和这里的函数**算出同样的值**', () => {
  // ⚠️ 判据：**同一套数字只能有一个来源。** 注入的是字符串、测的是函数
  //   ⟹ 如果它们不一致，那我测的和模型跑的是两回事（而那种偏差没人会发现）。
  // eslint-disable-next-line no-new-func
  const DP = new Function(`${P.INJECT}\nreturn DP;`)();
  for (const d of [0, 0.15, 0.3, 0.5, 0.75, 1]) {
    for (const e of [0, 0.4, 1]) {
      assert.ok(Math.abs(DP.lum(d, e) - P.lumAt(d, e)) < 1e-9,
        `注入的 DP.lum(${d}, ${e})=${DP.lum(d, e)} 和 lumAt=${P.lumAt(d, e)} 不一致`);
      assert.ok(Math.abs(DP.sat(d, e) - P.satAt(d, e)) < 1e-9,
        `注入的 DP.sat(${d}, ${e}) 和 satAt 不一致`);
      assert.ok(Math.abs(DP.hue(d, e) - P.hueAt(d, e)) < 1e-9,
        `注入的 DP.hue(${d}, ${e}) 和 hueAt 不一致`);
    }
  }
  // ⚠️ 底色也要一致
  assert.strictEqual(DP.bg, P.TARGET.bg, '注入的底色和 TARGET.bg 不一致');
});

check('⚠️ 注入的代码本身语法合法（它会被抄进模型的产物里）', () => {
  // ⚠️ 判据：**注入的代码坏了，每一张生成的壁纸都会白屏。**
  assert.doesNotThrow(() => {
    // eslint-disable-next-line no-new-func
    new Function(P.INJECT);
  }, '注入的那段代码有语法错误');
  // ⚠️ 而它不许引用任何外部东西（THREE / ctx / window）—— 那样抄到哪都能跑
  for (const bad of ['THREE', 'ctx.', 'window.', 'document']) {
    assert.ok(!P.INJECT.includes(bad),
      `注入的代码里引用了 ${bad} ⟹ 它该是纯算术，不依赖任何环境`);
  }
});

check('极端输入不崩（模型可能传任何东西）', () => {
  for (const fn of ['lumAt', 'satAt', 'hueAt']) {
    for (const [a, b] of [[NaN, 0], [Infinity, 0], [-5, 0], [2, 0], [0, NaN], [0, 99]]) {
      const v = P[fn](a, b);
      assert.ok(Number.isFinite(v), `${fn}(${a}, ${b}) 返回了 ${v}`);
    }
  }
});

check('⚠️⚠️ 而**夹紧要在入口做**（不能靠下游兜）', () => {
  // ⚠️⚠️⚠️ 反向验证逮住这条：我把 `clamp01` 里的夹紧去掉之后测试**还是绿的**
  //   ⟹ 因为 `lumAt` 结尾还有一层 `Math.max(0, Math.min(1, ...))` 兜着。
  //   ⚠️ 那意味着**夹紧做了两遍**，而"两个地方做同一件事"的问题是：
  //     改一处不报错 ⟹ 下一个人会以为入口那层是多余的、删掉它
  //     ⟹ 而 `hueAt` **没有**结尾那层（它走 `% 360`）⟹ 那时 NaN 就漏出去了。
  //   ⟹ 判据：**边界检查在入口做一次，别在下游重复兜。**
  //     而这条测试守的是"入口那层真的在起作用"。
  //   ⚠️ 用超范围的输入验：`d = 5` 时如果入口夹到 1，结果该等于 `lumAt(1)`。
  assert.strictEqual(P.lumAt(5, 0), P.lumAt(1, 0),
    'd=5 的结果和 d=1 不一样 ⟹ 入口没把它夹到 1');
  assert.strictEqual(P.satAt(-3, 0), P.satAt(0, 0),
    'd=-3 的结果和 d=0 不一样 ⟹ 入口没把它夹到 0');
  // ⚠️⚠️ hueAt 尤其重要 —— 它没有下游兜底（走 % 360）
  assert.strictEqual(P.hueAt(0, 99), P.hueAt(0, 1),
    'loudness=99 的色相和 =1 不一样 ⟹ 入口没夹，而 hueAt 没有下游兜底');
  assert.ok(Number.isFinite(P.hueAt(NaN, NaN)), 'hueAt(NaN, NaN) 不是有限数');
});


// ═══════════════════════════════════════════════════════════════════════════
//  ⚠️⚠️⚠️ 颜色可换，关系不可换（0.9.156）
// ═══════════════════════════════════════════════════════════════════════════
//
// 用户 2026-08-03：「目标的颜色是可以修改的，没必要紫色，我只是想要实现他那种效果」
//
// ⚠️ 而我一路把"色相 294→251"当成了硬指标 —— 那是**把"风格"和"审美原理"搞混了**。
//   ⟹ 判据：**从参考物量出来的东西要分两类**：
//     「关系」（中心低饱和→外围高饱和、亮度往外降、色相往外偏冷）= 效果的来源
//     「取值」（具体是紫还是青）= 那一张的选择
console.log('\n颜色可换，关系不可换');

check('⚠️⚠️ 换主色相之后，那三条关系全部不变**而且值是对的**', () => {
  // ⚠️⚠️⚠️ 反向验证逮住这条：我原来只比较 `alt.x === ref.x`（换色前后一致）——
  //   而把 `satBase: TARGET.satBase` 改成 `satBase: 0.6` 时**两边都变成 0.6**
  //   ⟹ "一致"照样成立，守卫全绿。
  //   ⟹ 判据：**"前后一致"不等于"值是对的"** —— 一个错的常数在所有调用里
  //     都一样错，那种错法用"比较两次调用"是抓不到的。
  //   ⟹ 所以两件都要守：① 值等于 TARGET（对）② 换色前后一致（不受色相影响）
  const ref = P.paletteFor(294);   // 参考壁纸那套
  for (const hue of [195, 40, 150, 0, 359]) {
    const alt = P.paletteFor(hue);
    for (const key of ['satBase', 'satLoud', 'satSpatialGain',
      'lumCenter', 'lumEdge', 'hueSpatialShift']) {
      // ① ⚠️ 值必须等于实测标定的那个（改坏常数会在这里红）
      assert.strictEqual(alt[key], P.TARGET[key],
        `主色 ${hue} 的 ${key} 是 ${alt[key]}，而 TARGET.${key} 是 ${P.TARGET[key]}`
        + ' ⟹ 那几个值是从参考壁纸实测标定的，不能改');
      // ② 而换色前后要一致（那是"关系不随配色变"这条）
      assert.strictEqual(alt[key], ref[key],
        `主色 ${hue} 时 ${key} 和参考那套不一样 ⟹ 关系跟着配色变了`);
    }
  }
  // ③⚠️⚠️ 而那几个值本身要在合理范围 —— 否则"等于 TARGET"只是等于一个错的东西
  assert.ok(P.TARGET.satBase >= 0.25 && P.TARGET.satBase <= 0.40,
    `TARGET.satBase = ${P.TARGET.satBase} 不在 0.25-0.40（实测中心 0.30）`);
  assert.ok(P.TARGET.satSpatialGain > 0.15,
    `TARGET.satSpatialGain = ${P.TARGET.satSpatialGain} 太小`
    + ' ⟹ 饱和度的空间梯度没了，画面会是平的');
  assert.ok(P.TARGET.hueSpatialShift < -20,
    `TARGET.hueSpatialShift = ${P.TARGET.hueSpatialShift} 不是"往外偏冷"`
    + '（该是负数且绝对值 >20）');
});

check('⚠️ 而主色相真的换了（不是摆设）', () => {
  for (const hue of [195, 40, 150]) {
    const pal = P.paletteFor(hue);
    assert.strictEqual(pal.hueCalm, hue, `paletteFor(${hue}) 的主色相不是 ${hue}`);
    // ⚠️⚠️ 激烈时往**冷**的方向偏 —— 那让"高潮"在颜色上也能看出来
    //   ⚠️ 而"冷的方向"是色相减小，要处理绕过 0 的情况
    const delta = ((pal.hueCalm - pal.hueLoud) % 360 + 360) % 360;
    assert.ok(delta > 40 && delta < 80,
      `主色 ${hue}：激烈时只偏了 ${delta} 度（该是 ~59）⟹ 那让"高潮"看不出颜色变化`);
  }
});

check('⚠️⚠️ 底色跟着主色走（一套青色配蓝紫底会脏）', () => {
  for (const [hue, expectDominant] of [[195, 'b'], [40, 'r'], [120, 'g']]) {
    const pal = P.paletteFor(hue);
    const r = (pal.bg >> 16) & 255;
    const g = (pal.bg >> 8) & 255;
    const b = pal.bg & 255;
    // ⚠️ 底色要**很暗**（近黑）—— 那是"大片留白"的基础
    assert.ok(Math.max(r, g, b) <= 40,
      `主色 ${hue} 的底色 #${pal.bg.toString(16).padStart(6, '0')} 太亮了`
      + `（最大通道 ${Math.max(r, g, b)}，该 ≤40）`);
    // ⚠️⚠️ 但它要**带着主色的调子** —— 否则底色和主体像两张图拼的
    const dom = { r, g, b };
    const maxKey = Object.keys(dom).reduce((a, k) => (dom[k] > dom[a] ? k : a), 'r');
    assert.strictEqual(maxKey, expectDominant,
      `主色 ${hue} 的底色主通道是 ${maxKey}，该是 ${expectDominant}`
      + ' ⟹ 底色没跟着主色走，那会让底色和主体像两张图拼的');
  }
});

check('极端/非法主色相不崩', () => {
  for (const bad of [NaN, Infinity, -30, 720, null, undefined, 'abc']) {
    const pal = P.paletteFor(bad);
    assert.ok(Number.isFinite(pal.hueCalm) && pal.hueCalm >= 0 && pal.hueCalm < 360,
      `paletteFor(${String(bad)}) 的色相是 ${pal.hueCalm}`);
    assert.ok(Number.isFinite(pal.bg) && pal.bg >= 0 && pal.bg <= 0xffffff,
      `paletteFor(${String(bad)}) 的底色不合法`);
  }
  // ⚠️ -30 和 720 该被折进 0-360（而不是当成非法）
  assert.strictEqual(P.paletteFor(-30).hueCalm, 330, '-30 没折成 330');
  assert.strictEqual(P.paletteFor(720).hueCalm, 0, '720 没折成 0');
});

check('hslToRgb 是对的（那是底色的来源）', () => {
  // ⚠️ 拿几个已知值验 —— 一个错的 HSL→RGB 会让所有底色都偏
  assert.deepStrictEqual(P.hslToRgb(0, 1, 0.5), [255, 0, 0], '纯红不对');
  assert.deepStrictEqual(P.hslToRgb(1 / 3, 1, 0.5), [0, 255, 0], '纯绿不对');
  assert.deepStrictEqual(P.hslToRgb(2 / 3, 1, 0.5), [0, 0, 255], '纯蓝不对');
  assert.deepStrictEqual(P.hslToRgb(0, 0, 0.5), [128, 128, 128], '灰不对（s=0 那条分支）');
  assert.deepStrictEqual(P.hslToRgb(0, 0, 0), [0, 0, 0], '黑不对');
  assert.deepStrictEqual(P.hslToRgb(0, 0, 1), [255, 255, 255], '白不对');
  // ⚠️⚠️ 反向验证逮住这条：`t < 1/6` 那个分支只有**橙黄色系**会走
  //   ⟹ 上面那六个用例（红/绿/蓝/灰/黑/白）都绕过它，改坏了照样绿。
  //   ⟹ 判据：**验一个分段函数要覆盖每一段**，而不是几个"典型值"。
  assert.deepStrictEqual(P.hslToRgb(30 / 360, 1, 0.5), [255, 128, 0],
    '橙色不对（那是 t < 1/6 那个分支）');
  assert.deepStrictEqual(P.hslToRgb(60 / 360, 1, 0.5), [255, 255, 0], '黄色不对');
  assert.deepStrictEqual(P.hslToRgb(180 / 360, 1, 0.5), [0, 255, 255], '青色不对');
  assert.deepStrictEqual(P.hslToRgb(300 / 360, 1, 0.5), [255, 0, 255], '洋红不对');
});


console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
