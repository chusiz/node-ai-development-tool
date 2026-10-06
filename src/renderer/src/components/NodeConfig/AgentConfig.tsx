import type { JSX } from 'react'
import { useGraphStore, useResolvedProjectDir } from '../../stores/graphStore'
import { AgentCommonFields, DeleteRow, TitleField } from './NodeConfigPanel'
import { Icon } from '../Icons'

/**
 * 智能体节点(agent)的配置面板(v0.6.1 工程化 agent 编排)。
 *
 * 复用全部 Agent 通用字段(Agent/模型/权限/模板/失败重试/sessionId),
 * 额外三件事:
 *   ① 角色设定(agentRole)—— "你是规划师/审查员…",作为每轮的隐含系统提示;
 *   ② 最大轮次(maxRounds 1..8)—— 循环上限,输出含完成标志即提前收尾;
 *   ③ 完成标志(doneHint)—— LLM 输出包含它即认为任务完成。
 */
export function AgentConfig({ nodeId }: { nodeId: string }): JSX.Element | null {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId))
  const { dir: projectDir, source } = useResolvedProjectDir()

  if (!node) return null

  return (
    <div className="node-config">
      <TitleField nodeId={nodeId} value={node.data.title} />

      <div className="kv">
        <span className="k">模式</span>
        <span className="v">{node.data.mode === 'parallel' ? '并行(独立支路)' : '串行(迭代执行)'}</span>
      </div>

      {node.data.mode === 'parallel' && (
        <div className="fhint warn">
          并行智能体与主链<b>共用同一份项目代码</b>,请把改动限定在职责范围内;冲突交由下游整合节点处理。
        </div>
      )}

      <label className="cfglabel col">
        <span>角色设定(系统提示)</span>
        <textarea
          rows={2}
          value={node.data.agentRole ?? ''}
          onChange={(e) => useGraphStore.getState().patchConfig(nodeId, { agentRole: e.target.value })}
          placeholder="你是项目规划师:把需求拆成…"
          spellCheck={false}
        />
      </label>
      <div className="fhint">这个角色在<b>每一轮迭代</b>里都生效,让 AI 始终保持同一身份做事。</div>

      <div className="cfgrow">
        <label className="cfglabel narrow">
          <span>最大轮次</span>
          <input
            type="number"
            min={1}
            max={8}
            value={node.data.maxRounds ?? 3}
            onChange={(e) => useGraphStore.getState().patchConfig(nodeId, { maxRounds: Number(e.target.value) })}
          />
        </label>
        <label className="cfglabel">
          <span>完成标志</span>
          <input
            value={node.data.doneHint ?? '任务完成'}
            onChange={(e) => useGraphStore.getState().patchConfig(nodeId, { doneHint: e.target.value })}
            placeholder="任务完成"
          />
        </label>
      </div>
      <div className="fhint">
        输出里包含「完成标志」即提前收尾;否则跑满最大轮次。每轮都会<b>续聊上一轮的产出</b>迭代打磨。
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
