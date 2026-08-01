import CoreGraphics
import Foundation
import ApplicationServices
import AppKit

struct PointerCommand: Decodable {
    let type: String
    let x: Double?
    let y: Double?
    // Scroll notches (positive scrolls content down) and the key to press for
    // desktop switching, both optional so existing mouse commands are unchanged.
    let dy: Double?
    let key: String?
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

// ⚠️⚠️⚠️ **主动请求辅助功能授权**（0.9.76）。
//
// 用户 2026-08-01：「你只要能保证需要用到的时候能够弹出来让授权的东西，
// 用户授权一下就行」
//
// ⚠️ 原来这里只调 `AXIsProcessTrusted()` —— 那是**纯查询**，
//   它**永远不会弹框**。⟹ 用户看到的是"一个鼠标事件都没转发进去"，
//   而没有任何东西告诉他"去授权"，更没有弹框让他点。
//
// ⟹ `AXIsProcessTrustedWithOptions` + `kAXTrustedCheckOptionPrompt: true`
//   是 macOS **唯一**会自动弹辅助功能授权框的 API。
//   它弹的是系统标准框（"XXX 想要控制此电脑…" + 「打开系统设置」按钮）。
//
// ⚠️ 三件必须知道的：
//   ① 它**只在还没授权时**弹 —— 已授权时是静默的 true，不会骚扰用户
//   ② 弹框之后**这个进程不会自动获得授权** —— 用户在系统设置里勾选之后，
//      macOS 要求**重启进程**才生效。⟹ 我们仍然要报 trusted: false，
//      让面板显示"授权后重开本应用"（那段文案已经在了）
//   ③ 用户点「稍后」的话不会再弹（macOS 记住了）⟹ 那时只能靠面板的提示
//
// ⚠️ 弹框里显示的名字是**这个二进制的名字**（AirCursorPointer），
//   不是主应用 —— 那是 TCC 按可执行文件记授权的必然结果。
//   面板上那句「授权列表里找 AirCursorPointer」就是为这个写的。
//
// ⚠️⚠️ **先查，只有真没授权才弹**（0.9.86）。上面 ① 那句"已授权时是静默的
//   true，不会骚扰用户"我**没实测过**，是照着"应该如此"写的。而鼠标 helper
//   （GestureWallMouse）那边实测的结果是：用户每装载一个壁纸都被弹一次。
//   ⟹ 不赌这个 API 的行为，自己先用纯查询判一次。
//   这个 helper 是幂等启动的（systemBridge.startPointer），不像鼠标那个会反复
//   重启，所以不需要 --no-ax-prompt 那套；但形状一样，一起改掉。
// ⚠️⚠️⚠️ **这个 helper 也一个框都不弹**（0.9.87）——
//   弹框的责任全部收到主进程（见 GestureWallMouse.swift 里那段，
//   以及 main.js 的 `ensureAccessibility()`）。
//   这个 helper 由 `systemBridge.startPointer()` 幂等拉起，但它**会在
//   sendPointer 发现进程死掉时被重拉** ⟹ 同样不能在这里弹。
let axTrusted = AXIsProcessTrusted()

if !axTrusted {
    FileHandle.standardError.write("AirCursorPointer 缺少辅助功能权限，鼠标事件不会生效。已弹出授权请求。\n".data(using: .utf8)!)
}
emit(["type": "ready", "trusted": axTrusted])

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

// Pixel units, not lines: `.line` scrolls by whole rows, which reads as a jump
// on a trackpad-smooth desktop. One notch is a screenful fraction, so a tilt
// moves a readable amount rather than a fixed row count that means something
// different in every app.
func postScroll(_ notches: Double) {
    let pixels = Int32((notches * 90).rounded())
    guard pixels != 0,
          let event = CGEvent(
            scrollWheelEvent2Source: source,
            units: .pixel,
            wheelCount: 1,
            wheel1: pixels,
            wheel2: 0,
            wheel3: 0
          ) else {
        return
    }
    event.post(tap: .cghidEventTap)
}

// Desktop switching has no synthesisable gesture event — NSEvent swipes cannot
// be constructed — so it goes through the keyboard shortcut macOS binds to it.
// Ctrl+Left / Ctrl+Right move between Spaces (requires "Mission Control"
// keyboard shortcuts to be enabled, which is the macOS default).
let leftArrow: CGKeyCode = 123
let rightArrow: CGKeyCode = 124

func postKeyWithControl(_ code: CGKeyCode) {
    guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else {
        return
    }
    down.flags = .maskControl
    up.flags = .maskControl
    down.post(tap: .cghidEventTap)
    usleep(20_000)
    up.post(tap: .cghidEventTap)
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
    case "scroll":
        postScroll(command.dy ?? 0)
    case "key":
        switch command.key {
        case "spaceLeft":
            postKeyWithControl(leftArrow)
        case "spaceRight":
            postKeyWithControl(rightArrow)
        default:
            continue
        }
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
