import type {
  BuildOptions,
  BuildTarget,
  ChartParams,
  ImageParams,
  ImageProviderConfig,
  PythonParams,
  VideoParams,
} from '../../shared/canvas'

/**
 * 内置动作的主进程内部契约 —— 给 runner(调度器)与各执行器(packager / imagegen)共用。
 *
 * 放在 workflow/ 下而不是执行器目录下,是因为 RunnerEnv(调度器的依赖接口)
 * 要引用它;而 runner 不允许 import 执行器的实现层(那会拖进 child_process,
 * e2e 的假 env 就没法替换它了)。执行器反过来引这里的类型,依赖方向是对的。
 *
 * 内置动作节点(output / image / 未来的 video…)不走 agent 会话:
 * 没有 sessionId、没有 waitFor。它们由主进程直接执行,这就是请求/结果的形状。
 */

/** 内置动作的执行请求。`action` 是**数据**不是 if/else —— 加动作不再改类型 */
export interface BuiltinActionRequest {
  canvasId: string
  nodeId: string
  /** ⚠️ v0.3.0 起由字面量 'package' 放宽为 string —— 加动作不用回来改类型 */
  action: string
  /**
   * 项目文件夹。**已由 specFromGraph 解析到项目节点锚定的目录**(可能为空串
   * = 用户还没指定;执行器会用人话报错,而不是猜一个目录去干活)。
   */
  projectDir: string

  // ---- package 专属(可选)----
  buildTarget?: BuildTarget
  buildOptions?: BuildOptions

  // ---- image 专属(可选)----
  /** 节点标题(产物目录 slug 用) */
  nodeTitle?: string
  /** **阶段一已展开**的画面描述(纯文本,不含 {{prev}} 之类图上下文变量) */
  prompt?: string
  imageParams?: ImageParams
  imageProvider?: ImageProviderConfig

  // ---- test 专属(可选)----
  /**
   * 要跑的测试命令行(**整条**,允许 && / 管道 / 引号 → 执行器用 shell)。
   * 空串 = 没配 → 执行器直接回人话失败,不去猜一条命令跑。
   */
  testCommand?: string
  /** 测试超时(秒)。缺省由执行器兜 300 */
  testTimeoutSec?: number

  // ---- video 专属(可选)----
  /** 视频理解参数:来源 / 视觉模型 / 抽帧 */
  videoParams?: VideoParams

  // ---- handoff 专属(可选)----
  /** 交接说明:这批素材给下游做什么用(游戏素材 / UI 图 / 封面…) */
  handoffNote?: string

  // ---- prompt / prompt_negative 专属(v0.5.0 生图工作区;noop 动作)----
  /** 正向提示词文本(noop 动作把它作为节点产出交下去) */
  promptText?: string
  /** 负向提示词文本(noop 动作把它作为节点产出交下去) */
  negativeText?: string

  // ---- chart 专属(v0.6.2 可视化图形制作)----
  /** 图表参数:类型 / 标题 / 画布尺寸。数据本体走 `prompt`(已展开占位符) */
  chartParams?: ChartParams

  // ---- python 专属(v0.6.4 多语言节点)----
  /** Python 执行参数:脚本本体 / 脚本文件 / 命令行参数 / python 路径 */
  pythonParams?: PythonParams

  /** 进度/日志要能冒泡到 RunBar / 节点日志(packager 与 imagegen 都走它) */
  onProgress?(line: string): void
}

export interface BuiltinActionResult {
  ok: boolean
  /** package 产出的可交付文件路径(exe)。失败时没有 */
  artifactPath?: string
  /** image 产出的图片路径(**相对 projectDir**)。失败时没有。下游注入用它 */
  artifacts?: string[]
  /** video 产出的理解文本(直接交给下游 {{prev}} / {{node:<id>}}) */
  handoffText?: string
  /** 完整日志(会截尾摘要进节点产出) */
  log: string
  /** 失败原因(人话) */
  error?: string
  /**
   * 非零退出的**退出码**(test 用)。
   *
   * 为什么单独给一个字段而不是只靠 `ok`:测试"跑起来但没过"和"根本没跑起来"
   * (命令不存在 / 目录不对)是两件事,给用户的文案完全不同 —— 前者要贴失败用例,
   * 后者要提示检查命令。只凭 ok:false 区分不出来。
   */
  exitCode?: number | null
}
