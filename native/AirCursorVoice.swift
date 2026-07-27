import AppKit
import Foundation

final class VoiceDelegate: NSObject, NSSpeechRecognizerDelegate {
    func speechRecognizer(_ sender: NSSpeechRecognizer, didRecognizeCommand command: String) {
        guard let data = "\(command)\n".data(using: .utf8) else {
            return
        }
        FileHandle.standardOutput.write(data)
    }
}

let commands = [
    "点",
    "选",
    "开",
    "确认",
    "点击",
    "单击",
    "点一下",
    "启动",
    "唤醒",
    "退出",
    "停止",
    "打开网易云",
    "打开音乐",
    "打开微信",
    "打开浏览器",
    "打开谷歌",
    "打开 Safari",
    "打开访达",
    "打开终端",
    "打开 Cursor",
]

let delegate = VoiceDelegate()

guard let recognizer = NSSpeechRecognizer() else {
    FileHandle.standardError.write("系统语音初始化失败\n".data(using: .utf8)!)
    exit(1)
}

recognizer.commands = commands
recognizer.delegate = delegate
recognizer.listensInForegroundOnly = false
recognizer.blocksOtherRecognizers = false
recognizer.startListening()

FileHandle.standardOutput.write("__AIRCURSOR_VOICE_READY__\n".data(using: .utf8)!)
RunLoop.main.run()
