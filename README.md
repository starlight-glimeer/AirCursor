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
- Thumb-index pinch: click on release.
- Thumb-middle pinch: right click.
- Fist and hold: hide the control layer.
- Drag, scroll and desktop switching have no built-in pose — record one (see below).
- Voice: "启动/控制", "退出/停止", "打开网易云", "点击".

Click and drag are separate actions rather than one pose that upgrades when the
hand moves far enough. Holding a button down is a distinct intent, and inferring
it from movement collided with the motion gestures below, which move the hand on
purpose: any pose still matching click would have started a drag mid-scroll.

The desktop build uses Electron for the transparent always-on-top overlay and a tiny Swift CoreGraphics helper for macOS pointer events.

## Record Your Own Gesture

The four actions above are fixed in code; which gesture triggers each one is yours to record.

1. In 手势规则, pick 单手 or 双手 for the action, then press 开始录制.
2. A 3 second countdown runs. Get both hands into frame.
3. Hold the pose still. The progress bar fills over 2 seconds and the template saves itself — no button to press, which is the point when both hands are busy.
4. Moving out of the pose, dropping a hand, or showing the wrong number of hands restarts the 2 seconds and says why. After 15 seconds it gives up rather than saving something wrong.

Every recorder row draws the pose it saved, so you can see what was captured instead of performing the gesture to find out. A tilt gesture draws two frames: the rest pose, and the position the tilt reaches. A saved row also states what it measured — "抬压到 26°，超过 19° 就滚一段" — because a gesture confirmed only by "已录制" is a gesture you still have to go and test.

The saved template is the median of the frames you held, so one mistracked frame cannot poison it. Matching normalizes translation and scale, so the same pose works closer to or further from the camera; two-hand templates share one origin and one scale across both hands, so the distance between your hands stays part of the signature. A one-hand pose can never match a two-hand template.

Wrist tilt is forgiven up to 旋转容差 (default 20°), measured along wrist to middle-finger base. It is capped rather than unlimited on purpose: full rotation invariance would make thumbs-up and thumbs-down the same gesture. For two hands the tilt is one shared axis, so leaning the whole pose still matches while rotating one hand alone stays a distinct gesture.

Matching weights the worst single finger as heavily as the whole hand. Plain whole-hand RMS dilutes a one-finger difference — the thumb is 4 of 21 landmarks — which put fist and thumbs-up 0.210 apart, under the 0.22 threshold that shipped, meaning they were not distinguishable at all. Weighting the worst finger raises that pair to 0.346 for 13% more noise, so the default threshold is now 0.28.

Which gesture fires is decided once per frame by nearest template, not by whichever consumer asks first. A pose sitting between two templates sticks with the one already held (18% of the threshold in hysteresis) so it cannot flip frame to frame.

A new recording is refused when it lands within one threshold of a gesture you already saved: at that range it is inside the drift of a single held pose, so which one fires would be arbitrary. Pairs between one and two thresholds apart still save — the whole single-hand pose space only spans about 0.21 to 0.54, so refusing that band would reject open-palm vs fist — and the dashboard warns instead.

## Motion Gestures

Scrolling and desktop switching are not poses. A pose is a single frame, and both
of these need to know what the hand has been *doing*, so the recorded pose only
selects which control law is active and the movement afterwards decides the rest.
They are two different laws, deliberately not one mechanism:

**上下滚动 is a ratchet.** Park the wrist, tilt the palm up, and one notch of
scrolling fires; tilt further and nothing more happens until the hand returns to
the pose it was recorded in, which re-arms it. Scrolling more is one more tilt.
The alternative — mapping continuous hand displacement onto scroll position — has
no defined rest position, so the hand has to hover mid-air and there is no moment
that clearly means "stop".

**Recording a motion gesture has two stages**, because asking someone to hold a
movement still for two seconds is a contradiction. Stage 1 captures the rest
pose — that one genuinely is static, since it is the position the hand returns to
in order to re-arm. Stage 2 asks for the action itself: perform the tilt (or the
swipe), and the extent it reaches becomes this gesture's trigger, at 75% of what
was demonstrated so repeating the same movement crosses it rather than landing on
the edge. The stage ends when the movement settles, not on a timer, and a dropped
frame mid-movement does not discard it — at a 40-60% tracking rate a movement is
guaranteed to have gaps.

So 滚动触发角 and 挥动速度门限 are fallbacks for gestures recorded before this
existed. "How far do I have to tilt" is a question the recording already
answered, and one global slider cannot answer it for two differently-recorded
gestures. 抬压角度 says which of the two is in force.

The tilt is measured against the recorded template's own angle, not against an
angle captured when the gesture is first recognised: the recorded pose *is* the
rest position, which avoids both a baseline race and treating an already-tilted
hand as neutral.

That angle also has a hard ceiling. Matching de-rotates a live pose onto its
template by at most 旋转容差, and past that the leftover rotation is charged as
shape error at about 0.0196 distance per degree — so a trigger angle beyond the
tolerance would make the pose stop matching at exactly the angle it should fire
at. 滚动触发角 is therefore clamped, and 抬压角度 in the diagnostics panel says so
when it happens rather than leaving a slider that silently does nothing.

**左右切换桌面 is a swipe**, one desktop per stroke, sent as Ctrl+Left/Right —
macOS Spaces have no synthesisable gesture event, so the keyboard shortcut is the
only route. The hard part is not detecting the stroke, it is the return: swiping
right means the hand comes back, and that return is a fast leftward stroke. So
firing again requires both the cooldown to expire and the wrist to actually stop.
A stroke also has to be sideways and straight — a hand being carried somewhere is
not a gesture.

The two laws never compete for one motion, and not because of a priority order:
the ratchet requires a wrist below 1.1 palm widths per second, the swipe one
above 挥动速度门限 (default 2.6), and the dead band between them means no single
motion satisfies both. Speeds are in palm widths per second rather than pixels so
a threshold means the same thing at any distance from the camera.

Both gestures need a measurable rotation axis, which two mirrored hands do not
have — their axes cancel, and `poseAngle` returns null. Recording a two-hand
mirrored pose for 上下滚动 is refused at save time rather than saving something
that could never fire.

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
| 保持进度 | which gesture is accumulating hold time and for how long, or that a pinch is waiting for release, or that a drag is holding the button | — |
| 抬压角度 | palm tilt away from the recorded pose, against the trigger angle, and whether that angle was clamped | — |
| 动态手势 | why the ratchet and the swipe each did nothing this frame, plus wrist speed | — |

动态手势 exists because these two gestures have several distinct ways to do
nothing — the wrist was moving, the hand has not returned to rest, the cooldown is
running, the pose has no measurable axis, the stroke was not straight enough — and
every one of them looks identical from the outside: the gesture appears on the
status line and the screen does not move. That symptom has already cost this
project three debugging rounds under other causes, so each reason is named.
Reports carry a tally of these reasons across the whole sample window under
`motion`, since a single frame's reason is whatever the last frame happened to
say.

**点击通道 in 运行状态 is the first row to read when nothing happens.** Gesture recognition and mouse delivery are two separate claims, and only 识别 speaks for the first: macOS discards synthesised events from a process without the Accessibility grant, silently — no error, no exception, and the helper cannot tell. So a live gesture, a click animation and a dead mouse are all mutually consistent, and no amount of gesture tuning helps. 正常 means the helper is running and trusted; 无权限 and 异常 raise a red banner that names the fix. Reports carry the same verdict under `pointer`, including which binary is running (`pointer.binary`) and how many commands were written versus dropped.

The helper binary is named after a hash of its Swift source, not the app version, because the Accessibility grant is per binary — a version-keyed name silently revoked the permission on every release, which is why clicking worked up to 0.2.15 and did nothing from 0.2.16 to 0.3.1. `pointer.binary` keeping the same suffix across an upgrade is the check that this stays fixed.

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
- **滚动触发角** — degrees of palm tilt per scroll notch, clamped against 旋转容差.
- **每次滚动量** — notches per tilt; larger scrolls faster and lands less precisely.
- **挥动速度门限** — how fast a sideways stroke must be to switch desktops. Its floor stays above the wrist speed the ratchet allows, so the two gestures cannot both fire.

恢复默认调参 puts them all back. 重置指标 clears the rolling averages in both processes before a fresh measurement.

To report something, describe the symptom in the note box and press 保存报告. Use 打开报告目录 to reveal the file — it lands under `~/Library/Application Support/<app name>/reports/aircursor-report-<timestamp>.json`, where the folder is `AirCursor` for the packaged app and `aircursor` for a `npm start` run, so opening it beats typing the path. The JSON holds mean/min/max/p95 for every metric over the last 120 samples, the exact tuning in force, app and display info, and the shape of each recorded gesture. 透明层 DevTools opens the overlay's console; with diagnostics on, overlay console output is also mirrored into the panel.

Menu shortcuts: Command+D diagnostics, Command+S save report, Command+Alt+I dashboard DevTools, Command+Alt+O overlay DevTools.

## Package

```bash
npm run dist:mac
```

The unsigned DMG is written to `dist/`.
