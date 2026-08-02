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
    // ⚠️⚠️ **这里是 textContent，不是 markdown** —— 写 `**音轨**` 会原样显示成
    //   带星号的字（用户 2026-08-02 的截图里就是那样，而那让整段话看起来像乱码）。
    //   ⟹ 纯文本里不写 markdown 标记。强调靠**措辞和顺序**，不靠符号。
    // ⚠️⚠️⚠️ **2026-08-02 第二次真实触发，而提示又是错的**（反方向）。
    //   用户截图里的原文：
    //     code 3: PIPELINE_ERROR_DECODE: Error Domain=NSOSStatusErrorDomain
    //     Code=-12909 "(null)" (-12909): VTDecompressionOutputCallback
    //   ⚠️ 里面**没有 "audio packet"** —— 而这条 hint 无条件说"解码挂在音轨上，
    //     错误里那句 audio packet 就是它" ⟹ **提示在说谎**。
    //   ⚠️ `-12909` 是 VideoToolbox 的 `kVTVideoDecoderBadDataErr`，
    //     而 `VTDecompressionOutputCallback` 是**视频轨**的解码回调
    //     ⟹ 挂的是视频轨，方向和上一次完全相反。
    //
    // ⟹ 判据：**一个错误码下面可能有完全不同的原因，别给码配一句话** ——
    //   要按**错误原文**分流。而"给码配一句话"这件事我在这条上错了两次
    //   （第一次说 HEVC、第二次说音轨），两次都是拿唯一见过的那个 case
    //   当成了这个码的全部含义。
    // ⟹ 具体的分流在下面 `decodeHint()` 里，这里只留**不知道是哪种**时的兜底。
    hint: null,
  },
  4: {
    title: '格式不支持',
    hint: '容器或编码不被支持。H.264 的 mp4 / VP9 的 webm 最稳。',
  },
};

// ⚠️⚠️⚠️ **按错误原文分流 code 3**（0.9.135）。
//
// 同一个 `PIPELINE_ERROR_DECODE` 底下至少有三种完全不同的原因，而它们的
// "下一步"互相矛盾：
//   · 音轨编码不支持（AC-3/E-AC-3/DTS）→ 去掉音轨（视频不用动）
//   · 视频轨编码不支持（HEVC/AV1）      → 转码视频
//   · 视频数据坏了 / 硬解不吃这一帧      → 转码也不一定救得回来
// ⟹ 给码配一句话必然对其中两种说错话（我已经错了两次，两个方向）。
function decodeHint(msg) {
  const m = String(msg || '');
  // ── ① 音轨（2026-08-02 第一次触发的那种）
  if (/audio packet/i.test(m)) {
    return '解码挂在音轨上（错误里那句 "audio packet" 就是它）。\n'
      + '壁纸不需要声音，把音轨去掉最省事（视频不重新编码，秒完）：\n\n'
      + 'ffmpeg -i 原文件.mp4 -c:v copy -an 新文件.mp4';
  }
  // ── ② VideoToolbox 的视频解码错（2026-08-02 第二次触发的那种）
  //   ⚠️ `-12909` = kVTVideoDecoderBadDataErr（数据坏了 / 硬解不吃这一帧）
  //   ⚠️ `-12911` = kVTVideoDecoderMalfunctionErr
  //   ⚠️ `-8969`  = codecBadDataErr
  //   而 `VTDecompressionOutputCallback` 出现就说明挂在**视频轨**的解码回调里。
  if (/VTDecompression|VideoToolbox|-12909|-12911|-8969/i.test(m)) {
    return '解码挂在视频轨上（错误里的 VTDecompression / -12909 是 macOS 的'
      + '硬件解码器报的）。\n'
      + '⚠️ 而它常常是放了一会儿才挂 —— 那说明不是"整个文件不支持"，'
      + '是某几帧硬解器不吃（数据本身有问题，或者用了它不支持的编码特性）。\n\n'
      + '重编码一次通常能救回来（用软件编码器重写每一帧）：\n\n'
      + 'ffmpeg -i 原文件.mp4 -c:v libx264 -pix_fmt yuv420p -an 新文件.mp4\n\n'
      + '⚠️ 如果它一装载就挂（不是放一会儿），那更可能是编码本身不支持'
      + '（HEVC/H.265 或 AV1）—— 同一条命令也能转。';
  }
  // ── ③ 不知道是哪种：**别猜**，只说清"该看什么"
  //   ⚠️ 判据：不知道的时候给观测入口，别给一个可能是错的建议。
  return '解码失败，而错误原文里没有能定位到具体轨道的线索。\n'
    + '⚠️ 把上面那行 code 3 的原文发给我 —— 音轨、视频轨、数据损坏三种的'
    + '处理方式完全不同，看错方向会白折腾一遍转码。\n\n'
    + '想先自己试：ffmpeg -i 原文件.mp4 -c:v libx264 -pix_fmt yuv420p -an 新文件.mp4'
    + '（重编码视频 + 去掉音轨，三种都覆盖）';
}

// ⚠️⚠️ **这三个都是 `textContent`，不是 markdown** —— 写 `**音轨**` 会原样
//   显示成带星号的字（用户 2026-08-02 的截图里就是那样，整段话看起来像乱码）。
//   ⚠️ 而我 0.9.135 写 decodeHint 时**又踩了一次**（上一版的注释里就写着这条）
//     ⟹ 判据：**强调靠措辞和顺序，不靠符号。** 纯文本里一个 `*` 都别写。
//   ⚠️ 换行是有效的（CSS 里 `white-space: pre-wrap`，见 video.html）。
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

// ⚠️⚠️⚠️ **音轨挂掉时请宿主转一份没有音轨的**（0.9.111）。
//
// 用户 2026-08-02 两次报同一个错（第二次是在我"修好"之后）：
//     code 3: PIPELINE_ERROR_DECODE: Failed to send audio packet for decoding
//
// 挂的是**音轨**，而 `<video>` 上有 `muted` ⟹ **Chromium 即使静音也照样解码音轨**
// ⟹ 视频轨完全能放的壁纸整个黑屏（工坊里常见 AC-3/E-AC-3/DTS）。
//
// ⚠️⚠️ **而 0.9.109 我在这里加的"关掉 audioTracks 再重试"是空转** ——
//   那个 API 在 Chromium 里默认不存在（我自己的注释都写了"大概率拿不到"）。
//   ⟹ 教训：**明知"大概率不管用"的修复不该当成修复发出去** ——
//     那一版让用户以为解决了，而它只是把同一个错又报了一遍。
//
// ⟹ 真能修的地方在宿主：AVFoundation 只保留视频轨、不重新编码（几秒）。
//   这边只负责两件事：**报上去** + **拿到新 URL 后换过去**。
let askedStrip = false;
// ⚠️ "放了一会儿才挂"只自己重试一次 —— 见 error handler 里那段判据。
let retriedMidPlay = false;

video.addEventListener('error', () => {
  const err = video.error;
  const code = err ? err.code : 0;
  const msg = (err && err.message) || '';
  const spec = MEDIA_ERRORS[code] || { title: '未知错误', hint: '' };

  // ⚠️ 只有"音轨解码失败"值得请宿主转 —— 别的转了也没用。
  const audioFail = code === 3 && /audio packet/i.test(msg);
  if (audioFail && !askedStrip && window.gw && window.gw.videoAudioFailed) {
    askedStrip = true;
    // ⚠️ 先把错误显示出来**再**请求 —— 转换要几秒，那几秒里画面不该是空的，
    //   而"正在处理"比"一片黑"好。转好之后 use-cache 会把它盖掉。
    fail(spec.title, `code ${code}${msg ? `: ${msg}` : ''}`,
      '这个视频的音轨 Chromium 放不了 —— 正在自动转一份没有音轨的（通常几秒）。\n'
      + '⚠️ 如果一直停在这儿，看面板「?」页里 we 那段的日志。');
    // ⚠️ 传**相对文件名**而不是完整 URL —— 宿主那边只信自己解析出来的路径
    //   （渲染进程传来的路径不能直接拿去读文件）。
    const name = decodeURIComponent(String(video.currentSrc || video.src)
      .split('/').pop() || '');
    window.gw.videoAudioFailed({ file: name, mode: 'strip' });
    return;
  }

  // ⚠️⚠️⚠️ **放了一会儿才挂 ⟹ 先自己重试一次**（0.9.135）。
  //
  // 用户 2026-08-02：「video 类型的一个壁纸**运行着突然**解码失败」——
  // 那个"运行着"是关键信息：文件本身能解码（已经放了一段时间），
  // 挂掉的是**某几帧**（VideoToolbox 的 -12909 = 数据坏了 / 硬解不吃这一帧）。
  //
  // ⟹ 而壁纸是**循环播放**的：从头再来一遍很可能就过去了
  //   （下一轮到那几帧时也许还挂，但至少不是"一挂就永久黑屏到用户来处理"）。
  // ⚠️ 判据：**"从没放起来"和"放了一会儿挂了"是两类故障** ——
  //   前者是文件/编码不支持（重试无用），后者可能是瞬时的（重试值得试）。
  //   而原来的代码对两者一视同仁：直接显示错误、停在那儿。
  //
  // ⚠️ 只重试**一次**，而且要求已经放过 >2 秒：
  //   · 无限重试会变成"黑屏闪烁"的死循环（比停住更糟）
  //   · 没放起来就重试等于把同一个失败做两遍，白等
  // ⚠️ 而重试失败之后照常显示错误 —— 不能把故障吞掉。
  const playedFor = video.currentTime;
  if (code === 3 && !retriedMidPlay && playedFor > 2) {
    retriedMidPlay = true;
    report({ ok: false, kind: '解码中断，正在重试', detail: `已放 ${playedFor.toFixed(1)}s`, midPlay: true });
    // ⚠️ `load()` 会重置到头 —— 对壁纸没关系（它本来就在循环）。
    video.load();
    video.play().catch(() => { /* 真不行的话下一次 error 事件会走到下面 */ });
    return;
  }

  // ⚠️⚠️⚠️ **视频轨挂了 ⟹ 请宿主重编码一份**（0.9.136）。
  //
  // 用户 2026-08-02 对着 0.9.135 说"还是有问题" —— 而他说得对：
  //   那一版只是把提示改准了（说清是视频轨、给了 ffmpeg 命令），
  //   **壁纸还是放不了**，他仍然得自己去跑那条命令。
  // ⟹ 判据：**报得准不等于修好了。** 而我们有 AVFoundation（去音轨那个 helper
  //   已经在用它了）⟹ 加一个"重编码"模式就能自己修，不该把活推给用户。
  //
  // ⚠️ 而它排在**重试之后** —— 重试是秒级的，重编码要按分钟算
  //   ⟹ 先试便宜的那个。
  // ⚠️ 只请求一次（`askedStrip` 和音轨那支共用一个标志：同一个文件不会既要
  //   去音轨又要重编码 —— 错误原文只会指向一轨）。
  const videoTrackFail = code === 3
    && /VTDecompression|VideoToolbox|-12909|-12911|-8969/i.test(msg);
  if (videoTrackFail && !askedStrip && window.gw && window.gw.videoAudioFailed) {
    askedStrip = true;
    fail(spec.title, `code ${code}${msg ? `: ${msg}` : ''}`,
      '这个视频有几帧 macOS 的硬件解码器放不了 —— 正在自动重新编码一份。\n'
      + '⚠️ 每一帧都要重写，所以要几十秒到几分钟（看文件大小）。\n'
      + '⚠️ 进度看面板「?」页里 we 那段的日志。');
    const name = decodeURIComponent(String(video.currentSrc || video.src)
      .split('/').pop() || '');
    window.gw.videoAudioFailed({ file: name, mode: 'reencode' });
    return;
  }

  // err.message 常常是空字符串，所以带上码 —— 没有它连"是哪一类"都不知道。
  // ⚠️ code 3 的 hint 按**错误原文**分流（见 decodeHint）——
  //   给码配一句话会对其中两种原因说错话（实测栽过两次，两个方向）。
  // ⚠️ 而"放了一会儿才挂"这件事要带进详情 —— 它决定用户该转码还是该换壁纸。
  const when = playedFor > 2 ? `（已放 ${playedFor.toFixed(1)}s 后才挂，重试过一次）` : '';
  fail(spec.title, `code ${code}${msg ? `: ${msg}` : ''}${when}`,
    spec.hint !== null ? spec.hint : decodeHint(msg));
});

// 宿主转好了 ⟹ 换成那个没有音轨的文件。
// ⚠️ 而**必须把错误框收起来** —— 不收的话它盖在正常播放的视频上面。
if (window.gw && window.gw.onVideoUseCache) {
  window.gw.onVideoUseCache((payload) => {
    const url = payload && payload.url;
    if (!url) return;
    errBox.classList.remove('on');
    video.src = url;
    video.load();
    video.play().catch(() => { /* loadeddata 那条会再试一次 */ });
    report({ ok: true, usingStrippedCache: true });
  });
}

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
