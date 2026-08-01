// workshop.js：Steam 创意工坊的 ID 解析、steamcmd 输出翻译、脱敏。
//
//   node test/workshop.test.js
//
// 为什么这些值得测：这条链的失败模式又多又静默 —— 没装 steamcmd、没登录、
// Guard 码过期、ID 不存在、下载了但目录是空的……**每一种都表现成"壁纸没出来"**，
// 而那和渲染坏了完全分不清。所以"把失败翻译成能行动的一句话"就是这一层的产品价值。
const assert = require('node:assert');
// ⚠️ 这一行原来是 `require('../src/workshop.js') || globalThis.GestureWallWorkshop`
// —— **一直是坏的**：workshop.js 是 IIFE 挂 globalThis，`require` 返回 `{}`，
// 而 `{}` 是真值 ⟹ `||` 短路 ⟹ `W` 恒为空对象。
//
// 它没被发现是因为**没有任何测试用过 `W`**（都用下面的 `S`）——
// 直到我加了两条用 `W.findWallpaperDirs` 的，立刻 `is not a function`。
// ⟹ 教训：**"或"兜底遇到空对象不会兜**（`{} || x` 给 `{}`）；
//    而一个从没被用过的导入不会报错，它会一直躺着等下一个人踩。
// ⚠️ **require 那次调用不能删** —— workshop.js 是 IIFE，它的副作用就是
// 往 globalThis 挂对象。我第一版把 require 删了只留 globalThis 引用
// ⟹ 模块压根没加载 ⟹ 所有测试 `Cannot read properties of undefined`。
require('../src/workshop.js');
const W = globalThis.GestureWallWorkshop;

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

check('详情解析出预览图、标题、类型', () => {
  const item = S.parseDetail({
    publishedfileid: '3747222633', result: 1, title: '音域回响',
    preview_url: 'https://images.steamusercontent.com/x.jpg',
    tags: [{ tag: 'Web' }], file_size: '2500000', subscriptions: 1234,
  });
  assert.strictEqual(item.ok, true);
  assert.strictEqual(item.title, '音域回响');
  assert.strictEqual(item.type, 'web');
  assert.ok(item.preview);
});

// ⚠️ 这条断言是反向的：parseDetail **不该**判断支持性。
//
// 它曾经判过（硬编码 `type === 'web' || type === 'video'`），然后加 image 类型时
// 这边没跟着改 ⟹ 用户看到"看起来是 image · 大概不支持"，而它其实支持、
// 甚至真的放出来了。同一个事实有两个来源就一定会漂。
// ⟹ 支持性只有 we-host.js 的 TYPES 一个来源，主进程在转发详情时加上。
check('parseDetail 不判断支持性（那是 we-host 的唯一职责）', () => {
  const item = S.parseDetail({
    publishedfileid: '1', result: 1, title: 'x', tags: [{ tag: 'Web' }],
  });
  assert.strictEqual(item.supported, undefined,
    'parseDetail 又开始判支持性了 —— 那份判断会和 TYPES 漂开');
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

console.log('\n  legacy 单文件工坊物品（实测撞上的）');

// ⚠️ 这一节完全来自一次真实失败。用户下 3339949060，steamcmd 说：
//   Success. Downloaded item ... to ".../3339949060/…_legacy.bin" (966026 bytes)
//
// 也就是**下载真的成功了**，但落地的是一个 .bin 归档而不是 project.json + 资产。
// Steam 对老的单文件上传不解包，原样存。
//
// 我原来的成功判据（目录里有 project.json）把它判成失败 ⟹ 报"下载完了但找不到文件"，
// 而那会让人去查网络和账号 —— 方向完全错，因为下载压根没问题。
check('按后缀找 legacy.bin（文件名前缀是 Steam 生成的随机数字）', () => {
  const found = S.findLegacyBin('/x/1', () => ['2479884489559000807_legacy.bin']);
  assert.strictEqual(found, '/x/1/2479884489559000807_legacy.bin');
});

check('没有 legacy.bin 时返回 null', () => {
  assert.strictEqual(S.findLegacyBin('/x/1', () => ['project.json']), null);
  // 目录读不了也不能抛
  assert.strictEqual(S.findLegacyBin('/x/1', () => { throw new Error('ENOENT'); }), null);
});

// 里面是什么只能靠魔数判，**不能猜** —— zip / WE 私有归档 / 裸视频，
// 三种处置完全不同，判错就是又一轮来回。
check('魔数认出 zip / 视频 / 图片', () => {
  assert.strictEqual(S.sniffLegacy([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]).kind, 'zip');
  assert.strictEqual(S.sniffLegacy([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]).kind, 'mp4');
  assert.strictEqual(S.sniffLegacy([0x47, 0x49, 0x46, 0x38, 0, 0, 0, 0]).kind, 'gif');
  assert.strictEqual(S.sniffLegacy([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).kind, 'png');
  assert.strictEqual(S.sniffLegacy([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]).kind, 'webm');
});

// WE 的私有归档要 scene 渲染 —— 认出来才能明确说"不支持"而不是瞎解压。
check('认出 WE 的 PKGV 私有归档', () => {
  const head = [13, 0, 0, 0, 0x50, 0x4b, 0x47, 0x56, 0x30, 0x30, 0x31, 0x33];
  assert.strictEqual(S.sniffLegacy(head).kind, 'pkgv');
});

// ⚠️ 判不出来时必须给出头几个字节。那串十六进制能让我直接查是什么格式，
// 而"不支持的格式"这五个字什么信息都没有。
check('认不出的格式给出开头字节（那是唯一能往下查的线索）', () => {
  const out = S.sniffLegacy([0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4]);
  assert.strictEqual(out.kind, 'unknown');
  assert.ok(out.hex, '没给十六进制');
  assert.match(out.hex, /de ad be ef/);
});

check('空文件或太小的单独报', () => {
  assert.strictEqual(S.sniffLegacy([]).kind, 'empty');
  assert.strictEqual(S.sniffLegacy(null).kind, 'empty');
  assert.strictEqual(S.sniffLegacy([1, 2]).kind, 'empty');
});

// 目录在但 project.json 不在，和"下载失败"是两件完全不同的事 ——
// steamcmd 说了 Success，混在一起报会让人去查网络。
check('区分"目录不在"和"目录在但没 project.json"', () => {
  const dirOnly = `${S.STEAM_ROOTS[0]}/steamapps/workshop/content/431960/1`;
  // findDownloaded 要 project.json，findDownloadedDir 只要目录
  assert.strictEqual(S.findDownloaded('1', (p) => p === dirOnly), null);
  assert.strictEqual(S.findDownloadedDir('1', (p) => p === dirOnly), dirOnly);
});

console.log('\n  类型推断（实测撞上"类型未标注"）');

// ⚠️ 用户实测：查 3339949060，预览图和标题都出来了，**类型显示"未标注"**。
// 原因是那个物品的 tags 里没有 Scene/Video/Web —— 老物品或作者没选分类的都这样。
//
// 而"未标注"这三个字让用户只能靠猜要不要下。类型其实还能从 filename 推：
// legacy 单文件物品的 filename 就是原始上传的文件名，带扩展名。
check('tag 没标类型时从 filename 推', () => {
  assert.strictEqual(S.typeFromFilename('wallpaper.mp4'), 'video');
  assert.strictEqual(S.typeFromFilename('anim.gif'), 'image');
  assert.strictEqual(S.typeFromFilename('scene.pkg'), 'scene');
  // zip 里可能是任何一种，推不出来就别瞎猜
  assert.strictEqual(S.typeFromFilename('stuff.zip'), null);
  assert.strictEqual(S.typeFromFilename(null), null);
});

// ⚠️ 两个来源必须分开记：把推断显示成确定，用户会按错的信息做决定。
check('typeSource 区分"作者标的"和"我们推的"', () => {
  const tagged = S.parseDetail({
    publishedfileid: '1', result: 1, title: 'x',
    tags: [{ tag: 'Web' }], filename: 'whatever.mp4',
  });
  assert.strictEqual(tagged.type, 'web');
  assert.strictEqual(tagged.typeSource, 'tag', 'tag 存在时不该用文件名');

  const inferred = S.parseDetail({
    publishedfileid: '2', result: 1, title: 'x',
    tags: [{ tag: 'Anime' }], filename: 'clip.mp4',
  });
  assert.strictEqual(inferred.type, 'video');
  assert.strictEqual(inferred.typeSource, 'filename');

  const unknown = S.parseDetail({ publishedfileid: '3', result: 1, title: 'x' });
  assert.strictEqual(unknown.type, null);
  assert.strictEqual(unknown.typeSource, null);
});

// 推断出的类型要能被支持性判定用上 —— 但那个判定在 we-host，
// 所以这里只验"类型推出来了且带了来源标记"。
check('推断出的类型带 typeSource，供上层判支持性', () => {
  const item = S.parseDetail({
    publishedfileid: '1', result: 1, title: 'x', filename: 'a.mp4',
  });
  assert.strictEqual(item.type, 'video');
  assert.strictEqual(item.typeSource, 'filename');
  // 支持性由主进程用 WE.isSupportedType(item.type) 补上，这里不该有
  assert.strictEqual(item.supported, undefined);
});

console.log('\n  浏览工坊（仿 Steam 排版）');

// ⚠️ 这条是 Steam 的硬规则：search_text 非空时必须用 query_type=12
//（RankedByTextSearch）。用别的值搜索词会被**静默忽略** ——
// 返回的是热门榜，而那看起来像"搜索没用"。
check('有搜索词时强制用文本搜索的 query_type', () => {
  assert.strictEqual(S.queryTypeFor('trending', true), 12);
  assert.strictEqual(S.queryTypeFor('recent', true), 12, '有搜索词时排序不该覆盖它');
  // 没搜索词时按排序走
  assert.strictEqual(S.queryTypeFor('trending', false), 3);
  assert.strictEqual(S.queryTypeFor('recent', false), 1);
});

check('未知排序回落到热门，不产生非法 query_type', () => {
  assert.strictEqual(S.queryTypeFor('不存在的排序', false), 3);
  assert.strictEqual(S.queryTypeFor(null, false), 3);
});

// ⚠️ return_previews / return_tags 少了的话，返回的项**没有预览图和类型** ——
// 而那正是"浏览着挑壁纸"的全部依据。用户明确说过"预览图是可以看到的吧"。
check('请求必须要预览图和类型标签（那是浏览的全部依据）', () => {
  const p = S.browseParams({ key: 'K', page: 1 });
  assert.strictEqual(p.get('return_previews'), 'true', '没要预览图');
  assert.strictEqual(p.get('return_tags'), 'true', '没要类型标签');
  assert.strictEqual(p.get('appid'), '431960');
});

check('搜索词和标签正确编码', () => {
  const p = S.browseParams({ key: 'K', query: '龙猫', tags: ['Video', 'Scene'] });
  assert.strictEqual(p.get('search_text'), '龙猫');
  assert.strictEqual(p.get('requiredtags[0]'), 'Video');
  assert.strictEqual(p.get('requiredtags[1]'), 'Scene');
});

// 空搜索词不该产生 search_text= 参数 —— 那会让 Steam 当成"搜空字符串"。
check('空搜索词不带 search_text', () => {
  const p = S.browseParams({ key: 'K', query: '   ' });
  assert.strictEqual(p.has('search_text'), false, '空白搜索词被当成搜索了');
});

// ⚠️ 类型标签首字母必须大写：Steam 的 requiredtags 区分大小写，
// 传 'scene' 会返回空结果**而不报错** —— 那看起来像"这个筛选没东西"。
check('类型标签是 Steam 认的大写形式', () => {
  for (const t of S.TYPE_TAGS_QUERY) {
    assert.match(t.id, /^[A-Z]/, `${t.id} 首字母没大写 —— Steam 会返回空结果且不报错`);
  }
  // 而且要标出哪些我们放不了 —— 筛选按钮上就能看到
  assert.strictEqual(S.TYPE_TAGS_QUERY.find((t) => t.id === 'Scene').supported, false);
  assert.strictEqual(S.TYPE_TAGS_QUERY.find((t) => t.id === 'Web').supported, true);
});

check('每页数量有上下限（Steam 不接受任意值）', () => {
  assert.strictEqual(S.browseParams({ key: 'K', perPage: 999 }).get('numperpage'), '50');
  assert.strictEqual(S.browseParams({ key: 'K', perPage: 0 }).get('numperpage'), '1');
  assert.strictEqual(S.browseParams({ key: 'K', page: -5 }).get('page'), '1');
});

// ⚠️ total 是分页的唯一依据 —— 没有它就不知道有几页。
check('响应解析出 total（没它做不了分页）', () => {
  const out = S.parseBrowseResponse({
    response: { total: 1234, publishedfiledetails: [
      { publishedfileid: '1', result: 1, title: 'a', tags: [{ tag: 'Web' }] },
    ] },
  });
  assert.strictEqual(out.total, 1234);
  assert.strictEqual(out.items.length, 1);
  assert.strictEqual(out.items[0].type, 'web');
});

check('响应缺字段时不抛', () => {
  assert.deepStrictEqual(S.parseBrowseResponse(null), { items: [], total: 0 });
  assert.deepStrictEqual(S.parseBrowseResponse({ response: {} }), { items: [], total: 0 });
});

// "需要 API key"这五个字对用户没用 —— 他不知道去哪弄、要不要钱。
check('没 key 时给出能照做的步骤', () => {
  const hint = S.apiKeyHint();
  assert.match(hint, /steamcommunity\.com\/dev\/apikey/, '没给申请地址');
  assert.match(hint, /免费/, '没说明是免费的');
  // ⚠️ 还要说清"不配也能用"，否则用户以为整个功能被锁住了
  assert.match(hint, /不需要它|装载/, '没说明装载壁纸不需要 key');
});

console.log('\n  我的壁纸（扫目录，不管来源）');

// 用假文件系统测，那样不用造真实目录树。
function fakeFs(tree, files) {
  return {
    listDir: (d) => { if (!tree[d]) throw new Error('ENOENT'); return tree[d]; },
    isDir: (d) => !!tree[d],
    exists: (f) => files.has(f),
  };
}

check('找出所有含 project.json 的目录', () => {
  const tree = { '/a': ['w1', 'w2'], '/a/w1': ['project.json'], '/a/w2': ['project.json'] };
  const files = new Set(['/a/w1/project.json', '/a/w2/project.json']);
  const out = S.findWallpaperDirs(['/a'], fakeFs(tree, files));
  assert.deepStrictEqual(out.dirs.sort(), ['/a/w1', '/a/w2']);
});

// 用户可能建了分类文件夹，所以要往下找一层。
check('嵌套一层也能找到（用户会建分类目录）', () => {
  const tree = { '/a': ['分类'], '/a/分类': ['w3'], '/a/分类/w3': ['project.json'] };
  const files = new Set(['/a/分类/w3/project.json']);
  const out = S.findWallpaperDirs(['/a'], fakeFs(tree, files));
  assert.deepStrictEqual(out.dirs, ['/a/分类/w3']);
});

// ⚠️ 深度必须有上限：无限递归会扫穷整个盘（用户可能把 root 设成家目录）。
check('深度有上限（否则会扫穷整个盘）', () => {
  const tree = { '/a': ['b'], '/a/b': ['c'], '/a/b/c': ['d'], '/a/b/c/d': ['project.json'] };
  const files = new Set(['/a/b/c/d/project.json']);
  const out = S.findWallpaperDirs(['/a'], fakeFs(tree, files));
  assert.strictEqual(out.dirs.length, 0, '超过 2 层还在扫 —— 深目录会拖死扫描');
});

// ⚠️ 找到 project.json 就停，不往里钻 —— 壁纸目录里可能有几百个资产文件。
check('找到 project.json 就停，不进壁纸内部', () => {
  const tree = {
    '/a': ['w1'], '/a/w1': ['project.json', 'assets'],
    '/a/w1/assets': ['nested'], '/a/w1/assets/nested': ['project.json'],
  };
  const files = new Set(['/a/w1/project.json', '/a/w1/assets/nested/project.json']);
  const out = S.findWallpaperDirs(['/a'], fakeFs(tree, files));
  assert.deepStrictEqual(out.dirs, ['/a/w1'], '钻进壁纸内部了');
});

// 权限不足、目录不存在 —— 都不该让整个扫描失败。
check('读不了的目录被跳过，不中断扫描', () => {
  const tree = { '/a': ['bad', 'good'], '/a/good': ['project.json'] };
  const files = new Set(['/a/good/project.json']);
  // '/a/bad' 不在 tree 里 ⟹ isDir 返回 false，直接跳过
  const out = S.findWallpaperDirs(['/a'], fakeFs(tree, files));
  assert.deepStrictEqual(out.dirs, ['/a/good']);
});

check('隐藏目录被跳过（.DS_Store 那类）', () => {
  const tree = { '/a': ['.hidden', 'w1'], '/a/.hidden': ['project.json'], '/a/w1': ['project.json'] };
  const files = new Set(['/a/.hidden/project.json', '/a/w1/project.json']);
  const out = S.findWallpaperDirs(['/a'], fakeFs(tree, files));
  assert.deepStrictEqual(out.dirs, ['/a/w1']);
});

check('多个 root 里重复的目录只算一次', () => {
  const tree = { '/a': ['w1'], '/a/w1': ['project.json'] };
  const files = new Set(['/a/w1/project.json']);
  const out = S.findWallpaperDirs(['/a', '/a'], fakeFs(tree, files));
  assert.strictEqual(out.dirs.length, 1, '同一个目录被算了两次');
});

check('root 不存在时安静跳过', () => {
  const out = S.findWallpaperDirs(['/不存在'], fakeFs({}, new Set()));
  assert.deepStrictEqual(out.dirs, []);
});

console.log('\n  筛选分组（年龄分级那一套）');

// ⚠️ 工坊的筛选**全部走 requiredtags**，没有独立参数 —— 类型、年龄、分辨率、主题
// 都是标签。不知道这点的话会去找 `maturity=` 那种参数，而那不存在。
// ⚠️ 0.9.52：四组 → **三组**（分辨率那组删了，用户点名「用处不大」）。
check('三组筛选都在，且都用 requiredtags 机制', () => {
  const ids = S.FILTER_GROUPS.map((g) => g.id);
  assert.deepStrictEqual(ids, ['type', 'age', 'genre']);
  for (const g of S.FILTER_GROUPS) {
    assert.ok(g.tags.length > 0, `${g.id} 组是空的`);
    assert.ok(g.label, `${g.id} 组没有中文标签`);
  }
});

// ⚠️ 这三个字符串我核过两遍，因为 Open Wallpaper Engine 里有**两套不一样的命名**：
//   WorkshopViewModel        ["Everyone","Questionable","Mature"]     ← 发给 API
//   FilterResultsViewModel   ["Everyone","Partial Nudity","Mature"]   ← 筛本地已下载
// 用错的那套会让筛选**返回空结果且不报错** —— 看起来像"这个分级下没东西"。
check('年龄分级用 Steam API 认的那套命名', () => {
  const ids = S.AGE_TAGS_QUERY.map((t) => t.id);
  assert.deepStrictEqual(ids, ['Everyone', 'Questionable', 'Mature']);
  // 真样本印证：那个壁纸的 project.json 里是 "contentrating": "Everyone"
  assert.ok(ids.includes('Everyone'));
  // 而 'Partial Nudity' 是筛本地用的，不该出现在这里
  assert.ok(!ids.includes('Partial Nudity'),
    '用了筛本地那套命名 —— API 会返回空结果且不报错');
});

// ⚠️ "默认全开然后让用户自己关"在这件事上是错的默认值。
// ⚠️⚠️ **年龄标签的 label 用年龄段，不描述内容**（0.9.53）。
// 用户 2026-08-01：「年龄这里应该是隐晦一些，直接承认内容太露骨了，写年龄吧，
// 这个三个分级」
//
// 原来是「全年龄 / 轻度不适宜 / 成人内容」—— 后两个在**描述内容是什么**，
// 而这是一个会被别人看到屏幕的桌面软件 ⟹ 那两个词本身就是要避免的东西。
check('年龄标签用年龄段，label 里不出现内容描述', () => {
  const labels = S.AGE_TAGS_QUERY.map((t) => t.label);
  assert.deepStrictEqual(labels, ['全年龄', '13+', '18+']);
  // ⚠️ 反向锁住那两个词 —— 改回去不报错，而"屏幕上出现内容描述"
  //   正是用户要避免的那件事。
  for (const bad of ['成人', '露骨', '裸', '不适宜', '色']) {
    assert.ok(!labels.some((l) => l.includes(bad)),
      `年龄标签里出现了内容描述「${bad}」⟹ 用年龄段（13+/18+），别描述内容`);
  }
  // ⚠️⚠️ 而 `id` 一个字都不能改 —— 那是发给 Steam 的 requiredtags，
  //   **区分大小写而且写错会返回空结果且不报错**（看起来像"这个分级下没东西"）。
  //   改 label 时顺手"统一一下" id 是很自然的手滑 ⟹ 守住。
  assert.deepStrictEqual(S.AGE_TAGS_QUERY.map((t) => t.id),
    ['Everyone', 'Questionable', 'Mature'],
    '年龄标签的 id 被改了 ⟹ 那是发给 Steam 的原文，写错会静默返回空结果');
});

check('默认只勾全年龄（浏览时不该出现成人内容）', () => {
  const defaults = S.defaultTags();
  assert.deepStrictEqual(defaults, ['Everyone']);
  assert.ok(!defaults.includes('Mature'), '默认勾上了成人内容');
});

// requiredtags 区分大小写，而这几组的原文都不是简单的首字母大写
//（'Sci-Fi' 带连字符、'Pixel art' 只有首词大写）
// ⟹ 逐个核对比"写个正则"可靠。
// ⚠️ 0.9.52 去掉了分辨率那两条（'1920 x 1080' / 'Ultrawide Standard'）——
//   整组筛选删了（用户：「分辨率这个分类不需要，用处不大」），
//   连 RESOLUTION_TAGS_QUERY 的定义和 export 一起删的。
check('标签用 Steam 的原文（大小写和空格都不能改）', () => {
  const genres = S.GENRE_TAGS_QUERY.map((t) => t.id);
  assert.ok(genres.includes('Sci-Fi'), 'Sci-Fi 的连字符写法不对');
  assert.ok(genres.includes('Pixel art'), 'Pixel art 只有首词大写');
  // ⚠️ 而"删掉的东西不许留引用"要有守卫 —— 我删定义时**漏了 export**，
  //   那会让 `root.GestureWallWorkshop = { …, RESOLUTION_TAGS_QUERY, … }`
  //   抛 ReferenceError（整个模块加载失败 ⟹ 工坊页全白）。
  assert.strictEqual(S.RESOLUTION_TAGS_QUERY, undefined,
    'RESOLUTION_TAGS_QUERY 又回来了 —— 分辨率那组删了，留着就是死代码');
  assert.ok(!(S.FILTER_GROUPS || []).some((g) => g.id === 'resolution'),
    '分辨率筛选组又回来了（用户点名删掉）');
});

// ⚠️⚠️ 多选取**并集**（用户 2026-08-01：「应该允许多选，这样就是取并集，
// 比如说年龄我选择了全年龄和轻度不适宜，那就是这两种的我都要看」）。
//
// 参数名叫 requiredtags ⟹ Steam 默认 AND。而一个壁纸不可能同时是
// 「全年龄」和「轻度不适宜」⟹ 多选必然零结果，看起来像"这个筛选下没东西"。
// ⚠️ 这条**没能实测**（这台机器没有 Steam API key），用户侧第一次多选就能验。
check('多个标签取并集（match_all_tags=false）', () => {
  const two = S.browseParams({ key: 'K', tags: ['Everyone', 'Questionable'] });
  assert.strictEqual(two.get('match_all_tags'), 'false',
    '多选标签时没发 match_all_tags=false ⟹ Steam 按 AND 算，必然零结果');
  // ⚠️ 单个标签下 AND/OR 等价 ⟹ 不发那个参数（少一个出错面：
  //    如果参数名错了，Steam 可能整个请求报错而不是忽略它）
  const one = S.browseParams({ key: 'K', tags: ['Everyone'] });
  assert.strictEqual(one.get('match_all_tags'), null,
    '单个标签也发 match_all_tags ⟹ 多一个没必要的出错面');
  const none = S.browseParams({ key: 'K', tags: [] });
  assert.strictEqual(none.get('match_all_tags'), null);
});

// 四组的标签混在一个 requiredtags 数组里传 —— 那是 Steam 的机制。
check('多组标签能一起传（类型+年龄+主题同时筛）', () => {
  const p = S.browseParams({
    key: 'K', tags: ['Video', 'Everyone', 'Anime'],
  });
  assert.strictEqual(p.get('requiredtags[0]'), 'Video');
  assert.strictEqual(p.get('requiredtags[1]'), 'Everyone');
  assert.strictEqual(p.get('requiredtags[2]'), 'Anime');
});

// 标签 id 不能重复 —— 重复的话 UI 上会出现两个一样的按钮，
// 而点其中一个会让另一个的状态显示错。
check('所有组的标签 id 全局唯一', () => {
  const all = S.FILTER_GROUPS.flatMap((g) => g.tags.map((t) => t.id));
  const dup = all.filter((x, i) => all.indexOf(x) !== i);
  assert.deepStrictEqual(dup, [], `重复的标签 id：${dup.join(', ')}`);
});

// ⚠️⚠️⚠️ **工坊下载要复制到统一的壁纸目录，而列表要按工坊 ID 去重。**
//
// 用户 2026-08-01 的要求：
//   「现在的壁纸应该统一都是默认用户下面的 Documents/GestureWall/Wallpapers
//     （不同用户自适应）…创意工坊的壁纸下载，和默认加载都应该是这样」
//
// ⚠️ 而 steamcmd 的下载位置是**它自己定的、不可配**
//（`~/Library/Application Support/Steam/steamapps/workshop/content/431960/<ID>/`）
// ⟹ 只能下载后**复制**过去（不是移动 —— Steam 目录是 steamcmd 的账本，
//    移走会让下次下载认为"已下载"却找不到文件，只能手动清 appworkshop_*.acf）
//
// ⟹ 于是同一个壁纸在两处各有一份 ⟹ **列表里会出现两次**。
// ⚠️ 用户看到两个一样的壁纸不会想到"一个是副本"——
//    他会以为列表有 bug，或者不知道点哪个（而两个行为完全一样）。
check('同一个工坊壁纸在两处时，列表只出现一次', () => {
  const tree = {
    '/D/W': ['3339949060-完美壁纸', '我的自制壁纸'],
    '/D/W/3339949060-完美壁纸': [],
    '/D/W/我的自制壁纸': [],
    '/S/431960': ['3339949060'],
    '/S/431960/3339949060': [],
  };
  const pj = new Set([
    '/D/W/3339949060-完美壁纸/project.json',
    '/D/W/我的自制壁纸/project.json',
    '/S/431960/3339949060/project.json',
  ]);
  const r = W.findWallpaperDirs(['/D/W', '/S/431960'], {
    listDir: (d) => tree[d] || [],
    isDir: (d) => d in tree,
    exists: (f) => pj.has(f),
  });
  assert.strictEqual(r.dirs.length, 2,
    `列出了 ${r.dirs.length} 个：${r.dirs.join(', ')} —— `
    + '同一个工坊 ID（3339949060）在两处，应该只算一个');
  // ⚠️ **保留我们目录里那份** —— 那是用户在 Finder 里能找到的
  assert.ok(r.dirs.some((d) => d.startsWith('/D/W/3339949060')),
    '去重后留的是 Steam 目录那份 ⟹ 用户从 Finder 打开壁纸目录时找不到它');
  // 用户自己放的（不带 ID）不能被去重逻辑吃掉
  assert.ok(r.dirs.includes('/D/W/我的自制壁纸'),
    '用户自己放的壁纸被去重逻辑漏掉了 —— 它目录名里没有工坊 ID');
});

check('不同工坊壁纸不会被误去重', () => {
  const tree = {
    '/S/431960': ['111111111', '222222222'],
    '/S/431960/111111111': [],
    '/S/431960/222222222': [],
  };
  const pj = new Set([
    '/S/431960/111111111/project.json',
    '/S/431960/222222222/project.json',
  ]);
  const r = W.findWallpaperDirs(['/S/431960'], {
    listDir: (d) => tree[d] || [],
    isDir: (d) => d in tree,
    exists: (f) => pj.has(f),
  });
  assert.strictEqual(r.dirs.length, 2,
    `两个不同 ID 被去重成 ${r.dirs.length} 个 —— 去重的键取错了`);
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全绿'}\n`);
