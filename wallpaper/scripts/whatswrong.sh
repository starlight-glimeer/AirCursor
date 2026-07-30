#!/bin/bash
cd ~/workspace/AirCursor 2>/dev/null || { echo "❌ 仓库路径不对"; exit 1; }

echo "=== ① 仓库在哪个版本 ==="
git log --oneline -1
echo -n "  和 5a3a7c8(你说好用的那版)差异: "
if git diff 5a3a7c8 --quiet -- wallpaper/src public; then echo "✅ 手势代码一致"; else echo "❌ 有差异"; git diff 5a3a7c8 --stat -- wallpaper/src public; fi

echo
echo "=== ② vendor 副本和源头一致吗 ==="
for f in pose.js motion.js tracking.js; do
  diff -q public/$f wallpaper/src/vendor/aircursor/$f >/dev/null 2>&1 \
    && echo "  ✅ $f" || echo "  ❌ $f 不一致 ← 跑 npm run vendor"
done
[ -f wallpaper/src/vendor/mediapipe/hands/hands.js ] && echo "  ✅ MediaPipe 在" || echo "  ❌ MediaPipe 缺 ← 跑 npm run vendor"

echo
echo "=== ③ 有几份配置(这是最可疑的) ==="
ls -d ~/Library/Application\ Support/GestureWall ~/Library/Application\ Support/AirCursor 2>/dev/null
for d in ~/Library/Application\ Support/GestureWall ~/Library/Application\ Support/AirCursor; do
  [ -f "$d/config.json" ] || continue
  echo "  --- $d/config.json  (改于 $(stat -f '%Sm' "$d/config.json")) ---"
  node -e "
    const c=require('$d/config.json');
    const r=c.recorded||{};
    console.log('    录了',Object.keys(r).length,'个手势:',Object.keys(r).join(', ')||'(无)');
    for(const [k,v] of Object.entries(r)) console.log('      '+k+': '+(v.dynamic?'动态':'静态')+' '+v.hands+'手'+(v.keyframeData?' '+v.keyframeData.length+'关键帧':'')+(v.enabled===false?' [已关闭]':''));
    const t=c.gestureTuning||{};
    console.log('    调参: matchThreshold='+t.matchThreshold+' rotationTolerance='+t.rotationTolerance+' modelComplexity='+t.modelComplexity);
    console.log('    手势开关: '+(c.gestures&&c.gestures.enabled));
  " 2>&1 | head -14
done

echo
echo "=== ④ 有没有旧的 app 在抢 ==="
ls -d /Applications/*estureWall*.app /Applications/*irCursor*.app 2>/dev/null || echo "  (没有)"
ps aux | grep -iE 'gesturewall|aircursor' | grep -v grep | awk '{print "  跑着:",$11}' | head -3
