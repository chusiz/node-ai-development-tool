import { memo, type JSX } from 'react'
import { useGraphStore, useResolvedProjectDir } from '../stores/graphStore'
import { NODE_TYPES } from '../../../shared/nodeRegistry'
import { NodeShell, type ShellNodeProps } from './NodeShell'

/**
 * 交接节点(handoff)—— 内置动作节点:把上游(通常是图像节点)产出的图片
 * 收集成素材清单,作为交接文本交给下游软件制作节点。
 *
 * 底层逻辑与程序节点不同:不启动 agent 会话、不耗 token —— 只是"扫图 →
 * 生成清单"的确定性动作。下游 {{node:<id>}} / {{prev}} 引用清单后,
 * AI 制作/打包时按相对路径直接用这些素材。
 *
 * 端口:1 入 1 出(中间节点,像图像节点一样可以串在链上)。
 */
function HandoffNodeInner({ id, selected }: ShellNodeProps): JSX.Element {
  const { dir: projectDir } = useResolvedProjectDir()
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === id))
  const note = node?.data.handoffNote ?? ''
  const inbound = useGraphStore((s) => s.edges.filter((e) => e.target === id).length)

  return (
    <NodeShell
      id={id}
      selected={selected}
      badge={NODE_TYPES.handoff.badge}
      hasTargetHandle={NODE_TYPES.handoff.ports.target === 1}
      hasSourceHandle={NODE_TYPES.handoff.ports.source === 1}
      kindClass="kind-handoff"
      meta={
        <>
          {note ? (
            <span className="agent-node-cwd" title={note}>
              {note.length > 24 ? `${note.slice(0, 24)}…` : note}
            </span>
          ) : (
            <span className="agent-node-cwd">素材交接</span>
          )}
          <span className="agent-node-brief" title={projectDir || '项目文件夹未设'}>
            {projectDir ? '收图 → 软件' : '项目文件夹未设'}
          </span>
          {inbound === 0 && <span className="node-soft-hint">还没有上游(接图像节点)</span>}
        </>
      }
    />
  )
}

export const HandoffNode = memo(HandoffNodeInner)
