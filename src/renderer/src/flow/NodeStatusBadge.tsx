import type { JSX } from 'react'
import { useLiveStore, useRuntimeStore } from '../stores/runtimeStore'
import type { SessionStatus } from '../types'

const LABEL: Record<SessionStatus, { cls: string; text: string }> = {
  idle: { cls: '', text: '空闲' },
  running: { cls: 'warn', text: '运行中' },
  done: { cls: 'ok', text: '完成' },
  error: { cls: 'err', text: '出错' },
  timeout: { cls: 'err', text: '超时' },
  killed: { cls: '', text: '已取消' },
  skipped: { cls: '', text: '已跳过' },
  interrupted: { cls: 'warn', text: '被中断' },
}

/**
 * 独立订阅运行时状态。
 *
 * 拆成单独组件是刻意的:状态每次变都只重渲染这个小徽标,
 * 而不是让整个 AgentNode(进而整个 React Flow 节点索引)重算。
 */
export function NodeStatusBadge({ nodeId }: { nodeId: string }): JSX.Element {
  // 两个 store 分开订阅 —— 高频进度不会带着状态一起重渲染
  const status = useRuntimeStore((s) => s.runtimes[nodeId]?.status ?? 'idle')
  const cost = useRuntimeStore((s) => s.runtimes[nodeId]?.lastCostUsd ?? null)
  const live = useLiveStore((s) => s.progress[nodeId] ?? null)

  const m = LABEL[status]
  return (
    <span className="node-status">
      {live && status === 'running' ? (
        <span className="live-mini" title={live.label}>
          <span className="dot pulse" />
        </span>
      ) : (
        <span className={`badge ${m.cls}`} title={cost != null ? `上一轮 $${cost.toFixed(5)}` : ''}>
          <span className={`dot ${status === 'running' ? 'pulse' : ''}`} />
          {m.text}
        </span>
      )}
    </span>
  )
}
