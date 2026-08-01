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
import CoreAudio
// ⚠️ `kAudioHardwareServiceDeviceProperty_VirtualMainVolume` 定义在
// **AudioToolbox** 里（AudioServices），不在 CoreAudio ⟹ 两个都要 import。
// 云端编不了 swiftc ⟹ 这类"符号在哪个框架"的错只能靠人核，
// 而它的症状是 helper 编译失败 ⟹ 音频整条链没有（柱子完全不动）。
import AudioToolbox

let BIN_COUNT = 128
// 1024 点 FFT。取这个大小是因为 @48kHz 约 21ms 一帧，接近 60fps 的节奏；
// 再大就会让低频波纹的触发比画面慢半拍。
let FFT_SIZE = 1024
// 采样率。ScreenCaptureKit 给的是 48kHz。
//
// ⚠️ 这个常量我加过一次（第三版分箱时），而回退第三版时**连它一起删了** ——
// 然后 FFT 自检引用它 ⟹ `cannot find 'SAMPLE_RATE' in scope` ⟹ helper 编译失败
// ⟹ 音频整条链不工作，而用户看到的是"自检没输出"。
//
// ⚠️ 教训：回退一个改动时，要检查**有没有别的地方依赖它引入的东西**。
// 我回退的是"分箱模型"，而它顺带引入的常量被后来的代码用上了。
// 而 `node --check` 查不出 Swift 的问题 —— 那一层在云端只能靠人看。
// ⚠️ **44100 对齐 WE**（`spec.rate = 44100`），而且 `config.sampleRate` 也设成它
// ⟹ 这个常量必须和 SCStreamConfiguration 里那个一致，
//    否则自检报的频率是假的（我曾因此把 1kHz 期望段算错）。
let SAMPLE_RATE = 44100

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

// ⚠️⚠️ **vDSP 的实数 FFT 带 2 倍因子，这个 0.5 是抵消它、对齐 kiss_fftr。**
//
// `vDSP_fft_zrip` 为了效率省掉一次除 2 ⟹ 输出是标准 FFT 的 2 倍。
// WE 用 `kiss_fftr`（标准值）⟹ 不抵消的话我们的 magnitude 是它的两倍，
// 而 `0.35*log10(power)` 会把那个 2 倍放成 **+0.21 的输出偏移**
//（乘以频段加权后是 +0.07 ~ +0.29）⟹ 用户报「整体的柱子都太长了」。
//
// ⚠️ **量出来的，不是记的**（用户 0.9.13 真机自检）：
//   理论峰值 424.7（手写 DFT：1kHz @48kHz/1024 矩形窗，纯数学）
//   实测峰值 849.4（第 21 个 bin，位置也对）⟹ 比值 **2.00**
//
// ⟹ 这不是"我调的系数"：它的身份是**两个 FFT 库的约定差**，
//    大小由实测确定，而判据（能不能从 WE 的行为推出来）通过。
let VDSP_SCALE: Float = 0.5

// ⚠️⚠️⚠️ **「柱子太长」不是尺度 bug —— 三条独立验证都说尺度是对的。**
//
// 用户从 0.9.12 到 0.9.21 一直报「整体的柱子都太长了」，而我为它查了四轮。
// 现在能确定的是**这一层的幅度没有错**：
//
//   ① vDSP 的 2 倍因子已抵消 —— 真机自检量出比值 **2.00**（VDSP_SCALE=0.5）
//   ② `kiss_fftr`（WE 用的）前向变换**不做归一化** ⟹ 满幅正弦峰值 N/2 = 512
//      ⟹ 我们抵消后也是 512 ⟹ **两边同尺度**
//   ③ **帕塞瓦尔定理**（能量守恒，纯数学）：
//        Σ|X[k]|² = N² · rms²
//        用户实测 rms=0.2688 ⟹ 单边谱平均 magnitude = **12.2**
//        而他读数反解出的 magnitude 是 **3.8-12** ⟹ **同量级，对上了**
//      ⟹ 我们的 magnitude 是能量守恒下的正确值
//
// ⟹ 公式逐字抄 WE + 尺度对齐 + 能量守恒 ⟹ **同样音量下我们和真 WE 一样长**。
//
// ⚠️⚠️ 那作者的预览图为什么短（w1≈0.045-0.20 ⟹ magnitude 1.2-2.0）？
//   我们 3.8-12 ⟹ 差 3-6 倍 = **9.5-15.6 dB**
//   ⟹ 那完全在"作者录预览图时音量比用户现在低 10-15dB"的范围内
//
// ⚠️⚠️⚠️ **而这里有一个待验的、能从 WE 的行为推出来的真差异：**
//
//   WE 抓 PulseAudio 的 `.monitor` 源 —— 那是 sink 的**输出流**，
//   **经过系统音量控制之后**的信号 ⟹ 音量 50% 则信号也 50%。
//
//   而 ScreenCaptureKit 的 `capturesAudio` 抓的是**应用的音频输出**，
//   设计上**不受系统音量影响**（录屏时系统静音也该有声音）。
//
//   ⟹ 若为真：WE 那边音量小则柱子短，我们这边音量小柱子照旧长
//      ⟹ **那就是「整体太长」「太敏感」的根因**
//   ⟹ 线索：用户实测 RMS **−9.5/−11.4 dBFS**（很大的电平）。
//      一般听音乐时系统音量 30-50% ⟹ −20..−30 dBFS
//      ⟹ 我们读到 −10 左右，像是没经过衰减的原始流
//
//   ⚠️ **判法（面板已就位，不用改代码）：转系统音量看 RMS 变不变。**
//      变了 ⟹ 假设错，别改；不变 ⟹ 坐实，修法是把系统音量乘进去
//      （CoreAudio 的 `kAudioHardwareServiceDeviceProperty_VirtualMainVolume`）
//
// ⚠️ 在那之前**不许调幅度** —— 这一层的 Float 常量白名单只有三个，
//    守卫会拦住新增的（`test/audio-bins.test.js`）。

// ⚠️⚠️⚠️ **读系统输出音量，把它乘进采样。这是「柱子太长」的根因修复。**
//
// 用户 2026-08-01 实测坐实：**系统音量调到 0，柱子还在动。**
//
// 为什么这是对齐 WE 而不是我调参数：
//   WE 抓 PulseAudio 的 `.monitor` 源 —— 那是 sink 的**输出流**，
//   **经过系统音量控制之后**的信号 ⟹ 音量 50% 则 monitor 信号也 50%，
//   静音时 monitor 里就是**静音**。
//
//   而 ScreenCaptureKit 的 `capturesAudio` 抓的是**应用的音频输出**，
//   设计上**不受系统音量影响**（录屏时把系统静音也该录到声音）。
//
// ⟹ 两个平台的音频抓取点不同，而 WE 的公式是按"音量之后"的信号调的
//    ⟹ 补上这一乘是**平台差异的补偿**，判据（能不能从 WE 的行为推出来）——**能**。
//
// ⚠️ 而这也解释了用户从 0.9.12 到 0.9.21 一直报的两件事：
//   「整体的柱子都太长了」 = 我们的输入比 WE 大（他系统音量没开满）
//   「太敏感」            = 同一个原因（信号大 ⟹ 离 log10 地板远 ⟹ 一直在高位）
//
// ⚠️ 失败时返回 1.0（不衰减）——**不能返回 0**：读不到音量时静音整条链，
// 症状是"柱子完全不动"，而那和没授权是同一个画面（这个项目为它烧过四轮）。
func systemOutputVolume() -> Float {
    var deviceID = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    guard AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &deviceID
    ) == noErr, deviceID != 0 else { return 1.0 }

    // ⚠️ 先看是不是静音 —— 静音时 VirtualMainVolume 仍会返回上次的音量值
    //（macOS 把"静音"和"音量"分成两个属性）⟹ 漏了这一步静音时柱子照旧动。
    var muted = UInt32(0)
    var mutedSize = UInt32(MemoryLayout<UInt32>.size)
    var mutedAddr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyMute,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )
    if AudioObjectHasProperty(deviceID, &mutedAddr),
       AudioObjectGetPropertyData(deviceID, &mutedAddr, 0, nil, &mutedSize, &muted) == noErr,
       muted != 0 {
        return 0.0
    }

    var volume = Float32(1.0)
    var volSize = UInt32(MemoryLayout<Float32>.size)
    var volAddr = AudioObjectPropertyAddress(
        // ⚠️ **`VirtualMasterVolume` 在新 SDK 里改名成 `VirtualMainVolume`。**
        //
        // 用户 0.9.23 真机编译失败：
        //   error: 'kAudioHardwareServiceDeviceProperty_VirtualMasterVolume'
        //   has been renamed to 'kAudioHardwareServiceDeviceProperty_VirtualMainVolume':
        //   APIs deprecated as of macOS 10.9 and earlier are unavailable in Swift
        //
        // ⚠️ Apple 从 macOS 12 起把 Master/Slave 这类术语改成 Main/Secondary，
        // 而 Swift 对"10.9 之前废弃的 API"是**硬拒绝**（不是警告）。
        // ⟹ 那意味着旧名字在 Swift 里根本编不过，不存在兼容写法。
        //
        // ⚠️ 这类"符号名在新 SDK 里变了"云端查不出（跑不了 swiftc）——
        // 一轮打包的成本。守卫补了一条：禁止出现已知的旧名（见测试）。
        mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )
    if AudioObjectHasProperty(deviceID, &volAddr),
       AudioObjectGetPropertyData(deviceID, &volAddr, 0, nil, &volSize, &volume) == noErr {
        // VirtualMainVolume 是 0..1 的标量
        return min(1.0, max(0.0, volume))
    }

    // ⚠️ 退路：有些设备（尤其外接/聚合设备）没有 VirtualMainVolume，
    // 但有**逐声道**的 `kAudioDevicePropertyVolumeScalar`（element 1 = 左声道）。
    // 漏了这条退路的症状是"在某些输出设备上音量修复不生效"，
    // 而那看起来像"修复没做" —— 比报错更难查。
    var chanVol = Float32(1.0)
    var chanSize = UInt32(MemoryLayout<Float32>.size)
    var chanAddr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyVolumeScalar,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: 1
    )
    if AudioObjectHasProperty(deviceID, &chanAddr),
       AudioObjectGetPropertyData(deviceID, &chanAddr, 0, nil, &chanSize, &chanVol) == noErr {
        return min(1.0, max(0.0, chanVol))
    }

    // ⚠️ 两条都拿不到 ⟹ **不衰减**（返回 1.0），不是 0 ——
    // 返回 0 会静音整条链，症状和没授权一模一样（这个项目为它烧过四轮）。
    return 1.0
}

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
    private var real: [Float]
    private var imag: [Float]
    private var magnitudes: [Float]
    // ⚠️ 最近一帧 FFT 的原始峰值 magnitude —— **只给尺度自检用**。
    //
    // 为什么必须暴露：`process()` 只返回 128 段最终值，那已经过了
    // log10 + 加权 + clamp ⟹ **反解不回 magnitude**（clamp 会吃掉信息，
    // 我为此反解过一次得到 775，而那个值是被 min(1.0) 夹过的下界）。
    // ⟹ 要判"我们的 FFT 尺度和 kiss_fftr 差几倍"，只能看原始值。
    private(set) var lastPeakMagnitude: Float = 0
    private(set) var lastPeakBin = 0
    // 输入 PCM 的 RMS —— 判"柱子太长"是系统音量还是我们的实现（见 process 里的注释）
    private(set) var lastRMS: Float = 0
    // 上一帧的结果，用来做时间平滑。
    private var smoothed = [Float](repeating: 0, count: BIN_COUNT)

    init() {
        log2n = vDSP_Length(log2(Double(FFT_SIZE)))
        setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2))!
        // ⚠️⚠️⚠️ **这里原来有一个 Hann 窗，删了。WE 没有窗函数。**
        //
        // 我加它的理由（原注释）是"不加窗每帧边界的突变会撒一层假的高频"——
        // 那个说法本身是对的，是标准的 DSP 常识。**但它不是 WE 的行为**，
        // 而"频谱好不好看"这件事上 WE 的行为才是规格。
        //
        // WE 的链子（`PulseAudioPlaybackRecorder.cpp`）：
        //     m_audioFFTbuffer[i] = (audioBuffer[i] - 128) / 128.0f;
        //     kiss_fftr(cfg, m_audioFFTbuffer, out);
        //     ^^^^^^^^^ **中间什么都没有 == 矩形窗**
        //
        // 而这个差别不是"细节",它决定了整个圆环的样子。用户实测数据反推：
        //
        //   `0.35*log10(power)` 有一个**绝对地板**：power < 1 ⟹ 负数 ⟹ 被
        //   `max(0, v)` 夹成 0。而频段加权是**乘法** —— 它乘不动 0。
        //   满幅纯音的 magnitude ≈ 775 ⟹ **地板在满幅下方 58dB**。
        //
        //   用户段 80/100/119 的实测值 0.006/0.009/0.007 反推 magnitude = **1.02**，
        //   地板是 1.00 ⟹ 那 62 段不是"值小"，是**恒等于 0**。
        //
        //   矩形窗 vs Hann 的旁瓣：-13dB/6dB每倍频  vs  -31dB/18dB每倍频。
        //   一个 magnitude 70 的低音（用户段 1 的实测值）泄漏到 10 段之外：
        //     矩形 1.58（**在地板之上**）   Hann 0.002（地板之下 500 倍）
        //
        // ⟹ **WE 的频谱能填满圆环，靠的就是矩形窗的泄漏。** 那不是缺陷，
        //    是这套 log10 地板 + 频段加权公式赖以工作的前提：泄漏把整条谱
        //    抬到地板之上，log10 才有东西可压缩，加权才有东西可乘。
        //
        // 这一个原因同时解释用户报的两个症状：
        //   ①「12点到3点之间基本没有反应」 高段自身能量在地板下，泄漏被 Hann 掐掉
        //   ②「柱子之间高度差很大」        Hann 出孤立窄峰 + 旁边全 0；
        //                                矩形窗是涂抹的 ⟹ 峰周围连成片、过渡平滑
        //
        // ⚠️ 教训（第 11 次同一个形状）：**我又一次把"我知道的正确做法"
        //    放进了一个"实现别人的规格"的层里。** 前十次是分箱模型、归一化系数、
        //    `USEFUL_BINS=76`、`min(1.2,·)`。这次更隐蔽 —— 加窗不是从某个壁纸
        //    抄来的魔数，是教科书上的对的事，所以我审了这个文件八轮都没看它一眼。
        //    判据不变：**这一行能不能从 WE 的行为推出来？** 不能就不该在这层。
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
        // ⚠️⚠️ **去直流（DC offset）。**
        //
        // 用户实测（2026-07-31）：「3 点方向那个柱子基本上一直都是居高不下」。
        // 3 点方向 = 段 0，而段 0 读的是 `index = band*2 = 0` ——
        // **FFT bin 0 是直流分量，不是频率**。它等于信号的平均值，
        // 只要音频不完美居中它就一直有值，而且**不随音乐变化**。
        //
        // ⚠️ WE 那边第一步就做了这件事：
        //     m_audioFFTbuffer[i] = (audioBuffer[i] - 128) / 128.0f
        //                            ^^^^^^^^^^^^^^^ 它的输入是 8-bit 无符号 PCM
        //                                            （0..255，中心 128），减 128 去偏移
        //
        // 我们的输入是 Float32（理论上已居中），但 ScreenCaptureKit 的混音
        // 仍可能带偏移 —— 而 bin 0 会把它全部收下。
        // ⟹ 显式减均值，那是零成本的，而漏掉它的症状正好是"某根柱子永远最长"。
        //
        // ⚠️ 这一步**是**能从 WE 推出来的（它的 `-128` 干的就是这件事），
        // 所以它留着 —— 而上面那个 Hann 窗推不出来，所以删了。同一条判据。
        var centered = [Float](repeating: 0, count: FFT_SIZE)
        var dc: Float = 0
        vDSP_meanv(input, 1, &dc, vDSP_Length(FFT_SIZE))
        var negDC = -dc
        vDSP_vsadd(input, 1, &negDC, &centered, 1, vDSP_Length(FFT_SIZE))

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
                centered.withUnsafeBufferPointer { ptr in
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

        // ⚠️⚠️⚠️ **输入电平（RMS）—— 判"柱子太长"是音量还是实现。**
        //
        // 真 WE 的预览图（作者用真 WE 跑的，唯一独立真值）反解出的 magnitude
        // 只有 **1.2-2.0**，而我们是 **2.8-12** ⟹ 差 12dB。
        //
        // ⚠️ 而 12dB = 音量差 4 倍 ⟹ **完全可能是"作者录预览图时音量小"**。
        // ⟹ 那意味着预览图**定不了绝对幅度**，只能定形状（动态范围）。
        //
        // ⟹ 唯一能分开"音量差"和"实现差"的，是**报出输入 PCM 的 RMS**：
        //   RMS ≈ 0.03-0.1（−30..−20dBFS）= 正常听感音量 ⟹ 我们的实现偏大
        //   RMS ≈ 0.3+（−10dBFS 以上）    = 用户音量开得很大 ⟹ 不是实现问题
        //
        // ⚠️ 这条**必须先报再改**。我这一轮已经因为"没量就改"被推翻十一次，
        // 而 VDSP_SCALE 是第一个先量后改的 —— 那次一量就精确命中 2.00。
        var rms: Float = 0
        vDSP_rmsqv(input, 1, &rms, vDSP_Length(FFT_SIZE))
        lastRMS = rms

        // 记下原始峰值（尺度自检要用，正常路径不看它）
        var pk: Float = 0
        var pkAt = 0
        for i in 1..<(FFT_SIZE / 2) where magnitudes[i] > pk {
            pk = magnitudes[i]
            pkAt = i
        }
        lastPeakMagnitude = pk
        lastPeakBin = pkAt

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
        // ⚠️⚠️⚠️ **128 = 左声道 64 + 右声道 64（右半镜像），不是 128 个连续频段。**
        //
        // 这是这一层最关键的一个判断，而我前十一轮全建立在"128 个连续频段"上。
        //
        // ⚠️ 证据（三条互相独立，都指向 64）：
        //   ① WE 的算法本身是 **64 段**：`for (int band = 0; band < 64; band++)`，
        //      数组是 `audio16[16] / audio32[32] / audio64[64]`
        //      —— **它没有任何 128 长度的数组**
        //   ② shader uniform 是 `g_AudioSpectrum64Left` / `g_AudioSpectrum64Right`
        //      —— **两个 64**，加起来正好 128
        //   ③ 壁纸侧两种取样法都假设**数组两端对称**：
        //      `jquery.audiovisualizer.js:91` 的 `getRingArray` 交替 `shift()`/`pop()`
        //        —— 从**两端**往里对称削
        //      `PWLine.js:147` 的 `iv = (120 - 密度)/2`
        //        —— 从**中心**往两边取
        //      连续数组上这两种切法都毫无道理（会砍掉低频或只保留中频）。
        //
        // ⚠️ 反证（一条，所以这个结论不是铁的）：
        //   粒子壁纸把 128 线性重采样到 512（`r = floor(n*t/512)`）—— 当连续数组用。
        //   ⟹ **读代码分不出来**，而这个判断也无法从我们自己的数据判
        //      （数据能说"我发的效果好不好"，不能说"WE 发什么"）。
        //   ⟹ 判据只能是**用户看画面**，而这个改动是可逆的（一个 MIRROR 开关）。
        //
        // ⚠️ 而"连续 128"必然产生用户报了十几轮的那个症状：
        //   连续频段 ⟹ 值随 band 单向递减（音乐的 1/f 分布）
        //   ⟹ 圆环上从 3 点一路降到 2 点 ⟹ **必然螺旋**
        //   ⟹ 而段 119 紧贴段 0 是 5.6kHz 贴 47Hz ⟹ **3 点必然是分割线**
        //   用户 2026-08-01 的读数正是这个形状：
        //     3点 0.374 → 9点 0.101 → 2点 0.05（单向递减，无回升）
        //
        // 而镜像布局下：3点响 → 9点弱 → 绕回 2点又响 ⟹ **左右对称、绕回连续**。
        //
        // ⚠️⚠️ **最强的一条支持**：镜像让所有常量回到 WE 原值。
        //   加权分母  63     （我改成过 127）
        //   stride    2      （我用过 2，改成 1，两轮都错）
        //   覆盖范围  0-5.9kHz（我搞成过 11.2kHz）
        // ⟹ 我过去每一个错，都出自"把 64 段公式适配到 128 段"这个前提。
        //    前提换掉，那些补丁全都不需要了 —— **那本身就是前提对了的信号**。
        // ⚠️ 一路 = **64 段**（WE 的 `band < 64`）。128 = 左 64 + 右 64，
        // 而拼接在上层做（两路各自跑一次 process）。
        let bands = BIN_COUNT / 2
        var out = [Float](repeating: 0, count: bands)
        let half = FFT_SIZE / 2

        for band in 0..<bands {
            // ① **线性取样 band × 2**（WE 原值），但**跳过 bin 0**。
            //
            // WE：`int index = band * 2;` ⟹ 64 段覆盖 bin 0..126 ⟹ 0-5.4kHz。
            //
            // ⚠️ bin 0 是直流分量不是频率 —— 用户实测「3 点方向那根柱子一直
            // 居高不下」，而 3 点 = 段 0。上面已经去了直流，这里 +1 是双重保险：
            // 去直流靠整窗均值，而窗内的极低频（<20Hz 听不见的隆隆声）
            // 仍会落进 bin 0/1，那些不该驱动画面。
            let index = min(half - 1, band * 2 + 1)

            // ② **功率**，不开根。magnitudes 存的是 |X|（vDSP_zvabs 的输出），
            // 平方回去拿功率 —— WE 那边是 `f2 = f1*f1 + f2*f2`。
            //
            // ⚠️⚠️⚠️ **这里曾经是"在主瓣宽度上求三个 bin 的功率和"，撤了。**
            //
            // 我加它的理由：单点采样会抖（实测同一正弦落在 bin 正中 vs bin 中间时，
            // 邻居 bin 的值在 0% 和 98% 之间跳）⟹ 柱子高度无故抖动。
            // 而云端实测它确实把孤峰从 13.8 降到 5.8 个。
            //
            // ⚠️ **但 WE 没有这一步。** 源码（`/tmp/lwe`，即
            // `linux-wallpaperengine/src/WallpaperEngine/Audio/Drivers/Recorders/
            //  PulseAudioPlaybackRecorder.cpp`）逐字是：
            //
            //     int index = band * 2;
            //     float f1 = this->m_FFTinfo[index].r;
            //     float f2 = this->m_FFTinfo[index].i;
            //     f2 = f1 * f1 + f2 * f2;
            //
            // **单点取值，一个 bin。**
            //
            // ⟹ 用户 2026-08-01 的第一性原理（他为这条纠正了我三次）：
            //   「WE 是闭源的，壁纸作者看不到渲染器内部。他们只能在真 WE 上
            //     看效果来调，而那些壁纸在真 WE 上效果 OK —— 那是已验证的事实。
            //     ⟹ 我们要做的是反推出一个不用动的渲染器，
            //        不是针对某个壁纸做适配。」
            //
            // ⟹ 判据：**这一行能不能从 WE 的行为推出来？** 主瓣求和 —— **不能**。
            //   它是"我知道的正确做法"，和 Hann 窗那次犯的错**一模一样**：
            //   教科书上对的事，在别的场景下完全正确，但不是 WE 的行为。
            //
            // ⚠️ 而"单点采样会抖"这个观察**本身是对的** —— 那正说明
            //   真 WE 的柱子也会那样抖，而壁纸作者是**在那个抖动上**调效果的。
            //   我把它"修好"，反而离作者看到的画面更远。
            let m = magnitudes[index] * VDSP_SCALE
            let power = m * m

            // ③ **0.35 × log10(功率)**。
            // ⚠️ power ≤ 0 时 log10 是 -inf ⟹ 必须挡（WE 也判了 f2 > 0）。
            var v: Float = 0.0
            if power > 0.0 {
                v = LOG_SCALE * log10f(power)
            }

            // ④ **频段加权**：2 − e^((1 − band/63) − 0.5)
            // ⚠️ 分母是 **63**（WE 原值）—— 我曾改成 127 去适配 128 段，
            // 那是"把 64 段公式硬套到 128"的产物之一。
            let t = 1.0 - Float(band) / Float(bands - 1)
            let weight = 2.0 - expf(t - 0.5)
            v = v * weight

            // ⑤ clamp 到 0..1。⚠️ WE 是 `fmin(1.0f, …)` —— **只截上界**，
            // 而 log10 在功率 < 1 时是负数 ⟹ 下界也要挡
            //（否则柱子往反方向长）。
            //
            // ⚠️ 这个下界是一道**硬地板**：power < 1 ⟹ 输出恒 0，
            // 而频段加权是乘法、乘不动 0。那是"高段完全不动"的根因，
            // 靠的是矩形窗的泄漏把整条谱抬到地板之上（见 init 里那段注释）。
            v = min(1.0, max(0.0, v))

            // ⑥ **两向平滑，系数 0.3**（WE 的 `movetowards(cur, target, 0.3f)`）。
            // ⚠️ 我之前 ATTACK=1.0（上升不插值），理由是"PWCircle 自己有平滑"。
            // 而 WE 原版**就是平滑的** —— 壁纸作者是对着那个行为调效果的。
            smoothed[band] = smoothed[band] + (v - smoothed[band]) * SMOOTH
            let value = smoothed[band]

            // ⑦ 这一路（一个声道）的 64 段。**镜像拼接交给上层**。
            //
            // ⚠️ 原来这里写 `out[band]` 和 `out[BIN_COUNT-1-band]` 都写同一个
            // `value`，注释里说"分声道是锦上添花、暂时不做"。
            // **那个判断被用户 0.9.17 的实测证伪了**：
            //   「孤峰固定在第59段(37/60帧)」+「镜像逐段差 0.0000」
            //   ⟹ band 63 写到段 63 和段 64（**相邻**），而它的加权是 1.393（最大）
            //   ⟹ 9 点方向必然两根精确等高的最长柱子紧挨着 ⟹ 折线上一个尖顶
            // ⟹ 取平均的话，那两根柱子**在数学上不可能不相等** ⟹ 必须分声道。
            out[band] = value
        }

        return out
    }
}

// ⚠️ **FFT 自检**：喂一个已知频率的纯音，看它在频谱上占几段。
//
// 用户实测（2026-07-31）的尖刺全是**单段孤峰**（前后都低、只有它自己高），
// 位置每次变但都落在 2.5k-6kHz。而那在物理上不可能来自真实音乐：
//
//   FFT + Hann 窗的主瓣宽约 4 个 bin，而相邻段隔 2 个 bin
//   ⟹ 任何真实频率成分至少落进 **2 个相邻段**
//
// ⟹ 单段孤峰说明 FFT 这一层有问题。三个可能（都没验证）：
//   · 窗函数没生效 ⟹ 主瓣会很窄
//   · vDSP_ctoz 的 stride 用错 ⟹ 读到的不是连续样本
//   · magnitudes 被写坏
//
// **这三个用同一个测试就能分辨**：1kHz 纯音应该占 3-4 段且峰值在 bin 21 附近。
// ⟹ 启动时跑一次，把结果打出来。那比我继续推理有用
//（这个现象我已经猜错十次）。
func selfTestFFT(_ spectrum: Spectrum) {
    let freq: Float = 1000.0
    var tone = [Float](repeating: 0, count: FFT_SIZE)
    for i in 0..<FFT_SIZE {
        tone[i] = sinf(2.0 * Float.pi * freq * Float(i) / Float(SAMPLE_RATE))
    }
    // ⚠️ **跑多帧，不是一帧。**
    //
    // 第一版只跑一帧 ⟹ smoothed 从 0 开始只走 30% ⟹ 读到的是真实值的 0.3 倍
    //（用户的自检结果 0.289，除以 0.3 才是真实的 0.96）。
    // 那不影响"主瓣宽度"的判断，但**平滑的行为要多帧才看得出来** ——
    // 如果平滑有索引错位之类的问题，单帧看不出。
    //
    // 20 帧 ⟹ 0.7^20 ≈ 0.0008，已经收敛到 99.9%。
    // ⚠️ `process()` 现在返回**64 段**（一路声道），不是 128 ——
    // 镜像拼接搬到了调用点（两路各跑一次）。
    // 漏改这里会让下面的 `bins[BIN_COUNT-1-i]` **越界崩溃**，
    // 而 Swift 的数组越界是 fatalError ⟹ helper 直接死 ⟹ 音频整条链没了，
    // 用户看到的是"柱子不动"（和没授权同一个画面）。
    var bins = [Float](repeating: 0, count: BIN_COUNT / 2)
    for _ in 0..<20 {
        bins = spectrum.process(tone)
    }

    // ⚠️ **稳态信号下相邻段的跳变** —— 那是"单段孤峰"的直接判据。
    //
    // 纯音是稳态的，所以频谱应该是**光滑的钟形**：
    // 主瓣内相邻段的差值应该是渐变的，不该出现"这段 0.9、旁边 0.05"。
    //
    // 如果这个数很大，说明我们的分箱/平滑在**稳态信号上**就已经产生尖刺
    // ⟹ 那和音乐无关，是这一层的问题。
    // ⚠️⚠️ **只看前半（左声道那 64 段）。**
    //
    // 输出现在是镜像的（左 64 + 右 64 倒序），而所有判据在整个 128 上都会双计：
    //   主瓣宽度 ×2、镜像那一份被算成"主瓣外的孤立高值"（= 假尖刺）、
    //   峰值段可能落在后半（那时 peakSeg != expectSeg 会误报"频率映射错了"）。
    //
    // ⟹ 判据只跑前 64 段。而"镜像本身对不对"另有一条专门的检查（见下）。
    // `bins` 已经就是一路的 64 段 ⟹ 不用再切前半（那是 128 时代的写法）
    let bandsHalf = BIN_COUNT / 2
    let front = bins

    // 峰值段 + 它周围有几段超过峰值的 1/4（那是"主瓣宽度"的粗略度量）
    var peak = 0
    for i in 1..<front.count where front[i] > front[peak] { peak = i }

    // ⚠️ **排除主瓣附近** —— 我第一版没排除，而那让判据必然误报。
    //
    // 用户实测：稳态最大跳变 0.526（在第 10 段），而那正是**爬上峰值那一步**
    //（邻域 0.151 → 0.437 → 0.963：4 段宽的钟形，相邻差值必然接近 0.5）。
    // ⟹ 我的阈值 0.25 会把**任何正常的纯音**判成"有尖刺"。
    //
    // 而"尖刺"指的是**主瓣之外**出现孤立的高值 ——
    // 纯音的频谱该是"一个 4 段宽的钟形 + 其余全部接近 0"。
    var maxJump: Float = 0
    var jumpAt = 0
    for i in 1..<front.count {
        // 峰值 ±4 段是主瓣，它的陡峭是钟形本身，不是尖刺
        if abs(i - peak) <= 4 { continue }
        let d = abs(front[i] - front[i - 1])
        if d > maxJump { maxJump = d; jumpAt = i }
    }
    // ⚠️ 顺带报主瓣外的最大值 —— 那比跳变更直接：
    // 纯音下主瓣外该全是接近 0 的底噪，出现明显的值就是真尖刺。
    var outsidePeak: Float = 0
    var outsideAt = 0
    for i in 0..<front.count {
        if abs(i - peak) <= 4 { continue }
        if front[i] > outsidePeak { outsidePeak = front[i]; outsideAt = i }
    }
    let threshold = front[peak] * 0.25
    var wide = 0
    for v in front where v > threshold { wide += 1 }

    // ⚠️⚠️ **泄漏的衰减：近处 vs 远处。矩形窗下这才是有判别力的判据。**
    //
    // 用户 0.9.13 实测「主瓣宽 64 段」，而那是**期望行为**：
    // 矩形窗旁瓣 -13dB、6dB/倍频滚降 ⟹ 泄漏把整条谱抬到 log10 地板之上
    // （那正是上一轮删 Hann 窗的理由 —— WE 靠泄漏铺满圆环）。
    // 算术核过：他第 15 段读 0.706 ⟹ 反解 magnitude 27.5，
    // 而理论泄漏（相隔 10 bin）= 19.2 ⟹ 1.44 倍，同量级。
    //
    // ⟹ "有多少段亮"分不出好坏。**能分出好坏的是"远处比近处低多少"**：
    //   正常：泄漏随距离单调降（6dB/倍频）⟹ 远处明显更低
    //   异常：远处和近处一样高 ⟹ ctoz 的 stride 错 / 缓冲被写坏 / 索引乱了
    //         （那些会让频谱变成"到处都是能量"，画面上是一圈等长的柱子）
    var nearSum: Float = 0
    var nearN = 0
    var farSum: Float = 0
    var farN = 0
    for i in 0..<front.count {
        let d = abs(i - peak)
        if d >= 5 && d <= 10 { nearSum += front[i]; nearN += 1 }
        if d >= 25 { farSum += front[i]; farN += 1 }
    }
    let nearMean = nearN > 0 ? nearSum / Float(nearN) : 0
    let farMean = farN > 0 ? farSum / Float(farN) : 0
    // 差值而不是比值：这一层的输出已经过 log10，**差值就是 dB 意义上的比例**。
    let leakFalloff = nearMean - farMean

    // ⚠️ **镜像对不对**：段 i 和段 127−i 必须逐段相等。
    //
    // 这条查的是实现，不是假设：两半是同一份 `value` 写进去的
    // ⟹ 任何不相等都说明索引写错了（比如写成 `BIN_COUNT - band` 差一位）。
    // 而那种差一位的错在画面上表现为"接缝处有一根突兀的柱子"，
    // 看起来像音频问题，实际是这里的下标。
    // ⚠️ **这条检查改了含义。**
    //
    // 原来它查 `bins[i] == bins[127-i]`，因为那时 `process()` 自己做镜像
    //（两半写同一个 value）⟹ 恒等于 0，查的是"下标有没有写错"。
    //
    // 现在镜像在调用点用**两路不同声道**拼 ⟹ 自检只跑一路 ⟹ 这里没有可比的两半。
    // ⟹ 改成查**同一路自己跑两遍是否一致**（确定性检查）：
    //   纯音 + 同样的平滑状态 ⟹ 结果必须逐段相同。
    //   不相同 = 有未初始化的内存 / 悬空指针（那类 bug 时好时坏，最难查）。
    let again = spectrum.process(tone)
    var mirrorMaxDiff: Float = 0
    var mirrorAt = 0
    for i in 0..<min(bins.count, again.count) {
        let d = abs(bins[i] - again[i])
        if d > mirrorMaxDiff { mirrorMaxDiff = d; mirrorAt = i }
    }

    // ⚠️⚠️⚠️ **FFT 的绝对尺度：我们的 vDSP 和 WE 的 kiss_fftr 差几倍？**
    //
    // 用户 0.9.12 实测「整体的柱子都太长了」，平均 0.454（柱子 82px）。
    //
    // ⚠️ 而这**不能靠调系数解决** —— 那正是用户否掉过的做法
    //（「我们现在在调节柱子这件事本身就很奇怪」「我不相信他们做的这么差」）。
    // ⟹ 只能问：**我们的 magnitude 和 WE 的 magnitude 是不是同一个尺度？**
    //
    // 两边的输入尺度一样（WE 的 `(buf-128)/128` 和我们的 Float32 都是 ±1），
    // N 也一样（1024）⟹ **同一个信号进去，magnitude 应该相等**。
    // 而两边用的库不同：WE 是 `kiss_fftr`，我们是 `vDSP_fft_zrip`。
    //
    // ⚠️ **vDSP 的实数 FFT 带一个 2 倍因子**（它省掉了一次除 2，
    // Apple 的文档和 Accelerate 示例都要求输出乘 0.5 才等于标准 FFT）。
    // 而 kiss_fftr 给的是标准值。
    //
    // ⚠️⚠️ **但这条我只是"知道"，没有在这台机器上验过** ——
    // 而"若错则全盘推翻"的前提必须先证。所以这里不写死 0.5，
    // 而是**量出来**：
    //
    //   理论基准（纯数学，不依赖任何库）：
    //     满幅正弦、矩形窗、N 点 DFT，峰值 magnitude = N/2 —— 当频率恰好落在
    //     整数 bin 上时。1kHz @48kHz/1024 落在 bin 21.33 ⟹ 能量分散到邻居
    //     ⟹ 峰值会低一些（手算 DFT 得 424.7，即 N/2 的 0.83 倍）。
    //
    //   ⟹ 期望 = 512 × 0.83 ≈ 425。实测除以它就是**这台机器上的真实因子**。
    //      ≈1 ⟹ vDSP 没有 2 倍因子，我记错了，不要改代码
    //      ≈2 ⟹ 确认有，乘 0.5 是**对齐 WE**而不是调参
    //
    // ⚠️ 这个数字要报给用户看，而不是我在云端断言 —— 云端跑不了 swiftc。
    // ⚠️ 那个 0.83 是**算出来的，不是估的**：手写 DFT 跑
    // 1kHz @48kHz/1024 矩形窗，峰值 424.7，除以 N/2=512 得 **0.8295**
    //（1kHz 落在 bin 21.33，不是整数 ⟹ 能量分散到邻居 ⟹ 峰值低于 N/2）。
    // 验算脚本在 test/audio-bins.test.js 里（云端可跑，不需要 swiftc）。
    let theoryPeak = Float(FFT_SIZE) / 2.0 * 0.8295
    let scaleRatio = theoryPeak > 0 ? spectrum.lastPeakMagnitude / theoryPeak : 0

    // 1kHz 在哪一段：bin = 1000 / (24000/512) ≈ 21 ⟹ 段 = (21-1)/2 = 10
    let expectSeg = Int((freq / (Float(SAMPLE_RATE) / 2.0 / Float(FFT_SIZE / 2)) - 1) / 2)
    emit([
        "type": "selftest",
        "tone": Int(freq),
        "peakSeg": peak,
        "expectSeg": expectSeg,
        "peakValue": front[peak],
        // ⚠️ 镜像的逐段最大差值 —— 该恒为 0（两半写的是同一个 value）。
        // 非 0 = 下标写错了，症状是"圆环接缝处有一根突兀的柱子"。
        "mirrorMaxDiff": mirrorMaxDiff,
        "mirrorAt": mirrorAt,
        // ⚠️ FFT 的绝对尺度 —— 判"vDSP 和 kiss_fftr 差几倍"。
        // 报原始值和比值两个，因为比值的分母（理论期望）本身是我算的，
        // 只报比值的话我算错了就看不出来。
        "peakMagnitude": spectrum.lastPeakMagnitude,
        "peakBin": spectrum.lastPeakBin,
        "theoryPeak": theoryPeak,
        "scaleRatio": scaleRatio,
        // ⚠️ 这个数是判据：<2 说明主瓣太窄（窗函数或 stride 有问题），
        // 3-6 是正常的 Hann 窗主瓣
        "segsAboveQuarter": wide,
        // ⚠️ 泄漏衰减 —— 矩形窗下"亮几段"没判别力，"远处比近处低多少"才有。
        // 输出已过 log10 ⟹ 差值就是 dB 意义上的比例。
        "leakNear": nearMean,
        "leakFar": farMean,
        "leakFalloff": leakFalloff,
        // ⚠️ 稳态信号下的最大跳变。纯音的频谱该是光滑钟形 ⟹ 这个数该很小。
        // 如果它很大，说明分箱/平滑在稳态信号上就产生尖刺（和音乐无关）。
        "maxJump": maxJump,
        "jumpAt": jumpAt,
        // ⚠️ 主瓣外的最大值 —— 纯音下该接近 0（只有底噪）。
        // 它明显 > 0 就是真尖刺，而那比跳变更直接。
        "outsidePeak": outsidePeak,
        "outsideAt": outsideAt,
        "neighbors": [
            peak >= 2 ? front[peak - 2] : 0,
            peak >= 1 ? front[peak - 1] : 0,
            front[peak],
            peak + 1 < front.count ? front[peak + 1] : 0,
            peak + 2 < front.count ? front[peak + 2] : 0,
        ],
    ])
}



final class AudioTap: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    // 一个 Spectrum —— WE 是单声道（`spec.channels = 1`）。
    // ⚠️ 这里曾经是两个（分左右声道），撤了，理由见 pcm() 上面那段。
    private let spectrum = Spectrum()
    private var pending = [Float]()
    // 系统音量缓存（每 10 帧刷一次，见 didOutputSampleBuffer 里的注释）
    private var cachedVolume: Float = 1.0
    private var volumeTick = 0
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
            // ⚠️⚠️ **44100 和 1 声道都是对齐 WE，不是我挑的。**
            //
            // 源码（`/tmp/lwe/…/PulseAudioPlaybackRecorder.cpp:106-108`）：
            //     spec.format   = PA_SAMPLE_U8;
            //     spec.rate     = **44100**;
            //     spec.channels = **1**;
            //
            // 采样率决定每个 FFT bin 对应多少 Hz：
            //     44100/1024 = 43.07 Hz/bin   （WE）
            //     48000/1024 = 46.88 Hz/bin   （我们之前）
            // ⟹ 我们每一段对应的频率比 WE **高 8.8%**
            // ⟹ 壁纸作者是对着 WE 的频率映射调效果的（哪个段对应人声、哪个对应鼓）
            //    ⟹ 偏 8.8% 意味着他调好的"这一圈对应什么"整体挪了位置。
            //
            // ⚠️ 直接让 SCStream 给 44100，而不是自己重采样 ——
            // 重采样要插值，那会引入 WE 没有的滤波（同一个形状的错第三次）。
            config.sampleRate = 44100
            config.channelCount = 1
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
        guard var samples = pcm(from: buffer) else { return }
        // ⚠️⚠️ **乘系统音量** —— 见 `systemOutputVolume()` 上面那段：
        // WE 抓的 PulseAudio `.monitor` 是**音量之后**的信号，
        // 而 ScreenCaptureKit 抓的是音量之前的 ⟹ 补上这一乘才和 WE 同尺度。
        // 用户实测坐实：系统音量调到 0，柱子还在动。
        //
        // ⚠️ 每 10 帧读一次而不是每帧 —— CoreAudio 的属性查询有开销，
        // 而音量是人手动调的（10 帧 ≈ 0.2 秒，感知不到延迟）。
        // ⚠️ 但**第一帧就要读**（`volumeTick == 0`），否则启动瞬间用错的音量。
        if volumeTick % 10 == 0 {
            cachedVolume = systemOutputVolume()
        }
        volumeTick += 1
        let vol = cachedVolume
        if vol < 0.999 {
            for i in 0..<samples.count { samples[i] *= vol }
        }
        pending.append(contentsOf: samples)
        // 一次回调发几帧。**用户 0.9.17 实测：0%（恒 1 帧，每批 960 采样）**
        // ⟹ 我曾怀疑"push 模型下一次回调连发多帧 ⟹ movetowards 连做多次而
        //    时间没走 ⟹ 平滑速度随批大小漂"—— **那条假设已经被这个数证伪**。
        // 观测保留（换音源/换设备时批大小会变），但它不再是待查项。
        var framesThisCall = 0
        while pending.count >= FFT_SIZE {
            framesThisCall += 1
            let chunk = Array(pending.prefix(FFT_SIZE))
            pending.removeFirst(FFT_SIZE)
            let one = spectrum.process(chunk)
            // 拼成 128：**同一份 64 段镜像两次**。
            //
            // ⚠️ 这里曾经是"左声道前半 + 右声道后半"，撤了 ——
            // WE 的 shader uniform `g_AudioSpectrum64Left` 和 `64Right`
            // 传的是**同一个 `recorder.audio64`**（`CPass.cpp:889-890`）
            // ⟹ WE 的"左右"就是同一份数据。
            //
            // ⚠️⚠️ 于是段 63 和段 64（相邻，band 63 加权 1.393 最大）**精确相等**，
            // 在折线壁纸上是一个尖顶 —— 而**那个尖顶在真 WE 上也存在**。
            // 我曾为它做分声道，那让画面离作者调好的效果**更远**，不是更近。
            //
            // ⚠️ "128 = 左64+右64" 这个布局本身仍是我的**推测**：
            // WE 只有 audio16/32/64，而网页壁纸的 `wallpaperRegisterAudioListener`
            // 收到 128 个数 —— 而 linux-wallpaperengine 的 `CWeb.cpp`
            // **压根没接音频** ⟹ 这份逆向源码答不了那 128 段的真实格式。
            // 支撑它的是壁纸侧的三条间接证据（`getRingArray` 从两端削、
            // `PWLine.js:147` 的 `iv=(120-密度)/2` 从中心取、uniform 名字带 Left/Right），
            // 而用户实测「镜像 + 64 段让画面明显变好」⟹ 暂时保留。
            var bins = [Float](repeating: 0, count: BIN_COUNT)
            let bands = BIN_COUNT / 2
            for b in 0..<bands {
                bins[b] = one[b]
                bins[BIN_COUNT - 1 - b] = one[b]
            }
            emit([
                "type": "audio",
                "bins": bins.map { Double(round($0 * 10000) / 10000) },
                "rms": Double(round(spectrum.lastRMS * 10000) / 10000),
                "nth": framesThisCall,
                "batch": samples.count,
                // ⚠️ 报出来 —— 否则"音量乘了没生效"是静默失败，
                // 而它的症状（柱子还是长）和没改一模一样。
                "vol": Double(round(vol * 1000) / 1000),
            ])
        }
        // 防止上游比我们快时无界堆积。
        if pending.count > FFT_SIZE * 8 { pending.removeFirst(pending.count - FFT_SIZE) }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emitStatus("stopped", ["message": error.localizedDescription])
        exit(3)
    }

    // 取出**单声道** PCM（多声道取平均）。
    //
    // ⚠️⚠️⚠️ **这里曾经改成分左右声道，撤了。WE 抓的是单声道。**
    //
    // 源码定案（`/tmp/lwe/…/PulseAudioPlaybackRecorder.cpp` 第 106-108 行）：
    //     spec.format   = PA_SAMPLE_U8;
    //     spec.rate     = 44100;
    //     spec.channels = **1**;        ← 单声道
    //
    // 而 shader 那边（`CPass.cpp:889-890`）：
    //     addUniform ("g_AudioSpectrum64Left",  recorder.audio64, 64);
    //     addUniform ("g_AudioSpectrum64Right", recorder.audio64, 64);
    //                                          ^^^^^^^^^^^^^^^^ **同一个数组**
    // ⟹ WE 的"左右"是同一份数据，不是两次 FFT。
    //
    // ⚠️ 我做分声道的理由是"修镜像轴上的等高双柱"（band 63 写到相邻的段 63/64，
    // 加权 1.393 最大 ⟹ 两根等高最长柱子紧挨着 ⟹ 折线上一个尖顶）。
    // **但那个尖顶在真 WE 上也存在** —— 既然 64Left == 64Right，
    // 任何按"左右拼接"消费 128 的壁纸在真 WE 上都会看到同样的双柱。
    // ⟹ 那不是我们的 bug，而"修掉"它意味着**画面和作者调好的效果不一样**。
    //
    // ⟹ 用户的第一性原理（他为这条纠正了我三次）：
    //   壁纸在真 WE 上效果 OK 是已验证的事实 ⟹ 我们要反推一个不用动的渲染器。
    //   ⟹ 判据：这一行能不能从 WE 的行为推出来？分声道 —— **不能**。
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
        // ScreenCaptureKit 给的是**非交错**格式：每声道一个 AudioBuffer。
        // 取平均降成单声道 —— WE 的 `spec.channels = 1`。
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
        guard used > 0 else { return nil }
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
    // ⚠️ 启动时先跑一次 FFT 自检 —— 那比继续推理有用。
    //
    // 用户实测的尖刺是**单段孤峰**，而 FFT + Hann 窗的主瓣宽约 4 个 bin
    // ⟹ 真实音乐不可能产生单段孤峰。自检用 1kHz 纯音验这一条：
    //   segsAboveQuarter < 2  ⟹ 主瓣太窄（窗函数或 stride 有问题）
    //   3-6                   ⟹ 正常
    //   peakSeg != expectSeg  ⟹ 频率映射错了
    //
    // 输出会进 CloudWatch/终端，打包版里也会进面板的日志区。
    selfTestFFT(Spectrum())

    let tap = AudioTap(targetBundle: targetBundle)
    Task { await tap.start() }
    RunLoop.main.run()
}
