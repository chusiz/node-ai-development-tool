import type { JSX } from 'react'
import { useGraphStore, useResolvedProjectDir } from '../../stores/graphStore'
import { Icon } from '../Icons'
import { DeleteRow, TitleField } from './NodeConfigPanel'

/**
 * 闸门节点(gate)的配置面板 —— v0.6.5 反馈闭环。
 *
 * 两种校验方式:
 *   - 「跑命令」:在项目目录执行一条命令,退出码 0 = 通过(同测试节点);
 *   - 「校验文本」:对上游产出的文本做 contains / not-contains / regex 判定。
 * 不通过 = 节点失败 → 下游被拦,同时触发上游开启了「自动修复」的节点重跑。
 */
export function GateConfig({ nodeId }: { nodeId: string }): JSX.Element | null {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId))
  const patchConfig = useGraphStore((s) => s.patchConfig)
  const { dir: projectDir } = useResolvedProjectDir()

  if (!node) return null

  const g = node.data.gateParams ?? { mode: 'text', textRule: 'contains', pattern: '' }
  const onFail = node.data.failurePolicy ?? 'skip'

  const patchGate = (part: Record<string, unknown>) =>
    patchConfig(nodeId, { gateParams: { ...g, ...part } })

  return (
    <div className="node-config">
      <div className="fhint">
        <Icon name="gate" size={12} />
        <b>运行 → 校验 → 不通过就拦住下游(v0.6.5 反馈闭环)。</b>
        校验失败会触发上游开启了「自动修复」的节点把错误喂回 AI 重跑;轮次用尽仍失败,下游保持被拦。
      </div>

      <TitleField nodeId={nodeId} value={node.data.title} />

      <label className="cfglabel col">
        <span>校验方式</span>
        <select value={g.mode ?? 'text'} onChange={(e) => patchGate({ mode: e.target.value as 'exit' | 'text' })}>
          <option value="text">校验上游文本(默认)</option>
          <option value="exit">跑一条命令看退出码</option>
        </select>
      </label>

      {g.mode === 'text' ? (
        <>
          <label className="cfglabel col">
            <span>判定规则</span>
            <select
              value={g.textRule ?? 'contains'}
              onChange={(e) => patchGate({ textRule: e.target.value as 'contains' | 'not-contains' | 'regex' })}
            >
              <option value="contains">包含以下文本</option>
              <option value="not-contains">不包含以下文本</option>
              <option value="regex">匹配正则表达式</option>
            </select>
          </label>
          <label className="cfglabel col">
            <span>匹配内容</span>
            <input
              value={g.pattern ?? ''}
              placeholder={g.textRule === 'regex' ? 'PASS|success' : 'PASS'}
              onChange={(e) => patchGate({ pattern: e.target.value })}
              spellCheck={false}
            />
            <div className="fhint">
              校验对象是<strong>上游节点产出的文本</strong>(代码生成结果 / 测试摘要 / 交接清单…)。
            </div>
          </label>
        </>
      ) : (
        <>
          <label className="cfglabel col">
            <span>命令</span>
            <input
              value={g.command ?? ''}
              placeholder="npm run typecheck"
              onChange={(e) => patchGate({ command: e.target.value })}
              spellCheck={false}
            />
            <div className="fhint">
              在项目目录里执行,支持 <code>&amp;&amp;</code> 与管道。退出码 0 = 通过。
            </div>
          </label>
          <label className="cfglabel narrow">
            <span>超时(秒)</span>
            <input
              type="number"
              min={5}
              max={3600}
              value={g.timeoutSec ?? 120}
              onChange={(e) => patchGate({ timeoutSec: Number(e.target.value) })}
            />
          </label>
        </>
      )}

      <label className="cfglabel col">
        <span>失败提示(给修复节点看)</span>
        <input
          value={g.hint ?? ''}
          placeholder="例如:页面按钮点击无效,请检查事件绑定"
          onChange={(e) => patchGate({ hint: e.target.value })}
          spellCheck={false}
        />
        <div className="fhint">自动修复时,这段提示会和错误详情一起注入上游 AI 节点。</div>
      </label>

      <label className="cfglabel col">
        <span>校验失败时</span>
        <select
          value={onFail}
          onChange={(e) =>
            patchConfig(nodeId, { failurePolicy: e.target.value as 'stop' | 'skip' | 'continue' })
          }
        >
          <option value="skip">拦住下游(默认 · 不通过就别往下传)</option>
          <option value="stop">整条停止</option>
          <option value="continue">当空产出继续(不推荐)</option>
        </select>
      </label>

      <div className="cfglabel col">
        <span>工作目录</span>
        <div className="cwd-picker">
          <div className={`cwd-value ${projectDir ? '' : 'unset'}`} title={projectDir || '上游项目节点还没选文件夹'}>
            {projectDir || '继承项目文件夹(未设置)'}
          </div>
        </div>
      </div>

      {!g.pattern?.trim() && g.mode !== 'exit' && (
        <div className="fhint warn">
          <Icon name="alert" size={12} />
          还没填匹配内容 —— 运行时这个节点会直接报错。
        </div>
      )}
      {g.mode === 'exit' && !g.command?.trim() && (
        <div className="fhint warn">
          <Icon name="alert" size={12} />
          还没填命令 —— 运行时这个节点会直接报错。
        </div>
      )}

      <DeleteRow nodeId={nodeId} />
    </div>
  )
}
