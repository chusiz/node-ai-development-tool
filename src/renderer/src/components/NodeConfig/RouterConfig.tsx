import type { JSX } from 'react'
import { useGraphStore, useResolvedProjectDir } from '../../stores/graphStore'
import { useUpstreams, AgentCommonFields, DeleteRow, TitleField } from './NodeConfigPanel'
import { Icon } from '../Icons'

/**
 * 路由节点(router)的配置面板(v0.6.1 工程化 agent 编排)。
 *
 * 复用全部 Agent 通用字段;额外一个**分支标签**编辑:
 *   - 标签顺序 = 出边顺序(第 i 个标签描述第 i 条出边);
 *   - LLM 看完上游成果后选一条分支,其余分支在运行时自动跳过;
 *   - 标签可留空 —— 运行时显示「分支1 / 分支2…」。
 */
export function RouterConfig({ nodeId }: { nodeId: string }): JSX.Element | null {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId))
  const { dir: projectDir, source } = useResolvedProjectDir()
  const outgoing = useGraphStore((s) =>
    s.edges
      .filter((e) => e.source === nodeId)
      .map((e) => {
        const title = s.nodes.find((n) => n.id === e.target)?.data.title ?? e.target
        return `${e.target}\u0000${title}`
      })
      .join('\u0001'),
  )
  const upstreams = useUpstreams(nodeId)

  if (!node) return null
  const routes = Array.isArray(node.data.routes) ? node.data.routes : []
  const targets = outgoing
    ? outgoing.split('\u0001').map((pair) => {
        const at = pair.indexOf('\u0000')
        return { id: pair.slice(0, at), title: pair.slice(at + 1) }
      })
    : []

  const patchRoutes = (next: string[]) =>
    useGraphStore.getState().patchConfig(nodeId, { routes: next })

  return (
    <div className="node-config">
      <TitleField nodeId={nodeId} value={node.data.title} />

      <div className="fhint">
        <Icon name="router" size={12} />
        看完上游成果后从出边里<b>选一条分支</b>激活,其余分支自动跳过 —— 实现条件分支。
      </div>

      {targets.length === 0 ? (
        <div className="fhint warn">还没有出边 —— 从右侧端口拉 <b>{node.data.routes?.length ? '更多' : ''}</b> 条线到下游节点,每条线 = 一个分支。</div>
      ) : (
        <div className="cfgrow">
          <label className="cfglabel">
            <span>分支标签(顺序 = 出边顺序)</span>
            <input
              value={routes.join(' / ')}
              onChange={(e) => patchRoutes(e.target.value.split(/[\/,，、\s]+/).filter(Boolean))}
              placeholder="例如:有Bug / 通过"
            />
          </label>
        </div>
      )}

      {targets.length > 0 && (
        <div className="kv-list">
          <span className="k">当前分支</span>
          {targets.map((t, i) => (
            <div key={t.id} className="kv-row">
              <span className="k">
                分支{i + 1}
                {routes[i] ? `(${routes[i]})` : ''}
              </span>
              <span className="v">{t.title}</span>
            </div>
          ))}
        </div>
      )}

      {upstreams.length === 0 && (
        <div className="fhint warn">还没有上游 —— 路由靠上游成果做决策,先拉一条线进来。</div>
      )}

      <AgentCommonFields
        nodeId={nodeId}
        agentId={node.data.agentId}
        model={node.data.model}
        permissionMode={node.data.permissionMode}
        promptTemplate={node.data.promptTemplate}
        failurePolicy={node.data.failurePolicy}
        retry={node.data.retry}
        cwd={projectDir}
        cwdMode="readonly"
        tplLabel="路由决策模板"
        tplPlaceholder="留空 = 默认路由模板(给上游成果 + 分支清单,要求只输出分支编号)"
      />

      {source === 'canvas' && (
        <div className="fhint">
          <Icon name="alert" size={12} />
          当前画布没有项目节点,目录来自画布级 projectDir 兜底(deprecated)。建议放一个项目节点。
        </div>
      )}

      <DeleteRow nodeId={nodeId} />
    </div>
  )
}
