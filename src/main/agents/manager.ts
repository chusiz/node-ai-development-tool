import { randomUUID } from 'node:crypto'
import type { NodeEvent, SessionStatus } from './types'
import type { StartRequest, StartResult } from '../../shared/ipc'
import { getAdapter } from './registry'
import { AgentSession, type SessionCallbacks } from './session'
import { ApiSession } from './api/session'
import { buildApiCtx } from './api/resolve'
import { configuredCliPath } from './cliPath'
import type { LiveSession } from './live'
import { createBatcher } from '../util/batching'
import { providerOfAgent } from '../../shared/providers'
import type { SessionOutcome } from '../../shared/failure'

export type { StartRequest, StartResult }

export interface ManagerEmit {
  events(nodeId: string, events: NodeEvent[]): void
  exit(nodeId: string, status: SessionStatus, code: number | null): void
  sessionId(nodeId: string, sessionId: string): void
  log(nodeId: string, line: string): void
}

/** 每个 nodeId 同时只允许一个活跃进程 —— 同一 session 并发 resume 会互相踩 */
export class SessionManager {
  /**
   * ⚠️ 值类型是 LiveSession 而不是 AgentSession(v0.4.0 起)。
   *
   * 这张表原本只装 spawn 出来的子进程;现在还要装 API 直连那种"只有 fetch
   * 循环、没有进程"的会话。两者形态差得远,但管理器对它们的要求是一样的
   * (还在跑吗 / 跑完了吗 / 停下),所以抽成接口就够了 —— 见 live.ts。
   */
  private live = new Map<string, LiveSession>()
  /**
   * 探测结果的缓存。
   *
   * ⚠️ 存的是 `{exe, prefixArgs}` 而不是一个字符串:纯 JS 的 CLI(如 gemini-cli)
   * 的真实入口是「node + 脚本路径」两段。只缓存 exe 会把脚本路径丢掉,
   * 于是第二次运行会去执行一个根本没被指定脚本的 node —— 报错还很难懂。
   */
  private resolvedExe = new Map<string, { exe: string; prefixArgs: string[] }>()
  /** 已结束会话的最后结局。live 里被删掉之后,waitFor 还能查到 */
  private lastExit = new Map<string, SessionOutcome>()
  /**
   * 正在启动中的节点(已占位、尚未进 live)。
   * 存在的唯一理由:让「检查是否忙碌」与「占位」发生在同一个同步块里。
   */
  private pending = new Set<string>()
  private batch = createBatcher<{ nodeId: string; events: NodeEvent[] }>((items) => {
    for (const it of items) this.emit.events(it.nodeId, it.events)
  }, 40)

  constructor(private readonly emit: ManagerEmit) {}

  /** 缓存探测结果:239MB 二进制,每次调用都跑一次 --version 太浪费 */
  private async exeFor(agentId: string): Promise<{ exe: string; prefixArgs: string[] }> {
    const cached = this.resolvedExe.get(agentId)
    if (cached) return cached

    const adapter = getAdapter(agentId)
    // 用户显式配置的路径优先。空串/缺项 = 没配,折成 undefined 走自动探测
    const loc = await adapter.detect(configuredCliPath(agentId))
    if (!loc) throw new Error(`未在本机找到 ${adapter.displayName} 可执行文件`)
    const rec = { exe: loc.exe, prefixArgs: loc.prefixArgs ?? [] }
    this.resolvedExe.set(agentId, rec)
    return rec
  }

  /**
   * 让探测缓存失效。
   *
   * 必须的:用户在设置里改了自定义 CLI 的 exe 路径后,缓存还指着旧路径,
   * 表现就是「改了没反应」。任何改动 agent 定义的路径都要调这个。
   */
  clearExeCache(agentId?: string): void {
    if (agentId === undefined) this.resolvedExe.clear()
    else this.resolvedExe.delete(agentId)
  }

  async start(req: StartRequest): Promise<StartResult> {
    const { nodeId, prompt } = req
    if (!prompt.trim()) throw new Error('prompt 不能为空')

    /*
     * ⚠️ 检查与占位之间**不能有 await**。
     *
     * 原来这里只查 live,而 exeFor() 是个 await —— 同一节点快速触发两次时,
     * 两次都在 await 之前通过了检查(那时 live 还没写入),于是双双 spawn,
     * 两路进程写同一个节点。用 pending 做同步占位把这个窗口关掉。
     */
    if (this.pending.has(nodeId) || this.live.get(nodeId)?.isRunning) {
      throw new Error(`节点 ${nodeId} 正在运行中,请先取消或等待完成`)
    }
    this.pending.add(nodeId)

    try {
      const agentId = req.agentId ?? 'claude'
      const isFirstTurn = !req.sessionId
      const sessionId = req.sessionId ?? randomUUID()

      /*
       * 两条路在这里分叉。
       *
       * `agentId` 是不是 `api:<providerId>` 形态,决定了底下是"拉一个子进程"
       * 还是"发 HTTP 请求"。分叉点**只应该有一个** —— 散在别处的话,
       * 迟早出现"起了 API 会话却按 CLI 的方式去等子进程"这种半截行为。
       */
      const provider = providerOfAgent(agentId)

      let exe: string
      let args: string[]
      let live: LiveSession
      let model: string | undefined

      /*
       * onExit 里要判断"还活着的是不是我",但构造回调时会话本身还不存在
       * (先有回调才能 new)。用一个可变持有者打破这个循环。
       * onExit 只会在会话结束时触发,那时 holder.live 必然已赋值。
       */
      const holder: { live?: LiveSession } = {}

      const callbacks: SessionCallbacks = {
        onEvents: (events) => this.batch.push({ nodeId, events }),
        onExit: (status, code) => {
          this.batch.flushNow()
          // ⚠️ 只删「还是我这一个」。
          // 无条件 delete 的话:取消旧会话后立刻起新会话,旧会话的 close 事件
          // 会把**新**会话从表里删掉 → 新会话从此无法取消。
          if (holder.live && this.live.get(nodeId) === holder.live) this.live.delete(nodeId)
          this.lastExit.set(nodeId, { status, code })
          this.emit.exit(nodeId, status, code)
        },
        onSessionId: (sid) => this.emit.sessionId(nodeId, sid),
        onStderr: (line) => this.emit.log(nodeId, line),
      }

      if (provider) {
        const built = buildApiCtx(req, provider, req.cwd)
        // 缺 Key / 缺地址属于用户配置问题,直接抛一句能照着做的话
        if (!built.ok) throw new Error(built.message)

        live = new ApiSession(built.ctx, callbacks)
        // 回显用:API 型没有可执行文件,把接口地址放在同一个字段里(见 StartResult 的注释)
        exe = built.ctx.baseUrl
        model = built.ctx.model
        args = [`POST ${built.ctx.baseUrl}`, `model=${built.ctx.model}`]
      } else {
        const adapter = getAdapter(agentId)
        const { exe: exePath, prefixArgs } = await this.exeFor(agentId)

        const opts = {
          nodeId,
          cwd: req.cwd,
          sessionId,
          isFirstTurn,
          permissionMode: req.permissionMode ?? ('acceptEdits' as const),
          dangerouslySkipPermissions: req.dangerouslySkipPermissions,
          timeoutMs: req.timeoutMs,
          maxBudgetUsd: req.maxBudgetUsd,
        }

        // 参数只算一次,同一份传给 session —— 避免两处分叉
        args = adapter.buildArgs(opts, prompt)
        live = new AgentSession(adapter, exePath, opts, callbacks, prefixArgs)
        exe = exePath
      }

      holder.live = live
      this.live.set(nodeId, live)

      // 故意不 await:调用方立刻拿到 sessionId 好去渲染,
      // 真正的完成信号走 onExit 事件 / session.done
      void live.run(prompt, args)

      return { nodeId, sessionId, isFirstTurn, exe, args, model }
    } finally {
      // live 已就位(或启动已失败),占位使命结束
      this.pending.delete(nodeId)
    }
  }

  /**
   * 等某个节点这一轮跑完。
   *
   * ⚠️ 必须在 `start()` 返回后**立刻**调用。中间若又 start 了一次同一节点,
   * 这里等到的会是那一次而不是你要的那一次(`live` 已被顶替)。
   * 工作流 runner 的调用点满足这个约束。
   */
  async waitFor(nodeId: string): Promise<SessionOutcome> {
    const s = this.live.get(nodeId)
    if (s) {
      await s.done
      const r = s.result
      if (r) return { status: r.status, code: r.code, ...(r.failure ? { failure: r.failure } : {}) }
    }
    return this.lastExit.get(nodeId) ?? { status: 'error', code: null }
  }

  cancel(nodeId: string): boolean {
    const s = this.live.get(nodeId)
    if (!s) return false
    s.cancel()
    return true
  }

  runningNodeIds(): string[] {
    return [...this.live.entries()].filter(([, s]) => s.isRunning).map(([id]) => id)
  }

  /**
   * 退出前清场,防孤儿进程。
   *
   * ⚠️ 调用顺序有要求:工作流 runner 必须先 runner.cancelAll() 再调这个。
   * 反过来的话 live 表已被清空,runner 里等 session.done 的逻辑就再也醒不过来
   * (它的 waitFor 查不到 live 也查不到 lastExit)→ 退出时永久挂起。
   */
  killAll(): void {
    for (const s of this.live.values()) s.cancel()
    this.live.clear()
    this.pending.clear()
    this.batch.dispose()
  }
}
