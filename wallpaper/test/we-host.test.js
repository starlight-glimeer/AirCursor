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
// ⚠️ 真实样本。**硬编码绝对路径，所以在别人机器上会缺** ——
// 那样相关的 check 会静默跳过（下面每个用它的 check 都判了 null）。
// 不改成打包进仓库是因为它们是第三方作品（几十 MB，含作者的图片/视频）。
//
// ⚠️ 而"静默跳过"本身是个风险：测试全绿不等于验过。所以下面会打一行说明。
const SAMPLE_DIR = '/home/moon/hackathon/壁纸/粒子效果_网易云监听';
// ⚠️ 第二个样本：884307090「完美壁纸」。
//
// 加它是因为**它和第一个样本的形状完全不同**，而那些差异各自暴露过一个 bug：
//   · 137 个控件（第一个只有 44）⟹ 平铺就找不到东西
//   · 大量 condition（第一个几乎没有）⟹ 我压根没实现 condition
//   · text 字段是 HTML（第一个是纯文本双语）⟹ label 全变成 "<br"
//   · file 类型属性没有 value ⟹ 那些键根本没发给壁纸
// ⟹ **一个样本证明不了兼容性。** 这条教训值得写下来。
const SAMPLE_DIR_2 = '/home/moon/hackathon/壁纸/884307090';

function readSample(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  } catch {
    return null;
  }
}
const sampleJSON = readSample(SAMPLE_DIR);
const sampleJSON2 = readSample(SAMPLE_DIR_2);

console.log('\nwe-host.js');

// ⚠️ 样本缺失要**说出来** —— 否则"全绿"会被读成"兼容性验过了"，
// 而实际上是相关的 check 静默跳过了。
if (!sampleJSON || !sampleJSON2) {
  const missing = [!sampleJSON && '粒子效果_网易云监听', !sampleJSON2 && '884307090']
    .filter(Boolean).join('、');
  console.log(`\n  ⚠️ 真实样本缺失（${missing}）—— 用它们的 check 会跳过。`);
  console.log('     那些 check 覆盖的是"我按想象写解析然后被真数据打脸"那一类');
  console.log('     （137 个控件平铺 / condition 没实现 / label 全是 "<br" / file 类型没 value），');
  console.log('     ⟹ 缺样本时本文件的全绿**不代表兼容性**。');
}

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
check('⚠️⚠️ scene 现在支持了（0.9.158），而 application 照旧不支持', () => {
  // ⚠️⚠️⚠️ **这条守卫守的决定翻了。** 用户 2026-08-03：
  //   「scene 这种类型我们可以支持，后面我们的 agent 也支持生成 scene 类型的壁纸」
  //
  // ⚠️ 而我 2026-07-30 那份评估的结论是"不该做" —— **它错在量错了对象**：
  //   我读的是 linux-wallpaperengine 的代码规模（30470 行 C++），
  //   而实测两个真实工坊壁纸之后，主体是"图层 + 文字 + 变换"
  //   （样本 B：140 个对象里 **1 个**粒子系统）。
  //   ⟹ 判据：**评估工作量要量"真实输入里有什么"，不是量"引擎有多少行"。**
  assert.strictEqual(WE.parseProject({ type: 'scene' }).supported, true,
    'scene 该支持了（0.9.158）—— 见 scene-pkg.js 那 20 项测试');
  // ⚠️ 而 application（别人编译的 Windows .exe）**照旧不支持** ——
  //   那不是能力问题，是"跑不了也不该跑"（用户明确不做）。
  assert.strictEqual(WE.parseProject({ type: 'application' }).supported, false,
    'application 该照旧不支持（那是 Windows .exe）');
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
    // ⚠️ 这条断言改了。原来是「sep_* 不该出现」，而现在 `type: 'text'` 的项
    // 会作为**分组标题**（`type: 'group'`）出现 —— 那是有意的：
    //
    // 真实样本（884307090）里作者用它们分段：
    //   「----------完美壁纸圆环(PWCircle)----------」
    //   「----------完美壁纸直线(PWLine)----------」
    // 而我原来一律扔掉 ⟹ 137 个控件平铺、13 组重名 ⟹ 用户找不到属性。
    //
    // ⟹ 现在验的是"它们不是**可调控件**"（没有 value/min/max），而不是"不存在"。
    for (const c of controls.filter((x) => x.key.startsWith('sep_'))) {
      assert.strictEqual(c.type, 'group',
        `${c.key} 的 type 是 ${c.type} —— text 项该是分组标题，不是可调控件`);
    }
    // 纯分隔线（`_____` / `-----`）连标题都不该算
    assert.ok(!controls.some((c) => c.type === 'group' && /^[\s_\-—=]+$/.test(c.label)),
      '纯分隔线被当成分组标题了 —— 那才是真装饰');
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
  // ⚠️⚠️⚠️ **这里原来写的是 `artwork: 'data:image/png;base64,AAA'`** ——
  //   而**真实的 track 里没有 `artwork` 这个字段**（`nowplaying.js` 给的是
  //   `artworkData`（裸 base64）+ `artworkMimeType`）。
  //   ⟹ 这条测试一直是绿的，而真机上**封面一直是空的**
  //     （用户 2026-08-02 的截图坐实：歌名歌手都对、封面框空白）。
  //   ⟹ 教训：**fixture 必须长得像真实数据**，否则它测的是一个不存在的世界。
  //     而这个错还骗过了两层：既让 bug 活着，又让修 bug 的人看到"测试红了"。
  artworkData: 'AAA', artworkMimeType: 'image/png', playing: true,
  // ⚠️⚠️ **这里原来写 `position: 42`** —— 而 media-control 给的字段叫
  //   **`elapsedTime`**（本文件 34 行那个 fixture 用的就是它）。
  //   ⟹ `mediaTimeline` 一直读 `track.position` 而真实数据里没有这个键
  //     ⟹ 我们给壁纸发的进度**恒为 0**，而壁纸自己造计时器往前跑
  //     ⟹ 用户 2026-08-02 看到的"进度条跑一会儿自己重置"。
  //   ⚠️⚠️ **而这条测试一直是绿的**，因为 fixture 和 src 用了同一个假名字 ——
  //     两个错互相印证。这是 0.9.110（封面那次）之后**同一个形状的第二次**。
  //   ⟹ 判据：**fixture 的字段名必须来自真实数据**，不是来自被测代码。
  elapsedTime: 42, duration: 210,
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
  // ⚠️ 同上：用真实字段名 elapsedTime
  const out = WE.mediaTimeline({ elapsedTime: 'abc', duration: null });
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

// WE 自己只有四种类型（实测 project.json 的取值）。
// ⚠️ 我们的 TYPES 里多一个 image —— 那是**我们造的**，给 legacy 单文件壁纸用
//（Steam 存成 _legacy.bin 不解包，里面可能就是一个 gif）。
// 这条断言把"WE 的四种"和"我们扩的那一种"分开写，免得以后有人以为 image 是 WE 的。
check('WE 的四种类型都认识，加上我们扩的 image', () => {
  const WE_OFFICIAL = ['application', 'scene', 'video', 'web'];
  for (const t of WE_OFFICIAL) {
    assert.ok(WE.TYPES[t], `WE 官方类型 ${t} 不认识`);
  }
  assert.ok(WE.TYPES.image, 'image（我们为 legacy 单文件造的）不在 TYPES 里');
  assert.deepStrictEqual(Object.keys(WE.TYPES).sort(),
    [...WE_OFFICIAL, 'image'].sort());
  assert.strictEqual(WE.parseProject({ type: 'web' }).supported, true);
  assert.strictEqual(WE.parseProject({ type: 'video', file: 'a.mp4' }).supported, true);
  // ⚠️ scene 0.9.158 起支持（见上面那条守卫的判据）
  assert.strictEqual(WE.parseProject({ type: 'scene' }).supported, true);
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

console.log('\n  image 类（我们为 legacy 单文件壁纸造的）');

// ⚠️ image **不是 WE 的类型** —— WE 只有 web/video/scene/application 四种。
//
// 这一项是我们自己加的：legacy 工坊物品是单文件上传（Steam 存成 _legacy.bin 不解包），
// 里面可能就是一个 gif/png/jpg，没有 project.json。那种我们给它造一个并标成 image。
//
// 我第一版直接写了 type:'image' 而没有加进 TYPES ⟹ 自己的分派器把它判成
// "不认识的类型" —— 造出来的东西自己不认，而且症状是装载被拒。
check('image 类被认识且支持（否则我们造的 project.json 自己不认）', () => {
  const p = WE.parseProject({ type: 'image', file: 'wallpaper.gif' });
  assert.strictEqual(p.known, true, 'image 没加进 TYPES');
  assert.strictEqual(p.supported, true);
});

// 用户明确要求支持 GIF。而 GIF 在 WE 自己那边是包成 scene（gifscene.json），
// 那条要 scene 渲染；但 legacy 的裸 GIF 不需要 —— 一个 <img> 就够。
check('两条 GIF 路径不混：gifscene 归 scene，裸 GIF 归 image', () => {
  // ⚠️⚠️ 两条路**都支持了**（0.9.158 起 scene 也支持）——
  //   但它们走**不同的渲染路径**，而那个区分仍然要在：
  //     `gifscene.json` 是 WE 把 GIF 包成 scene ⟹ 走 scene 渲染
  //     legacy 的裸 GIF 没有 project.json ⟹ 我们造一个标成 image，一个 <img> 就够
  //   ⚠️ 判据：**"都支持"不等于"可以混"** —— 走错路径的症状是白屏。
  const gifScene = WE.parseProject({ type: 'scene', file: 'gifscene.json' });
  assert.strictEqual(gifScene.supported, true, 'gifscene 是 scene，0.9.158 起支持');
  assert.strictEqual(gifScene.type, 'scene', 'gifscene 的类型该是 scene（决定渲染路径）');
  const bareGif = WE.parseProject({ type: 'image', file: 'wallpaper.gif' });
  assert.strictEqual(bareGif.supported, true, '裸 GIF 一个 <img> 就够，该支持');
  assert.strictEqual(bareGif.type, 'image', '裸 GIF 该走 image 路径，不是 scene');
});

// video 和 image 走同一个渲染页（容器逻辑一样：铺满、cover、居中），
// 只有标签不同。所以装载路径的判据必须覆盖两者。
check('isMediaType 覆盖 video 和 image，不覆盖 web/scene', () => {
  assert.strictEqual(WE.isMediaType('video'), true);
  assert.strictEqual(WE.isMediaType('image'), true);
  assert.strictEqual(WE.isMediaType('web'), false);
  assert.strictEqual(WE.isMediaType('scene'), false);
});

console.log('\n  支持性判定只能有一个来源');

// ⚠️ 这一节来自一次真实的错报。用户查一个 GIF 壁纸，界面说：
//   "看起来是 image（从文件名 …preview.gif 推的）· 大概不支持 ·
//    application 类是 Windows 程序，macOS 上跑不了"
//
// 两处都错：image 是支持的（它后来真的放出来了），而理由是 application。
//
// 根因是同一个：**同一个事实有两个来源**。
//   ① workshop.js 自己维护了 `type === 'web' || type === 'video'`，
//      加 image 时只改了 we-host 的 TYPES，那边没跟着改
//   ② 面板里写了两分支三元（不是 scene 就说 application），image 落到 else
check('isSupportedType 覆盖所有 TYPES 里 support:full 的项', () => {
  for (const [type, spec] of Object.entries(WE.TYPES)) {
    assert.strictEqual(WE.isSupportedType(type), spec.support === 'full',
      `${type} 的支持性判定和 TYPES 里的声明不一致`);
  }
});

// ⚠️ 这条是防漂的关键：workshop.js **不许**自己判断支持性。
check('workshop.js 里没有硬编码的支持列表', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'workshop.js'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/supported:\s*type ===/.test(code),
    'workshop.js 又自己判支持性了 —— 那份列表一定会和 TYPES 漂开');
});

// 少一个分支的后果不是"少说一句"，是**说错**，而说错比不说糟。
check('每个不支持的类型都有自己的理由，不会串台', () => {
  const app = WE.typeRefusal('application');
  assert.match(app, /Windows/, 'application 的理由该提 Windows');
  // ⚠️ 支持的类型不该有拒绝理由 —— scene 0.9.158 起进了这一组
  for (const t of ['web', 'video', 'image', 'scene']) {
    assert.strictEqual(WE.typeRefusal(t), null, `${t} 被给了拒绝理由`);
  }
  // ⚠️⚠️ 而没见过的类型仍要给一句通用的（不能套用 application 的）
  const unknown = WE.typeRefusal('某种没见过的');
  assert.ok(unknown, '没见过的类型该给一句话');
  assert.notStrictEqual(unknown, app, '没见过的类型套用了 application 的理由');
});

// 没见过的类型也要给一句话（而不是 undefined 或者错误地套用别的理由）。
check('没见过的类型给通用理由，不套用别人的', () => {
  const out = WE.typeRefusal('zzz');
  assert.match(out, /zzz/, '没点名是哪个类型');
  assert.ok(!/Windows/.test(out), '把未知类型说成了 Windows 程序');
});


console.log('\n  file 类型属性（没有 value 是合法状态）');

// ⚠️ 这一组的数据全部抄自**真实** project.json：工坊 884307090
// 「Perfect Wallpaper-完美壁纸」，用户真机装载过。不是我构造的形状。
//
// 症状：预览图有山景背景，实际装载后纯黑 + 只剩花瓣和时钟。
// 日志：Not allowed to load local resource: file:///[object%20Object]
//
// 根因：file / directory / textinput 三种类型在 project.json 里**没有 value 字段**
//（那是"用户还没选文件"的正常状态），而原来的 userProperties 遇到
// `value === undefined` 就 continue ⟹ 这些键根本不发给壁纸。
//
// 而壁纸假设它们存在且是字符串 —— 同一个文件里的 condition 就是证据：
//   "condition": "MuiscModel.value != 0 || selectmusic.value != '' "
const REAL_FILE_PROPS = {
  image: { condition: 'wallpapermode.value == 1', order: 12, text: '自定义壁纸', type: 'file' },
  selectvideo: { condition: 'wallpapermode.value == 3', fileType: 'video', order: 15, type: 'file' },
  selectmusic: { fileType: 'video', order: 196.1, type: 'file' },
  particles_image: { condition: 'particles_isParticles.value == true', order: 33.9, type: 'file' },
  customdirectory: { condition: 'wallpapermode.value == 2', mode: 'fetchall', order: 13, type: 'directory' },
  weather_CityText: { condition: 'weather_show.value == true', order: 180.23, type: 'textinput' },
  wallpapermode: { options: [{ label: '单壁纸', value: 1 }], order: 11, type: 'combo', value: 1 },
};

check('没有 value 的 file 属性也要发出去（缺键会让壁纸的 condition 全走错）', () => {
  const out = WE.userProperties(REAL_FILE_PROPS, {});
  for (const key of ['image', 'selectvideo', 'selectmusic', 'particles_image']) {
    assert.ok(key in out, `${key} 没发给壁纸 —— 壁纸读 props.${key}.value 会拿到 undefined`);
  }
});

check('directory / textinput 同样处理（都是"还没填"的状态）', () => {
  const out = WE.userProperties(REAL_FILE_PROPS, {});
  assert.ok('customdirectory' in out, 'directory 类型被丢了');
  assert.ok('weather_CityText' in out, 'textinput 类型被丢了');
});

// ⚠️ 空字符串而不是 null/undefined：壁纸拿它和 '' 比较。
check('未设置时发空字符串（壁纸拿 .value 和 \'\' 比）', () => {
  const out = WE.userProperties(REAL_FILE_PROPS, {});
  assert.strictEqual(out.selectmusic.value, '', `发的是 ${JSON.stringify(out.selectmusic.value)}`);
  // 复刻壁纸真实的那个 condition，确认它能正确求值
  const condition = out.selectmusic.value !== '';
  assert.strictEqual(condition, false, '"没选自定义音乐"这个状态求值错了');
});

check('用户真选了文件时用他的值，不被空字符串覆盖', () => {
  const out = WE.userProperties(REAL_FILE_PROPS, { image: '/Users/moon/bg.jpg' });
  assert.strictEqual(out.image.value, '/Users/moon/bg.jpg');
});

// 装饰项仍然要剔掉 —— 别为了修这个把那条一起放开。
check('text 类型仍然被剔掉（它没有 value 也不该发）', () => {
  const out = WE.userProperties({
    Text_Other: { order: -1, text: '<h4>完美壁纸</h4>', type: 'text' },
    image: { type: 'file' },
  }, {});
  assert.ok(!('Text_Other' in out), 'text 类型被发出去了 —— 那是纯装饰');
  assert.ok('image' in out, 'file 类型该发');
});


console.log('\n  控件名字（project.json 的 text 是 HTML）');

// ⚠️ 用户装载「完美壁纸」后，面板上 137 个控件的名字**全是 `"<br"`** ——
// 一个都分辨不出来，所以他没法自己去调那些属性。
//
// 根因：`text` 字段是 **HTML**，而我按"双语用斜杠分隔"写了 `.split('/')[0]`
// ⟹ 第一个 `/` 出现在 `<br />` 里面。
//
// 真实样本（884307090，用户提供的壁纸文件）：
//   "<br />多边形变换<br />Polygon<br /><small>用波峰音频效果更明显</small><br />"
//
// ⚠️ 这是"载荷假设必先验"的又一次：那个 project.json 68KB 一直在手边，
// 而我按想象写了解析。
const REAL_TEXTS = [
  ['<br />多边形变换<br />Polygon<br /><small>用波峰音频效果更明显</small><br />', '多边形变换'],
  ['<br />音频方向<br />Wave direction<br />', '音频方向'],
  ['<br />圆心-X(%)<br />Center of circle-X(%)<br />', '圆心-X(%)'],
  ['<br />圆环半径(%)<br />Circle Radius(%)<br />', '圆环半径(%)'],
  ['<br/><h4>●  背景选项(Background Options)</h4><small>默认壁纸是…</small><br/>',
    '●  背景选项(Background Options)'],
];

check('控件名字从 HTML 的 text 里正确取出（原来全是 "<br"）', () => {
  for (const [text, want] of REAL_TEXTS) {
    const out = WE.controlsOf({ k: { type: 'slider', text, value: 1 } });
    assert.strictEqual(out[0].label, want,
      `text=${JSON.stringify(text.slice(0, 40))}… 取出的名字是 `
      + `${JSON.stringify(out[0].label)}，期望 ${JSON.stringify(want)}`);
  }
});

// ⚠️ 标签要换成分隔符而不是直接删 —— `A<br/>B` 直接删会粘成 `AB`。
check('标签换成分隔符，不是直接删（否则中英文粘一起）', () => {
  const out = WE.controlsOf({
    k: { type: 'slider', text: '音频幅度<br />Wave Range', value: 1 },
  });
  assert.strictEqual(out[0].label, '音频幅度',
    `取出 ${JSON.stringify(out[0].label)} —— 如果是"音频幅度Wave Range"，`
    + '说明标签被直接删掉而没换成分隔符');
});

// ⚠️ 选项的 label 是**纯文本**，斜杠是名字的一部分，不能按它切。
check('选项名里的斜杠要留着（"向上/左" 不是双语分隔）', () => {
  const out = WE.controlsOf({
    k: {
      type: 'combo',
      text: '<br />音频方向<br />',
      value: 1,
      options: [
        { label: '向上/左-Upward-Left', value: 1 },
        { label: '向外-Outward', value: 2 },
      ],
    },
  });
  assert.strictEqual(out[0].options[0].label, '向上/左-Upward-Left',
    `选项名被截成 ${JSON.stringify(out[0].options[0].label)} —— `
    + '斜杠在这里是名字的一部分，不是双语分隔符');
});

// ⚠️ 两种斜杠必须分开对待 —— 这是我改 label 解析时漏掉的第二个格式。
//
//   `渲染精度 / Render Resolution`   ← 两侧有空格 = 双语分隔符，要切
//   `向上/左-Upward-Left`            ← 没有空格 = 名字的一部分，不能切
//
// 第一版我只处理了前一种（按 `/` 切），第二版只处理后一种（完全不切）——
// 各让一条测试报红。**两种真实格式都在样本里，而我一次只看到一种。**
check('双语用「空格斜杠空格」分隔才切，名字里的斜杠不切', () => {
  const bilingual = WE.controlsOf({
    k: { type: 'slider', text: '渲染精度 / Render Resolution', value: 1 },
  });
  assert.strictEqual(bilingual[0].label, '渲染精度', '纯文本双语没拆开');

  const slashInName = WE.controlsOf({
    k: { type: 'slider', text: '圆心-X(%)', value: 1 },
  });
  assert.strictEqual(slashInName[0].label, '圆心-X(%)', '名字里的括号被吃了');

  // 没有空格的斜杠不许切
  const noSpace = WE.controlsOf({
    k: { type: 'slider', text: '上/下方向', value: 1 },
  });
  assert.strictEqual(noSpace[0].label, '上/下方向',
    `被切成 ${JSON.stringify(noSpace[0].label)} —— 没有空格的斜杠是名字的一部分`);
});

check('没有 text 时用 key 兜底（而不是空白）', () => {
  const out = WE.controlsOf({ myKey: { type: 'slider', value: 1 } });
  assert.strictEqual(out[0].label, 'myKey',
    '没有 text 时名字是空的 ⟹ 面板上一行空白，用户不知道那是什么');
  // 只有标签没有文字时也要兜底
  const out2 = WE.controlsOf({ k2: { type: 'slider', text: '<br /><br />', value: 1 } });
  assert.strictEqual(out2[0].label, 'k2', 'text 全是标签时没兜底');
});


console.log('\n  condition：决定用户能不能找到属性');

// ⚠️⚠️ **这是"看不到属性"的根因。** 我压根没实现 condition。
//
// 用户报（2026-07-31）：「没有看到你说的这些属性」，而他贴的面板输出里
//「音频样式」「音频方向」「可视化音频」各出现**两次**。
//
// 真实数据（884307090）：
//   showCircle    condition: "visual_audio_model.value == 1"   ← 圆环那套
//   PWLineShow    condition: "visual_audio_model.value == 2"   ← 直线那套
//   PolygonAngle  condition: "visual_audio_model.value == 1 && showSemiCircle.value == false"
//
// 默认 `visual_audio_model = 1` ⟹ PWLine 那 20 个控件**本该隐藏**。
// 而我全都显示 ⟹ 13 组重名 ⟹ 属性在，但埋在一堆同名项里找不到。
// 实测：过滤后 165 → 67 个，重名从 13 组降到 1 组。

check('condition 求值：真实数据里出现的全部形状', () => {
  const v = {
    visual_audio_model: 1, showSemiCircle: false, weather_show: false,
    ColorMode: 2, selectmusic: '', MuiscModel: 0, PWLinePosition: 1,
    BlurColorGradient: false, Test_Author: true,
  };
  const cases = [
    // 数字相等/不等
    ['visual_audio_model.value == 1', true],
    ['visual_audio_model.value == 2', false],
    ['MuiscModel.value != 0', false],
    // 布尔
    ['Test_Author.value == true', true],
    ['showSemiCircle.value == false', true],
    ['weather_show.value == true', false],
    // 空字符串（file 类型"还没选"）
    ["selectmusic.value != '' ", false],
    // && 连接
    ['visual_audio_model.value == 1 && showSemiCircle.value == false', true],
    ['visual_audio_model.value == 1 && showSemiCircle.value == true', false],
    // || 连接 + 括号（真实样本 PWLineBlurColor 的形状）
    ["MuiscModel.value != 0 || selectmusic.value != '' ", false],
    ['(visual_audio_model.value == 1 && ColorMode.value == 2)'
      + '||(ColorMode.value == 2 && BlurColorGradient.value == false )', true],
  ];
  for (const [cond, want] of cases) {
    assert.strictEqual(WE.evalCondition(cond, v), want,
      `condition ${JSON.stringify(cond)} 求值成 ${!want}，期望 ${want}`);
  }
});

// ⚠️ 认不出来的一律显示 —— 宁可多显示一个，也不要把用户要的控件藏起来。
check('看不懂的 condition 一律显示（不许藏掉控件）', () => {
  const weird = ['someWeirdSyntax(', 'a.value ~= 3', 'foo && bar', ''];
  for (const c of weird) {
    assert.strictEqual(WE.evalCondition(c, {}), true,
      `看不懂的 condition ${JSON.stringify(c)} 被判成隐藏 —— `
      + '宁可多显示一个，也不要因为解析不了而藏掉用户需要的控件');
  }
  assert.strictEqual(WE.evalCondition(null, {}), true, '没有 condition 时该显示');
});

// ⚠️ 不许用 eval —— condition 是第三方壁纸提供的字符串。
check('condition 不用 eval（那是第三方壁纸给的字符串）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'we-host.js'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/\beval\(/.test(code),
    'condition 用 eval 求值 ⟹ 工坊里任意壁纸能在我们的进程里执行代码，'
    + '而那和我们为了安全开着 contextIsolation 自相矛盾');
  assert.ok(!/new Function\(/.test(code), '同上：new Function 等于 eval');
});

// ⚠️ 真实样本上的端到端效果 —— 这条直接对应用户报的现象。
// ⚠️ 用**第二个**样本（完美壁纸）—— 第一个（音域回响）只有 44 个控件、
// 几乎没有 condition，压根暴露不出这个 bug。那正是"一个样本证明不了兼容性"。
check('（真样本 884307090）过滤后重名控件降到 2 组以内', () => {
  if (!sampleJSON2) { console.log('    （跳过：样本不在）'); return; }
  const p = WE.parseProject(sampleJSON2);
  const controls = WE.controlsOf(p.properties);
  const values = {};
  for (const c of controls) values[c.key] = c.value;
  const visible = controls.filter((c) => WE.evalCondition(c.condition, values));

  const nameCount = new Map();
  for (const c of visible) {
    if (c.type === 'group') continue;
    nameCount.set(c.label, (nameCount.get(c.label) || 0) + 1);
  }
  const dupes = [...nameCount.entries()].filter(([, n]) => n > 1);
  assert.ok(dupes.length <= 2,
    `过滤后还有 ${dupes.length} 组重名控件：${dupes.map(([n]) => n).join(', ')}`
    + ' ⟹ 用户分不清哪个属于哪套（他实测报过「音频样式」出现两次）');
  assert.ok(visible.length < controls.length * 0.6,
    `过滤后 ${visible.length}/${controls.length} —— 筛掉的太少，`
    + 'condition 大概没生效（真样本应该从 165 降到 67 左右）');
});

// ⚠️⚠️⚠️ **`elapsedTime` 是快照，不是当前位置**（0.9.117）。
//
// 用户 2026-08-02 的诊断报告（网易云正在放《无情画》）是决定性证据：
//     elapsedTime: 0.046439909297052155   ← 47 毫秒
//     duration:    230.69025              ← 230 秒（对的）
//     timestamp:   2026-08-02T13:50:33Z
// 而报告导出时刻 13:52:17.893 —— 比 timestamp **晚 104.9 秒**
//     0.046 + 104.9 = **104.9 / 230.7** ⟹ 那才是真实位置。
//
// ⟹ 播放器只在**状态变化时**（换歌/暂停/拖动）publish 一次，`elapsedTime` 冻结在
//   那一刻 ⟹ 直接用它，进度条永远停在开头附近，而壁纸自己的计时器从那儿往前跑、
//   到总长就重置 —— 那正是用户看到的现象。
//
// ⚠️⚠️ 而我为这个 bug 猜了四轮（字段名 → 单位 → 频率 → 采集方式），
//   **每轮都在推断，而真实数据一次就给出答案**。
//   ⟹ 判据：**"值不对"和"字段名不对"是两类问题，先看到真实值再决定改哪个。**
//     前三次都栽在字段名上，让我形成了"又是名字错了"的惯性 —— 而这次名字是对的。
check('进度按 timestamp 外推（elapsedTime 是快照）', () => {
  const now = Date.now();
  const ago = (ms) => new Date(now - ms).toISOString();

  // ①⭐ 用户那条真实数据：104.9 秒前的快照
  const real = WE.mediaTimeline({
    elapsedTime: 0.0464, duration: 230.69, timestamp: ago(104900), playing: true });
  assert.ok(Math.abs(real.position - 104.9) < 1,
    `真实数据外推错了：${real.position}（该 ≈ 104.9）`
    + ' —— elapsedTime 是 timestamp 那一刻的快照，要加上漂移');

  // ②⚠️ 暂停时**不许外推** —— 时间不走，外推会让进度条在暂停时继续爬
  //   （那比停在开头更像坏了）
  assert.strictEqual(WE.mediaTimeline({
    elapsedTime: 42, duration: 230, timestamp: ago(60000), playing: false }).position, 42,
  '暂停时还在外推 ⟹ 进度条会自己往前爬');

  // ③⚠️ timestamp 解析不出来就退回裸值（别外推一个错的量）
  // 4b ⚠️⚠️ timestamp 无效时**不许污染 position**。
  //   `Date.parse('不是日期')` 给 NaN，而 `NaN > 0` 是 false ⟹ 后面那个
  //   `if (drift > 0)` 恰好兜住了它 ⟹ "删掉 isFinite 检查"这个改法**结果不变**
  //   （反向验证显示永久绿逮到的）。
  //   ⟹ 所以断言不能只比值，要直接验 position 是**有限数** ——
  //     那是"NaN 有没有一路传到壁纸"的唯一判据。
  const badTs = WE.mediaTimeline({
    elapsedTime: 42, duration: 230, timestamp: '不是日期', playing: true });
  assert.ok(Number.isFinite(badTs.position),
    `timestamp 坏了让 position 变成 ${badTs.position}（NaN 会一路传到壁纸）`);
  assert.strictEqual(badTs.position, 42, 'timestamp 坏了没退回裸值');
  assert.strictEqual(WE.mediaTimeline({
    elapsedTime: 42, duration: 230, playing: true }).position, 42,
  '没有 timestamp 时不该外推');

  // ④⚠️ 夹在 [0, duration] —— 暂停很久没 publish 时外推会超过总长
  //   ⟹ 进度条冲出轨道
  assert.strictEqual(WE.mediaTimeline({
    elapsedTime: 200, duration: 230, timestamp: ago(600000), playing: true }).position, 230,
  '外推超过总长没夹住 ⟹ 进度条会冲出轨道');

  // ⑤⚠️ 未来的 timestamp（时钟不对）不外推 —— 负漂移会把进度往回拉
  assert.strictEqual(WE.mediaTimeline({
    elapsedTime: 42, duration: 230,
    timestamp: new Date(now + 60000).toISOString(), playing: true }).position, 42,
  '未来的 timestamp 产生负漂移 ⟹ 进度会被往回拉');

  // ⑥ duration 拿不到时不夹上限（否则一律变 0）
  const noDur = WE.mediaTimeline({
    elapsedTime: 10, duration: 0, timestamp: ago(30000), playing: true });
  assert.ok(noDur.position > 30, `duration 为 0 时被错夹成 ${noDur.position}`);
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
