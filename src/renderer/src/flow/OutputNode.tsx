import { memo, useState, type JSX } from 'react'
import { useResolvedProjectDir } from '../stores/graphStore'
import { useNodeRunStatus, useWorkflowStore } from '../stores/workflowStore'
import { NodeShell, type ShellNodeProps } from './NodeShell'

/**
 * 输出节点(output)—— **内置动作节点**,不是 Agent。
 *
 * 端口:1 个(可多路)输入、**无**输出。它不启动 AI 会话、不消耗 token,
 * 打包由主进程的 Packager 直接执行 —— 所以节点上显著标注"内置打包 · 不耗 token"。
 *
 * 进度/产物路径走与 agent 相同的两条既有通道:
 *   - 打包日志 → 节点日志(notice)→ 底部正文行;
 *   - 运行状态 → RunNodeChip / RunBar tally。
 * 无需任何新通道 —— 外壳是共用的,这正是抽 NodeShell 的收益之一。
 */
function OutputNodeInner({ id, selected, data }: ShellNodeProps): JSX.Element {
  const { dir: projectDir } = useResolvedProjectDir()
  const status = useNodeRunStatus(id)
  const runBusy = status === 'running' || status === 'queued' || status === 'waiting'
  // P0 只有 exe 生效;apk/web 灰置(P1),UI 上提前如实显示
  const target = data.buildTarget ?? 'exe'
  const outDir = data.buildOptions?.outDir?.trim() || (projectDir ? `${projectDir}\\dist` : '<项目>\\dist')
  const [starting, setStarting] = useState(false)

  const startPack = async (): Promise<void> => {
    if (runBusy || starting) return
    setStarting(true)
    try {
      // 跑输出节点 = 打包它自己(targets 会自动带上游:项目/功能链先跑完)
      await useWorkflowStore.getState().runTargets([id])
    } finally {
      setStarting(false)
    }
  }

  return (
    <NodeShell
      id={id}
      selected={selected}
      badge={{ icon: 'output', text: '输出', cls: 'kind-output', title: '内置打包 · 不启动 AI 会话 · 不消耗 token' }}
      hasTargetHandle
      hasSourceHandle={false}
      kindClass="kind-output"
      meta={
        <>
          <span className="agent-node-cwd" title={`打包目标:${target === 'exe' ? 'Windows 安装包 (.exe)' : target}`}>
            打包:{target === 'exe' ? 'Windows exe' : `${target}(即将支持)`}
          </span>
          <span className="agent-node-brief" title={outDir}>
            输出:{outDir.split(/[\\/]/).filter(Boolean).slice(-2).join('/')}
          </span>
          {/*
            显眼的「开始打包」按钮(PRD §4.1)。也可以走 RunBar 的整图运行 ——
            两者最终走同一个 runTargets 路径,不会出现两条执行语义。
          */}
          <button className="mini node-pack" disabled={runBusy || starting} onClick={(e) => {
            e.stopPropagation()
            void startPack()
          }} title="打包这个项目的末端产物(Windows exe)">
            {runBusy || starting ? '打包中…' : '开始打包'}
          </button>
        </>
      }
    />
  )
}

export const OutputNode = memo(OutputNodeInner)
