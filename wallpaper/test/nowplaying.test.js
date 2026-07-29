// TrackTracker：曲目身份判定 + 封面沿用规则。纯逻辑，不起子进程。
//
//   node test/nowplaying.test.js
//
// 这一层被单独抽出来就是因为它已经错过一次：换歌时释放旧封面的判断写在
// `lastKey = key` **之后**，所以条件恒为 false，一首没封面的歌会一直挂着上一首的
// 封面。那种 bug 在真机上表现为"壁纸卡住了"，不会报错。
const assert = require('node:assert');
const { TrackTracker } = require('../src/nowplaying.js');

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

const song = (title, extra = {}) => ({
  bundleIdentifier: 'com.netease.163music',
  title,
  artist: '某人',
  ...extra,
});

console.log('\nTrackTracker');

check('同一首歌的多次读取算同一首', () => {
  assert.strictEqual(
    TrackTracker.keyOf(song('A', { elapsedTime: 3 })),
    TrackTracker.keyOf(song('A', { elapsedTime: 41 })),
    '播放进度变化被当成了换歌',
  );
});

check('不同歌名算不同曲目', () => {
  assert.notStrictEqual(TrackTracker.keyOf(song('A')), TrackTracker.keyOf(song('B')));
});

check('同名不同 app 算不同曲目', () => {
  const a = TrackTracker.keyOf(song('A'));
  const b = TrackTracker.keyOf({ ...song('A'), bundleIdentifier: 'com.spotify.client' });
  assert.notStrictEqual(a, b);
});

check('第一次拿到封面就带出去', () => {
  const t = new TrackTracker();
  const out = t.accept(song('A', { artworkData: 'AAA', artworkMimeType: 'image/png' }));
  assert.strictEqual(out.artworkData, 'AAA');
  assert.strictEqual(out.artworkMimeType, 'image/png');
});

// 封面在 MediaRemote 侧是懒加载的，换歌后头几次读经常还没有 —— 这时不能闪回中性。
check('同一首歌内，封面缺失时沿用已有的', () => {
  const t = new TrackTracker();
  t.accept(song('A', { artworkData: 'AAA' }));
  const out = t.accept(song('A'));   // 同一首，这次没带封面
  assert.strictEqual(out.artworkData, 'AAA', '同一首歌内封面丢了');
});

// 这就是那个 bug。换歌 + 新歌没封面 ⟹ 必须是 null，不能是上一首的。
check('换歌且新歌没封面 → 封面必须清空（回归守卫）', () => {
  const t = new TrackTracker();
  t.accept(song('A', { artworkData: 'AAA' }));
  const out = t.accept(song('B'));
  assert.strictEqual(out.artworkData, null,
    '换歌后还挂着上一首的封面 —— 释放判断又写在赋值之后了');
  assert.strictEqual(out.artworkMimeType, null);
});

check('换歌且新歌有封面 → 用新的', () => {
  const t = new TrackTracker();
  t.accept(song('A', { artworkData: 'AAA' }));
  const out = t.accept(song('B', { artworkData: 'BBB' }));
  assert.strictEqual(out.artworkData, 'BBB');
});

check('换回上一首要重新等它的封面，不复用', () => {
  const t = new TrackTracker();
  t.accept(song('A', { artworkData: 'AAA' }));
  t.accept(song('B', { artworkData: 'BBB' }));
  const out = t.accept(song('A'));   // 回到 A，但这次读没带封面
  assert.strictEqual(out.artworkData, null, 'A 的旧封面被从缓存里翻出来了');
});

check('mime 缺失时给默认值而不是 null', () => {
  const t = new TrackTracker();
  const out = t.accept(song('A', { artworkData: 'AAA' }));
  assert.strictEqual(out.artworkMimeType, 'image/jpeg');
});

check('原始字段原样透过', () => {
  const t = new TrackTracker();
  const out = t.accept(song('A', { album: '某专辑', duration: 210, playing: true }));
  assert.strictEqual(out.album, '某专辑');
  assert.strictEqual(out.duration, 210);
  assert.strictEqual(out.playing, true);
});

check('reset 之后同一首歌也算新的', () => {
  const t = new TrackTracker();
  t.accept(song('A', { artworkData: 'AAA' }));
  t.reset();
  const out = t.accept(song('A'));
  assert.strictEqual(out.artworkData, null, 'reset 没清掉封面');
});

// 停止播放（title 消失）后再开始，不该把停止前的封面带回来。
check('停止再播放，封面不残留', () => {
  const t = new TrackTracker();
  t.accept(song('A', { artworkData: 'AAA' }));
  t.reset();                          // install 里 title 为空时就是这么做的
  const out = t.accept(song('A', {}));
  assert.strictEqual(out.artworkData, null);
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
