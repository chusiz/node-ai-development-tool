import type { PermissionMode } from './events'
// NodeKind 的唯一真相源在 nodeRegistry(由 NODE_TYPES 的键派生)。
// 这里只 re-export,老代码 `import { NodeKind } from './canvas'` 不受影响。
import type { NodeKind } from './nodeRegistry'

export type { NodeKind } from './nodeRegistry'

/**
 * 画布契约 —— 渲染进程是这份数据的**唯一所有者**,主进程只负责原样存取。
 *
 * 刻意不放 React Flow 的 Node/Edge 类型进来:那样等于把 @xyflow 的内部结构
 * 写进 IPC 契约,它升级一次我们就要跟着改。这里只保留真正需要落盘的部分,
 * 渲染时再补上 React Flow 需要的字段。
 */

/*
 * ⚠️ 这几个都用 `type` 而不是 `interface`。
 *
 * React Flow 的 Node<NodeData> 要求 NodeData extends Record<string, unknown>,
 * 而 TS 只给**对象字面量的 type 别名**隐式索引签名,interface 不给。
 * 用 interface 的话 data 就传不进 React Flow 的泛型,只能到处写 as 强转。
 */

/*
 * 节点类型 `NodeKind` 已迁到 `nodeRegistry.ts`(v0.3.0 起),由 `NODE_TYPES`
 * 的键派生;本文件顶部 re-export 保持老 import 路径可用。
 *
 * 背景:UI 调色板里「串行节点 / 并行节点」是两个入口,但底层是同一种 `feature`
 * 加一个 `mode` 属性 —— 两套几乎相同的组件/调度代码不值得养。
 */

/** feature 节点的执行模式。判据永远是「边指向的那个节点的 mode」(PRD §2) */
export type FeatureMode = 'serial' | 'parallel'

/** 输出节点的打包目标。P0 只落地 exe;apk/web 灰置(链路重,见 PRD §2.5);game = 把项目目录打包成 zip 交付 */
export type BuildTarget = 'exe' | 'apk' | 'web' | 'game'

/**
 * 输出节点的打包参数。P0 只落地 exe 必填项,其余为占位。
 * 全可选:缺省 = 走内置 electron-builder 默认链路的对应默认值。
 */
export interface BuildOptions {
  appName?: string
  version?: string
  /** 产物输出目录。留空 = <projectDir>/dist */
  outDir?: string
  icon?: string
  compress?: boolean
  /** Android 应用包名,如 com.example.app(apk 目标用,默认 com.nodeai.developmenttool) */
  appId?: string
  /** 高级:自定义打包命令,留空 = 走内置打包链路。exe/apk 当前仍走内置链路 */
  customCommand?: string
}

/**
 * 图像节点的生成参数(v0.3.0 新增)。全可选:缺省走注册表的 normalize 默认值。
 * `n` 会被夹到 1..8;`seed` 为空表示每张随机。
 */
export interface ImageParams {
  n?: number
  /** 尺寸,如 '1024x1024' */
  size?: string
  /** 随机种子。留空 = 每张随机 */
  seed?: number
  /** 负提示词(ComfyUI 式):告诉模型不要画什么。HTTP 后端的 bodyTemplate 里用 {{negativePrompt}} 取 */
  negativePrompt?: string
}

/**
 * 视频节点的理解参数(v0.4.1)。
 *
 * 视频理解是**确定性管线**(抽帧 + 视觉模型),不是 LLM 文本会话:
 *   - `source`:视频文件路径。相对路径按项目文件夹解析;绝对路径直接用。
 *   - `providerId` + `model`:负责"看图说话"的多模态模型(如火山 doubao-vision、OpenAI gpt-4o)。
 *   - `frameEverySec`:每多少秒抽一帧;`maxFrames`:最多抽几帧(成本上限 —— 视觉模型按图计费)。
 */
export interface VideoParams {
  /** 视频文件路径(相对项目 / 绝对) */
  source?: string
  /** 视觉模型所在服务商 id */
  providerId?: string
  /** 视觉模型名 */
  model?: string
  /** 抽帧间隔(秒)。默认 3 */
  frameEverySec?: number
  /** 最多抽几帧(成本上限)。默认 8 */
  maxFrames?: number
}

/**
 * 图像节点的出图方式(v0.3.0 新增)—— 两种 provider 二选一。
 *
 * 用**判别联合**(按 `kind`)而不是"两套字段混在一起":字段表不同、
 * 校验方式不同(命令 vs endpoint)、执行链路完全不同。
 * `{{env:VAR}}` 在**主进程**阶段二展开(密钥不进渲染进程 / 不进 graph.json)。
 */
export type ImageProviderConfig =
  | {
      kind: 'local-command'
      /** 命令行模板。支持 {{promptFile}} {{outDir}} {{n}} {{size}} {{seed}} {{env:}}。⚠️ 禁 {{prompt}}(命令注入) */
      command?: string
      /** 工作目录。留空 = 项目文件夹 */
      cwd?: string
      /** 超时(秒)。默认 600(D4:给本地冷启动留余量) */
      timeoutSec?: number
    }
  | {
      kind: 'http'
      /** URL。支持 {{env:}} */
      endpoint?: string
      method?: 'GET' | 'POST'
      /** 请求头。值支持 {{env:}}(只剥 CR/LF,不做 JSON 转义 —— header 语义不同) */
      headers?: Record<string, string>
      /** 请求体模板(通常 JSON)。{{prompt}} 按 JSON 转义嵌入;{{promptJson}} 为含引号整值 */
      bodyTemplate?: string
      /** 从响应 JSON 取图片的路径,如 data[0].b64_json。走安全路径解析 */
      responsePath?: string
      /** base64(内联图片数据)| url(图片链接,由本工具下载落盘) */
      responseType?: 'base64' | 'url'
      /** base64 落盘的扩展名。默认 png */
      format?: string
      /** 超时(秒)。默认 120(D4) */
      timeoutSec?: number
    }

/**
 * 单个节点的配置。全是「用户配的」,不含任何运行时状态。
 *
 * ⚠️ 这里做成**扁平 + 全可选**,而不是按 kind 的判别联合:
 *   - React Flow 的 NodeData 需要 Record<string, unknown>,扁平类型最省事;
 *   - graph.json 是可被手改的,扁平 + normalize 默认值对"多一个/少一个字段"最宽容。
 *
 * 每种 kind 实际用到哪些字段(配置面板与调度器共同依据):
 *
 * | kind    | agentId | model | cwd | promptTemplate | permissionMode | failurePolicy/retry | mode | projectDir/brief | buildTarget/buildOptions | imageParams/imageProvider |
 * |---------|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
 * | project | ✓ | ✓ | ✓(留空=自己的 projectDir) | ✓ | ✓ | ✓ |   | ✓ |   |   |
 * | feature | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |   |   |   |
 * | merge   | ✓ | ✓ | ✓ | ✓(空=默认合并模板) | ✓ | ✓ |   |   |   |   |
 * | review  | ✓ | ✓ | ✓ | ✓(空=默认审查模板) | ✓(默认 plan=只读) | ✓ |   |   |   |   |
 * | doc     | ✓ | ✓ | ✓ | ✓(空=默认文档模板) | ✓ | ✓ |   |   |   |   |
 * | output  | ✗ | ✗ | ✓(只读=项目文件夹) | ✗ | ✗ | ✓(失败策略仍生效) |   |   | ✓ |   |
 * | image   | ✗ | ✗ | ✓(只读=项目文件夹) | ✓(画面描述) | ✗ | ✗ |   |   |   | ✓ |
 * | test    | ✗ | ✗ | ✓(只读=项目文件夹) | ✗ | ✗ | ✓(失败策略仍生效) |   |   |   | testCommand/testTimeoutSec |
 * | subgraph | ✗ | ✗ | ✗(不直接执行,运行时展开) | ✗ | ✗ | ✗ |   |   |   | subgraph |
 */
export type NodeConfig = {
  title: string
  /**
   * 节点类型**镜像**。与 CanvasNode.type 必须同步。
   *
   * 为什么要在 data 里再存一份:`specFromGraph` 只拿到 `node.data`,
   * 拿不到 React Flow 的 `node.type`;调度器/校验要只凭 data 就能判断语义。
   * 同步由 graphStore 的 toFlowNode / toGraph / normalizeConfig 统一保证。
   */
  kind: NodeKind

  // ---- Agent 类节点(project / feature / merge)共用 ----
  /**
   * 用什么东西跑这个节点。
   *
   * 两种形态共用这一个字段(见 shared/providers.ts 的 apiAgentId):
   *   - CLI 工具:id 就是工具名,如 `claude` / `codebuddy` / `codex`;
   *   - API 直连:`api:<providerId>`,如 `api:hunyuan` / `api:deepseek`。
   *
   * 合成一个字段而不是拆成 agentId + providerId:节点上真正要回答的问题只有
   * "这个节点用什么跑"。拆两个字段就会冒出"CLI 的 id 配了 API 的服务商"这类
   * 没有意义的组合,以及随之而来的一堆校验分支。
   */
  agentId?: string
  /**
   * API 型 agent 用哪个模型(v0.4.0 新增)。
   *
   * 只在 agentId 是 API 型时有意义 —— CLI 工具的模型由它自己的参数或配置决定,
   * 我们不该越权替它选,所以对 CLI 一律留空,配置面板也只在选中服务商时才显示它。
   * 留空 = 用该服务商的默认模型(解析顺序见 effectiveModel)。
   */
  model?: string
  /** agent 的工作目录。空 = 继承项目节点锚定的项目文件夹 */
  cwd?: string
  /** prompt 模板,支持 {{input}} / {{prev}} / {{node:<id>}}。留空 = 用输入框的话 */
  promptTemplate?: string
  permissionMode?: PermissionMode
  /** 上游节点失败时的策略 */
  failurePolicy?: 'stop' | 'skip' | 'continue'
  /** 失败重试次数 */
  retry?: number

  // ---- feature 专属 ----
  mode?: FeatureMode

  // ---- project 专属 ----
  /**
   * 项目文件夹:整个画布项目文件夹的**唯一权威来源**(用户决策 Q1)。
   * 画布级 CanvasGraph.projectDir 已 deprecated,仅无 project 节点时兜底读。
   */
  projectDir?: string
  /** 项目说明:"这个项目是做什么的",作为起点上下文交给下游 */
  brief?: string

  // ---- output 专属(无 agentId / promptTemplate 等,面板也不显示它们)----
  buildTarget?: BuildTarget
  buildOptions?: BuildOptions

  // ---- image 专属(v0.3.0 新增;无 agentId,画面描述复用 promptTemplate)----
  /** 生成参数:张数 / 尺寸 / 种子 */
  imageParams?: ImageParams
  /** 出图方式:本地命令 / HTTP 二选一 */
  imageProvider?: ImageProviderConfig

  // ---- game 专属(v0.4.1;session 节点,复用 agent 字段 + 引擎选择)----
  /** 游戏引擎。目前支持 godot(开源 MIT,生成项目文件后由 Godot 编辑器打开) */
  gameEngine?: 'godot'

  // ---- video 专属(v0.4.1;内置动作节点,无 agentId)----
  /** 视频理解参数:来源 / 视觉模型 / 抽帧 */
  videoParams?: VideoParams

  // ---- test 专属(内置动作,无 agentId)—— 在项目目录里跑的一条命令 ----
  /**
   * 要跑的测试命令,**整条命令行**(允许 && / 管道 / 引号,因此执行器用 shell)。
   * 留空 = 没有任何可跑的 —— 运行前校验会 warn。
   */
  testCommand?: string
  /** 测试超时(秒)。默认 300,夹到 5..3600。 */
  testTimeoutSec?: number

  // ---- handoff 专属(v0.4.2;内置动作节点,无 agentId)----
  /** 交接说明:这批素材给下游做什么用(游戏素材 / UI 图 / 封面…) */
  handoffNote?: string

  // ---- 生图工作区(prompt / prompt_negative 专属;builtin noop 节点)----
  /** 正向提示词:画面要什么(生图页 prompt 节点) */
  promptText?: string
  /** 负向提示词:画面不要什么(生图页 prompt_negative 节点) */
  negativeText?: string

  // ---- subgraph 专属:一段被封起来的节点图(数据跟着子图节点走)----
  /**
   * 子图模板。位置是**相对子图节点**的偏移(封装时减去包围盒左上角),
   * 展开时再加回来 —— 这样挪动子图节点 = 挪动整段。
   *
   * 运行时(specFromGraph)会把它展开回平铺节点执行,语义与没封装过**完全一样**。
   */
  subgraph?: SubgraphTemplate

  // ---- agent 专属(v0.6.1 工程化 agent 编排:带循环的智能体)----
  /** 角色设定(系统提示):"你是规划师 / 审查员…"。空 = 不额外设定 */
  agentRole?: string
  /** 循环轮次上限 1..8,默认 3。输出含 doneHint 即提前收尾 */
  maxRounds?: number
  /** 完成标志:LLM 输出包含它即认为该智能体任务完成(默认「任务完成」) */
  doneHint?: string

  // ---- router 专属(v0.6.1 工程化 agent 编排:LLM 智能路由)----
  /**
   * 分支标签,顺序 = 出边顺序:第 i 个标签描述第 i 条出边。
   * LLM 看完上游成果后选一条分支激活,其余分支自动跳过。
   */
  routes?: string[]

  // ---- chart 专属(v0.6.2 可视化图形制作:内置 SVG 图表渲染)----
  /** 图表参数:类型 / 标题 / 尺寸 / 数据(数据模板可含 {{input}} 注入上游产出) */
  chartParams?: ChartParams

  // ---- python 专属(v0.6.4 多语言节点:子进程跑 Python 脚本)----
  /** Python 执行参数:脚本本体 / 脚本文件 / 命令行参数 / python 路径 */
  pythonParams?: PythonParams

  // ---- gate 专属(v0.6.5 反馈闭环:失败即拦截 + 触发自动修复)----
  /** 闸门参数:校验规则(命令退出码 / 上游产出文本),不通过则失败并拦住下游 */
  gateParams?: GateParams

  // ---- 自动修复(v0.6.5 反馈闭环:feature/agent 节点配置)----
  /** 开启后:下游 gate/test 失败时,本节点自动进入修复轮次(错误喂回 LLM 重跑) */
  autofix?: AutofixParams

  // ---- v0.6.6 工程化节点群(P1/P2/P4)----
  /** lint 专属:静态检查命令(缺省 npx tsc --noEmit) */
  lintParams?: LintParams
  /** git 专属:本地版本操作(status / commit / log / branch,不 push) */
  gitParams?: GitParams
  /** deps 专属:依赖清单与缺失检测(自动识别 npm / pip) */
  depsParams?: DepsParams
  /** context 专属:项目记忆(代码风格 / 规范 / 接口清单,落盘供下游引用) */
  contextParams?: ContextParams
  /** contract 专属:接口契约(从上游文本提取路由,生成 OpenAPI 骨架) */
  contractParams?: ContractParams
  /** cost 专属:运行摘要与成本估算(各节点状态 / 耗时 / 产出规模) */
  costParams?: CostParams
  /** diff 专属:项目现状快照(文件树 + 变更统计,给增量修改当上下文) */
  diffParams?: DiffParams
  /** deploy 专属:Web 静态部署包(复制产物 + 生成 vercel/netlify 配置) */
  deployParams?: DeployParams
}

/** v0.6.6 lint 节点:静态检查(确定性,比 LLM 审查更便宜) */
export interface LintParams {
  /** 检查命令(在项目目录执行,退出码 0 = 通过);空 = npx tsc --noEmit */
  command?: string
  timeoutSec?: number
}

/** v0.6.6 git 节点:本地版本操作(只在项目目录内,不 push 外部) */
export interface GitParams {
  op: 'status' | 'commit' | 'log' | 'branch'
  /** op=commit 时用;空 = 自动消息 */
  message?: string
}

/** v0.6.6 deps 节点:依赖管理(清单 + 缺失检测 + 版本) */
export interface DepsParams {
  /** 自动识别 package.json / requirements.txt */
  manager?: 'auto' | 'npm' | 'pip'
}

/** v0.6.6 context 节点:项目记忆 */
export interface ContextParams {
  /** 记忆文本:代码风格 / 命名规范 / 已定义接口 / 目录结构说明 */
  text?: string
}

/** v0.6.6 contract 节点:接口契约 */
export interface ContractParams {
  /** 手工补充的契约说明(与上游产出合并) */
  text?: string
}

/** v0.6.6 cost 节点:运行摘要(参数留空,数据由调度器注入) */
export interface CostParams {
  /* 无 */
}

/** v0.6.6 diff 节点:项目现状快照 */
export interface DiffParams {
  /* 无 */
}

/** v0.6.6 deploy 节点:Web 静态部署包 */
export interface DeployParams {
  /** 部署平台配置 */
  platform?: 'vercel' | 'netlify' | 'static'
}

/** v0.6.5 闸门(Gate)节点参数:运行 → 校验 → 不通过就拦住,别往下传 */
export interface GateParams {
  /** 校验方式:exit = 跑命令看退出码;text = 校验上游产出文本 */
  mode: 'exit' | 'text'
  /** mode=exit:要跑的命令(在项目目录里执行) */
  command?: string
  /** mode=exit:命令超时(秒),缺省 120 */
  timeoutSec?: number
  /** mode=text:文本判定规则 */
  textRule?: 'contains' | 'not-contains' | 'regex'
  /** mode=text:匹配文本 / 正则 */
  pattern?: string
  /** 失败时给修复节点的提示(可留空,默认"修复使其通过校验") */
  hint?: string
}

/** v0.6.5 自动修复参数:挂在 feature/agent 节点上,给下游失败兜底 */
export interface AutofixParams {
  /** 是否开启自动修复(下游 gate/test 失败时触发) */
  enabled?: boolean
  /** 本轮运行内最多修复轮数(1..3,缺省 2) */
  maxRounds?: number
}

/** v0.6.4 Python 节点参数:子进程跑脚本,stdout 交下游 */
export interface PythonParams {
  /** 脚本本体(python 源码);与 scriptPath 二选一 */
  script?: string
  /** 脚本文件相对项目目录的路径(script 为空时读取它) */
  scriptPath?: string
  /** 传给脚本的命令行参数(逐项,不做 shell 展开) */
  args?: string[]
  /** python 可执行文件;空 = 用 PATH 里的 python */
  pythonPath?: string
  /** 超时(秒),缺省 300 */
  timeoutSec?: number
}

/** 图表类型(v0.6.2):ECharts SSR 支持的 5 种 */
export type ChartType = 'bar' | 'line' | 'pie' | 'scatter' | 'funnel'

/** 图表参数(v0.6.2):ECharts SSR 渲染为 SVG,落盘 assets/generated/charts/ */
export interface ChartParams {
  chartType: ChartType
  title?: string
  /** 画布宽(px),夹到 320..2000 */
  width: number
  /** 画布高(px),夹到 240..2000 */
  height: number
}

/**
 * 子图模板 —— 「一段被封起来的节点图」的完整数据。
 *
 * ## inMap / outMap 为什么按"外部节点 id"记映射
 *
 * 封装那一刻,外部连线各自接在内部哪个节点上是**已知**的;封装之后用户还可能
 * 给子图节点新拉线 —— 那些线在模板里没有对应记录,只能落到兜底入口/出口
 * (entryIds[0] / exitIds 最后一个)。按"外部 id → 内部 id"记,展开时拿现存的
 * 外部线去查:还记得就精确重接,不记得(或对端已删)就落兜底。
 */
export interface SubgraphTemplate {
  /** 内部节点。位置 = 相对子图节点的偏移 */
  nodes: { id: string; type: NodeKind; position: { x: number; y: number }; data: NodeConfig }[]
  /** 内部连线(id 可为空串,展开时会按端点重算) */
  edges: { id: string; source: string; target: string }[]
  /** 封装时外部入线 → 内部入口的对应(from = 外部节点 id) */
  inMap: { from: string; to: string }[]
  /** 封装时内部出口 → 外部出线的对应(to = 外部节点 id) */
  outMap: { from: string; to: string }[]
  /** 兜底入口(封装后新连的外部入线都接第一个);空 = 没有入口 */
  entryIds: string[]
  /** 兜底出口(新拉的出线都从最后一个出);空 = 没有出口 */
  exitIds: string[]
}

export type CanvasNode = {
  id: string
  /** 与 NodeConfig.kind 同步。React Flow 按它选组件 */
  type: NodeKind
  position: { x: number; y: number }
  data: NodeConfig
}

export type CanvasEdge = {
  id: string
  source: string
  target: string
}

export type Viewport = {
  x: number
  y: number
  zoom: number
}

export type CanvasGraph = {
  /**
   * v0.2.0 起为 2;v0.3.0(image-node)起为 3(D1 决策)。
   * 加载 <3 时经 migrateGraph 升级(幂等)。保存恒写 3 —— 渲染端是唯一写入方,
   * 不能指望主进程兜。
   *
   * 升到 3 的**唯一理由**是能力代际标记:v2→v3 对已有节点**零数据迁移**,
   * 但若用户把含 image 节点的画布分享给还停在 v0.2.0 的旧版应用,旧版能凭
   * version:3 识别"这代我不认识"并提示升级,而不是渲染出一个空白/异常节点。
   */
  version: 3
  name: string
  /**
   * ⚠️ @deprecated 画布级项目文件夹。
   *
   * 唯一权威已转移到 project 节点(用户决策 Q1);**仅在没有 project 节点时
   * 作兼容兜底读**(经 resolveProjectDir)。新写一律以 project 节点为准,
   * 本字段不再是"用户配的项目文件夹"。
   *
   * 为什么仍保留字段而不是删掉:旧画布加载后要无损(P0-9),而且用户可能
   * 还没放项目节点 —— 这时它是唯一的目录来源。彻底移除归 P1-6。
   */
  projectDir: string
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  viewport: Viewport
}

export const EMPTY_GRAPH: CanvasGraph = {
  version: 3,
  name: '默认画布',
  projectDir: '',
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
}

/**
 * 项目文件夹权威解析的来源。UI 用它如实标注(Deprecated 的兜底要显式告知用户)。
 */
export type ProjectDirSource = 'node' | 'canvas' | 'none'

/**
 * 项目文件夹权威解析:**优先 project 节点,无则回落画布级 projectDir(deprecated)**。
 *
 * 这是整个增量里**唯一**该回答"项目文件夹在哪"的地方。所有调用方
 * (specFromGraph / 节点卡片显示 / 配置面板 fallback)只走它 —— 各写一遍
 * `||` 的下场是"界面显示 A 目录、agent 跑在 B 目录",一个不报错、行为微妙的 bug。
 *
 * 返回 `source` 是为了让 UI 能如实标注兜底来源;只要字符串的调用方取 `.dir`。
 * 空串语义与 effectiveCwd 一致 = "用户没说过要在哪儿干活",**不是**"随便挑一个";
 * 真正兜底到沙箱仍然只由主进程的 resolveStartCwd 决定(边界只守一次)。
 */
export function resolveProjectDir(
  nodes: readonly { data?: { kind?: NodeKind; projectDir?: string } }[],
  legacyProjectDir: string | undefined,
): { dir: string; source: ProjectDirSource } {
  // 多个 project 节点不强制(用户决策 Q3),取第一个;多于一个由 validateGraph 给软提示
  const proj = nodes.find((n) => n.data?.kind === 'project')
  const own = proj?.data?.projectDir?.trim()
  if (own) return { dir: own, source: 'node' }
  const legacy = (legacyProjectDir ?? '').trim()
  if (legacy) return { dir: legacy, source: 'canvas' }
  return { dir: '', source: 'none' }
}

/**
 * 画布迁移:version 1/2 → 3,**幂等**。
 *
 * 迁移规则(PRD §7):旧 `agent` 节点 → `feature` 且 `mode='serial'`。
 * 依据:旧模型"共享同一项目文件夹 + 上游产出全量注入 + 按就绪队列顺序执行"
 * 正是"串行"的定义,映射后**语义零变化**,旧画布跑出来的结果与升级前一致。
 *
 * v0.3.0 新增的 `image` 是本规则的一个"合法新 kind":已是新代的节点(kind 在、
 * type 不是 'agent')一律原样返回,所以含 image 的 v3 画布重复迁移也不会被改写。
 *
 * ⚠️ 幂等性**不依赖 version 号**:只要节点 type 已不是 'agent' 且 data.kind
 * 在,就原样保留。所以重复加载、主进程先迁渲染进程又迁一次,都不会重复改写
 * —— 手改过的 graph.json 少写 version 字段也不会被误判回 v1。
 */
export function migrateGraph(raw: unknown): CanvasGraph {
  const g = (raw ?? {}) as Partial<CanvasGraph> & { version?: number }
  const rawNodes = Array.isArray(g.nodes) ? g.nodes : []
  const nodes: CanvasNode[] = rawNodes.map((n, i) => {
    const legacyType = (n as { type?: string }).type === 'agent'
    const data = (n.data ?? {}) as NodeConfig
    const id = n.id ?? `n-migrated-${i}`
    const position = n.position ?? { x: 0, y: 0 }
    // 已是新代(kind 在、type 不是 agent)→ 原样保留;type 从 data.kind 重算一次,
    // 防止手改数据里 type 与 kind 不同步时 React Flow 选错组件
    if (!legacyType && data.kind) {
      return { id, type: data.kind, position, data }
    }
    // 旧 agent(或 data 缺 kind)→ feature/serial;原有字段一个不丢
    return {
      id,
      type: 'feature',
      position,
      data: { ...data, kind: 'feature', mode: data.mode ?? 'serial' },
    }
  })
  const rawEdges = Array.isArray(g.edges) ? g.edges : []
  return {
    version: 3,
    name: g.name ?? '默认画布',
    projectDir: typeof g.projectDir === 'string' ? g.projectDir : '',
    nodes,
    edges: rawEdges.map((e, i) => ({
      id: e.id ?? `e-migrated-${i}`,
      source: e.source,
      target: e.target,
    })),
    viewport: g.viewport ?? { x: 0, y: 0, zoom: 1 },
  }
}

/**
 * 子图模板的**宽容解析** —— graph.json 可被手改,模板里可能少字段 / 有悬空引用。
 *
 * 与 migrateGraph 同一条原则:能救则救(缺 position 补 0,0;悬空的边/映射剔除),
 * 救不了的整体剔除。剔除后的"内部没有入口但有上游"这类后果由校验(V13..V15)提示,
 * 这里不做决策 —— normalize 只负责把数据变成可信的形状。
 */
export function normalizeSubgraph(raw: unknown): SubgraphTemplate | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const t = raw as Partial<SubgraphTemplate>

  const rawNodes = Array.isArray(t.nodes) ? t.nodes : []
  const nodes: SubgraphTemplate['nodes'] = []
  const ids = new Set<string>()
  for (const n of rawNodes) {
    if (typeof n !== 'object' || n === null || typeof n.id !== 'string' || !n.id) continue
    if (ids.has(n.id)) continue
    ids.add(n.id)
    nodes.push({
      id: n.id,
      type: (typeof n.type === 'string' ? n.type : 'feature') as NodeKind,
      position:
        n.position && typeof n.position.x === 'number' && typeof n.position.y === 'number'
          ? { x: n.position.x, y: n.position.y }
          : { x: 0, y: 0 },
      data: (n.data ?? {}) as NodeConfig,
    })
  }

  const rawEdges = Array.isArray(t.edges) ? t.edges : []
  const edges: SubgraphTemplate['edges'] = []
  const seen = new Set<string>()
  for (const e of rawEdges) {
    if (typeof e !== 'object' || e === null) continue
    if (typeof e.source !== 'string' || typeof e.target !== 'string') continue
    if (!ids.has(e.source) || !ids.has(e.target) || e.source === e.target) continue
    const key = `${e.source}\u0000${e.target}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ id: typeof e.id === 'string' ? e.id : '', source: e.source, target: e.target })
  }

  const pairList = (v: unknown, hasFrom: (s: string) => boolean, hasTo: (s: string) => boolean) => {
    const out: { from: string; to: string }[] = []
    for (const m of Array.isArray(v) ? v : []) {
      if (typeof m !== 'object' || m === null) continue
      const from = (m as { from?: unknown }).from
      const to = (m as { to?: unknown }).to
      if (typeof from !== 'string' || typeof to !== 'string') continue
      if (!hasFrom(from) || !hasTo(to)) continue
      out.push({ from, to })
    }
    return out
  }
  const inMap = pairList(t.inMap, () => true, (s) => ids.has(s))
  const outMap = pairList(t.outMap, (s) => ids.has(s), () => true)

  const idList = (v: unknown): string[] =>
    (Array.isArray(v) ? v : []).filter((s): s is string => typeof s === 'string' && ids.has(s))

  return {
    nodes,
    edges,
    inMap,
    outMap,
    entryIds: idList(t.entryIds),
    exitIds: idList(t.exitIds),
  }
}

/**
 * 用户**明确**指定的目录:节点自己的 cwd 优先,没人给就用项目文件夹。
 *
 * 两者都没有时返回空串,而空串的意思是"用户没说过要在哪儿干活" ——
 * **不是**"随便挑一个"。真正的落点由主进程的 `resolveStartCwd` 决定:
 * 它会兜到 `workspaces/<canvasId>` 这个沙箱,**绝不会**是应用自己的目录
 * (agent 默认 acceptEdits,在源码目录里起来就能改这个项目)。
 *
 * ⚠️ 别把兜底写进这里。渲染进程只需要知道"用户配了没有"来做显示,
 * 让它同时承担安全兜底的话,多一个调用方就多一次漏掉的机会。
 * 单独抽出来是因为有几个地方要回答同一个问题(节点卡片、配置面板、
 * 工作流 spec),各处自己写一遍 `||` 的话,迟早有一处忘了项目文件夹这一层。
 *
 * v2 起接的 `projectDir` 由 resolveProjectDir 产出(不再是画布级字段直读)。
 */
export function effectiveCwd(projectDir: string | undefined, nodeCwd: string | undefined): string {
  return nodeCwd || projectDir || ''
}

/**
 * 节点 id 必须**全局唯一**,不只是画布内唯一。
 *
 * 理由在主进程:SessionManager 按 nodeId 做互斥(一个 nodeId 同时只能跑一路进程)。
 * 两个画布各有一个 "node-1" 的话,在管理器眼里它们是同一个节点 ——
 * 会互相阻塞,日志也会串。所以带一段随机后缀。
 */
export function newCanvasNodeId(): string {
  return `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}
