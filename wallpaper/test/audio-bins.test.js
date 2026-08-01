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
check('① 线性取样 stride 1（照抄 WE 的 2 会让频率范围翻倍）', () => {
  assert.match(swiftCode, /band \+ 1/,
    'stride 不是 1 —— WE 用 stride 2 是因为它只有 64 段。'
    + '128 段用 stride 2 会覆盖到 11.2kHz，而音乐在那儿没能量 ⟹ 半个圆环是死的');
  assert.ok(!/band \* 2/.test(swiftCode),
    '还在用 band*2 —— 那让频率范围翻倍（用户报"3 点是分割线"就是它）');
  // 不许再出现我那三个错误模型的痕迹
  assert.ok(!/LINEAR_BINS|USEFUL_BINS|powf\(ratio/.test(swiftCode),
    '还有旧分箱模型的残留（LINEAR_BINS / USEFUL_BINS / powf(ratio…)）');
});

check('② 用功率（re²+im²），不是 magnitude', () => {
  assert.match(swiftCode, /magnitude \* magnitude/,
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
  assert.ok(Math.abs(A.bandWeight(127) - 1.393) < 0.002,
    `band 127 的加权是 ${A.bandWeight(127).toFixed(3)}，WE 是 1.393`);
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
  // stride 1 ⟹ 段 127 读 bin 128
  const topHz = 128 * hzPerBin;
  assert.ok(topHz < 8000,
    `覆盖到 ${Math.round(topHz)}Hz —— WE 只到 5.4kHz。`
    + '铺太宽会让高频那些段落在音乐几乎没能量的区间 ⟹ 半个圆环不动');
  assert.ok(topHz > 4000,
    `只覆盖到 ${Math.round(topHz)}Hz —— 太窄会丢掉人声和主奏的泛音`);
  // 而 3 点接缝处的频率跳变要小
  const seamRatio = (128 * hzPerBin) / (1 * hzPerBin);
  assert.ok(seamRatio < 200,
    `圆周接缝处频率差 ${Math.round(seamRatio)} 倍 —— 那必然产生可见的分割线`
    + '（用户报「3 点是很明显的分割线」）');
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
  assert.strictEqual(A.bandValue(0.99, 127), 0,
    'magnitude<1 时 log10 为负，最大的频段加权（段 127，×1.35）也救不回来 —— '
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
    for (const b of [0, 63, 127]) {
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
  // ⚠️ 断言从 `band*2+1` 改成 `band+1` —— stride 从 2 改成 1 了（见上一条）。
  // 关键是那个 **+1**：它让段 0 读 bin 1 而不是 bin 0。
  assert.match(swiftCode, /min\(half - 1, band \+ 1\)/,
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

check('自检报主瓣宽度（那是判据本身）', () => {
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
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(main, /onSelfTest/, '主进程没接自检回调');
  // ⚠️ 切到块尾，不用固定长度 —— 我往这个回调里加了"稳态跳变"的判断，
  // 900 字符的切片就把断言要找的东西推走了 ⟹ 在正确代码上报红。
  // **切片长度是个会漂的锚点**，这一轮我已经栽过三次。
  const i = main.indexOf('onSelfTest');
  const block = main.slice(i, main.indexOf('\n    },', i));
  assert.match(block, /broadcast\('helper-log'/,
    '自检结果只写 console ⟹ 打包版里看不到（这是我这轮第五次踩这个）');
  // 要给出判断，不只报数字
  assert.match(block, /窗函数或 stride/,
    '不说"这个数不对意味着什么" ⟹ 用户拿到数字也不知道下一步');
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
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  // ⚠️ 判据的文案改过一次（第一版看全局跳变，必然误报）——
  // 断言锚在"结论"而不是某句具体的话。
  assert.match(main, /主瓣外/,
    '面板不解释那个数意味着什么 ⟹ 用户拿到数字也不知道结论');
  assert.match(main, /尖刺来自分箱\/平滑|尖刺来自音乐/,
    '不给结论 ⟹ 那个数字要用户自己判断');
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
