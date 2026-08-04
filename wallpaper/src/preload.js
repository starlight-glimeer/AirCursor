// One preload for all three windows. Each uses the subset it needs; a window
// having access to a channel it never calls costs nothing, while three preloads
// would drift apart.
const { contextBridge, ipcRenderer } = require('electron');

function on(channel) {
  return (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  };
}

contextBridge.exposeInMainWorld('gw', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (patch) => ipcRenderer.invoke('set-config', patch),

  // ⚠️⚠️ 用户点了启动页、进主界面了（0.9.48）。
  // 骨架层靠这个信号才建 —— 它是 alwaysOnTop:'screen-saver' 的独立窗口，
  // 会压在启动页上（用户报过：「登录界面啥都没点的时候，我都能看到我手的骨架」）。
  // ⚠️ 0.9.47 是用 setTimeout(2600) 挡的，而 0.9.48 撤掉了自动进入 ⟹
  // 启动页会**停留到用户点击为止**（可能几分钟），定时器就挡不住了。
  launchDismissed: () => ipcRenderer.invoke('launch-dismissed'),

  // 三层图片

  // 图库

  // 手势录制
  startRecording: (action) => ipcRenderer.invoke('start-recording', action),
  cancelRecording: () => ipcRenderer.invoke('cancel-recording'),
  clearRecording: (action) => ipcRenderer.invoke('clear-recording', action),
  undoRecording: (action) => ipcRenderer.invoke('undo-recording', action),
  toggleRecording: (action, enabled) => ipcRenderer.invoke('toggle-recording', action, enabled),

  // 投递层健康 + 原始关键点录制(从 AirCursor 搬过来的两样)
  pointerHealth: () => ipcRenderer.invoke('pointer-health'),
  openAccessibility: () => ipcRenderer.invoke('open-accessibility'),
  openCameraSettings: () => ipcRenderer.invoke('open-camera-settings'),
  startCapture: () => ipcRenderer.invoke('start-capture'),
  revealCaptures: () => ipcRenderer.invoke('reveal-captures'),
  saveCapture: (payload) => ipcRenderer.send('save-capture', payload),
  onStartCapture: (handler) => ipcRenderer.on('start-capture', () => handler()),
  onCaptureSaved: (handler) => ipcRenderer.on('capture-saved', (_e, p) => handler(p)),
  onPointerHealth: (handler) => ipcRenderer.on('pointer-health', (_e, p) => handler(p)),

  // 预设

  // WE 网页壁纸
  // ⚠️ `wePick`（「装载别处的目录…」）0.9.37 整条链删了 ——
  // 用户说它和「换目录…」冗余，而且它装载的壁纸不在网格里（更差）。
  // ⟹ 这里不留桩，否则就是死代码。
  weClear: () => ipcRenderer.invoke('we-clear'),
  // 把一个壁纸移到**废纸篓**（不是永久删除 —— 用户可能点错）。
  // ⚠️ 主进程那边有路径白名单（只允许壁纸目录树下），而确认对话框在面板。
  deleteWallpaper: (dir) => ipcRenderer.invoke('we-delete-wallpaper', dir),
  // 轮播（0.9.43）：开关 / 间隔 / 顺序或随机 / 播放列表
  weSetRotate: (patch) => ipcRenderer.invoke('we-set-rotate', patch),
  weRotateNext: () => ipcRenderer.invoke('we-rotate-next'),
  weControls: () => ipcRenderer.invoke('we-controls'),
  weStatus: () => ipcRenderer.invoke('we-status'),
  weSetProperty: (key, value) => ipcRenderer.invoke('we-set-property', key, value),
  weSetAudioSource: (source) => ipcRenderer.invoke('we-set-audio-source', source),
  weSetStrategy: (id) => ipcRenderer.invoke('we-set-strategy', id),
  weSetMouseForward: (patch) => ipcRenderer.invoke('we-set-mouse-forward', patch),

  // 创意工坊
  workshopDownload: (input) => ipcRenderer.invoke('workshop-download', input),
  workshopSetSteam: (patch) => ipcRenderer.invoke('workshop-set-steam', patch),
  workshopProbe: () => ipcRenderer.invoke('workshop-probe'),
  workshopDetails: (input) => ipcRenderer.invoke('workshop-details', input),
  workshopLocal: () => ipcRenderer.invoke('workshop-local'),
  workshopBrowse: (opts) => ipcRenderer.invoke('workshop-browse', opts),
  workshopBrowseMeta: () => ipcRenderer.invoke('workshop-browse-meta'),
  workshopSetKey: (key) => ipcRenderer.invoke('workshop-set-key', key),
  workshopAddDir: () => ipcRenderer.invoke('workshop-add-dir'),
  workshopRemoveDir: (dir) => ipcRenderer.invoke('workshop-remove-dir', dir),
  workshopLoadLocal: (dir) => ipcRenderer.invoke('workshop-load-local', dir),

  // ⚠️⚠️ AI 生成壁纸（0.9.123）。用户 2026-08-02：「调用大模型 api，帮我做壁纸」
  //   凭证存在 userData/config.json（仓外），诊断报告里由 redactConfig 打码。
  // ⚠️ 右栅宽度分档（0.9.141）—— 挡位在主进程（它管 config），面板只挑一档
  weSetSideWidth: (w) => ipcRenderer.invoke('we-set-side-width', w),
  genMeta: () => ipcRenderer.invoke('gen-meta'),
  genSetKey: (key) => ipcRenderer.invoke('gen-set-key', key),
  genPing: () => ipcRenderer.invoke('gen-ping'),
  genWallpaper: (payload) => ipcRenderer.invoke('gen-wallpaper', payload),
  // ⚠️ 进度必须有：一次生成要几十秒到几分钟（实测三轮约 10k token），
  //   而**没有进度的等待和卡死分不开** —— 这个项目为"静默"栽过很多次。
  onGenProgress: on('gen-progress'),

  // 诊断报告
  exportDiagnostics: () => ipcRenderer.invoke('export-diagnostics'),
  revealDiagnostics: () => ipcRenderer.invoke('reveal-diagnostics'),

  // video 页面 → 主进程
  sendVideoStatus: (payload) => ipcRenderer.send('video-status', payload),
  // ⚠️ 0.9.111：视频音轨 Chromium 放不了时请宿主转一份没有音轨的
  //   （AVFoundation passthrough，不重新编码 —— 见 main.js 那段）。
  videoAudioFailed: (payload) => ipcRenderer.send('we-video-audio-failed', payload),
  onVideoUseCache: on('we-video-use-cache'),

  setGestures: (enabled) => ipcRenderer.invoke('set-gestures', enabled),
  resetView: () => ipcRenderer.invoke('reset-view'),
  testSystemAction: (id) => ipcRenderer.invoke('test-system-action', id),

  // Sensor -> main -> wall/dashboard. Fire and forget: a dropped gesture is better
  // than a stalled camera loop waiting for an ack.
  sendGesture: (payload) => ipcRenderer.send('gesture', payload),
  sendHands: (payload) => ipcRenderer.send('hands', payload),
  sendSensorStatus: (payload) => ipcRenderer.send('sensor-status', payload),
  reportOverlayGeometry: (payload) => ipcRenderer.send('overlay-geometry', payload),
  onOverlayGeometry: (handler) => ipcRenderer.on('overlay-geometry', (_e, p) => handler(p)),
  onHelperLog: (handler) => ipcRenderer.on('helper-log', (_e, p) => handler(p)),
  sendRecordingProgress: (payload) => ipcRenderer.send('recording-progress', payload),
  sendRecordingResult: (payload) => ipcRenderer.send('recording-result', payload),

  onConfig: on('config'),
  onStrategy: on('strategy'),
  onGesture: on('gesture'),
  onHands: on('hands'),
  onTrack: on('track'),
  onSensorStatus: on('sensor-status'),
  onResetView: on('reset-view'),
  onRecordingProgress: on('recording-progress'),
  onRecordingResult: on('recording-result'),
  onStartRecording: on('start-recording'),
  onWeStatus: on('we-status'),
  onWeAudioStatus: on('we-audio-status'),
  // ⚠️ 实际频谱值（抽样）。这是"该把 NORMALIZE 调成多少"的唯一依据 ——
  // 在它之前我改了三轮参数，全靠从壁纸代码反推 + 用户看截图。
  onWeAudioFrame: on('we-audio-frame'),
  // ⚠️ 闸门丢帧的报告。打包版没有终端，这是"两个音源同时发"唯一能看见的地方。
  onWeAudioDrop: on('we-audio-drop'),
  // ⚠️ 主动拿最后一次 FFT 自检 —— 它只在 helper 启动时跑一次，
  // 而面板可能那时候还没打开。
  weSelfTest: () => ipcRenderer.invoke('we-selftest'),

  // 在 Finder 里打开壁纸目录。⚠️ 壁纸是**文件**，而用户对文件的直觉是"去看看" ——
  // 之前面板上连路径都只是纯文本。
  revealWallpaperDir: (dir) => ipcRenderer.invoke('reveal-wallpaper-dir', dir),

  // ⚠️ 用浏览器打开一个外部链接（0.9.54，右侧详情面板的「在 Steam 打开」用）。
  // ⚠️ 主进程侧会**校验协议只能是 http/https** —— 渲染进程传什么都可能，
  // 而 shell.openExternal 对 `file://` / 自定义 scheme 也会执行。
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  ourWallpaperDir: () => ipcRenderer.invoke('our-wallpaper-dir'),
  // 把已经在 Steam 目录里的工坊壁纸搬进我们目录（清 0.9.24-0.9.28 留下的两份）
  importExistingFromSteam: () => ipcRenderer.invoke('import-existing-from-steam'),
  // 恢复默认壁纸目录（改错了之后回不去 —— 默认值不写进 config，用户不知道填什么）
  resetWallpaperDir: () => ipcRenderer.invoke('workshop-reset-dir'),
  onWorkshopProgress: on('workshop-progress'),
  onMouseStatus: on('mouse-status'),
  onVideoStatus: on('video-status'),
  onVideoSource: on('video-source'),
  // ⚠️⚠️⚠️ **报"我跑起来了"**（0.9.159）。
  //
  // ⚠️ `we-preload.js` 有 `wallpaperReady`（第三方壁纸自己调），
  //   而**我们自己的页面**（`scene.html` / `video.html`）走这个 preload
  //   ⟹ 它们调 `window.wallpaperReady()` 是个**静默 no-op**
  //     （`window.wallpaperReady` 压根不存在，那个 `if` 直接跳过）。
  //   ⚠️ 后果：面板永远显示「⏳ 页面加载了，但壁纸还没报 ready：
  //     如果一直这样，是里面的脚本没跑起来」—— 而脚本明明跑起来了。
  //   ⟹ 判据：**"我们自己的页面"和"第三方壁纸"用两套 preload 时，
  //     两边都要有的那些通道要逐个核**（这次漏的是 ready，上次漏的是 onSceneData）。
  wallpaperReady: () => ipcRenderer.send('we-ready'),
  // ⚠️ scene 类壁纸（0.9.159）：主进程解好包再送过来（渲染进程是 sandbox，读不了文件）
  onSceneData: on('scene-data'),
  // ⚠️⚠️ **裸的 128 段频谱** —— scene 里的音频柱要它（实测两个样本都挂了
  //   `Simple_Audio_Bars` effect）。
  //   ⚠️ 和面板用的 `we-audio-frame` 是**两回事**：那个是抽样过的诊断数据
  //     （每半秒一次、只有几个采样点），拿它驱动柱子会是每秒 2 帧的抖动。
  //   ⟹ 判据：**诊断用的抽样数据不能拿来驱动画面。**
  onWeAudio: on('we-audio'),
  // ⚠️⚠️ 错误也要单独一条 —— 那让屏幕上能说清"卡在哪一步"，
  //   而不是留一片黑让用户猜（这个项目为"静默失败"栽过很多次）
  onSceneError: on('scene-error'),
  onCancelRecording: on('cancel-recording'),
});
