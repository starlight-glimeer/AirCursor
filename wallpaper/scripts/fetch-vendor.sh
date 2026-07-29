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

# MediaPipe tasks-vision 的 GestureRecognizer（可选，取不到不影响现有链路）。
#
# 为什么加这个：现在的手势判定是**手写几何**——把 21 个关键点拼成 63 维向量算欧氏距离，
# 小于 0.28 就算命中。它没有"什么叫摊开的手"这种语义，只知道"和存的那 63 个数字差多少"。
# 实测代价：手动着的时候一个 0.28 的球只能停留 89ms，而序列匹配要求依次进入 N 个这样的
# 球 ⟹ 同一个人相邻两秒做同样的动作，10 个关键帧一个都走不到。
#
# GestureRecognizer 在 hand_landmark 之上多一层**分类头**，内置 8 类：
#   None / Closed_Fist / Open_Palm / Pointing_Up / Thumb_Down / Thumb_Up / Victory / ILoveYou
# 其中 Open_Palm 正好是用户报"录得最费劲"的那个双手摊开。它是本地推理、12ms 级、免费，
# 而且输出里**同时带 landmarks** ⟹ 可以整体替代现在的 hands 而不丢任何东西。
#
# ⚠️ 自定义手势仍然要训练（`customGesturesClassifierOptions` 只配置已训练好的分类器的
# 阈值和白名单，它不训练模型），而 Model Maker 官方已标"不再积极维护"。所以这条路的
# 定位是"内置那 8 类用模型、其余继续用尺子"，不是全面替代。
#
# 取不到就跳过：这是旁路，不能让它挡住 npm install。
mkdir -p "$vendor/mediapipe/tasks-vision"
if [ ! -f "$vendor/mediapipe/tasks-vision/vision_bundle.mjs" ]; then
  echo "取 tasks-vision（GestureRecognizer，可选）"
  if curl -fsSL --max-time 120 -o "$vendor/mediapipe/tasks-vision/vision_bundle.mjs" \
      https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.0/vision_bundle.mjs 2>/dev/null; then
    # wasm 和模型也要本地化 —— 运行时联网取会让"没网就不能用手势"，而这是个桌面应用。
    for f in vision_wasm_internal.js vision_wasm_internal.wasm; do
      curl -fsSL --max-time 120 -o "$vendor/mediapipe/tasks-vision/$f" \
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.0/wasm/$f" 2>/dev/null || true
    done
    curl -fsSL --max-time 180 -o "$vendor/mediapipe/tasks-vision/gesture_recognizer.task" \
      https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task 2>/dev/null || true
    echo "  tasks-vision：已取"
  else
    echo "  ⚠️ tasks-vision 取不到（跳过）——「用模型识别手势」那个开关会不可用，其余不受影响"
  fi
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
