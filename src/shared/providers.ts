/**
 * 模型服务商注册表 —— 「填自己的 API Key 用模型」这件事的唯一事实源。
 *
 * ## 为什么要有这张表
 *
 * 在这之前的架构里,节点上选的东西叫 "agent",而且只有一种形态:
 * 本机装好的 CLI(Claude Code),应用负责把它拉起来当子进程。
 * 用户要的第二条路完全不同 —— **不装任何东西,直接带着自己的 Key 调云端 API**。
 * 那条路上「模型」才是一等公民:同一家服务商下面挂着十几个模型,
 * 换模型就是换一个字符串,而换服务商要换地址、换鉴权头、换协议。
 *
 * 与其在每个调用点 if/else 判断"这家怎么拼请求",不如把差异全部收敛成数据:
 * 本文件描述**每一家长什么样**,执行层只认 `protocol` 这一个分叉点。
 * 加一家新服务商 = 往 PROVIDERS 里加一条,零代码改动。
 *
 * ## ⚠️ 内置模型清单一定会过时
 *
 * 模型迭代以周计,而这份清单是写死的。所以它**只是兜底与快速上手**,
 * 不是权威:
 *   1. 绝大多数 OpenAI 兼容服务都提供 `GET {baseUrl}/models`,能拉到真实列表
 *      (见 `listModels`),设置页可以一键刷新;
 *   2. 下拉框永远带一个「手动输入」出口 —— 只要把模型名填对就能用,
 *      哪怕内置清单里根本没有它。
 * 这两条兜在一起,清单过期也不会把用户卡死。反过来若只依赖内置清单,
 * 厂商一发新模型用户就只能等我们更新版本。
 *
 * ## 这个文件**不能** import 任何带副作用的东西
 *
 * 渲染进程会按值引用它(要渲染下拉框),所以这里只能是纯字面量与纯函数。
 * 引用 zod / node 内置模块会把它们打进渲染进程的 bundle —— 见 defaults.ts
 * 顶部关于 zod 泄漏的说明,同一个坑。
 */

/** 请求/响应协议。执行层只在这一个维度上分叉 */
export type ProviderProtocol =
  /** OpenAI Chat Completions(`POST /chat/completions`,SSE 增量) */
  | 'openai'
  /** Anthropic Messages(`POST /v1/messages`,事件类型更细) */
  | 'anthropic'
  /** Google Gemini(`POST /models/{model}:streamGenerateContent`) */
  | 'gemini'

/** 分组。只影响 UI 上的分区展示与排序,不参与任何逻辑判断 */
export type ProviderGroup = 'cn' | 'intl' | 'aggregator' | 'local' | 'custom'

export interface ModelDef {
  /** 传给 API 的 model 字段。**必须逐字准确** —— 写错就会 404 */
  id: string
  label: string
  /** 角标,用来标出"最能干活的那个"或"最便宜的那个" */
  tag?: string
}

export interface ProviderDef {
  id: string
  label: string
  group: ProviderGroup
  protocol: ProviderProtocol
  /** 默认接口地址。OpenAI 兼容的端点通常要以 /v1 结尾 */
  baseUrl: string
  /**
   * 是否允许用户改地址。
   *
   * 几乎全是 true —— 公司内网网关、自建反向代理、区域端点(如 .cn / 国际站)
   * 都要求换地址。置 false 的只有那些"地址本身就是产品身份"的情况。
   */
  baseUrlEditable: boolean
  /**
   * 鉴权头怎么写。这三家各不一样,写错的表现都是 401 ——
   * 而 401 的报错文本通常不会告诉你"应该用 x-api-key 而不是 Bearer"。
   */
  authStyle: 'bearer' | 'x-api-key' | 'none'
  /** 去哪申请 Key。设置页给一个可点的链接,省得用户自己搜 */
  keyUrl?: string
  /** 内置模型清单(兜底用,可能滞后于厂商) */
  models: ModelDef[]
  /** 是否支持 `GET {baseUrl}/models` 拉真实列表 */
  listModels: boolean
  /**
   * 本地推理服务不需要 Key。为 true 时 UI 不强制填 Key,
   * 探测失败也给出"服务没启动"而不是"密钥不对"的提示。
   */
  optionalKey: boolean
  hint?: string
}

/**
 * 首批内置的服务商。
 *
 * 顺序即 UI 顺序(组内),所以把最可能被点的放前面。
 * 模型清单的选品原则:**只列各家的主力型号,不追求全**。列全了既维护不动,
 * 也让下拉框变得没法用 —— 用户要的是"选一个能用的",不是"看完厂商目录"。
 */
export const PROVIDERS: readonly ProviderDef[] = [
  /* ---------------- 国内 ---------------- */
  {
    id: 'hunyuan',
    label: '腾讯混元',
    group: 'cn',
    protocol: 'openai',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    baseUrlEditable: true,
    authStyle: 'bearer',
    keyUrl: 'https://console.cloud.tencent.com/hunyuan/api-key',
    listModels: false,
    optionalKey: false,
    models: [
      { id: 'hunyuan-turbos-latest', label: '混元 TurboS', tag: '推荐' },
      { id: 'hunyuan-t1-latest', label: '混元 T1(推理)' },
      { id: 'hunyuan-large', label: '混元 Large' },
      { id: 'hunyuan-standard', label: '混元 Standard(便宜)' },
    ],
    hint:
      'Key 在腾讯云控制台「大模型知识引擎 → 混元大模型 → API KEY」申请。' +
      '用腾讯云新版 TokenHub 的话,把地址改成 https://tokenhub.tencentmaas.com/v1,模型名填 hy4-preview 或 hy3。',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek 深度求索',
    group: 'cn',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    baseUrlEditable: true,
    authStyle: 'bearer',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    listModels: true,
    optionalKey: false,
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek Chat', tag: '推荐' },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner(推理)' },
    ],
  },
  {
    id: 'dashscope',
    label: '通义千问(阿里云百炼)',
    group: 'cn',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    baseUrlEditable: true,
    authStyle: 'bearer',
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    listModels: true,
    optionalKey: false,
    models: [
      { id: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus', tag: '写代码' },
      { id: 'qwen-max', label: 'Qwen Max' },
      { id: 'qwen-plus', label: 'Qwen Plus(均衡)' },
      { id: 'qwen-turbo', label: 'Qwen Turbo(便宜)' },
    ],
    hint: '注意用「兼容模式」地址(带 /compatible-mode/v1),原生 DashScope 协议不通用。',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    group: 'cn',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    baseUrlEditable: true,
    authStyle: 'bearer',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    listModels: false,
    optionalKey: false,
    models: [
      { id: 'glm-4.6', label: 'GLM-4.6', tag: '推荐' },
      { id: 'glm-4.5', label: 'GLM-4.5' },
      { id: 'glm-4.5-air', label: 'GLM-4.5 Air(便宜)' },
    ],
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    group: 'cn',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    baseUrlEditable: true,
    authStyle: 'bearer',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    listModels: true,
    optionalKey: false,
    models: [
      { id: 'kimi-k2-turbo-preview', label: 'Kimi K2 Turbo', tag: '推荐' },
      { id: 'kimi-latest', label: 'Kimi Latest' },
      { id: 'moonshot-v1-128k', label: 'Moonshot v1 128K(长文)' },
    ],
  },
  {
    id: 'ark',
    label: '火山方舟(豆包)',
    group: 'cn',
    protocol: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    baseUrlEditable: true,
    authStyle: 'bearer',
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    listModels: true,
    optionalKey: false,
    models: [
      { id: 'doubao-seed-1-6-250615', label: '豆包 Seed 1.6' },
      { id: 'doubao-pro-32k', label: '豆包 Pro 32K' },
    ],
    /*
     * 方舟的 model 字段有两种值,这是**最容易踩**的一家:
     *   1. 基础模型名(`doubao-seed-1-6-250615` 等)—— 点「刷新模型列表」能拉到;
     *   2. **推理接入点 id**(`ep-xxxx`、`ark-xxxx`,在控制台自建,**数量不限**)
     *      —— 这才是多数用户实际在用的那个,而且**拉不到**:`/api/v3/models`
     *      不返回接入点,官方的 ListEndpoints 接口要账号级 AK/SK 签名鉴权
     *      (不是方舟 API Key),所以本应用拿不到,只能手填。
     * 于是「模型多、没法输入」在这家尤其突出 —— 接入点一个个建出来,
     * 没有任何下拉能列全,可搜索的输入框才是正解。
     */
    hint:
      '模型 id 有两种:基础模型名(doubao-seed-1-6-250615,点「刷新模型列表」能拉到)' +
      '与推理接入点 id(ep-xxxx / ark-xxxx,在控制台自建、数量不限)。' +
      '接入点不会出现在模型列表里(方舟没给出用 API Key 拉取接入点的接口),' +
      '把接入点 id 直接粘进模型框即可。',
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    group: 'cn',
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    baseUrlEditable: true,
    authStyle: 'bearer',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    listModels: true,
    optionalKey: false,
    models: [
      { id: 'deepseek-ai/DeepSeek-V3', label: 'DeepSeek V3' },
      { id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', label: 'Qwen3 235B' },
    ],
    hint: '聚合平台,模型名带厂商前缀(如 deepseek-ai/xxx)。建议点「拉取模型」看全量列表。',
  },

  /* ---------------- 国际 ---------------- */
  {
    id: 'openai',
    label: 'OpenAI',
    group: 'intl',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    baseUrlEditable: true,
    authStyle: 'bearer',
    keyUrl: 'https://platform.openai.com/api-keys',
    listModels: true,
    optionalKey: false,
    models: [
      { id: 'gpt-5', label: 'GPT-5', tag: '推荐' },
      { id: 'gpt-5-mini', label: 'GPT-5 mini(便宜)' },
      { id: 'gpt-4.1', label: 'GPT-4.1' },
      { id: 'o3', label: 'o3(推理)' },
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    group: 'intl',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    baseUrlEditable: true,
    authStyle: 'x-api-key',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    listModels: true,
    optionalKey: false,
    models: [
      { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', tag: '推荐' },
      { id: 'claude-opus-4-1', label: 'Claude Opus 4.1(最强)' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5(快)' },
    ],
    hint: '鉴权头是 x-api-key,不是 Bearer。另需 anthropic-version 头(应用会自动带上)。',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    group: 'intl',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    baseUrlEditable: true,
    authStyle: 'x-api-key',
    keyUrl: 'https://aistudio.google.com/apikey',
    listModels: true,
    optionalKey: false,
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', tag: '推荐' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash(快)' },
    ],
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    group: 'intl',
    protocol: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    baseUrlEditable: true,
    authStyle: 'bearer',
    keyUrl: 'https://console.x.ai',
    listModels: true,
    optionalKey: false,
    models: [
      { id: 'grok-4', label: 'Grok 4' },
      { id: 'grok-4-fast', label: 'Grok 4 Fast' },
    ],
  },

  /* ---------------- 聚合 ---------------- */
  {
    id: 'openrouter',
    label: 'OpenRouter(聚合)',
    group: 'aggregator',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    baseUrlEditable: true,
    authStyle: 'bearer',
    keyUrl: 'https://openrouter.ai/keys',
    listModels: true,
    optionalKey: false,
    models: [
      { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
      { id: 'openai/gpt-5', label: 'GPT-5' },
      { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat' },
    ],
    hint: '一个 Key 打通各家模型,模型名一律带厂商前缀。建议点「拉取模型」看全量列表。',
  },
  {
    id: 'groq',
    label: 'Groq(极速推理)',
    group: 'aggregator',
    protocol: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    baseUrlEditable: true,
    authStyle: 'bearer',
    keyUrl: 'https://console.groq.com/keys',
    listModels: true,
    optionalKey: false,
    models: [
      { id: 'moonshotai/kimi-k2-instruct', label: 'Kimi K2' },
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
    ],
  },

  /* ---------------- 本地 ---------------- */
  {
    id: 'ollama',
    label: 'Ollama(本机)',
    group: 'local',
    protocol: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    baseUrlEditable: true,
    authStyle: 'none',
    listModels: true,
    optionalKey: true,
    models: [
      { id: 'qwen3:8b', label: 'Qwen3 8B' },
      { id: 'deepseek-r1:7b', label: 'DeepSeek R1 7B' },
    ],
    hint: '需要本机先跑起 Ollama。不用填 Key —— 这里的模型名就是你 `ollama pull` 过的名字。',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio / vLLM(本机)',
    group: 'local',
    protocol: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    baseUrlEditable: true,
    authStyle: 'none',
    listModels: true,
    optionalKey: true,
    models: [],
    hint:
      'LM Studio 默认 1234 端口,vLLM 默认 8000。填对应端口即可,' +
      '模型名点「拉取模型」就能拿到本机已加载的。',
  },

  /* ---------------- 自定义 ---------------- */
  {
    id: 'custom',
    label: '自定义 OpenAI 兼容',
    group: 'custom',
    protocol: 'openai',
    baseUrl: '',
    baseUrlEditable: true,
    authStyle: 'bearer',
    listModels: true,
    optionalKey: true,
    models: [],
    hint:
      '任何遵循 OpenAI Chat Completions 协议的服务都行:公司内网网关、One-API、' +
      'New-API、自建反向代理……把 Base URL(通常以 /v1 结尾)、Key、模型名填上即可。',
  },
] as const

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]))

export function getProvider(id: string): ProviderDef | undefined {
  return BY_ID.get(id)
}

/** 分组的中文名与顺序。UI 直接照着渲染,不要再各写一份 */
export const PROVIDER_GROUPS: readonly { id: ProviderGroup; label: string }[] = [
  { id: 'cn', label: '国内服务商' },
  { id: 'intl', label: '国际服务商' },
  { id: 'aggregator', label: '聚合平台' },
  { id: 'local', label: '本地推理' },
  { id: 'custom', label: '自定义' },
]

export function providersInGroup(group: ProviderGroup): ProviderDef[] {
  return PROVIDERS.filter((p) => p.group === group)
}

/* ============================================================
   API 型 agent 的 id 编码
   ============================================================ */

/**
 * API 直连这类 agent 用 `api:<providerId>` 当 id。
 *
 * ## 为什么不给节点加一个独立的 `providerId` 字段
 *
 * 节点上真正要回答的问题只有一个:**"这个节点用什么跑"**。用 CLI 是
 * `agentId='claude'`,用云端 API 是"哪一家 + 哪个模型"。如果拆成
 * `agentId` + `providerId` 两个字段,就会冒出"agentId 是 CLI 但 providerId
 * 有值"这类没有意义的组合,以及随之而来的一堆校验分支。
 *
 * 把服务商编进 agentId 之后:
 *   - 节点上仍然只有**一个**"用什么东西跑"的选择,组合非法状态从类型上就不存在;
 *   - 现有的 `agentId` 落盘、工作流 spec 传递、日志 meta 全都不改;
 *   - `model` 作为独立字段,因为它对同一家服务商是可换的(见 NodeConfig.model)。
 *
 * 分隔符用 `:` —— 服务商 id 里不可能出现它(全是小写字母)。
 */
export const API_AGENT_PREFIX = 'api:'

export function apiAgentId(providerId: string): string {
  return API_AGENT_PREFIX + providerId
}

/**
 * 从 agentId 解出服务商。不是 API 型、或服务商不在注册表里 → null。
 *
 * ⚠️ 后一种情况(前缀对但 id 不认识)必须也返回 null 而不是抛:
 * agentId 是从 graph.json 读出来的,手改过的文件里出现 `api:不存在的东西`
 * 完全可能。那种情况下应该**回落成 CLI 默认**并让节点照常能跑,
 * 而不是让整个画布打不开。
 */
export function providerOfAgent(agentId: string | undefined): ProviderDef | null {
  if (!agentId || !agentId.startsWith(API_AGENT_PREFIX)) return null
  return getProvider(agentId.slice(API_AGENT_PREFIX.length)) ?? null
}

/** 是不是 API 型 agent(不校验服务商是否存在) */
export function isApiAgent(agentId: string | undefined): boolean {
  return !!agentId && agentId.startsWith(API_AGENT_PREFIX)
}

/**
 * 从 agentId 解出**服务商 id**(不校验它是否在注册表里)。不是 API 型 → undefined。
 *
 * 与 `providerOfAgent` 的区别:那个要求服务商**认识**,这个只做前缀剥离。
 * 查 `settings.agent.providers[<id>]` 用的是这个 —— 设置里可以存在任何
 * providerId(用户自己加的、注册表更新前留下的),按"必须认识"去查会在
 * 最需要读到配置的那种情况下反而拿不到。
 */
export function providerIdOfAgent(agentId: string | undefined): string | undefined {
  if (!agentId || !agentId.startsWith(API_AGENT_PREFIX)) return undefined
  const id = agentId.slice(API_AGENT_PREFIX.length)
  return id || undefined
}

/**
 * 这个节点实际会用哪个模型。
 *
 * 优先级:节点上选的 > 该服务商设置的默认模型 > 该服务商的内置首选 > 空串。
 *
 * 抽在这里是为了让"界面上显示的模型"和"请求里真发的模型"永远是同一个 ——
 * 两处各算一次的话,用户会看到界面写着 A 而请求发的是 B,而且不报任何错。
 */
export function effectiveModel(
  agentId: string | undefined,
  nodeModel: string | undefined,
  providerDefaultModel?: string,
): string {
  const picked = (nodeModel ?? '').trim()
  if (picked) return picked
  const fallback = (providerDefaultModel ?? '').trim()
  if (fallback) return fallback
  return providerOfAgent(agentId)?.models[0]?.id ?? ''
}

/**
 * 从 `settings.agent.providers` 抽出「providerId → 默认模型」,给 specFromGraph 用。
 *
 * ## 为什么要单独抽一个函数
 *
 * 运行规格(spec)是**主/渲染共用**的数据契约,它只认"拍进来的字段",不该
 * 自己去读设置 —— 那会让它从纯函数变成有依赖的模块。
 *
 * 但"用户在设置里选好的默认模型"必须能进运行规格,否则节点上不选模型时
 * spec.model 是空串,主进程只能退回**内置清单**的第一项。用户改过 Base URL
 * (中转站/代理/区域端点)时内置模型名多半不被认,于是每次都报"模型名不对",
 * 而他在设置里明明已经选好了 —— 这就是断链的那一环。
 *
 * 于是取数据的动作放在调用方(渲染进程,已经持有 settings),本函数只做
 * 「挑出非空的那些」这一件纯逻辑。空串必须剔掉:空串代表"用内置首选",
 * 混进映射会让 spec 把"用户没配"误当成"用户配了个空模型"。
 */
export function defaultModelMap(
  providers: Readonly<Record<string, { defaultModel?: string } | undefined>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!providers) return out
  for (const [id, cfg] of Object.entries(providers)) {
    const m = (cfg?.defaultModel ?? '').trim()
    if (m) out[id] = m
  }
  return out
}

/**
 * 这个服务商的 Base URL —— 用户改过就用用户的。
 *
 * 空串(自定义服务商还没填)由调用点拦下来报一句人话,
 * 而不是让 fetch 抛一个 "Failed to parse URL"。
 */
export function effectiveBaseUrl(provider: ProviderDef, override: string | undefined): string {
  const o = (override ?? '').trim()
  return (o || provider.baseUrl).replace(/\/+$/, '')
}

/* ============================================================
   模型候选:可搜索下拉的数据层
   ============================================================ */

/**
 * 一条候选模型**是从哪来的**。
 *
 * 为什么要标来源:这几种东西在界面上长得一模一样(都是一个模型名),
 * 但可信度完全不同 ——
 *   - `verified` = **探测跑过、确实拿到过回复**(最强,见 shared/probe.ts);
 *   - `remote`   = 刚从服务端拉的,此刻服务端认它,但没验过能不能回话;
 *   - `builtin`  = 写死在注册表里的,**可能已经过期**(见本文件顶部「清单一定会过时」);
 *   - `custom`   = 用户自己填的,压根没经过任何验证。
 *
 * 用户报过的原话是「模型版本多,没法输入」—— Ark 接入点动辄十几个、
 * 聚合站上百个,下拉框既翻不动也搜不了。所以这个控件必须让他**直接敲**,
 * 而敲进去的那个值必须**原样生效**,不因"不在清单里"被拦下。
 * 既然允许手填,就必须让他知道自己在填的是哪一种 —— 否则选错了要等到
 * 运行时才报模型名不对。
 */
export type ModelSource = 'verified' | 'remote' | 'builtin' | 'custom'

export interface ModelCandidate extends ModelDef {
  source: ModelSource
}

/** 来源的中文角标。UI 直接显示,不要在组件里各写一份 */
export const MODEL_SOURCE_LABEL: Record<ModelSource, string> = {
  verified: '已验证',
  remote: '服务端',
  builtin: '内置',
  custom: '手填',
}

/**
 * 按输入框里的字过滤候选模型。
 *
 * ## 匹配规则(三条,缺一条都会让"搜不到")
 *
 * 1. **大小写不敏感** —— 用户看到的是 `Claude Sonnet 4.5`,模型名却是
 *    `anthropic/claude-sonnet-4.5`,照着显示名敲大写 C 是最自然的动作。
 * 2. **同时匹配 `id` 与 `label`** —— 上面那条既是两个字段的差异,
 *    也说明只查一个必然漏:有人记 id(`qwen3:8b`),有人记显示名(`Qwen3 8B`)。
 * 3. **子串匹配,不是前缀匹配** —— 真实 id 里版本号在**末尾**
 *    (`doubao-seed-1-6-250615` 里能搜 `seed`、`1-6`、`250615` 任意一段),
 *    前缀匹配会让"搜 250615"这种最常见的找法直接落空。
 *
 * ## 排序:完全一致 > 前缀 > 子串
 *
 * 三者都命中时排前面的是那个**最可能就是他要的**。列表一长(聚合站上百条),
 * "能搜到"只是及格,"第一个就是它"才省得逐条看。
 *
 * ## 空查询返回全部 —— 这是刻意的
 *
 * 一上来就空着,用户会以为"这个服务商没有模型",而实际是候选还没输进去。
 * 空输入时列出全部,等于把"这家有什么"直接摆出来供浏览。
 *
 * ## 稳定性
 *
 * 相同排序档位内**保持入参顺序**(Array.prototype.sort 在 V8 上稳定),
 * 所以服务端列表原有的排序不会因为过滤而被搅乱。
 */
export function filterModels(list: readonly ModelCandidate[], query: string): ModelCandidate[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...list]

  const scored: { m: ModelCandidate; rank: number }[] = []
  for (const m of list) {
    const id = m.id.toLowerCase()
    const label = m.label.toLowerCase()
    let rank = -1
    if (id === q || label === q) rank = 0
    else if (id.startsWith(q) || label.startsWith(q)) rank = 1
    else if (id.includes(q) || label.includes(q)) rank = 2
    if (rank >= 0) scored.push({ m, rank })
  }
  scored.sort((a, b) => a.rank - b.rank)
  return scored.map((s) => s.m)
}

/**
 * 把多路候选合成一份列表,并按 id **去重**。
 *
 * ## 为什么要去重
 *
 * 同一个模型会从好几路进来:服务端刚拉的(`remote`)、注册表内置的(`builtin`)、
 * 以及用户自己填的(`custom`)。不去重的话下拉里会出现三个一模一样的选项,
 * 用户会以为是三个不同的模型 —— 这正是 `toModelDefs` 里那条去重逻辑
 * 要解决的同一个问题,只是那处管的是"服务端一家返回的重复",这处管的是"跨来源"。
 *
 * ## 去重键要归一化
 *
 * 用 `trim().toLowerCase()` 当键:`GPT-4o` 与 `gpt-4o` 是同一个模型,
 * 但**下发到 API 的仍是原始 id 大小写** —— 改写回去等于替用户改错。
 *
 * ## 谁先谁后 = 谁的身份更正
 *
 * **先传入的来源赢**。调用方按 `remote → builtin → custom` 的顺序传,
 * 于是"服务端刚说的"覆盖"我们以为的",手填的只在两边都没有时才作为新项出现。
 * 但**重复项允许补 label**:先到那条 `label === id` 时,后到的显示名能填上。
 */
export function mergeModelCandidates(groups: readonly { source: ModelSource; models: readonly ModelDef[] }[]): ModelCandidate[] {
  const out: ModelCandidate[] = []
  const at = new Map<string, number>()

  for (const g of groups) {
    for (const m of g.models) {
      const id = (m.id ?? '').trim()
      if (!id) continue
      const key = id.toLowerCase()
      const prev = at.get(key)
      if (prev !== undefined) {
        const p = out[prev]!
        // 与 toModelDefs 同一套规矩:重复项只补 label,绝不覆盖 id 与已有 label
        if (p.label === p.id) {
          const l = (m.label ?? '').trim()
          if (l && l !== id) p.label = l
        }
        continue
      }
      at.set(key, out.length)
      out.push({ id, label: (m.label ?? '').trim() || id, tag: m.tag, source: g.source })
    }
  }
  return out
}

/**
 * 用户**当前填着**的那个模型名,原样作为一条 `custom` 候选返回。
 *
 * 存在的理由:手填是这套控件明确支持的用法(清单外的名字照样生效),
 * 但填完之后下拉里如果没有它,用户会以为自己没填上、或者被系统偷偷改了值。
 * 让它以「手填」身份出现在列表里,既确认了"值在这儿",又如实标明它没被验证过。
 *
 * 已经在候选列表里的值返回 `[]` —— 重复列一次只会让人以为有两个模型。
 */
export function currentValueCandidate(
  list: readonly ModelCandidate[],
  value: string | undefined,
): ModelCandidate[] {
  const id = (value ?? '').trim()
  if (!id) return []
  if (list.some((m) => m.id.toLowerCase() === id.toLowerCase())) return []
  return [{ id, label: id, source: 'custom' }]
}
