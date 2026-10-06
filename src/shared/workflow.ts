// 从 events/log 直接取,不经 ipc —— 否则 ipc 要 re-export 本文件,绕成一个类型环
import type { PermissionMode } from './events'
import type { PersistedRecord } from './log'
// 只 import type:failure.ts 零依赖,但这里不需要它的值,不必把它拖进任何 bundle
import type { FailureKind } from './failure'
// 按值引:effectiveCwd / resolveProjectDir / newCanvasNodeId 是纯函数,canvas.ts 只 import type,不会把 zod 拖进来
import { effectiveCwd, newCanvasNodeId, resolveProjectDir } from './canvas'
import type {
  BuildOptions,
  BuildTarget,
  FeatureMode,
  ImageParams,
  ImageProviderConfig,
  NodeKind,
  SubgraphTemplate,
  VideoParams,
} from './canvas'
// NodeKind 的真相源与类型定义在 nodeRegistry;validateGraph 改为**注册表驱动**
import { connectionWarning, emptySubgraphMessage, getNodeType, NODE_TYPES } from './nodeRegistry'
import type { GraphValidateCtx, NodeTypeDef, TypeValidateCtx } from './nodeRegistry'
// 按值引:纯函数,无副作用 ——「这个 agentId 是不是 API 直连」「用哪个模型」
// 都只该有一处实现。effectiveModel 是模型优先级的**单一真相源**
// (节点显式选的 > 设置里的默认 > 内置首选),spec 与主进程运行期共用它,
// 所以界面上写的模型与请求里发的模型不可能分叉。
import { effectiveModel, providerIdOfAgent } from './providers'

/**
 * 工作流的契约 —— 主进程调度器与渲染进程 RunBar 共用同一份定义。
 *
 * ## 为什么渲染进程每次 run 都把整张图的快照传过来
 *
 * 主进程不持有画布。代价是运行中改图不影响本次运行 ——
 * 而**这其实是优点**:运行语义被冻结,不会出现"跑到一半目标变了"。
 * 好处是主进程保持无状态,调度逻辑简单到可以单独测试。
 */

export type FailurePolicy =
  /** 默认。上游失败 → 所有后代标 skipped,独立分支继续跑 */
  | 'skip'
  /** 上游失败 → 整条运行转 failed */
  | 'stop'
  /** 把失败当成"空产出",照常往下跑 */
  | 'continue'

export type SpillPolicy =
  /** 默认。产出过大时落盘,往模板里注入文件路径 + 预览(下游用 Read 取全文) */
  | 'file'
  /** 直接截断。给没有工具能力的 CLI 用(argv 模式下它连 Read 都没有) */
  | 'truncate'
  /** 宁可失败也不静默降级 */
  | 'fail'

/** 运行一个节点所需的全部信息。与画布上的节点配置一一对应 */
export interface WorkflowNodeSpec {
  id: string
  title: string
  /** 节点类型 */
  kind: NodeKind
  /**
   * 执行器种类。由 `specFromGraph` 从注册表**拍进来** —— 主进程运行期不再回查
   * 注册表(主进程无画布状态)。runner 只认它,不认 kind(去散点的核心)。
   */
  executor: 'session' | 'builtin'
  /** 仅 builtin:走哪个内置动作(package / image) */
  action?: string
  /** 仅 feature 有:串行 = 注入上游产出并叠加;并行 = 独立支路(不自动注入) */
  mode?: FeatureMode
  cwd: string
  /**
   * project 专属:**用户显式配的**项目文件夹(未配 = 空串)。
   *
   * ⚠️ 与 `cwd` 是**两件事**,不可互相替代:
   *   - `cwd` 是**解析后**的值 —— project 节点空则回落画布级/沙箱,永远有值;
   *   - `projectDir` 是**用户配没配** —— V3 那条 warn 问的是这个。
   * 少了这个字段,主进程 runner 把 spec 当 `NodeSpecSource` 传给 validateGraph 时,
   * 每个**配好了目录**的项目节点都会被判成"还没选文件夹" ——
   * 用户去设置里一看目录好好设着,最后怀疑是 bug。
   * 那种"教用户忽略项目节点的警告"比不报更糟。
   */
  projectDir?: string
  /** ⚠️ 非会话节点(output / image)**没有** agentId(它们不走会话) */
  agentId?: string
  /**
   * API 型 agent 用的模型(v0.4.0)。CLI 型为 undefined —— 那种工具的模型
   * 由它自己的参数决定,我们不越权替它选。同样只在会话节点上有意义。
   */
  model?: string
  promptTemplate: string
  permissionMode?: PermissionMode
  failurePolicy: FailurePolicy
  retry: number
  /** project 专属:"这个项目是做什么的",composePrompt 时前置为起点上下文 */
  brief?: string
  /** output 专属 */
  buildTarget?: BuildTarget
  buildOptions?: BuildOptions
  /** image 专属(画面描述走上面的 promptTemplate) */
  imageParams?: ImageParams
  imageProvider?: ImageProviderConfig
  /** handoff 专属:交接说明(这批素材给下游做什么用) */
  handoffNote?: string
  /** prompt / prompt_negative 专属(v0.5.0 生图工作区):提示词文本 */
  promptText?: string
  negativeText?: string
  /** test 专属:在项目目录里跑的一条测试命令行 + 超时(秒) */
  testCommand?: string
  testTimeoutSec?: number
  /** game 专属 */
  gameEngine?: 'godot'
  /** video 专属(内置动作) */
  videoParams?: VideoParams
  /** agent 专属(v0.6.1):角色设定(系统提示) */
  agentRole?: string
  /** agent 专属:循环轮次上限(1..8) */
  maxRounds?: number
  /** agent 专属:完成标志(输出含它即收尾) */
  doneHint?: string
  /** router 专属:分支标签(顺序 = 出边顺序) */
  routes?: string[]
}

export interface WorkflowEdgeSpec {
  source: string
  target: string
}

export interface WorkflowSpec {
  runId: string
  canvasId: string
  /** 只跑这些节点。空 = 全图(所有边仍然生效) */
  targets: string[]
  nodes: WorkflowNodeSpec[]
  edges: WorkflowEdgeSpec[]
  /** 用户在这次运行里额外给的输入,对应 {{input}} 的"手填"部分 */
  input: string
  maxParallel: number
  /** 单个上游产出的内联上限,超出走 spillPolicy */
  inlineLimitBytes: number
  spillPolicy: SpillPolicy
  /**
   * 画布级 projectDir(deprecated 兜底)。
   *
   * 为什么 spec 里还要带它:主进程在 run() 里调 validateGraph 时,
   * V1(没有项目节点)/V5(输出节点触达不到项目)这两条要拿它区分
   * "有画布级兜底"和"彻底没目录"两种情形,提示语才说得准。
   */
  projectDir?: string
}

export type RunNodeStatus =
  | 'queued'
  /** 上游还没好 —— 与 queued 分开是为了让 UI 能说清"在等谁" */
  | 'waiting'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'cancelled'

export interface RunNodeState {
  nodeId: string
  status: RunNodeStatus
  /** 已尝试次数(含首次)。用于 UI 显示"第 2 次尝试" */
  attempts: number
  startedAt?: number
  endedAt?: number
  error?: string
  /**
   * `error` 的类别(v0.6.0)。**只有归出类时才有值**。
   *
   * 调度器据此跳过退避重试,渲染端据此显示"该改配置"而不是"再试一次"。
   * 两者用的是同一份判定(shared/failure.ts),所以界面上说的和调度器做的一致。
   */
  errorKind?: FailureKind
  /*
   * ⚠️ 上面这三个字段(error / errorKind / errorRetryable)**不要拿 error 的文案
   * 做去重键或字符串比对**。
   *
   * 同文件里 graphIssuesFor 已经有一处按 message 去重(空模板 V13 与 expandSubgraphs
   * 的 warning 说的是同一件事,措辞逐字一致,改一处要改两处,不共用常量就会在
   * RunBar 检查列表里出现两遍)。那套机制只覆盖**图校验**,运行态这边不参与 ——
   * 但它意味着本文件已经存在「两处文案必须逐字一致」的先例。
   * 一旦有人把 error 拉进那条链路,它就从「一句提示」变成「半个契约」,
   * 改文案会像改常量那样牵连别处。要按类别判断就用 errorKind(结构化、稳定),
   * 它本来就是为这件事准备的。
   */
  /**
   * 本次失败**重试也没用**。只在明确归类为不可重试时为 false;
   * `undefined` = 没归出类,按可重试处理(维持旧行为)。
   *
   * ⚠️ **别让渲染端从 `errorKind !== 'unknown'` 推这个字段**(或反过来)。
   * 那是把判定规则复制到第二个地方:主进程往 `shared/failure.ts` 加一条规则,
   * 界面这边不会跟着变,而两边都不报错 —— 调度器已经在退避重试了,
   * 界面却告诉用户"重试没用",用户于是去改他根本没配的东西。
   * 要显示就显示这个字段的值,它由主进程算好后随运行态一起过来。
   *
   * (为什么 `error` 与 `errorKind` 要分开:`error` 是**给人看的话**,
   *  `errorKind` 是给代码看的**类别**,两者由同一次判定产出(shared/failure.ts),
   *  所以界面说的与调度器做的永远一致。)
   */
  errorRetryable?: boolean
  /** 产出字符数,给 UI 一个规模感(不传正文,正文在节点日志里) */
  outputChars?: number
  /**
   * 最近产出正文的**开头预览**(v0.5.0 新增,悬停边/节点的"数据探针"用)。
   * 全文不进运行态(会撑爆每次推送的快照),预览够回答"它交出了什么"。
   */
  outputPreview?: string
  /**
   * 内置动作节点本次产出的**相对项目文件夹**路径列表(image 节点写它)。
   * 随 RunState 落盘 → 重启后节点卡片仍能显示缩略图(M-2:只覆盖最近一次运行)。
   */
  artifacts?: string[]
}

/**
 * 运行发起失败的附加信息,挂在 `Envelope.detail` 上。
 *
 * 环检测失败时必须把**环上那条闭合路径**带给 UI —— 图一大,
 * 光看一句"工作流里有环"用户根本不知道是哪几条线。
 */
export interface WorkflowRunFailure {
  /** 闭合路径上的节点 id,首尾同一个。非环错误时不存在 */
  cycle?: string[]
}

export type RunStatus = 'running' | 'done' | 'failed' | 'cancelled'

export interface RunState {
  runId: string
  canvasId: string
  status: RunStatus
  startedAt: number
  endedAt?: number
  nodes: Record<string, RunNodeState>
}

/**
 * 运行 id。由**渲染进程**生成。
 *
 * 谁发起谁命名:渲染进程要在调用返回之前就把它记进 store,才能接住
 * 紧接着推来的第一个事件 —— 等主进程分配 id 再回传的话,中间那一小段
 * 里到达的事件找不到归属,会被丢掉。
 */
export function newRunId(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 整合节点每条上游支路的性质。**只有调度器算得出来**(要知道拓扑),
 * 所以由 runner 组装、由 `formatBranchManifest` 渲染成文字。
 */
export interface MergeBranchInfo {
  id: string
  title: string
  /**
   * `project`  项目的起点状态(基线,本身不含功能改动)
   * `serial`   串行功能:在上游成果之上叠加
   * `parallel` 并行功能:与兄弟支路同时改同一份代码,改动可能已被覆盖
   * `merge`    上游的整合节点(已经收口过一次)
   */
  role: 'project' | 'serial' | 'parallel' | 'merge'
  /**
   * 该支路的改动已被清单里**另一条支路**包含(串行链上它是别人的上游)。
   *
   * 有值 = **不要重复落实**。串行是叠加语义:A → B 都连到整合节点时,
   * B 是在 A 之后、看着 A 的成果做的,它的现状里已经含了 A。
   * 不标出来的话整合节点会把 A 再实施一遍 —— 同一件事做两遍正是
   * "串行链和并行支路合不到一块"最常见的来源。
   */
  subsumedByTitle?: string
}

/** 支路角色 → 给模型看的一句话。刻意写明"改动在不在项目里",这是判据 */
const BRANCH_ROLE_TEXT: Record<MergeBranchInfo['role'], string> = {
  project: '项目节点 —— 项目的起点状态,本身不含功能改动',
  serial: '串行功能 —— 在上游成果之上叠加,改动**已经在项目里**',
  parallel: '并行功能 —— 与其它支路同时改同一份代码,改动**可能已被别的支路覆盖**',
  merge: '上游整合节点 —— 已经收口过一次,可当成一条已验证的支路',
}

/**
 * 把支路清单渲染成一段给模型读的文字(纯函数,可单测)。
 *
 * 单独抽出来的理由:这里是整合节点**唯一的判据来源**。它拿到的
 * `{{prev}}` 只是各支路的一段段文字,看不出谁和谁并行、谁已经把谁叠加了 ——
 * 而"该不该重复落实某条支路"完全取决于这个,不取决于支路自己怎么写。
 *
 * 空清单返回空串:`renderTemplate` 会把 `{{branches}}` 整行替换成空,
 * 默认模板里那句"先分清两类支路"因此仍然通顺(整合节点上游为 0 是
 * 校验 V6 会提示的情形,不该在这里抛)。
 */
export function formatBranchManifest(branches: readonly MergeBranchInfo[]): string {
  if (branches.length === 0) return ''

  const lines = [`## 支路清单(共 ${branches.length} 条)`]
  for (const b of branches) {
    // 包含关系用括号收在末尾:前面已经有一个破折号,再用破折号会连成一串,读不清层次
    const tail = b.subsumedByTitle ? `(已被「${b.subsumedByTitle}」包含,**不要重复落实**)` : ''
    lines.push(`- 「${b.title}」:${BRANCH_ROLE_TEXT[b.role]}${tail}`)
  }

  /*
   * 只统计**未被包含**的并行支路:已被别的支路包含的那条,它的改动不足以
   * 单独构成一次覆盖风险(真正的现状在包含它的那条支路里)。
   */
  const racing = branches.filter((b) => b.role === 'parallel' && !b.subsumedByTitle)
  if (racing.length >= 2) {
    lines.push(
      `⚠️ 这 ${racing.length} 条并行支路共用同一份项目目录,它们的改动**可能互相覆盖** —— ` +
        '以项目里的实际文件为准,不要只信支路自述。',
    )
  }
  if (branches.some((b) => b.subsumedByTitle)) {
    lines.push('⚠️ 串行链是叠加的:标了「已被…包含」的支路不要重复落实,否则同一件事会被做两遍。')
  }
  return lines.join('\n')
}

/**
 * 整合节点的默认合并指令。用户清空模板时用它(可编辑)。
 *
 * ## 唯一职责:让各支路的改动**互相兼容**
 *
 * 整合节点不是"把上游的文字汇总一下"的地方,而是**代码能不能合到一起**的
 * 唯一收口点。它的材料天然是两类性质完全不同的东西:
 *
 *   - **串行支路**:按顺序叠加,改动已经在项目里,是当前这份代码的组成部分;
 *   - **并行支路**:各改各的(共用同一份目录),改动可能互相覆盖、也可能与
 *     串行成果冲突。
 *
 * 旧模板把两者统称"各支路的成果",模型于是只能当成两堆并列的材料 ——
 * 常见的失败是**把串行支路重复落实一遍**(明明已经在项目里了),
 * 或者**只信支路自述、不去看项目实际成了什么样**。
 * 所以这里先把判据({{branches}})交给它,再要求以文件为准、最后验证一次。
 *
 * ⚠️ 措辞里有几处是 e2e 逐字钉住的(「整合进项目」「收敛冲突」,以及
 * `{{prev}}` / `{{projectDir}}` 两个变量必须在场)—— 改文案时别把它们删了。
 */
export const DEFAULT_MERGE_TEMPLATE =
  '你的唯一职责:把前面各支路的改动整合进项目,让它们**互相兼容**,合成一个能一起工作的程序。\n' +
  '\n' +
  '项目文件夹:{{projectDir}}\n' +
  '\n' +
  '先分清两类支路(它们不是同一种东西,处理方式相反):\n' +
  '1. 串行支路是**叠加**的 —— 它的改动已经在项目里,是你手上这份代码的组成部分,确认它还在、没被别的支路改坏即可;\n' +
  '2. 并行支路是**各改各的** —— 它们共用同一份代码,改动可能互相覆盖、或与串行成果冲突,这些才是你要收敛的部分;\n' +
  '3. 标了「已被…包含」的支路不要重复落实,否则同一件事会被做两遍。\n' +
  '\n' +
  '做法:\n' +
  '1. 先看项目里的**实际文件**现状(列目录 / 读文件),以文件为准 —— 各支路的自述只能说明"它想做什么",说明不了"现在是什么";\n' +
  '2. 逐条对照支路清单,把缺失的改动补上;若多条支路改了同一处,以「功能完整、互不破坏」为准收敛冲突;\n' +
  '3. 同一件事被两条支路各做了一遍时,合成一份能同时满足双方的实现,不要留下两套;\n' +
  '4. 合完之后**验证一次**:能构建就构建、能跑就跑(构建脚本 / 测试 / 启动入口),发现没收敛干净的冲突就继续修;\n' +
  '5. 最后报告:逐条给出落实结果(已落实 / 已收敛冲突 / 无法兼容及原因)+ 整合后项目能跑成什么样。\n' +
  '\n' +
  '{{branches}}\n' +
  '\n' +
  '各支路成果如下:\n' +
  '\n' +
  '{{prev}}'

/**
 * 审查节点的默认指令。用户清空模板时用它(可编辑)。
 *
 * ## 与"功能节点"的根本差别:它**不改代码**,产出一份问题清单
 *
 * 这是它唯一有价值的地方 —— 如果它顺手把问题改了,它就变成了一条普通串行支路,
 * 而"只看不改"的那份独立判断(以及最关键的:改动是不是真的解决了问题)
 * 就永远失去了。所以默认指令反复强调"不要改文件、不要提交",并且要求
 * 每条问题都给出**位置**和**为什么** —— 泛泛的"建议优化"下游没法执行。
 *
 * 同样刻意要求它**基于实际文件**而不是上游自述:上游说"我做完了"不等于做对了。
 */
export const DEFAULT_REVIEW_TEMPLATE =
  '你是一个**只读审查**节点:检查上游支路的成果,找出真问题。**不要修改任何文件,不要提交。**\n' +
  '\n' +
  '项目文件夹:{{projectDir}}\n' +
  '\n' +
  '先看现状:上游产出的自述附在最后,但它只能说明"想做什么"。请直接读项目里的实际文件,\n' +
  '以**文件的实际内容**为准 —— 上游说做完了,不等于做对了。\n' +
  '\n' +
  '审查顺序(按重要性,别平铺):\n' +
  '1. **会出错的**:逻辑错误、边界没处理、空值 / 越界、与项目里既有代码冲突、依赖缺失;\n' +
  '2. **会崩的**:资源没释放、异常没接、阻塞调用、明显的数据竞争;\n' +
  '3. **会坑人的**:接口与文档不符、错误信息说不清原因、命名让人误解;\n' +
  '4. 风格 / 格式问题放最后,而且只在它真的会带来误解时才提。\n' +
  '\n' +
  '每条问题必须写清三件事:在哪(文件 + 大致位置)、是什么、为什么是问题。\n' +
  '没问题的部分就明确说"没问题" —— 不要为了凑数硬挑。\n' +
  '\n' +
  '产出格式:先一句总体结论(能不能用),再逐条列问题,最后给建议的修复优先级。\n' +
  '\n' +
  '上游成果自述:\n' +
  '\n' +
  '{{prev}}'

/**
 * 文档节点的默认指令。用户清空模板时用它(可编辑)。
 *
 * ## 核心要求:跟着项目现有的文档风格写,而且是"改"不是"再写一份"
 *
 * 文档节点最容易干成的坏事是产出一堆与项目既有文档重名/重复的新文件 ——
 * 项目里于是有了两份说法不一样的说明,比没有文档更糟。所以默认指令先要求
 * 去看现有文档的写法与语言,并明确"已有的改,没有的才新建"。
 */
export const DEFAULT_DOC_TEMPLATE =
  '你是**文档节点**:为上游的成果补上或更新文档。你改的是文档,**不要改动业务代码**。\n' +
  '\n' +
  '项目文件夹:{{projectDir}}\n' +
  '\n' +
  '先摸清现有写法:列出项目里的文档(README、docs/、各目录的说明、代码里的注释),\n' +
  '看清它们用什么语言、什么结构、写到多细 —— **跟着它的风格写**,不要另起一套。\n' +
  '\n' +
  '写什么(按上游改动范围取舍,不要为了全而全):\n' +
  '1. 这块东西**是什么、怎么用** —— 给调用方视角的、能直接复制运行的示例;\n' +
  '2. 需要配置 / 前置条件 / 环境变量的地方要写全,别让读者去猜;\n' +
  '3. 已经写过的部分**改**,而不是再新建一份重复的 —— 两份说法不一样比没有文档更糟;\n' +
  '4. 只写你**确实验证过**的行为;不确定的地方标注「待确认」,不要编。\n' +
  '\n' +
  '产出:说明你改了 / 新增了哪些文件,以及读者现在能照着它做什么。\n' +
  '\n' +
  '上游成果:\n' +
  '\n' +
  '{{prev}}'

/**
 * 会话类节点在**模板留空**时用的默认提示词。
 *
 * 为什么放在这里、而不是让 runner 去查注册表:注册表(nodeRegistry)反过来
 * import 本文件(取 NodeKind / validateGraph 的类型),两边互为依赖 ——
 * 让注册表引用本文件的常量会在运行时形成环。而"kind → 默认模板"这件事
 * 本来就属于本文件(它已经知道了所有 kind 的语义),放这儿依赖方向是干净的。
 *
 * 于是 runner 里不再出现任何 kind 字面量:它只问 `spec.kind` 该用哪份默认模板。
 * 未登记的 kind 回落 `{{input}}`(= 把上游产出直接当提示词),这是升级前的行为。
 */
export function defaultPromptFor(kind: string): string {
  if (kind === 'merge') return DEFAULT_MERGE_TEMPLATE
  if (kind === 'review') return DEFAULT_REVIEW_TEMPLATE
  if (kind === 'doc') return DEFAULT_DOC_TEMPLATE
  if (kind === 'router') return DEFAULT_ROUTER_TEMPLATE
  return '{{input}}'
}

/**
 * 路由节点的默认提示词(v0.6.1)。
 *
 * 要求 LLM 只输出分支编号,由 runner 的 parseRouterPick 解析(带标签兜底)。
 * 模板里同时给出编号和标签两条线索,LLM 拿标签说人话、编号做机器可读输出。
 */
const DEFAULT_ROUTER_TEMPLATE = `上游成果(材料)如下:

{{input}}

下面这些分支,只允许选一条(其余分支将被跳过):
{{routes}}

请只输出一行,内容为你要选的那条分支的编号(如「分支1」)或分支名。
不要解释,不要输出别的。
`;

/**
 * 子图嵌套的展开轮数上限。
 *
 * 只是防手改 graph.json 造出自我包含的模板(UI 造不出这种结构),正常画布
 * 远到不了这个数量级 —— 实测 25 层嵌套耗时 <1ms,所以给得宽松点。
 * 到了上限还剩子图节点**不静默**:expandSubgraphs 会报一条 warn。
 */
export const MAX_SUBGRAPH_DEPTH = 20

/**
 * 展开子图时被"兜底入口"吞掉的外部入线。
 *
 * 存在的理由:模板只记了部分映射时,查不到的那些入线会**全部落到同一个入口**
 * (串行语义 = 叠加)。这在结果上等于把互不可见的几路输入静默混在一起,
 * 必须报出来,连兜底落点是谁一起说。
 */
export interface UnmappedInEdge {
  subgraphId: string
  /** 没能映射到入口的外部节点 id(按边去重后) */
  externals: string[]
  /** 兜底落点(展开后的 id) */
  fallback: string
}

/** `expandSubgraphs` 的返回值。除 nodes/edges/targets 外都是**给调用方的报告** */
export interface ExpandResult {
  nodes: { id: string; data: NodeSpecSource }[]
  edges: { source: string; target: string }[]
  targets: string[]
  /**
   * 展开过程中**必须让用户知道**的副作用(纯提示,调用方转成 warn 级 GraphIssue)。
   *
   * 为什么不静默:这些都是"看起来跑通了、结果却是错的"那一类 ——
   * 空模板子图被消掉后下游拿不到任何输入、嵌套超限的节点根本没被执行。
   */
  warnings: string[]
  unmappedIn: UnmappedInEdge[]
}

/**
 * 把图里的子图节点**展开回平铺节点**(纯函数,幂等)。
 *
 * ## 语义承诺:展开后的运行结果与没封装过**完全一样**
 *
 * 子图是纯 UI 层的复用机制,不是运行语义:调度器眼里只有平铺节点。
 * 内部节点 id 加 `<子图id>::` 前缀 —— 嵌套子图时前缀自然叠加(`外::内::节点`)。
 *
 * ## 前缀不足以防撞名(这是真的踩过的坑)
 *
 * 前缀只保证"内部 id 落在 `sub::` 命名空间",**不保证那个命名空间空着**:
 * 外部已存在 `sg::x`、子图内部有 `x` 时,展开后会出现两个 `sg::x`。
 * runner 的 `new Map(spec.nodes.map(n => [n.id, n]))` 只留一个,另一个的
 * 整份 spec(含 promptTemplate / cwd)被**静默丢弃** —— 用户点运行看到节点跑起来了,
 * 跑的却是另一个节点的提示词。所以这里必须像 `graphStore.expandSubgraph`
 * (用户手动展开那条路径)**同样**做 remap:两条路径做的是同一件事。
 *
 * ## 外部线的重接规则
 *
 *   - 入线(→ 子图):查 inMap(按"线另一端的外部节点 id"),查不到落 entryIds[0];
 *   - 出线(子图 →):查 outMap(按外部对端),查不到落 exitIds 最后一个;
 *   - 空模板的子图节点直接消掉,外部线随之断开 —— 下游**照样会跑**,
 *     只是 `{{prev}}` 是空的。所以这条必须报 warn(见 P1-1),不能只在 UI 文案里说。
 *
 * ## targets 的改写
 *
 * 指向子图节点的 target = "跑这段子图" = 跑它内部所有节点(每轮展开就地改写,
 * 嵌套子图也能追到最里层)。
 *
 * 轮数上限见 `MAX_SUBGRAPH_DEPTH`:到了上限还剩子图就原样留下,并报一条
 * warn(它会在 runner 里以"未知内置动作"失败,错误可见 —— 但用户看到那句话
 * 根本猜不到真实原因是嵌套层数超了)。
 */
export function expandSubgraphs(
  nodes: readonly { id: string; data: NodeSpecSource }[],
  edges: readonly { source: string; target: string }[],
  targets?: readonly string[],
): ExpandResult {
  let curNodes: { id: string; data: NodeSpecSource }[] = nodes.map((n) => ({ ...n }))
  let curEdges: { source: string; target: string }[] = edges.map((e) => ({ ...e }))
  let curTargets: string[] = [...(targets ?? [])]
  const warnings: string[] = []
  const unmappedIn: UnmappedInEdge[] = []

  for (let round = 0; round < MAX_SUBGRAPH_DEPTH; round++) {
    const sub = curNodes.find((n) => (n.data.kind ?? 'feature') === 'subgraph')
    if (!sub) break

    const t = sub.data.subgraph
    const rest = curNodes.filter((n) => n.id !== sub.id)
    if (!t || t.nodes.length === 0) {
      /*
       * 空模板:节点消掉,连着它的外部线一并删(断头线没有意义)。
       *
       * ⚠️ 下游节点**不会被跳过** —— 它还在图里,还是会被调度,只是收不到任何
       * 上游产出。删边这件事对用户完全不可见,而后果是"在空白上下文上叠加功能,
       * 而上游可能已经改了项目文件" —— 看起来跑通了,结果是错的。
       * 所以必须报出来(文案里说清是"断开"而不是"跳过")。
       * 刻意**不**自动跳过下游:静默改变执行集合比报错更糟。
       */
      const inbound = curEdges.some((e) => e.target === sub.id)
      const outbound = curEdges.some((e) => e.source === sub.id)
      if (inbound || outbound) {
        warnings.push(emptySubgraphMessage(sub.data.title || sub.id))
      }      curNodes = rest
      curEdges = curEdges.filter((e) => e.source !== sub.id && e.target !== sub.id)
      curTargets = curTargets.filter((x) => x !== sub.id)
      continue
    }

    const prefix = `${sub.id}::`
    const innerIds = new Set(t.nodes.map((n) => n.id))

    /*
     * 防撞名 remap —— 与 `graphStore.expandSubgraph` 同一件事,同一套做法。
     *
     * 外部已经占了 `<subid>::<inner>` 时给内部节点换一个全局唯一 id,并同步
     * 改写 edges / inMap / outMap / entryDefault / exitDefault / targets。
     * 漏掉任何一处都会留下一条指向旧 id 的悬空线(那种线在 store 里是隐形的,
     * 但 runner 的 nodeById 查不到它,那一路输入就无声丢了)。
     */
    const used = new Set(curNodes.map((n) => n.id))
    const remap = new Map<string, string>()
    for (const inner of t.nodes) {
      let id = prefix + inner.id
      if (used.has(id)) {
        id = newCanvasNodeId()
        remap.set(inner.id, id)
      }
      used.add(id)
    }
    /** 内部原始 id → 展开后的全局唯一 id(没撞名就是加前缀) */
    const fid = (x: string): string => remap.get(x) ?? prefix + x

    const entryId = t.entryIds[0] ?? t.nodes[0].id
    const exitId = t.exitIds[t.exitIds.length - 1] ?? t.nodes[t.nodes.length - 1].id
    const entryDefault = fid(entryId)
    const exitDefault = fid(exitId)

    curNodes = [...rest, ...t.nodes.map((inner) => ({ id: fid(inner.id), data: inner.data }))]

    // 这一轮里没被 inMap 命中的外部入线(按 source 去重)
    const missed: string[] = []

    curEdges = [
      // 内部线(带前缀)
      ...t.edges
        .filter((e) => innerIds.has(e.source) && innerIds.has(e.target))
        .map((e) => ({ source: fid(e.source), target: fid(e.target) })),
      // 外部线:重接到入口/出口
      ...curEdges.map((e) => {
        if (e.target === sub.id) {
          const m = t.inMap.find((mm) => mm.from === e.source && innerIds.has(mm.to))
          if (m) return { source: e.source, target: fid(m.to) }
          if (!missed.includes(e.source)) missed.push(e.source)
          return { source: e.source, target: entryDefault }
        }
        if (e.source === sub.id) {
          const m = t.outMap.find((mm) => mm.to === e.target && innerIds.has(mm.from))
          return { source: m ? fid(m.from) : exitDefault, target: e.target }
        }
        return e
      }),
    ]
    // 指向子图的 target → 内部全部节点(就地把这段子图跑完)
    curTargets = curTargets.flatMap((x) =>
      x === sub.id ? t.nodes.map((inner) => fid(inner.id)) : [x],
    )

    /*
     * 兜底入口吞掉了外部入线 → 报出来。
     *
     * 只有 `entryIds` 为空(V14 会报"没有入口节点")或确实有入线没被记映射时才报,
     * 映射完整时**不产生任何噪音** —— 一条永远为真的警告等于没有警告。
     */
    if (missed.length > 0) {
      const entryInner = t.nodes.find((n) => n.id === entryId)
      const entryName = entryInner?.data.title || entryId
      unmappedIn.push({ subgraphId: sub.id, externals: missed, fallback: entryDefault })
      warnings.push(
        `子图「${sub.data.title || sub.id}」接入了 ${missed.length} 条外部输入,但模板只记了 ${t.inMap.filter((mm) => innerIds.has(mm.to)).length} 条映射(这 ${missed.length} 条落到兜底入口「${entryName}」,会在那里叠加)`,
      )
    }
  }

  /*
   * 到上限还剩子图节点:**不静默**。
   * 它会在 runner 里以"未注册的内置动作: (空)"失败 —— 那句话对用户毫无指向性,
   * 真实原因(嵌套层数)一个字都没提,这里补一条能指向原因的 warn。
   */
  const leftover = curNodes.filter((n) => (n.data.kind ?? 'feature') === 'subgraph')
  for (const n of leftover) {
    warnings.push(
      `子图「${n.data.title || n.id}」嵌套超过 ${MAX_SUBGRAPH_DEPTH} 层,未能完全展开 —— 它里面的节点这次不会执行`,
    )
  }

  return { nodes: curNodes, edges: curEdges, targets: curTargets, warnings, unmappedIn }
}

/**
 * 展开子图的副作用 → GraphIssue(level 全是 warn,**无 nodeId**)。
 *
 * ## 为什么没有 nodeId
 *
 * 报出来的这些事都发生在"节点已经被消掉"之后(空模板子图)或"节点根本没进图"
 * (嵌套超限),挂到任何具体节点上都是错的 —— 而挂错的 nodeId 会让 UI 去高亮
 * 一个不存在的节点,比不报更难排查。
 *
 * ## 为什么只在渲染端展示
 *
 * 主进程 runner 的 `validateGraph` 跑在**展开后**的 spec 上,那里已经没有
 * 子图节点了,这些信息在主进程侧天然不可见。它们是纯提示(不阻断运行),
 * RunBar 的检查列表就是它们该出现的地方。
 */
export function expansionIssues(expanded: ExpandResult): GraphIssue[] {
  return expanded.warnings.map((message) => ({ level: 'warn' as const, message }))
}

/**
 * **运行前该给用户看的全部检查结果**(纯函数)。
 *
 * ⚠️ 必须用**展开后**的图 —— 主进程 runner 校验的就是它(见 `WorkflowRunner.run`)。
 * 用未展开的图校验会让 RunBar 的 warn 列表与实际运行语义系统性不一致:
 * 子图内部的 project/test/doc 节点在未展开的图里**一个都不存在**,
 * 它们的配置问题一条都报不出来,用户看界面说"没问题"、运行后节点日志冒警告。
 *
 * ## 为什么要额外补子图节点自身的校验
 *
 * 展开后 `kind:'subgraph'` 的节点已经消失,V13(内容为空)/V14(有上游没入口)/
 * V15(有下游没出口)永远触发不了。所以再用**未展开的图**跑一遍校验,
 * 只取挂在子图节点上的那些条 —— preds/succs 必须是未展开的(子图节点的
 * 上游就是那些外部节点,展开后算不出来)。
 *
 * ## 为什么是共享的纯函数而不是 renderer 的 hook 里现算
 *
 * e2e 要能**逐字比对**"渲染端看到的"与"主进程看到的"。逻辑放在这里,
 * `useGraphIssues` 只是它的一层 store 绑定,e2e 直接调同一个函数 ——
 * 两边不可能漂。漂了就是 P0-3 那种"注释说绝不会不一致,实际不一致"。
 */
export function graphIssuesFor(args: {
  nodes: readonly { id: string; data: NodeSpecSource }[]
  edges: readonly { source: string; target: string }[]
  projectDir?: string
}): GraphIssue[] {
  const expanded = expandSubgraphs(args.nodes, args.edges)
  const issues: GraphIssue[] = validateGraph({
    nodes: expanded.nodes,
    edges: expanded.edges,
    projectDir: args.projectDir,
  })

  /*
   * 子图节点自身的 V13/V14/V15。用未展开的图跑,再按 nodeId 过滤 ——
   * 只要子图节点自己那几条,其余(外部节点的规则)上面已经用展开后的图算过了,
   * 这里是补缺不是重算。
   */
  const subIds = new Set(
    args.nodes.filter((n) => (n.data.kind ?? 'feature') === 'subgraph').map((n) => n.id),
  )
  if (subIds.size > 0) {
    for (const issue of validateGraph({
      nodes: args.nodes,
      edges: args.edges,
      projectDir: args.projectDir,
    })) {
      if (issue.nodeId && subIds.has(issue.nodeId)) issues.push(issue)
    }
  }

  /*
   * 展开副作用(空模板被消掉 / 外部入线落到兜底入口 / 嵌套超限)。
   *
   * 放在子图自身校验**之后**,并按文案去重:空模板那条 V13 与
   * expandSubgraphs 的 warning 说的是**同一件事**(措辞也逐字一致,改一处要改两处),
   * 两边都收下就会在检查列表里出现两遍。同一个问题报两次不会更严重,
   * 只会让人怀疑这个列表是不是坏了 —— 所以留先到的那条(带 nodeId 的那条,
   * 它还能让 UI 高亮到子图节点上)。
   */
  const seen = new Set(issues.map((i) => i.message))
  for (const issue of expansionIssues(expanded)) {
    if (seen.has(issue.message)) continue
    seen.add(issue.message)
    issues.push(issue)
  }

  return issues
}

/**
 * 画布快照 → 运行规格。
 *
 * 放 shared 是因为它是**纯数据转换**,没有主进程特有的东西 ——
 * 而且这样渲染进程发出去的东西和主进程收到的东西是同一份代码算的,
 * 不会出现"界面上显示的依赖关系"和"调度器理解的依赖关系"不一致。
 */
export function specFromGraph(args: {
  canvasId: string
  nodes: readonly { id: string; data: NodeSpecSource }[]
  edges: readonly { source: string; target: string }[]
  /** 空数组 = 跑全图 */
  targets?: string[]
  input?: string
  maxParallel: number
  inlineLimitBytes: number
  spillPolicy?: SpillPolicy
  runId?: string
  /** 画布级 projectDir(deprecated 兜底,仅无 project 节点时生效) */
  projectDir?: string
  /**
   * 「providerId → 用户在设置里选的默认模型」。渲染进程从 settings 抽出来传进来。
   *
   * ⚠️ 为什么是参数而不是在这里读设置:本文件是**零依赖纯函数**(项目铁律),
   * 让它去读 settings 就得引入 zod,直接把 zod 拖进渲染进程 bundle。
   *
   * 为什么必须有这个参数:节点上不选模型时,spec.model 曾经是空串,主进程只能
   * 退回内置清单第一项。用户改过 Base URL(中转站/代理/区域端点)时那个名字
   * 多半不被认 → 每次报"模型名不对",而他在设置里明明已经选好了。
   * 缺省 undefined = 没有默认模型,行为与改动前完全一致。
   */
  defaultModels?: Readonly<Record<string, string>>
}): WorkflowSpec {
  /*
   * ① 先展开子图:子图是 UI 层的复用机制,不是运行语义 —— 调度器眼里
   *    只有平铺节点。展开在**最前**做,后面的目录解析/规格映射拿到的
   *    已经是普通节点(内部节点的 project 触达关系也随之恢复)。
   */
  const expanded = expandSubgraphs(args.nodes, args.edges, args.targets)

  /*
   * ② 解析权威项目文件夹 —— **全图只解析这一次**。
   * resolveProjectDir 是唯一解析点:优先 project 节点,无则回落画布级。
   */
  const { dir: projectDir } = resolveProjectDir(expanded.nodes, args.projectDir)

  /*
   * 默认模型映射只在这里算一次(逐节点重复 trim 是白做功)。
   * 没传 defaultModels 时是空对象,下面的回落链与改动前逐字一致。
   *
   * ⚠️ 逐条过滤掉非字符串的值:这份数据是**从渲染端传进来的**(由 settings 抽出),
   * 而 settings.json 是用户能手改的文件。传进来一个数字/对象时,
   * 让它一路走到 effectiveModel 里的 `.trim()` 会抛 —— 而那会让**整张画布打不开**
   * (点运行直接炸),代价比"忽略一个坏值"大得多。宁可当它没配。
   */
  const rawDefaults = args.defaultModels
  const defaultModels: Record<string, string> = {}
  if (rawDefaults) {
    for (const [id, m] of Object.entries(rawDefaults)) {
      if (typeof m === 'string' && m.trim()) defaultModels[id] = m
    }
  }

  return {
    runId: args.runId ?? newRunId(),
    canvasId: args.canvasId,
    targets: expanded.targets,
    nodes: expanded.nodes.map((n) => {
      // 缺 kind(手改数据兜底)按旧语义 = feature/serial —— 与 migrateGraph 的默认一致
      const kind: NodeKind = n.data.kind ?? 'feature'
      // ★ 从注册表取执行器与动作(单一真相)。之后 spec 里带着它一路到主进程,运行期不再回查。
      const def = getNodeType(kind)
      const isSession = def.executor === 'session'

      /*
       * model 只在 API 型 agent 上有意义。CLI 型塞一个 model 会让下游以为
       * "模型可换",而 CLI 根本不看这个字段 —— 那种沉默的无效配置比不配置更糟。
       *
       * 优先级是**节点显式选的 > 设置里的默认**,由 effectiveModel 单一真相源决定。
       * 顺序不能反:节点上填的模型名是用户对这一条支路的明确选择(可能这条支路
       * 要用便宜模型、那条要用推理模型),全局默认不该覆盖它。
       *
       * 只给**非空**结果:三层(节点/设置/内置)都没给时保持 undefined,
       * 由主进程 buildApiCtx 报"还没有选模型"这句人话 —— 在这里塞个空串会让
       * 那个校验失去意义(空串与 undefined 在 effectiveModel 里同义,但校验看的是有没有)。
       */
      const apiProviderId = providerIdOfAgent(n.data.agentId)
      const model =
        isSession && apiProviderId
          ? effectiveModel(n.data.agentId, n.data.model, defaultModels[apiProviderId]) || undefined
          : undefined

      return {
        id: n.id,
        title: n.data.title || n.id,
        kind,
        executor: def.executor,
        action: def.action,
        mode: kind === 'feature' ? (n.data.mode ?? 'serial') : undefined,
        /*
         * cwd 解析:
         *   - project 节点:它自己的 projectDir 就是项目文件夹(空则回落解析值)
         *   - 其余节点:节点 cwd 覆盖 → 否则解析出的项目文件夹 → 否则空串
         * 一律经 effectiveCwd + 同一个 projectDir,保证界面/调度器/agent 三方一致。
         */
        cwd:
          kind === 'project'
            ? (n.data.projectDir?.trim() || projectDir)
            : effectiveCwd(projectDir, n.data.cwd),
        /*
         * projectDir 只给 project 节点,内容是**用户显式配的值**(不回落)。
         * 校验规则问的是"配没配",不是"最后会用哪个目录" ——
         * 混进解析值会把"没配但有画布级兜底"误报成"配好了",正好是修的反面。
         */
        projectDir: kind === 'project' ? (n.data.projectDir ?? '') : undefined,
        // 非会话节点(output / image)不给 agentId —— 它们不走会话,给了反而会误导 runner 去找 agent
        // 会话节点:节点显式 agentId > 配置了默认模型的 provider(api:xxx) > 'claude' CLI
        agentId: isSession ? (n.data.agentId ?? pickDefaultAgentId(args.defaultModels)) : undefined,
        /*
         * 优先级与上面的 `model` 局部变量同源(那里已算好,这里只是把它放进 spec)。
         * CLI 型拿到的是 undefined —— 见上面那段注释。
         */
        model,
        promptTemplate: n.data.promptTemplate ?? '',
        permissionMode: isSession ? n.data.permissionMode : undefined,
        failurePolicy: n.data.failurePolicy ?? 'skip',
        // 夹到 0..5:界面上是数字输入框,但 store 里的值来自磁盘,
        // 手改过 graph.json 的话可能是任意数 —— 这里兜一层
        retry: Math.max(0, Math.min(5, Math.trunc(n.data.retry ?? 0))),
        // brief 只对 project 有意义,别的 kind 带着也是噪音
        brief: kind === 'project' ? n.data.brief : undefined,
        // 按 action 拍入各内置动作专属字段(action 是数据,不是 if/else)
        buildTarget: def.action === 'package' ? (n.data.buildTarget ?? 'exe') : undefined,
        buildOptions: def.action === 'package' ? n.data.buildOptions : undefined,
        imageParams: def.action === 'image' || def.action === 'sampler' ? n.data.imageParams : undefined,
        imageProvider: def.action === 'image' || def.action === 'sampler' ? n.data.imageProvider : undefined,
        handoffNote: def.action === 'handoff' ? n.data.handoffNote : undefined,
        promptText: def.action === 'noop' ? n.data.promptText : undefined,
        negativeText: def.action === 'noop' ? n.data.negativeText : undefined,
        gameEngine: kind === 'game' ? (n.data.gameEngine ?? 'godot') : undefined,
        videoParams: def.action === 'video' ? n.data.videoParams : undefined,
        testCommand: def.action === 'test' ? n.data.testCommand : undefined,
        testTimeoutSec: def.action === 'test' ? n.data.testTimeoutSec : undefined,
        // v0.6.1 工程化 agent 编排:会话节点上的编排字段(agent 循环 / router 分支)
        agentRole: isSession && kind === 'agent' ? (n.data.agentRole ?? '') : undefined,
        maxRounds: isSession && kind === 'agent' ? (n.data.maxRounds ?? 3) : undefined,
        doneHint: isSession && kind === 'agent' ? (n.data.doneHint ?? '任务完成') : undefined,
        routes: isSession && kind === 'router' ? (Array.isArray(n.data.routes) ? n.data.routes.map(String) : []) : undefined,
      }
    }),
    edges: expanded.edges.map((e) => ({ source: e.source, target: e.target })),
    input: args.input ?? '',
    maxParallel: args.maxParallel,
    inlineLimitBytes: args.inlineLimitBytes,
    spillPolicy: args.spillPolicy ?? 'file',
    projectDir: args.projectDir ?? '',
  }
}

/**
 * 会话节点没配 agentId 时的默认选择。
 *
 * ⚠️ 之前是**硬编码 `'claude'`**(本机 CLI),这会让只用 API 的用户拖出
 * 「项目」等节点时悄悄掉进 CLI 路径 —— 本机没装 CLI 就报"找不到可执行文件",
 * 装了 CLI 则用的是 CLI 自己的 Key/模型(与用户在设置里配的 API 毫无关系)。
 *
 * 正确语义:配了默认模型的 provider 就是用户当前的主力 API(探测一键选用后
 * `defaultModels[providerId]=model` 一定非空),所以默认 agentId = `api:<该provider>`。
 * 完全没配 API(默认模型为空/未传)→ 维持老行为 'claude',兼容老调用方。
 */
export function pickDefaultAgentId(defaultModels: Record<string, string> | undefined): string {
  if (defaultModels) {
    for (const id of Object.keys(defaultModels)) {
      const m = defaultModels[id]
      if (typeof m === 'string' && m.trim()) return `api:${id}`
    }
  }
  return 'claude'
}

/** `specFromGraph` 需要的最小节点形状(与 CanvasNode['data'] 对齐但不强绑) */
export interface NodeSpecSource {
  title?: string
  kind?: NodeKind
  mode?: FeatureMode
  agentId?: string
  /** API 型 agent 的模型(v0.4.0) */
  model?: string
  cwd?: string
  promptTemplate?: string
  permissionMode?: PermissionMode
  failurePolicy?: FailurePolicy
  retry?: number
  projectDir?: string
  brief?: string
  buildTarget?: BuildTarget
  buildOptions?: BuildOptions
  imageParams?: ImageParams
  imageProvider?: ImageProviderConfig
  /** game 专属:游戏引擎 */
  gameEngine?: 'godot'
  /** video 专属(内置动作) */
  videoParams?: VideoParams
  /** handoff 专属(内置动作):交接说明(这批素材给下游做什么用) */
  handoffNote?: string
  /** test 专属(内置动作) */
  testCommand?: string
  testTimeoutSec?: number
  /** prompt / prompt_negative 专属(v0.5.0 生图工作区):提示词文本 */
  promptText?: string
  negativeText?: string
  /** subgraph 专属:被封起来的那段图(specFromGraph 会展开成平铺节点) */
  subgraph?: SubgraphTemplate
  /** agent 专属(v0.6.1):角色设定 / 最大轮次 / 完成标志 */
  agentRole?: string
  maxRounds?: number
  doneHint?: string
  /** router 专属(v0.6.1):分支标签(顺序 = 出边顺序) */
  routes?: string[]
}

export interface GraphIssue {
  level: 'error' | 'warn' | 'info'
  /** 问题挂在哪个节点上。图级问题(如"没有项目节点")没有 */
  nodeId?: string
  message: string
}

/**
 * 运行前图校验。**只报不猜**:绝大多数是 warn(不阻断合法旧画布,M6 决策),
 * 只有"结构性死局"才配 error —— 本增量 error 级留空(环检测走 buildIndex
 * 抛 CycleError 的既有路径,带环路径给 UI 高亮,职责不重叠)。
 *
 * ## 改造要点(去散点):不再有 kind 分支
 *
 * V1..V8 从"写死一堆 if kind===…"改成**注册表驱动**:
 *   ① 图级规则:每个**已注册类型**各跑一次 `def.validateGraph`(即使该类型节点数为 0
 *      —— V1"没有项目节点"这条就靠这个);
 *   ② 节点级规则:每个节点跑它自己类型的 `def.validate`;
 *   ③ 框架通用规则:端口方向**由 ports 推导**(V7),不再手写两条 if。
 * 语义与升级前逐条等价(e2e 第 18/21 节逐字钉住)。
 */
export function validateGraph(args: {
  nodes: readonly { id: string; data: NodeSpecSource }[]
  edges: readonly { source: string; target: string }[]
  /** 画布级 projectDir(deprecated 兜底)。V1/V5 的提示语要区分有无兜底 */
  projectDir?: string
}): GraphIssue[] {
  const issues: GraphIssue[] = []
  const { nodes, edges } = args
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const resolvedProjectDir = resolveProjectDir(nodes, args.projectDir).dir

  // 前驱/后继表。有环也能建(环检测不在这里),BFS 靠 visited 集合天然会停
  const preds = new Map<string, string[]>()
  const succs = new Map<string, string[]>()
  for (const n of nodes) {
    preds.set(n.id, [])
    succs.set(n.id, [])
  }
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target) || e.source === e.target) continue
    preds.get(e.target)?.push(e.source)
    succs.get(e.source)?.push(e.target)
  }

  const kindOf = (id: string): NodeKind => byId.get(id)?.data.kind ?? 'feature'

  /** 沿入边向上游 BFS:是否触达某个 project 节点(不含自身)。V5 用它 */
  const hasProjectAncestor = (id: string): boolean => {
    const seen = new Set<string>()
    const stack = [id]
    while (stack.length > 0) {
      const cur = stack.pop() as string
      if (seen.has(cur)) continue
      seen.add(cur)
      if (cur !== id && kindOf(cur) === 'project') return true
      for (const p of preds.get(cur) ?? []) stack.push(p)
    }
    return false
  }

  // ① 图级规则:每个已注册类型各跑一次(不依赖该类型节点是否存在)
  const graphCtx: GraphValidateCtx = { nodes, edges, resolvedProjectDir }
  // Object.values 的字面量联合类型不含可选方法,收窄回 NodeTypeDef[](否则 validateGraph 读不到)
  for (const def of Object.values(NODE_TYPES) as NodeTypeDef[]) {
    issues.push(...(def.validateGraph?.(graphCtx) ?? []))
  }

  // ② 节点级规则:每个节点交给它自己类型的 validate
  const countKind = (kind: string): number =>
    nodes.filter((n) => (n.data.kind ?? 'feature') === kind).length
  for (const n of nodes) {
    const def = getNodeType(n.data.kind ?? 'feature')
    if (!def.validate) continue
    const ctx: TypeValidateCtx = {
      id: n.id,
      data: n.data,
      preds: preds.get(n.id) ?? [],
      succs: succs.get(n.id) ?? [],
      hasProjectAncestor,
      countKind,
      resolvedProjectDir,
      // 让"要依据上游性质下判断"的规则能查到对方(如整合节点看汇入的是串行还是并行)
      dataOf: (id) => byId.get(id)?.data,
    }
    issues.push(...def.validate(ctx))
  }

  // ③ 框架通用规则:端口方向非法(交互层 onConnect 优先拦截,这里是运行前兜底)。
  //    **由 ports 推导** —— 任何 source:0 / target:0 的类型自动生效(V7 通用化)。
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue
    const srcDef = getNodeType(kindOf(e.source))
    const tgtDef = getNodeType(kindOf(e.target))
    if (tgtDef.ports.target === 0) {
      issues.push({
        level: 'warn',
        nodeId: e.target,
        message: `${tgtDef.label}节点「${byId.get(e.target)?.data.title || e.target}」是画布源头,不该有入边(来自「${byId.get(e.source)?.data.title || e.source}」的连线会被忽略)`,
      })
    }
    if (srcDef.ports.source === 0) {
      issues.push({
        level: 'warn',
        nodeId: e.source,
        message: `${srcDef.label}节点「${byId.get(e.source)?.data.title || e.source}」是终点,不该有出边(连向「${byId.get(e.target)?.data.title || e.target}」的连线会被忽略)`,
      })
    }
    // 携带物语义可疑(类型化端口):交互层 onConnect 已提示过一次,这里是运行前兜底
    const semantic = connectionWarning(
      kindOf(e.source),
      kindOf(e.target),
      byId.get(e.source)?.data.title || e.source,
      byId.get(e.target)?.data.title || e.target,
    )
    if (semantic) {
      issues.push({ level: 'warn', nodeId: e.target, message: semantic })
    }
  }

  return issues
}

/** 主进程 → 渲染进程的运行态推送 */
export interface WorkflowEvent {
  runId: string
  /** 全量快照。运行态很小(每个节点几十字节),增量同步不值得引入一致性风险 */
  state: RunState
  /** 本次变化涉及的节点,方便 UI 做高亮动画 */
  changed?: string[]
}

/**
 * 从一段会话日志里提取"这个节点的产出"。
 *
 * 优先级:**最后一条 result 的 text** → 所有 text 事件按序拼接 → 空串。
 *
 * 先看 result 是因为它才是这一轮的最终答复;text 事件里混着中间的旁白,
 * 拿它当产出会让下游收到一堆过程废话 —— 而下游往往要拿这个当输入用。
 */
export function extractOutput(
  recs: PersistedRecord[],
  maxChars = 4_000_000,
): { text: string; truncated: boolean } {
  let result: string | null = null
  const chunks: string[] = []

  for (const rec of recs) {
    if (rec.t !== 'event') continue
    const ev = rec.ev
    if (ev.k === 'result') {
      /*
       * 后来的 result 覆盖先前的:一个节点可能被重试过多次。
       *
       * ⚠️ **空白 result 视为没有**:有些 agent(Codex 那类)的 result 事件
       * 只带元数据、text 是空串或纯空白,而正文全在 text 事件里。
       * 直接信它的话,`result ?? chunks` 会选到那个空串,**把整段正文吞掉** ——
       * 上游节点辛苦写的东西传给下游时变成空,而且不报任何错。
       */
      const t = ev.text
      if (t != null && t.trim() !== '') result = t
    } else if (ev.k === 'text') {
      chunks.push(ev.text)
    }
  }

  let text = result ?? chunks.join('')
  if (text.length <= maxChars) return { text, truncated: false }
  text = text.slice(0, maxChars)
  return { text, truncated: true }
}

export interface RenderedTemplate {
  text: string
  /** 模板里出现但没值的变量名。调用方应当发一条 notice,而不是抛异常 */
  unknown: string[]
}

/**
 * 极简模板渲染。只用 `{{name}}`,不引任何模板引擎。
 *
 * **未知变量原样保留** —— 渲染不出来就留 `{{prev}}` 在 prompt 里给用户看,
 * 比替换成空串好得多:空串会静默改变语义,而原样保留一眼就能看出哪里没接上。
 */
export function renderTemplate(tpl: string, vars: Record<string, string>): RenderedTemplate {
  const unknown: string[] = []
  const text = tpl.replace(/\{\{([^{}]+)\}\}/g, (whole, rawName: string) => {
    const name = rawName.trim()
    if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name]
    if (!unknown.includes(name)) unknown.push(name)
    return whole
  })
  return { text, unknown }
}

/** 模板里引用到的节点 id(`{{node:<id>}}` / `{{title:<id>}}`)。UI 用来画"依赖了谁" */
export function referencedNodeIds(tpl: string): string[] {
  const ids: string[] = []
  for (const m of tpl.matchAll(/\{\{\s*(?:node|title):([A-Za-z0-9_-]+)\s*\}\}/g)) {
    if (!ids.includes(m[1])) ids.push(m[1])
  }
  return ids
}
