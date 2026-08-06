# scene 类壁纸渲染器：格式规格 + 已知缺口

> 目标：**mac 上通用兼容 Steam 创意工坊的 Wallpaper Engine 壁纸。**
> 用户 2026-08-04 定的原则：「渲染器开发，不是适配壁纸本身，要通用」
> 「只要有那个效果，我们就要做，这才是逆向还原渲染器的做法」

**这份文档是给接手的人（人或 agent）看的。** 它只写**实测坐实**的东西 ——
每条结论后面标了它是从哪些样本量出来的，以及"错了会怎样"。

---

## 0. 先读这三条

### ⚠️ 一、WE 的 scene 格式**没有任何公开规范**

所有结论来自实测 9 张真实工坊壁纸（232 张 `.tex` / 1000+ 对象）。
⟹ 判据：**改这一层之前先跑审计脚本**，别信直觉：

```bash
node wallpaper/scripts/scene-audit.js ~/Documents/DreamPaper/Wallpapers
```

它会摊开每张壁纸的格式形状，并**按"影响多少张壁纸"排序**列出缺口。

### ⚠️⚠️ 二、`.tex` 头部的字段**会说谎**

`format` 字段声明 DXT3 的 178 张贴图里，实际是
**DXT3/5 ×96 · R8 ×28 · RGBA8888 ×22 · DXT1 ×8 · RG88 ×6**。

⟹ 判据：**声明是声明，事实是长度和 flags。**（详见第 2 节）

### ⚠️⚠️⚠️ 三、真值就在输入里

每张壁纸都带 `preview.gif` —— **那是作者在 WE 里渲染的标准答案**。

```bash
node wallpaper/scripts/scene-preview-diff.js ~/Documents/DreamPaper/Wallpapers
```

而 app 里有「和作者的 preview 对照」按钮（设置 → 开发者选项），
它截我们 5 帧 + 抽 preview 8 帧，**同一套指标**逐项列差值。

⟹ 判据：**不确定的时候先找真值，而真值往往已经在输入里。**
（我前 8 轮的 bug 全靠用户看一眼说"哪里不对"发现，而那些**每一个都能量出来**。）

---

## 1. 三层结构

| 层 | 文件 | 性质 |
|---|---|---|
| **解析** | `src/scene-pkg.js` | **纯函数**（不引 fs）⟹ 云端可测，89 项守卫 |
| **装载** | `src/main.js` `sendSceneData` | 解包 → 解码 → 按需送（**只读**壁纸目录） |
| **渲染** | `src/scene.html` + `src/scene-render.js` | three.js 正交相机 + 图层/文字/音频柱 |

⚠️ 为什么解析在主进程：`scene.pkg` 是 11-123MB，而渲染进程是 `sandbox: true`（读不了文件）。
⚠️⚠️ 而**不整包送** —— 120MB 塞进 IPC 会把 Electron 卡死 ⟹ 只送用到的那些。

### 装载路径（三条渲染路径之一）

```
web   → 直接 loadURL 那个 HTML（壁纸自己是个网页）
video → 我们的 video.html + 一个 <video>
scene → 我们的 scene.html + 主进程解好的场景数据（IPC）
```

⚠️ **scene 也要走 `preload.js`** —— `WE.isMediaType('scene')` 是 `false`
（它只认 video/gif），光靠那个判断会给 scene 挂 `we-preload.js`，
而那里面没有 `onSceneData` ⟹ 数据永远送不到，**画面全黑且零报错**。

---

## 2. 归档 / 纹理格式（全部实测）

### PKGV 归档

```
[4B 长度][版本串 "PKGV0022"]      ⚠️ 长度是 8，串不带 \0
[4B 条目数]
条目 × N：[4B 名长][名][4B 偏移][4B 长度]
[数据区]                          ⚠️⚠️ 偏移**相对数据区起点**，不是文件头
```

实测版本：`PKGV0021 / 0022 / 0023 / 0024`。
⚠️ **不认识的版本不拒绝**，只警告 —— 布局一致的话照样能读。

### `.tex` 头部

```
[裸串 "TEXV0005"][\0]            ⚠️⚠️ 裸串 + \0，**不带长度前缀**（和 PKGV 不一样！）
[裸串 "TEXI0001"][\0]
[4B flags][4B format]
[4B texW][4B texH]               纹理尺寸（2 的幂）
[4B imgW][4B imgH]               图像尺寸（真实内容）
[4B ?]                           实测像主色
[TEXB 块]
```

### TEXB 块（像素数据在这里）

```
[裸串 "TEXB0003"][\0]            ⚠️ 也有 TEXB0004（多一个字段，实测值 0）
[4B imageCount]                  实测都是 1
每个 image：
  [4B freeImageFormat]           ⚠️⚠️ **判别键**：13=PNG / 2=JPEG / 0xFFFFFFFF=无容器
  [4B ?]                         ⚠️ 只有 TEXB0004 有
  [4B mipCount]                  实测 1 / 4 / 5
  每个 mip：
    [4B w][4B h][4B isLZ4][4B uncompressedLen][4B compressedLen][数据]
    ⚠️ PNG/JPEG 的 uncompressedLen 是 **0**
[可选 TEXS 块]                   序列帧（sprite sheet）
```

⚠️ 我们只要 **mip 0**（壁纸铺满屏幕，用不上小 mip）。

### ⚠️⚠️⚠️ 像素格式由 `flags` 定，不是 `format`

| flags | 真实像素格式 |
|---|---|
| 0 | RGBA8888 |
| 4 | DXT3/5 |
| 7 | DXT1 |
| 8 | RG88 |
| 9 | R8 |

**这张表是怎么定下来的**（方法比结论重要）：

1. 先用**长度**反推候选：`len == ceil(w/4)·ceil(h/4)·16` ⟹ DXT3/5，`len == w·h·4` ⟹ RGBA8888…
2. **只取唯一匹配的 80 张**来学 `flags → 格式`；有歧义的 92 张不参与
   （w/h 都是 4 的倍数时 DXT3/5 和 R8 长度相同）
3. 学出来的表核**全部 172 张** ⟹ **一致 172、冲突 0**

⟹ 判据：**先用无歧义的样本学规则，再用规则解释有歧义的。**
反过来（拿有歧义的去学）会把两种格式混成一个。

⚠️ 冲突时**以长度为准**（长度是事实，字段是声明），并标出来。

### ⚠️⚠️ 16 字节的块一律按 **DXT5** 解

DXT3/DXT5 块大小相同（16B）⟹ 长度分不出，而 `format` 说 DXT3。

**判别方法**：同一份数据两种解法，量**块内行周期性** ——
真 DXT5 当 DXT3 解会把 a0/a1 端点当成前 4 个像素的 4bit alpha
⟹ 每个 4×4 块第 0 行和第 2 行的 alpha 统计上差很远。

实测 61 张：DXT3 解的行周期差 **79-108**，DXT5 解只有 **0-56**（差一个数量级）⟹ 全部是 DXT5。
交叉验证：一张纯不透明背景按 DXT5 解是 100% alpha=255，按 DXT3 解出来是 12.5% 的周期图案。

⚠️ 错了的症状很隐蔽：**画面蒙一层细密横纹**，看起来像"贴图本来就有质感"。

### `format = 34` 是 **MP4 视频**

数据以 ISO BMFF 的 `ftyp` box 开头。那是 WE 的"视频纹理"（一个图层的内容是一段视频）。
实测 6 张。⟹ 渲染层走 `THREE.VideoTexture` + `<video muted autoplay loop>`。

### 232 张贴图的实测分布

```
DXT3/5+LZ4 ×74   PNG ×52   R8+LZ4 ×50   RGBA8888+LZ4 ×20
RGBA8888 ×8   DXT1+LZ4 ×8   RG88+LZ4 ×6   MP4 ×6   R8 ×4   JPEG ×2   DXT3/5 ×2
```

⟹ **只支持 PNG/JPEG 等于放弃 3/4 的贴图**（0.9.159 就是那样，
所以有几张壁纸只画出一两个图层）。

### DXT 解码的五个坑（都对着手算的值验过）

- **565→888 要按比例扩**（`<<3` 会让纯白变 248,252,248 ⟹ 整体偏暗）
- **DXT1 的 `c0 <= c1` ⟹ 第 4 色透明**（漏了该透明处变黑块）
- **DXT3 的 4bit alpha 要 `*17`**（`<<4` 会让半透明偏）
- **DXT5 的 3bit 索引表**在 `a0 > a1` 时 8 级、否则 6 级 + 0/255
- **边缘块**（非 4 倍数尺寸）不能越界写
  ⚠️ 验它要挑"越界时会变"的像素 —— Buffer 写越界是**静默丢弃**，输出长度永远对

### LZ4

块格式（不带帧头），WE 在 TEXB 里给了 `uncompressedLen`。
⚠️ **重叠匹配必须逐字节复制**（`offset < matchLen` 时 `copy` 会读到还没写的字节）。

---

## 3. scene.json（1000+ 对象实测）

### ⚠️ 对象类型不是 `type` 字段，是"有哪个键"

`image` / `text` / `particle` / `light` / `sound` / `shape` / 纯变换节点（`group`）

### ⚠️⚠️⚠️ 属性是**包装对象**，不是裸值

凡是"能被用户属性/脚本驱动"的字段，磁盘上是：

```
{user, value}                     ×655   绑到 project.json 的用户属性
{script, scriptproperties, value} ×187   绑到一段 JS
{script, user, value}             ×44
{script, value}                   ×27
```

⟹ **四种都带 `value`，那就是静态默认值。**

不拆包装的后果（实测）：
- `visible` 326 处被包装（187 处 `value: false`）⟹ 样本 A **多画 77 个**该隐藏的图层
- `alpha`/`brightness` 166 处 ⟹ `Number({...})` = **NaN**，而 NaN 乘进颜色是**黑的**
- `origin` 63 处 ⟹ 读成 `[0,0,0]` ⟹ 图层全堆在角上

### ⚠️⚠️ 坐标：`origin` 的含义**取决于有没有父节点**

| | 含义 | 实测范围 |
|---|---|---|
| 根对象（`parent == null`） | 画布像素坐标的**绝对**位置 | x:139~1920 y:133~1080 |
| 子对象 | **相对父节点**的偏移 | x:-1555~1774 y:-898~898（绕 0） |

坐标系：**原点在画布左下角，Y 轴向上**（三条证据：背景层在正中 / 一对遮罩对称在画布外 /
抽 preview 首帧比对 SUNDAY 在 DECEMBER 之上）。

⚠️ 样本 A 有 **264/271** 个子对象 ⟹ 无条件减半画布会把几乎所有东西推出画布。

### ⚠️⚠️ `camera.eye` **已经是以画布中心为原点的**（和 `origin` 不同！）

判据：样本 A 的 `eye` 是 `(0,0)` 而画面**居中** ⟹ 若它是画布像素坐标（原点左下），
`(0,0)` 就意味着相机在左下角 ⟹ 画面只剩右上 1/4。

⚠️ 而偏移要**夹在"画布还盖满屏幕"的范围内** —— 实测样本 B 的 `eye.y=+121`
会让可见上边界超出最大背景层 90 单位 ⟹ 露黑边。
⟹ 判据：**壁纸铺满屏幕是硬需求，露黑边看起来像"坏了"** ⟹ 宁可少偏几十像素。

⟹ 判据（总结）：**同一个文件里的两个坐标字段可以有不同的原点。**
"这个字段是画布像素坐标"是从 `origin` **推广**过来的，而推广没有依据。

### ⚠️ 画布尺寸要**读**不要反推

在 `general.orthogonalprojection`（实测 9 张全是 3840×2160）。
从最大图层反推会错：样本 B 最大图层 **5760×2880**（作者故意留的视差余量）⟹ 画面缩到 2/3。

### ⚠️ `visible` 要继承祖先

实测样本 A：70 个自己 `visible`，正确该画的只有 **8** 个
（5 套非英语语言 + 备用时钟皮肤挂在 `visible=false` 的父节点下）。
⚠️ 抽 preview 首帧核对过：背景 + 涟漪 + `03:33` + 日期 + `PM` + 3 条频谱 = 正好 8。

### ⚠️⚠️ 贴图不在 `image` 字段里

```
scene.json 的 image: "models/LonelyCAT.json"
  ↓ { "material": "materials/LonelyCAT.json" }
materials/LonelyCAT.json: { "passes": [{ "textures": ["LonelyCAT"] }] }
  ↓ 贴图名是**裸名**（没有目录、没有扩展名）
真文件: materials/LonelyCAT.tex
```

⚠️ `textures` 数组里**第一个可以是 null**（shader 的空槽位）⟹ 取第一个非空的。

### `models/util/*.json` 是 **WE 内置模型**（不在包里）

`composelayer` 7/9 张 · `solidlayer` 6/9 · `fullscreenlayer` 5/9 ·
`projectlayer` 1/9 · `solidlayer_depthtest` 1/9

⚠️ 它们**本来没有贴图**（画面来自下层 + effect）⟹ 那不是"读不到"。
⟹ 判据：**"读不到"和"本来就没有"要分开报** ——
混在一起会让 14 个正常现象看起来像 14 个 bug，而真 bug 就藏在里面了。

### `colorBlendMode` 非 0 走**加色**

实测取值 `1 / 6 / 7 / 9 / 11 / 12 / 31`（不是 0/1/2）。WE 没公开这个枚举
⟹ 量了一个**能验证的相关性**：

| mode | 层数 | 贴图没有 alpha 的比例 |
|---|---|---|
| 0 | 108 | 12% |
| 6 / 9 / 31 | 各 1-2 | **100%** |

⟹ 非 0 的那些靠"混合产生透明"（加色：黑色部分自然消失）。
⚠️ 而加色比普通混合**保守**：猜错是画面偏亮（看得出是效果不对），
普通混合猜错是**一整块实心色盖住画面**（看起来像坏了）⟹ 两种错法里选症状轻的。

⟹ 判据：**枚举拿不到时，量"这些值出现在什么样的数据上"** ——
那能定出"该走哪一类"，即使定不出"具体是哪一个"。

---

## 4. flipY 的三个陷阱（同一个形状撞了三次）

| 纹理源 | `texture.flipY` | 怎么办 |
|---|---|---|
| `CanvasTexture(canvas)` | ✅ 生效（默认 true） | 不用管 |
| `CanvasTexture(ImageBitmap)` | ❌ **被忽略** | `createImageBitmap(blob, {imageOrientation:'flipY'})` |
| `DataTexture` | ⚠️ 默认是 **false** | 显式 `tex.flipY = true` |

⟹ 判据：**同一个属性在不同的纹理源/纹理类上，默认值不同、生效性也不同。**
"这个属性我设过了"不等于"它生效了"。

⚠️ 而这个 bug 的症状很有代表性：**文字是正的、图层是反的** ——
那个"一半正一半反"恰好指出了分界线。

---

## 5. 现在能画什么 / 不能画什么

### ✅ 能画

图层（变换树 + 视差）· 文字（canvas→纹理，含包内 ttf/otf）·
音频柱（`Simple_Audio_Bars`，按参数还原）· `tint`/`opacity` effect（折成两个乘法）·
全部 11 种贴图存储形态（含 MP4 视频纹理）

### ⛔ 不能画（按"影响多少张壁纸"排序 —— 那就是优先级）

| 缺口 | 影响 | 备注 |
|---|---|---|
| **粒子系统** | **9/9 张 · 78 个** | 唯一"每张都缺"的 |
| **合成层**（离屏渲染） | 7/9 张 | `clipping_mask` 要靠它（那 7 个白三角） |
| `waterwaves` | 5/9 张 · 19 处 | shader |
| `pulse` | 5/9 张 · 14 处 | shader |
| `blurprecise` | 5/9 张 · 8 处 | shader |
| `enhanced_simple_audio_bars` | 4/9 张 · 8 处 | 可能能按参数还原（像 Simple_Audio_Bars 那样） |
| `shake` / `lightshafts` | 各 4/9 张 | shader |
| `foliagesway` / `scroll` | 各 3/9 张 | shader |
| `shape` 类对象 | 3/9 张 · 9 个 | |
| 其余 25 种 shader effect | 各 1-2 张 | |
| **用户属性 / 脚本驱动** | 913 处绑定 | ⟹ 时钟不会走（我们只用静态默认值） |

⚠️ shader 的门槛：`.frag` 里有 `#include "common.h"`、`[COMBO_OFF]` 预处理宏、
`g_Texture0Resolution` 这类宿主注入的 uniform，而 `common_blending.h` **不在包里**（WE 内置）。

---

## 6. 下一步该做什么（我的建议，不是命令）

### 优先级 ① 合成层 + `clipping_mask`（7/9 张）

那是**一个通用机制**，做完之后 `clipping_mask` / `blur` / `localcontrast` 那类
"抓下层画面再处理"的 effect 都有了地基。

已查清的机制：
- 每个 `clipping_mask` 实例引用 `_rt_imageLayerComposite_<id>_a` —— 那是**离屏渲染目标**
- `<id>` 是某个 `composelayer` 对象的 id，而那个对象**位置尺寸和被裁的图层完全重合**
- shader 的运算是 `albedo`（合成结果）与 `clip`（本层贴图）按 `mask * albedo.a` 混合

⟹ 实现：先把合成层之下的图层渲进 `WebGLRenderTarget`，再作为纹理给上层用。

### 优先级 ② 粒子系统（9/9 张，78 个）

唯一每张都缺的。⚠️ 而它是独立子系统（发射器/生命周期/受力），工作量比合成层大。

### 优先级 ③ `enhanced_simple_audio_bars`（4/9 张）

先看它的参数是不是也**完全声明式**（`Simple_Audio_Bars` 就是，所以我们不用编译 shader 就还原了）。
⟹ 若是，那是性价比最高的一个。

---

## 7. 工作方式（这一轮烧了 9 轮打包才学会的）

### ⚠️⚠️⚠️ 真机只该用来验"画出来对不对"，不该用来发现"格式长什么样"

我前 8 轮每次只验一张：打包 → 安装 → 点开 → 截图 → 改一行。
而**每一轮都发现一个新的格式形状**（属性包装 / 变换树 / 贴图链 / TEXB 容器 /
flipY / camera.eye）—— 那些**全都能在解析层看出来**。

⟹ 两个脚本先跑，再动代码：

```bash
node wallpaper/scripts/scene-audit.js <壁纸目录>          # 格式形状 + 缺口排序
node wallpaper/scripts/scene-preview-diff.js <壁纸目录>   # 真值指标
```

### ⚠️⚠️ 守卫要"见过红"

`test/scene-pkg.test.js`（46 项）+ `test/scene-render.test.js`（43 项）。

写完一条断言之后**故意把它守的东西改坏**，确认它真的报红。
这一轮那么做逮出了 **8 条假守卫**，其中三次是同一个形状：

⟹ 判据：**永远锚到"那段代码会跑"的形状，不是"这个名字出现过"。**
（`scene: lastSceneDiag` 有两处 / `_scene:` 含子串 `scene:` / `FONT_BUDGET` 在注释里也有）

### ⚠️ 而守卫也会错

这一轮有**两条守卫把 bug 写成了要守的东西**，而且当时是绿的：
- `camOffset.x = e[0] - baseW / 2`（那正是"画面推到右上角"的 bug）
- "blend 不许猜、全走普通混合"（那时只有 2 张样本，看不出相关性）

⟹ 判据：**守卫锁住的是写它时的理解。** 样本变多之后理解会变，守卫要跟着改。
"全绿"从来不是"对了"的证据，只是"和我当时的想法一致"。

### 硬约束

- ⛔ **只读壁纸目录**（用户：「不动壁纸本身」）—— 有守卫穷举 `fs.*` 调用
- ⛔ 打包的 GUI 应用**不能靠 PATH 找外部命令**（`.app` 从 Finder 启动拿不到 `/opt/homebrew/bin`）
- ⛔ 探针不能只放在"要观测的那个东西"里面（它挂了探针跟着挂）
- 限帧 40（壁纸是常驻后台进程）

---

## 8. 常用命令

```bash
npm test                      # 全部守卫（24 个文件）
npm run dist:mac              # 打包
bash wallpaper/scripts/install-dmg.sh   # 装（先 ⌃⇧Q 退旧的）

node wallpaper/test/scene-pkg.test.js      # 只跑解析层
node wallpaper/test/scene-render.test.js   # 只跑渲染层
```

app 里的诊断：**设置 → 开发者选项**
- 「复制这张壁纸的诊断」—— 装载步骤 + 耗时 + 错误 + 能力
- 「复制逐图层清单」—— 每个对象：屏幕坐标/尺寸/α/blend/视差/贴图/**alpha 分布**
- 「和作者的 preview 对照」—— 逐项差值 + 一句结论（要 ffmpeg）
