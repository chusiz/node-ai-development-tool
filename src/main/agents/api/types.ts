import type { PermissionMode } from '../../../shared/events'
import type { ProviderDef } from '../../../shared/providers'

/**
 * API 直连这条链路的内部类型。
 *
 * 关键的设计选择是**中间表示**(`ChatMessage` / `StreamChunk`)在协议层之上:
 * 各家厂商的报文形状差得很远(OpenAI 的 delta、Anthropic 的 content_block、
 * Gemini 的 parts),但如果让工具循环直接吃原始报文,那段循环就写不成通用的了。
 * 于是顺序是:
 *
 *   messages(中间表示) → protocols.buildChatRequest() → 各家报文
 *   各家流式报文 → protocols.readStream() → StreamChunk(中间表示) → 工具循环
 *
 * 加一家新服务商只要在 protocols 里补一个分支,工具循环与 session 一行不动。
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

/** 已累积完成的一次工具调用 */
export interface ToolCall {
  id: string
  name: string
  /** 原始 JSON 字符串(模型的参数是流式吐出来的,这里存拼好的完整串) */
  args: string
}

/**
 * 一条对话消息。
 *
 * `toolCalls` / `toolCallId` 是为"带工具的多轮"服务的:assistant 那一条要挂上
 * 它请求的调用,紧接着的 tool 消息要指出自己回应的是哪一个 —— 少任何一半,
 * 下一次请求都会被服务商判成非法报文(它们要的是严格配对)。
 */
export interface ChatMessage {
  role: Role
  content: string
  /** role='assistant' 时:它请求了哪些工具调用 */
  toolCalls?: ToolCall[]
  /** role='tool' 时:回应的是哪个 toolCall.id */
  toolCallId?: string
  /** role='tool' 时:工具名。部分服务商要求带上 */
  name?: string
}

/** 工具定义。参数用 JSON Schema —— 三家都能吃这个形状 */
export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/**
 * 流式解析出来的最小增量。
 *
 * 刻意做得很小:它只描述"模型说了什么",不掺任何工具执行语义。
 * 工具循环负责把这些增量拼成完整的一次调用,再决定跑不跑。
 */
export type StreamChunk =
  | { k: 'text'; text: string }
  /** 思维链。不是所有服务商都给,给了就展示 */
  | { k: 'reasoning'; text: string }
  /**
   * 工具调用的碎片。`index` 是它的身份 ——
   * OpenAI 把一次调用的 id / name / arguments 分在多个 chunk 里发,
   * 靠 index 才能拼回同一次调用。
   */
  | { k: 'tool_delta'; index: number; id?: string; name?: string; args?: string }
  | { k: 'usage'; inputTokens?: number; outputTokens?: number }
  | { k: 'finish'; reason: string | null }
  /**
   * 流**中途**报错。
   *
   * 单独一个类型而不是 throw:HTTP 200 之后才开始吐错的场景很常见
   * (Anthropic 的 overloaded、OpenAI 的 content_filter 都走这条路),
   * 那时已经输出了一半正文。抛异常会让那半截内容连同错误一起丢掉,
   * 而用户更需要看到"它说到一半断了,原因是X"。
   */
  | { k: 'error'; message: string }

/** 一次 API 会话所需的全部运行期上下文 */
export interface ApiCtx {
  nodeId: string
  canvasId: string
  provider: ProviderDef
  /** 实际使用的接口地址(已应用用户覆盖) */
  baseUrl: string
  /** 明文 Key。**只在主进程内存里**,绝不写日志、绝不进 IPC */
  apiKey: string
  model: string
  /** 工作目录 = 工具能碰的文件范围 */
  cwd: string
  permissionMode: PermissionMode
  /** 工具循环最多跑几轮。防模型陷入"调用-失败-再调用"的死循环 */
  maxTurns: number
  /** 单次请求超时 */
  timeoutMs: number
}
