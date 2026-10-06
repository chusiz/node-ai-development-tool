import { memo, type JSX } from 'react'
import { useGraphStore, useResolvedProjectDir } from '../stores/graphStore'
import { NodeShell, type ShellNodeProps } from './NodeShell'

/**
 * 整合节点(merge)—— 让各支路的改动互相兼容,合成一个能跑的程序。
 *
 * 端口:1 个可接收**多路连线**的输入点(React Flow 原生支持多线汇到同一点)、
 * 1 出。汇入 <2 时给软提示(不阻断,PRD §4.1)。
 */
function MergeNodeInner({ id, selected }: ShellNodeProps): JSX.Element {
  const { dir: projectDir } = useResolvedProjectDir()
  /*
   * 汇入数。拼字符串做依赖:只在这个数字变化时重渲染,
   * 而不是每拉一条无关的线就重算一次。
   */
  const inboundCount = useGraphStore(
    (s) => s.edges.filter((e) => e.target === id).length,
  )

  return (
    <NodeShell
      id={id}
      selected={selected}
      badge={{ icon: 'merge', text: '整合', cls: 'kind-merge', title: '整合节点:让各支路的改动互相兼容,合成一个能跑的程序' }}
      hasTargetHandle
      hasSourceHandle
      kindClass="kind-merge"
      meta={
        <>
          {projectDir ? (
            <span className="agent-node-cwd" title={projectDir}>
              {projectDir.split(/[\\/]/).filter(Boolean).slice(-2).join('/')}
            </span>
          ) : (
            <span className="agent-node-cwd">跟随项目文件夹(未设置)</span>
          )}
          <span className={inboundCount < 2 ? 'node-soft-hint' : 'agent-node-brief'}>
            汇入 {inboundCount} 条支路
            {inboundCount < 2 ? ' · 建议至少连接 2 条' : ''}
          </span>
        </>
      }
    />
  )
}

export const MergeNode = memo(MergeNodeInner)
