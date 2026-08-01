exec(open('_icon-curtain.py').read())
import os
from PIL import Image, ImageFilter
CY=(84,232,252)

def build():
    """单条极光帷幕。用户 2026-08-01 定的（icons5/p2 波形 + icons6/d2 亮度）。

    ⚠️ 三条 → 一条：三条时波形是同一曲线平移下来的，看着像等高线；只留一条之后
      左右波峰的高差才立得起来，有形状、有方向。
    ⚠️ **左峰比右峰矮**（.42 vs .32，y 越小越高）—— 用户点名要这个差距。
      对称的波形没有表情，而差 0.06 看不出、差 0.14 已经歪。0.10 是那个甜点。
    ⚠️ 亮度三个杠杆**一起收**（alpha .82→.68 / 亮芯 1.15→.95 / 外发光 .48→.42）。
      只压一个没用：压 alpha 上缘亮芯照样刺眼，只压亮芯身体反而显得比上缘亮。
    """
    P = [(-.06,.64),(.24,.42),(.50,.51),(.76,.32),(1.06,.60)]
    L, _ = curtain(P, .34, CY, 0.68, core=.012, ray=.66, rayseed=5,
                   rayscale=.011, core_boost=0.95)
    art = bg(); acc = Image.new('RGBA',(B,B),(0,0,0,0)); acc.alpha_composite(L)
    halo = acc.filter(ImageFilter.GaussianBlur(.058*B))
    halo.putalpha(halo.getchannel('A').point(lambda v: int(v*.42)))
    art.alpha_composite(halo); art.alpha_composite(acc)
    s = Image.new('RGBA',(B,B),(0,0,0,0)); stars(s,70,3); art.alpha_composite(s)
    return art

OUT=os.environ.get('ICON_OUT','/tmp/icons/icon-1024.png')
finish(build(), OUT)
