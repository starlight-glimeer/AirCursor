# DreamPaper 文档索引

> mac 上的动态壁纸平台。三条内容通道：Steam 创意工坊 / AI 生成 / 音频+手势。

**接手先读这一页**，它告诉你去读哪一份。

---

## 按"你要干什么"找

| 你要做的事 | 读哪份 |
|---|---|
| **改 scene 渲染器**（当前主线） | [`SCENE-RENDERER.md`](SCENE-RENDERER.md) ← 格式规格 + 已知缺口 + 优先级 |
| 改 AI 生成壁纸那条链 | [`../MODULES.md`](../MODULES.md) 里「AI 生成」那几节 |
| 改手势 / 音频 / 壁纸层策略 | [`../MODULES.md`](../MODULES.md)（按时间倒序的决策日志） |
| 想知道某个决定为什么是那样 | [`../MODULES.md`](../MODULES.md) —— 每一节都写了"错了会怎样" |
| 打包 / 装 / 授权 | [`../README.md`](../README.md) |

---

## 这个项目的工作方式（三条，别跳过）

### ⚠️ 一、先跑审计，再动代码

处理真实数据的功能，**代码侧对数据形态的假设是理想化的**，而合成测试给假绿。

```bash
node wallpaper/scripts/scene-audit.js ~/Documents/DreamPaper/Wallpapers
node wallpaper/scripts/scene-preview-diff.js ~/Documents/DreamPaper/Wallpapers
```

第一个摊开格式形状 + 按"影响多少张壁纸"排缺口；第二个量作者 preview 的真值指标。

⟹ 判据：**真机只该用来验"画出来对不对"，不该用来发现"格式长什么样"。**

### ⚠️⚠️ 二、守卫要见过红

写完一条断言，**故意把它守的东西改坏**，确认报红。

⟹ 判据：**永远锚到"那段代码会跑"的形状，不是"这个名字出现过"。**
（`scene-support` 这一轮那么做逮出 8 条假守卫，其中 3 次是同一个形状。）

⚠️ 而**守卫本身也会错** —— 它锁住的是写它时的理解。样本变多之后理解会变，
守卫要跟着改。"全绿"不是"对了"的证据。

### ⚠️⚠️⚠️ 三、观测通道要通到"用户真的会去看的地方"

打包版**没有终端** ⟹ 只进 `console` 的信息等于没有。
每个诊断都要能在**面板上**看到，而且能一键复制。

⟹ 判据：**探针的价值 = 信息量 ÷ 获取成本。**

---

## 硬约束

| | |
|---|---|
| ⛔ **只读壁纸目录** | 工坊壁纸是别人的内容，我们是播放器。有守卫穷举 `fs.*` |
| ⛔ **写入只在一个函数里** | `writeWallpaperFiles`，根只可能是我们的壁纸目录下一层 |
| ⛔ **凭证不落日志** | `redactConfig` 把 apiKey/password/guardCode 换成 `***`（诊断报告要发给别人） |
| ⛔ **不靠 PATH 找外部命令** | `.app` 从 Finder 启动拿不到 `/opt/homebrew/bin` ⟹ 走候选路径表 |
| ⛔ **第三方 HTML 按第三方对待** | `sandbox: true` + `contextIsolation: true`，资源过 `resolveAsset` 越界检查 |
| 限帧 40 | 壁纸是常驻后台进程 |
| 部署 / 上 pre / 打标签 | **要用户明示**，代码 + PR 即停 |

---

## 云端笔记（历史，不在这个仓库里）

`~/hackathon/aicursor-helper/` 和 `~/hackathon/aircursor-notes/` 是 7 月底的调研笔记。

⚠️ 其中 **`scene-wallpaper-feasibility.md`（2026-07-30）的结论已被实测推翻** ——
它说 scene「要移植 30k 行 C++」，那是量了 `linux-wallpaperengine` 的**代码规模**
（支持 WE 的全部功能），而不是量**真实壁纸里有什么**。

⟹ 判据：**评估工作量要量"真实输入里有什么"，不是量"那个引擎有多少行"。**

以那份为准的现在是 [`SCENE-RENDERER.md`](SCENE-RENDERER.md)。
