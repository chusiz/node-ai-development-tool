import { memo, type JSX } from 'react'
import { useGraphStore, useResolvedProjectDir } from '../stores/graphStore'
import { useNodeRunStatus, useWorkflowStore } from '../stores/workflowStore'
import { NODE_TYPES } from '../../../shared/nodeRegistry'
import type { NodeKind, NodeTypeDef } from '../../../shared/nodeRegistry'
import { Icon } from '../components/Icons'
import { NodeShell, type ShellNodeProps } from './NodeShell'

/**
 * v0.6.6 工程化节点群(8 个 builtin,确定性执行,不耗 LLM token):
 *   lint 静态检查 / git 版本控制 / deps 依赖管理 / context 项目记忆 /
 *   contract 接口契约 / cost 运行摘要 / diff 现状快照 / deploy 一键部署
 *
 * 共用同一个轻组件:卡片上显示一句"这个节点会干什么",加一个就地运行按钮。
 * 各自的专属参数在配置面板(ToolkitConfig)里编辑。
 */

const SUMMARY: Record<string, string> = {
  lint: '静态检查(tsc/eslint)',
  git: '本地 git 操作',
  deps: '依赖清单与缺失检测',
  context: '项目记忆',
  contract: '接口契约(OpenAPI)',
  cost: '运行摘要与成本',
  diff: '项目现状快照',
  deploy: 'Web 部署包',
}

function ToolkitNodeInner({ id, selected, data }: ShellNodeProps): JSX.Element {
  const { dir: projectDir } = useResolvedProjectDir()
  const status = useNodeRunStatus(id)
  const runBusy = status === 'running' || status === 'queued' || status === 'waiting'
  // React Flow 的 type = NodeKind;data 里没有 kind/action,从注册表反查
  const kind = useGraphStore((s) => s.nodes.find((n) => n.id === id)?.type ?? 'lint') as NodeKind
  const def = NODE_TYPES[kind] ?? NODE_TYPES.lint
  const action = (def as NodeTypeDef).action ?? 'lint'
  const runLabel = action === 'deploy' ? '开始部署' : '开始运行'

  return (
    <NodeShell
      id={id}
      selected={selected}
      badge={def.badge}
      hasTargetHandle={def.ports.target === 1}
      hasSourceHandle={def.ports.source === 1}
      kindClass={`kind-${kind}`}
      meta={
        <>
          {projectDir ? (
            <span className="agent-node-cwd" title={projectDir}>
              {projectDir.split(/[\\/]/).filter(Boolean).slice(-2).join('/')}
            </span>
          ) : (
            <span className="agent-node-cwd">跟随项目文件夹(未设置)</span>
          )}
          <span className="agent-node-brief" title={def.badge.title}>
            {SUMMARY[action] ?? def.label}
          </span>
          <button
            className="mini node-run-test"
            disabled={runBusy}
            title={`就地跑这个节点(连同上游)`}
            onClick={(e) => {
              e.stopPropagation()
              void useWorkflowStore.getState().runTargets([id])
            }}
          >
            <Icon name={def.badge.icon ?? 'play'} size={11} />
            {runBusy ? '运行中…' : runLabel}
          </button>
        </>
      }
    />
  )
}

export const LintNode = memo(ToolkitNodeInner)
export const GitNode = memo(ToolkitNodeInner)
export const DepsNode = memo(ToolkitNodeInner)
export const ContextNode = memo(ToolkitNodeInner)
export const ContractNode = memo(ToolkitNodeInner)
export const CostNode = memo(ToolkitNodeInner)
export const DiffNode = memo(ToolkitNodeInner)
export const DeployNode = memo(ToolkitNodeInner)
