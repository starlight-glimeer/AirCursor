// 系统投递层:真的鼠标/键盘事件,以及本地语音识别。
//
// 从 AirCursor 的 electron/main.js 原样抽出来,不是重写 —— 这一层烧掉了四轮 debug,
// 里面每条都是真机才能发现的:
//
//   · helper 二进制路径按**源码 sha256** 命名,不带版本号。macOS 的辅助功能授权是按
//     二进制文件授予的,路径里有版本号 ⟹ 每次发版写出新文件 ⟹ 授权失效 ⟹
//     `CGEvent.post` 被系统**静默丢弃**(不报错/不抛异常/helper 自己都看不到)。
//   · 重编译判据只看 `existsSync`,不比 mtime —— 路径已经编码了内容,而 `git checkout`
//     会重写 mtime,在 git 仓里比 mtime 等于每次切分支都编出一个未授权的新二进制。
//   · Swift 侧 ping/pong 回带 `AXIsProcessTrusted()`:能不能点由**真正发事件的那个进程**
//     回答,不由主进程推断。
//   · 五个静默点(stdio ignore / 无 try-catch / ipcMain 吞异常 / 数"发出"不数"送达" /
//     警告写进被轮询覆盖的字段)叠在一起,让三份真机报告都查不到这条链。
//
// 已在真机验证过:packaged/trusted 双 true、7625 sent、0 failed。
//
// 这个文件由主进程 require,拿到的是一组闭包 —— 它需要主进程给它 `broadcast` 和取
// 配置的能力,所以是工厂函数而不是裸导出。
'use strict';
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
// ⚠️ 打包时预编译的 helper —— 见 prebuilt-helper.js 顶部那段。
const { findPrebuilt } = require("./prebuilt-helper.js");
const { app, systemPreferences } = require('electron');

// 源码位置:打包后在 resources/native/,开发时在仓库的 native/。
function sourcePaths(root) {
  const dir = app.isPackaged ? path.join(process.resourcesPath, 'native') : path.join(root, 'native');
  return {
    pointer: path.join(dir, 'AirCursorPointer.swift'),
    voice: path.join(dir, 'AirCursorVoice.swift'),
    voiceInfo: path.join(dir, 'AirCursorVoiceInfo.plist'),
  };
}

function createSystemBridge({ root, broadcast, onVoiceText }) {
  const helperSource = sourcePaths(root).pointer;
  const voiceSource = sourcePaths(root).voice;
  const voiceInfoSource = sourcePaths(root).voiceInfo;
  let pointerHelper = null;
  let voiceHelper = null;
  let voiceBuffer = '';
  let voiceStatus = '等待';
  let systemCursorHidden = false;
  // ⚠️ 这一行曾经**不在这里** —— 这个文件是从 AirCursor 的 electron/main.js 原样抽出来的,
  // 而 `quitting` 是留在那边的模块级变量 ⟹ `pointerHelper.on('exit')` 里读它抛
  // ReferenceError。
  //
  // 它为什么躲得过所有测试和 `npm start`:那一行**只在 helper 真的退出时**才执行,而
  // helper 退出基本只发生在打包版退出的那一刻。用户真机上看到的就是退出时弹
  // 「Uncaught Exception: ReferenceError: quitting is not defined」。
  //
  // ⚠️ 这个修复做过一次(`55abb70`),又跟着打包配置一起被 revert 掉了 —— 所以这是第二遍。
  let quitting = false;
  let pointerHealth = {
    state: 'starting',
    detail: '尚未启动',
    binary: null,
    compiled: null,
    trusted: null,
    sent: 0,
    failed: 0,
    lastError: null,
    startedAt: null,
    exitedAt: null,
    exits: 0,
  };

  function setPointerHealth(patch) {
    pointerHealth = { ...pointerHealth, ...patch };
    broadcast('pointer-health', pointerHealth);
  }

  // ⚠️⚠️⚠️ **二进制名里不许带 hash**（0.9.89）。用户 2026-08-02，第六轮：
  //
  //   「假如说每次的进程在系统看来都是不一样的程序，那这不就是有问题的吗？
  //     我每次打开都是同一个产品啊…其他摄像头权限查了我一次后面都正常开了」
  //
  // **他说对了，而这是"反复弹框"的真正根因。** 原来叫
  // `AirCursorPointer-${sha256(源码).slice(0,12)}`，而 **TCC 按可执行文件路径
  // 记授权** ⟹ 每改一次源码就是一个新文件名 = 新程序，上次的授权对它不算。
  //
  // ⚠️ 对照用户的打包日志：`GestureWallAudio-0b0001ce0347` 五个版本没变
  //   ⟹ 音乐权限只问一次 ✅；而 Pointer/Mouse 每版都换 ⟹ 每次都问 ❌。
  //   差别不是"辅助功能比麦克风特殊"，是**我改了哪个文件**。
  //
  // ⟹ 路径固定，hash 挪到旁边的 `.hash` 文件（helperUpToDate 读它）。
  function helperBinaryPath(binaryName) {
    return path.join(app.getPath("userData"), binaryName);
  }

  function helperSourceHash(...sources) {
    const hash = crypto.createHash("sha256");
    for (const file of sources) hash.update(fs.readFileSync(file));
    return hash.digest("hex").slice(0, 12);
  }

  // ⚠️ 原来判"要不要重编"靠"那个带 hash 的文件名存不存在"（路径本身编码了源码内容，
  //   所以存在即最新）。名字固定之后那个技巧没了 ⟹ 把 hash 写在旁边的戳文件里。
  //   ⚠️ 不能用 mtime 比较 —— 那会让每次 `git checkout` 都重编，
  //     而那正是这段代码当初 churn 不停的原因（原注释记着这一点）。
  function helperUpToDate(binary, hash) {
    if (!fs.existsSync(binary)) return false;
    try { return fs.readFileSync(`${binary}.hash`, "utf8").trim() === hash; }
    catch { return false; }
  }

  function stampHelper(binary, hash) {
    // ⚠️ 只在编译成功后调 —— 提前写戳会让下次以为"已经最新"而拿旧二进制跑。
    try { fs.writeFileSync(`${binary}.hash`, hash); } catch { /* 下次重编，无害 */ }
  }
  
  function compilePointerHelper() {
    const helperBinary = helperBinaryPath("AirCursorPointer");
    const hash = helperSourceHash(helperSource);
    // ⚠️ 判据从"带 hash 的文件名存不存在"换成"戳文件对不对得上"（0.9.89，
    //   见 helperBinaryPath 上面那段）。等价，而路径从此稳定 ⟹ 授权不会丢。
    if (helperUpToDate(helperBinary, hash)) return { helperBinary, compiled: false };

    // ⚠️⚠️ **先看打包时预编译好的在不在**（0.9.75）——
    // 在就直接用，用户机器上不需要 Xcode 命令行工具。
    // ⚠️⚠️ 不在就**原样往下走**（下面 swiftc 那段一行没改）。
    //   那是有意的：上一轮我为了加一句提示把这个文件里的
    //   `if (result.status !== 0)` 改成 `|| result.error`，
    //   **把手势整个弄坏了**（用户报"摄像头没法正常使用"，只能整版回退）。
    //   ⟹ 这次只加不改。
    // ⚠️ 0.9.89 起直接传裸名 —— 原来是 path.basename(带 hash 的路径)，
    //   而那个 basename 现在恰好也是裸名（能工作），但写死名字更明确：
    //   预编译脚本里就是这个名字，两边对不上的后果是**静默重新编译**。
    const prebuiltPointer = findPrebuilt("AirCursorPointer");
    if (prebuiltPointer) return { helperBinary: prebuiltPointer, compiled: false };

    const result = spawnSync("/usr/bin/swiftc", [helperSource, "-o", helperBinary], {
      encoding: "utf8",
    });
  
    if (result.status !== 0) {
      // ⚠️ 只改消息文本，**判断条件一行没动**（上一轮改它把手势弄坏了）。
      throw new Error((result.stderr?.trim() || "swiftc 编译 AirCursorPointer 失败")
        + "\n\n如果是「找不到 swiftc」：在「终端」里跑一次 xcode-select --install，装完重开本应用。");
    }

    stampHelper(helperBinary, hash);
    return { helperBinary, compiled: true };
  }
  
  function refreshTrustState() {
    if (process.platform !== "darwin") return true;
    const trusted = systemPreferences.isTrustedAccessibilityClient(false);
    if (trusted !== pointerHealth.trusted) {
      setPointerHealth({
        trusted,
        ...(trusted
          ? {}
          // ⚠️ 这句里原来写「重启 AirCursor」—— 0.9.73 改成 GestureWall。
          // 用户装的应用就叫那个，而 AirCursor 是**上游项目**的名字 ——
          // 让他去重启一个不存在的应用是纯误导。
          // ⚠️ 而 `AirCursorPointer` / `AirCursorVoice`（helper 的二进制名）
          //   **不能改** —— 系统授权列表里显示的就是那些，改了用户找不到。
          //   ⟹ 判据：**"对外的称呼"可以改，"系统里的真实标识"不能。**
          : { state: "untrusted", detail: "缺少辅助功能权限：点击不会生效，请在系统设置里勾选后重启 GestureWall" }),
      });
    }
    return trusted;
  }
  
  function startPointerHelper() {
    let helperBinary;
    let compiled;
    try {
      ({ helperBinary, compiled } = compilePointerHelper());
    } catch (error) {
      // Used to throw out of app.whenReady() and leave pointerHelper undefined
      // forever, so every later click threw inside an ipcMain handler where
      // nothing was listening. The UI kept drawing click animations regardless.
      setPointerHealth({
        state: "compile-failed",
        detail: `编译失败：${error.message}`,
        lastError: error.message,
        binary: null,
      });
      return false;
    }
  
    try {
      pointerHelper = spawn(helperBinary, [], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      setPointerHealth({
        state: "spawn-failed",
        detail: `无法启动 helper：${error.message}`,
        lastError: error.message,
        binary: helperBinary,
      });
      return false;
    }
  
    setPointerHealth({
      state: "running",
      detail: compiled ? "helper 已重新编译并启动" : "helper 已启动（复用已授权的二进制）",
      binary: helperBinary,
      compiled,
      lastError: null,
      startedAt: Date.now(),
    });
  
    if (systemCursorHidden) {
      pointerHelper.stdin.write(`${JSON.stringify({ type: "hideCursor" })}\n`);
    }
    // The helper answers a ping with its AXIsProcessTrusted() verdict, so "can we
    // actually click" is a fact from the process that posts the events rather than
    // an inference from this side of the pipe.
    pointerHelper.stdin.write(`${JSON.stringify({ type: "ping" })}\n`);
    pointerHelper.stdout.on("data", (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        const text = line.trim();
        if (!text.startsWith("{")) continue;
        try {
          const message = JSON.parse(text);
          if (message.type === "pong") {
            setPointerHealth({
              trusted: Boolean(message.trusted),
              ...(message.trusted
                ? { state: "running", detail: "helper 正常，已获辅助功能权限" }
                : {
                    state: "untrusted",
                    detail: "helper 在运行，但缺少辅助功能权限：系统会丢弃所有点击事件",
                  }),
            });
          }
        } catch {
          // A malformed line is not worth killing the pipe over.
        }
      }
    });
    pointerHelper.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      setPointerHealth({ lastError: message });
      broadcast('helper-log', { source: 'pointer', message });
    });
    pointerHelper.on("exit", (code, signal) => {
      pointerHelper = null;
      if (quitting) return;
      setPointerHealth({
        state: "exited",
        detail: `helper 退出（code ${code ?? "null"} / signal ${signal ?? "null"}）`,
        exitedAt: Date.now(),
        exits: pointerHealth.exits + 1,
      });
    });
    return true;
  }
  
  function compileSwiftHelper(source, binaryName) {
    const extraInputs = binaryName === "AirCursorVoice" ? [voiceInfoSource] : [];
    const helperBinary = helperBinaryPath(binaryName);
    // ⚠️ 名字固定 + 戳文件判新旧（0.9.89，见 helperBinaryPath 上面那段）。
    //   语音那个的 hash 要连 plist 一起算 —— plist 是链进二进制的（-sectcreate），
    //   改了 plist 而不重编，弹框里的说明就还是旧的。
    const hash = helperSourceHash(source, ...extraInputs);
    if (helperUpToDate(helperBinary, hash)) return helperBinary;

    // ⚠️ 同上：预编译的在就用，不在原样走 swiftc（0.9.75）。
    const prebuilt = findPrebuilt(binaryName);
    if (prebuilt) return prebuilt;
  
    const args = [source, "-o", helperBinary];
    if (binaryName === "AirCursorVoice") {
      args.push("-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", voiceInfoSource);
    }
  
    const result = spawnSync("/usr/bin/swiftc", args, {
      encoding: "utf8",
    });
  
    if (result.status !== 0) {
      // ⚠️ 同上：只改消息。
      throw new Error((result.stderr || `Failed to compile ${binaryName}.`)
        + "\n\n如果是「找不到 swiftc」：在「终端」里跑一次 xcode-select --install，装完重开本应用。");
    }

    stampHelper(helperBinary, hash);
    return helperBinary;
  }
  
  function startVoiceHelper() {
    if (process.platform !== "darwin") return;
  
    let helperBinary;
    try {
      helperBinary = compileSwiftHelper(voiceSource, "AirCursorVoice");
    } catch (error) {
      voiceStatus = `系统语音不可用：${error.message}`;
      broadcast('voice-status', { text: voiceStatus });
      return;
    }
  
    voiceHelper = spawn(helperBinary, [], { stdio: ["ignore", "pipe", "pipe"] });
    voiceHelper.stdout.on("data", (chunk) => {
      voiceBuffer += chunk.toString();
      const lines = voiceBuffer.split(/\r?\n/);
      voiceBuffer = lines.pop() || "";
      for (const line of lines) {
        const phrase = line.trim();
        if (!phrase) continue;
        if (phrase === "__AIRCURSOR_VOICE_READY__") {
          voiceStatus = "macOS 语音已开启";
          broadcast('voice-status', { text: voiceStatus });
        } else if (phrase.startsWith("__AIRCURSOR_VOICE_ERROR__:")) {
          voiceStatus = phrase.replace("__AIRCURSOR_VOICE_ERROR__:", "");
          broadcast('voice-status', { text: voiceStatus });
        } else if (phrase.startsWith("__AIRCURSOR_VOICE_HEARD__:")) {
          const heard = phrase.replace("__AIRCURSOR_VOICE_HEARD__:", "");
          voiceStatus = `听到：${heard}`;
          broadcast('voice-status', { text: voiceStatus });
        } else if (phrase === "__AIRCURSOR_VOICE_TAP__") {
          voiceStatus = "听到：短促确认";
          broadcast('voice-status', { text: voiceStatus });
          if (onVoiceText) onVoiceText('点');
        } else {
          if (onVoiceText) onVoiceText(phrase);
        }
      }
    });
    voiceHelper.stderr.on("data", (chunk) => {
      voiceStatus = chunk.toString().trim();
      broadcast('voice-status', { text: voiceStatus });
    });
    voiceHelper.on("exit", () => {
      voiceHelper = null;
    });
  }
  
  function sendPointer(command) {
    if (!pointerHelper || pointerHelper.killed) {
      if (!startPointerHelper()) {
        pointerHealth.failed += 1;
        return false;
      }
    }
    try {
      pointerHelper.stdin.write(`${JSON.stringify(command)}\n`);
      pointerHealth.sent += 1;
      return true;
    } catch (error) {
      setPointerHealth({
        state: "write-failed",
        detail: `写入 helper 失败：${error.message}`,
        lastError: error.message,
        failed: pointerHealth.failed + 1,
      });
      return false;
    }
  }
  
  function setPointerHealth(patch) {
    pointerHealth = { ...pointerHealth, ...patch };
    broadcast('pointer-health', pointerHealth);
  }

  return {
    // ⚠️⚠️⚠️ **start() 什么都不做了**（0.9.82）。用户 2026-08-01：
    //   「第一次打开的时候，他会弹一个要辅助功能…一开始那个明显是很不需要的，
    //     就问我要了，这应该是不可取的」
    //
    // **他说得对。** 原来这里无条件 `startPointerHelper()`，而那个 helper
    // 一启动就调 `AXIsProcessTrustedWithOptions`（0.9.76 加的，会弹授权框）
    // ⟹ **应用一打开就要辅助功能**，而那时用户什么都没做。
    //
    // ⚠️ 而 pointer helper 是给**手势的鼠标控制**用的 —— 用户没开手势时
    //   它一个事件都不会发。为一个可选功能在启动时要权限是纯副作用。
    //
    // ⚠️⚠️ **而这个错下面那段注释里就写着** —— 语音当初因为"启动时抢麦克风、
    //   把用户正在听的音乐音轨切了"被改成按需，而鼠标 helper 犯的是**同一个错**，
    //   只是它的代价（弹一个授权框）没有音乐被打断那么刺眼，所以一直留着。
    //   ⟹ 判据：**启动时不碰任何需要授权的东西。** 每一条都改成按需。
    //
    // ⚠️ 语音**不在启动时拿**（历史原因，见上）：
    //   用户报告每次打开这个产品，正在听的音乐音轨就变了。推断得对 —— helper
    //   一启动就占用麦克风，而 macOS 上进程抢占音频输入会触发输入设备切换。
    start() {
      // 有意为空 —— 两个 helper 都改成按需了（startPointer / startVoice）。
    },
    // ⚠️ 新增（0.9.82）：手势真的要用鼠标控制时才拉起它。
    startPointer() {
      if (pointerHelper && !pointerHelper.killed) return { ok: true, already: true };
      try {
        startPointerHelper();
        return { ok: true };
      } catch (error) {
        setPointerHealth({ state: 'start-failed', detail: `启动失败:${error.message}`, lastError: error.message });
        return { ok: false, error: error.message };
      }
    },
    startVoice() {
      if (voiceHelper && !voiceHelper.killed) return { ok: true, already: true };
      try {
        startVoiceHelper();
        return { ok: true };
      } catch (error) {
        voiceStatus = `语音启动失败:${error.message}`;
        return { ok: false, reason: error.message };
      }
    },
    stopVoice() {
      if (voiceHelper && !voiceHelper.killed) voiceHelper.kill();
      voiceHelper = null;
      voiceStatus = '已关闭';
      broadcast('voice-status', { text: voiceStatus });
      return { ok: true };
    },
    stop() {
      // ⚠️ 先置位,再 kill。顺序反了 `quitting` 就白设了 —— `kill()` 之后 `exit`
      // 事件随时可能到,而它读的就是这个标志。
      quitting = true;
      if (pointerHelper && !pointerHelper.killed) pointerHelper.kill();
      if (voiceHelper && !voiceHelper.killed) voiceHelper.kill();
    },
    send: sendPointer,
    health: () => ({ ...pointerHealth, trusted: refreshTrustState() }),
    voiceStatus: () => voiceStatus,
    setCursorHidden(hidden) {
      if (systemCursorHidden === hidden) return;
      systemCursorHidden = hidden;
      sendPointer({ type: hidden ? 'hideCursor' : 'showCursor' });
    },
  };
}

module.exports = { createSystemBridge };
