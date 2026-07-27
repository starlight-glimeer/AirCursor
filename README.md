# AirCursor

Transparent macOS hand and voice control overlay.

AirCursor uses the webcam to recognize hand landmarks, draws a translucent skeleton-hand overlay, and maps simple gestures to desktop actions.

## Run

```bash
npm install
npm start
```

The first run opens a normal AirCursor dashboard and a separate transparent overlay. Minimize the dashboard to keep AirCursor running in the background. Real mouse movement/clicking requires macOS Accessibility permission for the terminal or packaged app that launches AirCursor.

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

## Record Your Own Gesture

The four actions above are fixed in code; which gesture triggers each one is yours to record.

1. In 手势规则, pick 单手 or 双手 for the action, then press 开始录制.
2. A 3 second countdown runs. Get both hands into frame.
3. Hold the pose still. The progress bar fills over 2 seconds and the template saves itself — no button to press, which is the point when both hands are busy.
4. Moving out of the pose, dropping a hand, or showing the wrong number of hands restarts the 2 seconds and says why. After 15 seconds it gives up rather than saving something wrong.

The saved template is the median of the frames you held, so one mistracked frame cannot poison it. Matching normalizes translation and scale, so the same pose works closer to or further from the camera; two-hand templates share one origin and one scale across both hands, so the distance between your hands stays part of the signature. A one-hand pose can never match a two-hand template.

Recording is deliberately tighter than triggering: 手势容错阈值 controls how far a live pose may sit from the template and still fire.

## Diagnostics

Turn on 诊断与调参 in the dashboard (or press Command+D) to get the panel that makes feedback precise.

| Metric | Reads | Amber when |
| --- | --- | --- |
| 摄像头帧率 | camera frames delivered per second | < 24 fps |
| 绘制帧率 | overlay repaint rate | < 50 fps |
| 推理耗时 | one MediaPipe pass, mean and p95 | > 22 ms |
| 端到端延迟 | frame capture to finished result | > 45 ms |
| 静止抖动 | cursor movement while the hand is parked (0 with 静止锁定 means the deadzone is holding it) | > 2.5 px |
| 跟随滞后 | how far the cursor trails the raw fingertip | > 26 px |
| 识别率 | share of frames with a hand, plus hand count | < 85% |
| 手势距离 | live distance to the recorded template, and the closest seen | — |

手势距离 is the number to read while recording: a pose that should fire but does not is a threshold problem if the distance sits just above it, and a template problem if it never comes close.

The six sliders apply instantly, no restart:

- **平滑强度 (minCutoff)** — lower is steadier but syrupy, higher is more responsive but shakier.
- **快速跟随 (beta)** — how aggressively smoothing backs off when the hand moves fast.
- **静止死区** — pixels of movement to ignore, which kills hover crawl.
- **预测提前量** — compensates pipeline latency; too much overshoots.
- **手势容错阈值** — larger accepts sloppier poses and misfires more.
- **推理间隔** — smaller tracks tighter and costs more CPU.

恢复默认调参 puts them all back. 重置指标 clears the rolling averages in both processes before a fresh measurement.

To report something, describe the symptom in the note box and press 保存报告. Use 打开报告目录 to reveal the file — it lands under `~/Library/Application Support/<app name>/reports/aircursor-report-<timestamp>.json`, where the folder is `AirCursor` for the packaged app and `aircursor` for a `npm start` run, so opening it beats typing the path. The JSON holds mean/min/max/p95 for every metric over the last 120 samples, the exact tuning in force, app and display info, and the shape of each recorded gesture. 透明层 DevTools opens the overlay's console; with diagnostics on, overlay console output is also mirrored into the panel.

Menu shortcuts: Command+D diagnostics, Command+S save report, Command+Alt+I dashboard DevTools, Command+Alt+O overlay DevTools.

## Package

```bash
npm run dist:mac
```

The unsigned DMG is written to `dist/`.
