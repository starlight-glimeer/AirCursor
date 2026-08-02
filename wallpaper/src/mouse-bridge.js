// 全局鼠标 → 壁纸窗口。让「真壁纸层」和「鼠标交互」同时成立。
//
// 背景（这是这个文件存在的全部理由）：
//
// macOS 上这两件事本来互斥 ——
//   真壁纸层能覆盖菜单栏那 25px，但**收不到鼠标事件**
//   普通窗口能收鼠标，但**画不到菜单栏那一层**
//
// 我原来做成了"让用户选一个"，而用户否掉了：mac 原生壁纸没有那条缝，
// 而"鼠标交互失效"对一个交互式壁纸产品不可接受。他是对的 ——
// 给两个残废选项不是解法。
//
// ⟹ 正解是 Open Wallpaper Engine 那套：窗口留在壁纸层，鼠标事件用全局监听抓下来
// 再手动转发进去。我们这边用 Swift helper（NSEvent）+ sendInputEvent 实现同一件事。
//
// ⚠️⚠️ 权限：**需要辅助功能授权**，而开发模式（npm start）下拿不到。
//
// 我原来断言"监听鼠标不需要那个权限"，说了三次而从没验证。实测证伪：
// helper 报了 running（addGlobalMonitorForEvents 返回非 nil），而动鼠标零事件。
// ⟹ 这是最坏的一种失败：不报错，只是静默不工作。
//
// 而 aircursor-notes/pitfalls.md 第 281 行早就写着这条：`packaged: false` 时
// 辅助功能列表里根本没有本应用 ⟹ 权限类问题"到此为止，先打包再验"。
//
// 解析和坐标换算放在这里且是纯函数 —— 那是这条链里唯一能在云端验的部分。
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { findPrebuilt } = require('./prebuilt-helper.js');
const crypto = require('node:crypto');

// helper 一行一个 JSON。逐行解析而不是攒 buffer：它永不结束，
// 而半行 JSON.parse 会失败。
function parseLines(buffer, chunk) {
  const combined = buffer + chunk;
  const parts = combined.split('\n');
  const tail = parts.pop();
  const messages = [];
  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed));
    } catch {
      messages.push({ type: 'garbage', raw: trimmed.slice(0, 200) });
    }
  }
  return { messages, tail };
}

// 屏幕坐标 → 窗口内坐标。
//
// ⚠️ 这一步错了的症状是"点击位置偏移"，而那看起来像命中判定有 bug。
// 壁纸窗口通常就在 (0,0) 且铺满，所以偏移量常常是 0 —— 也就是**测不出来**，
// 直到用户接了第二块屏幕。所以显式减 bounds 而不是假设窗口在原点。
function toWindowPoint(event, bounds) {
  if (!event || !bounds) return null;
  const x = Math.round(event.x - bounds.x);
  const y = Math.round(event.y - bounds.y);
  // 落在窗口外的事件直接丢：多显示器时鼠标会跑到别的屏上，
  // 而把负坐标喂给 sendInputEvent 会让渲染进程收到莫名其妙的位置。
  if (x < 0 || y < 0 || x > bounds.width || y > bounds.height) return null;
  return { x, y };
}

// helper 的事件 → Electron 的 sendInputEvent 载荷。
//
// ⚠️ 字段名必须完全对上 Electron 的定义，而写错**不会报错** ——
// sendInputEvent 对不认识的字段是静默忽略的，症状是"事件发了但页面没反应"。
function toInputEvent(event, point) {
  if (!event || !point) return null;
  switch (event.kind) {
    case 'move':
      return { type: 'mouseMove', x: point.x, y: point.y };
    // ⚠️⚠️⚠️ **拖拽必须带按键状态**（0.9.108）。
    //
    // 用户 2026-08-02 要做的是"歌单当壁纸背景，允许鼠标点击和 360° 拖拽"
    // （对着 OWE 那个音乐播放器的效果）。而这一支原来和 `move` **合在一起**，
    // 注入的是**裸 `mouseMove`**（不带 button）⟹ 页面收到 `mousemove` 而
    // `event.buttons === 0` ⟹ **任何"按住拖"的判定都不成立**。
    //
    // ⚠️ 而症状会是"点得动、拖不动"，而且**不报任何错** ——
    //   壁纸那边只是收到一串普通的 hover 移动。
    //   （那个粒子壁纸的 js 里就在读 `buttons`/`which`，OWE 那种 orbit 控制
    //    更是必然要判"左键有没有按着"。）
    //
    // ⚠️⚠️ Electron 的 `sendInputEvent` 对 mouseMove 认 `button` 字段：
    //   带上它才等价于"拖拽中的移动"。
    case 'drag':
      return {
        type: 'mouseMove', x: point.x, y: point.y,
        button: event.button === 2 ? 'right' : 'left',
      };
    case 'down':
      return {
        type: 'mouseDown', x: point.x, y: point.y,
        button: event.button === 2 ? 'right' : 'left',
        // clickCount 必须给：缺了它页面收不到 click 事件（只有 mousedown），
        // 而"能按下但不算点击"是个很难查的症状。
        clickCount: 1,
      };
    case 'up':
      return {
        type: 'mouseUp', x: point.x, y: point.y,
        button: event.button === 2 ? 'right' : 'left',
        clickCount: 1,
      };
    case 'scroll':
      return {
        type: 'mouseWheel', x: point.x, y: point.y,
        deltaX: event.dx || 0, deltaY: event.dy || 0,
        // canScroll 少了的话滚动会被当成无效事件丢掉。
        canScroll: true,
      };
    default:
      return null;
  }
}

// 编译 helper。源码没变不重编。
//
// ⚠️⚠️⚠️ **文件名里不许带 hash**（0.9.89）。用户 2026-08-02，第六轮：
//
//   「假如说每次的进程在系统看来都是不一样的程序，那这不就是有问题的吗？
//     我每次打开都是同一个产品啊，你如果用一个不一样的东西作为某点来检测，
//     那不是必然每次都会弹的吗？其他摄像头权限查了我一次后面都正常开了」
//
// **他说对了，而这是"反复弹框"的真正根因。** 前五版我全在改弹框逻辑，
// 而问题在**命名**：原来叫 `GestureWallMouse-${sha256(源码).slice(0,12)}`，
// 而 **TCC 按可执行文件路径记授权** ⟹ 我每改一次这个 Swift 文件，
// 打出来的就是一个**新文件名 = 新程序**，用户上次给的授权对它不算。
//
// ⚠️⚠️ 对照用户自己的打包日志就能坐实：
//   `GestureWallAudio-0b0001ce0347` —— 五个版本一个字没变 ⟹ 音乐权限只问一次 ✅
//   `GestureWallMouse-f57afb8d2af0 → 1635ebad82ad → 4edcf88e073a` ⟹ 每次都问 ❌
//   差别不是"辅助功能比麦克风特殊"，是**我改了哪个文件**。
//   而摄像头是**主应用自己**要的（bundle id 稳定）⟹ 从来没这个问题。
//
// ⟹ 二进制名固定为 `GestureWallMouse`，hash 挪到旁边的 `.hash` 文件里
//   ——「源码变了要重编」这个能力一点没丢，而路径从此稳定。
const HELPER_NAME = 'GestureWallMouse';

function ensureHelper(sourcePath, outDir, run = spawnSync) {
  if (!fs.existsSync(sourcePath)) {
    return { ok: false, error: `鼠标 helper 源码不在：${sourcePath}` };
  }
  const hash = crypto.createHash('sha256')
    .update(fs.readFileSync(sourcePath)).digest('hex').slice(0, 12);
  const binary = path.join(outDir, HELPER_NAME);
  const stamp = `${binary}.hash`;
  // ⚠️ 判"要不要重编"改成读 .hash 文件 —— 原来是"那个带 hash 的文件名存不存在"。
  //   两者等价，而这个版本的路径是固定的。
  if (fs.existsSync(binary)) {
    let recorded = null;
    try { recorded = fs.readFileSync(stamp, 'utf8').trim(); } catch { /* 没有戳 */ }
    if (recorded === hash) return { ok: true, binary, cached: true };
    // ⚠️ 源码变了 ⟹ 重编到**同一个路径**。用户的授权跟着路径，所以不会丢。
  }

  // ⚠️ 同 audio-source.js：预编译的在就用，不在原样走 swiftc（0.9.75）。
  // ⚠️ 预编译那个也是固定名了（见 scripts/prebuild-helpers.sh）。
  const pre = findPrebuilt(HELPER_NAME);
  if (pre) return { ok: true, binary: pre, cached: true, prebuilt: true };

  fs.mkdirSync(outDir, { recursive: true });
  const result = run('/usr/bin/swiftc', [
    sourcePath, '-o', binary,
    '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos11.0`,
    '-O',
  ], { encoding: 'utf8', timeout: 120000 });

  if (result.error || result.status !== 0) {
    return {
      ok: false,
      // ⚠️ 同 audio-source.js：只加一句提示，不动判断条件（见那边的注释）。
      error: `swiftc 编译鼠标 helper 失败：${(result.stderr || result.error || '').toString().slice(0, 400)}`
        + '\n\n如果是「找不到 swiftc」：在「终端」里跑一次 xcode-select --install，装完重开本应用。',
    };
  }
  // ⚠️ 编完才写戳 —— 编译失败时不能写，否则下次会以为"已经是最新的"
  //   而拿一个旧二进制（或者压根没有）跑。
  try { fs.writeFileSync(stamp, hash); } catch { /* 写不了就下次重编，无害 */ }
  return { ok: true, binary, cached: false };
}

// 把 helper 的状态翻译成人话。
function describeStatus(msg) {
  if (!msg || msg.type !== 'status') return null;
  if (msg.state === 'running') {
    return {
      ok: true,
      // ⚠️ 措辞不能说成"已开/能用" —— 实测过 running 之后照样零事件（没授权）。
      // 说"已启动"而不是"已开"，真的收到事件由上层的 injected 计数来证。
      text: msg.trusted === false
        ? '监听已启动，但没有辅助功能授权 —— 大概收不到事件（要打包成 .app）'
        : (msg.gateOnFinder
          ? '监听已启动（只在桌面被聚焦时转发）'
          : '监听已启动'),
      gateOnFinder: !!msg.gateOnFinder,
      trusted: msg.trusted,
    };
  }
  // ⚠️ 被门挡掉要单独报。上一版就是因为没有这条，
  // 用户看到 "已开 ✅" 而实际一个事件都没进去 —— 白测了一轮。
  if (msg.state === 'gated') {
    return {
      ok: false,
      text: `鼠标事件被"只在桌面被聚焦时"那个门挡住了（已挡 ${msg.blocked} 个，`
        + `当前前台是 ${msg.front}）—— 把那个开关关掉`,
      gated: true, blocked: msg.blocked,
    };
  }
  // ⚠️ 这条是实测逼出来的：监听"建立成功"和"真的在工作"是两件事。
  // helper 报 running（返回非 nil）而回调一次不触发 —— 那时候没有任何错误信号。
  if (msg.state === 'silent') {
    return {
      ok: false, silent: true, trusted: !!msg.trusted,
      text: msg.message || '监听建立了但收不到事件',
      // 没授权的话给出确切的下一步，而不是让用户去猜。
      hint: msg.trusted ? null
        : '开发模式拿不到辅助功能授权（列表里只有 Electron/终端，没有本应用）。'
          + '这一项要打包成 .app 才能验：npm run dist:mac',
    };
  }
  if (msg.state === 'failed') {
    return { ok: false, text: msg.message || '全局鼠标监听建不起来' };
  }
  return { ok: false, text: `未知状态 ${msg.state}` };
}

// ⚠️⚠️ 0.9.86 这里有一套 `axPromptUsed` + `--no-ax-prompt` 的"只弹一次"压制，
//   **0.9.87 全删了**。用户实测那一版仍然反复弹，而他给的方向是对的：
//   「你还不如就逻辑简单一点，初次的时候就问用户要这个辅助功能，然后就不要再弹了」
//
// 根本问题是**位置**：我把"要不要弹框"的判断放进了一个反复重启的进程链里
// （这个 helper 每装载一个壁纸重启一次），压制状态放哪都不对 ——
// 放 helper 里跟着进程死，放这里也只压得住一次启动内。
//
// ⟹ 责任收到主进程：`main.js` 的 `ensureAccessibility()` 启动时查一次、
//   没授权就问一次（标记写进 config 文件）。helper 这边**只做纯查询**。
//   ⟹ 这里不需要传任何授权相关的参数了。
function start({ sourcePath, outDir, gateFinder, onEvent, onStatus,
  spawnFn = spawn, runFn = spawnSync }) {
  const built = ensureHelper(sourcePath, outDir, runFn);
  if (!built.ok) {
    onStatus({ ok: false, text: built.error });
    return null;
  }

  // ⚠️ 默认不传参数就是"不设门" —— 那个默认值我改过一次（见 Swift 那边的注释）。
  const args = gateFinder ? ['--gate-finder'] : [];

  const child = spawnFn(built.binary, args,
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '';

  child.stdout.on('data', (chunk) => {
    const { messages, tail } = parseLines(buffer, String(chunk));
    buffer = tail;
    for (const msg of messages) {
      if (msg.type === 'mouse') onEvent(msg);
      else if (msg.type === 'status') {
        const described = describeStatus(msg);
        if (described) onStatus(described);
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.warn('[mouse helper]', text.slice(0, 300));
  });

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      onStatus({ ok: false, text: `鼠标转发退出（code ${code}）` });
    }
  });

  return {
    binary: built.binary,
    stop: () => { try { child.kill(); } catch { /* 已经死了 */ } },
  };
}

module.exports = {
  parseLines, toWindowPoint, toInputEvent, describeStatus, ensureHelper, start,
};
