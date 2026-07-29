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
      const kind = recorded.keyframeData && recorded.keyframeData.length ? '动态' : '静态';
      state.textContent = `已录制 · ${kind} · ${recorded.hands} 只手`
        + (recorded.keyframes ? ` · ${recorded.keyframes} 关键帧` : '');
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
      // 回退：主进程和 preload 早就接好了，但面板上没有入口 ⟹ 功能点不到。
      // 判据是 recordUndo 里有这个键，不是 recorded 里有 —— 清除也能回退。
      if (config.recordUndo && action.id in config.recordUndo) {
        const undo = el('button', 'act', '撤销上次');
        undo.title = '回到这个动作上一次的录制（或回到未录制）';
        undo.onclick = () => window.gw.undoRecording(action.id);
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
  cursorToggle.checked = !!config.controlCursor;
  renderAudioSource();
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

document.getElementById('capture-reveal').onclick = () => window.gw.revealCaptures();

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
  { id: 'netease', label: '网易云', hint: '只抓网易云的声音（需 macOS 14.4+）' },
  { id: 'system', label: '全系统', hint: '整台机器的输出，别的 App 出声也会影响画面' },
  { id: 'off', label: '关闭', hint: '不抓音频，壁纸走它自己的空闲动画' },
];

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
}

// 状态分三层显示，因为它们代表不同的失败：
//   装载了没有 → 根本没选壁纸
//   ready 没有 → 页面加载了但里面的 JS 没跑起来（ES module 挂了就是这样）
//   音频不 ok  → 权限或没在放歌
// ⚠️ 这三种在画面上看起来都是"没反应"，分不开的话没法查。
async function renderWEStatus() {
  const status = await window.gw.weStatus();
  const node = document.getElementById('we-state');
  if (!node) return;
  if (!status.dir) {
    node.innerHTML = '未装载 —— 现在显示的是三层景深壁纸';
  } else if (status.error) {
    node.innerHTML = `<span class="warn">${status.error}</span>\n${status.dir}`;
  } else {
    node.innerHTML = `<b>${status.title}</b>\n${status.dir}\n`
      + (status.ready
        ? '✅ 壁纸里的脚本已经跑起来了'
        : '⏳ 页面加载了，但壁纸还没报 ready —— 如果一直这样，是里面的脚本没跑起来')
      + (status.wantsAudio ? '\n这个壁纸要音频' : '\n这个壁纸不需要音频');
  }
  renderAudioStatus(status.audio);
  await renderWEControls();
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
  for (const control of result.controls) {
    const value = control.key in result.overrides ? result.overrides[control.key] : control.value;
    const row = document.createElement('div');
    row.className = 'we-row';

    const label = document.createElement('label');
    label.textContent = control.label;
    row.appendChild(label);

    if (control.type === 'bool') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!value;
      input.onchange = () => window.gw.weSetProperty(control.key, input.checked);
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

window.gw.onWeStatus(() => renderWEStatus());
window.gw.onWeAudioStatus((status) => renderAudioStatus(status));

window.gw.getConfig().then(apply);
renderWEStatus();
