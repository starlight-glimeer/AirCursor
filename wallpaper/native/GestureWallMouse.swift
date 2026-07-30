// 全局鼠标事件监听器 —— 让壁纸能同时「在真壁纸层」和「收到鼠标」。
//
// 为什么必须有：
//
// macOS 上这两件事本来是互斥的：
//   真壁纸层（kCGDesktopWindowLevel）能覆盖菜单栏那 25px，但**收不到鼠标事件**
//   普通窗口能收鼠标，但**画不到菜单栏那一层**（那是系统绘制的独立图层）
//
// 用户的要求是两个都要 —— 而且他说得对：mac 原生壁纸就没有那条缝，
// 而"鼠标交互失效"对一个交互式壁纸产品是不可接受的。
//
// ⟹ 解法是 Open Wallpaper Engine 用的那套：窗口留在壁纸层（所以能覆盖），
// 鼠标事件用**全局监听**抓下来，再手动转发进那个窗口。
//
// ⚠️⚠️ 权限：**需要辅助功能授权**。
//
// 我原来断言"监听鼠标不需要辅助功能权限（键盘才需要）"，说了三次，
// 而那**只是推断、从没验证**。2026-07-30 实测证伪：
//
//   $ swiftc GestureWallMouse.swift -o /tmp/gm && /tmp/gm
//   {"gateOnFinder":false,"state":"running","type":"status"}
//   （动鼠标、点击 —— 零事件）
//
// 也就是 addGlobalMonitorForEvents **返回了非 nil**（所以我们报 running），
// 但回调一次都不触发。⟹ 这是最坏的一种失败：**它不报错，只是静默不工作**。
//
// ⚠️ 而这正是 aircursor-notes/pitfalls.md 第 281 行那条教训：
// `packaged: false`（npm start）下辅助功能列表里根本没有本应用（只有 Electron/终端），
// "没授权"是默认状态 ⟹ **权限类问题到此为止，先打包再验**。
// 我在自己的新功能上重演了那个错。
//
// ⟹ 所以：① 这条链必须打包成 .app 才能验
//         ② monitor != nil **不能**当成"能用"的证据（见下面的探活）
//
// 输出：一行一个 JSON 到 stdout，坐标是屏幕坐标（左上原点，已经翻好 y 轴）。
//   {"type":"mouse","kind":"move","x":100,"y":200,"at":123456}
//   {"type":"mouse","kind":"down","x":100,"y":200,"button":0}
//   {"type":"mouse","kind":"scroll","x":100,"y":200,"dx":0,"dy":-3}
//   {"type":"status","state":"running"}

import Cocoa

// 只监听真正会用到的类型。
//
// ⚠️ 这条是 OWE 代码里的注释直接给的教训：`.any` 会**饿死主线程**。
// 那是别人踩过的坑，免费拿来用。
let WATCHED: NSEvent.EventTypeMask = [
    .mouseMoved, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
    .leftMouseDragged, .rightMouseDragged, .scrollWheel,
]

func emit(_ dict: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: dict),
          let line = String(data: data, encoding: .utf8) else { return }
    // 直接写 fd 而不是 print：print 有行缓冲，管道里会攒着不发出去。
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

// NSEvent 的坐标是**左下原点**（Cocoa 惯例），而 Electron / CSS 是**左上原点**。
//
// ⚠️ 这个翻转是这个文件里最容易错、而且错了最难发现的一处：
// 不翻的话点击位置会上下颠倒 —— 而"点上面结果响应在下面"看起来像
// 命中判定有 bug，不像坐标系问题。
func flipY(_ point: NSPoint) -> NSPoint {
    // 用**主屏**的高度翻转。多显示器时 NSEvent.mouseLocation 是全局坐标，
    // 而主屏左下角是原点。
    guard let main = NSScreen.screens.first else { return point }
    return NSPoint(x: point.x, y: main.frame.maxY - point.y)
}

var lastMoveAt: TimeInterval = 0
// 移动事件节流。鼠标移动每秒能触发上百次，全发会把 IPC 灌满，
// 而壁纸的视差效果 60fps 就够了。
let MOVE_INTERVAL: TimeInterval = 1.0 / 60.0

func handle(_ event: NSEvent) {
    let flipped = flipY(NSEvent.mouseLocation)
    let x = Int(flipped.x.rounded())
    let y = Int(flipped.y.rounded())

    switch event.type {
    case .mouseMoved, .leftMouseDragged, .rightMouseDragged:
        let now = ProcessInfo.processInfo.systemUptime
        if now - lastMoveAt < MOVE_INTERVAL { return }
        lastMoveAt = now
        // 拖拽和纯移动分开：壁纸可能要区分"划过"和"拖着划"。
        let dragging = event.type != .mouseMoved
        emit(["type": "mouse", "kind": dragging ? "drag" : "move", "x": x, "y": y])
    case .leftMouseDown:
        emit(["type": "mouse", "kind": "down", "x": x, "y": y, "button": 0])
    case .leftMouseUp:
        emit(["type": "mouse", "kind": "up", "x": x, "y": y, "button": 0])
    case .rightMouseDown:
        emit(["type": "mouse", "kind": "down", "x": x, "y": y, "button": 2])
    case .rightMouseUp:
        emit(["type": "mouse", "kind": "up", "x": x, "y": y, "button": 2])
    case .scrollWheel:
        // scrollingDeltaY 是"像素级"的（触控板），deltaY 是"行数"的（滚轮）。
        // ⚠️ 两个混用会让触控板和滚轮的灵敏度差一个量级。优先用前者，
        // 没有时回落到后者乘一个行高。
        let dy = event.hasPreciseScrollingDeltas
            ? event.scrollingDeltaY : event.deltaY * 16
        let dx = event.hasPreciseScrollingDeltas
            ? event.scrollingDeltaX : event.deltaX * 16
        emit(["type": "mouse", "kind": "scroll", "x": x, "y": y,
              "dx": Int(dx.rounded()), "dy": Int(dy.rounded())])
    default:
        break
    }
}

// 「只在用户正在看桌面时转发」这个门 —— 默认**关**。
//
// ⚠️ 这个默认值我一开始设反了，而那让功能看起来是坏的。实测证据（诊断报告）：
//   mouse: { status: { ok: true }, injected: 0 }
// 也就是 helper 起来了、一个事件都没转发过 —— 因为门把它们全挡了。
//
// 为什么 OWE 需要这个门而我们不需要：它是**纯壁纸应用**，用户和它的唯一交互
// 就是桌面，所以"前台是 Finder"约等于"在看壁纸"。而我们有面板、有终端、
// 有诊断报告 —— 用户大部分时间前台**不是** Finder，那个门会挡掉绝大多数点击。
//
// ⟹ 默认放行，需要收紧的人用 `--gate-finder` 打开。
// 代价是在别的应用里滑滚轮壁纸也会动 —— 那是个可接受的副作用，
// 而"点壁纸完全没反应"不是。
var gateOnFinder = false
// ⚠️ 声明必须在 monitor 回调之前 —— Swift 顶层代码是顺序执行的。
// 探活用：monitor 非 nil 不等于能收到事件（实测过），所以数一下真收到几个。
var eventsSeen = 0
// 被门挡掉的计数。⚠️ 必须报出来：否则"没反应"和"被挡了"分不清，
// 而那正是我上一版让用户白测一轮的原因。
var blockedByGate = 0

for arg in CommandLine.arguments.dropFirst() {
    if arg == "--gate-finder" { gateOnFinder = true }
    // 兼容旧参数名（老的 helper 二进制可能还在缓存里）
    if arg == "--always" { gateOnFinder = false }
}

let monitor = NSEvent.addGlobalMonitorForEvents(matching: WATCHED) { event in
    if gateOnFinder {
        let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        if front != "com.apple.finder" {
            blockedByGate += 1
            // 每挡 50 个报一次，让上层知道"事件有，但被门挡了"。
            if blockedByGate % 50 == 1 {
                emit(["type": "status", "state": "gated",
                      "blocked": blockedByGate,
                      "front": front ?? "(未知)"])
            }
            return
        }
    }
    eventsSeen += 1
    handle(event)
}

if monitor == nil {
    emit(["type": "status", "state": "failed",
          "message": "全局鼠标监听建不起来（addGlobalMonitorForEvents 返回 nil）"])
    exit(2)
}

// ⚠️ 探活：monitor 非 nil **不等于**能收到事件。
//
// 实测就是这样：返回了非 nil、我们报了 running，而回调一次都不触发（没授权）。
// ⟹ "建立成功"和"真的在工作"是两件事，而只报前者会让功能看起来是好的。
//
// 所以启动 3 秒后自查：一个事件都没有就报出来，并说清最可能的原因。
// 3 秒是因为用户装载壁纸后总会动一下鼠标 —— 真有授权的话那几秒必有事件。
let trusted = AXIsProcessTrusted()

emit(["type": "status", "state": "running",
      "gateOnFinder": gateOnFinder,
      // AXIsProcessTrusted 直接问系统"我被授权了吗"，不用等超时。
      "trusted": trusted])

DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
    if eventsSeen == 0 {
        emit(["type": "status", "state": "silent",
              "trusted": AXIsProcessTrusted(),
              "message": AXIsProcessTrusted()
                ? "监听建立了但 3 秒内零事件 —— 已授权，所以是别的问题"
                : "监听建立了但收不到事件：**没有辅助功能授权**。"
                  + "而开发模式（npm start）下拿不到那个授权 —— 必须打包成 .app"])
    }
}
// RunLoop 必须跑起来，否则监听回调一次都不会触发（进程会直接退出）。
RunLoop.main.run()
