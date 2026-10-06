/**
 * 图静态分析 —— **实现已搬到 `src/shared/graph.ts`**,本文件只做转发。
 *
 * ## 为什么搬
 *
 * 环检测必须在渲染进程也有一份:主进程那唯一的检测跑在 `specFromGraph`
 * **展开子图之后**,`CycleError.cycle` 里装的是 `sg::a::b` 这种带前缀的 id,
 * 而画布上不存在这个节点 —— UI 拿它去高亮一条边都点不亮,提示里也是一串
 * 用户从没见过的 id。渲染进程要能在**展开前**先检一次(见
 * `workflowStore.runWith`),但渲染进程不能引用 `src/main/**`,
 * 于是这份零依赖的纯函数放进了契约层。
 *
 * ## 为什么不直接改所有调用方
 *
 * `buildIndex` / `CycleError` 是 runner 的地基,主进程侧有十处以上引用。
 * 转发保住了既有 import 路径(`./graph`),改动面只剩本文件。
 */
export {
  ancestors,
  buildIndex,
  closure,
  CycleError,
  descendants,
  normalizeEdges,
  type GraphIndex,
} from '../../shared/graph'
