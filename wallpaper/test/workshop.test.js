// workshop.js：Steam 创意工坊的 ID 解析、steamcmd 输出翻译、脱敏。
//
//   node test/workshop.test.js
//
// 为什么这些值得测：这条链的失败模式又多又静默 —— 没装 steamcmd、没登录、
// Guard 码过期、ID 不存在、下载了但目录是空的……**每一种都表现成"壁纸没出来"**，
// 而那和渲染坏了完全分不清。所以"把失败翻译成能行动的一句话"就是这一层的产品价值。
const assert = require('node:assert');
const W = require('../src/workshop.js') || globalThis.GestureWallWorkshop;

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

const S = globalThis.GestureWallWorkshop;

console.log('\nworkshop.js');

console.log('\n  工坊 ID 解析（用户会粘贴各种形式）');

// ⚠️ 只认纯数字会让"从浏览器地址栏复制"这个最自然的动作失败，
// 而失败信息只会是"ID 不合法" —— 用户不知道该改什么。
check('裸数字', () => {
  assert.strictEqual(S.parseWorkshopId('3747222633'), '3747222633');
});

check('创意工坊网页链接', () => {
  assert.strictEqual(
    S.parseWorkshopId('https://steamcommunity.com/sharedfiles/filedetails/?id=3747222633'),
    '3747222633');
});

check('带其他参数的链接', () => {
  assert.strictEqual(
    S.parseWorkshopId('https://steamcommunity.com/sharedfiles/filedetails/?l=schinese&id=3747222633'),
    '3747222633');
});

// WE 自己的分享按钮给的是这个格式。
check('steam:// 协议链接', () => {
  assert.strictEqual(
    S.parseWorkshopId('steam://url/CommunityFilePage/3747222633'), '3747222633');
});

check('前后空格不影响', () => {
  assert.strictEqual(S.parseWorkshopId('  3747222633  '), '3747222633');
});

check('认不出来时返回 null 而不是抛', () => {
  assert.strictEqual(S.parseWorkshopId(''), null);
  assert.strictEqual(S.parseWorkshopId(null), null);
  assert.strictEqual(S.parseWorkshopId('随便一句话'), null);
  // 太短的数字不像工坊 ID（那些是十位数）
  assert.strictEqual(S.parseWorkshopId('123'), null);
});

console.log('\n  steamcmd 参数');

// AppID 写错的后果：steamcmd 去下别的游戏的物品，然后报"找不到" ——
// 而那个错误信息完全指不到真正的原因。
check('AppID 是 Wallpaper Engine 的 431960', () => {
  assert.strictEqual(S.WE_APP_ID, '431960');
  const args = S.downloadArgs({ username: 'u', password: 'p', workshopId: '123' });
  assert.ok(args.includes('431960'), '参数里没有 AppID');
});

// ⚠️ 少了 +quit，steamcmd 会停在交互提示符上等输入 —— 那表现成"卡住不动"，
// 而不是任何错误。用户会以为是网络慢。
check('+quit 必须在最后（否则 steamcmd 卡在交互提示符）', () => {
  const args = S.downloadArgs({ username: 'u', workshopId: '123' });
  assert.strictEqual(args[args.length - 1], '+quit');
});

check('validate 参数在（否则下到损坏的文件也说成功）', () => {
  const args = S.downloadArgs({ username: 'u', workshopId: '123' });
  assert.ok(args.includes('validate'));
});

check('Guard 码在时会带上', () => {
  const args = S.downloadArgs({ username: 'u', password: 'p', guardCode: 'ABCDE', workshopId: '1' });
  assert.ok(args.includes('ABCDE'));
});

check('匿名模式不带用户名密码', () => {
  const args = S.downloadArgs({ anonymous: true, workshopId: '1' });
  assert.ok(args.includes('anonymous'));
  assert.ok(!args.includes('undefined'), '匿名时混进了 undefined');
});

console.log('\n  脱敏（诊断报告会发给别人看）');

// ⚠️ 这条不是洁癖：诊断报告是设计给用户导出后发给我的，而 downloadArgs 里有明文密码。
// 忘了脱敏就等于让用户把 Steam 密码贴进聊天记录。
check('密码和 Guard 码被遮掉，用户名保留', () => {
  const args = S.downloadArgs({
    username: 'moon', password: 'hunter2', guardCode: 'ABCDE', workshopId: '1',
  });
  const safe = S.redactArgs(args);
  const joined = safe.join(' ');
  assert.ok(!joined.includes('hunter2'), '密码泄漏了');
  assert.ok(!joined.includes('ABCDE'), 'Guard 码泄漏了');
  // 用户名保留：诊断时"用的是哪个账号"有价值，而它不是秘密
  assert.ok(joined.includes('moon'), '用户名也被遮了，诊断信息不足');
  // 其余参数不能被吃掉
  assert.ok(joined.includes('431960') && joined.includes('+quit'));
});

check('匿名模式脱敏不出错', () => {
  const safe = S.redactArgs(S.downloadArgs({ anonymous: true, workshopId: '1' }));
  assert.ok(safe.includes('anonymous'));
});

console.log('\n  输出翻译（把失败变成能行动的一句话）');

// "登录失败"这四个字对用户来说能做的事是零。
// 拆开之后：要 Guard 码 → 去看手机；限流 → 等几分钟；密码错 → 改密码。
check('要 Steam Guard 码时说清去哪看', () => {
  const hit = S.classifyLine('Steam Guard code:');
  assert.strictEqual(hit.kind, 'needsGuard');
  assert.match(hit.text, /手机|邮箱|Steam App/);
});

// ⚠️ Steam 因频繁登录临时封锁时，那个错误看起来像密码错。
// 混在一起的话用户会去反复改密码 —— 而正确的动作是等。
check('限流和密码错分开', () => {
  const rate = S.classifyLine('Login Failure: RateLimitExceeded');
  const bad = S.classifyLine('Login Failure: Invalid Password');
  assert.strictEqual(rate.kind, 'rateLimited');
  assert.strictEqual(bad.kind, 'badPassword');
  assert.match(rate.text, /等|频繁/);
});

check('ID 不存在和网络失败分开', () => {
  const notFound = S.classifyLine('ERROR! Download item 123 failed (Failure: FileNotFound).');
  assert.strictEqual(notFound.kind, 'notFound');
  assert.match(notFound.text, /ID|订阅/);
  const other = S.classifyLine('ERROR! Download item 123 failed (Timeout).');
  assert.strictEqual(other.kind, 'downloadFailed');
});

// 买过 WE 才能下它的工坊物品。这条是"账号没这个游戏"，不是网络问题 ——
// 而用户可能用了另一个没买 WE 的账号。
check('账号没有 Wallpaper Engine 单独报', () => {
  const hit = S.classifyLine('No subscription for app 431960');
  assert.strictEqual(hit.kind, 'noSubscription');
  assert.match(hit.text, /Wallpaper Engine|本体/);
});

check('进度百分比带出数字', () => {
  const hit = S.classifyLine('Downloading item 123 ... 45.5%');
  assert.ok(hit.percent > 0, '没解析出百分比');
});

check('成功和失败不会混', () => {
  assert.strictEqual(S.classifyLine('Success. Downloaded item 123').kind, 'downloaded');
  assert.strictEqual(S.classifyLine('Logged in OK').kind, 'loggedIn');
});

check('无关的行返回 null（不污染事件流）', () => {
  assert.strictEqual(S.classifyLine('Redirecting stderr to ...'), null);
  assert.strictEqual(S.classifyLine(''), null);
  assert.strictEqual(S.classifyLine(null), null);
});

console.log('\n  汇总（挑最该说的那一条）');

// ⚠️ 不能取最后一条：steamcmd 结束时经常再打几行收尾信息，
// 而真正的原因在中间。取错了就会报"登录成功"而实际下载失败了。
check('取最严重的那条，不是最后一条', () => {
  const out = S.summarize([
    'Logging in user moon',
    'Logged in OK',
    'ERROR! Download item 123 failed (Failure: FileNotFound).',
    'Waiting for client config...OK',
  ]);
  assert.strictEqual(out.kind, 'notFound', `取到的是 ${out && out.kind}`);
});

check('只有成功信息时报成功', () => {
  const out = S.summarize(['Logged in OK', 'Success. Downloaded item 123']);
  assert.strictEqual(out.kind, 'downloaded');
});

check('登录问题优先于下载问题（那是更根本的原因）', () => {
  const out = S.summarize([
    'Steam Guard code:',
    'ERROR! Download item 123 failed (Failure).',
  ]);
  assert.strictEqual(out.kind, 'needsGuard');
});

check('一行有用的都没有时返回 null', () => {
  assert.strictEqual(S.summarize(['随便', '几行', '废话']), null);
});

check('接受字符串（不只是数组）', () => {
  const out = S.summarize('Logged in OK\nSuccess. Downloaded item 1');
  assert.strictEqual(out.kind, 'downloaded');
});

console.log('\n  路径与安装提示');

// ⚠️ 这个路径是 steamcmd 自己定的、不可配。和它实际写的地方不一致的话，
// 下载成功但我们找不到 ⟹ 症状是"下载完了什么都没发生"。
check('下载目录布局对齐 steamcmd 的约定', () => {
  const p = S.contentPath('/opt/homebrew/Caskroom/steamcmd', '3747222633');
  assert.match(p, /steamapps\/workshop\/content\/431960\/3747222633$/);
});

check('缺参数时返回 null 而不是拼出坏路径', () => {
  assert.strictEqual(S.contentPath(null, '1'), null);
  assert.strictEqual(S.contentPath('/x', null), null);
});

// "请安装 steamcmd"没用。给能直接粘贴的命令，并说清它是官方工具 ——
// 否则"要装个东西才能用我的账号"听起来像可疑操作。
check('安装提示给出可直接粘贴的命令，并说明是官方工具', () => {
  const hint = S.installHint();
  assert.match(hint, /brew install/);
  assert.match(hint, /Valve|官方/);
});

check('候选路径覆盖 Apple Silicon 和 Intel 的 brew 前缀', () => {
  assert.ok(S.STEAMCMD_CANDIDATES.some((p) => p.includes('/opt/homebrew/')));
  assert.ok(S.STEAMCMD_CANDIDATES.some((p) => p.includes('/usr/local/')));
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
