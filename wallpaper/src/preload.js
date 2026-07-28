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
  pickImage: (layer) => ipcRenderer.invoke('pick-image', layer),
  clearImage: (layer) => ipcRenderer.invoke('clear-image', layer),
  setStrategy: (id) => ipcRenderer.invoke('set-strategy', id),
  setGestures: (enabled) => ipcRenderer.invoke('set-gestures', enabled),
  resetView: () => ipcRenderer.invoke('reset-view'),
  savePreset: (name) => ipcRenderer.invoke('save-preset', name),
  loadPreset: (name) => ipcRenderer.invoke('load-preset', name),
  deletePreset: (name) => ipcRenderer.invoke('delete-preset', name),

  // Sensor -> main -> wall. Fire and forget: a dropped gesture is better than a
  // stalled camera loop waiting for an ack.
  sendGesture: (payload) => ipcRenderer.send('gesture', payload),
  sendSensorStatus: (payload) => ipcRenderer.send('sensor-status', payload),

  onConfig: on('config'),
  onStrategy: on('strategy'),
  onGesture: on('gesture'),
  onTrack: on('track'),
  onSensorStatus: on('sensor-status'),
  onResetView: on('reset-view'),
});
