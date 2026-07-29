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

function renderLayers() {
  const host = document.getElementById('layers');
  host.innerHTML = '';
  for (const slot of Lib.SLOTS) {
    const filePath = config.layers[slot];
    const row = el('div', 'layer-row');
    const thumb = el('div', 'thumb');
    if (filePath) thumb.style.backgroundImage = `url("${fileUrl(filePath)}")`;
    const info = el('div');
    info.append(el('span', 'nm', SLOT_LABEL[slot].name));
    info.append(el('span', 'pth', filePath || SLOT_LABEL[slot].hint));
    const buttons = el('div');
    const pick = el('button', 'act', filePath ? '更换' : '选择');
    pick.onclick = () => window.gw.pickImage(slot);
    buttons.append(pick);
    if (filePath) {
      const clear = el('button', 'act danger', '清除');
      clear.onclick = () => window.gw.clearImage(slot);
      buttons.append(clear);
    }
    row.append(thumb, info, buttons);
    host.append(row);
  }
}

function renderSlots() {
  const host = document.getElementById('slots');
  host.innerHTML = '';
  const chosen = config.slots || {};
  const fallback = T.template(config.template).slots;
  for (const slot of Lib.SLOTS) {
    const wrap = el('div', 'slot');
    const head = el('div', 'slot-head');
    head.append(el('b', null, SLOT_LABEL[slot].name));
    head.append(el('span', null, '表现方式'));
    wrap.append(head);

    const grid = el('div', 'modules');
    const active = chosen[slot] || fallback[slot];
    for (const mod of Object.values(T.MODULES[slot])) {
      const card = el('div', `module${mod.id === active ? ' on' : ''}`);
      card.append(el('b', null, mod.label));
      card.append(el('span', null, mod.hint));
      card.onclick = () => window.gw.setConfig({ slots: { [slot]: mod.id } });
      grid.append(card);
    }
    wrap.append(grid);
    host.append(wrap);
  }
}

// 应用预设会改掉滑块背后的值，那时必须重建；普通拖动时不能重建，否则会把拖着的
// 滑块从手指下抽走。
let pendingPresetRefresh = false;

function renderPresets() {
  const host = document.getElementById('presets');
  const names = Object.keys(config.presets || {});
  host.innerHTML = '';
  if (!names.length) {
    host.append(el('p', 'hint', '还没有预设'));
    return;
  }
  for (const name of names) {
    const row = el('div', 'preset');
    row.append(el('span', null, name));
    const load = el('button', 'act', '应用');
    load.onclick = () => { pendingPresetRefresh = true; window.gw.loadPreset(name); };
    const remove = el('button', 'act danger', '删除');
    remove.onclick = () => window.gw.deletePreset(name);
    row.append(load, remove);
    host.append(row);
  }
}

// ---------------------------------------------------------------------------
// 图库分区
// ---------------------------------------------------------------------------
const SLOT_OPTIONS = [
  { value: 'any', label: '任意' },
  { value: 'background', label: '背景' },
  { value: 'subject', label: '主体' },
  { value: 'shard', label: '碎片' },
];

function renderGallery() {
  const host = document.getElementById('gallery');
  const items = config.library || [];
  host.innerHTML = '';
  document.getElementById('lib-empty').style.display = items.length ? 'none' : '';
  for (const item of items) {
    const card = el('div', `asset${item.missing ? ' missing' : ''}`);
    const pic = el('div', 'pic');
    if (!item.missing) pic.style.backgroundImage = `url("${fileUrl(item.path)}")`;
    card.append(pic);

    const meta = el('div', 'meta');
    meta.append(el('div', 'nm', item.name));

    const select = document.createElement('select');
    for (const option of SLOT_OPTIONS) {
      const node = document.createElement('option');
      node.value = option.value;
      node.textContent = option.label;
      if (option.value === item.slot) node.selected = true;
      select.append(node);
    }
    select.onchange = () => window.gw.librarySetSlot(item.id, select.value);
    meta.append(select);

    const row = el('div', 'row');
    // 只给已标注槽位的素材"用作"按钮：标着"任意"时我们不知道该放哪一层，
    // 而替用户猜会把主体塞进背景。
    if (item.slot !== 'any' && !item.missing) {
      const use = el('button', 'act', `用作${SLOT_LABEL[item.slot].name}`);
      use.onclick = () => window.gw.setLayer(item.slot, item.path);
      row.append(use);
    }
    const remove = el('button', 'act danger', '移除');
    remove.onclick = () => window.gw.libraryRemove(item.id);
    row.append(remove);
    meta.append(row);

    card.append(meta);
    host.append(card);
  }
}

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
    const node = document.getElementById('log');
    if (!node || !entry) return;
    const line = `[${entry.source || '?'}] ${entry.message}`;
    node.textContent = `${node.textContent}${node.textContent ? '\n' : ''}${line}`
      .split('\n').slice(-40).join('\n');
    node.scrollTop = node.scrollHeight;
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
      state.textContent = `已录制 · ${kind} · ${recorded.hands} 只手`
        + (recorded.keyframes ? ` · ${recorded.keyframes} 关键帧` : '')
        + (recorded.dynamic && recorded.law ? ` · 按${recorded.law === 'swipe' ? '挥动' : '倾斜'}判方向` : '');
      state.className = 'state ok';
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

// ---------------------------------------------------------------------------
// 系统分区
// ---------------------------------------------------------------------------
function renderStrategy() {
  const select = document.getElementById('strategy');
  if (!strategy || !strategy.all) return;
  select.innerHTML = strategy.all
    .map((s) => `<option value="${s.id}"${s.id === strategy.id ? ' selected' : ''}>${s.label}</option>`)
    .join('');
  select.onchange = () => window.gw.setStrategy(select.value);

  const note = document.getElementById('frame-note');
  if (!strategy.wanted || !strategy.got) { note.textContent = ''; return; }
  const w = strategy.wanted;
  const g = strategy.got;
  const dy = g.y - w.y;
  const dh = w.height - g.height;
  if (!dy && !dh && w.width === g.width) {
    note.innerHTML = `画面 ${g.width}×${g.height} <span class="ok">全屏 ✓</span>`;
  } else {
    note.innerHTML = `画面 ${g.width}×${g.height} <span class="warn">⚠️ 顶部差 ${dy}px 高度差 ${dh}px</span>`;
  }
}

function renderToggles() {
  const bind = (id, get_, set_) => {
    const node = document.getElementById(id);
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
  bind('music', () => config.music.enabled, (v) => window.gw.setConfig({ music: { enabled: v } }));
  bind('moodFromCover', () => config.music.moodFromCover,
    (v) => window.gw.setConfig({ music: { moodFromCover: v } }));
  bind('showHud', () => config.debug.showHud, (v) => window.gw.setConfig({ debug: { showHud: v } }));
}

// ---------------------------------------------------------------------------
// 渲染入口
// ---------------------------------------------------------------------------
let built = false;

function apply(next) {
  config = next;
  const t = T.template(config.template);
  document.getElementById('tpl-name').textContent = t.label;
  document.getElementById('tpl-hint').textContent = t.hint;
  renderLayers();
  renderSlots();
  renderPresets();
  renderGallery();
  renderGestureLead();
  renderRecordables();
  renderToggles();
  if (!built) {
    renderSliders('tuning', TUNING);
    renderSliders('musicTuning', MUSIC_TUNING);
    renderSliders('gestureTuning', GESTURE_TUNING);
    // 只接一次:按钮的 onclick 每次 apply 都重设是幂等的,但 onCaptureSaved 是订阅,
    // 重复订阅会让一次保存报好几遍。
    wireDiagnostics();
    refreshPointerHealth();
    built = true;
  } else if (pendingPresetRefresh) {
    pendingPresetRefresh = false;
    renderSliders('tuning', TUNING);
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
window.gw.onStrategy((s) => { strategy = s; renderStrategy(); });

window.gw.onSensorStatus((s) => {
  document.getElementById('live').textContent = s && s.text ? s.text : '—';
  // 摄像头被拒时也把授权按钮露出来 —— 和辅助功能同一个道理:说了缺什么就得给路径。
  if (s && s.denied) {
    const grants = document.getElementById('grant-row');
    if (grants) grants.hidden = false;
  }

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
        return `${p.action}${d} · ${p.why}`;
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
    state.textContent = p.countdown ? `${phase} ${p.countdown}` : `${phase}：${p.hint || ''}`;
    state.className = 'state ok';
  }
});

window.gw.onRecordingResult((r) => {
  recordingAction = null;
  const node = document.getElementById('live');
  if (r && r.ok) node.textContent = `✅ ${r.action} 录制成功`;
  else if (r && r.conflictWith) {
    node.textContent = `❌ 和「${T.ACTIONS[r.conflictWith] ? T.ACTIONS[r.conflictWith].label : r.conflictWith}」的手势太像（距离 ${r.distance}），换一个差别更大的`;
  } else if (r) node.textContent = `❌ ${r.error || '录制失败'}`;
  renderRecordables();
});

window.gw.onTrack((t) => {
  const node = document.getElementById('track');
  if (!t) {
    node.innerHTML = '<span class="warn">读不到正在播放的音乐</span>\n没装 media-control，或当前没有在放歌';
    return;
  }
  node.innerHTML = `♪ ${t.title || '?'} — ${t.artist || '?'}\n`
    + `${t.bundleIdentifier || ''}${t.artworkData ? ' · 有封面' : ' · 无封面（氛围用默认值）'}`;
});

document.getElementById('preset-save').onclick = async () => {
  const input = document.getElementById('preset-name');
  await window.gw.savePreset(input.value);
  input.value = '';
};

document.getElementById('lib-add').onclick = () => window.gw.libraryAdd();

window.gw.getConfig().then(apply);
