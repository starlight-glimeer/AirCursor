// video 壁纸的错误分流。
//
//   node test/video.test.js
//
// ⚠️⚠️ **这个文件存在的理由：同一个 `code 3` 我给出了两次错的建议，方向相反。**
//
//   2026-08-02 第一次触发（用户截图原文）：
//     code 3: PIPELINE_ERROR_DECODE: Failed to send audio packet for decoding
//     ⟹ 挂的是**音轨**。而当时的提示说"换个 H.264 的壁纸 / 用 ffmpeg 转视频"
//       —— 视频本来就是 H.264，转码白折腾。
//
//   同一天第二次触发：
//     code 3: PIPELINE_ERROR_DECODE: Error Domain=NSOSStatusErrorDomain
//     Code=-12909 "(null)" (-12909): VTDecompressionOutputCallback
//     ⟹ 挂的是**视频轨**（-12909 = VideoToolbox 的 kVTVideoDecoderBadDataErr）。
//       而那时的提示已经被我改成了音轨那套，无条件说"错误里那句 audio packet
//       就是它"—— 而这个错误里**根本没有 audio packet** ⟹ 提示在说谎。
//
// ⟹ 判据：**一个错误码下面可能有完全不同的原因，别给码配一句话。**
//   而这个文件的用例输入**全部是用户截图里的真实错误原文**，不是我编的
//   —— 编的字符串会漏掉真实错误才有的形状（比如 `Code=-12909 "(null)"` 那种）。

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// ⚠️ video.js 顶层要 `document`（它拿 DOM 元素）⟹ 不能直接 require。
//   ⟹ 从源码里抠出 decodeHint 来跑，和 config.test.js 抠 mergeConfig 同一个做法。
//   ⚠️ **抠而不是手抄**：手抄的副本会和源码悄悄分叉，那时测试还是绿的，
//     但守的已经不是真代码了。
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'video.js'), 'utf8');
const match = source.match(/function decodeHint\([^)]*\) \{[\s\S]*?\n\}/);
assert.ok(match, '在 video.js 里找不到 decodeHint —— 函数被改名或删了');
// eslint-disable-next-line no-new-func
const decodeHint = new Function(`${match[0]}; return decodeHint;`)();

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

// ⚠️ 用户截图里的**真实**错误原文（两次触发各一条）
const REAL_AUDIO = 'PIPELINE_ERROR_DECODE: Failed to send audio packet for decoding: '
  + '{timestamp=0 duration=21333 size=847}';
const REAL_VIDEO = 'PIPELINE_ERROR_DECODE: Error Domain=NSOSStatusErrorDomain '
  + 'Code=-12909 "(null)" (-12909): VTDecompressionOutputCallback';

console.log('\nvideo 解码错误分流');

check('音轨那种（真实原文）⟹ 说音轨、给去音轨的命令', () => {
  const h = decodeHint(REAL_AUDIO);
  assert.match(h, /音轨/, '没指出是音轨');
  assert.match(h, /-an\b/, '没给去音轨的 ffmpeg 命令（-an）');
  // ⚠️ 而**不该**让用户转视频 —— 视频轨可能本来就是好的，转码白折腾几分钟
  assert.ok(!/libx264/.test(h),
    '音轨挂了却建议转视频编码（libx264）⟹ 那是 0.9.109 那次的错误方向，'
    + '视频本来就是 H.264，转码白折腾');
  assert.match(h, /-c:v copy/, '没说视频轨直接 copy（不重新编码，秒完）');
});

check('视频轨那种（真实原文）⟹ 说视频轨、不提 audio packet', () => {
  const h = decodeHint(REAL_VIDEO);
  assert.match(h, /视频轨/, '没指出是视频轨');
  // ⚠️⚠️ 这条是这次 bug 的核心：那个错误里**没有** audio packet，
  //   而提示却说"错误里那句 audio packet 就是它"⟹ 提示在说谎。
  assert.ok(!/audio packet/.test(h),
    '视频轨挂了却提 "audio packet" ⟹ 而这个错误里根本没有那句话，提示在说谎');
  assert.match(h, /libx264/, '没给重编码视频的命令');
});

check('视频轨那种要说"可能是放一会儿才挂"（那决定用户怎么处理）', () => {
  const h = decodeHint(REAL_VIDEO);
  // ⚠️ 用户报的是"运行着突然" ⟹ 那说明文件能解码、挂的是某几帧
  //   ⟹ 和"一装载就挂"（编码整个不支持）是两回事，处理方式也不同。
  assert.match(h, /放了一会儿|一装载就挂/,
    '没区分"放一会儿才挂"和"一装载就挂" ⟹ 前者是某几帧的数据问题、'
    + '后者是编码不支持，而用户看到的都是同一句"解码失败"');
});

check('VideoToolbox 的另外几个码也认（不只 -12909）', () => {
  for (const msg of [
    'Code=-12911 (-12911): VTDecompressionOutputCallback',
    'Error Domain=NSOSStatusErrorDomain Code=-8969',
    'VideoToolbox decode failed',
  ]) {
    const h = decodeHint(msg);
    assert.match(h, /视频轨/, `"${msg.slice(0, 40)}…" 没被认成视频轨问题`);
  }
});

check('认不出来的时候**别猜** —— 给观测入口，不给可能是错的建议', () => {
  // ⚠️⚠️ 这是这一整轮的教训：给码配一句话必然对某些原因说错话。
  //   ⟹ 不知道是哪种时，正确的做法是让用户把原文发过来。
  const h = decodeHint('PIPELINE_ERROR_DECODE');
  assert.ok(!/音轨上|视频轨上/.test(h),
    '认不出轨道却断言是哪一轨 ⟹ 那正是栽过两次的形状');
  assert.match(h, /发给我|原文/, '没让用户把错误原文发过来');
  // ⚠️ 但也要给一条"三种都覆盖"的命令 —— 光说"发给我"是把人挂在那儿
  assert.match(h, /libx264/, '兜底没给一条能自己先试的命令');
  assert.match(h, /-an\b/, '兜底那条命令没同时去掉音轨（三种原因要都覆盖）');
});

check('空 message 不抛（err.message 常常是空字符串）', () => {
  for (const v of [undefined, null, '']) {
    assert.doesNotThrow(() => decodeHint(v), `decodeHint(${JSON.stringify(v)}) 抛了`);
    assert.ok(decodeHint(v).length > 20, '空 message 时的兜底提示太短，等于没说');
  }
});

// ---------------------------------------------------------------------------
// ⚠️⚠️ 纯文本里不许有 markdown 标记
// ---------------------------------------------------------------------------
//
// `errHint` 是 `textContent` ⟹ 写 `**音轨**` 会**原样显示成带星号的字**
// （用户 2026-08-02 的截图里就是那样，整段话看起来像乱码）。
// ⚠️ 而我 0.9.135 写 decodeHint 时**又踩了一次** —— 上一版的注释里就写着这条。
// ⟹ 判据：强调靠措辞和顺序，不靠符号。
check('提示里没有 markdown 标记（errHint 是 textContent）', () => {
  for (const msg of [REAL_AUDIO, REAL_VIDEO, 'PIPELINE_ERROR_DECODE', '']) {
    const h = decodeHint(msg);
    assert.ok(!/\*\*/.test(h),
      `提示里有 ** 标记 ⟹ textContent 会原样显示成星号：${h.slice(0, 60)}`);
    assert.ok(!/^\s*[-*] /m.test(h), '提示里有 markdown 列表标记');
    assert.ok(!/`[^`]+`/.test(h), '提示里有反引号 ⟹ 同样会原样显示');
  }
});

// ---------------------------------------------------------------------------
// 中途失败重试（0.9.135）
// ---------------------------------------------------------------------------
//
// 用户 2026-08-02：「video 类型的一个壁纸**运行着突然**解码失败」
// ⚠️ "运行着"是关键：文件能解码（已经放了一段），挂的是某几帧
// ⟹ 而壁纸是循环播放的，从头再来很可能就过去了。
// ⚠️ 判据：**"从没放起来"和"放了一会儿挂了"是两类故障** ——
//   前者重试无用，后者可能是瞬时的。原来的代码对两者一视同仁。
check('中途解码失败会自己重试一次，而且只重试一次', () => {
  const src = source;
  assert.match(src, /let retriedMidPlay = false;/, '没有"重试过了"的标志');
  const at = src.indexOf("video.addEventListener('error'");
  assert.ok(at > 0, '找不到 error handler');
  const handler = src.slice(at, src.indexOf('\n});', at));
  // ⚠️ 三个条件都要在：code 3 / 没重试过 / 已经放过一会儿
  assert.match(handler, /code === 3 && !retriedMidPlay && playedFor > 2/,
    '重试的条件不对 —— 要同时满足"解码错" + "没重试过" + "已经放过 >2 秒"。'
    + '\n⚠️ 缺"没重试过"会变成黑屏闪烁的死循环（比停住更糟）；'
    + '\n⚠️ 缺"放过一会儿"等于把同一个失败做两遍，白等');
  assert.match(handler, /retriedMidPlay = true;/, '没标记"重试过了"⟹ 会无限重试');
  // ⚠️ 而重试失败之后必须照常报错 —— 不能把故障吞掉
  // ⚠️⚠️ `fail(spec.title` 在这个 handler 里出现**两次**（音轨那条路也调它）
  //   ⟹ 只 match 名字的话破坏最后那条断言照样绿（反向验证逮到的）。
  //   ⟹ 锚**最后那次调用的完整形状**（带 `${when}` 那个 —— 只有它有）。
  // ⚠️ `[^`]*` 跨不过嵌套的反引号（那行里有 `${msg ? \`: ${msg}\` : ''}`）
  //   ⟹ 用 `[\s\S]*?` 但**限制长度**，别跨到别的语句去。
  assert.match(handler, /fail\(spec\.title, `code \$\{code\}[\s\S]{0,60}?\$\{when\}`/,
    '重试之后没有带上"放了多久"的 fail(...) ⟹ 真的坏了会永久黑屏且什么都不说');
});

check('详情里带上"放了多久才挂"（那决定用户该转码还是换壁纸）', () => {
  const at = source.indexOf("video.addEventListener('error'");
  const handler = source.slice(at, source.indexOf('\n});', at));
  assert.match(handler, /已放 \$\{playedFor/,
    '错误详情里没说"放了多久才挂" ⟹ 而那是区分"编码不支持"和"某几帧坏了"的'
    + '唯一线索（用户报的正是"运行着突然"）');
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
