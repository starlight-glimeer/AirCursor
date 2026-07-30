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
// ⚠️ 关键前提：监听**鼠标**事件不需要辅助功能权限（键盘才需要）。
// 所以这条链 npm start 就能验，和 pointer helper 那条（CGEvent.post 要授权）不同。
//
// 解析和坐标换算放在这里且是纯函数 —— 那是这条链里唯一能在云端验的部分。
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
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

  fs.mkdirSync(outDir, { recursive: true });
  const result = run('/usr/bin/swiftc', [
    sourcePath, '-o', binary,
    '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos11.0`,
    '-O',
  ], { encoding: 'utf8', timeout: 120000 });

  if (result.error || result.status !== 0) {
    return {
      ok: false,
      error: `swiftc 编译鼠标 helper 失败：${(result.stderr || result.error || '').toString().slice(0, 400)}`,
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
      text: msg.requireFinder
        ? '鼠标转发已开（只在桌面被聚焦时生效）'
        : '鼠标转发已开（任何时候都转发）',
    };
  }
  if (msg.state === 'failed') {
    // ⚠️ 这条要说清"不是权限问题"，否则用户会去翻辅助功能设置浪费时间 ——
    // 而鼠标监听本来就不需要那个权限。
    return { ok: false, text: msg.message || '全局鼠标监听建不起来（不是权限问题）' };
  }
  return { ok: false, text: `未知状态 ${msg.state}` };
}

function start({ sourcePath, outDir, always, onEvent, onStatus,
  spawnFn = spawn, runFn = spawnSync }) {
  const built = ensureHelper(sourcePath, outDir, runFn);
  if (!built.ok) {
    onStatus({ ok: false, text: built.error });
    return null;
  }

  const child = spawnFn(built.binary, always ? ['--always'] : [],
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
