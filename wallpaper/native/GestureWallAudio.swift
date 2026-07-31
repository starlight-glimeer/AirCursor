// 系统音频 → 128 段 FFT，一行一帧 JSON 打到 stdout。
//
// 为什么必须是原生：Electron 的 desktopCapturer 在 macOS 上**不给系统音频**
// （`audio: true` 被忽略）。而 WE 网页壁纸的灵魂就是音频响应 —— 拿不到频谱，
// 那个壁纸就只剩空闲动画。
//
// 为什么 FFT 在这边做而不是把 PCM 传进 JS：PCM 是 48kHz×2ch，每秒十几万个数；
// 128 段 FFT 每帧才 128 个数。传 PCM 等于把音频线程的活扛到 IPC 上。
//
// 用法：
//   GestureWallAudio                  # 全系统混音
//   GestureWallAudio --bundle com.netease.163music   # 只抓网易云（macOS 14.4+）
//   GestureWallAudio --probe          # 只报能力和权限，不出数据
//
// stdout 协议（一行一个 JSON，便于逐行解析、不用缓冲）：
//   {"type":"status","state":"running","filtered":true,"bundle":"…"}
//   {"type":"status","state":"denied","message":"…"}
//   {"type":"audio","bins":[…128 个 0..1 的数…]}
//
// ⚠️ 状态必须能被上层看见。这条链的失败模式全是静默的：没授权时 SCStream 要么起不来、
// 要么给全 0 的采样，而全 0 的画面看起来就是"音频响应坏了"，和"壁纸不支持音频"、
// "网易云没在放"完全分不清。AirCursor 为这件事烧掉四轮（缺权限时 CGEvent.post
// 静默丢弃），教训是**报"我在干什么"要和功能同时做，不是出问题之后再加**。

import Foundation
import AVFoundation
import ScreenCaptureKit
import Accelerate

let BIN_COUNT = 128
// 1024 点 FFT。取这个大小是因为 @48kHz 约 21ms 一帧，接近 60fps 的节奏；
// 再大就会让低频波纹的触发比画面慢半拍。
// ⚠️ 2048 而不是 1024 —— **低频要分辨率**。
//
// 1024 点 @48kHz 是每 bin 46.9 Hz ⟹ 40Hz 和 80Hz 落在同一个 bin，
// 而那是鼓的整个基频范围 ⟹ 对数分箱在低频区会大量重复。
// 2048 点是 23.4 Hz/bin，一帧 42.7ms（可接受 —— 视觉上跟得上节拍）。
let FFT_SIZE = 2048
// 采样率。ScreenCaptureKit 给的是 48kHz。
let SAMPLE_RATE = 48000

// ⚠️ 手感参数。改它们不动逻辑，也不需要每个壁纸单独调 —— 这一层的输出（128 段）
// 是所有壁纸共用的，WE 的音频接口就是这么设计的。
//
// ⚠️⚠️ 这些值和下面的分箱都是**读了真实壁纸的渲染代码之后**定的，不是猜的。
// 依据：884307090「完美壁纸」的 `js/PWCircle.js`（用户 2026-07-31 提供）。
// 那份代码推翻了我之前三个假设里的两个：
//
//   ① **它只用 arr[0..119]** —— `for(var i=0; i<120; i++)`，不是 128。
//      arr[120..127] 完全没用。
//      ⟹ 我原来按"前 76 段"分箱是错的：那个 76 来自**另一个**壁纸
//        （Sonic Topography 重采样到 512 后 `Pe<=300` 丢掉后半）。
//        **两个壁纸的消费边界不一样，而我拿一个的推到了全体。**
//
//   ② **它自己就有时间平滑**：
//        w2 = waveArr[i] - waveArr[i]*0.25    // 上一帧衰减 25%
//        w1 = Math.max(w1, w2)                // 取大 ⟹ 上升立刻跟上、下降平滑
//      ⟹ 我们再平滑一次就是**双重平滑**，那正是用户报的"不丝滑/拖泥带水"。
//      ⟹ 所以 ATTACK 拉到 1.0（完全不平滑上升），RELEASE 也基本不做 ——
//        把平滑交给壁纸，它比我们更知道自己的帧率。
//
//   ③ **幅度上限是 1.2 不是 1.0**：`w1 = Math.min(w1, 1.2)`。
//      而柱子长度 = `w1 * param.range * 100` 像素，range 默认 9
//      ⟹ w1=1 时柱子 **900px**，而屏幕高 956 ⟹ **w1 到 0.3 就已经很长了**。
//      那正是截图里柱子长到离谱的原因 —— 不是分箱，是幅度。
//
// ⚠️⚠️ **我们是渲染器，不是"适配某个壁纸"。**
//
// 用户点出的定位（2026-07-31）：「我们的产品其实是个壁纸渲染器，所以你的修改
// 应该是能够适配这个壁纸的参数，其他的壁纸也可以适配，而不是来一个适配一个」。
//
// ⟹ 这里的每个数必须能回答"它是契约还是某个壁纸的内部细节"：
//
//   LINEAR_BINS / USEFUL_BINS   ✅ 契约 —— "128 段每段都是独立、正确的频谱值"
//                                  是频谱**质量**本身，和谁消费无关
//   CEILING                     ✅ 契约 —— 物理上限，防非法值传下去
//   NORMALIZE                   ✅ 契约 —— "日常音乐落在什么量级"
//                                  ⚠️ 它是从 WE 原版行为反推的，不是照抄 PWCircle
//
// ⚠️ 我上一版犯的错：把 `min(1.2, …)` 写进来，理由是"PWCircle 自己 clamp 到 1.2"。
// 那是**照抄单个壁纸的实现细节** —— 而且我已经犯过一次同样的错
//（把 Sonic Topography 的 76 段边界当成通用常量）。**同一个形状，两次。**
//
// ⟹ 判据：如果一个数只能从"某个壁纸的源码"推出来，它就不该在这里。
//   能留在这里的，必须能从"WE 的行为"或"信号处理本身"推出来。
//
// NORMALIZE  日常音乐下的能量量级。
//            ⚠️ 从 WE 原版行为反推：PWCircle 的 `w = w1*range*100` 且 range 默认 9
//            ⟹ 一根 90px 的柱子对应 w1≈0.1 ⟹ **WE 给的值在日常音乐下大概 0.05..0.3**。
//            那不是 PWCircle 的偏好，是"WE 原版长什么样"的证据 ——
//            所有为 WE 写的壁纸都是按那个量级调的。
// ATTACK     上升插值（1.0 = 不插值）。
//            ⚠️ 壁纸普遍自己做平滑（PWCircle: `Math.max(w1, prev*0.75)`）——
//            我们再平滑就是双重平滑。**不平滑是契约，平滑是壁纸的事。**
// RELEASE    下降插值。只用来压 FFT 的逐帧抖动（那是我们的噪声，该我们处理）。
// CEILING    物理上限。防 NaN/Infinity 和异常尖峰传下去，不是审美参数。
// ⚠️ 0.002 是**从真机实测数据算出来的**，不是猜的。
//
// 用户 2026-07-31 在面板上读到的实际频谱（NORMALIZE=0.06 时）：
//   最大 2.0（撞了 CEILING，说明还在削顶）  平均 0.733
//   低频段(0-39) 1.341   高频段(80-119) 0.423
//   [0]1.676 [5]2.0 [10]1.497 [20]1.736 [40]0.535 [60]0.614 [80]0.583 [119]0.221
//
// 反推 FFT 原始幅度（v = sqrt(mean × NORMALIZE) ⟹ mean = v²/NORMALIZE）：
//   低频约 37..67，高频约 0.8..6
//
// 目标量级（从 PWCircle 的 `w1*range*100` 反推 WE 原版）：日常音乐 0.05..0.3。
//   低频均值 1.341 → 0.25 ⟹ v 缩 5.4x ⟹ NORMALIZE ÷ 29 = 0.0021
//   整体均值 0.733 → 0.12 ⟹ NORMALIZE ÷ 37 = 0.0016
// ⟹ 两条算法一致到同一个量级，取 0.002。
//
// ⚠️ 而这个数**本该一开始就这么定** —— 我之前改了三轮参数，
// 全靠从壁纸源码反推"应该是多少"，而没有看过实际值。
// 观测（面板那行「实际频谱」）是第四轮才加的，加完这个数就是算术。
// ⚠️⚠️ 0.012 —— 依据是**三份独立证据**，不是我倒推的数字。
//
// 用户点出的问题（2026-07-31）：「我们的渲染器的修改就应该是通用的才对，
// 我们现在在调节柱子这件事本身就很奇怪。你之前调研的时候不是有一些代码吗，
// 我不相信他们做的这么差」。
//
// 他说得对，而且我之前那个 0.05..0.3 的"目标量级"**是我编的** ——
// 我从"一根 90px 的柱子"倒推，而那 90px 建立在一个算错的数上：
//
//   我以为：w = w1 * range * 100，range = 9  ⟹ 900px
//   实际是：main.js:329 `param.range = properties.range.value / 5` ⟹ **1.8**
//   ⟹ 真实柱子 = w1 * 180px，我把它算大了 5 倍
//   ⟹ 那也是用户报"短柱子太短"的原因：真实长度只有我以为的 1/5
//
// ⟹ 而真正的契约来自三份**独立**证据（不同作者、不同文件）：
//
//   ① `jquery.audiovisualizer.js`（Alice 的通用库，第三方作品）：
//        audioValue = Math.min(audioValue, 1.5);   // 注释："溢出部分按值1.5处理"
//        audioValue = Math.min(audioSamples[i], 1); // 注释："溢出部分按值1处理"
//      ⚠️ 它**明确写了"溢出"** —— 那是"WE 会给出 >1 的值"的直接证据，
//      而且出自一个不知道我们存在的第三方作者。
//
//   ② `PWCircle.js`（老陈）：`w1 = Math.min(w1, 1.2)`
//   ③ Sonic Topography（另一个壁纸）：不 clamp，当相对强度用
//
// ⟹ **契约 = 基准 0..1，响的地方允许溢出到 1.2~1.5。**
//
// 按这个契约 + 用户实测的原始幅度（低频 93.7 / 中频 39..45 / 高频 0.9..1）：
//   NORMALIZE = 0.012 ⟹ 峰值 1.12（正好在溢出区）、中频 0.2..0.5
//   柱子长度 = v × 180px ⟹ 36..200px，在 956px 高的屏幕上是合理的圆环
//
// ⚠️ 这个数现在**能被别人核对**：它 = 0..1 契约 ÷ 实测幅度，两边都有出处。
// ⚠️ 0.004 是**保守起步值**，不是算准的。
//
// FFT 从 1024 加到 2048 之后有两个方向相反的变化：
//   · vDSP 的幅度与窗内样本数成正比 ⟹ 幅度约 ×2
//   · 而对数分箱让低频段覆盖更窄的频带 ⟹ 单段能量变少
// 两者抵消多少我算不准 ⟹ 起个偏小的值（宁可柱子短，不要一上来就削顶
// —— 削顶会让一片柱子长度相同，那个症状比"偏短"难认得多）。
//
// ⚠️ 而面板会**直接算出该调多少**（见 dashboard.js 的 renderAudioFrame）：
// 它拿实测峰值和目标 1.1 一比就出来了 ⟹ 一轮收敛，不用来回试。
let NORMALIZE: Float = 0.004
let ATTACK: Float = 1.0
let RELEASE: Float = 0.5
let CEILING: Float = 2.0

func emit(_ dict: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: dict),
          var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    // 直接写 fd，不用 print：print 有行缓冲，管道里会攒着不发。
    FileHandle.standardOutput.write(line.data(using: .utf8)!)
}

func emitStatus(_ state: String, _ extra: [String: Any] = [:]) {
    var dict: [String: Any] = ["type": "status", "state": state]
    dict.merge(extra) { _, new in new }
    emit(dict)
}

// 把一段 PCM 变成 128 段幅度谱。
final class Spectrum {
    private let setup: FFTSetup
    private let log2n: vDSP_Length
    private var window: [Float]
    private var real: [Float]
    private var imag: [Float]
    private var magnitudes: [Float]
    // 上一帧的结果，用来做时间平滑。
    private var smoothed = [Float](repeating: 0, count: BIN_COUNT)

    init() {
        log2n = vDSP_Length(log2(Double(FFT_SIZE)))
        setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2))!
        window = [Float](repeating: 0, count: FFT_SIZE)
        // Hann 窗。不加窗的话每帧边界的突变会在整个频谱上撒一层假的高频，
        // 而高频正是流星效果的触发源 —— 会变成随机掉流星。
        vDSP_hann_window(&window, vDSP_Length(FFT_SIZE), Int32(vDSP_HANN_NORM))
        real = [Float](repeating: 0, count: FFT_SIZE / 2)
        imag = [Float](repeating: 0, count: FFT_SIZE / 2)
        magnitudes = [Float](repeating: 0, count: FFT_SIZE / 2)
    }

    deinit { vDSP_destroy_fftsetup(setup) }

    func process(_ samples: [Float]) -> [Float] {
        var input = samples
        if input.count < FFT_SIZE {
            input.append(contentsOf: [Float](repeating: 0, count: FFT_SIZE - input.count))
        }
        var windowed = [Float](repeating: 0, count: FFT_SIZE)
        vDSP_vmul(input, 1, window, 1, &windowed, 1, vDSP_Length(FFT_SIZE))

        // ⚠️ 这一段的写法是被编译器警告逼出来的，而那个警告是真 bug 不是风格问题：
        //
        //   var split = DSPSplitComplex(realp: &real, imagp: &imag)   // ← 错
        //
        // `&real` 从 [Float] 隐式转出的指针**只在 init 那一次调用期间有效**，
        // 出了那行就悬空了。而 split 是拿来给后面 vDSP_ctoz / vDSP_fft_zrip 写结果的 ——
        // 也就是往已经失效的地址写。这类问题不会崩，会写坏或读到垃圾，
        // 表现是"频谱是噪声"或"柱子乱跳"，而且时好时坏。
        //
        // 正确做法是让 real/imag 的可变缓冲在**整个使用期间**都处于 with… 作用域内。
        real.withUnsafeMutableBufferPointer { realBuf in
            imag.withUnsafeMutableBufferPointer { imagBuf in
                var split = DSPSplitComplex(realp: realBuf.baseAddress!,
                                            imagp: imagBuf.baseAddress!)
                windowed.withUnsafeBufferPointer { ptr in
                    ptr.baseAddress!.withMemoryRebound(
                        to: DSPComplex.self, capacity: FFT_SIZE / 2
                    ) { complex in
                        vDSP_ctoz(complex, 2, &split, 1, vDSP_Length(FFT_SIZE / 2))
                    }
                }
                vDSP_fft_zrip(setup, &split, 1, log2n, FFTDirection(FFT_FORWARD))
                magnitudes.withUnsafeMutableBufferPointer { magBuf in
                    vDSP_zvabs(&split, 1, magBuf.baseAddress!, 1,
                               vDSP_Length(FFT_SIZE / 2))
                }
            }
        }

        // 512 个 bin 降到 128：**按对数频率分组**，不是线性平均。
        //
        // ⚠️ 这一步的选择会直接决定画面好不好看。线性分组下人耳关心的低频挤在头几个
        // bin 里，而壁纸的低频段（前 6 个索引驱动波纹）会几乎没有分辨率 —— 表现是
        // "鼓点不触发波纹"。WE 自己给的是已经做过感知加权的数据，所以这里要对齐它的
        // 量纲而不是给原始 FFT。
        // ⚠️ 硬约束（2026-07-30 从壁纸 bundle 里查出来的）：
        //
        // 样本壁纸（Sonic Topography）把收到的数组重采样到 512，然后按
        //   Pe<=6 / <=18 / <=35 / <=60 / <=95 / <=145 / <=210 / <=300
        // 分成 8 段 —— 而 `Pe<=300` **之后没有 else**。
        // ⟹ 512 空间的 301..511 那 211 段被它自己丢掉。
        //
        // 反推到我们这 128 段：**只有前 76 段（0..75）承载全部视觉效果，
        // 后 52 段白算。**
        //
        // 所以下面的对数分组如果把有用信号挤到第 76 段以后，画面会几乎不动 ——
        // 而那看起来像"音频没接上"，会让人去查权限和管道，方向全错。
        //
        // ⚠️ 当前的对数分组是把 1..512 个 FFT bin 铺满 128 段，也就是**后 52 段
        // 覆盖的是最高频**（人耳最不敏感、音乐里能量也最少的那段）。
        // 这个组合大概是可接受的（有用能量本来就在低频），但**没有真机验证过**。
        // 真机上如果柱子只有左边一小片在动，先怀疑这里，不是权限。
        // ⚠️⚠️ 这一段整个重写过一次 —— 原来那版**在数学上就是错的**。
        //
        // 原来是 `lo = powf(half, i/128)` 纯对数铺满 1..512。真机截图（用户 2026-07-31）
        // 显示柱子长度随索引**单调递增**、还带一段段等长的阶梯 —— 那不是音乐的形状。
        //
        // 算出来才明白：低索引处 `powf(512, i/128)` 增长极慢 ——
        //   i=0..13 的 (start,end) **全是 (1,1)**，14 个箱子读同一个 FFT bin
        //   i=20 → (2,2)   i=40 → (7,7)   i=60 → (18,19)   i=127 → (487,511)
        // 一共 **38 / 128 个箱子在读完全相同的 bin**，它们的值必然一模一样。
        //
        // 而箱子宽度从 1 单调涨到 25 ⟹ 越往后平均的 bin 越多、越接近"整体音量"
        // ⟹ 后面的柱子更长更均匀，前面一格一格 —— **正是那张截图**。
        //
        // ⟹ 新的分箱分三段，目标是"每个箱子至少有一个自己的 bin"+
        //    "有用信号落在壁纸真正消费的前 76 段里"：
        //
        var out = [Float](repeating: 0, count: BIN_COUNT)
        let half = FFT_SIZE / 2
        // ⚠️⚠️ **对数频率分箱 + 低频插值**。这是第三版，前两版都在数学上错了：
        //
        //   第一版：纯对数铺满 bin 1..512
        //     ⟹ 38/128 个箱子读**同一个** FFT bin（低索引处 powf 增长极慢）
        //     ⟹ 画面上一段段等长的阶梯
        //
        //   第二版：低频改成线性一对一（段 i ↔ bin 1+i）
        //     ⟹ 不重复了，但**把音乐能量挤在头几段**：
        //        60-250Hz（鼓和低音）只落在段 0..4，而那五段在圆周上是 3 点到 4 点
        //     ⟹ 用户报「3 点到 6 点这个区间的柱子明显更长」
        //
        // ⟹ 第三版：**按对数频率铺开**（每段覆盖等比例频率），
        // 而低频段不足一个 bin 宽时用**相邻 bin 线性插值**。
        // 那是音频可视化的标准做法，也是唯一能同时满足两件事的：
        //   · 每段值都不同（不重复）—— 靠插值
        //   · 音乐能量铺满整圈 —— 靠对数
        //
        // 实测（用规格文件算的）：60-250Hz 从 **5 段铺到 28 段**。
        //
        // ⚠️ FFT 从 1024 加到 2048：低频要分辨率。
        // 1024 点 @48kHz 是每 bin 46.9Hz ⟹ 40Hz 和 80Hz 落在同一个 bin，
        // 而那是鼓的整个基频范围。2048 点是 23.4Hz/bin，延迟 42.7ms（可接受）。
        let F_MIN: Float = 40.0        // 音乐能量的下界（再低是听不见的隆隆声）
        let F_MAX: Float = 16000.0     // 上界（再高人耳不敏感、音乐里也没能量）
        let USEFUL_BINS = 120          // PWCircle 用 arr[0..119]
        let nyquist = Float(SAMPLE_RATE) / 2.0
        let hzPerBin = nyquist / Float(half)
        let ratio = F_MAX / F_MIN

        for i in 0..<BIN_COUNT {
            var loHz: Float
            var hiHz: Float
            if i < USEFUL_BINS {
                loHz = F_MIN * powf(ratio, Float(i) / Float(USEFUL_BINS))
                hiHz = F_MIN * powf(ratio, Float(i + 1) / Float(USEFUL_BINS))
            } else {
                // 收尾段：从 F_MAX 线性铺到奈奎斯特。⚠️ 要和上面衔接上，
                // 各算各的会让边界处出现零宽段。
                let tail = Float(BIN_COUNT - USEFUL_BINS)
                loHz = F_MAX + (nyquist - F_MAX) * (Float(i - USEFUL_BINS) / tail)
                hiHz = F_MAX + (nyquist - F_MAX) * (Float(i - USEFUL_BINS + 1) / tail)
            }
            let lo = max(1.0, loHz / hzPerBin)
            let hi = min(Float(half - 1), max(lo + 0.01, hiHz / hzPerBin))

            // ⚠️ 宽度不足 1 个 bin ⟹ **插值**，而不是取整共用。
            // 那是第一版 38/128 重复的成因，也是这一版能同时做到
            //「不重复」和「低频铺开」的关键。
            var mean: Float
            if hi - lo < 1.0 {
                let center = (lo + hi) / 2.0
                let i0 = Int(center)
                let frac = center - Float(i0)
                let a = magnitudes[min(half - 1, i0)]
                let b = magnitudes[min(half - 1, i0 + 1)]
                mean = a + (b - a) * frac
            } else {
                var sum: Float = 0
                let start = Int(lo)
                let end = min(half - 1, max(start, Int(hi)))
                for j in start...end { sum += magnitudes[j] }
                mean = sum / Float(end - start + 1)
            }
            // 归一化。⚠️ 用 sqrt 而不是线性：
            //
            // FFT 幅度的动态范围很大（安静段和鼓点差两个数量级），线性映射下
            // 要么安静时全是 0、要么鼓点时全部顶天 —— 用户报的"幅度不对"就是这个。
            // sqrt 压缩动态范围，效果接近人耳的对数感知，也是音频可视化的常规做法。
            // ⚠️ **线性，不是 sqrt。** 这一版是从实测数据算出来的，见下。
            //
            // 我上一版用 sqrt，理由是"FFT 动态范围有两个数量级，线性会全 0 或顶天"。
            // 而用户实测的数字证明那个代价太大：
            //
            //   实测值(sqrt): [0]0.433 [10]0.183 [20]0.28 [40]0.301 [60]0.279
            //   反推原始幅度:  93.7    16.7      39.2    45.3      38.9
            //
            //   原始动态 93.7/16.7 = **5.6 倍**
            //   sqrt 之后         = **2.4 倍**   ← 差异被压掉一半以上
            //
            // ⟹ 用户报的「柱子之间的差距不大，音乐的动感不强」就是这个：
            // sqrt(x) 的性质是"x 差 4 倍 ⟹ sqrt 只差 2 倍"，而音频可视化要的正是对比。
            //
            // 也试过 dB（20*log10）—— **更糟**（动态压到 1.3 倍），因为 dB 本身就是压缩。
            // 方向搞反了：这里要**保留**动态，不是压缩它。
            //
            // ⚠️ 线性的代价是响的地方会溢出（高潮时低频能到 1.87）——
            // 而那**正是 WE 契约允许的**：PWCircle 自己写 `Math.min(w1, 1.2)`
            // 就是为了处理溢出。我们不该替它压。
            var v = mean * NORMALIZE
            // ⚠️ 上限 CEILING，而**不是**某个壁纸的内部数字。
            //
            // 我上一版写的是 `min(1.2, …)`，理由是"PWCircle 自己 clamp 到 1.2"。
            // 那是错的推理方向：**1.2 是它的实现细节，不是 WE 的契约。**
            //
            // 我们是渲染器/宿主 —— 该做的是"给出符合 WE 契约的频谱"，
            // 而每个壁纸怎么截、怎么放大是它自己的事（PWCircle 截 1.2，
            // Sonic Topography 压根不截、当相对强度用）。
            //
            // ⟹ 从 PWCircle 的代码能**反推**契约（而不是照抄它的数字）：
            //   它写 `Math.min(w1, 1.2)` ⟹ 它**预期收到的值可能超过 1**
            //   ⟹ 契约不是"严格 0..1"，而是"0..1 附近、响的地方允许溢出"
            //
            // CEILING = 2.0 是个**物理上限**（防 NaN/Infinity 传下去），
            // 不是审美选择。真正决定"好不好看"的是 NORMALIZE。
            v = min(CEILING, max(0.0, v))
            // 时间平滑。⚠️ **上升沿也要平滑** ——
            //
            // 原来是 `v > prev ? v : prev*0.82 + v*0.18`：上升时**直接跳到新值**，
            // 只有下降平滑 ⟹ 鼓点让柱子瞬间弹到顶，那正是用户报的"不丝滑"。
            //
            // 现在两个方向都插值，只是上升快、下降慢（那个不对称是对的：
            // 攻击要跟得上节拍，释放慢一点看起来才顺）。
            let prev = smoothed[i]
            let alpha: Float = v > prev ? ATTACK : RELEASE
            smoothed[i] = prev + (v - prev) * alpha
            out[i] = smoothed[i]
        }
        return out
    }
}

final class AudioTap: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private let spectrum = Spectrum()
    private var pending = [Float]()
    private let targetBundle: String?

    init(targetBundle: String?) {
        self.targetBundle = targetBundle
        super.init()
    }

    func start() async {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: false)

            // ⚠️ 抓系统音频要一个 display 作为 filter 的锚，即使我们完全不要视频。
            guard let display = content.displays.first else {
                emitStatus("error", ["message": "没有可用的显示器"])
                exit(1)
            }

            var filtered = false
            let filter: SCContentFilter
            if let bundle = targetBundle {
                // 只抓指定 App 的输出。macOS 14.4+ 才有 per-app 音频过滤；
                // 更早的系统上这里找不到应用就退回全局混音，并**明确报出来** ——
                // 静默退回会让用户以为"只抓网易云"生效了，而实际上视频的声音也在驱动画面。
                let apps = content.applications.filter { $0.bundleIdentifier == bundle }
                if apps.isEmpty {
                    emitStatus("warning", [
                        "message": "没找到 \(bundle)，退回全系统混音",
                        "bundle": bundle,
                    ])
                    filter = SCContentFilter(display: display, excludingWindows: [])
                } else {
                    filter = SCContentFilter(display: display,
                                             including: apps,
                                             exceptingWindows: [])
                    filtered = true
                }
            } else {
                filter = SCContentFilter(display: display, excludingWindows: [])
            }

            let config = SCStreamConfiguration()
            config.capturesAudio = true
            config.sampleRate = 48000
            config.channelCount = 2
            // 视频我们不要，但 SCStream 仍会产帧 —— 压到最小省电。
            config.width = 2
            config.height = 2
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            config.showsCursor = false

            let s = SCStream(filter: filter, configuration: config, delegate: self)
            try s.addStreamOutput(self, type: .audio,
                                  sampleHandlerQueue: DispatchQueue(label: "gw.audio"))
            try await s.startCapture()
            stream = s
            emitStatus("running", [
                "filtered": filtered,
                "bundle": targetBundle ?? NSNull(),
                "bins": BIN_COUNT,
            ])
        } catch {
            // 没给屏幕录制权限就会落到这里。**必须报出来** —— 否则上层看到的是
            // "没有音频数据"，和"没在放歌"分不清。
            emitStatus("denied", [
                "message": "启动失败（大概率是没给屏幕录制权限）：\(error.localizedDescription)",
            ])
            exit(2)
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .audio, buffer.isValid else { return }
        guard let samples = pcm(from: buffer) else { return }
        pending.append(contentsOf: samples)
        while pending.count >= FFT_SIZE {
            let chunk = Array(pending.prefix(FFT_SIZE))
            pending.removeFirst(FFT_SIZE)
            let bins = spectrum.process(chunk)
            emit(["type": "audio", "bins": bins.map { Double(round($0 * 10000) / 10000) }])
        }
        // 防止上游比我们快时无界堆积。
        if pending.count > FFT_SIZE * 8 { pending.removeFirst(pending.count - FFT_SIZE) }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emitStatus("stopped", ["message": error.localizedDescription])
        exit(3)
    }

    // 取出单声道 PCM。双声道取平均：壁纸要的是"整体有多响"，左右分开没有用途。
    private func pcm(from buffer: CMSampleBuffer) -> [Float]? {
        guard let desc = buffer.formatDescription?.audioStreamBasicDescription else { return nil }
        let frames = Int(buffer.numSamples)
        guard frames > 0 else { return nil }
        let channels = Int(desc.mChannelsPerFrame)

        var blockBuffer: CMBlockBuffer?
        let listSize = MemoryLayout<AudioBufferList>.size + (channels - 1) * MemoryLayout<AudioBuffer>.size
        let listPtr = UnsafeMutableRawPointer.allocate(byteCount: listSize, alignment: 16)
        defer { listPtr.deallocate() }
        let list = listPtr.assumingMemoryBound(to: AudioBufferList.self)

        guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            buffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: list,
            bufferListSize: listSize,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBuffer) == noErr else { return nil }

        let buffers = UnsafeMutableAudioBufferListPointer(list)
        var out = [Float](repeating: 0, count: frames)
        var used = 0
        for ab in buffers {
            guard let raw = ab.mData else { continue }
            let count = Int(ab.mDataByteSize) / MemoryLayout<Float>.size
            let ptr = raw.assumingMemoryBound(to: Float.self)
            let n = min(frames, count)
            for i in 0..<n { out[i] += ptr[i] }
            used += 1
        }
        if used > 1 {
            for i in 0..<frames { out[i] /= Float(used) }
        }
        return out
    }
}

// --- 入口 ---

var targetBundle: String? = nil
var probeOnly = false
var args = Array(CommandLine.arguments.dropFirst())
while !args.isEmpty {
    let arg = args.removeFirst()
    switch arg {
    case "--bundle":
        if !args.isEmpty { targetBundle = args.removeFirst() }
    case "--probe":
        probeOnly = true
    default:
        break
    }
}

if probeOnly {
    // 探针：只报"这条链能不能用"，不出数据。
    // ⚠️ 这是让"没授权"变成可观测事件的唯一手段 —— 上层拿它在面板上显示一行状态，
    // 而不是让用户对着不动的柱子猜。
    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: false)
            let hasTarget = targetBundle == nil
                || content.applications.contains { $0.bundleIdentifier == targetBundle }
            emitStatus("ok", [
                "displays": content.displays.count,
                "targetFound": hasTarget,
                "bundle": targetBundle ?? NSNull(),
            ])
            exit(0)
        } catch {
            emitStatus("denied", ["message": error.localizedDescription])
            exit(2)
        }
    }
    RunLoop.main.run()
} else {
    let tap = AudioTap(targetBundle: targetBundle)
    Task { await tap.start() }
    RunLoop.main.run()
}
