import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type OnConnect,
  type OnEdgesChange,
  type OnNodesChange,
  type OnSelectionChangeParams,
  type Viewport,
} from '@xyflow/react'
import { useGraphStore } from '../stores/graphStore'
import { useUiStore } from '../stores/uiStore'
import { useWorkflowStore } from '../stores/workflowStore'
import { nodeTypes } from './nodeTypes'
import { edgeTypes } from './edgeTypes'
import { setCanvasBridge } from '../lib/shortcuts'
import { deleteNodeWithConfirm } from '../lib/nodeOps'
import { workspaceNodeList, WORKFLOW_TEMPLATES, type WorkspaceId } from '../../../shared/nodeRegistry'
import { Icon, NodeIcon } from '../components/Icons'
import { ProbeCard } from './ProbeCard'
import type { NodeConfig, NodeKind } from '../../../shared/canvas'
import { t, nodeEntryLabel } from '../lib/i18n'
import { exportWorkflowFile, importWorkflowFile } from '../lib/workflowIO'

/** 节点数超过这个值就自动关掉 MiniMap —— 小地图要一直维护一张全图缩略 */
const MINIMAP_MAX_NODES = 50

function CanvasInner(): JSX.Element {
  const nodes = useGraphStore((s) => s.nodes)
  const edges = useGraphStore((s) => s.edges)
  const viewport = useGraphStore((s) => s.viewport)
  const onNodesChange = useGraphStore((s) => s.onNodesChange)
  const onEdgesChange = useGraphStore((s) => s.onEdgesChange) as OnEdgesChange
  const onConnect = useGraphStore((s) => s.onConnect) as OnConnect
  const onViewportChange = useGraphStore((s) => s.onViewportChange)
  const addNode = useGraphStore((s) => s.addNode)
  /*
   * 添加菜单按**工作区**过滤(v0.5.0):生图页只出现生图节点,
   * 软件页只出现软件节点。菜单随工作区切换实时变化。
   */
  const workspace = useUiStore((s) => s.workspace)
  const ADD_ENTRIES = useMemo(() => workspaceNodeList(workspace), [workspace])
  /** 工作区可见的模板(生图页只列生图模板,软件页只列软件模板) */
  const TEMPLATE_LIST = useMemo(
    () => Object.entries(WORKFLOW_TEMPLATES).filter(([, t]) => t.workspace === workspace),
    [workspace],
  )
  const [wfMenuOpen, setWfMenuOpen] = useState(false)
  const applyTemplate = useGraphStore((s) => s.applyTemplate)
  const removeEdge = useGraphStore((s) => s.removeEdge)
  const encapsulate = useGraphStore((s) => s.encapsulate)
  const edgeError = useGraphStore((s) => s.edgeError)
  const edgeWarn = useGraphStore((s) => s.edgeWarn)

  const selectedNodeId = useUiStore((s) => s.selectedNodeId)
  const selectedEdgeId = useUiStore((s) => s.selectedEdgeId)
  const select = useUiStore((s) => s.select)
  const selectEdge = useUiStore((s) => s.selectEdge)
  /** 框选/多选出的节点数(订阅数字而不是数组:数字没变就不重渲染) */
  const multiCount = useUiStore((s) => s.selectedIds.length)
  const probe = useUiStore((s) => s.probe)

  /*
   * 环检测失败时把环上的边染红。
   *
   * 不改 graphStore 里的 edges —— 那是用户的配置,不该被一次失败的运行改写
   * (改了就存盘,重开还有红色)。这里只在渲染时派生一份带 class 的副本。
   *
   * 同时在这里给每条边挂上**渲染类型**(可切断)。挂在这一层而不是写进 store:
   * store 里的边必须是 `{ id, source, target }` 三个字段 —— 它是会被
   * `toGraph()` 原样写进 graph.json 的形状。往里塞 `type: 'cuttable'`
   * 等于把渲染实现泄漏进数据格式,以后换线型就会变成一次数据迁移。
   */
  const cycle = useWorkflowStore((s) => s.cycle)
  const displayEdges = useMemo(() => {
    // 环是一串首尾相接的节点 id,把相邻两两配成边
    const onCycle = new Set<string>()
    for (let i = 0; i + 1 < cycle.length; i++) onCycle.add(`${cycle[i]}\u0000${cycle[i + 1]}`)
    return edges.map((e) => ({
      ...e,
      type: 'cuttable',
      ...(onCycle.has(`${e.source}\u0000${e.target}`) ? { className: 'edge-cycle' } : null),
    }))
  }, [edges, cycle])

  // 放在 Provider 内部才能拿到真实的画布坐标转换 ——
  // 自己按 viewport 手算的话,侧栏/顶栏宽度一变,新节点就跑到视口外面去了
  const { screenToFlowPosition, fitView } = useReactFlow()

  /*
   * 把「缩放到刚好装下」交给 App 层的快捷键表(Ctrl+0)。
   * fitView 只有 Provider 内部拿得到,而那整张表不该被关进画布里 ——
   * 用一个显式的小槽对接,比把跑全部/删节点这些无关动作一起搬进来干净。
   */
  useEffect(() => {
    setCanvasBridge({ fitView: () => void fitView({ padding: 0.2, duration: 220 }) })
    return () => setCanvasBridge(null)
  }, [fitView])

  // 选中的节点被删掉后,Inspector 必须跟着落到空态
  useEffect(() => {
    if (selectedNodeId && !nodes.some((n) => n.id === selectedNodeId)) select(null)
  }, [nodes, selectedNodeId, select])

  /*
   * 框选/多选结果进 uiStore(「封装成子图」按它显隐)。
   * 用 getState 写而不是订阅:画布本体不需要因为选区变化重渲染,
   * 只有工具栏那个按钮(subscribe 的是 length)需要。
   */
  const onSelectionChange = useCallback(({ nodes: picked }: OnSelectionChangeParams) => {
    useUiStore.getState().setMultiSelection(picked.map((n) => n.id))
  }, [])

  /*
   * 这是上面那条的连线版本:选中的线被切断之后,工具栏的「断开连线」必须落回空态。
   *
   * 放在这里而不是让 removeEdge 顺手清 uiStore,是为了**不让两个 store 互相 import** ——
   * graphStore 一旦认识 uiStore,"谁删了边"就会散成两处真相。
   * 用"状态里指向的东西还在不在"来派生,是这套代码里已经有的写法(见上面那条)。
   */
  useEffect(() => {
    if (selectedEdgeId && !edges.some((e) => e.id === selectedEdgeId)) selectEdge(null)
  }, [edges, selectedEdgeId, selectEdge])

  /*
   * 类型选择菜单的开与关都在 uiStore 里(快捷键 Ctrl+K 要能掀开它)。
   * 这里只负责菜单自己的两件事:**焦点落在第一项**、**点画布别处关掉**。
   *
   * 让菜单项拿到真实焦点而不是自己记一个"高亮第几项":
   * 键盘用户的 Enter / Space 就是原生激活,焦点环也由系统给,
   * 不用再自己画一套高亮 + 自己判断回车。
   */
  const addMenuOpen = useUiStore((s) => s.addMenuOpen)
  const setAddMenuOpen = useUiStore((s) => s.setAddMenuOpen)
  const addWrapRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    if (!addMenuOpen) return
    itemRefs.current[0]?.focus()
    const onPointerDown = (e: PointerEvent): void => {
      if (!addWrapRef.current?.contains(e.target as Node)) setAddMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [addMenuOpen, setAddMenuOpen])

  const handleAdd = useCallback(
    (kind: NodeKind, preset?: Partial<NodeConfig>) => {
      const center = screenToFlowPosition({
        x: window.innerWidth / 2 - 260,
        y: window.innerHeight / 2 - 120,
      })
      // preset 来自入口(如并行入口带 { mode: 'parallel' })—— 底层一种节点,视觉两种
      addNode(center, kind, preset)
      setAddMenuOpen(false)
    },
    [addNode, screenToFlowPosition, setAddMenuOpen],
  )

  /** 菜单内的方向键 / 数字直选。Enter、Space 交给按钮自己(原生激活) */
  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const items = itemRefs.current.filter((el): el is HTMLButtonElement => el !== null)
    if (items.length === 0) return
    const idx = items.indexOf(document.activeElement as HTMLButtonElement)

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      items[idx < 0 ? 0 : (idx + 1) % items.length].focus()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      items[idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length].focus()
      return
    }
    if (e.key === 'Home') {
      e.preventDefault()
      items[0].focus()
      return
    }
    if (e.key === 'End') {
      e.preventDefault()
      items[items.length - 1].focus()
      return
    }
    // 数字键直选:菜单里每项左边就写着它的序号,按 3 就是第三项
    const n = Number.parseInt(e.key, 10)
    if (Number.isInteger(n) && n >= 1 && n <= items.length) {
      e.preventDefault()
      items[n - 1].click()
    }
  }

  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange as OnNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onViewportChange={(vp: Viewport) => onViewportChange(vp)}
        onNodeClick={(_, n) => select(n.id)}
        onEdgeClick={(_, e) => selectEdge(e.id)}
        onPaneClick={() => select(null)}
        onSelectionChange={onSelectionChange}
        // 大画布只挂载视口内的节点,收益随节点数线性增长
        onlyRenderVisibleElements
        defaultViewport={viewport}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        fitView={false}
        panOnScroll
        selectionOnDrag
        deleteKeyCode={null}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#222b38" />
        <Controls showInteractive={false} />
        {nodes.length <= MINIMAP_MAX_NODES && (
          <MiniMap
            pannable
            zoomable
            nodeColor="#2f4a75"
            maskColor="rgb(13 16 23 / 70%)"
            style={{ background: '#141922' }}
          />
        )}
      </ReactFlow>

      {/* 画布工具条。放在 Provider 内部,坐标转换才准 */}
      <div className="canvas-tools">
        <div className="add-wrap" ref={addWrapRef}>
          <button
            className="primary"
            aria-haspopup="menu"
            aria-expanded={addMenuOpen}
            title={t('canvas.addNodeHint')}
            onClick={() => setAddMenuOpen(!addMenuOpen)}
          >
            <Icon name="plus" size={12} />
            {t('canvas.addNode')}
          </button>
          {addMenuOpen && (
            <div className="add-menu" role="menu" onKeyDown={onMenuKeyDown}>
              {/*
                入口直接来自注册表:一个 kind 可以有多个入口(串行/并行),
                每个入口自带 preset(如并行入口带 mode:'parallel')。
                序号既是提示,也是数字键直选的依据(按 2 = 第二项)。
                图标是**按类型**给的(并行入口拿并行图标,而不是 feature 的),
                所以"串行 / 并行"这两个同 kind 入口在菜单里也一眼能分开。
              */}
              {ADD_ENTRIES.map((entry, i) => (
                <button
                  key={entry.key}
                  ref={(el) => {
                    itemRefs.current[i] = el
                  }}
                  role="menuitem"
                  title={entry.hint}
                  onClick={() => handleAdd(entry.kind, entry.preset)}
                >
                  <span className="add-idx">{i + 1}</span>
                  {/*
                    图标单独的槽位:固定宽度,让九行的文字左边缘对齐。
                    颜色按**图标名**给(串行/并行是同一个 kind 但不同图标),
                    所以这两个入口的配色和画布上的角标本一致。
                  */}
                  <span className={`add-icon ic-${entry.icon ?? entry.kind}`}>
                    <NodeIcon name={entry.icon} size={13} />
                  </span>
                  <span className="add-label">{nodeEntryLabel(entry.kind, entry.label)}</span>
                </button>
              ))}
              <div className="add-foot">
                <span className="kbd">↑</span>
                <span className="kbd">↓</span> {t('canvas.menuSelect')} · <span className="kbd">Enter</span>{' '}
                {t('canvas.menuAdd')} · <span className="kbd">1-{ADD_ENTRIES.length}</span> {t('canvas.menuDirect')}
              </div>
            </div>
          )}
        </div>
        {/*
          框选了 ≥2 个节点时出现:把这些节点连同它们之间的连线封成一个子图节点。
          外部连线整体改接到子图节点上,原样保进模板 —— 展开时按记录重接,
          一次封装 + 展开 = 画布回到原样。
        */}
        {multiCount >= 2 && (
          <button
            title={t('canvas.encapsulateHint')}
            onClick={() => {
              const ids = useUiStore.getState().selectedIds
              const id = encapsulate(ids)
              // 选中并直接打开配置页:封装完第一件事就是看"里面装了什么"
              if (id) select(id, 'config')
            }}
          >
            <Icon name="subgraph" size={12} />
            {t('canvas.encapsulate')}
          </button>
        )}
        {/*
          选中的是连线时,这个按钮变成「断开连线」。
          切边**没有确认框**(节点会问一次,因为它带着对话历史和运行记录;
          连线重新拉一条就行),所以按钮此刻长什么样、按下去干什么,
          必须严格对应当前选中的是什么 —— 不能出现"按钮写着删节点、
          实际删的是刚选中的线"这种错位。
        */}
        {selectedEdgeId ? (
          <button title={t('canvas.disconnectEdgeHint')} onClick={() => removeEdge(selectedEdgeId)}>
            <Icon name="scissors" size={12} />
            {t('canvas.disconnectEdge')}
          </button>
        ) : (
          <button
            disabled={!selectedNodeId}
            title={selectedNodeId ? t('canvas.deleteSelectedHint') : t('canvas.deleteSelectedDisabled')}
            onClick={() => {
              if (selectedNodeId) void deleteNodeWithConfirm(selectedNodeId)
            }}
          >
            <Icon name="close" size={12} />
            {t('canvas.deleteSelected')}
          </button>
        )}

        {/*
          工作流菜单(v0.6.0):导出 / 导入 / 模板。
          参考 ComfyUI 的工作流 JSON(图可序列化、可分享)与 Langflow / Coze 的模板市场。
          导出 / 导入与快捷键 Ctrl+E / Ctrl+I 共用 workflowIO,菜单按钮不再是另一份实现。
        */}
        <div className="wf-wrap" style={{ position: 'relative' }}>
          <button
            title={t('canvas.workflowHint')}
            aria-expanded={wfMenuOpen}
            onClick={() => setWfMenuOpen((v) => !v)}
          >
            <Icon name="subgraph" size={12} />
            {t('canvas.workflow')}
          </button>
          {wfMenuOpen && (
            <div className="wf-menu">
              <button
                title={t('canvas.exportDialogTitle')}
                onClick={() => {
                  setWfMenuOpen(false)
                  void exportWorkflowFile()
                }}
              >
                {t('canvas.exportWf')}
              </button>
              <button
                title={t('canvas.importDialogTitle')}
                onClick={() => {
                  setWfMenuOpen(false)
                  void importWorkflowFile()
                }}
              >
                {t('canvas.importWf')}
              </button>
              <div className="wf-menu-sep" />
              <div className="wf-menu-title">{t('canvas.templates')}</div>
              {TEMPLATE_LIST.map(([key, tpl]) => (
                <button
                  key={key}
                  title={t(`template.${key}.desc`, tpl.desc)}
                  onClick={() => {
                    setWfMenuOpen(false)
                    const res = applyTemplate(key, workspace as WorkspaceId)
                    alert(
                      res.ok
                        ? t('canvas.templateApplied', undefined, { label: t(`template.${key}`, tpl.label), desc: t(`template.${key}.desc`, tpl.desc) })
                        : (res.error ?? t('canvas.templateFailed')),
                    )
                  }}
                >
                  {t(`template.${key}`, tpl.label)}
                </button>
              ))}
            </div>
          )}
        </div>
        {/*
          连线反馈三层:红色 = 方向错、被拒;黄色 = 语义可疑、已生效;都没 = 常规提示。
          方向错误当场可见;语义警告 6 秒后自动消失(它在 validateGraph 里有兜底)。
        */}
        {edgeError ? (
          <span className="hint-inline err">
            <Icon name="alert" size={12} />
            {edgeError}
          </span>
        ) : edgeWarn ? (
          <span className="hint-inline warn">
            <Icon name="alert" size={12} />
            {edgeWarn}
          </span>
        ) : (
          <span className="hint-inline">
            {t('canvas.hintLine')}
            <button
              className="linklike"
              title={t('canvas.shortcutsHint')}
              onClick={() => useUiStore.getState().setShowShortcuts(true)}
            >
              <Icon name="keyboard" size={12} />
              {t('canvas.shortcuts')}
            </button>
          </span>
        )}
      </div>

      {/* 数据探针:悬停边/节点时浮出产出预览(没跑过的节点由 ProbeCard 自己不显示) */}
      {probe && <ProbeCard nodeId={probe.nodeId} x={probe.x} y={probe.y} />}
    </>
  )
}

/** 画布本身。ReactFlowProvider 提供坐标转换与内部 store */
export function Canvas(): JSX.Element {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  )
}
