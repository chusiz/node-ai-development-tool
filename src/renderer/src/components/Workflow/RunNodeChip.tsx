import type { JSX } from 'react'
import { useNodeRunStatus } from '../../stores/workflowStore'
import type { RunNodeStatus } from '../../../../shared/workflow'

const LABEL: Record<RunNodeStatus, { cls: string; text: string }> = {
  queued: { cls: '', text: '排队' },
  waiting: { cls: '', text: '等待上游' },
  running: { cls: 'warn', text: '运行中' },
  done: { cls: 'ok', text: '完成' },
  failed: { cls: 'err', text: '失败' },
  skipped: { cls: '', text: '已跳过' },
  cancelled: { cls: '', text: '已取消' },
}

/**
 * 节点上的"这次运行里的状态"。
 *
 * 与 NodeStatusBadge(会话状态)是两件事,刻意分开:
 * 会话可以还在(上一轮聊完停在那儿,status = done),而这次运行里它可能是 queued。
 * 合成一个徽标就得写优先级规则,而"这个节点现在到底在干嘛"会变得说不清。
 *
 * 只订阅**状态字符串** —— 每次推送都会重建整份 RunState,订阅对象的话
 * 画布上每个节点都会重渲染一次。
 */
export function RunNodeChip({ nodeId }: { nodeId: string }): JSX.Element | null {
  const status = useNodeRunStatus(nodeId)
  if (!status) return null

  const m = LABEL[status]
  return (
    <span className={`badge run-chip ${m.cls}`} title={`本次运行:${m.text}`}>
      <span className={`dot ${status === 'running' ? 'pulse' : ''}`} />
      {m.text}
    </span>
  )
}
