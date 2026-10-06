import type { JSX } from 'react'
import { useGraphStore, useResolvedProjectDir } from '../../stores/graphStore'
import { Icon } from '../Icons'
import { AgentCommonFields, DeleteRow, TitleField } from './NodeConfigPanel'

/**
 * 文档节点(doc)的配置面板。
 *
 * 与会话节点同构。这里额外把"**已有的改,而不是再写一份**"这条约定说出来 ——
 * 它是文档节点最容易干成的坏事(产出与既有文档重名/矛盾的第二份说明),
 * 而这条约束靠提示词实现,用户得知道它在那儿。
 */
export function DocConfig({ nodeId }: { nodeId: string }): JSX.Element | null {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId))
  const { dir: projectDir, source } = useResolvedProjectDir()

  if (!node) return null

  return (
    <div className="node-config">
      <TitleField nodeId={nodeId} value={node.data.title} />

      <div className="fhint">
        按上游改动补写 / 更新文档(README、接口说明、使用示例等)。
        默认指令要求它<b>先看项目现有文档的写法与语言</b>,跟着写;
        已经写过的部分<b>改</b>,而不是再新建一份重复的 —— 两份说法不一样比没有文档更糟。
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
        tplLabel="文档指令模板"
        tplPlaceholder={
          '留空 = 用默认文档指令(跟着现有风格、只写验证过的行为)\n可用 {{input}} {{prev}} {{node:<id>}} {{projectDir}}'
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
