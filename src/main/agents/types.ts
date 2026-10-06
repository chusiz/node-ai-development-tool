import type { NodeEvent, SessionStatus, AgentCapabilities, PermissionMode } from '../../shared/ipc'

export type { NodeEvent, SessionStatus, AgentCapabilities }

export interface SessionOptions {
  /** 唯一节点 id,用于日志与并发互斥 */
  nodeId: string
  /** 工作目录,必须是绝对路径 —— resume 按 cwd 索引会话,变了就接不上 */
  cwd: string
  /** 首轮:自己生成的 uuid;后续轮:要恢复的 session id */
  sessionId: string
  /** true = 这是首轮(--session-id),false = 接续(--resume) */
  isFirstTurn: boolean
  /** 分叉:扇出到多节点时用,不污染原始会话 */
  fork?: boolean
  permissionMode?: PermissionMode
  /** 无人值守模式下需要显式跳过权限询问,否则会永久挂起 */
  dangerouslySkipPermissions?: boolean
  maxBudgetUsd?: number
  timeoutMs?: number
  /** 附加到内置参数之后的额外参数 */
  extraArgs?: string[]
}

export interface AgentDetectResult {
  exe: string
  /**
   * 需要拼在真实参数之前的固定参数。
   *
   * 存在的理由是 npm 全局安装的**纯 JS** CLI(如 gemini-cli):它的 `.cmd` 壳里
   * 是 `node …\dist\index.js %*`,真实入口是 node + 一个脚本路径。
   * 我们不能用 `process.execPath`(打包后那是本应用自己),所以定位器会另找
   * 一个 node,把脚本路径作为前置参数交回来。原生二进制的 CLI 这里是空数组。
   */
  prefixArgs?: string[]
  version: string | null
  source: string
  tried: string[]
}

/**
 * Agent 适配器接口。
 *
 * 加一个新 agent(Codex / Gemini / Qwen)= 新增一个实现目录 + 在 registry 注册,
 * 核心代码零改动。这就是"第一版只做 Claude 但接口先立好"的兑现方式。
 */
export interface AgentAdapter {
  id: string
  displayName: string
  capabilities: AgentCapabilities

  /**
   * prompt 的投递方式。缺省视为 'stdin'。
   * 自定义 CLI 可能只接受 argv,或要求写文件 —— 所以这是适配器的能力,不是全局约定。
   */
  promptDelivery?: 'stdin' | 'argv' | 'argv-after' | 'file'

  /**
   * 输出行的解析模式。缺省按 capabilities.streamJson 推断。
   * 'text' 时必须实现 parsePlainText,否则每行 JSON.parse 失败 → 全进 stderr → UI 空白。
   */
  lineMode?: 'json' | 'text'

  /** 探测本机是否可用 */
  detect(configuredPath?: string): Promise<AgentDetectResult | null>

  /**
   * 构造命令行参数。
   *
   * ⚠️ prompt 必须是**可选参数**而不是不在签名里:promptDelivery 为 'argv' 的适配器
   * 需要把 prompt 拼进参数,只传 opts 的话那种模式根本无法实现。
   * 走 stdin 的适配器忽略它即可。
   */
  buildArgs(opts: SessionOptions, prompt?: string): string[]

  /**
   * 把一行已 JSON.parse 的原始对象归一化。
   * 一个原始对象可能展开成多个事件(assistant 消息的 content 数组常同时含
   * thinking / text / tool_use),返回空数组 = 忽略该行。
   */
  parseEvent(obj: unknown): NodeEvent[]

  /** 从原始事件中提取权威 session id(以 agent 回传的为准) */
  extractSessionId(obj: unknown): string | null

  /**
   * 清理会污染/串扰子进程的环境变量。
   * nodeId 会作为 HAOWAN_NODE_ID 注入,便于子进程侧区分来源。
   */
  sanitizeEnv(env: NodeJS.ProcessEnv, nodeId?: string): NodeJS.ProcessEnv

  /** 不支持流式时的兜底:纯文本解析成事件 */
  parsePlainText?(chunk: string): NodeEvent[]
}
