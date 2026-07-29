// WE 网页壁纸专用 preload：冒充 Wallpaper Engine 的宿主。
//
// ⚠️ 这个文件曾经要求 contextIsolation: false，现在**不要了**。改掉的理由是安全：
// 壁纸是从 Steam 创意工坊下载的第三方 HTML，和 preload 同世界意味着它可能摸到
// require ⟹ 能读用户的文件系统。那个风险不值得为一个接口形状去承担。
//
// 两个方向各有办法，都不用关隔离：
//
//   我们 → 壁纸（5 个 register 函数）
//     contextBridge.exposeInMainWorld 就是干这个的 —— 它把东西从隔离世界**桥进**
//     页面的主世界。页面看到的是真的 window.wallpaperRegisterAudioListener。
//
//   壁纸 → 我们（window.wallpaperPropertyListener，页面自己挂的对象）
//     这个方向 contextBridge 读不到。但 webContents.executeJavaScript **跑在主世界**
//     （要跑隔离世界得显式用 executeJavaScriptInIsolatedWorld），所以主进程可以直接
//     在页面世界里调它。见 main.js 的 sendWEProperties。
//
// ⚠️ 时序仍然是硬约束。样本的 index.html 里作者自己写了注释：
//   「必须在脚本加载时立即注册，不能延迟到 onload 或模块加载后」
// 它的注册代码是 `if (window.wallpaperRegisterMediaPropertiesListener) { … }` ——
// 我们晚一步，这些 if 全是 false，壁纸显示正常但永远收不到数据。
// preload 在页面任何脚本之前执行，所以下面的 expose 必须在**模块顶层**。
const { contextBridge, ipcRenderer } = require('electron');

const listeners = {
  audio: [],
  mediaProperties: [],
  mediaThumbnail: [],
  mediaPlayback: [],
  mediaTimeline: [],
};

function register(bucket) {
  return (callback) => {
    if (typeof callback === 'function') listeners[bucket].push(callback);
  };
}

// 逐个 try：一个壁纸回调抛异常不该让后面的收不到数据，也不该把异常带回 IPC 处理里。
function emit(bucket, payload) {
  for (const cb of listeners[bucket]) {
    try {
      cb(payload);
    } catch (error) {
      console.warn(`[we] ${bucket} 回调抛异常:`, error && error.message);
    }
  }
}

// ⚠️ 逐个 expose，不是挂一个大对象：WE 的接口就是一堆平铺的 window 全局，
// 壁纸检查的是 `window.wallpaperRegisterAudioListener` 而不是某个命名空间下的字段。
contextBridge.exposeInMainWorld('wallpaperRegisterAudioListener', register('audio'));
contextBridge.exposeInMainWorld('wallpaperRegisterMediaPropertiesListener', register('mediaProperties'));
contextBridge.exposeInMainWorld('wallpaperRegisterMediaThumbnailListener', register('mediaThumbnail'));
contextBridge.exposeInMainWorld('wallpaperRegisterMediaPlaybackListener', register('mediaPlayback'));
contextBridge.exposeInMainWorld('wallpaperRegisterMediaTimelineListener', register('mediaTimeline'));

// 样本读 `wallpaperMediaIntegration.PLAYBACK_PLAYING` 并在拿不到时兜底成 0。
// ⚠️ 所以 PLAYING 必须是 0，否则走兜底分支的壁纸会把"正在播放"判成停止。
contextBridge.exposeInMainWorld('wallpaperMediaIntegration', {
  PLAYBACK_PLAYING: 0,
  PLAYBACK_PAUSED: 1,
  PLAYBACK_STOPPED: 2,
});

// 壁纸调它表示"我准备好了"。样本确实会调（`We.wallpaperReady && We.wallpaperReady()`）。
// 我们拿它当"页面里的 JS 真的跑起来了"的信号 —— 那是区分"白屏因为加载失败"和
// "白屏因为渲染有问题"的唯一观测点，而这两种在外面看起来一模一样。
contextBridge.exposeInMainWorld('wallpaperReady', () => {
  ipcRenderer.send('we-ready');
});

// 音频和歌曲信息：主进程送过来，转给壁纸注册的回调。
// 壁纸的消费代码是 `e.length` + 下标访问，普通数组就够，不用 Float32Array。
ipcRenderer.on('we-audio', (_event, frame) => emit('audio', frame));

// 四个通道分开，因为更新频率差一个量级（歌名换歌才变、进度每秒变）。
ipcRenderer.on('we-media-properties', (_event, p) => emit('mediaProperties', p));
ipcRenderer.on('we-media-thumbnail', (_event, p) => emit('mediaThumbnail', p));
ipcRenderer.on('we-media-playback', (_event, p) => emit('mediaPlayback', p));
ipcRenderer.on('we-media-timeline', (_event, p) => emit('mediaTimeline', p));

// ⚠️ 属性那条**不在这里**。它是反向的（页面挂对象、我们去调），而隔离世界里读不到
// 页面挂的东西。主进程用 executeJavaScript 在主世界里调，见 main.js sendWEProperties。
// 这里留这段注释是因为"为什么 preload 里没有属性通道"本身是个会被人问的问题。
