import type { JSX } from 'react'
import type { NodeKind } from '../../../../shared/canvas'
import { ProjectConfig } from './ProjectConfig'
import { FeatureConfig } from './FeatureConfig'
import { MergeConfig } from './MergeConfig'
import { OutputConfig } from './OutputConfig'
import { ImageConfig } from './ImageConfig'
import { ReviewConfig } from './ReviewConfig'
import { TestConfig } from './TestConfig'
import { DocConfig } from './DocConfig'
import { GameConfig } from './GameConfig'
import { VideoConfig } from './VideoConfig'
import { HandoffConfig } from './HandoffConfig'
import { SubgraphConfig } from './SubgraphConfig'
import { PromptConfig, NegativeConfig, SamplerConfig, ImageOutputConfig } from './ImageFlowConfigs'
import { AgentConfig } from './AgentConfig'
import { RouterConfig } from './RouterConfig'

/**
 * kind → 配置面板。与 `flow/nodeTypes.ts` **对称**:
 *   同是渲染端"组件映射",同是**模块级常量**,同样"加一个类型加一行"。
 *
 * NodeConfigPanel 只读它,不再写 `switch(node.type)`(去散点,PRD §2.2/#3)。
 * 面板是 React 组件,只能留在渲染端 —— shared 的 nodeRegistry 里存的是数据。
 *
 * ⚠️ 用 `Record<NodeKind, …>`:加一个新 kind 时这里漏加会**编译期报错**
 * (缺键),而不是运行时面板空白。这正是把映射从 switch 换成表的收益之一。
 */
export const PANEL_BY_KIND: Record<NodeKind, (p: { nodeId: string }) => JSX.Element | null> = {
  project: ProjectConfig,
  feature: FeatureConfig,
  merge: MergeConfig,
  output: OutputConfig,
  image: ImageConfig,
  review: ReviewConfig,
  test: TestConfig,
  doc: DocConfig,
  game: GameConfig,
  video: VideoConfig,
  handoff: HandoffConfig,
  subgraph: SubgraphConfig,
  prompt: PromptConfig,
  prompt_negative: NegativeConfig,
  sampler: SamplerConfig,
  image_output: ImageOutputConfig,
  agent: AgentConfig,
  router: RouterConfig,
}
