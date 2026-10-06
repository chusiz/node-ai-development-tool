import type { SessionStatus } from './types'
import type { FailureVerdict } from '../../shared/failure'

/**
 * 会话管理器的**统一句柄**。
 *
 * ## 为什么要有这个接口
 *
 * SessionManager 里那张 `live: Map<nodeId, session>` 原本存的是 AgentSession
 * (spawn 出来的子进程)。现在多了一路 API 直连 —— 它根本不 spawn 任何东西,
 * 只是一个 fetch 循环。两者形态差得很远,但管理器要的东西其实只有三样:
 *
 *   1. 现在还在跑吗(`isRunning`)—— 用于互斥与「取消」按钮的可用性;
 *   2. 跑完了通知我(`done`)—— 工作流 runner 靠它等一个节点结束;
 *   3. 让它停(`cancel`);
 *   4. 真正开跑(`run`)。
 *
 * 把这几样抽成接口,管理器就不用关心背后是进程还是 HTTP ——
 * 也不用为了兼容新形态去写 `if (是 API) … else …` 的分支散落在各处。
 *
 * ⚠️ `done` 必须是**构造后即可 await** 的语义(即使已经结束也要立刻 resolve)。
 * 原因见 AgentSession.done 的注释:快进程会在"start 返回"和"注册监听"之间
 * 就跑完,那时再注册监听就永远等不到 → 节点卡在 running。
 * 实现这一条的办法是在构造时就创建 Promise,而不是等第一次访问。
 */
export interface LiveSession {
  readonly isRunning: boolean
  readonly done: Promise<void>
  /**
   * 已结束则有值。管理器用它把结局转成事件;未结束为 null。
   * signal 只有子进程形态才有(HTTP 形态永远为 null)。
   *
   * `failure` 只在**确实失败**且**归出了类**时才有值(见 shared/failure.ts)。
   * 工作流调度器靠它决定还要不要退避重试 —— 缺省即视为可重试,维持旧行为。
   */
  readonly result: {
    status: SessionStatus
    code: number | null
    signal: NodeJS.Signals | null
    failure?: FailureVerdict
  } | null
  /**
   * 开跑。两种形态的签名一致:
   *   - CLI:presetArgs 是算好的 argv(可执行文件之外的参数);
   *   - API:presetArgs 无意义,实现里刻意忽略(带下划线前缀)。
   * 刻意返回 Promise<void> 而不是让构造就开跑 —— 这样"创建"和"开始"
   * 是两步,管理器能先把句柄塞进 `live` 表再跑,避免竞态。
   */
  run(prompt: string, presetArgs?: string[]): Promise<void>
  cancel(): void
}
