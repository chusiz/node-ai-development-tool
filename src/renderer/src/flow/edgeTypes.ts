import type { EdgeTypes } from '@xyflow/react'
import { CuttableEdge } from './CuttableEdge'

/**
 * 连线的渲染类型映射。**必须是模块级常量,而且只在这里定义一次。**
 *
 * 与 `nodeTypes.ts` 是同一类约束:React Flow 在 edgeTypes 的 identity 变化时
 * 会重建内部索引,组件里内联写对象字面量会让每次渲染都造一个新对象。
 *
 * ⚠️ 这里只影响**渲染**。store 里的边始终是 `{ id, source, target }`,
 * `toGraph()` 也只写这三个字段 —— 所以 graph.json 里不会有 `type: 'cuttable'`。
 * 渲染类型是"我们怎么画这条线",不是"这条线在数据上是什么",两者不该混。
 *
 * 加一种新线型:这里加一行 + 写那个组件;Canvas 那边改 `displayEdges` 挂上即可。
 */
export const edgeTypes = {
  cuttable: CuttableEdge,
} satisfies EdgeTypes
