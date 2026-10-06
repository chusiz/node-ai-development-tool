import type { JSX } from 'react'
import { useGraphStore, useResolvedProjectDir } from '../../stores/graphStore'
import { useUpstreams, AgentCommonFields, DeleteRow, TitleField } from './NodeConfigPanel'
import { Icon } from '../Icons'
import type { ChartType } from '../../../../shared/canvas'

/**
 * 图表节点(chart)的配置面板(v0.6.2 可视化图形制作)。
 *
 * 数据模板(promptTemplate)里写 JSON,可含 {{input}} / {{prev}} 注入上游产出;
 * 运行时 ECharts SSR 渲染成 SVG,落盘 assets/generated/charts/,随项目打包交付。
 */
const CHART_TYPES: { value: ChartType; label: string }[] = [
  { value: 'bar', label: '柱状图' },
  { value: 'line', label: '折线图' },
  { value: 'pie', label: '饼图' },
  { value: 'scatter', label: '散点图' },
  { value: 'funnel', label: '漏斗图' },
]

export function ChartConfig({ nodeId }: { nodeId: string }): JSX.Element | null {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId))
  const { dir: projectDir, source } = useResolvedProjectDir()
  const upstreams = useUpstreams(nodeId)

  if (!node) return null
  const cp = node.data.chartParams ?? { chartType: 'bar' as ChartType, width: 800, height: 480, title: '' }
  const patch = (p: Partial<typeof cp>) =>
    useGraphStore.getState().patchConfig(nodeId, { chartParams: { ...cp, ...p } })

  const typeLabel = CHART_TYPES.find((t) => t.value === cp.chartType)?.label ?? cp.chartType

  return (
    <div className="node-config">
      <TitleField nodeId={nodeId} value={node.data.title} />

      <div className="fhint">
        <Icon name="chart" size={12} />
        把数据渲染成 <b>SVG 图表</b> 落盘(assets/generated/charts/),随项目打包交付。
        数据模板里写 <b>JSON</b>,可含 <b>{'{{input}}'}</b> / <b>{'{{prev}}'}</b> 注入上游产出。
      </div>

      <div className="cfgrow">
        <label className="cfglabel">
          <span>图表类型</span>
          <select value={cp.chartType} onChange={(e) => patch({ chartType: e.target.value as ChartType })}>
            {CHART_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="cfgrow">
        <label className="cfglabel">
          <span>标题(可留空)</span>
          <input value={cp.title ?? ''} onChange={(e) => patch({ title: e.target.value })} placeholder="例如:月度销量" />
        </label>
      </div>

      <div className="cfgrow grid2">
        <label className="cfglabel">
          <span>宽度(px)</span>
          <input
            type="number"
            value={cp.width}
            onChange={(e) => patch({ width: Number(e.target.value) || 800 })}
            min={320}
            max={2000}
          />
        </label>
        <label className="cfglabel">
          <span>高度(px)</span>
          <input
            type="number"
            value={cp.height}
            onChange={(e) => patch({ height: Number(e.target.value) || 480 })}
            min={240}
            max={2000}
          />
        </label>
      </div>

      <div className="kv-list">
        <span className="k">数据格式({typeLabel})</span>
        {cp.chartType === 'pie' || cp.chartType === 'funnel' ? (
          <div className="kv-row">
            <span className="k">饼/漏斗</span>
            <span className="v">{'[{"name":"A","value":10},{"name":"B","value":20}]'}</span>
          </div>
        ) : cp.chartType === 'scatter' ? (
          <div className="kv-row">
            <span className="k">散点</span>
            <span className="v">{'[[1,2],[3,5],[8,9]] 或 [{"name":"点1","value":[1,2]}]'}</span>
          </div>
        ) : (
          <div className="kv-row">
            <span className="k">柱/折线</span>
            <span className="v">{'{"categories":["一月","二月"],"series":[10,20]} 或 [{"name":"A","value":10}]'}</span>
          </div>
        )}
      </div>

      {upstreams.length === 0 && (
        <div className="fhint warn">
          还没有上游 —— 数据模板里写死 JSON 也能出图;接一个产出数据的上游节点后可用 {'{{input}}'} 动态注入。
        </div>
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
        tplLabel="数据模板(JSON)"
        tplPlaceholder={'{"categories":["一月","二月"],"series":[10,20]}'}
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
