import { memo, useEffect, useState, type JSX } from 'react'
import { useResolvedProjectDir } from '../stores/graphStore'
import { useNodeArtifacts, useNodeRunStatus } from '../stores/workflowStore'
import { NodeShell, type ShellNodeProps } from './NodeShell'
import { NODE_TYPES } from '../../../shared/nodeRegistry'

/**
 * 生图工作区(v0.5.0)节点组件:
 *   - PromptNode:正向提示词(纯文本数据源)
 *   - NegativeNode:负向提示词(纯文本数据源)
 *   - SamplerNode:采样出图(复用图像节点的缩略图展示)
 *   - ImageOutputNode:图片输出(终点,展示素材清单)
 */

const MAX_THUMBS = 6

/** 缩略图网格(与 ImageNode 同一只读图片通道) */
function Thumbs({ id }: { id: string }): JSX.Element {
  const { dir: projectDir } = useResolvedProjectDir()
  const status = useNodeRunStatus(id)
  const rels = useNodeArtifacts(id)
  const runBusy = status === 'running' || status === 'queued' || status === 'waiting'
  const shown = rels.slice(0, MAX_THUMBS)
  const more = rels.length - shown.length
  const relKey = shown.join('\u0000')
  const [urls, setUrls] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const list = relKey ? relKey.split('\u0000') : []
      const next: Record<string, string> = {}
      if (projectDir) {
        for (const rel of list) {
          try {
            const res = await window.api.image.readThumb(projectDir, rel)
            if (res.ok && res.data) next[rel] = res.data.dataUrl
          } catch {
            /* 单张读失败不影响其它张 */
          }
        }
      }
      if (!cancelled) setUrls(next)
    })()
    return () => {
      cancelled = true
    }
  }, [projectDir, relKey])
  return rels.length === 0 ? (
    <div className="image-thumbs empty">{runBusy ? '生成中…' : '还没有图片'}</div>
  ) : (
    <div className="image-thumbs">
      {shown.map((rel) =>
        urls[rel] ? (
          <div className="image-thumb" key={rel} title={rel}>
            <img src={urls[rel]} alt="" />
          </div>
        ) : (
          <div className="image-thumb pending" key={rel} title={rel} />
        ),
      )}
      {more > 0 && <div className="image-thumb more">+{more}</div>}
    </div>
  )
}

/** 正向提示词节点:只显示提示词文本,不出图 */
function PromptNodeInner({ id, selected, data }: ShellNodeProps): JSX.Element {
  const text = (data.promptText ?? '').trim()
  const line = text ? text.split('\n')[0] : '还没有正向提示词'
  return (
    <NodeShell
      id={id}
      selected={selected}
      badge={NODE_TYPES.prompt.badge}
      hasTargetHandle={NODE_TYPES.prompt.ports.target > 0}
      hasSourceHandle={NODE_TYPES.prompt.ports.source > 0}
      kindClass="kind-prompt"
      meta={
        <span className="agent-node-cwd" title={text || '还没有正向提示词'}>
          {line}
        </span>
      }
    />
  )
}
export const PromptNode = memo(PromptNodeInner)

/** 负向提示词节点:只显示负向文本,不出图 */
function NegativeNodeInner({ id, selected, data }: ShellNodeProps): JSX.Element {
  const text = (data.negativeText ?? '').trim()
  const line = text ? text.split('\n')[0] : '还没有负向提示词'
  return (
    <NodeShell
      id={id}
      selected={selected}
      badge={NODE_TYPES.prompt_negative.badge}
      hasTargetHandle={NODE_TYPES.prompt_negative.ports.target > 0}
      hasSourceHandle={NODE_TYPES.prompt_negative.ports.source > 0}
      kindClass="kind-prompt"
      meta={
        <span className="agent-node-cwd" title={text || '还没有负向提示词'}>
          {line}
        </span>
      }
    />
  )
}
export const NegativeNode = memo(NegativeNodeInner)

/** 采样出图节点:合并上游提示词出图,展示缩略图 */
function SamplerNodeInner({ id, selected, data }: ShellNodeProps): JSX.Element {
  const params = data.imageParams ?? {}
  const provider = data.imageProvider
  const providerLabel = provider?.kind === 'http' ? 'HTTP 接口' : '本地命令'
  const n = params.n ?? 1
  const size = params.size ?? '512x512'
  return (
    <NodeShell
      id={id}
      selected={selected}
      badge={NODE_TYPES.sampler.badge}
      hasTargetHandle={NODE_TYPES.sampler.ports.target === 1}
      hasSourceHandle={NODE_TYPES.sampler.ports.source === 1}
      kindClass="kind-sampler"
      meta={
        <span className="agent-node-brief" title={`出图方式:${providerLabel} · ${n} 张 · ${size}`}>
          {providerLabel} · {n} 张 · {size}
        </span>
      }
      extra={<Thumbs id={id} />}
    />
  )
}
export const SamplerNode = memo(SamplerNodeInner)

/** 图片输出节点:终点,展示已生成的素材清单 */
function ImageOutputNodeInner({ id, selected }: ShellNodeProps): JSX.Element {
  return (
    <NodeShell
      id={id}
      selected={selected}
      badge={NODE_TYPES.image_output.badge}
      hasTargetHandle={NODE_TYPES.image_output.ports.target > 0}
      hasSourceHandle={NODE_TYPES.image_output.ports.source > 0}
      kindClass="kind-output"
      meta={<span className="agent-node-brief">扫描项目素材目录,输出图片清单</span>}
      extra={<Thumbs id={id} />}
    />
  )
}
export const ImageOutputNode = memo(ImageOutputNodeInner)
