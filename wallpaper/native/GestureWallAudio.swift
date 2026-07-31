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
let FFT_SIZE = 1024

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
// NORMALIZE  幅度。⚠️ 按上面第③条，目标是让**音乐里常见的能量**落在 0.15..0.4，
//            而不是 0..1 铺满 —— 铺满就意味着柱子长到出屏幕。
// ATTACK     上升插值（1.0 = 不插值，直接跟上）。壁纸自己会处理。
// RELEASE    下降插值。留一点点，防止 FFT 逐帧抖动，但别和壁纸的衰减叠加。
let NORMALIZE: Float = 0.06
let ATTACK: Float = 1.0
let RELEASE: Float = 0.5

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
        //   0..19    线性一对一（FFT bin 1..20 = 47..940 Hz，鼓/低音，每箱独占一个 bin）
        //   20..75   对数铺到 bin 170（≈7.9 kHz）—— 人声和主奏全在这段
        //   76..127  对数铺完 170..511（7.9..24 kHz）—— 壁纸会丢掉这段，但填对的值
        //            比填 0 好：万一别的壁纸的消费边界不是 300，它也能拿到东西
        //
        // 重复箱子从 38 降到 2（算过）。
        var out = [Float](repeating: 0, count: BIN_COUNT)
        let half = FFT_SIZE / 2
        // ⚠️ 分箱的形状参数。
        //
        // USEFUL_BINS = **120**，因为 PWCircle 用的是 `arr[0..119]`（读过它的代码）。
        // 原来写的 76 来自另一个壁纸的消费边界，那是把单个样本的约束当成了通用规则。
        // ⚠️ 120 对两者都安全：Sonic Topography 只看前 76 段，那 76 段仍然落在
        // 音乐能量最集中的区域；而 PWCircle 需要 120 段都有值。
        // ⚠️ 40 而不是 20 —— 算过：20 时 (20,21)(22,23)(25,26) 这些相邻段会共用
        // 同一个 FFT bin（10/128 重复），而那正是画面上"等长柱子"的成因。
        // 40 时重复降到 **0**，而前 76 段仍到 4.9kHz、第 119 段到 15.9kHz，两个边界都合理。
        let LINEAR_BINS = 40
        let USEFUL_BINS = 120
        // 16 kHz 对应的 FFT bin —— 音乐能量的实际上界。
        // @48kHz / 1024 点 ⟹ 每 bin 46.9 Hz。
        let midTop = min(half - 1, Int(16000.0 / (48000.0 / 2.0 / Float(half))))
        for i in 0..<BIN_COUNT {
            var start: Int
            var end: Int
            if i < LINEAR_BINS {
                // 一对一：每个箱子独占一个 FFT bin，不可能重复。
                start = 1 + i
                end = start
            } else if i < USEFUL_BINS {
                let span = Float(USEFUL_BINS - LINEAR_BINS)
                let base = Float(1 + LINEAR_BINS)
                let ratio = Float(midTop) / base
                let lo = base * powf(ratio, Float(i - LINEAR_BINS) / span)
                let hi = base * powf(ratio, Float(i + 1 - LINEAR_BINS) / span)
                start = max(1 + LINEAR_BINS, Int(lo))
                end = min(half - 1, max(start, Int(hi) - 1))
            } else {
                let span = Float(BIN_COUNT - USEFUL_BINS)
                let base = Float(midTop)
                let ratio = Float(half) / base
                let lo = base * powf(ratio, Float(i - USEFUL_BINS) / span)
                let hi = base * powf(ratio, Float(i + 1 - USEFUL_BINS) / span)
                start = max(midTop, Int(lo))
                end = min(half - 1, max(start, Int(hi) - 1))
            }
            var sum: Float = 0
            for j in start...end { sum += magnitudes[j] }
            let mean = sum / Float(end - start + 1)
            // 归一化。⚠️ 用 sqrt 而不是线性：
            //
            // FFT 幅度的动态范围很大（安静段和鼓点差两个数量级），线性映射下
            // 要么安静时全是 0、要么鼓点时全部顶天 —— 用户报的"幅度不对"就是这个。
            // sqrt 压缩动态范围，效果接近人耳的对数感知，也是音频可视化的常规做法。
            var v = sqrtf(mean * NORMALIZE)
            // ⚠️ 上限 1.2 而不是 1.0 —— PWCircle 自己 clamp 到 1.2
            //（`w1 = Math.min(w1, 1.2)`），clamp 到 1.0 会白丢 17% 的动态范围。
            v = min(1.2, max(0.0, v))
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
