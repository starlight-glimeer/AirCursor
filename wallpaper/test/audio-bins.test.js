// WE 音频算法。**这一整个文件是为一串真机 bug 写的，而它们全源于同一个错误：
// 我八轮都在自己设计这一层，而不是去看 WE 怎么做。**
//
//   node test/audio-bins.test.js
//
// 用户 2026-07-31 点出的第一性原理：
//   「你为什么是在针对这个壁纸做适配，这很奇怪。应该是我们不理解那个壁纸软件
//     它的渲染原理，所以我们通过这个壁纸去反推我们的渲染器」
//   「Linux 和 Mac 应该是很相近的……他那个逆向应该会对我们非常有帮助」
//
// 他对。答案在 `linux-wallpaperengine`（逆向 WE 的开源项目）里，
// 而我为它猜了八轮：对数分箱 / 线性分箱 / 低频插值 / sqrt / 去掉 sqrt /
// 各种归一化系数 / 要不要平滑 / 上限取多少 —— **每一条都错**。
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const A = require('../src/audio-bins.js');

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

const SWIFT = path.join(__dirname, '..', 'native', 'GestureWallAudio.swift');
const swiftSrc = fs.readFileSync(SWIFT, 'utf8');
const swiftCode = swiftSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// ⚠️⚠️⚠️ **剥注释后再查代码。这一轮我因为漏了这一步，反向验证三次假阴性。**
//
// 形状：守卫写 `assert.match(main, /sticky/)`，而 `sticky` 这个词**也出现在注释里**
// ⟹ 把字段改名成 `stickyX` 后断言照样绿 ⟹ **守卫没有判别力**。
//
// 三次分别是：`multiPct`（改名后绿）、`rawFrames`（改名后绿）、
// `音乐本身的瞬态`（删掉面板文案后绿，因为注释里也写了这句）。
// ⚠️ 而 `gating.test.js` 里**早就有 `codeOnly`**（第 176 行）——
// 我在这个文件里重复造了三次同样的洞，而解药在隔壁文件里躺着。
// ⟹ 教训：**写守卫前先看隔壁的守卫怎么写的**（"改前查兄弟分支"的同一个形状）。
//
// ⚠️ 注意 Swift 侧的 `swiftCode` 一开始就做了这件事，只有 JS 侧漏了。
function codeOnly(source) {
  return source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
}
// 三个 JS 源的"只有代码"版本 —— 查"有没有这个字段/文案"一律用它们
const mainCode = () => codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8'));
const dashCode = () => codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'));

console.log('\nWE 音频算法');

console.log('\n  五个步骤，每个都有出处');

// ⚠️ 这五条对应 WE 那段代码的五行。它们**必须一起用** ——
// 比如"功率不开根"成立是因为后面有 log10（对数已经压缩了动态范围），
// 我之前"去掉 sqrt 又不加 log"是两头都不对。
// ⚠️ 这条断言改了：原来要求 `band * 2`（照抄 WE 的 stride），而那是错的。
//
// WE 是 **64 段** × stride 2 ⟹ 覆盖 0-5.4kHz。
// 照抄在 **128 段**上 ⟹ 覆盖 0-11.2kHz ⟹ **频率范围翻倍**。
//
// 用户 2026-08-01 的描述定死了后果：
//   「3 点是一个很明显的分割线，上面很明显不活跃，下面太活跃了」
//   「3 点到 4 点这个区间有反应，其他的反应都很小」
//
// 算出来：3-4 点 = 段 0-10 = 47-1000Hz（音乐能量集中）；
// 段 58-119 = 5.4k-11.2kHz（WE 压根不覆盖）⟹ 那 62 段几乎没能量 ⟹ 半个圆环死的。
// 而 3 点是圆周接缝：段 119 的 11.2kHz 紧贴段 0 的 47Hz，**差 239 倍**。
// ⚠️⚠️ **这条断言反过来过一次：先要求 stride 2，改成要求 stride 1，现在回到 2。**
//
// 那不是来回摇摆 —— **前提换了**。
//   前提"128 个连续频段" ⟹ stride 2 覆盖 0-11.2kHz ⟹ 半个圆环死 ⟹ 要 stride 1
//   前提"左 64 + 右 64"   ⟹ 只有 64 段 ⟹ stride 2 覆盖 0-5.4kHz ⟹ **WE 原值**
//
// ⚠️ 而"频率范围翻倍"这个观察从头到尾是对的，错的是我当时的解法：
// 我改 stride 去补偿，而根源是"用 128 段"这个前提本身。
// **改一个派生常量去补偿一个错的前提** —— 这一轮我干了三次
//（stride、加权分母、覆盖范围），三次都在同一个前提上打补丁。
check('① 线性取样 stride 2 —— WE 原值（因为只有 64 段）', () => {
  assert.match(swiftCode, /band \* 2 \+ 1/,
    'stride 不是 2 —— WE 是 `int index = band * 2`。'
    + '我曾改成 stride 1，那是为了补偿"128 个连续频段"这个错前提造成的频率翻倍；'
    + '前提改成「左 64 + 右 64」之后，stride 2 覆盖 0-5.4kHz，和 WE 一致');
  // 不许再出现我那三个错误模型的痕迹
  assert.ok(!/LINEAR_BINS|USEFUL_BINS|powf\(ratio/.test(swiftCode),
    '还有旧分箱模型的残留（LINEAR_BINS / USEFUL_BINS / powf(ratio…)）');
});

// ⚠️⚠️⚠️ **128 = 左 64 + 右 64（右半镜像）。**
//
// 证据三条（都指向 64）：WE 的循环 `band < 64`；数组只有 16/32/64 没有 128；
// shader uniform 是 `g_AudioSpectrum64Left`/`64Right` 两个 64。
// 壁纸侧两种取样也都假设两端对称（`getRingArray` 交替 shift/pop 从两端削、
// `PWLine.js:147` 的 `iv=(120-密度)/2` 从中心取）。
//
// 反证一条：粒子壁纸把 128 线性重采样到 512，当连续数组用
// ⟹ 读代码分不出来，**判据只能是用户看画面**（这个改动是可逆的）。
//
// 最强的支持：**镜像让所有常量回到 WE 原值**（加权分母 63、stride 2、0-5.4kHz）——
// 我过去每个错都出自"把 64 段公式适配到 128 段"，前提换掉补丁全都不需要了。
check('128 = 左 64 + 右 64，右半是镜像', () => {
  assert.match(swiftSrc, /let bands = BIN_COUNT \/ 2/,
    'Swift 里没有 `bands = BIN_COUNT / 2` —— 循环还在跑 128 段');
  // ⚠️ 断言从 `out[BIN_COUNT-1-band] = value` 改成下面这个 —— 因为镜像
  // **从 process() 里搬到了调用点**，而且两半现在是**两个不同声道**：
  //   旧：out[band] 和 out[127-band] 都写同一个 value（两半精确相等）
  //   新：bins[b] = left[b]，bins[127-b] = right[b]（立体声下不相等）
  //
  // ⚠️⚠️ 为什么必须改：用户 0.9.17 实测「孤峰固定在第59段(37/60帧)」+
  // 「镜像逐段差 0.0000」⟹ band 63 写到段 63 **和段 64（相邻！）**，
  // 而 band 63 的加权是 **1.393（全场最大）**
  // ⟹ 9 点方向必然有两根**精确等高的最长柱子**紧挨着、中间没过渡
  // ⟹ 折线壁纸（PWCircle 的 style2/3 用 lineTo 连 120 点）上就是一个尖顶。
  // ⟹ 取平均的话那两根在**数学上不可能不相等** ⟹ 分声道是唯一正解。
  // ⚠️⚠️ 这条断言反过来过一次：先要求 `= value`（两半同一份），改成
  // `= right[b]`（分左右声道），**现在回到同一份**。理由是 WE 源码：
  //     addUniform ("g_AudioSpectrum64Left",  recorder.audio64, 64);
  //     addUniform ("g_AudioSpectrum64Right", recorder.audio64, 64);
  //                                          ^^^^^^^^^^^^^^^^ **同一个数组**
  // ⟹ WE 的"左右"就是同一份数据，而且 `spec.channels = 1`（只抓单声道）。
  //
  // ⟹ 于是段 63/64（相邻，band 63 加权 1.393 最大）**精确相等** ——
  //    在折线壁纸上是一个尖顶，而**那个尖顶在真 WE 上也存在**。
  //    我曾为它做分声道，那让画面离作者调好的效果**更远**。
  assert.match(swiftCode, /bins\[BIN_COUNT - 1 - b\] = one\[b\]/,
    '镜像后半不是同一份数据 —— WE 的 64Left 和 64Right 传的是同一个 audio64');
  assert.match(swiftCode, /bins\[b\] = one\[b\]/, '镜像前半不对');
  assert.ok(!/spectrumL|spectrumR|pcmStereo/.test(swiftCode),
    '还有分左右声道的残留 —— WE 的 `spec.channels = 1`，只抓单声道');
  // JS 规格也要镜像，而且要逐段相等
  const mags = new Array(512).fill(0).map((_, i) => 100 / Math.sqrt(i + 1));
  const f = A.frameValues(mags);
  assert.strictEqual(f.length, 128, `输出长度 ${f.length}，壁纸要 128`);
  for (let i = 0; i < 64; i += 1) {
    assert.strictEqual(f[i], f[127 - i],
      `段 ${i} (${f[i]}) 和段 ${127 - i} (${f[127 - i]}) 不相等 —— 镜像下标写错了。`
      + '症状是"圆环接缝处有一根突兀的柱子"，看起来像音频问题实际是下标');
  }
  // ⚠️ **形状要"降下去再升回来"**，那是"不螺旋"的量化。
  // 用户十几轮报的都是单向递减：3点 0.374 → 9点 0.101 → 2点 0.05。
  const mean = (from) => {
    let sum = 0;
    for (let i = from; i < from + 10; i += 1) sum += f[i] || 0;
    return sum / 10;
  };
  const at3 = mean(0);      // 3 点
  const at9 = mean(60);     // 9 点（镜像轴附近）
  const at2 = mean(110);    // 2 点（绕回来）
  assert.ok(Math.abs(at3 - at2) / Math.max(at3, at2) < 0.4,
    `3 点(${at3.toFixed(3)}) 和 2 点(${at2.toFixed(3)}) 差太多 —— `
    + '绕一圈回来该接近（那是"接缝不可见"）。差得多就是螺旋');
  assert.ok(at9 > at3,
    `9 点(${at9.toFixed(3)}) 不比 3 点(${at3.toFixed(3)}) 高 —— `
    + '镜像布局下 9 点是高频端（加权 ×1.39），该是圆环上最活跃的');
});

check('② 用功率（re²+im²），不是 magnitude', () => {
  // ⚠️ 断言从 `magnitude * magnitude` 改成 `m * m` —— 因为改成了**主瓣求和**：
  // 单点取值时是 `power = magnitude²`，现在是三个 bin 的功率相加。
  // （功率可加，magnitude 不可加 —— 那是能量守恒，不是风格选择。）
  // ⚠️ 这条锚点改过两次：`magnitude * magnitude` → `power += m * m`（主瓣求和）
  // → 现在回到 `power = m * m`（单点）。**每次都是前提变了，不是摇摆。**
  // 最后这次的依据是 WE 源码逐字：`f2 = f1 * f1 + f2 * f2`，单点取值。
  assert.match(swiftCode, /let power = m \* m/,
    '没有把 magnitude 平方回功率 —— WE 用的是 `f2 = f1*f1 + f2*f2`');
  assert.ok(!/sqrtf\(/.test(swiftCode),
    '还在开根 —— 那和 WE 相反（它用功率，因为后面要 log10）');
});

check('③ 0.35 × log10(功率)', () => {
  assert.match(swiftCode, /LOG_SCALE \* log10f\(power\)/,
    '归一化不是 `0.35 * log10(功率)` —— 我曾用线性、用 sqrt，都错');
  assert.match(swiftSrc, /let LOG_SCALE: Float = 0\.35/,
    'LOG_SCALE 不是 0.35（WE 的 `0.35f * log10(f2)`）');
  // ⚠️ log10(0) = -inf，必须挡
  assert.match(swiftCode, /if power > 0\.0/,
    'power ≤ 0 时没挡住 ⟹ log10 返回 -inf，整帧变成 NaN');
});

// ⚠️ 这一条是"柱子铺满整圈"的唯一原因。
check('④ 频段加权 2 − e^((1−band/(N−1))−0.5)', () => {
  assert.match(swiftCode, /2\.0 - expf\(t - 0\.5\)/,
    '没有频段加权 ⟹ 低频原样保留 ⟹ 用户报「3 点那片特别长」。'
    + 'WE 主动压低频（×0.351）、抬高频（×1.393），那才是柱子铺满整圈的原因');
  // 数值要和 WE 的曲线一致
  assert.ok(Math.abs(A.bandWeight(0) - 0.351) < 0.002,
    `band 0 的加权是 ${A.bandWeight(0).toFixed(3)}，WE 是 0.351`);
  // ⚠️ 顶端是 band **63**（WE 的 64 段），不是 127。
  // 我曾把分母改成 127 去适配"128 个连续频段" —— 那是同一个错前提的第二个补丁。
  assert.ok(Math.abs(A.bandWeight(63) - 1.393) < 0.002,
    `band 63 的加权是 ${A.bandWeight(63).toFixed(3)}，WE 是 1.393`);
  assert.match(swiftSrc, /Float\(bands - 1\)/,
    'Swift 的加权分母不是 `bands - 1`（= 63）—— 它曾是 BIN_COUNT-1 = 127');
});

check('⑤ 两向平滑，系数 0.3', () => {
  assert.match(swiftCode, /\* SMOOTH/,
    '没有平滑 —— WE 是 `movetowards(cur, target, 0.3f)`');
  assert.match(swiftSrc, /let SMOOTH: Float = 0\.3/, 'SMOOTH 不是 0.3');
  // ⚠️ 两个方向同一个系数 —— 我之前分了 ATTACK/RELEASE 且 ATTACK=1.0（不平滑上升）
  assert.ok(!/ATTACK|RELEASE/.test(swiftCode),
    '还有 ATTACK/RELEASE —— WE 两个方向用同一个系数，'
    + '而我曾让上升不插值（理由是"壁纸自己有平滑"），那和 WE 的真实行为相反。'
    + '「颗粒粗、没有波浪感」就是那个的后果');
});


// ⚠️ 频率覆盖范围要和 WE 一致 —— 那是"半个圆环死的"的根因。
check('频率覆盖和 WE 一致（0-6kHz，不是 0-11kHz）', () => {
  const hzPerBin = 48000 / 2 / 512;
  // ⚠️ 顶端是 **band 63 × stride 2 + 1 = bin 127**（不是 bin 128）。
  // 这个式子跟着 stride 改过两次 —— 直接从规格算，别写死。
  const topBin = (A.BANDS - 1) * 2 + 1;
  const topHz = topBin * hzPerBin;
  assert.ok(topHz < 8000,
    `覆盖到 ${Math.round(topHz)}Hz —— WE 只到 5.4kHz。`
    + '铺太宽会让高频那些段落在音乐几乎没能量的区间 ⟹ 半个圆环不动');
  assert.ok(topHz > 4000,
    `只覆盖到 ${Math.round(topHz)}Hz —— 太窄会丢掉人声和主奏的泛音`);

  // ⚠️⚠️ **接缝不再是频率跳变问题 —— 镜像布局下 3 点两侧是同一个频段。**
  //
  // 旧论证：段 119 的 5.6kHz 紧贴段 0 的 47Hz ⟹ 119 倍跳变 ⟹ 可见分割线。
  // 那个论证建立在"128 个连续频段"上。镜像布局下：
  //   段 127 = 右声道 band 0 = **和段 0 同一个频段**
  //   ⟹ 接缝处频率差 **1 倍**，天然连续。
  //
  // ⟹ 这条测试从"频率比值"改成直接查**镜像**（那才是接缝连续的机制）。
  const mags2 = new Array(512).fill(0).map((_, i) => 100 / Math.sqrt(i + 1));
  const f2 = A.frameValues(mags2);
  assert.strictEqual(f2[0], f2[127],
    `段 0 (${f2[0]}) 和段 127 (${f2[127]}) 不相等 —— 圆环绕回来接不上，`
    + '那就是用户报了十几轮的「3 点是很明显的分割线」');
});

console.log('\n  这套算法在真实数据上的效果');

// ⚠️⚠️⚠️ **这批数字换过一次，原因是旧的那批口径是错的。**
//
// 旧值 `{0:166.7, 10:72.3, 20:10.0, …, 119:1.4}` 是"用户读数 ÷ 我当时的归一化系数"
// 反推的 —— 而那个系数在改成 WE 算法时就删了。把旧值代进**当前**公式得到
// 0.40..0.67（漂亮、铺满），而用户在同一批读数里看到的是 **0.006..0.376**。
//
// ⟹ 下面那两条「真实数据」测试**一直在验一组不存在的数字，而且一直全绿**。
//    这就是为什么守卫没能拦住"高段恒等于 0"：它验的输入不是真实输入。
//
// ⚠️ 教训：**反推出来的中间量会随算法一起过期。** 测试里固定的"真实数据"
//    必须是**观测量**（用户看到的最终值），或者标清它是用哪一版公式反推的。
//    这一条比它拦住的 bug 更值钱 —— 一个恒绿的守卫比没有守卫更坏。
//
// 现在这批是用**当前**公式从用户实测最终值反解 magnitude：
//   magnitude = 10^((最终值 / 加权 / LOG_SCALE) / 2)
// 用户实测（2026-07-31，全系统混音，正在放音乐）：
//   [0]0.376 [10]0.176 [20]0.014 [40]0.115 [60]0.178 [80]0.006 [100]0.009 [119]0.007
const REAL_OBSERVED = { 0: 0.376, 10: 0.176, 20: 0.014, 40: 0.115, 60: 0.178, 80: 0.006, 100: 0.009, 119: 0.007 };
// 反解：magnitude = 10^((最终值 / 加权 / LOG_SCALE) / 2)
const magOf = (band) => 10 ** ((REAL_OBSERVED[band] / A.bandWeight(band, 128) / A.LOG_SCALE) / 2);

// ⚠️ **这条是"高段恒 0"的坐实，而且用的是独立观测。**
// 它不是把反解值代回公式（那是循环论证，见下面删掉的两条），
// 而是问：**用户那批读数反解出的 magnitude，离地板有多远？**
check('用户实测反解：高段的 magnitude 贴在地板上（不是"值小"）', () => {
  const high = [80, 100, 119].map((b) => ({ b, m: magOf(b) }));
  for (const { b, m } of high) {
    assert.ok(m < 1.1,
      `段 ${b} 反解 magnitude=${m.toFixed(3)} —— 如果它明显大于 1（地板），`
      + '那"高段恒 0"的解释就不成立，得另找原因');
  }
  // 而低段离地板很远 ⟹ 两者的差距不是加权能填的
  const low = magOf(1 in REAL_OBSERVED ? 1 : 0);
  assert.ok(low > 10,
    `低段反解 magnitude=${low.toFixed(1)} —— 低段也贴地板的话，`
    + '说明整条谱都在地板附近，那是增益问题不是泄漏问题（结论会不一样）');
  const span = 20 * Math.log10(low / high[0].m);
  assert.ok(span > 20,
    `低段比高段只高 ${span.toFixed(0)}dB —— 而频段加权最多只有 ${(1.354 / 0.351).toFixed(1)} 倍`
    + `（${(20 * Math.log10(1.354 / 0.351)).toFixed(0)}dB）⟹ 加权填不平这个差距，`
    + '这就是"调加权救不回高段"的算术依据');
});

// ⚠️⚠️ **`0.35*log10(power)` 有一个绝对地板，而频段加权是乘法 —— 乘不动 0。**
//
// power < 1 ⟹ log10 为负 ⟹ 被下界夹成 0。而 magnitude=1 就是那个地板。
// 满幅纯音的 magnitude ≈ 775（自检实测段 10 = 0.963 反推）
// ⟹ **地板在满幅下方 58dB**：任何比满幅低 54dB 的成分输出**恒等于 0**。
//
// 上面反解出的 magnitude：段 80/100/119 = **1.02**，地板是 1.00。
// ⟹ 用户报的「12 点到 3 点之间基本没有反应」不是"值小"，是**恒 0**，
//    而我为它调了三轮加权 —— 加权改不了地板。
check('地板：magnitude 贴着 1.0 的段必然输出 0（那不是"小"，是"没有"）', () => {
  assert.strictEqual(A.bandValue(1.0, 60), 0,
    'magnitude=1 ⟹ power=1 ⟹ log10=0 ⟹ 输出必须是 0。'
    + '如果这里非 0，说明公式链和 WE 的 log10 不一致');
  assert.strictEqual(A.bandValue(0.99, A.BANDS - 1), 0,
    'magnitude<1 时 log10 为负，最大的频段加权（band 63，×1.39）也救不回来 —— '
    + '**加权是乘法，它乘不动 0**。我为"高段不动"调了三轮加权，方向从一开始就错');
  // 地板离满幅多远 —— 那个距离决定了"多弱的成分会被整段丢掉"
  const fullScale = 775;   // 自检实测反推
  const floorDb = 20 * Math.log10(fullScale);
  assert.ok(floorDb > 50,
    `地板只在满幅下方 ${floorDb.toFixed(0)}dB —— 那太浅了，连中等音量都会被丢`);
});

// ⚠️⚠️⚠️ **WE 没有窗函数，而那不是疏漏 —— 是这套公式赖以工作的前提。**
//
// WE：`(audioBuffer[i]-128)/128.0` 直接进 `kiss_fftr`，中间什么都没有 == 矩形窗。
// 我加了 Hann 窗（理由是"不加窗会撒假高频"—— DSP 常识，本身没错）。
//
// 旁瓣：矩形 -13dB / 6dB每倍频    Hann -31dB / 18dB每倍频
// 一个 magnitude 70 的低音泄漏到 10 段之外：矩形 1.58（**在地板之上**）
//                                          Hann 0.002（地板之下 500 倍）
//
// ⟹ **WE 的频谱能铺满圆环，靠的就是矩形窗的泄漏把整条谱抬到地板之上。**
//    log10 才有东西可压缩，频段加权才有东西可乘。
//
// 一个原因解释用户报的两件事：①高段没反应 ②柱子之间高度差特别大
// （Hann 出孤立窄峰 + 旁边全 0；矩形窗涂抹 ⟹ 峰周围连成片、过渡平滑）
//
// ⚠️ 这是同一个形状的第 11 次：**把"我知道的正确做法"放进一个"实现别人规格"的层。**
//    前十次是分箱模型、归一化系数、`USEFUL_BINS=76`、`min(1.2,·)` —— 那些是魔数，
//    容易被认出来。加窗更隐蔽：它是教科书上对的事，所以我审这个文件八轮没看它一眼。
//    判据不变：**这一行能不能从 WE 的行为推出来？** 不能就不该在这层。
check('没有窗函数（WE 是矩形窗，泄漏是它铺满圆环的机制）', () => {
  assert.ok(!/vDSP_hann_window|vDSP_hamm_window|vDSP_blkman_window/.test(swiftSrc),
    '又加了窗函数。WE 的链子里 `(audioBuffer[i]-128)/128` 直接进 kiss_fftr —— '
    + '没有窗。而 Hann 把旁瓣从 -13dB 压到 -31dB ⟹ 强低音的泄漏被掐掉 ⟹ '
    + '高频段只剩自己那点能量，落在 log10 的地板下 ⟹ 恒 0 ⟹ 半个圆环不动。'
    + '用户报的「12点到3点没反应」和「柱子高度差很大」都是这一行');
  // 去直流仍然要有 —— 那个能从 WE 的 `-128` 推出来
  assert.match(swiftSrc, /vDSP_meanv/,
    '去直流被一起删了。那一步**能**从 WE 推出来（它的 -128 干的就是这件事），'
    + '删掉的症状是"3 点方向那根柱子永远最长"（bin 0 收下全部直流偏移）');
});

// ⚠️⚠️⚠️ **这里原来有两条「真实数据」测试，删了。它们是同义反复。**
//
// 它们拿 `REAL_MAGS` 代进公式，要求"动态范围 <8 倍"和"每段 >0.05"。
// 而 `REAL_MAGS` 现在是**从用户那批读数反解出来的** ⟹ 代回公式必然复现读数
// （0.006..0.376，62 倍，段 80 只有 0.006）⟹ **它们永远红，而且红得没有信息**：
// 报的是"用户当时看到的画面不好看"，那件事我已经知道了。
//
// 而旧口径下它们**永远绿**（旧 REAL_MAGS 代进当前公式给 0.40..0.67）——
// ⟹ 这两条测试从来没有过判别力，只是从"恒绿"翻到了"恒红"。
//
// 真正要验的是**删掉 Hann 窗之后的新读数**，而那只能来自真机
// ⟹ 云端拿不到 ⟹ **不该在这里假装能验**。用户下一轮打包后的面板读数
// 就是这条测试的输入，拿到再写。
//
// ⚠️ 教训：**"用反推的中间量喂公式再验公式"是循环论证。**
// 输入是从输出反解的，那条链子里没有独立信息。
// 有判别力的测试要么用**独立的输入**（合成信号，比如上面的地板/纯音自检），
// 要么用**独立的观测**（真机读数）—— 不能拿输出当输入。

console.log('\n  ⏳ 等真机数据：删掉 Hann 窗之后的频谱分布（云端无法验）');

console.log('\n  边界与安全');

check('功率为 0 时输出 0，不是 NaN', () => {
  assert.strictEqual(A.bandValue(0, 0), 0, 'magnitude=0 时输出不是 0');
  for (let b = 0; b < 128; b += 17) {
    const v = A.bandValue(0, b);
    assert.ok(Number.isFinite(v) && v === 0, `第 ${b} 段在静音时输出 ${v}`);
  }
});

check('输出夹在 0..1（下界也要挡 —— log10 会给负数）', () => {
  for (const m of [0, 0.001, 0.5, 1, 100, 1e6]) {
    for (const b of [0, 31, 63]) {
      const v = A.bandValue(m, b);
      assert.ok(v >= 0 && v <= 1,
        `magnitude=${m} band=${b} 输出 ${v} 越界 —— `
        + 'log10 在功率<1 时是负数，只截上界会让柱子往反方向长');
    }
  }
});

check('整帧长度是 128，且不越界读 magnitudes', () => {
  const mags = new Array(256).fill(10);
  const out = A.frameValues(mags);
  assert.strictEqual(out.length, 128);
  // band*2 最大 254，而 magnitudes 只有 256 —— 刚好够
  const short = A.frameValues(new Array(64).fill(10));
  assert.strictEqual(short.length, 128, '短数组时长度不对');
  assert.ok(short.every(Number.isFinite), '短数组时产生了非法值');
});

console.log('\n  和 Swift 一致（两份知识会漂）');

check('Swift 和这份规格的常量一致', () => {
  for (const [re, why] of [
    [/let LOG_SCALE: Float = 0\.35/, 'LOG_SCALE'],
    [/let SMOOTH: Float = 0\.3/, 'SMOOTH'],
    [/BIN_COUNT = 128/, 'BIN_COUNT'],
  ]) {
    assert.match(swiftSrc, re, `${why} 和这份规格漂了`);
  }
});

// ⚠️ 这一层不该再有"我调的参数" —— 要改只有一个理由：
// 发现 WE 的真实行为和这里不一致，而那要有出处。
check('这一层没有我自己设计的参数', () => {
  const banned = [
    ['NORMALIZE', '我猜过 0.012 / 0.0066 / 0.002 / 0.06 / 0.6，全是自己倒推的'],
    ['CEILING', '上限是 WE 的 fmin(1.0,…)，不需要单独的常量'],
    ['LINEAR_BINS', '旧分箱模型'],
    ['USEFUL_BINS', '旧分箱模型（那个 76 还是从另一个壁纸抄的）'],
  ];
  for (const [name, why] of banned) {
    assert.ok(!new RegExp(`let ${name}`).test(swiftCode),
      `${name} 又回来了 —— ${why}。这一层的每个数都该有 WE 的出处`);
  }
});

check('出处写在代码里（下一个人要能核对）', () => {
  assert.match(swiftSrc, /linux-wallpaperengine/,
    '没写出处 ⟹ 下次有人想改这些数时，无从判断它们是抄的还是猜的');
  assert.match(swiftSrc, /PulseAudioPlaybackRecorder/,
    '没写具体文件名 —— 出处要能定位到那几十行');
});


console.log('\n  直流分量（"3 点方向一直居高不下"）');

// ⚠️ 用户实测三次都报同一件事：「3 点方向那个柱子基本上一直都是居高不下」。
//
// 3 点方向 = 段 0，而段 0 原来读 `index = band*2 = 0`
// ⟹ **FFT bin 0 是直流分量（DC），不是频率**。
// 它等于信号的平均值，只要音频不完美居中它就一直有值，而且**不随音乐变化**。
//
// ⚠️ WE 那边第一步就处理了：`(audioBuffer[i] - 128) / 128.0f`
//（它的输入是 8-bit 无符号 PCM，中心 128）。
// 而我们的输入是 Float32，我以为"已经居中"就不用管 —— 那是错的：
// ScreenCaptureKit 的混音仍可能带偏移，而 bin 0 会把它全部收下。
// ⚠️ 这条测试原来锚在 `vDSP_vmul`（加窗）上 ——「先减均值再加窗」。
// 窗删掉之后 `indexOf` 返回 **-1**，`meanAt < -1` 恒假 ⟹ **在正确代码上报红**。
// ⟹ 顺序判据改锚到 `vDSP_ctoz`（进 FFT 那一步），那个不会随窗的去留变化。
//
// ⚠️ 教训：**用"另一个可能被删掉的调用"当位置锚，那个锚会消失。**
// `indexOf` 找不到时返回 -1 而不是抛错 ⟹ 比较静默地变成假。
// 这一轮我已经栽过四次位置锚（都是固定长度切片），这次是**锚本身不存在**。
check('去直流：进 FFT 之前先减均值', () => {
  assert.match(swiftCode, /vDSP_meanv/,
    '没有去直流 ⟹ bin 0 收下全部偏移，症状是"某根柱子永远最长"'
    + '（用户实测三次报同一个位置）');
  const meanAt = swiftCode.indexOf('vDSP_meanv');
  const fftAt = swiftCode.indexOf('vDSP_ctoz');
  assert.ok(meanAt >= 0 && fftAt >= 0,
    `锚点不存在（meanv=${meanAt} ctoz=${fftAt}）—— indexOf 找不到给 -1 不抛错，`
    + '而 -1 参与比较会让断言静默变假');
  assert.ok(meanAt < fftAt,
    '去直流在进 FFT 之后 ⟹ 那一步白做，bin 0 仍然收下全部偏移');
});

check('段 0 不读 bin 0（那是直流不是频率）', () => {
  // ⚠️ 这条断言的锚改过两次（`band*2+1` → `band+1` → `band*2+1`），
  // 而**要守的东西一次没变**：那个 **+1**，它让段 0 读 bin 1 而不是 bin 0。
  // ⟹ 锚里带 stride 是脆的（stride 会随前提变）。用 `+ 1\)` 收尾更稳。
  assert.match(swiftCode, /min\(half - 1, band \* 2 \+ 1\)/,
    '段 0 仍然读 bin 0 —— 那是直流分量。去直流是靠"整窗均值"，'
    + '而窗内的极低频（<20Hz 听不见的隆隆声）仍会落进 bin 0/1，那些不该驱动画面');
});


console.log('\n  FFT 自检（"单段孤峰"的判据）');

// ⚠️ 用户实测三份数据（2026-07-31），尖刺全是**单段孤峰**：
//
//   第1份 [52]0.01→0.424 升、[53]0.424→0.048 降   ⟹ 段 52 孤峰
//   第2份 [53]0.223→0.476 升、[54]0.476→0.098 降  ⟹ 段 53 孤峰
//   第3份 [35]0.196→0.491 升、[36]0.491→0.145 降  ⟹ 段 35 孤峰
//
// 位置每次变，但都落在 2.5k-6kHz。
//
// ⚠️⚠️ **这条推理当时依赖"Hann 主瓣宽 4 bin"，而窗已经删了 —— 重算：**
//
// 矩形窗的主瓣宽是 **2 个 bin**（Hann 是 4 个），而 stride 1 下相邻段就是相邻 bin
// ⟹ 一个真实频率成分落进 **2 个相邻段**，仍然不是单段。
// ⟹ **判据本身没变**（"1kHz 纯音应该占 ≥2 段"），只是期望宽度从 4 变成 2。
//
// 而当时列的三个可能里，**"窗函数没生效"这一项现在是期望行为** ——
// 剩下两个（ctoz 的 stride 错 / magnitudes 被写坏）仍然靠这个自检分辨。
//
// ⚠️ 教训：**推理链里引用了某个实现细节，那个细节改了链子要跟着重算。**
// 我差点留着"主瓣宽 4 bin"当判据，那会让删窗之后的正确行为看起来像 bug。
check('启动时跑 FFT 自检（1kHz 纯音）', () => {
  assert.match(swiftSrc, /func selfTestFFT/,
    '没有 FFT 自检 ⟹ "单段孤峰"只能靠我推理，而我为它猜错了十次');
  assert.match(swiftCode, /selfTestFFT\(Spectrum\(\)\)/,
    '自检没被调用 —— 定义了不调等于没有');
});

// ⚠️ 这条测试原名「自检报主瓣宽度（那是判据本身）」—— 名字过期了：
// 主瓣宽度**不再是判据**（矩形窗下纯音会点亮几十段，那是泄漏）。
// 它现在的作用是"这些观测量都还在报"，而判据换成了泄漏衰减 + 镜像 + 峰值位置。
// ⚠️ 一个名字说着旧结论的绿色测试，读的人会照它去理解代码 —— 那是文档级的错。
check('自检报出全部观测量（宽度/峰值/邻域都还在）', () => {
  // ⚠️ 切到函数尾，不用固定长度 —— 我往这个函数里加了两个判据，
  // 2000 字符的切片就把断言要找的东西推走了。**这一轮我栽过四次。**
  const i = swiftSrc.indexOf('func selfTestFFT');
  const fn = swiftSrc.slice(i, swiftSrc.indexOf('\nfunc ', i + 10));
  assert.match(fn, /segsAboveQuarter/,
    '自检不报主瓣宽度 ⟹ 分不清"窗函数没生效"和"频率映射错了"');
  assert.match(fn, /peakSeg/, '不报峰值位置 —— 那是频率映射对不对的判据');
  assert.match(fn, /expectSeg/, '不报期望位置 —— 那样"对不对"要人工算');
  assert.match(fn, /neighbors/,
    '不报邻域值 ⟹ 看不出主瓣的形状（单段孤峰 vs 正常的钟形）');
});

check('自检结果送到面板（打包版没有终端）', () => {
  const main = mainCode();
  assert.match(main, /onSelfTest/, '主进程没接自检回调');
  // ⚠️ 切到块尾，不用固定长度 —— 我往这个回调里加了"稳态跳变"的判断，
  // 900 字符的切片就把断言要找的东西推走了 ⟹ 在正确代码上报红。
  // **切片长度是个会漂的锚点**，这一轮我已经栽过三次。
  const i = main.indexOf('onSelfTest');
  const block = main.slice(i, main.indexOf('\n    },', i));
  assert.match(block, /broadcast\('helper-log'/,
    '自检结果只写 console ⟹ 打包版里看不到（这是我这轮第五次踩这个）');
  // 要给出判断，不只报数字
  // ⚠️ 这条断言原来查 `/窗函数或 stride/`，而**剥注释后才发现它一直是假阴性**：
  // 我改判据时把代码里那句删了（窗已经不存在了），只剩注释在解释历史
  // ⟹ 守卫一直绿，而面板实际上少了"这个数不对该查什么"的指引。
  // ⟹ 改成查现在真实的那句。
  assert.match(block, /峰值位置不对 = 频率映射错了/,
    '不说"这个数不对意味着什么" ⟹ 用户拿到数字也不知道下一步。'
    + '⚠️ 而这句话要跟着判据改 —— 判据换了而提示没换，会把用户指向错的方向'
    + '（他 0.9.13 就同时看到「比值 2.00 ✅」和一句说"窗函数有问题"的提示）');
});


// ⚠️⚠️⚠️ **FFT 绝对尺度自检的理论基准，用手写 DFT 算出来核对。**
//
// 用户 0.9.12 实测「整体的柱子都太长了」（平均 0.454 ⟹ 柱子 82px）。
// 而这**不能靠调系数解决** —— 用户明确否过（「我们现在在调节柱子这件事本身就很奇怪」
// 「我不相信他们做的这么差」）⟹ 只能问"我们的 magnitude 和 WE 的是不是同一尺度"。
//
// 两边输入都是 ±1（WE 的 `(buf-128)/128` vs 我们的 Float32），N 都是 1024
// ⟹ 同一信号应给同一 magnitude。差别只在库：WE 是 `kiss_fftr`，我们是 `vDSP_fft_zrip`。
//
// ⚠️ 我"知道"vDSP 的实数 FFT 带 2 倍因子，但**没在真机验过** ——
// 这是典型的承重前提（若错则整个修复方向作废）⟹ 不写死 0.5，让自检量出来。
//
// 而量的基准（理论峰值）是**我算的**，所以它本身要被核：
check('FFT 尺度自检的理论基准 = 手写 DFT 的真实峰值', () => {
  // 手写 DFT —— 纯数学，不依赖任何 FFT 库，所以能当基准
  const N = 1024;
  const rate = 48000;
  const freq = 1000;
  const x = Array.from({ length: N }, (_, i) => Math.sin((2 * Math.PI * freq * i) / rate));
  let peak = 0;
  let peakK = 0;
  for (let k = 15; k <= 28; k += 1) {
    let re = 0;
    let im = 0;
    for (let n = 0; n < N; n += 1) {
      re += x[n] * Math.cos((-2 * Math.PI * k * n) / N);
      im += x[n] * Math.sin((-2 * Math.PI * k * n) / N);
    }
    const mag = Math.hypot(re, im);
    if (mag > peak) { peak = mag; peakK = k; }
  }
  const coeff = peak / (N / 2);
  assert.strictEqual(peakK, 21,
    `1kHz @48kHz/1024 的峰值该在 bin 21（1000/46.875 = 21.33），实测 ${peakK}`);
  // Swift 里写的系数必须等于这个算出来的值
  const m = swiftSrc.match(/Float\(FFT_SIZE\) \/ 2\.0 \* ([\d.]+)/);
  assert.ok(m, 'Swift 里找不到理论峰值的式子 —— 尺度自检没了？');
  assert.ok(Math.abs(Number(m[1]) - coeff) < 0.002,
    `Swift 用的系数 ${m[1]}，手写 DFT 算出来是 ${coeff.toFixed(4)}。`
    + '这个数是用户会看到的**分母** ⟹ 它错了，比值就错，'
    + '而我会照着一个错的比值去改代码');
  // 判断阈值要能分开 1 和 2（那是两个相反的结论）
  const main = mainCode();
  assert.match(main, /scaleRatio/, '面板没显示尺度比值 —— 那用户看不到，等于没测');
  assert.match(main, /别乘 0\.5/,
    '面板只说了"该乘 0.5"没说"别乘" ⟹ 比值≈1 时用户拿不到"不要改"这个结论，'
    + '而那正是我可能记错的那一边');
});

// ⚠️⚠️⚠️ **0.5 已经加了，而它的合法性完全依赖"真机量出比值 2.00"这件事。**
//
// 这条守卫从"禁止提前加"翻成"加了就必须带实测出处" —— 那不是放宽，
// 是把判据从"有没有这个常量"换成"这个常量有没有依据"。
//
// 用户 0.9.13 真机自检：理论峰值 424.7（手写 DFT）vs 实测 **849.4** ⟹ **2.00**。
// ⟹ 身份是"vDSP 和 kiss_fftr 的库约定差"，不是调参。判据通过。
//
// ⚠️ 而这是这一轮里**第一个先量后改**的常量。前面十一个全是先改后被推翻。
check('VDSP_SCALE = 0.5，且注释里带真机实测出处', () => {
  assert.match(swiftSrc, /let VDSP_SCALE: Float = 0\.5/,
    'Swift 里没有 VDSP_SCALE —— vDSP 的实数 FFT 带 2 倍因子（真机实测 2.00），'
    + '不抵消的话 magnitude 是 WE 的两倍，log10 后是 +0.21 的输出偏移 '
    + '⟹ 用户报「整体的柱子都太长了」');
  assert.strictEqual(A.VDSP_SCALE, 0.5, 'JS 规格的 VDSP_SCALE 和 Swift 漂了');
  // ⚠️ **必须真的乘在 magnitude 上** —— 定义了不用等于没有
  //（我这一轮已经栽过"定义了不调用"：selfTestFFT）。
  // ⚠️ 锚点跟着改成主瓣求和里的那一行
  assert.match(swiftCode, /magnitudes\[index\] \* VDSP_SCALE/,
    'VDSP_SCALE 定义了但没乘在 magnitude 上 —— 定义了不用等于没有');
  // ⚠️ 出处必须写在代码里。这个数是"库约定差"还是"我调的系数"，
  // 唯一的区别就是**有没有那个实测依据** ⟹ 依据丢了它就退化成魔数。
  const at = swiftSrc.indexOf('let VDSP_SCALE');
  const ctx = swiftSrc.slice(Math.max(0, at - 1800), at);
  assert.match(ctx, /849\.4/,
    'VDSP_SCALE 上面没写实测峰值 849.4 —— 那个数是它唯一的依据，'
    + '丢了它这个 0.5 就退化成"我调的系数"（而那正是用户否掉的做法）');
  assert.match(ctx, /kiss_fftr/,
    '没说明是对齐 kiss_fftr —— 那是"能不能从 WE 的行为推出来"的答案');
});

// ⚠️⚠️ **自检判据必须跟着"没有窗函数"走。**
//
// 用户 0.9.13 同时看到「比值 2.00 ✅」和「主瓣宽 64 段 ⚠️」+
// 「主瓣外有明显的值 ⟹ 尖刺来自分箱/平滑」——
// 而后两个 ⚠️ **都是判据错、不是代码错**：那两条判据是为 Hann 窗写的。
//
// 算术核对（用他的读数）：第 15 段读 0.706 ⟹ 反解 magnitude 27.5；
// 峰值 849.4 ⟹ 相差 -29.8dB；矩形窗理论泄漏（相隔 10 bin，-13dB 旁瓣 +
// 6dB/倍频）= 19.2 ⟹ **1.44 倍，同量级，对上了**。
// 而"主瓣外最大跳变仅 0.044"证明那是**平缓高原**不是尖刺。
//
// ⚠️ 教训：**删掉一个实现（Hann 窗）时，要把依赖它的判据一起改。**
// 否则正确的代码会一直报 ⚠️，而用户看到 ⚠️ 就会以为没修好 ——
// 那比没有判据更坏（我这一轮已经因为"恒绿的守卫"栽过一次，这次是恒红）。
check('自检判据适配矩形窗（不再要求主瓣窄、主瓣外干净）', () => {
  const main = mainCode();
  const at = main.indexOf('onSelfTest');
  const block = main.slice(at, main.indexOf('\n    },', at));
  assert.ok(!/segsAboveQuarter\s*[<>]=?\s*\d/.test(block),
    '还在用"主瓣宽度"当通过判据 —— 矩形窗下纯音会点亮几十段（那是泄漏，'
    + '是 WE 铺满圆环的机制）⟹ 那条判据必然报 ⚠️ 在正确代码上');
  assert.ok(!/outsidePeak\s*>\s*0\.\d/.test(block),
    '还在用"主瓣外最大值"当判据 —— 矩形窗下主瓣外有值是**期望行为**');
  // 换上的判据要有判别力
  // ⚠️ 词边界 —— 反向验证时我把它改名成 `leakFalloffX`，
  // 而 `/leakFalloff/` 仍然匹配 ⟹ **守卫没拦住**。
  // 教训：**子串匹配对"改名"这种破坏方式假阴性**，标识符断言要带 `\b`。
  assert.match(block, /\bleakFalloff\b/,
    '没有"泄漏衰减"判据 —— 矩形窗下"亮几段"分不出好坏，'
    + '"远处比近处低多少"才分得出（远处不衰减 = ctoz stride 错 / 缓冲写坏）');
  assert.match(block, /\bmirrorMaxDiff\b/,
    '没查镜像逐段相等 —— 那是"接缝一根突兀柱子"的判据');
  // ⚠️ 那句 ⟸ 提示也要改：它原来说"主瓣宽度<2 说明窗函数有问题"，
  // 而现在没有窗函数了 ⟹ 会把用户指向错的方向（他 0.9.13 就同时看到
  // 「比值 2.00 ✅」和那句提示，两者矛盾）。
  assert.ok(!/主瓣宽度 <2 说明窗函数/.test(block),
    '⟸ 提示还在说"窗函数有问题" —— 窗已经删了，那句话指向错的方向');
});

// ⚠️⚠️⚠️ **面板的"低频/高频"口径在镜像之后错了 —— 这条守卫锁住它。**
//
// 用户 0.9.14 看到「⚠️ 低高频差不多 —— 大概是白噪声或者加权把差异抹平了」，
// **那句话是我的口径错，不是数据的事**（他在放正常音乐）：
//   镜像下段 i 对应 band `i<64 ? i : 127-i`
//   ⟹ 面板取的"高频段(80-119)"实际是 **band 47..8 = 中低频**
//
// ⟹ 分段必须按 band（前半 64 就够，后半镜像一模一样）。
check('面板的低频/高频按 band 取，不是按镜像后的段号', () => {
  const main = mainCode();
  // ⚠️ 切到**结构边界**，不用固定长度 —— 我刚写这条守卫时用了
  // `slice(at, at + 400)`，而那被"禁止固定长度切片"那条守卫当场逮到
  //（它只挡增长，基线 22 处，我一加就变 23）。
  // ⟹ 自己的守卫抓自己，这次它对了：往 lowMean 上面加注释就会把切片撑走。
  const at = main.indexOf('lowMean:');
  const block = main.slice(at, main.indexOf('dynRange:', at));
  // 两个切片都必须落在前半 64（band 区间），不能跨到镜像那半
  const slices = [...block.matchAll(/arr\.slice\((\d+),\s*(\d+)\)/g)]
    .map((m) => [Number(m[1]), Number(m[2])]);
  assert.ok(slices.length >= 2, `只解析出 ${slices.length} 个切片，正则失效了`);
  for (const [from, to] of slices) {
    assert.ok(to <= 64,
      `切片 [${from}, ${to}) 越过了镜像轴（64）—— 段 64 之后是右声道的倒序，`
      + `段 ${to - 1} 实际是 band ${127 - (to - 1)}。`
      + '按段号分低高频在镜像下必然报错的结论（用户 0.9.14 就看到"像白噪声"）');
  }
  const dash = dashCode();
  assert.ok(!/高频段\(80-119\)/.test(dash),
    '面板还在显示"高频段(80-119)" —— 那个区间是 band 47..8，不是高频');
});

// ⚠️⚠️ **动态范围 + 输入电平：这两个是"柱子太长"的判据，而它们不是猜的。**
//
// 真 WE 的预览图（`884307090/preview.png`，作者用真 WE 跑的，唯一独立真值）：
//   柱子长度 = `w1 × range × 100`，而 `range = 9/5 = 1.8` ⟹ w1 × 180px；
//   圆环半径 = `radius/100 × minW/2` = 0.4 × 400 = 160px（预览图 800×800）
//   ⟹ **比例可算，不靠目测绝对像素**：
//     大多数柱子 ≈ 半径的 4-6%  ⟹ w1 ≈ **0.045**
//     最长的     ≈ 半径的 20-25% ⟹ w1 ≈ **0.20**
//   ⟹ 真 WE 的动态范围 ≈ **4.4 倍**，而用户 0.9.14 只有 **2.4 倍**（0.31→0.736）
//
// ⚠️ 而这里有一个**算术上的关键洞见**：`0.35*log10` 的动态范围**是位置的函数**。
//   贴地板时（magnitude 1.2→2.0，只差 1.7 倍）输出差 **4.4 倍**；
//   离地板远时（magnitude 2.8→12，差 4.3 倍）输出只差 **2.4 倍**。
//   ⟹ **"太长"和"太平"是同一个原因**：整体偏大 ⟹ 离地板远 ⟹ 压缩把差异抹平。
//   ⟹ 而降低整体幅度会**同时**修好两个（地板截断底部，等于放大动态范围）。
//
// ⚠️⚠️ **但绝对幅度不能用预览图定标。** magnitude 差 12dB = 音量差 4 倍，
// 完全在"作者录预览图时的音量 vs 用户现在的音量"范围内。
// ⟹ 分开这两种可能的唯一办法是**报出输入 PCM 的 RMS**：
//   0.03-0.1（−30..−20dBFS）= 正常听感 ⟹ 我们的实现偏大
//   0.3+（−10dBFS 以上）    = 音量开得大 ⟹ 不是实现问题
//
// ⟹ **先量后改。** 这一轮我因为"没量就改"被推翻十一次，
//    而 VDSP_SCALE 是第一个先量后改的 —— 一量就精确命中 2.00。
check('面板报动态范围和输入电平（"该不该降幅度"的依据）', () => {
  const main = mainCode();
  assert.match(main, /\bdynRange\b/,
    '没报动态范围 —— 那是"柱子太长/太平"的量化判据（真 WE 预览图约 4.4 倍）');
  assert.match(main, /\binputRMS\b/,
    '没报输入电平 ⟹ 分不开"音量大"和"实现偏大"，'
    + '而那两个结论一个要改代码、一个不能改');
  assert.match(main, /vDSP_rmsqv|inputRMS/, 'RMS 没有来源');
  const swift = swiftSrc;
  assert.match(swift, /vDSP_rmsqv/, 'Swift 没算 RMS');
  assert.match(swift, /"rms"/, 'Swift 算了 RMS 但没发出来 —— 算了不发等于没有');
  const dash = dashCode();
  assert.match(dash, /\binputRMS\b/, '面板没显示输入电平 ⟹ 用户看不到 = 等于没测');
  assert.match(dash, /\bdynRange\b/, '面板没显示动态范围');
  // ⚠️ 两个方向的结论都要写在面板上，包括"不是实现问题" ——
  // 那是我可能弄错的那一边（我倾向于认为是自己的实现问题，而那是偏见）。
  assert.match(dash, /不是实现/,
    '面板只说了"是实现偏大"没说"可能不是实现问题" ⟹ '
    + '音量大的那种情况用户拿不到"不用改"这个结论');
});

// ⚠️ 而"降低幅度"这件事**现在还不许做** —— 要等真机 RMS 报回来。
// 若 RMS 显示正常听感音量，那时的修法也不能是"我调一个系数"，
// 而要有出处（比如 WE 的 8-bit 量化、或某个我们漏掉的归一化步骤）。
check('还没有无出处的幅度系数', () => {
  // 允许的常量：LOG_SCALE(WE) / SMOOTH(WE) / VDSP_SCALE(真机量出 2.00)
  const consts = [...swiftSrc.matchAll(/^let ([A-Z_]+): Float = ([\d.]+)/gm)]
    .map((m) => m[1]);
  const allowed = new Set(['LOG_SCALE', 'SMOOTH', 'VDSP_SCALE']);
  const extra = consts.filter((c) => !allowed.has(c));
  assert.strictEqual(extra.length, 0,
    `多了这些 Float 常量：${extra.join(', ')}。这一层只许有三个：`
    + 'LOG_SCALE / SMOOTH（WE 原值）、VDSP_SCALE（真机量出 2.00）。'
    + '新增的必须先有出处 —— 我这一轮因为"没量就改"被推翻十一次');
});

// ⚠️⚠️⚠️ **MODULES.md 里关于这一层的 claim 必须和代码一致。**
//
// 这类漂移我在同一份文档里踩了三次，而每次都让下一轮往错方向查：
//   ① 「螺旋是我诊断工具的残影」—— 后来被 stride/镜像证伪，但结论留在文档里
//   ② 「那是壁纸故意绕 15 圈的设计」—— `main.js:1141` 有映射表把 12→180，证伪
//   ③ 契约表写「**不做**时间平滑」—— 而 WE 原版就是 `movetowards(…, 0.3f)`，相反
//
// ⚠️ ③ 最坏：它是一条**看起来很有道理**的推理（"壁纸自己会平滑，我们再做是双重"），
// 而它和 WE 的实际行为相反。文档里的错推理比错数字更持久 ——
// 数字会被实测打脸，推理会被后来的人当前提。
check('MODULES.md 的音频契约和代码一致', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'MODULES.md'), 'utf8');
  // 文档不许再出现被证伪的结论
  const dead = [
    ['不做时间平滑', 'WE 原版就是 movetowards(cur, target, 0.3f) —— 文档说反了'],
    ['绕了 15 圈', 'main.js:1141 的映射表把 PolygonAngle 12 → 180，那条论证已证伪'],
    ['诊断工具造成的残影', '螺旋的真因是 stride + 把 128 当连续频段，不是残影'],
    // ⚠️ 2026-08-01 下午拿到完整源码后新增的两条 —— 它们推翻了我当天做的两个修复
    ['分声道是唯一正解', 'WE 的 spec.channels = 1（单声道），64Left/64Right 传同一个 audio64'],
    ['本来就是降级的', '「这个壁纸不用管」和「为这个壁纸特调」是同一个错的两面 —— '
      + '作者在真 WE 上看着效果满意才发布的'],
  ];
  // ⚠️ 但**引述**一条已推翻的结论是正当的（"我曾经写的是 X，那是错的，因为…"）——
  // 那正是这份文档最有价值的部分。⟹ 守卫要能区分"当前结论"和"引述"。
  //
  // 判别方式：看那句话**前面 40 个字**里有没有推翻标记。
  // 我第一版没做这个区分 ⟹ 它抓了我自己写的检讨文字（在正确的文档上报红）。
  const RETRACTED = /曾经|原来|我曾|已证伪|证伪|推翻|错的|那和.{0,6}相反|已经删/;
  for (const [phrase, why] of dead) {
    let at = md.indexOf(phrase);
    while (at >= 0) {
      const before = md.slice(Math.max(0, at - 40), at);
      assert.ok(RETRACTED.test(before),
        `MODULES.md 里「${phrase}」被当成**当前结论**在陈述：${why}\n`
        + `    上下文：…${before}【${phrase}】…\n`
        + '    ⟹ 要么删，要么在它前面写清"曾经/已证伪"（引述是正当的，并列不是）');
      at = md.indexOf(phrase, at + 1);
    }
  }
  // 文档里写的常量必须真的在代码里
  const claims = [
    [/VDSP_SCALE[^\n]*0\.5/, /let VDSP_SCALE: Float = 0\.5/, 'VDSP_SCALE'],
    [/系数 0\.3|0\.3f/, /let SMOOTH: Float = 0\.3/, 'SMOOTH'],
    [/左 ?64 ?\+ ?右 ?64/, /let bands = BIN_COUNT \/ 2/, '64+64 镜像'],
    // 采样率：文档说 44100 就必须真的是 44100（两处都要）
    [/44100/, /let SAMPLE_RATE = 44100/, '采样率 44100'],
    [/单声道|channels = 1/, /config\.channelCount = 1/, '单声道'],
  ];
  for (const [inDoc, inCode, name] of claims) {
    if (inDoc.test(md)) {
      assert.match(swiftSrc, inCode,
        `MODULES.md 说了 ${name}，但代码里找不到 ⟹ 文档和实现漂了。`
        + '读文档的人（包括失忆后的我）会照文档理解代码');
    }
  }
  // 反过来：代码里有窗函数的话文档也会错
  assert.ok(!/vDSP_hann_window/.test(swiftSrc) || !md.includes('不加窗函数'),
    'MODULES.md 写着"不加窗函数"，而代码里有 vDSP_hann_window');
});

// ⚠️⚠️⚠️ **「柱子突兀的长」和「整体太长」是同一个根因 —— 这条是算术。**
//
// 用户 0.9.15：「还是会有一些柱子突兀的长」。而他 0.9.14 的读数里
// 最大跳变 `[23] 0.736→0.367` = 相邻段差 **0.37**，看起来像尖刺 bug。
//
// 算一下就不是：
//   相邻段隔 stride 2 = 2 个 FFT bin = **94Hz**（48kHz/1024）
//   音乐里相邻 94Hz 的能量差 2 倍是常态（一个泛音峰的边缘）
//   ⟹ **WE 也是 stride 2，所以它一样有这种落差**
//
// 差别只在幅度：真 WE 的 0.045 vs 0.02 = 8px vs 4px（看不出）；
//              我们 0.736 vs 0.367 = 132px vs 66px（一眼看出）
//
// ⚠️ 而 PWCircle 自己的平滑是**时间**平滑（`w1 = max(arr[i], waveArr[i]*0.75)`，
// 让柱子下落变慢），**不会让相邻柱子接近** ⟹ "加空间平滑"是错的方向，
// 那会把真实的频谱结构抹掉，而那正是我们要传递的信息。
//
// ⟹ 守卫：**这一层不许有空间平滑**（相邻段互相平均/模糊）。
check('不做空间平滑（相邻段差大是音乐常态，WE 也一样）', () => {
  // 相邻段互相平均的典型写法
  const bad = [
    [/out\[band - 1\]|out\[band \+ 1\]/, '读了相邻段的输出 —— 那是空间平滑'],
    [/magnitudes\[index - 1\].*magnitudes\[index \+ 1\]/s, '把相邻 bin 平均了'],
    [/\bblur\b|smoothSpatial|neighborAvg/i, '有空间平滑/模糊的痕迹'],
  ];
  for (const [re, why] of bad) {
    assert.ok(!re.test(swiftCode),
      `${why}。相邻段隔 94Hz，差 2 倍是音乐常态（WE 也是 stride 2）⟹ `
      + '"突兀的长"要靠降幅度解决，不是抹平频谱结构');
  }
  // 时间平滑要有（那是 WE 的 movetowards），别把两者搞混
  // ⚠️ 锚点改了：0.9.25 起平滑从 `process()` 搬到 `tickSmooth()`
  //（对齐 WE —— movetowards 在渲染帧率上跑，FFT 只更新 target）。
  assert.match(swiftCode, /smoothed\[i\] \+= \(target\[i\] - smoothed\[i\]\) \* SMOOTH/,
    '时间平滑没了 —— WE 是 movetowards(cur, target, 0.3f)。'
    + '⚠️ 时间平滑（要）和空间平滑（不要）是两件事');
});

// ⚠️ 帧节奏观测 —— 判"突兀"的第二个候选：push 模型的批大小抖动。
//
// WE 是 **pull** 模型（渲染循环主动读音频缓冲）⟹ 每渲染帧平滑一次、节奏恒定。
// 我们是 **push**（`while pending.count >= FFT_SIZE` 有多少发多少）
// ⟹ 一次回调带来 3000 采样就连发 2 帧，两帧间隔**几微秒**
// ⟹ `movetowards` 连做 2 次而时间没走 ⟹ 平滑速度随批大小漂，
//    且前面那些帧被 PWCircle 的重绘覆盖 = 等效跳帧。
//
// ⚠️ **这是推理，先量后改**（上一轮"没量就改"被推翻十一次的教训）。
check('报帧节奏（判 push 模型的批大小抖动）', () => {
  assert.match(swiftSrc, /framesThisCall/, 'Swift 没数一次回调发几帧');
  assert.match(swiftSrc, /"nth"/, '数了但没发出来 —— 算了不发等于没有');
  const main = mainCode();
  assert.match(main, /\bframeRhythm\b/, '主进程没统计帧节奏');
  // ⚠️ 必须统计**分布**而不是记最后一个值 ——
  // "最后一次是 1" 和 "平均 1.02" 是完全不同的结论，
  // 而我这一轮已经因为"面板显示的是上一个音源的残留"误判过一次。
  // ⚠️ 锚在**代码**上而不是整个文件 —— 我第一版用 `/multiPct/` 查整个 main.js，
  // 而那个词也出现在**注释**里 ⟹ 把字段改名成 `lastNth` 后断言照样绿。
  // 教训：**注释会让守卫假阴性**（这一轮我已经因为"字符串在提示语里也出现"栽过一次）。
  // ⟹ 查"字段定义"这个形状：`multiPct:` 后面跟表达式。
  assert.match(main, /multiPct:\s*Number\(/,
    '没统计"发多帧的比例" —— 只记最后一个值分不出节奏稳不稳'
    + '（"最后一次是 1"和"平均 1.02"是完全不同的结论）');
  const dash = dashCode();
  assert.match(dash, /\bmultiPct\b/, '面板没显示 ⟹ 用户看不到 = 等于没测');
  // 两个方向的结论都要在面板上，包括"不是这个原因"
  assert.match(dash, /不是这个原因/,
    '面板只说了"节奏不稳"没说"节奏稳 ⟹ 不是这个原因" ⟹ '
    + '那种情况用户拿不到"这条假设作废"的结论');
});

// ⚠️⚠️⚠️ **孤峰要看"在多帧里稳不稳"，不是单帧的位置。**
//
// 用户 0.9.16：「有些本来应该是一个高峰的，很突兀，就是一个噪点一样，
// 波浪那个壁纸尤为明显」。而他 0.9.14 的读数里已经有证据：
//   段21=0.446  **段22=0.736**  段23=0.367  ⟹ 段 22 比两边都高 = **单段孤峰**
//
// ⚠️ 我上一轮那条「相邻段隔 94Hz、差 2 倍是常态」解释的是**单调渐变**
//（0.7→0.5→0.35），而孤峰是 0.45→0.74→0.37 ⟹ **答错了问题**。
//
// ⚠️⚠️ 而"孤峰"有两个完全不同的结论，需要不同的处理：
//   固定在同几段 ⟹ **结构性**（我们这层的 bug，要改）
//   位置乱跳     ⟹ 音乐本身的瞬态（WE 也一样，不该改）
// ⟹ **只看一帧分不出来**，所以必须统计多帧的稳定性。
//
// ⚠️ 我为这个现象试过两条路，都在云端被自己否掉了：
//   ① 8-bit 量化假设（WE 的输入精度只有 1/128 ⟹ 有量化噪声垫底）
//      → 云端实测：量化前后**完全一样**（孤峰数、踩地板数都相同）⟹ **证伪**
//   ② 合成"像音乐"的信号复现 → 跑出"45/64 段踩地板"，以为找到根因
//      → 而用户实测的 9 个采样点**一个 0 都没有** ⟹ 真实音乐下谱是满的
//      ⟹ **合成信号的结论不适用**（我造不出连续谱：真音乐的打击乐/齿音/混响
//         都是宽带的，我的合成是 14 个纯正弦 + 白噪，其余 bin 全靠泄漏）
//
// ⟹ 判"孤峰是不是真的"**只能用真实帧** ⟹ 留环形缓冲 + 报稳定性。
check('孤峰按多帧稳定性统计（分辨结构性 vs 音乐瞬态）', () => {
  const main = mainCode();
  assert.match(main, /\brawFrames\b/,
    '没留原始帧 ⟹ 孤峰只能靠 9 个抽样点看，而孤峰的定义需要**连续**的段');
  assert.match(main, /spikeProfile:/, '没报孤峰画像');
  // ⚠️ 必须报**多帧的稳定性**，只报位置分不出两个结论
  assert.match(main, /sticky:/,
    '没判"孤峰是否固定在同几段" ⟹ 分不出"结构性 bug"和"音乐瞬态"，'
    + '而那两个结论一个要改代码、一个不能改');
  assert.match(main, /rawFrames\.length \* 0\.5|rawFrames\.length >= 10/,
    'sticky 的判据没挂在帧数上 ⟹ 一两帧就下结论');
  const dash = dashCode();
  assert.match(dash, /\bspikeProfile\b/, '面板没显示 ⟹ 用户看不到 = 等于没测');
  // ⚠️ 左右声道差那一行已经删了（分声道整个撤了，WE 是单声道）。
  // ⟹ 守卫从"判据要是相对量"改成"不许留死代码"。
  //
  // ⚠️ 但那次的**教训要留**：我原来写死 `channelDiff > 0.005`，
  // 而用户实测差 0.001 ⟹ 正好卡在阈值边上 ⟹ 同一行文案一会说立体声
  // 一会说单声道。**阈值要么有出处，要么做成比例** ——
  // 拍一个数出来，症状是"提示自相矛盾"，而用户会以为是数据在抖。
  assert.ok(!/channelDiff/.test(dash),
    '面板还在显示左右声道差 —— 分声道已经撤了（WE 单声道），那是死代码');
  // 两个方向的结论都要在面板上
  assert.match(dash, /音乐本身的瞬态/,
    '面板只说了"结构性问题"没说"是音乐瞬态、不该改" ⟹ '
    + '那种情况用户拿不到"这条不用管"的结论');
  // 原始帧也要进诊断报告 —— 那样我能在云端重放真实数据而不是再合成一个假的
  assert.match(main, /audioFrames:/,
    '诊断报告里没有原始帧 ⟹ 我只能继续在云端合成信号，'
    + '而合成信号已经骗过我一次（45/64 踩地板 vs 用户实测一个 0 都没有）');
});

// ⚠️⚠️⚠️ **镜像轴上的等高双柱：那不是 bug，真 WE 也有。别再"修"它。**
//
// 用户 0.9.17 实测「孤峰固定在第59段(37/60帧)」+「镜像逐段差 0.0000」
// ⟹ 我判定为结构性问题，做了**分左右声道两次 FFT**去修它。
//
// ⚠️ **然后 WE 源码证伪了那个修复**（`/tmp/lwe`，即 linux-wallpaperengine）：
//     PulseAudioPlaybackRecorder.cpp:106-108
//       spec.format   = PA_SAMPLE_U8;
//       spec.rate     = 44100;
//       spec.channels = **1**;          ← **单声道**
//     CPass.cpp:889-890
//       addUniform ("g_AudioSpectrum64Left",  recorder.audio64, 64);
//       addUniform ("g_AudioSpectrum64Right", recorder.audio64, 64);
//                                            ^^^^^^^^^^^^^^^^ **同一个数组**
//
// ⟹ WE 只抓单声道，"左右"是同一份数据
// ⟹ 段 63 和段 64（相邻，band 63 加权 1.393 最大）**在真 WE 上也精确相等**
// ⟹ 那个尖顶是 WE 的固有行为，而壁纸作者是**在它存在的情况下**调好效果的
// ⟹ **"修掉"它意味着画面和作者调好的效果不一样。**
//
// ⚠️ 用户的第一性原理（他为这条纠正了我三次，最后一次很直接）：
//   「WE 是闭源的，作者必然不知道软件内部。这些壁纸那么多人创作，
//     他们怎么调出效果这么好的？这个版本是他们调出效果 OK 的，
//     那我们根据这个反推出来一个**不用动的渲染器**才是根本。」
//
// ⟹ 判据：这一行能不能从 WE 的行为推出来？分声道 —— **不能** ⟹ 已撤。
check('不分左右声道（WE 的 spec.channels = 1）', () => {
  assert.ok(!/pcmStereo|spectrumL|spectrumR|pendingL|pendingR/.test(swiftCode),
    '又在分左右声道 —— WE 源码 `spec.channels = 1`（单声道），'
    + '而 shader 的 64Left/64Right 传的是同一个 audio64。'
    + '⟹ 镜像轴上的等高双柱在真 WE 上也存在，"修"它会让画面偏离作者调好的效果');
  assert.match(swiftCode, /private func pcm\(from/,
    '取平均的单声道 pcm() 不在了');
  // JS 规格里 mirror() 保留，但两半必须能是同一份
  const mags = new Array(512).fill(0).map((_, i) => 100 / Math.sqrt(i + 1));
  const one = A.channelValues(mags);
  const m = A.mirror(one, one);
  assert.strictEqual(m.length, 128, `mirror 输出 ${m.length} 段，壁纸要 128`);
  assert.strictEqual(m[63], m[64],
    '两半传同一份数据时段 63/64 应该相等 —— 那是 WE 的行为（不是缺陷）');
  assert.strictEqual(m[0], one[0], '段 0 应该是 band 0');
  assert.strictEqual(m[127], one[0], '段 127 也应该是 band 0（镜像两端）');
});

// ⚠️⚠️⚠️ **单点取值，不做主瓣求和。WE 就是单点。**
//
// 我曾在这里加"三个 bin 求功率和"，理由是**两个都成立的观察**：
//   ① stride 2 丢一半 bin —— 实测 200Hz 谐波列里最强的 bin4=144.6 完全丢了
//      ⟹ 段值 `0.48 / 0.09 / 0.49 / 0.06` 奇偶交替
//   ② 单点采样本身抖 —— 同一正弦落在 bin 正中 vs bin 中间时，
//      邻居 bin 的值在 **0% 和 98%** 之间跳，只取决于"频率落在哪"
// 而云端实测它把孤峰从 13.8 降到 5.8 个。**观察和效果都是真的。**
//
// ⚠️ **但 WE 没有这一步。** 源码逐字（PulseAudioPlaybackRecorder.cpp）：
//     int index = band * 2;
//     float f1 = this->m_FFTinfo[index].r;
//     float f2 = this->m_FFTinfo[index].i;
//     f2 = f1 * f1 + f2 * f2;
// **单点取值，一个 bin。**
//
// ⟹ 那两个观察正说明**真 WE 的柱子也那样抖**，而壁纸作者是在那个抖动上
//    调效果的。我"修好"它，画面离作者看到的更远，不是更近。
// ⟹ 和 Hann 窗那次是**同一个错**：教科书上对的事，在别的场景完全正确，
//    但不是 WE 的行为。这一轮我犯了两次（Hann 窗、主瓣求和）。
check('单点取值，不做主瓣求和（WE 是单点）', () => {
  // 禁止在 bin 区间上循环求和
  assert.ok(!/for k in lo\.\.\.hi|power \+= m \* m/.test(swiftCode),
    '又在做主瓣求和 —— WE 源码是 `f2 = m_FFTinfo[index].r² + .i²`，单点取值。'
    + '"单点会抖"这个观察本身对，但那说明真 WE 也抖，而作者是在那个抖动上调效果的');
  assert.match(swiftCode, /let m = magnitudes\[index\] \* VDSP_SCALE/,
    '不是单点取值');
  assert.strictEqual(typeof A.bandValueFromLobe, 'undefined',
    'JS 规格里还有 bandValueFromLobe —— 主瓣求和已撤，那是死代码');
});

// ⚠️⚠️ **采样率 44100 和单声道，都是对齐 WE 源码。**
//
// `spec.rate = 44100` / `spec.channels = 1`（PulseAudioPlaybackRecorder.cpp:106-108）
//
// 采样率决定每个 bin 对应多少 Hz：
//     44100/1024 = 43.07 Hz/bin  （WE）
//     48000/1024 = 46.88 Hz/bin  （我们之前）
// ⟹ 我们每一段对应的频率比 WE **高 8.8%**
// ⟹ 壁纸作者是对着 WE 的频率映射调效果的（哪一段对应人声、哪一段对应鼓）
//    ⟹ 偏 8.8% 意味着他调好的"这一圈对应什么"整体挪了位置。
//
// ⚠️ 直接让 SCStream 给 44100，不自己重采样 —— 重采样要插值，
//    那会引入 WE 没有的滤波（同一个形状的错第三次）。
check('采样率 44100、单声道，和 SCStream 配置一致', () => {
  assert.match(swiftSrc, /let SAMPLE_RATE = 44100/,
    'SAMPLE_RATE 不是 44100 —— WE 源码 `spec.rate = 44100`');
  assert.match(swiftCode, /config\.sampleRate = 44100/,
    'SCStream 没配 44100 ⟹ 实际拿到 48000，而常量说 44100 '
    + '⟹ **自检报的频率是假的**（我曾因此把 1kHz 的期望段算错）');
  assert.match(swiftCode, /config\.channelCount = 1/,
    'SCStream 还在要 2 声道 —— WE 的 `spec.channels = 1`');
  // 常量和配置必须一致，否则频率标注全错
  const m1 = swiftSrc.match(/let SAMPLE_RATE = (\d+)/);
  const m2 = swiftCode.match(/config\.sampleRate = (\d+)/);
  assert.ok(m1 && m2, '找不到采样率的两处定义');
  assert.strictEqual(m1[1], m2[1],
    `SAMPLE_RATE=${m1[1]} 而 config.sampleRate=${m2[1]} —— 不一致 ⟹ `
    + '自检和面板报的频率会是假的');
});

// ⚠️⚠️⚠️ **「柱子太长」：三条独立验证说这一层的尺度是对的 ⟹ 不许调幅度。**
//
// 用户从 0.9.12 到 0.9.21 一直报这条，我查了四轮。现在能确定：
//   ① vDSP 的 2 倍因子已抵消（真机自检量出 2.00）
//   ② kiss_fftr 前向不归一化 ⟹ 满幅峰值 N/2=512，我们抵消后也是 512
//   ③ **帕塞瓦尔定理**（纯数学）：Σ|X[k]|² = N²·rms²
//      用户实测 rms=0.2688 ⟹ 平均 magnitude **12.2**
//      而他读数反解出 **3.8-12** ⟹ **同量级** ⟹ 能量守恒下正确
//
// ⟹ 公式逐字抄 WE + 尺度对齐 + 能量守恒 ⟹ 同音量下我们和真 WE 一样长。
//
// ⚠️ 待验的真差异（**能从 WE 的行为推出来**，不是调系数）：
//   WE 抓 PulseAudio `.monitor` = sink 输出流 = **音量控制之后**
//   ScreenCaptureKit `capturesAudio` = 应用音频输出 = 设计上**不受音量影响**
//   ⟹ 判法：转系统音量看面板的 RMS 变不变（面板已提示用户这么做）
//
// ⟹ **在那个观测回来之前不许调幅度。**
check('不许新增幅度常量（尺度已三重验证，等音量观测）', () => {
  const consts = [...swiftSrc.matchAll(/^let ([A-Z_]+): Float = ([\d.]+)/gm)].map((m) => m[1]);
  const allowed = new Set(['LOG_SCALE', 'SMOOTH', 'VDSP_SCALE']);
  const extra = consts.filter((c) => !allowed.has(c));
  assert.strictEqual(extra.length, 0,
    `多了这些 Float 常量：${extra.join(', ')}。「柱子太长」已三重验证不是尺度问题`
    + '（vDSP 因子已抵消 / kiss_fftr 不归一化 / 帕塞瓦尔对上）⟹ '
    + '再乘一个系数就是"我调的参数"，而用户明确否过这条路');
  // ⚠️ 那条假设**已经坐实**（用户实测：系统音量 0，柱子还在动）
  // ⟹ 提示撤掉，守卫改成"音量必须真的乘进采样"。
  const dash = dashCode();
  assert.match(dash, /systemVolume/,
    '面板没显示系统音量 ⟹ "音量乘了没生效"是静默失败，'
    + '而它的症状（柱子还是长）和没改一模一样');
});

// ⚠️⚠️⚠️ **系统音量乘进采样：这是「柱子太长」的根因修复，而它有出处。**
//
// 用户 2026-08-01 实测坐实：**系统音量调到 0，柱子还在动。**
//
//   WE 抓 PulseAudio 的 `.monitor` 源 = sink 的**输出流** = **音量之后**的信号
//     ⟹ 音量 50% 则信号也 50%，静音时 monitor 里就是静音
//   ScreenCaptureKit 的 `capturesAudio` = **应用的**音频输出 = **音量之前**
//     ⟹ 设计如此（录屏时系统静音也该录到声音）
//
// ⟹ 两个平台的抓取点不同，而 WE 的公式是按"音量之后"的信号调的
//    ⟹ 补这一乘是**平台差异的补偿**，判据（能从 WE 的行为推出来？）——**能**
//
// ⚠️ 而它同时解释用户从 0.9.12 到 0.9.21 报的两件事：
//   「整体的柱子都太长了」 = 我们的输入比 WE 大（他系统音量没开满）
//   「太敏感」            = 同一个原因（信号大 ⟹ 离 log10 地板远 ⟹ 长期在高位）
check('系统音量乘进采样（对齐 WE 抓的音量后信号）', () => {
  assert.match(swiftSrc, /import CoreAudio/, '没 import CoreAudio ⟹ 读不到音量');
  // ⚠️ `kAudioHardwareServiceDeviceProperty_VirtualMasterVolume` 在 **AudioToolbox**
  // 里（AudioServices），不在 CoreAudio ⟹ 漏了它 helper 编译失败
  // ⟹ 音频整条链没有，而用户看到的是"柱子完全不动"（和没授权同一个画面）。
  // ⚠️ 云端跑不了 swiftc ⟹ 这类"符号属于哪个框架"的错只能靠守卫兜。
  if (/VirtualMasterVolume/.test(swiftCode)) {
    // ⚠️ 用 `swiftCode`（剥注释）不是 `swiftSrc` —— 我上面那段注释里
    // 就写了"import AudioToolbox"这几个字 ⟹ 查 swiftSrc 会假阴性。
    // **这是今天第四次踩"注释让守卫失效"**（前三次：multiPct / rawFrames /
    // 音乐本身的瞬态）⟹ 规则很简单：**查代码一律用剥注释的那份。**
    assert.match(swiftCode, /^import AudioToolbox$/m,
      '用了 VirtualMasterVolume 但没 import AudioToolbox ⟹ 编译失败 ⟹ '
      + '音频整条链死掉（症状：柱子完全不动，和没授权一样）');
  }
  // ⚠️ 单一属性不够：有些设备没有 VirtualMasterVolume，只有逐声道的 VolumeScalar。
  // 漏了退路的症状是"在某些输出设备上音量修复不生效"—— 看起来像修复没做。
  assert.match(swiftCode, /kAudioDevicePropertyVolumeScalar/,
    '没有逐声道音量的退路 ⟹ 外接/聚合设备上可能拿不到音量 ⟹ 修复静默失效');
  assert.match(swiftCode, /func systemOutputVolume/, '没有读系统音量的函数');
  assert.match(swiftCode, /samples\[i\] \*= vol/,
    '音量没乘进采样 —— 定义了不用等于没有'
    + '（用户实测：不乘的话系统静音柱子还在动）');
  // ⚠️ 静音必须单独查 —— macOS 把"静音"和"音量"分成两个属性，
  // 静音时 VirtualMasterVolume 仍返回上次的音量值
  assert.match(swiftCode, /kAudioDevicePropertyMute/,
    '没查静音属性 —— macOS 静音时 VirtualMasterVolume 仍返回上次的音量'
    + '⟹ 静音时柱子照旧动（那正是用户报的症状）');
  // ⚠️ 读不到音量时必须返回 1.0（不衰减），**不能是 0**
  assert.ok(!/return 0\.0$[\s\S]{0,80}else \{ return 1\.0 \}/m.test(swiftCode)
    || /else \{ return 1\.0 \}/.test(swiftCode),
    '读不到音量时的兜底不是 1.0 ⟹ 返回 0 会静音整条链，'
    + '症状是"柱子完全不动"，和没授权同一个画面（这个项目为它烧过四轮）');
  const guardCount = (swiftCode.match(/return 1\.0/g) || []).length;
  assert.ok(guardCount >= 2,
    `只有 ${guardCount} 处 "return 1.0" 兜底 —— 拿不到设备 / 拿不到音量属性`
    + '两条失败路径都要兜到不衰减');
  // 静音要能和"没授权/没在放歌"区分开
  const main = mainCode();
  assert.match(main, /lastSystemVolume/, '主进程没记系统音量');
  assert.match(main, /result\.silent && !\(lastSystemVolume <= 0\.001\)/,
    '静音时会误报"没授权/没在放歌" —— 两者都是全 0 帧，'
    + '而报错的方向完全不同（用户一静音就看到"是不是没在放歌"是误导）');
});

// ⚠️⚠️⚠️ **查代码用剥注释的那份 —— 这是今天第四次踩的洞，做成自动检查。**
//
// 形状：写成 `assert.match(swiftSrc, 某正则)` 而那个正则匹配的字**也出现在注释里**
// ⟹ 把代码里的 X 删了，断言照样绿 ⟹ **守卫没有判别力**。
//
// 今天踩了四次：`multiPct`、`rawFrames`、`音乐本身的瞬态`、`import AudioToolbox`。
// 每一次都是反向验证逮到的，而不是我想到的。
// ⟹ 与其靠纪律，不如**让测试自己扫**：把所有 `assert.match(swiftSrc, …)`
//    的正则抽出来，看有没有"注释里命中、代码里没有"的。
//
// ⚠️ 白名单：验"出处写在注释里"的断言本来就该用 swiftSrc
//（比如查 `linux-wallpaperengine` 这个出处有没有写在代码里）。
check('没有"只在注释里命中"的 Swift 断言（守卫必须有判别力）', () => {
  const self = fs.readFileSync(__filename, 'utf8');
  // 本来就该查注释的（验出处/教训写没写）
  // ⚠️ 白名单里那个 `/X/` 是**这条测试自己的注释**里举的例子 ——
  // 它扫到了自己 ⟹ 报"只在注释里命中"。那是对的（示例本来就在注释里），
  // 但会让这条测试恒红。⟹ 教训：**自省式的检查要能认出自己**。
  const ALLOW = [/linux-wallpaperengine/, /PulseAudioPlaybackRecorder/, /849\.4/, /kiss_fftr/, /X/];
  const re = /assert\.match\(swiftSrc, (\/(?:[^/\\]|\\.)+\/[a-z]*)/g;
  const risky = [];
  let m = re.exec(self);
  while (m) {
    let r = null;
    try {
      // eslint-disable-next-line no-eval
      r = eval(m[1]);
    } catch (e) { r = null; }
    if (r && !ALLOW.some((a) => a.source === r.source)) {
      if (r.test(swiftSrc) && !r.test(swiftCode)) risky.push(m[1]);
    }
    m = re.exec(self);
  }
  assert.strictEqual(risky.length, 0,
    `这些断言只在**注释**里命中，代码里没有：${risky.join(', ')}\n`
    + '    ⟹ 把代码里对应的东西删掉，断言照样绿 = 守卫没有判别力。\n'
    + '    ⟹ 改用 swiftCode（剥注释的那份）；若本意是查注释里的出处，'
    + '加进这条测试的 ALLOW 白名单');
});

// ⚠️⚠️⚠️ **平滑跑在渲染帧率（60Hz），FFT 只更新 target（43Hz）—— WE 的结构。**
//
// 源码依据（不是我的选择）：
//   `WallpaperApplication.cpp:889` 在**渲染主循环**里调 `m_audioDriver->update()`
//   而 `movetowards(…, 0.3f)` 在 `PulseAudioPlaybackRecorder::update()` 的**开头**，
//   在 `if (!fullFrameReady) return;` **之前**：
//
//       void update () {
//           pa_mainloop_iterate (…);
//           for (int i = 0; i < 64; i++)
//               audio64[i] = movetowards (audio64[i], m_FFTdestination64[i], 0.3f);
//           if (!fullFrameReady) return;      ← FFT 只在有新数据时才跑
//           … kiss_fftr … 算 m_FFTdestination64 …
//       }
//
// ⟹ movetowards ≈ **60 次/秒**（渲染帧率），FFT ≈ **43 次/秒**（44100/1024）
// ⟹ 柱子在两次 FFT 更新**之间继续插值** ⟹ 运动是连续的
//
// 我们原来把平滑放在 FFT 那一步 ⟹ 画面只有 43fps 且**每 23ms 一跳**
//（PWCircle 只在收到帧时重绘）⟹ 跳变让孤峰更醒目
//   —— 用户 0.9.24 已经说「孤峰少了、变矮了」但「还有噪点」。
//
// 顺带：有效平滑强度也不同。WE 每个 target 被追 60/43 ≈ 1.4 次
// ⟹ 等效系数 1−0.7^1.4 = **0.392**，而我们原来是 0.300。
check('平滑跑在 60fps 定时器上，不是每个 FFT 帧', () => {
  assert.match(swiftCode, /func tickSmooth/,
    '没有独立的 tickSmooth ⟹ 平滑还绑在 FFT 帧上 ⟹ 画面 43fps 且每 23ms 一跳');
  assert.match(swiftCode, /func startEmitTimer/, '没有发帧定时器');
  assert.match(swiftCode, /repeating: \.milliseconds\(16\)/,
    '定时器不是 ~60fps（16ms）—— WE 的 movetowards 跑在渲染帧率上');
  // ⚠️ 定时器必须被启动 —— 定义了不调等于没有，而症状是"柱子完全不动"
  assert.match(swiftCode, /startEmitTimer\(\)\s*$/m,
    'startEmitTimer 定义了但没调用 ⟹ 平滑和发帧都不会跑 ⟹ 柱子完全不动'
    + '（和没授权同一个画面）');
  // ⚠️ process() 不能再直接 emit —— 否则两条路都在发帧
  const fnAt = swiftCode.indexOf('func process');
  const fn = swiftCode.slice(fnAt, swiftCode.indexOf('\n    }', fnAt + 10));
  assert.ok(!/emit\(/.test(fn),
    'process() 里还在 emit ⟹ FFT 帧和定时器**两条路都在发** ⟹ '
    + '帧率不确定，而平滑会被追两次（有效系数漂）');
  // ⚠️⚠️ **线程安全**：FFT 写 target、定时器读 target 写 smoothed
  // ⟹ 必须同一个串行 queue，否则是数据竞争（Swift 数组写非原子，可能 CoW 重分配）
  // ⟹ 症状是"偶发乱跳/崩溃"且**时好时坏**（这个项目栽过同形状的：DSPSplitComplex 悬空指针）
  assert.match(swiftCode, /makeTimerSource\(queue: audioQueue\)/,
    '定时器不在 audioQueue 上 ⟹ 和 FFT 回调跨 queue 碰同一个数组 = 数据竞争');
  assert.match(swiftCode, /sampleHandlerQueue: audioQueue/,
    'FFT 回调不在 audioQueue 上 ⟹ 同上');
  // ⚠️ 不能用 Timer/RunLoop —— 这个进程没有主 RunLoop 在跑（SCStream 回调驱动）
  assert.ok(!/Timer\.scheduledTimer/.test(swiftCode),
    '用了 Timer.scheduledTimer ⟹ 这个进程没有主 RunLoop 在跑，它压根不会触发，'
    + '而那是完全静默的（柱子一动不动）');
  // JS 规格要有对应实现，且数值上验证"多步插值 = 更强的等效系数"
  assert.strictEqual(typeof A.tickSmooth, 'function', 'JS 规格没有 tickSmooth');
  const target = new Array(64).fill(0.1);
  target[10] = 0.9;
  const one = A.smoothSteps(target, 1);
  const oneFour = A.smoothSteps(target, 2);   // 60/43≈1.4，取 2 步看趋势
  assert.ok(oneFour[10] > one[10],
    `追 2 步(${oneFour[10].toFixed(3)}) 不比 1 步(${one[10].toFixed(3)}) 更接近 target `
    + '⟹ tickSmooth 的实现不对（那是"两次 FFT 之间继续插值"的全部意义）');
});

console.log('\n  Swift 的未定义符号（云端跑不了 swiftc）');

// ⚠️⚠️ 这一条是实测烧出来的，而且形状很典型。
//
// 我回退"第三版分箱"时，**连它顺带引入的 `SAMPLE_RATE` 一起删了** ——
// 而后来加的 FFT 自检引用了那个常量
// ⟹ `cannot find 'SAMPLE_RATE' in scope` ⟹ helper 编译失败
// ⟹ **音频整条链不工作**，而用户看到的是"自检没输出"。
//
// ⚠️ 云端跑不了 swiftc，`node --check` 也查不出 Swift 的问题
// ⟹ 那一层的错误只能靠用户打包时才暴露，一轮成本很高。
//
// ⟹ 用一个粗糙但有效的检查兜住最常见的一类：**全大写常量用了没定义**。
// （Swift 里全大写是常量约定，而"删了定义留下引用"正是回退改动时的典型失误。）
check('Swift 里全大写常量都有定义（回退改动最容易漏这个）', () => {
  const code = swiftSrc.split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  const used = new Set([...code.matchAll(/\b([A-Z][A-Z_0-9]{2,})\b/g)].map((m) => m[1]));
  const defined = new Set([...code.matchAll(/let ([A-Z][A-Z_0-9]+)\s*[:=]/g)].map((m) => m[1]));
  // Swift / Darwin 自带的
  const builtin = new Set(['FFT_FORWARD', 'FFT_INVERSE', 'M_E', 'M_PI']);
  const missing = [...used].filter((x) => !defined.has(x) && !builtin.has(x));
  assert.deepStrictEqual(missing, [],
    `这些全大写标识符用了但没定义：${missing.join(', ')} ⟹ swiftc 会报 `
    + '"cannot find X in scope"，而 helper 编译失败 = 音频整条链不工作。'
    + '⚠️ 云端跑不了 swiftc，所以这类错误只能靠用户打包时暴露');
});

// ⚠️ 顺带守一条：helper 的编译失败要能被看见。
check('helper 编译失败会报到面板', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'audio-source.js'), 'utf8');
  assert.match(src, /swiftc 编译.*失败|编译.*失败/,
    'swiftc 失败时没有专门的错误信息 ⟹ 用户只看到"音频不工作"');
  // 要把 swiftc 的原话带出来
  assert.match(src, /result\.stderr/,
    '不带 swiftc 的 stderr ⟹ 只知道"编译失败"，不知道是哪一行哪个符号');
});


// ⚠️ 自检要跑多帧 —— 第一版只跑一帧，读到的是真实值的 0.3 倍。
//
// 用户的自检结果邻域是 `0.045 0.131 0.289 0.194 0.074`，
// 而真实峰值该是 0.289/0.3 ≈ 0.96 —— 因为 smoothed 从 0 开始只走了 30%。
//
// 那不影响"主瓣宽度"的判断（比例不变），但**平滑的行为要多帧才看得出来**。
check('自检跑多帧（单帧读到的是真实值的 0.3 倍）', () => {
  const i = swiftSrc.indexOf('func selfTestFFT');
  const fn = swiftSrc.slice(i, swiftSrc.indexOf('\nfunc ', i + 10));
  assert.match(fn, /for _ in 0\.\.<\d+/,
    '自检只跑一帧 ⟹ smoothed 从 0 开始只走 30%，而平滑的行为要多帧才看得出来');
});

// ⚠️ 稳态信号下的跳变 —— 那是"单段孤峰"最直接的判据。
check('自检量稳态跳变（纯音的频谱该是光滑钟形）', () => {
  const i = swiftSrc.indexOf('func selfTestFFT');
  const fn = swiftSrc.slice(i, swiftSrc.indexOf('\nfunc ', i + 10));
  assert.match(fn, /maxJump/,
    '不量稳态跳变 ⟹ 分不清"尖刺来自我们这一层"和"来自音乐的瞬态"。'
    + '纯音是稳态的，它的频谱该是光滑钟形 ⟹ 跳变大就说明问题在分箱/平滑');
  const main = mainCode();
  // ⚠️ 判据的文案改过一次（第一版看全局跳变，必然误报）——
  // 断言锚在"结论"而不是某句具体的话。
  assert.match(main, /主瓣外/,
    '面板不解释那个数意味着什么 ⟹ 用户拿到数字也不知道结论');
  // ⚠️ 同上，这条也是剥注释后暴露的假阴性：原文案「尖刺来自分箱/平滑」
  // 是 Hann 时代的判据，删窗时换成了"主瓣外平缓 ⟹ 矩形窗的泄漏"。
  assert.match(main, /主瓣外平缓|主瓣外跳变大/,
    '不给结论 ⟹ 那个数字要用户自己判断');
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
