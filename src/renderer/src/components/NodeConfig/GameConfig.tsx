import type { JSX } from 'react'
import { useGraphStore, useResolvedProjectDir } from '../../stores/graphStore'
import { AgentCommonFields, DeleteRow, TitleField } from './NodeConfigPanel'
import { Icon } from '../Icons'

/**
 * 游戏节点(game)的配置面板。
 *
 * 与 feature 同族(session 节点):引擎固定 Godot、目录跟随项目文件夹,
 * 其余走 AgentCommonFields(哪个模型跑、提示词模板、权限、失败策略、重试)。
 * 默认提示词模板已在注册表里写好 —— 目标是"生成一个 Godot 4.x 打开即玩的完整项目"。
 */
export function GameConfig({ nodeId }: { nodeId: string }): JSX.Element | null {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId))
  const { dir: projectDir, source } = useResolvedProjectDir()

  if (!node) return null
  const engine = node.data.gameEngine ?? 'godot'

  return (
    <div className="node-config">
      <TitleField nodeId={nodeId} value={node.data.title} />

      <div className="kv">
        <span className="k">引擎</span>
        <span className="v">
          Godot 4.x({engine === 'godot' ? '开源 MIT · 节点化场景' : engine})—— 生成项目文件,
          用 Godot 编辑器打开即可运行
        </span>
      </div>

      <div className="fhint">
        <Icon name="info" size={12} />
        该节点让 AI 直接产出 <b>project.godot + 场景(.tscn) + 脚本(.gd)</b> 的完整项目。
        玩法优先小而完整:模型会先做一个可运行原型,而不是半成品大项目。
        想换玩法/加功能,把新需求写在「提示词模板」里,或接一个上游节点提供需求。
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
