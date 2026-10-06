import type { JSX } from 'react'
import { useGraphStore, useResolvedProjectDir } from '../../stores/graphStore'
import { Icon } from '../Icons'
import { AgentCommonFields, DeleteRow, TitleField } from './NodeConfigPanel'

/**
 * 审查节点(review)的配置面板。
 *
 * 与功能节点的结构一致(它就是会话节点),差别只在**职责说明**与
 * **权限模式的默认值**:注册表给 review 的 normalize 把默认权限设成 `plan`(只读)。
 *
 * 面板要把"只读"与"可写"的后果说清楚 —— 用户把权限模式改成「接受编辑」之后,
 * 这个节点就不再是审查,而是会动手改代码的普通支路。这个切换的代价必须写在脸上,
 * 而不是让用户自己从两个下拉选项里推断。
 */
export function ReviewConfig({ nodeId }: { nodeId: string }): JSX.Element | null {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId))
  const { dir: projectDir, source } = useResolvedProjectDir()

  if (!node) return null
  const readOnly = (node.data.permissionMode ?? 'plan') === 'plan'

  return (
    <div className="node-config">
      <TitleField nodeId={nodeId} value={node.data.title} />

      <div className={readOnly ? 'fhint' : 'fhint warn'}>
        {readOnly ? (
          <>
            <Icon name="check" size={12} />
            当前是<b>只读评审</b>:不改任何文件,产出一份问题清单交给下游。
          </>
        ) : (
          <>
            <Icon name="alert" size={12} />
            权限模式已放开:{' '}
            <b>{node.data.permissionMode === 'bypassPermissions' ? '全部放行' : '接受编辑'}</b> ——
            这个节点现在会<b>改你的代码</b>,不再是纯审查。审查的价值就在"只看不改",
            要保留它就别放开。
          </>
        )}
      </div>

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
        tplLabel="审查指令模板"
        tplPlaceholder={
          '留空 = 用默认审查指令(只读、按重要性排、每条给出位置与原因)\n可用 {{input}} {{prev}} {{node:<id>}} {{projectDir}}'
        }
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
