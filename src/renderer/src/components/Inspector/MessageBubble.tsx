import { useState, type JSX } from 'react'
import type { NodeEvent, PersistedRecord } from '../../types'

/**
 * 一条消息。
 *
 * 外溢过的大内容(`_blob`)默认只显示预览 + 一个「展开」——
 * 全文要点一下才从磁盘取回来,不点就永远不进内存。
 * 这正是当初那个"10MB tool_result 直接进渲染进程"的内存黑洞的解法。
 */
export function MessageBubble({
  rec,
  canvasId,
}: {
  rec: PersistedRecord
  canvasId: string
}): JSX.Element | null {
  if (rec.t === 'user') {
    return (
      <div className="bubble user">
        <div className="who">你</div>
        <div className="txt">{rec.text}</div>
      </div>
    )
  }

  if (rec.t === 'notice') {
    return (
      <div className={`bubble notice ${rec.level}`}>
        <div className="txt">{rec.text}</div>
      </div>
    )
  }

  if (rec.t === 'diag') {
    return (
      <details className="rawline">
        <summary>
          <span className="tag">诊断</span>
          {rawLabel(rec.payload)}
        </summary>
        <pre className="code">{safeJson(rec.payload)}</pre>
      </details>
    )
  }

  return <EventBubble ev={rec.ev} meta={rec} canvasId={canvasId} />
}

function EventBubble({
  ev,
  meta,
  canvasId,
}: {
  ev: NodeEvent
  meta: PersistedRecord
  canvasId: string
}): JSX.Element | null {
  switch (ev.k) {
    case 'init':
      return (
        <div className="bubble">
          <div className="who">会话已建立</div>
          <div className="result-bar">
            <span>sid: {ev.sessionId.slice(0, 8)}…</span>
            {ev.model && <span>model: {ev.model}</span>}
            {ev.tools && <span>tools: {ev.tools.length}</span>}
          </div>
        </div>
      )

    case 'text':
      return (
        <div className="bubble">
          <div className="who">claude</div>
          <div className="txt">{ev.text}</div>
        </div>
      )

    case 'thinking':
      return (
        <div className="bubble thinking">
          <div className="who">思考</div>
          <div className="txt">{ev.text}</div>
        </div>
      )

    case 'tool_use':
      return (
        <div className="bubble tool">
          <div className="who">调用工具 · {ev.name}</div>
          <pre className="code">{safeJson(ev.input)}</pre>
        </div>
      )

    case 'tool_result':
      return (
        <div className={`bubble tool-result ${ev.isError ? 'is-error' : ''}`}>
          <div className="who">
            工具结果{ev.isError ? ' (错误)' : ''}
            {meta._truncated && <TruncNote meta={meta} canvasId={canvasId} />}
          </div>
          <div className="txt">{ev.content || '(空)'}</div>
        </div>
      )

    case 'result':
      return (
        <div className="bubble">
          <div className="who">本轮结束</div>
          <div className="result-bar">
            <span className={ev.isError ? 'badge err' : 'badge ok'}>
              <span className="dot" />
              {ev.isError ? '异常' : '成功'}
            </span>
            {ev.durationMs != null && <span>{(ev.durationMs / 1000).toFixed(1)}s</span>}
            {ev.costUsd != null && <span>${ev.costUsd.toFixed(5)}</span>}
          </div>
        </div>
      )

    case 'error':
      return (
        <div className="bubble error">
          <div className="who">错误</div>
          <div className="txt">{ev.message}</div>
        </div>
      )

    case 'raw':
      return (
        <details className="rawline">
          <summary>
            <span className="tag">诊断</span>
            {rawLabel(ev.payload)}
          </summary>
          <pre className="code">{safeJson(ev.payload)}</pre>
        </details>
      )

    default:
      return null
  }
}

/** 被外溢的记录:显示"折叠了多少",并提供按需取回全文 */
function TruncNote({ meta, canvasId }: { meta: PersistedRecord; canvasId: string }): JSX.Element | null {
  const [full, setFull] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!meta._blob) return null

  const load = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.api.session.blob(canvasId, meta._blob as string)
      if (res.ok) setFull(res.data)
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="trunc">
      <span className="badge warn">
        已折叠 {Math.round((meta._bytes ?? 0) / 1024)}KB
      </span>
      {full === null ? (
        <button className="mini" onClick={() => void load()} disabled={busy}>
          {busy ? '读取中…' : '展开'}
        </button>
      ) : (
        <button className="mini" onClick={() => setFull(null)}>
          收起
        </button>
      )}
      {full !== null && <pre className="code full">{full}</pre>}
    </span>
  )
}

function rawLabel(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const o = payload as Record<string, unknown>
    const t = typeof o.type === 'string' ? o.type : 'unknown'
    const s = typeof o.subtype === 'string' ? ` / ${o.subtype}` : ''
    const h = typeof o.hook_name === 'string' ? ` · ${o.hook_name}` : ''
    return `${t}${s}${h}`
  }
  return '非 JSON 行'
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v, null, 2)
    return s.length > 4000 ? s.slice(0, 4000) + '\n… (已截断)' : s
  } catch {
    return String(v)
  }
}
