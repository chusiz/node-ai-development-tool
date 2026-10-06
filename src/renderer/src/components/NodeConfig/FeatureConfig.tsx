import type { JSX } from 'react'
import { useGraphStore, useResolvedProjectDir } from '../../stores/graphStore'
import { AgentCommonFields, DeleteRow, TitleField } from './NodeConfigPanel'
import { Icon } from '../Icons'

/**
 * 功能节点(feature)的配置面板。
 *
 * 串行 / 并行共用这一个面板(底层就是同一种节点 + mode):
 *   - 模式只读展示(从哪个入口创建就固定是哪种;要换就删了重加 ——
 *     串行/并行的注入语义完全不同,运行中途切换会让人分不清"它到底按哪套跑的");
 *   - 工作目录只读 = 项目文件夹(串行继承、并行共享,都解析到同一处);
 *   - 并行节点附冲突软提示(PRD §2.2 的"靠提示词协调")。
 */
export function FeatureConfig({ nodeId }: { nodeId: string }): JSX.Element | null {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId))
  const { dir: projectDir, source } = useResolvedProjectDir()

  if (!node) return null
  const isParallel = node.data.mode === 'parallel'

  return (
    <div className="node-config">
      <TitleField nodeId={nodeId} value={node.data.title} />

      <div className="kv">
        <span className="k">模式</span>
        <span className="v">{isParallel ? '并行(独立支路)' : '串行(叠加改造)'}</span>
      </div>

      {isParallel && (
        <div className="fhint warn">
          并行支路与主链<b>共用同一份项目代码</b>,请把改动限定在你的功能范围内;
          冲突交由下游整合节点处理。
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
