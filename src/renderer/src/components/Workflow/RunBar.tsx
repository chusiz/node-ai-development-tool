import { useState, type JSX } from 'react'
import { useActiveRun, useWorkflowStore } from '../../stores/workflowStore'
import { useGraphIssues, useGraphStore } from '../../stores/graphStore'
import { useUiStore } from '../../stores/uiStore'
import { RunNodeChip } from './RunNodeChip'
import { Icon } from '../Icons'
import type { RunNodeState, RunStatus } from '../../../../shared/workflow'

/**
 * 工作流的控制条。浮在画布上沿。
 *
 * ## 为什么输入框放在这里而不是每个节点里
 *
 * `{{input}}` 是**整次运行**的公共输入(比如"这次要改的是登录页"),
 * 源头节点们共用它。放进单个节点的话,"跑一次这条流水线"就得先逐个节点填一遍,
 * 而这恰恰是用户最不想做的事。
 *
 * ## 运行中不做乐观更新
 *
 * 点了运行之后不自己造"正在跑"的状态 —— 权威在主进程,推送来了才显示。
 * 自己造的话,发起失败(有环)和真的跑起来在界面上会长得一样。
 *
 * ## 失败原因为什么落在这一条上(而不是顶栏)
 *
 * 顶栏那个 `claude 2.1.289` 回答的是"**装没装**",而用户真正撞上的问题是
 * "**跑起来为什么停**"。这两件事的处置方向完全不同:前者去装 CLI,
 * 后者去改 Key / 充钱 / 换模型。放进顶栏会让那串版本号承担它答不了的问题,
 * 而 RunBar 本来就是"这次运行怎么了"的唯一出口(失败计数、校验提示都在这),
 * 失败原因放这里是同一类信息的自然延伸,不需要新开一处常驻 UI。
 */

const SCOPE_LABEL: Record<RunStatus, { cls: string; text: string }> = {
  running: { cls: 'warn', text: '运行中' },
  done: { cls: 'ok', text: '全部完成' },
  failed: { cls: 'err', text: '有失败' },
  cancelled: { cls: '', text: '已取消' },
}

export function RunBar(): JSX.Element | null {
  const run = useActiveRun()
  const starting = useWorkflowStore((s) => s.starting)
  const error = useWorkflowStore((s) => s.error)
  const cycle = useWorkflowStore((s) => s.cycle)
  const input = useWorkflowStore((s) => s.input)
  const setInput = useWorkflowStore((s) => s.setInput)
  const runAll = useWorkflowStore((s) => s.runAll)
  const cancel = useWorkflowStore((s) => s.cancel)
  const clearError = useWorkflowStore((s) => s.clearError)

  const nodeCount = useGraphStore((s) => s.nodes.length)
  const edgeCount = useGraphStore((s) => s.edges.length)
  const selectedNodeId = useUiStore((s) => s.selectedNodeId)
  // 运行前图校验(P0-8)。同一份纯函数主进程 run() 里也会跑一遍并写进节点日志,
  // 这里提前在界面上亮出来 —— "跑之前就知道哪里不妥"比"跑完看日志"体验好得多
  const issues = useGraphIssues()

  const [open, setOpen] = useState(false)
  const [warnsOpen, setWarnsOpen] = useState(false)
  const [failsOpen, setFailsOpen] = useState(false)

  const running = run?.status === 'running' || starting
  const tally = run ? tallyOf(run.nodes) : null
  // 只在**已经结束**的运行上展示:运行中的失败不该被当成最终结论
  // (调度器可能正在退避重试,那时报"不可重试"是骗人)
  const fails = run && !running ? hardFailuresOf(run.nodes) : []

  return (
    <div className="run-bar">
      <button
        className="primary"
        // 空画布 / 正在跑都点不动 —— 连点两次会发起两次运行,
        // 第二次会因为"节点正在运行中"整片失败,看起来像坏了
        disabled={running || nodeCount === 0}
        onClick={() => void runAll()}
        title={nodeCount === 0 ? '先加个节点' : '按连线顺序跑完整张图 (Ctrl+Enter)'}
      >
        <Icon name="play" size={12} />
        跑全部
      </button>

      <button
        disabled={running || !selectedNodeId}
        onClick={() => {
          if (selectedNodeId) void useWorkflowStore.getState().runTargets([selectedNodeId])
        }}
        title="只跑选中节点(连同它的上游)(Ctrl+Shift+Enter)"
      >
        <Icon name="play" size={12} />
        只跑选中
      </button>

      {tally && (
        <>
          <span className={`badge ${SCOPE_LABEL[run!.status].cls}`}>{SCOPE_LABEL[run!.status].text}</span>
          <span className="run-tally" title="完成 / 总数">
            {tally.done}/{tally.total}
            {tally.failed > 0 && <span className="err"> · 失败 {tally.failed}</span>}
            {tally.skipped > 0 && <span> · 跳过 {tally.skipped}</span>}
            {tally.waiting > 0 && <span> · 等待 {tally.waiting}</span>}
          </span>
        </>
      )}

      {running && (
        <button className="danger" onClick={() => void cancel(run!.runId)}>
          <Icon name="stop" size={11} />
          取消
        </button>
      )}

      <button className={open ? 'ghost on' : 'ghost'} onClick={() => setOpen((v) => !v)}>
        {input.trim() ? (
          <>
            输入
            <Icon name="dot" size={8} className="dirty-dot" />
          </>
        ) : (
          '输入'
        )}
      </button>

      {open && (
        <div className="run-input">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={'给这次运行的一句话(可选)\n会作为 {{input}} 拼在每个源头节点的提示词后面'}
            rows={3}
          />
          <div className="hint">只影响这次运行,不写进节点配置</div>
        </div>
      )}

      {/*
       * 校验提示:warn 级不阻断运行(M6 决策),但要让用户在点「跑」之前看到。
       * 收进一个可展开的小块而不是平铺 —— 提示多了会把运行条撑成一面墙。
       */}
      {!running && issues.length > 0 && (
        <button
          className={warnsOpen ? 'ghost on run-warns-toggle' : 'ghost run-warns-toggle'}
          onClick={() => setWarnsOpen((v) => !v)}
          title="展开查看运行前检查提示"
        >
          <Icon name="alert" size={12} />
          检查 {issues.length}
        </button>
      )}

      {warnsOpen && !running && issues.length > 0 && (
        <div className="run-warns">
          {issues.map((w, i) => (
            <div key={i} className={w.level === 'error' ? 'run-warn err' : 'run-warn'}>
              <Icon name="alert" size={12} />
              <span>{w.message}</span>
            </div>
          ))}
        </div>
      )}

      {/*
       * 失败原因。
       *
       * 收成一块而不是平铺,理由与上面的校验提示一样:提示一多就把运行条撑成一面墙。
       * 折叠态只留「哪几个节点 + 一句话原因」,展开才逐条看 ——
       * 而 hover 就已经能看到全文,多数时候根本不用点开。
       *
       * 只列**归出了类**的那些(`errorKind` 有值):没归类的失败原因是一句
       * 「会话以 error 结束(code 1)」,它进节点日志已经够了,搬到这儿只是噪音。
       */}
      {fails.length > 0 && (
        <button
          className={failsOpen ? 'ghost on run-fails-toggle' : 'ghost run-fails-toggle'}
          onClick={() => setFailsOpen((v) => !v)}
          title={fails.map((f) => `${f.title}:${f.reason}`).join('\n')}
        >
          <Icon name="alert" size={12} />
          失败原因 {fails.length}
        </button>
      )}

      {failsOpen && fails.length > 0 && (
        <div className="run-fails">
          {fails.map((f) => (
            <div key={f.nodeId} className="run-fail" title={f.reason}>
              <Icon name="alert" size={12} />
              <span className="run-fail-title">{f.title}</span>
              <span className="run-fail-reason">{f.reason}</span>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="run-error">
          <span className="err">发起失败:{error}</span>
          {cycle.length > 0 && (
            <span className="hint">
              环上的节点:{cycle.map((id) => titleOf(id)).join(' → ')}
            </span>
          )}
          <button className="mini" onClick={clearError}>
            知道了
          </button>
        </div>
      )}

      {edgeCount === 0 && nodeCount > 1 && !running && (
        <span className="hint-inline">
          节点之间还没连线 —— 现在它们各跑各的,不会互相传递结果
        </span>
      )}

      {/*
        键盘提示常驻在运行条最右。
        运行条在布局流里(不占画布像素),所以这条提示是"白捡"的可见度 ——
        快捷键最大的问题是没人知道它存在,而这里恰好是用户点「跑」时会看的地方。
      */}
      <span className="run-keys">
        <span className="kbd">Ctrl</span>
        <span className="sc-sep">+</span>
        <span className="kbd">Enter</span>
        <span className="run-keys-label">跑全部</span>
        <button
          className="linklike"
          title="查看全部快捷键 (?)"
          onClick={() => useUiStore.getState().setShowShortcuts(true)}
        >
          快捷键
        </button>
      </span>
    </div>
  )
}

function tallyOf(nodes: Record<string, { status: string }>): {
  total: number
  done: number
  failed: number
  skipped: number
  waiting: number
} {
  let done = 0
  let failed = 0
  let skipped = 0
  let waiting = 0
  for (const n of Object.values(nodes)) {
    if (n.status === 'done') done++
    else if (n.status === 'failed') failed++
    else if (n.status === 'skipped' || n.status === 'cancelled') skipped++
    else waiting++
  }
  return { total: Object.keys(nodes).length, done, failed, skipped, waiting }
}

interface RunFailure {
  nodeId: string
  title: string
  /** 面向用户的原因(调度器给的就是人话,这里不加工) */
  reason: string
}

/**
 * 本次运行里**归出了类**的失败。
 *
 * ⚠️ 判据是 `errorKind` 有值,不是 `status === 'failed'`:
 * `errorKind` 只有在调度器把错误归进已知类别时才会写(见 shared/failure.ts),
 * 而那里的判定是**保守**的 —— 归不出来的失败没有 `errorKind`。
 * 那样做的理由:没归类的失败原因是一句「会话以 error 结束(code 1)」,
 * 摆到运行条上既不增加信息量,又会把真正该看的几条(余额不足、鉴权失败)淹没。
 *
 * 排序:不可重试的排前面。同为失败,「改了配置才能好」比「可能自己好」更需要立刻看见。
 */
function hardFailuresOf(nodes: Record<string, RunNodeState>): RunFailure[] {
  return Object.values(nodes)
    .filter((n) => n.status === 'failed' && !!n.errorKind && !!n.error)
    .sort((a, b) => Number(b.errorRetryable === false) - Number(a.errorRetryable === false))
    .map((n) => ({ nodeId: n.nodeId, title: titleOf(n.nodeId), reason: n.error as string }))
}

/** 环里的 id 换成标题,不然用户看到一串 n1a2b3c 不知道是哪个 */
function titleOf(id: string): string {
  const n = useGraphStore.getState().nodes.find((x) => x.id === id)
  return n?.data.title ?? id
}
