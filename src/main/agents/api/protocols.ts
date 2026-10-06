import type { ProviderDef } from '../../../shared/providers'
import type { ChatMessage, StreamChunk, ToolDef } from './types'
import { createSseReader } from './sse'
import { jsonHeaders } from '../../providers'

/**
 * 三家协议的请求构造与流式解析。
 *
 * 这个文件是整条 API 链路里**唯一**出现厂商名的地方。它把"各家报文长什么样"
 * 全部收进两个函数:
 *   buildChatRequest —— 中间表示 → 各家请求
 *   readStream       —— 各家流式报文 → 中间表示
 * 上面的工具循环、会话、IPC 一律不认识 `content_block` 或 `functionCall`。
 *
 * ## 三家在"请求"上的真实差异(都不是猜的,是各自文档的硬要求)
 *
 * | | 系统提示 | 工具结果放在哪 | 鉴权 | 必须的额外参数 |
 * |---|---|---|---|---|
 * | openai | messages 里 role=system | role=tool + tool_call_id | Bearer | — |
 * | anthropic | **顶层 system 字段**(不能放 messages) | role=**user** 里的 tool_result 块 | x-api-key | max_tokens **必填** |
 * | gemini | **顶层 systemInstruction** | role=user 里的 functionResponse 块 | query 参数 | — |
 *
 * ⚠️ Anthropic 那条"tool_result 必须放在 user 里"是最容易写错的一条:
 * 直觉上"工具返回"该是 role=tool,但 Anthropic 的 messages 只有 user/assistant
 * 两个角色,工具结果属于"用户侧提供的信息"。写错会得到一句语焉不详的 400。
 */

/** 一次请求的全部输入 */
export interface ChatRequestInput {
  provider: ProviderDef
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  tools: ToolDef[]
  /**
   * 输出 token 上限。**不传就是"沿用各家原来的行为"**。
   *
   * ## 为什么需要这个参数
   *
   * OpenAI 系的 `buildOpenai` 原本**完全不带** `max_tokens` —— 那意味着
   * 请求没有输出上限,模型可以一直写到 `max_completion_tokens` 或服务端默认值。
   * 单次对话无所谓(用户本来就要一整段回答),但"挨个验证 15 个模型"那种
   * 批量探测就是**真金白银**:15 个模型各生成几百 token,用户点一次花一次,
   * 而他对此毫无感知。所以探测路径必须能强制一个最小输出。
   *
   * ⚠️ **不传时行为与从前完全一致** —— 正常会话路径不传这个字段,
   * 改动只影响显式要求最小输出的那条路(见 shared/probe.ts)。
   *
   * 另外 Anthropic 的 `max_tokens` 是**必填**且没有默认值,那一支一直是写死的
   * 8192;传了这个参数就能把它压到探测需要的量级。
   */
  maxTokens?: number
}

/* ============================================================
   请求构造
   ============================================================ */

export function buildChatRequest(a: ChatRequestInput): { url: string; init: RequestInit } {
  // 聊天请求全是带 JSON body 的 POST,所以用 jsonHeaders(鉴权 + Content-Type)
  const headers = jsonHeaders(a.provider, a.apiKey)
  switch (a.provider.protocol) {
    case 'anthropic':
      return buildAnthropic(a, headers)
    case 'gemini':
      return buildGemini(a)
    default:
      return buildOpenai(a, headers)
  }
}

function toOpenaiMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      // content 为 null 而不是省略:带 tool_calls 的 assistant 消息里,
      // 省略 content 会被部分实现判成非法
      content: m.content || null,
      tool_calls: m.toolCalls.map((t) => ({
        id: t.id,
        type: 'function',
        function: { name: t.name, arguments: t.args || '{}' },
      })),
    }
  }
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
  }
  return { role: m.role, content: m.content }
}

function buildOpenai(a: ChatRequestInput, headers: Record<string, string>): { url: string; init: RequestInit } {
  const body: Record<string, unknown> = {
    model: a.model,
    stream: true,
    messages: a.messages.map(toOpenaiMessage),
  }
  /*
   * 只有显式要求时才夹上。不传 = 与从前逐字一致(正常会话不受影响),
   * 传了 = 强制最小输出,批量探测靠这条把成本压到可接受。
   */
  if (typeof a.maxTokens === 'number') body.max_tokens = a.maxTokens
  if (a.tools.length) {
    body.tools = a.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
    body.tool_choice = 'auto'
  }
  return {
    url: `${a.baseUrl}/chat/completions`,
    init: { method: 'POST', headers, body: JSON.stringify(body) },
  }
}

/**
 * Anthropic 的消息转换。
 *
 * ⚠️ 返回的是**数组**:一条 role=tool 的中间表示会被转成一个 role=user 的
 * tool_result 块;连续的多个 tool 结果还要**合并进同一条** user 消息 ——
 * Anthropic 要求 user/assistant 严格交替,连着两条 user 会被拒。
 */
function toAnthropicMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const m of messages) {
    if (m.role === 'system') continue // 走顶层 system

    if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content,
      }
      const last = out[out.length - 1]
      // 上一条已经是本次合并出来的 user 就并进去,避免连续 user
      if (last && last.role === 'user' && Array.isArray(last.content) && last.__merged === true) {
        ;(last.content as unknown[]).push(block)
      } else {
        out.push({ role: 'user', content: [block], __merged: true })
      }
      continue
    }

    if (m.role === 'assistant' && m.toolCalls?.length) {
      const content: unknown[] = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const t of m.toolCalls) {
        content.push({
          type: 'tool_use',
          id: t.id,
          name: t.name,
          // input 必须是对象。模型给的参数串若截断(超长被服务商砍掉),
          // 这里会 parse 失败 —— 回落成空对象,让这次的 tool_result 报错,
          // 而不是整个请求 400
          input: safeParseJson(t.args),
        })
      }
      out.push({ role: 'assistant', content })
      continue
    }

    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })
  }
  // 内部用的 __merged 标记不能发给服务商
  for (const m of out) delete m.__merged
  return out
}

function buildAnthropic(a: ChatRequestInput, headers: Record<string, string>): { url: string; init: RequestInit } {
  const system = a.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .filter(Boolean)
    .join('\n\n')

  const body: Record<string, unknown> = {
    model: a.model,
    // ⚠️ max_tokens 在 Anthropic 是**必填**,没有默认值。漏了直接 400。
    // 不传时沿用对话场景的 8192;探测路径传 1(见 ChatRequestInput.maxTokens)。
    max_tokens: typeof a.maxTokens === 'number' ? a.maxTokens : 8192,
    stream: true,
    messages: toAnthropicMessages(a.messages),
  }
  if (system) body.system = system
  if (a.tools.length) {
    body.tools = a.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }))
  }
  return {
    url: `${a.baseUrl}/messages`,
    init: { method: 'POST', headers, body: JSON.stringify(body) },
  }
}

function toGeminiContents(messages: ChatMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const m of messages) {
    if (m.role === 'system') continue

    if (m.role === 'tool') {
      // Gemini 的 functionResponse 用 name 匹配(不是 id),且 response 必须是对象
      out.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: m.name ?? 'tool',
              response: { result: m.content },
            },
          },
        ],
      })
      continue
    }

    if (m.role === 'assistant' && m.toolCalls?.length) {
      const parts: unknown[] = []
      if (m.content) parts.push({ text: m.content })
      for (const t of m.toolCalls) {
        parts.push({ functionCall: { name: t.name, args: safeParseJson(t.args) } })
      }
      out.push({ role: 'model', parts })
      continue
    }

    out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })
  }
  return out
}

function buildGemini(a: ChatRequestInput): { url: string; init: RequestInit } {
  const system = a.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .filter(Boolean)
    .join('\n\n')

  const body: Record<string, unknown> = { contents: toGeminiContents(a.messages) }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  /*
   * Gemini 的输出上限在 `generationConfig.maxOutputTokens`,不是顶层的 max_tokens。
   * 同样只在显式要求时加 —— 不传时 body 与从前逐字一致。
   */
  if (typeof a.maxTokens === 'number') {
    body.generationConfig = { maxOutputTokens: a.maxTokens }
  }
  if (a.tools.length) {
    body.tools = [
      {
        functionDeclarations: a.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ]
  }

  const url = new URL(`${a.baseUrl}/models/${encodeURIComponent(a.model)}:streamGenerateContent`)
  // alt=sse 是关键:不加的话返回的是一个 JSON 数组的流,而不是 SSE
  url.searchParams.set('alt', 'sse')
  if (a.apiKey) url.searchParams.set('key', a.apiKey)

  return {
    url: url.toString(),
    init: {
      method: 'POST',
      // Gemini 用 query 鉴权,这里只声明内容类型
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  }
}

/** 解析模型给的参数串。失败给空对象 —— 让这次工具调用自己报"缺参数",而不是炸掉整个请求 */
function safeParseJson(s: string): Record<string, unknown> {
  if (!s || !s.trim()) return {}
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { args: v }
  } catch {
    return {}
  }
}

/* ============================================================
   流式解析
   ============================================================ */

/**
 * 把响应体读成 StreamChunk 序列。
 *
 * 用异步生成器而不是回调,是为了让工具循环里能写成 `for await (...)` ——
 * 边收边跑的顺序天然正确,不需要在回调里维护状态机。
 */
export async function* readStream(
  provider: ProviderDef,
  res: Response,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  if (!res.body) return

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  const queue: StreamChunk[] = []
  let sawDone = false

  const sse = createSseReader((payload) => {
    // OpenAI 系用 [DONE] 显式收尾;Anthropic / Gemini 靠流自然结束
    if (payload === '[DONE]') {
      sawDone = true
      return
    }
    let obj: unknown
    try {
      obj = JSON.parse(payload)
    } catch {
      // 半截 JSON(流被切断)—— 不报错,后面的 chunk 里通常还有完整事件
      return
    }
    queue.push(...parseChunk(provider.protocol, obj))
  })

  try {
    for (;;) {
      if (signal?.aborted) break
      const { value, done } = await reader.read()
      if (value) sse.push(decoder.decode(value, { stream: true }))
      while (queue.length) yield queue.shift() as StreamChunk
      if (done || sawDone) break
    }
    sse.flush()
    while (queue.length) yield queue.shift() as StreamChunk
    if (sawDone) yield { k: 'finish', reason: null }
  } finally {
    // 提前 break(取消)时必须把流放掉,否则连接会一直挂着
    try {
      await reader.cancel()
    } catch {
      /* 已经关了 */
    }
  }
}

/** 一个原始报文 → 零到多个增量。导出是为了 e2e 能脱离网络直接测解析 */
export function parseChunk(protocol: ProviderDef['protocol'], obj: unknown): StreamChunk[] {
  if (!obj || typeof obj !== 'object') return []
  switch (protocol) {
    case 'anthropic':
      return parseAnthropicChunk(obj as Record<string, any>)
    case 'gemini':
      return parseGeminiChunk(obj as Record<string, any>)
    default:
      return parseOpenaiChunk(obj as Record<string, any>)
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function parseOpenaiChunk(o: Record<string, any>): StreamChunk[] {
  const out: StreamChunk[] = []

  const choice = Array.isArray(o.choices) ? o.choices[0] : undefined
  const d = choice?.delta
  if (d && typeof d === 'object') {
    if (str(d.content)) out.push({ k: 'text', text: d.content })
    /*
     * 思维链字段各家中转叫法不一:DeepSeek 用 reasoning_content,
     * 有的用 reasoning,还有的塞在 reasoning_details 里。都认一下 ——
     * 认不出的后果是"思考过程不显示",不影响答案,所以宁可多认几个。
     */
    if (str(d.reasoning_content)) out.push({ k: 'reasoning', text: d.reasoning_content })
    else if (str(d.reasoning)) out.push({ k: 'reasoning', text: d.reasoning })

    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        out.push({
          k: 'tool_delta',
          // 部分实现省略 index,单次调用时默认为 0 是对的
          index: typeof tc?.index === 'number' ? tc.index : 0,
          id: str(tc?.id) || undefined,
          name: str(tc?.function?.name) || undefined,
          args: str(tc?.function?.arguments) || undefined,
        })
      }
    }
  }

  if (choice?.finish_reason) out.push({ k: 'finish', reason: String(choice.finish_reason) })

  if (o.usage && typeof o.usage === 'object') {
    out.push({
      k: 'usage',
      inputTokens: numOr(o.usage.prompt_tokens),
      outputTokens: numOr(o.usage.completion_tokens),
    })
  }

  // 少数服务商把错误塞在 200 的报文里
  if (o.error) {
    out.push({ k: 'error', message: errorText(o.error) })
  }

  return out
}

function parseAnthropicChunk(o: Record<string, any>): StreamChunk[] {
  const out: StreamChunk[] = []
  switch (o.type) {
    case 'content_block_start': {
      const cb = o.content_block
      if (cb?.type === 'tool_use') {
        out.push({
          k: 'tool_delta',
          index: typeof o.index === 'number' ? o.index : 0,
          id: str(cb.id) || undefined,
          name: str(cb.name) || undefined,
        })
      }
      break
    }
    case 'content_block_delta': {
      const d = o.delta
      const idx = typeof o.index === 'number' ? o.index : 0
      if (d?.type === 'text_delta') out.push({ k: 'text', text: str(d.text) })
      else if (d?.type === 'thinking_delta') out.push({ k: 'reasoning', text: str(d.thinking) })
      else if (d?.type === 'input_json_delta') out.push({ k: 'tool_delta', index: idx, args: str(d.partial_json) })
      break
    }
    case 'message_start': {
      const u = o.message?.usage
      if (u) out.push({ k: 'usage', inputTokens: numOr(u.input_tokens), outputTokens: numOr(u.output_tokens) })
      break
    }
    case 'message_delta': {
      if (o.usage) out.push({ k: 'usage', outputTokens: numOr(o.usage.output_tokens) })
      if (o.delta?.stop_reason) out.push({ k: 'finish', reason: String(o.delta.stop_reason) })
      break
    }
    case 'error':
      out.push({ k: 'error', message: errorText(o.error) })
      break
    default:
      break
  }
  return out
}

function parseGeminiChunk(o: Record<string, any>): StreamChunk[] {
  const out: StreamChunk[] = []
  const c = Array.isArray(o.candidates) ? o.candidates[0] : undefined
  const parts = c?.content?.parts
  if (Array.isArray(parts)) {
    for (const p of parts) {
      if (!p || typeof p !== 'object') continue
      if (str(p.text)) out.push({ k: 'text', text: p.text })
      /*
       * Gemini 的工具调用**不是增量的** —— 一次就给完整的 name + args,
       * 也没有 id。所以这里一次性推一个 tool_delta,index 由我们自己编号。
       * 没有 id 的问题在工具循环里解决(那里会补一个)。
       */
      if (p.functionCall) {
        out.push({
          k: 'tool_delta',
          index: out.filter((x) => x.k === 'tool_delta').length,
          name: str(p.functionCall.name) || undefined,
          args: JSON.stringify(p.functionCall.args ?? {}),
        })
      }
    }
  }
  if (c?.finishReason) out.push({ k: 'finish', reason: String(c.finishReason) })
  if (o.usageMetadata) {
    out.push({
      k: 'usage',
      inputTokens: numOr(o.usageMetadata.promptTokenCount),
      outputTokens: numOr(o.usageMetadata.candidatesTokenCount),
    })
  }
  if (o.error) out.push({ k: 'error', message: errorText(o.error) })
  return out
}

function numOr(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 错误对象的文本。各家字段名不一样:Anthropic 是 {type,message},OpenAI 是 {message} */
function errorText(e: unknown): string {
  if (!e) return '未知错误'
  if (typeof e === 'string') return e
  const o = e as Record<string, unknown>
  const msg = str(o.message) || str(o.type) || str(o.code)
  const detail = str(o.detail)
  return [msg, detail].filter(Boolean).join(' · ') || JSON.stringify(e).slice(0, 300)
}

/**
 * 从非流式响应体里抠出助手正文。
 *
 * 只在"测试连接"与"服务商不支持流式"时用 —— 正常对话不走这条。
 */
export function extractPlainReply(protocol: ProviderDef['protocol'], raw: unknown): string {
  const o = (raw ?? {}) as Record<string, any>
  try {
    if (protocol === 'anthropic') {
      const arr = Array.isArray(o.content) ? o.content : []
      return arr.map((b: any) => (b?.type === 'text' ? str(b.text) : '')).join('')
    }
    if (protocol === 'gemini') {
      const parts = o.candidates?.[0]?.content?.parts
      return Array.isArray(parts) ? parts.map((p: any) => str(p?.text)).join('') : ''
    }
    return str(o.choices?.[0]?.message?.content)
  } catch {
    return ''
  }
}
