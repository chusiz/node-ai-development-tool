import type { NodeEvent, PermissionMode, SessionStatus } from './events'
import type { NodeMetaSnapshot, PersistedRecord } from './log'
import type { Settings } from './settings'
import type { CanvasGraph } from './canvas'
import type { RunState, WorkflowEvent, WorkflowSpec } from './workflow'
import type { ModelDef, ProviderDef } from './providers'
import type { ProviderTestResult, SecretStatus } from './secrets'
import type { FailureKind, FailureVerdict, SessionOutcome } from './failure'
import type { ProbeReport, ProbeResult, ProbeVerdict } from './probe'

export type { PersistedRecord, LogRecord, NodeMetaSnapshot } from './log'
export type { ModelDef, ProviderDef, ProviderProtocol, ProviderGroup } from './providers'
/** 文件选择/保存对话框的过滤器,与 Electron 的 OpenDialogOptions.filters 同形 */
export type FileFilter = { name: string; extensions: string[] }
/* 可搜索模型框的候选类型。纯类型,渲染进程按值引的是 shared/providers 那侧 */
export type { ModelCandidate, ModelSource } from './providers'
export type { SecretStatus, ProviderTestResult } from './secrets'
/*
 * 模型探测的类型。只 re-export **类型** ——
 * 判定与组装的**值**在 shared/probe.ts,那一层零依赖(不 import zod),
 * 渲染进程按值引它不会把 zod 拖进 bundle,见那个文件的顶部说明。
 */
export type { ProbeReport, ProbeResult, ProbeVerdict }
/*
 * 失败归类。只 re-export **类型** ——
 * 渲染进程不需要 classifyFailure 的值(判定在主进程做,结果随 RunState 过来),
 * 按值引用会把这段正则表拖进 renderer bundle,纯属白给。
 */
export type { FailureKind, FailureVerdict, SessionOutcome }
export type {
  RunState,
  RunNodeState,
  RunNodeStatus,
  RunStatus,
  WorkflowEvent,
  WorkflowSpec,
  WorkflowNodeSpec,
  WorkflowEdgeSpec,
  FailurePolicy,
  SpillPolicy,
} from './workflow'

export type { NodeEvent, SessionStatus, PermissionMode }
export type {
  Settings,
  MemorySettings,
  LimitSettings,
  WorkflowSettings,
  AgentSettings,
} from './settings'
export type {
  CanvasGraph,
  CanvasNode,
  CanvasEdge,
  NodeConfig,
  Viewport,
  // nodes-v2 契约增补。只 re-export 类型,无新通道 —— 输出节点走 RunnerEnv,
  // 不开新的 IPC(打包进度经既有 nodeLog 通道冒泡)
  NodeKind,
  FeatureMode,
  BuildTarget,
  BuildOptions,
  // image-node(v0.3.0)契约增补 —— 图像节点的生成参数与出图方式
  ImageParams,
  ImageProviderConfig,
} from './canvas'

/**
 * 通道名单一真相源 —— main 和 preload 都从这里 import,
 * 杜绝两边字符串写错导致的"调了没反应"。
 */

/** 渲染进程 → 主进程,请求/响应式(invoke) */
export const CH = {
  appInfo: 'app:info',
  appPaths: 'app:paths',
  agentList: 'agent:list',
  agentDetect: 'agent:detect',
  /**
   * 模型服务商(v0.4.0)。
   *
   * 密钥管理单独开通道而不是塞进 settings:Key **不落 settings.json**,
   * 走独立的加密存储(见 shared/secrets.ts 顶部)。既然存储位置不同、
   * 读写时机也不同(设置页保存 vs 填完即存),合成一条通道只会让两边打架。
   */
  providerList: 'provider:list',
  providerModels: 'provider:models',
  providerTest: 'provider:test',
  /**
   * 批量模型探测(v0.4.0)——「挨个验证,通的留下、不通的去掉」。
   *
   * 单独开通道而不是复用 `providerTest`:那个是**探一个**(设置页的「测试连接」),
   * 这个是**探一批**,请求数、并发、限流中止与三档判定全都不一样。
   * 合成一条会让调用点各写一半的分支,最后谁也说不清当前跑的是哪种。
   */
  providerProbe: 'provider:probe',
  secretSet: 'secret:set',
  secretClear: 'secret:clear',
  /** 密钥库自身的信息:存哪、是否加密。用来在界面上如实告知"你的 Key 是怎么存的" */
  secretInfo: 'secret:info',
  sessionStart: 'session:start',
  sessionCancel: 'session:cancel',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsRelaunch: 'settings:relaunch',
  systemMetrics: 'system:metrics',
  canvasLoad: 'canvas:load',
  canvasSave: 'canvas:save',
  dialogPickDirectory: 'dialog:pickDirectory',
  dialogPickFile: 'dialog:pickFile',
  dialogSaveFile: 'dialog:saveFile',
  fsWriteText: 'fs:writeText',
  fsReadText: 'fs:readText',
  shellOpenPath: 'shell:openPath',
  /**
   * 缩略图只读通道(v0.3.0 新增,S2)。渲染端不直接碰 fs ——
   * 传「项目文件夹 + 相对路径」,主进程白名单校验后回小尺寸 dataUrl。
   */
  imageReadThumb: 'image:readThumb',
  nodeLogTail: 'node:logTail',
  nodeBlob: 'node:blob',
  nodeReset: 'node:reset',
  skillList: 'skill:list',
  skillSetEnabled: 'skill:setEnabled',
  skillDelete: 'skill:delete',
  skillImportLocal: 'skill:importLocal',
  skillOpenDir: 'skill:openDir',
  workflowRun: 'workflow:run',
  workflowCancel: 'workflow:cancel',
  workflowCancelNode: 'workflow:cancelNode',
  workflowGet: 'workflow:get',
  /*
   * 无边框窗口控制(v0.4.0)。主进程按 `event.sender` 反查窗口,
   * 多开窗口时各自控制自己,不会误关别人的。
   */
  winMinimize: 'win:minimize',
  winToggleMaximize: 'win:toggleMaximize',
  winClose: 'win:close',
  winIsMaximized: 'win:isMaximized',
  /** 本地生图服务(SD WebUI)一键启停(v0.4.2):检测 / 后台启动 / 停止 */
  localSdStatus: 'localSd:status',
  localSdStart: 'localSd:start',
  localSdStop: 'localSd:stop',
} as const

/** 本地生图服务状态(v0.4.2)。供渲染端「本地服务」状态卡显示 */
export interface LocalSdStatus {
  /** SD API 是否在响应 */
  running: boolean
  /** 服务端口(默认 7860) */
  port: number
  /** API 返回的可用模型标题 */
  models: string[]
  /** 找到的 SD WebUI 安装目录(找不到为 null) */
  dir: string | null
  /** 由 chusiz 后台拉起的进程 pid(外部手动开的为 null) */
  pid: number | null
  /** 可用的本地 python 推理环境(直出模式用;提取的运行时优先,整合包 python 次之) */
  pythonPath: string | null
  /** 可用的 checkpoint 模型文件(直出模式用) */
  checkpoint: string | null
}

/** 主进程 → 渲染进程,单向推送 */
export const EV = {
  /**
   * 日志批次 —— 取代原来的 session:events。
   *
   * 载荷里带 seq,而且内容是**外溢处理后**的记录(大 tool_result 已被换成
   * 截断版 + blob 引用)。广播原始事件的话,一个 10MB 的 tool_result
   * 会原样冲进 IPC 和渲染进程内存。
   */
  nodeLog: 'node:log',
  /** 高频进度心跳。与日志分开,免得几十条/轮的 progress 把日志流冲垮 */
  nodeProgress: 'node:progress',
  sessionStatus: 'session:status',
  sessionExit: 'session:exit',
  /**
   * 工作流运行态。载荷带 runId —— 一个渲染进程可能同时开着多个画布、
   * 发过多次运行,收到事件先按 runId 过滤再进 store。
   */
  workflowRun: 'workflow:run',
  /**
   * 批量模型探测的进度(v0.4.0)。
   *
   * 单独开一条而不是让 probe 调用中途回传:批量探测要发 N 个请求、按并发 3
   * 分批跑,十几秒是常态。期间界面必须说清"到第几个了" —— 否则用户面对一个
   * 卡住十几秒的按钮,只能怀疑它死机了,于是去连点,连点又会再触发一轮限流。
   *
   * 载荷带 `providerId`:设置页可能有多张服务商卡片同时可见(分组可展开),
   * 收到进度先按 id 过滤再进各自的 state。
   */
  providerProbe: 'provider:probeProgress',
  /** 无边框窗口的最大化/还原状态变化。自绘按钮据此切换图标(□ / ❐) */
  winMaximizeChanged: 'win:maximizeChanged',
} as const

/** 批量探测进度载荷 */
export interface ProbeProgressPayload {
  providerId: string
  /** 已完成的探测数(失败/跳过的**也算完成** —— 它们确实发过了) */
  done: number
  /** 本轮候选总数 */
  total: number
  /** 已因限流中止。为 true 时 done < total,剩下的是"没测"而非"测了不行" */
  aborted: boolean
}

export type ChannelName = (typeof CH)[keyof typeof CH]
export type EventName = (typeof EV)[keyof typeof EV]

/**
 * 统一信封:渲染侧永远能拿到结构化的成败,而不是裸异常。
 *
 * `detail` 只在少数地方用得上 —— 典型是工作流的环检测:
 * 失败时除了错误文本,还需要把**环上的节点**带给 UI 去高亮。
 * 没有它就只能去解析错误字符串里那几个 id,那是把展示格式当契约用。
 */
export type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; detail?: unknown }

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  v8: string
  platform: string
  arch: string
}

export interface AgentCapabilities {
  headless: boolean
  streamJson: boolean
  resume: boolean
  specifySessionId: boolean
  tools: boolean
  fork: boolean
}

/**
 * 节点上「Agent」下拉框的一项。
 *
 * v0.4.0 起这个列表混装了两种完全不同的东西:
 *   - `kind: 'cli'` —— 本机装好的命令行工具,应用把它拉起来当子进程;
 *   - `kind: 'api'` —— 用户填自己的 Key 直连的云端服务商。
 *
 * 混在一个列表里是**有意为之**:对用户来说这两者在节点上的角色完全一样
 * (就是"这个节点拿什么跑"),分成两个下拉框只会让他先想"我该用哪个框"。
 * 区别用 `groupLabel` 做成分组标题就够了。
 */
export interface AgentListEntry {
  /** `claude` / `codebuddy` / … 或 `api:<providerId>` */
  id: string
  displayName: string
  capabilities: AgentCapabilities
  kind: 'cli' | 'api'
  /** API 型:服务商 id */
  providerId?: string
  /** API 型:可选模型。CLI 型为 undefined(它的模型不归我们管) */
  models?: ModelDef[]
  /** API 型:Key 是否已配置。UI 在未配置的项上挂提示,但不阻止选择 */
  keyReady?: boolean
  /** CLI 型:本机是否探测到可执行文件。没装也允许选 —— 用户可以之后再装 */
  installed?: boolean
  /**
   * CLI 型:是否在本机实测过。
   *
   * `claude` 是 true;其余(CodeBuddy / Codex / Gemini / Qwen / Cursor / Aider)
   * 都是**按官方文档接入但未逐版本实测**。之所以要把这件事告诉用户:
   * 未实测的工具一旦报错,"是应用接错了还是 CLI 改版了"这个疑问只能由用户去猜,
   * 而如实标注能让他先去看版本/文档,而不是反复怀疑自己的配置。
   */
  verified?: boolean
  /** 分组标题。UI 直接拿它开 <optgroup>,不必自己判断分组逻辑 */
  groupLabel: string
}

/**
 * 探测结果。
 *
 * ⚠️ v0.4.0 起 `found: true` 分成两种形态:CLI 有 exe,API 有服务商信息。
 * 加 `kind` 判别字段而不是把两者的字段混在一个对象里 —— 混着写的话,
 * UI 就得靠"exe 是不是空"去猜这是哪一种,那是在用值的巧合当类型。
 */
export type DetectResult =
  | {
      found: true
      kind: 'cli'
      exe: string
      version: string | null
      source: string
      tried: string[]
    }
  | {
      found: true
      kind: 'api'
      providerId: string
      baseUrl: string
      /** 当前会用的模型 */
      model: string
      /** Key 是否就绪。false 时 UI 提示"先去设置里填 Key" */
      keyReady: boolean
      test?: ProviderTestResult
    }
  | { found: false; kind: 'cli' | 'api'; message: string; tried: string[] }

/* ============================================================
   技能库
   ============================================================ */

/**
 * 这个技能是怎么进来的。
 *
 * `manual` 单独一个 kind 而不是 `local` 的空路径:用户自己把文件夹拷进
 * `data\skills\skills\` 是最常见的用法,界面应该说"你自己放的",
 * 而不是显示一个空白的来源栏。
 */
export type SkillOrigin =
  | { kind: 'local'; path: string; at: number }
  | { kind: 'github'; url: string; at: number }
  | { kind: 'ai'; nodeId: string; at: number }
  | { kind: 'manual' }

export interface SkillEntry {
  /** 目录名 —— 也是操作(启用/删除)时用的键 */
  name: string
  /** SKILL.md frontmatter 里写的 name。和 name 不同 = 作者把目录名写错了 */
  declaredName: string | null
  description: string
  /** description 来自正文首段(作者没写 frontmatter description) */
  descriptionFromBody: boolean
  enabled: boolean
  /**
   * 调用名。⚠️ plugin 提供的技能带命名空间:`haowan-skills:pdf`。
   * 停用的技能是空串 —— 模型看不见它,给个调用名会让人以为能用。
   */
  invokeAs: string
  fileCount: number
  bytes: number
  origin: SkillOrigin | null
  /** 名字不合规范时的说明;null = 没问题 */
  nameProblem: string | null
  /** 技能目录绝对路径 */
  dir: string
}

export interface StartRequest {
  nodeId: string
  /**
   * 这个节点属于哪个画布。
   *
   * 必须有:主进程要按画布把会话日志写进 data/canvases/<canvasId>/nodes/<nodeId>/。
   * 渲染进程知道自己当前开着哪个画布,主进程不维护这张表。
   */
  canvasId: string
  agentId?: string
  /**
   * API 型 agent(`agentId = 'api:<providerId>'`)用哪个模型。
   * CLI 型忽略它 —— 那种工具的模型由它自己的参数/配置决定。
   */
  model?: string
  cwd: string
  /** 首次运行不传,由主进程生成;后续传上一轮的 sessionId 以接续 */
  sessionId?: string
  prompt: string
  permissionMode?: PermissionMode
  dangerouslySkipPermissions?: boolean
  timeoutMs?: number
  maxBudgetUsd?: number
}

export interface StartResult {
  nodeId: string
  sessionId: string
  isFirstTurn: boolean
  /**
   * CLI 型是被拉起的可执行文件路径;API 型是实际请求的接口地址。
   *
   * 两者共用这个字段而不是拆开:它的唯一用途是**回显给人看**
   * ("它到底拿什么跑的"),两种形态各占一半语义,拆开只会让调用点多一个分支。
   */
  exe: string
  args: string[]
  /** API 型实际用的模型名,便于界面上确认。CLI 型为 undefined */
  model?: string
}

/**
 * 设置页里一张服务商卡片要的全部信息。
 *
 * 把 `def`(静态注册表)、`secret`(有没有 Key)、`config`(用户覆盖)三份数据
 * 在这里拼好再回渲染进程 —— 让 UI 少发三次请求、也少写三处拼装逻辑。
 */
export interface ProviderView {
  def: ProviderDef
  secret: SecretStatus
  /** 用户覆盖的接口地址。空 = 用 def.baseUrl */
  baseUrlOverride: string
  /** 该服务商的默认模型。空 = 用 def.models[0] */
  defaultModel: string
  /**
   * 探测验证过可用的模型 id(v0.4.0)。
   *
   * 存在设置里(与 `defaultModel` 同级)而不是另一个缓存机制:「这个模型我验过
   * 能用」本来就是一条配置,跟着 settings 走才能换电脑、分享画布。
   *
   * ⚠️ **只存通过的**(`ok`)。跳过/不可用的都不存 —— 存下来会让用户以为
   * "已经验过,不可用",而跳过那一档的语义恰恰是"没测出来"(见 shared/probe.ts)。
   */
  verifiedModels: string[]
  /**
   * 最近手填过的模型名/接入点 id(v0.4.1)。
   *
   * 设置页候选区渲染成可一键点选的 chips —— 用户手填过火山接入点后,
   * 下次不必重新打一遍(接入点拉不到,手填是唯一入口)。
   */
  recentModels: string[]
}

/** 密钥库的元信息。`encrypted: false` 时 UI 必须显示明文风险提示 */
export interface SecretStoreInfo {
  file: string
  encrypted: boolean
  /** 已存了几家的 Key */
  count: number
}

/** 一批日志记录。seq 由主进程赋值,渲染进程是纯镜像,不做乐观插入 */
export interface NodeLogPayload {
  nodeId: string
  canvasId: string
  recs: PersistedRecord[]
}

export interface NodeProgressPayload {
  nodeId: string
  ev: NodeEvent & { k: 'progress' }
}

export interface NodeLogTail {
  recs: PersistedRecord[]
  torn: boolean
  /** 磁盘上这个节点的总记录数(可能远大于 recs.length) */
  total: number
  /** 读不到 meta(从没跑过 / 被清空过)时为 null */
  meta: NodeMetaSnapshot | null
}

export interface SessionExitPayload {
  nodeId: string
  status: SessionStatus
  code: number | null
}

export interface SessionStatusPayload {
  nodeId: string
  sessionId?: string
  /** 非 JSON 行 / 解析失败的行,只用于诊断 */
  stderr?: string
}

/**
 * 一个 Electron 进程的内存快照。
 *
 * 暴露这个接口的用意是**让用户自己验证每个降内存开关的真实收益** ——
 * 各 Chromium 开关在具体版本下的实际 MB 数我们没有实测过,与其承诺数字,
 * 不如把测量结果直接摆出来。
 */
export interface ProcessMetricEntry {
  pid: number
  /** Browser / Tab / GPU / Utility / … */
  type: string
  /** 常驻物理内存(KB)。Electron 的 workingSetSize 单位就是 KB */
  workingSetKb: number
  peakKb: number
  cpuPercent: number
}

export interface SettingsPayload {
  /** 当前值(保存后立即更新) */
  current: Settings
  /** 本次进程启动时实际生效的值 */
  applied: Settings
  /** 改了、但本次进程还没生效、需要重启的字段(如 memory.disableGpu) */
  restartRequired: string[]
  settingsFile: string
}

/**
 * preload 通过 contextBridge 暴露给渲染进程的全部能力。
 *
 * 写成显式接口(而不是 typeof api)是为了让 preload 必须 conform ——
 * 契约在这里,实现错了编译期就报。
 */
export interface RendererApi {
  app: {
    info(): Promise<Envelope<AppInfo>>
    paths(): Promise<Envelope<Record<string, string>>>
  }
  agents: {
    /**
     * 节点上「Agent」下拉框的选项 —— CLI 工具与 API 服务商混在一起,
     * 靠每项的 `groupLabel` / `kind` 让 UI 分组。
     */
    list(): Promise<Envelope<AgentListEntry[]>>
    /**
     * 探测一个 agent 能不能用。
     *
     * - CLI 型:找可执行文件。`overridePath` 供设置页"检测"按钮用编辑框里
     *   还没保存的值试探,不必先保存。
     * - API 型(`api:<providerId>`):报 Key 是否就绪、地址与当前模型,
     *   并可顺带做一次真实连通性测试(`probe: true`)。
     */
    detect(
      agentId: string,
      overridePath?: string,
      probe?: boolean,
    ): Promise<Envelope<DetectResult>>
  }
  /**
   * 模型服务商(v0.4.0)。
   *
   * ⚠️ 这三个方法**永远不会**把明文 Key 回给渲染进程 ——
   * 传进去的 key 是"还没保存、想先试试"的那一把,出来的只有脱敏信息与结果。
   */
  providers: {
    list(): Promise<Envelope<ProviderView[]>>
    /** 拉取真实模型列表(多数 OpenAI 兼容服务支持 GET /models),失败回落内置清单 */
    models(
      providerId: string,
      override?: { key?: string; baseUrl?: string },
    ): Promise<Envelope<{ models: ModelDef[]; source: 'remote' | 'builtin'; message?: string }>>
    /** 发一次最小请求验证链路。这是唯一能真正证明"Key 对、地址对、模型对"的方式 */
    test(
      providerId: string,
      override?: { key?: string; baseUrl?: string; model?: string },
    ): Promise<Envelope<ProviderTestResult>>
    /**
     * 批量探测:挨个验证候选模型,通的留下、不通的去掉。
     *
     * 存在的理由是一个物理限制 —— **火山方舟的推理接入点(`ark-…`/`ep-…`)拉不到**
     * (`/models` 不返回接入点,官方的 ListEndpoints 要账号级 AK/SK 签名)。
     * 拉不到就只能挨个试:服务端会在 404/401 那一下告诉它认不认。
     *
     * 三条约定,调用方必须知道:
     *  1. **会发多个真实计费请求** —— 所以 UI 必须先告知数量(见 estimateProbeCost),
     *     不许静默扣费;
     *  2. **并发上限 3**,遇到 429 立即停止剩余探测;
     *  3. **三档分开**:`skipped` 是"这次没测出来"(限流/超时/5xx),
     *     **绝不是"模型不可用"** —— 混起来会让用户在限流时误删能用的模型。
     *
     * `manualModels` 是用户手填的候选名(接入点 id 走这里),它会与
     * 服务端列表、内置清单一起去重合并。
     */
    probe(
      providerId: string,
      override?: { key?: string; baseUrl?: string; manualModels?: string[] },
    ): Promise<Envelope<ProbeReport>>
    /**
     * 订阅批量探测进度。**返回退订函数**,组件卸载时必须调用
     * (React StrictMode 下 effect 跑两次,不退订就翻倍)。
     */
    onProbeProgress(cb: (p: ProbeProgressPayload) => void): () => void
  }
  /** API Key 的写入与清除。读取只走 providers.list() 里的脱敏状态 */
  secrets: {
    set(providerId: string, key: string): Promise<Envelope<SecretStatus>>
    clear(providerId: string): Promise<Envelope<SecretStatus>>
    /** 密钥库存哪、是不是真加密了。UI 用它决定要不要显示明文风险提示 */
    info(): Promise<Envelope<SecretStoreInfo>>
  }
  session: {
    start(req: StartRequest): Promise<Envelope<StartResult>>
    cancel(nodeId: string): Promise<Envelope<{ cancelled: boolean }>>
    /** 订阅统一返回**退订函数**,组件卸载时必须调用 */
    onLog(cb: (p: NodeLogPayload) => void): () => void
    onProgress(cb: (p: NodeProgressPayload) => void): () => void
    onExit(cb: (p: SessionExitPayload) => void): () => void
    onStatus(cb: (p: SessionStatusPayload) => void): () => void
    /** 从磁盘读某个节点的日志尾部(刷新后恢复 / 用户点「加载更早」) */
    logTail(canvasId: string, nodeId: string, limit: number): Promise<Envelope<NodeLogTail>>
    /** 按需取回外溢的大内容(UI 的「展开」按钮) */
    blob(canvasId: string, hash: string): Promise<Envelope<string | null>>
    /** 清空某节点的日志(「新会话」)。旧记录连着磁盘一起删,不是只清界面 */
    reset(canvasId: string, nodeId: string): Promise<Envelope<{ reset: true }>>
  }
  canvas: {
    load(canvasId: string): Promise<Envelope<CanvasGraph | null>>
    save(canvasId: string, graph: CanvasGraph): Promise<Envelope<{ saved: true }>>
  }
  /** 缩略图只读通道(S2)。校验在主进程:传绝对路径 / `..` 一律被拒 */
  image: {
    readThumb(
      projectDir: string,
      relPath: string,
    ): Promise<Envelope<{ dataUrl: string; w: number; h: number } | null>>
  }
  /** 本地生图服务(SD WebUI)一键启停(v0.4.2) */
  localSd: {
    status(): Promise<Envelope<LocalSdStatus>>
    /** 后台静默启动并轮询就绪(首次加载模型约 1-2 分钟)。已在运行则直接返回 */
    start(port?: number): Promise<Envelope<LocalSdStatus & { started: boolean; error?: string }>>
    /** 停止由本应用拉起的服务(外部手动开的管不到) */
    stop(): Promise<Envelope<{ ok: boolean; message: string }>>
  }
  workflow: {
    /**
     * 发起一次运行。**承诺在整个工作流跑完后才 resolve** ——
     * 中途的进度走 `onEvent`,这里拿到的是最终状态。
     */
    run(spec: WorkflowSpec): Promise<Envelope<RunState>>
    /** 整体取消:在跑的全杀,没跑的全标 cancelled */
    cancel(runId: string): Promise<Envelope<{ cancelled: boolean }>>
    /** 取消一个节点**及其后代**,独立分支继续跑 */
    cancelNode(runId: string, nodeId: string): Promise<Envelope<{ cancelled: boolean }>>
    /** 读回某次运行的状态(刷新渲染进程后接上进度) */
    get(runId: string): Promise<Envelope<RunState | null>>
    onEvent(cb: (ev: WorkflowEvent) => void): () => void
  }
  skills: {
    list(): Promise<Envelope<SkillEntry[]>>
    /** 启用/停用 —— 主进程把目录在 skills\ 和 skills-disabled\ 之间移动 */
    setEnabled(name: string, enabled: boolean): Promise<Envelope<{ name: string }>>
    remove(name: string): Promise<Envelope<{ name: string }>>
    /** 把某个本地文件夹装进技能库。名字以 SKILL.md 里声明的为准 */
    importLocal(sourceDir: string): Promise<Envelope<{ name: string }>>
    /** 在资源管理器里打开技能库目录 */
    openDir(): Promise<Envelope<{ opened: true }>>
  }
  dialog: {
    /** 打开系统文件夹选择器。取消返回 null */
    pickDirectory(title?: string, defaultPath?: string): Promise<Envelope<string | null>>
    /** 打开系统文件选择器。取消返回 null */
    pickFile(title?: string, filters?: FileFilter[]): Promise<Envelope<string | null>>
    /** 打开系统保存对话框。取消返回 null */
    saveFile(title?: string, defaultName?: string, filters?: FileFilter[]): Promise<Envelope<string | null>>
  }
  fs: {
    /** 把文本写入文件(utf8)。工作流导出用 */
    writeText(filePath: string, content: string): Promise<Envelope<{ written: true }>>
    /** 读取文本文件(utf8)。工作流导入用 */
    readText(filePath: string): Promise<Envelope<string>>
  }
  shell: {
    /** 在资源管理器里打开这个路径 */
    openPath(path: string): Promise<Envelope<{ opened: true }>>
  }
  settings: {
    get(): Promise<Envelope<SettingsPayload>>
    /** 传完整设置(不传 patch)—— 整份替换,不存在"两个字段互相打架"的合并语义 */
    set(next: Settings): Promise<Envelope<SettingsPayload>>
    /** 保存并重启。主进程内部先杀 agent 树再 relaunch,避免留下孤儿进程 */
    relaunch(): Promise<Envelope<{ relaunching: true }>>
    /** 各进程内存快照,给 PerformanceSection / MemoryMeter 用 */
    metrics(): Promise<Envelope<ProcessMetricEntry[]>>
  }
  /**
   * 无边框窗口的窗口控制(v0.4.0)。
   *
   * 帧被去掉后,最小化/最大化/关闭必须自绘按钮 + IPC 完成。
   * `onMaximizeChanged` 返回退订函数(订阅一律如此,见文件顶部 on 的注释)。
   */
  windowCtl: {
    minimize(): Promise<unknown>
    toggleMaximize(): Promise<Envelope<{ maximized: boolean }>>
    close(): Promise<unknown>
    isMaximized(): Promise<Envelope<{ maximized: boolean }>>
    onMaximizeChanged(cb: (maximized: boolean) => void): () => void
  }
}
