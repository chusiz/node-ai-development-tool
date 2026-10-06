import type { JSX } from 'react'
import { useGraphStore, useResolvedProjectDir } from '../../stores/graphStore'
import { DeleteRow, TitleField } from './NodeConfigPanel'
import { PROVIDERS } from '../../types'
import { Icon } from '../Icons'

/**
 * 视频节点(video)的配置面板。
 *
 * 与 agent 节点不同:这是内置动作节点,没有 agentId —— 分析用的视觉模型
 * 直接在这里配(服务商 + 模型名),不经过「Agent」选择器。
 * 视觉模型必须支持图片输入(多模态),如火山 doubao-vision / OpenAI gpt-4o。
 */
export function VideoConfig({ nodeId }: { nodeId: string }): JSX.Element | null {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId))
  const patch = useGraphStore((s) => s.patchConfig)
  const { dir: projectDir } = useResolvedProjectDir()

  if (!node) return null
  const p = node.data.videoParams ?? {}

  const set = (field: 'source' | 'providerId' | 'model' | 'frameEverySec' | 'maxFrames', v: string | number) => {
    patch(nodeId, { videoParams: { ...p, [field]: v } })
  }

  return (
    <div className="node-config">
      <TitleField nodeId={nodeId} value={node.data.title} />

      <label className="cfglabel">
        <span>视频文件</span>
        <input
          type="text"
          className="fpath"
          placeholder={projectDir ? '项目内相对路径,如 assets/demo.mp4' : '视频文件路径(相对项目 / 绝对路径)'}
          value={p.source ?? ''}
          onChange={(e) => set('source', e.target.value)}
          spellCheck={false}
        />
        <div className="fhint">
          <Icon name="info" size={12} />
          填项目内的视频路径或绝对路径。相对路径按项目文件夹解析。
        </div>
      </label>

      <label className="cfglabel">
        <span>视觉服务商</span>
        <select
          className="fpath"
          value={p.providerId ?? ''}
          onChange={(e) => set('providerId', e.target.value)}
        >
          <option value="">(未选择)</option>
          {PROVIDERS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </label>

      <label className="cfglabel">
        <span>视觉模型</span>
        <input
          type="text"
          className="fpath"
          placeholder="支持图片输入的多模态模型,如 doubao-seed-1-6-vision / gpt-4o"
          value={p.model ?? ''}
          onChange={(e) => set('model', e.target.value)}
          spellCheck={false}
        />
        <div className="fhint warn">
          <Icon name="alert" size={12} />
          模型必须支持图片输入。视觉模型按帧计费 —— 下面的「最多抽几帧」就是成本上限。
        </div>
      </label>

      <div className="cfgrow">
        <label className="cfglabel">
          <span>抽帧间隔(秒)</span>
          <input
            type="number"
            className="fnum"
            min={1}
            max={300}
            value={p.frameEverySec ?? 3}
            onChange={(e) => set('frameEverySec', Number(e.target.value))}
          />
        </label>
        <label className="cfglabel">
          <span>最多抽几帧</span>
          <input
            type="number"
            className="fnum"
            min={1}
            max={30}
            value={p.maxFrames ?? 8}
            onChange={(e) => set('maxFrames', Number(e.target.value))}
          />
        </label>
      </div>

      <div className="fhint">
        <Icon name="info" size={12} />
        分析会先把视频抽成若干帧,再让视觉模型逐帧理解,最后汇总成一段文字产出交给下游
        (下游据此制作 / 优化软件,或决定给软件加什么视频内容)。需要本机有 ffmpeg(用于抽帧)。
      </div>

      <DeleteRow nodeId={nodeId} />
    </div>
  )
}
