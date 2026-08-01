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
  assert.match(swiftCode, /out\[BIN_COUNT - 1 - band\] = value/,
    '没有镜像写入 ⟹ 后半 64 段是 0（半个圆环空的），'
    + '或者按连续频段填（那必然单向递减 ⟹ 螺旋）');
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
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
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
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
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
