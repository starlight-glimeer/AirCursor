#!/usr/bin/env bash
# 打包前把四个 Swift helper 编译好，放进 dist/prebuilt-helpers/。
#
# ⚠️⚠️ **为什么要有这个脚本**
#
# 四个 helper（音频采集 / 鼠标转发 / 全局鼠标 / 语音）原来是在**用户机器上
# 现场编译**的 —— 我们把 `.swift` 源码放进 .app，运行时调 `/usr/bin/swiftc`。
# 而那个只有装了 **Xcode 命令行工具**（约 1.5 GB）的机器才有。
#
# 普通用户拿到 dmg ⟹ 四个 helper 全部编译失败 ⟹
#   · 壁纸不跟音乐动
#   · 壁纸收不到鼠标点击
#   · 语音不可用
# 而症状是"某个功能没反应"，不是一句清楚的错误。
#
# ⟹ 改成**打包时编译**（打包机有 swiftc）。用户机器上再也不需要工具链。
#
# ⚠️⚠️ **二进制名必须和运行时算的一致** —— 那是这个脚本唯一的技术约束：
#   运行时用 `<HelperName>-<源码 sha256 前 12 位>` 命名，而且**文件存在就直接用**
#   （见 system-bridge.js 的 helperBinaryPath / audio-source.js 的 ensureHelper）。
#   ⟹ 我们按同一规则命名，运行时就会直接拿来用、跳过编译。
#   ⚠️ 算错的后果不是报错，是**静默地重新编译**（回到没有这个脚本的状态）——
#     所以下面每一个都打印出算出来的名字，而 gating 测试会核对那个规则没变。
set -euo pipefail

cd "$(dirname "$0")/../.."          # 仓库根
OUT="dist/prebuilt-helpers"

# ⚠️⚠️ **目录必须先建出来**（即使没编译任何东西）——
# `extraResources` 里引用了 `dist/prebuilt-helpers`，而 electron-builder
# 对**不存在的** from 会直接报错 ⟹ 整个打包失败。
# ⟹ 先建空目录。那时 findPrebuilt 找不到东西 ⟹ 运行时原样走 swiftc（正确的兜底）。
mkdir -p "$OUT"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "⚠️  这台机器没有 swiftc（Xcode 命令行工具）—— 跳过预编译。"
  echo "    打出来的包仍然能用，但用户机器上要装 Xcode 命令行工具："
  echo "      xcode-select --install"
  echo "    ⟹ 在有 swiftc 的机器上打包才能免掉这一步。"
  exit 0
fi

ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ]; then TARGET_ARCH="arm64"; else TARGET_ARCH="x86_64"; fi

# hash 的算法要和运行时**逐字节一致** —— 源码的 sha256 前 12 位。
# ⚠️ 用 shasum 而不是 md5：运行时用的是 sha256。
hash_of() {
  shasum -a 256 "$1" | cut -c1-12
}

# $1=源码路径  $2=二进制名  $3=最低系统版本  $4...=额外 swiftc 参数
build_one() {
  local src="$1" name="$2" minos="$3"
  shift 3
  if [ ! -f "$src" ]; then
    echo "⚠️  源码不在，跳过：$src"
    return 0
  fi
  local h out
  h="$(hash_of "$src")"
  out="$OUT/${name}-${h}"
  if [ -f "$out" ]; then
    echo "  ✓ 已有（源码没变）：${name}-${h}"
    return 0
  fi
  echo "  编译 ${name}-${h} …"
  swiftc "$src" -o "$out" \
    -target "${TARGET_ARCH}-apple-macos${minos}" -O "$@"
  echo "  ✓ ${name}-${h}"
}

echo "预编译 Swift helper（${TARGET_ARCH}）"

# ⚠️ 每个的 -target 最低版本要和运行时那份**一致** —— 不一致会让
#   预编译的二进制在某些系统上跑不了，而运行时那份本来可以。
build_one native/AirCursorPointer.swift AirCursorPointer 11.0
build_one wallpaper/native/GestureWallMouse.swift GestureWallMouse 11.0
build_one wallpaper/native/GestureWallAudio.swift GestureWallAudio 13.0

# ⚠️ Voice 那个要把 Info.plist 塞进 __TEXT 段（语音识别的授权说明在里面），
#   而且它的 hash 算的是**两个文件**（源码 + plist）—— 见 helperBinaryPath 的
#   `...sources` 参数。⟹ 这里必须按同样的顺序拼。
if [ -f native/AirCursorVoice.swift ] && [ -f native/AirCursorVoiceInfo.plist ]; then
  VH="$(cat native/AirCursorVoice.swift native/AirCursorVoiceInfo.plist \
        | shasum -a 256 | cut -c1-12)"
  VOUT="$OUT/AirCursorVoice-${VH}"
  if [ -f "$VOUT" ]; then
    echo "  ✓ 已有（源码没变）：AirCursorVoice-${VH}"
  else
    echo "  编译 AirCursorVoice-${VH} …"
    swiftc native/AirCursorVoice.swift -o "$VOUT" \
      -target "${TARGET_ARCH}-apple-macos11.0" -O \
      -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist \
      -Xlinker native/AirCursorVoiceInfo.plist
    echo "  ✓ AirCursorVoice-${VH}"
  fi
fi

echo ""
echo "预编译好的（会被打进 .app 的 Resources/prebuilt-helpers/）："
# ⚠️ `|| true` —— set -e 下 ls 对空目录会让脚本退出（这个项目栽过两次）
ls -1 "$OUT" 2>/dev/null || true
