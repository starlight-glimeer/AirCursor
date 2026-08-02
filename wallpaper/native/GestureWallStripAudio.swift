// 把视频的音轨去掉，视频轨**原样搬过去**（不重新编码）。
//
// ⚠️⚠️⚠️ **为什么需要这个东西**
//
// 用户 2026-08-02 报"video 这种壁纸不稳定，运行着会弹出来"，错误原文：
//     code 3: PIPELINE_ERROR_DECODE: Failed to send audio packet for decoding
//
// 挂掉的是**音轨**。而 `<video>` 上明明有 `muted` —— 那说明
// **Chromium 即使静音也照样解码音轨**（muted 只管"不输出到设备"）
// ⟹ 一个视频轨完全能放的壁纸，会因为音轨编码不支持（工坊里常见 AC-3 / E-AC-3 /
//   DTS，Chromium 都不带解码器）而**整个黑屏**。
//
// ⚠️ 而这件事在渲染进程里救不回来：
//   · `<video>` 没有"只解码视频轨"的开关
//   · `video.audioTracks` 在 Chromium 里**默认不存在**（要 flag）
//     ⟹ 0.9.109 我加的那个"关掉音轨再重试"是空转（自己的注释都写了"大概率拿不到"，
//       而用户的截图证明它真的没救回来）
//   · MediaSource + 只 append 视频 segment ⟹ 要在 JS 里解封装 mp4，太重
//
// ⟹ 放到宿主侧：macOS **自带 AVFoundation**，`AVAssetExportSession` 配
//   `passthrough` 预设可以只保留视频轨、**不重新编码**（几百 MB 的文件也就几秒）。
//   ⚠️ 不用 ffmpeg：那要往包里塞 40MB+，而系统已经有能干这件事的东西。
//
// ⚠️⚠️ **它只在真的撞到那个错时才跑**（懒转换 + 缓存）—— 不是装载每个视频壁纸
//   都转一遍。绝大多数壁纸的音轨是 AAC，Chromium 放得好好的。
//
// 用法：
//     GestureWallStripAudio <输入文件> <输出文件>
// 输出 JSON 一行，成功：{"ok":true,"out":"...","ms":1234}
//        失败：{"ok":false,"error":"..."}

import Foundation
import AVFoundation

// ⚠️ 输出必须是**一行 JSON** —— 上层按行读 stdout。多行/裸文本都会让它解析失败，
//   而那时上层只知道"helper 挂了"，不知道为什么。
func emit(_ dict: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: dict),
          let line = String(data: data, encoding: .utf8) else {
        FileHandle.standardOutput.write("{\"ok\":false,\"error\":\"json encode failed\"}\n".data(using: .utf8)!)
        return
    }
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

let args = CommandLine.arguments
guard args.count >= 3 else {
    emit(["ok": false, "error": "用法：GestureWallStripAudio <输入> <输出> [strip|reencode]"])
    exit(2)
}
let inPath = args[1]
let outPath = args[2]

// ⚠️⚠️⚠️ **第三个参数：两种模式**（0.9.136）。
//
// 用户 2026-08-02 撞到的**第二种**解码失败（截图原文）：
//   code 3: … Code=-12909 (-12909): VTDecompressionOutputCallback（已放 3.6s 后才挂）
// ⟹ 挂的是**视频轨**（VideoToolbox 的 kVTVideoDecoderBadDataErr），
//   而 0.9.135 只是把提示改准了 —— **壁纸还是放不了**，用户得自己去跑 ffmpeg。
//   ⚠️ 而他的原话是"还是有问题" ⟹ 报得准不等于修好了。
//
//   strip     = 只去音轨，passthrough（不重新编码，几秒）—— 音轨挂掉时用
//   reencode  = 重新编码视频轨 + 去音轨 —— 视频轨挂掉时用
//
// ⚠️ 两种分开而不是"总是 reencode"：
//   passthrough 是秒级、画质零损失；重编码要按分钟算而且有损。
//   ⟹ 能不重编码就不重编码。判据来自**错误原文说的是哪一轨**（见 video.js 的
//     decodeHint）—— 那也是这一轮的中心教训。
let mode = args.count >= 4 ? args[3] : "strip"
guard mode == "strip" || mode == "reencode" else {
    emit(["ok": false, "error": "模式只能是 strip 或 reencode，收到：\(mode)"])
    exit(2)
}

guard FileManager.default.fileExists(atPath: inPath) else {
    emit(["ok": false, "error": "输入文件不在：\(inPath)"])
    exit(2)
}

let started = Date()
let asset = AVURLAsset(url: URL(fileURLWithPath: inPath))

// ⚠️⚠️ **先确认有视频轨** —— 没有的话导出会"成功"但产出一个空文件，
//   而那比报错糟（上层拿到一个能打开但黑屏的文件）。
let videoTracks = asset.tracks(withMediaType: .video)
guard !videoTracks.isEmpty else {
    emit(["ok": false, "error": "这个文件里没有视频轨（可能整个文件就是坏的）"])
    exit(3)
}

// ⚠️ 目标位置已存在就先删 —— AVAssetExportSession 对已存在的输出直接失败。
if FileManager.default.fileExists(atPath: outPath) {
    try? FileManager.default.removeItem(atPath: outPath)
}
// 上层目录可能还不在（缓存目录第一次用）
try? FileManager.default.createDirectory(
    at: URL(fileURLWithPath: outPath).deletingLastPathComponent(),
    withIntermediateDirectories: true)

// ⚠️⚠️⚠️ **用 AVMutableComposition 而不是直接导出 asset**。
//
// 直接 `AVAssetExportSession(asset: asset, presetName: passthrough)` 会把**两条轨都**
// 搬过去 —— 那等于没干活。要"只要视频轨"，就得自己拼一个只有视频轨的 composition。
let composition = AVMutableComposition()
guard let compVideo = composition.addMutableTrack(
        withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
    emit(["ok": false, "error": "建不出视频轨（AVMutableComposition 拒绝）"])
    exit(3)
}

do {
    // ⚠️ 逐段插入所有视频轨（一般只有一条，但多机位素材会有多条）
    for track in videoTracks {
        try compVideo.insertTimeRange(
            CMTimeRange(start: .zero, duration: asset.duration),
            of: track, at: .zero)
        // ⚠️⚠️ **保留原始的 transform** —— 手机竖屏拍的视频靠它旋转 90°。
        //   漏了它的话导出来的视频是躺倒的，而那看起来像"我们把壁纸转坏了"。
        compVideo.preferredTransform = track.preferredTransform
        break   // 只要第一条：多条会叠在同一个时间段上，那不是我们要的
    }
} catch {
    emit(["ok": false, "error": "插入视频轨失败：\(error.localizedDescription)"])
    exit(3)
}

// ⚠️ `presetPassthrough` = **不重新编码**，只重新封装 ⟹ 快，而且画质零损失。
//   ⚠️ 而它对某些编码不可用（AVAssetExportSession 会在 export 时报）。
//
// ⚠️⚠️ **reencode 模式用 `AVAssetExportPresetHighestQuality`**（0.9.136）——
//   它会用**软件/硬件编码器重写每一帧**，那正是"某几帧硬解器不吃"这种问题的解法
//   （等价于 `ffmpeg -c:v libx264`，而我们不需要带 ffmpeg 进包）。
//   ⚠️ 代价说清楚：它按分钟算（不是秒），而且有损。
//     ⟹ 所以只在**视频轨真的挂了**的时候用，音轨那种仍然走 passthrough。
//   ⚠️ 而它同样只导 composition（里面只有视频轨）⟹ 音轨顺带也去掉了。
let presetName = mode == "reencode"
    ? AVAssetExportPresetHighestQuality
    : AVAssetExportPresetPassthrough
guard let session = AVAssetExportSession(
        asset: composition, presetName: presetName) else {
    emit(["ok": false,
          "error": mode == "reencode"
            ? "这个视频不支持重编码导出（编码太特殊）"
            : "这个视频不支持 passthrough 导出（编码太特殊）"])
    exit(3)
}
session.outputURL = URL(fileURLWithPath: outPath)
session.outputFileType = .mp4
session.shouldOptimizeForNetworkUse = false

// ⚠️⚠️ `exportAsynchronously` 是异步的，而这是个命令行工具 ——
//   不等它就直接退出，进程一死导出就断了（产出半个文件）。
//   ⟹ 用信号量等。⚠️ 而**必须有超时**：卡住的话上层会一直等一个不回来的 helper。
let sema = DispatchSemaphore(value: 0)
session.exportAsynchronously { sema.signal() }

// 10 分钟：passthrough 通常几秒，但几个 GB 的 4K 壁纸慢一点也正常。
if sema.wait(timeout: .now() + 600) == .timedOut {
    session.cancelExport()
    emit(["ok": false, "error": "导出超时（10 分钟）—— 文件太大或者磁盘太慢"])
    exit(4)
}

switch session.status {
case .completed:
    // ⚠️⚠️ **确认产出的文件真的能用** —— status == completed 但文件是 0 字节
    //   这种事在 AVFoundation 上出现过。而那时上层拿到一个"成功"的空文件 ⟹
    //   壁纸黑屏，而我们以为修好了。
    // ⚠️ 分两步写：`try? attributesOfItem(...)[.size] as? Int` 是**双重 optional**
    //   （`Int??`）—— `?? 0` 只解一层，`.some(nil)` 会被当成有值。
    //   这个项目在"静默用了错的值"上栽过很多次，宁可写长一点。
    let attrs = try? FileManager.default.attributesOfItem(atPath: outPath)
    let size = (attrs?[.size] as? Int) ?? 0
    if size < 1024 {
        emit(["ok": false, "error": "导出说成功，但产出的文件只有 \(size) 字节"])
        exit(5)
    }
    emit(["ok": true, "out": outPath, "bytes": size,
          "ms": Int(Date().timeIntervalSince(started) * 1000)])
case .failed:
    emit(["ok": false, "error": session.error?.localizedDescription ?? "导出失败（没给原因）"])
    exit(5)
case .cancelled:
    emit(["ok": false, "error": "导出被取消"])
    exit(5)
default:
    emit(["ok": false, "error": "导出结束时状态是 \(session.status.rawValue)"])
    exit(5)
}
