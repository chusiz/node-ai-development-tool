/**
 * 模型可用性探测 —— 「挨个发一次请求,看哪个真能回话」。
 *
 * ## 为什么要探测而不是拉列表
 *
 * 用户报的原话是「输入 api,验证的时候把所有模型名都验证一次,有回复的就是正确的,
 * 然后直接选用,因为如同火山有 1.6、2.1、2.0 等十多个版本,根本没法选」。
 *
 * 这句话背后是一个**物理限制**,不是偏好:
 *
 * - 大多数服务能 `GET /models`,那是最省事的答案 —— 能拉到就优先用它(见
 *   `fetchModels`),它是服务端的权威回答。
 * - 但**火山方舟的推理接入点拉不到**。方舟 `/api/v3/models` 不返回接入点,
 *   官方 `ListEndpoints` 要账号级 AK/SK 签名(不是方舟 API Key),本应用拿不到。
 *   而接入点(`ark-…` / `ep-…`)恰恰是方舟用户实际在用的那个,而且数量不限。
 * - 聚合站一个 Key 打通上百个模型,清单长到没法翻。
 *
 * 拉不到的**只能挨个试**:服务端会在 404 / 401 那一下告诉你这个 model 认不认。
 * 于是本模块做的事就是「把候选池跑一遍,按响应分三档」。
 *
 * ## 三档判定,以及为什么必须有第三档
 *
 * ```
 * ok       拿到了回复        → 真的能用
 * missing  模型不存在/无权限 → 别选它
 * skipped  没测出来          → **这不代表模型不可用**
 * ```
 *
 * 第三档是这套设计里**最要紧的一条**。限流(429)、5xx、超时、网络失败都不是
 * 「这个模型不对」,而是「这一次没测出来」。把它们混进 `missing` 的话,一次限流
 * 会让界面上出现半屏"不可用"—— 用户据此把能用的模型删掉,而真实原因是限流。
 * **方向错了,比没测更糟。**
 *
 * 判定复用 `shared/failure.ts` 的 `classifyFailure` / `classifyHttpStatus`,
 * 不另起一套关键词表 —— 那张表上一轮钉了 89 条断言,另写一份等于制造第二份真相。
 *
 * ## 成本:为什么每个请求都必须夹着 max_tokens
 *
 * 探测会一次发 N 个请求(N 可能是 15)。`protocols.ts` 里 `buildOpenai` 构造的
 * body **本来没有** `max_tokens`(OpenAI 系默认无上限),而 Anthropic 那边虽然有
 * `max_tokens` 却是写死的 8192。批量跑一遍 = 真金白银,而且用户点一次就花一次。
 *
 * 所以探测请求强制最小输出:prompt 短到不能再短,输出上限 1 个 token。
 * prompt 必须**能触发一次完整回复**(纯空白 / 无意义字符有些服务商会返回空响应,
 * 那就判不出"可用"了),所以用「答:1」这种有明确应答形状的极短串。
 *
 * ## 并发与限流
 *
 * 突发 15 个并发会被服务端限流,而用户看到的是"**全部失败**"—— 比不探测更糟。
 * 因此并发上限 3(见 `PROBE_CONCURRENCY`),每个探测独立超时,且**遇到 429 立即
 * 停止剩余探测**:继续发只会让限流窗口一直不恢复,而剩余那些一个都没测出来,
 * 如实标 `skipped` 才是真的。
 *
 * ## 本模块零依赖
 *
 * 与 `shared/providers.ts` / `shared/failure.ts` 同例:纯逻辑、不 import 任何
 * 带副作用的东西(尤其 zod),所以渲染进程可以**按值**引用 —— 这是设置页能在
 * 本地算出"这次要花多少钱"的前提(见 `estimateProbeCost`)。
 */
import { mergeModelCandidates, type ModelCandidate, type ModelDef } from './providers'
import { classifyFailure } from './failure'

/* ============================================================
   判定结果
   ============================================================ */

/**
 * 一个候选模型这一轮探测的结局。
 *
 * ⚠️ 这是一个**封闭集合**,且三档的语义差别很大,UI 必须分开显示 ——
 * 把 `skipped` 混进"不可用"会让用户在限流时误删能用的模型(见文件顶部)。
 */
export type ProbeVerdict = 'ok' | 'missing' | 'skipped'

/** 三个结局的中文短标签。UI 直接显示,不要在组件里各写一份 */
export const PROBE_VERDICT_LABEL: Record<ProbeVerdict, string> = {
  ok: '可用',
  missing: '不可用',
  skipped: '跳过',
}

/** 一条探测结果 */
export interface ProbeResult {
  /** 被探的模型 id(**原样**,不带任何改写) */
  id: string
  verdict: ProbeVerdict
  /**
   * 人话原因。
   *
   * `skipped` **必须**说清为什么(限流 / 超时 / 服务端故障),并且——在 UI 上——
   * 明确说"这不代表模型不可用"。这是用户区分"限流"与"模型不存在"的唯一依据。
   */
  reason: string
  /** 往返毫秒。用于让用户自己看出"哪个慢" */
  latencyMs: number
}

/** 一轮探测的完整结果 */
export interface ProbeReport {
  /** 每个候选一条,顺序与候选池一致 */
  results: ProbeResult[]
  /** 候选池来源:'remote' = 拉到了服务端真实列表;'builtin' = 退回内置清单 */
  source: 'remote' | 'builtin'
  /** 候选池里有多少个。UI 进度与成本提示都读它 */
  total: number
  /**
   * 是否被限流**中止**了。
   *
   * 为 true 时 `results` 里会有尚未发出的候选(标 `skipped`),UI 必须把这件事
   * 单独说出来 —— "限流了,已停止"与"这些模型不可用"是两种完全不同的结论。
   */
  rateLimited: boolean
  /**
   * 面向用户的一句话总结(取自 shared/providers.ts 的"内置清单"口径,
   * 在此原样带出候选池的出处,让用户知道这批候选是真是假)。
   */
  note: string
}

/* ============================================================
   成本
   ============================================================ */

/**
 * 探测请求的**输出上限**(token)。
 *
 * 1 而不是 0:0 会被部分服务端当成非法值,1 是各家都能接受的最小值。
 * 与 `testProvider` 用的 32 相比,批量探测下差 32 倍 —— 15 个模型就是
 * 480 → 15 个 token,这正是"敢做批量探测"的前提。
 */
export const PROBE_MAX_TOKENS = 1

/**
 * 探测用的 prompt。**必须短到不能再短,但要能触发一次完整回复**。
 *
 * 「答:1」:一个字符的答案,有明确应答形状。
 * 刻意不用空串 / 单个空白 —— 有些服务商会返回空响应体,那样就分不出
 * "能用但没话说"与"这个模型不存在"了。
 */
export const PROBE_PROMPT = '答:1'

/**
 * 并发上限。
 *
 * 3 是权衡:够快(15 个模型不至于让人等太久),又不会像一次性 15 个那样
 * 把服务商的并发额度打爆(结果是 429 限流,见文件顶部为什么必须立刻停)。
 */
export const PROBE_CONCURRENCY = 3

/** 每个探测独立超时(毫秒)。比拉列表宽松:推理模型吐第一个 token 慢 */
export const PROBE_TIMEOUT_MS = 30_000

/**
 * 一次批量探测大概花多少钱 —— **给用户看的成本知情文案**。
 *
 * 为什么要有这个函数:探测是**用户点了就真扣费**的动作,而用户对此毫无感知。
 * 把"要发几个请求"和"输出上限几个 token"摆出来,他才能自己判断值不值;
 * 只弹一个"确定要验证吗"是没用的 —— 他不知道那意味着多少钱。
 *
 * 按"输出 token 计价"估:输入是固定几个字符(可忽略),输出被 PROBE_MAX_TOKENS
 * 夹住,所以真实花费约等于 N 个 token。这里不猜单价(各服务商差几个数量级,
 * 且应用也不知道用户拿到的是哪一档折扣)—— 换成"输出上限共 N 个 token"这个
 * 事实陈述,比一个编出来的金额诚实得多。
 */
export function estimateProbeCost(total: number): string {
  const n = Math.max(0, Math.floor(total))
  if (n === 0) return '没有候选模型,不会发出任何请求。'
  return `将发出 ${n} 个请求(并发 ${PROBE_CONCURRENCY},逐个验证),每个请求的输出上限 ${PROBE_MAX_TOKENS} 个 token,` +
    `全部输出合计不超过 ${n * PROBE_MAX_TOKENS} 个 token —— 花费很小,但确实是真实请求、真实计费。`
}

/* ============================================================
   候选池
   ============================================================ */

/** 候选池的三路来源。`remote` 非空时优先用它(那是服务端的权威回答) */
export interface ProbeCandidateInput {
  /** `/models` 拉到的真实列表(拉不到就是空数组) */
  remote: readonly ModelDef[]
  /** 服务商注册表里的内置清单(兜底,可能已过期) */
  builtin: readonly ModelDef[]
  /**
   * 用户手填的名字。
   *
   * ⚠️ **这一路是火山场景的全部意义**:接入点 id(`ark-…`)不在任何可拉取的
   * 列表里,没有它探测对方舟用户完全无效。
   */
  manual?: readonly string[]
}

/** 一轮探测实际探哪些,以及它们从哪来 */
export interface ProbeCandidatePool {
  candidates: ModelCandidate[]
  /** 权威来源:能拉到真实列表时是 'remote',否则 'builtin' */
  source: 'remote' | 'builtin'
  /** 候选总数 */
  total: number
  /**
   * 手填的那些是否**全部**进了候选池。
   *
   * 单列出来是因为"用户填了但没被探"是个静默失败:他看到结果里没有自己填的
   * 接入点,会以为那个 id 不存在。UI 用它来提醒"你填的 X 没被验证"。
   */
  manualMissing: string[]
}

/**
 * 组装候选池,去重后返回。
 *
 * ## 优先级:`remote` > `builtin`,手填永远并入
 *
 * 能拉到真实列表时**优先用它** —— 那是服务端的权威回答,内置清单可能过期半年。
 * 但手填的名字**总是**并进去:它可能是接入点 id(拉不到),也可能与服务端列表
 * 重复(去重解决),更可能用户只是想确认某个特定的 id 通不通。
 *
 * ## 去重沿用 `mergeModelCandidates` 的同一套口径
 *
 * 不另写一份:那一处已经在处理"同一模型从多路来源进来"的问题(跨来源去重、
 * 大小写归一、`models/` 前缀)。这里直接调它,于是**候选池与界面上那个可搜索
 * 下拉框看到的是同一批去重后的模型** —— 两处去重口径漂移的话,用户会遇上
 * "下拉里有这个模型,探测列表里却没有"这种没法解释的现象。
 *
 * 顺序决定**探测顺序**,所以内部清单排在手填之前:用户最想验的那个手填项
 * 不会排在第 15 位等着(有并发上限 + 429 可能中止,靠前的先测更稳妥)。
 */
export function buildProbeCandidates(input: ProbeCandidateInput): ProbeCandidatePool {
  const hasRemote = input.remote.length > 0
  const source: ProbeCandidatePool['source'] = hasRemote ? 'remote' : 'builtin'

  const builtin: ModelDef[] = [...input.builtin]
  /*
   * `remote` 在前 —— 它是服务端的权威回答,内置清单可能已经过期半年。
   *
   * ⚠️ 内置清单**照样并进去**(只是排在后面),不是"拉到就不用它了":
   * 服务端列表与内置清单的内容并不总是一致(中转站可能只暴露自己那几个模型),
   * 而漏掉一个用户能用的模型,比多探一个更快拿到明确结论更糟。
   * 真被服务端认证过的名字会靠去重覆盖掉同名的内置项,排序上自然排前面。
   */
  const groups = hasRemote
    ? [
        { source: 'remote' as const, models: input.remote },
        { source: 'builtin' as const, models: builtin },
      ]
    : [{ source: 'builtin' as const, models: builtin }]

  /*
   * 手填的模型名:按手填原样保留,label 就是 id 本身。
   *
   * 不套用内置清单的 label —— 那些显示名对应的是"基础模型名"这个形态
   * (`doubao-seed-1-6-250615` → 「豆包 Seed 1.6」),而用户填的是接入点 id
   * (`ark-09d8…-b6d72`),那个 id 在控制台里的名字他自己是知道的,
   * 我们猜一个 label 只会显示错东西。
   */
  const manual: ModelDef[] = (input.manual ?? [])
    .map((id) => (id ?? '').trim())
    .filter((id) => id.length > 0)
    .map((id) => ({ id, label: id }))

  const candidates = mergeModelCandidates([...groups, { source: 'custom', models: manual }])

  /*
   * 算一下用户手填的名字有没有**真的**进了池子。
   *
   * 去重是按归一化后的键做的,所以"进了池但键不同"是可能的(理论上不会出现,
   * 因为键就是 id 本身);真正会缺的是空串与纯空白 —— 那些在 map/filter 里
   * 就被剔掉了,而用户可能以为自己填了。
   */
  const inPool = new Set(candidates.map((c) => c.id.toLowerCase()))
  const manualMissing = manual.map((m) => m.id).filter((id) => !inPool.has(id.toLowerCase()))

  return { candidates, source, total: candidates.length, manualMissing }
}

/* ============================================================
   响应分类
   ============================================================ */

/**
 * 把一次探测的原始结果归成三档之一。
 *
 * ## 为什么不自己判关键词
 *
 * 「模型不存在」在各家的说法有 `model not found` / `unrecognized_model` /
 * `does not exist` / `模型不存在` / HTTP 404 ……,而 `shared/failure.ts` 里那张
 * `NON_RETRYABLE_RULES` 表**已经把 `model` 这一类收全了**(上一轮还专门为
 * 「模型名与 does-not-exist 之间隔着模型名」这个坑加过 `{0,80}` 间隙)。
 * 这里自己再写一份关键词表,等于制造第二份真相 —— 加规则时只改一处就会漂移。
 *
 * ## 映射规则(为什么每一档都这么归)
 *
 * | 情况 | 归成 | 理由 |
 * |---|---|---|
 * | HTTP 2xx | `ok` | 链路通、Key 对、这个 model 名字被认 —— 三件事一次证明 |
 * | 401 / 403 | `missing` | Key 有效但**这个模型**没被授权,与模型名本身无关;对用户而言同样是不能选 |
 * | 404 且正文说清了是模型 | `missing` | 正文有具体证据时才敢判不可用(网关瞬时 404 是真实存在的) |
 * | 404 正文含糊 | `skipped` | 沿用 `shared/failure.ts` 对 404 的保守口径:CDN 切量时也会短 404,赌错了是拿"看不到的希望"换"多等 3 秒" |
 * | 429 | `skipped` + 中止 | **限流不是模型不对**。而且必须停,继续发只会延长限流窗口 |
 * | 5xx | `skipped` | 服务端故障,与用户配置无关 |
 * | 超时 / 网络失败 | `skipped` | "这次没测出来",最不能算成"不可用" |
 * | 正文命中 balance / quota | `skipped` | 余额不足、配额用尽 —— 是**账户**问题,15 个模型会一起 402,把它算成"这些模型不可用"会把用户引向完全错误的方向 |
 *
 * 最后一行是**最容易漏、后果最重**的一条:一次欠费会让全部候选都判成"不可用",
 * 而真实原因只要去充值就能解决。`classifyFailure` 认出 `balance` 就是
 * 用来挡这一条的。
 *
 * @param status  HTTP 状态码;网络层失败(超时 / fetch 抛错)时传 0
 * @param detail  响应体文本,已截断。**空响应体是可以接受的** —— 2xx 本身就够判 ok
 * @param netErr  网络层错误文本;非空时直接判 `skipped`
 */
export function classifyProbeResponse(
  status: number,
  detail: string,
  netErr = '',
): { verdict: ProbeVerdict; reason: string; rateLimited: boolean } {
  // 网络层失败(超时 / ECONNREFUSED / fetch failed)—— 什么都没测到
  if (netErr) {
    return {
      verdict: 'skipped',
      reason: `这次没测出来(连接失败:${trim(netErr)})—— **这不代表模型不可用**,可能只是网络抖动或对方暂时没响应。`,
      rateLimited: false,
    }
  }

  // 2xx = 链路、鉴权、模型名三件事一次全对。这是唯一能确定"可用"的情形
  if (status >= 200 && status < 300) {
    return { verdict: 'ok', reason: '有回复 —— 链路、Key、模型名都对。', rateLimited: false }
  }

  /*
   * 限流**先判**,且不依赖文案。
   *
   * 判据必须是状态码本身:文案含糊时 `classifyFailure` 归不出类(= 可重试),
   * 而这里**无论归出类与否都必须中止** —— 429 的字面
   * 意思就是"你现在发太多了",继续发只会让窗口一直不恢复。
   *
   * ⚠️ 这与"限流算不算模型问题"是两个独立的问题:它是**限流**(要停),
   * 但它**不是模型不存在**(所以是 skipped 而不是 missing)。
   */
  if (status === 429) {
    return {
      verdict: 'skipped',
      reason: '触发限流(HTTP 429),已停止后续探测 —— **这不代表模型不可用**,请稍后再试一次。',
      rateLimited: true,
    }
  }

  /*
   * 账户/配额类必须从 401/403/5xx 里**抢在前面**判出来。
   *
   * 靠文本判:有的服务拿 402 报欠费、拿 403 报配额耗尽,状态码与真实原因
   * 对不上。判成"不可用"会把用户引向"这些模型不能用",而他该做的是去充值。
   */
  const byText = classifyFailure(detail)
  if (byText.kind === 'balance' || byText.kind === 'quota') {
    return {
      verdict: 'skipped',
      reason: `${byText.kind === 'balance' ? '账户余额不足' : '配额已用尽'}(HTTP ${status})—— 这是账户问题,不是模型的问题,请先处理账户再试。`,
      rateLimited: false,
    }
  }

  // 401/403:Key 有效但没有这个模型的权限 —— 对"能不能选它"而言就是不可用
  if (status === 401 || status === 403) {
    return {
      verdict: 'missing',
      reason: `服务端拒绝了(HTTP ${status})—— Key 没有这个模型的访问权限,或 Key 本身无效。`,
      rateLimited: false,
    }
  }

  /*
   * 正文说清了是"模型"或"鉴权"问题 → 不可用。
   *
   * ⚠️ 这里用 `classifyFailure`(纯文本),因为**按状态码不够**:
   * `classifyHttpStatus` 只对 401/402/403/404/429 有专门分支,**400 一律返回
   * unknown**。而 400 + `unrecognized_model` 是真实存在的形态(CLI 型错误原文
   * 就是它,见 shared/failure.ts 的注释),只靠状态码会把它判成"没测出来"——
   * 用户看到的是"跳过,再试一次",而重试多少次它都是同一个错。
   *
   * 归不出类时**不判 missing**:这正是 `shared/failure.ts` 对 404 的保守口径
   * (CDN 切量时也会短 404)—— 宁可让用户重试,也不把能用的模型判死。
   */
  if (!byText.retryable && (byText.kind === 'model' || byText.kind === 'auth')) {
    return {
      verdict: 'missing',
      reason: `模型不存在或无权限(HTTP ${status})${detail ? ` · ${trim(detail)}` : ''} —— 换用这个服务端的准确模型名再试。`,
      rateLimited: false,
    }
  }

  // 5xx 与其它一切归不出类的:都是"这次没测出来"
  return {
    verdict: 'skipped',
    reason:
      `这次没测出来(HTTP ${status}${detail ? ` · ${trim(detail)}` : ''})—— ` +
      (status >= 500
        ? '**这不代表模型不可用**,是对方服务端的问题,稍后再试。'
        : '**这不代表模型不可用**,可能只是这次请求没通过。'),
    rateLimited: false,
  }
}

/* ============================================================
   探测结果 → 界面
   ============================================================ */

/** 按三档分组。UI 直接渲染三组,不必自己遍历判归属 */
export function groupProbeResults(results: readonly ProbeResult[]): Record<ProbeVerdict, ProbeResult[]> {
  const out: Record<ProbeVerdict, ProbeResult[]> = { ok: [], missing: [], skipped: [] }
  for (const r of results) out[r.verdict].push(r)
  return out
}

/**
 * 「第一个可用模型」—— 用户点一下就能选用。
 *
 * 挑的是**最快**的那个 ok(而不是候选池第一个):用户刚点完"用第一个",
 * 他要的其实是"现在就能用的那个",而列表第一项可能是个 30 秒的大模型。
 * 同延迟时保持候选池顺序(`groupProbeResults` 里的入参顺序)。
 */
export function pickFirstAvailable(results: readonly ProbeResult[]): string | null {
  const ok = results.filter((r) => r.verdict === 'ok')
  if (ok.length === 0) return null
  let best = ok[0]!
  for (const r of ok) if (r.latencyMs < best.latencyMs) best = r
  return best.id
}

/**
 * 把"探明了可用的模型"转成候选列表,喂给节点面板那个可搜索下拉框。
 *
 * 存哪:settings 的服务商配置里(与 `defaultModel` 同级)。这是**最省事**的
 * 落点 —— 不引入第二个缓存机制,用户换电脑/分享画布时它跟着 settings 走,
 * 而"这个模型我验过能用"本来就是一条配置,不是运行时状态。
 *
 * 为什么不需要单独记 verdict:落盘的**只有 ok 那批**(见 `verifiedModelIds`)——
 * skipped 的模型下次还得再探一遍,存下来反而会让用户以为"已经验过,不可用"。
 * 这就是"跳过不代表不可用"在存储层的落地。
 */
export function verifiedCandidates(results: readonly ProbeResult[]): ModelCandidate[] {
  return results
    .filter((r) => r.verdict === 'ok')
    .map((r) => ({ id: r.id, label: r.id, tag: '已验证', source: 'verified' as const }))
}

/** 探测通过的模型 id 列表。settings 落盘与候选注入都用它,避免两处各写一遍过滤 */
export function verifiedModelIds(results: readonly ProbeResult[]): string[] {
  return results.filter((r) => r.verdict === 'ok').map((r) => r.id)
}

/* ============================================================
   杂项
   ============================================================ */

/** 原因/正文统一截断。与 failure.ts 的 RAW_MAX 同量级:够定位,又不撑爆 UI */
function trim(s: string, max = 160): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}
