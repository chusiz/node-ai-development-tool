import { memo, type JSX } from 'react'
import { useGraphStore, useResolvedProjectDir } from '../stores/graphStore'
import { NODE_TYPES } from '../../../shared/nodeRegistry'
import { NodeShell, type ShellNodeProps } from './NodeShell'

/**
 * 游戏节点(game)—— 会话类节点:用 Godot(GDScript)制作 2D/3D 游戏。
 *
 * 参考开源节点化游戏工具的设计:Godot(场景即节点树,组合优于继承)、
 * Unreal Blueprint(逻辑可视化连线)、GDevelop(AI 描述即可生成)。
 * chusiz 的落点:让 LLM 直接产出**完整可打开的 Godot 项目**
 * (project.godot + .tscn 场景 + GDScript),用户用 Godot 编辑器打开即玩。
 *
 * 端口:1 入 1 出。需求从上游来,游戏项目作为产出继续交下去。
 */
function GameNodeInner({ id, selected }: ShellNodeProps): JSX.Element {
  const { dir: projectDir } = useResolvedProjectDir()
  const inbound = useGraphStore((s) => s.edges.filter((e) => e.target === id).length)

  return (
    <NodeShell
      id={id}
      selected={selected}
      badge={NODE_TYPES.game.badge}
      hasTargetHandle={NODE_TYPES.game.ports.target === 1}
      hasSourceHandle={NODE_TYPES.game.ports.source === 1}
      kindClass="kind-game"
      meta={
        <>
          {projectDir ? (
            <span className="agent-node-cwd" title={projectDir}>
              {projectDir.split(/[\\/]/).filter(Boolean).slice(-2).join('/')}
            </span>
          ) : (
            <span className="agent-node-cwd">跟随项目文件夹(未设置)</span>
          )}
          <span className="agent-node-brief" title="Godot 引擎(GDScript):生成项目文件,Godot 4.x 打开即可运行">
            Godot 游戏
          </span>
          {inbound === 0 && <span className="node-soft-hint">还没有上游</span>}
        </>
      }
    />
  )
}

export const GameNode = memo(GameNodeInner)
