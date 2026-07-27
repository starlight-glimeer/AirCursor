import CoreGraphics
import Foundation

struct PointerCommand: Decodable {
    let type: String
    let x: Double?
    let y: Double?
}

let source = CGEventSource(stateID: .hidSystemState)
var lastPoint = CGPoint(x: 0, y: 0)

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

while let line = readLine() {
    guard let data = line.data(using: .utf8),
          let command = try? JSONDecoder().decode(PointerCommand.self, from: data) else {
        continue
    }

    let point = CGPoint(x: command.x ?? Double(lastPoint.x), y: command.y ?? Double(lastPoint.y))

    switch command.type {
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
        postMouse(.leftMouseDown, at: point)
        usleep(45_000)
        postMouse(.leftMouseUp, at: point)
    case "rightClick":
        lastPoint = point
        postMouse(.rightMouseDown, at: point, button: .right)
        usleep(45_000)
        postMouse(.rightMouseUp, at: point, button: .right)
    default:
        continue
    }
}
