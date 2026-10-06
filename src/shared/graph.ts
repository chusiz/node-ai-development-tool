import type { WorkflowEdgeSpec } from './workflow'
import type { SubgraphTemplate } from './canvas'

/**
 * 图的静态分析:分层、环检测、前驱后继。
 *
 * 纯函数,不碰 fs / 不碰 Electron —— 所以可以单独跑,也可以在 e2e 里直接断言。
 *
 * ## 为什么在 shared 而不是 main
 *
 * 环检测必须在**渲染进程**也能跑:主进程那份跑在 `specFromGraph` 展开子图**之后**,
 * `CycleError.cycle` 里装的是带前缀的 id(`sg::a::b`),而画布上根本没有这个节点 ——
 * UI 拿它去高亮会一条边都点不亮(见 `workflowStore.runWith` 的预检)。
 * 渲染进程不能引用 `src/main/**`,所以这份纯逻辑放在契约层,主进程侧
 * `src/main/workflow/graph.ts` 只做转发(既有 import 路径不变)。
 *
 * 它对 shared 的依赖只有 `WorkflowEdgeSpec` 这一个**类型**,不构成运行时依赖环。
 */

export interface GraphIndex {
  nodes: string[]
  /** 节点 → 它的直接前驱 */
  preds: Map<string, string[]>
  /** 节点 → 它的直接后继 */
  succs: Map<string, string[]>
  /** 节点 → 最长路径深度。同层之间**保证**没有依赖 */
  depth: Map<string, number>
  /** 拓扑序(depth 升序,同层内保持输入顺序,便于结果稳定可复现) */
  order: string[]
}

export class CycleError extends Error {
  constructor(readonly cycle: string[]) {
    super(`工作流里有环:${cycle.join(' → ')}`)
    this.name = 'CycleError'
  }
}

/** 去掉自环与重复边。自环在 UI 上连得出来(从自己拉回自己),但没有语义 */
export function normalizeEdges(nodeIds: string[], edges: WorkflowEdgeSpec[]): WorkflowEdgeSpec[] {
  const known = new Set(nodeIds)
  const seen = new Set<string>()
  const out: WorkflowEdgeSpec[] = []
  for (const e of edges) {
    if (e.source === e.target) continue
    if (!known.has(e.source) || !known.has(e.target)) continue
    const key = `${e.source}\u0000${e.target}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ source: e.source, target: e.target })
  }
  return out
}

/**
 * 建索引。
 *
 * ## 分层为什么必须用「最长路径」而不是朴素的 Kahn 轮次
 *
 * 朴素做法"每轮取出所有入度为 0 的节点作为一层"是错的:
 * 取出一个节点会让它后继的入度减一,于是**本来有依赖关系的两个节点**
 * 可能被塞进同一层(只在某一轮里入度刚好都归零)。同层被当成可并发,
 * 真并发起来就会读到还没写完的上游产出。
 *
 * 最长路径深度 `depth(v) = max(depth(u) + 1 for u in preds(v))` 保证
 * **任一节点的所有前驱深度严格更小**,同层之间绝对无依赖。
 */
export function buildIndex(nodeIds: string[], edges: WorkflowEdgeSpec[]): GraphIndex {
  const preds = new Map<string, string[]>()
  const succs = new Map<string, string[]>()
  for (const id of nodeIds) {
    preds.set(id, [])
    succs.set(id, [])
  }
  for (const e of edges) {
    preds.get(e.target)?.push(e.source)
    succs.get(e.source)?.push(e.target)
  }

  // --- 环检测:反复摘掉入度为 0 的节点,摘不完就是有环 ---
  const indeg = new Map<string, number>()
  for (const id of nodeIds) indeg.set(id, preds.get(id)?.length ?? 0)
  const removed = new Set<string>()
  const queue = nodeIds.filter((id) => (indeg.get(id) ?? 0) === 0)
  while (queue.length > 0) {
    const id = queue.shift() as string
    removed.add(id)
    for (const next of succs.get(id) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1
      indeg.set(next, d)
      if (d === 0) queue.push(next)
    }
  }

  if (removed.size !== nodeIds.length) {
    throw new CycleError(extractCycle(nodeIds, succs, removed))
  }

  // 环已经排除,按拓扑序递推最长路径深度
  const depth = new Map<string, number>()
  const order: string[] = []
  const remaining = new Map(indeg)
  const ready = nodeIds.filter((id) => (remaining.get(id) ?? 0) === 0)
  while (ready.length > 0) {
    // 同层内按输入顺序出队,让 order 与节点创建顺序一致 —— 结果可复现,便于测试
    ready.sort((a, b) => nodeIds.indexOf(a) - nodeIds.indexOf(b))
    const id = ready.shift() as string
    order.push(id)
    for (const next of succs.get(id) ?? []) {
      const candidate = (depth.get(id) ?? 0) + 1
      if (candidate > (depth.get(next) ?? 0)) depth.set(next, candidate)
      const d = (remaining.get(next) ?? 0) - 1
      remaining.set(next, d)
      if (d === 0) ready.push(next)
    }
  }
  for (const id of nodeIds) if (!depth.has(id)) depth.set(id, 0)

  return { nodes: nodeIds, preds, succs, depth, order }
}

/**
 * 从"摘不掉的那批节点"里找回一条真实的环路径。
 *
 * 直接把剩余节点全报出去对用户没有帮助(那可能是一大片),
 * 我们要的是**一条能高亮的闭合路径**。
 */
function extractCycle(nodeIds: string[], succs: Map<string, string[]>, removed: Set<string>): string[] {
  const stuck = nodeIds.filter((id) => !removed.has(id))
  const inStuck = new Set(stuck)
  const start = stuck[0]
  if (!start) return []

  // 沿后继走,只走同样"摘不掉"的节点 —— 环一定在剩余子图里
  const path: string[] = []
  const onPath = new Map<string, number>()
  let cur = start
  while (true) {
    const at = onPath.get(cur)
    if (at !== undefined) return [...path.slice(at), cur]
    onPath.set(cur, path.length)
    path.push(cur)
    const next = (succs.get(cur) ?? []).find((n) => inStuck.has(n))
    if (!next) return path // 理论到不了:剩余子图必有环
    cur = next
  }
}

/**
 * 一个节点的全部后代(含自身)。
 *
 * 取消与失败传播都要用:取消上游时,下游不该继续傻等。
 */
export function descendants(index: GraphIndex, root: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const stack = [root]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    for (const n of index.succs.get(id) ?? []) stack.push(n)
  }
  return out
}

/** 一个节点的全部祖先(含自身)。用来把"只跑选中的节点"扩展成"连上游一起跑" */
export function ancestors(index: GraphIndex, root: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const stack = [root]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    for (const n of index.preds.get(id) ?? []) stack.push(n)
  }
  return out
}

/** 「只跑这个节点」时:`{node}` ∪ 它的所有祖先 ∪ 由它出发能到的一切 */
export function closure(index: GraphIndex, target: string): Set<string> {
  const set = new Set<string>()
  for (const id of ancestors(index, target)) set.add(id)
  for (const id of descendants(index, target)) set.add(id)
  return set
}

/**
 * 环检测只需要节点 id;`subgraphInnerCycleHint` 还要读data 里的模板。
 *
 * 刻意只声明用得到的字段(而不是引 NodeSpecSource):这两个函数是**契约层**里
 * 最容易被别处复用的纯函数,把入参收窄到"用得到的最小形状"才不会让调用方
 * 为了传个 id 而被迫构造一个完整节点。
 */
type CycleNode = { id: string; data?: { kind?: string; title?: string; subgraph?: SubgraphTemplate } }
type CycleEdge = { source: string; target: string }

/**
 * 发起运行前的环预检 —— 在**未展开**的图上跑,所以环上每个 id 都对应画布上一个真实节点。
 *
 * ## 为什么渲染端要自己检一遍(而不是只用主进程那一次)
 *
 * 主进程 `WorkflowRunner.run` 里那唯一一次 `buildIndex` 跑在 `specFromGraph`
 * **展开子图之后**的 spec 上。它抛的 `CycleError.cycle` 装的是 `sg::a::b` 这种
 * 带前缀的 id,而画布上根本没有这个节点:
 *   - `RunBar.titleOf` 查不到 → 回退显示裸 id,用户看到一串没见过的符号;
 *   - `Canvas.displayEdges` 用 `${cycle[i]}\0${cycle[i+1]}` 匹配 store 里的边
 *     → **一条都点不亮**。
 *
 * 展开必须早(主进程要在展开后的图上解析 `resolveProjectDir`),但**定位信息**
 * 可以单独在展开前取一次 —— 这就是本函数。命中就直接报出去、**不进 IPC**:
 * 主进程那次仍保留作为兜底(手改 graph.json 造出的跨子图环在未展开的图上看不出来),
 * 只是它抛出的 cycle 不再送高亮。
 *
 * 放在 shared 而不是 renderer 的 store 里,是为了让 e2e 能直接断言**这条真实路径**
 * —— 断言一份复制品等于什么都没钉住。
 */
export function detectCanvasCycle(
  nodes: readonly CycleNode[],
  edges: readonly CycleEdge[],
): CycleError | null {
  const ids = nodes.map((n) => n.id)
  try {
    buildIndex(ids, normalizeEdges(ids, [...edges]))
    return null
  } catch (e) {
    if (e instanceof CycleError) return e
    /*
     * 这里的 `throw e` 是**故意穿透**,不是"忘了处理"。
     *
     * `buildIndex` 在环检测这条路上唯一的抛出就是 `CycleError`;
     * 别的异常(例如 `ids` 里有非字符串导致 `indexOf` 崩)属于**编程错误**,
     * 静默当成"无环"会让一个真正的崩溃伪装成"这张图没问题",
     * 那比崩掉本身坏得多 —— 崩掉至少还留了个栈。
     */
    throw e
  }
}

/**
 * 子图**内部**成环时的定位提示。
 *
 * 未展开的图上子图只是一个节点 —— 内部的线不在 `edges` 里,`detectCanvasCycle`
 * 看不见它。而主进程展开后检出的环带的是 `sg::a::b`,画布上不存在,
 * 于是用户被指向两个不存在的节点:最无从下手的一类报错。
 *
 * 这里把内部节点 id 换成模板里的**标题**,拼成一句能照着做的提示。
 * 刻意**不**返回可高亮的 cycle —— `Canvas` 拿内部 id 去匹配边会一条都不亮,
 * 给一个"看起来高亮实际不亮"的结果比不给更糟。
 *
 * ## 只报**第一个**成环的子图,是有意有界
 *
 * 多个子图同时内部成环是极罕见的形态(要靠手改 graph.json 才造得出),
 * 而列全反而有害:提示会从"这里有个环,展开它"退化成"这里有五个环",
 * 用户读完不知道该先动哪个 —— 找不到重点比少报一个更糟。
 * 修完第一个,下一次点运行自然会把下一个暴露出来,一个一个收敛。
 *
 * ⚠️ **别把这里改成"收集全部"**:那看着像功能增强,实际是拿重点换计数。
 */
export function subgraphInnerCycleHint(nodes: readonly CycleNode[]): string | null {
  for (const n of nodes) {
    const data = n.data
    if (!data || (data.kind ?? 'feature') !== 'subgraph') continue
    const t = data.subgraph
    if (!t || t.nodes.length === 0) continue
    const innerIds = t.nodes.map((x) => x.id)
    let err: CycleError | null = null
    try {
      buildIndex(innerIds, normalizeEdges(innerIds, [...t.edges]))
    } catch (e) {
      // 同 detectCanvasCycle:非 CycleError 是编程错误,故意穿透而不是当成"无环"
      if (!(e instanceof CycleError)) throw e
      err = e
    }
    if (!err) continue
    const title = (id: string): string => t.nodes.find((x) => x.id === id)?.data.title || id
    return `子图「${data.title || n.id}」内部有环:${err.cycle.map(title).join(' → ')} —— 展开它才能改`
  }
  return null
}
