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

  function helperBinaryPath(binaryName, ...sources) {
    const hash = crypto.createHash("sha256");
    for (const file of sources) hash.update(fs.readFileSync(file));
    return path.join(app.getPath("userData"), `${binaryName}-${hash.digest("hex").slice(0, 12)}`);
  }
  
  function compilePointerHelper() {
    const helperBinary = helperBinaryPath("AirCursorPointer", helperSource);
    // Existence is the whole gate: the path already encodes the source contents,
    // so a file at that path cannot be stale. mtime comparison would rebuild on
    // every `git checkout`, which is what made this churn constantly.
    if (fs.existsSync(helperBinary)) return { helperBinary, compiled: false };

    // ⚠️⚠️ **先看打包时预编译好的在不在**（0.9.75）——
    // 在就直接用，用户机器上不需要 Xcode 命令行工具。
    // ⚠️⚠️ 不在就**原样往下走**（下面 swiftc 那段一行没改）。
    //   那是有意的：上一轮我为了加一句提示把这个文件里的
    //   `if (result.status !== 0)` 改成 `|| result.error`，
    //   **把手势整个弄坏了**（用户报"摄像头没法正常使用"，只能整版回退）。
    //   ⟹ 这次只加不改。
    const prebuiltPointer = findPrebuilt(path.basename(helperBinary));
    if (prebuiltPointer) return { helperBinary: prebuiltPointer, compiled: false };

    const result = spawnSync("/usr/bin/swiftc", [helperSource, "-o", helperBinary], {
      encoding: "utf8",
    });
  
    if (result.status !== 0) {
      // ⚠️ 只改消息文本，**判断条件一行没动**（上一轮改它把手势弄坏了）。
      throw new Error((result.stderr?.trim() || "swiftc 编译 AirCursorPointer 失败")
        + "\n\n如果是「找不到 swiftc」：在「终端」里跑一次 xcode-select --install，装完重开本应用。");
    }
  
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
    const helperBinary = helperBinaryPath(binaryName, source, ...extraInputs);
    if (fs.existsSync(helperBinary)) return helperBinary;

    // ⚠️ 同上：预编译的在就用，不在原样走 swiftc（0.9.75）。
    const prebuilt = findPrebuilt(path.basename(helperBinary));
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
    start() {
      try {
        startPointerHelper();
      } catch (error) {
        setPointerHealth({ state: 'start-failed', detail: `启动失败:${error.message}`, lastError: error.message });
      }
      // ⚠️ 语音**不在启动时拿**。
      //
      // 用户报告:每次打开这个产品,正在听的音乐音轨就变了。推断得对 —— helper 一启动就
      // 占用麦克风,而 macOS 上进程抢占音频输入会触发输入设备切换,连带影响正在播放的
      // 音频路由。而语音是个可选功能,为它在启动时无条件抢麦克风是纯粹的副作用。
      //
      // 所以改成按需:用户在面板上打开语音才启动。
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
