// CoreAudio 进程 tap 探针 **第二步**：走完整链条，真的读 PCM。
//
// ⚠️⚠️ 为什么要第二个探针，而不是直接改 GestureWallAudio.swift：
//
// 探针 1 证明了 `AudioHardwareCreateProcessTap` **不需要屏幕录制权限**
// （用户 2026-08-01 真机：`tapErr: 0` + `screenRecordingGranted: false`）
// —— 那推翻了我那句凭印象的话，而且是一条真出路。
//
// **但它只证明了第 1 步。** 完整链条是：
//   1. AudioHardwareCreateProcessTap      ✅ 探针 1 验过
//   2. 建 aggregate device 把 tap 挂上去   ❓
//   3. AudioDeviceCreateIOProcID + Start   ❓
//   4. 回调里真的拿到 PCM                  ❓
//
// ⚠️ 第 2-4 步任一失败都可能要别的权限，或者**拿到全 0** ——
// 而"全 0"是这个项目最熟悉的失败形态：它不报错，画面就是柱子不动，
// 而那和"没在放歌"、"壁纸不支持音频"长得一模一样（为它烧过四轮）。
//
// ⟹ 直接改代码的代价是：改完打包、用户看到柱子不动、我们再猜为什么。
//    而这个探针把"能不能用"变成**一个数字**（读到多少非零采样 + RMS）。
//
// 用法（放着音乐跑）：
//   swiftc -target arm64-apple-macos14.2 GestureWallAudioTapProbe2.swift -o /tmp/tap2
//   /tmp/tap2
//
// ⚠️ 它会跑 3 秒然后自己退出，不留任何东西（tap 和 aggregate device 都销毁）。

import Foundation
import CoreAudio
import AVFoundation

func emit(_ dict: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: dict),
          let line = String(data: d, encoding: .utf8) else { return }
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

// ⚠️ 每一步都单独报错误码 —— 链条上四步，失败在哪一步决定下一步做什么。
// 只报「失败了」的话，我又要靠猜（这个项目为「静默失败」烧过四轮）。
//
// ⚠️⚠️ **`exit()` 会跳过 `defer`** ⟹ 失败退出时要**手动清理**。
// 漏了这个的话，探针失败一次就在系统里留下一个 tap + 一个 aggregate device，
// 而那可能影响用户后续的音频（症状：某个应用没声音，而谁也想不到是探针留的）。
//
// ⟹ 用全局变量记住"建了什么"，fail() 里逐个销毁。
// ⚠️ 顺序：先销毁 aggregate device 再销毁 tap（tap 被它引用着）。
var createdTap = AudioObjectID(kAudioObjectUnknown)
var createdAgg = AudioObjectID(kAudioObjectUnknown)

func cleanup() {
    if createdAgg != AudioObjectID(kAudioObjectUnknown) {
        AudioHardwareDestroyAggregateDevice(createdAgg)
        createdAgg = AudioObjectID(kAudioObjectUnknown)
    }
    if createdTap != AudioObjectID(kAudioObjectUnknown) {
        AudioHardwareDestroyProcessTap(createdTap)
        createdTap = AudioObjectID(kAudioObjectUnknown)
    }
}

func fail(_ step: String, _ err: OSStatus, _ note: String = "") {
    cleanup()
    var v = "第「\(step)」步失败，错误码 \(err)"
    if !note.isEmpty { v += "。\(note)" }
    emit([
        "type": "tapprobe2",
        "ok": false,
        "failedStep": step,
        "err": Int(err),
        "verdict": v,
    ])
    exit(1)
}

guard #available(macOS 14.2, *) else {
    emit([
        "type": "tapprobe2", "ok": false,
        "verdict": "这台机器不到 macOS 14.2，CoreAudio 进程 tap 用不了。",
    ])
    exit(1)
}

// ── 1. 建 tap（全局，不排除任何进程）──────────────────────────────────
//
// ⚠️⚠️⚠️ **这里的初始化器选错会让 tap 没有源，而且不报错。**
//
// 我第一版用的是：
//     CATapDescription(stereoMixdownOfProcesses: [])
// 假设「空数组 = 全部进程」。**那个假设是错的** ——
// 那个初始化器的语义是「混音**这些**进程」⟹ 空数组 = **没有进程**。
//
// ⟹ tap 建起来了（`tapErr: 0`），但它**不监听任何进程**
// ⟹ 下游全部 noErr，而回调一次都不触发（用户 2026-08-01 实测两次）。
//
// ⟹ 正解是另一个初始化器：
//     CATapDescription(stereoGlobalTapButExcludeProcesses: [])
//   = 全局 tap，**排除**这些进程 ⟹ 空数组 = 不排除任何 = **全部**
//
// ⚠️ 两个初始化器名字很像、参数类型一样、都不报错 ——
// 而语义正好相反（白名单 vs 黑名单）。
// ⟹ 这类"选错重载但不报错"和 CFString 那次是同一个形状：
//    **每一步都成功，功能是死的**。
let desc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
desc.name = "GestureWall tap probe2"
desc.isPrivate = true
// ⚠️ 静音 tap 不能开 —— 那会让**用户听不到声音**（tap 把音频截走）。
// 默认是 unmuted，但显式写出来：这个字段错了的后果是"壁纸能动但没声音"，
// 而用户会以为是播放器坏了。
desc.muteBehavior = .unmuted
var tapID = AudioObjectID(kAudioObjectUnknown)
let tapErr = AudioHardwareCreateProcessTap(desc, &tapID)
if tapErr != noErr || tapID == AudioObjectID(kAudioObjectUnknown) {
    fail("建 tap", tapErr, "探针 1 里这步是成功的 —— 若这里失败，先重跑探针 1")
}
// ⚠️ 记下来 —— `fail()` 和结尾都要销毁它。
// **不用 defer**：`exit()` 会跳过 defer，而 fail() 里就是 exit。
createdTap = tapID

// tap 的 UID —— 挂到 aggregate device 上要用它。
//
// ⚠️⚠️⚠️ **这一段是探针 2 第一版零回调的根因。**
//
// 我原来写的是：
//     var tapUID: CFString = "" as CFString
//     AudioObjectGetPropertyData(tapID, &addr, 0, nil, &size, &tapUID)
//
// swiftc 给了警告（用户 2026-08-01 真机看到的）：
//     warning: forming 'UnsafeMutableRawPointer' to a variable of type 'CFString';
//     this is likely incorrect because 'CFString' may contain an object reference
//
// ⟹ `&tapUID` 取的是**Swift 变量本身的地址**，而 `CFString` 是引用类型
//    （变量里存的是指针）。CoreAudio 要往那里写一个 `CFStringRef`，
//    而它写进去之后 Swift 这边的 ARC 语义已经乱了 ⟹ 读出来是垃圾/空。
//
// ⚠️⚠️ 而后果**不是崩溃，是静默失效**：
//   UID 是空的 ⟹ aggregate device 挂了一个**不存在的 tap**
//   ⟹ 建设备成功（`noErr`）、挂 IOProc 成功、`AudioDeviceStart` 成功
//   ⟹ 但那个设备**没有任何输入源** ⟹ **回调一次都不触发**
//
//   观测到的正是这个：`callbacks: 0`，而每一步的错误码都是 0。
//
// ⚠️ 这是这个项目的**第三个「API 返回成功但不工作」**：
//   ① `addGlobalMonitorForEvents` 返回非 nil 但零回调（NSApplication 没初始化）
//   ② `Timer.scheduledTimer` 注册成功但不触发（没有主 RunLoop）
//   ③ 这次：aggregate device 建成功但没有源
//   ⟹ 共同点：**每一步都 noErr，而功能是死的** ⟹ 只查返回码不够，
//      必须有"真的读到数据了吗"这一层观测（这个探针就是为此存在的）。
//
// ⟹ 正解：用 `Unmanaged<CFString>` 接收 —— 那是"CoreFoundation 对象指针"
//    在 Swift 里的正确类型，`takeRetainedValue()` 再交给 ARC。
var tapUIDAddr = AudioObjectPropertyAddress(
    mSelector: kAudioTapPropertyUID,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
)
var uidRef: Unmanaged<CFString>?
var uidSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
let uidErr = AudioObjectGetPropertyData(tapID, &tapUIDAddr, 0, nil, &uidSize, &uidRef)
if uidErr != noErr { fail("读 tap UID", uidErr) }
// ⚠️ `kAudioTapPropertyUID` 是 **copy** 语义（调用方拥有）⟹ takeRetainedValue。
// 用 takeUnretainedValue 会过度释放 ⟹ 崩溃或用后即焚。
guard let uidRefValue = uidRef else {
    fail("读 tap UID", -1, "UID 是 nil —— 那正是上一版静默失效的形态")
    exit(1)
}
let tapUID = uidRefValue.takeRetainedValue()
// ⚠️ **UID 不能是空串** —— 空 UID 的 aggregate device 会"建成功但没有源"，
// 而那就是零回调。⟹ 这里挡住它，让失败变成可见的错误而不是静默。
if (tapUID as String).isEmpty {
    fail("读 tap UID", -2, "UID 是空串 ⟹ aggregate device 会没有输入源（零回调）")
}

// ── 2. 建 aggregate device，把 tap 挂进去 ───────────────────────────────
//
// ⚠️ 这一步是 CoreAudio tap 的必经之路：tap 自己不是设备，
// 要靠一个 aggregate device 才能走 IOProc 拿数据。
// 而它需要一个**唯一的 UID** —— 撞名会让第二次运行失败。
// ⚠️⚠️⚠️ **aggregate device 必须有一个 subdevice 提供时钟，否则没有 IO 周期。**
//
// 我第一版给了 `kAudioAggregateDeviceSubDeviceListKey: []`（空）——
// 而 aggregate device 的 **IO 周期是靠 subdevice 的时钟驱动的**
// ⟹ 没有 subdevice = 没有时钟 = **不产生 IO 周期** = 回调一次都不触发。
//
// ⟹ 把**默认输出设备**加进去。它只提供时钟（我们不往它写数据），
//    不会影响用户听到的声音。
//
// ⚠️ 这和 tap 描述那个错是同一轮的：两个都"建成功但不工作"，都不报错。
var defOutAddr = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultOutputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
)
var defOut = AudioDeviceID(0)
var defOutSize = UInt32(MemoryLayout<AudioDeviceID>.size)
let defOutErr = AudioObjectGetPropertyData(
    AudioObjectID(kAudioObjectSystemObject), &defOutAddr, 0, nil, &defOutSize, &defOut
)
if defOutErr != noErr || defOut == 0 {
    fail("读默认输出设备", defOutErr, "aggregate device 需要它提供时钟")
}
// 它的 UID —— subdevice 列表要用 UID 而不是 AudioDeviceID
var outUIDAddr = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyDeviceUID,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
)
// ⚠️ 同 tap UID：**CF 引用类型要用 Unmanaged 接收**，不能 `&裸CFString`
//（那次的后果是读到空 UID ⟹ 静默失效）。
var outUIDRef: Unmanaged<CFString>?
var outUIDSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
let outUIDErr = AudioObjectGetPropertyData(
    defOut, &outUIDAddr, 0, nil, &outUIDSize, &outUIDRef
)
if outUIDErr != noErr { fail("读默认输出设备 UID", outUIDErr) }
guard let outUIDValue = outUIDRef else {
    fail("读默认输出设备 UID", -1, "UID 是 nil")
    exit(1)
}
let outUID = outUIDValue.takeRetainedValue()

let aggUID = "com.gesturewall.tapprobe2.\(ProcessInfo.processInfo.processIdentifier)"
let aggDesc: [String: Any] = [
    kAudioAggregateDeviceNameKey as String: "GestureWall Tap Probe2",
    kAudioAggregateDeviceUIDKey as String: aggUID,
    // ⚠️ private = 不出现在用户的声音设置里。漏了它用户会看到一个奇怪的设备。
    kAudioAggregateDeviceIsPrivateKey as String: true,
    kAudioAggregateDeviceIsStackedKey as String: false,
    kAudioAggregateDeviceTapAutoStartKey as String: true,
    // ⚠️ **必须有一个 subdevice** —— 它提供时钟，见上面那段。
    kAudioAggregateDeviceSubDeviceListKey as String: [
        [kAudioSubDeviceUIDKey as String: outUID],
    ],
    // ⚠️ 主设备也指它 —— 那决定用谁的时钟当基准
    kAudioAggregateDeviceMainSubDeviceKey as String: outUID,
    kAudioAggregateDeviceTapListKey as String: [
        [kAudioSubTapUIDKey as String: tapUID,
         kAudioSubTapDriftCompensationKey as String: true],
    ],
]
var aggID = AudioObjectID(kAudioObjectUnknown)
let aggErr = AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggID)
if aggErr != noErr || aggID == AudioObjectID(kAudioObjectUnknown) {
    fail("建 aggregate device", aggErr,
         "tap 建起来了但挂不上设备 ⟹ 这条路走不通，保留 ScreenCaptureKit")
}
createdAgg = aggID

// ── 3. 挂 IOProc 并启动 ────────────────────────────────────────────────
//
// ⚠️⚠️ 计数器放在一个 **class 实例**里，而不是顶层 `var`。
//
// 原因：Swift 6 的严格并发检查会拒绝"在 @Sendable 闭包里改顶层 var"
// （`AudioDeviceCreateIOProcIDWithBlock` 的 block 是 @Sendable）
// ⟹ 报 `reference to captured var in concurrently-executing code`
// 或者在 Swift 5 模式下只警告 —— 而**警告和错误的差别取决于编译器版本**，
// 那是我在云端判不了的（跑不了 swiftc）。
//
// ⟹ 用 class：引用类型，闭包捕获的是引用，不触发那条检查。
// ⚠️ 这不是"更安全"（音频线程和主线程仍在竞争），但探针只读一次、
// 3 秒后主线程才读，实际不会撞上。真要上生产得加锁。
final class Counters {
    var frames = 0
    var nonZero = 0
    var sumSq: Double = 0
    var peak: Float = 0
    var channelsSeen = 0
    var callbacks = 0
    // ⚠️⚠️ **格式细节 —— 换过去之前必须确认的两件事之一。**
    //
    // 探针报了 `channels: 1`（只有一个 AudioBuffer），但那有两种可能：
    //   ① 真的是单声道（正好是 WE 要的 —— 它 `spec.channels = 1`）
    //   ② **交错的立体声**（L,R,L,R… 挤在一个 buffer 里）
    //
    // ⚠️ 若是 ② 而我按单声道读，采样率实际是一半
    // ⟹ **每个 FFT bin 对应的频率翻倍** ⟹ 整圈频率映射错位
    // ⟹ 而那是"画面看起来还行但对不上音乐"，最难发现的一类。
    //
    // ⟹ `mNumberChannels` 直接给出答案。
    var bufChannels: UInt32 = 0
    var bufBytes: UInt32 = 0
}
let c = Counters()

var procID: AudioDeviceIOProcID?
let ioErr = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, nil) {
    (_, inInputData, _, _, _) in
    c.callbacks += 1
    let list = inInputData
    let n = Int(list.pointee.mNumberBuffers)
    if n > c.channelsSeen { c.channelsSeen = n }
    // ⚠️ AudioBufferList 是变长结构 —— 只能用 UnsafeMutableAudioBufferListPointer
    // 遍历，直接 `list.pointee.mBuffers[i]` 只能拿到第一个（那是 C 的柔性数组）。
    let bufs = UnsafeMutableAudioBufferListPointer(
        UnsafeMutablePointer(mutating: list))
    for buf in bufs {
        // 记下格式（每次都一样，记第一次就够）
        if c.bufChannels == 0 {
            c.bufChannels = buf.mNumberChannels
            c.bufBytes = buf.mDataByteSize
        }
        guard let raw = buf.mData else { continue }
        let count = Int(buf.mDataByteSize) / MemoryLayout<Float>.size
        let p = raw.assumingMemoryBound(to: Float.self)
        for i in 0..<count {
            let v = p[i]
            c.frames += 1
            if v != 0 { c.nonZero += 1 }
            c.sumSq += Double(v) * Double(v)
            if abs(v) > c.peak { c.peak = abs(v) }
        }
    }
}
if ioErr != noErr { fail("挂 IOProc", ioErr) }

let startErr = AudioDeviceStart(aggID, procID)
if startErr != noErr {
    fail("启动设备", startErr,
         "⚠️ 若这一步报权限类错误，说明这条路仍要某种授权 —— 那时记下错误码")
}

// ── 4. 跑 3 秒，看读到什么 ─────────────────────────────────────────────
//
// ⚠️ 3 秒是因为：用户要有时间让音乐播着，而太久会让人以为卡住了。
Thread.sleep(forTimeInterval: 3.0)
AudioDeviceStop(aggID, procID)
if let pid = procID { AudioDeviceDestroyIOProcID(aggID, pid) }

let rms = c.frames > 0 ? (c.sumSq / Double(c.frames)).squareRoot() : 0
let dbfs = rms > 0 ? 20 * log10(rms) : -999

// ⚠️ **结论用 if/else 组装** —— 三元嵌套会让 Swift 类型检查超时（上一版踩过）。
var verdict = ""
if c.callbacks == 0 {
    verdict = "设备启动成功但**回调一次都没触发** ⟹ 和 addGlobalMonitorForEvents "
    verdict += "那次一样是「注册成功但不工作」。这条路不能用。"
} else if c.nonZero == 0 {
    verdict = "回调触发了 \(c.callbacks) 次、读到 \(c.frames) 个采样，**但全是 0** ⟹ "
    verdict += "要么当时没在放音乐，要么这条路拿不到系统输出。"
    verdict += "⚠️ 请**放着音乐**再跑一次 —— 那是这两种的判别方式。"
} else {
    verdict = "✅ **通了**：\(c.callbacks) 次回调、\(c.frames) 个采样、"
    verdict += "\(c.nonZero) 个非零（\(Int(Double(c.nonZero) / Double(c.frames) * 100))%）、"
    verdict += "RMS \(String(format: "%.4f", rms))（\(String(format: "%.1f", dbfs)) dBFS）。"
    verdict += "⟹ CoreAudio tap 能拿到系统音频，而且**不需要屏幕录制权限** "
    verdict += "⟹ 换过去之后菜单栏不会再显示「正在共享屏幕」。"
    // ⚠️ 但还有两件事要确认，否则换过去会引入新问题
    verdict += " ⚠️ 换之前还要定两件事："
    if c.bufChannels > 1 {
        verdict += "①格式是**交错的 \(c.bufChannels) 声道**"
        verdict += "（按单声道读会让频率映射整体翻倍，画面对不上音乐）；"
    } else {
        verdict += "①格式是**单声道**（正好是 WE 要的，直接用）；"
    }
    verdict += "②这个 RMS 是音量前还是音量后 —— **改一下系统音量再跑一次**："
    verdict += "RMS 跟着变=音量后（换过去要去掉那次乘系统音量），不变=音量前（保留）。"
    verdict += " 当前系统音量 \(Int(max(0, sysVol) * 100))%。"
}

// ⚠️⚠️ **系统音量 —— 换过去之前必须确认的另一件事。**
//
// PulseAudio 的 monitor（WE 用的）= **音量之后**的信号
// ScreenCaptureKit（我们现在用的）= **音量之前** ⟹ 我们为此乘了系统音量
// CoreAudio tap = **不知道**
//
// ⟹ 若 tap 已经是音量后，我们再乘一次就**乘了两遍**
//    ⟹ 音量 50% 时柱子只有 WE 的 1/4
//
// ⟹ 报出当前音量 + RMS，让用户**改音量跑两次**对比：
//    RMS 跟着变 ⟹ tap 是音量后 ⟹ 换过去要**去掉**那次乘法
//    RMS 不变   ⟹ tap 是音量前 ⟹ 保留乘法
var volAddr = AudioObjectPropertyAddress(
    mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
    mScope: kAudioDevicePropertyScopeOutput,
    mElement: kAudioObjectPropertyElementMain
)
var sysVol = Float32(-1)
var volSize = UInt32(MemoryLayout<Float32>.size)
if AudioObjectHasProperty(defOut, &volAddr) {
    if AudioObjectGetPropertyData(defOut, &volAddr, 0, nil, &volSize, &sysVol) != noErr {
        sysVol = -1
    }
}

// ⚠️ 正常路径也要清理（不能只靠 defer，因为上面已经改成手动了）
cleanup()

emit([
    "type": "tapprobe2",
    "ok": c.nonZero > 0,
    // ⚠️ 报出中间状态 —— 零回调时要能判"是哪一环空了"。
    // 前两版失败都是"每一步 noErr 但功能死"，而没有这些字段的话
    // 我只能继续猜（这一轮已经猜错两次：tap 初始化器、subdevice 列表）。
    "bufChannels": Int(c.bufChannels),
    "bufBytes": Int(c.bufBytes),
    "systemVolume": Double(String(format: "%.3f", max(0, sysVol))) ?? 0,
    "tapUID": tapUID as String,
    "outUID": outUID as String,
    "aggID": Int(aggID),
    "callbacks": c.callbacks,
    "frames": c.frames,
    "nonZero": c.nonZero,
    "channels": c.channelsSeen,
    "rms": Double(String(format: "%.4f", rms)) ?? 0,
    "dbfs": Double(String(format: "%.1f", dbfs)) ?? 0,
    "peak": Double(String(format: "%.4f", c.peak)) ?? 0,
    // ⚠️ 再报一次屏幕录制状态 —— 这个探针跑完才是完整的证据链
    "screenRecordingGranted": CGPreflightScreenCaptureAccess(),
    "verdict": verdict,
])
