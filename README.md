# AirCursor

Transparent macOS hand and voice control overlay.

AirCursor uses the webcam to recognize hand landmarks, draws a translucent skeleton-hand overlay, and maps simple gestures to desktop actions.

## Run

```bash
npm install
npm start
```

The first run asks for camera permission. Real mouse movement/clicking requires macOS Accessibility permission for the terminal or packaged app that launches AirCursor.

For the old browser fallback:

```bash
npm run web
```

Then open `http://127.0.0.1:5177`.

## Current Gesture

- Open palm and hold: wake the transparent control layer.
- Index finger: move the cursor.
- Thumb-index pinch: mouse down/up for click and drag.
- Thumb-middle pinch: right click.
- Fist and hold: hide the control layer.
- Voice: "启动/控制", "退出/停止", "打开网易云", "点击".

The desktop build uses Electron for the transparent always-on-top overlay and a tiny Swift CoreGraphics helper for macOS pointer events.
