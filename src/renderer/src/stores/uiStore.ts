import { create } from 'zustand'
import type { WorkspaceId } from '../../../shared/nodeRegistry'

/**
 * 右栏的页签。
 *
 * 放进 store 而不是 InspectorPanel 的局部 state:画布上的节点需要能
 * **替用户把配置页打开**(「选项目文件夹」那个按钮)。局部 state 的话
 * 节点够不着它,用户点了按钮只看到节点被选中、目录设置还是找不到。
 */
export type InspectorTab = 'chat' | 'config'

/** 项目 id 的本地注册表(多项目并行)。画布 id = `<projectId>-<workspace>` */
const PROJECTS_KEY = 'nodeaidevtool.projects.v1'
/** 兼容旧键(chusiz / ClaudeCanvas 时代):只读,不回写 */
const LEGACY_PROJECTS_KEYS = ['chusiz.projects.v1', 'claudecanvas.projects.v1']
export function loadProjectList(): string[] {
  try {
    let raw = localStorage.getItem(PROJECTS_KEY)
    if (!raw) {
      for (const k of LEGACY_PROJECTS_KEYS) {
        raw = localStorage.getItem(k)
        if (raw) break
      }
    }
    const arr: unknown = raw ? JSON.parse(raw) : null
    return Array.isArray(arr) && arr.every((x) => typeof x === 'string') && arr.length > 0
      ? (arr as string[])
      : ['default']
  } catch {
    return ['default']
  }
}
function saveProjectList(list: string[]): void {
  try {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(list))
  } catch {
    /* localStorage 不可用(隐私模式)时多项目只是不持久化,不影响使用 */
  }
}

interface UiState {
  /** 当前被选中的节点。Inspector 与节点配置面板都跟着它 */
  selectedNodeId: string | null
  /**
   * 当前被选中的**连线**。
   *
   * 和 `selectedNodeId` 是**互斥**的:同一时刻要么选中一个节点、要么选中一条线。
   *
   * 为什么不互斥:工具栏那个「删除选中」按钮、以及 Delete 快捷键,都要回答
   * "删的是哪一个"。允许同时选中就等于把这个问题推给每个消费方各猜一次 ——
   * 而它们本该共享同一条规则。互斥之后,规则只有一条:选中的那个就是目标。
   */
  selectedEdgeId: string | null
  inspectorTab: InspectorTab
  showDiag: boolean
  showSettings: boolean
  showSkills: boolean
  /** 画布左上角「+ 添加节点」的类型菜单开着没有 */
  addMenuOpen: boolean
  /** 快捷键帮助浮层 */
  showShortcuts: boolean
  /**
   * 悬停探针(边数据预览):悬停连线/节点时,画布右下浮出该节点最近一次
   * 运行的产出开头。null = 关。瞬时 UI,不落盘。
   */
  probe: { nodeId: string; x: number; y: number } | null
  /**
   * React Flow 框选/多选出来的节点 id(单选另有 selectedNodeId)。
   * 「封装成子图」按钮按它显隐 —— 没有 store 级状态的话,工具栏够不着框选结果。
   */
  selectedIds: string[]
  /**
   * 「这次选中是带着页签意图来的」—— 由 `select(id, tab)` 写,Inspector 消费一次。
   *
   * 为什么必须有这个字段:Inspector 里有一条"**换节点就切回对话页**"的规则
   * (见 InspectorPanel 的 effect),它的存在是对的 —— 点另一个节点时,
   * 用户想看的是那个节点的对话。但「放置项目节点」按钮要的是
   * "建好 → 选中 → 直接把配置页打开,好让用户马上选文件夹"。
   * 两者在时序上撞车:选中状态一变,那条 effect 就把页签抢回对话页,
   * 于是按钮里那句 setInspectorTab('config') 白写了,用户还是停在对话页 ——
   * 正是注释里说要避免的「以为要手打路径」。
   *
   * 把意图和选中**放在同一次状态写入**里,effect 就能区分
   * "换节点(默认回对话)"和"换节点且明确要求某个页签"。
   */
  selectionTab: InspectorTab | null

  /**
   * 「重命名请求」(v0.6.6 快捷键 F2)。
   *
   * 双击标题就地改名是 NodeShell 的内部 state,快捷键在 App 层 ——
   * 用一个显式的小槽把两者接起来:App 层按下 F2 写进 nodeId,
   * NodeShell 看到自己的 id 就进入改名态,再把它清掉(一次性消费)。
   */
  renameRequestId: string | null

  // ---- 双工作区 + 多项目(v0.5.0)----
  /** 当前工作区:生图 / 软件制作(各自独立的画布与节点集合) */
  workspace: WorkspaceId
  /** 当前项目 id(画布 id = canvasIdFor(projectId, workspace)) */
  projectId: string
  /** 已知项目列表(新建项目时登记,localStorage 持久化) */
  projects: string[]
  setWorkspace(ws: WorkspaceId): void
  setProjectId(id: string): void
  /** 新建项目:登记进列表并切换过去 */
  addProject(name: string): boolean

  select(nodeId: string | null, tab?: InspectorTab): void
  /** 选中一条连线。会把节点选中清掉(互斥,见 selectedEdgeId 的注释) */
  selectEdge(edgeId: string | null): void
  /** 取走并清空这次选中附带的页签意图。没有则返回 null */
  consumeSelectionTab(): InspectorTab | null
  setInspectorTab(tab: InspectorTab): void
  /** 请求某个节点进入就地改名态(F2)。NodeShell 消费后应调用 requestRename(null) 清掉 */
  requestRename(nodeId: string | null): void
  toggleDiag(): void
  setShowSettings(v: boolean): void
  setShowSkills(v: boolean): void
  setAddMenuOpen(v: boolean): void
  setShowShortcuts(v: boolean): void
  /** 打开/移动悬停探针(null = 关)。坐标是屏幕坐标,浮层自己换算位置 */
  setProbe(p: { nodeId: string; x: number; y: number } | null): void
  /** React Flow 的 onSelectionChange 框选结果(节点 id) */
  setMultiSelection(ids: string[]): void
}

/*
 * 「添加节点菜单开没开」为什么放在全局 store 而不是 Canvas 的局部 state:
 * 快捷键 Ctrl+K 要能从任意位置把它掀开,而快捷键表在 App 层 ——
 * 局部 state 的话,那条 def 够不着它,只能再搭一层回传,不如直接放这儿。
 * showShortcuts 同理(? 切换)。
 */
export const useUiStore = create<UiState>((set, get) => ({
  selectedNodeId: null,
  selectedEdgeId: null,
  inspectorTab: 'chat',
  showDiag: false,
  showSettings: false,
  showSkills: false,
  addMenuOpen: false,
  showShortcuts: false,
  selectionTab: null,
  renameRequestId: null,
  probe: null,
  selectedIds: [],
  workspace: 'app',
  projectId: 'default',
  projects: loadProjectList(),

  /*
   * 带着页签意图选中:一次写入同时落 userId 与页签,并把意图留给 Inspector 消费。
   * 不带 tab 时把 selectionTab 清成 null —— 否则上一次的意图会粘到下一次选中上。
   *
   * 选中节点必然清掉连线选中 —— `select(null)`(点空白 / Esc)也因此顺带
   * 把连线一起取消,不用每个调用点各写一次。
   */
  select: (selectedNodeId, tab) =>
    set({
      selectedNodeId,
      selectedEdgeId: null,
      selectionTab: tab ?? null,
      ...(tab ? { inspectorTab: tab } : {}),
    }),
  selectEdge: (selectedEdgeId) => set({ selectedEdgeId, selectedNodeId: null }),
  consumeSelectionTab: () => {
    const t = get().selectionTab
    if (t) set({ selectionTab: null })
    return t
  },
  setInspectorTab: (inspectorTab) => set({ inspectorTab }),
  toggleDiag: () => set((st) => ({ showDiag: !st.showDiag })),
  setShowSettings: (showSettings) => set({ showSettings }),
  setShowSkills: (showSkills) => set({ showSkills }),
  setAddMenuOpen: (addMenuOpen) => set({ addMenuOpen }),
  setShowShortcuts: (showShortcuts) => set({ showShortcuts }),
  setProbe: (probe) => set({ probe }),
  setMultiSelection: (selectedIds) => set({ selectedIds }),
  requestRename: (renameRequestId) => set({ renameRequestId }),

  /*
   * 切工作区 / 切项目:只改状态,不碰画布 —— App 层监听 workspace/projectId
   * 变化后统一调用 graphStore.load(canvasIdFor(...))。选中态一起清掉,
   * 免得旧画布的选中残留到新画布上。
   */
  setWorkspace: (workspace) => set({ workspace, selectedNodeId: null, selectedEdgeId: null, selectionTab: null }),
  setProjectId: (projectId) =>
    set({ projectId, selectedNodeId: null, selectedEdgeId: null, selectionTab: null }),
  addProject: (name) => {
    const id = name.trim()
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,32}$/.test(id)) return false
    const list = get().projects
    if (!list.includes(id)) {
      saveProjectList([...list, id])
      set({ projects: [...list, id] })
    }
    set({ projectId: id, selectedNodeId: null, selectedEdgeId: null, selectionTab: null })
    return true
  },
}))
