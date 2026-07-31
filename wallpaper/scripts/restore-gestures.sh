#!/usr/bin/env bash
# 把手势模块恢复到已知好状态(tag: gesture-ok)。
#
# ⚠️ 只动手势文件。`wallpaper/src/` 里混着三类,整目录 checkout 会冲掉壁纸的工作:
#
#   手势(这个脚本管的)  input sensor recorder overlay overlay-window preview
#                       templates system system-bridge + public 那三个
#   壁纸(不动)          wall wall.html layers nowplaying we-host audio-source
#   两边共有(不动)      main.js dashboard.js dashboard.html preload.js
#
# 共有的那四个真出问题要按段落看 —— 手势那几段的位置记在 aicursor-helper/FROM-LOCAL.md。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

TAG="${1:-gesture-ok}"
git rev-parse "$TAG" >/dev/null 2>&1 || { echo "❌ 找不到 $TAG，先 git fetch --tags"; exit 1; }

FILES=(
  wallpaper/src/input.js
  wallpaper/src/sensor.js
  wallpaper/src/recorder.js
  wallpaper/src/overlay.js
  wallpaper/src/overlay-window.js
  wallpaper/src/preview.js
  wallpaper/src/templates.js
  wallpaper/src/system.js
  wallpaper/src/system-bridge.js
  public/pose.js
  public/motion.js
  public/tracking.js
)

echo "从 $TAG ($(git rev-parse --short "$TAG")) 恢复 ${#FILES[@]} 个手势文件…"
git checkout "$TAG" -- "${FILES[@]}"

echo
echo "重拷 vendor 副本(必须 —— public/ 改了而判定加载的是副本)…"
npm run vendor --silent 2>&1 | tail -2

echo
echo "=== 证明真的回到那个状态 ==="
if git diff "$TAG" --quiet -- "${FILES[@]}"; then
  echo "  ✅ 那 ${#FILES[@]} 个文件和 $TAG 一致"
else
  echo "  ❌ 还有差异:"; git diff "$TAG" --stat -- "${FILES[@]}"
fi
bash "$(dirname "${BASH_SOURCE[0]}")/fingerprint.sh" | grep -A1 '合并指纹'
echo
echo "  ⚠️ 指纹应该是 085ec8857b51。不是的话说明共有文件(main.js/dashboard.*)也变了 ——"
echo "     那几个这个脚本不动,要按段落看。"
echo
echo "  没被动的:$(git status --porcelain -- wallpaper/src public | wc -l | tr -d ' ') 个文件仍有改动(壁纸的工作保住了)"

# ⚠️ 显式成功退出。这是**纯报告脚本**，退出码不该反映最后一条命令的真假 ——
# `grep` 没匹配到、`[ ] && echo` 条件为假，都会让它以非 0 结束。
#
# 实测代价：fingerprint.sh 因为末尾一句 `[ "$dirty" -gt 0 ] && echo …`
# 在干净工作区下返回 1 ⟹ `npm run sync && npm start` 里的 && **阻断了 npm start**。
# 症状是所有输出都正常、然后什么都没发生 —— 看起来像 Electron 起不来。
#
# ⚠️ 这个脚本**有一条真的失败路径**（上面找不到 tag 时 `exit 1`）——
# 那条在这里之前就退出了，所以不冲突。
# ⟹ 但**别把这句 exit 0 往上挪**，否则"tag 找不到"会被报成成功，
# 而这是恢复手势的救命脚本，静默"成功"意味着用户以为手势回来了。
exit 0
