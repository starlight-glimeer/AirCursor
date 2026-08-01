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

// ── 1. 建 tap（全局混音）────────────────────────────────────────────────
let desc = CATapDescription(stereoMixdownOfProcesses: [])
desc.name = "GestureWall tap probe2"
desc.isPrivate = true
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
let aggUID = "com.gesturewall.tapprobe2.\(ProcessInfo.processInfo.processIdentifier)"
let aggDesc: [String: Any] = [
    kAudioAggregateDeviceNameKey as String: "GestureWall Tap Probe2",
    kAudioAggregateDeviceUIDKey as String: aggUID,
    // ⚠️ private = 不出现在用户的声音设置里。漏了它用户会看到一个奇怪的设备。
    kAudioAggregateDeviceIsPrivateKey as String: true,
    kAudioAggregateDeviceIsStackedKey as String: false,
    kAudioAggregateDeviceTapAutoStartKey as String: true,
    kAudioAggregateDeviceSubDeviceListKey as String: [],
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
}

// ⚠️ 正常路径也要清理（不能只靠 defer，因为上面已经改成手动了）
cleanup()

emit([
    "type": "tapprobe2",
    "ok": c.nonZero > 0,
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
