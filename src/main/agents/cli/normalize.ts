import type { NodeEvent } from '../../../shared/events'

/**
 * Codex CLI 与 Gemini CLI 的原始报文 → 统一 NodeEvent。
 *
 * 两份 schema 都是照各自官方文档写的(2026-10 时点),不是猜的:
 *
 * **`codex exec --json`**(JSONL,stdout)
 * ```
 * {"type":"thread.started","thread_id":"…"}
 * {"type":"turn.started"}
 * {"type":"item.started","item":{"id":"…","type":"command_execution","command":"…","status":"in_progress"}}
 * {"type":"item.completed","item":{"id":"…","type":"agent_message","text":"…"}}
 * {"type":"item.completed","item":{"id":"…","type":"reasoning","text":"…"}}
 * {"type":"item.completed","item":{"id":"…","type":"command_execution","aggregated_output":"…","exit_code":0,"status":"completed"}}
 * {"type":"turn.completed","usage":{…}}
 * {"type":"turn.failed","error":{"message":"…"}}
 * ```
 *
 * **`gemini -p … --output-format stream-json`**(JSONL,stdout)
 * ```
 * {"type":"init","session_id":"…","model":"…"}
 * {"type":"message","role":"assistant","content":"…","delta":true}
 * {"type":"tool_use","tool_name":"Bash","tool_id":"…","parameters":{…}}
 * {"type":"tool_result","tool_id":"…","status":"success","output":"…"}
 * {"type":"result","status":"success","stats":{…}}
 * {"type":"error","message":"…"}
 * ```
 *
 * ⚠️ 两家都**没有 schema 版本号**(Codex 的文档自己就写了 "There is currently
 * no schema version indicator")。所以这里的策略必须是**宽容**:认识的类型精确
 * 处理,不认识的一律 `raw` 原样保留(在诊断面板里能看到),**永不抛异常**。
 * 厂商加一个新 item type 时,表现只会是"那个新东西暂时不显示",
 * 而不是整条会话崩掉。
 */

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/* ---------------- Codex ---------------- */

export function normalizeCodexEvent(obj: unknown, ts = Date.now()): NodeEvent[] {
  if (!obj || typeof obj !== 'object') return []
  const o = obj as Record<string, any>
  const type = str(o.type)

  switch (type) {
    case 'thread.started':
      // sessionId 由 extractCodexSessionId 取;这里不产生事件(与 Claude 一致:
      // init 事件负责展示,raw 是给诊断留的)
      return [{ k: 'raw', ts, payload: obj }]

    case 'turn.started':
      return []

    case 'turn.completed': {
      const u = o.usage ?? {}
      return [
        {
          k: 'progress',
          ts,
          label: `tokens 输入 ${u.input_tokens ?? '?'} / 输出 ${u.output_tokens ?? '?'}`,
        },
      ]
    }

    case 'turn.failed':
      return [{ k: 'error', ts, message: str(o.error?.message) || '本轮失败' }]

    case 'error':
      /*
       * ⚠️ Codex 会把「Reconnecting... 1/5」这种重连提示也发成 type=error。
       * 把它们当致命错误报出来,用户会以为跑挂了,而实际上那一轮还在继续。
       * 所以含 reconnect 字样的降级成 progress。
       */
      if (/reconnect/i.test(str(o.message))) {
        return [{ k: 'progress', ts, label: str(o.message) }]
      }
      return [{ k: 'error', ts, message: str(o.message) }]

    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      return codexItem(o, type, ts)

    default:
      return [{ k: 'raw', ts, payload: obj }]
  }
}

function codexItem(o: Record<string, any>, type: string, ts: number): NodeEvent[] {
  const it = o.item
  if (!it || typeof it !== 'object') return [{ k: 'raw', ts, payload: it }]
  const itemType = str(it.type) || str(it.item_type) // 老版本叫 item_type(见下面的注释)
  const id = str(it.id)

  switch (itemType) {
    case 'agent_message':
    // 老版本(pre-0.44.0)叫 assistant_message,一起认
    case 'assistant_message':
      // 只在 completed 时输出。started 时 text 还是空的,发出去会多一个空气泡
      return type === 'item.completed' ? [{ k: 'text', ts, text: str(it.text) }] : []

    case 'reasoning':
      return type === 'item.completed' ? [{ k: 'thinking', ts, text: str(it.text) }] : []

    case 'command_execution':
      if (type === 'item.started') {
        return [{ k: 'tool_use', ts, id, name: 'shell', input: { command: it.command } }]
      }
      if (type === 'item.completed') {
        return [
          {
            k: 'tool_result',
            ts,
            toolUseId: id,
            content: str(it.aggregated_output) || '(无输出)',
            // exit_code 在未完成时是 null,不能把 null 当成功
            isError: typeof it.exit_code === 'number' && it.exit_code !== 0,
          },
        ]
      }
      return []

    case 'file_change': {
      if (type !== 'item.completed') return []
      const changes = Array.isArray(it.changes) ? it.changes : []
      const summary = changes
        .map((c: any) => `${str(c?.kind) || 'change'}  ${str(c?.path)}`)
        .join('\n')
      // 文件改动在 Codex 那边是一个"已完成"的 item,没有 started 阶段,
      // 所以这里同时补一条 tool_use 和一条 tool_result,让界面上的
      // 「调用 → 结果」这对结构保持完整(否则会看到一个没有来源的结果)
      return [
        { k: 'tool_use', ts, id, name: 'file_change', input: { changes } },
        {
          k: 'tool_result',
          ts,
          toolUseId: id,
          content: summary || '(无改动)',
          isError: it.status === 'failed',
        },
      ]
    }

    case 'mcp_tool_call': {
      if (type === 'item.started') {
        return [
          {
            k: 'tool_use',
            ts,
            id,
            name: `${str(it.server)}:${str(it.tool)}`,
            input: it.arguments ?? {},
          },
        ]
      }
      if (type === 'item.completed') {
        const blocks = it.result?.content
        const text = Array.isArray(blocks)
          ? blocks.map((b: any) => str(b?.text)).filter(Boolean).join('\n')
          : JSON.stringify(it.result ?? it.error ?? {})
        return [
          {
            k: 'tool_result',
            ts,
            toolUseId: id,
            content: text || '(无内容)',
            isError: !!it.error || it.status === 'failed',
          },
        ]
      }
      return []
    }

    case 'web_search':
      return type === 'item.completed'
        ? [{ k: 'tool_use', ts, id, name: 'web_search', input: { query: it.query } }]
        : []

    case 'todo_list': {
      if (type === 'item.started' || type === 'item.updated') {
        const items = Array.isArray(it.items) ? it.items : []
        const done = items.filter((x: any) => x?.completed).length
        return [{ k: 'progress', ts, label: `待办 ${done}/${items.length}` }]
      }
      return []
    }

    case 'error':
      return [{ k: 'error', ts, message: str(it.message) }]

    default:
      return [{ k: 'raw', ts, payload: o }]
  }
}

export function extractCodexSessionId(obj: unknown): string | null {
  const o = obj as Record<string, any> | null
  if (o && o.type === 'thread.started' && typeof o.thread_id === 'string') return o.thread_id
  return null
}

/* ---------------- Gemini ---------------- */

export function normalizeGeminiEvent(obj: unknown, ts = Date.now()): NodeEvent[] {
  if (!obj || typeof obj !== 'object') return []
  const o = obj as Record<string, any>

  switch (str(o.type)) {
    case 'init':
      return [{ k: 'raw', ts, payload: obj }]

    case 'message': {
      // 用户那条也会回显一次(我们自己已经落过盘了),跳过避免重复
      if (str(o.role) !== 'assistant') return []
      return [{ k: 'text', ts, text: str(o.content) }]
    }

    case 'tool_use':
      return [
        {
          k: 'tool_use',
          ts,
          id: str(o.tool_id),
          name: str(o.tool_name) || 'tool',
          input: o.parameters ?? {},
        },
      ]

    case 'tool_result':
      return [
        {
          k: 'tool_result',
          ts,
          toolUseId: str(o.tool_id),
          content: str(o.output) || str(o.error) || '(无输出)',
          isError: str(o.status) !== 'success',
        },
      ]

    case 'result': {
      const stats = o.stats ?? {}
      return [
        {
          k: 'result',
          ts,
          text: null,
          sessionId: null,
          costUsd: typeof stats.total_cost_usd === 'number' ? stats.total_cost_usd : null,
          durationMs: typeof stats.duration_ms === 'number' ? stats.duration_ms : null,
          isError: str(o.status) !== 'success',
        },
      ]
    }

    case 'error':
      return [{ k: 'error', ts, message: str(o.message) || 'Gemini CLI 报错' }]

    default:
      return [{ k: 'raw', ts, payload: obj }]
  }
}

export function extractGeminiSessionId(obj: unknown): string | null {
  const o = obj as Record<string, any> | null
  if (o && o.type === 'init' && typeof o.session_id === 'string') return o.session_id
  return null
}

/* ---------------- 纯文本 CLI ---------------- */

/**
 * 只吐文本的 CLI(如 Aider)的兜底解析。
 *
 * 按行发 text 事件。这类 CLI 没有事件流、没有工具调用可见性 ——
 * 它的价值只是"能接上",而不是"体验好"。所以这里不做任何花哨的合并,
 * 让渲染侧统一的相邻文本合并逻辑去处理就行。
 */
export function plainTextEvents(chunk: string, ts = Date.now()): NodeEvent[] {
  const t = chunk.replace(/\r$/, '')
  if (!t.trim()) return []
  return [{ k: 'text', ts, text: t }]
}
