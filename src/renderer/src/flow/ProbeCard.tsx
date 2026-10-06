import type { JSX } from 'react'
import { useGraphStore } from '../stores/graphStore'
import { useNodeRunState } from '../stores/workflowStore'
import { getNodeType } from '../../../shared/nodeRegistry'
import { NodeIcon } from '../components/Icons'
import type { RunNodeStatus } from '../../../shared/workflow'

/**
 * 悬停探针(Noodl 式的数据预览):悬停连线 = 看**上游节点**交出了什么;
 * 悬停节点 = 看它自己的产出。全文在节点日志里,这里只给开头 ——
 * 探针回答的是"这条线里流的是什么",不是"逐字读它"。
 *
 * ## 为什么「没跑过就不显示」
 *
 * 没有运行记录时返回 null(连浮层都不出现):鼠标扫过画布是常态,
 * 每个未运行的节点都弹一个「还没跑过」只会挡视线。探针是**调试工具**,
 * 它只在真的有东西可看时才存在。
 */

const STATUS_TEXT: Record<RunNodeStatus, string> = {
  queued: '排队中',
  waiting: '等上游',
  running: '运行中',
  done: '完成',
  failed: '失败',
  skipped: '已跳过',
  cancelled: '已取消',
}

export interface ProbeTarget {
  nodeId: string
  /** 屏幕坐标(事件发生时的指针位置),浮层挂在指针右下角 */
  x: number
  y: number
}

export function ProbeCard({ nodeId, x, y }: ProbeTarget): JSX.Element | null {
  // 三个订阅都返回稳定类型(对象引用 / 字符串),push 一次最多重渲染一个浮层
  const title = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId)?.data.title)
  const kind = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId)?.type)
  const state = useNodeRunState(nodeId)

  if (!state || state.status === 'queued' || state.status === 'waiting') return null

  const def = kind ? getNodeType(kind) : null
  const pos = {
    left: Math.min(x + 16, Math.max(8, window.innerWidth - 356)),
    top: Math.min(y + 16, Math.max(8, window.innerHeight - 220)),
  }

  return (
    <div className="probe-pop" style={pos} role="status">
      <div className="probe-head">
        <span className="probe-title">{title ?? nodeId}</span>
        {def && (
          <span className={`node-kind-badge ${def.badge.cls}`} title={def.badge.title ?? def.badge.text}>
            <NodeIcon name={def.badge.icon} />
            {def.badge.text}
          </span>
        )}
        <span className={`probe-status st-${state.status}`}>{STATUS_TEXT[state.status]}</span>
      </div>
      <pre className="probe-body">
        {state.error
          ? `失败:${state.error}`
          : (state.outputPreview ??
            (state.status === 'running' ? '运行中 —— 完成后这里能看到产出的开头' : '这次运行没有留下产出预览'))}
      </pre>
      {state.artifacts && state.artifacts.length > 0 && (
        <div className="probe-foot">产出 {state.artifacts.length} 个文件(全文见节点对话)</div>
      )}
    </div>
  )
}
