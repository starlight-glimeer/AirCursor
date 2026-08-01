#!/usr/bin/env bash
# 从 dmg 装 GestureWall —— **走的就是用户拿到 dmg 之后的那条路**。
#
# ⚠️⚠️ 为什么要有这个脚本（而不是直接拷 dist/mac-arm64/GestureWall.app）：
#
# 用户 2026-08-01：
#   「可是我就是应该验证 dmg 啊，最后别人拿到的也是 dmg，
#     这样才一致性，好测试，好优化啊」
#
# **他是对的。** 我上一版把"直接拷 .app"放成推荐，理由是"不用每次 xattr" ——
# 那是优化**我们的往返成本**，而他要的是**测试有效性**。
#
# ⟹ 跳过 dmg 测出来的「能用」**不保证 dmg 那条路能用**，因为 dmg 有它
# 自己的失败模式：quarantine、符号链接/权限没保住、Gatekeeper 对 dmg 内的
# .app 校验更严、拖拽时拖错地方。
#
# ⚠️ 而这正是这个项目栽过的形状：我曾在 `npm start` 下验鼠标转发，
# 而它**必须打包才能验**（授权按二进制身份给）。
# ⟹ **测的环境和用户的环境不一样，结论就不可信。**
#
# ⟹ 所以这个脚本**不跳过任何一步**：挂载 dmg → 从挂载点拷 → 卸载 → 解隔离。
#   它只是把手动的四步合成一条命令。
set -euo pipefail

cd "$(dirname "$0")/../.."

APP_NAME="GestureWall.app"
DEST="/Applications/$APP_NAME"

# ⚠️⚠️ **`|| true` 不能省** —— `set -euo pipefail` 下：
# `ls` 找不到文件返回非零 ⟹ `pipefail` 让整条管道非零 ⟹ `set -e` **立刻退出**
# ⟹ 下面那个友好的错误信息**永远看不到**，用户只看到"什么都没输出、退出码 2"。
#
# ⚠️ 这个项目为**同一个形状**栽过一次：`fingerprint.sh` 里
# `[ "$dirty" -gt 0 ] && echo …` 在干净工作区时返回 1 ⟹ 整个脚本 exit 1
# ⟹ `npm run sync && npm start` 的 `&&` 阻断后半段，而所有输出都正常。
# ⟹ **工作区越干净越触发**，跟直觉相反。
DMG=$(ls -t dist/*.dmg 2>/dev/null | head -1 || true)
if [ -z "$DMG" ]; then
  echo "❌ dist/ 下没有 .dmg —— 先跑 npm run dist:mac"
  exit 1
fi

echo "dmg: $DMG"
echo "     时间 $(date -r "$DMG" '+%Y-%m-%d %H:%M:%S')"
echo ""

# ⚠️ 旧版本在跑的话，拷进去的文件可能被占用（尤其 helper 二进制）
# ⟹ 症状是"装完还是旧行为"，而那和"改了没生效"分不清。
if pgrep -x GestureWall >/dev/null 2>&1; then
  echo "⚠️ GestureWall 正在运行 —— 先退掉它（⌃⇧Q 或 Dock 右键退出），"
  echo "   否则新文件可能拷不进去，而症状是「装完还是旧行为」。"
  exit 1
fi

# ── 挂载 ────────────────────────────────────────────────────────────────
# ⚠️ 用 -nobrowse：不在 Finder 里弹窗（这是脚本，不该打扰）
# ⚠️ 而挂载点要**从 hdiutil 的输出里取**，不能猜 /Volumes/<名字> ——
# 同名卷已挂载时 macOS 会加后缀（"GestureWall 1"），猜的话就拷错地方了。
echo "① 挂载…"
PLIST=$(hdiutil attach "$DMG" -nobrowse -readonly -plist)
MNT=$(echo "$PLIST" | python3 -c '
import sys, plistlib
d = plistlib.loads(sys.stdin.buffer.read())
for e in d.get("system-entities", []):
    p = e.get("mount-point")
    if p:
        print(p)
        break
')
if [ -z "$MNT" ]; then
  echo "❌ 挂载了但找不到挂载点 —— hdiutil 的输出变了？"
  exit 1
fi
echo "   $MNT"

# ⚠️ 无论后面成功失败都要卸载 —— 留着挂载点会让下次装载遇到同名卷加后缀，
# 而那正是上面那个"不能猜挂载点"的成因。
cleanup() {
  hdiutil detach "$MNT" -quiet 2>/dev/null || true
}
trap cleanup EXIT

if [ ! -d "$MNT/$APP_NAME" ]; then
  echo "❌ dmg 里没有 $APP_NAME —— 里面是：$(ls "$MNT")"
  exit 1
fi

# ── 拷贝 ────────────────────────────────────────────────────────────────
# ⚠️ 先删再拷，不是覆盖 —— `cp -R` 到已存在的 .app 是**合并**：
# 旧版本有而新版本没有的文件会**残留**，而残留的旧 helper 可能被加载
# ⟹ 症状是"改了没生效"。
echo "② 覆盖 ${DEST}（先删旧的 —— cp 到已存在的 .app 是合并，旧文件会残留）"
rm -rf "$DEST"
# ⚠️ 用 ditto 而不是 cp —— 它保留资源分支/扩展属性/符号链接，
# 那是 Apple 自己推荐的拷 .app 的方式（cp -R 在某些情况下会丢 symlink 目标）。
ditto "$MNT/$APP_NAME" "$DEST"

# ── 解隔离 ──────────────────────────────────────────────────────────────
# ⚠️ 这一步**就是用户也要做的那一步**，脚本里做只是省事，没有跳过。
echo "③ 解除 Gatekeeper 隔离"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
# ⚠️⚠️ **只有 quarantine 还在才是问题** —— 别把所有剩余属性都报成"没清干净"。
#
# 我第一版直接打印全部剩余属性，而用户 2026-08-01 看到的是：
#     ③ 解除 Gatekeeper 隔离
#        剩余扩展属性：com.apple.provenance
# ⟹ 读起来像「没清干净」，用户会去想办法清它、或者以为装得有问题。
#
# 而 `com.apple.provenance` 是 macOS 13 起的**来源记录**，和 quarantine
# 不是一回事：
#     quarantine  = 「未验证来源，要拦」⟹ Gatekeeper 会挡
#     provenance  = 「从哪来的」⟹ 纯溯源信息，**不影响能不能打开**
# 而且它是 **SIP 保护的**，`xattr -dr` 删不掉（删了也会被重新加）。
#
# ⟹ 判据只看 quarantine 在不在。其他属性放进"顺带一提"，不当问题报。
REST=$(xattr "${DEST}" 2>/dev/null | tr '\n' ' ' || true)
if echo "${REST}" | grep -q "com.apple.quarantine"; then
  echo "   ⚠️ quarantine 还在（${REST}）—— 打开时会被 Gatekeeper 挡"
  echo "      试手动跑一次：xattr -dr com.apple.quarantine ${DEST}"
elif [ -n "${REST}" ]; then
  # ⚠️ 措辞不能像"有问题" —— 这些属性是正常的
  echo "   ✅ quarantine 已清（还有 $REST —— 那是系统的来源记录，不影响打开）"
else
  echo "   ✅ 干净"
fi

echo ""
echo "✅ 装好了：$DEST"
VER=$(python3 -c '
import plistlib, sys
with open("'"$DEST"'/Contents/Info.plist", "rb") as f:
    d = plistlib.load(f)
print(d.get("CFBundleShortVersionString", "?"))
' 2>/dev/null || echo "?")
echo "   版本 $VER"
echo ""
echo "⚠️ **重新装过之后授权可能要重给** —— 辅助功能/屏幕录制是按二进制路径挂的。"
echo "   症状：鼠标转发不工作（面板会说「零事件」）。"
echo "   ⟹ 系统设置 → 隐私与安全性 → 辅助功能，把 GestureWall 删掉再加回来。"
echo ""
echo "然后：打开 GestureWall，⌃⇧W 开面板"
