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

// steamcmd 的下载目录布局是它自己定的，不可配：
//   <steamcmd 的安装目录>/steamapps/workshop/content/431960/<工坊 ID>/
//
// ⚠️ 这个路径要和 steamcmd 实际写的地方一致，否则下载成功但我们找不到 ⟹
// 症状是"下载完了什么都没发生"。
function contentPath(steamRoot, workshopId) {
  if (!steamRoot || !workshopId) return null;
  return `${steamRoot}/steamapps/workshop/content/${WE_APP_ID}/${workshopId}`;
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
const STEAMCMD_CANDIDATES = [
  '/opt/homebrew/bin/steamcmd',
  '/usr/local/bin/steamcmd',
  '/usr/bin/steamcmd',
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

root.GestureWallWorkshop = {
  WE_APP_ID,
  STEAMCMD_CANDIDATES,
  parseWorkshopId,
  contentPath,
  classifyLine,
  summarize,
  installHint,
  downloadArgs,
  redactArgs,
};
})(typeof window === 'undefined' ? globalThis : window);
