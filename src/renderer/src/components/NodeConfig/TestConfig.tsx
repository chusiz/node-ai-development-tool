import type { JSX } from 'react'
import { useGraphStore, useResolvedProjectDir } from '../../stores/graphStore'
import { Icon } from '../Icons'
import { DeleteRow, TitleField } from './NodeConfigPanel'

/**
 * 测试节点(test)的配置面板 —— **内置动作节点**,与 OutputConfig / ImageConfig 同一原则。
 *
 * ⚠️ 本面板**绝不出现** Agent / 模型 / Prompt 模板 等会话专属字段:测试节点不启动
 * AI 会话。显示了反而让人以为"改了模板会影响测试怎么跑"。
 *
 * 但**失败策略要留着** —— 它不是会话专属语义,而是调度器对"本节点失败后下游怎么办"
 * 的通用规则(propagateSkips 读的就是它)。对测试节点来说这是最要紧的一个旋钮:
 * 默认「跳过下游」= 测试没过就别往下打包/整合;想先看全貌再决定,就改成「当空产出继续」。
 */
export function TestConfig({ nodeId }: { nodeId: string }): JSX.Element | null {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId))
  const patchConfig = useGraphStore((s) => s.patchConfig)
  const { dir: projectDir } = useResolvedProjectDir()

  if (!node) return null

  const command = node.data.testCommand ?? ''
  const timeout = node.data.testTimeoutSec ?? 300
  const onFail = node.data.failurePolicy ?? 'skip'

  return (
    <div className="node-config">
      <div className="fhint">
        <Icon name="info" size={12} />
        <b>内置测试能力 · 不启动 AI 会话 · 不消耗 token。</b>
        在项目目录里跑下面这条命令,把**退出码与日志**交给下游 ——
        "通没通过"由退出码决定,不经过模型解释。
      </div>

      <TitleField nodeId={nodeId} value={node.data.title} />

      <label className="cfglabel col">
        <span>测试命令</span>
        <input
          value={command}
          placeholder="npm test"
          onChange={(e) => patchConfig(nodeId, { testCommand: e.target.value })}
          spellCheck={false}
        />
        <div className="fhint">
          整条命令行都可以写,支持 <code>&amp;&amp;</code> 与管道,例如{' '}
          <code>npm run typecheck &amp;&amp; npm test</code>。
          退出码 0 视为通过。
        </div>
      </label>

      <label className="cfglabel narrow">
        <span>超时(秒)</span>
        <input
          type="number"
          min={5}
          max={3600}
          value={timeout}
          onChange={(e) => patchConfig(nodeId, { testTimeoutSec: Number(e.target.value) })}
        />
      </label>

      <label className="cfglabel col">
        <span>测试失败时</span>
        <select
          value={onFail}
          onChange={(e) =>
            patchConfig(nodeId, { failurePolicy: e.target.value as 'stop' | 'skip' | 'continue' })
          }
        >
          <option value="skip">跳过下游(默认 · 测试没过就别继续)</option>
          <option value="stop">整条停止</option>
          <option value="continue">当空产出继续(先看全貌再决定)</option>
        </select>
      </label>

      <div className="cfglabel col">
        <span>工作目录</span>
        <div className="cwd-picker">
          <div
            className={`cwd-value ${projectDir ? '' : 'unset'}`}
            title={projectDir || '上游项目节点还没选文件夹'}
          >
            {projectDir || '继承项目文件夹(未设置)'}
          </div>
        </div>
        <div className="fhint">测试在项目节点锚定的项目文件夹里跑,与串行/并行支路共用同一份代码。</div>
      </div>

      {!command.trim() && (
        <div className="fhint warn">
          <Icon name="alert" size={12} />
          还没填测试命令 —— 运行时这个节点会直接报错。
        </div>
      )}

      <DeleteRow nodeId={nodeId} />
    </div>
  )
}
