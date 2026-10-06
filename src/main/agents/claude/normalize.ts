import type { NodeEvent } from '../types'

/**
 * 原始事件 → 稳定 NodeEvent 契约。
 *
 * 设计铁律:**这个文件永不抛异常**。claude 的流式输出会随版本漂移,
 * 我们宁可把它降级成 { k:'raw' } 原样留着,也不能让一个没见过的字段
 * 崩掉整个会话。
 */

type Rec = Record<string, unknown>

function rec(v: unknown): Rec | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : null
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function strArr(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
}

/** tool_result 的 content 可以是字符串,也可以是块的数组,统一压成字符串 */
function flattenContent(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    return v
      .map((b) => {
        const r = rec(b)
        if (!r) return typeof b === 'string' ? b : ''
        return str(r.text) ?? str(r.content) ?? ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (v === null || v === undefined) return ''
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function normalizeContentBlock(block: unknown, ts: number): NodeEvent | null {
  const b = rec(block)
  if (!b) return null
  const type = str(b.type)

  switch (type) {
    case 'text': {
      const text = str(b.text)
      // 空文本块直接丢掉,不产生空气泡
      return text ? { k: 'text', ts, text } : null
    }
    case 'thinking': {
      // 实测字段名是 thinking(不是 text),别搞错。
      // 注意:claude 常吐 thinking 为空串的占位块,必须丢弃而不是渲染成空气泡。
      const text = str(b.thinking) ?? str(b.text)
      return text ? { k: 'thinking', ts, text } : null
    }
    case 'redacted_thinking':
      return { k: 'thinking', ts, text: '[已加密的思考内容]' }
    case 'tool_use':
      return {
        k: 'tool_use',
        ts,
        id: str(b.id) ?? '',
        name: str(b.name) ?? 'unknown',
        input: b.input ?? null,
      }
    case 'tool_result':
      return {
        k: 'tool_result',
        ts,
        toolUseId: str(b.tool_use_id) ?? '',
        content: flattenContent(b.content),
        isError: b.is_error === true,
      }
    default:
      return { k: 'raw', ts, payload: block }
  }
}

function normalizeSystem(obj: Rec, ts: number): NodeEvent[] {
  const subtype = str(obj.subtype)

  if (subtype === 'init') {
    return [
      {
        k: 'init',
        ts,
        sessionId: str(obj.session_id) ?? '',
        model: str(obj.model),
        cwd: str(obj.cwd),
        tools: strArr(obj.tools),
      },
    ]
  }

  // 实测:思考过程中会高频吐这玩意(每轮几十条),它是**进度心跳不是消息**。
  // 归到 progress,由 UI 拿去更新 live 指示器,绝不进消息流。
  if (subtype === 'thinking_tokens') {
    return [{ k: 'progress', ts, label: 'thinking_tokens', value: num(obj.estimated_tokens) ?? undefined }]
  }

  // hook_started / hook_response 等 —— 保留原文,UI 归入诊断区折叠展示
  return [{ k: 'raw', ts, payload: obj }]
}

function normalizeAssistant(obj: Rec, ts: number): NodeEvent[] {
  const message = rec(obj.message)
  const content = message?.content
  if (!Array.isArray(content)) {
    // 有的版本 assistant.message.content 直接是字符串
    const s = str(content)
    return s ? [{ k: 'text', ts, text: s }] : [{ k: 'raw', ts, payload: obj }]
  }

  const out: NodeEvent[] = []
  for (const block of content) {
    const ev = normalizeContentBlock(block, ts)
    if (ev) out.push(ev)
  }
  // ⚠️ 这里**不能**用"out 为空就兜底成 raw"。
  // 实测 claude 会吐出 thinking 为空串的块({"thinking":"","signature":"..."}),
  // 那种块应当静默丢弃。未知块类型在 normalizeContentBlock 内部已经各自吐过 raw 了,
  // 在外面再兜一次只会给每条空 thinking 消息都加一个"未识别事件"气泡。
  return out
}

function normalizeUser(obj: Rec, ts: number): NodeEvent[] {
  const message = rec(obj.message)
  const content = message?.content
  if (!Array.isArray(content)) return [{ k: 'raw', ts, payload: obj }]

  const out: NodeEvent[] = []
  for (const block of content) {
    const ev = normalizeContentBlock(block, ts)
    // user 消息里的 text 块是回显,不重复渲染
    if (ev && ev.k !== 'text') out.push(ev)
  }
  return out.length > 0 ? out : []
}

function normalizeResult(obj: Rec, ts: number): NodeEvent[] {
  const isError = obj.is_error === true
  const result = str(obj.result)

  // subtype 可能是 success / error_max_turns / error_during_execution
  const subtype = str(obj.subtype)
  const failed = isError || (subtype !== undefined && subtype !== 'success')

  return [
    {
      k: 'result',
      ts,
      text: result ?? null,
      sessionId: str(obj.session_id) ?? null,
      costUsd: num(obj.total_cost_usd),
      durationMs: num(obj.duration_ms),
      isError: failed,
    },
  ]
}

/**
 * 一个原始对象可能展开成多个事件 —— assistant 消息的 content 数组里
 * 常常同时有 thinking / text / tool_use 三种块。
 */
export function normalizeClaudeEvent(obj: unknown, ts = Date.now()): NodeEvent[] {
  try {
    const o = rec(obj)
    if (!o) return [{ k: 'raw', ts, payload: obj }]

    const type = str(o.type)
    switch (type) {
      case 'system':
        return normalizeSystem(o, ts)
      case 'assistant':
        return normalizeAssistant(o, ts)
      case 'user':
        return normalizeUser(o, ts)
      case 'result':
        return normalizeResult(o, ts)
      default:
        // 未知类型 —— 原样保留,这是抗版本漂移的关键
        return [{ k: 'raw', ts, payload: obj }]
    }
  } catch {
    return [{ k: 'raw', ts, payload: obj }]
  }
}

/** 从原始事件里提取权威 session id(以 claude 回传的为准,不完全信自己生成的) */
export function extractClaudeSessionId(obj: unknown): string | null {
  try {
    const o = rec(obj)
    if (!o) return null
    return str(o.session_id) ?? null
  } catch {
    return null
  }
}
