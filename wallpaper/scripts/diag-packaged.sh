#!/bin/bash
# 在 Mac 上跑这个。它只读不写,告诉我们你跑的到底是什么。
echo "=== ① /Applications 里有几个我们的 app ==="
ls -dla /Applications/*estureWall*.app /Applications/*irCursor*.app 2>/dev/null || echo "  (没有)"

echo
echo "=== ② 现在跑着的进程 ==="
ps aux | grep -iE 'gesturewall|aircursor|Electron' | grep -v grep | awk '{print "  "$2"  "$11}' | head

echo
echo "=== ③ 每个 app 的版本和构建时间 ==="
for a in /Applications/*estureWall*.app /Applications/*irCursor*.app; do
  [ -d "$a" ] || continue
  echo "  $a"
  echo "    版本: $(defaults read "$a/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null)"
  echo "    构建于: $(stat -f '%Sm' "$a")"
  [ -f "$a/Contents/Resources/app.asar" ] && echo "    ⚠️ 含 app.asar ⟹ 旧包(新的应该是散文件 app/)"
  [ -d "$a/Contents/Resources/app" ] && echo "    ✅ 散文件 app/ ⟹ 新包"
done

echo
echo "=== ④ dist 里的构建产物 ==="
# ⚠️ 0.9.131 改名。两个目录都看一眼 —— 用户可能还没改目录名。
ls -dla ~/workspace/{DreamPaper,AirCursor}/dist/mac-arm64/*.app 2>/dev/null || echo "  (dist 是空的 —— 还没构建过)"

echo
echo "=== ⑤ 仓库在哪个 commit ==="
cd ~/workspace/DreamPaper 2>/dev/null || cd ~/workspace/AirCursor
git log --oneline -1 && echo "  版本: $(node -e "console.log(require('./package.json').version)")"

# ⚠️ 显式成功退出。这是**纯报告脚本**，退出码不该反映最后一条命令的真假 ——
# `grep` 没匹配到、`[ ] && echo` 条件为假，都会让它以非 0 结束。
#
# 实测代价：fingerprint.sh 因为末尾一句 `[ "$dirty" -gt 0 ] && echo …`
# 在干净工作区下返回 1 ⟹ `npm run sync && npm start` 里的 && **阻断了 npm start**。
# 症状是所有输出都正常、然后什么都没发生 —— 看起来像 Electron 起不来。
exit 0
