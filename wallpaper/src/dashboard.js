// Dashboard：四个分区（模板 / 图库 / 手势录制 / 壁纸与音乐）。
//
// 每个控件都直接写回主进程，主进程持久化并广播 —— 所以没有"应用"按钮可以忘记按，
// 壁纸也不用被单独通知。
const T = window.GestureWallTemplates;
const Lib = window.GestureWallLibrary;
const P = window.GestureWallPreview;
const Sys = window.GestureWallSystem;

let config = null;
let strategy = null;
let recordingAction = null;

// ---------------------------------------------------------------------------
// 启动页
// ---------------------------------------------------------------------------
const launch = document.getElementById('launch');
launch.onclick = () => launch.classList.add('gone');
// 键盘也能进：点击是主路径，但一个只能点的入口对键盘用户是死路。
window.addEventListener('keydown', (e) => {
  if (!launch.classList.contains('gone') && (e.key === 'Enter' || e.key === ' ')) {
    launch.classList.add('gone');
  }
});

// ---------------------------------------------------------------------------
// 左栏切换
// ---------------------------------------------------------------------------
for (const button of document.querySelectorAll('nav button[data-tab]')) {
  button.onclick = () => {
    for (const b of document.querySelectorAll('nav button[data-tab]')) b.classList.remove('on');
    for (const s of document.querySelectorAll('main section')) s.classList.remove('on');
    button.classList.add('on');
    document.getElementById(`tab-${button.dataset.tab}`).classList.add('on');
    // ⚠️ 切到「我的壁纸」就刷新。
    //
    // 用户报（2026-07-31）：「壁纸存储目录那里应该是自动刷新，不应该是每次我自己
    // 手动点击刷新才能看到」。
    //
    // 他说得对，而且理由比"方便"更硬：壁纸目录是**磁盘上的东西**，
    // 用户会在 Finder 里往里拖文件、删文件 —— 那些变化面板压根不知道。
    // 而"切过去看看"正是他想知道"现在有什么"的时刻。
    //
    // ⚠️ 只在切到那个页签时扫，不做轮询：扫描要遍历磁盘（Steam 那个目录 639MB），
    // 每隔几秒扫一次会一直占着 IO。
    if (button.dataset.tab === 'mine') renderMine();
  };
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function get(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

// 点路径 → 嵌套 patch，这样主进程的深合并只碰那一个键。
function patchFor(path, value) {
  const keys = path.split('.');
  const root = {};
  let node = root;
  for (let i = 0; i < keys.length - 1; i += 1) {
    node[keys[i]] = {};
    node = node[keys[i]];
  }
  node[keys[keys.length - 1]] = value;
  return root;
}

function fileUrl(p) {
  if (!p) return '';
  return `file://${String(p).split('/').map(encodeURIComponent).join('/')}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------------------
// 滑块（数据驱动，避免"加了滑块但漏改一处"）
// ---------------------------------------------------------------------------
const TUNING = [
  { path: 'depth.background', label: '背景景深', min: -9, max: -1, step: 0.1 },
  { path: 'depth.shard', label: '碎片景深', min: 0.4, max: 4, step: 0.1 },
  { path: 'parallax', label: '视差强度', min: 0, max: 3, step: 0.05 },
  { path: 'transform.background.scale', label: '背景缩放', min: 0.8, max: 2.2, step: 0.02 },
  { path: 'transform.subject.scale', label: '主体缩放', min: 0.3, max: 2.2, step: 0.02 },
  { path: 'transform.subject.y', label: '主体上下', min: -2, max: 2, step: 0.02 },
  { path: 'shards.count', label: '碎片数量', min: 0, max: 16, step: 1 },
  { path: 'shards.spread', label: '碎片散布', min: 0.2, max: 3.5, step: 0.05 },
  { path: 'transform.shard.scale', label: '碎片大小', min: 0.2, max: 6, step: 0.1 },
  { path: 'tilt.maxYaw', label: '左右转幅度°', min: 0, max: 70, step: 1 },
  { path: 'tilt.maxPitch', label: '上下转幅度°', min: 0, max: 50, step: 1 },
];

const MUSIC_TUNING = [
  { path: 'music.coverInfluence', label: '封面染色强度', min: 0, max: 1, step: 0.05 },
];

const GESTURE_TUNING = [
  { path: 'gestureTuning.minCutoff', label: '平滑强度', min: 0.2, max: 6, step: 0.1 },
  { path: 'gestureTuning.beta', label: '快速跟随', min: 0, max: 0.3, step: 0.005 },
  { path: 'gestureTuning.deadzone', label: '静止死区', min: 0, max: 0.01, step: 0.0002 },
  { path: 'gestureTuning.prediction', label: '预测提前量', min: 0, max: 1.5, step: 0.05 },
  { path: 'gestureTuning.swipeSpeed', label: '挥动速度门', min: 1, max: 6, step: 0.1 },
  { path: 'gestureTuning.tiltTriggerDeg', label: '倾斜触发角°', min: 8, max: 45, step: 1 },
];

function renderSliders(hostId, spec) {
  const host = document.getElementById(hostId);
  host.innerHTML = '';
  for (const item of spec) {
    const row = el('div', 'row2');
    const label = el('label', null, item.label);
    const range = document.createElement('input');
    range.type = 'range';
    range.min = item.min;
    range.max = item.max;
    range.step = item.step;
    range.value = get(config, item.path);
    // 小数位数按步长算：死区滑块步长 0.0002，固定 toFixed(2) 会让整条滑轨都显示 0.00。
    const decimals = Math.max(0, Math.min(4, -Math.floor(Math.log10(item.step))));
    const out = el('output', null, Number(range.value).toFixed(decimals));
    range.oninput = () => {
      out.textContent = Number(range.value).toFixed(decimals);
      window.gw.setConfig(patchFor(item.path, Number(range.value)));
    };
    row.append(label, range, out);
    host.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// 模板分区
// ---------------------------------------------------------------------------
const SLOT_LABEL = {
  background: { name: '背景', hint: '整张壁纸' },
  subject: { name: '主体', hint: '抠好的人物，透明 PNG' },
  shard: { name: '碎片', hint: '壁纸的一小块' },
};
// 应用预设会改掉滑块背后的值，那时必须重建；普通拖动时不能重建，否则会把拖着的
// 滑块从手指下抽走。
let pendingPresetRefresh = false;
// ---------------------------------------------------------------------------
// 图库分区
// ---------------------------------------------------------------------------
const SLOT_OPTIONS = [
  { value: 'any', label: '任意' },
  { value: 'background', label: '背景' },
  { value: 'subject', label: '主体' },
  { value: 'shard', label: '碎片' },
];
// ---------------------------------------------------------------------------
// 手势分区
// ---------------------------------------------------------------------------
function renderGestureLead() {
  const t = T.template(config.template);
  document.getElementById('ges-lead').textContent =
    `「${t.label}」这套模板的手势。换模板会换一整套动作 —— 手势和模板是绑定的。`;
}

// 录制选项：静态还是动态、几只手。
//
// 静态/动态是**用户的选择**，不是按动作名查表 —— AirCursor 那边一开始是硬编码的，
// 结果既拒绝了"用画圈打开某个功能"（适合动态的动作被强制静态），也在一个静止姿势
// 就够用的地方强加了做动作的步骤。有律的动作（挥动/倾斜）例外：它们的方向由律决定，
// 录制只是加一道"必须是这个手型"的门，所以固定静态。
// 往日志窗格追一行。这是**唯一活得够久**的显示位置 —— `#live` 每帧被 sensor 状态覆盖。
function logLine(source, message) {
  // ⚠️ 音频/壁纸的日志也写到**音源旁边**那一格。
  //
  // 原来只有「手势录制」页签底部有 #log，而音频的输出（FFT 自检、
  // swiftc 编译失败、丢帧报告）都往那里去 ⟹ 用户在「我的壁纸」页签里找不到它。
  // 而我还告诉他"在创意工坊的诊断那块"—— 也是错的。
  //
  // ⟹ 音频的东西要在音频旁边。两处都写（手势页签那个是全量日志，
  // 这个只收 audio/we/wall 的）。
  if (source === 'audio' || source === 'we' || source === 'wall') {
    const box = document.getElementById('audio-log');
    if (box) {
      const line = `[${source}] ${message}`;
      box.textContent = `${box.textContent}${box.textContent ? '\n' : ''}${line}`
        .split('\n').slice(-15).join('\n');
      box.scrollTop = box.scrollHeight;
    }
  }
  const node = document.getElementById('log');
  if (!node) return;
  const line = `[${source}] ${message}`;
  node.textContent = `${node.textContent}${node.textContent ? '\n' : ''}${line}`
    .split('\n').slice(-40).join('\n');
  node.scrollTop = node.scrollHeight;
}

function recordOptions(action) {
  const stored = (config.recordOptions && config.recordOptions[action.id]) || {};
  return {
    // 默认静态（录得快），动态用户自己选。**有律的也给选** —— 见 templates.js 里
    // `law` 的注释：律只说明默认怎么触发，不该锁死怎么录。
    kind: stored.kind || 'static',
    hands: stored.hands || 1,
  };
}

// 诊断:录关键点 + 投递层健康。
//
// 这一段是补入口 —— 三个能力(startCapture / revealCaptures / pointerHealth)之前
// preload、主进程、sensor 三层都接好了,面板零入口,而我还报告说"接进面板了"。三层各自
// 都对,整条链没有入口 ⟹ 功能等于不存在,而所有测试全绿。逮到它的是一条机械反查守卫。
function wireDiagnostics() {
  const capture = document.getElementById('capture-start');
  const reveal = document.getElementById('revealCaptures');
  const state = document.getElementById('capture-state');

  capture.onclick = async () => {
    const result = await window.gw.startCapture();
    // 失败最常见的原因是摄像头没开,所以直接把原因显示出来而不是只说"失败"。
    state.textContent = result.ok
      ? '正在录制 5 秒:把手放进画面,做几个平时会用的动作'
      : `无法录制:${result.reason || '未知原因'}`;
    state.className = result.ok ? 'state ok' : 'state warn';
  };
  reveal.onclick = () => window.gw.revealCaptures();

  document.getElementById('grantAccessibility').onclick = () => window.gw.openAccessibility();
  document.getElementById('grantCamera').onclick = () => window.gw.openCameraSettings();
  document.getElementById('grantMic').onclick = () => window.gw.openMicrophoneSettings();
  document.getElementById('grantSpeech').onclick = () => window.gw.openSpeechSettings();

  window.gw.onVoiceStatus((s) => {
    const state = document.getElementById('voice-state');
    if (!state || !s) return;
    state.textContent = `语音：${s.text || '—'}`;
    state.className = /失败|不可用/.test(s.text || '') ? 'state warn' : 'state';
  });

  // 骨架几何:三层尺寸 + 端到端映射。不一致时直接说"画布在被缩放",而不是让人去猜。
  window.gw.onOverlayGeometry((g) => {
    const node = document.getElementById('overlay-geom');
    if (!node || !g) return;
    const m = g.mapped || [];
    const corners = m.map((p) => `${p.at} ${p.x},${p.y}`).join(' · ');
    node.textContent = g.consistent
      ? `骨架几何：正常 · 逻辑 ${g.logical.w}x${g.logical.h} · dpr ${g.dpr} · ${corners}`
      : `骨架几何：⚠️ 画布被缩放显示 —— 缓冲 ${g.buffer.w}x${g.buffer.h} / CSS ${g.css.w}x${g.css.h} / 逻辑 ${g.logical.w}x${g.logical.h}`;
    node.className = g.consistent ? 'state ok' : 'state warn';
  });

  // 骨架层/helper 的报错。只留最近 40 行 —— 它的用途是"刚才出了什么事",不是日志归档。
  window.gw.onHelperLog((entry) => {
    if (!entry) return;
    logLine(entry.source || '?', entry.message);
  });

  window.gw.onCaptureSaved((payload) => {
    if (!payload || payload.error) {
      state.textContent = `保存失败:${payload && payload.error}`;
      state.className = 'state warn';
      return;
    }
    // 报**有手的帧数**而不只是总帧数:一个 0 帧有手的文件看起来存成功了,而它对标定
    // 完全没用 —— 那是"看起来成功"的一种。
    const ok = payload.withHands > 0;
    state.textContent = ok
      ? `已存 ${payload.frames} 帧（其中 ${payload.withHands} 帧有手）`
      : `存了 ${payload.frames} 帧但一帧手都没有 —— 这份没法用来标定,重录一次`;
    state.className = ok ? 'state ok' : 'state warn';
  });
}

// 投递层健康。trusted 单独显示:没授权时 sent 照常增长(CGEvent.post 静默丢弃),
// 只看 sent 会以为一切正常。
function renderPointerHealth(health) {
  const node = document.getElementById('pointer-health');
  const grants = document.getElementById('grant-row');
  if (!node || !health) return;
  // 授权按钮只在真缺的时候出现:常显一个"去授权"会让已经授权的人以为还有事没做。
  if (grants) grants.hidden = health.trusted !== false;
  if (health.trusted === false) {
    node.textContent = '点击通道：无辅助功能授权 —— 手势能识别，但鼠标事件被系统静默丢弃';
    node.className = 'state warn';
    return;
  }
  if (health.state !== 'running') {
    node.textContent = `点击通道：${health.state}${health.detail ? ' · ' + health.detail : ''}`;
    node.className = 'state warn';
    return;
  }
  node.textContent = `点击通道：正常 · 已发 ${health.sent}${health.failed ? ` · 失败 ${health.failed}` : ''}`;
  node.className = 'state ok';
}

function renderRecordables() {
  stopAllPreviews();
  const grouped = T.groupedActions(config.template, config.proTier);
  renderActionGroup('recordables', grouped.wall.filter((a) => a.recordable));
  renderActionGroup('systemActions', grouped.system.filter((a) => a.recordable));
}

function renderActionGroup(hostId, actions) {
  const host = document.getElementById(hostId);
  if (!host) return;
  host.innerHTML = '';
  const t = T.template(config.template);
  if (!actions.length) {
    // 分清两种空：真的没有可录制动作，还是进阶模式没开。第一版只写了前一句，于是
    // "勾一下就有了"这个出路完全看不出来。
    const withPro = T.recordableActionsOf(config.template, true);
    host.append(el('p', 'hint', withPro.length && !config.proTier
      ? '这些动作要开「进阶模式」才能录 —— 勾上上面那个'
      : '这套模板没有需要录制的动作'));
    return;
  }
  for (const action of actions) {
    const recorded = config.recorded && config.recorded[action.id];
    const options = recordOptions(action);
    const row = el('div', 'rec');

    // ---- 左：名字、提示、状态、进度条 ----
    const info = el('div');
    const name = el('span', 'nm', action.label);
    if (t.actions.pro.includes(action.id)) name.append(el('span', 'tier pro', '进阶'));
    info.append(name);
    info.append(el('span', 'hint2', action.hint));

    const state = el('div', 'state');
    if (recordingAction === action.id) {
      state.textContent = '准备中…';
      state.className = 'state ok';
    } else if (recorded) {
      // ⚠️ 读存下来的 `dynamic` 字段，不是靠 keyframeData 的长度猜。
      //
      // 猜的后果：**有律的动态动作不产生 keyframes**（recorder.js 里 `s.dynamic && !s.law`
      // 才建关键帧序列，有律的走律），于是录了动态却显示"静态"。用户报「我点击的动态
      // 动作，录制过程看起来很顺畅，但是怎么显示已录制·静态」—— 录制是对的，显示在说谎。
      //
      // 而"界面主动说谎"在这个项目里已经有过一次代价（识别行显示了手势名但动作不发生，
      // 因为显示和触发用了两个时间尺度）。存了什么就显示什么。
      const kind = recorded.dynamic ? '动态' : '静态';
      // `!== false`：这个字段是后加的，存量录制没有它，缺字段当成"开着"。
      const on = recorded.enabled !== false;
      state.textContent = `${on ? '已录制' : '已关闭'} · ${kind} · ${recorded.hands} 只手`
        + (recorded.keyframes ? ` · ${recorded.keyframes} 关键帧` : '')
        + (recorded.dynamic && recorded.law ? ` · 按${recorded.law === 'swipe' ? '挥动' : '倾斜'}判方向` : '');
      // 关掉的用灰色（默认 state），不用 ok 的绿色 —— 一眼扫过去要能看出哪些在用。
      state.className = on ? 'state ok' : 'state';
    } else if (action.kind === 'continuous') {
      // 连续动作不录也能用（内置的捏合/移动映射），所以"未录制"不是缺陷状态。
      state.textContent = '未录制（在用内置映射，录一个手型可以当开关）';
      state.className = 'state';
    } else {
      state.textContent = action.law ? '未录制（有内置判定，录了更准）' : '未录制';
      state.className = 'state';
    }
    info.append(state);

    const bar = el('div', 'bar');
    const fill = el('i');
    fill.dataset.action = action.id;
    bar.append(fill);
    info.append(bar);
    row.append(info);

    // ---- 中：预览 ----
    row.append(buildPreview(action, recorded));

    // ---- 右：选项 + 按钮 ----
    const right = el('div');
    // 系统动作先给一个"试一下"：确认这个动作在这台机器上能用，再花时间录手势。
    if (action.system) {
      const test = el('button', 'act', '试一下');
      test.onclick = async () => {
        test.textContent = '…';
        const r = await window.gw.testSystemAction(action.id);
        test.textContent = r && r.ok ? '✅ 能用' : '❌ 失败';
        setTimeout(() => { test.textContent = '试一下'; }, 1800);
      };
      right.append(test);
    }
    const opts = el('div', 'opts');
    {
      const kindSelect = document.createElement('select');
      for (const [value, label] of [['static', '静态姿势'], ['dynamic', '动态动作']]) {
        const node = document.createElement('option');
        node.value = value;
        node.textContent = label;
        if (value === options.kind) node.selected = true;
        kindSelect.append(node);
      }
      kindSelect.onchange = () => window.gw.setConfig({
        recordOptions: {
          ...(config.recordOptions || {}),
          [action.id]: { ...options, kind: kindSelect.value },
        },
      });
      opts.append(kindSelect);
    }
    const handsSelect = document.createElement('select');
    for (const [value, label] of [[1, '单手'], [2, '双手']]) {
      const node = document.createElement('option');
      node.value = String(value);
      node.textContent = label;
      if (value === options.hands) node.selected = true;
      handsSelect.append(node);
    }
    handsSelect.onchange = () => window.gw.setConfig({
      recordOptions: {
        ...(config.recordOptions || {}),
        [action.id]: { ...options, hands: Number(handsSelect.value) },
      },
    });
    opts.append(handsSelect);
    right.append(opts);

    const buttons = el('div');
    buttons.style.marginTop = '6px';
    if (recordingAction === action.id) {
      const stop = el('button', 'act danger', '取消');
      stop.onclick = () => window.gw.cancelRecording();
      buttons.append(stop);
    } else {
      const rec = el('button', 'act primary', recorded ? '重录' : '录制');
      rec.disabled = !config.gestures.enabled || !!recordingAction;
      rec.onclick = () => window.gw.startRecording(action.id);
      buttons.append(rec);
      if (recorded) {
        // 单个手势的开关。放在「重录」旁边，因为"先关掉它试试"和"重录一个"是同一个
        // 处境下的两个选择 —— 手势串了的时候。
        const on = recorded.enabled !== false;
        const toggle = el('button', on ? 'act' : 'act primary', on ? '关闭' : '启用');
        toggle.onclick = async () => {
          const r = await window.gw.toggleRecording(action.id, !on);
          // 启用可能被冲突拒绝。不显示的话就是"点了没反应" —— 这个项目里最难查的症状。
          if (r && !r.ok && r.conflictWith) {
            const label = T.ACTIONS[r.conflictWith] ? T.ACTIONS[r.conflictWith].label : r.conflictWith;
            const state = row.querySelector('.state');
            if (state) {
              state.textContent = `打不开：和「${label}」太像（距离 ${r.distance}，至少要 ${r.need}）`;
              state.className = 'state warn';
            }
            logLine('面板', `打不开「${action.label}」：和「${label}」太像（${r.distance}/${r.need}）`
              + '。两个手势里得清除或重录一个');
          } else if (r && !r.ok) {
            logLine('面板', `开关失败：${r.error || '未知原因'}`);
          }
        };
        buttons.append(toggle);

        const clear = el('button', 'act danger', '清除');
        clear.onclick = () => window.gw.clearRecording(action.id);
        buttons.append(clear);
      }
      // 回退:有上一版才出现。常显一个大部分时候没用的按钮会训练人忽略它,而它恰好是
      // 录坏了唯一的退路 —— 没有它,唯一能知道新录的好不好的办法是留下它,而如果更差
      // 旧的已经没了,于是人根本不敢重录。
      if (config.recordUndo && action.id in config.recordUndo) {
        const undo = el('button', 'act', '回退');
        undo.title = config.recordUndo[action.id] ? '回到上一次录的那个手势' : '回到未录制状态';
        undo.onclick = async () => {
          const result = await window.gw.undoRecording(action.id);
          // 说清落到哪个状态:光说"已回退"你不知道现在手上是旧手势还是没有。回退成功后
          // 主进程会广播 config,面板整体重画,所以这里只在失败时留一行。
          if (!result.ok) {
            state.textContent = `回退失败:${result.reason || '未知原因'}`;
            state.className = 'state warn';
          }
        };
        buttons.append(undo);
      }
    }
    right.append(buttons);
    row.append(right);

    host.append(row);
  }
  if (!config.gestures.enabled) {
    host.append(el('p', 'hint warn', '先开启摄像头手势才能录制'));
  }
}

// ---------------------------------------------------------------------------
// 预览
//
// 为什么它是精华：录完之后，用户唯一的验证手段本来是"摆一遍看有没有反应"，而那把
// "录错了"和"匹配没过"混成同一个症状。画出来就一眼看出录的是不是自己想的那个。
// ---------------------------------------------------------------------------
const previewLoops = new Map();

function stopPreview(action) {
  const handle = previewLoops.get(action);
  if (handle) cancelAnimationFrame(handle);
  previewLoops.delete(action);
}

function stopAllPreviews() {
  for (const action of [...previewLoops.keys()]) stopPreview(action);
}

// 把一个模板画到 canvas 上。
function drawTemplate(canvas, template, { tiltDeg = 0, accent = '#6cc7ff' } = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const hands = P.templatePoints(template);

  // 双手比单手宽，所以框跟着内容变。**先加 class 再量尺寸** —— class 决定
  // clientWidth，反过来的话第一次绘制会把双手姿势塞进单手的框里。
  canvas.classList.toggle('is-wide', !!hands && hands.length > 1);

  const w = canvas.clientWidth || 60;
  const h = canvas.clientHeight || 76;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (!hands) {
    // 清空而不是塌掉：虚线空框就是"还没录"的样子，把 backing store 归零会让元素消失。
    canvas.classList.add('is-empty');
    return;
  }
  canvas.classList.remove('is-empty');

  const { hands: placed } = P.layout(hands, w, h, tiltDeg);
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = accent;
  ctx.fillStyle = accent;
  for (const points of placed) {
    for (const line of P.HAND_LINES) {
      ctx.beginPath();
      line.forEach((id, i) => {
        const p = points[id];
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
    }
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// 动图：走完动作，停一下，重来。停顿段换颜色 —— "动作结束了"要看得见而不是靠数节拍。
function startPreviewLoop(action, canvas, keyframes) {
  stopPreview(action);
  if (!keyframes || keyframes.length < 2) return;
  let start = null;
  const tick = (nowMs) => {
    // 自己检查还在不在文档里：省掉每个调用点都要记得拆除。
    if (!canvas.isConnected) { previewLoops.delete(action); return; }
    if (start === null) start = nowMs;
    const frame = P.frameAt(keyframes, nowMs - start);
    if (frame) {
      drawTemplate(canvas, frame.template, { accent: frame.holding ? '#8affc1' : '#6cc7ff' });
    }
    previewLoops.set(action, requestAnimationFrame(tick));
  };
  previewLoops.set(action, requestAnimationFrame(tick));
}

function buildPreview(action, recorded) {
  const wrap = el('div', 'preview');
  const rest = document.createElement('canvas');
  wrap.append(rest);

  const keyframes = recorded && recorded.keyframeData;
  const dynamic = keyframes && keyframes.length > 1;

  if (dynamic) {
    wrap.append(el('span', 'arrow', '→'));
    const move = document.createElement('canvas');
    move.className = 'is-move';
    wrap.append(move);
    // 静止那格画起始姿势，动的那格放动图 —— 两格并排，因为"从哪开始"和"怎么动"
    // 是两个独立的问题，一个动图答不了第一个。
    drawTemplate(rest, keyframes[0].template);
    // 元素进 DOM 之后才能量到尺寸，所以动画在下一帧启动。
    requestAnimationFrame(() => startPreviewLoop(action.id, move, keyframes));
  } else if (recorded && recorded.template) {
    drawTemplate(rest, recorded.template);
    // 倾斜类：第二格画"动作实际到达的位置"，而不是让用户看一个角度数字自己想象。
    if (action.law === 'tilt' && recorded.trigger) {
      wrap.append(el('span', 'arrow', '→'));
      const tilted = document.createElement('canvas');
      tilted.className = 'is-move';
      wrap.append(tilted);
      requestAnimationFrame(() => drawTemplate(tilted, recorded.template, {
        tiltDeg: (config.gestureTuning && config.gestureTuning.tiltTriggerDeg) || 22,
        accent: '#8affc1',
      }));
    }
  } else {
    drawTemplate(rest, null);
  }
  return wrap;
}
// build 标识（版本 + commit + 是否打包）。
//
// ⚠️ 这个函数踩过两个坑，都是"改了但用户看不到"：
//
//   ① 第一版放进 `#launch`（开屏页）—— 那个页会 `.gone` 淡出 ⟹ 看不见。
//      用户报「没看到任何类似 v0.9.10 … 的字样」。现在在 nav 里，所有 tab 常驻。
//   ② 第一版在 `renderWEStatus()` 里赋值 —— 而那个函数**不一定在启动时跑**
//      （它跟着壁纸状态走）⟹ 没装载壁纸时标识是空的。
//      现在从 `apply()` 调，那是配置一到就跑的必然入口。
//
// ⟹ 一句话：**核对版本用的东西，不能依赖任何"恰好发生"的时机。**
// 而它对打包来回测试是刚需 —— 测了旧版本会得出"改了没生效"的假结论。
async function renderBuildStamp() {
  const node = document.getElementById('build-stamp');
  if (!node) return;
  try {
    const status = await window.gw.weStatus();
    node.textContent = (status && status.build) || '版本未知';
  } catch {
    // 拿不到也要说话 —— 空白会被读成"这个功能没做"。
    node.textContent = '版本读不到';
  }
}

function renderToggles() {
  // ⚠️ 元素不在就跳过，而且**说出来**。
  //
  // 实测烧的一轮：收缩成两个页签时删掉了 music / showHud / moodFromCover 三个开关，
  // 但这里的 bind 调用留着 ⟹ `node.checked` 对 null 抛 TypeError。
  //
  // 后果和它的样子完全不成比例：renderToggles 是 apply() 的第三步，它一抛，
  // **后面所有初始化都不跑**（我的壁纸目录列表、鼠标转发勾选、筛选初始状态…）。
  // 用户看到的是「某个功能没反应」，而根因是一个被删掉的 UI 元素。
  //
  // ⟹ 静默跳过是对的（HTML 就是不该有它了），但必须报一句 ——
  // 静默 no-op 会让「配置存了但界面不动」变成查不出的鬼故事。
  const missing = [];
  const bind = (id, get_, set_) => {
    const node = document.getElementById(id);
    if (!node) { missing.push(id); return; }
    node.checked = get_();
    node.onchange = () => set_(node.checked);
  };
  bind('gestures', () => config.gestures.enabled, (v) => window.gw.setGestures(v));
  bind('proTier', () => config.proTier, (v) => window.gw.setConfig({ proTier: v }));
  bind('showHands', () => config.showHands, (v) => window.gw.setConfig({ showHands: v }));
  // 手控制真鼠标。默认关,而且这不是保守:一开摄像头就抢走鼠标,用户会没法用鼠标去把它
  // 关掉 —— 那是个能把自己锁在外面的开关。
  bind('controlCursor', () => !!config.controlCursor,
    (v) => window.gw.setConfig({ controlCursor: v }));
  // 语音走专用通道而不是 setConfig:开关要同时启停 helper,而 setConfig 只写配置。
  bind('voice', () => !!config.voice, async (v) => {
    const grants = document.getElementById('voice-grants');
    const state = document.getElementById('voice-state');
    if (grants) grants.hidden = !v;
    if (state) state.hidden = !v;
    const result = await window.gw.setVoice(v);
    if (state && result && result.ok === false) {
      state.textContent = `语音启动失败：${result.reason}`;
      state.className = 'state warn';
    }
  });
  // ⚠️ 这里曾经还有三个 bind:music / moodFromCover / showHud。
  //
  // 收缩成两个页签时那三个开关的 HTML 元素被删了,而 bind 调用留着 ⟹
  // `node.checked` 对 null 抛 TypeError,把 apply() 整个打断。
  // ⟹ 删掉它们(元素本来就不该回来);上面的 missing 报告负责逮住下一次同类漏删。
  if (missing.length) {
    console.warn(`[dashboard] 这些开关的 HTML 元素不在了,已跳过:${missing.join(', ')}`
      + ' —— 要么补回元素,要么删掉这里的 bind 调用');
  }
}

// ---------------------------------------------------------------------------
// 渲染入口
// ---------------------------------------------------------------------------
let built = false;

function apply(next) {
  config = next;
  // ⚠️ 产品形态收缩之后这里只剩两块:创意工坊 + 手势。
  //
  // 删掉的是模板(三层景深的参数)、图库、壁纸与音乐 —— 那三个 tab 连同它们的
  // renderLayers / renderSlots / renderPresets / renderGallery / renderStrategy 一起走了。
  // 三层景深的**渲染**还在(它是 WE 壁纸未装载时的底),只是不再暴露参数。
  renderBuildStamp();
  renderGestureLead();
  renderRecordables();
  renderToggles();
  cursorToggle.checked = !!config.controlCursor;
  renderAudioSource();
  renderWEStrategy();
  renderMineDirs();
  mouseForwardBox.checked = !!(config.we && config.we.mouseForward);
  mouseGateBox.checked = !!(config.we && config.we.mouseGateFinder);
  if (!built) {
    renderSliders('gestureTuning', GESTURE_TUNING);
    // 只接一次:按钮的 onclick 每次 apply 都重设是幂等的,但 onCaptureSaved 是订阅,
    // 重复订阅会让一次保存报好几遍。
    wireDiagnostics();
    refreshPointerHealth();
    built = true;
  }
  if (!config.gestures.enabled) {
    document.getElementById('live').textContent = '手势未开启';
  }
}

// 投递层健康:启动查一次,之后主进程状态变了会推过来。轮询会掩盖"从来没查过"这种情形,
// 所以是"一次 + 推送"而不是定时。
function refreshPointerHealth() {
  window.gw.pointerHealth().then(renderPointerHealth).catch(() => {});
}
window.gw.onPointerHealth(renderPointerHealth);

window.gw.onConfig(apply);
// 壁纸层策略仍然由主进程广播（⌃⇧L 能换），只是面板不再展示它 ——
// 那个 UI 在「壁纸与音乐」里，而那个 tab 已经砍掉。记下来是因为 renderWEStrategy
// 还在用 `strategy` 这个变量（创意工坊那页要显示当前壁纸层）。
window.gw.onStrategy((s) => { strategy = s; renderWEStrategy(); });

window.gw.onSensorStatus((s) => {
  document.getElementById('live').textContent = s && s.text ? s.text : '—';
  // 摄像头被拒时也把授权按钮露出来 —— 和辅助功能同一个道理:说了缺什么就得给路径。
  if (s && s.denied) {
    const grants = document.getElementById('grant-row');
    if (grants) grants.hidden = false;
  }

  // 心跳。停了要**主动变红**，因为"没有日志"和"一切正常"在面板上长得一模一样。
  if (s && s.heartbeat) {
    const h = s.heartbeat;
    const node = document.getElementById('heartbeat');
    if (node) {
      // 摄像头帧数和推理帧数分开显示：它们背离的那一刻就指明了是哪一层停的。
      // 摄像头涨、推理不涨 = 卡在推理；两个都不涨 = 摄像头或整层没了。
      node.textContent = `心跳：${h.stalled ? '⚠️ 推理停了' : `${h.fps}/s`}`
        + ` · 推理累计 ${h.frames} 帧 · 摄像头 ${h.cameraFrames} 帧`
        + (h.errors ? ` · 判定异常 ${h.errors} 次` : '')
        + (h.busy ? ' · 上一帧还在推理' : '');
      node.className = h.stalled ? 'state warn' : 'state ok';
    }
    // 停摆要进日志窗格：面板那一格会被下一次心跳覆盖，而"什么时候停的"要留痕。
    if (h.stalled) logLine('骨架层', `推理停了（累计 ${h.frames} 帧，摄像头 ${h.cameraFrames} 帧）`);
  }

  // 异常的堆栈进日志窗格。这一层没有开发者工具，不转出来就只剩"某个功能不工作"。
  if (s && s.error) logLine('骨架层', s.error.split('\n').slice(0, 3).join(' / '));

  // 匹配诊断。每个录过的动作一行：离触发多远、为什么没触发。
  //
  // 报**距离和门限两个数**，不是"匹配/不匹配"：差 0.01 和差 10 倍指向完全不同的处理
  // （再摆准一点 vs 这个模板录坏了重录），而一个布尔值把它们压成同一句话。
  if (s && s.probe) {
    const node = document.getElementById('match-probe');
    if (node) {
      const lines = s.probe.map((p) => {
        if (!p.action) return p.why;                       // "手不在画面里" 这类
        const d = p.distance !== undefined
          ? ` · 距离 ${p.distance} / 门 ${p.threshold}${p.distance < p.threshold ? ' ✓' : ''}`
          : '';
        // 动态手势多报两样：走到第几步，以及"离上一个关键帧多远"。
        //
        // 后者是中点规则的另一半：推进要求离下一帧**比离上一帧近**，所以 `0.31→0.24`
        // （在往前走）和 `0.31→0.09`（还黏在上一帧）是完全不同的处境，而只看 toNext
        // 两者一模一样。
        const step = p.steps ? ` · 第 ${p.step}/${p.steps} 步` : '';
        const back = p.fromPrev !== undefined ? ` · 离上一步 ${p.fromPrev}` : '';
        // 重新武装的进度。「第一次好触发、后面很难」的那个状态就在这里 —— 手够近所以
        // 不算离开、但已经触发过，于是看起来没反应。报出"离开了多久 / 要多久"。
        const rearm = p.reArm !== undefined && !p.armed
          ? ` · 松开门 ${p.reArm}${p.awayMs ? `（已离开 ${p.awayMs}ms）` : ''}`
          : '';
        return `${p.action}${step}${d}${back}${rearm} · ${p.why}`;
      });
      node.textContent = `手势匹配：\n${lines.join('\n')}`;
      // 有任何一个够近就转绿 —— 那说明手势这侧是通的，问题在下游（执行/绑定）。
      node.className = s.probe.some((p) => p.distance !== undefined && p.distance < p.threshold)
        ? 'state ok' : 'state';
    }
  }
});

window.gw.onGesture((g) => {
  if (!g) return;
  const detail = g.value !== undefined ? ` ${(g.value * 100).toFixed(0)}%`
    : g.x !== undefined ? ` ${(g.x * 100).toFixed(0)},${(g.y * 100).toFixed(0)}`
    : '';
  const node = document.getElementById('live');
  const first = node.textContent.split('\n')[0];
  node.textContent = `${first}\n最近事件：${g.action}${detail}`;
});

// 录制进度：只更新那一条的文字和进度条，不重建整个列表 —— 重建会让按钮在点击的
// 瞬间被替换掉。
window.gw.onRecordingProgress((p) => {
  if (!p) return;
  recordingAction = p.action;
  const fill = document.querySelector(`.bar i[data-action="${p.action}"]`);
  if (fill) fill.style.width = `${Math.round((p.progress || 0) * 100)}%`;
  const row = fill && fill.closest('.rec');
  const state = row && row.querySelector('.state');
  if (state) {
    const phase = { countdown: '倒计时', capture: '保持不动', ready: '准备做动作', move: '录动作' }[p.phase] || p.phase;
    // 做动作时把**实测幅度和需要的幅度**显示出来。
    //
    // 之前只有一句"做动作，做完停住"，于是用户做完了、它判定幅度不足、录制退出 ——
    // 而全程没有任何东西告诉他幅度不够。「看着像是意外中断」就是这么来的：失败的原因
    // 在失败之前是可知的，只是没人显示它。
    const extent = p.extent !== undefined && p.extentNeeded !== undefined
      ? ` · 幅度 ${p.extent}/${p.extentNeeded}${p.extent >= p.extentNeeded ? ' ✓' : ''}`
      : '';
    state.textContent = p.countdown
      ? `${phase} ${p.countdown}`
      : `${phase}：${p.hint || ''}${extent}`;
    state.className = 'state ok';
  }
});

window.gw.onRecordingResult((r) => {
  recordingAction = null;
  const node = document.getElementById('live');
  let text;
  if (r && r.ok) text = `✅ ${r.action} 录制成功`;
  else if (r && r.conflictWith) {
    // 报出**要多远才够**，不只是"太像了" —— 后者读不出该改多少。
    // 而如果撞上的那个手势当时是关着的，必须说清楚：否则用户会去找一个自己看不见
    // 在用的东西，而"我明明把它关了"和"它还在挡我"看起来是矛盾的。
    const label = T.ACTIONS[r.conflictWith] ? T.ACTIONS[r.conflictWith].label : r.conflictWith;
    text = `❌ 和「${label}」的手势太像（距离 ${r.distance}，至少要 ${r.need ?? '?'}）`
      + (r.otherDisabled ? '。那个手势现在是关着的，但关掉不代表可以撞 ——'
        + '重新打开它的时候两个就串了。要么把它清除，要么换一个差别更大的手势'
        : '，换一个差别更大的');
  } else if (r) text = `❌ ${r.error || '录制失败'}`;
  if (text) {
    node.textContent = text;
    // ⚠️ 也写进日志窗格。`#live` 每帧都被 sensor 状态覆盖（~30/s），所以录制失败的
    // 原因写在那里等于**闪一下就没了** —— 用户看到的就只是"录制突然退出了"，而错误
    // 信息其实是有的。
    //
    // 「看着像意外中断」这句描述之所以出现，就是因为唯一说明原因的那行字活不过 33ms。
    // 日志窗格留 40 行，是这个信息该去的地方。
    logLine('录制', text);
  }
  renderRecordables();
});
// ---------------------------------------------------------------------------
// 控制鼠标键盘 + 录原始关键点
// ---------------------------------------------------------------------------
//
// ⚠️ 这两块的主进程、preload、sensor 三层在合并时都接好了，唯独**面板上没有入口** ——
// 整条链齐了但用户点不到，功能等于不存在，而所有测试全绿。这是本项目反复出现的
// 那个形状（未读的 config 字段、没导入的 spawnSync、默认空的录制页）的又一次。
// 现在 gating 里有条守卫按"preload 暴露了什么"反查"面板用了没有"。

const cursorToggle = document.getElementById('controlCursor');
const pointerHealthNode = document.getElementById('pointer-health');

cursorToggle.onchange = () => window.gw.setConfig({ controlCursor: cursorToggle.checked });

function renderPointerHealth(health) {
  if (!health) { pointerHealthNode.textContent = '—'; return; }
  // ⚠️ trusted 是最要紧的一位：false 意味着后面所有 sent 都被系统丢掉了，
  // 而 sent 那个数字照常增长 —— 只看 sent 会以为一切正常。这正是 AirCursor
  // 烧掉四轮的那件事（缺权限时 CGEvent.post 静默丢弃）。
  if (health.trusted === false) {
    pointerHealthNode.innerHTML =
      '<span class="warn">没有辅助功能权限 —— 手势移动光标会被系统静默丢弃</span>\n'
      + '去「系统设置 → 隐私与安全性 → 辅助功能」勾上本应用';
    return;
  }
  const parts = ['✅ 点击通道正常'];
  if (Number.isFinite(health.sent)) parts.push(`已投递 ${health.sent}`);
  // failed 和"没权限"是两回事，分开报。
  if (health.failed) parts.push(`⚠️ 失败 ${health.failed}`);
  if (health.exits) parts.push(`helper 重启 ${health.exits} 次`);
  pointerHealthNode.textContent = parts.join(' · ');
}

if (window.gw.onPointerHealth) window.gw.onPointerHealth(renderPointerHealth);
if (window.gw.pointerHealth) window.gw.pointerHealth().then(renderPointerHealth).catch(() => {});

const captureState = document.getElementById('capture-state');

document.getElementById('capture-start').onclick = async () => {
  captureState.textContent = '正在录 5 秒 —— 就做平时会做的动作，别刻意摆姿势。';
  const result = await window.gw.startCapture();
  // ⚠️ 主进程返回的是 {ok:false, reason:…} 不是 error。读错字段只会显示兜底文案，
  // 而"摄像头没开"恰恰是最常见的失败原因。
  if (result && result.ok === false) {
    captureState.innerHTML = `<span class="warn">${result.reason || result.error || '起不来'}</span>`;
  }
};

// ⚠️ 合并时的 id 分歧:WE 分支那半用 `capture-reveal`,而保留下来的 HTML 里是
// `revealCaptures`(那一段本来就有自己的绑定,见 renderDiagnostics)。
// 这一行是重复绑定 + 用了不存在的 id ⟹ getElementById 返回 null 然后崩。删掉。

window.gw.onCaptureSaved((payload) => {
  if (!payload) return;
  // 写盘失败也走这个通道。不接的话录完什么都不显示，用户会去找一个不存在的文件。
  if (payload.error) {
    captureState.innerHTML = `<span class="warn">存盘失败：${payload.error}</span>`;
    return;
  }
  const { file, frames, withHands } = payload;
  // ⚠️ 报"有手的帧数"而不只是总帧数：0 帧有手也会存出一个看起来成功的文件
  // （有大小、能打开），而它完全没用。这个区别必须说出来。
  const rate = frames ? Math.round(withHands / frames * 100) : 0;
  captureState.innerHTML = rate === 0
    ? `<span class="warn">录完了，但 ${frames} 帧里一帧都没检测到手</span>\n`
      + '摄像头开了吗？手在画面里吗？这个文件没有用，重录一次。'
    : `✅ 存好了：${withHands}/${frames} 帧有手（${rate}%）\n${file}`;
});




// ---------------------------------------------------------------------------
// WE 网页壁纸
// ---------------------------------------------------------------------------

const AUDIO_SOURCES = [
  { id: 'netease', label: '网易云', hint: '只抓网易云的声音（需 macOS 14.4+，要屏幕录制授权）' },
  { id: 'system', label: '全系统', hint: '整台机器的输出，要屏幕录制授权' },
  // ⚠️ 合成测试音：**不需要任何授权**，纯代码产生频谱。
  //
  // 它的用途是把「壁纸能不能画音频可视化」和「我们能不能拿到系统音频」拆开 ——
  // 用户从"圆环没有"查了好几轮，而那两件事的症状完全一样。
  // 选它之后圆环动了 ⟹ 壁纸侧正常，剩下的纯粹是授权问题。
  { id: 'synth', label: '测试音（免授权）', hint: '合成频谱，用来确认壁纸能不能画音频可视化' },
  // ⚠️ 诊断用：每 2 秒只让一段有值，看画面上哪根柱子动。
  // 那是画面和数据矛盾时唯一能定位的办法。
  { id: 'sweep', label: '单段扫描（诊断）', hint: '每 2 秒只让一段有值，看哪根柱子动' },
  // ⚠️ 诊断用：每 2 秒只让一段有值，看画面上哪根柱子动。
  // 那是"画面和数据矛盾"时唯一能定位的办法。
  { id: 'sweep', label: '单段扫描（诊断）', hint: '每 2 秒只让一段有值，看哪根柱子动' },
  { id: 'off', label: '关闭', hint: '不抓音频，壁纸走它自己的空闲动画' },
];

// 当前装载的壁纸要不要音频。
//
// ⚠️ 用模块级变量而不是参数：`renderAudioSource` 有三个调用点（apply / 切音源 /
// 装载壁纸后），全都改签名容易漏一个，而漏掉的那个会让提示语消失 ——
// 那是"有时候提示、有时候不提示"，比一直不提示更难查。
let weWantsAudio = false;

function renderAudioSource() {
  const host = document.getElementById('we-audio-source');
  if (!host) return;
  const current = (config.we && config.we.audioSource) || 'off';
  host.className = 'we-src';
  host.innerHTML = '';
  for (const source of AUDIO_SOURCES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = source.id === current ? 'on' : '';
    button.textContent = source.label;
    button.title = source.hint;
    button.onclick = async () => {
      await window.gw.weSetAudioSource(source.id);
      renderWEStatus();
    };
    host.appendChild(button);
  }

  // ⚠️ 装载了「要音频」的壁纸而音源是关，必须**主动说**。
  //
  // 实测：用户装载「完美壁纸」，山景背景出来了，但那个音频圆圈完全不动。
  // 而 project.json 里 `supportsaudioprocessing: true` ⟹ 我们**知道**它要音频，
  // 也知道音源是 'off'（默认值）—— 却什么都没说。
  //
  // ⟹ 那让用户去查一个不存在的 bug。而真相是"没开音源"，
  // 加上"开了也要打包才有屏幕录制授权"这层，不主动讲清就一定会被当成坏了。
  const note = document.getElementById('we-audio-note');
  if (note) {
    if (weWantsAudio && current === 'off') {
      note.innerHTML = '⚠️ <b>这个壁纸要音频</b>（project.json 里 '
        + '<code>supportsaudioprocessing: true</code>），而音源现在是「关」'
        + ' ⟹ 它的音频可视化部分（频谱圆环 / 跳动的柱子）不会动。'
        + '<br>那不是坏了。开音源要<b>屏幕录制</b>授权，而开发模式（<code>npm start</code>）'
        + '拿不到 ⟹ 这一项只能打包版验。';
      note.hidden = false;
    } else {
      note.hidden = true;
    }
  }
}

// 壁纸层策略选择。⚠️ 做成开关而不是我替用户定，因为那是个真取舍：
// 菜单栏区域有内容 vs 鼠标交互能用，两者在 macOS 上不可兼得。
const WE_STRATEGIES = [
  { id: 'desktop', label: '真壁纸层', hint: '菜单栏区域也有内容，但壁纸收不到鼠标' },
  { id: 'bottom-normal', label: '普通窗口压最底', hint: '能收鼠标，顶部 25px 是系统菜单栏' },
  { id: 'floating', label: '悬浮最上层', hint: '只用来验渲染，会盖住所有窗口' },
];

function renderWEStrategy() {
  const host = document.getElementById('we-strategy');
  if (!host) return;
  const current = (config.we && config.we.strategy) || 'bottom-normal';
  host.className = 'we-src';
  host.innerHTML = '';
  for (const s of WE_STRATEGIES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = s.id === current ? 'on' : '';
    button.textContent = s.label;
    button.title = s.hint;
    button.onclick = async () => {
      await window.gw.weSetStrategy(s.id);
      renderWEStatus();
    };
    host.appendChild(button);
  }
}

// 鼠标转发。⚠️ 这是"真壁纸层 + 鼠标交互"能同时成立的关键 ——
// 我原来做成了让用户在两者间选一个，而用户否掉了那个方案（他是对的）。
const mouseForwardBox = document.getElementById('mouseForward');
const mouseGateBox = document.getElementById('mouseGateFinder');
const mouseStateNode = document.getElementById('mouse-state');

mouseForwardBox.onchange = () =>
  window.gw.weSetMouseForward({ mouseForward: mouseForwardBox.checked });
mouseGateBox.onchange = () =>
  window.gw.weSetMouseForward({ mouseGateFinder: mouseGateBox.checked });

window.gw.onMouseStatus((status) => {
  if (!status) { mouseStateNode.textContent = '—'; return; }
  mouseStateNode.innerHTML = status.ok
    ? `✅ ${status.text}`
    : `<span class="warn">${status.text}</span>`;
});

// ⚠️ 这一段是"点了没反应"的分辨器。三种原因长得一样，而这里把它们拆开：
//   注入数 0        → helper 没抓到（转发没起来 / Finder 门挡住了）
//   注入了但页面 0  → 坐标算错，注到窗口外
//   mouse 有 pointer 无 → 事件族问题（壁纸监听 pointerdown 而我们注 mouseDown）
function renderMouseDiag(mouse) {
  if (!mouse) return '';
  const injected = mouse.injected || 0;
  const saw = mouse.pageSaw;
  if (!injected) {
    // ⚠️ 按可能性排序，而且第一条是实测确认过的原因（没授权）。
    // 原来这条写的是"转发没起来或者门挡住了"，而真因是第三种：
    // 监听建立了、门也开着、但没有辅助功能授权 ⟹ 回调一次都不触发。
    const trusted = mouse.status && mouse.status.trusted;
    if (trusted === false) {
      return '\n⚠️ 没有辅助功能授权 —— 监听建立了但收不到任何事件。'
        + '\n开发模式（npm start）拿不到那个授权，要打包成 .app：npm run dist:mac';
    }
    return '\n⚠️ 一个鼠标事件都没转发进去。三种可能：'
      + '\n① 没有辅助功能授权（最常见，开发模式下必然如此）'
      + '\n② 「只在桌面被聚焦时」那个开关开着'
      + '\n③ helper 没起来 —— 看上面那行状态';
  }
  if (!saw) {
    return `\n⚠️ 已转发 ${injected} 个事件，但页面一个都没收到 —— `
      + `坐标可能算错了${mouse.lastEvent ? `（最近注入位置 ${mouse.lastEvent.x},${mouse.lastEvent.y}）` : ''}`;
  }
  const parts = [`已转发 ${injected}`];
  parts.push(`页面收到 mousedown ${saw.mousedown} / pointerdown ${saw.pointerdown} / click ${saw.click}`);
  // ⚠️ 这条区分最关键：我们注入的是 mouseDown，而很多壁纸监听 pointerdown。
  // Chromium 通常会合成，但如果没合成，症状就是"点了没反应"而事件其实到了。
  if (saw.mousedown > 0 && saw.pointerdown === 0) {
    parts.push('\n⚠️ mousedown 到了但 pointerdown 没有 —— '
      + '这个壁纸监听的是 pointer 事件，而注入的 mouse 事件没被合成成 pointer。'
      + '这是个真问题，把这行发给我。');
  }
  return `\n${parts.join(' · ')}`;
}

// 状态分三层显示，因为它们代表不同的失败：
//   装载了没有 → 根本没选壁纸
//   ready 没有 → 页面加载了但里面的 JS 没跑起来（ES module 挂了就是这样）
//   音频不 ok  → 权限或没在放歌
// ⚠️ 这三种在画面上看起来都是"没反应"，分不开的话没法查。
// 属性发送状态那一行。
//
// ⚠️ 这是"圆环/粒子/时间显示为什么不出现"的**第一观测点**，而它以前完全不可见。
//
// 实测：用户报「圆环没有、也没交互」，面板只说"页面加载了但没报 ready" ——
// 而 ready 只是个显示信号（不阻塞任何功能），真正该问的是
// **那 100+ 项属性进去了吗**。这个壁纸的圆环、粒子、时间全由属性驱动
// （showCircle / visual_audio_model / particles_isParticles…），属性没进去它什么都不画。
//
// 而主进程原来把 `no-listener` 静默吞了 ⟹「壁纸没挂 listener」和「一切正常」
// 长得一模一样。
function propsLine(props) {
  if (!props) return '';
  if (props.state === '已送到') {
    return `\n✅ ${props.count} 项属性已送到壁纸`;
  }
  if (props.state === '这个壁纸没有可配置项') {
    return '\n这个壁纸没有可配置项（正常）';
  }
  if (props.state === '发不进去') {
    if (props.reason === 'no-listener') {
      return `\n<span class="warn">⚠️ 有 ${props.count} 项属性，但壁纸没挂`
        + ' wallpaperPropertyListener ⟹ 一项都没进去。'
        + '它的圆环/粒子/时间都靠属性驱动，所以画面会缺一大块。'
        + '常见原因：脚本在挂 listener 之前就抛了 —— ⌃⇧D 看 Console 第一条报错</span>';
    }
    return `\n<span class="warn">⚠️ 属性发不进去：${props.reason}</span>`;
  }
  if (props.state === '发送中') {
    return `\n⏳ 正在发 ${props.count} 项属性…`;
  }
  return '';
}

async function renderWEStatus() {
  const status = await window.gw.weStatus();
  // ⚠️ 先记下"这个壁纸要不要音频"，再重渲染音源区 —— 那句提示依赖它。
  // 放在 `if (!node) return` **之前**：那个 return 是为了 we-state 容器不存在时
  // 早退，但音源提示和它没关系，卡在那里会让提示永远不出现。
  const wasWanting = weWantsAudio;
  weWantsAudio = !!status.wantsAudio;
  if (wasWanting !== weWantsAudio) renderAudioSource();
  const node = document.getElementById('we-state');
  if (!node) return;
  // 菜单栏那条缝：盖住了不用说，盖不住要说清"试了几次、还差多少"。
  // ⚠️ 那条缝是"看得见但查不到"的典型 —— 用户只能看到顶上有一条别的东西。
  // ⚠️ 带上触发原因（lastReason）：那是查因的线索。
  // "因 blur 被夹"意味着点别的应用触发的，"因 resize"是尺寸变化触发的 ——
  // 两者指向不同的 macOS 行为。
  // ⚠️ 尺寸对不对、和菜单栏区域有没有内容，是**两件事**。
  //
  // 诊断报告证明过：窗口 1470×956 一像素不差，而用户仍然看到顶上那条带子 ——
  // 因为普通窗口画不到菜单栏那一层（系统的独立图层）。
  // 所以这里只在**尺寸真的不对**时报警，而"那条带子"用另一句话解释。
  const menuBarNote = status.menuBar && status.menuBar.sizeOk
    && !status.menuBar.coversMenuBar
    ? '\n顶部那 25px 是系统菜单栏画的（我们的窗口已经铺满整屏）—— '
      + '想让那块也有内容就切「真壁纸层」，代价是壁纸收不到鼠标。'
    : '';
  const menuBar = menuBarNote || (status.menuBar && !status.menuBar.sizeOk && status.menuBar.gap
    ? `\n⚠️ 顶部菜单栏那条带子盖不住（推了 ${status.menuBar.pushes} 次，`
      + `还差 ${status.menuBar.gap.height || status.menuBar.gap.y}px，`
      + `最近因 ${status.menuBar.lastReason}）—— macOS 把窗口夹进了可见区域。`
      + '⌃⇧L 切到 desktop 层能盖住，代价是鼠标交互失效。'
    : '');

  if (!status.dir) {
    node.innerHTML = '未装载 —— 现在显示的是三层景深壁纸' + menuBar;
  } else if (status.error) {
    node.innerHTML = `<span class="warn">${status.error}</span>\n${status.dir}`;
  } else {
    node.innerHTML = `<b>${status.title}</b>\n${status.dir}\n`
      + (status.ready
        ? '✅ 壁纸里的脚本已经跑起来了'
        : '⏳ 页面加载了，但壁纸还没报 ready —— 如果一直这样，是里面的脚本没跑起来')
      + (status.wantsAudio ? '\n这个壁纸要音频' : '\n这个壁纸不需要音频')
      + propsLine(status.props)
      + menuBar;
  }
  renderAudioStatus(status.audio);
  if (mouseStateNode && status.mouse) {
    const base = status.mouse.status
      ? (status.mouse.status.ok ? `✅ ${status.mouse.status.text}`
        : `<span class="warn">${status.mouse.status.text}</span>`)
      : '转发未启用（只有「真壁纸层」需要）';
    mouseStateNode.innerHTML = base + renderMouseDiag(status.mouse);
  }
  await renderWEControls();
}

// 实际频谱值。⚠️ **这是"参数该调多少"的唯一依据。**
//
// 我为"幅度/形状不对"改了三轮参数，而从没看过那 128 个数长什么样 ——
// 每轮都从壁纸代码反推"应该是多少"，然后靠用户看截图判断。
// ⟹ 有了这一行，调参从"猜"变成"读数"。
function renderAudioFrame(frame) {
  const node = document.getElementById('we-audio-frame');
  if (!node || !frame) return;
  // ⚠️ 报三件事，每件都直接对应一个可能的问题：
  //   max        —— 顶天了没有（>1.5 说明 NORMALIZE 太大）
  //   low/high   —— 形状对不对（音乐应该低频远大于高频）
  //   逐段值      —— 具体哪一段不对
  const shape = frame.lowMean > frame.highMean * 1.5 ? '✅ 低频>高频（像音乐）'
    : (frame.highMean > frame.lowMean * 1.2
      ? '⚠️ 高频>低频 —— 那不是音乐的形状，分箱或加权有问题'
      : '⚠️ 低高频差不多 —— 大概是白噪声或者加权把差异抹平了');
  // ⚠️ 报出**这是哪个音源的数据**。
  //
  // 用户实测撞到：切到「单段扫描」后，状态行说"只有第 40 段有值"，
  // 而这一行显示的是真音频的形状 ⟹ 两行自相矛盾，他有理由以为两个源同时在发。
  // 真相是这一行**压根没更新**（我只在真采集路径里上报）。
  // ⟹ 带上 source，那样"没更新"会立刻暴露出来。
  const SRC_NAME = {
    system: '全系统', netease: '网易云', synth: '测试音', sweep: '单段扫描', off: '关闭',
  };
  const who = SRC_NAME[frame.source] || frame.source || '?';
  // ⚠️ 这里原来会算「NORMALIZE 该乘多少」——**那个参数已经不存在了**。
  //
  // 音频算法现在整套抄自 WE（linux-wallpaperengine 的逆向成果），
  // 没有"我调的参数"了 ⟹ 不该再有"帮你调参"的建议。
  //
  // 而值该长什么样是可以判断的：WE 的算法把动态压到 5 倍左右
  //（低频 ×0.351、高频 ×1.393 的加权），所以正常音乐下**每段都该有可见的值**。
  // ⟹ 报"形状对不对"，而不是"该调多少"。
  let advice = '';
  if ((frame.source === 'system' || frame.source === 'netease') && frame.max > 0.02) {
    const spread = frame.max / Math.max(0.01, frame.mean);
    if (frame.lowMean > frame.highMean * 4) {
      advice = '<br><span class="warn">⚠️ 低频比高频大 4 倍以上 —— '
        + 'WE 的频段加权本该把它压平（低频 ×0.351、高频 ×1.393）。'
        + '如果画面上一片长一片没有，说明加权没生效</span>';
    } else if (spread > 25) {
      advice = `<br><span class="warn">⚠️ 峰值是均值的 ${spread.toFixed(0)} 倍 —— `
        + '太尖了，正常音乐下 WE 的算法应该在 10 倍以内</span>';
    } else {
      advice = '<br>✅ 形状像 WE 的输出（动态压到位、低高频接近）';
    }
  }

  node.innerHTML = `<b>实际频谱</b>（${who}，每半秒刷新）`
    + `<br>最大 ${frame.max}　平均 ${frame.mean}`
    + `　${frame.max > 1.5 ? '<span class="warn">⚠️ 顶天了，NORMALIZE 要调小</span>'
      : (frame.max < 0.05 ? '<span class="warn">⚠️ 太小，NORMALIZE 要调大</span>' : '')}`
    // ⚠️ 段号改了：镜像下段 80-119 是 band 47..8（中低频），不是高频。
    // 现在按 **band** 取前半：低频 band 0-19、高频 band 44-63。
    + `<br>低频(band 0-19) ${frame.lowMean}　高频(band 44-63) ${frame.highMean}　${shape}`
    // ⚠️⚠️ 动态范围 —— 真 WE 预览图是 **4.4 倍**（大多数柱子 0.045、最长 0.20）。
    // 我们 0.9.14 只有 2.4 倍 ⟹ 太平 ⟹ 底被抬起来了（那和"太长"是同一件事）。
    // ⚠️⚠️ 输入电平 —— 判"柱子太长"是系统音量还是我们的实现。
    // 真 WE 预览图反解 magnitude 1.2-2.0，我们 2.8-12 ⟹ 差 12dB，
    // 而 12dB = 音量差 4 倍 ⟹ 完全可能是作者录预览图时音量小。
    + (frame.inputRMS !== undefined
      ? `<br>输入电平 RMS <b>${frame.inputRMS}</b>（${frame.inputDbfs} dBFS）`
        + `${frame.inputRMS > 0.25
          ? ' ⚠️ 音量很大 ⟹ 柱子长可能是音量，不是实现'
          : (frame.inputRMS > 0.02
            ? ' ✅ 正常听感音量 ⟹ 柱子长就是我们的实现偏大'
            : ' ⚠️ 几乎没有声音 —— 是不是没在放歌')}`
      : '')
    // ⚠️ 帧节奏 —— 判"柱子突兀的长"是不是 push 模型的批大小抖动。
    // WE 是 pull 模型（渲染循环主动读）⟹ 节奏恒定；
    // 我们是 push（有多少发多少）⟹ 一次回调连发多帧时 movetowards 连做多次
    // 而时间没走 ⟹ 平滑速度漂，且前面那些帧被 PWCircle 的重绘覆盖 = 等效跳帧。
    // **孤峰**（比左右邻居高 30% 以上）—— 用户 0.9.16 报的「突兀的高、像噪点」。
    //
    // 为什么要报"在 60 帧里出现几次"而不只报位置：
    //   每帧都在同一段 ⟹ **结构性**问题（我们这一层的 bug）
    //   位置乱跳       ⟹ 音乐本身的瞬态（WE 也一样，不该改）
    // 那两个结论一个要改代码、一个不能改，而只看一帧分不出来。
    // ⚠️⚠️ **「圆环左侧能归零、右侧常驻」是可预期的，不是 bug。**
    //
    // 用户 0.9.18 的观察，算出来是这样（镜像布局下段→band 的映射）：
    //   圆环**右侧**（12点→3点→6点）= 段 90-127 + 0-30 = **band 0-37 = 低频**
    //   圆环**左侧**（6点→9点→12点）= 段 30-90        = **band 30-63 = 高频**
    //
    // ⟹ 「右侧常驻」= 低频常驻（鼓/贝斯几乎不断，且离 log10 地板远）
    //    「左侧能归零」= 高频归零（泛音时断时续，且贴着地板）
    // ⟹ 那是音乐能量分布 + log10 地板的必然，**WE 也一样**。
    //
    // ⚠️ 我曾据此怀疑"镜像布局是错的"（因为真 WE 预览图明显不对称，
    // 而镜像必然近似左右对称）—— 但用户同一轮实测「波浪壁纸展现更细腻了」
    // ⟹ 镜像 + 分声道的方向是对的 ⟹ 那个怀疑没有站住。
    + '<br><small>圆环右侧(12→3→6点)=低频 band 0-37，左侧(6→9→12点)=高频 band 30-63'
    + ' ⟹ 「右侧常驻、左侧能归零」是低频不断、高频贴地板，WE 也一样</small>'
    // 左右声道差 —— 判"分声道有没有真起作用"。
    // ⚠️ 这一行是「9 点方向两根等高最长柱子」那个修复的验收点：
    // band 63 写到段 63 **和段 64（相邻）**，而它加权 1.393（最大）
    // ⟹ 两路同一份数据时它们精确相等 ⟹ 折线上一个尖顶。
    // ⚠️⚠️ 阈值改了：原来写死 `> 0.005`，而**那个数我是拍的**。
    // 用户 0.9.18 实测左右差在 **0.001 附近徘徊** ⟹ 正好卡在阈值边上
    // ⟹ 同一行文案「一会说是立体声，一会说是单声道」。
    //
    // ⟹ 判据换成**和信号本身的比例**：左右差要和平均幅度比，
    //    绝对值没有意义（音量小的时候差自然也小）。
    //    差 / 平均 > 1% ⟹ 立体声（那个比例足以让段 63/64 不等高）
    + (frame.channelDiff !== undefined
      ? (() => {
        const rel = frame.mean > 0 ? frame.channelDiff / frame.mean : 0;
        return `<br>左右声道差 <b>${frame.channelDiff}</b>`
          + `（占平均幅度 ${(rel * 100).toFixed(1)}%）`
          + `${rel > 0.01
            ? ' ✅ 有立体声差异 ⟹ 段 63/64 不再等高'
            : ' ⚠️ 两路几乎一样 ⟹ 段 63/64 仍然近似等高。'
              + '若音源本来是单声道，**那不是 bug**（WE 也一样）'}`;
      })()
      : '')
    + (frame.spikeProfile
      ? `<br>孤峰：<b>${frame.spikeProfile.count}</b> 个（比邻居高 30%+）`
        + (frame.spikeProfile.top.length
          ? `　最常出现：${frame.spikeProfile.top.map(
            (t) => `第${t.seg}段(${t.n}/${frame.spikeProfile.frames}帧)`,
          ).join('　')}`
          : '')
        + `${frame.spikeProfile.sticky
          ? ' ⚠️ 固定在同几段 ⟹ 结构性问题，是我们这层'
          : ' ✅ 位置在变 ⟹ 音乐本身的瞬态（WE 也一样）'}`
      : '')
    + (frame.rhythm
      ? `<br>帧节奏：一次回调发多帧的比例 <b>${frame.rhythm.multiPct}%</b>`
        + `（最多 ${frame.rhythm.max} 帧）　每批采样 ${frame.rhythm.batchAvg}`
        + `（最大 ${frame.rhythm.batchMax}）`
        + `${frame.rhythm.multiPct < 2
          ? ' ✅ 节奏稳 ⟹ 突兀的柱子不是这个原因'
          : ' ⚠️ 连发多帧 ⟹ 平滑速度随批大小漂（那会让柱子忽长忽短）'}`
      : '')
    + (frame.dynRange !== undefined
      ? `<br>动态范围 <b>${frame.dynRange}</b> 倍（真 WE 预览图约 4.4 倍）`
        + `${frame.dynRange >= 3.5
          ? ' ✅ 有层次'
          : ' ⚠️ 太平 —— 底被抬起来了，柱子会显得又长又齐'}`
        // ⚠️⚠️ **「柱子突兀的长」和「整体太长」是同一个根因** —— 算术如下：
        //
        // 相邻段隔 stride 2 = **94Hz**，而音乐里相邻 94Hz 的能量差 2 倍是常态
        //（一个泛音峰的边缘）⟹ **WE 也是 stride 2，所以它一样有这种落差**。
        //
        // 差别只在幅度：真 WE 的 0.045 vs 0.02 = **8px vs 4px**（看不出）；
        // 我们的 0.736 vs 0.367 = **132px vs 66px**（一眼看出）。
        //
        // ⚠️ 而 PWCircle 自己的平滑（`w2 = waveArr[i]*0.75; w1 = max(arr[i], w2)`）
        // 是**时间**平滑（让柱子下落变慢），**不会让相邻柱子接近** ——
        // 所以"加空间平滑"是错的方向，那会把真实的频谱结构抹掉。
        + '<br><small>相邻段隔 94Hz（stride 2，WE 原值）⟹ 相邻柱子差 2 倍是音乐常态，'
        + 'WE 也一样。「突兀的长」和「整体太长」是同一个根因：幅度偏大把落差放大成像素。'
        + '⟹ 看上面那行 RMS 决定该不该降</small>'
      : '')
    // ⚠️ 按钟点报 —— 用户十几轮都在用钟表描述，而我一直报段号，
    // 两边说的不是同一种坐标，每次都要换算（而我换算错过好几次）。
    + (frame.clock ? `<br><b>按钟点</b>（你看到的位置）：<br>`
      + `<span style="font-family:ui-monospace;font-size:10px">`
      + frame.clock.map((c) => {
        const dead = c.peak < 0.05 ? ' ⚠️' : '';
        return `${c.h}点 ${c.mean}/${c.peak}${dead}`;
      }).join('　') + '</span>' : '')
    + `<br>最大值在第 <b>${frame.peakAt}</b> 段`
    // ⚠️ 尖刺 —— "很多个和周围高度差很大的柱子"的量化。
    // 用户报那是**共性问题**（两个壁纸都有）⟹ 只能来自我们发的数据。
    // 报出"哪几段跳变最大 + 它前后的值"，那能直接指出是哪些段不对。
    + (frame.spikes ? `<br>平均跳变 ${frame.avgJump}　最大跳变的段：`
      + frame.spikes.map((s) => `<b>[${s.i}]</b> ${s.prev}→${s.cur}`).join('　') : '')
    // ⚠️ 单段扫描时这个数应该跟着扫描段号走 —— 那是"扫描真的生效了"的直接证据。
    + `<br><span style="font-family:ui-monospace;font-size:10px">`
    + frame.samples.map((s) => (s.i === frame.peakAt
      ? `<b>[${s.i}] ${s.v}</b>` : `[${s.i}] ${s.v}`)).join('　')
    + '</span>'
    + advice;
  node.hidden = false;
}

function renderAudioStatus(audio) {
  const node = document.getElementById('we-audio-state');
  if (!node) return;
  if (!audio) {
    node.textContent = (config.we && config.we.audioSource === 'off')
      ? '音频已关闭' : '还没有音频状态';
    return;
  }
  node.innerHTML = audio.ok
    ? `✅ ${audio.text}`
    : `<span class="warn">${audio.text}</span>${audio.detail ? '\n' + audio.detail : ''}`;
}

// 控件从 project.json 自动生成 —— 不给每个壁纸手写一遍 UI。
// 这样支持的不是"这一个壁纸"，是任意 WE 网页壁纸。
async function renderWEControls() {
  const host = document.getElementById('we-controls');
  if (!host) return;
  const result = await window.gw.weControls();
  if (!result.ok || !result.controls.length) {
    host.innerHTML = '<span class="hint">装载壁纸后，这里会按它的 project.json 自动生成。</span>';
    return;
  }
  host.innerHTML = '';

  // 当前值（用户改过的优先）。渲染每一行要用。
  const values = {};
  for (const c of result.controls) {
    values[c.key] = c.key in result.overrides ? result.overrides[c.key] : c.value;
  }

  // ⚠️⚠️ 按 condition 过滤。**这是"看不到属性"的根因修复。**
  //
  // 用户报「没有看到你说的这些属性」，而他贴的面板输出里「音频样式」「音频方向」
  //「可视化音频」各出现**两次** —— 那是 PWCircle 和 PWLine 各有一套同名控件。
  //
  // 真实数据：`showCircle` 的 condition 是 `visual_audio_model.value == 1`，
  // `PWLineShow` 是 `== 2`。默认 1（圆环）⟹ PWLine 那 20 个本该隐藏。
  // 而我全都显示了 ⟹ 13 组重名 ⟹ 属性在，但埋在一堆同名项里找不到。
  //
  // 过滤后：165 → 67 个，重名从 13 组降到 1 组（实测数据）。
  // ⚠️ 过滤在**主进程**做（那边有 we-host.js，是 condition 求值的单一来源）——
  // 面板加载不了 we-host，而在这里重写一份求值就是第二份知识，
  // 那个形状我在本项目栽过（音源列表、支持类型列表）。
  const visible = result.controls.filter((c) => c.visible !== false);

  let lastWasGroup = false;
  for (const control of visible) {
    // 分组标题：project.json 里 type=text 的项。我原来把它们当装饰扔了，
    // 而作者用它们分段（「----------完美壁纸圆环(PWCircle)----------」）。
    if (control.type === 'group') {
      const h = document.createElement('div');
      h.className = 'we-group';
      h.textContent = control.label;
      host.appendChild(h);
      lastWasGroup = true;
      continue;
    }
    lastWasGroup = false;
    const value = values[control.key];
    const row = document.createElement('div');
    row.className = 'we-row';

    const label = document.createElement('label');
    label.textContent = control.label;
    row.appendChild(label);

    if (control.type === 'bool') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!value;
      input.onchange = async () => {
        await window.gw.weSetProperty(control.key, input.checked);
        // ⚠️ 改一个属性可能让别的控件出现/消失（condition 依赖它）——
        // 比如把 visual_audio_model 从"圆环"改成"直线"，整段控件都要换。
        renderWEControls();
      };
      row.appendChild(input);
      row.appendChild(document.createElement('span'));   // 占住第三列，别让网格错位
    } else if (control.type === 'combo') {
      const select = document.createElement('select');
      for (const option of control.options || []) {
        const el = document.createElement('option');
        el.value = String(option.value);
        el.textContent = option.label;
        if (String(option.value) === String(value)) el.selected = true;
        select.appendChild(el);
      }
      select.onchange = () => {
        // ⚠️ option 的 value 在 DOM 里一律是字符串，但壁纸的 combo 值可能是数字
        // （样本的 gridSize 是 120/160/320…）。原样发字符串过去，壁纸拿它当数字用
        // 会得到 NaN —— 而那是静默的。所以按原始类型还原。
        const original = (control.options || [])
          .find((o) => String(o.value) === select.value);
        window.gw.weSetProperty(control.key, original ? original.value : select.value);
      };
      row.appendChild(select);
      row.appendChild(document.createElement('span'));
    } else if (control.type === 'slider') {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = control.min;
      input.max = control.max;
      input.step = control.step;
      input.value = value;
      const readout = document.createElement('span');
      readout.className = 'val';
      readout.textContent = value;
      input.oninput = () => {
        readout.textContent = input.value;
        window.gw.weSetProperty(control.key, Number(input.value));
      };
      row.appendChild(input);
      row.appendChild(readout);
    } else {
      // color 之类：原样文本编辑。样本的 color 值是 "r g b" 空格分隔的 0..1，
      // 不是 hex —— 用 color picker 会需要来回转换，先给文本框。
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value === undefined ? '' : String(value);
      input.onchange = () => window.gw.weSetProperty(control.key, input.value);
      row.appendChild(input);
      row.appendChild(document.createElement('span'));
    }
    host.appendChild(row);
  }
}

document.getElementById('we-pick').onclick = async () => {
  const result = await window.gw.wePick();
  if (!result.ok && result.error) {
    document.getElementById('we-state').innerHTML = `<span class="warn">${result.error}</span>`;
    return;
  }
  renderWEStatus();
};

document.getElementById('we-clear').onclick = async () => {
  await window.gw.weClear();
  renderWEStatus();
};

// ---------------------------------------------------------------------------
// 创意工坊
// ---------------------------------------------------------------------------

const wsState = document.getElementById('ws-state');

// 用户名/密码/Guard 码改了就存。⚠️ 不做"保存"按钮：那会让人以为填完不点就没生效，
// 而下载失败时又多一个可疑原因。
for (const [id, key] of [['ws-user', 'username'], ['ws-pass', 'password'], ['ws-guard', 'guardCode']]) {
  document.getElementById(id).onchange = (e) => {
    window.gw.workshopSetSteam({ [key]: e.target.value || null });
  };
}

// 先看预览再决定装不装。
//
// ⚠️ 这一步是补一个产品缺口：我原来只做了"填 ID → 下载"，而那等于把命令行搬进 GUI。
// 工坊的本质是浏览，没有预览图就没法挑。而且类型在这里就能看到 ⟹ scene 类可以在
// 下载几百 MB 之前就说清"装了也只能看静态图"。
const peekCard = document.getElementById('ws-peek-card');

function renderPeek(item) {
  peekCard.innerHTML = '';
  peekCard.className = 'ws-card on';
  if (!item.ok) {
    peekCard.innerHTML = `<div class="meta"><span class="warn">${item.reason}</span></div>`;
    return;
  }

  if (item.preview) {
    const img = document.createElement('img');
    img.src = item.preview;
    // ⚠️ 预览图加载失败不能让卡片塌掉 —— 那会看起来像"这个壁纸有问题"，
    // 而实际上只是图挂了（Steam 的 CDN 在国内经常要代理）。
    img.onerror = () => { img.style.display = 'none'; };
    peekCard.appendChild(img);
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  // ⚠️ 三种情况要分开说，因为用户据此做的决定不同：
  //   作者标了 tag      → 确定的，可以直接判断
  //   我们从文件名推的  → 大概，要说明是推断
  //   什么线索都没有    → 说清"下了才知道"，而不是干巴巴一句"未标注"
  //（"未标注"是用户实测看到的原话 —— 那时候他只能靠猜要不要下。）
  let typeText;
  if (item.type && item.typeSource === 'tag') {
    typeText = `${item.type}${item.supported ? ' · 能跑' : ' · 暂不支持'}`;
  } else if (item.type) {
    typeText = `看起来是 ${item.type}（从文件名 ${item.filename} 推的）`
      + `${item.supported ? ' · 应该能跑' : ' · 大概不支持'}`;
  } else {
    typeText = '作者没标类型 —— 下载后才知道是哪种（我们会自动认格式）';
  }
  meta.innerHTML = `<b>${item.title}</b>`
    + `<span class="sub">${typeText} · ${W_FORMAT(item.sizeBytes)} · ${item.subscriptions} 人订阅</span>`;
  // 在下载之前就说清后果。⚠️ 让用户下完几百 MB 才发现装不了，比一开始说清糟得多。
  //
  // ⚠️ 这里原来是个两分支三元表达式（不是 scene 就说 application），于是 image
  // 被报成"Windows 程序" —— 少一个分支的后果不是少说一句，是**说错**。
  // 现在理由由主进程按类型查表给出（we-host 的 TYPE_REFUSALS），加类型不会漏。
  if (item.refusal) {
    meta.innerHTML += `<span class="warn">${item.refusal}</span>`;
  }
  peekCard.appendChild(meta);

  const acts = document.createElement('div');
  acts.className = 'acts';
  const go = document.createElement('button');
  go.type = 'button';
  go.className = item.supported ? 'act primary' : 'act';
  go.textContent = item.supported ? '下载并装载' : '仍要下载';
  go.onclick = () => startDownload(item.id);
  acts.appendChild(go);
  peekCard.appendChild(acts);
}

const W_FORMAT = (bytes) => {
  const n = Number(bytes) || 0;
  if (n <= 0) return '大小未知';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

document.getElementById('ws-peek').onclick = async () => {
  const input = document.getElementById('ws-id').value;
  peekCard.className = 'ws-card on';
  peekCard.innerHTML = '<div class="meta">查询中…</div>';
  const result = await window.gw.workshopDetails(input);
  if (!result.ok) {
    peekCard.innerHTML = `<div class="meta"><span class="warn">${result.error}</span>`
      + `${result.hint ? `\n${result.hint}` : ''}</div>`;
    return;
  }
  if (!result.items.length) {
    peekCard.innerHTML = '<div class="meta">没查到这个物品</div>';
    return;
  }
  renderPeek(result.items[0]);
};

// ---------------------------------------------------------------------------
// 浏览创意工坊（仿 Steam 排版）
// ---------------------------------------------------------------------------
//
// ⚠️ 不支持的类型（scene / application）**不隐藏** —— 用户明确说过
// "虽然有些类型无法支持现在，但是预览图是可以看到的吧"。
// 隐藏它们会让人以为工坊里没东西；标出来才是诚实的。
// ⚠️ tags 初值由 meta.defaultTags 填（只勾「全年龄」）—— 不在这里写死，
// 因为默认值的依据在 workshop.js（唯一来源）。
const browse = { sort: 'trending', tags: [], page: 1, total: 0, perPage: 30 };

function renderBrowseControls(meta) {
  const sortHost = document.getElementById('br-sorts');
  sortHost.className = 'we-src';
  sortHost.innerHTML = '';
  for (const s of meta.sorts) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = s.id === browse.sort ? 'on' : '';
    b.textContent = s.label;
    b.onclick = () => { browse.sort = s.id; browse.page = 1; runBrowse(); };
    sortHost.appendChild(b);
  }

  // 四组筛选，按 meta.filterGroups 渲染 —— 加一组不用改这里。
  const host = document.getElementById('br-filters');
  host.innerHTML = '';
  for (const group of meta.filterGroups || []) {
    const row = document.createElement('div');
    row.className = 'br-group';

    const label = document.createElement('span');
    label.className = 'br-group-label';
    label.textContent = group.label;
    row.appendChild(label);

    const btns = document.createElement('div');
    btns.className = 'we-src';
    for (const t of group.tags) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = browse.tags.includes(t.id) ? 'on' : '';
      // ⚠️ 类型那组标出能不能跑 —— 那样点进去之前就知道，
      // 而不是筛出一屏全是"放不了"。
      b.textContent = t.supported === false && group.id === 'type'
        ? `${t.label}（放不了）` : t.label;
      // 成人内容那两项给个提示，免得误点
      if (group.id === 'age' && !t.defaultOn) b.title = '默认不勾';
      b.onclick = () => {
        browse.tags = browse.tags.includes(t.id)
          ? browse.tags.filter((x) => x !== t.id) : [...browse.tags, t.id];
        browse.page = 1;
        renderBrowseControls(meta);
        runBrowse();
      };
      btns.appendChild(b);
    }
    row.appendChild(btns);
    host.appendChild(row);
  }
}

// 一张工坊卡片。仿 Steam：预览图 + 标题 + 类型 + 订阅数。
function workshopCard(item, onPick) {
  const card = document.createElement('div');
  card.className = 'ws-item';
  card.title = item.title || item.id;

  const img = document.createElement('img');
  if (item.preview) img.src = item.preview;
  // ⚠️ 预览图挂了不能让卡片塌掉 —— Steam 的 CDN 在国内常要代理，
  // 而"图没出来"和"这个壁纸有问题"是两件事。
  img.onerror = () => { img.style.display = 'none'; };
  card.appendChild(img);

  const nm = document.createElement('div');
  nm.className = 'nm';
  nm.textContent = item.title || item.id;
  card.appendChild(nm);

  const tp = document.createElement('div');
  tp.className = item.supported ? 'tp' : 'tp no';
  const parts = [];
  if (item.type) parts.push(item.supported ? item.type : `${item.type}·放不了`);
  else parts.push('类型未标');
  if (item.subscriptions) parts.push(`${item.subscriptions} 订阅`);
  if (item.sizeBytes) parts.push(W_FORMAT(item.sizeBytes));
  tp.textContent = parts.join(' · ');
  card.appendChild(tp);

  // ⚠️ 这里原来给每张卡片加了「📁 打开目录」——**去掉了**。
  //
  // 用户报（2026-07-31）：「不是每个壁纸都要显示一下目录的。就保留
  // 我的壁纸目录：/Users/moon/Documents/GestureWall/Wallpapers 这个就行」。
  //
  // 他说得对：**一个入口就够**。壁纸都在同一个目录树下，进去了就能看到全部 ——
  // 每张卡片一个按钮是把"一次操作"重复了 N 遍，而 N 张卡片上的 N 个按钮
  // 只会让界面吵。
  // ⟹ 打开目录的入口留在「存储目录」那块（每个根目录一个）。

  card.onclick = () => onPick(item);
  return card;
}

async function runBrowse() {
  const state = document.getElementById('br-state');
  const grid = document.getElementById('br-grid');
  state.textContent = '查询中…';
  grid.innerHTML = '';

  const result = await window.gw.workshopBrowse({
    query: document.getElementById('br-q').value,
    sort: browse.sort, tags: browse.tags,
    page: browse.page, perPage: browse.perPage,
  });

  if (!result.ok) {
    state.innerHTML = `<span class="warn">${result.error}</span>`
      + (result.hint ? `\n${result.hint}` : '');
    // 没 key 时把那块展开 —— 否则用户看到错误但找不到在哪配。
    if (result.needsKey) document.getElementById('br-key-box').open = true;
    document.getElementById('br-pager').style.display = 'none';
    return;
  }

  browse.total = result.total;
  state.textContent = result.items.length
    ? `共 ${result.total} 个，第 ${browse.page} 页`
    : '这一页没东西（换个搜索词或排序试试）';

  for (const item of result.items) {
    grid.appendChild(workshopCard(item, (picked) => {
      // 点卡片 = 填到"按 ID 装载"那栏并看详情，不直接下载 ——
      // ⚠️ 直接下几百 MB 会让误点变成很贵的操作。
      document.getElementById('ws-id').value = picked.id;
      renderPeek({ ...picked, ok: true });
      document.getElementById('ws-id').scrollIntoView({ behavior: 'smooth' });
    }));
  }

  const pages = Math.ceil(result.total / browse.perPage) || 1;
  document.getElementById('br-pager').style.display = result.items.length ? 'flex' : 'none';
  document.getElementById('br-page').textContent = `${browse.page} / ${pages}`;
  document.getElementById('br-prev').disabled = browse.page <= 1;
  document.getElementById('br-next').disabled = browse.page >= pages;
}

document.getElementById('br-go').onclick = () => { browse.page = 1; runBrowse(); };
document.getElementById('br-q').onkeydown = (e) => {
  if (e.key === 'Enter') { browse.page = 1; runBrowse(); }
};
document.getElementById('br-prev').onclick = () => { browse.page -= 1; runBrowse(); };
document.getElementById('br-next').onclick = () => { browse.page += 1; runBrowse(); };
document.getElementById('br-key-save').onclick = async () => {
  await window.gw.workshopSetKey(document.getElementById('br-key').value.trim());
  document.getElementById('br-key').value = '';
  runBrowse();
};

// ⚠️ try 住：这是我加的初始化，它抛了不该影响手势那些开关。
try {
window.gw.workshopBrowseMeta().then((meta) => {
  if (!meta) return;
  // 默认只勾「全年龄」。⚠️ 浏览工坊时默认不该出现成人内容，
  // 而"默认全开让用户自己关"在这件事上是错的默认值。
  if (!browse.tags.length) browse.tags = meta.defaultTags || [];
  renderBrowseControls(meta);
  document.getElementById('br-key-hint').textContent = meta.keyHint;
  if (!meta.hasKey) {
    document.getElementById('br-state').innerHTML =
      '<span class="hint">配了 API key 才能浏览（下面那块）。'
      + '不配也能用 —— 贴工坊链接到下面「按 ID 装载」。</span>';
  } else {
    runBrowse();
  }
}).catch(() => {});
} catch (error) { console.error('[dashboard] 工坊浏览初始化失败：', error); }

// ---------------------------------------------------------------------------
// 我的壁纸
// ---------------------------------------------------------------------------
//
// 用户的原话："不知道从哪里得到的壁纸，反正只要在指定的壁纸存储目录中有的壁纸
// 就在这里" ⟹ 判据是目录里有 project.json，不是"我们下载过"。
async function renderMine() {
  const state = document.getElementById('mine-state');
  const grid = document.getElementById('mine-grid');
  const result = await window.gw.workshopLocal();
  // ⚠️ 存下扫描结果，给 renderMineDirs 用 —— 那是"目录到底扫了哪儿"的唯一来源。
  // 存下来而不是让它重扫：扫描要遍历磁盘，而它在每次增删目录后都会跑。
  lastScanned = result.scanned || null;
  renderMineDirs();

  if (!result.ok || !result.items.length) {
    grid.innerHTML = '';
    // ⚠️ 空列表时报出扫过哪些目录 —— 否则用户不知道我们找过哪儿，
    // 而他可能把壁纸放在别的地方。
    // ⚠️ "一个都没找到"是最需要"打开目录"的时刻 —— 用户要去里面放东西。
    // 只报路径让他自己去 Finder 粘贴，那是把最后一步留给了他。
    state.innerHTML = '一个壁纸都没找到。'
      + '<div class="bar-row" style="margin-top:6px">'
      + '<button class="act" id="mine-open-ours" type="button">打开我的壁纸目录</button>'
      + '<span class="hint">把壁纸放进去（每个壁纸一个子目录，里面要有 project.json）</span>'
      + '</div>'
      + '<div class="hint" style="margin-top:6px">扫过这些目录：\n'
      + (result.scannedRoots || []).join('\n') + '</div>';
    // ⚠️ innerHTML 重建了节点 ⟹ 每次都要重新绑（绑在旧节点上等于没绑）。
    const openOurs = document.getElementById('mine-open-ours');
    if (openOurs) {
      openOurs.onclick = async () => {
        // 不传路径 = 打开我们自己的目录（主进程会顺手建出来 + 放说明文件）。
        const out = await window.gw.revealWallpaperDir();
        if (!out.ok) state.innerHTML = `<span class="warn">${out.error}</span>`;
      };
    }
    return;
  }

  const usable = result.items.filter((i) => i.supported).length;
  state.textContent = `${result.items.length} 个壁纸，其中 ${usable} 个能跑`
    + (result.truncated ? '（超过 500 个，只列了前 500）' : '');

  grid.innerHTML = '';
  for (const item of result.items) {
    const card = workshopCard({
      ...item,
      // ⚠️ item.dir 透传下去 —— 卡片靠它决定要不要显示「打开目录」。
      // 本地文件走 file://（自定义 protocol 只服务当前装载的那个）
      preview: item.preview ? `file://${encodeURI(item.preview)}` : null,
    }, async () => {
      if (item.broken) return;
      const out = await window.gw.workshopLoadLocal(item.dir);
      if (!out.ok) state.innerHTML = `<span class="warn">${out.error}</span>`;
      renderWEStatus();
      renderMine();
    });
    // 当前装载的那个标出来 —— 否则一屏缩略图里认不出哪个在用。
    if (item.active) card.style.borderColor = 'var(--accent)';
    grid.appendChild(card);
  }
}

// 最近一次扫描的结果（哪些目录、在不在、找到几个）。renderMine 拿到就存下来。
//
// ⚠️ 用模块级变量而不是每次重新扫 —— 扫描要遍历磁盘，而这个函数在
// 每次增删目录后都会跑。
let lastScanned = null;

function renderMineDirs() {
  const host = document.getElementById('mine-dirs');
  const dirs = (config.we && config.we.libraryDirs) || [];
  host.innerHTML = '';

  // ⚠️ **我们自己的壁纸目录放最前面，而且常驻显示。**
  //
  // 用户要的：「你的默认壁纸目录改成标准的壁纸软件的目录层级」+「要能够点开」。
  // ⟹ "我的壁纸放哪"这个问题必须一眼看到答案，而不是等到"一个都没找到"时才出现。
  window.gw.ourWallpaperDir().then((res) => {
    if (!res || !res.ok) return;
    const box = document.createElement('div');
    box.className = 'bar-row';
    box.style.cssText = 'align-items:baseline;margin-bottom:8px';
    const label = document.createElement('span');
    label.className = 'hint';
    label.style.cssText = 'font-family:ui-monospace,Menlo,monospace;font-size:11px;'
      + 'user-select:text;flex:1';
    label.textContent = `我的壁纸目录：${res.dir}`;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'act';
    open.textContent = '打开';
    open.onclick = () => window.gw.revealWallpaperDir(res.dir);
    box.append(label, open);
    // ⚠️ 插到最前面而不是 append —— 这个函数是异步回调，
    // 直接 append 会让它落在已经渲染好的目录列表后面（顺序随机）。
    host.insertBefore(box, host.firstChild);
  });

  // ⚠️ **然后是自动扫的目录。**
  //
  // 用户报：面板只写「还没加自定义目录（steamcmd 那个是自动扫的）」——
  // 而"那个"是哪个路径、存不存在、找到几个，一个字都没说。
  // ⟹「我的壁纸是空的」时，用户没法判断是"目录不对"还是"目录对但里面没东西"，
  // 而那两件事的下一步完全不同（改路径 vs 去下壁纸）。
  const auto = (lastScanned || []).filter((x) => x.auto);
  if (auto.length) {
    const title = document.createElement('div');
    title.className = 'hint';
    title.style.marginBottom = '4px';
    title.textContent = '自动扫描的目录（steamcmd 下载的壁纸在这里）：';
    host.appendChild(title);
    for (const item of auto) {
      const row = document.createElement('div');
      row.className = 'bar-row';
      row.style.cssText = 'align-items:baseline;margin:2px 0 2px 8px';
      const text = document.createElement('span');
      text.className = 'hint';
      text.style.cssText = 'font-family:ui-monospace,Menlo,monospace;font-size:11px;'
        + 'user-select:text;flex:1';
      // 三件事一行说完：路径、在不在、找到几个。
      const mark = item.exists
        ? (item.found ? `✅ ${item.found} 个壁纸` : '目录在，但里面没有壁纸')
        : '（这个目录不存在 —— 正常，装了 Steam 才会有）';
      text.textContent = `${item.path}  ${mark}`;
      if (item.exists && !item.found) text.style.color = 'var(--warn, #c98)';
      row.appendChild(text);
      // ⚠️ **能点开。** 用户要的：「我要能进到那个目录，看到我的壁纸文件」。
      // 只有存在的目录才给按钮 —— 打开一个不存在的目录只会弹错误。
      if (item.exists) {
        const open = document.createElement('button');
        open.type = 'button';
        open.textContent = '打开';
        open.title = '在 Finder 里打开这个目录';
        open.onclick = () => window.gw.revealWallpaperDir(item.path);
        row.appendChild(open);
      }
      host.appendChild(row);
    }
  }

  const custom = document.createElement('div');
  custom.className = 'hint';
  custom.style.margin = '10px 0 4px';
  custom.textContent = dirs.length ? '我自己加的目录：' : '还没加自定义目录。';
  host.appendChild(custom);

  if (!dirs.length) {
    const tip = document.createElement('div');
    tip.className = 'hint';
    tip.style.cssText = 'margin-left:8px;font-size:11px';
    // ⚠️ 这两条约束是用户会撞到的，说在前面比让他试出来好。
    tip.innerHTML = '⚠️ 每个<b>子目录</b>要是一个壁纸（里面有 <code>project.json</code>）'
      + '—— 直接放一堆 mp4 是认不出来的。'
      + '<br>⚠️ 最多扫 2 层深、500 个 —— 再多会让面板卡住。';
    host.appendChild(tip);
    return;
  }
  for (const dir of dirs) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    const label = document.createElement('span');
    label.className = 'hint';
    label.textContent = dir;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'act danger';
    del.textContent = '移除';
    del.onclick = async () => {
      await window.gw.workshopRemoveDir(dir);
      // ⚠️ 只调 renderMine() —— 它自己会调 renderMineDirs（并刷新 lastScanned）。
      // 两个都调会渲染两遍，而且中间那次用的是**过期的** lastScanned。
      //
      // ⚠️ 这里是 onclick 里，所以 renderMine → renderMineDirs → (这个函数只是绑定
      // 不执行) 不构成同步递归。但那是"恰好"—— 别在 renderMineDirs 的**函数体**里
      // 调 renderMine()，那会真的死循环。
      renderMine();
    };
    row.append(label, del);
    host.appendChild(row);
  }
}

document.getElementById('mine-refresh').onclick = renderMine;
document.getElementById('mine-add-dir').onclick = async () => {
  const out = await window.gw.workshopAddDir();
  if (out.ok) { renderMineDirs(); renderMine(); }
};

// 已下载的列表 —— 下过的东西要能重新装载，而不是每次重填 ID。


async function startDownload(id) {
  wsState.textContent = '开始…';
  const result = await window.gw.workshopDownload(id);
  if (result.ok) {
    wsState.innerHTML = `✅ 装载成功\n${result.dir}`;
    renderWEStatus();
    return;
  }
  let html = `<span class="warn">${result.error}</span>`;
  if (result.searched && result.searched.length) {
    html += `\n找过这些路径：\n${result.searched.join('\n')}`;
  }
  if (result.tail && result.tail.length) {
    html += `\n\nsteamcmd 最后几行：\n${result.tail.slice(-8).join('\n')}`;
  }
  wsState.innerHTML = html;
}

// 进度实时显示。⚠️ 没有它，下载大壁纸时界面一动不动，和卡死分不清。
window.gw.onWorkshopProgress((hit) => {
  if (!hit) return;
  wsState.textContent = hit.text;
});

// 启动时探一下 steamcmd 在不在 —— 提前说比等下载失败再说好。
window.gw.workshopProbe().then((probe) => {
  if (!probe) return;
  if (!probe.installed) {
    wsState.innerHTML = `<span class="warn">${probe.hint}</span>`;
    return;
  }
  document.getElementById('ws-user').value = probe.username || '';
  wsState.textContent = `steamcmd 就绪：${probe.steamcmd}`;
}).catch(() => {});

// ---------------------------------------------------------------------------
// 诊断报告
// ---------------------------------------------------------------------------

const diagState = document.getElementById('diag-state');

document.getElementById('diag-export').onclick = async () => {
  const result = await window.gw.exportDiagnostics();
  diagState.innerHTML = result.ok
    ? `✅ 已导出\n${result.file}\n把这个文件发过来`
    : `<span class="warn">导出失败：${result.error || '未知'}</span>`;
};

document.getElementById('diag-reveal').onclick = () => window.gw.revealDiagnostics();

// 视频播放状态。⚠️ 这是"放了但你看不见"的唯一证据 —— 有分辨率和时间在涨，
// 就说明解码正常、问题在窗口层级或遮挡，那和"放不了"是两种完全不同的修法。
window.gw.onVideoStatus((status) => {
  if (!status) return;
  const node = document.getElementById('we-state');
  if (!node) return;
  if (status.ok === false) {
    node.innerHTML = `<span class="warn">视频：${status.kind}</span>\n${status.hint || ''}`;
    return;
  }
  if (status.loading) return;
  // 图片/GIF 的状态：报出放大倍数，因为"糊"最常见的原因是源图太小。
  // ⚠️ 那和"我们渲染差"是两件事，不说清用户会归错因。
  if (status.kindLoaded === 'image') {
    const up = status.upscale;
    node.innerHTML = `🖼 图片已显示 ${status.width}×${status.height}`
      + (up && up > 1.8
        ? `\n⚠️ 被放大了 ${up} 倍（屏幕 ${status.screenWidth}px）—— 糊是因为源图小，`
          + `不是渲染问题。已改用 contain 保清晰度。`
        : '');
    return;
  }
  if (status.width) {
    node.innerHTML = `▶ 视频在放 ${status.currentTime}s`
      + `${status.duration ? ' / ' + status.duration + 's' : ''}`
      + `\n${status.width}×${status.height}（有分辨率 = 解码正常；`
      + `如果你看到的是黑屏，那是层级或遮挡问题，不是播放问题）`;
  }
});

// ⚠️ 面板重新获得焦点时刷新「我的壁纸」。
//
// 这是**比切页签更贴合真实动作**的时机：用户点「打开」进 Finder → 拖几个壁纸进去
// → 切回面板。那时候他期望看到新的壁纸，而不是再点一次什么东西。
//
// ⚠️ 只在「我的壁纸」页签是当前页时才扫 —— 否则每次切回窗口都遍历一遍磁盘
//（Steam 那个目录 639MB），而用户可能只是回来看手势设置。
window.addEventListener('focus', () => {
  const mine = document.getElementById('tab-mine');
  if (mine && mine.classList.contains('on')) renderMine();
});

window.gw.onWeStatus(() => renderWEStatus());
// ⚠️ 订阅实际频谱 —— 没有它，"参数调多少"只能靠猜（我猜了三轮）。
if (window.gw.onWeAudioFrame) window.gw.onWeAudioFrame(renderAudioFrame);

// ⚠️ 面板打开时补发最后一次 FFT 自检。
//
// 自检只在音频 helper 启动时跑一次，而用户可能那时候还没打开面板
// ⟹ 那行就永远错过了（他实测撞到，还问"这个在哪里"）。
if (window.gw.weSelfTest) {
  window.gw.weSelfTest().then((r) => {
    if (!r || !r.ok || !r.test) return;
    const t = r.test;
    const ok = t.segsAboveQuarter >= 2 && t.segsAboveQuarter <= 8
      && Math.abs(t.peakSeg - t.expectSeg) <= 1;
    logLine('audio', `${ok ? '✅' : '⚠️'} FFT 自检（${t.tone}Hz）：`
      + `峰值第 ${t.peakSeg} 段（应 ${t.expectSeg}）　主瓣宽 ${t.segsAboveQuarter} 段`
      + `　邻域 ${(t.neighbors || []).map((v) => Number(v).toFixed(3)).join(' ')}`
      + (t.outsidePeak !== undefined
        ? `　主瓣外最大 ${Number(t.outsidePeak).toFixed(3)}(第${t.outsideAt}段)`
          + (t.outsidePeak > 0.2 ? ' ⚠️主瓣外有明显值⟹尖刺在分箱/平滑'
            : ' ✅主瓣外干净⟹尖刺来自音乐瞬态')
        : ''));
  }).catch(() => {});
}
// ⚠️ 闸门丢帧 —— 那说明有旧音源还在发。打包版没终端，只能在这里看。
if (window.gw.onWeAudioDrop) {
  window.gw.onWeAudioDrop((d) => {
    const node = document.getElementById('we-audio-frame');
    if (!node) return;
    const extra = document.createElement('div');
    extra.className = 'warn';
    extra.style.marginTop = '4px';
    extra.textContent = `⚠️ 闸门丢掉了 ${d.count} 帧：owner=${d.owner}，`
      + `而当前音源=${d.current} —— 旧音源的 helper 还在吐数据`;
    // 只留最后一条
    const old = node.querySelector('.warn');
    if (old) old.remove();
    node.appendChild(extra);
    node.hidden = false;
  });
}
window.gw.onWeAudioStatus((status) => renderAudioStatus(status));

// ⚠️ apply() 必须最先跑，而且不能被任何东西挡住。
//
// 它负责绑定**所有**开关（包括「开启摄像头手势」）。而这个文件顶层有很多初始化代码，
// 任何一处抛异常都会让它永远跑不到 —— 表现是"点开关完全没反应，也没报错"。
//
// 实测踩到：用户报"摄像头打不开、点了什么反应都没有"，而纯 main 是好的 ——
// 也就是我往顶层加的东西里有一处抛了，把 apply() 挡在后面。
//
// ⟹ 两条改动：① apply() 提到最前面 ② 我加的初始化各自 try 住，互不牵连。
window.gw.getConfig().then(apply).catch((error) => {
  // apply 自己抛的话开关全绑不上，那是最坏的情况 —— 必须能看见。
  console.error('[dashboard] apply() 失败，开关可能都没绑上：', error);
});
renderWEStatus();
