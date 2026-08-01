exec(open('gen3.py').read())
import os
from PIL import Image, ImageFilter
CY=(84,232,252); BL=(96,158,255)
P1=[(-.06,.56),(.22,.30),(.50,.42),(.78,.22),(1.06,.32)]
P3=[(-.06,.92),(.32,.72),(.62,.80),(.88,.66),(1.06,.72)]
def shift(P,dy): return [(x,y+dy) for x,y in P]

def build():
    """e-拉开层次：上青（高而亮）+ 下蓝（低而沉）。参数就是 icons4/e 那一版。"""
    layers=[
      curtain(shift(P1,.02),.38,CY,1.00,core=.012,ray=.66,rayseed=5,rayscale=.011,core_boost=1.4),
      curtain(P3,.16,BL,0.70,core=.007,ray=.50,rayseed=27,rayscale=.012),
    ]
    art=bg(); acc=Image.new('RGBA',(B,B),(0,0,0,0))
    for L,_ in layers: acc.alpha_composite(L)
    halo=acc.filter(ImageFilter.GaussianBlur(.058*B))
    halo.putalpha(halo.getchannel('A').point(lambda v:int(v*.55)))
    art.alpha_composite(halo); art.alpha_composite(acc)
    s=Image.new('RGBA',(B,B),(0,0,0,0)); stars(s,70,3); art.alpha_composite(s)
    return art

OUT=os.environ.get('ICON_OUT','/tmp/icons/icon-1024.png')
finish(build(), OUT)
