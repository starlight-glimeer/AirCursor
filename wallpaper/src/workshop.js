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

// ─────────────────────────────────────────────────────────────────────────
// 「我的壁纸」：扫指定目录，不管壁纸是怎么来的
// ─────────────────────────────────────────────────────────────────────────
//
// 用户的原话："自己的壁纸资源就是「我的壁纸」下载的壁纸，不知道从哪里得到的壁纸，
// 反正只要在指定的壁纸存储目录中有的壁纸就在这里"
//
// ⟹ 判据是**目录里有没有 project.json**，不是"我们下载过"。
// 那样手动拷进去的、朋友发的、从别的机器拷来的，全都能用。
//
// ⚠️ 扫描要防三件事，而每一件不防都会表现成"列表是空的 / 卡住"：
//   ① 深度 —— 用户可能把壁纸放在嵌套目录里，但无限递归会扫穷整个盘
//   ② 数量 —— 工坊目录可能有几百个，全读 project.json 会卡住界面
//   ③ 坏文件 —— 一个坏的 project.json 不能让整个列表变空

// 扫多深。
//
// ⚠️ 这个数字的含义要说准，我第一版就搞混了：它是**递归调用的层数**，
// 而"能找到几层深的壁纸"比它多一层。
//   depth=0  扫 <root> 的直接子目录        → 找到 <root>/<壁纸>/project.json
//   depth=1  再往下一层                    → 找到 <root>/<分类>/<壁纸>/project.json
// ⟹ 所以 1 就够（标准布局 + 一层用户分类），设 2 会多扫一层没用的。
const SCAN_MAX_DEPTH = 1;
// 最多列多少。⚠️ 不是性能洁癖：工坊订阅几百个很常见，
// 而读几百个 project.json + 找预览图会让面板卡住好几秒。
const SCAN_MAX_ITEMS = 500;

// 找出所有含 project.json 的目录。
//
// listDir / isDir 由调用方注入 —— 那样这个函数是纯的、能测，
// 而不用在测试里造真实目录树。
function findWallpaperDirs(roots, { listDir, isDir, exists }) {
  const found = [];
  const seen = new Set();

  const walk = (dir, depth) => {
    if (found.length >= SCAN_MAX_ITEMS) return;
    if (depth > SCAN_MAX_DEPTH) return;
    // ⚠️ 同一个目录被两个 root 覆盖时（比如 root 互为父子）会重复扫。
    if (seen.has(dir)) return;
    seen.add(dir);

    let entries = [];
    try {
      entries = listDir(dir) || [];
    } catch {
      return;   // 权限不足、目录不存在 —— 都不该让整个扫描失败
    }

    for (const name of entries) {
      if (found.length >= SCAN_MAX_ITEMS) return;
      // 跳过隐藏目录：.DS_Store 那类，以及用户不想让我们进的
      if (name.startsWith('.')) continue;
      const child = `${dir}/${name}`;
      if (!isDir(child)) continue;
      if (exists(`${child}/project.json`)) {
        found.push(child);
      } else {
        walk(child, depth + 1);
      }
    }
  };

  for (const root of roots || []) {
    if (root && isDir(root)) walk(root, 0);
  }

  // ⚠️⚠️ **按工坊 ID 去重** —— 上面那个 `seen` 只去重**路径**，
  // 而 0.9.24 起工坊下载会复制到 `Documents/GestureWall/Wallpapers/<ID>-<标题>`
  // ⟹ 同一个壁纸在 Steam 目录和我们目录里各有一份，路径不同 ⟹ 列表里出现两次。
  //
  // ⚠️ 用户看到两个一样的壁纸时，不会想到"一个是副本" ——
  // 他会以为列表有 bug，或者不知道该点哪个（而它们的行为完全一样）。
  //
  // 判 ID 的方式：**目录名里的那串数字**。
  //   Steam:  .../content/431960/**3339949060**
  //   我们:   .../Wallpapers/**3339949060**-完美壁纸
  // ⟹ 取目录名开头的连续数字（工坊 ID 是纯数字，长度 9-10 位）。
  //
  // ⚠️ **保留先出现的那个**，而 roots 里我们的目录排在最前
  //（`workshop-local` 的注释说明了那个顺序是故意的）
  // ⟹ 留下的是我们目录里的副本 = 用户在 Finder 里能找到的那个。
  const byId = new Map();
  const deduped = [];
  for (const dir of found) {
    const base = dir.split('/').pop() || '';
    const m = base.match(/^(\d{6,})/);
    if (!m) {
      // 不带 ID 的（用户自己放的壁纸）⟹ 不参与去重，原样保留
      deduped.push(dir);
      continue;
    }
    if (byId.has(m[1])) continue;
    byId.set(m[1], dir);
    deduped.push(dir);
  }

  return { dirs: deduped, truncated: found.length >= SCAN_MAX_ITEMS };
}

// ─────────────────────────────────────────────────────────────────────────
// 浏览工坊（仿 Steam 创意工坊的排版）
// ─────────────────────────────────────────────────────────────────────────
//
// ⚠️ 这条**需要 Steam Web API key**（免费，在 steamcommunity.com/dev/apikey 申请）。
// 和"贴 ID 看详情"那条不同（那条免 key）：
//
//   ISteamRemoteStorage/GetPublishedFileDetails  ✅ 免 key —— 按 ID 拿详情
//   IPublishedFileService/QueryFiles             ⚠️ 要 key —— 搜索/浏览/排行
//
// ⟹ 所以浏览是"配了 key 才有"的功能，而没配 key 时要说清怎么弄，
// 不能只报"请求失败"。

// Steam 的排序类型。⚠️ 这些数字是 Steam 定的枚举，不是我编的。
// 而 `search_text` 非空时**必须**用 12（RankedByTextSearch）——
// 否则搜索词被忽略、返回的是热门榜，而那看起来像"搜索没用"。
// ⚠️⚠️ **顺序 = 默认值**（0.9.118）。用户 2026-08-02：
//   「我希望顺序换一下，然后默认是订阅最多」
//   ⟹ 「订阅最多」放第一个。而**面板的默认值就是这个列表的第一项**
//     （dashboard.js 的 `browse.sort`）—— 两处必须一致，不然"默认选中的那个"
//     和"实际用的排序"会错开（那种不一致用户看到的是"UI 选中 A 而结果是 B"）。
//
// ⚠️⚠️⚠️ 而 `popular` 的 queryType **原来写的是 9 —— 和 subscribed 重复**
//   ⟹ 那两个选项一直返回**完全一样的结果**，用户点了只会觉得"没变化"。
//   真值是 **0（RankedByVote）**，出处：Open Wallpaper Engine 的
//   `WorkshopAPIService.swift:39`（`case .mostPopular: return 0 // RankedByVote`）。
//   ⚠️ 这是"两个枚举值填成同一个"那类错 —— **不报错、不空结果，只是静默重复**，
//     而那正是最难自己发现的（我是改顺序时顺手核对才逮到）。
const SORT_ORDERS = [
  { id: 'subscribed', label: '订阅最多', queryType: 9 },   // RankedByTotalUniqueSubscriptions
  { id: 'trending', label: '近期热门', queryType: 3 },     // RankedByTrend
  { id: 'popular', label: '总下载量', queryType: 0 },      // RankedByVote ← 原来错写成 9
  { id: 'recent', label: '最新发布', queryType: 1 },       // RankedByPublicationDate
];

const TEXT_SEARCH_QUERY_TYPE = 12;

function queryTypeFor(sortId, hasText) {
  if (hasText) return TEXT_SEARCH_QUERY_TYPE;
  const hit = SORT_ORDERS.find((s) => s.id === sortId);
  // ⚠️ 兜底用**列表第一项**，不写死数字 —— 写死的话改默认排序时会漏掉这里，
  //   而症状是"传了个不认识的 sortId 时排序悄悄变回原来那个"。
  return hit ? hit.queryType : SORT_ORDERS[0].queryType;
}

// ⚠️ 工坊的筛选**全部走 requiredtags**，没有独立的参数 —— 类型、年龄分级、
// 分辨率、主题，Steam 都当成标签。这一点不知道的话会去找 `maturity=` 那种参数，
// 而那不存在。
//
// ⚠️⚠️ 而 requiredtags 是**区分大小写**的，写错会**返回空结果且不报错** ——
// 那看起来像"这个筛选下没东西"，而不像"我拼错了"。所以下面每组都用 Steam 认的原文。

// 类型。
const TYPE_TAGS_QUERY = [
  // ⚠️⚠️ **0.9.159 起 supported: true** —— scene 的渲染做了
  //   （图层 + 文字 + 音频柱 + 视差；shader effect / 粒子还没有）。
  //   ⚠️ 而它是**分维度支持** ⟹ 装载时逐张报覆盖率（见 scene-pkg 的 renderability）。
  //   ⚠️ 漏改这里的症状：搜索面板把 scene 标成「暂不支持」、下载按钮写
  //     「仍然下载（暂不支持）」—— 而它其实能装能画。
  { id: 'Scene', label: '场景', supported: true },
  { id: 'Video', label: '视频', supported: true },
  { id: 'Web', label: '网页', supported: true },
  // ⚠️⚠️ 这里原来有 `{ id: 'Application', label: '程序', supported: false }`
  //   —— **0.9.118 删了**。用户 2026-08-02：「类型那里把程序这种类型直接删除不显示了」
  //
  // ⚠️ 而它和「场景」不是一类东西，所以只删这一个：
  //   · **场景**（Scene）—— **0.9.159 起支持**（那条评估我量错了对象，
  //     见 we-host.js 里 scene 那段）⟹ 标 supported: true
  //   · **程序**（Application）—— 别人编译的 **Windows .exe**，
  //     在 macOS 上**永远跑不了**，而且用户明确说过不做
  //     ⟹ 一个永远不会支持的筛选项 = 纯噪声，删掉
  //   ⟹ 判据：**「暂不支持」和「永远不支持」要分开** ——
  //     前者值得显示（是个待办），后者不值得（是个死胡同）。
];

// 年龄分级。
//
// ⚠️ 这三个字符串我核过两遍，因为 Open Wallpaper Engine 里有**两套不一样的命名**：
//   WorkshopViewModel        ["Everyone", "Questionable", "Mature"]   ← 发给 API 的
//   FilterResultsViewModel   ["Everyone", "Partial Nudity", "Mature"] ← 筛本地已下载的
// 我用前者。真样本印证：那个壁纸的 project.json 里是 `"contentrating": "Everyone"`。
//
// ⚠️ 默认只勾 Everyone（OWE 也这么做）—— 浏览工坊时默认不该出现成人内容，
// 而"默认全开然后让用户自己关"在这件事上是错的默认值。
// ⚠️⚠️ 标签文案用**年龄段**，不描述内容（0.9.53）。用户 2026-08-01：
//   「年龄这里应该是隐晦一些，直接承认内容太露骨了，写年龄吧，这个三个分级」
//
// 原来是「全年龄 / 轻度不适宜 / 成人内容」—— 后两个在**描述内容是什么**，
// 而这是一个会被别人看到屏幕的桌面软件 ⟹ 那两个词本身就是要避免的东西。
// ⟹ 换成分级式的年龄门槛（和电影分级、App Store 那套一致）：
//   用户看得懂"13+ / 18+"是什么意思，而屏幕上不出现任何内容描述。
//
// ⚠️ `id` 一个字都不能改 —— 那是发给 Steam 的 requiredtags，
// **区分大小写而且写错会返回空结果且不报错**（看起来像"这个分级下没东西"）。
// ⟹ 改的只有 label。
const AGE_TAGS_QUERY = [
  { id: 'Everyone', label: '全年龄', defaultOn: true },
  { id: 'Questionable', label: '13+', defaultOn: false },
  { id: 'Mature', label: '18+', defaultOn: false },
];


// 主题。真样本用的就是这一套（那个壁纸的 tags 是 ["Sci-Fi"]）。
const GENRE_TAGS_QUERY = [
  { id: 'Abstract', label: '抽象' },
  { id: 'Animal', label: '动物' },
  { id: 'Anime', label: '动漫' },
  { id: 'Cartoon', label: '卡通' },
  { id: 'CGI', label: 'CGI' },
  { id: 'Cyberpunk', label: '赛博朋克' },
  { id: 'Fantasy', label: '幻想' },
  { id: 'Game', label: '游戏' },
  { id: 'Girls', label: '女性角色' },
  { id: 'Guys', label: '男性角色' },
  { id: 'Landscape', label: '风景' },
  { id: 'Medieval', label: '中世纪' },
  { id: 'Memes', label: '梗图' },
  { id: 'Music', label: '音乐' },
  { id: 'Nature', label: '自然' },
  { id: 'Pixel art', label: '像素画' },
  { id: 'Relaxing', label: '放松' },
  { id: 'Retro', label: '复古' },
  { id: 'Sci-Fi', label: '科幻' },
  { id: 'Sports', label: '运动' },
  { id: 'Technology', label: '科技' },
  { id: 'Television', label: '影视' },
  { id: 'Vehicle', label: '载具' },
  { id: 'Unspecified', label: '未分类' },
];

// 筛选分组 —— 面板照这个渲染，加一组不用改 UI 代码。
const FILTER_GROUPS = [
  { id: 'type', label: '类型', tags: TYPE_TAGS_QUERY },
  { id: 'age', label: '年龄分级', tags: AGE_TAGS_QUERY },
  // ⚠️ 这里原来有「分辨率」组（RESOLUTION_TAGS_QUERY）—— 0.9.52 删了。
  // 用户 2026-08-01：「分辨率这个分类不需要，用处不大」
  // 他说得对：工坊壁纸的分辨率标签和"能不能在我的屏幕上好看"关系很弱
  //（网页/场景类是矢量的，视频类会被拉伸），而它占了一整行筛选。
  // ⚠️ RESOLUTION_TAGS_QUERY 的定义也删了 —— 留着就是死代码，
  //   而下一个人会以为它还在用（本项目在"删 UI 留调用"上栽过三次）。
  { id: 'genre', label: '主题', tags: GENRE_TAGS_QUERY },
];

// 默认勾上的标签。⚠️ 只有年龄分级有默认值，别的组默认不筛
//（筛了反而看不到"海量资源"）。
function defaultTags() {
  return AGE_TAGS_QUERY.filter((t) => t.defaultOn).map((t) => t.id);
}

// 组装浏览请求的查询参数。
//
// ⚠️ `return_previews` / `return_tags` 少了的话，返回的项**没有预览图和类型** ——
// 而那正是"浏览着挑壁纸"的全部依据。用户说过："预览图是可以看到的吧"。
function browseParams({ key, query, sort, tags, page, perPage }) {
  const hasText = !!(query && query.trim());
  const params = new URLSearchParams();
  params.set('key', key);
  params.set('appid', WE_APP_ID);
  params.set('query_type', String(queryTypeFor(sort, hasText)));
  params.set('page', String(Math.max(1, page || 1)));
  // ⚠️ 用 == null 而不是 || —— perPage: 0 是 falsy，`|| 30` 会把它变成 30，
  // 于是"限到 1"这个夹取根本没跑到。这类 falsy 兜底吞掉合法值的错很难看出来。
  const n = perPage == null ? 30 : Number(perPage);
  params.set('numperpage', String(Math.min(50, Math.max(1, Number.isFinite(n) ? n : 30))));
  params.set('return_previews', 'true');
  params.set('return_tags', 'true');
  params.set('return_short_description', 'true');
  params.set('return_metadata', 'true');
  if (hasText) params.set('search_text', query.trim());
  (tags || []).forEach((tag, i) => params.set(`requiredtags[${i}]`, tag));
  // ⚠️⚠️ **多个标签取并集（OR）而不是交集（AND）**。用户 2026-08-01：
  //   「之后是选中逻辑，应该允许多选，这样就是取并集，比如说年龄我选择了
  //     全年龄和轻度不适宜，那就是这两种的我都要看」
  //
  // 参数名就叫 `requiredtags` —— Steam 默认把它们当**全部满足**（AND）。
  // 而一个壁纸不可能同时是「全年龄」和「轻度不适宜」，也不可能同时是
  // 「视频」和「网页」⟹ 多选两项**必然零结果**，而那看起来像"这个筛选下没东西"。
  //
  // `match_all_tags=false` 把它变成 OR。
  //
  // ⚠️⚠️ **这条我没能实测** —— 这台机器没有 Steam API key（工坊查询要 key），
  // 所以我只能按 IPublishedFileService/QueryFiles 的参数表写。
  // ⟹ 用户侧第一次多选就能验：勾「全年龄」+「轻度不适宜」，
  //    出结果 = 生效；零结果 = 这个参数名不对，要换写法。
  // ⚠️ 只在**多个**标签时发 —— 单个标签下 AND/OR 等价，而少发一个参数
  //   就少一个出错面（如果这个参数名错了，Steam 可能整个请求报错而不是忽略它）。
  if ((tags || []).length > 1) params.set('match_all_tags', 'false');
  return params;
}

// QueryFiles 的响应结构和 GetPublishedFileDetails **不一样**：
// 前者是 response.publishedfiledetails 但字段略有差异，而且带 total。
// ⚠️ 复用 parseDetail 是对的（字段名大部分相同），但 total 要单独取 ——
// 没有它就没法做分页（不知道有几页）。
function parseBrowseResponse(json) {
  const response = (json && json.response) || {};
  const list = response.publishedfiledetails;
  return {
    items: Array.isArray(list) ? list.map(parseDetail).filter(Boolean) : [],
    total: Number(response.total) || 0,
  };
}

// 没配 key 时给出能照做的步骤。
// ⚠️ "需要 API key"这五个字对用户没用 —— 他不知道去哪弄、要不要钱。
function apiKeyHint() {
  return '浏览工坊需要一个 Steam Web API key（免费）：\n'
    + '  1. 打开 steamcommunity.com/dev/apikey\n'
    + '  2. 域名随便填（比如 localhost），提交\n'
    + '  3. 把那串 key 粘到下面\n'
    + '（只用来搜索和浏览。贴 ID 装载壁纸不需要它。）';
}

root.GestureWallWorkshop = {
  SORT_ORDERS,
  TYPE_TAGS_QUERY,
  AGE_TAGS_QUERY,
  GENRE_TAGS_QUERY,
  FILTER_GROUPS,
  defaultTags,
  queryTypeFor,
  browseParams,
  parseBrowseResponse,
  apiKeyHint,
  SCAN_MAX_DEPTH,
  SCAN_MAX_ITEMS,
  findWallpaperDirs,
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
