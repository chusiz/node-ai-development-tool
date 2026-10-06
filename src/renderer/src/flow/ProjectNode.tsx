import { memo, useState, type JSX } from 'react'
import { unwrap } from '../lib/unwrap'
import { useGraphStore, useResolvedProjectDir } from '../stores/graphStore'
import { useUiStore } from '../stores/uiStore'
import { NodeShell, type ShellNodeProps } from './NodeShell'

/**
 * 项目节点 —— 画布起点,项目文件夹的**唯一权威来源**(用户决策 Q1)。
 *
 * 端口:无入(0 个 target)、1 出。连进来会被 onConnect 拒绝。
 *
 * "选文件夹"写的是**这个节点自己**的 projectDir 字段(不再是画布级)。
 * 为什么从节点按钮进来却写节点字段、而不是又去写画布:用户在项目节点上
 * 看到按钮的那一刻,语境就是"这个项目在哪个目录" —— v2 起权威就在节点上,
 * 画布级字段只剩 deprecated 兜底(由 ProjectDirButton 只读展示)。
 */
function ProjectNodeInner({ id, selected }: ShellNodeProps): JSX.Element {
  const { dir: resolvedDir, source } = useResolvedProjectDir()
  const nodeProjectDir = useGraphStore((s) => s.nodes.find((n) => n.id === id)?.data.projectDir ?? '')
  const brief = useGraphStore((s) => s.nodes.find((n) => n.id === id)?.data.brief ?? '')
  // 选目录失败的原因,就地显示在按钮原来的位置(与旧节点卡片同一条规矩:
  // "点了没反应"和"失败了"必须在原地可辨,不能只进一条看不见的错误通道)
  const [dirErr, setDirErr] = useState<string | null>(null)

  const pick = async (): Promise<void> => {
    try {
      const picked = unwrap(
        await window.api.dialog.pickDirectory('选择这个项目的文件夹', nodeProjectDir || resolvedDir || undefined),
      )
      if (!picked) return
      // ⚠️ 写节点自身的 projectDir —— 这是权威字段,不是画布级 projectDir
      useGraphStore.getState().patchConfig(id, { projectDir: picked })
      // 选中是为了让用户看清是哪个节点触发的;不切页签 ——
      // 路径立刻出现在节点卡片上,反馈已经够了
      useUiStore.getState().select(id)
    } catch (e) {
      setDirErr((e as Error).message)
    }
  }

  const dir = nodeProjectDir || resolvedDir

  return (
    <NodeShell
      id={id}
      selected={selected}
      badge={{ icon: 'project', text: '项目', cls: 'kind-project', title: '项目节点:项目文件夹的唯一权威来源' }}
      hasTargetHandle={false}
      hasSourceHandle
      kindClass="kind-project"
      // 空串 = 明确"不显示上游"(undefined 才会回落到自动推导)。
      // project 是画布源头,永远不该有"← 上游"提示
      upstream=""
      meta={
        <>
          {dirErr ? (
            <span className="agent-node-cwd err" title={dirErr}>
              打不开文件夹选择器:{dirErr}
            </span>
          ) : dir ? (
            <span className="agent-node-cwd" title={dir}>
              {dir.split(/[\\/]/).filter(Boolean).slice(-2).join('/')}
            </span>
          ) : (
            <button
              className="node-need-cwd"
              title={
                '项目节点是整张画布项目文件夹的权威来源。\n点这里选一个真实项目文件夹,下游的串行/并行/整合/输出节点都会在这个目录里干活'
              }
              onClick={(e) => {
                e.stopPropagation()
                void pick()
              }}
            >
              未选择 · 点此选文件夹
            </button>
          )}
          {brief && (
            <span className="agent-node-brief" title={brief}>
              {brief.split('\n')[0]}
            </span>
          )}
        </>
      }
    />
  )
}

export const ProjectNode = memo(ProjectNodeInner)
