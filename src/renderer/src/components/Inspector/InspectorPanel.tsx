import { useEffect, useRef, type JSX } from 'react'
import { useGraphStore } from '../../stores/graphStore'
import { useRuntimeStore } from '../../stores/runtimeStore'
import { useUiStore } from '../../stores/uiStore'
import { useNodeActions } from '../../hooks/useNodeActions'
import { NodeConfigPanel } from '../NodeConfig/NodeConfigPanel'
import { Composer } from './Composer'
import { MessageList } from './MessageList'
import { Icon } from '../Icons'

/**
 * 右栏。选中哪个节点就显示哪个节点的对话与配置。
 *
 * 「配置」和「对话」分成两个页签而不是并排:右栏宽度有限,
 * cwd / 权限模式 / 模板这些字段和消息流抢同一块地方,两边都难用。
 */
export function InspectorPanel(): JSX.Element {
  const selectedNodeId = useUiStore((s) => s.selectedNodeId)
  const tab = useUiStore((s) => s.inspectorTab)
  const setTab = useUiStore((s) => s.setInspectorTab)
  const showDiag = useUiStore((s) => s.showDiag)
  const toggleDiag = useUiStore((s) => s.toggleDiag)
  const canvasId = useGraphStore((s) => s.canvasId)
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === selectedNodeId))
  const status = useRuntimeStore((s) => s.runtimes[selectedNodeId ?? '']?.status ?? 'idle')
  const turns = useRuntimeStore((s) => s.runtimes[selectedNodeId ?? '']?.turns ?? 0)
  const model = useRuntimeStore((s) => s.runtimes[selectedNodeId ?? '']?.model ?? null)
  const diagCount = useRuntimeStore((s) => s.runtimes[selectedNodeId ?? '']?.diagnostics.length ?? 0)

  /*
   * hooks 不能在条件分支之后调用,所以这里先把 actions 拿好
   * (nodeId 为空时它也不会被用到)
   */
  const actions = useNodeActions(selectedNodeId ?? '')

  /*
   * 进来该停在哪一页:**对话**。
   *
   * 这里原来还有一条「没有工作目录 → 强制配置页」。那条现在删掉了,
   * 因为它把两件事混成了一件:
   *
   *  - 没有项目文件夹,不再是"没配好"—— agent 会跑在画布沙箱里,对话照常;
   *  - 把用户按在一个**没有输入框**的表单上,正是「那怎么和节点对话呢」
   *    和「跟 AI 说句话得先编个项目目录」的来源。
   *
   * 「节点配置」是想要才去的地方,所以手动切过去不会被抢回来 ——
   * 只有换了个节点才会切回对话。
   *
   * ⚠️ 但"换节点"要区分两种情况:用户点画布上的节点(默认回对话),
   * 还是程序带着页签意图选中(如「放置项目节点」要直接打开配置页)。
   * 后者由 select(id, tab) 记在 store 里,这里消费一次,不要抢回去。
   */
  const prevSelected = useRef<string | null>(null)
  const consumeSelectionTab = useUiStore((s) => s.consumeSelectionTab)

  useEffect(() => {
    if (!selectedNodeId) {
      prevSelected.current = null
      return
    }
    if (prevSelected.current === selectedNodeId) return
    prevSelected.current = selectedNodeId
    // 这次选中自带的页签意图优先 —— 没有才回落"对话"
    setTab(consumeSelectionTab() ?? 'chat')
  }, [selectedNodeId, setTab, consumeSelectionTab])

  if (!selectedNodeId || !node) {
    return (
      <aside className="inspector">
        <div className="inspector-empty">
          <div className="big">
            <Icon name="logo" size={30} />
          </div>
          <div>还没有选中节点</div>
          <div className="sub">
            点画布上的任意一个节点,在下面的输入框里跟它说话
            <br />
            要让它改你的项目,再去「节点配置」里选项目文件夹
          </div>
        </div>
      </aside>
    )
  }

  const running = status === 'running'

  return (
    <aside className="inspector">
      <header className="inspector-head">
        <div className="inspector-title" title={node.data.title}>
          {node.data.title}
        </div>
        <span className="spacer" />
        <button
          onClick={() => void actions.newSession()}
          disabled={running}
          title="清空这个节点的会话与磁盘日志,下一句话会是全新会话"
        >
          新会话
        </button>
      </header>

      <div className="inspector-sub">
        <span className="badge">
          {turns} 轮{turns > 0 ? ` · 续用同一会话` : ''}
        </span>
        {model && <span className="badge">{model}</span>}
        {diagCount > 0 && (
          <button className={showDiag ? 'primary mini' : 'mini'} onClick={toggleDiag}>
            诊断 {diagCount}
          </button>
        )}
      </div>

      <nav className="tabs">
        <button className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>
          对话
        </button>
        <button className={tab === 'config' ? 'active' : ''} onClick={() => setTab('config')}>
          节点配置
        </button>
      </nav>

      {tab === 'chat' ? (
        <div className="inspector-body">
          <MessageList nodeId={selectedNodeId} canvasId={canvasId} />
        </div>
      ) : (
        <div className="inspector-body scroll">
          <NodeConfigPanel nodeId={selectedNodeId} />
        </div>
      )}

      {/*
        输入框**常驻**,两个页签下都在。
        原来它只在「对话」页里 —— 于是停在配置页的用户眼前一个输入框都没有,
        想问「那怎么和节点对话呢?」。而且配置和对话本来就不冲突:
        改完权限模式顺手就能说一句话,不必先切页签。
      */}
      <Composer nodeId={selectedNodeId} />
    </aside>
  )
}
