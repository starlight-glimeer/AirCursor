// Dashboard：四个分区（模板 / 图库 / 手势录制 / 壁纸与音乐）。
//
// 每个控件都直接写回主进程，主进程持久化并广播 —— 所以没有"应用"按钮可以忘记按，
// 壁纸也不用被单独通知。
const T = window.GestureWallTemplates;
const Lib = window.GestureWallLibrary;

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

function renderContinuous() {
  const host = document.getElementById('continuous');
  host.innerHTML = '';
  const actions = T.actionsOf(config.template, config.proTier)
    .filter((a) => a.kind === 'continuous');
  for (const action of actions) {
    const row = el('div', 'rec');
    const info = el('div');
    info.append(el('span', 'nm', action.label));
    info.append(el('span', 'hint2', action.hint));
    row.append(info);
    host.append(row);
  }
}

function renderRecordables() {
  const host = document.getElementById('recordables');
  host.innerHTML = '';
  const t = T.template(config.template);
  const actions = T.recordableActionsOf(config.template, config.proTier);
  if (!actions.length) {
    host.append(el('p', 'hint', '这套模板没有需要录制的动作'));
    return;
  }
  for (const action of actions) {
    const recorded = config.recorded && config.recorded[action.id];
    const row = el('div', 'rec');

    const info = el('div');
    const name = el('span', 'nm', action.label);
    if (t.actions.pro.includes(action.id)) {
      name.append(el('span', 'tier pro', '进阶'));
    }
    info.append(name);
    info.append(el('span', 'hint2', action.hint));
    const state = el('div', 'state');
    if (recordingAction === action.id) {
      state.textContent = '准备中…';
      state.className = 'state ok';
    } else if (recorded) {
      state.textContent = `已录制 · ${recorded.hands} 只手${recorded.keyframes ? ` · ${recorded.keyframes} 关键帧` : ''}`;
      state.className = 'state ok';
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

    const buttons = el('div');
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
    }
    row.append(buttons);
    host.append(row);
  }
  if (!config.gestures.enabled) {
    host.append(el('p', 'hint warn', '先开启摄像头手势才能录制'));
  }
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
  renderContinuous();
  renderRecordables();
  renderToggles();
  if (!built) {
    renderSliders('tuning', TUNING);
    renderSliders('musicTuning', MUSIC_TUNING);
    renderSliders('gestureTuning', GESTURE_TUNING);
    built = true;
  } else if (pendingPresetRefresh) {
    pendingPresetRefresh = false;
    renderSliders('tuning', TUNING);
  }
  if (!config.gestures.enabled) {
    document.getElementById('live').textContent = '手势未开启';
  }
}

window.gw.onConfig(apply);
window.gw.onStrategy((s) => { strategy = s; renderStrategy(); });

window.gw.onSensorStatus((s) => {
  document.getElementById('live').textContent = s && s.text ? s.text : '—';
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
