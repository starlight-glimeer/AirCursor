# 从 1024 源图产出 `icon.iconset/`（十档）+ `icon.icns`。
#
# ⚠️⚠️ **0.9.137 之前这一步没有脚本** —— iconset 和 icns 是我当时在终端里
#   临时拼出来的，而 build/README.md 却写着"要改就改脚本重跑"。
#   ⟹ 那句话当时是**假的**：改了 `_icon-build.py` 之后没有任何东西能把它
#     变成 iconset，得靠人记得那串临时命令。
#   ⟹ 判据：**"生成物"要有一条能重跑的路，否则它就是手工产物。**
#     而手工产物的问题不是麻烦，是"下一个人不知道怎么复现"。
#
# 用法（在 wallpaper/build/ 下）：
#   python3 _icon-pack.py            # 用 icon-source-1024.png
#   python3 _icon-pack.py 别的.png    # 指定源图

import os
import struct
import sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
src_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'icon-source-1024.png')
src = Image.open(src_path).convert('RGBA')
if src.size != (1024, 1024):
    src = src.resize((1024, 1024), Image.LANCZOS)

# ⚠️ macOS 的 iconset 命名是**约定死的**（`icon_<w>x<h>[@2x].png`）——
#   写错一个字 `iconutil` 会直接拒绝整个目录。
#   ⚠️ 而 @2x 的像素尺寸是标称值的两倍（`icon_16x16@2x.png` 是 32px）。
SPECS = [
    ('icon_16x16.png', 16),
    ('icon_16x16@2x.png', 32),
    ('icon_32x32.png', 32),
    ('icon_32x32@2x.png', 64),
    ('icon_128x128.png', 128),
    ('icon_128x128@2x.png', 256),
    ('icon_256x256.png', 256),
    ('icon_256x256@2x.png', 512),
    ('icon_512x512.png', 512),
    ('icon_512x512@2x.png', 1024),
]

iconset = os.path.join(HERE, 'icon.iconset')
os.makedirs(iconset, exist_ok=True)
for name, size in SPECS:
    # ⚠️ LANCZOS 而不是默认 —— 图标缩到 16px 时重采样质量是唯一能看出差别的地方
    src.resize((size, size), Image.LANCZOS).save(os.path.join(iconset, name))
print(f'  icon.iconset/  {len(SPECS)} 档')

# ---------------------------------------------------------------------------
# icns（手写容器）
# ---------------------------------------------------------------------------
#
# ⚠️⚠️ 这台机器（Linux）没有 `iconutil` ⟹ 按 icns 容器格式直接拼字节。
#   结构：`icns` magic + 4B 大端总长度 + 若干 `[4B 类型][4B 块长][PNG 载荷]`
#   ⚠️ 块长**含那 8 字节头**自己 —— 漏算的话 Finder 会把整个文件判为损坏。
#
# ⚠️⚠️ 而**"Finder / Dock 认不认"在这台机器上验不了** ——
#   ⟹ `build-mac.sh` 在真机打包时用 Apple 的 `iconutil` 从 iconset
#     **重生成一遍**（见那个脚本里 ICON_OVERRIDE 那段），得到权威产物。
#   ⟹ 这里这个只是兜底（万一真机上没有 iconutil）。
#   ⚠️ 判据：**验不了的产物要有一条"在能验的地方重做"的路**，
#     而不是假装它是对的。
TYPES = [
    (b'icp4', 16), (b'icp5', 32), (b'icp6', 64),
    (b'ic07', 128), (b'ic08', 256), (b'ic09', 512),
    (b'ic10', 1024), (b'ic11', 32), (b'ic12', 64),
    (b'ic13', 256), (b'ic14', 512),
]
blocks = []
for code, size in TYPES:
    import io
    buf = io.BytesIO()
    src.resize((size, size), Image.LANCZOS).save(buf, format='PNG')
    payload = buf.getvalue()
    blocks.append(code + struct.pack('>I', len(payload) + 8) + payload)

body = b''.join(blocks)
icns = b'icns' + struct.pack('>I', len(body) + 8) + body
out = os.path.join(HERE, 'icon.icns')
with open(out, 'wb') as f:
    f.write(icns)
print(f'  icon.icns      {len(icns) // 1024} KB, {len(TYPES)} 块')

# ⚠️ 自校验：每一块都要能解回合法 PNG。
#   ⚠️ 这不能证明 Finder 认它（见上面那段），但能逮住"长度算错"这类硬错误 ——
#     而那是手写二进制最容易犯的。
pos = 8
n = 0
while pos < len(icns):
    code = icns[pos:pos + 4]
    ln = struct.unpack('>I', icns[pos + 4:pos + 8])[0]
    payload = icns[pos + 8:pos + ln]
    assert payload[:8] == b'\x89PNG\r\n\x1a\n', f'{code} 的载荷不是 PNG'
    im = Image.open(io.BytesIO(payload))
    im.load()
    n += 1
    pos += ln
assert pos == len(icns), f'长度不闭合：读到 {pos}，文件 {len(icns)}'
print(f'  ✓ 自校验：{n} 块都能解回合法 PNG，长度闭合')
