import type { NodeEvent, SessionStatus } from '../../shared/events'
import type { NodeMetaSnapshot, PersistedRecord } from '../../shared/log'
import { DEFAULT_LOG_LIMITS, NodeLogWriter, readNodeMeta, writeNodeMeta, type NodeMeta } from './nodeLog'
import { ensureNodeDir } from '../paths'

export interface HubEmit {
  /** 一批已外溢处理的记录。调用方直接广播这一份,不要广播原始事件 */
  log(nodeId: string, canvasId: string, recs: PersistedRecord[]): void
  progress(nodeId: string, ev: NodeEvent & { k: 'progress' }): void
  exit(nodeId: string, status: SessionStatus, code: number | null): void
}

/**
 * 会话日志的中枢:把「写盘」与「广播」绑成一条有序的流水线。
 *
 * ## 为什么必须串行
 *
 * 写盘是异步的,而 manager 的回调是同步的。不做串行化的话,
 * `onExit` 里那次广播会在最后几条事件的 `await` 还没落地时就发出去 ——
 * 渲染进程先收到「本轮结束」,再收到最后几段正文,顺序就错了。
 *
 * 按 nodeId 串成一条链之后,「先入队的先广播」成为结构性保证:
 * manager 在 onExit 里先 `batch.flushNow()`(把剩余事件同步推进队列)
 * 再发 exit,所以 exit 天然排在所有日志之后。
 */
export class NodeLogHub {
  private writers = new Map<string, NodeLogWriter>()
  private canvasOf = new Map<string, string>()
  private chains = new Map<string, Promise<void>>()
  private metas = new Map<string, NodeMeta>()

  constructor(private readonly emit: HubEmit) {}

  private writer(canvasId: string): NodeLogWriter {
    let w = this.writers.get(canvasId)
    if (!w) {
      w = new NodeLogWriter(canvasId, DEFAULT_LOG_LIMITS)
      this.writers.set(canvasId, w)
    }
    return w
  }

  /** 顺序即语义。同一 nodeId 的写入绝不并发 */
  private enqueue(nodeId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(nodeId) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    this.chains.set(nodeId, next)
    // 队尾跑完就清理,否则 Map 会随节点数无界增长
    void next.finally(() => {
      if (this.chains.get(nodeId) === next) this.chains.delete(nodeId)
    })
    return next
  }

  /**
   * 登记 nodeId → canvasId。
   * 没有这层映射就不知道该把日志写进哪个画布 —— 主进程不维护「当前画布」的概念。
   */
  /**
   * 登记一次会话的起点。
   *
   * ⚠️ 每轮都会调用(不是只在首轮),所以**不能无脑写初始值** ——
   * 那样每轮都会把轮数清零、把上一轮的 model/cost 抹掉,
   * 而这些恰恰是重启后要靠它接上上下文的东西。
   * 规则:调用方给的是"本轮的事实",累计值一律沿用内存里已有的。
   */
  register(nodeId: string, canvasId: string, meta: Omit<NodeMeta, 'version' | 'lastSeq' | 'startedAt'>): void {
    this.canvasOf.set(nodeId, canvasId)
    // 目录必须**同步**建好 —— 排进队列的写入跑起来时它得已经存在
    ensureNodeDir(canvasId, nodeId)
    const prev = this.metas.get(nodeId)
    this.writeMeta(nodeId, {
      version: 1,
      nodeId,
      agentId: meta.agentId,
      cwd: meta.cwd,
      sessionId: meta.sessionId ?? prev?.sessionId ?? null,
      isFirstTurn: meta.isFirstTurn,
      status: meta.status,
      turns: prev?.turns ?? 0,
      model: prev?.model ?? null,
      lastCostUsd: prev?.lastCostUsd ?? null,
      lastDurationMs: prev?.lastDurationMs ?? null,
      lastSeq: prev?.lastSeq ?? 0,
      // 新的一轮开始了,上一轮的结束时间不再成立
      endedAt: undefined,
      startedAt: prev?.startedAt ?? Date.now(),
    })
  }

  /**
   * meta 的磁盘写入。
   *
   * ⚠️ 必须也走 enqueue —— 一次会话注册会连发三次 meta 写入
   * (register 的初始值、appendUser 的轮数、absorb 的 sessionId),
   * 如果它们各自 fire-and-forget,`writeJsonAtomic` 的 tmp+rename 落地顺序
   * **不受调用顺序约束**:晚发起的可能先 rename,于是旧快照盖掉新快照,
   * sessionId 被抹掉 → 重启后接不上上下文。串进同一条链就变成严格有序。
   */
  private writeMeta(nodeId: string, patch: Partial<NodeMeta>): void {
    const canvasId = this.canvasOf.get(nodeId)
    const prev = this.metas.get(nodeId)
    if (!canvasId || (!prev && !patch.nodeId)) return
    const next = { ...(prev as NodeMeta), ...patch, nodeId }
    // 内存里立刻生效:后续 touchMeta 的合并要以最新值为基准,不能等落盘
    this.metas.set(nodeId, next)
    void this.enqueue(nodeId, () =>
      // meta 只是索引用,写不进去不该影响会话本身
      writeNodeMeta(canvasId, next).catch(() => {}),
    )
  }

  /** 用户消息。必须在 spawn 之前完成写入与广播,好让它的 seq 小于本轮所有 agent 事件 */
  appendUser(nodeId: string, text: string): Promise<void> {
    const canvasId = this.canvasOf.get(nodeId)
    if (!canvasId) return Promise.resolve()
    const ts = Date.now()
    return this.enqueue(nodeId, async () => {
      const seq = await this.writer(canvasId).appendUser(nodeId, text, ts)
      this.emit.log(nodeId, canvasId, [{ seq, ts, t: 'user', text }])
      /*
       * 轮数由主进程记账,不是渲染进程数气泡数出来的 ——
       * 刷新后渲染进程只加载日志尾部(有上限),数出来的轮数会偏小,
       * 而它又被用来判断"cwd 是否已锁定",偏小就意味着允许改 cwd,进而破坏 --resume。
       */
      this.touchMeta(nodeId, { lastSeq: seq, turns: (this.metas.get(nodeId)?.turns ?? 0) + 1 })
    })
  }

  /** 一批 agent 事件。progress 走单独通道且**不落盘** —— 每轮几十条,写盘没有意义 */
  appendEvents(nodeId: string, events: NodeEvent[]): void {
    const canvasId = this.canvasOf.get(nodeId)
    if (!canvasId) return

    const durable: NodeEvent[] = []
    for (const ev of events) {
      if (ev.k === 'progress') this.emit.progress(nodeId, ev)
      else durable.push(ev)
    }
    if (durable.length === 0) return

    void this.enqueue(nodeId, async () => {
      const { recs } = await this.writer(canvasId).appendEvents(nodeId, durable)
      this.emit.log(nodeId, canvasId, recs)
      this.touchMeta(nodeId, { lastSeq: recs[recs.length - 1]?.seq ?? 0 })
      this.absorb(nodeId, durable)
    })
  }

  /**
   * 权威 sessionId 落盘。
   *
   * 这条路和 `absorb` 里从 init/result 事件顺手捞 id 的那条**并存,不互相取代**:
   *
   * - **这条路是主**:manager 从子进程回传里一提取到 id 就立刻告诉我们,
   *   不依赖日志事件长什么样。发现型 id 的 agent(Codex / Qwen 等)根本不回传
   *   Claude 形状的 `init` 事件 —— 只靠 absorb 的话,它们重启后 `--resume` 全丢,
   *   用户看到的现象就是"记忆没了"。
   * - **absorb 是备份**:进程崩掉时回调可能没赶上,事件里那条还能兜住。
   *
   * 两边写的是同一个字段,来源又都是子进程自己回传的 id,所以后到的直接覆盖即可,
   * 不需要额外的优先级规则。
   */
  setSessionId(nodeId: string, sessionId: string): void {
    if (!sessionId) return
    this.touchMeta(nodeId, { sessionId, isFirstTurn: false })
  }

  /** 应用自己发的提示(降级、截断、重试),用户可见 */
  appendNotice(nodeId: string, level: 'info' | 'warn' | 'error', text: string): void {
    const canvasId = this.canvasOf.get(nodeId)
    if (!canvasId) return
    void this.enqueue(nodeId, async () => {
      const ts = Date.now()
      const seq = await this.writer(canvasId).appendNotice(nodeId, level, text, ts)
      this.emit.log(nodeId, canvasId, [{ seq, ts, t: 'notice', level, text }])
    })
  }

  /** 结尾。排在所有日志之后,顺序由 enqueue 保证 */
  appendExit(nodeId: string, status: SessionStatus, code: number | null): void {
    const canvasId = this.canvasOf.get(nodeId)
    if (!canvasId) {
      this.emit.exit(nodeId, status, code)
      return
    }
    void this.enqueue(nodeId, async () => {
      // 非正常结束留一条记录 —— 否则回看日志时只看到话说到一半就没了
      if (status === 'killed' || status === 'error' || status === 'timeout') {
        const label = { killed: '已取消', error: '异常结束', timeout: '超时结束' }[status]
        const ts = Date.now()
        const seq = await this.writer(canvasId).appendNotice(nodeId, status === 'killed' ? 'warn' : 'error', label, ts)
        this.emit.log(nodeId, canvasId, [{ seq, ts, t: 'notice', level: status === 'killed' ? 'warn' : 'error', text: label }])
      }
      this.touchMeta(nodeId, { status, endedAt: Date.now() })
      this.emit.exit(nodeId, status, code)
    })
  }

  /** 从事件里顺手捞 sessionId / model / cost,省得回头再扫一遍日志 */
  private absorb(nodeId: string, events: NodeEvent[]): void {
    for (const ev of events) {
      if (ev.k === 'init') {
        /*
         * ⚠️ sessionId 必须落到 meta 里,这是**跨重启续接上下文的唯一来源**。
         *
         * 首轮启动时渲染进程还不知道 sessionId(是 claude 建会话时才给的),
         * 不在这里捕获的话,关掉应用再打开就只剩日志、没有 id →
         * 下一句话会开一个全新会话,用户会以为"记忆丢了"。
         */
        this.touchMeta(nodeId, {
          model: ev.model ?? null,
          sessionId: ev.sessionId,
          isFirstTurn: false,
        })
      } else if (ev.k === 'result') {
        this.touchMeta(nodeId, { lastCostUsd: ev.costUsd, lastDurationMs: ev.durationMs })
      }
    }
  }

  /** 增量更新 meta。走 writeMeta,所以同样受那条串行链保护 */
  private touchMeta(nodeId: string, patch: Partial<NodeMeta>): void {
    if (!nodeId) return
    if (!this.metas.has(nodeId)) return
    this.writeMeta(nodeId, patch)
  }

  /**
   * 等这个节点排队中的写入全部落盘。
   *
   * 循环到"队尾不再变化"为止,而不是只 await 一次当前尾:链上的一次 append
   * 会顺手**再排一次 meta 写入**(轮数 / sessionId),那次追加发生在被 await
   * 的那个函数**执行期间** —— 只 await 一次的话,meta 还在飞的时候就返回了,
   * 调用方以为落盘了,其实没有。
   */
  async flush(nodeId: string): Promise<void> {
    for (;;) {
      const cur = this.chains.get(nodeId)
      if (!cur) return
      await cur.catch(() => {})
      if (this.chains.get(nodeId) === cur) return
    }
  }

  readTail(nodeId: string, limit: number): ReturnType<NodeLogWriter['readTail']> | null {
    const canvasId = this.canvasOf.get(nodeId)
    if (!canvasId) return null
    return this.writer(canvasId).readTail(nodeId, limit)
  }

  /**
   * 读回一个节点的历史:日志尾部 + meta。canvasId 由调用方给 ——
   * 刷新渲染进程后主进程的映射表是空的(nodeId 来自磁盘上的画布),不能依赖 register。
   *
   * 顺带把 canvasOf 补上,这样紧接着的 appendUser 知道该往哪个画布写 ——
   * 不然"重启后继续对话"的第一句话会被静默丢弃(appendUser 找不到 canvasId 就直接返回)。
   */
  async readStateOf(
    canvasId: string,
    nodeId: string,
    limit: number,
  ): Promise<{
    recs: PersistedRecord[]
    torn: boolean
    total: number
    meta: NodeMetaSnapshot | null
  }> {
    this.canvasOf.set(nodeId, canvasId)
    const [tail, onDisk] = await Promise.all([
      this.writer(canvasId).readTail(nodeId, limit),
      readNodeMeta(canvasId, nodeId),
    ])

    /*
     * 用磁盘的 meta 给内存补基准(后续 touchMeta 才有东西可合并),
     * 但**内存优先** —— 若这个节点在本进程里跑过,内存那份一定比磁盘新,
     * 拿磁盘覆盖等于把这一轮的轮数/sessionId 回退掉。
     */
    if (onDisk && !this.metas.has(nodeId)) this.metas.set(nodeId, onDisk)
    const meta = this.metas.get(nodeId) ?? onDisk

    if (!meta) return { ...tail, meta: null }
    return {
      ...tail,
      meta: {
        sessionId: meta.sessionId,
        turns: meta.turns,
        /*
         * 磁盘上写着 running 而进程早没了 —— 上次是被强杀/崩掉的。
         * 报成 interrupted 而不是 done:那一轮确实没跑完,说成完成就是在撒谎。
         */
        status: meta.status === 'running' ? 'interrupted' : meta.status,
        model: meta.model,
        lastCostUsd: meta.lastCostUsd,
        lastDurationMs: meta.lastDurationMs,
        lastSeq: meta.lastSeq,
      },
    }
  }

  /**
   * 只要 meta,不读日志。
   *
   * 工作流在每次启动节点前都要问一遍"这个节点现在到哪了"(拿 sessionId 决定
   * --resume 还是首轮,拿 lastSeq 当水位)。走 readStateOf 会顺带把几百条
   * 日志读出来又丢掉 —— 白读一遍磁盘,还白占一次内存。
   */
  async metaOf(
    canvasId: string,
    nodeId: string,
  ): Promise<{ sessionId: string | null; lastSeq: number }> {
    this.canvasOf.set(nodeId, canvasId)
    if (!this.metas.has(nodeId)) {
      // 同样借这次机会把 canvasOf 补上,让随后 appendUser 知道往哪写
      const onDisk = await readNodeMeta(canvasId, nodeId)
      if (onDisk) this.metas.set(nodeId, onDisk)
    }
    const m = this.metas.get(nodeId)
    return { sessionId: m?.sessionId ?? null, lastSeq: m?.lastSeq ?? 0 }
  }

  /** 水位之后的记录。**先 flush** —— 否则刚跑完的那一轮可能还在写盘队列里 */
  async logsAfter(canvasId: string, nodeId: string, watermark: number, limit: number): Promise<PersistedRecord[]> {
    this.canvasOf.set(nodeId, canvasId)
    await this.flush(nodeId)
    return this.writer(canvasId).readAfter(nodeId, watermark, limit)
  }

  readBlob(canvasId: string, hash: string): Promise<string | null> {
    return this.writer(canvasId).readBlob(hash)
  }

  async resetNode(canvasId: string, nodeId: string): Promise<void> {
    this.canvasOf.set(nodeId, canvasId)
    this.metas.delete(nodeId)
    await this.writer(canvasId).resetNode(nodeId)
  }

  async flushAll(): Promise<void> {
    // 逐个走 flush(它自己会追到队尾稳定),而不是快照一次 chains.values()
    await Promise.allSettled([...this.chains.keys()].map((id) => this.flush(id)))
  }
}
