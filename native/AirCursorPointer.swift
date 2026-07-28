import CoreGraphics
import Foundation
import ApplicationServices
import AppKit

struct PointerCommand: Decodable {
    let type: String
    let x: Double?
    let y: Double?
}

let source = CGEventSource(stateID: .hidSystemState)
var lastPoint = CGPoint(x: 0, y: 0)
var cursorHidden = false

// Answered on stdout so the main process can tell "the helper is running" from
// "the helper is running and the OS will actually deliver its events". Without
// the Accessibility grant CGEvent.post fails silently — no error, no exception,
// the events simply never arrive — so this verdict is the only way to know.
func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          var line = String(data: data, encoding: .utf8) else {
        return
    }
    line.append("\n")
    FileHandle.standardOutput.write(line.data(using: .utf8)!)
}

if !AXIsProcessTrusted() {
    FileHandle.standardError.write("AirCursorPointer 缺少辅助功能权限，鼠标事件不会生效。\n".data(using: .utf8)!)
}
emit(["type": "ready", "trusted": AXIsProcessTrusted()])

func currentMousePoint() -> CGPoint {
    CGEvent(source: nil)?.location ?? lastPoint
}

func postMouse(_ type: CGEventType, at point: CGPoint, button: CGMouseButton = .left) {
    guard let event = CGEvent(
        mouseEventSource: source,
        mouseType: type,
        mouseCursorPosition: point,
        mouseButton: button
    ) else {
        return
    }
    event.post(tap: .cghidEventTap)
}

func hideSystemCursor() {
    if cursorHidden {
        return
    }
    CGDisplayHideCursor(CGMainDisplayID())
    NSCursor.hide()
    cursorHidden = true
}

func showSystemCursor() {
    if !cursorHidden {
        return
    }
    CGDisplayShowCursor(CGMainDisplayID())
    NSCursor.unhide()
    cursorHidden = false
}

atexit {
    showSystemCursor()
}

while let line = readLine() {
    guard let data = line.data(using: .utf8),
          let command = try? JSONDecoder().decode(PointerCommand.self, from: data) else {
        continue
    }

    let point = CGPoint(x: command.x ?? Double(lastPoint.x), y: command.y ?? Double(lastPoint.y))

    switch command.type {
    case "ping":
        // Re-read the trust state rather than caching it: the user can grant the
        // permission while the app is already running.
        emit(["type": "pong", "trusted": AXIsProcessTrusted()])
    case "hideCursor":
        hideSystemCursor()
    case "showCursor":
        showSystemCursor()
    case "move":
        lastPoint = point
        postMouse(.mouseMoved, at: point)
    case "down":
        lastPoint = point
        postMouse(.leftMouseDown, at: point)
    case "up":
        lastPoint = point
        postMouse(.leftMouseUp, at: point)
    case "click":
        lastPoint = point
        postMouse(.mouseMoved, at: point)
        postMouse(.leftMouseDown, at: point)
        usleep(45_000)
        postMouse(.leftMouseUp, at: point)
    case "clickCurrent":
        let current = currentMousePoint()
        lastPoint = current
        postMouse(.leftMouseDown, at: current)
        usleep(45_000)
        postMouse(.leftMouseUp, at: current)
    case "rightClick":
        lastPoint = point
        postMouse(.mouseMoved, at: point)
        postMouse(.rightMouseDown, at: point, button: .right)
        usleep(45_000)
        postMouse(.rightMouseUp, at: point, button: .right)
    default:
        continue
    }
}
