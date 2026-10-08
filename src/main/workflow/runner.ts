import type { StartRequest, StartResult } from '../../shared/ipc'
import type { PersistedRecord } from '../../shared/log'
import {
  extractOutput,
  defaultPromptFor,
  formatBranchManifest,
  renderTemplate,
  validateGraph,
  type MergeBranchInfo,
  type RunNodeState,
  type RunState,
  type WorkflowEvent,
  type WorkflowNodeSpec,
  type WorkflowSpec,
} from '../../shared/workflow'
import { injectOne, buildVars, type SpillContext } from './inputs'
import type { BuiltinActionRequest, BuiltinActionResult } from './builtinAction'
import { plannedCwd } from '../startSession'
import { buildIndex, CycleError, normalizeEdges, ancestors, descendants, type GraphIndex } from './graph'
import { findLatestRunState } from './runLog'
import type { FailureVerdict, SessionOutcome } from '../../shared/failure'

/**
 * 调度器。
 *
 * ## 为什么不是「按层同步屏障」
 *
 * 层只用来做 UI 展示与优先级。真按层跑会在宽图上留一堆空转槽位:
 * 第 0 层有 10 个节点但并发上限是 2,那 8 个只能等着,而第 1 层里
 * 早就绪的节点(它的前驱在第 0 层已经跑完)也不许开始。
 *
 * 所以用**就绪队列 + 全局并发上限**:谁的前驱都好了谁就能上。
 *
 * ## 环境是注入的
 *
 * 这个类不 import 任何 Electron / fs / SessionManager / Packager,全部通过
 * `RunnerEnv` 进来。于是 e2e 里可以用一个假的 env 把三条关键断言(产出传递 /
 * 溢出降级 / 失败传播与重试)加输出节点分流全部跑完,不依赖真实 agent。
 *
 * ## nodes-v2 起:两类执行路径
 *
 * Agent 类节点(project / feature / merge)走会话路径;
 * `executor==='builtin'` 的节点(output / image)是**内置动作节点**,走
 * `runBuiltinAction` 注入进来的独立路径。两条路在 runNode 顶部就分开
 * —— 只认 `spec.executor`,**不认 kind**(见 runBuiltinNode 的注释)。
 */

export interface NodeRunSnapshot {
  sessionId: string | null
  /** 运行前的水位。之后只取 seq 大于它的记录,免得把上一轮的产出当成这一轮的 */
  lastSeq: number
}

export interface RunnerEnv {
  /** 运行前的节点状态(拿 sessionId 决定 --resume 还是首轮,拿水位切本轮记录) */
  stateOf(canvasId: string, nodeId: string): Promise<NodeRunSnapshot>
  logsAfter(canvasId: string, nodeId: string, watermark: number, limit: number): Promise<PersistedRecord[]>
  /** 与界面点「发送」走**完全同一条路径**(登记 → 落盘用户消息 → spawn) */
  startNode(req: StartRequest): Promise<StartResult>
  /**
   * 等这一轮跑完。
   *
   * `outcome.failure` 带着失败归类(见 shared/failure.ts):调度器靠它决定
   * **还要不要退避重试**。缺省 = 可重试,也就是升级前的行为。
   */
  waitFor(nodeId: string): Promise<SessionOutcome>
  cancelNode(nodeId: string): boolean
  notice(nodeId: string, level: 'info' | 'warn' | 'error', text: string): void
  emit(ev: WorkflowEvent): void
  /** 运行态落盘。不落盘的话刷新渲染进程后 RunBar 就丢了 */
  persist(state: RunState): void
  /** 读日志尾部时的上限。够 extractOutput 找到最后一条 result 即可 */
  logTailLimit: number
  /**
   * 内置动作节点(output / image / 未来的 video…)的执行器。
   * 不走会话、不耗 token。由 env.ts 接到内置动作注册表上;
   * e2e 里用假实现,才能测"分流"本身。
   */
  runBuiltinAction(req: BuiltinActionRequest): Promise<BuiltinActionResult>
}

/** 重试之间的退避。第一次等 1s,往后翻倍,封顶 8s */
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 8000

/**
 * 「会话没跑成」这一种失败 —— 带上归类结果,让 catch 能决定还要不要退避。
 *
 * 为什么不直接把 verdict 存在局部变量里、靠外层的 `catch` 读?
 * 因为 `startNode` / `waitFor` / `logsAfter` 都在 try 里,而"失败"要在
 * try 之前就判定一次非 done —— 用异常把控制权交回同一个 catch,
 * 失败处理就只有**一处**,不会出现"非 done 走 A 分支、抛异常走 B 分支"
 * 而两条分支的重试策略悄悄不一致的那种坑。
 *
 * ⚠️ 必须用 `instanceof` 判定,不能用"错误消息里有没有某个关键词":
 * 前者问的是"这是不是会话失败"(一个类型问题),
 * 后者是在拿展示格式当契约 —— 改一句文案就会静默失效。
 */
class SessionFailed extends Error {
  constructor(
    message: string,
    /** 会话归出的失败类别。`undefined` = 没归出类 → 按可重试处理 */
    readonly failure?: FailureVerdict,
  ) {
    super(message)
    this.name = 'SessionFailed'
  }
}

/**
 * 节点被取消(用户点取消 / cancelNode)。与会话失败**分开**:
 * 取消不是错误,不该触发外层 catch 的重试/判死分支 —— 那是失败语义。
 */
class CancelledError extends Error {
  constructor() {
    super('节点已取消')
    this.name = 'CancelledError'
  }
}

/**
 * 路由决策解析(v0.6.1):把 LLM 的一行输出解析成"选中的分支"。
 *
 * 解析顺序(容错):
 *   ① 「分支N / 第N个 / 选项N」(1-based)显式编号;
 *   ② 分支标签(routes[i])直接命中;
 *   ③ 兜底:**激活全部分支**并标 unparsed —— 宁可多跑,不可漏跑
 *      (路由解析失败不该让整条流水线静默失去一条支路)。
 */
export function parseRouterPick(
  text: string,
  routes: readonly string[],
  outgoing: readonly string[],
): { index: number; label: string; activeTargets: string[]; unparsed: boolean } {
  const pick = (i: number) => {
    const idx = Math.max(0, Math.min(i, outgoing.length - 1))
    return {
      index: idx,
      label: routes[idx] ? `分支${idx + 1}(${routes[idx]})` : `分支${idx + 1}`,
      activeTargets: [outgoing[idx]],
      unparsed: false,
    }
  }
  const m = text.match(/分支\s*(\d+)|第\s*(\d+)\s*(?:个|条)|选项\s*(\d+)/)
  if (m) {
    const raw = m[1] ?? m[2] ?? m[3]
    const idx = Number(raw) - 1
    if (idx >= 0 && idx < outgoing.length) return pick(idx)
  }
  for (let i = 0; i < routes.length; i++) {
    if (routes[i] && text.includes(routes[i])) return pick(i)
  }
  return { index: -1, label: '全部(未解析)', activeTargets: [...outgoing], unparsed: true }
}

/**
 * 内置动作失败时节点日志的**中文前缀**(纯文案,不参与调度)。
 *
 * 与 runBuiltinNode 里按 action 收尾分派同处 —— 加一个内置动作(action)时,
 * 若想让它失败日志更可读,在此登记一条即可;漏登记会回落到通用的"执行"。
 * ⚠️ 这只是给用户看的措辞,调度**不**依赖它(分流只认 spec.executor/action)。
 */
const ACTION_FAIL_LABEL: Record<string, string> = { package: '打包', image: '出图', test: '测试', video: '视频分析', chart: '图表渲染', handoff: '交接' }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 单次运行的内部状态。state 是给外面的快照,这里放不该外传的东西 */
interface ActiveRun {
  spec: WorkflowSpec
  index: GraphIndex
  /** 本次真正参与的节点 */
  active: Set<string>
  /** 节点 → 本轮产出(已提取、已注入处理)。给下游当变量用 */
  outputs: Map<string, string>
  /** 节点 → 落盘后的 blob 路径(溢出时才有) */
  spilled: Map<string, string>
  /** router 节点 → 本次激活的出边目标节点列表(其余出边分支自动跳过) */
  routerPick: Map<string, string[]>
  state: RunState
  cancelled: boolean
}

export class WorkflowRunner {
  private runs = new Map<string, ActiveRun>()
  /** v0.6.4 增量执行:上一次成功运行的基线(输入指纹相同 → 复用产出) */
  private lastState: RunState | null = null

  constructor(private readonly env: RunnerEnv) {}

  get(runId: string): RunState | undefined {
    return this.runs.get(runId)?.state
  }

  activeRuns(): RunState[] {
    return [...this.runs.values()].map((r) => r.state)
  }

  /**
   * 跑一个工作流。返回最终状态(**不抛异常** —— 失败体现在 state.status 里)。
   *
   * 只有"图本身有问题"(有环)才会抛,因为那时候没有任何东西可以跑。
   */
  async run(spec: WorkflowSpec): Promise<RunState> {
    const nodeById = new Map(spec.nodes.map((n) => [n.id, n]))
    const edges = normalizeEdges([...nodeById.keys()], spec.edges)

    // v0.6.4 增量执行基线:同画布最近一次成功运行(读失败 = null,退化为全量执行)
    this.lastState = await findLatestRunState(spec.canvasId).catch(() => null)

    /*
     * ① 运行前图校验(V1..V8)。全部 warn(不阻断,M6 决策),逐条进节点日志
     *    —— RunBar 已订阅 nodeLog,提示自然可见,无需新增 IPC 通道。
     *    环检测**不在这里**:它由 buildIndex 抛 CycleError(带环路径,UI 已有
     *    红色高亮),那是"结构性死局",和这些"建议类"提示不是一回事。
     *    无 nodeId 的图级问题(如"画布上没有项目节点")不在这里播 ——
     *    主进程没有可挂靠的节点日志,它们由渲染端 RunBar 的校验列表展示。
     */
    for (const issue of validateGraph({
      nodes: spec.nodes.map((n) => ({ id: n.id, data: n })),
      edges: spec.edges,
      projectDir: spec.projectDir,
    })) {
      if (issue.nodeId && nodeById.has(issue.nodeId)) {
        this.env.notice(issue.nodeId, issue.level, issue.message)
      }
    }

    const index = buildIndex([...nodeById.keys()], edges)

    /*
     * 参与本次运行的节点集合。
     *
     * 「只跑这个节点」= 它 + 它的**祖先** —— 不带上游的话模板里的
     * {{input}} 全是空的,跑出来的东西没有意义。
     * 后代不在集合里:用户点某个节点是想跑它,不是想连带跑掉后面一串。
     */
    const active = new Set<string>()
    if (spec.targets.length === 0) {
      for (const id of nodeById.keys()) active.add(id)
    } else {
      for (const t of spec.targets) {
        if (!nodeById.has(t)) continue
        for (const id of ancestors(index, t)) active.add(id)
      }
    }
    if (active.size === 0) throw new Error('没有可运行的节点')

    const state: RunState = {
      runId: spec.runId,
      canvasId: spec.canvasId,
      status: 'running',
      startedAt: Date.now(),
      nodes: {},
    }
    for (const id of active) {
      state.nodes[id] = { nodeId: id, status: 'queued', attempts: 0 }
    }

    const run: ActiveRun = {
      spec,
      index,
      active,
      outputs: new Map(),
      spilled: new Map(),
      routerPick: new Map(),
      state,
      cancelled: false,
    }
    this.runs.set(spec.runId, run)
    this.publish(run, [...active])

    try {
      await this.schedule(run)
      /*
       * v0.6.4 增量执行:把每个**成功**内置节点的输入指纹写进运行态落盘,
       * 下一次 run 拿它做"输入未变 → 复用产出"判定。失败/取消不写
       * (上一轮失败不该成为复用基线)。
       */
      for (const id of active) {
        const n = state.nodes[id]
        if (n && n.status === 'done' && !n.inputHash) {
          const sp = run.spec.nodes.find((s) => s.id === id)
          if (sp && sp.executor === 'builtin') n.inputHash = this.inputHashOf(run, sp) ?? undefined
        }
      }
      if (run.cancelled) state.status = 'cancelled'
      else state.status = Object.values(state.nodes).some((n) => n.status === 'failed')
        ? 'failed'
        : 'done'
    } catch (e) {
      state.status = 'failed'
      // 调度器自身的异常(不该发生)也要留下痕迹,而不是让 UI 卡在"运行中"
      const anyNode = Object.values(state.nodes)[0]
      if (anyNode) anyNode.error = e instanceof Error ? e.message : String(e)
    } finally {
      state.endedAt = Date.now()
      this.publish(run, [])
      this.env.persist(state)
    }
    return state
  }

  cancel(runId: string): boolean {
    const run = this.runs.get(runId)
    if (!run || run.state.status !== 'running') return false
    run.cancelled = true
    const changed: string[] = []
    for (const [id, n] of Object.entries(run.state.nodes)) {
      if (n.status === 'running') {
        n.status = 'cancelled'
        n.endedAt = Date.now()
        this.env.cancelNode(id)
        changed.push(id)
      } else if (n.status === 'queued' || n.status === 'waiting') {
        n.status = 'cancelled'
        changed.push(id)
      }
    }
    run.state.status = 'cancelled'
    run.state.endedAt = Date.now()
    this.publish(run, changed)
    this.env.persist(run.state)
    return true
  }

  /**
   * 取消整个工作流里的某一个节点 —— 只砍它和它的后代,独立分支继续跑。
   * 这是"其中一路跑歪了,别的还能用"的场景。
   */
  cancelNode(runId: string, nodeId: string): boolean {
    const run = this.runs.get(runId)
    if (!run || run.state.status !== 'running') return false
    const doomed = descendants(run.index, nodeId).filter((id) => run.active.has(id))
    const changed: string[] = []
    for (const id of doomed) {
      const n = run.state.nodes[id]
      if (!n || (n.status !== 'running' && n.status !== 'queued' && n.status !== 'waiting')) continue
      if (n.status === 'running') this.env.cancelNode(id)
      n.status = 'cancelled'
      n.endedAt = Date.now()
      changed.push(id)
    }
    this.publish(run, changed)
    return changed.length > 0
  }

  /** 退出时用。**必须在 manager.killAll() 之前调用**,否则 waitFor 永远等不到 */
  cancelAll(): void {
    for (const id of [...this.runs.keys()]) this.cancel(id)
  }

  /** 丢掉已经结束的运行(内存里的),磁盘上的那份不动 */
  reap(): void {
    for (const [id, r] of this.runs) {
      if (r.state.status !== 'running') this.runs.delete(id)
    }
  }

  // ---------------------------------------------------------------- 调度

  private async schedule(run: ActiveRun): Promise<void> {
    const { state, active } = run
    /** 完成计数。纯诊断用 —— 正确性靠 `wake` 本身,不靠这个数 */
    let completions = 0
    let wake: (() => void) | null = null
    const inflight = new Map<string, Promise<void>>()

    const signal = (): void => {
      completions++
      const w = wake
      wake = null
      w?.()
    }

    for (;;) {
      if (run.cancelled) break

      this.propagateSkips(run)

      // 尽量填满并发槽位
      while (inflight.size < Math.max(1, run.spec.maxParallel)) {
        const next = this.pickReady(run)
        if (!next) break
        const p = this.runNode(run, next)
          .catch((e) => {
            // runNode 自己已经处理了失败;走到这里说明是环境异常
            this.setNode(run, next, {
              status: 'failed',
              error: e instanceof Error ? e.message : String(e),
              endedAt: Date.now(),
            })
          })
          .then(() => {
            inflight.delete(next)
            signal()
          })
        inflight.set(next, p)
      }

      if (inflight.size === 0) break

      /*
       * 填槽位这一段是**完全同步**的(`runNode` 的函数体会同步执行到第一个
       * `await` 才让出),所以没有任何节点能在填槽期间完成 —— 这里不需要
       * "先记下完成次数再等"那套双检。直接等下一次完成信号即可。
       *
       * signal() 里先把 wake 置空再调用,所以同一批里的第二次完成不会重复
       * 触发同一个 resolve;它只是让计数多走一格,而下一次循环会把该起的
       * 节点照常起起来 —— 计数只用于诊断,不参与正确性。
       */
      await new Promise<void>((r) => {
        wake = r
      })
      void active
      void completions
    }

    await Promise.allSettled([...inflight.values()])
  }

  /** 前驱里只要有一个"注定跑不出结果",后继就不该开始 —— 直接标 skipped 并继续传播 */
  private propagateSkips(run: ActiveRun): void {
    let changed = true
    while (changed) {
      changed = false
      for (const id of run.active) {
        const n = run.state.nodes[id]
        /*
         * ⚠️ waiting 也要看。
         *
         * 上一轮把它标成 waiting 之后,如果这一轮它某个前驱失败了,
         * 只看 queued 的话它就再也进不了这个循环 —— 永远停在"等待中",
         * 而实际上它该变成 skipped。这类节点会一直挂着,直到用户取消整次运行。
         */
        if (!n || (n.status !== 'queued' && n.status !== 'waiting')) continue
        const preds = (run.index.preds.get(id) ?? []).filter((p) => run.active.has(p))
        const blocked = preds.some((p) => {
          const pn = run.state.nodes[p]
          if (!pn) return true
          if (pn.status === 'failed') {
            // 'continue' 视为"产出为空",不阻断;'skip'/'stop' 才阻断
            const policy = run.spec.nodes.find((s) => s.id === p)?.failurePolicy ?? 'skip'
            return policy !== 'continue'
          }
          // router 已选出分支:不在激活分支里的节点注定跑不出结果 → 跳过
          if (pn.status === 'done' && this.routerExcludes(run, p, id)) return true
          return pn.status === 'skipped' || pn.status === 'cancelled'
        })
        if (blocked) {
          n.status = 'skipped'
          changed = true
          this.publish(run, [id])
        } else if (preds.some((p) => run.state.nodes[p]?.status !== 'done')) {
          // 有前驱还没好 —— 标成 waiting 只是为了 UI 能说清"在等谁"
          if (n.status !== 'waiting') {
            n.status = 'waiting'
            this.publish(run, [id])
          }
        }
      }
    }
  }

  private ready(run: ActiveRun, id: string): boolean {
    const n = run.state.nodes[id]
    // waiting 是 queued 的一个"显示态",两者都可被拾取
    if (!n || (n.status !== 'queued' && n.status !== 'waiting')) return false
    const preds = (run.index.preds.get(id) ?? []).filter((p) => run.active.has(p))
    return preds.every((p) => {
      const pn = run.state.nodes[p]
      if (!pn) return true
      if (pn.status === 'failed') {
        const policy = run.spec.nodes.find((s) => s.id === p)?.failurePolicy ?? 'skip'
        return policy === 'continue'
      }
      // router 未选中的分支:永远不 ready(propagateSkips 会标 skipped)
      if (pn.status === 'done' && this.routerExcludes(run, p, id)) return false
      return pn.status === 'done'
    })
  }

  /** 就绪队列按"最长路径深度"升序取,让靠近源头的先跑 —— 下游能更早拿到输入 */
  private pickReady(run: ActiveRun): string | null {
    let best: string | null = null
    let bestDepth = Number.POSITIVE_INFINITY
    for (const id of run.active) {
      if (!this.ready(run, id)) continue
      const d = run.index.depth.get(id) ?? 0
      if (d < bestDepth) {
        bestDepth = d
        best = id
      }
    }
    return best
  }

  // ---------------------------------------------------------------- 单节点

  private async runNode(run: ActiveRun, nodeId: string): Promise<void> {
    const spec = run.spec.nodes.find((s) => s.id === nodeId)
    if (!spec) {
      this.setNode(run, nodeId, { status: 'skipped', error: '节点不在本次运行的规格里' })
      return
    }

    /*
     * ⚠️ 这里**只认 executor,不认 kind**(去散点的核心,PRD §2.4 目标 A)。
     *
     * 内置动作节点(output / image / 未来的 video…)统一走 runBuiltinNode;
     * 会话节点走下面的既有 agent 路径。加一个新内置节点 = 注册表加一条声明,
     * 本函数一行不改 —— 所以这里**不再出现任何 kind 字面量**。
     *
     * 用 if 打补丁到会话路径里是行不通的:下面的 stateOf / composePrompt /
     * startNode / waitFor / logsAfter 全都会把"没有会话"当成异常或空转
     * (waitFor 永远等不到一个不存在的进程,互斥锁也占着不放)。
     * 所以这里最顶上一层就分开,会话路径对内置动作节点一无所知。
     */
    if (spec.executor === 'builtin') return this.runBuiltinNode(run, spec)

    const attempts = Math.max(1, Math.min(6, spec.retry + 1))
    const spill: SpillContext = {
      canvasId: run.spec.canvasId,
      inlineLimitBytes: run.spec.inlineLimitBytes,
      policy: run.spec.spillPolicy,
    }

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (run.cancelled) {
        this.setNode(run, nodeId, { status: 'cancelled', endedAt: Date.now() })
        return
      }

      this.setNode(run, nodeId, { status: 'running', attempts: attempt, startedAt: Date.now() })

      const before = await this.env.stateOf(run.spec.canvasId, nodeId)
      const prompt = await this.composePrompt(run, spec, spill, nodeId)

      try {
        /*
         * v0.6.1 工程化 agent 编排:
         *   - agent:同一角色多轮循环(首轮 = 正常会话,后续轮续聊上轮产出,
         *     直到输出含 doneHint 或轮次到顶),复用同一套会话失败/重试语义;
         *   - router:一轮会话 + LLM 分支决策,选中一条出边激活,其余由调度跳过。
         * 两者都走 runSessionOnce,异常(含取消)冒泡到下面的统一 catch。
         */
        if (spec.kind === 'agent') {
          await this.runAgentNode(run, spec, before, prompt, spill)
          return
        }
        if (spec.kind === 'router') {
          await this.runRouterNode(run, spec, before, prompt, spill)
          return
        }

        const res = await this.runSessionOnce(run, spec, before, prompt, spill)
        const injected = await injectOne(spill, res.text)
        if (injected.spilled && injected.file) run.spilled.set(nodeId, injected.file)
        run.outputs.set(nodeId, injected.text)

        this.setNode(run, nodeId, {
          status: 'done',
          endedAt: Date.now(),
          outputChars: res.text.length,
          // 悬停探针(边数据预览)用的开头 600 字;全文在节点日志里,不进运行态
          outputPreview: res.text.slice(0, 600),
        })
        return
      } catch (e) {
        if (e instanceof CancelledError) {
          this.setNode(run, nodeId, { status: 'cancelled', endedAt: Date.now() })
          return
        }
        const msg = e instanceof Error ? e.message : String(e)
        const failure = e instanceof SessionFailed ? e.failure : undefined

        /*
         * ① 明确不可重试 → **当场判死,不再退避**。
         *
         * 余额不足 / 鉴权失败 / 模型名写错这类错误,重试第 6 次的结果和第 1 次
         * 一模一样,而中间要白等 1+2+4+8+8 ≈ 23 秒。用户盯着进度条,既不知道
         * 发生了什么,也没有任何办法在中途补救。
         *
         * 判据取自 shared/failure.ts,**只用 `=== false`**:`undefined`(没归出类)
         * 与 `true` 都按可重试处理,那正是升级前的行为。宁可多重试几次,
         * 也不要把一次网络抖动判成永久失败。
         */
        if (failure && failure.retryable === false) {
          this.env.notice(nodeId, 'error', failure.hint)
          /*
           * 原始错误**照样进节点日志**,只是不进 `error` 字段。
           *
           * `error` 是给用户看的(会显示在 RunBar 与数据探针上),
           * 里面那些 `API Error: 402 … (request_id: req_xxx)` 用户读不懂、
           * 也不该由他去拿 request_id 找人;而排查时又恰恰只有原文有用。
           * 所以两处分开:人话在 error,原文在日志。
           */
          this.env.notice(nodeId, 'warn', `原始错误:${failure.raw}`)
          this.setNode(run, nodeId, {
            status: 'failed',
            endedAt: Date.now(),
            error: failure.hint,
            errorKind: failure.kind,
            /** 明确告诉 UI"重试没用" —— 它可以据此显示"改配置"而不是"再试一次" */
            errorRetryable: false,
          })
          return
        }

        if (attempt < attempts) {
          // 走到这里说明 waitFor 已经返回过 —— 进程确实退了,直接退避重试是安全的
          const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1))
          this.env.notice(nodeId, 'warn', `第 ${attempt} 次失败(${msg}),${delay}ms 后重试`)
          await sleep(delay)
          continue
        }
        this.env.notice(nodeId, 'error', `运行失败:${msg}`)
        this.setNode(run, nodeId, { status: 'failed', endedAt: Date.now(), error: msg })
        return
      }
    }
  }

  /**
   * 会话路径的**单轮执行**:登记 → 等会话 → 取产出 → 返回文本与水位。
   *
   * agent 循环 / router 与普通会话节点共用它 —— 三类节点都"发一轮会话拿一轮产出",
   * 只是调度节奏不同。失败与取消一律抛异常,交给 runNode 的统一 catch。
   */
  private async runSessionOnce(
    run: ActiveRun,
    spec: WorkflowNodeSpec,
    before: NodeRunSnapshot,
    prompt: string,
    _spill: SpillContext,
  ): Promise<{ text: string; truncated: boolean; nextSeq: number }> {
    await this.env.startNode({
      nodeId: spec.id,
      canvasId: run.spec.canvasId,
      agentId: spec.agentId,
      model: spec.model,
      cwd: spec.cwd,
      // 续用该节点已有的会话 —— 工作流跑的是"这个节点的助手",不是每次全新的
      sessionId: before.sessionId ?? undefined,
      prompt,
      permissionMode: spec.permissionMode,
    })

    const outcome = await this.env.waitFor(spec.id)

    if (run.cancelled) throw new CancelledError()
    if (outcome.status !== 'done') {
      throw new SessionFailed(
        `会话以 ${outcome.status} 结束${outcome.code != null ? `(code ${outcome.code})` : ''}`,
        outcome.failure,
      )
    }

    const recs = await this.env.logsAfter(run.spec.canvasId, spec.id, before.lastSeq, this.env.logTailLimit)
    const { text, truncated } = extractOutput(recs)
    if (truncated) {
      this.env.notice(spec.id, 'warn', '产出超过 4MB,已截断后交给下游')
    }
    // 下一轮从本轮最后一条记录之后开始读,才不会把上一轮产出再算一遍
    return { text, truncated, nextSeq: recs.length > 0 ? recs[recs.length - 1].seq : before.lastSeq }
  }

  /**
   * agent 节点(v0.6.1):同一角色**多轮循环**直到完成。
   *
   * 首轮 = 正常会话(composePrompt 产物);后续轮把上轮产出续聊,
   * 输出含 doneHint(默认「任务完成」)即提前收尾,否则跑满 maxRounds(1..8)。
   * 每轮独立取日志水位,轮次信息进节点日志 —— 用户看得见"卡在第几轮"。
   */
  private async runAgentNode(
    run: ActiveRun,
    spec: WorkflowNodeSpec,
    before: NodeRunSnapshot,
    composed: string,
    spill: SpillContext,
  ): Promise<void> {
    const nodeId = spec.id
    const maxRounds = Math.max(1, Math.min(8, Math.trunc(spec.maxRounds ?? 3)))
    const doneHint = (spec.doneHint ?? '任务完成').trim() || '任务完成'
    let watermark = before.lastSeq
    let lastText = ''
    let lastTruncated = false

    for (let round = 1; round <= maxRounds; round++) {
      if (run.cancelled) throw new CancelledError()
      const prompt =
        round === 1
          ? composed
          : [
              `【第 ${round}/${maxRounds} 轮迭代】你上一轮的结果如下:`,
              lastText,
              '',
              `请基于它继续推进任务。当你认为任务已经完成时,在回复末尾单独输出一行,内容只包含「${doneHint}」。`,
            ].join('\n')
      const res = await this.runSessionOnce(run, spec, { sessionId: before.sessionId, lastSeq: watermark }, prompt, spill)
      watermark = res.nextSeq
      lastText = res.text
      lastTruncated = res.truncated
      this.env.notice(nodeId, 'info', `智能体第 ${round}/${maxRounds} 轮完成(产出 ${lastText.length} 字)`)
      if (lastText.includes(doneHint)) {
        this.env.notice(nodeId, 'info', `检测到完成标志「${doneHint}」,提前收尾`)
        break
      }
    }

    const injected = await injectOne(spill, lastText)
    if (injected.spilled && injected.file) run.spilled.set(nodeId, injected.file)
    run.outputs.set(nodeId, injected.text)

    this.setNode(run, nodeId, {
      status: 'done',
      endedAt: Date.now(),
      outputChars: lastText.length,
      outputPreview: lastText.slice(0, 600),
    })
    void lastTruncated
  }

  /**
   * v0.6.4 增量执行:算一个内置节点的**输入指纹**。
   *
   * 指纹 = 上游产出摘要 + 本节点配置(动作 + 相关参数)。配置变了 / 上游产出
   * 变了,指纹就变,下次运行真实执行;都没变则复用上次产出(零成本)。
   * 只对 builtin 节点有意义(会话节点每次都要真实对话,不参与增量)。
   */
  private inputHashOf(run: ActiveRun, spec: WorkflowNodeSpec): string | null {
    if (spec.executor !== 'builtin') return null
    const ups = run.spec.edges
      .filter((e) => e.target === spec.id)
      .map((e) => {
        const out = run.outputs.get(e.source)
        return `${e.source}:${out !== undefined ? String(out).slice(0, 2000) : ''}`
      })
      .sort()
      .join('\n')
    const cfg = JSON.stringify({
      action: spec.action,
      buildTarget: spec.buildTarget,
      buildOptions: spec.buildOptions,
      imageParams: spec.imageParams,
      imageProvider: spec.imageProvider,
      videoParams: spec.videoParams,
      chartParams: spec.chartParams,
      promptText: spec.promptText,
      negativeText: spec.negativeText,
      testCommand: spec.testCommand,
      testTimeoutSec: spec.testTimeoutSec,
      handoffNote: spec.handoffNote,
    })
    const raw = `${ups}\n${cfg}`
    let h = 0
    for (let i = 0; i < raw.length; i++) {
      h = (h * 31 + raw.charCodeAt(i)) | 0
    }
    return String(h)
  }

  /**
   * router 节点(v0.6.1):LLM 看完上游成果后**选一条出边分支**激活。
   *
   * 一轮会话 → parseRouterPick 解析(编号/标签/兜底全激活)→ 记录到
   * run.routerPick;调度器的 propagateSkips 据此把未选分支标 skipped。
   * 节点产出 = 一句"选中了哪条"摘要(下游可引用,但通常只是给人看的)。
   */
  private async runRouterNode(
    run: ActiveRun,
    spec: WorkflowNodeSpec,
    before: NodeRunSnapshot,
    composed: string,
    spill: SpillContext,
  ): Promise<void> {
    const nodeId = spec.id
    const outgoing = run.spec.edges.filter((e) => e.source === nodeId).map((e) => e.target)
    const routes = Array.isArray(spec.routes) ? spec.routes : []
    const branchList = outgoing
      .map(
        (t, i) =>
          `分支${i + 1}${routes[i] ? `(${routes[i]})` : ''}:→ ${run.spec.nodes.find((n) => n.id === t)?.title ?? t}`,
      )
      .join('\n')
    // 模板里写了 {{routes}} 就替换;没写(默认模板)就在末尾补分支清单
    const prompt = composed.includes('{{routes}}')
      ? composed.replace(/\{\{routes\}\}/g, branchList)
      : `${composed}\n\n可选的输出分支:\n${branchList}`

    const res = await this.runSessionOnce(run, spec, before, prompt, spill)
    const pick = parseRouterPick(res.text, routes, outgoing)
    run.routerPick.set(nodeId, pick.activeTargets)

    const summary = `选中:${pick.label};激活下游:${pick.activeTargets
      .map((t) => run.spec.nodes.find((n) => n.id === t)?.title ?? t)
      .join('、') || '(无)'}`
    run.outputs.set(nodeId, summary)

    if (pick.unparsed) {
      this.env.notice(nodeId, 'warn', `路由输出无法解析(${res.text.slice(0, 80)}),已激活全部分支`)
    }
    this.env.notice(nodeId, 'info', summary)
    this.setNode(run, nodeId, {
      status: 'done',
      endedAt: Date.now(),
      outputChars: summary.length,
      outputPreview: summary,
    })
  }

  /** router 已完成且本节点不在其激活分支 → 真。调度用它把未选分支跳过 */
  private routerExcludes(run: ActiveRun, routerId: string, nodeId: string): boolean {
    const rs = run.spec.nodes.find((s) => s.id === routerId)
    if (rs?.kind !== 'router') return false
    const pick = run.routerPick.get(routerId)
    if (!pick) return false
    return !pick.includes(nodeId)
  }

  /**
   * 内置动作节点:不走会话、不耗 token、不产生对话记录,不套用失败策略/重试。
   *
   * ⚠️ 不套用 Agent 的失败策略/重试语义 —— 那是 Agent 专属(PRD §5.3)。
   * 打包/出图失败直接 failed 并给出可读原因;用户看到原因后自己决定重跑,
   * "自动重试一次几十秒的打包/出图"大概率是把同一个错误再犯一遍。
   *
   * 状态仍复用 RunNodeStatus:queued → running → done | failed(取消 = cancelled),
   * 这样 RunBar / RunNodeChip / tally 不用为内置节点写第二个分支。
   *
   * **两类产出的收尾在这里按 action 分派(仅收尾,不碰调度)**:
   *   - package:产物路径 + 日志尾部进 outputs;
   *   - image:阶段一展开画面描述 → 相对路径列表进 outputs 与 RunNodeState.artifacts。
   */
  private async runBuiltinNode(run: ActiveRun, spec: WorkflowNodeSpec): Promise<void> {
    this.setNode(run, spec.id, { status: 'running', attempts: 1, startedAt: Date.now() })
    // 失败文案前缀(打包/出图…),仅用于日志可读性;未登记回落"执行"(语义不变)
    const failLabel = ACTION_FAIL_LABEL[spec.action ?? ''] ?? '执行'

    /*
     * v0.6.4 增量执行:输入未变且上次成功 → 复用上次产出,不真实执行。
     * 只对**内置动作节点**(不耗 token 的重操作:打包/出图/测试/图表/python…);
     * 会话节点(agent)每次都要真实对话,不参与。
     */
    const inputHash = this.inputHashOf(run, spec)
    const prev = this.lastState?.nodes[spec.id]
    if (inputHash && prev && prev.status === 'done' && prev.inputHash === inputHash) {
      run.outputs.set(spec.id, prev.outputPreview ?? '')
      if (Array.isArray(prev.artifacts)) {
        for (const a of prev.artifacts) this.env.notice(spec.id, 'info', `[增量复用] ${a}`)
      }
      this.env.notice(spec.id, 'info', '输入未变,复用上次产出(增量执行)')
      this.setNode(run, spec.id, {
        status: 'done',
        endedAt: Date.now(),
        inputHash,
        reused: true,
        outputChars: prev.outputChars,
        outputPreview: prev.outputPreview,
        artifacts: prev.artifacts,
      })
      return
    }

    try {
      // 图像节点 / 采样出图 / 图表:先做**阶段一**占位符展开(调度侧才拿得到上游产出与依赖关系)
      let prompt: string | undefined
      if (spec.action === 'image' || spec.action === 'sampler' || spec.action === 'chart') {
        prompt = await this.expandImagePrompt(run, spec, spec.id)
      }

      const res = await this.env.runBuiltinAction({
        canvasId: run.spec.canvasId,
        nodeId: spec.id,
        action: spec.action ?? '',
        // 已由 specFromGraph 解析到项目文件夹(单一解析点),这里不做第二次解析
        projectDir: spec.cwd,
        buildTarget: spec.buildTarget,
        buildOptions: spec.buildOptions,
        nodeTitle: spec.title,
        prompt,
        imageParams: spec.imageParams,
        imageProvider: spec.imageProvider,
        videoParams: spec.videoParams,
        handoffNote: spec.handoffNote,
        chartParams: spec.chartParams,
        promptText: spec.promptText,
        negativeText: spec.negativeText,
        testCommand: spec.testCommand,
        testTimeoutSec: spec.testTimeoutSec,
        pythonParams: spec.pythonParams,
        // 打包/出图/视频分析/测试日志一行行冒泡到节点日志(RunBar 已订阅)
        onProgress: (line) => this.env.notice(spec.id, 'info', line),
      })
      if (run.cancelled) {
        this.setNode(run, spec.id, { status: 'cancelled', endedAt: Date.now() })
        return
      }
      if (!res.ok) {
        /*
         * ⚠️ 测试节点即使"没过"也有产出 —— 失败用例与堆栈正是下游最需要看的材料。
         *
         * 这里是本次改造最容易写错的一处:内置动作失败通常没有产出可言
         * (打包失败就是没有 exe),照搬那个习惯会让测试节点的失败产出变成空 ——
         * 于是下游拿到的是"上游失败了"而**看不到为什么失败**,只能重跑一遍。
         * 所以测试的产出在成败两条路上都要落。
         */
        if (spec.action === 'test') run.outputs.set(spec.id, formatTestOutput(res))
        this.env.notice(spec.id, 'error', `${failLabel}失败:${res.error ?? '未知原因'}`)
        this.setNode(run, spec.id, {
          status: 'failed',
          endedAt: Date.now(),
          error: res.error ?? `${failLabel}失败`,
          // 测试"没过"也有产出:失败用例正是探针/下游要看的东西
          outputPreview: spec.action === 'test' ? formatTestOutput(res).slice(0, 600) : undefined,
        })
        return
      }
      if (spec.action === 'image' || spec.action === 'sampler') {
        // 产出的**相对路径列表**注入下游({{prev}} / {{node:<id>}} 都取得到)
        const rels = res.artifacts ?? []
        run.outputs.set(spec.id, formatImageOutput(rels))
        this.setNode(run, spec.id, {
          status: 'done',
          endedAt: Date.now(),
          artifacts: rels,
          outputChars: rels.length,
          outputPreview: formatImageOutput(rels).slice(0, 600),
        })
      } else if (spec.action === 'test') {
        /*
         * 测试节点的产出**必须进 outputs** —— 它和 output(终点、无下游)不同:
         * 它是链上的中间节点,"测试过了没、不过是什么"正是下游(整合 / 输出 /
         * 人自己)要看的材料。
         */
        const testOut = formatTestOutput(res)
        run.outputs.set(spec.id, testOut)
        this.setNode(run, spec.id, {
          status: 'done',
          endedAt: Date.now(),
          outputChars: res.log.length,
          outputPreview: testOut.slice(0, 600),
        })
      } else if (spec.action === 'video') {
        /*
         * 视频理解的产出 = 文字理解(不是文件列表):必须进 outputs,
         * 下游 {{prev}} / {{node:<id>}} 取到的就是"视频讲了什么"。
         * 理解文档本身也落盘(artifacts 相对路径),供查看/复用。
         */
        const videoOut = res.handoffText ?? `[视频分析完成] ${res.log.slice(-2000)}`
        run.outputs.set(spec.id, videoOut)
        this.setNode(run, spec.id, {
          status: 'done',
          endedAt: Date.now(),
          artifacts: res.artifacts ?? [],
          outputChars: videoOut.length,
          outputPreview: videoOut.slice(0, 600),
        })
      } else if (
        spec.action === 'handoff' ||
        spec.action === 'image-output' ||
        spec.action === 'noop' ||
        spec.action === 'chart' ||
        spec.action === 'python'
      ) {
        /*
         * 交接节点的产出 = 素材清单文本(不是文件列表):必须进 outputs,
         * 下游 {{prev}} / {{node:<id>}} 取到的就是"有哪些素材、在哪、干什么用",
         * AI 制作/打包时按相对路径直接引用这些图片。
         * 图表节点同款:产出 = 相对路径 + 说明文本,下游可引用该 SVG。
         * Python 节点同款(v0.6.4):产出 = stdout 文本,下游直接消费。
         */
        const handoffOut = res.handoffText ?? `[交接完成] ${res.log.slice(-2000)}`
        run.outputs.set(spec.id, handoffOut)
        this.setNode(run, spec.id, {
          status: 'done',
          endedAt: Date.now(),
          outputChars: handoffOut.length,
          outputPreview: handoffOut.slice(0, 600),
        })
      } else {
        /*
         * 产物路径 + 日志尾部进产出,供 UI 展示。
         * 下游无消费 —— 输出节点是终点(没有 source 端口),但 outputs 里
         * 留一份让"产物路径"能被展示/复制,与 agent 节点的展示路径共用。
         */
        const pkgOut = `[打包产物] ${res.artifactPath ?? '(未识别)'}\n\n${res.log.slice(-2_000)}`
        run.outputs.set(spec.id, pkgOut)
        this.setNode(run, spec.id, {
          status: 'done',
          endedAt: Date.now(),
          outputChars: res.log.length,
          outputPreview: pkgOut.slice(0, 600),
        })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.env.notice(spec.id, 'error', `${failLabel}异常:${msg}`)
      this.setNode(run, spec.id, { status: 'failed', endedAt: Date.now(), error: msg })
    }
  }

  /**
   * 图像节点的**阶段一**占位符展开(在主进程调度侧做)。
   *
   * 展开 {{prev}} / {{input}} / {{node:<id>}} / {{title:<id>}} —— 这些是"图上下文变量",
   * 只有调度器(runner)拿得到上游产出与依赖关系;渲染端拿不到(主进程无画布状态,
   * 渲染端只有画布,没有"这一轮各节点产出了什么")。
   *
   * 复用与 composePrompt 同一套 buildVars + renderTemplate,但**不加** withPipelineHeader
   * —— 图像节点不需要"你是流水线的一环"这类 LLM 语境措辞。
   * 未知变量照旧原样保留 + notice warn(与 agent 节点一致)。
   *
   * ⚠️ 阶段二({{env:}} + provider 占位符)在**主进程执行器 imagegen** 里做,
   * 不在这里 —— 因为 {{env:}} 只能在主进程展开(密钥不进前端),而这里只是调度侧。
   */
  private async expandImagePrompt(run: ActiveRun, spec: WorkflowNodeSpec, nodeId: string): Promise<string> {
    const nodeById = new Map(run.spec.nodes.map((n) => [n.id, n]))
    const preds = (run.index.preds.get(nodeId) ?? []).filter((p) => run.active.has(p))
    const vars = buildVars({
      spec,
      nodeById,
      preds,
      injected: run.outputs,
      userInput: run.spec.input,
      projectDir: spec.cwd || run.spec.projectDir,
    })
    const rendered = renderTemplate(spec.promptTemplate ?? '', vars)
    if (rendered.unknown.length > 0) {
      this.env.notice(
        nodeId,
        'warn',
        `画面描述里有取不到值的变量(原样保留了):${rendered.unknown.map((u) => `{{${u}}}`).join(' ')}`,
      )
    }
    return rendered.text
  }

  private async composePrompt(
    run: ActiveRun,
    spec: WorkflowNodeSpec,
    spill: SpillContext,
    nodeId: string,
  ): Promise<string> {
    const nodeById = new Map(run.spec.nodes.map((n) => [n.id, n]))
    const rawPreds = (run.index.preds.get(nodeId) ?? []).filter((p) => run.active.has(p))

    /*
     * 并行支路:**跳过上游 feature 节点的自动注入**(待明确事项 M2)。
     *
     * 判定依据严格遵循 PRD §2:"边指向的那个节点的 mode" —— "不注入"是
     * **目标节点**的性质,不是边的性质。project / merge 前驱的产出仍然注入
     * (它们代表"项目当前状态",不是"别的功能")。
     * 显式 {{node:<featureId>}} 仍然放行(M2):用户主动写就是 opt-in,
     * 变量表里放的是全量祖先的产出,这里只过滤自动注入的 preds 列表。
     */
    const injectPreds =
      spec.kind === 'feature' && spec.mode === 'parallel'
        ? rawPreds.filter((p) => nodeById.get(p)?.kind !== 'feature')
        : rawPreds

    /*
     * 变量表里放**所有已完成祖先**的产出,不只是直接前驱 ——
     * {{node:<id>}} 的用处就是跳过中间节点直接引用更远的产出。
     * {{prev}} / {{input}} 仍然只看直接前驱(buildVars 里区分)。
     */
    const vars = buildVars({
      spec,
      nodeById,
      preds: injectPreds,
      injected: run.outputs,
      userInput: run.spec.input,
      // 整合节点默认模板的 {{projectDir}} 用;spec.projectDir 是画布级兜底值
      projectDir: spec.cwd || run.spec.projectDir,
    })

    /*
     * 提交前把上游产出再统一过一遍 spill。
     *
     * buildVars 里的值已经是 spill 过的了,但它对 {{node:<id>}} 这类
     * "跳过中间节点"的引用也生效 —— 所以这里只需要处理**没经过 spill** 的部分:
     * 用户手填的 input 也可能很大(比如他自己贴了一份日志)。
     */
    if (vars.input.length > spill.inlineLimitBytes) {
      const injected = await injectOne(spill, vars.input)
      vars.input = injected.text
    }

    /*
     * 整合节点专属:把「每条上游支路是什么性质」变成一段判据。
     *
     * 只有这里算得出来 —— 角色要看前驱节点自己的 kind/mode,而「谁已经把谁
     * 叠加了」要看**拓扑**(某个前驱是不是另一个前驱的祖先)。`{{prev}}` 那边
     * 拿到的只是一段段文字,从文字里读不出这些,于是整合节点只能靠猜:
     * 要么把串行链重复落实一遍,要么把并行支路被覆盖的改动当成"已经做好了"。
     *
     * 变量名用 `branches` 而不是 `prev2`:它不是"更多材料",是**判据**
     * (哪些改动已经在项目里、哪些要收敛)。用户自定义模板时不写它就退回旧行为。
     */
    if (spec.kind === 'merge') vars.branches = formatBranchManifest(this.mergeBranches(run, injectPreds))

    /*
     * 模板为空时的兜底:按 kind 取一份默认指令(merge / review / doc 各有各的,
     * 其余回落 `{{input}}` = 把上游产出直接当提示词)。
     *
     * ⚠️ 这里**不写 kind 字面量**:登记表在 `shared/workflow.defaultPromptFor`,
     * 因为 merge / review / doc 的默认指令是"这类节点存在的意义"的一部分,
     * 和它们的徽标、校验放在同一个知识域里;runner 只问"这个 kind 的默认是什么",
     * 不参与决定它是什么(去散点)。
     */
    const tpl = spec.promptTemplate.trim() === '' ? defaultPromptFor(spec.kind) : spec.promptTemplate
    const rendered = renderTemplate(tpl, vars)
    if (rendered.unknown.length > 0) {
      this.env.notice(
        nodeId,
        'warn',
        `prompt 模板里有取不到值的变量(原样保留了):${rendered.unknown.map((u) => `{{${u}}}`).join(' ')}`,
      )
    }

    return this.withPipelineHeader(rendered.text, spec, run, injectPreds)
  }

  /**
   * 整合节点的上游支路清单。**只有调度器算得出来**,所以放在这里;
   * shared 的 `formatBranchManifest` 只负责渲染成文字(纯函数、e2e 直接断言)。
   *
   * ## 两个判据
   *
   * ① **角色**:前驱自己的 kind/mode。串行支路的改动已经在项目里,并行支路
   *    的改动可能已被别的支路覆盖 —— 处理方式相反,不能混为一谈。
   * ② **包含关系**:前驱里若 a 是 b 的祖先,则 a 的成果早已叠进 b 的现状
   *    (串行是"看着上游做"的语义)。标出来让整合节点**不要重复落实**。
   *    注意这里必须用祖先关系而不是"a 的深度更小"—— 两条互不相干的支路
   *    深度可能相同也可能不同,那种情况谁都不包含谁。
   */
  private mergeBranches(run: ActiveRun, preds: string[]): MergeBranchInfo[] {
    const nodeById = new Map(run.spec.nodes.map((n) => [n.id, n]))
    return preds.map((id) => {
      const s = nodeById.get(id)
      const role: MergeBranchInfo['role'] =
        s?.kind === 'project'
          ? 'project'
          : s?.kind === 'merge'
            ? 'merge'
            : s?.kind === 'feature' && s.mode === 'parallel'
              ? 'parallel'
              : 'serial'

      const subsumedBy = preds.find(
        (other) => other !== id && ancestors(run.index, other).includes(id),
      )
      return {
        id,
        title: s?.title ?? id,
        role,
        subsumedByTitle: subsumedBy ? (nodeById.get(subsumedBy)?.title ?? subsumedBy) : undefined,
      }
    })
  }

  /**
   * 给流水线里的下游节点加一段「你在哪、上游是谁、项目在哪」的开场白。
   *
   * 上游的产出本身早就传过去了(模板为空时用的就是 `{{input}}`),但**只有产出**:
   * 下游不知道自己在一条流水线里,也不知道上游可能已经在项目目录里动了文件。
   * 于是它只会把上游那段文字当成全部事实,而不是"去看看现在项目成了什么样,
   * 再决定我这块该怎么做"。
   *
   * 这里补的就是这个:一句上下文 + 项目文件夹路径 + 明确允许它自己去看。
   * 因为所有节点共用同一个项目文件夹,下游本来就读得到上游改过的文件 ——
   * 缺的从来不是权限,是"知道该去看"。
   *
   * nodes-v2 分派(注入规则判据 = 目标节点的 kind/mode,PRD §5.1 分派表):
   *   - project:不加流水线上下文(它是源头);有 brief 则前置为项目说明
   *   - feature/parallel:换成"并行支路边界"开场白(见内注释)
   *   - feature/serial:沿用既有流线上下文
   *   - merge:流线上下文 + 追加"合回项目、收敛冲突"的职责措辞
   */
  private withPipelineHeader(
    prompt: string,
    spec: WorkflowNodeSpec,
    run: ActiveRun,
    preds: string[],
  ): string {
    // project 是源头:没有上游,没有流线上下文;brief 是"这个项目做什么"
    if (spec.kind === 'project') {
      const brief = (spec.brief ?? '').trim()
      return brief ? `[项目说明] ${brief}\n\n${prompt}` : prompt
    }

    /*
     * 目录用 plannedCwd 算,不是直接用 spec.cwd。
     *
     * spec.cwd 为空时节点并不是"没有目录" —— 主进程会兜到画布沙箱,
     * 而**同一条流水线上的节点共用同一个沙箱**。照着 spec.cwd 判断的话,
     * 这段开场白在实际有共享目录的情况下只字不提,下游就仍然不知道
     * "上游改过的文件就在手边",于是把它当成一段纯文字来读 ——
     * 而"去看看上游把项目改成什么样了再决定自己怎么做"正是搭流水线的全部意义。
     */
    const dir = plannedCwd(run.spec.canvasId, spec.cwd)
    const nodeById = new Map(run.spec.nodes.map((n) => [n.id, n]))
    const from = preds.map((id) => `「${nodeById.get(id)?.title ?? id}」`).join('、')

    /*
     * 并行支路:换上"支路边界"开场白。
     *
     * 就算它连到了 feature 上游(自动注入已被过滤,但结构上那条线还在),
     * 也要把"别把上游产出当输入、改动面别越界、冲突交整合节点"说清楚 ——
     * 这是 PRD §2.2 的三重约定里靠提示词协调的那一重,不阻断。
     */
    if (spec.kind === 'feature' && spec.mode === 'parallel') {
      const header = [
        `[并行支路边界] 你是一条**并行支路**,负责「${spec.title}」。`,
        from
          ? `你从 ${from} 接入,那只是表达"你属于这个项目" —— **不要**把其它功能节点的产出当成你的输入。`
          : '你独立开工,不等别的支路。',
        `项目文件夹是 ${dir} —— 所有支路与主链**共享同一份代码**,请把改动限定在「${spec.title}」这个功能范围内,不要改动与它无关的文件;`,
        '其它支路可能正在同时改别的功能:不要依赖它们的产出;若担心改动重叠,由下游的整合节点统一收敛。',
        '做完之后,把你这块的结论作为产出写清楚,整合节点会拿它当输入。',
      ]
        .filter(Boolean)
        .join('\n')
      return `${header}\n\n${prompt}`
    }

    if (preds.length === 0) return prompt

    // merge:在通用流线上下文上追加"收口"职责;串行维持原有措辞
    const mergeNote =
      spec.kind === 'merge'
        ? '你是整合节点:唯一职责是让上游**串行支路**与**并行支路**的改动**互相兼容**,' +
          '合成一个能一起工作的程序 —— 不是把各支路的文字罗列一遍。' +
          '串行支路的改动已经在项目里(别重复落实);并行支路各改各的、可能互相覆盖,那才是要收敛的部分。' +
          '下面的支路清单会逐条标出每条支路的性质,以及它是否已被另一条包含。'
        : ''

    const header = [
      `[流水线上下文] 你是这条流水线里的一环,负责「${spec.title}」。`,
      `上游是 ${from},它的产出附在下面。`,
      `项目文件夹是 ${dir} —— 上游可能已经在这个目录里改过文件,` +
        `可以直接列目录 / 读文件看现在的实际状态,据此调整你这块的做法。`,
      '做完之后,把你这块的结论作为产出写清楚,下一个节点会拿它当输入。',
      mergeNote,
    ]
      .filter(Boolean)
      .join('\n')
    return `${header}\n\n${prompt}`
  }

  // ---------------------------------------------------------------- 小工具

  private setNode(run: ActiveRun, nodeId: string, patch: Partial<RunNodeState>): void {
    const n = run.state.nodes[nodeId]
    if (!n) return
    Object.assign(n, patch)
    this.publish(run, [nodeId])
  }

  private publish(run: ActiveRun, changed: string[]): void {
    // 快照要深拷一份:否则渲染进程拿到的就是活对象,主进程一改它就跟着变,
    // 而 IPC 的结构化克隆本身也会序列化 —— 也就是说会序列化到一半被改
    this.env.emit({
      runId: run.state.runId,
      state: {
        ...run.state,
        nodes: Object.fromEntries(Object.entries(run.state.nodes).map(([k, v]) => [k, { ...v }])),
      },
      changed,
    })
  }
}

/**
 * 图像节点产出注入下游的**固定格式**(PRD §3.1)。
 *
 * 下游 agent 的 cwd = 项目文件夹,所以这些**相对路径可直接被 Read / 引入项目**。
 * 目录行取第一张图的目录段,方便下游一眼知道素材落在哪。
 */
export function formatImageOutput(rels: string[]): string {
  if (rels.length === 0) return '[图像产出] 没有生成新图片'
  const first = rels[0]
  const slash = Math.max(first.lastIndexOf('/'), first.lastIndexOf('\\'))
  const dir = slash >= 0 ? first.slice(0, slash) : ''
  return [
    `[图像产出] 生成了 ${rels.length} 张图片`,
    dir ? `目录(相对项目文件夹):${dir}` : '',
    ...rels.map((r) => `- ${r}`),
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 测试节点产出注入下游的**固定格式**。
 *
 * 形状与 `formatImageOutput` 同一路子:下游看到的第一行就是结论(通过 / 未通过
 * + 退出码),下面是日志尾部。日志**保尾**——失败用例与堆栈总在后面,
 * 保头只会拿到一堆环境输出。
 *
 * ⚠️ 成败两条路都走它。测试"未通过"不是"没有产出":失败列表本身就是下游
 * (以及人)判断该怎么修的唯一依据。
 */
export function formatTestOutput(res: {
  ok: boolean
  log: string
  error?: string
  exitCode?: number | null
}): string {
  const code = res.exitCode != null ? String(res.exitCode) : '未知'
  const head = res.ok
    ? `[测试结果] 通过(退出码 ${code})`
    : `[测试结果] 未通过:${res.error ?? '未知原因'}(退出码 ${code})`
  return `${head}\n\n${res.log.slice(-4_000)}`
}

export { CycleError }
