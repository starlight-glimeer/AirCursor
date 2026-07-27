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

Wrist tilt is forgiven up to 旋转容差 (default 20°), measured along wrist to middle-finger base. It is capped rather than unlimited on purpose: full rotation invariance would make thumbs-up and thumbs-down the same gesture. For two hands the tilt is one shared axis, so leaning the whole pose still matches while rotating one hand alone stays a distinct gesture.

Matching weights the worst single finger as heavily as the whole hand. Plain whole-hand RMS dilutes a one-finger difference — the thumb is 4 of 21 landmarks — which put fist and thumbs-up 0.210 apart, under the 0.22 threshold that shipped, meaning they were not distinguishable at all. Weighting the worst finger raises that pair to 0.346 for 13% more noise, so the default threshold is now 0.28.

Which gesture fires is decided once per frame by nearest template, not by whichever consumer asks first. A pose sitting between two templates sticks with the one already held (18% of the threshold in hysteresis) so it cannot flip frame to frame.

A new recording is refused when it lands within one threshold of a gesture you already saved: at that range it is inside the drift of a single held pose, so which one fires would be arbitrary. Pairs between one and two thresholds apart still save — the whole single-hand pose space only spans about 0.21 to 0.54, so refusing that band would reject open-palm vs fist — and the dashboard warns instead.

## Gesture-Triggered Rules

Every rule under 常用规则 takes a gesture too, recorded the same way. Hold a bound gesture for 1.2 seconds and the rule fires; there is a 2.5 second cooldown afterwards, and it works whether or not control mode is on, since opening an app should not require waking the pointer first.

Rules only ever fire from a gesture you recorded — the built-in poses stay reserved for the pointer, so binding one cannot hijack your click. The hold is longer than wake/exit because launching an app by accident is more annoying than a stray cursor move. 清除 removes the binding and the rule goes back to voice-only.

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
| 手势距离 | distance to the nearest recorded template, the closest seen, and which gesture it is | — |

If two bound gestures are too close together, an amber banner in 手势规则 names the pair and their distance — that fault presents as "the action does nothing" because a different action fires instead, so it is called out rather than left to be inferred. Reports carry the same list under `gestureConflicts`.

手势距离 is the number to read while recording: a pose that should fire but does not is a threshold problem if the distance sits just above it, and a template problem if it never comes close. With several gestures bound, the name tells you whether the wrong template is the one winning.

The seven sliders apply instantly, no restart:

- **平滑强度 (minCutoff)** — lower is steadier but syrupy, higher is more responsive but shakier.
- **快速跟随 (beta)** — how aggressively smoothing backs off when the hand moves fast.
- **静止死区** — pixels of movement to ignore, which kills hover crawl.
- **预测提前量** — compensates pipeline latency; too much overshoots.
- **手势容错阈值** — larger accepts sloppier poses and misfires more. Default 0.28: above the 0.10-0.16 a held pose drifts on real hardware, below the 0.346 that separates the closest distinct pair.
- **旋转容差** — degrees of wrist tilt to forgive; too large merges gestures that differ only in direction.
- **推理间隔** — smaller tracks tighter and costs more CPU.

恢复默认调参 puts them all back. 重置指标 clears the rolling averages in both processes before a fresh measurement.

To report something, describe the symptom in the note box and press 保存报告. Use 打开报告目录 to reveal the file — it lands under `~/Library/Application Support/<app name>/reports/aircursor-report-<timestamp>.json`, where the folder is `AirCursor` for the packaged app and `aircursor` for a `npm start` run, so opening it beats typing the path. The JSON holds mean/min/max/p95 for every metric over the last 120 samples, the exact tuning in force, app and display info, and the shape of each recorded gesture. 透明层 DevTools opens the overlay's console; with diagnostics on, overlay console output is also mirrored into the panel.

Menu shortcuts: Command+D diagnostics, Command+S save report, Command+Alt+I dashboard DevTools, Command+Alt+O overlay DevTools.

## Package

```bash
npm run dist:mac
```

The unsigned DMG is written to `dist/`.
