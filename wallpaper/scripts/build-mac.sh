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
echo "=== 装哪个包 ==="
# ⚠️ 按修改时间取最新，而不是按名字 —— 同一版本号会覆盖，名字看不出新旧。
DMG=$(ls -t dist/*.dmg 2>/dev/null | head -1)
if [ -z "$DMG" ]; then
  echo "  ❌ dist/ 下没有 .dmg —— 打包失败了，往上翻 electron-builder 的输出"
  exit 1
fi
echo "  $DMG"
echo "  时间: $(date -r "$DMG" '+%H:%M:%S')"
echo ""
echo "  open \"$DMG\""
echo ""
echo "--- 装的步骤（未签名应用，前两步是必须的）---"
echo ""
echo "  ① 退掉旧的（如果在跑）：⌃⇧Q"
echo "     否则新装的和旧的会抢壁纸层。"
echo ""
echo "  ② open \"$DMG\" → 把 GestureWall 拖进「应用程序」"
echo ""
echo "  ③ 解除 Gatekeeper 隔离（**未签名应用必须这一步**）："
echo "     xattr -dr com.apple.quarantine /Applications/GestureWall.app"
echo ""
echo "     ⚠️ 不做这步的症状是"打不开 / 提示来自身份不明的开发者"，"
echo "     而那看起来像我们的包坏了。也可以右键→打开，但命令更省事。"
echo ""
echo "  ④ 打开 GestureWall，⌃⇧W 开面板"
echo ""
echo "--- 两个已知的"看起来像 bug"其实不是 ---"
echo ""
echo "  ⚠️ 每次重装后**可能要重新勾一次辅助功能** —— 未签名应用的主二进制"
echo "     每次都变，macOS 按二进制记授权。"这次又要我勾"不是代码 bug。"
echo ""
echo "  ⚠️ 权限表现不如正式签名应用稳定（原型阶段可接受）。"
echo ""
echo "⚠️ 装好后**核对面板顶部的 build 标识**：应该是 v$VERSION $COMMIT 打包版"
echo "   对不上就是装成旧包了 —— 那会让你测出"改了没生效"的假结论。"
echo ""
exit 0
