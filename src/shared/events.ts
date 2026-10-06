/**
 * 全应用唯一的事件契约 —— main / preload / renderer 三边共享。
 *
 * UI、持久化、工作流引擎都只认 NodeEvent,不认任何 agent 的原始输出格式。
 * 这是抗 agent 版本漂移的关键:**未知事件一律降级为 raw 原样保留,永不抛异常**。
 */
export type NodeEvent =
  | { k: 'init'; ts: number; sessionId: string; model?: string; cwd?: string; tools?: string[] }
  | { k: 'text'; ts: number; text: string }
  | { k: 'thinking'; ts: number; text: string }
  | { k: 'tool_use'; ts: number; id: string; name: string; input: unknown }
  | { k: 'tool_result'; ts: number; toolUseId: string; content: string; isError: boolean }
  | {
      k: 'result'
      ts: number
      text: string | null
      sessionId: string | null
      costUsd: number | null
      durationMs: number | null
      isError: boolean
    }
  | { k: 'error'; ts: number; message: string }
  /**
   * 高频进度心跳(实测有 system/thinking_tokens,每轮可爆几十条)。
   *
   * ⚠️ **不是消息**,绝不能进消息数组 —— 只喂给临时的 live 指示器,
   * 用完即弃。这是 plan §5.7"高频数据隔离到独立 store"的落地。
   */
  | { k: 'progress'; ts: number; label: string; value?: number }
  /** 解析不了的原始行 / 未知事件类型。保留是为了排查与向后兼容 */
  | { k: 'raw'; ts: number; payload: unknown }

export type SessionStatus =
  | 'idle'
  | 'running'
  | 'done'
  | 'error'
  | 'timeout'
  | 'killed'
  | 'skipped'
  /**
   * 磁盘上记着 `running`,但进程已经不在了 —— 上次应用是被强杀/崩掉的。
   *
   * 与 `error` 分开是因为成因不同(不是 agent 出错,是我们的进程没了),
   * 排查方向也完全不同。只能由"启动时读盘"产生,manager 永远不会给出这个值。
   */
  | 'interrupted'

/**
 * 实测自 `claude --help`(2.1.289):
 *   (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")
 * ⚠️ 没有 "default" —— 早期文档里的写法已经不存在了,写错会直接启动失败。
 *
 * 放在 events.ts 而不是 ipc.ts:节点配置(shared/canvas.ts)也要引用它,
 * 放在 ipc.ts 会绕成一个类型循环。
 */
export type PermissionMode =
  | 'acceptEdits'
  | 'auto'
  | 'bypassPermissions'
  | 'manual'
  | 'dontAsk'
  | 'plan'
