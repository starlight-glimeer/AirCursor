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
echo "=== 装 ==="
# ⚠️⚠️⚠️ **走 dmg 是主路径 —— 那是用户拿到的东西。**
#
# 0.9.37 我把"直接拷 .app"放成推荐，理由是"不用每次 xattr"。
# 用户 2026-08-01 否掉了：
#   「可是我就是应该验证 dmg 啊，最后别人拿到的也是 dmg，
#     这样才一致性，好测试，好优化啊」
#
# **他是对的，而我的取舍搞错了优先级**：
#   我优化的是**我们的往返成本**（少敲一条命令）
#   而他要的是**测试有效性**（测的东西和别人拿到的一样）
# ⟹ 两者冲突时测试有效性优先 —— 因为跳过 dmg 测出来的「能用」
#   **不保证 dmg 那条路能用**，而 dmg 有它自己的失败模式：
#     · quarantine（我们知道的那个）
#     · dmg 里的符号链接/权限没保住
#     · Gatekeeper 对 dmg 内的 .app 校验更严
#     · 拖拽时拖到了别处
#
# ⚠️ 而这正是这个项目栽过的形状：我曾在 `npm start` 下验鼠标转发，
# 而它**必须打包才能验**（授权是按二进制身份给的）。
# ⟹ **测的环境和用户的环境不一样，结论就不可信。**
#
# ⟹ dmg 回到主路径。而"每次都要 xattr"那个麻烦用**一条命令**解决
#   （合并三步），不是靠换路径绕开。
# ⚠️⚠️ **`|| true` 不能省** —— `set -euo pipefail` 下 `ls` 找不到文件返回非零，
# `pipefail` 让整条管道非零 ⟹ `set -e` **在赋值后立刻退出**
# ⟹ 下面那句「打包失败了，往上翻 electron-builder 的输出」**永远看不到**，
#    用户只看到"什么都没打印、退出码 2" —— 而那时他最需要那句提示。
#
# ⚠️ 这个项目为同一个形状栽过：`fingerprint.sh` 里
# `[ "$dirty" -gt 0 ] && echo …` 在干净工作区返回 1 ⟹ 整个脚本 exit 1
# ⟹ `npm run sync && npm start` 的 `&&` 阻断后半段（**工作区越干净越触发**）。
DMG=$(ls -t dist/*.dmg 2>/dev/null | head -1 || true)
APP=$(ls -td dist/mac*/GestureWall.app 2>/dev/null | head -1 || true)

if [ -z "$DMG" ]; then
  echo "  ❌ dist/ 下没有 .dmg —— 打包失败了，往上翻 electron-builder 的输出"
  exit 1
fi

echo ""
echo "  $DMG"
echo "  时间: $(date -r "$DMG" '+%H:%M:%S')"
echo ""
echo "--- ① 退掉旧的（如果在跑）：⌃⇧Q ---"
echo "    否则新装的和旧的会抢壁纸层。"
echo ""
echo "--- ② 一条命令装完（挂载 → 覆盖 → 卸载 → 解隔离）---"
echo ""
echo "  bash wallpaper/scripts/install-dmg.sh"
echo ""
echo "    ⚠️ 它走的就是**用户拿到 dmg 之后的那条路** —— 只是把"
echo "       「拖进应用程序 + xattr」自动化了，没有跳过任何一步。"
echo ""
echo "--- ②' 或者手动（和别人拿到的完全一样）---"
echo ""
echo "  open \"$DMG\"          # 拖 GestureWall 进「应用程序」"
echo "  xattr -dr com.apple.quarantine /Applications/GestureWall.app"
echo ""
echo "    ⚠️ xattr 这步**每次都要** —— 那个属性是从 dmg 拷出来时打上的，"
echo "       按文件算，不是「这台机器信任过一次就行」。"
echo "       不做的症状是「打不开」/「来自身份不明的开发者」。"
echo ""

if [ -n "$APP" ]; then
  echo "--- ⚠️ 未打包的 .app 也在（$APP）---"
  echo "    只在「想跳过 dmg 快速看一眼」时用，**不能当验证**："
  echo "    它绕过了 dmg 那条路，而用户拿到的是 dmg。"
  echo ""
fi

echo "--- ③ 打开 GestureWall，⌃⇧W 开面板 ---"
echo ""
echo "  ⚠️ **重新装过之后授权可能要重给** —— 辅助功能/屏幕录制是按"
echo "     二进制路径挂的。症状：鼠标转发不工作（面板会说「零事件」）。"
echo "     ⟹ 系统设置 → 隐私与安全性 → 辅助功能，把 GestureWall 删掉再加回来。"
echo ""
