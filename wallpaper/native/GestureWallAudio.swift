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

// ⚠️ 这里原来有一大段注释，讲我从 PWCircle.js 反推出的三个"契约"
//（只用 arr[0..119] / 它自己有平滑 / 上限 1.2 / 柱子长度 = w1*range*100）。
//
// **那些观察是对的，但我从它们推出的结论全错了** ——
// 我用"某个壁纸怎么消费"去反推"我们该怎么产生"，而那两件事之间隔着 WE 本身。
// ⟹ 正确的做法是直接看 WE 怎么产生（出处见下）。
//
// 那段注释删了：它记录的是一条错误的推理路径，留着会误导下一次。
// 唯一值得留的：`param.range = properties.range.value / 5`（main.js:329）——
// 柱子长度是 w1×180px 而不是 w1×900px，我曾按 900 反推系数，算大了 5 倍。

// ⚠️⚠️⚠️ **这些参数不是我调的，是 Wallpaper Engine 的。**
//
// 出处：`linux-wallpaperengine`（逆向 WE 的开源项目）
// `src/WallpaperEngine/Audio/Drivers/Recorders/PulseAudioPlaybackRecorder.cpp`
//
//     f1 = 0.35f * log10(f2);                                    ← LOG_SCALE
//     dest = min(1.0f, f1 * (2.0f - pow(M_E, (1-band/63) - 0.5))) ← 频段加权
//     movetowards(current, target, 0.3f);                        ← SMOOTH
//
// ⚠️ 用户 2026-07-31 点出的第一性原理：
//   「应该是我们不理解那个壁纸软件它的渲染原理，所以我们通过这个壁纸去反推
//     我们的渲染器，目的是壁纸到我们的渲染器上效果都不错」
//
// 而我之前八轮都在**自己设计**这一层（线性/对数/插值分箱、sqrt/线性归一化、
// 要不要平滑），每轮靠他打包看效果 —— 那是把用户当测量仪器用。
//
// ⟹ 现在这一层没有"我的参数"。要改只有一个理由：
// **发现 WE 的真实行为和这里不一致**，而那要有出处（代码或实测数据）。
//
// LOG_SCALE  0.35 —— WE 的 `0.35f * log10(f2)`
// SMOOTH     0.3  —— WE 的 `movetowards(…, 0.3f)`，两个方向同一个系数
let LOG_SCALE: Float = 0.35
let SMOOTH: Float = 0.3

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
        // ⚠️⚠️⚠️ **这一段是 Wallpaper Engine 的真实算法**，不是我设计的。
        //
        // 用户 2026-07-31 点出了我的根本错误：
        //   「你为什么是在针对这个壁纸做适配，这很奇怪。应该是我们不理解那个壁纸
        //     软件它的渲染原理，所以我们通过这个壁纸去反推我们的渲染器」
        //   「Linux 和 Mac 应该是很相近的……他那个逆向应该会对我们非常有帮助」
        //
        // 他对。我为音频形状改了**八轮**，每轮都在自己设计分箱（线性/对数/插值），
        // 然后靠他打包看效果告诉我对不对 —— 那是把用户当测量仪器用。
        //
        // 而答案一直在 `linux-wallpaperengine`（逆向 WE 的开源项目）里：
        // `src/WallpaperEngine/Audio/Drivers/Recorders/PulseAudioPlaybackRecorder.cpp`
        //
        //     for (int band = 0; band < 64; band++) {
        //         int index = band * 2;
        //         f2 = re*re + im*im;                    // 功率，不开根
        //         f1 = 0.35f * log10(f2);
        //         dest[band] = min(1.0f, f1 * (2.0f - pow(M_E, (1.0f - band/63.0f) - 0.5f)));
        //     }
        //     movetowards(current, target, 0.3f);        // 两向平滑
        //
        // ⚠️ FFT 是纯算术，和平台无关 —— Linux 和 macOS 在这一层**完全相同**。
        // ⚠️ 那个项目是 GPL-3.0，这里只用它揭示的**算法**（公开的逆向成果、
        //    几十行数学），不复制代码 —— 那和"移植它"是两件事。
        //
        // ## 我猜错的每一条，以及为什么它们互相依赖
        //
        //   我的做法                    WE 的真实做法
        //   ─────────────────────────────────────────────
        //   对数/线性混合分箱            **band × 2，纯线性取样**
        //   magnitude（开根）            **功率（re²+im²，不开根）**
        //   线性归一化（还专门去掉 sqrt） **0.35 × log10()**
        //   无频段加权                   **2 − e^((1−band/63)−0.5)**
        //   ATTACK=1.0（不平滑上升）      **两向平滑，系数 0.3**
        //
        // ⚠️ 它们**必须一起用**：
        //   · "功率不开根"成立是因为后面有 log10（对数已经压缩了动态范围）
        //     ⟹ 我之前"去掉 sqrt 又不加 log"是两头都不对
        //   · 而频段加权是"柱子铺满整圈"的唯一原因（见下）
        //
        // ## 频段加权解释了用户的全部观察
        //
        //     band  0 → ×0.351    低频被**压**
        //     band 63 → ×1.393    高频被**放大**      ⟹ 4 倍差距
        //
        // WE 主动压低频、抬高频，抵消音乐 1/f 的天然分布 ⟹ 柱子铺满整圈。
        // 而我没有任何加权 ⟹ 低频原样保留 ⟹ 用户报「3 点那片特别长」。
        //
        // 而「颗粒粗、没有波浪感」也在这里：WE 每帧向目标插值 30%，
        // 我 ATTACK=1.0 直接跳。
        var out = [Float](repeating: 0, count: BIN_COUNT)
        let half = FFT_SIZE / 2

        for band in 0..<BIN_COUNT {
            // ① **线性取样**：band × 2。
            // ⚠️ WE 用 64 段时取 index = band*2（覆盖 FFT bin 0..126）。
            // 我们是 128 段 ⟹ 同样的 index = band*2 覆盖 0..254，
            // 那是同一套算法的更细版本（每段一个 bin，不做任何分组）。
            let index = min(half - 1, band * 2)

            // ② **功率**，不开根。magnitudes 里存的已经是 |X| = sqrt(re²+im²)
            // （vDSP_zvabs 的输出），所以这里平方回去拿功率。
            let magnitude = magnitudes[index]
            let power = magnitude * magnitude

            // ③ **0.35 × log10(功率)**。
            // ⚠️ power ≤ 0 时 log10 是 -inf ⟹ 必须挡住（WE 那边也判了 f2 > 0）。
            var v: Float = 0.0
            if power > 0.0 {
                v = LOG_SCALE * log10f(power)
            }

            // ④ **频段加权**：2 − e^((1 − band/(N−1)) − 0.5)
            // ⚠️ 分母用 BIN_COUNT−1（WE 64 段时用 63）—— 那让加权曲线
            // 在我们 128 段下保持同样的形状（0.351 → 1.393）。
            let t = 1.0 - Float(band) / Float(BIN_COUNT - 1)
            let weight = 2.0 - expf(t - 0.5)
            v = v * weight

            // ⑤ clamp 到 0..1。⚠️ WE 是 `fmin(1.0f, …)` —— **只截上界**，
            // 而 log10 在功率很小时是负数 ⟹ 下界也要挡（否则柱子会往反方向长）。
            v = min(1.0, max(0.0, v))

            // ⑥ **两向平滑，系数 0.3**（WE 的 `movetowards(cur, target, 0.3f)`）。
            // ⚠️ 我之前 ATTACK=1.0（上升不插值），理由是"PWCircle 自己有平滑，
            // 再平滑就是双重平滑"。而 WE 原版**就是平滑的** ——
            // 壁纸作者是对着这个行为调的效果，所以我们平滑才对。
            // 那也是「波浪感」的来源：相邻帧之间连续变化，而不是每帧跳。
            smoothed[band] = smoothed[band] + (v - smoothed[band]) * SMOOTH
            out[band] = smoothed[band]
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
