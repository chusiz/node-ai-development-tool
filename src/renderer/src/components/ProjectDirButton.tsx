import type { JSX } from 'react'
import { useResolvedProjectDir } from '../stores/graphStore'

/**
 * 顶栏上的「项目文件夹」—— **只读诊断项**(v2 起 deprecated,M4 决策)。
 *
 * v1 时它是画布级项目文件夹的设置入口;v2 起项目文件夹的唯一权威转移到
 * **项目节点**(用户决策 Q1),这里不再提供编辑 —— 如果保留可写,就会出现
 * 两个都能改目录的地方,而"界面显示 A、agent 跑在 B"的漂移正是这么来的。
 *
 * 现在它的职责只剩**如实报告**:当前生效的目录是什么、来自哪里(项目节点 /
 * 画布级兜底 / 未设置)。用户想换目录,去项目节点上选 —— 界面文案要指过去。
 */
export function ProjectDirButton(): JSX.Element {
  const { dir, source } = useResolvedProjectDir()

  // 尾巴两段就够认出来是哪个项目(盘符 + 项目名),完整路径挂在 title 上
  const short = dir ? dir.split(/[\\/]/).filter(Boolean).slice(-2).join('/') : ''

  const title =
    source === 'node'
      ? `项目文件夹:${dir}\n来源:项目节点(权威)。要更换,请在画布上的项目节点里选择`
      : source === 'canvas'
        ? `项目文件夹:${dir}\n来源:画布级 projectDir(deprecated 兜底 —— 画布上还没有项目节点)`
        : '未设置项目文件夹 —— 节点将跑在画布沙箱里。\n在画布上放一个「项目节点」并选择文件夹,即可让 agent 在真实项目里干活'

  return (
    <span
      className={
        source === 'node'
          ? 'project-dir readonly'
          : source === 'canvas'
            ? 'project-dir readonly deprecated'
            : 'project-dir readonly unset'
      }
      title={title}
      // role/aria:长得像状态标签而不是按钮,点不出任何东西
      role="status"
    >
      {source === 'node' && `📁 ${short}`}
      {source === 'canvas' && `📁 ${short} · 画布兜底`}
      {source === 'none' && '📁 未设置(沙箱)'}
    </span>
  )
}
