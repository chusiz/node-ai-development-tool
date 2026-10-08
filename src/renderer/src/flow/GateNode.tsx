import { memo, type JSX } from 'react'
import { useResolvedProjectDir } from '../stores/graphStore'
import { useNodeRunStatus, useWorkflowStore } from '../stores/workflowStore'
import { NODE_TYPES } from '../../../shared/nodeRegistry'
import { Icon } from '../components/Icons'
import { NodeShell, type ShellNodeProps } from './NodeShell'

/**
 * 闸门节点(gate)—— v0.6.5 反馈闭环的内置动作节点。
 *
 * 端口:1 入 1 出。它把上游产出的文本(或一条命令的退出码)当**校验对象**:
 * 不通过 = 节点失败 → 下游被拦;同时触发上游开启「自动修复」的节点把错误喂回 AI 重跑。
 * 不启动 AI 会话、不消耗 token。
 *
 * 卡片上要能看出"这一下会校验什么":规则 + 匹配内容(或命令)。失败时错误气泡会
 * 经 NodeShell 的红框展示,与 test 节点同款。
 */
function GateNodeInner({ id, selected, data }: ShellNodeProps): JSX.Element {
  const { dir: projectDir } = useResolvedProjectDir()
  const status = useNodeRunStatus(id)
  const runBusy = status === 'running' || status === 'queued' || status === 'waiting'

  const g = data.gateParams ?? { mode: 'text', textRule: 'contains', pattern: '' }
  const ruleLabel =
    g.mode === 'exit'
      ? (g.command ?? '').trim() || '未配置命令'
      : `${g.textRule === 'contains' ? '包含' : g.textRule === 'not-contains' ? '不包含' : '匹配'}${(g.pattern ?? '').trim() ? `「${g.pattern}」` : '…'}`

  return (
    <NodeShell
      id={id}
      selected={selected}
      badge={NODE_TYPES.gate.badge}
      hasTargetHandle={NODE_TYPES.gate.ports.target === 1}
      hasSourceHandle={NODE_TYPES.gate.ports.source === 1}
      kindClass="kind-gate"
      meta={
        <>
          {projectDir ? (
            <span className="agent-node-cwd" title={projectDir}>
              {projectDir.split(/[\\/]/).filter(Boolean).slice(-2).join('/')}
            </span>
          ) : (
            <span className="agent-node-cwd">跟随项目文件夹(未设置)</span>
          )}
          <span className={`agent-node-brief ${ruleLabel.startsWith('未配置') ? 'unset' : ''}`} title={ruleLabel}>
            {ruleLabel}
          </span>
          <button
            className="mini node-run-test"
            disabled={runBusy}
            title="跑这条校验(连同上游)"
            onClick={(e) => {
              e.stopPropagation()
              void useWorkflowStore.getState().runTargets([id])
            }}
          >
            <Icon name="gate" size={11} />
            {runBusy ? '校验中…' : '开始校验'}
          </button>
        </>
      }
    />
  )
}

export const GateNode = memo(GateNodeInner)
