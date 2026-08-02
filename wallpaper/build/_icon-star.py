# 圆角五角星 —— 画在左下角，被 squircle 裁掉一部分。
#
# 用户 2026-08-02：「我想改一下图标，画一个五角星，每个角是圆滑的，在左下角，
#   不要完全显示，遮挡一部分，颜色就还和现在的一样」
#
# ⚠️⚠️ **"每个角圆滑"不是给多边形加圆角滤镜** —— 那会把星芒磨钝成一朵花。
#   五角星的形状张力全在**尖角的锐度对比**：外角尖、内谷圆。
#   ⟹ 做法：外顶点用**小半径**圆角（保住尖），内谷用**大半径**（那才是"圆滑"
#     真正看得见的地方）。而实现上靠**二次贝塞尔**逐段过角，不用滤镜。
#
# ⚠️ 而"不要完全显示，遮挡一部分"是这个设计的关键：
#   星星中心放在左下角**画布之外**一点，靠 squircle 的裁剪自然切出弧形边界
#   ⟹ 那比"画一颗完整的星然后盖住一半"好，因为切口跟着图标的圆角走。

import math
from PIL import Image, ImageDraw, ImageFilter

# ⚠️⚠️ 颜色沿用现在那套（用户 2026-08-02 点名"颜色就还和现在的一样"）：
#   底色 = `DEEP`（深蓝黑渐变，来自 _icon-curtain.py）
#   主体 = 这个 `CY`（极光青）—— **和 _icon-build.py 里那个是同一个值**。
#   ⚠️ 在这里再写一遍而不是 import：这些脚本是靠 `exec(open(...).read())` 串起来的
#     （见 _icon-build.py 第一行）⟹ 没有模块边界，而 CY 定义在 _icon-build.py 里
#     ⟹ 单独跑这个文件时拿不到它。
#   ⚠️ 判据：**值重复了就要有守卫盯着别分叉**（见 gating 里那条）。
CY = (84, 232, 252)


def _round_star_path(cx, cy, r_out, r_in, rot, n=5, out_round=0.055, in_round=0.30, steps=14):
    """圆角五角星的轮廓点。

    ⚠️ 半径按**外半径的比例**给（out_round / in_round），不是绝对像素 ——
      那样换尺寸时形状不变（图标要出 16px 到 1024px 十档）。
    ⚠️ `out_round` 远小于 `in_round`：见文件头那段判据。
    """
    # 交替外/内顶点，共 2n 个
    verts = []
    for i in range(2 * n):
        ang = rot + i * math.pi / n
        rad = r_out if i % 2 == 0 else r_in
        verts.append((cx + math.cos(ang) * rad, cy + math.sin(ang) * rad))

    pts = []
    for i, (vx, vy) in enumerate(verts):
        prev = verts[(i - 1) % len(verts)]
        nxt = verts[(i + 1) % len(verts)]
        # 这个顶点是外角还是内谷
        frac = out_round if i % 2 == 0 else in_round
        cut = r_out * frac
        # 从顶点往两条邻边各退 cut，作为圆角的起终点
        d1 = math.hypot(prev[0] - vx, prev[1] - vy)
        d2 = math.hypot(nxt[0] - vx, nxt[1] - vy)
        # ⚠️ 退的距离不能超过边长的一半 —— 否则相邻两个圆角会打穿，
        #   形状变成自交的一团（那种坏法在小尺寸下看起来像噪点）。
        c1 = min(cut, d1 * 0.5)
        c2 = min(cut, d2 * 0.5)
        a = (vx + (prev[0] - vx) * c1 / d1, vy + (prev[1] - vy) * c1 / d1)
        b = (vx + (nxt[0] - vx) * c2 / d2, vy + (nxt[1] - vy) * c2 / d2)
        # 二次贝塞尔：a → 顶点(控制点) → b
        pts.append(a)
        for s in range(1, steps):
            t = s / steps
            u = 1 - t
            pts.append((u * u * a[0] + 2 * u * t * vx + t * t * b[0],
                        u * u * a[1] + 2 * u * t * vy + t * t * b[1]))
        pts.append(b)
    return pts


def build():
    """左下角的圆角五角星（**定稿 k3**，用户 2026-08-02 在 12 个候选里选的）。

    ⚠️⚠️ 参数是**四轮反馈搜出来的**，每一个都别随手改：

    | 参数 | 值 | 用户的原话 / 判据 |
    |---|---|---|
    | `ratio`（内外半径比） | 0.62 | 「都太瘦了，整体应该都是圆润胖乎乎的感觉」
    |                      |      | ⚠️ 这是**胖瘦的主导参数**，不是圆角。
    |                      |      | 几何标准是 0.382（最瘦），0.42 那版被否了。
    | `in_round`（内谷圆角） | 0.50 | 「每个角是圆滑的」—— 圆滑真正看得见的地方是内谷
    | `out_round`（外角圆角）| 0.16 | 同上，但外角不能太圆（会磨成一朵花）
    | `r_f`（外半径）        | 0.48 | 「再大一些」×2 轮（0.30 → 0.40 → 0.48）
    | 中心位置               | (.36,.72) | 「被遮挡的地方少一些」
    |                      |      | ⚠️ **放大之后必须往右上挪** —— 不挪的话星星比
    |                      |      | 画布还宽，左边和下边被整条裁成直边，那看起来
    |                      |      | 像"一块青色的形状"而不是星星（i2 那版被否）。

    ⚠️⚠️ 而这一轮我自己走错过两次，都是**只推一个参数**：
      · 第一次只推"胖"（f1~f4）⟹ 胖了但只露出一两个角、认不出是星星
      · 第二次只推"大"（h2/i2）⟹ 大了但被裁成直边
      ⟹ 判据：**"大小"和"切多少"是两个自由度**（半径 + 中心位置），
        只动一个必然把另一个推到不可接受的地方。
    """
    art = bg()

    # ── 定稿几何
    cx, cy = B * 0.36, B * 0.72
    r_out = B * 0.48
    r_in = r_out * 0.62
    # ⚠️ 一个角朝上偏左一点 —— 正朝上太"标志"，偏一点有姿态
    rot = -math.pi / 2 - 0.18
    poly = _round_star_path(cx, cy, r_out, r_in, rot,
                            out_round=0.16, in_round=0.50)

    # 星体的 mask（硬边）
    body_mask = Image.new('L', (B, B), 0)
    ImageDraw.Draw(body_mask).polygon(poly, fill=255)

    # ⚠️⚠️ **光泽沿着形状做**，不是一团高斯模糊：缩一圈同形状的路径再模糊
    #   ⟹ 那像"面上的光"。第一版用居中的高斯糊，看起来是"糊了一块"（被否）。
    inner = _round_star_path(cx, cy, r_out * 0.70, r_in * 0.70, rot,
                             out_round=0.16, in_round=0.50)
    sheen_mask = Image.new('L', (B, B), 0)
    ImageDraw.Draw(sheen_mask).polygon(inner, fill=255)
    sheen_mask = sheen_mask.filter(ImageFilter.GaussianBlur(B * 0.05))

    # 星体：上亮下暗（和极光的方向一致 —— 光从上面来）
    grad = Image.linear_gradient('L').resize((B, B))
    top = Image.new('RGB', (B, B), tuple(min(255, int(c * 1.18)) for c in CY))
    bot = Image.new('RGB', (B, B), tuple(int(c * 0.72) for c in CY))
    star = Image.composite(bot, top, grad).convert('RGBA')
    star.putalpha(body_mask)

    # 面上的光泽 —— ⚠️ 必须夹在星体内，否则模糊会溢出边界变成一团脏光
    sh = Image.new('RGBA', (B, B), (255, 255, 255, 0))
    sh.putalpha(Image.composite(sheen_mask.point(lambda v: int(v * 70 / 255)),
                                Image.new('L', (B, B), 0), body_mask))
    star.alpha_composite(sh)

    # ⚠️⚠️ 外发光**只在 squircle 内** —— 第一版溢出到圆角外面，
    #   在底边留了一道脏影（那是"图标边缘发灰"的经典成因）。
    halo = star.filter(ImageFilter.GaussianBlur(B * 0.045))
    ha = halo.getchannel('A').point(lambda v: int(v * 0.4))
    halo.putalpha(Image.composite(ha, Image.new('L', (B, B), 0), squircle(B)))
    art.alpha_composite(halo)
    art.alpha_composite(star)

    # ⚠️ 星点保留（极光那版就有）—— 它们让右上那片空底不空。
    s = Image.new('RGBA', (B, B), (0, 0, 0, 0))
    stars(s, 70, 3)
    art.alpha_composite(s)
    return art
