#!/usr/bin/env bash
# 一次把"鼠标转发那条链到底断在哪"全部测出来。
#
# ⚠️⚠️ **为什么要有这个脚本**
#
# 用户 2026-08-02：「你不是应该先搞一堆探针探一探我本地这个权限到底怎么搞的？
#   到底有没有打通，然后再做你的设计呢？」
#
# **他说得对，而这是我这十几版的根本毛病** —— 我一直在改代码然后让他重新打包验，
# 每次只能得到一个 yes/no。而这条链有**七个前提**，任何一个断了症状都一样
# （"点了没反应"），于是我在猜哪一个。
#
# ⟹ 一次全测。每一条都是**可观测的事实**，不是推断。
#
# 用法（在仓库根目录）：
#     bash wallpaper/scripts/probe-permissions.sh
#
# ⚠️ 它只读不写：不改配置、不装东西、不动授权。唯一的"副作用"是启动一个 helper
#   跑 6 秒然后杀掉 —— 而那正是要测的东西。
set -uo pipefail          # ⚠️ 不用 -e：某条探针失败要继续往下测，那才是探针的意义

APP="/Applications/GestureWall.app"
HELPERS="$APP/Contents/Resources/prebuilt-helpers"
PASS="✅"; FAIL="❌"; WARN="⚠️ "

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  鼠标转发链探针 —— 七个前提逐个测"
echo "════════════════════════════════════════════════════════════"

# ── ① 装的是哪一版 ──────────────────────────────────────
echo ""
echo "① 装的是哪一版"
if [ -d "$APP" ]; then
  V=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' \
      "$APP/Contents/Info.plist" 2>/dev/null || echo '读不到')
  echo "   $PASS $APP  版本 $V"
  # ⚠️ 仓库里的版本和装的版本要对得上 —— 否则后面全在测旧代码
  REPO_V=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo '?')
  if [ "$V" != "$REPO_V" ]; then
    echo "   ${WARN}仓库是 ${REPO_V}，装的是 ${V} ⟹ **下面测的是旧版本**"
  fi
else
  echo "   $FAIL 没装 —— 先 bash wallpaper/scripts/install-dmg.sh"
  echo "      ⚠️ 后面几条照样往下测（配置、壁纸那些不依赖 .app）"
fi

# ── ② helper 在不在、能不能执行 ──────────────────────────
echo ""
echo "② helper 二进制"
MOUSE="$HELPERS/GestureWallMouse"
if [ -x "$MOUSE" ]; then
  echo "   $PASS $MOUSE"
  echo "      $(shasum -a 256 "$MOUSE" | cut -c1-12)  $(stat -f%z "$MOUSE") 字节"
else
  echo "   $FAIL 不在或不可执行：$MOUSE"
  ls -la "$HELPERS" 2>/dev/null | sed 's/^/      /'
fi

# ── ③ 签名身份（决定 TCC 把它当谁）───────────────────────
echo ""
echo "③ 签名身份 —— 决定 macOS 把它当成"谁"要权限"
codesign -dv "$MOUSE" 2>&1 | grep -E "^(Identifier|Signature|TeamIdentifier)" | sed 's/^/   /'
echo "   ⚠️ Identifier 是它自己的名字（不是 GestureWall）⟹ 授权要单独给它"

# ── ④ TCC 数据库里有没有它 ─────────────────────────────
echo ""
echo "④ 辅助功能授权列表里有没有它（读 TCC 数据库）"
# ⚠️ 这个库默认不给读（需要"完全磁盘访问权限"）—— 读不到不代表没授权，
#   所以下面 ⑥ 那个"让 helper 自己报"才是权威口径。
TCC="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
if sqlite3 "$TCC" "select service,client,auth_value from access
   where service='kTCCServiceAccessibility'" 2>/dev/null | sed 's/^/   /'; then
  :
else
  echo "   $WARN 读不到 TCC 数据库（正常 —— 它要「完全磁盘访问权限」）"
fi
echo "   ⚠️ 系统级的那个库（/Library/…）辅助功能条目在这儿，也可能读不到："
sudo -n sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \
  "select client,auth_value from access where service='kTCCServiceAccessibility'" \
  2>/dev/null | sed 's/^/   /' || echo "   $WARN 读不到（要 sudo，跳过 —— 不影响 ⑥）"

# ── ⑤ helper 直接跑：它自己报授权状态 ───────────────────
echo ""
echo "⑤ helper 自己怎么说（跑 6 秒 —— 这几秒里请动一下鼠标、点几下桌面）"
echo "   ⚠️ 这是**权威口径**：helper 调 AXIsProcessTrusted() 查的是它自己"
# ⚠️ helper 不在就别白等 6 秒（本地验脚本时就是这样）
if [ ! -x "$MOUSE" ]; then
  echo "   $FAIL 跳过 —— ② 已经说了 helper 不在"
  echo ""
  echo "⑥ 那个粒子壁纸靠什么触发流星"
  SKIP_HELPER=1
fi
OUT=$(mktemp)
if [ "${SKIP_HELPER:-0}" != "1" ]; then
"$MOUSE" > "$OUT" 2>&1 &
PID=$!
sleep 6
kill "$PID" 2>/dev/null
wait "$PID" 2>/dev/null

echo ""
echo "   —— helper 的原始输出（前 12 行）——"
head -12 "$OUT" | sed 's/^/   /'

TRUSTED=$(grep -o '"trusted":[a-z]*' "$OUT" | head -1 | cut -d: -f2)
NEVENTS=$(grep -c '"type":"mouse"' "$OUT")
echo ""
echo "   —— 判定 ——"
case "$TRUSTED" in
  true)  echo "   $PASS 辅助功能：**已授权**（helper 自己说的）" ;;
  false) echo "   $FAIL 辅助功能：**未授权** ⟹ 这就是断点" ;;
  *)     echo "   $WARN helper 没报 trusted —— 它可能压根没起来（看上面输出）" ;;
esac
echo "   鼠标事件数：$NEVENTS"
if [ "$NEVENTS" -gt 0 ]; then
  echo "   $PASS **事件抓到了** ⟹ 授权这条线通了，问题在下游（注入/壁纸）"
  echo "   —— 抓到的前 3 个 ——"
  grep '"type":"mouse"' "$OUT" | head -3 | sed 's/^/      /'
else
  echo "   $FAIL 零事件 ⟹ 要么没授权，要么这 6 秒你没动鼠标"
fi
fi
rm -f "$OUT"

# ── ⑥ 那个壁纸听的是什么事件 ────────────────────────────
if [ "${SKIP_HELPER:-0}" != "1" ]; then
echo ""
echo "⑥ 那个粒子壁纸靠什么触发流星"
fi
# ⚠️ 壁纸目录不能只猜默认那个 —— 用户可以换（config.we.wallpaperDir）。
#   ⟹ 先从配置里读，读不到再退回默认。
WP=""
for d in GestureWall aircursor; do
  C="$HOME/Library/Application Support/$d/config.json"
  if [ -f "$C" ]; then
    WP=$(node -e "
      try { const c=require('$C');
        console.log((c.we && c.we.wallpaperDir) || '');
      } catch { console.log(''); }" 2>/dev/null)
    [ -n "$WP" ] && break
  fi
done
[ -z "$WP" ] && WP="$HOME/Documents/GestureWall/Wallpapers"
echo "   壁纸目录：$WP"
FOUND=$(find "$WP" -maxdepth 3 -name "index-*.js" 2>/dev/null | head -8)
if [ -n "$FOUND" ]; then
  for f in $FOUND; do
    if grep -q "triggerMeteorAt" "$f" 2>/dev/null; then
      echo "   $PASS 找到了：$f"
      echo "      触发方式：$(grep -o 'on[A-Za-z]*:[a-zA-Z]*,children' "$f" | head -1)"
      grep -o 'onClick:[a-zA-Z]*' "$f" | head -1 | sed 's/^/      /'
      echo "      ⚠️ 它听的是 **click**，而我们注入的是 mouseDown/mouseUp"
      echo "         ⟹ 靠 Chromium 自己合成 click，那一步没法从这里验"
    fi
  done
else
  echo "   $WARN 没在 $WP 下找到壁纸的 js —— 装载过的壁纸才有"
fi

# ── ⑦ 应用的配置（开关到底开着没有）──────────────────────
echo ""
echo "⑦ 配置里那两个开关"
# ⚠️⚠️ **目录名两个都要试**。`app.getPath('userData')` 用的是 `app.getName()`，
#   而它读打包后 package.json 的 `productName`（GestureWall）—— 但源码里顶层
#   `name` 是 `aircursor`。两者不一致 ⟹ 我**不确定**实际落在哪个目录，
#   而猜错的话这一条会报"没有配置文件"，把一个好的前提说成坏的。
# ⚠️⚠️ **把所有可能的 config.json 全列出来**（0.9.100）。
#   用户那次输出里 ⑦ 说"最后写入 Jul 30"而 ⑧ 说 helper 正在跑 —— 矛盾。
#   而最可能的解释是**存在多个 config.json，应用写的不是我读的那个**
#   （`app.getPath('userData')` 用 `app.getName()`，而源码 name 是 aircursor、
#    productName 是 GestureWall ⟹ 打包版和开发模式可能落在不同目录）。
#   ⟹ 不"挑一个"就完事：全列出来，带时间戳和 dir 值。**刚写的那个才是真的。**
echo "   —— 所有找到的 config.json（时间戳 + dir）——"
FOUND_CFG=0
for d in GestureWall aircursor Electron; do
  C="$HOME/Library/Application Support/$d/config.json"
  if [ -f "$C" ]; then
    FOUND_CFG=1
    TS=$(stat -f '%Sm' "$C" 2>/dev/null || stat -c '%y' "$C" 2>/dev/null)
    DIRV=$(node -e "try{const c=require('$C');console.log((c.we&&c.we.dir)||'null')}catch(e){console.log('读不了')}" 2>/dev/null)
    echo "      $C"
    echo "         写入 $TS   dir=$DIRV"
  fi
done
[ "$FOUND_CFG" = "0" ] && echo "      （一个都没找到）"
# ⚠️ 再兜一层：直接扫整个 Application Support，别赌目录名
echo "   —— 兜底：全盘扫一下（可能有我没想到的目录名）——"
find "$HOME/Library/Application Support" -maxdepth 2 -name config.json \
  -newermt '2026-08-01' 2>/dev/null | head -5 | sed 's/^/      /' \
  || echo "      （扫不到 / find 不支持 -newermt）"

CFG=""
for d in GestureWall aircursor; do
  C="$HOME/Library/Application Support/$d/config.json"
  [ -f "$C" ] && CFG="$C" && break
done
if [ -n "$CFG" ]; then
  echo "   $CFG"
  # ⚠️ 文件的修改时间 —— 判断"应用有没有真的写过它"
  echo "      最后写入：$(stat -f '%Sm' "$CFG" 2>/dev/null || stat -c '%y' "$CFG" 2>/dev/null)"
  node -e "
    const c = require('$CFG');
    const w = c.we || {};
    console.log('      mouseForward        =', w.mouseForward, w.mouseForward ? '✅' : '❌ 关着 ⟹ helper 不会启动');
    console.log('      mouseForwardMigrated=', w.mouseForwardMigrated);
    console.log('      strategy            =', w.strategy, (w.strategy||'desktop')==='desktop' ? '✅' : '❌ 只有 desktop 才转发');
    console.log('      dir（装载的壁纸）   =', w.dir || '(没装载 ⟹ helper 不会启动)');
    console.log('      controlCursor       =', c.controlCursor);
    // ⚠️⚠️ **把 we 那一块的原文打出来**（0.9.99）。
    //   用户 2026-08-02：「什么叫壁纸没装载呀？我就是应用了这个网易云监听里的
    //     效果…然后才点的呀」
    //   **他说得对，而 dir 是空的就是个真 bug**（装载成功了但没记下来）。
    //   ⚠️ 而我上一轮开始靠"哪个函数会清掉它"来猜 —— 那是在读代码猜数据。
    //   ⟹ 直接把文件里的原文打出来：到底有没有这个键、值是什么、
    //     文件什么时候被写的。数据说话，不猜。
    console.log('');
    console.log('      —— config.we 原文（只印相关字段）——');
    console.log('      ' + JSON.stringify({
      dir: w.dir, mouseForward: w.mouseForward, strategy: w.strategy,
      wallpaperDir: w.wallpaperDir, libraryDirs: w.libraryDirs,
    }, null, 2).split('\n').join('\n      '));
  " 2>/dev/null || echo "   $WARN 读不了（json 坏了？）"
else
  echo "   $WARN 两个位置都没有配置文件："
  echo "      ~/Library/Application Support/GestureWall/config.json"
  echo "      ~/Library/Application Support/aircursor/config.json"
  echo "      ⟹ 应用还没跑过，或者目录名和我猜的都不一样。这条列出实际有什么："
  ls -d "$HOME/Library/Application Support/"*ureWall* \
        "$HOME/Library/Application Support/"*ircursor* 2>/dev/null | sed 's/^/      /'
fi

# ── ⑧ 应用**自己**那个 helper 起来了没有 ────────────────
# ⚠️⚠️ 这一条是 0.9.98 加的，因为⑦暴露了一件事：**⑤ 测的是探针自己启动的
#   helper，和应用在跑的那个没关系**。用户 2026-08-02 那次输出里
#   ⑤ 抓到 145 个事件（✅）而⑦说"没装载壁纸"⟹ 应用里那个压根没起来
#   ⟹ 两条加起来才说明"探针通了、应用没通"，而单看⑤会以为一切正常。
echo ""
echo "⑧ 应用**自己**在跑的那个 helper（⑤ 测的是探针启动的，不是这个）"
# ⚠️⚠️ 不能用 `pgrep -fl <词>` —— 它匹配**命令行里含那个词的任何进程**，
#   包括这个探针脚本自己 ⟹ 假阳性（本地实测报"✅ 在跑"，而那是探针自己的 bash）。
#   ⟹ `pgrep -x` 精确匹配**进程名**。
RUNNING=$(pgrep -x GestureWallMouse 2>/dev/null || true)
if [ -n "$RUNNING" ]; then
  echo "   ${PASS}应用的 helper 在跑（pid ${RUNNING}）"
  # ⚠️ 把它的完整路径打出来 —— 要确认是 .app 里那个，不是 userData 下的旧编译产物
  ps -o command= -p "$RUNNING" 2>/dev/null | sed 's/^/      /'
else
  echo "   ${FAIL}应用**没有**在跑 GestureWallMouse"
  echo "      ⟹ 那个 helper 只在**装载了壁纸**时才启动（syncMouseForward 的前提）"
  echo "      ⟹ 看⑦的 dir：是 (没装载) 的话就是这个原因，去点一个壁纸"
fi

echo ""
echo "   —— GestureWall 自己在跑吗 ——"
# ⚠️ 同上：`-x` 精确匹配进程名（主进程就叫 GestureWall）
GW=$(pgrep -x GestureWall 2>/dev/null || true)
if [ -n "$GW" ]; then
  echo "      ${PASS}GestureWall 在跑（pid ${GW}）"
else
  echo "      ${WARN}GestureWall 没在跑 ⟹ ⑦ 读到的配置是上次退出时的状态，"
  echo "         而 ⑧ 当然也是 ❌。⟹ **先打开应用再跑这个探针**"
fi

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  把上面**全部输出**发给我"
echo ""
echo "  ⚠️ 怎么读：⑤ 是"探针自己跑一个 helper"的结果，"
echo "     ⑧ 才是"应用在跑的那个"。⑤✅ 而 ⑧❌ = 链路本身能用、但应用没启动它。"
echo "════════════════════════════════════════════════════════════"
echo ""
