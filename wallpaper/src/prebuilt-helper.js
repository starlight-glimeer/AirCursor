// 打包时预编译的 Swift helper —— 找它们在不在。
//
// ⚠️⚠️ **为什么需要这个**
//
// 四个 helper（音频采集 / 鼠标转发 / 全局鼠标 / 语音）原来是在**用户机器上
// 现场编译**的：我们把 `.swift` 源码放进 .app，运行时调 `/usr/bin/swiftc`。
// 而那个只有装了 **Xcode 命令行工具**（约 1.5 GB）的机器才有 ——
// 普通用户拿到 dmg ⟹ 四个全部编译失败 ⟹ 壁纸不跟音乐动、收不到鼠标点击、
// 语音不可用。而症状是"某个功能没反应"，不是一句清楚的错误。
//
// ⟹ 改成**打包时编译**（`scripts/prebuild-helpers.sh`），把二进制放进
//   `.app/Contents/Resources/prebuilt-helpers/`。
//
// ⚠️⚠️ **这个模块只做"找"，不做"决定"** —— 三处调用方的逻辑是：
//     预编译的在 ⟹ 用它
//     不在       ⟹ **原样走 swiftc 那条路**（一行都没改）
//   那是有意的：swiftc 那条是**一直在工作**的代码，而这次改动的全部风险
//   都在"我动了它"。⟹ 只加不改。
//   （起因：上一轮我为了加一句提示把 `if (result.status !== 0)` 改成
//    `|| result.error`，把手势整个弄坏了，用户报"摄像头没法正常使用"。）
//
// ⚠️ 二进制名必须和运行时算的**一致**：`<HelperName>-<源码 sha256 前 12 位>`。
//   算错的后果不是报错，是**静默地重新编译** ⟹ 回到没有预编译的状态。
//   ⟹ 所以 hash 由调用方传进来（它们各自已经算好了），这里不重复算。

const fs = require('node:fs');
const path = require('node:path');

// ⚠️ `process.resourcesPath` 只在**打包后**存在（指向 .app/Contents/Resources）。
//   开发模式（npm start）下它指向 electron 自己的 Resources ⟹ 那里当然没有
//   我们的东西，函数会返回 null，然后走 swiftc —— 那正是开发时想要的行为
//   （改了 .swift 立刻生效，不用重新打包）。
function prebuiltDir() {
  const base = process.resourcesPath;
  if (!base) return null;
  return path.join(base, 'prebuilt-helpers');
}

// 找预编译好的那个。找到返回绝对路径，没有返回 null。
// ⚠️ 参数就是调用方**已经算好**的二进制文件名（含 hash）——
//   在这里重新算一遍就是第二份知识，而两份必然会漂。
function findPrebuilt(binaryFileName) {
  const dir = prebuiltDir();
  if (!dir) return null;
  const full = path.join(dir, binaryFileName);
  try {
    // ⚠️ 要查**可执行**而不只是存在 —— 打包过程里权限可能丢
    //   （electron-builder 的 extraResources 会保留权限，但那不是我们能控的），
    //   而"文件在但不可执行"的症状是 spawn 抛 EACCES，那看起来像别的问题。
    fs.accessSync(full, fs.constants.X_OK);
    return full;
  } catch {
    return null;
  }
}

const root = typeof globalThis !== 'undefined' ? globalThis : global;
root.GestureWallPrebuilt = { findPrebuilt, prebuiltDir };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { findPrebuilt, prebuiltDir };
}
