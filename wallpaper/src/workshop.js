// Steam 创意工坊：解析 ID、驱动 steamcmd、把它的输出翻译成人能看懂的状态。
//
// 为什么必须有这一层：用户买了 Wallpaper Engine（Windows-only），但**工坊内容不是
// 平台相关的** —— 那些就是文件，而 steamcmd 有 mac 版。所以账号里的资源能用。
//
// 这一层全是纯函数（除了 download 那个入口），因为 steamcmd 的失败模式又多又静默：
// 没装、没登录、Guard 码过期、ID 不存在、下了但目录是空的…… 每一种都会表现成
// "壁纸没出来"，而那和我们的渲染坏了完全分不清。
(function (root) {

// Wallpaper Engine 在 Steam 上的 AppID。工坊物品下载必须带它。
// 431960 是常量不是配置 —— 写错的话 steamcmd 会去下别的游戏的物品然后说"找不到"。
const WE_APP_ID = '431960';

// 工坊 ID 是纯数字。从用户可能粘贴的各种形式里抠出来：
//   3747222633
//   https://steamcommunity.com/sharedfiles/filedetails/?id=3747222633
//   steam://url/CommunityFilePage/3747222633
//
// ⚠️ 宽松地接受多种形式，因为用户会直接从浏览器地址栏或 WE 的分享按钮复制。
// 只认纯数字会让"粘贴链接"这个最自然的动作失败，而失败信息只会是"ID 不合法"。
function parseWorkshopId(input) {
  const text = String(input == null ? '' : input).trim();
  if (!text) return null;
  // ?id=数字 / CommunityFilePage/数字 / 裸数字
  const match = text.match(/(?:[?&]id=|CommunityFilePage\/|^)(\d{6,20})(?:[^\d]|$)/);
  if (!match) return null;
  return match[1];
}

// steamcmd 在 macOS 上的数据根目录。
//
// ⚠️ 这条是实测出来的，之前我猜错了。我原来按"steamcmd 二进制所在目录的上两级"推，
// 而那在 brew 装的情况下是 /opt/homebrew —— 完全不对。真实位置来自 steamcmd
// 自己的启动输出：
//   Logging directory: '/Users/moon/Library/Application Support/Steam/logs'
//
// 而且 brew 的 /opt/homebrew/bin/steamcmd 只是**包装脚本**，真二进制在
// Caskroom/steamcmd/<版本号>/MacOS/ 下 ⟹ 从二进制路径反推根目录这个思路本身就错，
// 不管怎么推都错。
//
// 猜错的后果：下载真的成功了，但我们去错的地方找文件 ⟹ 报"下载完了但找不到"。
const STEAM_ROOTS = [
  `${process.env.HOME || '~'}/Library/Application Support/Steam`,
  // 手动装 tar 包的话，steamcmd 会在自己所在目录下建 steamapps/
  `${process.env.HOME || '~'}/steamcmd`,
  `${process.env.HOME || '~'}/Steam`,
];

// 下载目录布局是 steamcmd 自己定的、不可配。
function contentPath(steamRoot, workshopId) {
  if (!steamRoot || !workshopId) return null;
  return `${steamRoot}/steamapps/workshop/content/${WE_APP_ID}/${workshopId}`;
}

// ⚠️ legacy 工坊物品：Steam 对老的单文件上传不解包，原样存成
//   <工坊ID>/<某串数字>_legacy.bin
// 而不是我们期待的目录结构（project.json + 资产）。实测：
//   Success. Downloaded item 3339949060 to ".../3339949060/2479884489559000807_legacy.bin"
//
// 所以"目录里有 project.json"这个成功判据会把它判成失败 —— 而下载其实成功了。
//
// 里面是什么只能靠魔数判，不能猜：可能是 zip、可能是 WE 的 PKGV 私有归档、
// 也可能就是裸的一个 mp4。三种的处置完全不同。
const MAGICS = [
  { bytes: [0x50, 0x4b, 0x03, 0x04], kind: 'zip', label: 'ZIP 归档（能解）' },
  { bytes: [0x50, 0x4b, 0x05, 0x06], kind: 'zip', label: 'ZIP 归档（空）' },
  { bytes: [0x52, 0x41, 0x52, 0x21], kind: 'rar', label: 'RAR 归档（解不了）' },
  { bytes: [0x37, 0x7a, 0xbc, 0xaf], kind: '7z', label: '7z 归档（解不了）' },
  { bytes: [0x89, 0x50, 0x4e, 0x47], kind: 'png', label: 'PNG 图片' },
  { bytes: [0x47, 0x49, 0x46, 0x38], kind: 'gif', label: 'GIF 动图' },
  { bytes: [0xff, 0xd8, 0xff], kind: 'jpg', label: 'JPEG 图片' },
  { bytes: [0x1a, 0x45, 0xdf, 0xa3], kind: 'webm', label: 'WebM 视频' },
];

// 识别 legacy.bin 里装的是什么。head 是文件开头的字节（至少 16 个）。
//
// ⚠️ 返回 kind 让代码分派、label 给人看。判不出来时**明确说判不出来**并给出头几个
// 字节的十六进制 —— 那样用户贴给我，我能直接查是什么格式，不用来回猜。
function sniffLegacy(head) {
  const bytes = Array.from(head || []);
  if (bytes.length < 4) return { kind: 'empty', label: '文件是空的或太小' };

  for (const magic of MAGICS) {
    if (magic.bytes.every((b, i) => bytes[i] === b)) return { kind: magic.kind, label: magic.label };
  }
  // mp4/mov 的魔数在偏移 4：'ftyp'
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return { kind: 'mp4', label: 'MP4/MOV 视频' };
  }
  // WE 的私有归档，开头是长度前缀 + "PKGV"
  const text = bytes.slice(0, 12).map((b) => String.fromCharCode(b)).join('');
  if (text.includes('PKGV')) return { kind: 'pkgv', label: 'WE 私有 PKGV 归档' };

  const hex = bytes.slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join(' ');
  return { kind: 'unknown', label: `认不出的格式（开头字节：${hex}）`, hex };
}

// 找 legacy.bin。⚠️ 文件名前缀是 Steam 生成的一串数字，不固定，所以按后缀找。
function findLegacyBin(dir, listFiles) {
  let names = [];
  try { names = listFiles(dir) || []; } catch { return null; }
  const hit = names.find((n) => /_legacy\.bin$/i.test(n));
  return hit ? `${dir}/${hit}` : null;
}

// 在所有可能的根目录下找那个工坊物品。
//
// ⚠️ 逐个试而不是推断，理由见上：路径推断这条路已经错过一次。exists 由调用方注入，
// 这样这个函数仍然是纯的、可测。
function findDownloaded(workshopId, exists, roots) {
  for (const root of roots || STEAM_ROOTS) {
    const dir = contentPath(root, workshopId);
    if (dir && exists(`${dir}/project.json`)) return dir;
  }
  return null;
}

// 下载落地了但不是我们期待的形状 —— 目录在、project.json 不在。
// ⚠️ 分开报这种情况很重要：它和"下载失败"完全不同（steamcmd 说了 Success），
// 而混在一起报的话，用户会去查网络/账号，而真正的问题是格式。
function findDownloadedDir(workshopId, exists, roots) {
  for (const root of roots || STEAM_ROOTS) {
    const dir = contentPath(root, workshopId);
    if (dir && exists(dir)) return dir;
  }
  return null;
}

// 所有找过的路径。⚠️ 找不到时必须报出来 —— 否则用户和我都不知道该往哪查，
// 而这条链最可能的失败恰恰是"路径不对"。
function searchedPaths(workshopId, roots) {
  return (roots || STEAM_ROOTS).map((r) => contentPath(r, workshopId)).filter(Boolean);
}

// 把 steamcmd 的一行输出翻译成状态。
//
// ⚠️ 它的输出是给人看的、不是协议，所以只能按关键字匹配。这一层的价值在于**把
// "登录失败"拆成能行动的几种** —— 用户面对"登录失败"能做的事是零，面对
// "需要 Steam Guard 验证码"就知道去手机上看。
//
// 每条都返回 { kind, text }，kind 给代码用、text 给人看。
function classifyLine(line) {
  const text = String(line == null ? '' : line);
  if (!text.trim()) return null;

  // —— 登录相关（最常见的卡点）——
  if (/Steam Guard code/i.test(text) || /Two-factor code/i.test(text)) {
    return {
      kind: 'needsGuard',
      text: '需要 Steam Guard 验证码 —— 看手机上的 Steam App 或邮箱',
    };
  }
  if (/Invalid Password|Login Failure.*password/i.test(text)) {
    return { kind: 'badPassword', text: '账号或密码不对' };
  }
  if (/Rate Limit|RateLimitExceeded/i.test(text)) {
    // ⚠️ Steam 会因为频繁登录尝试临时封锁，而那个错误看起来像密码错。
    // 分开说很重要：一个是"改密码"，另一个是"等一会儿"。
    return { kind: 'rateLimited', text: 'Steam 限流了 —— 登录太频繁，等几分钟再试' };
  }
  if (/Logged in OK|Waiting for user info.*OK/i.test(text)) {
    return { kind: 'loggedIn', text: '登录成功' };
  }
  if (/Logging in user/i.test(text)) {
    return { kind: 'loggingIn', text: '正在登录…' };
  }

  // —— 下载相关 ——
  // ⚠️ 百分比要在 "Downloading item" 之前判。steamcmd 的进度行长这样：
  //   Downloading item 123 ... 45.5%
  // 也就是**两个模式都命中同一行**。先判 Downloading 的话进度永远解析不出来 ⟹
  // 进度条一动不动，而下载其实在进行 —— 用户会以为卡死了。
  const progress = text.match(/(\d+(?:\.\d+)?)%/);
  if (progress) {
    return { kind: 'progress', text: `下载中 ${progress[1]}%`, percent: Number(progress[1]) };
  }
  if (/Downloading item (\d+)/i.test(text)) {
    return { kind: 'downloading', text: '正在下载…' };
  }
  if (/Success\. Downloaded item/i.test(text)) {
    return { kind: 'downloaded', text: '下载完成' };
  }
  // ⚠️ 这条要在 ERROR 之前判：steamcmd 报"物品不存在"用的也是 ERROR 前缀，
  // 但它和"网络失败"该给不同的建议。
  if (/ERROR!?\s*Download item .* failed \(([^)]+)\)/i.test(text)) {
    const reason = text.match(/failed \(([^)]+)\)/i)[1];
    if (/File?NotFound|Invalid.*Param/i.test(reason)) {
      return { kind: 'notFound', text: `找不到这个工坊物品（${reason}）—— ID 对吗？还订阅着吗？` };
    }
    return { kind: 'downloadFailed', text: `下载失败：${reason}` };
  }
  if (/No subscription/i.test(text)) {
    // 买过 WE 才能下它的工坊物品。这条是"账号没这个游戏"，不是网络问题。
    return { kind: 'noSubscription', text: '这个账号没有 Wallpaper Engine —— 工坊物品需要拥有本体' };
  }
  return null;
}

// 从整段输出里挑出**最该告诉用户的那一条**。
//
// ⚠️ 不是取最后一条：steamcmd 结束时经常再打几行无关的收尾信息，
// 而真正的原因在中间。所以按严重程度取。
const SEVERITY = [
  'noSubscription', 'notFound', 'badPassword', 'rateLimited', 'needsGuard',
  'downloadFailed', 'downloaded', 'progress', 'downloading', 'loggedIn', 'loggingIn',
];

function summarize(lines) {
  const found = [];
  for (const line of Array.isArray(lines) ? lines : String(lines).split('\n')) {
    const hit = classifyLine(line);
    if (hit) found.push(hit);
  }
  if (!found.length) return null;
  for (const kind of SEVERITY) {
    const hit = found.find((f) => f.kind === kind);
    if (hit) return hit;
  }
  return found[found.length - 1];
}

// steamcmd 可能在哪。⚠️ 顺序有意义：brew 的两个前缀（Apple Silicon 和 Intel）
// 在前，因为那是绝大多数人的安装方式。
//
// ⚠️ 后两条是官方 tar 包的手动安装位置。加它们的理由很具体：brew 装 steamcmd 要先
// 自更新索引（连 GitHub），国内经常卡好几分钟甚至超时 —— 那时候用户会走 Valve 官方
// 的 steamcmd_osx.tar.gz，解到 ~/steamcmd/ 里。不认这条路的话，装好了我们还说"没找到"。
//
// 注意 tar 包给的是 **steamcmd.sh**（shell 包装脚本）不是同名二进制。
const STEAMCMD_CANDIDATES = [
  '/opt/homebrew/bin/steamcmd',
  '/usr/local/bin/steamcmd',
  '/usr/bin/steamcmd',
  `${process.env.HOME || '~'}/steamcmd/steamcmd.sh`,
  `${process.env.HOME || '~'}/Steam/steamcmd.sh`,
];

// steamcmd 没装的话给出能直接粘贴的命令。
//
// ⚠️ 这条比"请安装 steamcmd"有用得多。而且要说清它是 Valve 官方工具 ——
// 否则"要装个东西才能用我的账号"听起来像可疑操作。
function installHint() {
  return 'steamcmd 没找到。它是 Valve 官方的命令行工具，装它：\n'
    + '  brew install --cask steamcmd\n'
    + '装好后回来重试（也可以在下面手填路径）';
}

// 组装下载用的参数。抽出来是为了能在没有 steamcmd 的环境下测它。
//
// ⚠️ `+quit` 必须在最后，否则 steamcmd 会停在交互提示符上等输入 ——
// 那表现成"卡住不动"，而不是任何错误。
function downloadArgs({ username, password, guardCode, workshopId, anonymous }) {
  const args = [];
  if (anonymous) {
    // 匿名登录只能下"免费且公开"的物品，WE 的工坊物品基本都不行。
    // 留这条路是为了让"能不能连上 Steam"和"账号有没有权限"分开诊断。
    args.push('+login', 'anonymous');
  } else {
    args.push('+login', username);
    if (password) args.push(password);
    if (guardCode) args.push(guardCode);
  }
  args.push('+workshop_download_item', WE_APP_ID, String(workshopId), 'validate');
  args.push('+quit');
  return args;
}

// 把参数里的密码和 Guard 码换成星号，用于日志和诊断报告。
//
// ⚠️ 必须有这个：诊断报告是要发给我看的，而 downloadArgs 里有明文密码。
// 忘了脱敏就等于让用户把密码贴进聊天记录。
function redactArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    out.push(args[i]);
    if (args[i] === '+login') {
      // +login <user> [password] [guard] —— 用户名保留（诊断有用），后面的遮掉
      if (i + 1 < args.length) out.push(args[i + 1]);
      let j = i + 2;
      while (j < args.length && !String(args[j]).startsWith('+')) {
        out.push('***');
        j += 1;
      }
      i = j - 1;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// 工坊内容展示（预览图、标题、类型）
// ─────────────────────────────────────────────────────────────────────────
//
// 为什么必须有：只给一个"填 ID"的输入框是把命令行搬进 GUI —— 而工坊的本质是**浏览**。
// 用户说得对："平时不都是随便浏览着看的吗"。没有预览图就没法挑，而挑不了这个功能
// 等于只服务已经知道 ID 的人。
//
// ⚠️ Steam 有两个相关 API，差别决定我们能做到哪一步（读 OWE 的代码确认的）：
//
//   ISteamRemoteStorage/GetPublishedFileDetails  ✅ 不要 API key
//     按 ID 批量拿：标题、预览图 URL、类型标签、大小、订阅数
//   IPublishedFileService/QueryFiles             ⚠️ 要 Web API key
//     搜索、按热度浏览、排行榜
//
// ⟹ 所以"贴一个 ID/链接就能先看到预览图再决定装不装"零门槛就能做；
// "在应用内浏览整个工坊"需要用户去申请一个免费的 Web API key。
// 两件分开做，先把零门槛那半边做掉。
const DETAILS_ENDPOINT = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';
const QUERY_ENDPOINT = 'https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/';

// 批量取详情的 POST body。表单编码，不是 JSON —— 这个 API 只吃 form。
function detailsBody(workshopIds) {
  const ids = (workshopIds || []).filter(Boolean);
  const parts = [`itemcount=${ids.length}`];
  ids.forEach((id, i) => parts.push(`publishedfileids[${i}]=${encodeURIComponent(id)}`));
  return parts.join('&');
}

// WE 用 tag 标类型（Scene / Video / Web / Application）。
// ⚠️ 这是**装载前**就能知道类型的唯一途径 —— 靠它我们能在下载之前就告诉用户
// "这个是 scene，装了也只能看静态图"，而不是让他下完 200MB 才发现。
const TYPE_TAGS = { scene: 'scene', video: 'video', web: 'web', application: 'application' };

function typeFromTags(tags) {
  for (const tag of tags || []) {
    const name = String((tag && tag.tag) || tag || '').toLowerCase();
    if (TYPE_TAGS[name]) return name;
  }
  return null;
}

// ⚠️ 不是每个工坊物品都标了类型 tag。实测（用户查 3339949060）：预览图和标题都拿到了，
// 类型是"未标注" —— 老的物品、或者作者没选分类的，tags 里就是没有 Scene/Video/Web。
//
// 但类型还能从别处推：`filename` 字段。legacy 单文件物品的 filename 就是**原始上传的
// 文件名**（带扩展名），而那直接说明了它是什么。
//
// ⟹ 这条比"类型未标注"有用得多：用户看到"未标注"只能靠猜要不要下，
// 而看到"看起来是 mp4"就能决定了。
function typeFromFilename(filename) {
  const name = String(filename || '').toLowerCase();
  if (!name) return null;
  if (/\.(mp4|webm|m4v|mov|avi|mkv)$/.test(name)) return 'video';
  if (/\.(gif|png|jpe?g|webp)$/.test(name)) return 'image';
  // .zip / .rar 里可能是任何一种，说不了；WE 场景包常是 .pkg
  if (/\.pkg$/.test(name)) return 'scene';
  return null;
}

// 把 API 的一项翻译成我们要显示的样子。
//
// ⚠️ 字段全部防御性读取：这个 API 对已删除/私有的物品返回 result != 1 且大部分字段缺失，
// 而那时候直接读 .title 会是 undefined ⟹ 界面上出现一张无字白卡片，
// 用户不知道是加载中还是这个壁纸没了。
function parseDetail(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.publishedfileid ? String(raw.publishedfileid) : null;
  if (!id) return null;
  // result: 1 = 正常，其他都是拿不到（已删除、私有、ID 不存在）
  const ok = raw.result === 1 || raw.result === undefined;
  if (!ok) {
    return { id, ok: false, reason: '这个工坊物品拿不到 —— 已删除、设为私有，或者 ID 不对' };
  }
  // 先看 tag（作者标的最准），tag 没有就从文件名推。
  // ⚠️ 两个来源分开记：typeSource 让界面能说"这是推断的"而不是当成确定的。
  const tagType = typeFromTags(raw.tags);
  const nameType = tagType ? null : typeFromFilename(raw.filename);
  const type = tagType || nameType;
  return {
    id,
    ok: true,
    title: raw.title || '(无标题)',
    preview: raw.preview_url || null,
    type,
    // 'tag' = 作者标的（可信）、'filename' = 我们从文件名推的（大概）、null = 没线索。
    // ⚠️ 界面必须区分这两种，否则把推断显示成确定，用户会按错的信息做决定。
    typeSource: tagType ? 'tag' : (nameType ? 'filename' : null),
    filename: raw.filename || null,
    // 大小和订阅数都是给人做决定用的：几百 MB 的壁纸值不值得等，
    // 订阅数说明它是不是靠谱的作品。
    sizeBytes: Number(raw.file_size) || 0,
    subscriptions: Number(raw.subscriptions) || 0,
    description: (raw.description || '').slice(0, 400),
    // ⚠️ 这里**不判断支不支持**。
    //
    // 我原来写了 `type === 'web' || type === 'video'` —— 一份硬编码的支持列表。
    // 然后加 image 类型时只改了 we-host.js 的 TYPES，这里没跟着改 ⟹ 用户看到
    // "看起来是 image · 大概不支持"，而它其实支持，甚至真的放出来了。
    //
    // 同一个事实有两个来源就一定会漂。⟹ 支持性判断只有 we-host.js 的 TYPES
    // 一个来源，这里只报类型，由调用方去问。
  };
}

function parseDetailsResponse(json) {
  const list = json && json.response && json.response.publishedfiledetails;
  if (!Array.isArray(list)) return [];
  return list.map(parseDetail).filter(Boolean);
}

// 人能读的大小。⚠️ 显示 "228893184" 对做决定毫无帮助。
function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '大小未知';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

root.GestureWallWorkshop = {
  DETAILS_ENDPOINT,
  QUERY_ENDPOINT,
  detailsBody,
  typeFromTags,
  typeFromFilename,
  parseDetail,
  parseDetailsResponse,
  formatSize,
  WE_APP_ID,
  STEAMCMD_CANDIDATES,
  STEAM_ROOTS,
  findDownloaded,
  findDownloadedDir,
  findLegacyBin,
  sniffLegacy,
  searchedPaths,
  parseWorkshopId,
  contentPath,
  classifyLine,
  summarize,
  installHint,
  downloadArgs,
  redactArgs,
};
})(typeof window === 'undefined' ? globalThis : window);
