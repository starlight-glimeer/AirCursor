// CoreAudio 进程 tap 探针 —— 判「抓系统音频能不能不亮"正在共享屏幕"」。
//
// ⚠️⚠️⚠️ 这个文件的存在是因为**我说过一句没验过的话**。
//
// 用户 2026-08-01 问「为什么显示 GestureWall 正在共享屏幕」，我答：
//   「macOS 上抓系统输出没有别的免安装 API ——
//     CoreAudio 的进程 tap 要 14.2+ **而且同样要屏幕录制权限**」
//
// 而他接着说：「真的吗，必须要这个屏幕录制？我之前的手势那里我记得也操作桌面了，
// 就没有用到这个什么屏幕共享啊」—— **他是对的**：
//
//   手势（摄像头）   → 摄像头权限，菜单栏亮绿点
//   鼠标转发         → 辅助功能权限，**不亮任何指示**
//   系统音频（现在） → 屏幕录制权限，亮"正在共享屏幕"
//
// ⟹ 他的记忆没错，而我把"抓系统音频"的限制说成了整个应用的必然。
//
// ⚠️ 而那句「进程 tap 同样要屏幕录制权限」**我从没验过** —— 那是凭印象。
// 它正好是"能不能避开屏幕共享"的关键：
//   若真要屏幕录制 ⟹ 我们现在的做法没得选，说明照旧
//   若**不要** ⟹ **那是一条真出路**，值得换过去（用户就不会看到那个指示）
//
// ⟹ 这个探针只做一件事：在真机上问系统"我能不能建 process tap"，
//    并报出授权状态。不出音频数据、不改任何现有行为。
//
// 用法：
//   swiftc -target arm64-apple-macos14.2 GestureWallAudioTapProbe.swift -o /tmp/tapprobe
//   /tmp/tapprobe
//
// ⚠️ `-target` 必须 14.2+ —— 低了的话那些 API 符号压根不存在（编译失败），
// 而那本身就是答案的一部分（说明这条路对旧系统不可用）。

import Foundation
import CoreAudio
import AVFoundation

func emit(_ dict: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: dict),
          let line = String(data: d, encoding: .utf8) else { return }
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

// ⚠️ 系统版本先报出来 —— 这条路要 14.2+，而用户的系统版本决定了结论适不适用。
let os = ProcessInfo.processInfo.operatingSystemVersion
let osStr = "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"

if #available(macOS 14.2, *) {
    // ① 能不能列出"正在出声的进程" —— 那是 tap 的前提。
    //
    // ⚠️ 这一步就可能被权限挡住，而**它挡不挡是我们要的答案**：
    // 若这里就要屏幕录制权限，系统会返回错误或空列表。
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyProcessObjectList,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    let sizeErr = AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size
    )
    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    var procs = [AudioObjectID](repeating: 0, count: max(1, count))
    var listErr: OSStatus = noErr
    if sizeErr == noErr && count > 0 {
        listErr = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &procs
        )
    }

    // ② 试着**真的建一个 tap**（全局混音，不指定进程）。
    //
    // ⚠️ 这是决定性的一步：能建起来 ⟹ 不需要屏幕录制 ⟹ 有出路。
    // ⚠️ 建完立刻销毁 —— 这只是探针，不该留下任何东西在跑。
    var tapID = AudioObjectID(kAudioObjectUnknown)
    var tapErr: OSStatus = noErr
    var tapNote = ""
    let desc = CATapDescription(stereoMixdownOfProcesses: [])
    // ⚠️ 名字要能在系统的音频设备列表里认出来 —— 万一探针没清干净，
    // 用户能看到是谁留下的。
    desc.name = "GestureWall tap probe"
    desc.isPrivate = true
    tapErr = AudioHardwareCreateProcessTap(desc, &tapID)
    if tapErr == noErr && tapID != AudioObjectID(kAudioObjectUnknown) {
        tapNote = "建成功了"
        // ⚠️ 立刻销毁。漏了这一步会在系统里留一个 tap 对象，
        // 而那可能影响用户后续的音频（这个项目对"留下状态"很敏感）。
        let destroyErr = AudioHardwareDestroyProcessTap(tapID)
        if destroyErr != noErr { tapNote += "（销毁失败 \(destroyErr)，重启一下应用）" }
    } else {
        tapNote = "建不起来"
    }

    // ③ 顺带报屏幕录制授权状态 —— 那样能判"tap 成功是因为不需要，
    //    还是因为我们已经有屏幕录制权限了"。
    //
    // ⚠️⚠️ **这一步是这个探针最关键的对照** ——
    // 没有它的话，"tap 建成功"在已授权的机器上无法区分两种原因，
    // 而那正是我上一条犯的错（把没验的当成了结论）。
    let screenOK = CGPreflightScreenCaptureAccess()

    emit([
        "type": "tapprobe",
        "os": osStr,
        "available": true,
        "processListSizeErr": Int(sizeErr),
        "processListErr": Int(listErr),
        "processCount": count,
        "tapErr": Int(tapErr),
        "tapNote": tapNote,
        // 屏幕录制权限当前状态 —— 判"成功是不是靠它"
        "screenRecordingGranted": screenOK,
        // ⚠️ 结论要在这里给出来，而不是让人自己解释四个数字。
        "verdict": tapErr == noErr
            ? (screenOK
                ? "tap 能建，但**这台机器已经有屏幕录制权限** ⟹ 分不清是否依赖它。"
                  + "要定案：到 系统设置 → 隐私与安全性 → 屏幕录制 里**关掉** GestureWall，"
                  + "然后重跑这个探针。仍然成功 ⟹ 真的不需要，那是一条出路。"
                : "tap 能建，而屏幕录制**没有授权** ⟹ **不需要屏幕录制！**"
                  + "那就是出路 —— 换过去用户就不会看到"正在共享屏幕"。")
            : "tap 建不起来（错误 \(tapErr)）"
              + (screenOK ? "，而屏幕录制是授权的 ⟹ 这条路本身不通"
                          : "，可能是缺屏幕录制权限，也可能这条路不通 ⟹ "
                            + "先给屏幕录制授权再跑一次，能成功就说明它依赖那个权限"),
    ])
} else {
    emit([
        "type": "tapprobe",
        "os": osStr,
        "available": false,
        // ⚠️ 这也是答案的一部分：这条路对旧系统不可用
        // ⟹ 即使它在新系统上能避开屏幕录制，我们仍要保留 ScreenCaptureKit 兜底。
        "verdict": "这台机器是 macOS \(osStr)，CoreAudio 进程 tap 要 14.2+ ⟹ 用不了。"
            + "⟹ 这条路即使在新系统上可行，也必须保留 ScreenCaptureKit 作为旧系统的兜底。",
    ])
}
