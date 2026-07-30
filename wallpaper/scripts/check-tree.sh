#!/usr/bin/env bash
# 启动前检查工作区是否干净。
#
# ⚠️ 存在的理由:用户的工作区曾经躺着 25 个来自另一个分支的改动(做壁纸时 checkout 过),
# 而 `npm start` 跑的是**磁盘上的文件**不是 git 里的版本。症状是"手势变慢、骨架往右偏
# (很早修过的 bug 重现)、删掉的界面回来了",而我花了四轮在 git 历史里找 ——
# 因为 `git diff <commit>` 比的是 HEAD,**不含未提交的改动**。
#
# 这个检查只警告不阻塞:未提交的改动本身很正常(正在开发),它要防的是
# "**手势文件被别的分支改过而你不知道**"。
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 0
command -v git >/dev/null 2>&1 || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# 只关心会影响运行行为的文件
dirty=$(git status --porcelain -- wallpaper/src public 2>/dev/null)
[ -z "$dirty" ] && exit 0

count=$(echo "$dirty" | wc -l | tr -d ' ')
echo ""
echo "⚠️  工作区有 $count 个未提交的改动(在 wallpaper/src 或 public 里):"
echo "$dirty" | sed 's/^/     /' | head -12
[ "$count" -gt 12 ] && echo "     …还有 $((count - 12)) 个"
echo ""
echo "   npm start 跑的是**磁盘上的文件**,不是 git 里的版本。"
echo "   如果你在别的分支做过事,这些可能是那个分支的代码 ——"
echo "   那会表现为「版本不对」「修过的 bug 重现」,而 git diff 查不出来。"
echo ""
echo "   要回到干净状态(会保留改动,可以 git stash pop 拿回来):"
echo "     git stash push -m '说清这是什么改动'"
echo ""
echo "   ⚠️ 别用 git checkout . —— 那会直接丢掉,而里面可能是别人几天的工作。"
echo ""
