import { memo, type JSX } from 'react'
import { useGraphStore } from '../stores/graphStore'
import { NODE_TYPES } from '../../../shared/nodeRegistry'
import { NodeShell, type ShellNodeProps } from './NodeShell'

/**
 * 子图节点(subgraph)—— 一段被封起来的节点图。
 *
 * ## 它在图上的语义:透明
 *
 * 运行时(specFromGraph)会展开回平铺节点,调度器眼里它从没存在过。
 * 卡片上要一眼看出三件事:
 *   ① 里面有多少节点 / 多少条线(规模感);
 *   ② 空子图是坏状态(展开或删掉它 —— V13 会在运行前提示);
 *   ③ 「展开」入口 —— 修改内部结构的唯一路径。
 *
 * 徽标取自注册表(NODE_TYPES.subgraph.badge),与其他节点同一做法。
 */
function SubgraphNodeInner({ id, selected }: ShellNodeProps): JSX.Element {
  const def = NODE_TYPES.subgraph
  const innerCount = useGraphStore((s) => s.nodes.find((n) => n.id === id)?.data.subgraph?.nodes.length ?? 0)
  const innerEdges = useGraphStore((s) => s.nodes.find((n) => n.id === id)?.data.subgraph?.edges.length ?? 0)
  const expandSubgraph = useGraphStore((s) => s.expandSubgraph)

  return (
    <NodeShell
      id={id}
      selected={selected}
      badge={def.badge}
      hasTargetHandle={def.ports.target === 1}
      hasSourceHandle={def.ports.source === 1}
      kindClass="kind-subgraph"
      meta={
        <>
          <span className="agent-node-cwd" title="运行时按原样展开成平铺节点执行,和没封装过一样">
            {innerCount > 0 ? `内部 ${innerCount} 节点 · ${innerEdges} 连线` : '空子图'}
          </span>
          <button
            className="mini"
            disabled={innerCount === 0}
            title="展开回原来的节点(修改内部结构后再封装回来)"
            onClick={(e) => {
              e.stopPropagation()
              expandSubgraph(id)
            }}
          >
            展开
          </button>
        </>
      }
    />
  )
}

export const SubgraphNode = memo(SubgraphNodeInner)
