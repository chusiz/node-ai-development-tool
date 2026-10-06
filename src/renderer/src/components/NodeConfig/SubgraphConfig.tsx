import type { JSX } from 'react'
import { useGraphStore } from '../../stores/graphStore'
import { getNodeType } from '../../../../shared/nodeRegistry'
import { Icon } from '../Icons'
import { DeleteRow, TitleField } from './NodeConfigPanel'

/**
 * 子图节点(subgraph)的配置面板。
 *
 * 它没有 agent 字段、没有模板 —— 内部节点各自的配置在**封装前**已经改好了,
 * 这里只做三件事:看(内部有什么)、展开(要改内部结构时的唯一入口)、删。
 */
export function SubgraphConfig({ nodeId }: { nodeId: string }): JSX.Element | null {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId))
  const expandSubgraph = useGraphStore((s) => s.expandSubgraph)

  if (!node) return null
  const t = node.data.subgraph

  return (
    <div className="node-config">
      <TitleField nodeId={nodeId} value={node.data.title} />

      <div className="fhint">
        子图是<b>一段被封起来的节点图</b>:运行时按原样展开成平铺节点执行,
        和没封装过完全一样。要改内部结构就<b>展开</b>,改完可以再次封装。
      </div>

      {t && t.nodes.length > 0 ? (
        <>
          <div className="cfg-label">内部节点({t.nodes.length} 个 · {t.edges.length} 条连线)</div>
          <ul className="subgraph-list">
            {t.nodes.map((inner) => {
              const def = getNodeType(inner.type)
              return (
                <li key={inner.id} title={def.badge.title ?? def.label}>
                  <span className={`node-kind-badge ${def.badge.cls}`}>
                    {def.badge.text}
                  </span>
                  <span className="subgraph-node-title">{inner.data.title || inner.id}</span>
                  {t.entryIds.includes(inner.id) && <span className="node-soft-hint">入口</span>}
                  {t.exitIds.includes(inner.id) && <span className="node-soft-hint">出口</span>}
                </li>
              )
            })}
          </ul>
          <button
            type="button"
            className="mini"
            title="展开回原来的节点(外部连线按封装时的记录重新接好)"
            onClick={() => expandSubgraph(nodeId)}
          >
            展开编辑
          </button>
        </>
      ) : (
        <div className="fhint">
          <Icon name="alert" size={12} />
          内容为空 —— 空子图运行时会被跳过,展开或删除它。
        </div>
      )}

      <DeleteRow nodeId={nodeId} />
    </div>
  )
}
