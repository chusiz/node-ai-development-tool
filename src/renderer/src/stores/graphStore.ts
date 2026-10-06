import { create } from 'zustand'
import { useMemo } from 'react'
import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type Viewport,
} from '@xyflow/react'
import {
  EMPTY_GRAPH,
  migrateGraph,
  newCanvasNodeId,
  normalizeSubgraph,
  resolveProjectDir,
  type CanvasGraph,
  type NodeConfig,
  type NodeKind,
  type ProjectDirSource,
  type SubgraphTemplate,
} from '../../../shared/canvas'
import {
  applyTypeDefaults,
  connectionError,
  connectionWarning,
  getNodeType,
  NODE_TYPES,
  WORKFLOW_TEMPLATES,
  type WorkspaceId,
} from '../../../shared/nodeRegistry'
import { HistoryStack } from '../../../shared/history'
// graphIssuesFor = expandSubgraphs + validateGraph + 子图节点自身校验,与主进程同口径
import { graphIssuesFor, type GraphIssue } from '../../../shared/workflow'
import { unwrap } from '../lib/unwrap'

/**
 * 画布上的 React Flow 节点。data 与 shared 的 NodeConfig 同一形状;
 * type(NodeKind)同时是 React Flow 选组件的键和 NodeConfig.kind 的镜像。
 */
export type AgentFlowNode = Node<NodeConfig, NodeKind>

/** 拖动结束 / 其他改动之后多久落盘。拖动过程中**不写**,见 onNodesChange */
const SAVE_DEBOUNCE_MS = 500

/**
 * 老画布(或手改过的 graph.json)里 data 可能缺字段。
 * 按 kind 补全之后再进 store,免得 UI 到处写 `data.title ?? '未命名'`。
 *
 * v0.3.0 起改为**读注册表**:
 *   ① 通用补全 title(用 def.defaultTitle)与 kind;
 *   ② 会话类节点补 agent 字段(内置动作节点 output/image **不补** —— PRD §4.2、
 *      面板不得出现、调度也不该看);
 *   ③ 套 def.defaultConfig(该类型的默认字段);
 *   ④ 最后调 def.normalize 按类型精修(如 feature.mode、image.provider)。
 *
 * ⚠️ kind 与 type 的同步在这里钉死:返回值必带调用方传入的 kind,
 * toFlowNode / toGraph 都以它为准 —— 镜像字段只在一个地方写,就不会漂。
 *
 * ⚠️ 具体补全逻辑已抽到 `shared/nodeRegistry.applyTypeDefaults`(纯函数):
 * 渲染端与 e2e 共用同一份实现,免得"界面里的默认值"与"e2e 断言里的默认值"各写一遍
 * 而悄悄漂掉。这里只做一层薄委托。
 */
function normalizeConfig(raw: unknown, kind: NodeKind): NodeConfig {
  return applyTypeDefaults(raw, kind)
}

/** 磁盘节点 → React Flow 节点。type 直取(v2 已是 NodeKind;v1 已被 migrateGraph 升级) */
function toFlowNode(n: CanvasGraph['nodes'][number]): AgentFlowNode {
  const kind: NodeKind = n.type
  return { id: n.id, type: kind, position: n.position, data: normalizeConfig(n.data, kind) }
}

interface GraphState {
  canvasId: string
  name: string
  /**
   * ⚠️ @deprecated 画布级项目文件夹(v1 遗留)。
   * 仅当画布上没有 project 节点时作兜底 —— 解析一律走 resolveProjectDir。
   */
  projectDir: string
  nodes: AgentFlowNode[]
  edges: Edge[]
  viewport: Viewport
  loaded: boolean
  saving: boolean
  saveError: string | null
  /** 非法连线被拒时的一闪而过的提示(见 onConnect),几秒后自动清 */
  edgeError: string | null
  /**
   * 类型化端口的**语义提醒**:连线已生效、只是组合可疑(见 onConnect),
   * 黄色提示几秒后自动清。与 edgeError(红线,已拒)分开存。
   */
  edgeWarn: string | null
  /** 撤销栈深度(0 = 没有可撤销的)。按钮置灰与帮助浮层都用它 */
  undoDepth: number
  redoDepth: number

  load(canvasId: string): Promise<void>
  onNodesChange(changes: NodeChange<AgentFlowNode>[]): void
  onEdgesChange(changes: EdgeChange[]): void
  onConnect(c: Connection): void
  onViewportChange(vp: Viewport): void
  /** 拖动过程中由 React Flow 给出;结束时才是 false */

  addNode(at?: { x: number; y: number }, kind?: NodeKind, preset?: Partial<NodeConfig>): string
  removeNode(id: string): void
  /**
   * 切断一条连线。**只删边,不删节点**。
   *
   * 和 removeNode 分开而不是让调用方自己 applyEdgeChanges:切边是画布上
   * 唯一的"纯减法"操作(节点带着对话历史与运行记录,删掉代价大得多),
   * 它需要一个统一入口来保证「改完就存盘」。散在各处手写 set(...) 的话,
   * 迟早有人漏掉 scheduleSave,表现是"切断后重开又回来了"。
   */
  removeEdge(id: string): void
  patchConfig(id: string, patch: Partial<NodeConfig>): void
  setProjectDir(dir: string): void

  /** 撤销 / 重做(Ctrl+Z / Ctrl+Shift+Z,见 lib/shortcuts.ts) */
  undo(): void
  redo(): void
  /**
   * 把选中的多个节点封装成一个子图节点。返回新节点 id;
   * 少于 2 个(或一个都没找到)返回 null,画布不动。
   */
  encapsulate(ids: string[]): string | null
  /**
   * 把一个子图节点展开回原来的节点。返回是否真的展开了
   * (不是子图节点 / 模板为空 = false,画布不动)。
   */
  expandSubgraph(id: string): boolean

  save(): Promise<void>
  toGraph(): CanvasGraph
}

/*
 * 存盘去抖。放在模块级而不是 store 里:它是副作用调度,不是状态。
 *
 * ⚠️ 这里**没有**「正在拖动就不存盘」的开关,这是故意的。
 *
 * 之前有一个模块级的 `dragging` 标志,scheduleSave 一看它为真就直接 return。
 * 问题在于它**只会被 React Flow 的事件复位**:拖动中途组件树被卸载(比如渲染
 * 抛错、整棵树被 React 卸掉),drag-end 那一次回调就永远不会来,标志卡在 true ——
 * 从此**任何**改动(连线、改名、加节点)都静默不落盘,界面上完全看不出来,
 * 直到重启才发现全丢了。用户那次连线消失,就是踩在这上面。
 *
 * 去抖本身就够了:拖动期间每一次位置变化都会把定时器往后推,所以真正写盘
 * 只会发生在「最后一次变化之后 500ms」——也就是拖动结束之后。标志是多余的,
 * 而多余的锁只有一种下场:锁死。
 */
let saveTimer: ReturnType<typeof setTimeout> | null = null

/** 非法连线提示的自动清除。放在模块级,重复触发时重置同一只定时器 */
let edgeErrorTimer: ReturnType<typeof setTimeout> | null = null

/** 语义警告(连线已生效,只是提醒)的自动清除 */
let edgeWarnTimer: ReturnType<typeof setTimeout> | null = null

/*
 * 画布历史(撤销/重做)。
 *
 * 快照只含 nodes + edges —— 不含视口:撤销"删了一个节点"不该把相机也拽回去。
 * 拖动期间不逐帧记:第一帧记一次(dragSnapshot),拖完那帧结算 —— 中间的帧
 * 既不记也不清栈,撤销一步 = 撤销整次拖动。
 */
interface HistorySnapshot {
  nodes: AgentFlowNode[]
  edges: Edge[]
}

let dragSnapshot: HistorySnapshot | null = null

export const useGraphStore = create<GraphState>((set, get) => {
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void get().save()
    }, SAVE_DEBOUNCE_MS)
  }

  /*
   * 历史栈。序列化时剥掉 `selected`(视图态):否则"选中了 A 再删掉 B"
   * 的快照与恢复后的状态会因 selected 标志被判成不同,撤销一次等于没动。
   */
  const serializeSnapshot = (s: HistorySnapshot): string => JSON.stringify(s)
  const history = new HistoryStack<HistorySnapshot>(serializeSnapshot, 50)

  /** 当前画布的深拷贝快照(逐层复制,不与 store 里的活对象共享引用) */
  const snapshot = (): HistorySnapshot => {
    const { nodes, edges } = get()
    return {
      nodes: nodes.map((n) => ({
        ...n,
        selected: false,
        position: { ...n.position },
        data: { ...n.data },
      })),
      edges: edges.map((e) => ({ ...e })),
    }
  }

  /** 改动**之后**调用:把"改动之前"的快照结算进历史(无实际变化/与栈顶重复会被 HistoryStack 去重) */
  const commitHistory = (before: HistorySnapshot): void => {
    history.push(before, snapshot())
    const { undoDepth, redoDepth } = history
    set({ undoDepth, redoDepth })
  }

  /** 恢复一份快照。清拖动中的半截快照,免得它以"改动前"的身份混进下一次结算 */
  const restore = (entry: HistorySnapshot): void => {
    dragSnapshot = null
    set({
      nodes: entry.nodes.map((n) => ({ ...n, selected: false })),
      edges: entry.edges.map((e) => ({ ...e })),
      undoDepth: history.undoDepth,
      redoDepth: history.redoDepth,
    })
    scheduleSave()
  }

  const flashWarn = (message: string): void => {
    if (edgeWarnTimer) clearTimeout(edgeWarnTimer)
    set({ edgeWarn: message })
    edgeWarnTimer = setTimeout(() => {
      edgeWarnTimer = null
      set({ edgeWarn: null })
    }, 6000)
  }

  return {
    canvasId: 'default',
    name: EMPTY_GRAPH.name,
    projectDir: '',
    nodes: [],
    edges: [],
    viewport: EMPTY_GRAPH.viewport,
    loaded: false,
    saving: false,
    saveError: null,
    edgeError: null,
    edgeWarn: null,
    undoDepth: 0,
    redoDepth: 0,

    async load(canvasId) {
      try {
        const graph = unwrap(await window.api.canvas.load(canvasId))
        /*
         * 主进程 loadGraph 已经迁过一次;这里再兜一次底(migrateGraph 幂等,
         * 不会重复改写)。兜的是:主进程返回 null(坏数据)、或渲染进程
         * 拿到的是旧缓存 —— 无论哪种,进 store 的永远是 v2 形状。
         */
        const g = migrateGraph(graph ?? {})
        /*
         * 换画布 = 换了一张图:历史属于之前那张,清掉(不清的话 Ctrl+Z
         * 会把上一张画布的内容整个盖到这张上)。
         */
        history.clear()
        dragSnapshot = null
        set({
          canvasId,
          name: g.name || EMPTY_GRAPH.name,
          // deprecated 字段原样保留进 store:无项目节点时 resolveProjectDir 靠它兜底
          projectDir: g.projectDir,
          nodes: g.nodes.map(toFlowNode),
          edges: g.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
          viewport: g.viewport ?? EMPTY_GRAPH.viewport,
          loaded: true,
          saveError: null,
          undoDepth: 0,
          redoDepth: 0,
        })
      } catch (e) {
        // 读不出画布也要能开工 —— 给一张空白的,而不是卡在加载态
        history.clear()
        dragSnapshot = null
        set({ canvasId, loaded: true, saveError: (e as Error).message, undoDepth: 0, redoDepth: 0 })
      }
    },

    onNodesChange(changes) {
      /*
       * 历史只记**结构性变化**:
       *   - remove:节点从图上消失(用户没有这条路 —— deleteKeyCode 关了、
       *     删节点走确认框 —— 但保底);
       *   - position 拖动:第一帧记 dragSnapshot,拖完(dragging:false)结算。
       * select / dimensions 是视图态,不进历史。
       */
      const dragging = changes.some((c) => c.type === 'position' && c.dragging)
      const removing = changes.some((c) => c.type === 'remove')
      if (dragging && !dragSnapshot) dragSnapshot = snapshot()
      const removeBefore = removing && !dragging ? snapshot() : null

      set((st) => ({ nodes: applyNodeChanges(changes, st.nodes) }))
      scheduleSave()
      if (dragging) return

      if (dragSnapshot) {
        commitHistory(dragSnapshot)
        dragSnapshot = null
      } else if (removeBefore) {
        commitHistory(removeBefore)
      }
    },

    onEdgesChange(changes) {
      set((st) => ({ edges: applyEdgeChanges(changes, st.edges) }))
      scheduleSave()
    },

    onConnect(c) {
      if (!c.source || !c.target || c.source === c.target) return
      const st = get()
      const src = st.nodes.find((n) => n.id === c.source)
      const tgt = st.nodes.find((n) => n.id === c.target)

      /*
       * 端口方向校验 —— 规则抽到 `shared/nodeRegistry.connectionError`(纯函数,
       * 由注册表的 ports 推导,不再写死 output/project),这里只负责"当场提示"。
       * 在 onConnect 拦(而不是等 validateGraph)是因为交互层的拒绝要**当场可见**
       * —— 运行前才提示的话,用户已经忘了自己拉过什么线。
       */
      const bad = src && tgt ? connectionError(src.type, tgt.type, src.data.title, tgt.data.title) : null
      if (bad) {
        if (edgeErrorTimer) clearTimeout(edgeErrorTimer)
        set({ edgeError: bad })
        edgeErrorTimer = setTimeout(() => {
          edgeErrorTimer = null
          set({ edgeError: null })
        }, 4000)
        return
      }

      // 同一条边不重复连(重复点击是常态,不该进历史);反向边允许(工作流里就是普通的依赖方向)
      if (st.edges.some((e) => e.source === c.source && e.target === c.target)) return

      const before = snapshot()
      set((s) => ({ edges: [...s.edges, { id: `e-${c.source}-${c.target}`, source: c.source, target: c.target }] }))
      commitHistory(before)

      /*
       * 类型化端口(语义层):线**已经连上了**,但组合可疑 → 黄色提醒,不阻断
       * (工作流里偶尔要故意混搭,硬禁会把合法用法一起挡掉)。
       * 运行前 validateGraph 也会再报一次(同一份 connectionWarning,双保险)。
       */
      const warn = src && tgt ? connectionWarning(src.type, tgt.type, src.data.title, tgt.data.title) : null
      if (warn) flashWarn(warn)
      scheduleSave()
    },

    onViewportChange(vp) {
      set({ viewport: vp })
      scheduleSave()
    },

    addNode(at, kind = 'feature', preset) {
      const id = newCanvasNodeId()
      const def = getNodeType(kind)
      const before = snapshot()
      set((st) => ({
        nodes: [
          ...st.nodes,
          {
            id,
            // type 与 data.kind 在 normalizeConfig 里同步,这里只管给 type
            type: kind,
            // 不指定位置时按已有节点数铺开,免得新节点叠在一起看不出来
            position: at ?? { x: 80 + (st.nodes.length % 4) * 300, y: 80 + Math.floor(st.nodes.length / 4) * 220 },
            // 标题用注册表的 defaultTitle;preset 来自添加入口(如并行的 mode)
            data: normalizeConfig(
              {
                title: `${def.defaultTitle} ${st.nodes.length + 1}`,
                ...preset,
              },
              kind,
            ),
          },
        ],
      }))
      commitHistory(before)
      scheduleSave()
      return id
    },

    removeNode(id) {
      const before = snapshot()
      set((st) => ({
        nodes: st.nodes.filter((n) => n.id !== id),
        // 连到它/从它出发的边必须一起删,否则 React Flow 会画出悬空的线
        edges: st.edges.filter((e) => e.source !== id && e.target !== id),
      }))
      commitHistory(before)
      scheduleSave()
    },

    removeEdge(id) {
      const before = snapshot()
      set((st) => ({ edges: st.edges.filter((e) => e.id !== id) }))
      commitHistory(before)
      scheduleSave()
    },

    patchConfig(id, patch) {
      const before = snapshot()
      set((st) => ({
        nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)),
      }))
      // 与原值相同的 patch 会被去重,不会进历史
      commitHistory(before)
      scheduleSave()
    },

    setProjectDir(dir) {
      set({ projectDir: dir })
      scheduleSave()
    },

    /*
     * 工作流导出 / 导入 / 模板(v0.6.0)。
     *
     * 参考 ComfyUI 的工作流 JSON 约定:图 = 可序列化的数据,分享/复用靠文件;
     * 参考 Langflow / Coze 的模板市场:内置常用骨架,一键铺图。
     * 导出的 JSON 是"画布快照" —— 节点位置、配置、连线全部保留。
     */
    exportWorkflow(): string {
      const { nodes, edges, viewport } = get()
      return JSON.stringify(
        {
          format: 'chusiz-workflow',
          version: 1,
          nodes: nodes.map((n) => ({
            id: n.id,
            type: n.type,
            position: n.position,
            data: n.data,
          })),
          edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
          viewport,
        },
        null,
        2,
      )
    },

    importWorkflow(json: string): { ok: boolean; error?: string } {
      let wf: {
        format?: string
        nodes?: Array<{ id?: string; type?: string; position?: { x: number; y: number }; data?: Record<string, unknown> }>
        edges?: Array<{ id?: string; source?: string; target?: string }>
      }
      try {
        wf = JSON.parse(json)
      } catch {
        return { ok: false, error: '文件不是有效的 JSON' }
      }
      if (wf.format !== 'chusiz-workflow' || !Array.isArray(wf.nodes)) {
        return { ok: false, error: '不是 chusiz 工作流文件(缺 format: chusiz-workflow 头)' }
      }
      const before = snapshot()
      const nodes = wf.nodes
        .filter((n) => n && typeof n.id === 'string' && n.id)
        .map((n) => {
          const kind = NODE_TYPES[n.type ?? ''] ? (n.type as NodeKind) : 'feature'
          const base = (n.data ?? {}) as Partial<NodeConfig>
          return {
            id: n.id as string,
            type: kind,
            position: n.position ?? { x: 80, y: 80 },
            data: normalizeConfig(
              { title: base.title ?? `${getNodeType(kind).defaultTitle} ${n.id}`, ...base },
              kind,
            ),
            selected: false,
          }
        })
      const idSet = new Set(nodes.map((n) => n.id))
      const edges = (wf.edges ?? [])
        .filter((e) => e && idSet.has(e.source ?? '') && idSet.has(e.target ?? ''))
        .map((e) => ({ id: e.id ?? `e-${e.source}-${e.target}`, source: e.source as string, target: e.target as string }))
      set({ nodes, edges, selectedNodeId: null })
      commitHistory(before)
      scheduleSave()
      return { ok: true }
    },

    applyTemplate(name: string, workspace?: WorkspaceId): { ok: boolean; error?: string } {
      const tpl = WORKFLOW_TEMPLATES[name]
      if (!tpl) return { ok: false, error: `未知模板:${name}` }
      const before = snapshot()
      // 模板只允许出现在它能归属的工作区:生图模板只铺在生图页
      if (tpl.workspace && workspace && tpl.workspace !== workspace) {
        return {
          ok: false,
          error: `模板「${tpl.label}」属于${tpl.workspace === 'image' ? '生图' : '软件制作'}页,请先切换到对应工作区再套用`,
        }
      }
      set({ nodes: [], edges: [], selectedNodeId: null })
      const created: Record<number, string> = {}
      for (const [i, spec] of tpl.nodes.entries()) {
        const id = newCanvasNodeId()
        created[i] = id
        set((st) => ({
          nodes: [
            ...st.nodes,
            {
              id,
              type: spec.kind,
              position: spec.pos,
              data: normalizeConfig(
                {
                  title: spec.title ?? `${getNodeType(spec.kind).defaultTitle} ${i + 1}`,
                  ...spec.preset,
                },
                spec.kind,
              ),
              selected: false,
            },
          ],
        }))
      }
      const edges = tpl.edges
        .map(([from, to]) => {
          const s = created[from]
          const t = created[to]
          if (!s || !t) return null
          return { id: `e-${s}-${t}`, source: s, target: t }
        })
        .filter((e): e is { id: string; source: string; target: string } => !!e)
      set({ edges })
      commitHistory(before)
      scheduleSave()
      return { ok: true }
    },

    undo() {
      const entry = history.undoPop(snapshot())
      if (entry) restore(entry)
    },

    redo() {
      const entry = history.redoPop(snapshot())
      if (entry) restore(entry)
    },

    encapsulate(ids) {
      const st = get()
      const picked = new Set(ids)
      const sel = st.nodes.filter((n) => picked.has(n.id))
      if (sel.length < 2) return null

      const inSet = (id: string): boolean => picked.has(id)
      const innerEdges = st.edges.filter((e) => inSet(e.source) && inSet(e.target))
      const inExt = st.edges.filter((e) => !inSet(e.source) && inSet(e.target))
      const outExt = st.edges.filter((e) => inSet(e.source) && !inSet(e.target))

      /*
       * 包围盒左上角作为子图节点的落点,内部位置改为相对它 ——
       * 挪动子图节点 = 挪动整段,展开时再加回来。
       */
      const minX = Math.min(...sel.map((n) => n.position.x))
      const minY = Math.min(...sel.map((n) => n.position.y))
      const entryIds = [...new Set(inExt.map((e) => e.target))]
      const exitIds = [...new Set(outExt.map((e) => e.source))]

      const template: SubgraphTemplate = {
        nodes: sel.map((n) => ({
          id: n.id,
          type: n.type,
          position: { x: n.position.x - minX, y: n.position.y - minY },
          data: { ...n.data },
        })),
        edges: innerEdges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
        inMap: inExt.map((e) => ({ from: e.source, to: e.target })),
        outMap: outExt.map((e) => ({ from: e.source, to: e.target })),
        entryIds,
        exitIds,
      }

      const id = newCanvasNodeId()
      const before = snapshot()
      set((s) => ({
        nodes: [
          ...s.nodes.filter((n) => !picked.has(n.id)),
          {
            id,
            type: 'subgraph',
            position: { x: minX, y: minY },
            data: normalizeConfig(
              { title: `子图 ${s.nodes.length + 1}`, subgraph: template },
              'subgraph',
            ),
          },
        ],
        edges: [
          ...s.edges.filter((e) => !inSet(e.source) && !inSet(e.target)),
          ...inExt.map((e) => ({ ...e, target: id })),
          ...outExt.map((e) => ({ ...e, source: id })),
        ],
      }))
      commitHistory(before)
      scheduleSave()
      return id
    },

    expandSubgraph(id) {
      const st = get()
      const sub = st.nodes.find((n) => n.id === id)
      if (!sub || sub.type !== 'subgraph') return false
      const t = normalizeSubgraph(sub.data.subgraph)
      if (!t || t.nodes.length === 0) return false

      /*
       * 内部 id 尽量复用原 id(展开 = 回到封装前的样子);与现存冲突的
       * 换新 id。边与 inMap/outMap 同步改写,一致性只在这一处维护。
       */
      const used = new Set(st.nodes.map((n) => n.id))
      const remap = new Map<string, string>()
      for (const inner of t.nodes) {
        if (used.has(inner.id)) remap.set(inner.id, newCanvasNodeId())
      }
      const fid = (x: string): string => remap.get(x) ?? x

      const innerIds = new Set(t.nodes.map((n) => n.id))
      const entryDefault = t.entryIds[0] ?? t.nodes[0].id
      const exitDefault = t.exitIds[t.exitIds.length - 1] ?? t.nodes[t.nodes.length - 1].id

      const before = snapshot()
      set((s) => ({
        nodes: [
          ...s.nodes.filter((n) => n.id !== id),
          ...t.nodes.map((inner) => ({
            id: fid(inner.id),
            type: inner.type,
            position: { x: sub.position.x + inner.position.x, y: sub.position.y + inner.position.y },
            data: normalizeConfig(inner.data, inner.type),
          })),
        ],
        edges: [
          ...s.edges.filter((e) => e.source !== id && e.target !== id),
          ...t.edges.map((e) => ({
            id: `e-${fid(e.source)}-${fid(e.target)}`,
            source: fid(e.source),
            target: fid(e.target),
          })),
          // 外部入线:封装时记过映射就精确重接,否则落到兜底入口
          ...s.edges
            .filter((e) => e.target === id)
            .map((e) => {
              const m = t.inMap.find((mm) => mm.from === e.source && innerIds.has(mm.to))
              return { ...e, target: fid(m ? m.to : entryDefault) }
            }),
          ...s.edges
            .filter((e) => e.source === id)
            .map((e) => {
              const m = t.outMap.find((mm) => mm.to === e.target && innerIds.has(mm.from))
              return { ...e, source: fid(m ? m.from : exitDefault) }
            }),
        ],
      }))
      commitHistory(before)
      scheduleSave()
      return true
    },

    toGraph() {
      const { name, projectDir, nodes, edges, viewport } = get()
      return {
        // 保存恒写 3(D1):v2→v3 零数据迁移,升版只为能力代际标记
        version: 3,
        name,
        projectDir,
        nodes: nodes.map((n) => ({
          id: n.id,
          type: n.type,
          position: { x: n.position.x, y: n.position.y },
          data: n.data,
        })),
        edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
        viewport,
      }
    },

    async save() {
      const { canvasId } = get()
      set({ saving: true })
      try {
        unwrap(await window.api.canvas.save(canvasId, get().toGraph()))
        set({ saving: false, saveError: null })
      } catch (e) {
        set({ saving: false, saveError: (e as Error).message })
      }
    },
  }
})

/**
 * 项目文件夹权威解析的派生值。
 *
 * ⚠️ 两个 hook 拆开而不是返回一个对象:zustand v5 用 Object.is 比较快照,
 * 每次调用返回新对象会触发无限重渲染(React #185)—— 字符串才走 Object.is。
 */
export function useResolvedProjectDir(): { dir: string; source: ProjectDirSource } {
  const dir = useGraphStore((s) => resolveProjectDir(s.nodes, s.projectDir).dir)
  const source = useGraphStore((s) => resolveProjectDir(s.nodes, s.projectDir).source)
  return { dir, source }
}

/**
 * 运行前图校验(P0-8)。RunBar 用它展示warn 列表。
 *
 * ⚠️ 走 `shared/workflow.graphIssuesFor` —— 它校验的是**展开子图之后**的图,
 * 与主进程 `WorkflowRunner.run` 里 `validateGraph` 拿到的是**同一张图**
 * (实测:子图内含project + test 节点时,未展开口径 1 条 vs 主进程 3 条,
 * 三种不同后果取决于你看哪一端)。这条注释曾经写着"双保险但绝不会不一致",
 * 而实测就是不一致 —— 那句注释本身成了这个 bug 没人去查的原因。
 *
 * 共享纯函数还让 e2e 能**逐字比对**两端结果(P0-3 的回归防线)。
 */
export function useGraphIssues(): GraphIssue[] {
  const nodes = useGraphStore((s) => s.nodes)
  const edges = useGraphStore((s) => s.edges)
  const projectDir = useGraphStore((s) => s.projectDir)
  return useMemo(
    () =>
      graphIssuesFor({
        nodes: nodes.map((n) => ({ id: n.id, data: n.data })),
        edges: edges.map((e) => ({ source: e.source, target: e.target })),
        projectDir,
      }),
    [nodes, edges, projectDir],
  )
}

/** 关窗前把没落盘的改动补上。返回的 promise 由调用方决定等不等 */
export function flushGraphSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  return useGraphStore.getState().save()
}
