import type { RendererApi } from '../../shared/ipc'

declare global {
  interface Window {
    api: RendererApi
  }
}

/*
 * 渲染进程只看得到 shared 里的契约类型。
 *
 * 全部走 `export type` —— 这样打包器会把它们当纯类型擦掉。
 * 改成 `export {}`(值导出)的话,zod 那套运行时代码会被拖进渲染进程包,
 * 白白多几十 KB 且毫无用处(校验只发生在主进程边界)。
 */
export type {
  AppInfo,
  AgentListEntry,
  AgentCapabilities,
  DetectResult,
  SkillEntry,
  SkillOrigin,
  Envelope,
  StartRequest,
  StartResult,
  NodeEvent,
  SessionStatus,
  PermissionMode,
  PersistedRecord,
  LogRecord,
  NodeMetaSnapshot,
  NodeLogPayload,
  NodeProgressPayload,
  NodeLogTail,
  SessionExitPayload,
  SessionStatusPayload,
  CanvasGraph,
  CanvasNode,
  CanvasEdge,
  NodeConfig,
  Viewport,
  Settings,
  SettingsPayload,
  ProcessMetricEntry,
  MemorySettings,
  LimitSettings,
  WorkflowSettings,
  AgentSettings,
  // ---- 多服务商(v0.4.0) ----
  ModelDef,
  ProviderDef,
  ProviderProtocol,
  ProviderGroup,
  ModelCandidate,
  ModelSource,
  ProviderView,
  SecretStatus,
  SecretStoreInfo,
  ProviderTestResult,
  // ---- 模型可用性探测(v0.4.0) ----
  ProbeReport,
  ProbeResult,
  ProbeVerdict,
  ProbeProgressPayload,
} from '../../shared/ipc'

/*
 * ⚠️ 下面这些是**值**导入,不是类型 —— 所以必须从 shared/providers 直接引,
 * 不能走 ipc.ts 的 `export type`。
 *
 * providers.ts 是纯字面量 + 纯函数,零依赖,可以安全地进渲染进程 bundle;
 * 而 ipc.ts 会牵连 settings → zod。这也是 providers 单独成文件的原因之一。
 */
export {
  PROVIDERS,
  PROVIDER_GROUPS,
  API_AGENT_PREFIX,
  apiAgentId,
  providerOfAgent,
  isApiAgent,
  effectiveModel,
  effectiveBaseUrl,
  providersInGroup,
  getProvider,
  /* 可搜索模型框的数据层(纯逻辑,零依赖,见 shared/providers.ts 末尾) */
  MODEL_SOURCE_LABEL,
  filterModels,
  mergeModelCandidates,
  currentValueCandidate,
} from '../../shared/providers'

export { maskKey, envKeyName, looksLikeKey } from '../../shared/secrets'

/*
 * 探测的**值**(判定、分组、选第一个、成本估算)。
 *
 * 与上面 providers 同理从源文件直引:shared/probe.ts 零依赖(不 import zod),
 * 只有 `import type` 走 ipc.ts 的话,设置页就没法在本地算"这次要花多少钱"、
 * 也没法在渲染侧把三档结果分组 —— 那些都必须按值调用。
 */
export {
  PROBE_CONCURRENCY,
  PROBE_MAX_TOKENS,
  PROBE_PROMPT,
  PROBE_TIMEOUT_MS,
  PROBE_VERDICT_LABEL,
  estimateProbeCost,
  buildProbeCandidates,
  classifyProbeResponse,
  groupProbeResults,
  pickFirstAvailable,
  verifiedCandidates,
  verifiedModelIds,
} from '../../shared/probe'
