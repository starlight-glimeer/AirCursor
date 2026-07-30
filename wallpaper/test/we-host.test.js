// we-host.js：WE 网页壁纸的契约。
//
//   node test/we-host.test.js
//
// 这一层的每条断言都对应一个**静默失败** —— 搞错了壁纸照样显示，只是永远收不到数据。
// 契约本身是从样本 bundle（音域回响 / workshop 3747222633）里扒出来的，WE 没有公开的
// 宿主端规范，所以这些用例同时是那份契约的唯一记录。
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
require('../src/we-host.js');
const WE = globalThis.GestureWallWE;

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.message}`);
    process.exitCode = 1;
  }
}

// 真实样本。⚠️ 用真 project.json 而不是手写 fixture：手写的会长成我以为的样子，
// 而这整个契约的风险恰恰在"我以为的形状和真实形状不一样"。
const SAMPLE_DIR = '/home/moon/hackathon/壁纸/粒子效果_网易云监听';
const sampleJSON = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, 'project.json'), 'utf8'));
  } catch {
    return null;
  }
})();

console.log('\nwe-host.js');

console.log('\n  project.json 解析');

check('认出 Web 类型并取出入口文件', () => {
  const p = WE.parseProject({ type: 'Web', file: 'index.html', title: '测试' });
  assert.strictEqual(p.supported, true);
  assert.strictEqual(p.file, 'index.html');
});

// scene 要解 WE 的私有 .pkg/.tex 格式 + 它自己方言的 GLSL。那条路连
// Open Wallpaper Engine 都只做到"显示静态底图"（粒子代码是死的、零 shader、
// 零动画、DXT 直接放弃），所以明确不支持比装作支持然后画一张静态图好。
//
// ⚠️ video 曾经也在这条断言里。2026-07-30 起 video 支持了（一个 <video> 标签），
// 所以那半条挪到下面「四种类型的分派」里 —— 留在这会变成一条反向的谎。
check('scene 明确判为不支持（不假装能放）', () => {
  assert.strictEqual(WE.parseProject({ type: 'scene' }).supported, false);
  assert.strictEqual(WE.parseProject({ type: 'application' }).supported, false);
});

check('入口文件缺省是 index.html', () => {
  assert.strictEqual(WE.parseProject({ type: 'Web' }).file, 'index.html');
});

check('空输入返回 null 而不是抛', () => {
  assert.strictEqual(WE.parseProject(null), null);
  assert.strictEqual(WE.parseProject('不是对象'), null);
});

// 壁纸自己声明要不要音频。没声明的壁纸不用费劲去抓系统音频（那要屏幕录制权限）。
check('从 supportsaudioprocessing 或 audio.enabled 判断要不要音频', () => {
  assert.strictEqual(
    WE.parseProject({ type: 'Web', general: { supportsaudioprocessing: true } }).wantsAudio, true);
  assert.strictEqual(
    WE.parseProject({ type: 'Web', audio: { enabled: true } }).wantsAudio, true);
  assert.strictEqual(WE.parseProject({ type: 'Web' }).wantsAudio, false);
});

console.log('\n  属性契约（最容易静默失败的一处）');

// ⚠️ 这是整份契约里最反直觉的一条，也是最贵的一条。
// 证据（样本 bundle）：
//   ((Ns = We.gridSize) == null ? void 0 : Ns.value) !== void 0 && Y(We.gridSize.value)
// 它读 props.gridSize.value。平铺发过去，41 项全被判 undefined，壁纸静默用默认值 ——
// 表现是"我改了配置没反应"，而不是任何一条报错。
check('applyUserProperties 的值必须包在 {value:} 里', () => {
  const out = WE.userProperties({ gridSize: { type: 'combo', value: 160 } });
  assert.deepStrictEqual(out.gridSize, { value: 160 },
    '值被平铺了 —— 壁纸会把它当 undefined 并静默用默认值');
});

// applyGeneralProperties 的形状**不一样**，它是平的。
// 证据：`Ux = Tt => { Tt.fps !== void 0 && t(Tt.fps) }`，直接读 .fps。
// 两个接口一个包一个不包，这种不对称必须有测试盯着，不然改代码的人一定会统一它们。
check('applyGeneralProperties 是平的（fps 不包 value）', () => {
  const out = WE.generalProperties(60);
  assert.deepStrictEqual(out, { fps: 60 });
  assert.strictEqual(out.value, undefined, 'general 属性被包了一层，壁纸读不到');
});

check('fps 非法时回落到 30 而不是发 NaN', () => {
  assert.strictEqual(WE.generalProperties(0).fps, 30);
  assert.strictEqual(WE.generalProperties(NaN).fps, 30);
  assert.strictEqual(WE.generalProperties(undefined).fps, 30);
});

// project.json 里 type:"text" 的项是分隔标题（sep_render_title 那些），不是配置。
// 发过去无害但会污染面板，而且会让"有多少个可调项"这个数不对。
check('装饰用的 text 项被剔掉', () => {
  const out = WE.userProperties({
    sep_render_title: { type: 'text', value: '' },
    gridSize: { type: 'combo', value: 160 },
  });
  assert.ok(!('sep_render_title' in out), 'text 分隔项被当成配置发出去了');
  assert.ok('gridSize' in out);
});

check('用户覆盖优先于 project.json 的默认值', () => {
  const out = WE.userProperties({ theme: { type: 'combo', value: 'nocturnal' } },
    { theme: 'ember-fire' });
  assert.deepStrictEqual(out.theme, { value: 'ember-fire' });
});

check('覆盖里没有的键仍然发默认值（不是只发改过的）', () => {
  const out = WE.userProperties(
    { a: { value: 1 }, b: { value: 2 } }, { a: 9 });
  assert.deepStrictEqual(out, { a: { value: 9 }, b: { value: 2 } });
});

console.log('\n  真实样本');

if (!sampleJSON) {
  console.log('  ⚠ 跳过：样本目录不在，这几条只在有样本时跑');
} else {
  check('真样本被判为支持的 Web 壁纸且要音频', () => {
    const p = WE.parseProject(sampleJSON);
    assert.strictEqual(p.supported, true, `type=${p && p.type}`);
    assert.strictEqual(p.wantsAudio, true, '样本声明了 supportsaudioprocessing');
    assert.strictEqual(p.file, 'index.html');
  });

  // 样本实测：44 项里 16 项是 text 分隔标题，剩 28 项可配置
  // （slider 16 / bool 8 / combo 3 / color 1）。
  // ⚠️ 这个数是数出来的，不是估的 —— 我第一版写"样本有 40+"把分隔项算进去了，
  // 于是断言红了而代码是对的。项数本身是个事实，得去数。
  check('真样本的 28 个可配置项全部翻译出来且都带 value', () => {
    const p = WE.parseProject(sampleJSON);
    const out = WE.userProperties(p.properties);
    const all = Object.keys(p.properties).length;
    const decorative = Object.values(p.properties).filter((v) => v.type === 'text').length;
    assert.strictEqual(Object.keys(out).length, all - decorative,
      `翻译出 ${Object.keys(out).length} 项，应该是 ${all} - ${decorative} 个分隔项`);
    for (const [key, v] of Object.entries(out)) {
      assert.ok(v && typeof v === 'object' && 'value' in v, `${key} 没有 value 包装`);
    }
  });

  // color 类型的值是空格分隔的 "r g b" 字符串（0..1），不是 hex。
  // 原样转发就行，壁纸自己解析。这条守的是"别自作聪明转成 hex"。
  check('color 类型原样转发（是 "r g b" 字符串不是 hex）', () => {
    const p = WE.parseProject(sampleJSON);
    const out = WE.userProperties(p.properties);
    assert.ok(out.schemecolor, '样本有 schemecolor，没翻译出来');
    assert.strictEqual(typeof out.schemecolor.value, 'string');
    assert.match(out.schemecolor.value, /^[\d.]+ [\d.]+ [\d.]+$/,
      `色值格式变了：${out.schemecolor.value}`);
  });

  check('真样本生成的控件有 slider / bool / combo 三种', () => {
    const p = WE.parseProject(sampleJSON);
    const controls = WE.controlsOf(p.properties);
    const types = new Set(controls.map((c) => c.type));
    assert.ok(types.has('slider'), '没有 slider');
    assert.ok(types.has('bool'), '没有 bool');
    assert.ok(types.has('combo'), '没有 combo');
    // 分隔标题不该出现在控件里
    assert.ok(!controls.some((c) => c.key.startsWith('sep_')), 'sep_* 混进控件了');
  });

  check('控件按 order 排序（面板的分组顺序靠它）', () => {
    const controls = WE.controlsOf(WE.parseProject(sampleJSON).properties);
    for (let i = 1; i < controls.length; i += 1) {
      assert.ok(controls[i].order >= controls[i - 1].order, '控件没按 order 排');
    }
  });

  check('slider 控件带 min/max/step，combo 带 options', () => {
    const controls = WE.controlsOf(WE.parseProject(sampleJSON).properties);
    const slider = controls.find((c) => c.type === 'slider');
    assert.ok(Number.isFinite(slider.min) && Number.isFinite(slider.max), 'slider 缺范围');
    assert.ok(slider.max > slider.min, `slider 范围反了：${slider.min}..${slider.max}`);
    const combo = controls.find((c) => c.type === 'combo');
    assert.ok(Array.isArray(combo.options) && combo.options.length, 'combo 缺 options');
  });

  // 双语标签取中文那半。"音频响应强度 / Audio Intensity" → "音频响应强度"
  check('双语标签取中文', () => {
    const controls = WE.controlsOf(WE.parseProject(sampleJSON).properties);
    const labels = controls.map((c) => c.label);
    assert.ok(!labels.some((l) => l.includes('/')), `标签没拆开：${labels.find((l) => l.includes('/'))}`);
    assert.ok(labels.some((l) => /[一-龥]/.test(l)), '一个中文标签都没有');
  });
}

console.log('\n  音频帧');

// 样本的消费代码：`const t = e.length || 128`，然后重采样到 512。
// 长度不对不会报错，只会让整个频谱错位 —— 画出来的柱子形状看起来"就是这样"。
check('音频固定 128 段', () => {
  assert.strictEqual(WE.AUDIO_BINS, 128);
  const out = WE.normalizeAudioFrame(new Array(128).fill(0.5));
  assert.strictEqual(out.data.length, 128);
  assert.strictEqual(out.resampled, false);
});

// 长度不对时按比例重采样，而不是截断或补 0：截断会把高频整段丢掉，而高频正是
// 流星效果的触发源（样本里 Pe<=300 那段）。
check('长度不对时按比例重采样，不截断', () => {
  const src = new Array(256).fill(0).map((_, i) => i);
  const out = WE.normalizeAudioFrame(src);
  assert.strictEqual(out.data.length, 128);
  assert.strictEqual(out.resampled, true);
  // 末段必须来自源的末段，否则高频丢了
  assert.ok(out.data[127] > src[200], `末段是 ${out.data[127]}，高频被截掉了`);
});

check('短帧也补齐到 128', () => {
  const out = WE.normalizeAudioFrame([1, 2, 3, 4]);
  assert.strictEqual(out.data.length, 128);
});

// NaN/Infinity 喂进 GLSL 会让整块画面变黑 —— 比丢一帧糟得多，而且不报错。
check('NaN / Infinity / 负数被挡住', () => {
  const out = WE.normalizeAudioFrame([NaN, Infinity, -5, 0.5]);
  for (const v of out.data) {
    assert.ok(Number.isFinite(v) && v >= 0, `产出了非法值 ${v}`);
  }
});

// ⚠️ 这条是这一节存在的主要理由：没授权时拿到的是**全 0**，不是错误。
// 而全 0 的画面看起来就是"音频响应坏了"。所以"静默"必须是一个能被上层看见的事实,
// 不能只是一串零。这正是 AirCursor 烧掉四轮才补上 `点击通道` 状态行的同一个教训。
check('全 0 被标成 silent（没授权和没在放歌都长这样）', () => {
  const out = WE.normalizeAudioFrame(new Array(128).fill(0));
  assert.strictEqual(out.silent, true, '全 0 没被标出来 —— 那会看起来像"音频坏了"');
  assert.strictEqual(out.ok, true, '全 0 是合法帧，只是静默');
});

check('空帧标 ok:false 并给出原因', () => {
  const out = WE.normalizeAudioFrame(null);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.silent, true);
  assert.ok(out.reason, '没给原因，上层没法在面板上说清楚');
  assert.strictEqual(out.data.length, 128, '失败时也要给合法长度，否则壁纸下标越界');
});

check('有信号时不标 silent 并报峰值', () => {
  const out = WE.normalizeAudioFrame(new Array(128).fill(0.3));
  assert.strictEqual(out.silent, false);
  assert.ok(out.peak > 0);
});

console.log('\n  media 四通道');

const track = {
  title: '歌名', artist: '歌手', album: '专辑',
  artwork: 'data:image/png;base64,AAA', playing: true,
  position: 42, duration: 210,
};

// ⚠️ 样本读的是 `pb.state === (window.wallpaperMediaIntegration && ...PLAYBACK_PLAYING) || 0`
// —— 拿不到常量时兜底成 0。所以 PLAYING 必须是 0，否则走兜底分支的壁纸会把
// "正在播放"判成停止，表现是封面出来了但动画不动。
check('PLAYBACK_PLAYING 必须是 0（壁纸拿不到常量时兜底成 0）', () => {
  assert.strictEqual(WE.PLAYBACK.PLAYBACK_PLAYING, 0,
    'PLAYING 不是 0 —— 走兜底分支的壁纸会把播放中判成停止');
});

check('四个通道各自只带自己的字段', () => {
  assert.deepStrictEqual(WE.mediaProperties(track),
    { title: '歌名', artist: '歌手', albumTitle: '专辑' });
  assert.strictEqual(WE.mediaThumbnail(track).thumbnail, 'data:image/png;base64,AAA');
  assert.strictEqual(WE.mediaPlayback(track).state, WE.PLAYBACK.PLAYBACK_PLAYING);
  assert.deepStrictEqual(WE.mediaTimeline(track), { position: 42, duration: 210 });
});

check('没歌时给空串和暂停态，不给 null', () => {
  // 壁纸直接 `props.title || ''` 用，null 不会崩；但 position 会进算术，
  // null 变 0 还行，undefined 就是 NaN 了。
  assert.strictEqual(WE.mediaProperties(null).title, '');
  assert.strictEqual(WE.mediaPlayback(null).state, WE.PLAYBACK.PLAYBACK_PAUSED);
  assert.strictEqual(WE.mediaTimeline(null).position, 0);
  assert.strictEqual(WE.mediaTimeline(null).duration, 0);
});

check('进度非法时给 0 而不是 NaN', () => {
  const out = WE.mediaTimeline({ position: 'abc', duration: null });
  assert.strictEqual(out.position, 0);
  assert.strictEqual(out.duration, 0);
});

console.log('\n  资产路径解析（每种错法都是白屏）');

const DIR = '/tmp/wp';

check('入口文件正常解析', () => {
  assert.strictEqual(WE.resolveAsset('/index.html', DIR, 'index.html'), '/tmp/wp/index.html');
});

// wall://wallpaper/ 没有路径时要落到 project.json 声明的入口，不是目录本身。
check('空路径落到入口文件', () => {
  assert.strictEqual(WE.resolveAsset('/', DIR, 'index.html'), '/tmp/wp/index.html');
  assert.strictEqual(WE.resolveAsset('', DIR, 'index.html'), '/tmp/wp/index.html');
});

check('子目录资产正常解析', () => {
  assert.strictEqual(WE.resolveAsset('/assets/a.js', DIR, 'index.html'), '/tmp/wp/assets/a.js');
});

// ⚠️ URL 里的路径是百分号编码的。不解码 ⟹ 中文/空格目录名下所有资产 404 ⟹ 白屏。
check('百分号编码被还原', () => {
  assert.strictEqual(WE.resolveAsset('/%E4%B8%AD%E6%96%87.js', DIR, 'index.html'),
    '/tmp/wp/中文.js');
  assert.strictEqual(WE.resolveAsset('/my%20file.js', DIR, 'index.html'),
    '/tmp/wp/my file.js');
});

// 壁纸是第三方 HTML。一个 fetch('../../../etc/passwd') 不该读到东西。
check('越界路径被拦住（第三方 HTML 不能读文件系统）', () => {
  assert.strictEqual(WE.resolveAsset('/../../../etc/passwd', DIR, 'index.html'), null);
  assert.strictEqual(WE.resolveAsset('/..%2F..%2Fetc%2Fpasswd', DIR, 'index.html'), null);
});

// 前缀检查必须带路径分隔符，否则 /tmp/wpEVIL 会通过 /tmp/wp 的检查。
check('相邻同前缀目录不算在内（/tmp/wp 不放行 /tmp/wpEVIL）', () => {
  assert.strictEqual(WE.resolveAsset('/../wpEVIL/x.js', DIR, 'index.html'), null);
});

// 半个百分号会让 decodeURIComponent 抛。那不是攻击而是坏链接，但也不能当合法路径。
check('坏编码返回 null 而不是抛', () => {
  assert.strictEqual(WE.resolveAsset('/%E5%', DIR, 'index.html'), null);
});

check('没有目录时返回 null', () => {
  assert.strictEqual(WE.resolveAsset('/index.html', null, 'index.html'), null);
});

console.log('\n  四种类型的分派（不支持要说清，不能假装成功）');

// WE 一共四种类型，实测 project.json 的取值。
check('四种类型都认识，两种支持', () => {
  assert.deepStrictEqual(Object.keys(WE.TYPES).sort(),
    ['application', 'scene', 'video', 'web']);
  assert.strictEqual(WE.parseProject({ type: 'web' }).supported, true);
  assert.strictEqual(WE.parseProject({ type: 'video', file: 'a.mp4' }).supported, true);
  assert.strictEqual(WE.parseProject({ type: 'scene' }).supported, false);
  assert.strictEqual(WE.parseProject({ type: 'application' }).supported, false);
});

// ⚠️ "认识但不支持" vs "完全没见过" 要分开：前者能给出理由（"scene 是私有格式"），
// 后者只能说"不认识"。混在一起的话用户不知道是我们的问题还是壁纸的问题。
check('认识但不支持 vs 不认识，分开', () => {
  assert.strictEqual(WE.parseProject({ type: 'scene' }).known, true);
  assert.strictEqual(WE.parseProject({ type: 'zzz' }).known, false);
  assert.match(WE.refusalReason(WE.parseProject({ type: 'zzz' })), /不认识/);
});

// GIF 壁纸不是独立类型 —— WE 把它包成 scene，入口叫 gifscene.json。
// 这条是查出来的（OWE 的 SceneWallpaperViewModel:49 注释），不是猜的。
check('GIF 被认出来是 scene 的一种（gifscene）', () => {
  const gif = WE.parseProject({ type: 'scene', file: 'gifscene.json' });
  assert.strictEqual(gif.gifScene, true);
  assert.strictEqual(WE.isGifScene('gifscene.json'), true);
  assert.strictEqual(WE.isGifScene('scene.json'), false);
  // 理由里要点出它是 GIF，否则用户以为自己装错了文件
  assert.match(WE.refusalReason(gif), /GIF/);
});

// ⚠️ "不支持"三个字对用户没有价值。他需要知道为什么、以及能不能换一个。
// 更要紧的是说清"这不是坏了" —— 否则他会去排查一个不存在的 bug
//（我们已经在这类混淆上烧掉过一整天）。
check('每种拒绝都给出具体理由，不是一句"不支持"', () => {
  const scene = WE.refusalReason(WE.parseProject({ type: 'scene', file: 'scene.json' }));
  assert.match(scene, /私有格式|shader|渲染/, `scene 的理由太笼统：${scene}`);
  const app = WE.refusalReason(WE.parseProject({ type: 'application' }));
  assert.match(app, /Windows|exe/, `application 的理由太笼统：${app}`);
  // 每条都得比"暂不支持"长，否则等于没说
  for (const t of ['scene', 'application', 'zzz']) {
    assert.ok(WE.refusalReason(WE.parseProject({ type: t })).length > 12);
  }
});

check('project.json 读不到时也给人话', () => {
  assert.match(WE.refusalReason(null), /project\.json/);
});

console.log('\n  video 类');

// ⚠️ video 的 project.file 是**视频文件名**不是 html。拿它去 loadURL 会让
// Chromium 直接下载或黑屏，而且不报错 —— 所以两条装载路径必须分开。
check('入口不像视频时提前说出来', () => {
  assert.strictEqual(WE.videoHint('a.mp4'), null);
  assert.strictEqual(WE.videoHint('clip.webm'), null);
  assert.match(WE.videoHint('index.html'), /不像视频/);
  assert.match(WE.videoHint(''), /不像视频/);
});

check('常见容器都认（mp4/webm/m4v/mov）', () => {
  for (const f of ['a.mp4', 'a.webm', 'a.m4v', 'a.MOV']) {
    assert.strictEqual(WE.videoHint(f), null, `${f} 被误判成不是视频`);
  }
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
