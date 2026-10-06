import { create } from 'zustand'
import {
  specFromGraph,
  type RunNodeState,
  type RunNodeStatus,
  type RunState,
  type WorkflowEvent,
} from '../../../shared/workflow'
// 环检测跑在**渲染进程**:主进程那唯一一次在 specFromGraph 展开子图之后,
// CycleError.cycle 里装的是 `sg::a::b`,而画布上不存在这个节点 —— UI 拿它去
// 高亮一条边都点不亮。graph.ts 是零依赖纯函数(shared/graph.ts),可安全进 renderer bundle。
import { detectCanvasCycle, subgraphInnerCycleHint } from '../../../shared/graph'
// 从 defaults 而不是 settings 引 —— 后者 import 了 zod,按值引用会把 zod 拖进渲染进程
import { SETTING_DEFAULTS } from '../../../shared/defaults'
// shared/providers 是零依赖纯字面量+纯函数,按值引用安全(与 defaults 同理)
import { defaultModelMap } from '../../../shared/providers'
import { useGraphStore } from './graphStore'
import { useSettingsStore } from './settingsStore'
import { unwrap } from '../lib/unwrap'

/**
 * 工作流运行态。
 *
 * ## 为什么独立于 runtimeStore
 *
 * runtimeStore 是**会话**的状态(这个节点聊到哪了),这里的是**一次运行**的状态
 * (这次流水线里这个节点排到第几、跑没跑完)。同一次运行结束后运行态就该被丢掉,
 * 而会话还在 —— 两者生命周期不同,混在一起必然要写"运行结束时清哪些字段"的逻辑,
 * 那正是 bug 的温床。
 *
 * ## 运行态只在渲染进程是**镜像**
 *
 * 权威在主进程(它才是调度的人)。这里不做乐观插入:点了运行之后先记下 runId,
 * 之后完全靠 EV.workflowRun 推送把状态填进来。
 */

interface WorkflowState {
  /** 按 runId 存。同时能有好几次(不同画布/连续点了两次) */
  runs: Record<string, RunState>
  /** 当前界面对应的那次运行 */
  activeRunId: string | null
  /** 这次运行额外给用户的输入,会拼进 {{input}} */
  input: string
  /** 发起失败的原因(环检测等)。跑起来之后清空 */
  error: string | null
  /** 环检测失败时,环上的节点。图里高亮用 */
  cycle: string[]
  /** 正在发起的请求(防连点:同一个画布连点两次会跑两遍) */
  starting: boolean

  setInput(v: string): void

  /** 跑整张图 */
  runAll(): Promise<void>
  /** 只跑这些节点(会自动带上它们的祖先) */
  runTargets(targets: string[]): Promise<void>
  cancel(runId: string): Promise<void>
  cancelNode(runId: string, nodeId: string): Promise<void>

  /** 主进程推来的运行态 */
  ingest(ev: WorkflowEvent): void
  /** 刷新渲染进程后接上进度 */
  reattach(runId: string): Promise<void>

  clearError(): void
}

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  runs: {},
  activeRunId: null,
  input: '',
  error: null,
  cycle: [],
  starting: false,

  setInput: (input) => set({ input }),

  async runAll() {
    return runWith(set, get, [])
  },

  async runTargets(targets) {
    return runWith(set, get, targets)
  },

  async cancel(runId) {
    // 只改本地状态里的"取消中"观感 —— 真正的状态由主进程推回,
    // 本地不自己造 done/cancelled,否则会与真实结局不一致
    unwrap(await window.api.workflow.cancel(runId))
  },

  async cancelNode(runId, nodeId) {
    unwrap(await window.api.workflow.cancelNode(runId, nodeId))
  },

  ingest(ev) {
    set((st) => {
      /*
       * 用户可能已经点了「新的一次运行」,却还有上一条的推送在路上 ——
       * 那些迟到的快照不能覆盖新的。按 startedAt 比大小:晚发起的赢,
       * 同一 runId 的推送则永远覆盖自己(进度就是要覆盖)。
       */
      const prev = st.runs[ev.runId]
      if (prev && prev.startedAt > ev.state.startedAt) return st
      return {
        runs: { ...st.runs, [ev.runId]: ev.state },
        // 只有"当前这次"的推送才可能改变界面的运行中标志
        starting: ev.runId === st.activeRunId ? false : st.starting,
      }
    })
  },

  async reattach(runId) {
    const st = await window.api.workflow.get(runId)
    if (!st.ok || !st.data) return
    set((s) => ({
      runs: { ...s.runs, [runId]: st.data as RunState },
      activeRunId: runId,
    }))
  },

  clearError: () => set({ error: null, cycle: [] }),
}))

/** 界面上要显示的那次运行 */
export function activeRun(st: WorkflowState): RunState | null {
  return st.activeRunId ? (st.runs[st.activeRunId] ?? null) : null
}

/** 发起运行的公共部分 —— 两个入口只差 targets */
async function runWith(
  set: (fn: (st: WorkflowState) => Partial<WorkflowState>) => void,
  get: () => WorkflowState,
  targets: string[],
): Promise<void> {
  if (get().starting) return

  const graph = useGraphStore.getState()
  // 设置还没加载完就点了运行 —— 用默认值,不要卡住不发。
  // 并发上限/内联上限这两个值取默认和取用户值差别只是慢一点或多写一个文件,
  // 而"点了没反应"是明确的坏体验。
  const settings = useSettingsStore.getState().payload?.current
  const wf = settings?.workflow ?? SETTING_DEFAULTS.workflow

  /*
   * 各服务商的默认模型(「providerId → 模型名」)。
   *
   * 由渲染端抽好传进 specFromGraph,而不是让 spec 自己去读设置 —— spec 是
   * 零依赖纯函数,引入 zod 会把 zod 打进渲染进程 bundle(项目铁律)。
   * 空映射 = 用户没配过任何默认模型,行为与改动前一致。
   */
  const defaultModels = defaultModelMap(settings?.agent.providers)

  const rawNodes = graph.nodes.map((n) => ({ id: n.id, data: n.data }))
  const rawEdges = graph.edges.map((e) => ({ source: e.source, target: e.target }))

  /*
   * 环预检 —— 在 specFromGraph **之前**,用**未展开**的图。
   * 那时 id 与画布一致,RunBar 的标题替换与 Canvas 的边高亮都对得上。
   * 命中就直接 return,**不进 IPC**(理由见 shared/graph.detectCanvasCycle)。
   */
  const cyc = detectCanvasCycle(rawNodes, rawEdges)
  if (cyc) {
    set(() => ({ error: cyc.message, cycle: cyc.cycle }))
    return
  }
  // 未展开的图上看不见子图内部的线,单独检一次并给一句能照着做的提示
  const innerHint = subgraphInnerCycleHint(rawNodes)
  if (innerHint) {
    set(() => ({ error: innerHint, cycle: [] }))
    return
  }

  const spec = specFromGraph({
    canvasId: graph.canvasId,
    nodes: graph.nodes,
    edges: graph.edges,
    targets,
    input: get().input,
    maxParallel: wf.maxParallel,
    inlineLimitBytes: wf.inlineLimitBytes,
    // 节点上没选模型时用设置里的默认(见 defaultModelMap 的注释)
    defaultModels,
    // 没单独配 cwd 的节点继承画布的项目文件夹
    projectDir: graph.projectDir,
  })

  set(() => ({ starting: true, error: null, cycle: [], activeRunId: spec.runId }))

  try {
    const res = await window.api.workflow.run(spec)
    if (!res.ok) {
      /*
       * 走到这里说明是主进程那道兜底检测(手改 graph.json 造出的跨子图环)抛的 ——
       * 它的 cycle 带的是展开后的 id,画布上不存在,**不能拿去高亮**。
       * 所以这里只报错误文案,cycle 一律给空数组:一条点不亮的"高亮"比没有更糟。
       */
      set(() => ({ starting: false, error: res.error, cycle: [] }))
      return
    }
    set((st) => ({ starting: false, runs: { ...st.runs, [spec.runId]: res.data } }))
  } catch (e) {
    set(() => ({ starting: false, error: e instanceof Error ? e.message : String(e) }))
  }
}

/**
 * 某个节点在**当前**运行里的状态。没在跑就是 undefined。
 *
 * ⚠️ 返回的是对象,而每次推送都会重建整份 RunState —— 也就是说哪怕这个节点
 * 一点没变,引用也会变。所以**徽标这类高频订阅者要用下面那个只取字符串的版本**,
 * 否则一次推送会让画布上所有节点各重渲染一次。
 */
export function useNodeRunState(nodeId: string): RunNodeState | undefined {
  return useWorkflowStore((s) => {
    if (!s.activeRunId) return undefined
    return s.runs[s.activeRunId]?.nodes[nodeId]
  })
}

/** 只取状态字符串 —— 字符串比较走 Object.is,值没变就不会触发重渲染 */
export function useNodeRunStatus(nodeId: string): RunNodeStatus | undefined {
  return useWorkflowStore((s) => {
    if (!s.activeRunId) return undefined
    return s.runs[s.activeRunId]?.nodes[nodeId]?.status
  })
}

/** 当前这次运行的整体状态。没跑过 / 已经结束都返回 null */
export function useActiveRun(): RunState | null {
  return useWorkflowStore((s) => (s.activeRunId ? (s.runs[s.activeRunId] ?? null) : null))
}

/**
 * 稳定的空数组引用:zustand v5 用 Object.is 比较快照,每次返回新 `[]`
 * 会触发无限重渲染(React #185)。
 */
const EMPTY_ARTIFACTS: string[] = []

/**
 * 某节点**最近一次运行**产出的图片相对路径列表(image 节点缩略图网格读它)。
 *
 * 只取"当前这次运行"的 RunNodeState.artifacts(M-2:历史多次运行不进列表,归 P2)。
 * 运行态随 RunState 落盘 → 刷新/重启后仍读得到(M-2)。
 */
export function useNodeArtifacts(nodeId: string): string[] {
  return useWorkflowStore((s) => {
    if (!s.activeRunId) return EMPTY_ARTIFACTS
    return s.runs[s.activeRunId]?.nodes[nodeId]?.artifacts ?? EMPTY_ARTIFACTS
  })
}
