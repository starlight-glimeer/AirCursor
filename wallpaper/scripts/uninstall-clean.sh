#!/usr/bin/env bash
# 把 GestureWall 从这台机器上**彻底卸掉** —— 像从来没装过一样。
#
# ⚠️⚠️ **为什么需要它**
#
# 测"新用户拿到 dmg 能不能正常用"时，光清授权是不够的 —— 残留分四处，
# 而其中一处会让测试**得不出结论**：
#
#   ① 应用本体           /Applications/GestureWall.app
#   ② 授权记录（TCC）    摄像头 / 辅助功能 / 麦克风 / 屏幕录制
#   ③ ⚠️ **编译缓存**    ~/Library/Application Support/<name>/AirCursorPointer-<hash> …
#      ⟹ 之前编译好的 helper 二进制还在，运行时"文件存在就直接用"
#      ⟹ **"预编译有没有生效"这件事根本测不出来**（它会用缓存的那个）
#   ④ 配置 + 壁纸目录     config.json / ~/Documents/GestureWall/Wallpapers
#
# ⟹ 这个脚本把 ①②③ 全清。④ 里的**壁纸默认保留**（那是用户的东西），
#   要一起清就加 `--all`。
set -euo pipefail

APP="/Applications/GestureWall.app"
# ⚠️ userData 目录名跟 productName 走（electron 的 app.getPath('userData')），
#   而 productName 是 GestureWall ⟹ 目录就叫那个。
SUPPORT="$HOME/Library/Application Support/GestureWall"
# ⚠️ 老版本用过 aircursor 这个名字 ⟹ 一起清（否则"从来没装过"不成立）
SUPPORT_OLD="$HOME/Library/Application Support/aircursor"
CACHE="$HOME/Library/Caches/com.starlightglimeer.aircursor"
PREFS="$HOME/Library/Preferences/com.starlightglimeer.aircursor.plist"
SAVED="$HOME/Library/Saved Application State/com.starlightglimeer.aircursor.savedState"
LOGS="$HOME/Library/Logs/GestureWall"
WALLPAPERS="$HOME/Documents/GestureWall"

ALL=0
[ "${1:-}" = "--all" ] && ALL=1

echo ""
echo "=== 卸掉 GestureWall（像从来没装过）==="
echo ""

# ---------------------------------------------------------------
# 0. 先退掉正在跑的 —— 不退的话删了它还在内存里，而且会重新写配置
# ---------------------------------------------------------------
echo "① 退掉正在跑的进程"
# ⚠️ 三个都要杀：主应用 + 两类 helper（它们是**独立进程**，不会跟着主进程退）
for name in GestureWall AirCursorPointer AirCursorVoice GestureWallMouse GestureWallAudio; do
  # ⚠️ `|| true` —— pkill 找不到进程时退出码非 0，而 set -e 会让脚本停在这
  if pkill -f "$name" 2>/dev/null; then
    echo "   杀掉 $name"
  fi
done
sleep 1

# ---------------------------------------------------------------
# 1. 授权记录
# ---------------------------------------------------------------
echo ""
echo "② 清授权记录（TCC）"
# ⚠️ `tccutil reset All <bundleid>` 是**官方支持**的做法 —— 不用碰 TCC.db
#   （那个被 SIP 保护，sqlite3 读都读不了）。
if tccutil reset All com.starlightglimeer.aircursor 2>/dev/null; then
  echo "   ✓ 清掉 com.starlightglimeer.aircursor 的全部授权"
else
  echo "   ⚠️ tccutil 没清成（可能本来就没有记录）"
fi

# ⚠️⚠️ **但 helper 的授权 tccutil 清不掉** —— 它们是**独立二进制**，
#   不在任何 bundle 里，TCC 按**可执行文件路径**记它们。
#   ⟹ 那些必须手动删（脚本删不了，见最后的提示）。
#   ⚠️ 而删掉 SUPPORT 目录会让那些路径失效 ⟹ 下次编译出**新路径**
#     ⟹ 旧的授权记录变成孤儿（指向一个不存在的文件），
#       macOS 会重新弹框。⟹ 所以第 ③ 步顺带解决了大半。

# ---------------------------------------------------------------
# 2. 应用本体
# ---------------------------------------------------------------
echo ""
echo "③ 删应用和所有缓存"
for p in "$APP" "$SUPPORT" "$SUPPORT_OLD" "$CACHE" "$PREFS" "$SAVED" "$LOGS"; do
  if [ -e "$p" ]; then
    rm -rf "$p"
    echo "   ✓ 删掉 $p"
  fi
done

# ⚠️ 编译缓存单独确认一遍 —— **那是"预编译测不出来"的根源**，
#   漏掉它整个测试就白做。
if [ -d "$SUPPORT" ]; then
  echo "   ❌ $SUPPORT 还在 —— 权限问题？手动删一下"
else
  echo "   ✓ 编译缓存已清（那是「预编译有没有生效」能测出来的前提）"
fi

# ---------------------------------------------------------------
# 3. 壁纸目录（默认保留）
# ---------------------------------------------------------------
echo ""
if [ "$ALL" = "1" ]; then
  if [ -d "$WALLPAPERS" ]; then
    # ⚠️ 用废纸篓而不是 rm —— 那是用户下载的壁纸（可能几百 MB），
    #   而"跑了个脚本壁纸全没了"是不可接受的。
    osascript -e "tell application \"Finder\" to delete POSIX file \"$WALLPAPERS\"" >/dev/null 2>&1 \
      && echo "④ ✓ 壁纸目录已移到废纸篓：$WALLPAPERS" \
      || echo "④ ⚠️ 壁纸目录移不动，手动删：$WALLPAPERS"
  else
    echo "④ 壁纸目录本来就没有"
  fi
else
  if [ -d "$WALLPAPERS" ]; then
    echo "④ 壁纸目录**保留**了：$WALLPAPERS"
    echo "   （要一起清就跑 \`bash $0 --all\` —— 它会移到废纸篓，不是直接删）"
    echo "   ⚠️ 但那样就测不到「首次启动自动建目录 + 放说明文件」那一段"
  fi
fi

# ---------------------------------------------------------------
# 4. 剩下必须手动做的
# ---------------------------------------------------------------
echo ""
echo "=================================================="
echo "⚠️ 还有一件**脚本做不到**的：helper 的授权记录"
echo ""
echo "那四个 helper 是**独立二进制**（不在 bundle 里），"
echo "TCC 按可执行文件路径记它们，而 tccutil 只认 bundle id。"
echo ""
echo "⟹ 打开 系统设置 → 隐私与安全性，逐项检查这四处，"
echo "   看到下面这些名字就选中、点 − 删掉："
echo ""
echo "     辅助功能    ← 最关键，找 AirCursorPointer"
echo "     摄像头      ← 找 GestureWall"
echo "     麦克风"
echo "     屏幕录制"
echo ""
echo "   名字：GestureWall / AirCursorPointer / AirCursorVoice / GestureWallMouse"
echo ""
echo "⚠️ 但上面第 ③ 步删掉了编译缓存 ⟹ 下次编译出的 helper 是**新路径**"
echo "   ⟹ 旧记录变成指向不存在文件的孤儿，macOS 会**重新弹框**。"
echo "   ⟹ 所以就算列表里还剩几个，授权流程仍然会重走一遍。"
echo "=================================================="
echo ""
echo "现在这台机器上和 GestureWall 有关的东西："
# ⚠️ `|| true` —— set -e 下 find/ls 没结果会让脚本退出（这个项目栽过两次）
FOUND=0
for p in "$APP" "$SUPPORT" "$SUPPORT_OLD" "$CACHE" "$PREFS" "$SAVED" "$LOGS"; do
  if [ -e "$p" ]; then echo "  ❌ 还在：$p"; FOUND=1; fi
done
if [ -d "$WALLPAPERS" ]; then
  echo "  · 壁纸目录（有意保留）：$WALLPAPERS"
fi
if [ "$FOUND" = "0" ]; then
  echo "  ✅ 干净了"
fi
echo ""
