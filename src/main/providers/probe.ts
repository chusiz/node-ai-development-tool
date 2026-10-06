import type { ModelDef, ProviderDef } from '../../shared/providers'
import { effectiveBaseUrl } from '../../shared/providers'
import {
  PROBE_CONCURRENCY,
  PROBE_MAX_TOKENS,
  PROBE_PROMPT,
  PROBE_TIMEOUT_MS,
  buildProbeCandidates,
  classifyProbeResponse,
  type ProbeReport,
  type ProbeResult,
} from '../../shared/probe'
import { buildChatRequest } from '../agents/api/protocols'
import { fetchModels } from './index'

/**
 * 批量模型探测 —— 「挨个发一次最小请求,看哪个真能回话」。
 *
 * 用户要的是这个:填完 Key 与地址,点一下,系统挨个验证候选模型,
 * **通过的留下、不通的去掉**,他直接从中选,不用在十几个版本里猜。
 *
 * ## 为什么必须挨个试(而不是拉列表)
 *
 * 火山方舟的推理接入点(`ark-…` / `ep-…`)拉不到:`/api/v3/models` 不返回接入点,
 * 官方 `ListEndpoints` 要账号级 AK/SK 签名(不是方舟 API Key)。
 * 而接入点恰恰是方舟用户实际在用的那个,且数量不限。
 * 拉不到的东西只能挨个试 —— 服务端会在 404/401 那一下告诉他认不认。
 * 能拉到真实列表时我们优先用它(那是权威答案),见 `buildProbeCandidates`。
 *
 * ## 三条硬约束(每一条都对应一类真实事故)
 *
 * 1. **成本** —— 每个请求都夹 `max_tokens: 1`(见 shared/probe.ts 顶部)。
 *    没有这条,批量探测就是"点一次花一次钱而用户不知道"。
 * 2. **并发 ≤ 3** —— 突发 15 个会被限流,而用户看到的是"全部失败",
 *    比不探测更糟。限流后**立即停**(见 `aborted`)。
 * 3. **三档分开** —— `skipped` 绝不能混进"不可用",否则一次限流会让用户
 *    误删能用的模型(方向错了,比没测更糟)。
 */

/** 一轮探测的输入 */
export interface ProbeOptions {
  baseUrl?: string
  key?: string
  /** 用户手填的候选模型名(接入点 id 走这里)。空串与纯空白自动剔除 */
  manualModels?: readonly string[]
  /**
   * 候选池上限。
   *
   * ⚠️ 存在的原因:候选池是"服务端列表 ∪ 内置清单 ∪ 手填",聚合站能到上百个。
   * 不封顶的话点一下就是一百多个计费请求 —— 那不是探测,那是扣费。
   * 截断时 `note` 会说清"还有 N 个没探",让用户知道自己拿到的是**一部分**结论。
   */
  maxCandidates?: number
  /** 每个探测的超时,默认 PROBE_TIMEOUT_MS */
  timeoutMs?: number
  /** 并发上限,默认 PROBE_CONCURRENCY。测试用它来确认真实峰值 */
  concurrency?: number
  /**
   * 每完成一个探测就报一次进度。
   *
   * ⚠️ 存在的理由不是"锦上添花":批量探测按并发 3 分批跑十几个请求,
   * 十几秒是常态。期间界面若不说清"到第几个了",用户面对一个卡住的按钮
   * 只会怀疑它死机,于是去连点 —— 连点会再触发一轮限流,反而更糟。
   */
  onProgress?: (done: number, total: number, aborted: boolean) => void
}

/** 默认候选上限。够覆盖用户报的那个场景(方舟十多个版本),又不至于变成扣费按钮 */
const DEFAULT_MAX_CANDIDATES = 24

/**
 * 拉候选池:能拉到服务端真实列表就优先用它,拉不到退回内置清单。
 *
 * 单独抽出来是因为它同时服务于两件事 —— 探测的输入,以及 note 里那句
 * "这批候选是真是假"。`fetchModels` 失败不抛(它自己回落内置清单),
 * 所以这一段永远不会让整轮探测失败。
 */
async function resolveCandidates(
  p: ProviderDef,
  baseUrl: string,
  key: string,
  manual: readonly string[],
  maxCandidates: number,
): Promise<{ pool: ReturnType<typeof buildProbeCandidates>; note: string }> {
  let remote: ModelDef[] = []
  let listNote = ''
  try {
    const listed = await fetchModels(p, baseUrl, key)
    if (listed.source === 'remote') {
      remote = listed.models
      listNote = listed.message ?? ''
    } else {
      // 拉取失败的原因本身就是重要信息 —— 用户需要知道"这批候选是内置的、可能过期"
      listNote = listed.message ?? '拉不到服务端真实模型列表,已退回内置清单。'
    }
  } catch (e) {
    listNote = `拉取服务端模型列表失败(${e instanceof Error ? e.message : String(e)}),已退回内置清单。`
  }

  const full = buildProbeCandidates({ remote, builtin: p.models, manual })

  /*
   * 封顶。候选池是「服务端列表 ∪ 内置清单 ∪ 手填」,聚合站能到上百个 ——
   * 不封顶的话点一下就是一百多个计费请求,那不是探测,那是扣费。
   * 截断时把"还有 N 个没探"写进 note:用户必须知道自己拿到的是**一部分**结论。
   */
  const candidates = full.candidates.slice(0, maxCandidates)
  const dropped = full.total - candidates.length

  const note =
    (listNote ? `${listNote} ` : '') +
    (dropped > 0
      ? `候选共 ${full.total} 个,本轮只探前 ${candidates.length} 个(还有 ${dropped} 个未验证,可把手填的模型名加进来单独验)。`
      : `本轮将逐个验证 ${candidates.length} 个候选模型。`)

  return {
    pool: { ...full, candidates, total: candidates.length },
    note,
  }
}

/** 带超时的 fetch。与 providers/index.ts 里那份同构,刻意不共用 —— 那份是私有的 */
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
 * 探一个模型。
 *
 * 请求体由 `buildChatRequest` 构造(与正常会话同一条路,见 shared/probe.ts
 * 关于 maxTokens 的注释)—— 但 `stream: false`、工具为空、prompt 极短、
 * `max_tokens: 1`。**只有输出上限这一条是成本相关的,其余是为了拿到一个
 * 可判定的完整响应而不是半截 SSE。**
 */
async function probeOne(
  p: ProviderDef,
  base: string,
  key: string,
  model: string,
  timeoutMs: number,
): Promise<{ verdict: ProbeResult['verdict']; reason: string; rateLimited: boolean; latencyMs: number }> {
  const t0 = Date.now()

  /*
   * 探测走**非流式**。
   *
   * 判据只需要"这个 model 名字被不被认",而流式会带来两个没必要的麻烦:
   * 半截 SSE 读不到 `finish` 就断,以及部分网关的流式错误藏在第一个 chunk 里。
   * 非流式一次读完整份 JSON,`ok` / `missing` / `skipped` 三档都判得干净。
   * ⚠️ 这与正常会话路径无关 —— 那边仍然是 `stream: true`。
   */
  const { url, init } = buildChatRequest({
    provider: p,
    baseUrl: base,
    apiKey: key,
    model,
    messages: [{ role: 'user', content: PROBE_PROMPT }],
    tools: [],
    maxTokens: PROBE_MAX_TOKENS,
  })

  // buildChatRequest 固定 stream:true,这里改掉 —— 探测要的是完整 JSON 而非 SSE
  const body = JSON.parse(String(init.body)) as Record<string, unknown>
  body.stream = false
  const headers = { ...(init.headers as Record<string, string>) }

  try {
    const res = await fetchWithTimeout(url, { ...init, headers, body: JSON.stringify(body) }, timeoutMs)
    const latencyMs = Date.now() - t0

    // 响应体尽力取:它承载"model not found"这类关键证据,取不到不影响判定
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 500)
    } catch {
      /* 读不到就算了,状态码本身已经是主信息 */
    }

    const verdict = classifyProbeResponse(res.status, detail)
    return { ...verdict, latencyMs }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // 超时也会走到这里(AbortError)—— 归成 skipped,理由与网络失败同源
    return { ...classifyProbeResponse(0, '', msg), latencyMs: Date.now() - t0 }
  }
}

/**
 * 逐个验证一批候选模型。
 *
 * ## 调度
 *
 * 手动维护一个 `inflight` 集合,最多同时 `concurrency` 个(默认 3,
 * 见 shared/probe.ts 里为什么是 3 而不是 15)。**429 会置 `aborted`**:
 * 之后的候选一个都不发,全部标 `skipped` 并说清"是限流,不是模型不对"。
 *
 * 为什么不直接 `Promise.all`:那会一次发 15 个 —— 被限流之后用户看到的是
 * "全部失败",而他其实什么都不知道。限流是**可恢复**的,慢慢重试就行。
 */
export async function probeModels(p: ProviderDef, opts: ProbeOptions): Promise<ProbeReport> {
  /*
   * ⚠️ 必须先校验**原始**输入,不能直接拿 effectiveBaseUrl 的结果判断"有没有地址"。
   *
   * `effectiveBaseUrl` 的语义是 `o || provider.baseUrl` —— 空串会静默回落成
   * 服务商的内置地址(Ollama / LM Studio 都有内置地址)。如果拿回落值判断,
   * "用户没填地址"这条路径的兜底(`if (!base)`)就永远不触发:
   * 请求照发(用户白付一次调用费),note 里也永远没有「接口地址」字样。
   */
  const rawBase = (opts.baseUrl ?? '').trim()
  const base = rawBase ? effectiveBaseUrl(p, opts.baseUrl) : ''
  const key = (opts.key ?? '').trim()
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS
  const concurrency = Math.max(1, opts.concurrency ?? PROBE_CONCURRENCY)
  const maxCandidates = Math.max(1, opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES)

  if (!base) {
    return {
      results: [],
      source: 'builtin',
      total: 0,
      rateLimited: false,
      note: '还没填接口地址 —— 填上 Base URL 才能验证模型。',
    }
  }
  if (!key && !p.optionalKey) {
    return {
      results: [],
      source: 'builtin',
      total: 0,
      rateLimited: false,
      note: '还没填 API Key —— 填好 Key 才能验证模型。',
    }
  }

  const { pool, note: poolNote } = await resolveCandidates(
    p,
    base,
    key,
    opts.manualModels ?? [],
    maxCandidates,
  )
  const candidates = pool.candidates

  if (candidates.length === 0) {
    return {
      results: [],
      source: pool.source,
      total: 0,
      rateLimited: false,
      note:
        `没有可验证的候选模型。${p.listModels ? '可以点「刷新模型列表」,或' : ''}` +
        '在下方把模型名(或火山那样的接入点 id)加进候选再试 —— 内置清单里没有的名字,填进来一样能验。',
    }
  }

  const results: ProbeResult[] = new Array(candidates.length)
  let aborted = false
  let inflight = 0
  let cursor = 0
  let done = 0

  /**
   * 从候选池里取下一个。`aborted` 之后一律不再取 —— 那正是 429 要的行为。
   * 取不到就返回 null(队列空或已中止)。
   */
  const takeNext = (): number | null => {
    if (aborted || cursor >= candidates.length) return null
    return cursor++
  }

  /** 跑完一个 worker:尽量把并发槽位填满,直到队列空或被限流中止 */
  const worker = async (): Promise<void> => {
    for (;;) {
      if (inflight >= concurrency) return
      const idx = takeNext()
      if (idx === null) return
      inflight++
      try {
        const id = candidates[idx]!.id
        const r = await probeOne(p, base, key, id, timeoutMs)
        results[idx] = { id, verdict: r.verdict, reason: r.reason, latencyMs: r.latencyMs }
        /*
         * ⚠️ 限流就停。
         *
         * 判定来自 `classifyProbeResponse` 对 429 的专门分支(那里说明了为什么
         * 不依赖文案)。继续发只会让服务端把限流窗口一直延长,而剩下的模型
         * 一个都测不出来 —— 如实标 skipped 才是真的。
         */
        if (r.rateLimited) aborted = true
      } finally {
        inflight--
        done++
        /*
         * 报进度时把"已完成"算上**每一个**探过的候选 —— 包括 skipped 的。
         * 它们确实发出了请求,用户等的就是这些。
         */
        opts.onProgress?.(done, candidates.length, aborted)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()))

  /*
   * 被中止时,没轮到的那些补一条 skipped。
   *
   * 一条理由就够:它们**根本没有发出请求**。用户看到的每一个"跳过"都要能回答
   * "那它到底能不能用",而这一次的诚实答案是"没测出来,请稍后再试"。
   */
  const rateLimited = aborted
  const SKIP_NOT_RUN =
    '因触发限流(HTTP 429)已停止后续探测,这一项**没有发出请求** —— 这不代表模型不可用,请稍后再试一次。'

  /*
   * ⚠️ 必须用 Array.from 显式按索引填,不能用 results.map()。
   *
   * `results` 是 `new Array(n)` 的**稀疏数组** —— map 会跳过空洞(回调根本不执行),
   * 于是"未发出的候选补成 skipped"这段逻辑会**静默失效**:429 中止后,
   * 没测到的候选直接从报告里消失,用户看不到"这些还没测"。
   * (真实事故:31.3 节断言「未发出的候选也出现在结果里」正是死在这一行。)
   */
  const finalResults: ProbeResult[] = Array.from({ length: candidates.length }, (_, i) => {
    const r = results[i]
    if (r) return r
    return {
      id: candidates[i]!.id,
      verdict: 'skipped',
      reason: SKIP_NOT_RUN,
      latencyMs: 0,
    }
  })

  const okCount = finalResults.filter((r) => r.verdict === 'ok').length
  const missingCount = finalResults.filter((r) => r.verdict === 'missing').length
  const skippedCount = finalResults.filter((r) => r.verdict === 'skipped').length

  /*
   * 手填但没进池的名字要点名 —— 静默丢掉是最坏的失败方式:
   * 用户填了接入点 id,结果里没有它,他只会得出"这个 id 不存在"。
   */
  const missingManual = pool.manualMissing
  const note =
    `${poolNote} 结果:可用 ${okCount} 个、不可用 ${missingCount} 个、跳过 ${skippedCount} 个。` +
    (rateLimited ? '⚠️ 已因限流提前停止,部分模型没测到。' : '') +
    (missingManual.length > 0 ? `⚠️ 你填的这些名字没能进入候选:${missingManual.join('、')}。` : '')

  return {
    results: finalResults,
    source: pool.source,
    total: candidates.length,
    rateLimited,
    note,
  }
}

/**
 * 主进程侧的候选池组装测试入口。
 *
 * 为什么要导出这个"看起来多余"的函数:候选组装是**纯逻辑**(去重、优先级、
 * 手动名的并入),但它住在 `shared/probe.ts` 里被主进程与渲染进程共用。
 * 把它透出来,测试就能在"这一层"直接断言组装口径,而不必为了测它去跑一整轮
 * 假 fetch —— 假 fetch 测的是网络与调度,组装口径不该被那一层盖住。
 */
export { buildProbeCandidates }
