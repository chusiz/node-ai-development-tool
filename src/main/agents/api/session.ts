import { randomUUID } from 'node:crypto'
import type { NodeEvent, SessionStatus } from '../types'
import type { LiveSession } from '../live'
import type { SessionCallbacks } from '../session'
import type { ApiCtx, ChatMessage, StreamChunk, ToolCall, ToolDef } from './types'
import { buildChatRequest, readStream } from './protocols'
import { executeTool, toolsFor } from './tools'
import { loadHistory, saveHistory } from './history'
import { classifyFailure, classifyHttpStatus, type FailureVerdict } from '../../../shared/failure'

/**
 * API 直连的一路会话 —— 与 AgentSession 同构,但底下没有进程,只有 fetch。
 *
 * ## 一轮是怎么走的
 *
 * ```
 *   读历史 → 追加用户这句
 *   ┌─ 调模型(流式,边收边推文本事件) ─────────────┐
 *   │   有工具调用? → 执行 → 结果塞回 messages → 回到循环头 │
 *   │   没有?        → 这一轮结束                    │
 *   └──────────────────────────────────────────┘
 *   落盘历史 → 推 result 事件 → 结束
 * ```
 *
 * ## 两个必须处理的现实问题
 *
 * ### ① 流式文本不能逐 token 推给 UI
 *
 * SSE 是逐 token 来的,一个长回答能到几千个 chunk。每个 chunk 推一个 `text`
 * 事件会:把 40ms 聚合器冲垮、让 IPC 与渲染进程内存爆掉、并且**落盘时每 token
 * 一条记录**(刷新后重新加载几千条)。所以这里按「时间 + 长度」双阈值聚合,
 * 再整块推出去。渲染侧还会把相邻的 text 块合并成一条消息,所以用户看到的
 * 仍然是一个完整气泡 —— 见 renderer 的 mergeAdjacentText。
 *
 * ### ② 工具循环会失控
 *
 * 模型可能陷入"调用 → 失败 → 换个写法再调用"的循环,而每次调用都是真金白银
 * 的 token 与真实文件改动。所以有硬上限 `maxTurns`,到顶就停并如实报错,
 * 而不是让它一直跑到用户发现账单。
 */

/** 文本聚合:至少间隔这么久才推一次 */
const TEXT_FLUSH_MS = 400
/** 或者累积到这么多字符就立刻推(不等时间窗口) */
const TEXT_FLUSH_CHARS = 1500

export const DEFAULT_MAX_TURNS = 30
export const DEFAULT_API_TIMEOUT_MS = 10 * 60 * 1000

interface ChatOutcome {
  text: string
  toolCalls: ToolCall[]
  error: string | null
  /**
   * 本次失败的归类结果。
   *
   * 只在 `error` 非空时有值,交给 run() 存到会话上,由 finish() 交给调度器。
   * 单独一个字段而不是从 error 文本反推,是因为这条路的判据是 **HTTP 状态码**
   * (见 classifyHttpStatus 的说明),文案是我们自己拼的、不该反过来当判据。
   */
  failure?: FailureVerdict
}

export class ApiSession implements LiveSession {
  private finished = false
  private cancelled = false
  private timedOut = false
  private sawError = false
  /** 本轮归出的失败类别。调度器靠它决定还要不要退避重试 */
  private failure: FailureVerdict | undefined
  private aborter: AbortController | null = null
  private exitInfo: {
    status: SessionStatus
    code: number | null
    signal: NodeJS.Signals | null
    failure?: FailureVerdict
  } | null = null

  private readonly _done: Promise<void>
  private resolveDone!: () => void

  /** 我们自己生成的会话 id。API 协议无状态,这个 id 只是给 UI 和日志一个标识 */
  private readonly sessionId = randomUUID()
  private readonly startedAt = Date.now()

  constructor(
    private readonly ctx: ApiCtx,
    private readonly cb: SessionCallbacks,
  ) {
    // ⚠️ 必须在构造时就建 Promise,不能在 getter 里懒建 ——
    // 快会话会在"start 返回"与"注册监听"之间就跑完,那时新建的 Promise
    // 永远不会 resolve,工作流 runner 就永久挂起(同 AgentSession 的坑)
    this._done = new Promise<void>((resolve) => {
      this.resolveDone = resolve
    })
  }

  get isRunning(): boolean {
    return !this.finished
  }

  get done(): Promise<void> {
    return this._done
  }

  get result(): {
    status: SessionStatus
    code: number | null
    signal: NodeJS.Signals | null
    failure?: FailureVerdict
  } | null {
    return this.exitInfo
  }

  cancel(): void {
    if (this.finished) return
    this.cancelled = true
    // abort 会让正在 await 的 fetch / reader.read() 立刻抛,由下面的 catch 收尾。
    // 单独设一个标志是因为 killProcessTree 那种"同步杀死"在这里不存在 ——
    // HTTP 中断一定是异步的,中间还有一小段时间窗口
    this.aborter?.abort()
  }

  /* ------------------------------------------------------------------ */

  /**
   * 跑一轮。
   *
   * `_presetArgs` 是 LiveSession 接口的要求(CLI 那一路用它回显算好的 argv),
   * API 这条路上没有 argv 这个概念 —— 接口统一的好处是管理器不用分支,
   * 代价就是这里多一个不用的参数。刻意带下划线前缀,表明它是有意忽略的。
   */
  async run(prompt: string, _presetArgs?: string[]): Promise<void> {
    const { ctx, cb } = this
    const t0 = Date.now()
    let outText = ''
    let finalStatus: SessionStatus = 'done'

    try {
      const tools = toolsFor(ctx.permissionMode)
      const messages = await loadHistory(ctx.canvasId, ctx.nodeId)
      messages.push({ role: 'user', content: prompt })

      cb.onSessionId?.(this.sessionId)
      cb.onEvents([
        {
          k: 'init',
          ts: Date.now(),
          sessionId: this.sessionId,
          model: ctx.model,
          cwd: ctx.cwd,
          // 把工具名列出来:用户能一眼看到"这个权限模式下它手上有哪些家伙",
          // 而不是等到某次越权被拒才发现
          tools: tools.map((t) => t.name),
        },
      ])

      let turns = 0
      for (; turns < ctx.maxTurns; turns++) {
        if (this.cancelled) break

        const r = await this.chat(messages, tools)
        if (r.error) {
          this.sawError = true
          /*
           * 只在**这一轮就结束**时记归类。
           * 后面 maxTurns / 流被截断那些分支即使也发 error 事件,成因与 HTTP 无关
           * (是我们自己主动停的),不该被算成"服务商不可用"。
           */
          if (r.failure) this.failure = r.failure
          cb.onEvents([{ k: 'error', ts: Date.now(), message: r.error }])
          break
        }

        outText += r.text

        if (r.toolCalls.length === 0) {
          // 没有工具调用 = 这一轮就是最终回答
          messages.push({ role: 'assistant', content: r.text })
          // 空响应(既没文字也没调用)同样要停,否则下一次请求会发出一样的上下文,
          // 得到一个一样的空响应 —— 死循环,而且每轮都在花钱
          if (!r.text.trim()) {
            this.sawError = true
            cb.onEvents([
              { k: 'error', ts: Date.now(), message: '模型返回了空响应,已停止本轮。' },
            ])
          }
          break
        }

        messages.push({ role: 'assistant', content: r.text, toolCalls: r.toolCalls })

        for (const tc of r.toolCalls) {
          if (this.cancelled) break
          cb.onEvents([
            { k: 'tool_use', ts: Date.now(), id: tc.id, name: tc.name, input: safeParseJson(tc.args) },
          ])

          const res = await executeTool(tc.name, tc.args, {
            root: ctx.cwd,
            mode: ctx.permissionMode,
            isCancelled: () => this.cancelled,
          })

          cb.onEvents([
            {
              k: 'tool_result',
              ts: Date.now(),
              toolUseId: tc.id,
              content: res.content,
              isError: res.isError,
            },
          ])
          messages.push({
            role: 'tool',
            toolCallId: tc.id,
            name: tc.name,
            content: res.content,
          })
        }
      }

      if (turns >= ctx.maxTurns && !this.cancelled) {
        this.sawError = true
        cb.onEvents([
          {
            k: 'error',
            ts: Date.now(),
            message: `工具调用达到 ${ctx.maxTurns} 轮上限,已主动停止 —— 它可能陷在了「改一下、失败、再改一下」的循环里。看上面的工具记录判断卡在哪,或把任务说得更具体再跑。`,
          },
        ])
      }

      // 历史落盘走 try:它失败不该让整轮结果作废(用户已经在界面上看到答案了)
      await saveHistory(ctx.canvasId, ctx.nodeId, messages).catch(() => {})

      finalStatus = this.cancelled
        ? 'killed'
        : this.timedOut
          ? 'timeout'
          : this.sawError
            ? 'error'
            : 'done'

      cb.onEvents([
        {
          k: 'result',
          ts: Date.now(),
          text: outText || null,
          sessionId: this.sessionId,
          // API 直连拿不到美元成本(各家计费口径不一),如实留空而不是编一个
          costUsd: null,
          durationMs: Date.now() - t0,
          isError: this.sawError,
        },
      ])
    } catch (e) {
      finalStatus = this.cancelled ? 'killed' : this.timedOut ? 'timeout' : 'error'
      if (!this.cancelled) {
        this.sawError = true
        const msg = e instanceof Error ? e.message : String(e)
        /*
         * 兜底也归一次类。
         *
         * 走到这里的异常大多来自 fetch 本身(连接被拒 / DNS 失败 / 证书问题),
         * 归出来基本是 unknown → 可重试,那正是我们要的;
         * 但如果哪天某个 SDK 把"Key 无效"抛成了异常而不是返回 4xx,
         * 这里就能接住,不至于让一个永久错误被退避重试六次。
         */
        this.failure = classifyFailure(msg)
        cb.onEvents([{ k: 'error', ts: Date.now(), message: msg }])
      }
    } finally {
      this.finish(finalStatus)
    }
  }

  /* ------------------------------------------------------------------ */

  /**
   * 一次模型调用:发请求、读流、把碎片拼成完整的一次回答。
   *
   * 失败一律**返回** error 而不是抛 —— 调用方需要在下一次循环里正常收尾
   * (落盘、推 result、唤醒 done),抛出去会让这些全部跳过,
   * 而 done 不 resolve 就等于节点永远卡在 running。
   */
  private async chat(messages: ChatMessage[], tools: ToolDef[]): Promise<ChatOutcome> {
    const { ctx, cb } = this

    const { url, init } = buildChatRequest({
      provider: ctx.provider,
      baseUrl: ctx.baseUrl,
      apiKey: ctx.apiKey,
      model: ctx.model,
      messages,
      tools,
    })

    const ac = new AbortController()
    this.aborter = ac
    const timer = setTimeout(() => {
      this.timedOut = true
      ac.abort()
    }, ctx.timeoutMs)

    /** 已累积的正文。与"待推送缓冲"分开:后者推完就清,前者要留着当本轮结果 */
    let acc = ''
    let pending = ''
    let lastFlush = Date.now()

    const flush = (force: boolean): void => {
      if (!pending) return
      const now = Date.now()
      if (!force && now - lastFlush < TEXT_FLUSH_MS && pending.length < TEXT_FLUSH_CHARS) return
      cb.onEvents([{ k: 'text', ts: now, text: pending }])
      pending = ''
      lastFlush = now
    }

    const calls = new Map<number, { id: string; name: string; args: string }>()

    try {
      const res = await fetch(url, { ...init, signal: ac.signal })

      if (!res.ok) {
        // 把响应体捞出来 —— 各家真正的错因都在 body 里("model not found" 等),
        // 光看状态码只能猜
        let detail = ''
        try {
          detail = (await res.text()).slice(0, 400)
        } catch {
          /* 读不到就算了 */
        }
        // [FULLFLOW-DEBUG] 临时诊断:打印原始 HTTP 状态与响应体(排查 402 来源)
        console.error('[CHAT_HTTP]', res.status, url, detail.slice(0, 200))
        return {
          text: acc,
          toolCalls: [],
          error: httpError(res.status, detail, ctx),
          // 判据是状态码,不是我们自己拼的那句文案(见 classifyHttpStatus 的说明)
          failure: classifyHttpStatus(res.status, detail),
        }
      }

      for await (const chunk of readStream(ctx.provider, res, ac.signal)) {
        this.onChunk(chunk, {
          pushText: (t) => {
            acc += t
            pending += t
            flush(false)
          },
          pushThinking: (t) => {
            // 思考过程不进聚合缓冲:它的量通常很小,而且用户就是想实时看到它
            flush(true)
            cb.onEvents([{ k: 'thinking', ts: Date.now(), text: t }])
          },
          calls,
          onError: (m) => {
            this.sawError = true
            cb.onEvents([{ k: 'error', ts: Date.now(), message: m }])
          },
          onFinish: () => flush(true),
        })
      }
      flush(true)

      this.aborter = null
      clearTimeout(timer)

      if (this.timedOut) {
        return {
          text: acc,
          toolCalls: [],
          error: `请求超时(${Math.round(ctx.timeoutMs / 1000)} 秒)。推理型模型可以把这个值调大,或把任务拆小一点。`,
        }
      }
      if (this.cancelled) return { text: acc, toolCalls: [], error: null }

      const toolCalls: ToolCall[] = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v], i) => ({
          // Gemini 不给调用 id,而我们的 tool_result 必须靠 id 配对 —— 这里补一个。
          // 用 index 而不是随机数:同一轮里稳定,重放时日志更好读
          id: v.id || `call_${i}`,
          name: v.name,
          args: v.args || '{}',
        }))
        // 只拼出了参数没拼出名字的,是流被截断的残骸,丢掉
        .filter((c) => c.name)

      return { text: acc, toolCalls, error: null }
    } catch (e) {
      clearTimeout(timer)
      this.aborter = null

      if (this.cancelled) return { text: acc, toolCalls: [], error: null }
      if (this.timedOut) {
        return {
          text: acc,
          toolCalls: [],
          error: `请求超时(${Math.round(ctx.timeoutMs / 1000)} 秒)。`,
        }
      }
      return { text: acc, toolCalls: [], error: networkError(e, ctx) }
    }
  }

  /** 把一个流式增量喂给各个累积器。抽出来是为了让 chat() 的主线保持可读 */
  private onChunk(
    c: StreamChunk,
    h: {
      pushText(t: string): void
      pushThinking(t: string): void
      calls: Map<number, { id: string; name: string; args: string }>
      onError(m: string): void
      onFinish(): void
    },
  ): void {
    switch (c.k) {
      case 'text':
        h.pushText(c.text)
        break
      case 'reasoning':
        h.pushThinking(c.text)
        break
      case 'tool_delta': {
        const cur = h.calls.get(c.index) ?? { id: '', name: '', args: '' }
        if (c.id) cur.id = c.id
        if (c.name) cur.name = c.name
        // 参数是**分片**来的,必须累加。覆盖的话只会拿到最后一片,JSON 必然残缺
        if (c.args) cur.args += c.args
        h.calls.set(c.index, cur)
        break
      }
      case 'error':
        h.onError(c.message)
        break
      case 'finish':
      case 'usage':
        h.onFinish()
        break
    }
  }

  private finish(status: SessionStatus): void {
    if (this.finished) return
    this.finished = true
    // 与 AgentSession 同理:只有真失败才带归类结果,其余缺省即"可重试"
    const withFailure = this.failure ? { failure: this.failure } : {}
    this.exitInfo = { status, code: null, signal: null, ...withFailure }
    // 与 AgentSession 同序:先让 onExit 跑完(管理器要记 lastExit、清 live),
    // 再唤醒 await done 的调用方
    this.cb.onExit(status, null, null)
    this.resolveDone()
  }
}

/* ---------------- 错误文案 ---------------- */

/**
 * HTTP 错误 → 用户能照着做的话。
 *
 * 与 providers/index.ts 的 adviceFor 刻意分开:那边是"测试连接"场景(用户正盯着
 * 设置页),重点是告诉他去改哪一项;这边是"节点跑起来之后失败了",
 * 用户更关心"我该改配置还是重试"。
 */
function httpError(status: number, detail: string, ctx: ApiCtx): string {
  const tail = detail ? ` · ${detail}` : ''
  if (status === 401 || status === 403) {
    return `鉴权失败(HTTP ${status})${tail}\n检查「${ctx.provider.label}」的 API Key 是否还有效、是否已开通模型 ${ctx.model}。到 设置 → 模型服务 里点一次「测试连接」。`
  }
  if (status === 404) {
    /*
     * ⚠️ 火山方舟特例:它的 404(InvalidEndpointOrModel.NotFound) = 「模型未开通或无权访问」,
     * 不是地址问题(方舟地址本来就不带 /v1)。两种解法都要去方舟控制台:
     *   ① 开通管理里开通该模型 → 基础模型名直连即可;
     *   ② 或创建推理接入点 → 用 ep- / ark- 开头的接入点 id。
     * 必须直接给"下一步动作",而不是模棱两可的"模型名可能不对"。
     */
    if (ctx.provider.id === 'ark') {
      return (
        `接口或模型不存在(HTTP 404)${tail}\n` +
        `火山方舟的 404 表示「该模型未开通或无权访问」。两种解法(都要在方舟控制台操作):` +
        `① 到方舟控制台「开通管理」开通 ${ctx.model} 后,即可用这个基础模型名直连;` +
        `② 或在「在线推理 → 创建推理接入点」建一个,把 ep- 开头的接入点 id 填进模型框。` +
        `接口地址保持 ${ctx.baseUrl} 即可,不需要加 /v1。`
      )
    }
    return `接口或模型不存在(HTTP 404)${tail}\n模型名 "${ctx.model}" 可能不对,或地址应带 /v1。到 设置 → 模型服务 点「拉取模型」看真实列表。`
  }
  if (status === 429) {
    return `触发限流或余额不足(HTTP 429)${tail}`
  }
  return `${ctx.provider.label} 返回 HTTP ${status}${tail}`
}

function networkError(e: unknown, ctx: ApiCtx): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (ctx.provider.group === 'local') {
    return `连不上本机服务:${msg}\n确认它已启动,且 Base URL 的端口对得上。`
  }
  return `请求失败:${msg}\n若服务商在境外,可能需要给系统配代理;公司网络也可能拦了它。`
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}
