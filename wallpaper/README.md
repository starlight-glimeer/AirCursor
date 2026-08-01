# wallpaper/ —— 壁纸模块

**用户文档在仓库根的 [README.md](../README.md)**（安装、权限、壁纸放哪、
创意工坊、出问题怎么办）。这份只讲这个目录里有什么。

**架构和各模块的设计决定在 [MODULES.md](MODULES.md)** —— 那里记的是
"为什么这么做"和踩过的坑，改代码前值得读。

---

## ⚠️ 这份 README 之前是过期的

它原来的第一句是：

> macOS 手势音乐壁纸。三张你自己准备的图（背景 / 主体 / 碎片）按景深排成一个
> 有立体感的动态壁纸，手势控制它，跟随正在播放的音乐变氛围。

那是**支持 Wallpaper Engine 之前**的形态。现在的产品是"WE 创意工坊壁纸的
macOS 播放器"，而那个"三层景深"只剩一个**兜底渲染**（没装载壁纸时的底），
参数 UI 早就删了。

⟹ 教训：**README 会随功能推进过期，而过期的说明比没有说明更坏**（它主动误导）。
同一个坑在 UI 文案上也犯过 —— 创意工坊页曾写着"scene / video 类不支持"，
而 video 早就支持了，那句话在劝用户别下他其实能用的东西。

---

## 目录

```
src/
  main.js            主进程：窗口、壁纸层、IPC、配置、轮播、工坊下载
  dashboard.*        面板（唯一的 UI）
  wall.* video.*     壁纸层的两种载体（三层景深兜底 / video 类）
  we-host.js         project.json 的解析和类型判定（**唯一来源**）
  workshop.js        Steam 工坊 API（搜索、标签、下载参数）
  audio-source.js    系统音频采集的编译和启停
  audio-bins.js      FFT → 64 段的镜像规格（云端可跑，给测试用）
  system-bridge.js   helper 的编译和生命周期（鼠标转发 / 语音）
  mouse-bridge.js    全局鼠标监听（壁纸收点击靠它）
  prebuilt-helper.js 找打包时预编译好的 helper（见下）
  overlay.*          手骨架层
  input.js           手势判定（用 vendor/aircursor 的滤波器）
  vendor/aircursor/  上游的姿态/运动/跟踪代码 —— **别改**

native/
  GestureWallMouse.swift   全局鼠标监听
  GestureWallAudio.swift   系统音频采集（CoreAudio process tap）
  GestureWallAudioTapProbe*.swift  两个探针（当初用来证明 tap 不需要屏幕录制）

scripts/
  build-mac.sh           打 dmg（会先跑下面那个）
  prebuild-helpers.sh    **打包时**编译四个 Swift helper
  install-dmg.sh         走用户那条路装（⚠️ 会清 quarantine，不能用来测 Gatekeeper）
  whatswrong.sh          出问题时收集环境信息
  diag-packaged.sh       查打包产物里的东西对不对

test/               18 个文件。⚠️ 见下面「测试」
```

---

## ⚠️ helper 是**打包时**编译的（0.9.75 起）

四个 helper 原来在**用户机器上**现场编译（运行时调 `/usr/bin/swiftc`），
而那只有装了 Xcode 命令行工具（约 1.5 GB）的机器才有
⟹ 普通用户拿到 dmg：壁纸不跟音乐动、收不到鼠标点击、语音不可用，
**而症状是"某个功能没反应"，不是一句清楚的错误**。

现在 `scripts/prebuild-helpers.sh` 在打包时编好，放进
`.app/Contents/Resources/prebuilt-helpers/`。

**唯一的技术约束：名字规则两边必须一致。**
运行时用 `<HelperName>-<源码 sha256 前 12 位>` 命名、**文件存在就直接用**
⟹ 脚本按同一规则命名，运行时就直接拿来用、跳过编译。
⚠️ 算错的后果**不是报错**，是**静默地重新编译** —— 回到没有预编译的状态，
而那时用户看到的还是"功能没反应"，我们却以为修好了。

⚠️ `swiftc` 那条路**留着当兜底**（开发模式下也靠它 —— 改了 `.swift` 立刻生效）。
⚠️⚠️ 而**加新路径可以，改老路径不行** —— 我曾为了加一句"缺 Xcode 工具链"的提示，
把 `if (result.status !== 0)` 改成 `|| result.error`，**把手势整个弄坏了**
（用户报"摄像头没法正常使用"，只能整版回退）。
**锦上添花的东西不许碰承重代码。**

---

## 跑

```bash
npm install        # 会自动取 vendor（约 24MB）
npm start          # 开发模式
npm test           # 全部测试
npm run dist:mac   # 打 dmg（在仓库根跑也行）
```

**⚠️ 开发模式（`npm start`）拿不到辅助功能授权** —— 授权列表里只有
Electron/终端，没有本应用。鼠标转发那一项要打包成 `.app` 才能测。

---

## 测试

`test/gating.test.js` 有 200+ 项 —— 它不是单元测试，是
**"接线漏了但代码看着没错"那一类的守卫**。这个项目反复栽在同一个形状上：

- 配置字段没人读、模块没被 require、IPC 没注册 —— 纯逻辑用例全绿而功能是死的
- 删了 UI 留下调用 ⟹ `getElementById` 拿到 null ⟹ `null.onclick` 崩
- 一行变量被连带删掉 ⟹ rAF 回调静默吞异常 ⟹ 动画一帧都不画（查了六轮）
- `will-change: filter` 把 canvas 内容缓存住 ⟹ 画面冻在第一帧

**改这些守卫时的规矩（每一条都是栽过之后加的）：**

1. **写完断言要反向验证** —— 挨个破坏、确认它真的报红。
   永久绿的守卫和没有守卫一样，只是更贵。
2. **锚"产生效果的那一句"**，不是变量名/类名/函数名 —— 同一个名字在文件里
   往往有多处（声明 / 使用 / 注释），破坏一处照样绿。
   ⚠️ 而"那个模式出现两次"是最阴的一种 ⟹ 该数次数，不是查存在。
3. **任何"代码里含不含 X"的断言先剥注释和字符串**（`codeOnly()`）——
   注释里讲历史是应该的，而它会骗过守卫。`.html` 里有**两种**注释语法。
4. **不用固定长度切片**（`[\s\S]{0,300}`）—— 加几行注释就撑破了。锚结构边界。
5. **别锁死单个参数** —— 那会逼出错的解法。锁"总开销"、锁"意图"，
   而不是某个具体数字。（栽过两次：一次锁死"帧率 ≤30"逼出"降帧率"这个错解法，
   一次锁死"不许 ctx.filter"锁死了一个会让效果消失的实现。）

---

## 还没做

- scene 类壁纸（WE 编辑器的私有格式，要另一套渲染管线）
- 签名 + 公证（首次打开要过一次 Gatekeeper）
- Intel Mac（现在只打 arm64）
