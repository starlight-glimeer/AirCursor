// Settings window. Every control writes straight through to main, which persists
// and rebroadcasts — so the wall never has to be told separately, and there is no
// "apply" button to forget to press.
let config = null;

const LAYERS = [
  { key: 'background', name: '背景', hint: '整张壁纸' },
  { key: 'subject', name: '主体', hint: '抠好的人物，透明 PNG' },
  { key: 'shard', name: '碎片', hint: '壁纸的一小块' },
];

// Sliders are declared as data rather than markup so adding one cannot end up
// half-wired: the label, range, default and config path all come from one place.
// AirCursor shipped a slider that rendered blank because the same control had to
// be declared in three files and one was missed.
const TUNING = [
  { path: 'depth.background', label: '背景景深', min: -9, max: -1, step: 0.1 },
  { path: 'depth.shard', label: '碎片景深', min: 0.4, max: 4, step: 0.1 },
  { path: 'parallax', label: '视差强度', min: 0, max: 3, step: 0.05 },
  { path: 'transform.background.scale', label: '背景缩放', min: 0.8, max: 2.2, step: 0.02 },
  { path: 'transform.subject.scale', label: '主体缩放', min: 0.3, max: 2.2, step: 0.02 },
  { path: 'transform.subject.y', label: '主体上下', min: -2, max: 2, step: 0.02 },
  { path: 'shards.count', label: '碎片数量', min: 0, max: 16, step: 1 },
  { path: 'shards.spread', label: '碎片散布', min: 0.2, max: 3.5, step: 0.05 },
  { path: 'shards.drift', label: '碎片漂浮', min: 0, max: 3, step: 0.05 },
  // Up to 6x rather than 3x: the base scale is deliberately small (see
  // SHARD_BASE_SCALE), so the useful range for someone who wants big dramatic
  // shards runs higher than for the other layers.
  { path: 'transform.shard.scale', label: '碎片大小', min: 0.2, max: 6, step: 0.1 },
  { path: 'tilt.maxYaw', label: '左右转幅度°', min: 0, max: 70, step: 1 },
  { path: 'tilt.maxPitch', label: '上下转幅度°', min: 0, max: 50, step: 1 },
];

const MUSIC_TUNING = [
  { path: 'music.coverInfluence', label: '封面染色强度', min: 0, max: 1, step: 0.05 },
];

function get(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

// Build the nested patch object a dotted path implies, so main's deep merge
// touches only the one key instead of the whole subtree.
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

function renderLayers() {
  const host = document.getElementById('layers');
  host.innerHTML = '';
  for (const layer of LAYERS) {
    const filePath = config.layers[layer.key];
    const row = document.createElement('div');
    row.className = 'layer';
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (filePath) {
      thumb.style.backgroundImage = `url("file://${filePath.split('/').map(encodeURIComponent).join('/')}")`;
    }
    const info = document.createElement('div');
    info.innerHTML = `<span class="name">${layer.name}</span>` +
      `<span class="path">${filePath || layer.hint}</span>`;
    const buttons = document.createElement('div');
    const pick = document.createElement('button');
    pick.textContent = filePath ? '更换' : '选择';
    pick.onclick = () => window.gw.pickImage(layer.key);
    buttons.appendChild(pick);
    if (filePath) {
      const clear = document.createElement('button');
      clear.textContent = '清除';
      clear.onclick = () => window.gw.clearImage(layer.key);
      buttons.appendChild(clear);
    }
    row.append(thumb, info, buttons);
    host.appendChild(row);
  }
}

function renderSliders(hostId, spec) {
  const host = document.getElementById(hostId);
  host.innerHTML = '';
  for (const item of spec) {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('label');
    label.textContent = item.label;
    const range = document.createElement('input');
    range.type = 'range';
    range.min = item.min;
    range.max = item.max;
    range.step = item.step;
    const value = get(config, item.path);
    range.value = value;
    const out = document.createElement('output');
    out.textContent = Number(value).toFixed(item.step < 1 ? 2 : 0);
    // input, not change: a wallpaper you tune while watching it needs the value
    // live, and the whole point of the depth sliders is to see the effect move.
    range.oninput = () => {
      out.textContent = Number(range.value).toFixed(item.step < 1 ? 2 : 0);
      window.gw.setConfig(patchFor(item.path, Number(range.value)));
    };
    row.append(label, range, out);
    host.appendChild(row);
    // Two-column grid, so the output needs its own cell.
    const spacer = document.createElement('div');
    spacer.style.display = 'none';
    host.appendChild(spacer);
  }
}

function renderStrategy(strategy) {
  const select = document.getElementById('strategy');
  if (!strategy || !strategy.all) return;
  select.innerHTML = strategy.all
    .map((s) => `<option value="${s.id}"${s.id === strategy.id ? ' selected' : ''}>${s.label}</option>`)
    .join('');
  select.onchange = () => window.gw.setStrategy(select.value);
}

function renderToggles() {
  const gestures = document.getElementById('gestures');
  gestures.checked = config.gestures.enabled;
  gestures.onchange = () => window.gw.setGestures(gestures.checked);

  const music = document.getElementById('music');
  music.checked = config.music.enabled;
  music.onchange = () => window.gw.setConfig({ music: { enabled: music.checked } });

  const mood = document.getElementById('moodFromCover');
  mood.checked = config.music.moodFromCover;
  mood.onchange = () => window.gw.setConfig({ music: { moodFromCover: mood.checked } });
}

let built = false;

function apply(next) {
  config = next;
  renderLayers();
  renderToggles();
  // Sliders rebuild only once: rebuilding them on every config broadcast would
  // yank the thumb out from under the finger that is dragging it.
  if (!built) {
    renderSliders('tuning', TUNING);
    renderSliders('musicTuning', MUSIC_TUNING);
    built = true;
  }
  if (!config.gestures.enabled) {
    document.getElementById('live').textContent = '手势未开启';
  }
}

window.gw.onConfig(apply);
window.gw.onStrategy(renderStrategy);

window.gw.onSensorStatus((s) => {
  document.getElementById('live').textContent = s && s.text ? s.text : '—';
});

window.gw.onGesture((g) => {
  if (!g) return;
  const detail = g.value !== undefined ? ` ${(g.value * 100).toFixed(0)}%`
    : g.x !== undefined ? ` ${(g.x * 100).toFixed(0)},${(g.y * 100).toFixed(0)}`
    : '';
  const el = document.getElementById('live');
  el.textContent = `${el.textContent.split('\n')[0]}\n最近事件：${g.action}${detail}`;
});

window.gw.onTrack((t) => {
  const el = document.getElementById('track');
  if (!t) {
    el.innerHTML = '<span class="warn">读不到正在播放的音乐</span>' +
      '<span class="hint">没装 media-control，或当前没有在放歌</span>';
    return;
  }
  el.innerHTML = `♪ <b>${t.title || '?'}</b> — ${t.artist || '?'}` +
    `<span class="hint">${t.bundleIdentifier || ''}${t.artworkData ? ' · 有封面' : ' · 无封面（氛围用默认值）'}</span>`;
});

window.gw.getConfig().then(apply);
