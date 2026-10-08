import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useGraphStore } from '../../stores/graphStore'
import { useRuntimeStore } from '../../stores/runtimeStore'
import { useUiStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useNodeActions } from '../../hooks/useNodeActions'
import { agentDisplayNameMap } from '../../lib/agentNames'
import { t } from '../../lib/i18n'
import { effectiveModel, providerIdOfAgent } from '../../../../shared/providers'
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
  const diagCount = useRuntimeStore((s) => s.runtimes[selectedNodeId ?? '']?.diagnostics.length ?? 0)

  /* 当前节点用的 agent 显示名(agents.list 的一次性映射,模块级缓存) */
  const [agentNames, setAgentNames] = useState<Record<string, string> | null>(null)
  useEffect(() => {
    void agentDisplayNameMap().then(setAgentNames)
  }, [])

  /* 节点实际生效的模型:节点显式选的 > 该供应商全局默认 > 内置首选(与运行时一致) */
  const agentProviders = useSettingsStore((s) => s.payload?.current?.agent?.providers)
  const effectiveForNode = useMemo(() => {
    if (!node) return ''
    const pid = providerIdOfAgent(node.data.agentId)
    const def = pid ? (agentProviders?.[pid]?.defaultModel ?? '') : ''
    return effectiveModel(node.data.agentId, node.data.model, def)
  }, [node, agentProviders])

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
          <div>{t('inspector.noSelection')}</div>
          <div className="sub">
            {t('inspector.noSelectionSub')}
            <br />
            {t('inspector.noSelectionSub2')}
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
          title={t('inspector.newSessionTitle')}
        >
          {t('inspector.newSession')}
        </button>
      </header>

      <div className="inspector-sub">
        <span className="badge">
          {turns} {t('inspector.rounds')}
          {turns > 0 ? ` · ${t('inspector.sameSession')}` : ''}
        </span>
        {(() => {
          /* 当前节点实际用的 AI 与 agent:agent 名 + 生效模型(节点选的 > 全局默认) */
          const aid = node.data.agentId
          if (!aid) return null
          const aname = agentNames ? (agentNames[aid] ?? aid) : aid
          return (
            <span className="badge node-agent" title={t('inspector.agentTitle')}>
              {aname}
              {effectiveForNode ? ` · ${effectiveForNode}` : ''}
            </span>
          )
        })()}
        {diagCount > 0 && (
          <button className={showDiag ? 'primary mini' : 'mini'} onClick={toggleDiag}>
            {t('inspector.diagnosis')} {diagCount}
          </button>
        )}
      </div>

      <nav className="tabs">
        <button className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>
          {t('inspector.chatTab')}
        </button>
        <button className={tab === 'config' ? 'active' : ''} onClick={() => setTab('config')}>
          {t('inspector.configTab')}
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
