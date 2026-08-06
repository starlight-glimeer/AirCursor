# 给接手的 agent

> DreamPaper：mac 上的动态壁纸平台（Electron + Swift helper + three.js）。
> 当前主线：**scene 类壁纸渲染器** —— 目标是通用兼容 Steam 创意工坊的 Wallpaper Engine 壁纸。

---

## 先读这两份

1. **[`wallpaper/docs/README.md`](wallpaper/docs/README.md)** —— 文档索引 + 工作方式 + 硬约束
2. **[`wallpaper/docs/SCENE-RENDERER.md`](wallpaper/docs/SCENE-RENDERER.md)** —— scene 格式规格 / 已知缺口 / 优先级

`wallpaper/MODULES.md`（1900 行）是按时间倒序的**决策日志** —— 想知道"某个决定为什么是那样"时查它，
不用通读。

---

## 开工前的两条命令

```bash
npm test                                                    # 24 个文件的守卫，先确认基线是绿的
node wallpaper/scripts/scene-audit.js ~/Documents/DreamPaper/Wallpapers
```

第二条会摊开你手上每张 scene 壁纸的格式形状，**并按"影响多少张壁纸"排出缺口** ——
那就是优先级，不用猜。

⚠️⚠️ 判据：**真机只该用来验"画出来对不对"，不该用来发现"格式长什么样"。**
（这一轮烧了 9 次打包才学会：每轮都发现一个新的格式形状，而那些全都能在解析层看出来。）

---

## 这个项目的三条硬规矩

### ⛔ 一、只读壁纸目录

工坊壁纸是**别人的内容**，我们是播放器。写进去就永久丢了那张壁纸的原样（用户要重下）。
有守卫穷举 `sendSceneData` / `sendSceneLoose` 里的每个 `fs.*` 调用。

### ⛔ 二、守卫要见过红

写完一条断言，**故意把它守的东西改坏**，确认它真的报红。

⟹ 判据：**永远锚到"那段代码会跑"的形状，不是"这个名字出现过"。**

而**守卫本身也会错** —— 它锁住的是写它时的理解。这一轮有两条守卫把 bug 写成了要守的东西，
而且当时是绿的。⟹ "全绿"不是"对了"的证据。

### ⛔ 三、观测通道要通到用户会看的地方

打包版**没有终端** ⟹ 只进 `console` 的信息等于没有。
诊断要能在**面板上**（设置 → 开发者选项）看到，而且能一键复制。

⟹ 判据：**探针的价值 = 信息量 ÷ 获取成本。**

---

## 别做的事

| | 为什么 |
|---|---|
| 部署 / 打 tag / 发布 | **要用户明示**，代码 + commit 即停 |
| 改 `appId` 或 `name` | 保持 `aircursor`（改了用户已有的配置和授权会丢） |
| 改 helper 二进制名 | 保持 `GestureWall*` / `AirCursor*`（授权按二进制路径算） |
| 靠 `PATH` 找外部命令 | `.app` 从 Finder 启动拿不到 `/opt/homebrew/bin` ⟹ 走候选路径表 |
| 把凭证写进日志 | `redactConfig` 打码那几个字段（诊断报告要发给别人） |

---

## 提交习惯

- commit 说明写**判据**，不只是"改了什么" —— 那是这个项目最值钱的东西
  （每条"⟹ 判据：…"都是踩过之后写下来的"别碰什么、为什么"）
- 改完 + 测过就 commit；正常开发 push 也做
- 版本号在 `package.json`，有守卫核对"代码注释里提到的版本 ≤ package.json"

---

## 当前状态（2026-08-04 / 0.9.163）

**能画**：图层（变换树+视差）· 文字（含包内字体）· 音频柱 · tint/opacity ·
11 种贴图存储形态（DXT1/3/5 + LZ4 + R8/RG88/RGBA + PNG/JPEG + MP4 视频）

**缺口**（按影响排序）：粒子 9/9 张 · 合成层 7/9 · waterwaves 5/9 · pulse 5/9 · …

**建议下一步**：合成层 + `clipping_mask`（7/9 张，而且是个通用机制 ——
做完之后所有"抓下层画面再处理"的 effect 都有地基）。机制已查清，见 SCENE-RENDERER.md 第 6 节。
