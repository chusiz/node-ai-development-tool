import type { LimitSettings, NodeEvent, PersistedRecord, SessionStatus } from '../types'

/** 消息流里的一条。key 用 seq 拼 —— seq 由主进程保证逐节点唯一且单调 */
export type Item = {
  key: string
  seq: number
  ts: number
  rec: PersistedRecord
}

/** 一个节点的运行时状态。**不含任何画布配置**(那是 graphStore 的事) */
export type NodeRuntime = {
  nodeId: string
  sessionId: string | null
  turns: number
  status: SessionStatus
  model: string | null
  lastCostUsd: number | null
  lastDurationMs: number | null
  /** 主消息流 */
  items: Item[]
  /** 未识别的原始事件。默认折叠,不进主流视线 */
  diagnostics: Item[]
  stderrTail: string[]
  /** 因为超过 maxItemsPerNode 被从头折叠掉的条数 */
  trimmed: number
  error: string | null
  /** 收到过的最大 seq。重复投递/回放时用它去重 */
  maxSeq: number
}

/**
 * 唯一的初始值来源。
 *
 * 所有"重置"都走这里整体替换,而不是逐字段手写 ——
 * 那样的话「newSession 忘记重置 model」这类 bug **在结构上不可能发生**。
 */
export function emptyRuntime(nodeId: string): NodeRuntime {
  return {
    nodeId,
    sessionId: null,
    turns: 0,
    status: 'idle',
    model: null,
    lastCostUsd: null,
    lastDurationMs: null,
    items: [],
    diagnostics: [],
    stderrTail: [],
    trimmed: 0,
    error: null,
    maxSeq: 0,
  }
}

export const itemOf = (rec: PersistedRecord): Item => ({
  key: `s${rec.seq}`,
  seq: rec.seq,
  ts: rec.ts,
  rec,
})

/** raw 事件与诊断记录不进消息流 */
export function isDiagnostic(rec: PersistedRecord): boolean {
  if (rec.t === 'diag') return true
  return rec.t === 'event' && rec.ev.k === 'raw'
}

/**
 * 按上限裁剪超大文本。
 *
 * 在**入 store 之前**同步做掉,不是渲染时才截 —— 渲染时截的话,整个字符串
 * 已经躺在内存里了,省内存的目的就落空了(这正是改造前最大的内存黑洞)。
 * 落盘那份由主进程在写盘前外溢,这里是渲染进程侧的第二道闸。
 */
export function clampEvent(ev: NodeEvent, limits: LimitSettings): NodeEvent {
  switch (ev.k) {
    case 'text':
      return ev.text.length > limits.maxResultChars
        ? { ...ev, text: `${ev.text.slice(0, limits.maxResultChars)}\n… (已截断)` }
        : ev
    case 'thinking':
      return ev.text.length > limits.maxThinkingChars
        ? { ...ev, text: `${ev.text.slice(0, limits.maxThinkingChars)}\n… (已截断)` }
        : ev
    case 'tool_result':
      return ev.content.length > limits.maxToolResultChars
        ? { ...ev, content: `${ev.content.slice(0, limits.maxToolResultChars)}\n… (已截断)` }
        : ev
    case 'result':
      return ev.text && ev.text.length > limits.maxResultChars
        ? { ...ev, text: `${ev.text.slice(0, limits.maxResultChars)}\n… (已截断)` }
        : ev
    default:
      return ev
  }
}
