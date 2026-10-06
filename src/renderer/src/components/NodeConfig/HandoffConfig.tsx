import { type JSX } from 'react'
import { useGraphStore } from '../../stores/graphStore'
import { DeleteRow, TitleField } from './NodeConfigPanel'

/**
 * 交接节点(handoff)的配置面板 —— **内置动作节点**,与 ImageConfig 同一原则。
 *
 * 作用:把上游(通常是图像节点)产出的图片收集成素材清单,作为交接文本交给
 * 下游软件制作节点 —— 下游用 {{node:<id>}} 引用后,AI 就知道"有哪些素材、
 * 在哪、干什么用",制作/打包时按相对路径直接用。
 *
 * 只配一个「用途说明」:它是清单里最重要的一句(告诉 AI 这批图是干嘛的)。
 */
export function HandoffConfig({ nodeId }: { nodeId: string }): JSX.Element | null {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId))
  const patchConfig = useGraphStore((s) => s.patchConfig)

  if (!node) return null

  return (
    <div className="node-config">
      <div className="fhint warn">
        <b>素材交接 · 不启动 AI 会话 · 不消耗 token。</b>
        自动收集项目 <code>assets/generated/</code> 下的图片,生成素材清单交给下游软件节点。
      </div>

      <TitleField nodeId={nodeId} value={node.data.title} />

      <label className="cfglabel col">
        <span>用途说明(可选)</span>
        <textarea
          className="tpl"
          rows={3}
          value={node.data.handoffNote ?? ''}
          placeholder={'例:游戏主角立绘素材,制作时请引用这些图作为主角形象\n例:软件界面风格图,UI 设计参照这组图'}
          onChange={(e) => patchConfig(nodeId, { handoffNote: e.target.value })}
          spellCheck={false}
        />
      </label>
      <div className="fhint">
        清单里会自动带上每张图的相对路径。下游节点 prompt 里用 <code>{'{{node:<交接节点id>}}'}</code>{' '}
        或 <code>{'{{prev}}'}</code> 引用即可拿到素材清单。
      </div>

      <DeleteRow nodeId={nodeId} />
    </div>
  )
}
