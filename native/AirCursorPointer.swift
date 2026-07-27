import CoreGraphics
import Foundation
import ApplicationServices

struct PointerCommand: Decodable {
    let type: String
    let x: Double?
    let y: Double?
}

let source = CGEventSource(stateID: .hidSystemState)
var lastPoint = CGPoint(x: 0, y: 0)
var cursorHidden = false

if !AXIsProcessTrusted() {
    FileHandle.standardError.write("AirCursorPointer 缺少辅助功能权限，鼠标事件可能不会生效。\n".data(using: .utf8)!)
}

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
    cursorHidden = true
}

func showSystemCursor() {
    if !cursorHidden {
        return
    }
    CGDisplayShowCursor(CGMainDisplayID())
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
