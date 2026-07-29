// 模板 = 三个槽位 × 每槽几种模块，外加这套模板认哪些手势。
//
// 为什么模板和手势绑在一起（用户定的设计）：
//
//   「模板 A 可以放大缩小；模板 B 能放大缩小，还能 360 旋转主体。这两个模板是一套的，
//    相当于普通用户 / pro 用户的感觉。另外的模板是另外的手势设定，所以其实是绑定的。」
//
// 所以"该录哪些手势"是模板的属性，不是一份全局列表。换模板 = 换一套可用动作。
// 而 basic/pro 的含义见下面 TIERS —— 不是动作分两组，是"有没有手势"。
//
// 无 DOM、无 Electron，所以能跑纯逻辑用例。
(function (root) {
// 系统动作（打开应用、媒体键）由 system.js 提供。手势的定位是替代鼠标键盘，所以
// "控制壁纸"和"控制电脑"是同一批动作里的两类，而不是两个功能。
const System = root.GestureWallSystem;

// 分档不是"手势分两档"，是**有没有手势**。
//
// 我第一版理解错了：按动作分成 basic/pro 两组，于是"进阶"意味着更多手势动作。用户
// 说的是另一回事 ——
//
//   「普通版就是正常的手表交互，就没有手势；进阶版就是手势支持录制。」
//
// 所以普通版根本不开摄像头（鼠标交互），进阶版全部动作开放且都能录制。同一套模板的
// 两种玩法，而不是动作数量的两档。
//
// 结果是 pro 档现在包含全部动作，`actions.basic` 只剩空数组占位 —— 保留字段是为了
// 让"某个模板只想给一部分动作"这种情况以后还能表达，但默认不再拿它分层。
const TIERS = {
  basic: { id: 'basic', label: '普通', hint: '鼠标交互，不开摄像头' },
  pro: { id: 'pro', label: '进阶', hint: '手势控制，动作可自己录制' },
};

// 一个动作的定义。`id` 进配置和手势绑定，所以改名等于让用户已录的手势失效 ——
// 加新动作可以，改 id 不行。
const ACTIONS = {
  zoom: {
    id: 'zoom',
    label: '推进 / 拉远',
    hint: '双手拇指+食指捏合，拉开 = 推进放大，合拢 = 拉远',
    // continuous：每帧给一个 0..1 的值，不是"触发一次"。这类动作不需要录制 ——
    // 它由手的连续状态直接驱动，录一个静态姿势没有意义。
    kind: 'continuous',
    recordable: false,
  },
  parallax: {
    id: 'parallax',
    label: '视差跟随',
    hint: '单手移动，三层按景深错开',
    kind: 'continuous',
    recordable: false,
  },
  yawLeft: {
    id: 'yawLeft',
    label: '主体左转',
    hint: '快速向左横挥',
    kind: 'discrete',
    // `law` 只说明**默认怎么触发**（不录也能用），不锁死**怎么录**：用户选了动态就走
    // 关键帧序列，那时律让位。第一版把有律的动作强制静态、连下拉都不给，而用户要的是
    // "功能一致" —— 每个可录制动作都该有同样的选项。
    law: 'swipe',
    recordable: true,
  },
  yawRight: {
    id: 'yawRight',
    label: '主体右转',
    hint: '快速向右横挥',
    kind: 'discrete',
    law: 'swipe',
    recordable: true,
  },
  pitchUp: {
    id: 'pitchUp',
    label: '视角上看',
    hint: '手掌上抬，抬一次动一格',
    kind: 'discrete',
    law: 'tilt',
    recordable: true,
  },
  pitchDown: {
    id: 'pitchDown',
    label: '视角下看',
    hint: '手掌下压，压一次动一格',
    kind: 'discrete',
    law: 'tilt',
    recordable: true,
  },
  spin: {
    id: 'spin',
    label: '主体 360 旋转',
    hint: '录一个自己的手势：做完动作松手触发',
    kind: 'discrete',
    // 没有物理律：录一段动作，按关键帧序列匹配。
    law: null,
    recordable: true,
  },
  resetView: {
    id: 'resetView',
    label: '复位视角',
    hint: '录一个自己的手势',
    kind: 'discrete',
    law: null,
    recordable: true,
  },
  // 系统动作接在同一张表里：对录制、冲突检测、预览来说它们和壁纸动作没有区别 ——
  // 区别只在"触发之后干什么"，而那是主进程的事。
  ...(System ? System.systemActions() : {}),
};

// 槽位里可选的模块。每个模块只描述**怎么表现**，不描述用什么图 —— 图是用户的，
// 模块是我们的。
//
// `params` 是这个模块自己的可调项，会被合并进渲染配置。分开放而不是塞进全局 config，
// 是为了让"换模块"不带走上一个模块的参数残留。
//
// ⚠️ 同一槽位下所有模块的参数**键必须齐**（用例守着这条）。缺一个键不是"用默认值"，
// 是让渲染层读到 undefined 然后参与算术 —— 那会算出 NaN，而 NaN 传进 three.js 的
// 变换矩阵是整个物体消失，不是报错。所以不需要的参数写 0，不要省略。
const MODULES = {
  background: {
    still: {
      id: 'still',
      label: '静止',
      hint: '只跟视差轻微移动',
      params: { drift: 0, tintFromCover: true, moodScale: 0 },
    },
    drift: {
      id: 'drift',
      label: '缓慢推移',
      hint: '画面持续极慢地平移，像呼吸',
      params: { drift: 0.35, tintFromCover: true, moodScale: 0 },
    },
    pulse: {
      id: 'pulse',
      label: '随音乐呼吸',
      hint: '亮度和缩放跟着氛围起伏',
      params: { drift: 0.12, tintFromCover: true, moodScale: 0.06 },
    },
  },
  subject: {
    still: {
      id: 'still',
      label: '静止',
      hint: '只跟手势转动',
      params: { float: 0, floatSpeed: 0, leanWithParallax: 0 },
    },
    float: {
      id: 'float',
      label: '呼吸浮动',
      hint: '缓慢上下浮动，像悬着',
      params: { float: 0.05, floatSpeed: 0.5, leanWithParallax: 0 },
    },
    lean: {
      id: 'lean',
      label: '跟随视角倾斜',
      hint: '视差时主体也微微侧身，立体感更强',
      params: { float: 0.03, floatSpeed: 0.4, leanWithParallax: 0.5 },
    },
  },
  shard: {
    orbit: {
      id: 'orbit',
      label: '环绕',
      hint: '碎片均匀散在主体四周',
      params: { layout: 'orbit', drift: 1 },
    },
    cluster: {
      id: 'cluster',
      label: '单侧聚集',
      hint: '碎片偏向一侧，留出主体',
      params: { layout: 'cluster', drift: 0.8 },
    },
    depth: {
      id: 'depth',
      label: '前后穿插',
      hint: '有的在主体前，有的在后，纵深最强',
      params: { layout: 'depth', drift: 1.2 },
    },
  },
};

// 模板 = 一组默认模块 + 一套动作。
//
// 先只做一套（用户："我们先做一套模版以及对应的手势"）。结构留着，加第二套时只需
// 往这里加一条，不用改任何渲染或录制代码 —— 那是这个文件存在的意义。
const TEMPLATES = {
  depthStage: {
    id: 'depthStage',
    label: '景深舞台',
    hint: '背景 + 主体 + 漂浮碎片，三层景深',
    slots: { background: 'still', subject: 'float', shard: 'orbit' },
    // 进阶版：全部动作开放，全部可录制。普通版不开摄像头，所以它那一档是空的
    // （鼠标交互不需要"动作列表"）。见文件头 TIERS 的说明。
    actions: {
      basic: [],
      pro: [
        // 壁纸动作
        'zoom', 'parallax', 'yawLeft', 'yawRight', 'pitchUp', 'pitchDown', 'spin', 'resetView',
        // 系统动作：手势替代鼠标键盘，所以打开应用和控制播放也在这套里
        'open_netease', 'open_music', 'open_spotify', 'open_browser', 'open_finder',
        'media_toggle', 'media_next', 'media_prev',
      ],
    },
  },
};

const DEFAULT_TEMPLATE = 'depthStage';

function template(id) {
  return TEMPLATES[id] || TEMPLATES[DEFAULT_TEMPLATE];
}

// 这套模板下所有可用动作。普通档不开摄像头所以是空的；进阶档全部开放。
function actionsOf(templateId, includePro) {
  const t = template(templateId);
  const ids = includePro ? [...t.actions.basic, ...t.actions.pro] : [...t.actions.basic];
  return ids.map((id) => ACTIONS[id]).filter(Boolean);
}

// 需要录制的那些。continuous 类不在其中 —— 它们由手的连续状态驱动，录一个静态姿势
// 没有意义，而给它们做录制入口只会让用户以为录了才能用。
function recordableActionsOf(templateId, includePro) {
  return actionsOf(templateId, includePro).filter((a) => a.recordable);
}

// 按"控制什么"分组，UI 用它分区显示 —— 八个壁纸动作和八个系统动作混在一张长列表里
// 找不到东西。
function groupedActions(templateId, includePro) {
  const actions = actionsOf(templateId, includePro);
  return {
    wall: actions.filter((a) => !a.system),
    system: actions.filter((a) => a.system),
  };
}

function moduleOf(slot, id) {
  const options = MODULES[slot] || {};
  return options[id] || options[Object.keys(options)[0]];
}

// 把模板的槽位选择摊平成渲染层要的参数。
//
// 渲染层不认识"模块"这个概念，它只认参数 —— 所以这里是唯一需要知道两者关系的地方，
// 加一个模块不用碰 layers.js。
function resolveSlots(templateId, slots) {
  const t = template(templateId);
  const chosen = { ...t.slots, ...(slots || {}) };
  const out = {};
  for (const slot of Object.keys(MODULES)) {
    const mod = moduleOf(slot, chosen[slot]);
    out[slot] = { id: mod.id, ...mod.params };
  }
  return out;
}

root.GestureWallTemplates = {
  TIERS,
  ACTIONS,
  MODULES,
  TEMPLATES,
  DEFAULT_TEMPLATE,
  template,
  actionsOf,
  recordableActionsOf,
  groupedActions,
  moduleOf,
  resolveSlots,
};
})(typeof window === 'undefined' ? globalThis : window);
