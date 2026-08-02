// 大模型调用 —— 两个提供方，一个协议无关的出口。
//
// ⚠️⚠️ **为什么不用 aws-sdk / openai 这些包**
//
// Bedrock 现在支持 **bearer token**（长期 API key），不需要 SigV4 签名
// ⟹ 一个 fetch 就够。而 OpenAI 兼容那支本来就是裸 HTTP。
// 这个项目现在只有两个 dependency（都是 MediaPipe），加一个 SDK 的代价是：
//   · 打包体积（aws-sdk 那套是几十 MB）
//   · ⚠️ 更糟：**又一个能静默失败的东西** —— SDK 的凭证解析链
//     （env → ~/.aws → IMDS）在打包的 .app 里行为和终端里不一样，
//     而失败症状是"卡住然后超时"，分不清是网络还是凭证。
// ⟹ 裸 HTTP：失败就是一个 HTTP 状态码 + 响应体，能直接给用户看。
//
// ⚠️⚠️ **凭证从来不进这个仓** —— 它们存在 `app.getPath('userData')/config.json`
//   （`~/Library/Application Support/GestureWall/`），那在仓外。
//   而诊断报告里由 `redactConfig` 打码（报告是要发给别人看的）。
//   ⟹ 这个文件里**不许**出现任何默认 key / 默认 token。
//
// 云端能测的：请求怎么拼、响应怎么解、错误怎么归类（都是纯函数）。
// 云端测不了的：真的发出去（要凭证）。⟹ 拼装和解析全抽成纯函数，见下面 export。

'use strict';

// ---------------------------------------------------------------------------
// 提供方
// ---------------------------------------------------------------------------
//
// ⚠️ 只有两支，而这不是"先做两个以后再加" —— 除了 Bedrock，
//   几乎所有能用的服务（DeepSeek / 硅基流动 / OpenRouter / Kimi / 自建代理）
//   都说 OpenAI 那套 `POST {base}/chat/completions` 协议。
//   ⟹ 「OpenAI 兼容 + 一个 base URL」覆盖它们全部，不需要每家一支。
const PROVIDERS = {
  bedrock: {
    id: 'bedrock',
    label: 'AWS Bedrock',
    // 面板上要显示"这一支需要填什么" —— 两支需要的字段不一样，
    // 而"填了半套"的症状是 4xx，那种错误看起来像凭证不对。
    fields: ['region', 'apiKey', 'model'],
    hint: 'region 例如 us-west-2；凭证用 Bedrock 的长期 API key（bearer token，'
      + '不是 AK/SK）；模型 ID 例如 us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI 兼容',
    fields: ['baseUrl', 'apiKey', 'model'],
    // ⚠️⚠️ 这条文案我写错过：原本写的是「base URL **要带到版本号**，例如
    //   `https://api.deepseek.com/v1`」——而那是 **OpenAI 自己的形状**，
    //   照搬到 DeepSeek 上是错的：它的官方文档写的是
    //   `base_url (OpenAI) = https://api.deepseek.com`（**不带 /v1**）。
    //   ⟹ 判据：别把一家的路径习惯当成"OpenAI 兼容"这个协议的一部分。
    //     `/v1` 在不在是各家自己定的，而拼错的症状是 404 —— 那看起来像"地址填错了"。
    hint: 'base URL 照各家文档原样填 —— DeepSeek 是 https://api.deepseek.com（不带 /v1），'
      + 'OpenAI 官方和多数代理是 .../v1。硅基流动 / OpenRouter / Kimi 都走这一支',
  },
};

// ---------------------------------------------------------------------------
// 请求拼装（纯函数 —— 这是云端唯一能验的部分，所以它必须是纯的）
// ---------------------------------------------------------------------------
//
// ⚠️ 返回 `{ url, headers, body }` 而不是直接 fetch：
//   拼错 URL / 少个 header / body 格式不对，这三种是**最常见**的失败，
//   而它们全都表现为一个 4xx —— 分不清是哪个。
//   ⟹ 抽成纯函数之后可以直接断言"拼出来长什么样"，不需要真发请求。
function buildRequest(cfg, messages, options) {
  const opts = options || {};
  const maxTokens = opts.maxTokens || 16000;
  if (!cfg || !cfg.provider) throw new Error('没选提供方');
  const provider = PROVIDERS[cfg.provider];
  if (!provider) throw new Error(`不认识的提供方：${cfg.provider}`);
  if (!cfg.apiKey) throw new Error('没填 API key');
  if (!cfg.model) throw new Error('没填模型 ID');

  if (cfg.provider === 'bedrock') {
    if (!cfg.region) throw new Error('Bedrock 要填 region（例如 us-west-2）');
    // ⚠️ 模型 ID 要 URL 编码 —— 它带冒号（`...-v1:0`），而冒号在路径段里
    //   虽然合法，但跨代理时被吃掉过。编码是无损的，不编码是赌。
    return {
      url: `https://bedrock-runtime.${cfg.region}.amazonaws.com`
        + `/model/${encodeURIComponent(cfg.model)}/invoke`,
      headers: {
        // ⚠️ Bearer + 长期 API key。**不是** SigV4 —— 那要签名算法，
        //   而这条路径存在的全部意义就是不需要它。
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // ⚠️ 这个字段名是 Bedrock 上 Anthropic 模型的**必填**项，
        //   而它的值是一个写死的日期串（不是我们的版本号）。少了它是 400。
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: maxTokens,
        messages,
      }),
    };
  }

  // OpenAI 兼容
  if (!cfg.baseUrl) throw new Error('要填 base URL');
  // ⚠️ 用户很可能把末尾斜杠带上（复制粘贴的常态）⟹ 拼出 `//chat/completions`。
  //   有的网关容忍，有的返回 404 ⟹ 而 404 看起来像"地址填错了"。⟹ 剥掉。
  const base = String(cfg.baseUrl).replace(/\/+$/, '');
  return {
    url: `${base}/chat/completions`,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens,
      messages,
    }),
  };
}

// ---------------------------------------------------------------------------
// 响应解析（同样是纯函数）
// ---------------------------------------------------------------------------
//
// ⚠️ 两家的响应形状不同，而**都可能"200 但没内容"** ——
//   那种情况下 `data.content[0].text` 直接抛 TypeError，
//   而那个报错（"Cannot read properties of undefined"）对用户毫无意义。
//   ⟹ 每一步都判，抛的错要说"模型没返回内容"。
function parseResponse(provider, data) {
  if (!data || typeof data !== 'object') throw new Error('响应不是 JSON 对象');
  if (provider === 'bedrock') {
    const parts = data.content;
    if (!Array.isArray(parts) || !parts.length) {
      throw new Error(`模型没返回内容（stop_reason=${data.stop_reason || '?'}）`);
    }
    // ⚠️ 只取 type === 'text' 的块 —— 以后如果开了 thinking，
    //   数组里第一个可能是 thinking 块，而那不是我们要的正文。
    const text = parts.filter((p) => p && p.type === 'text')
      .map((p) => p.text || '').join('');
    if (!text) throw new Error('模型返回了内容但没有文本块');
    return { text, stopReason: data.stop_reason || null };
  }
  const choice = data.choices && data.choices[0];
  if (!choice) throw new Error('响应里没有 choices');
  const msg = choice.message || {};
  // ⚠️⚠️⚠️ **推理模型把思考过程放在 `reasoning_content`、正文放 `content`**
  //   （DeepSeek 的 deepseek-reasoner / V4 系列、以及多数走 OpenAI 兼容协议的
  //   推理模型都是这个形状）。
  //
  // ⚠️ 而那导致一种**很难查的失败**：如果 token 预算在"还在思考"的阶段就用完了，
  //   `content` 是**空字符串**而 `reasoning_content` 满的，`finish_reason` 是
  //   `length` ⟹ 症状是"200 成功但没内容"。
  //   ⟹ 用户 2026-08-02 实测就撞到这个：探针（只要几个 token）通了、
  //     而生成壁纸（要上万 token）返回空。**两件事同时成立正是这个形状的指纹。**
  //
  // ⚠️ 所以这里**不能只看 content** —— 但也**不能拿 reasoning_content 当正文**
  //   （那是思考过程，里面没有完整 HTML）。⟹ 只用它来把报错说清楚。
  let text = typeof msg.content === 'string' ? msg.content : '';
  // ⚠️ 有的网关把正文包在 content 数组里（`[{type:'text',text:'…'}]`）——
  //   Anthropic 风格的形状漏到 OpenAI 兼容端点上。⟹ 顺手兜住。
  if (!text && Array.isArray(msg.content)) {
    text = msg.content.filter((c) => c && (c.type === 'text' || c.text))
      .map((c) => c.text || '').join('');
  }
  const finish = choice.finish_reason || null;
  if (!text) {
    // ⚠️⚠️ 报错**必须带上现场** —— 我第一版只说"content 是空的"，
    //   而那句话把唯一有用的信息（finish_reason、有没有 reasoning_content、
    //   花了多少 token）全丢了 ⟹ 我只能去猜原因。
    //   ⟹ 判据：**一个不带证据的报错等于把排查成本转给下一轮猜测。**
    const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
    const usage = data.usage || {};
    const parts = [`模型返回 200 但正文是空的（finish_reason=${finish || '?'}）`];
    if (reasoning) {
      // ⚠️ 这是最常见的一种，而它有明确的下一步 ⟹ 直接说该怎么办。
      parts.push(`\n⚠️ 但它有 ${reasoning.length} 字的 reasoning_content（思考过程）`
        + '—— 说明**预算在思考阶段就用完了**，正文还没开始写。'
        + '\n⟹ 这个模型是推理型的，不适合一次生成上千行代码。'
        + '换一个非推理模型（deepseek-chat 那类），或者把描述写简单点。');
      parts.push(`\n它思考的开头：${reasoning.slice(0, 200)}`);
    } else if (finish === 'length') {
      parts.push('\n⚠️ finish_reason=length ⟹ 被 token 上限截断，'
        + '而截断的位置在正文之前。把描述写简单点，或者换个模型。');
    } else {
      // ⚠️ 都不是的话把消息对象的键列出来 —— 那是"这家的响应形状和我们
      //   预期的不一样"唯一能带回来的线索。
      parts.push(`\nmessage 里有这些字段：${Object.keys(msg).join(', ') || '（空）'}`);
    }
    if (usage.completion_tokens !== undefined) {
      parts.push(`\ntoken：输入 ${usage.prompt_tokens ?? '?'}、输出 ${usage.completion_tokens}`);
    }
    throw new Error(parts.join(''));
  }
  return { text, stopReason: finish };
}

// ---------------------------------------------------------------------------
// 错误归类
// ---------------------------------------------------------------------------
//
// ⚠️⚠️ 这一段的价值全在**让用户知道该动哪里**。
//   一个裸的 `HTTP 403` 在面板上等于没说话 —— 用户会去重填 key（而那可能是对的），
//   或者以为是网络问题。⟹ 每个状态码给一句"你该做什么"。
//
// ⚠️ 而 `stopReason === 'max_tokens'` 单独拎出来：那**不是错误**，
//   是"生成被截断了" —— 而截断的 HTML 一定跑不起来，症状是白屏。
//   如果不识别它，用户看到的是"生成成功但壁纸是白的"。
function explainHttpError(status, bodyText) {
  const brief = String(bodyText || '').slice(0, 400);
  const map = {
    400: '请求被拒（400）—— 大概是模型 ID 写错了，或者这个模型不接受这种请求格式',
    401: '凭证不对（401）—— API key 填错了或者过期了',
    403: '没权限（403）—— key 是对的但没开这个模型的访问权限。'
      + 'Bedrock 要在控制台的「模型访问」里申请开通对应模型',
    // ⚠️ 不要说"要带到版本号" —— 各家不一样（DeepSeek 不带 /v1，OpenAI 带）。
    //   说错的话用户会去加一个本来不该有的 /v1，然后 404 变成另一个 404。
    404: '地址不对（404）—— base URL 或模型 ID 写错了。'
      + 'base URL 要和你那家的文档一字不差（有的带 /v1、有的不带）',
    413: '请求太大（413）—— 提示词或者回喂的代码超了这个网关的上限',
    429: '被限流（429）—— 等一会儿再试，或者换个模型/区域',
  };
  if (map[status]) return `${map[status]}\n\n服务端说：${brief}`;
  if (status >= 500) {
    return `服务端出错（${status}）—— 不是你这边的问题，过一会儿再试\n\n服务端说：${brief}`;
  }
  return `HTTP ${status}\n\n服务端说：${brief}`;
}

// ---------------------------------------------------------------------------
// 真的发出去
// ---------------------------------------------------------------------------
//
// ⚠️ 云端测不了这个函数（要凭证 + 网络）⟹ 它里面**不放任何逻辑**，
//   只做"发 + 把错误翻译成人话"。所有能出错的判断都在上面那三个纯函数里。
async function chat(cfg, messages, options) {
  const opts = options || {};
  const { url, headers, body } = buildRequest(cfg, messages, opts);

  // ⚠️ 必须有超时。生成一整个壁纸要几十秒，而**没有超时的 fetch 会挂到永远**
  //   ⟹ 面板上一个转圈永远不停，而用户没法分辨"还在生成"和"卡死了"。
  //   ⚠️ 默认 300 秒 —— 长到够生成 16k token，短到不会变成"永远"。
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs || 300000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST', headers, body, signal: controller.signal,
    });
  } catch (error) {
    // ⚠️ abort 和真的网络错误要分开说 —— 前者是"太慢了"，
    //   后者是"连不上"，而用户的下一步动作完全不同。
    if (error.name === 'AbortError') {
      throw new Error(`等了 ${Math.round(timeoutMs / 1000)} 秒还没回 —— `
        + '模型太慢或者网络不通。可以换个更快的模型，或者把描述写简单点');
    }
    throw new Error(`连不上：${error.message}\n\n`
      + '⚠️ 这类服务在国内常常要代理。而"贴 ID 装载壁纸"走的是另一条路，不受影响');
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();
  if (!response.ok) throw new Error(explainHttpError(response.status, raw));

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`响应不是 JSON（HTTP ${response.status}）：${raw.slice(0, 300)}`);
  }
  const out = parseResponse(cfg.provider, data);

  // ⚠️⚠️ 截断要**当错误报**，不能当成功返回。
  //   截断的 HTML 一定跑不起来（标签没闭合 / 函数没写完），
  //   而症状是白屏 ⟹ 如果这里不说，用户会去查"为什么壁纸是白的"。
  if (out.stopReason === 'max_tokens' || out.stopReason === 'length') {
    throw new Error('生成被长度上限截断了 —— 产物不完整（跑起来会白屏）。'
      + '把描述写简单点，或者调高 max_tokens');
  }
  return out;
}

// ⚠️ 面板要能"先测一下通不通"，而不是把连通性问题混在生成失败里。
//   ⟹ 一个最小请求：能回话就算通。
// ⚠️⚠️⚠️ 探针**不只测连通，还要测"这个模型会不会思考"**（0.9.126）。
//
// 用户 2026-08-02 实测踩到的：探针通了（模型回「通了」），而生成壁纸返回空正文。
// 账单给出了答案：2 次请求共 17,304 token，其中探针约 16、生成的输入约 1,240
// ⟹ **输出约 16,000，正好撞在 max_tokens 上，而 content 是空的**
// ⟹ 那 16,000 全烧在 `reasoning_content` 里了：deepseek-v4-flash 是推理模型，
//   它"想"到上限，一行 HTML 都没开始写。
//
// ⚠️ 而**"探针通了"当时给了人一个错的安全感** —— 它只证明了凭证和网络，
//   而真正会让这个功能失败的是"模型类型不对"，探针那时对此一无所知。
//   ⟹ 判据：**探针要测的是"这条路能不能完成真实任务"，不是"能不能握手"。**
//     所以它现在多问一句话（要求写一小段代码），并报告：
//       · 有没有 reasoning_content（会思考 ⟹ 生成长代码大概率烧光预算）
//       · 思考花了多少 token（那是"烧得多不多"的量）
async function ping(cfg) {
  const { url, headers, body } = buildRequest(cfg,
    // ⚠️ 让它写一行代码而不是"回两个字" —— 推理模型对"写代码"这类任务
    //   才会启动长链思考，而问"通了吗"它可能直接答（那就测不出来）。
    [{ role: 'user', content: '只输出一行 JavaScript：把 canvas 清成黑色。不要解释。' }],
    { maxTokens: 800 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40000);
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('等了 40 秒还没回 —— 模型太慢或网络不通');
    throw new Error(`连不上：${error.message}\n\n⚠️ 这类服务在国内常常要代理`);
  } finally {
    clearTimeout(timer);
  }
  const raw = await response.text();
  if (!response.ok) throw new Error(explainHttpError(response.status, raw));
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(`响应不是 JSON：${raw.slice(0, 300)}`); }

  // ⚠️ 这里**不能用 parseResponse** —— 它在正文为空时会抛，
  //   而探针恰恰要把"正文空但有思考"当成一个**有用的结论**报出来，不是失败。
  const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
  const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
  const text = typeof msg.content === 'string' ? msg.content : '';
  const usage = data.usage || {};
  return {
    ok: true,
    reply: String(text).trim().slice(0, 60),
    // ⚠️⚠️ 这两个字段是这次事故的直接产物 —— 面板拿它们提醒用户换模型。
    thinks: !!reasoning,
    reasoningChars: reasoning.length,
    outputTokens: usage.completion_tokens,
    finish: (data.choices && data.choices[0] && data.choices[0].finish_reason) || null,
  };
}

module.exports = {
  PROVIDERS,
  buildRequest,
  parseResponse,
  explainHttpError,
  chat,
  ping,
};
