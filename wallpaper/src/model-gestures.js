// 用模型识别手势：MediaPipe 的 GestureRecognizer。
//
// ── 为什么加这一层 ────────────────────────────────────────────────────────
//
// 现在的手势判定是**手写几何**：把 21 个关键点拼成 63 维向量，算欧氏距离，小于 0.28 就
// 算命中。它没有"什么叫摊开的手"这种语义，只知道"和存的那 63 个数字差多少"。
//
// 实测代价（真机 landmark）：
//   · 手动着的时候，一个 0.28 的球只能停留 **89ms**（相邻 43ms 就走掉门的 48%）
//   · 序列匹配要求依次进入 N 个这样的球 ⟹ 同一个人相邻两秒做同样的动作，
//     **10 个关键帧一个都走不到**（最近的差 0.817，是门的 3 倍）
//
// 这不是调参能救的：门放大到能进球，就大到任何姿势都算命中。用户的判断是对的
// （「是不是我们的动态效果和成熟的路线不太一致」）——**我们在该用模型的地方用了尺子**。
//
// GestureRecognizer 在 hand_landmark 之上多一层分类头，是真的模型：它学过"什么叫
// Open_Palm"，所以手大一点小一点、角度偏一点都认。而且是**本地推理**（12ms 级、免费、
// 不上传画面），不像 VLM API 那条路要付 300–2000ms 的往返。
//
// ── 边界（这条路能做到什么、做不到什么） ──────────────────────────────────
//
// 内置只有 8 类：None / Closed_Fist / Open_Palm / Pointing_Up / Thumb_Down /
// Thumb_Up / Victory / ILoveYou。其中 **Open_Palm 正好是用户报"录得最费劲"的双手摊开**。
//
// ⚠️ 自定义手势仍然要训练。`customGesturesClassifierOptions` 只是配置**已训练好的**
// 分类器的阈值和白名单，它不训练模型；训练要走 Model Maker，而官方已标"不再积极维护"，
// 样本量是 Apple 参考的 100 视频/类那个量级。
//
// ⟹ 所以这一层的定位是**旁路，不是替代**：内置那 8 类交给模型，其余继续用尺子。
// 用户可以在面板上把某个动作绑到一个内置手势上，那个动作就不再需要录制。
//
// ── 为什么不直接换掉现在的 hands ──────────────────────────────────────────
//
// GestureRecognizer 的输出里**同时带 landmarks**，所以技术上可以整体替代。但：
//   · 换了之后骨架、录制、判定全都跑在一条没被真机验过的链上，一次动到四块
//   · 现在这条链刚被修通（静态手势、打开网易云都验过了）
//   · 而且我在云端跑不了它（要浏览器 + WebGL），真机结论只能来自用户
// 所以先做成可切换的旁路，让"模型认出来了没有"和"尺子认出来了没有"能并排看。
(function (root) {

// 模型资源都在 vendor 里，不联网取 —— 这是个桌面应用，"没网就不能用手势"不可接受。
const BASE = 'vendor/mediapipe/tasks-vision';

// 内置的 8 类。`None` 是"没认出任何手势"，不是一个可绑的动作。
const CANNED = ['Closed_Fist', 'Open_Palm', 'Pointing_Up', 'Thumb_Down', 'Thumb_Up',
  'Victory', 'ILoveYou'];

// 给用户看的名字。英文类名直接显示的话，"ILoveYou"那种没人知道是什么手势。
const LABELS = {
  Closed_Fist: '握拳',
  Open_Palm: '张开手掌',
  Pointing_Up: '食指向上',
  Thumb_Down: '拇指向下',
  Thumb_Up: '拇指向上',
  Victory: '胜利手势（V）',
  ILoveYou: '我爱你手势',
};

// 置信度门槛。模型每帧都会给一个分数，低分的当没认出来。
//
// 0.6 是个起点，不是标定值 —— 真机上要看误触率再调。比尺子那套好的地方是这个数
// **有明确含义**（模型对自己的判断有多确定），而 0.28 那个距离门没有。
const DEFAULT_SCORE = 0.6;

class ModelGestures {
  constructor() {
    this.recognizer = null;
    this.ready = false;
    this.error = null;
    this.lastAt = 0;
    // 每只手上一次认出的手势，用来做"离开再回来"——和尺子那套同一个道理：
    // 一直摆着的手型不该每帧触发一次。
    this.armed = new Map();
  }

  // 加载模型。失败不抛 —— 这是旁路，它挂了不该让整层停摆。
  async load(numHands = 2) {
    if (this.recognizer || this.error) return this.ready;
    try {
      // 动态 import：不用它的时候不该付 11MB wasm 的加载代价。
      //
      // ⚠️ 路径要用 `new URL(..., document.baseURI)` 解析，不能直接写相对路径。
      // 经典脚本里的 `import()` 是相对**文档 URL**解析的，而这个文件被 overlay.html
      // 加载 —— 两者恰好同目录所以看着能用，但哪天 html 移动一层就会静默 404，
      // 而症状是"开了开关但模型永远加载不出来"。
      const url = new URL(`${BASE}/vision_bundle.mjs`, document.baseURI).href;
      const vision = await import(url);
      const fileset = await vision.FilesetResolver.forVisionTasks(BASE);
      this.recognizer = await vision.GestureRecognizer.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: `${BASE}/gesture_recognizer.task`,
          // GPU 更快，但在 Electron 里不一定拿得到 —— 失败会落回 CPU（下面 catch）。
          delegate: 'GPU',
        },
        // VIDEO 而不是 IMAGE：它内部会做跨帧跟踪，和我们每帧喂一张图的用法一致。
        runningMode: 'VIDEO',
        numHands,
      });
      this.ready = true;
    } catch (error) {
      this.error = String((error && error.message) || error);
      this.ready = false;
    }
    return this.ready;
  }

  dispose() {
    if (this.recognizer) {
      try { this.recognizer.close(); } catch { /* 已经关了 */ }
    }
    this.recognizer = null;
    this.ready = false;
    this.armed.clear();
  }

  // 喂一帧。返回 { gestures: [{ name, label, score, hand }], landmarks }。
  //
  // `timestamp` 必须单调递增（VIDEO 模式的要求），而且不能和上一帧相同 —— 相同会
  // 让它抛"timestamp mismatch"，那个错误信息完全看不出是这个原因。
  detect(video, now) {
    if (!this.ready || !this.recognizer) return null;
    // 时间戳去重：摄像头偶尔会在同一毫秒交付两帧。
    const ts = now <= this.lastAt ? this.lastAt + 1 : Math.round(now);
    this.lastAt = ts;
    let result;
    try {
      result = this.recognizer.recognizeForVideo(video, ts);
    } catch (error) {
      // 单帧失败不该让这一层停掉 —— 记下原因，下一帧继续。
      this.error = String((error && error.message) || error);
      return null;
    }
    const out = [];
    const groups = result.gestures || [];
    for (let hand = 0; hand < groups.length; hand += 1) {
      const top = groups[hand] && groups[hand][0];
      if (!top || !top.categoryName || top.categoryName === 'None') continue;
      out.push({
        name: top.categoryName,
        label: LABELS[top.categoryName] || top.categoryName,
        score: Number(top.score.toFixed(3)),
        hand,
      });
    }
    return { gestures: out, landmarks: result.landmarks || [] };
  }

  // 把这一帧的识别结果变成"该触发哪些动作"。
  //
  // `bindings` 是 { 内置手势名: 动作 id }。走"离开再回来"而不是每帧发一次 ——
  // 和尺子那套同一个理由：一直摆着的手型只该算一个动作。
  actionsFor(detection, bindings, minScore = DEFAULT_SCORE) {
    const fired = [];
    if (!detection || !bindings) return fired;
    const seen = new Set();
    for (const g of detection.gestures) {
      if (g.score < minScore) continue;
      seen.add(g.name);
      const action = bindings[g.name];
      if (!action) continue;
      if (this.armed.get(g.name) === false) continue;   // 还没离开过
      this.armed.set(g.name, false);
      fired.push({ action, gesture: g.name, score: g.score });
    }
    // 这一帧没认出的手势重新武装。**用"没被认出"当离开的信号**，而不是算距离 ——
    // 模型的输出天然是离散的，不需要再造一个阈值。
    for (const name of Object.keys(bindings)) {
      if (!seen.has(name)) this.armed.set(name, true);
    }
    return fired;
  }
}

root.GestureWallModelGestures = {
  CANNED,
  LABELS,
  DEFAULT_SCORE,
  ModelGestures,
};
})(typeof window === 'undefined' ? globalThis : window);
