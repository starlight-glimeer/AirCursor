#!/usr/bin/env bash
# 取第三方前端库到 src/vendor/。
#
# 为什么不进 git：three.js 加 MediaPipe 一共约 24MB，而同一份 MediaPipe 已经躺在
# AirCursor 仓库里了。把它再提交一遍等于让每个 clone 都多下 24MB 二进制，而且两份
# 会各自漂移。
#
# 优先从本机已有的 AirCursor 拷（离线可用、字节相同），找不到再从 CDN 下。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
vendor="$here/src/vendor"
mkdir -p "$vendor/mediapipe/hands" "$vendor/mediapipe/camera_utils"

# 依次找 AirCursor 可能在的位置。它和本项目是同一个产品的两部分。
#
# `$here/..` 那条是最常命中的：这个项目作为 wallpaper/ 子目录放在 AirCursor 仓库里，
# 所以上一级目录**就是** AirCursor 根目录。第一版漏了这条，在真实布局下反而找不到。
aircursor=""
for candidate in \
  "${AIRCURSOR_REPO:-}" \
  "$here/.." \
  "$here/../AirCursor" \
  "$HOME/workspace/AirCursor" \
  "$HOME/hackathon/AirCursor"
do
  if [ -n "$candidate" ] && [ -d "$candidate/public/vendor/mediapipe/hands" ]; then
    aircursor="$candidate"
    break
  fi
done

if [ -n "$aircursor" ]; then
  echo "从 AirCursor 拷贝：$aircursor"
  cp -R "$aircursor/public/vendor/mediapipe/hands/." "$vendor/mediapipe/hands/"
  cp -R "$aircursor/public/vendor/mediapipe/camera_utils/." "$vendor/mediapipe/camera_utils/"
  if [ -f "$aircursor/public/vendor/three.r128.min.js" ]; then
    cp "$aircursor/public/vendor/three.r128.min.js" "$vendor/"
  fi

  # AirCursor 的手势判定：pose.js / motion.js / tracking.js。
  #
  # 拷贝而不是从 ../public/ 直接引用，有两个理由：①  引用会让壁纸依赖仓库目录结构，
  # 那是脆的；② 这三个文件是另一个 agent 维护的，拷贝一份意味着**我这边永远不改它们**
  # —— 要改就得改源头，两边不会悄悄分叉。
  #
  # 拷不到就是硬失败：One Euro 平滑和挥动判定是壁纸手感的核心，没有它们不如不跑。
  mkdir -p "$vendor/aircursor"
  for f in pose.js motion.js tracking.js; do
    if [ -f "$aircursor/public/$f" ]; then
      cp "$aircursor/public/$f" "$vendor/aircursor/$f"
    else
      echo "❌ 找不到 $aircursor/public/$f —— 手势判定拿不到，手感会退化"
      exit 1
    fi
  done
  echo "手势判定：已取 pose.js / motion.js / tracking.js"
else
  echo "找不到 AirCursor，从 CDN 下载（需要联网）"
  echo "  提示：也可以用 AIRCURSOR_REPO=<路径> 指定"
  curl -fsSL -o "$vendor/mediapipe/hands/hands.js" \
    https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/hands.js
  curl -fsSL -o "$vendor/mediapipe/camera_utils/camera_utils.js" \
    https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@0.3.1675466862/camera_utils.js
  # hands.js 运行时还会自己去取 .wasm / .data / .tflite，所以只下这两个不够 ——
  # 剩下的靠 locateFile 落回 CDN。这条路能跑但要联网，不如从 AirCursor 拷。
  echo "  ⚠️ CDN 路线只下了 js，模型文件会在运行时联网取"
  echo "  ⚠️ 手势判定（pose/motion/tracking）只在 AirCursor 仓库里，CDN 拿不到"
  echo "     → 手势会不可用。用 AIRCURSOR_REPO=<路径> 指定仓库位置。"
fi

# three.js 是 MIT，独立取。
if [ ! -f "$vendor/three.r128.min.js" ]; then
  echo "下载 three.js r128"
  curl -fsSL -o "$vendor/three.r128.min.js" \
    https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js
fi

echo
echo "vendor 就绪："
du -sh "$vendor" 2>/dev/null || true
ls "$vendor"
