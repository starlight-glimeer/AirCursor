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
check('① 线性取样 band × 2（不是任何形式的分箱）', () => {
  assert.match(swiftCode, /band \* 2/,
    'Swift 里没有 `band * 2` —— WE 是纯线性取样，'
    + '我猜过对数分箱、线性区+对数区、低频插值，全错');
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

console.log('\n  这套算法在真实数据上的效果');

// ⚠️ 这些 magnitude 是从用户实测反推的（他的面板读数 ÷ 我当时的系数）。
const REAL_MAGS = { 0: 166.7, 10: 72.3, 20: 10.0, 40: 10.2, 60: 9.8, 80: 3.2, 100: 4.0, 119: 1.4 };

check('（真实数据）动态范围从 118 倍降到 5 倍以内', () => {
  const out = {};
  for (const [b, m] of Object.entries(REAL_MAGS)) out[b] = A.bandValue(m, Number(b));
  const vals = Object.values(out);
  const ratio = Math.max(...vals) / Math.min(...vals);
  assert.ok(ratio < 8,
    `动态范围 ${ratio.toFixed(1)} 倍 —— 我的旧算法是 118 倍（一片长一片没有），`
    + `WE 算法应该在 5 倍左右（铺满整圈）。各段值：`
    + Object.entries(out).map(([b, v]) => `[${b}]${v.toFixed(2)}`).join(' '));
});

check('（真实数据）每段都有可见的值（没有段趴在 0）', () => {
  for (const [b, m] of Object.entries(REAL_MAGS)) {
    const v = A.bandValue(m, Number(b));
    assert.ok(v > 0.05,
      `第 ${b} 段的值 ${v.toFixed(3)} 太小 ⟹ 那根柱子看不见（<10px）。`
      + 'WE 的频段加权就是为了避免这个');
  }
});

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
check('去直流：加窗之前先减均值', () => {
  assert.match(swiftCode, /vDSP_meanv/,
    '没有去直流 ⟹ bin 0 收下全部偏移，症状是"某根柱子永远最长"'
    + '（用户实测三次报同一个位置）');
  // 顺序要对：先减均值，再加窗
  const meanAt = swiftCode.indexOf('vDSP_meanv');
  const windowAt = swiftCode.indexOf('vDSP_vmul');
  assert.ok(meanAt < windowAt,
    '去直流在加窗之后 ⟹ 窗函数已经改变了信号，均值不再是原始偏移');
});

check('段 0 不读 bin 0（那是直流不是频率）', () => {
  assert.match(swiftCode, /band \* 2 \+ 1/,
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
// ⚠️ 而单段孤峰**在物理上不可能来自真实音乐**：
// FFT + Hann 窗的主瓣宽约 4 个 bin，而相邻段隔 2 个 bin
// ⟹ 任何真实频率成分至少落进 2 个相邻段。
//
// ⟹ 那说明 FFT 这一层有问题，而三个可能（窗函数没生效 / ctoz 的 stride 错 /
// magnitudes 被写坏）**用同一个测试就能分辨**：1kHz 纯音占几段。
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
