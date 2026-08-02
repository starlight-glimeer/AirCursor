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
const image = document.getElementById('i');
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
    //
    // ⚠️⚠️⚠️ **2026-08-02：这条第一次真的被触发了，而当时的提示是错的。**
    //
    // 用户报"video 这种类型的壁纸不稳定，运行着会弹出来"，截图里的原文是：
    //     code 3: PIPELINE_ERROR_DECODE: **Failed to send audio packet** for
    //     decoding: {timestamp=0 duration=21333 size=847 …}
    //
    // ⚠️ 关键在 **audio packet** —— 挂掉的是**音轨**，不是视频轨。
    //   而 `<video>` 上明明有 `muted`（video.html 那行）⟹ 那说明
    //   **Chromium 即使静音也照样解码音轨**（muted 只是不输出到设备）。
    //   ⟹ 一个视频轨完全能放的壁纸，会因为音轨编码不支持而整个失败。
    //
    // ⚠️⚠️ 而当时那句提示说"换一个 H.264 的壁纸，或者用 ffmpeg 转一次" ——
    //   **对这个 case 是错的方向**：视频可能本来就是 H.264，转码是白折腾。
    //   正解是**把音轨去掉**（壁纸本来就不该出声）。
    //   ⟹ 教训：一条从未被触发过的错误分支，它的"下一步建议"是**推断**。
    //     真触发时第一件事是核对"错误说的是什么"，而不是照搬那个建议。
    hint: '解码挂在**音轨**上（错误里那句 "audio packet" 就是它）——'
      + '壁纸本来不需要声音，把音轨去掉最省事：\n'
      + 'ffmpeg -i 原文件 -c:v copy -an 新文件.mp4\n'
      + '（-c:v copy = 视频不重新编码，秒完；-an = 丢掉音轨）\n'
      + '如果去掉音轨还是这个错，那才是视频轨的编码不支持'
      + '（HEVC/H.265 或 AV1）⟹ 再加 -c:v libx264 转一次。',
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

// ⚠️⚠️⚠️ **音轨挂掉时自动重试一次（丢掉音轨）**（0.9.109）。
//
// 用户 2026-08-02 报"video 这种壁纸不稳定，运行着会弹出来"，截图原文：
//     code 3: PIPELINE_ERROR_DECODE: **Failed to send audio packet** for decoding
//
// ⚠️ 挂掉的是**音轨** —— 而 `<video>` 上有 `muted`（video.html 那行）
//   ⟹ **Chromium 即使静音也照样解码音轨**，muted 只管"不输出到设备"。
//   ⟹ 一个视频轨完全正常的壁纸，会因为音轨编码不支持而整个黑屏。
//
// ⟹ 而这件事我们能自己救：`disableRemotePlayback` 不管用，但
//   **重新加载时用 MediaSource 只挑视频轨**太重（要解封装）——
//   代价最低的是 `video.audioTracks`（能关就关）+ 重试一次。
//   ⚠️ 而 audioTracks 在 Chromium 里**默认没有**（要 flag）⟹ 大概率拿不到。
//   ⟹ 所以真正的兜底是：**报错时告诉用户去掉音轨的确切命令**（见上面 hint），
//     而不是假装能修好。
//
// ⚠️ 这里只做一件有把握的事：**同一个源只重试一次，且必须报出来**。
//   静默重试是这个项目栽过最多次的形状 —— 它会让"偶尔能放"变成一个谜。
let retried = false;

video.addEventListener('error', () => {
  const err = video.error;
  const code = err ? err.code : 0;
  const msg = (err && err.message) || '';
  const spec = MEDIA_ERRORS[code] || { title: '未知错误', hint: '' };

  // ⚠️ 只有"音轨解码失败"这一种值得重试 —— 别的重试就是白等。
  const audioOnly = code === 3 && /audio packet/i.test(msg);
  if (audioOnly && !retried) {
    retried = true;
    // ⚠️ 关掉音轨（Chromium 通常没这个 API —— 有就用，没有就往下走）
    let killed = false;
    const tracks = video.audioTracks;
    if (tracks && tracks.length) {
      for (let i = 0; i < tracks.length; i += 1) tracks[i].enabled = false;
      killed = true;
    }
    report({ ok: false, kind: '音轨解码失败，重试一次', detail: msg,
      hint: killed ? '已关掉音轨' : 'Chromium 没给 audioTracks API，直接重载试试' });
    // ⚠️ 重新 load 而不是 play() —— 错误状态下 play() 不会重新解封装。
    const src = video.currentSrc || video.src;
    video.removeAttribute('src');
    video.load();
    video.src = src;
    video.load();
    return;
  }

  // err.message 常常是空字符串，所以带上码 —— 没有它连"是哪一类"都不知道。
  fail(spec.title, `code ${code}${msg ? `: ${msg}` : ''}`, spec.hint);
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

// 按扩展名决定用 <video> 还是 <img>。
//
// ⚠️ 用扩展名而不是 project.json 的 type，理由是 legacy 单文件壁纸的 type 是
// 我们自己造的，而扩展名来自魔数嗅探 —— 后者更可信。
const IMAGE_EXT = /\.(gif|png|jpe?g|webp)(\?|$)/i;

window.gw.onVideoSource((payload) => {
  if (!payload || !payload.url) {
    fail('没有媒体源', '主进程没给 url', '');
    return;
  }
  errBox.classList.remove('on');

  if (IMAGE_EXT.test(payload.url)) {
    video.classList.remove('on');
    image.classList.add('on');
    // GIF 的循环由浏览器管，不用我们做。
    image.onload = () => {
      // ⚠️ 小图铺满大屏必然糊，而这时候 cover（裁掉边缘换铺满）是错的选择：
      // 它把本来就不够的像素再放大。低分辨率的源用 contain 更好 —— 保持原尺寸
      // 比例、留黑边，至少画面是清楚的。
      //
      // 阈值按屏幕宽度的一半：源图宽度不到屏幕一半，放大 2 倍以上就明显糊了。
      const tooSmall = image.naturalWidth > 0
        && image.naturalWidth < window.innerWidth * 0.5;
      image.style.objectFit = tooSmall ? 'contain' : 'cover';
      report({
        ok: true, kindLoaded: 'image',
        width: image.naturalWidth, height: image.naturalHeight,
        // 报出来让面板能解释"为什么糊" —— 那和"渲染差"是两件事。
        screenWidth: window.innerWidth,
        upscale: image.naturalWidth ? +(window.innerWidth / image.naturalWidth).toFixed(1) : null,
        fit: image.style.objectFit,
      });
    };
    // ⚠️ 图片加载失败也要报 —— 否则黑屏又变成"五种原因长得一样"。
    image.onerror = () => fail('图片放不出来', payload.url,
      '文件坏了，或者 protocol 没通。诊断报告里有实际请求的 URL。');
    image.src = payload.url;
    report({ ok: true, loading: true, url: payload.url, kind: 'image' });
    return;
  }

  image.classList.remove('on');
  video.classList.add('on');
  video.src = payload.url;
  // ⚠️ 必须显式 load()：换源时如果不调，旧的那段可能继续放 ——
  // 表现是"换了壁纸但画面没变"，看起来像装载失败。
  video.load();
  report({ ok: true, loading: true, url: payload.url, kind: 'video' });
});
