import type { NodeTypes } from '@xyflow/react'
import { ProjectNode } from './ProjectNode'
import { FeatureNode } from './FeatureNode'
import { MergeNode } from './MergeNode'
import { OutputNode } from './OutputNode'
import { ImageNode } from './ImageNode'
import { ReviewNode } from './ReviewNode'
import { TestNode } from './TestNode'
import { DocNode } from './DocNode'
import { GameNode } from './GameNode'
import { VideoNode } from './VideoNode'
import { HandoffNode } from './HandoffNode'
import { SubgraphNode } from './SubgraphNode'
import { PromptNode, NegativeNode, SamplerNode, ImageOutputNode } from './ImageFlowNodes'
import { PythonNode } from './PythonNode'
import { GateNode } from './GateNode'
import { LintNode, GitNode, DepsNode, ContextNode, ContractNode, CostNode, DiffNode, DeployNode } from './ToolkitNodes'

/**
 * ⚠️ 必须是**模块级常量**,而且只在这里定义这一次。
 *
 * React Flow 在 nodeTypes 的 identity 变化时会重建整个内部节点索引 ——
 * 任何组件里内联写 `nodeTypes={{ project: ProjectNode, ... }}` 都会在每次渲染时
 * 造出一个新对象,于是拖动时每一帧都在重建索引,直接掉帧到不可用。
 *
 * ## 为什么组件映射留在渲染端、而不是塞进 shared/nodeRegistry
 *
 * 注册表(shared)驱动的是**数据**:端口 / 执行器 / 徽标 / 面板 / 默认值 / 校验。
 * 但组件是 **React 概念** —— shared 不许 import React(项目铁律)。所以组件映射
 * 天然只能留在渲染端,且必须显式写成模块级常量。
 *
 * 加一个新类型:这里加一行 + panelRegistry 加一行 + 该类型自己的组件文件;
 * nodeRegistry 里再加一条声明。核心调度器(runner)、画布(Canvas)零改动。
 *
 * `agent` 键已于 nodes-v2 退役(migrateGraph 把旧 agent 全部升成 feature/serial);
 * `image` 键是 v0.3.0 新增;`review` / `test` / `doc` 三个键是本次新增的
 * 质量闸门与文档节点(其中 test 与 output/image 同族,是内置动作节点);
 * `subgraph` 是 Noodl 式的组件复用:不进添加菜单,只能由「封装选中」产生。
 */
export const nodeTypes = {
  project: ProjectNode,
  feature: FeatureNode,
  merge: MergeNode,
  output: OutputNode,
  image: ImageNode,
  review: ReviewNode,
  test: TestNode,
  doc: DocNode,
  game: GameNode,
  video: VideoNode,
  handoff: HandoffNode,
  subgraph: SubgraphNode,
  prompt: PromptNode,
  prompt_negative: NegativeNode,
  sampler: SamplerNode,
  image_output: ImageOutputNode,
  python: PythonNode,
  gate: GateNode,
  lint: LintNode,
  git: GitNode,
  deps: DepsNode,
  context: ContextNode,
  contract: ContractNode,
  cost: CostNode,
  diff: DiffNode,
  deploy: DeployNode,
} satisfies NodeTypes
