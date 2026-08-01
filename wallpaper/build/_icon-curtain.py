exec(open('gen.py').read())
import numpy as np, math, random
from PIL import Image, ImageDraw, ImageFilter
B = BOX
DEEP = ((14,22,42),(4,7,18))

def _path_y(pts, n):
    """Catmull-Rom 插值 → 每一列(x)对应的上缘 y。返回长度 n 的数组（比例坐标）。"""
    ext=[pts[0]]+list(pts)+[pts[-1]]
    xs,ys=[],[]
    segs=len(ext)-3; K=400
    for i in range(segs):
        p0,p1,p2,p3=ext[i],ext[i+1],ext[i+2],ext[i+3]
        for k in range(K):
            t=k/K; t2,t3=t*t,t*t*t
            xs.append(0.5*((2*p1[0])+(-p0[0]+p2[0])*t+(2*p0[0]-5*p1[0]+4*p2[0]-p3[0])*t2+(-p0[0]+3*p1[0]-3*p2[0]+p3[0])*t3))
            ys.append(0.5*((2*p1[1])+(-p0[1]+p2[1])*t+(2*p0[1]-5*p1[1]+4*p2[1]-p3[1])*t2+(-p0[1]+3*p1[1]-3*p2[1]+p3[1])*t3))
    xs,ys=np.array(xs),np.array(ys)
    o=np.argsort(xs)
    return np.interp(np.linspace(0,1,n), xs[o], ys[o])

_RAYCACHE={}
def _raytex(seed, scale):
    """竖向射线噪声（0..1），极光的主纹理。"""
    key=(seed,scale)
    if key in _RAYCACHE: return _RAYCACHE[key]
    rnd=np.random.RandomState(seed)
    k=max(8,int(B*scale))
    base=rnd.rand(k)**1.35
    t=np.interp(np.linspace(0,k-1,B), np.arange(k), base)
    k2=max(4,int(k*0.35)); b2=rnd.rand(k2)
    t=t*0.65+np.interp(np.linspace(0,k2-1,B),np.arange(k2),b2)*0.35
    t=(t-t.min())/(t.max()-t.min()+1e-9)
    _RAYCACHE[key]=t; return t

def curtain(pts, height, color, alpha=1.0, *, up=0.020, core=0.010,
            taper=0.9, ray=0.55, rayseed=7, rayscale=0.016, blur=0.008,
            core_boost=1.0):
    """一片极光帷幕。
      pts    —— 上缘曲线（比例坐标）
      height —— 往下垂落的高度（比例）；下缘指数羽化
      up     —— 上缘往上的溢光（很小，保证上缘锐利）
      core   —— 上缘那道亮芯的宽度
      ray    —— 射线纹理强度
    ⚠️ 关键：**上缘锐、下缘散**。这是极光和"发光的丝带"的全部区别 ——
       丝带上下对称，极光不是。
    """
    n=B
    ytop=_path_y(pts,n)*B
    Y=np.arange(B,dtype=np.float32)[:,None]
    dy=Y-ytop[None,:]
    hpx=height*B; uppx=up*B
    body=np.where(dy>=0, np.exp(-dy/hpx), np.exp(dy/uppx))
    coref=np.exp(-(dy/(core*B))**2)*core_boost
    # 横向包络：两端渐隐
    u=np.linspace(0,1,n)[None,:]
    env=np.sin(np.pi*np.clip(u,0,1))**taper
    # 射线只作用在"身体"上，亮芯不受它影响（否则上缘会被啃出缺口）
    r=_raytex(rayseed,rayscale)[None,:]
    body=body*(1-ray+ray*r)
    m=np.clip((body+coref)*env,0,1)
    mi=Image.fromarray((m*255).astype(np.uint8),'L')
    if blur: mi=mi.filter(ImageFilter.GaussianBlur(blur*B))
    layer=Image.new('RGBA',(B,B),color+(0,))
    layer.putalpha(mi.point(lambda v:int(v*alpha)))
    return layer, mi

def stars(layer,n=70,seed=3,ymax=0.78):
    rnd=random.Random(seed); d=ImageDraw.Draw(layer)
    for _ in range(n):
        x,y=rnd.uniform(0,B),rnd.uniform(0,B*ymax)
        r=rnd.uniform(B*0.0010,B*0.0032); a=rnd.randint(50,175)
        d.ellipse([x-r,y-r,x+r,y+r],fill=(255,255,255,a))

def bg(top=DEEP[0],bot=DEEP[1]): return vgrad(B,top,bot).convert('RGBA')
