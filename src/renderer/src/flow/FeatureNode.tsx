import { memo, type JSX } from 'react'
import { useResolvedProjectDir } from '../stores/graphStore'
import { NodeShell, type ShellNodeProps } from './NodeShell'

/**
 * 功能节点(feature)。串行 / 并行是**同一个组件** + `data.mode` 的两个视觉态
 * —— 底层一种节点,避免养两份几乎相同的代码(PRD §1.3 说明 1)。
 *
 * 端口:1 入、1 出。串行在上游成果上叠加;并行另起支路、不自动注入上游产出。
 */
function FeatureNodeInner({ id, selected, data }: ShellNodeProps): JSX.Element {
  const { dir: projectDir, source } = useResolvedProjectDir()
  const isParallel = data.mode === 'parallel'

  return (
    <NodeShell
      id={id}
      selected={selected}
      badge={
        isParallel
          ? { icon: 'parallel', text: '并行', cls: 'kind-parallel', title: '并行支路:独立开工,不自动注入上游产出' }
          : { icon: 'serial', text: '串行', cls: 'kind-serial', title: '串行:在上游成果上叠加' }
      }
      hasTargetHandle
      hasSourceHandle
      kindClass={isParallel ? 'kind-parallel' : 'kind-serial'}
      meta={
        <>
          {/* 串行/并行的工作目录都解析到项目文件夹(共享,无隔离)—— 只读展示 */}
          {projectDir ? (
            <span
              className="agent-node-cwd"
              title={
                projectDir +
                (source === 'canvas' ? '\n(来自画布级 projectDir 兜底,deprecated)' : '')
              }
            >
              {projectDir.split(/[\\/]/).filter(Boolean).slice(-2).join('/')}
            </span>
          ) : (
            <span className="agent-node-cwd" title="上游项目节点还没选文件夹">
              跟随项目文件夹(未设置)
            </span>
          )}
          {isParallel && (
            <span className="node-soft-hint" title="并行支路冲突约定(PRD §2.2)">
              共享项目代码 · 改动面别与其它支路重叠
            </span>
          )}
        </>
      }
    />
  )
}

export const FeatureNode = memo(FeatureNodeInner)
