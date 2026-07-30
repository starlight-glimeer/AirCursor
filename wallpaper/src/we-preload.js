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

// ─────────────────────────────────────────────────────────────────────────
// 鼠标事件探针
// ─────────────────────────────────────────────────────────────────────────
//
// ⚠️ 这是"点了没反应"的唯一分辨手段。那个症状有三种原因，长得一模一样：
//   ① helper 没抓到（转发压根没起来）
//   ② 抓到了但坐标算错，注到窗口外
//   ③ 注进去了，但页面不响应
//
// 主进程能报 ①②（注入计数 + 最近坐标）。而 ③ 只有页面自己知道 ——
// 所以在这里挂监听，如实报告"页面收到了什么"。
//
// ⚠️ 特别要区分 mouse 和 pointer 两族：我们注入的是 mouseDown，
// 而这个样本壁纸监听的是 **pointerdown**。Chromium 通常会从 mouse 合成 pointer，
// 但 sendInputEvent 是底层注入 —— 会不会走那条合成路径**我验不了**。
// ⟹ 两族都记，那样"mouse 收到了但 pointer 没有"会直接显示出来，
// 而不是笼统的"点了没反应"。
const seen = { mousedown: 0, pointerdown: 0, click: 0, wheel: 0, mousemove: 0 };
let seenReported = 0;

for (const type of Object.keys(seen)) {
  // capture 阶段监听：壁纸自己可能 stopPropagation，那样冒泡阶段就收不到了 ——
  // 而我们要测的是"事件到没到页面"，不是"壁纸处理没处理"。
  window.addEventListener(type, () => {
    seen[type] += 1;
    // 节流上报：mousemove 每秒上百次。
    const now = Date.now();
    if (now - seenReported < 500) return;
    seenReported = now;
    ipcRenderer.send('we-mouse-seen', { ...seen });
  }, { capture: true, passive: true });
}

// ⚠️ 属性那条**不在这里**。它是反向的（页面挂对象、我们去调），而隔离世界里读不到
// 页面挂的东西。主进程用 executeJavaScript 在主世界里调，见 main.js sendWEProperties。
// 这里留这段注释是因为"为什么 preload 里没有属性通道"本身是个会被人问的问题。
