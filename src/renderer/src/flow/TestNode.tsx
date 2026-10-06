import { memo, type JSX } from 'react'
import { useGraphStore, useResolvedProjectDir } from '../stores/graphStore'
import { useNodeRunStatus, useWorkflowStore } from '../stores/workflowStore'
import { NODE_TYPES } from '../../../shared/nodeRegistry'
import { Icon } from '../components/Icons'
import { NodeShell, type ShellNodeProps } from './NodeShell'

/**
 * 测试节点(test)—— **内置动作节点**,与 output / image 同族(不是 Agent)。
 *
 * 端口:1 入 1 出。它在项目目录里跑一条用户填的测试命令,把**退出码与日志**
 * 交给下游。不启动 AI 会话、不消耗 token —— "通没通过"是退出码说了算的客观事实,
 * 交给模型复述只会引入误差。
 *
 * 卡片上要能看出"这一下会跑什么":命令原文 + 超时。测试脚本跑起来可能要几分钟,
 * 命令看不全的话用户没法确认自己点的是哪个节点。
 *
 * 正文行沿用 NodeShell 的"最后一行"机制:执行器把每一行日志经 notice 冒泡上来,
 * 于是节点卡片上滚动的就是真实的测试输出,不需要任何新通道。
 */
function TestNodeInner({ id, selected, data }: ShellNodeProps): JSX.Element {
  const { dir: projectDir } = useResolvedProjectDir()
  const status = useNodeRunStatus(id)
  const runBusy = status === 'running' || status === 'queued' || status === 'waiting'
  // 失败策略只在这里只读展示:默认 skip = 测试没过就跳过下游(见注册表的注释)
  const onFail = useGraphStore((s) => s.nodes.find((n) => n.id === id)?.data.failurePolicy)

  const command = (data.testCommand ?? '').trim()
  const timeout = data.testTimeoutSec ?? 300

  return (
    <NodeShell
      id={id}
      selected={selected}
      badge={NODE_TYPES.test.badge}
      hasTargetHandle={NODE_TYPES.test.ports.target === 1}
      hasSourceHandle={NODE_TYPES.test.ports.source === 1}
      kindClass="kind-test"
      meta={
        <>
          {projectDir ? (
            <span className="agent-node-cwd" title={projectDir}>
              {projectDir.split(/[\\/]/).filter(Boolean).slice(-2).join('/')}
            </span>
          ) : (
            <span className="agent-node-cwd">跟随项目文件夹(未设置)</span>
          )}
          {/* 命令是"这个节点到底干什么"的全部内容 —— 留空也要显式说出来 */}
          <span className={`agent-node-brief ${command ? '' : 'unset'}`} title={command || '还没填测试命令'}>
            {command || '未配置测试命令'}
          </span>
          <span className="agent-node-brief" title={`超时 ${timeout} 秒;上游失败策略:${policyText(onFail)}`}>
            {timeout}s
          </span>
          {/*
            就地跑这个节点。与输出节点的「开始打包」同一条路径(runTargets),
            只有文案不同 —— 不会出现两套执行语义。
          */}
          <button
            className="mini node-run-test"
            disabled={runBusy}
            title="在项目目录里跑这条测试命令(连同它的上游)"
            onClick={(e) => {
              e.stopPropagation()
              void useWorkflowStore.getState().runTargets([id])
            }}
          >
            <Icon name="play" size={11} />
            {runBusy ? '测试中…' : '开始测试'}
          </button>
        </>
      }
    />
  )
}

/** 失败策略的中文短文案(卡片上只放这几个字) */
function policyText(p: string | undefined): string {
  if (p === 'continue') return '当空产出继续'
  if (p === 'stop') return '整条停止'
  return '跳过下游'
}

export const TestNode = memo(TestNodeInner)
