import type { NodeEvent } from './events'

/**
 * 会话日志的单条记录 —— 主进程与渲染进程**共用同一份定义**。
 *
 * ## 为什么 seq 由主进程赋值
 *
 * 用户消息也由主进程写入并广播,渲染进程**不做乐观插入**,只是纯粹地镜像。
 * 这一刀砍掉了整类"乐观 UI 与真实日志不一致"的 bug:重复气泡、
 * seq 冲突、刷新后顺序错乱 —— 那些都源于两处各自维护一份顺序。
 */
export type LogRecord =
  /** 用户发的话。由主进程在 session.start() 里写入 */
  | { seq: number; ts: number; t: 'user'; text: string }
  /** agent 的归一化事件 */
  | { seq: number; ts: number; t: 'event'; ev: NodeEvent }
  /** 诊断用,不进主消息流(未识别的原始事件等) */
  | { seq: number; ts: number; t: 'diag'; payload: unknown }
  /** 应用自己发的提示(降级、截断、重试等),用户可见 */
  | { seq: number; ts: number; t: 'notice'; level: 'info' | 'warn' | 'error'; text: string }

export type LogRecordKind = LogRecord['t']

/**
 * 落盘形态:在 LogRecord 之上,大内容被换成内容寻址的引用。
 *
 * 外溢发生在**写盘之前**,而且广播出去的也必须是截断版 ——
 * 否则一个 10MB 的 tool_result 会原样冲进 IPC 和渲染进程内存。
 * 这是当前实测最大的内存黑洞。
 */
export type PersistedRecord = LogRecord & {
  /** blobs/<_blob>.txt 的内容寻址引用 */
  _blob?: string
  /** 未截断前的原始字符数,UI 用它显示"已折叠 N 字符" */
  _bytes?: number
  _truncated?: boolean
}

/**
 * 磁盘上 meta.json 里渲染进程用得着的那几个字段。
 *
 * 不直接复用主进程的 `NodeMeta`:那个类型定义在 main/persist/nodeLog.ts,
 * 它 import 了 node:fs —— 让 shared 去依赖它会把 fs 拖进渲染进程的编译图。
 * 这里只挑 UI 需要的,主进程负责映射。
 */
export interface NodeMetaSnapshot {
  /** 权威 sessionId。**跨重启续接上下文全靠它** —— 丢了就只能开新会话 */
  sessionId: string | null
  turns: number
  status: string
  model: string | null
  lastCostUsd: number | null
  lastDurationMs: number | null
  lastSeq: number
}

/** 从记录里取出可渲染的文本(用于产出提取、预览等) */
export function recordText(rec: LogRecord): string {
  switch (rec.t) {
    case 'user':
      return rec.text
    case 'notice':
      return rec.text
    case 'event':
      switch (rec.ev.k) {
        case 'text':
          return rec.ev.text
        case 'thinking':
          return rec.ev.text
        case 'result':
          return rec.ev.text ?? ''
        case 'error':
          return rec.ev.message
        default:
          return ''
      }
    default:
      return ''
  }
}
