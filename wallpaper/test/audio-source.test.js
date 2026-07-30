// audio-source.js：helper 的行解析、状态翻译、编译缓存。
//
//   node test/audio-source.test.js
//
// 采集本身要 macOS + ScreenCaptureKit + 屏幕录制权限，云端一条都没有。所以这里测的是
// **能测的那部分**：协议解析和状态判定。它们恰好是最容易静默出错的部分 ——
// 半行 JSON、权限被拒、按 App 过滤悄悄退回全局。
const assert = require('node:assert');
const path = require('node:path');
const A = require('../src/audio-source.js');

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

console.log('\naudio-source.js');

console.log('\n  行协议');

// helper 永不结束，所以不能等进程退出再解析；而 stdout 是流，一次 data 事件里
// 可能是半行、也可能是三行半。这两种情况都必须对。
check('一次拿到多行都解析出来', () => {
  const { messages, tail } = A.parseLines('',
    '{"type":"status","state":"running"}\n{"type":"audio","bins":[1,2]}\n');
  assert.strictEqual(messages.length, 2);
  assert.strictEqual(messages[0].state, 'running');
  assert.deepStrictEqual(messages[1].bins, [1, 2]);
  assert.strictEqual(tail, '');
});

// ⚠️ 这条是这一节的核心：不完整的尾巴必须留着，不能解析也不能丢。
// 丢了就是每隔几帧掉一帧数据（画面偶尔卡顿），而且完全不报错。
check('半行留在 tail 里，下次拼上', () => {
  const first = A.parseLines('', '{"type":"audio","bi');
  assert.strictEqual(first.messages.length, 0);
  assert.ok(first.tail.length > 0, '半行被丢了');

  const second = A.parseLines(first.tail, 'ns":[0.5]}\n');
  assert.strictEqual(second.messages.length, 1);
  assert.deepStrictEqual(second.messages[0].bins, [0.5]);
});

check('空行被跳过', () => {
  const { messages } = A.parseLines('', '\n\n{"type":"status","state":"ok"}\n\n');
  assert.strictEqual(messages.length, 1);
});

// swiftc 的警告或 helper 的杂输出可能混进来。不该让一行垃圾把整条流搞崩。
check('非 JSON 的行标成 garbage 而不是抛', () => {
  const { messages } = A.parseLines('', 'warning: 这不是 JSON\n{"type":"status","state":"ok"}\n');
  assert.strictEqual(messages.length, 2);
  assert.strictEqual(messages[0].type, 'garbage');
  assert.strictEqual(messages[1].state, 'ok');
});

console.log('\n  状态翻译（每种失败都要有一句人话）');

// ⚠️ 这一节存在的全部理由：没授权 → 没数据 → 柱子不动，而那和"网易云没在放歌"、
// "这个壁纸不支持音频"是同一个画面。AirCursor 为同形状的问题烧掉四轮
// （缺权限时 CGEvent.post 静默丢弃）。所以每个状态都必须能变成一行给人看的字。
check('denied 给出具体该去哪开权限', () => {
  const out = A.describeStatus({ type: 'status', state: 'denied', message: 'x' });
  assert.strictEqual(out.ok, false);
  assert.match(out.text, /屏幕录制/, '没告诉用户去开哪个权限');
});

// ⚠️ 这条是个真实的语义陷阱：helper 在 macOS < 14.4 上找不到 per-app 过滤能力时会
// **退回全系统混音**。如果我们把 filtered:false 也报成"正在抓网易云"，用户会以为
// "只跟网易云联动"生效了，而实际上视频和提示音都在驱动画面。
check('抓全局混音时明确说出来（不能假装在抓网易云）', () => {
  const filtered = A.describeStatus({ type: 'status', state: 'running', filtered: true });
  const global = A.describeStatus({ type: 'status', state: 'running', filtered: false });
  assert.ok(filtered.ok && global.ok);
  assert.notStrictEqual(filtered.text, global.text, '两种情况说的是同一句话');
  assert.match(global.text, /全系统|其他|之外/, '没说明别的声音也会影响画面');
  assert.strictEqual(global.filtered, false);
});

check('warning 仍算能用，但 filtered 为 false', () => {
  const out = A.describeStatus({ type: 'status', state: 'warning', message: '没找到网易云' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.filtered, false);
  assert.match(out.text, /网易云/);
});

check('stopped / error 都判为不可用并带原因', () => {
  assert.strictEqual(A.describeStatus({ type: 'status', state: 'stopped' }).ok, false);
  const err = A.describeStatus({ type: 'status', state: 'error', message: '没有显示器' });
  assert.strictEqual(err.ok, false);
  assert.match(err.text, /显示器/);
});

check('探针区分"通过"和"通过但没找到网易云"', () => {
  const found = A.describeStatus({ type: 'status', state: 'ok', targetFound: true });
  const missing = A.describeStatus({ type: 'status', state: 'ok', targetFound: false });
  assert.strictEqual(found.targetFound, true);
  assert.strictEqual(missing.targetFound, false);
  assert.notStrictEqual(found.text, missing.text);
});

check('未知状态不返回 null（否则面板会静默什么都不显示）', () => {
  const out = A.describeStatus({ type: 'status', state: '没见过的状态' });
  assert.ok(out && out.text, '未知状态被吞了');
  assert.strictEqual(out.ok, false);
});

check('非 status 消息返回 null', () => {
  assert.strictEqual(A.describeStatus({ type: 'audio', bins: [] }), null);
  assert.strictEqual(A.describeStatus(null), null);
});

console.log('\n  helper 编译');

check('源码不存在时报错而不是抛', () => {
  const out = A.ensureHelper('/不存在/x.swift', '/tmp');
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /不在/);
});

check('编译失败把 swiftc 的话带出来（不然只知道"失败了"）', () => {
  const fake = () => ({ status: 1, stderr: 'error: 第 42 行语法错误' });
  const out = A.ensureHelper(__filename, '/tmp/gw-audio-test', fake);
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /第 42 行/, 'swiftc 的原文没带出来');
});

// 按源码 hash 命名：源码没变就不重编。
// ⚠️ 代价是源码一变路径就变，而 macOS 的权限是按二进制路径记的 ⟹ 改 helper 要重新授权。
// AirCursor 在这上面栽过（"helper 路径带版本号致授权静默失效"）。仍然用 hash 是因为
// 固定名字会让旧二进制被静默复用，那更难查。
check('产物名字带源码 hash', () => {
  const out = A.ensureHelper(__filename, '/tmp/gw-audio-test', () => ({ status: 0 }));
  assert.strictEqual(out.ok, true);
  assert.match(path.basename(out.binary), /^GestureWallAudio-[0-9a-f]{12}$/,
    `产物名不带 hash：${out.binary}`);
});

console.log('\n  网易云');

check('网易云 bundle id 是常量而不是散在各处', () => {
  assert.strictEqual(A.NETEASE_BUNDLE, 'com.netease.163music');
});

console.log('\n  开发模式 vs 打包（两个授权身份）');

// ⚠️ macOS 按二进制记权限。npm start 跑的是 node_modules 里的 Electron ⟹ 「屏幕录制」
// 列表里出现的是 Electron，**不是本应用**。所以"去勾上本应用"在开发模式下是一条
// 做不到的指令 —— 用户会找不到条目，然后合理地怀疑自己操作错了。
//
// 这条实测发生过：用户问"但是我们这个是应用吗，我好像没看到"。
check('开发模式的提示说清"要打包才能验"，不叫用户去勾不存在的条目', () => {
  const dev = A.permissionHint(false);
  assert.match(dev, /npm start|开发模式/, '没说明这是开发模式的限制');
  assert.match(dev, /打包|\.app/, '没告诉用户要打包');
  assert.ok(!/勾上本应用/.test(dev), '开发模式下还在叫用户勾一个不存在的列表项');
});

check('打包后的提示才给授权路径，并提醒要重启进程', () => {
  const packed = A.permissionHint(true);
  assert.match(packed, /屏幕录制/, '没给权限位置');
  // macOS 只在进程启动时读授权，勾完不重启等于没勾 —— 那会看起来像"授权没用"。
  assert.match(packed, /退出|重启|重新打开/, '没提醒授权后要完全退出再打开');
});

check('denied 状态按身份给不同文案，并标出 needsPackaging', () => {
  const dev = A.describeStatus({ type: 'status', state: 'denied', message: 'x' }, false);
  const packed = A.describeStatus({ type: 'status', state: 'denied', message: 'x' }, true);
  assert.strictEqual(dev.needsPackaging, true);
  assert.notStrictEqual(dev.text, packed.text, '两种身份说的是同一句话');
});

// 默认值必须是"打包"，因为漏传参数时给出"要打包"的建议是无害的，
// 而反过来（在开发模式说"去勾上本应用"）会让用户白折腾。
check('packaged 默认为 true（漏传时宁可给保守建议）', () => {
  const out = A.describeStatus({ type: 'status', state: 'denied' });
  assert.strictEqual(out.needsPackaging, false);
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
