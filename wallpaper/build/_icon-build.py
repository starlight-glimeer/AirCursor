# 应用图标的最终构图。
#
# ⚠️⚠️ **0.9.137 起是圆角五角星**（用户 2026-08-02 在 12 个候选里选的 k3）。
#   真正的绘制在 `_icon-star.py`（参数和判据都在那个文件的 docstring 里）。
#
# ⚠️ 而**极光帷幕那版没删** —— 它在 `_icon-curtain.py` 里（`curtain()` 那套还在，
#   星星那版也用它的 `bg()` / `stars()` / `squircle()`）。想换回去：把下面那行
#   `_icon-star.py` 换成一段调 `curtain()` 的 build()，历史版本见 git。
#   ⚠️ 判据：**换设计不删旧实现** —— 用户可能要对比，而重写一遍比留着贵。

exec(open('_icon-curtain.py').read())
exec(open('_icon-star.py').read())

import os
OUT = os.environ.get('ICON_OUT', 'icon-source-1024.png')
finish(build(), OUT)
