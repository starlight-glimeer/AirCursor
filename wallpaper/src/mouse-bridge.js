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
    case 'drag':
      return { type: 'mouseMove', x: point.x, y: point.y };
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

// 编译 helper。和音频那个同一套：按源码 hash 命名，源码没变不重编。
function ensureHelper(sourcePath, outDir, run = spawnSync) {
  if (!fs.existsSync(sourcePath)) {
    return { ok: false, error: `鼠标 helper 源码不在：${sourcePath}` };
  }
  const hash = crypto.createHash('sha256')
    .update(fs.readFileSync(sourcePath)).digest('hex').slice(0, 12);
  const binary = path.join(outDir, `GestureWallMouse-${hash}`);
  if (fs.existsSync(binary)) return { ok: true, binary, cached: true };

  // ⚠️ 同 audio-source.js：预编译的在就用，不在原样走 swiftc（0.9.75）。
  const pre = findPrebuilt(`GestureWallMouse-${hash}`);
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
