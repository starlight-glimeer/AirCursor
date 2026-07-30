# 两个模块的边界

`wallpaper/` 由两个 agent 分工维护。这份文件定的是**谁改哪些文件**和**中间的契约**，
让双方能各自改、各自验，不用读对方的代码。

## 🔴 要测这个分支：用 worktree，别往共享工作区 checkout

**给用户的命令绝不能污染 `~/workspace/AirCursor` 的工作区。** 正确做法：

```bash
git fetch origin
git worktree add /tmp/we-test origin/feat/we-wallpaper
cd /tmp/we-test/wallpaper          # ⚠️ 进 wallpaper/，不是 /tmp/we-test
npm install && npm start
# 测完（一条命令全清掉，不留痕迹）
git -C ~/workspace/AirCursor worktree remove /tmp/we-test --force
```

⚠️ **必须 `cd` 到 `wallpaper/` 子目录。** 这个分支的基点老，根目录 `package.json`
的 `"main"` 还指向 `electron/main.js`（AirCursor 0.4.2 的入口）——
在 `/tmp/we-test` 根目录跑 `npm start` 会启动**错的应用**，而它看起来"能跑"。
（这条是我写完这份文档之后实测发现的，验证过：worktree 里主工作区
`git status` 保持干净、`fetch-vendor.sh` 能正常拉到 24MB vendor。）

### 为什么：我用错误的做法烧掉了用户和另一个 agent 大半天

我曾让用户跑 `git checkout origin/feat/we-wallpaper -- wallpaper/`。那条命令把
25 个文件**写进工作区但不提交**，而 `wallpaper/` 里有一半是手势模块的文件：

| 被覆盖的文件 | 用户看到的症状 |
|---|---|
| `overlay.js`（我的版本在"骨架偏右"修好之前） | **很早修过的 bug 重现** |
| `sensor.js` / `input.js` | 手势变慢、不跟手 |
| `dashboard.html` | 早就删掉的「连续控制」又回来了 |

⟹ **git 里是对的版本，`npm start` 跑的是磁盘上的文件。**
而 `git diff <commit>` 比的是 HEAD、**不含未提交的改动** ——
所以基于 git 的验证会连续四轮说"代码一致"，而问题从一开始就不在它覆盖的范围里。

⚠️ **三个我当时就该知道的事实，我都忘了：**

1. **边界穿过 `wallpaper/` 内部** —— 这句话是我自己写在下面那张表里的。
   "壁纸自包含、只取那个目录"这个念头是错的，那个目录里有对方七个文件。
2. **我给的回滚办法不够。** 我写了「测完 `git checkout main -- wallpaper/`」，
   但那只覆盖已跟踪文件，`we-host.js` 那些新增的会留下。而且我把它写成了
   轻描淡写的附注，没说"不做这步手势会坏"。
3. **用户提示符里一直显示 `main +25 !1`** —— 那 25 个就是我造成的，
   它出现在用户贴给我的每一屏输出里，我看了好几次没注意。
   ⟹ **用户贴的终端输出里，提示符本身是数据。**

### 派生的两条规则

- **任何 checkout / 写文件的命令，必须同时给"怎么完全退出"和"不退出会坏什么"**，
  而且后者要写在显眼处，不是附注。
- **`git fetch` 不能省。** 我还犯过另一个：给 checkout 命令时漏了 fetch，
  于是用户编译的是旧代码，报出和修复前**一模一样的警告和行号** ——
  看起来像"修复没用"，实际是"修复没到"。所以给命令时要附一个
  **能一眼确认拿到新版**的检查（例如 `grep -c <新加的标识>`），
  别让编译/运行结果去背这个责任。

## 真机验证状态（2026-07-30）

**四种壁纸类型全部验过了**，而且是在真机上：

| 类型 | 状态 | 怎么验的 |
|---|---|---|
| **web** | ✅ 能跑 | 音域回响（React+Three.js+GLSL）：画面出来、脚本报 ready、改主题生效、点击掉流星、网易云歌名/进度都对 |
| **video** | ✅ 能跑 | 工坊视频壁纸真机播放正常 |
| **image / GIF** | ✅ 能跑 | legacy 单文件 → 魔数嗅探 → 造 project.json → `<img>` 整条链 |
| **scene** | ❌ 明确不支持 | 私有格式，装载时给理由 + 预览图（见 `scene-wallpaper-feasibility.md`） |
| **application** | ❌ 不做 | 用户的决定（Windows .exe） |

**创意工坊接入也通了**：steamcmd 登录 → 下载 → 预览图 → 类型识别 → 装载。

⟹ 所以下面那些"零真机验证"的警告**对上述路径已经不适用了**。仍然没验的只有：
音频频谱（要打包 + 屏幕录制权限）、多显示器、手势控制 WE 壁纸。

⚠️ **另一条真机才暴露的**：`bottom-normal` 策略下切桌面时壁纸会**跟着追过来覆盖**。
根因是「普通窗口 + `setVisibleOnAllWorkspaces(true)`」这个组合本身错了 ——
对普通窗口那个 API 的意思是"这一个窗口跟着你跑"，不是"每个桌面都有壁纸"。

macOS 原生要的是 `collectionBehavior = [.stationary, .canJoinAllSpaces]`，
关键在 **`.stationary`**（跨 Space 存在但不随切换移动）。
⚠️ **Electron 只暴露了 `canJoinAllSpaces` 那半边** ⟹ 拿不到那个组合。

⟹ 现状：`bottom-normal` 只待在当前桌面（其他桌面显示系统原生壁纸）。
要"每个桌面都有我们的壁纸**且**能收鼠标"，得写原生模块补 `.stationary`。

⚠️ **一条真机才暴露的事**：工坊里有的物品只上传了**缩略图**没有本体
（文件名带 `preview`，几百像素）。那种放大后必然糊，而"糊"看起来像渲染差 ——
所以现在会明确警告，并且小图自动改用 `contain` 而不是 `cover`。

## 分工

| | 壁纸模块 | 手势模块 |
|---|---|---|
| 管什么 | 三层渲染、模板/模块、图库、音乐、窗口层级、面板 | 摄像头、手势判定、录制、手感调参、骨架绘制 |
| 文件 | `layers.js` `mood.js` `nowplaying.js` `templates.js` `library.js` `wall.*` `dashboard.*` | `input.js` `recorder.js` `overlay.js` `overlay-window.js` `preview.js` `sensor.*` `system.js` |
| 共同拥有 | `main.js` `preload.js`（见下面的规则） | 同 |
| 测试 | `layers` `mood` `nowplaying` `templates` `library` `config` | `input` `recorder` `overlay` `preview` `system` `gating` |

`main.js` 和 `preload.js` 两边都要改（加 IPC 通道），所以**按段落分**：文件里用注释
分了区，改自己那段。冲突基本只会出现在 `defaultConfig` 和 IPC 注册这两处。

## 契约：手势事件

手势模块产出，壁纸模块消费。**这条线定死之后，双方各自可验**：

```jsonc
// 连续量：每帧发，0..1 的绝对值（不是增量）
{ "v":1, "kind":"gesture", "action":"zoom",     "value":0.62, "at":1785… }
{ "v":1, "kind":"gesture", "action":"pointer",  "x":0.4, "y":0.7, "at":… }

// 离散：触发一次
{ "v":1, "kind":"gesture", "action":"swipeLeft", "at":… }
{ "v":1, "kind":"gesture", "action":"spin",      "at":… }   // 用户录的手势
```

**为什么 `zoom` 发绝对值而不是"放大多少"**：渲染侧决定映射到什么倍数（`config.zoom`
的上下限），判定侧只报"手在干什么"。这样两边的调参互不干扰 —— 手势模块调灵敏度不会
改变壁纸的缩放范围。

**动作 id 是共享词表**，定义在 `templates.js` 的 `ACTIONS`。加动作要两边都知道：
手势模块负责它能被录制/触发，壁纸模块负责它触发之后有反应。⚠️ **改 id 等于让用户
已录的手势静默失效**，只能加不能改。

## 契约：骨架关键点

```jsonc
{ "hands": [[{ "x":0.4, "y":0.6 }, …21 点]], "recording": true, "at":… }
```

归一化、**已镜像**（发出前就翻好，接收方不用再想这件事）、不含 z。
`sensor.js` 发 → `main.js` 转 → `overlay-window.js` 画。

## 已知问题：手势不灵敏（手势模块）

用户反馈"骨架很大，而且不灵敏"。骨架大是渲染问题，已修（见下）。**不灵敏没查**，
可能的方向按可疑度：

1. **`modelComplexity: 0`**（`sensor.js`）。为省算力选的，代价是关键点精度。AirCursor
   用的是同样的值，但它的用途是指针定位，对精度更宽容。
2. **`SEND_INTERVAL_MS = 33`**（~30/s）。渲染侧有 One Euro 平滑，理论上够；但如果实际
   摄像头帧率就只有 30fps，节流会把有效采样率砍到更低。
3. **`gestureTuning` 的默认值**。`minCutoff: 1.2` / `beta: 0.045` 直接抄的 AirCursor，
   而那是给**屏幕指针**标的 —— 壁纸的视角控制是完全不同的量级，抄过来没有重新标定。
4. **`deadzone: 0.0016`** 归一化后相当于屏幕的 0.16%。看着很小，但 `input.js` 把坐标
   乘到 `FILTER_SPACE=1000` 的虚拟像素空间里滤波，所以实际死区是 1.6px —— 那个数是
   AirCursor 为**像素级指针**标的，对"手挥过半个屏幕"这种量级可能过小或过大，没验。

⚠️ 第 3、4 条是同一类问题：**AirCursor 的调参是为它自己的用途标定的，搬过来没有重标**。
`pitfalls.md` 里"一份报告只能标一个常数"说的就是这件事。

## 刚修的：骨架太大

`toCanvas` 原来把归一化坐标直接乘满屏 —— 手在摄像头里占 25%，在 1470px 宽的屏上就
画成 368px，比真手大好几倍。

现在**位置铺满屏、尺寸压到固定手宽**（200px 或屏宽 14%，取小）。两者分开是关键：
位置要覆盖整个屏幕才指得到任何地方，尺寸不能跟着屏幕长。只缩不放 —— 手离得远时
强行拉大会把"手离得远"这个信息抹掉。

## 跨文件不变量（两边共有，最容易分叉）

这些是**两个文件之间**的约定，任何一侧的单测都看不见。分叉的后果都是静默的：

| 不变量 | 在哪 | 分叉的症状 |
|---|---|---|
| 开骨架窗口的条件 == 发关键点的条件（录制时都放行） | `main.js:syncOverlayVisibility` / `sensor.js:sendHands` | 关骨架后录制 = 空窗口，和"骨架坏了"分不清 |
| 归一化坐标在喂给 AirCursor 模块前乘到 `FILTER_SPACE` | `input.js` | 掌宽被 `Math.max(60,…)` 钳死 ⟹ 速度恒为 0 ⟹ 挥动永不触发 |
| 加载 `templates.js` 的窗口必须先加载 `system.js` | 各 `*.html` | 八个系统动作静默消失，UI 上那一栏是空的 |
| 动作 id 只加不改 | `templates.js:ACTIONS` | 用户已录的手势静默失效 |

`test/gating.test.js` 和 `test/system.test.js` 里各有守卫读源码盯着前三条。

## 协作规则

**commit message 写清楚三件事**：改了什么、为什么（尤其是"为什么不用更显然的那个做法"）、
**什么没验证**。最后一条不是客套 —— 云端跑不了 Electron/摄像头，UI 和真机行为一律未验，
说清楚才不会让对方以为验过了。

**改到对方文件时**：先在 commit message 里说明为什么必须动，或者更好 —— 在契约里加一个
字段让对方自己改。

**跑测试**：`npm test` 是全量，改哪块至少跑对应的那几个文件。`npm run check` 只查语法，
**查不出未定义的标识符** —— 我在这上面栽过（`spawnSync` 没导入，运行时才炸，症状是
"手势触发了但什么都没发生"）。`test/system.test.js` 现在有一条守卫读 `main.js` 源码
检查导入完整性。

## 测试能覆盖什么、不能覆盖什么

205 项纯逻辑用例，`node` 直跑，不需要 Electron / GPU / 摄像头。它们覆盖几何、数值、
状态机、单位换算、接线完整性。

**覆盖不了**：画出来好不好看、真手能不能被认出来、窗口层级在真机上对不对、灵敏度合不合适。
夹具是合成的（规则形状的假手、纯色像素），真手的抖动、丢帧、时间相关噪声全在外面。
所以任何"手感"类的判断都只能真机看。
