// WE 网页壁纸专用 preload：冒充 Wallpaper Engine 的宿主。
//
// ⚠️ 这个窗口是 contextIsolation: false，和其他三个窗口不一样。原因不是图省事：
//
// 数据流是**双向**的，而其中一条方向决定了这件事。壁纸自己会执行
//   window.wallpaperPropertyListener = { applyUserProperties, applyGeneralProperties }
// 然后等宿主去调它。contextIsolation: true 下 preload 和页面是两个隔离的 JS 世界，
// 页面挂在自己 window 上的那个对象我们**根本看不见** —— 症状是画面正常、音频正常、
// 但 41 项配置永远发不进去，而且不报错。
//
// 代价是壁纸（第三方 HTML）和 preload 同世界。所以这里**只挂 WE 那几个函数**，
// 不暴露 ipcRenderer、不暴露 require、不暴露我们自己的 gw 接口。页面能拿到的
// 全部能力就是"注册回调"，它拿不到任何通往主进程的东西。
const { ipcRenderer } = require('electron');

// ⚠️ 时序是硬约束。样本的 index.html 里作者自己写了注释：
//   「必须在脚本加载时立即注册，不能延迟到 onload 或模块加载后」
// 它的注册代码是 `if (window.wallpaperRegisterMediaPropertiesListener) { ... }` ——
// 我们晚一步，这些 if 全是 false，壁纸显示正常但永远收不到歌曲信息。
// preload 在页面任何脚本之前执行，所以这些赋值必须在**模块顶层**，不能等 IPC 或 DOM。
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

// 逐个 try：一个壁纸的回调抛异常不该让后面的壁纸回调收不到数据，也不该
// 把异常带回主进程的 IPC 处理里。
function emit(bucket, payload) {
  for (const cb of listeners[bucket]) {
    try {
      cb(payload);
    } catch (error) {
      console.warn(`[we] ${bucket} 回调抛异常:`, error && error.message);
    }
  }
}

window.wallpaperRegisterAudioListener = register('audio');
window.wallpaperRegisterMediaPropertiesListener = register('mediaProperties');
window.wallpaperRegisterMediaThumbnailListener = register('mediaThumbnail');
window.wallpaperRegisterMediaPlaybackListener = register('mediaPlayback');
window.wallpaperRegisterMediaTimelineListener = register('mediaTimeline');

// 样本读 `wallpaperMediaIntegration.PLAYBACK_PLAYING` 并在拿不到时兜底成 0。
// ⚠️ 所以 PLAYING 必须是 0，否则走兜底分支的壁纸会把"正在播放"判成停止。
window.wallpaperMediaIntegration = {
  PLAYBACK_PLAYING: 0,
  PLAYBACK_PAUSED: 1,
  PLAYBACK_STOPPED: 2,
};

// 壁纸调它表示"我准备好了"。样本确实会调（`We.wallpaperReady && We.wallpaperReady()`），
// 我们拿它当"页面里的 JS 真的跑起来了"的信号 —— 这是区分"白屏因为加载失败"和
// "白屏因为渲染有问题"的唯一观测点，而那两种在外面看起来一模一样。
window.wallpaperReady = () => {
  ipcRenderer.send('we-ready');
};

// 音频：主进程送 128 段 FFT。
ipcRenderer.on('we-audio', (_event, frame) => {
  // 壁纸的消费代码是 `e.length` + 下标访问，普通数组就够，不用 Float32Array。
  emit('audio', frame);
});

// 歌曲信息：四个通道分开，因为更新频率差一个量级（歌名换歌才变、进度每秒变）。
ipcRenderer.on('we-media-properties', (_event, p) => emit('mediaProperties', p));
ipcRenderer.on('we-media-thumbnail', (_event, p) => emit('mediaThumbnail', p));
ipcRenderer.on('we-media-playback', (_event, p) => emit('mediaPlayback', p));
ipcRenderer.on('we-media-timeline', (_event, p) => emit('mediaTimeline', p));

// 属性：**反向调用** —— 我们去调壁纸挂上来的那个对象。
//
// ⚠️ 它可能还不存在。壁纸的 bundle 在自己的模块里做这个赋值，而模块加载是异步的
// （`<script type="module">`），所以主进程可能在它挂上之前就发来了属性。
// 样本自己也考虑了这件事（它内部用 eg/bd 两个变量缓存早到的属性），但我们不能指望
// 每个壁纸都这么写 —— 所以宿主侧也缓存并重试。
let pendingUser = null;
let pendingGeneral = null;

function flush() {
  const listener = window.wallpaperPropertyListener;
  if (!listener) return false;
  if (pendingUser && typeof listener.applyUserProperties === 'function') {
    try {
      listener.applyUserProperties(pendingUser);
      pendingUser = null;
    } catch (error) {
      console.warn('[we] applyUserProperties 抛异常:', error && error.message);
      pendingUser = null;   // 别无限重试一个会抛的调用
    }
  }
  if (pendingGeneral && typeof listener.applyGeneralProperties === 'function') {
    try {
      listener.applyGeneralProperties(pendingGeneral);
      pendingGeneral = null;
    } catch (error) {
      console.warn('[we] applyGeneralProperties 抛异常:', error && error.message);
      pendingGeneral = null;
    }
  }
  return !pendingUser && !pendingGeneral;
}

// 轮询到挂上为止。⚠️ 有上限：无上限的 setInterval 在"这个壁纸根本不用属性接口"
// 的情况下会永远跑下去，而那是完全正常的壁纸（不是所有壁纸都有可配置项）。
const FLUSH_INTERVAL_MS = 60;
const FLUSH_TIMEOUT_MS = 8000;
let flushTimer = null;
let flushStartedAt = 0;

function scheduleFlush() {
  if (flush()) return;
  if (flushTimer) return;
  flushStartedAt = Date.now();
  flushTimer = setInterval(() => {
    if (flush() || Date.now() - flushStartedAt > FLUSH_TIMEOUT_MS) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
  }, FLUSH_INTERVAL_MS);
}

ipcRenderer.on('we-user-properties', (_event, props) => {
  pendingUser = { ...(pendingUser || {}), ...props };
  scheduleFlush();
});

ipcRenderer.on('we-general-properties', (_event, props) => {
  pendingGeneral = { ...(pendingGeneral || {}), ...props };
  scheduleFlush();
});

// 手势要能控制这个壁纸。做法是把手势翻译成它自己的属性（比如转视角 = 改 cameraAngleX），
// 走的还是 applyUserProperties 那条路 —— 不需要壁纸配合，也不需要注入 DOM 事件。
ipcRenderer.on('we-gesture-properties', (_event, props) => {
  pendingUser = { ...(pendingUser || {}), ...props };
  scheduleFlush();
});
