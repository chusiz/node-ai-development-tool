import type { JSX } from 'react'
import { useNodeRunStatus } from '../../stores/workflowStore'
import type { RunNodeStatus } from '../../../../shared/workflow'
import { t } from '../../lib/i18n'

const LABEL: Record<RunNodeStatus, { cls: string; textKey: string }> = {
  queued: { cls: '', textKey: 'run.node.queued' },
  waiting: { cls: '', textKey: 'run.node.waiting' },
  running: { cls: 'warn', textKey: 'run.node.running' },
  done: { cls: 'ok', textKey: 'run.node.done' },
  failed: { cls: 'err', textKey: 'run.node.failed' },
  skipped: { cls: '', textKey: 'run.node.skipped' },
  cancelled: { cls: '', textKey: 'run.node.cancelled' },
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
  const text = t(m.textKey)
  return (
    <span className={`badge run-chip ${m.cls}`} title={`${t('run.statusPrefix')}:${text}`}>
      <span className={`dot ${status === 'running' ? 'pulse' : ''}`} />
      {text}
    </span>
  )
}
