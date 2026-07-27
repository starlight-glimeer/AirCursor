import AVFoundation
import Foundation
import Speech

let commandAliases: [(canonical: String, aliases: [String])] = [
    ("启动", ["启动", "唤醒", "开始", "开启控制", "打开控制"]),
    ("退出", ["退出", "停止", "隐藏", "关闭控制", "关掉控制"]),
    ("打开网易云", ["打开网易云", "网易云", "打开音乐"]),
    ("打开微信", ["打开微信", "微信"]),
    ("打开浏览器", ["打开浏览器", "打开谷歌", "谷歌", "Chrome"]),
    ("打开 Safari", ["打开 Safari", "Safari"]),
    ("打开访达", ["打开访达", "访达", "Finder"]),
    ("打开终端", ["打开终端", "终端", "Terminal"]),
    ("打开 Cursor", ["打开 Cursor", "Cursor"]),
    ("点", ["点", "选", "开", "确认", "点击", "单击", "点一下"]),
]

let exactCommandAliases = Set(["点", "选", "开", "确认", "点击", "单击", "点一下"].map(normalize))

func emit(_ value: String) {
    guard let data = "\(value)\n".data(using: .utf8) else {
        return
    }
    FileHandle.standardOutput.write(data)
}

func normalize(_ value: String) -> String {
    value
        .replacingOccurrences(of: " ", with: "")
        .replacingOccurrences(of: "，", with: "")
        .replacingOccurrences(of: ",", with: "")
        .replacingOccurrences(of: "。", with: "")
        .lowercased()
}

final class VoiceEngine {
    private let audioEngine = AVAudioEngine()
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh_CN"))
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var lastCommand = ""
    private var lastCommandAt = Date.distantPast
    private var lastTranscript = ""
    private var lastTranscriptAt = Date.distantPast
    private var pulseActive = false
    private var pulseStartedAt = Date.distantPast
    private var lastPulseAt = Date.distantPast
    private var loudFrames = 0
    private var quietFrames = 0
    private var noiseFloor: Float = 0.006
    private var pulsePeak: Float = 0
    private var restarting = false

    func requestAccessAndStart() {
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            guard status == .authorized else {
                emit("__AIRCURSOR_VOICE_ERROR__:需要在系统设置里允许语音识别")
                return
            }

            AVCaptureDevice.requestAccess(for: .audio) { granted in
                guard granted else {
                    emit("__AIRCURSOR_VOICE_ERROR__:需要在系统设置里允许麦克风")
                    return
                }

                DispatchQueue.main.async {
                    self?.start()
                }
            }
        }
    }

    private func start() {
        guard let recognizer else {
            emit("__AIRCURSOR_VOICE_ERROR__:系统语音识别不可用")
            return
        }

        if !recognizer.isAvailable {
            emit("__AIRCURSOR_VOICE_ERROR__:系统语音识别暂不可用")
            return
        }

        task?.cancel()
        task = nil
        request = SFSpeechAudioBufferRecognitionRequest()
        guard let request else {
            emit("__AIRCURSOR_VOICE_ERROR__:语音请求初始化失败")
            return
        }

        request.shouldReportPartialResults = true
        request.contextualStrings = commandAliases.flatMap { $0.aliases }
        request.taskHint = .confirmation

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1_024, format: format) { [weak self, weak request] buffer, _ in
            request?.append(buffer)
            self?.handleAudioPulse(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            emit("__AIRCURSOR_VOICE_ERROR__:麦克风启动失败")
            return
        }

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            if let result {
                self?.handleTranscript(result.bestTranscription.formattedString)
            }

            if error != nil || result?.isFinal == true {
                self?.restartSoon()
            }
        }

        emit("__AIRCURSOR_VOICE_READY__")
    }

    private func handleTranscript(_ transcript: String) {
        let text = normalize(transcript)
        guard !text.isEmpty else {
            return
        }

        let now = Date()
        if text != lastTranscript || now.timeIntervalSince(lastTranscriptAt) > 1.2 {
            lastTranscript = text
            lastTranscriptAt = now
            emit("__AIRCURSOR_VOICE_HEARD__:\(transcript)")
        }

        for item in commandAliases {
            let aliases = item.aliases.map(normalize)
            let matched: Bool
            if item.canonical == "点" {
                matched = aliases.contains(text) || exactCommandAliases.contains(text)
            } else {
                matched = aliases.contains(where: { text.contains($0) })
            }

            if matched {
                if item.canonical == lastCommand && now.timeIntervalSince(lastCommandAt) < 0.9 {
                    return
                }
                lastCommand = item.canonical
                lastCommandAt = now
                emit(item.canonical)
                return
            }
        }
    }

    private func handleAudioPulse(_ buffer: AVAudioPCMBuffer) {
        guard let channel = buffer.floatChannelData?[0] else {
            return
        }

        let frameCount = Int(buffer.frameLength)
        guard frameCount > 0 else {
            return
        }

        var sum: Float = 0
        var peak: Float = 0
        for index in 0..<frameCount {
            let sample = abs(channel[index])
            sum += sample * sample
            peak = max(peak, sample)
        }

        let rms = sqrt(sum / Float(frameCount))
        let rmsThreshold = max(Float(0.010), noiseFloor * 2.35)
        let peakThreshold = max(Float(0.050), noiseFloor * 7.0)
        let loud = rms > rmsThreshold || peak > peakThreshold
        let now = Date()

        if loud {
            quietFrames = 0
            pulsePeak = max(pulsePeak, peak)
            if pulseActive {
                return
            }

            loudFrames += 1
            if loudFrames >= 2 || peak > 0.09 {
                pulseActive = true
                pulseStartedAt = now
                pulsePeak = peak
            }
            return
        }

        if !pulseActive {
            loudFrames = 0
            pulsePeak = 0
            let bounded = min(max(rms, 0.001), 0.05)
            noiseFloor = noiseFloor * 0.985 + bounded * 0.015
            return
        }

        guard pulseActive else {
            return
        }

        quietFrames += 1
        guard quietFrames >= 3 else {
            return
        }

        pulseActive = false
        loudFrames = 0
        let duration = now.timeIntervalSince(pulseStartedAt)
        guard duration >= 0.045 && duration <= 1.15 else {
            pulsePeak = 0
            return
        }
        guard pulsePeak > 0.035 else {
            pulsePeak = 0
            return
        }
        guard now.timeIntervalSince(lastPulseAt) > 0.6 else {
            pulsePeak = 0
            return
        }

        lastPulseAt = now
        pulsePeak = 0
        emit("__AIRCURSOR_VOICE_TAP__")
    }

    private func restartSoon() {
        if restarting {
            return
        }
        restarting = true
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
            self?.restarting = false
            self?.start()
        }
    }
}

let engine = VoiceEngine()
engine.requestAccessAndStart()
RunLoop.main.run()
