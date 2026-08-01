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
  openMicrophoneSettings: () => ipcRenderer.invoke('open-microphone-settings'),
  openSpeechSettings: () => ipcRenderer.invoke('open-speech-settings'),
  setVoice: (enabled) => ipcRenderer.invoke('set-voice', enabled),
  startCapture: () => ipcRenderer.invoke('start-capture'),
  revealCaptures: () => ipcRenderer.invoke('reveal-captures'),
  saveCapture: (payload) => ipcRenderer.send('save-capture', payload),
  onStartCapture: (handler) => ipcRenderer.on('start-capture', () => handler()),
  onCaptureSaved: (handler) => ipcRenderer.on('capture-saved', (_e, p) => handler(p)),
  onPointerHealth: (handler) => ipcRenderer.on('pointer-health', (_e, p) => handler(p)),
  onVoiceStatus: (handler) => ipcRenderer.on('voice-status', (_e, p) => handler(p)),

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

  // 诊断报告
  exportDiagnostics: () => ipcRenderer.invoke('export-diagnostics'),
  revealDiagnostics: () => ipcRenderer.invoke('reveal-diagnostics'),

  // video 页面 → 主进程
  sendVideoStatus: (payload) => ipcRenderer.send('video-status', payload),

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
  ourWallpaperDir: () => ipcRenderer.invoke('our-wallpaper-dir'),
  // 把已经在 Steam 目录里的工坊壁纸搬进我们目录（清 0.9.24-0.9.28 留下的两份）
  importExistingFromSteam: () => ipcRenderer.invoke('import-existing-from-steam'),
  // 恢复默认壁纸目录（改错了之后回不去 —— 默认值不写进 config，用户不知道填什么）
  resetWallpaperDir: () => ipcRenderer.invoke('workshop-reset-dir'),
  onWorkshopProgress: on('workshop-progress'),
  onMouseStatus: on('mouse-status'),
  onVideoStatus: on('video-status'),
  onVideoSource: on('video-source'),
  onCancelRecording: on('cancel-recording'),
});
