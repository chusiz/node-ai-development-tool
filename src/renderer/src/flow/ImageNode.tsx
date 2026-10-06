import { memo, useEffect, useState, type JSX } from 'react'
import { useResolvedProjectDir } from '../stores/graphStore'
import { useNodeArtifacts, useNodeRunStatus } from '../stores/workflowStore'
import { NodeShell, type ShellNodeProps } from './NodeShell'
import { NODE_TYPES } from '../../../shared/nodeRegistry'

/**
 * 图像节点(image)—— **内置动作节点**,与 output 同族(不是 Agent)。
 *
 * 端口:1 入 1 出(它是链上的**中间节点**,不像 output 是终点)。
 * 不启动 AI 会话、不消耗 token —— 出图由主进程的 ImageGen 执行。
 *
 * 缩略图来自该节点**最近一次运行**产出的图片(相对项目文件夹)。渲染端不直接
 * 碰 fs:每张按需经**只读图片通道** window.api.image.readThumb 取小尺寸 dataUrl
 * (S2:主进程白名单校验)。运行中显示"生成中…",未运行显示空态。
 */

/** 缩略图网格最多显示 6 张,超出显示 +N(PRD §3.5) */
const MAX_THUMBS = 6

function ImageNodeInner({ id, selected, data }: ShellNodeProps): JSX.Element {
  const { dir: projectDir } = useResolvedProjectDir()
  const status = useNodeRunStatus(id)
  const rels = useNodeArtifacts(id)

  const runBusy = status === 'running' || status === 'queued' || status === 'waiting'

  const params = data.imageParams ?? {}
  const provider = data.imageProvider
  const providerLabel = provider?.kind === 'http' ? 'HTTP 接口' : '本地命令'
  const prompt = (data.promptTemplate ?? '').trim()
  const promptLine = prompt ? prompt.split('\n')[0] : '还没有画面描述'
  const n = params.n ?? 1
  const size = params.size ?? '1024x1024'

  const shown = rels.slice(0, MAX_THUMBS)
  const more = rels.length - shown.length
  const relKey = shown.join('\u0000')

  /*
   * 缩略图 URI。按需拉取:节点卡片上通常只有 ≤6 张,一次拉完可接受。
   * 依赖 relKey(字符串)而不是 shown 数组 —— 数组每次渲染都是新引用,
   * 会在 effect 依赖上造成无谓重跑。
   */
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
            // 校验不通过 / 读不到 → 主进程回 ok:true 但 data:null,这张就不显示
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

  const thumbs =
    rels.length === 0 ? (
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

  return (
    <NodeShell
      id={id}
      selected={selected}
      badge={NODE_TYPES.image.badge}
      hasTargetHandle={NODE_TYPES.image.ports.target === 1}
      hasSourceHandle={NODE_TYPES.image.ports.source === 1}
      kindClass="kind-image"
      meta={
        <>
          <span className="agent-node-cwd" title={prompt || '还没有画面描述'}>
            {promptLine}
          </span>
          <span className="agent-node-brief" title={`出图方式:${providerLabel} · ${n} 张 · ${size}`}>
            {providerLabel} · {n} 张 · {size}
          </span>
        </>
      }
      extra={thumbs}
    />
  )
}

export const ImageNode = memo(ImageNodeInner)
