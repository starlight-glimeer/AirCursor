#!/usr/bin/env bash
# 给"实际会被执行的代码"算一个指纹。
#
# ⚠️ 存在的理由:云端 agent 看得到的是它自己那份仓库,而用户跑的是他机器上的文件。
# 两者可能因为**未提交的改动**、**vendor 副本过期**、**分支切换残留**而不同 ——
# 而所有基于 git 的比对都查不出前两种(git diff 比的是 HEAD,vendor 不在 git 里)。
#
# 这个脚本算的是**磁盘上真实内容**的哈希,所以它能发现那三类的任意一种。
# 用法:两边都跑,对比输出的那一行 FINGERPRINT。
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

# 会影响手势行为的文件。顺序固定,否则哈希不可比。
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
  wallpaper/src/main.js
  wallpaper/src/dashboard.js
  wallpaper/src/dashboard.html
  wallpaper/src/overlay.html
  wallpaper/src/preload.js
  public/pose.js
  public/motion.js
  public/tracking.js
  # ⚠️ vendor 副本也要:它不在 git 里,而判定实际加载的是它
  wallpaper/src/vendor/aircursor/pose.js
  wallpaper/src/vendor/aircursor/motion.js
  wallpaper/src/vendor/aircursor/tracking.js
)

hash_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" 2>/dev/null | cut -c1-8
  else sha256sum "$1" 2>/dev/null | cut -c1-8; fi
}

echo "=== 逐文件指纹 ==="
missing=0
for f in "${FILES[@]}"; do
  if [ -f "$f" ]; then printf "  %s  %s\n" "$(hash_of "$f")" "$f"
  else printf "  %-8s  %s  ⚠️ 不存在\n" "MISSING" "$f"; missing=$((missing+1)); fi
done

echo
echo "=== 合并指纹(对比这一行就够) ==="
combined=$(for f in "${FILES[@]}"; do hash_of "$f" 2>/dev/null || echo MISSING; done | tr -d '\n')
if command -v shasum >/dev/null 2>&1; then
  final=$(printf '%s' "$combined" | shasum -a 256 | cut -c1-12)
else
  final=$(printf '%s' "$combined" | sha256sum | cut -c1-12)
fi
echo "  FINGERPRINT: $final"
[ "$missing" -gt 0 ] && echo "  ⚠️ 有 $missing 个文件不存在 —— 先跑 npm run vendor"

echo
echo "=== 上下文 ==="
echo "  HEAD:   $(git rev-parse --short HEAD 2>/dev/null)"
echo "  分支:   $(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
dirty=$(git status --porcelain -- wallpaper/src public 2>/dev/null | wc -l | tr -d ' ')
echo "  未提交: $dirty 个(在 wallpaper/src 或 public)"
[ "$dirty" -gt 0 ] && echo "  ⚠️ 有未提交改动 ⟹ 指纹反映的是磁盘,不是 HEAD"
