// video 类壁纸的渲染层。一个 <video> 就够，难的不是播放而是**说清为什么没播**。
//
// 黑屏有五种原因，而它们在屏幕上长得一模一样：
//   ① 文件找不到（路径/protocol 错）
//   ② 编解码器不支持（HEVC / AV1 —— Chromium 默认不带）
//   ③ 视频在放但被别的层挡住 / 窗口层级不对
//   ④ 视频真的就是黑的那一段
//   ⑤ autoplay 被挡（虽然 muted 一般不会）
//
// ⟹ 所以这里的重点是**每种都报出不同的信号**，并且持续汇报"我现在在放第几秒"——
// 有那个数就能一眼分开"放不了"和"放了但看不见"，而那是两种完全不同的修法。

const video = document.getElementById('v');
const errBox = document.getElementById('err');
const errTitle = document.getElementById('err-title');
const errDetail = document.getElementById('err-detail');
const errHint = document.getElementById('err-hint');

// MediaError 的四个码。⚠️ 只报数字对用户没用，每个都要给出**能行动的下一句**。
const MEDIA_ERRORS = {
  1: {
    title: '加载被中断',
    hint: '一般是窗口在加载途中被关了。重新装载一次看看。',
  },
  2: {
    title: '读不到文件',
    hint: '文件路径不对，或者自定义 protocol 没通。诊断报告里有实际请求的 URL。',
  },
  3: {
    title: '解码失败',
    // ⚠️ 这条是最可能撞上的：WE 工坊里有 HEVC(H.265) 编码的视频，而 Electron
    // 打包的 Chromium **默认不带 HEVC 解码器**。同样 AV1 也常常没有。
    // 那种壁纸会黑屏，而原因和"我们的代码坏了"完全不同 —— 必须能分开。
    hint: '这个视频的编码 Chromium 放不了（最常见是 HEVC/H.265 或 AV1）。'
      + '换一个 H.264 的壁纸，或者用 ffmpeg 转一次。',
  },
  4: {
    title: '格式不支持',
    hint: '容器或编码不被支持。H.264 的 mp4 / VP9 的 webm 最稳。',
  },
};

function fail(kind, detail, hint) {
  errTitle.textContent = kind;
  errDetail.textContent = detail || '';
  errHint.textContent = hint || '';
  errBox.classList.add('on');
  report({ ok: false, kind, detail, hint });
}

function report(payload) {
  if (window.gw && window.gw.sendVideoStatus) {
    window.gw.sendVideoStatus({ ...payload, at: Date.now() });
  }
}

video.addEventListener('error', () => {
  const err = video.error;
  const code = err ? err.code : 0;
  const spec = MEDIA_ERRORS[code] || { title: '未知错误', hint: '' };
  // err.message 常常是空字符串，所以带上码 —— 没有它连"是哪一类"都不知道。
  fail(spec.title, `code ${code}${err && err.message ? `: ${err.message}` : ''}`, spec.hint);
});

// ⚠️ 这条是"放了但看不见"的唯一证据。
//
// 没有它，画面黑就只能猜；有它就能确定视频解码正常、问题在窗口层级或遮挡 ——
// 后者是我们自己代码的事，前者不是。
let lastReport = 0;
video.addEventListener('timeupdate', () => {
  const now = Date.now();
  // 每秒一次就够。timeupdate 每秒能触发好几次，全发会把 IPC 灌满。
  if (now - lastReport < 1000) return;
  lastReport = now;
  report({
    ok: true,
    playing: !video.paused,
    currentTime: Number(video.currentTime.toFixed(1)),
    duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(1)) : null,
    // 分辨率是"解码真的成功了"的硬证据 —— 解不出来的话这两个数是 0。
    width: video.videoWidth,
    height: video.videoHeight,
  });
});

// autoplay 在 muted 时一般不会被挡，但"一般"不等于"永远"。
// ⚠️ 而它失败的样子就是黑屏，和解码失败一样 —— 所以显式试一次并报出来。
video.addEventListener('loadeddata', () => {
  video.play().catch((error) => {
    fail('自动播放被挡', String(error && error.message),
      '这不该发生（视频是 muted 的）。诊断报告发给我，我看看是什么挡的。');
  });
});

window.gw.onVideoSource((payload) => {
  if (!payload || !payload.url) {
    fail('没有视频源', '主进程没给 url', '');
    return;
  }
  errBox.classList.remove('on');
  video.src = payload.url;
  // ⚠️ 必须显式 load()：换源时如果不调，旧的那段可能继续放 ——
  // 表现是"换了壁纸但画面没变"，看起来像装载失败。
  video.load();
  report({ ok: true, loading: true, url: payload.url });
});
