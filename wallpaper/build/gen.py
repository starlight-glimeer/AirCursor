from PIL import Image, ImageDraw, ImageFilter
import math

S = 1024          # 最终边长
SS = 4            # 超采样
N = S * SS
PAD = int(N * 0.085)      # macOS 图标：画面四周留白 ~8.5%
BOX = N - 2 * PAD         # squircle 实际边长

_SQ={}
def squircle(size, n=5.0):
    if (size,n) in _SQ: return _SQ[(size,n)]
    """macOS 的圆角不是圆弧，是超椭圆 |x|^n+|y|^n=1（n≈5）。用圆角矩形会明显偏方。"""
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    r = size / 2
    for py in range(size):
        y = (py + 0.5 - r) / r
        t = 1 - abs(y) ** n
        if t <= 0: continue
        x = t ** (1 / n)
        d.line([(r - x * r, py), (r + x * r, py)], fill=255)
    _SQ[(size,n)]=m
    return m

def vgrad(size, top, bot):
    g = Image.new('RGB', (1, size))
    for i in range(size):
        t = i / (size - 1)
        g.putpixel((0, i), tuple(round(top[c] + (bot[c] - top[c]) * t) for c in range(3)))
    return g.resize((size, size), Image.BICUBIC)

def blob(layer, cx, cy, rx, ry, rot, color, blur):
    """一团发光的极光。cx/cy/rx/ry 都是 BOX 的比例。"""
    pad = int(max(rx, ry) * BOX) + blur * 3
    w = h = pad * 2
    t = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(t).ellipse(
        [pad - rx * BOX, pad - ry * BOX, pad + rx * BOX, pad + ry * BOX], fill=color)
    t = t.rotate(rot, resample=Image.BICUBIC, expand=True)
    t = t.filter(ImageFilter.GaussianBlur(blur))
    px, py = int(cx * BOX - t.width / 2), int(cy * BOX - t.height / 2)
    layer.alpha_composite(t, (px, py))

def finish(art, name):
    """art 是 BOX×BOX 的 RGB(A)，套上 squircle + 高光边，输出 1024 png。"""
    canvas = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    mask = squircle(BOX)
    art = art.convert('RGBA'); art.putalpha(mask)
    # 顶部内高光（macOS 图标那道细亮边）
    hl = Image.new('RGBA', (BOX, BOX), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hl)
    hd.line([(BOX * 0.18, BOX * 0.012), (BOX * 0.82, BOX * 0.012)], fill=(255, 255, 255, 70), width=max(2, BOX // 300))
    hl = hl.filter(ImageFilter.GaussianBlur(BOX // 500))
    hl.putalpha(Image.composite(hl.getchannel('A'), Image.new('L', (BOX, BOX), 0), mask))
    art.alpha_composite(hl)
    canvas.alpha_composite(art, (PAD, PAD))
    canvas.resize((S, S), Image.LANCZOS).save(name)
    print(' ', name)
