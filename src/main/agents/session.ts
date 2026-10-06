import { spawn, type ChildProcess } from 'node:child_process'
import type { AgentAdapter, NodeEvent, SessionOptions, SessionStatus } from './types'
import type { LiveSession } from './live'
import { createLineReader, createJsonLineReader } from './ndjson'
import { killProcessTree } from './kill'
import { classifyFailure, type FailureVerdict } from '../../shared/failure'

export interface SessionCallbacks {
  /** 一批归一化事件(调用方负责做 40ms 聚合再推给 UI) */
  onEvents(events: NodeEvent[]): void
  /** 子进程结束。status 已判定好 */
  onExit(status: SessionStatus, code: number | null, signal: NodeJS.Signals | null): void
  /** 权威 session id 首次出现时回调(以 agent 回传的为准) */
  onSessionId?(sessionId: string): void
  /** 非 JSON 行 / 解析失败的行,只用于诊断,不进 UI 主流 */
  onStderr?(line: string): void
}

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 收集错误文本时**只留最后这么多行**。
 *
 * 这一段纯粹是给 classifyFailure 当判据用的,而判据只需要命中关键词那一行;
 * 把整场会话的 stderr 全攒着会在长会话里占掉几 MB 内存,却对判定毫无增益。
 * 保留尾部是因为错误几乎总是最后才出现(前面是正常输出)。
 */
const ERROR_TAIL_LINES = 60

/**
 * 一路独立会话 = 一个 agent 子进程的生命周期。
 *
 * 刻意做成**与具体 agent 无关**:只通过 AgentAdapter 接口通信,
 * 加 Codex / Gemini 时这个文件一行都不用改。
 *
 * 架构要点(已实测):
 *   每轮对话开新进程 + --resume 接续,而不是常驻 PTY。
 *   这既绕开了"禁止原生模块"(node-pty 需要 MSVC 编译)的硬约束,
 *   又天然给每个节点进程级隔离 —— 节点间不可能串会话。
 */
export class AgentSession implements LiveSession {
  private child: ChildProcess | null = null
  private timer: NodeJS.Timeout | null = null
  private finished = false
  private cancelled = false
  private timedOut = false
  private sessionIdReported = false
  private sawErrorEvent = false
  /**
   * 错误文本的尾部环形缓冲(见 ERROR_TAIL_LINES)。
   *
   * 存在的唯一理由:让 `finish` 那一刻能**判定这次失败是不是重试也没用**
   * (欠费 / 鉴权错 / 模型名错)。不攒文本的话,退出时只剩一个退出码,
   * 而退出码对"服务端说不行"这件事一无所知 —— 402 与 1 在它眼里没有区别。
   */
  private errorTail: string[] = []

  private exitInfo: {
    status: SessionStatus
    code: number | null
    signal: NodeJS.Signals | null
    failure?: FailureVerdict
  } | null = null
  private doneResolvers: Array<() => void> = []

  constructor(
    private readonly adapter: AgentAdapter,
    private readonly exe: string,
    private readonly opts: SessionOptions,
    private readonly cb: SessionCallbacks,
    /**
     * 拼在真实参数之前的固定参数。
     *
     * 为 npm 全局安装的**纯 JS** CLI 而加:那种命令的 `.cmd` 壳里其实是
     * `node …\dist\index.js %*`,真实可执行文件是 node、脚本路径是第一个参数。
     * 原生二进制的 CLI 传空数组。见 cli/locator.ts 的说明。
     */
    private readonly prefixArgs: string[] = [],
  ) {}

  get pid(): number | undefined {
    return this.child?.pid
  }

  get isRunning(): boolean {
    return this.child !== null && !this.finished
  }

  /**
   * 完成通知。**构造后即可 await**,所以不存在「注册监听之前 exit 已经发生」的竞态。
   *
   * 工作流 runner 的用法是 `start()` 返回后立刻 `await session.done` ——
   * 若改成"先 start、之后才 addListener",快进程会在两步之间就跑完,
   * 那个 exit 事件就永远收不到 → 节点卡在 running。
   */
  get done(): Promise<void> {
    if (this.exitInfo) return Promise.resolve()
    return new Promise<void>((resolve) => this.doneResolvers.push(resolve))
  }

  /** 已结束则有值,否则 null */
  get result(): {
    status: SessionStatus
    code: number | null
    signal: NodeJS.Signals | null
    failure?: FailureVerdict
  } | null {
    return this.exitInfo
  }

  /**
   * 记一段"可能与失败有关"的文本,供退出时判定。
   *
   * 三个来源都收,因为不同 agent 把错放在不同地方:
   *   - stderr 原始行(`API Error: 402 …`、`[claude-code:unrecognized_model] …`);
   *   - 归一化后的 `error` 事件(适配器认得的那些);
   *   - `is_error` 的 result 事件正文(claude 把错误写在 result 里,不写 error 事件)。
   *
   * 刻意**不判类别**,只收集 —— 判定统一放在 finish 里做一次,
   * 免得"哪条算错误"在三个地方有三种口径。
   */
  private noteError(text: string | null | undefined): void {
    const t = (text ?? '').trim()
    if (!t) return
    this.errorTail.push(t)
    if (this.errorTail.length > ERROR_TAIL_LINES) {
      this.errorTail.splice(0, this.errorTail.length - ERROR_TAIL_LINES)
    }
  }

  /**
   * 跑一轮。
   *
   * prompt 默认走 **stdin 而非 argv**,这是 Claude 那条路的选择,理由两条:
   *   - 规避 Windows 32767 字符 argv 上限(工作流拼接上游输出极易超限)
   *   - 免去全部引号转义,天然防注入
   *
   * 但**不是所有 CLI 都收 stdin** —— 具体走哪条由适配器的 `promptDelivery` 决定,
   * 见下面 run 内部对 stdin 的处理。
   */
  run(prompt: string, presetArgs?: string[]): Promise<void> {
    if (this.child) throw new Error(`节点 ${this.opts.nodeId} 已有活跃进程,不允许并发 resume`)

    // 允许调用方传入算好的参数 —— manager 需要在 StartResult 里回显 argv。
    // 不传就会算两遍,两处一旦分叉(比如只有一处带了 prompt)极难排查。
    const args = presetArgs ?? this.adapter.buildArgs(this.opts, prompt)

    return new Promise<void>((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(this.exe, [...this.prefixArgs, ...args], {
          cwd: this.opts.cwd,
          // 净化交给适配器 —— 各 agent 的污染变量不同。
          // nodeId 透传是为了让子进程侧能分辨自己是哪个节点起的。
          env: this.adapter.sanitizeEnv(process.env, this.opts.nodeId),
          windowsHide: true,
          // 绝不用 shell:true —— 那会把参数交给 cmd.exe 做引号解析,
          // 又会踩上 GBK 代码页导致中文乱码
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (err) {
        const msg = `无法启动 ${this.adapter.displayName}: ${(err as Error).message}`
        // 启动失败(可执行文件不存在等)本身就是永久错误,但它走的是抛异常那条路,
        // 拿不到退出码 —— 不收集的话 finish 里无从判定,只能当成可重试白等一轮
        this.noteError(msg)
        this.cb.onEvents([{ k: 'error', ts: Date.now(), message: msg }])
        this.finish('error', null, null, resolve)
        return
      }

      this.child = child
      this.armTimeout()

      // stdout/stderr 显式 utf-8,不依赖系统 locale,从源头杜绝 GBK 乱码。
      // (stdin 是 Writable,没有 setEncoding;编码在 write 时指定)
      child.stdout?.setEncoding('utf-8')
      child.stderr?.setEncoding('utf-8')

      const onObj = (obj: unknown): void => {
        const sid = this.adapter.extractSessionId(obj)
        if (sid && !this.sessionIdReported) {
          this.sessionIdReported = true
          this.cb.onSessionId?.(sid)
        }
        const events = this.adapter.parseEvent(obj)
        if (events.length === 0) return
        if (events.some((e) => e.k === 'error' || (e.k === 'result' && e.isError))) {
          this.sawErrorEvent = true
        }
        for (const e of events) {
          if (e.k === 'error') this.noteError(e.message)
          else if (e.k === 'result' && e.isError) this.noteError(e.text)
        }
        this.cb.onEvents(events)
      }

      /*
       * 解析模式由适配器的 lineMode 决定,不再写死 JSON。
       *
       * 写死的后果很隐蔽:输出纯文本的 CLI 每一行都会 JSON.parse 失败 →
       * 全部被当成 stderr 诊断行 → **UI 一个字都不显示,而且不报任何错**。
       * 声明了 parsePlainText 的适配器以前从来没被调用过,就是这个原因。
       */
      const mode = this.adapter.lineMode ?? (this.adapter.capabilities.streamJson ? 'json' : 'text')
      /*
       * ⚠️ 诊断行(非 JSON 行 + 全部 stderr 原始行)都要过 noteError。
       *
       * 这条路是 CLI 型错误文本**最主要的来源** —— 实测 claude 的
       * `API Error: 402 Insufficient Balance` 与
       * `[claude-code:unrecognized_model] {…}` 都是这么冒出来的,
       * 事件流里根本没有对应的 error 事件。不收它,失败分类就永远归不出类。
       *
       * ⚠️ 但 **text 模式下的 stdout 不收**。
       *
       * 那一支的每一行都是 agent **写出来的正文**(它正在给用户答话),
       * 不是诊断信息。收进来会有两个坏处:
       *   ① 正文里出现"error at line 401"这类句子(改代码时非常常见)会被
       *      鉴权规则命中,一次瞬时失败就被误判成永久失败 —— 正好违反
       *      shared/failure.ts 的保守原则;
       *   ② 正文会把这 60 行的缓冲冲掉,真正的错误反倒被挤出去。
       * json 模式的"非 JSON 行"是另一回事:它按定义就是解析不了的诊断输出
       * (见 ndjson.ts 的注释),收它是安全的。
       *
       * ⚠️ 两条分支的**其余行为一字未改**:json 模式仍走 onStderr 诊断,
       * text 模式仍只经 parsePlainText 归一化。
       */
      const outReader =
        mode === 'json'
          ? createJsonLineReader(onObj, (line) => {
              this.noteError(line)
              this.cb.onStderr?.(line)
            })
          : createLineReader((line) => {
              const events = this.adapter.parsePlainText?.(line) ?? []
              if (events.length > 0) this.cb.onEvents(events)
            })

      child.stdout?.on('data', (chunk: string) => outReader.push(chunk))
      child.stdout?.on('end', () => outReader.flush())

      const errReader = createLineReader((line) => {
        this.noteError(line)
        this.cb.onStderr?.(line)
      })
      child.stderr?.on('data', (chunk: string) => errReader.push(chunk))
      child.stderr?.on('end', () => errReader.flush())

      child.on('error', (err) => {
        this.noteError(`子进程错误: ${err.message}`)
        this.cb.onEvents([{ k: 'error', ts: Date.now(), message: `子进程错误: ${err.message}` }])
        this.finish('error', null, null, resolve)
      })

      child.on('close', (code, signal) => {
        const status: SessionStatus = this.cancelled
          ? 'killed'
          : this.timedOut
            ? 'timeout'
            : code === 0 && !this.sawErrorEvent
              ? 'done'
              : 'error'
        this.finish(status, code, signal, resolve)
      })

      /*
       * prompt 的投递方式由适配器声明,不是全局约定。
       *
       * 'stdin'(缺省):写进 stdin。
       * 'argv' / 'argv-after':prompt 已经在 `buildArgs` 拼进参数里了,
       *   再往 stdin 写一遍就是**送两份输入** —— 有的 CLI 会把它当成
       *   第二次提问,有的会直接报错。
       * 'file':正文由适配器自己落盘(路径也在 argv 里),同样不该走 stdin。
       *
       * ⚠️ 但**三种模式都必须 end()**:不少 CLI 起手就等 stdin 的 EOF,
       * 不关的话进程会一直挂着 —— 表现是"启动了但永远不出结果",
       * 而且因为进程还活着,取消以外没有任何自动出口。
       */
      if (child.stdin) {
        child.stdin.on('error', () => {
          /* 进程提前退出时 EPIPE 是正常的 */
        })
        const delivery = this.adapter.promptDelivery ?? 'stdin'
        if (delivery === 'stdin') child.stdin.end(prompt, 'utf8')
        else child.stdin.end()
      }
    })
  }

  /** 用户主动取消 */
  cancel(): void {
    if (this.finished || !this.child) return
    this.cancelled = true
    const pid = this.child.pid
    if (pid !== undefined) void killProcessTree(pid)
    else this.child.kill()
  }

  private armTimeout(): void {
    const ms = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (ms <= 0) return
    this.timer = setTimeout(() => {
      if (this.finished || !this.child) return
      this.timedOut = true
      const pid = this.child.pid
      if (pid !== undefined) void killProcessTree(pid)
      else this.child.kill()
    }, ms)
  }

  private finish(
    status: SessionStatus,
    code: number | null,
    signal: NodeJS.Signals | null,
    resolve: () => void,
  ): void {
    if (this.finished) return
    this.finished = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.child = null

    /*
     * 归类**只在这一处做**,且只对 `error` 做。
     *
     * - `killed` 是用户自己取消的,不是失败;
     * - `timeout` 是**瞬时**的(网络慢、模型慢),退避重试有意义;
     * - `done` 压根没失败。
     * 所以只有 error 才需要判定,其余一律不带 failure —— 缺省即"可重试"。
     */
    const failure = status === 'error' ? classifyFailure(this.errorTail.join('\n')) : undefined

    this.exitInfo = { status, code, signal, ...(failure ? { failure } : {}) }
    // 顺序有讲究:先让 onExit 跑完(manager 要在这里记 lastExit、清 live 表),
    // 再唤醒 await done 的调用方 —— 否则它们醒来时查不到这次运行的结局。
    this.cb.onExit(status, code, signal)
    resolve()

    const waiters = this.doneResolvers
    this.doneResolvers = []
    for (const w of waiters) w()
  }
}
