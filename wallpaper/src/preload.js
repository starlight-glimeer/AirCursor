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

  // 三层图片
  pickImage: (slot) => ipcRenderer.invoke('pick-image', slot),
  clearImage: (slot) => ipcRenderer.invoke('clear-image', slot),
  setLayer: (slot, filePath) => ipcRenderer.invoke('set-layer', slot, filePath),

  // 图库
  libraryAdd: () => ipcRenderer.invoke('library-add'),
  libraryRemove: (id) => ipcRenderer.invoke('library-remove', id),
  librarySetSlot: (id, slot) => ipcRenderer.invoke('library-set-slot', id, slot),

  // 手势录制
  startRecording: (action) => ipcRenderer.invoke('start-recording', action),
  cancelRecording: () => ipcRenderer.invoke('cancel-recording'),
  clearRecording: (action) => ipcRenderer.invoke('clear-recording', action),
  undoRecording: (action) => ipcRenderer.invoke('undo-recording', action),

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
  savePreset: (name) => ipcRenderer.invoke('save-preset', name),
  loadPreset: (name) => ipcRenderer.invoke('load-preset', name),
  deletePreset: (name) => ipcRenderer.invoke('delete-preset', name),

  setStrategy: (id) => ipcRenderer.invoke('set-strategy', id),
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
  onCancelRecording: on('cancel-recording'),
});
