#!/usr/bin/env bash
# 打包成 .app / .dmg，并把 git commit 注入进去。
#
#   npm run dist:mac
#
# 为什么要单独一个脚本而不是直接 electron-builder：
#
# ⚠️ **打包产物里没有 .git** ⟹ 应用自己读不到 commit。而"我跑的是哪个版本"是
# 打包来回测试里最容易搞错、后果最大的一件事 —— 测了旧版本会得出"改了没生效"，
# 然后去查一个已经修好的问题。
#
# ⟹ 打包时把 commit 写进 package.json 的一个字段（打完还原），应用启动时读它。
set -euo pipefail
cd "$(dirname "$0")/../.."

COMMIT=$(git rev-parse --short HEAD)
DIRTY=$(git status --porcelain -- wallpaper/src public package.json | wc -l | tr -d ' ')
VERSION=$(node -e "console.log(require('./package.json').version)")

echo ""
echo "=== 打包 GestureWall ==="
echo "  版本:   v$VERSION"
echo "  commit: $COMMIT"
if [ "$DIRTY" -gt 0 ]; then
  # ⚠️ 有未提交改动时 commit 号会**骗人**：它指向 HEAD，而打进包里的是磁盘上的代码。
  # 这正是"测了旧版本"的另一个来源，所以标出来。
  echo "  ⚠️ 有 $DIRTY 个未提交改动 ⟹ 包里是磁盘代码，不是 $COMMIT"
  COMMIT="$COMMIT+dirty"
fi
echo ""

# 注入 commit：写进 package.json 的 build.extraMetadata，electron-builder 会把它
# 合并进打包后的 package.json。这样应用能读到，而源码里的 package.json 不受影响。
node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.build.extraMetadata = { gwCommit: '$COMMIT' };
fs.writeFileSync('/tmp/gw-pkg-backup.json', JSON.stringify(p, null, 2));
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
"
# 无论成败都还原 package.json —— 那个字段不该进 git。
restore() {
  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    delete p.build.extraMetadata;
    fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
  "
}
trap restore EXIT

npx electron-builder --mac dmg

echo ""
echo "=== 装哪个 ==="
# ⚠️⚠️ **优先用未打包的 .app，跳过 dmg。**
#
# 用户 2026-08-01 问：「xattr -dr com.apple.quarantine 这个我在想是不是
# 我的电脑只要操作过一次就行呢」
#
# **不是** —— `com.apple.quarantine` 是**按文件**的扩展属性，不是
# "这台机器信任这个应用"的记录。谁打的：浏览器下载、AirDrop、
# **以及从挂载的 dmg 里拷文件**。
# ⟹ 每次从 dmg 拖一个新的 .app 出来，那个新文件就带着 quarantine
# ⟹ 上次清的是上次那个 .app，和新的无关。
#
# ⚠️ 但**不经过 dmg 就不会被打** ⟹ electron-builder 同时产出
# `dist/mac-arm64/GestureWall.app`（未打包），直接从那里 cp 就干净。
# ⟹ 那样每次装新版**不用再 xattr**（本地开发的场景）。
#
# ⚠️ dmg 仍然保留 —— 它是给别人的（发给同事/自己另一台机器时要它）。
APP=$(ls -td dist/mac*/GestureWall.app 2>/dev/null | head -1)
DMG=$(ls -t dist/*.dmg 2>/dev/null | head -1)

if [ -z "$APP" ] && [ -z "$DMG" ]; then
  echo "  ❌ dist/ 下既没有 .app 也没有 .dmg —— 打包失败了，往上翻 electron-builder 的输出"
  exit 1
fi

echo ""
echo "--- ① 退掉旧的（如果在跑）：⌃⇧Q ---"
echo "    否则新装的和旧的会抢壁纸层。"
echo ""

if [ -n "$APP" ]; then
  echo "--- ② 装（推荐：直接拷，**不用 xattr**）---"
  echo ""
  echo "  rm -rf /Applications/GestureWall.app && cp -R \"$APP\" /Applications/"
  echo ""
  echo "    时间: $(date -r "$APP" '+%H:%M:%S')"
  echo "    ⚠️ 为什么不用 xattr：quarantine 是**从 dmg 拷出来时**被打上的，"
  echo "       直接 cp 构建产物不经过那一步 ⟹ 没有那个属性。"
  echo ""
fi

if [ -n "$DMG" ]; then
  echo "--- ②' 或者走 dmg（发给别人时用这个）---"
  echo ""
  echo "  open \"$DMG\"      # 拖进「应用程序」"
  echo "  xattr -dr com.apple.quarantine /Applications/GestureWall.app"
  echo ""
  echo "    时间: $(date -r "$DMG" '+%H:%M:%S')"
  echo "    ⚠️ 走 dmg **每次都要** xattr —— 那个属性是按文件打的，"
  echo "       不是「这台机器信任过一次就行」。不做的症状是「打不开」/"
  echo "       「来自身份不明的开发者」，而那看起来像我们的包坏了。"
  echo ""
fi

echo "--- ③ 打开 GestureWall，⌃⇧W 开面板 ---"
echo ""
echo "  ⚠️ **重新装过之后授权可能要重给** —— 辅助功能/屏幕录制是按"
echo "     二进制路径挂的。症状：鼠标转发不工作（面板会说「零事件」）。"
echo "     ⟹ 系统设置 → 隐私与安全性 → 辅助功能，把 GestureWall 删掉再加回来。"
echo ""
