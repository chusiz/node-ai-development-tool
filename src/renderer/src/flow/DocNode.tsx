import { memo, type JSX } from 'react'
import { useGraphStore, useResolvedProjectDir } from '../stores/graphStore'
import { NODE_TYPES } from '../../../shared/nodeRegistry'
import { NodeShell, type ShellNodeProps } from './NodeShell'

/**
 * 文档节点(doc)—— 会话类节点:按上游改动补写 / 更新文档,不改业务代码。
 *
 * 端口:1 入 1 出。它的产出(改了哪些文档、读者现在能照着做什么)继续往下传,
 * 所以放在链的靠后位置(整合之后、输出之前)最有用。
 *
 * 卡片上显示**它自己要写的文档往哪儿写**,以及有没有上游 ——
 * "文档节点不知道该写什么"通常就是没接上游,这件事得在卡片上看得出来。
 */
function DocNodeInner({ id, selected }: ShellNodeProps): JSX.Element {
  const { dir: projectDir } = useResolvedProjectDir()
  const inbound = useGraphStore((s) => s.edges.filter((e) => e.target === id).length)

  return (
    <NodeShell
      id={id}
      selected={selected}
      badge={NODE_TYPES.doc.badge}
      hasTargetHandle={NODE_TYPES.doc.ports.target === 1}
      hasSourceHandle={NODE_TYPES.doc.ports.source === 1}
      kindClass="kind-doc"
      meta={
        <>
          {projectDir ? (
            <span className="agent-node-cwd" title={projectDir}>
              {projectDir.split(/[\\/]/).filter(Boolean).slice(-2).join('/')}
            </span>
          ) : (
            <span className="agent-node-cwd">跟随项目文件夹(未设置)</span>
          )}
          <span className="agent-node-brief" title="跟着项目现有文档的风格写,已有的改而不是再写一份重复的">
            只写文档
          </span>
          {inbound === 0 && <span className="node-soft-hint">还没有上游</span>}
        </>
      }
    />
  )
}

export const DocNode = memo(DocNodeInner)
