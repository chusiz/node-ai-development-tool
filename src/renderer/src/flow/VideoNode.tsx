import { memo, type JSX } from 'react'
import { useGraphStore, useResolvedProjectDir } from '../stores/graphStore'
import { NODE_TYPES } from '../../../shared/nodeRegistry'
import { NodeShell, type ShellNodeProps } from './NodeShell'

/**
 * 视频节点(video)—— 内置动作节点:抽帧 + 视觉模型分析,**理解视频内容**。
 *
 * 与程序节点(LLM 会话)底层逻辑不同:这是"视频 → 帧 → 视觉模型"的确定性管线,
 * 不启动 agent 会话。理解结果(视频讲了什么、做了什么)作为产出交给下游,
 * 下游据此制作 / 优化软件,或决定给软件加什么视频内容。
 *
 * 端口:1 入 1 出。分析对象 = 配置里填的视频文件(可以接上游产出的路径)。
 */
function VideoNodeInner({ id, selected }: ShellNodeProps): JSX.Element {
  const { dir: projectDir } = useResolvedProjectDir()
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === id))
  const source = node?.data.videoParams?.source ?? ''
  const model = node?.data.videoParams?.model ?? ''
  const inbound = useGraphStore((s) => s.edges.filter((e) => e.target === id).length)

  return (
    <NodeShell
      id={id}
      selected={selected}
      badge={NODE_TYPES.video.badge}
      hasTargetHandle={NODE_TYPES.video.ports.target === 1}
      hasSourceHandle={NODE_TYPES.video.ports.source === 1}
      kindClass="kind-video"
      meta={
        <>
          {source ? (
            <span className="agent-node-cwd" title={source}>
              {source.split(/[\\/]/).filter(Boolean).slice(-2).join('/')}
            </span>
          ) : (
            <span className="agent-node-cwd">未填视频文件</span>
          )}
          <span className="agent-node-brief" title={model ? `视觉模型:${model}` : '还没选视觉模型'}>
            {model ? model.split(/[\/:]/).slice(-1)[0] : '视觉分析'}
          </span>
          {inbound === 0 && <span className="node-soft-hint">还没有上游</span>}
        </>
      }
    />
  )
}

export const VideoNode = memo(VideoNodeInner)
