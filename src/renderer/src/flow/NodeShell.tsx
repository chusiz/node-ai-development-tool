import { useRef, useState, type JSX, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useRuntimeStore } from '../stores/runtimeStore'
import { useGraphStore } from '../stores/graphStore'
import { useNodeRunStatus, useWorkflowStore } from '../stores/workflowStore'
import { useUiStore } from '../stores/uiStore'
import { deleteNodeWithConfirm } from '../lib/nodeOps'
import { NodeStatusBadge } from './NodeStatusBadge'
import { RunNodeChip } from '../components/Workflow/RunNodeChip'
import { Icon, NodeIcon } from '../components/Icons'
import type { NodeIconName } from '../../../shared/nodeRegistry'
import type { AgentFlowNode } from '../stores/graphStore'

/** 节点悬停多久后才弹数据探针 —— 扫过画布不算悬停 */
const PROBE_HOVER_MS = 400

/**
 * 四种类型节点(project / feature / merge / output)共用的外壳。
 *
 * ## 为什么抽外壳而不是四份拷贝
 *
 * 节点头部(就地改名 / 运行徽标 / 会话徽标 / 删除)、meta 行、单节点运行按钮
 * 在四种节点上是**完全一样**的 —— 四份拷贝意味着改一处要同步四处,而这里
 * 恰恰是交互细节最多、最容易改漏的地方(参考下面的 nodrag / stopPropagation 注释)。
 * 各类型的差异全部收敛到 props:端口布局、类型角标、meta 区内容、正文行。
 *
 * ⚠️ 用 `memo` 且**只吃 props** —— 运行时状态由内部的徽标组件自己订阅。
 * 如果把 status/最后一行文本塞进 node.data,每次流式增量都会重建整个 nodes 数组,
 * React Flow 就会全量重算所有 handle 位置,拖动直接掉帧。
 */

/**
 * 节点上显示的"最后一行"。全文在 Inspector 里看,这里只给一行规模感。
 *
 * 会话记录(user / event)与打包日志(notice)统一取最后一个可见条目:
 * 输出节点没有会话,它的"最后一行"就是打包进度/产物路径 —— 那是 notice 记录。
 */
export function useNodeLastLine(nodeId: string): string | null {
  return useRuntimeStore((s) => {
    const items = s.runtimes[nodeId]?.items
    if (!items || items.length === 0) return null
    for (let i = items.length - 1; i >= 0; i--) {
      const rec = items[i].rec
      if (rec.t === 'user') return `你:${rec.text.split('\n')[0]}`
      if (rec.t === 'notice') return rec.text.split('\n')[0]
      if (rec.t === 'event') {
        const ev = rec.ev
        if (ev.k === 'text') return ev.text.split('\n').filter(Boolean).slice(-1)[0] ?? null
        if (ev.k === 'tool_use') return `→ ${ev.name}`
        // 用文字前缀而不是 ⚠ 之类的符号:这一行是**正文**,旁边没有图标位,
        // 混进一个符号会和上下行的字重/基线打架
        if (ev.k === 'error') return `出错:${ev.message}`
      }
    }
    return null
  })
}

/**
 * 上游是谁。这是"连线的意义"在界面上的**唯一线索** ——
 * 不显示的话用户只能靠记住自己拉了哪几条线,而图一大就记不住了。
 *
 * 只取标题字符串(拼起来比较),不订阅整份 edges 数组,
 * 否则拉一条新线会让所有节点重渲染。
 */
export function useUpstreamKey(nodeId: string): string {
  return useGraphStore((s) =>
    s.edges
      .filter((e) => e.target === nodeId)
      .map((e) => s.nodes.find((n) => n.id === e.source)?.data.title ?? e.source)
      .join('、'),
  )
}

/**
 * 从节点上直接删掉它 —— 「这个功能不行,叉掉不要」。
 *
 * 确认与中断的细节在 `lib/nodeOps.deleteNodeWithConfirm` 里 ——
 * 画布工具条、键盘 Delete 也走同一份,免得三处的确认文案各说各话。
 */

/** 类型角标的形状。cls 控制颜色(串行蓝 / 并行橙 / 整合紫 / 输出绿…) */
export interface KindBadge {
  /** 图标名(来自注册表的 badge.icon)。纯文字角标可省略 */
  icon?: NodeIconName
  text: string
  cls: string
  title?: string
}

export interface NodeShellProps {
  /** React Flow 节点 props 里的 id / selected,由薄组件透传 */
  id: string
  selected?: boolean
  /** 类型角标(项目/串行/并行/整合/输出) */
  badge: KindBadge
  /** 端口布局:project 无 target、output 无 source(P0-2) */
  hasTargetHandle: boolean
  hasSourceHandle: boolean
  /** meta 区(标题下、正文上):目录行 / 打包目标等,各类型自定 */
  meta?: ReactNode
  /**
   * 正文上方的自定义区块(可选)。目前只有图像节点用:放缩略图网格。
   * 加插槽而不是把网格塞进 meta —— meta 是 flex 行,网格需要整行铺开。
   * 可选 prop,对其余类型零影响。
   */
  extra?: ReactNode
  /** 正文行(最后一行对话 / 打包进度)。null 时给空态占位 */
  line?: ReactNode
  /** 上游提示文字;空串/undefined = 不显示(project 不显示) */
  upstream?: string | null
  /** 骨架根类名(各类型加自己的修饰类,如 kind-parallel) */
  kindClass?: string
}

export function NodeShell({
  id,
  selected,
  badge,
  hasTargetHandle,
  hasSourceHandle,
  meta,
  extra,
  line,
  upstream,
  kindClass,
}: NodeShellProps): JSX.Element {
  const lastLine = useNodeLastLine(id)
  const upstreamKey = useUpstreamKey(id)

  /*
   * 标题单独订阅(返回字符串,走 Object.is)—— 改名要立刻反映在卡片上,
   * 而订阅整个 nodes 数组的话,任何节点动一下这里都会重渲染。
   */
  const title = useGraphStore((s) => s.nodes.find((n) => n.id === id)?.data.title ?? id)

  // 双击标题就地改名
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const commitRename = (): void => {
    setEditing(false)
    const next = draft.trim()
    // 空名字会让节点在画布上变成一片空白,没法再选中它 —— 空则视为放弃修改
    if (!next || next === title) return
    useGraphStore.getState().patchConfig(id, { title: next })
  }

  const status = useNodeRunStatus(id)
  const runBusy = status === 'running' || status === 'queued' || status === 'waiting'

  /*
   * 数据探针(悬停 400ms):看这个节点自己最近交出了什么。
   * 定时器放 ref:拖动 / 重渲染不该把它重置。没跑过的节点由 ProbeCard
   * 自己不显示 —— 这里不判断,免得两处规则漂移。
   */
  const probeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onProbeEnter = (e: ReactMouseEvent): void => {
    const { clientX, clientY } = e
    if (probeTimer.current) clearTimeout(probeTimer.current)
    probeTimer.current = setTimeout(() => {
      probeTimer.current = null
      useUiStore.getState().setProbe({ nodeId: id, x: clientX, y: clientY })
    }, PROBE_HOVER_MS)
  }
  const onProbeLeave = (): void => {
    if (probeTimer.current) {
      clearTimeout(probeTimer.current)
      probeTimer.current = null
    }
    useUiStore.getState().setProbe(null)
  }

  return (
    <div
      className={`agent-node ${kindClass ?? ''} ${selected ? 'is-selected' : ''}`}
      onMouseEnter={onProbeEnter}
      onMouseLeave={onProbeLeave}
    >
      {/* 上游入线。project 没有(它是源头) */}
      {hasTargetHandle && <Handle type="target" position={Position.Left} className="rf-handle" />}

      <header className="agent-node-head">
        {badge && (
          <span className={`node-kind-badge ${badge.cls}`} title={badge.title ?? badge.text}>
            <NodeIcon name={badge.icon} />
            {badge.text}
          </span>
        )}
        {/*
          双击标题就地改名。
          节点名是画布上唯一的「这块功能叫什么」,而改它之前只能选中节点、
          跑到右栏配置页去找「节点名」那一栏 —— 改个名字要跑三个地方。
          ⚠️ 双击必须 stopPropagation:React Flow 默认在双击时缩放画布,
          不拦住的话改名的同时整个画布会缩一下。
        */}
        {editing ? (
          <input
            /*
             * nodrag/nopan 是 React Flow 认的类:不加的话在输入框里拖动
             * 会把整个节点拖走、选中文字变成平移画布,根本改不了名
             */
            className="agent-node-rename nodrag nopan"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setEditing(false)
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className="agent-node-title"
            title={`${title}\n(双击改名)`}
            onDoubleClick={(e) => {
              e.stopPropagation()
              setDraft(title)
              setEditing(true)
            }}
          >
            {title}
          </span>
        )}
        <RunNodeChip nodeId={id} />
        <NodeStatusBadge nodeId={id} />
        {/*
          × 放在最右边、且**平时半透明** —— 它和「跑这个节点」挨着,
          不弱化的话误点概率不低,而删节点是没有撤销的。
          悬停才变红,是"这里能删"和"别乱点"之间那个折中。
          用 SVG 叉而不是字符 ×:字符的字形随字体变化,和旁边的按钮对不齐。
        */}
        <button
          className="node-del"
          title="删除这个节点"
          aria-label="删除这个节点"
          onClick={(e) => {
            e.stopPropagation()
            void deleteNodeWithConfirm(id)
          }}
        >
          <Icon name="close" size={12} />
        </button>
      </header>

      <div className="agent-node-meta">
        {meta}

        {/* 单独跑这个节点(会自动带上游;输出节点则是"开始打包")。运行中禁用 —— 同节点不能跑两路 */}
        <button
          className="mini node-run"
          disabled={runBusy}
          title="只跑这个节点(连同它的上游)"
          aria-label="只跑这个节点"
          onClick={(e) => {
            // 不阻止的话点按钮会顺带选中节点,Inspector 突然跳走
            e.stopPropagation()
            void useWorkflowStore.getState().runTargets([id])
          }}
        >
          <Icon name="play" size={11} />
        </button>
      </div>

      {/* 上游提示。project 永远没有上游,传 null 即可 */}
      {(upstream ?? upstreamKey) && (
        <div className="agent-node-up" title={`上游:${upstream ?? upstreamKey}`}>
          ← {upstream ?? upstreamKey}
        </div>
      )}

      {/* 类型自定的附加区块(目前只有图像节点:缩略图网格) */}
      {extra}

      <div className={`agent-node-line ${line ?? lastLine ? '' : 'empty'}`}>
        {line ?? lastLine ?? '还没有对话'}
      </div>

      {/* 下游出线。output 没有(它是终点) */}
      {hasSourceHandle && <Handle type="source" position={Position.Right} className="rf-handle" />}
    </div>
  )
}

/** 薄组件共用的 props 形状:React Flow 传给每种节点组件的都是这个 */
export type ShellNodeProps = NodeProps<AgentFlowNode>
