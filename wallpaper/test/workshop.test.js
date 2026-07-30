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

console.log('\n  下载落地在哪（我猜错过一次）');

// ⚠️ 这一节的由来：我原来按"steamcmd 二进制所在目录的上两级"推数据根目录。
// 那在 brew 装的情况下推出 /opt/homebrew —— 完全不对。真实位置是
// ~/Library/Application Support/Steam（steamcmd 自己的启动输出里写着
// "Logging directory: /Users/moon/Library/Application Support/Steam/logs"）。
//
// 而且 /opt/homebrew/bin/steamcmd 只是**包装脚本**，真二进制在
// Caskroom/steamcmd/<版本>/MacOS/ 下 ⟹ 从二进制路径反推这个思路本身就错。
// 猜错的后果：下载真成功了但我们去错地方找 ⟹ 报"下载完了但找不到"。
check('macOS 的标准位置在候选里，且排第一', () => {
  assert.match(S.STEAM_ROOTS[0], /Library\/Application Support\/Steam$/,
    `第一候选不是 macOS 标准位置：${S.STEAM_ROOTS[0]}`);
});

check('逐个候选去找，不靠推断', () => {
  const target = `${S.STEAM_ROOTS[0]}/steamapps/workshop/content/431960/999/project.json`;
  const found = S.findDownloaded('999', (p) => p === target);
  assert.ok(found, '标准位置下的文件没找到');
  assert.match(found, /Library\/Application Support\/Steam/);
});

check('第二候选也能命中（手动装 tar 包的情况）', () => {
  const target = `${S.STEAM_ROOTS[1]}/steamapps/workshop/content/431960/999/project.json`;
  assert.ok(S.findDownloaded('999', (p) => p === target));
});

check('都没有时返回 null（不瞎报一个路径当成功）', () => {
  assert.strictEqual(S.findDownloaded('999', () => false), null);
});

// ⚠️ 找不到时必须把找过的路径全报出来 —— 这条链最可能的失败就是路径不对，
// 而不给路径的话完全没法查。这次就是靠用户贴的 steamcmd 输出才发现我猜错了。
check('找不到时能列出所有找过的路径', () => {
  const paths = S.searchedPaths('999');
  assert.ok(paths.length >= 2, `只找了 ${paths.length} 个地方`);
  for (const p of paths) assert.match(p, /workshop\/content\/431960\/999$/);
});

console.log('\n  内容展示（预览图 / 类型 / 大小）');

// ⚠️ 这一节的由来：用户说"我怎么知道 id 或者链接，平时不都是随便浏览着看的吗"。
// 他说得对 —— 只给填 ID 的输入框等于把命令行搬进 GUI。
//
// 关键发现（读 OWE 的代码确认）：Steam 有两个接口，
//   GetPublishedFileDetails  ✅ 不要 API key —— 标题、预览图、类型、大小
//   QueryFiles               ⚠️ 要 API key —— 搜索、按热度浏览
// 所以"贴链接先看预览"零门槛能做，"应用内浏览整个工坊"要用户去申请免费 key。
check('详情接口是免 key 的那个', () => {
  assert.match(S.DETAILS_ENDPOINT, /ISteamRemoteStorage\/GetPublishedFileDetails/);
});

// 这个接口只吃表单编码，不是 JSON。
check('请求体是表单编码，支持批量', () => {
  const body = S.detailsBody(['111', '222']);
  assert.strictEqual(body, 'itemcount=2&publishedfileids[0]=111&publishedfileids[1]=222');
});

check('空输入不产生坏请求', () => {
  assert.strictEqual(S.detailsBody([]), 'itemcount=0');
  assert.strictEqual(S.detailsBody(null), 'itemcount=0');
});

// WE 用 tag 标类型 —— 这是**下载之前**知道类型的唯一途径。
// ⟹ 靠它能在下载几百 MB 之前就说清"这是 scene，装了也只能看静态图"。
check('从 tag 认出四种类型', () => {
  assert.strictEqual(S.typeFromTags([{ tag: 'Scene' }]), 'scene');
  assert.strictEqual(S.typeFromTags([{ tag: 'Video' }]), 'video');
  // tag 里混着别的分类标签（Anime、Nature 那些），要能挑出类型那个
  assert.strictEqual(S.typeFromTags([{ tag: 'Anime' }, { tag: 'Web' }]), 'web');
  assert.strictEqual(S.typeFromTags([{ tag: 'Nature' }]), null);
  assert.strictEqual(S.typeFromTags(null), null);
});

check('详情解析出预览图、标题、类型、能不能跑', () => {
  const item = S.parseDetail({
    publishedfileid: '3747222633', result: 1, title: '音域回响',
    preview_url: 'https://images.steamusercontent.com/x.jpg',
    tags: [{ tag: 'Web' }], file_size: '2500000', subscriptions: 1234,
  });
  assert.strictEqual(item.ok, true);
  assert.strictEqual(item.title, '音域回响');
  assert.strictEqual(item.type, 'web');
  assert.strictEqual(item.supported, true, 'web 类应该判为能跑');
  assert.ok(item.preview);
});

check('scene / application 判为不能跑', () => {
  for (const tag of ['Scene', 'Application']) {
    const item = S.parseDetail({
      publishedfileid: '1', result: 1, title: 'x', tags: [{ tag }],
    });
    assert.strictEqual(item.supported, false, `${tag} 被误判成能跑`);
  }
});

// ⚠️ 已删除/私有的物品：API 返回 result != 1 且大部分字段缺失。
// 不处理的话界面上出现一张无字白卡片 —— 用户不知道是加载中还是壁纸没了。
check('已删除 / 私有的物品说清原因，不给白卡片', () => {
  const item = S.parseDetail({ publishedfileid: '999', result: 9 });
  assert.strictEqual(item.ok, false);
  assert.match(item.reason, /删除|私有|ID/);
});

check('没有 id 的项直接丢掉（不产生空卡片）', () => {
  assert.strictEqual(S.parseDetail({ result: 1, title: 'x' }), null);
  assert.strictEqual(S.parseDetail(null), null);
});

check('响应解析容错（字段缺失不抛）', () => {
  assert.deepStrictEqual(S.parseDetailsResponse(null), []);
  assert.deepStrictEqual(S.parseDetailsResponse({ response: {} }), []);
  const items = S.parseDetailsResponse({
    response: { publishedfiledetails: [{ publishedfileid: '1', result: 1 }, null] },
  });
  assert.strictEqual(items.length, 1);
});

// ⚠️ 显示 "228893184" 对做决定毫无帮助 —— 用户要判断的是"这个值不值得等"。
check('大小格式化成人能读的', () => {
  assert.match(S.formatSize(2500000), /2\.4 MB/);
  assert.match(S.formatSize(2500000000), /2\.3\d GB/);
  assert.match(S.formatSize(5000), /5 KB/);
  assert.strictEqual(S.formatSize(0), '大小未知');
  assert.strictEqual(S.formatSize(null), '大小未知');
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
