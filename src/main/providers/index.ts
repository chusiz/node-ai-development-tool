import type { ModelDef, ProviderDef } from '../../shared/providers'
import { effectiveBaseUrl } from '../../shared/providers'
import type { ProviderTestResult } from '../../shared/secrets'

/**
 * 服务商的运行时能力:拼鉴权头、拉模型列表、发一次真实请求验证链路。
 *
 * ## 为什么"测试连接"必须是发一次真实请求
 *
 * 能想到的更便宜的做法是"只检查 Key 格式"或"只探测地址通不通",但这两个
 * 都证明不了什么:地址能连上而 Key 是空的、Key 是对的而模型名写错了、
 * 模型名对而这个 Key 没有该模型的权限……**这几种错都在 401/404 那个瞬间
 * 才暴露**。所以这里就老老实实发一次 `max_tokens: 1` 的最小请求 ——
 * 花掉的那点 token 换来的是"确定的能用",值。
 *
 * ## 三种协议在这两个动作上的差异
 *
 * | | 拉列表 | 探活 |
 * |---|---|---|
 * | openai | `GET /models` | `POST /chat/completions` |
 * | anthropic | `GET /models` | `POST /messages`(必须有 anthropic-version) |
 * | gemini | `GET /models?key=` | `POST /models/{m}:generateContent?key=` |
 *
 * 差异全部收在这一层,上层(IPC / UI)只看到"给个服务商,回个结果"。
 */

/** 拉列表用 20s,探活给 60s —— 推理模型吐第一个 token 就是慢,卡太紧会误判成失败 */
const LIST_TIMEOUT_MS = 20_000
const TEST_TIMEOUT_MS = 60_000

/**
 * **鉴权**头。三家写法不同,写错的表现都是 401 而报错文本不会告诉你该用哪个。
 *
 * ⚠️ 这里**只管鉴权,不带 `Content-Type`**。
 *
 * 之前是无条件塞上 `'Content-Type': application/json'`,而 `fetchModels` 拿它发的是
 * `GET /models` —— 一个没有 body 的 GET 却声明了 body 的内容类型,不少网关
 * (CDN / 反代 / WAF)会因此判成非法请求,回 401/403。用户看到的现象是
 * "Key 明明填对了却拉不到模型",而报错文本里没有一个字跟 Content-Type 有关。
 *
 * 发 GET 用它,发带 JSON body 的 POST 用下面的 `jsonHeaders`。
 */
export function authHeaders(p: ProviderDef, key: string): Record<string, string> {
  const h: Record<string, string> = {}
  if (p.authStyle === 'bearer' && key) h.Authorization = `Bearer ${key}`
  else if (p.authStyle === 'x-api-key' && key) h['x-api-key'] = key
  if (p.protocol === 'anthropic') {
    // 缺这个头 Anthropic 会直接 400。官方所有请求都必须带,值是日期形态的版本号。
    h['anthropic-version'] = '2023-06-01'
  }
  return h
}

/**
 * 带 JSON body 的 POST 用的头 = 鉴权头 + `Content-Type`。
 *
 * 单独一个函数而不是给 `authHeaders` 加布尔参数:调用点全是 POST,
 * 传 `true`/`false` 谁也看不出哪个对哪个错,而"GET 不带、POST 带"这件事
 * 本身就该在函数名上写着。
 */
export function jsonHeaders(p: ProviderDef, key: string): Record<string, string> {
  return { ...authHeaders(p, key), 'Content-Type': 'application/json' }
}

/** 带超时的 fetch。超时抛的错统一成一句人话 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ac.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把 HTTP 状态码翻译成**用户能照着做**的话。
 *
 * 原始报错基本都是「Unauthorized」这种,用户看了不知道该改什么。
 * 这里补上"下一句该干嘛",因为 401 的真实原因有四种以上(没填 Key / Key 错了 /
 * Key 没开这个模型的权限 / 中转服务要求不同的头),光看状态码分不出来。
 */
function adviceFor(status: number, p: ProviderDef): string {
  switch (status) {
    case 401:
    case 403:
      /*
       * 401 的真实原因有四种(没填 / 填错 / 没权限 / 头写错),状态码分不出来,
       * 所以这里必须把"申请地址"也带上 —— 用户最需要的不是"被拒了",
       * 而是"去哪拿一把对的 Key"。p.keyUrl 就是为此存在的。
       */
      return (
        `Key 被服务端拒绝(HTTP ${status}):可能没填、填错了、或这把 Key 没被授予该服务商的访问权限。` +
        (p.keyUrl ? `去 ${p.label} 申请或核对 Key:${p.keyUrl}。` : `去 ${p.label} 的控制台申请或核对 Key。`) +
        `若你改过 Base URL,还要确认它确实是这家服务商的地址 —— 有些中转要求 x-api-key 而不是 Bearer。`
      )
    case 404:
      /*
       * ⚠️ 火山方舟是**特例**,必须先单独分出去:
       *   - 方舟没有公开的 /models 端点(拉列表必 404,是平台限制不是配置错);
       *   - 方舟 404(InvalidEndpointOrModel.NotFound)的真实含义是
       *     「该模型未开通 或 无权访问」:要么到控制台「开通管理」开通模型后
       *     用基础模型名直连(预置接入点,2026 起支持),要么创建推理接入点
       *     用 ep- / ark- 开头的接入点 id。两种都要在方舟控制台做,应用侧改不了。
       *   所以方舟的 404 一律引导去控制台,不说 /v1 的事(它本来就不带 /v1)。
       */
      if (p.id === 'ark') {
        return (
          `火山方舟没有公开的 /models 模型列表端点,这是平台限制,不是你的配置错。` +
          `且方舟 404 =「模型未开通或无权访问」。两种解法(都要在方舟控制台操作):` +
          `① 到方舟控制台「开通管理」开通对应模型后,即可用基础模型名(如 doubao-*)直连;` +
          `② 或在「在线推理 → 创建推理接入点」建一个,把 ep- 开头的接入点 id 填进模型框。`
        )
      }
      /*
       * 其他家的 404 在这条链路上九成是"少写了 /v1"。OpenAI 兼容的端点几乎都以 /v1 结尾,
       * 而用户填的是网站首页那种不带版本号的地址 —— 直接把他自己填的地址回显出来,
       * 比让他自己去猜要快得多。
       *
       * ⚠️ 但**不能对每家都说"少了 /v1"**:Gemini(v1beta) 等本来就不以 /v1 结尾 ——
       * 对它们提示加 /v1 是明摆着的误导(加进去反而连不上)。
       * 按这家自己的默认地址分叉:默认带 /v1 才提 /v1,否则只让用户核对官方地址。
       */
      return (
        `这个地址上没有 /models 端点(HTTP 404)。` +
        (p.baseUrl?.endsWith('/v1')
          ? `最常见的原因是 Base URL 少了 /v1 —— 比如应填 ${p.baseUrl}/ 而不是去掉 /v1 的版本。`
          : `若你改过地址,先核对它是不是 ${p.label} 官方文档里写的接口地址(这家不以 /v1 结尾)。`) +
        `若地址确认无误,则是该服务端不提供模型列表端点:这时不影响使用,` +
        `直接在服务商卡片上手填模型名即可。`
      )
    case 429:
      return '触发限流,或账户余额不足。稍后重试,或去服务商控制台确认额度。'
    case 400:
      return '请求被拒绝。最常见的原因是模型名不存在,或该模型不支持这种调用方式。'
    default:
      return status >= 500
        ? '服务商侧故障,不是你的配置问题。稍后再试。'
        : '检查 Base URL、Key 与模型名。'
  }
}

/** 网络层错误(Base URL 打不通)的单独提示 —— 和 HTTP 错误完全两回事 */
function networkAdvice(p: ProviderDef, msg: string): string {
  if (p.group === 'local') {
    return `连不上本机服务(${msg})。确认它已经启动,且端口与 Base URL 里写的一致。`
  }
  return `连接失败(${msg})。若服务商在境外,可能需要给应用配代理;公司网络也可能拦了它。`
}

/* ============================================================
   拉模型列表
   ============================================================ */

interface ListOutcome {
  models: ModelDef[]
  source: 'remote' | 'builtin'
  message?: string
}

/**
 * 明确**不是**对话模型的东西 —— embedding / rerank / 语音 / 图像 / 审核 / GGUF。
 *
 * ## 为什么要在这一层滤掉
 *
 * `/models` 是**整个平台**的目录,不是"能当 Agent 用的模型"目录。OpenAI 那个端点里
 * `text-embedding-3-large`、`dall-e-3`、`whisper-1`、`omni-moderation-latest` 全都在,
 * 硅基流动 / One-API 这类聚合站更是把全网几十家的东西平铺出来 —— 一百多条里挑一个,
 * 用户会挑花眼,并且极容易选中"列得出来但聊不了"的,表现为运行时 400/404,
 * 也就是那种"配置看着没问题却就是跑不起来"的哑谜。
 *
 * ## 过滤必须保守:宁可多列一个,也不能漏掉能用的
 *
 * 这条是硬约束,因为**代价不对称**:
 *   - 滤**多**了 → 模型从下拉里消失,用户以为不支持,除非知道手填否则彻底用不了;
 *   - 滤**少**了 → 下拉多几行噪声,用户不选它就毫无影响。
 *
 * 所以下面每条规则都要求**高置信度**(名字里有明确的类型词),不做"像不像对话模型"
 * 的猜测式判断,也**不用任何正面白名单**。
 *
 * ⚠️ 特别说明为什么这里用黑名单而不用 `^(gemini|gemma)` 这种白名单:
 * 白名单看起来更安全,但一旦服务商是"用 Gemini 协议转 OpenAI 模型"的中转站,
 * 或者协议字段填错,用户会**一个模型都看不到** —— 那是把"多列几行噪声"升级成
 * "完全不可用",正好违反了保守原则。黑名单只滤掉名字自带类型词的,
 * 不认识的前缀一律放行,新上架的模型也就永远不会误杀。
 */
const NON_CHAT_PATTERNS: readonly RegExp[] = [
  /*
   * 向量化 / 检索类。写法上要盖住三种构词:
   *   `text-embedding-3-large`(整词)、`nomic-embed-text`(前后缀)、`bge-m3` / `gte-base`(族名)。
   * ⚠️ 不能滤掉**所有**含 "embed" 的:实测有些网关把对话模型叫
   * `deepseek-embed-chat` 这类,滤错了用户就没得用了 —— 所以只认上面三种形态。
   */
  /embedding/i,
  /(^|[-_./])embed([-_./]|$)/i,
  /(^|[-_./])(e5|bge|gte)-/i,
  // 重排(reranker 常与 embedding 同门,但同样不能当对话模型用)
  /rerank/i,
  // 语音:转写 / 合成。`speech` 单独放行是刻意的 —— `gpt-4o-audio-preview` 是能对话的
  /whisper/i,
  /(^|[-_./])(tts|stt|text-to-speech|speech-to-text)([-_./]|$)/i,
  /transcri/i,
  // 图像生成。只滤明确带类型词的:`gemma-3-27b` 这种多模态能对话的绝不能碰
  /(^|[-_./])(dall-e|dalle|stable-diffusion|sdxl|flux|imagen)([-_./]|$)/i,
  // 内容安全审核:那是独立端点,列进下拉必然是误选
  /moderation/i,
  // 容器 / 权重文件(llama.cpp 生态的 `/models` 里常混着 gguf)
  /(^|[-_./])(gguf|ggml)([-_./]|$)/i,
]

/**
 * 这个模型 id 是不是"明确不是对话模型"。
 *
 * 判定只看 **id**,不看 label —— label 是厂商给的随便写的中文名,
 * 拿它做判断等于相信一句没有约定俗成的自由文本。
 */
function isNonChatModel(id: string): boolean {
  return NON_CHAT_PATTERNS.some((re) => re.test(id))
}

/**
 * 把服务商的模型列表响应翻译成 `ModelDef[]`。
 *
 * ## 为什么必须容忍这么多形状
 *
 * 字段名不统一是**生态现状**,不是各家的怪癖。实测能拿到的返回至少有五种:
 *
 * | 形态 | 谁这么返回 |
 * |---|---|
 * | `{data:[{id}]}` | OpenAI 官方、大部分网关 |
 * | `{data:[{name}]}` | 部分网关(把 id 叫 name) |
 * | `[{id}]` | **裸数组**,One-API / New-API / 自建反代最常见 |
 * | `["gpt-4o", ...]` | **字符串数组**,极简实现与部分 vLLM |
 * | `{models:[{name}]}` | Gemini |
 *
 * 改之前只认 `data` 与 `models` 两个信封,于是**裸数组一律返回 0 条** ——
 * 用户看到的是"拉取失败,已回落内置清单",而列表其实就在响应里,只是没读对地方。
 * 这正是"明明配置了服务商却拉不到模型"最高频的一种成因。
 *
 * ## 元素本身还可能是字符串
 *
 * 找到数组只是第一步。`{models:["gpt-4o","gpt-4o-mini"]}` 这种"数组里直接就是模型名"
 * 的返回极其常见(极简网关、vLLM 的部分版本),按"元素一定是对象"去取 `o.id`
 * 会**全部落空**返回 0 条 —— 和上面的裸数组是同一个坑的两半,必须一起补。
 */
export function toModelDefs(raw: unknown, protocol: ProviderDef['protocol']): ModelDef[] {
  const out: ModelDef[] = []
  /*
   * 已收录 id 的归一化形式 → 下标。**去重是刚需,不是锦上添花**:
   *   - 同一家响应里 `data` 与 `models` 常同时存在,内容大量重叠;
   *   - 同一个模型会以 `models/gemini-2.5-pro` 与 `gemini-2.5-pro` 两种写法出现;
   *   - `{id:"x", name:"x"}` 这种把两个字段填一样的报文非常常见。
   * 不去重的话,下拉框里会出现两个一模一样的选项,用户会以为是两个不同的模型。
   */
  const seen = new Map<string, number>()

  /*
   * 归一化:`models/xxx` 剥前缀(请求时要的是不带前缀的名字)+ 转小写(大小写差异
   * 不该产生两条)。用它当去重键,而**下发到 API 的仍是原始 id 大小写** ——
   * 有些服务端对 `GPT-4o` 与 `gpt-4o` 只认其中一种,改写回去等于替用户改错。
   */
  const dedupKey = (id: string): string => id.replace(/^models\//, '').toLowerCase()

  /** 收录一条。重复 / 被过滤 / 空 id 都不进 `out` */
  const push = (id: string, label?: string): void => {
    const trimmed = id.trim()
    if (!trimmed) return
    // Gemini 返回 `models/gemini-2.5-pro`,而请求时要的是不带前缀的那个
    const bare = trimmed.replace(/^models\//, '')
    if (isNonChatModel(bare)) return
    const key = dedupKey(bare)
    const at = seen.get(key)
    if (at !== undefined) {
      /*
       * 重复项只允许**补 label**,绝不覆盖 id 与已有 label。
       * 有些网关 `{id:"gpt-4o", name:"GPT-4o"}`,`name` 只是显示名;
       * 另一些 `{id:"x", name:"y"}` 里两者语义完全不同。哪种都不该由第二遍改写第一遍。
       */
      const prev = out[at]!
      if (prev.label === prev.id && label && label.trim() && label.trim() !== bare) {
        prev.label = label.trim()
      }
      return
    }
    seen.set(key, out.length)
    out.push({ id: bare, label: label?.trim() || bare })
  }

  /** 收一个数组里的每一项。元素可能是对象,也可能是直接一个模型名的字符串 */
  const takeArray = (arr: readonly unknown[]): void => {
    for (const m of arr) {
      /*
       * 元素是字符串 = 极简返回(整个数组就是模型名列表)。
       * ⚠️ 必须在取字段**之前**判掉:字符串的 `m.id` 是 undefined,
       * 按对象处理会静默丢掉全部条目 —— 症状与"完全不认识这个形状"一模一样。
       */
      if (typeof m === 'string') {
        push(m)
        continue
      }
      if (!m || typeof m !== 'object') continue
      const o = m as Record<string, unknown>
      const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
      /*
       * 逐个字段找 id —— 不同厂商真的用不同名字,少认一个就少一批模型。
       * `model` / `slug` 是实测存在的两种(前者见于部分代理的调试接口,
       * 后者见于 vLLM / Ollama 系)。宁可多认一个字段,也不要把用户的模型漏掉。
       */
      const id = str(o.id) ?? str(o.name) ?? str(o.model) ?? str(o.model_name) ?? str(o.slug)
      if (!id) continue
      // 显示名优先级:厂商显式给的 > 与 id 不同的 name > id 本身
      const label = str(o.display_name) ?? str(o.displayName) ?? str(o.label) ?? str(o.title)
      push(id, label ?? (str(o.name) !== id ? str(o.name) : undefined))
    }
  }

  /*
   * 根是数组 = 中转站的裸数组形状。⚠️ 不能写成 `typeof raw !== 'object'` 就放行:
   * 数组也是 object,但 `root.data` / `root.models` 在它上面全是 undefined,
   * 会在下面被当成"空信封"静默返回空列表 —— 那正是"拉不到"的原因。
   */
  if (Array.isArray(raw)) {
    takeArray(raw)
    return out
  }
  if (!raw || typeof raw !== 'object') return out
  const root = raw as Record<string, unknown>

  /*
   * 信封降级。**这里收所有命中的数组,而不是只取第一个** ——
   * 之前"只取第一个"是为了防重复(同一家把 `data` 和 `models` 都塞进响应),
   * 但现在有了 `seen` 去重,全收既不会重复,又能把那种"一半数据在 data、
   * 一半在 models"的畸形响应也读全。命中一个都不能少的反面是:
   * 少认一个数组 = 一批模型对用户彻底不可见。
   */
  if (Array.isArray(root.data)) takeArray(root.data)
  if (Array.isArray(root.models)) takeArray(root.models)
  if (Array.isArray(root.result)) takeArray(root.result)
  /*
   * `protocol` 不再参与分派。
   *
   * 之前 Gemini 走 `^(gemini|gemma)` 白名单、其余走 `data` 信封,现在两个分支合一:
   *   - 形状判断本身就足以把 `{models:[{name,displayName}]}` 收对(Gemini 的字段名
   *     本来就在 `str(o.name)` 之后被覆盖到);
   *   - 白名单是"不认识的就不给你",那是误伤;黑名单才是保守的那一侧。
   * 留着这个形参是为了不破坏调用方签名(main / IPC 两处都按位置传它)。
   */
  void protocol
  return out
}

/**
 * 拉真实模型列表。
 *
 * 失败**不抛** —— 回落到内置清单并把原因放进 message。
 * 理由:内置清单本来就是为了"拉不到也能用",把失败做成异常会让设置页
 * 在离线环境下整块变红,而那时用户其实还能正常选内置模型。
 *
 * ⚠️ 但"不抛"不等于"静默":每条回落都带一句**说清现在用的是内置清单、
 * 以及下一步该做什么**的话。用户分辨不出"真拉到了"和"在用内置的"时,
 * 唯一的表现就是运行时一句 `unrecognized_model` —— 那时他已经不知道
 * 该去哪里改了。message 是这条信息唯一的载体,不要写成纯错误码。
 */

/** 回落时的统一措辞。UI 靠"内置清单"这四个字判断要不要给手填入口 */
const BUILTIN_FALLBACK = '当前显示的是内置清单'

export async function fetchModels(
  p: ProviderDef,
  baseUrl: string,
  key: string,
): Promise<ListOutcome> {
  const base = effectiveBaseUrl(p, baseUrl)
  if (!base) {
    return {
      models: [...p.models],
      source: 'builtin',
      message: `还没填 Base URL,${BUILTIN_FALLBACK}。填上地址后点「刷新模型列表」即可拉到该服务的真实模型。`,
    }
  }

  const url = new URL(`${base}/models`)
  // ⚠️ GET 不带 Content-Type —— 见 authHeaders 的注释。带了会被不少网关判成非法请求
  const headers = authHeaders(p, key)
  // Gemini 的 Key 走 query 而不是头(它的 REST 约定)
  if (p.protocol === 'gemini' && key) url.searchParams.set('key', key)

  /*
   * ⚠️ 这一段回答用户那个最要紧的疑问:**"我改了地址,拉的是不是我自己那个服务端的列表?"**
   *
   * 答案是**是**,而且这里就是答案的全部依据:
   *   - `effectiveBaseUrl` 优先用用户填的地址,只有空串 / 纯空白才回落注册表内置值
   *     (规则只有这一处,在 shared/providers.ts,`fetchModels` 不做第二次判断 ——
   *     两处各判一次迟早会打架,变成"界面写 A 地址、请求发 B 地址"这种最难查的错);
   *   - 本行的 `base` 直接进 `${base}/models`,中间没有任何替换。
   *
   * 但"用的是哪个地址"必须**说出来**。同一个 404,填的是内置地址和填的是自建网关,
   * 原因完全不同;用户在报错里看不到自己填的地址,就只能反复猜。
   * 成功时也要说 —— 静默更新一个下拉框,用户无法确认"服务端到底认了我这份配置没有"。
   */
  const usingCustomBase = (baseUrl ?? '').trim().length > 0
  const baseNote = usingCustomBase
    ? `已按你填的接口地址拉取(${base})。`
    : `未填地址,按内置地址拉取(${base})。`

  try {
    const res = await fetchWithTimeout(url.toString(), { method: 'GET', headers }, LIST_TIMEOUT_MS)
    if (!res.ok) {
      return {
        models: [...p.models],
        source: 'builtin',
        message:
          `拉取失败(HTTP ${res.status}),${BUILTIN_FALLBACK}。${baseNote}` +
          (key ? '' : '另外:你还没填 API Key,先填一把再试。') +
          adviceFor(res.status, p),
      }
    }
    const raw = await res.json()

    /*
     * 数一遍"服务端一共报了几个"(过滤**之前**)。
     * 这个差值是唯一能说清"我不是没拉到,是读到但全被过滤掉了"的依据,
     * 而这两种情况用户的下一步动作完全相反:前者去改地址,后者去手填模型名。
     * 少了它就只能说"没找到模型列表",用户会一律当成服务端的问题 —— 而实际是
     * 他这把 Key 只能看到 embedding 之类。
     */
    const reported = countCandidates(raw)
    const models = toModelDefs(raw, p.protocol)
    if (models.length === 0) {
      return {
        models: [...p.models],
        source: 'builtin',
        message:
          reported > 0
            ? `已从${usingCustomBase ? '你填的地址' : '内置地址'}读到 ${reported} 个模型,但它们都不是对话模型` +
              '(embedding / rerank / 语音 / 图像这类),所以一个都没留下,' +
              `${BUILTIN_FALLBACK}。若运行时报模型名不对,直接在下面手填模型名即可。`
            : `这个服务端没返回能识别的模型列表(响应里既没有 data / models 数组,也不是裸数组),` +
              `${BUILTIN_FALLBACK}。这不影响使用 —— 在下面手填模型名即可,` +
              '或换一个支持 GET /models 的地址。',
      }
    }
    // 按 id 排序,免得每次拉取顺序都在变(列表会进下拉框,顺序跳动很难点)
    models.sort((a, b) => a.id.localeCompare(b.id))
    return {
      models,
      source: 'remote',
      /*
       * 成功也带 message。用户看到"拉到 N 个"与看到一个静默更新的下拉框,
       * 是两种心态 —— 前者能确认这份配置确实被服务端认了。顺带把地址回显出来,
       * 让他一眼能核对"拉的到底是不是我填的那个"。
       */
      message:
        `已拉到服务端真实列表,共 ${models.length} 个模型。${baseNote}` +
        (reported > models.length ? `(另有 ${reported - models.length} 个非对话模型已隐藏)` : ''),
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      models: [...p.models],
      source: 'builtin',
      message: `拉取失败(连不上),${BUILTIN_FALLBACK}。${baseNote}${networkAdvice(p, msg)}`,
    }
  }
}

/**
 * 数一数服务端报了几个候选模型(过滤**之前**)。
 *
 * 为什么不顺手让 `toModelDefs` 一起返回:
 *   - `toModelDefs` 的职责是"给出**能用的**",让它汇报"被弃的有几个"等于把过滤
     策略泄漏给调用方,以后加/减一条规则就要改两处;
 *   - 两者数不一致只影响文案里的那个 N,不影响功能 —— 而"读到了 N 个但一个都不是
 *     对话模型"这句话对用户的价值,值得多写这十行。
 *
 * 数法与 `toModelDefs` 的形状分派保持一致(裸数组 / data / models / result)。
 */
function countCandidates(raw: unknown): number {
  if (Array.isArray(raw)) return raw.length
  if (!raw || typeof raw !== 'object') return 0
  const root = raw as Record<string, unknown>
  let n = 0
  for (const k of ['data', 'models', 'result']) {
    const arr = root[k]
    if (Array.isArray(arr)) n += arr.length
  }
  return n
}

/* ============================================================
   探活
   ============================================================ */

function buildTestRequest(
  p: ProviderDef,
  base: string,
  key: string,
  model: string,
): { url: string; init: RequestInit } {
  const headers = jsonHeaders(p, key)
  const ping = '回复两个字:正常'

  if (p.protocol === 'anthropic') {
    return {
      url: `${base}/messages`,
      init: {
        method: 'POST',
        headers,
        // max_tokens 必须给,Anthropic 没有默认值
        body: JSON.stringify({ model, max_tokens: 32, messages: [{ role: 'user', content: ping }] }),
      },
    }
  }

  if (p.protocol === 'gemini') {
    const url = new URL(`${base}/models/${encodeURIComponent(model)}:generateContent`)
    if (key) url.searchParams.set('key', key)
    // Gemini 用 query 鉴权,别再把 key 塞进头(有些部署会因此报重复凭证)
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    return {
      url: url.toString(),
      init: {
        method: 'POST',
        headers: h,
        body: JSON.stringify({
          contents: [{ parts: [{ text: ping }] }],
          generationConfig: { maxOutputTokens: 32 },
        }),
      },
    }
  }

  return {
    url: `${base}/chat/completions`,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: ping }], max_tokens: 32 }),
    },
  }
}

/** 从各家响应里抠出模型那句话。抠不到就回一个通用成功文案(HTTP 200 本身就是证据) */
function extractReply(p: ProviderDef, raw: unknown): string {
  const o = raw as Record<string, any> | null
  if (!o) return ''
  try {
    if (p.protocol === 'anthropic') return String(o.content?.[0]?.text ?? '').trim()
    if (p.protocol === 'gemini') return String(o.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim()
    return String(o.choices?.[0]?.message?.content ?? '').trim()
  } catch {
    return ''
  }
}

/**
 * 发一次最小请求验证链路。
 *
 * 这是唯一能同时证明「地址对 + Key 对 + 模型存在」三件事的办法,所以设置页的
 * 「测试」按钮走的就是它(而不是只检查格式)。
 */
export async function testProvider(
  p: ProviderDef,
  opts: { baseUrl?: string; key?: string; model?: string },
): Promise<ProviderTestResult> {
  const base = effectiveBaseUrl(p, opts.baseUrl)
  const key = (opts.key ?? '').trim()
  const model = (opts.model ?? '').trim() || p.models[0]?.id || ''

  if (!base) {
    return {
      ok: false,
      message: '还没填 Base URL',
      latencyMs: null,
      model: model || null,
      advice: `这个服务商的接口地址是必须的。${p.hint ?? ''}`,
    }
  }
  if (!key && !p.optionalKey) {
    return {
      ok: false,
      message: '还没填 API Key',
      latencyMs: null,
      model: model || null,
      advice: p.keyUrl ? `去申请:${p.keyUrl}` : '在设置页填入 Key 后再试。',
    }
  }
  if (!model) {
    return {
      ok: false,
      message: '还没选模型',
      latencyMs: null,
      model: null,
      advice: '点「拉取模型」选一个,或手动填一个模型名。',
    }
  }

  const { url, init } = buildTestRequest(p, base, key, model)
  const t0 = Date.now()
  try {
    const res = await fetchWithTimeout(url, init, TEST_TIMEOUT_MS)
    const latencyMs = Date.now() - t0

    if (!res.ok) {
      // 把响应体也捞出来 —— 各家在 body 里写字更具体("model not found" 之类)
      let detail = ''
      try {
        const text = await res.text()
        detail = text.slice(0, 300)
      } catch {
        /* 读不到就算了,状态码本身已经是主信息 */
      }
      return {
        ok: false,
        message: `HTTP ${res.status}${detail ? ` · ${detail}` : ''}`,
        latencyMs,
        model,
        advice: adviceFor(res.status, p),
      }
    }

    const reply = extractReply(p, await res.json())
    return {
      ok: true,
      message: reply ? `模型回话:${reply.slice(0, 80)}` : '接口返回 200,链路正常',
      latencyMs,
      model,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      message: msg,
      latencyMs: Date.now() - t0,
      model,
      advice: networkAdvice(p, msg),
    }
  }
}
