// 系统音频源：编译并驱动 Swift helper，把 128 段 FFT 送进 WE 壁纸。
//
// 采集必须在原生侧：Electron 的 desktopCapturer 在 macOS 上不给系统音频
// （`audio: true` 被忽略）。helper 用 ScreenCaptureKit，需要**屏幕录制**权限
// （不是麦克风 —— 抓系统音频在 macOS 上归在屏幕录制下）。
//
// 解析和状态判定放在这里且是纯函数，因为它们是这条链里唯一能在云端验的部分。
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// 网易云音乐的 bundle id。用户明确说音源就是网易云。
//
// ⚠️ macOS 没有"只抓某个 App 的输出"这种通用能力（Windows 有 per-app loopback）。
// ScreenCaptureKit 从 **macOS 14.4** 起支持按应用过滤；更早的系统上 helper 会退回
// 全系统混音并报 warning —— 那时候视频、提示音也会驱动画面。
const NETEASE_BUNDLE = 'com.netease.163music';

// helper 一行一个 JSON。逐行解析而不是等进程结束（它永不结束），
// 也不是攒 buffer 再 JSON.parse（半行会解析失败）。
//
// 纯函数：喂一段 stdout 片段，返回解析出的完整行和剩下的不完整尾巴。
function parseLines(buffer, chunk) {
  const combined = buffer + chunk;
  const parts = combined.split('\n');
  // 最后一段可能是不完整的行，留到下次。
  const tail = parts.pop();
  const messages = [];
  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed));
    } catch {
      // helper 的 stderr 可能混进来，或者 swiftc 的警告。不是致命的，丢掉。
      messages.push({ type: 'garbage', raw: trimmed.slice(0, 200) });
    }
  }
  return { messages, tail };
}

// 把 helper 的状态消息翻译成面板能显示的一行。
//
// ⚠️ 这一层存在的理由：这条链所有失败都是静默的。没授权 → 没数据 → 柱子不动，
// 和"网易云没在放歌"、"这个壁纸不支持音频"完全同一个症状。所以每种状态都要有
// **一句人话**，而不是让用户对着不动的画面猜。
function describeStatus(msg) {
  if (!msg || msg.type !== 'status') return null;
  switch (msg.state) {
    case 'running':
      return {
        ok: true,
        // filtered=false 意味着抓的是全系统混音，别的 App 出声也会驱动画面。
        // 这个区别必须说出来，否则用户会以为"只跟网易云联动"已经生效。
        text: msg.filtered
          ? '正在抓网易云的音频'
          : '正在抓全系统音频（网易云之外的声音也会影响画面）',
        filtered: !!msg.filtered,
      };
    case 'warning':
      return { ok: true, text: msg.message || '有警告', filtered: false };
    case 'denied':
      return {
        ok: false,
        // 权限是最可能的原因，直接把动作写出来。
        text: '拿不到系统音频，去「系统设置 → 隐私与安全性 → 屏幕录制」里勾上本应用',
        detail: msg.message,
      };
    case 'stopped':
      return { ok: false, text: `音频采集停止了：${msg.message || '未知原因'}` };
    case 'error':
      return { ok: false, text: msg.message || '音频采集出错' };
    case 'ok':
      return {
        ok: true,
        text: msg.targetFound ? '探针通过，找到网易云' : '探针通过，但没找到网易云（没开？）',
        targetFound: !!msg.targetFound,
      };
    default:
      return { ok: false, text: `未知状态 ${msg.state}` };
  }
}

// 编译 helper。和 AirCursor 一样按源码内容 hash 命名产物。
//
// ⚠️ hash 命名有个已知的代价：**源码一变，二进制路径就变，而 macOS 的权限授权是
// 按二进制路径记的** —— 也就是改一次 helper 就要重新授权一次。AirCursor 在这上面
// 栽过（笔记里"helper 路径带版本号致授权静默失效"那条）。这里仍然用 hash 是因为
// 替代方案（固定名字）会让旧二进制被静默复用，那更难查。
function ensureHelper(sourcePath, outDir, run = spawnSync) {
  if (!fs.existsSync(sourcePath)) {
    return { ok: false, error: `helper 源码不在：${sourcePath}` };
  }
  const source = fs.readFileSync(sourcePath);
  const hash = require('node:crypto').createHash('sha256')
    .update(source).digest('hex').slice(0, 12);
  const binary = path.join(outDir, `GestureWallAudio-${hash}`);
  if (fs.existsSync(binary)) return { ok: true, binary, cached: true };

  fs.mkdirSync(outDir, { recursive: true });
  const result = run('/usr/bin/swiftc', [
    sourcePath, '-o', binary,
    // ScreenCaptureKit 的 async API 要 macOS 13+；按进程过滤要 14.4+，
    // 但那是运行时判断（helper 里找不到应用会退回全局），不是编译期。
    '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`,
    '-O',
  ], { encoding: 'utf8', timeout: 120000 });

  if (result.error || result.status !== 0) {
    return {
      ok: false,
      error: `swiftc 编译失败：${(result.stderr || result.error || '').toString().slice(0, 400)}`,
    };
  }
  return { ok: true, binary, cached: false };
}

// 启动采集。onFrame 拿 128 段数组，onStatus 拿 describeStatus 的结果。
function start({ sourcePath, outDir, bundle, onFrame, onStatus, spawnFn = spawn, runFn = spawnSync }) {
  const built = ensureHelper(sourcePath, outDir, runFn);
  if (!built.ok) {
    onStatus({ ok: false, text: built.error });
    return null;
  }

  const args = [];
  // bundle 为 null 表示全系统混音。用户要的是网易云，所以默认传 bundle。
  if (bundle) args.push('--bundle', bundle);

  const child = spawnFn(built.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '';

  child.stdout.on('data', (chunk) => {
    const { messages, tail } = parseLines(buffer, String(chunk));
    buffer = tail;
    for (const msg of messages) {
      if (msg.type === 'audio' && Array.isArray(msg.bins)) {
        onFrame(msg.bins);
      } else if (msg.type === 'status') {
        const described = describeStatus(msg);
        if (described) onStatus(described);
      }
    }
  });

  // stderr 不当数据，只在出问题时有用。swiftc 的运行时报错会走这里。
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.warn('[audio helper]', text.slice(0, 300));
  });

  child.on('exit', (code) => {
    // 退出码是 helper 自己定的：2=没权限、3=流被停。
    if (code === 2) {
      onStatus({
        ok: false,
        text: '拿不到系统音频，去「系统设置 → 隐私与安全性 → 屏幕录制」里勾上本应用',
      });
    } else if (code !== 0 && code !== null) {
      onStatus({ ok: false, text: `音频采集退出（code ${code}）` });
    }
  });

  return {
    binary: built.binary,
    stop: () => {
      try { child.kill(); } catch { /* 已经死了 */ }
    },
  };
}

module.exports = { NETEASE_BUNDLE, parseLines, describeStatus, ensureHelper, start };
