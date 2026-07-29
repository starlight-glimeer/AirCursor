// 手势 → 系统动作。
//
// 手势的定位是**替代鼠标键盘**，不是只操作壁纸。所以动作分两类，而它们的代价差一个
// 量级：
//
//   打开应用 / 媒体键   走 /usr/bin/open 或系统级快捷键，**不需要任何授权**
//   移动光标 / 点击      走 CGEvent，需要辅助功能授权，而缺权限时是**静默丢弃**
//
// 分开是因为第二类有一个昂贵的失败模式：没授权时 CGEvent.post 不报错、不抛异常，
// 事件直接被系统扔掉。AirCursor 在这上面烧掉四轮 debug —— 症状是"手势识别到了但
// 什么都没发生"，而那和 CV 层的问题长得一模一样。
//
// 所以：第一类先做（零风险、立刻可用），第二类要有健康状态可查才做。
//
// 无 Electron 依赖（execFile 由调用方注入），所以能跑纯逻辑用例。
(function (root) {

// 打开应用：多个候选依次试，第一个成功就停。
//
// 为什么要候选列表：同一个 App 在不同机器上可能是不同的路径、不同的 bundle id、
// 中文名或英文名。写死一个的话"在我机器上能用"就是全部的测试覆盖。
const APP_RULES = [
  {
    id: 'open_netease',
    label: '打开网易云音乐',
    candidates: [
      ['/Applications/NeteaseMusic.app'],
      ['-b', 'com.netease.163music'],
      ['-a', 'NeteaseMusic'],
      ['-a', '网易云音乐'],
    ],
  },
  {
    id: 'open_music',
    label: '打开 Apple Music',
    candidates: [['-a', 'Music'], ['-b', 'com.apple.Music'], ['-a', '音乐']],
  },
  {
    id: 'open_spotify',
    label: '打开 Spotify',
    candidates: [['/Applications/Spotify.app'], ['-b', 'com.spotify.client'], ['-a', 'Spotify']],
  },
  {
    id: 'open_browser',
    label: '打开浏览器',
    candidates: [
      ['/Applications/Google Chrome.app'],
      ['-a', 'Google Chrome'],
      ['-a', 'Safari'],
    ],
  },
  {
    id: 'open_finder',
    label: '打开访达',
    candidates: [['-a', 'Finder']],
  },
];

// 媒体键。走系统级的按键合成，所以**不需要辅助功能授权** —— 和移动光标不是一条链。
//
// ⚠️ 这条待验：媒体键在 macOS 上其实也可能需要授权（取决于合成方式）。先按"不需要"
// 实现，健康状态里会报出来实际情况。用 osascript 而不是 CGEvent 是为了绕开授权 ——
// System Events 的 key code 走的是另一条路。
const MEDIA_KEYS = {
  media_toggle: { label: '播放 / 暂停', keyCode: 16 },
  media_next: { label: '下一曲', keyCode: 17 },
  media_prev: { label: '上一曲', keyCode: 18 },
};

// 所有系统动作，给 templates.js 引用。
function systemActions() {
  const out = {};
  for (const rule of APP_RULES) {
    out[rule.id] = {
      id: rule.id,
      label: rule.label,
      hint: '录一个自己的手势',
      kind: 'discrete',
      law: null,
      recordable: true,
      system: 'app',
    };
  }
  for (const [id, meta] of Object.entries(MEDIA_KEYS)) {
    out[id] = {
      id,
      label: meta.label,
      hint: '录一个自己的手势',
      kind: 'discrete',
      law: null,
      recordable: true,
      system: 'media',
    };
  }
  return out;
}

function ruleById(id) {
  return APP_RULES.find((rule) => rule.id === id) || null;
}

// 依次试候选，返回成功的那个参数组，全失败返回 null。
//
// `run` 注入进来（主进程传 spawnSync 的包装），所以这个函数本身是纯的、可测的。
function openApp(id, run) {
  const rule = ruleById(id);
  if (!rule) return null;
  for (const args of rule.candidates) {
    if (run(args)) return args;
  }
  return null;
}

// 一个动作 id 是不是系统动作，以及属于哪类。
function systemKindOf(id) {
  if (ruleById(id)) return 'app';
  if (MEDIA_KEYS[id]) return 'media';
  return null;
}

root.GestureWallSystem = {
  APP_RULES,
  MEDIA_KEYS,
  systemActions,
  ruleById,
  openApp,
  systemKindOf,
};
})(typeof window === 'undefined' ? globalThis : window);
