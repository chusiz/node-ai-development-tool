import { z } from 'zod'
import { SETTING_DEFAULTS } from './defaults'

/**
 * 设置 schema 放在 shared 而不是 main。
 *
 * 渲染进程只需要**类型**(`import type` 会被完全擦除,zod 不进渲染进程 bundle),
 * 主进程负责 parse。定义只有一份,不存在"两边字段名写岔"这种漂移。
 */

/*
 * 默认值住在 `defaults.ts`(纯字面量,不 import 任何东西),这里只把它转出来。
 * 不这么分的话,渲染进程按值引用一个默认值就会连带把 zod 打进渲染进程 bundle ——
 * 因为本文件顶部 import 了 z。见 defaults.ts 的注释。
 */
export { SETTING_DEFAULTS } from './defaults'

const D = SETTING_DEFAULTS

/*
 * 每个字段都用 .catch(默认值) 而不是 .default(默认值)。
 *
 * .catch 同时兜住两种情况:字段整个缺失、以及值被改坏(手改 settings.json
 * 写进去一个字符串)。而且它**只回退坏掉的那一个字段**,同段其它字段照常生效。
 * 用 .default 的话坏值会让整段 safeParse 失败 —— 用户改错一个数字就丢一整页设置。
 */
const bool = (d: boolean): z.ZodCatch<z.ZodBoolean> => z.boolean().catch(d)
const int = (d: number, lo: number, hi: number): z.ZodCatch<z.ZodNumber> =>
  z.number().int().min(lo).max(hi).catch(d)

export const MemorySettingsSchema = z.object({
  /** 关掉硬件加速。单点省内存收益最大的一项(代价:画布平移/缩放会发涩) */
  disableGpu: bool(D.memory.disableGpu),
  /** 一次性降低多项缓存与线程预算(代价:滚动与动画质量下降) */
  lowEndDeviceMode: bool(D.memory.lowEndDeviceMode),
  /** 渲染进程 V8 老生代堆上限(MB)。太低会 OOM,下限硬卡 256 */
  maxOldSpaceMb: int(D.memory.maxOldSpaceMb, 256, 8192),
  /** Chromium 磁盘缓存上限(MB)。保护 D 盘,并不省内存 */
  diskCacheMb: int(D.memory.diskCacheMb, 0, 4096),
})

/** 渲染进程侧的消息列表封顶。真正的裁剪在 store 里做,这里只是配置 */
export const LimitsSchema = z.object({
  maxItemsPerNode: int(D.limits.maxItemsPerNode, 50, 20000),
  maxToolResultChars: int(D.limits.maxToolResultChars, 0, 1_000_000),
  maxThinkingChars: int(D.limits.maxThinkingChars, 0, 1_000_000),
  maxResultChars: int(D.limits.maxResultChars, 0, 4_000_000),
  stderrTailLines: int(D.limits.stderrTailLines, 0, 200),
  diagRingSize: int(D.limits.diagRingSize, 0, 5000),
})

export const WorkflowSchema = z.object({
  /** 全局并发上限。16GB 内存 + API 限流下的保守值 */
  maxParallel: int(D.workflow.maxParallel, 1, 4),
  /** 上游产出超过这个长度就不再内联,改注入 blob 路径 */
  inlineLimitBytes: int(D.workflow.inlineLimitBytes, 1024, 4_000_000),
})

/**
 * Agent(CLI)相关设置。
 *
 * 这是"换个电脑也能用"的关键一项:npm 全局装的 claude 在别人机器上可能
 * 在完全不同的位置(甚至是用别的方式装的)。自动探测失败时,用户能自己指路。
 */
export const AgentSettingsSchema = z.object({
  /**
   * claude 可执行文件路径。空 = 自动探测。
   *
   * 用 .catch 而不是 .min(1):用户从输入框里清空是合法操作(等于"恢复自动"),
   * 不能被 schema 判成非法值再悄悄回滚。
   *
   * ⚠️ v0.4.0 起是旧配置的兼容位,新 CLI 走 cliPaths。
   */
  claudePath: z.string().max(4096).catch(D.agent.claudePath),
  /**
   * 各 CLI 的自定义可执行文件路径,key = agentId。
   *
   * `.catch({})` 而不是让它整段失败:用户手改坏一个条目不该丢掉所有 CLI 的配置。
   * 值的长度上限与单个字段一致(4096),Windows 长路径也够用。
   */
  cliPaths: z
    .record(z.string().max(64), z.string().max(4096))
    .catch({ ...D.agent.cliPaths }),
  /**
   * 各服务商的覆盖配置,key = providerId。
   *
   * 只存「地址」和「默认模型」这类非敏感项;**API Key 不在这里**
   * (走 data/secrets.json 的加密存储)。这样 settings.json 可以随便备份/分享。
   */
  providers: z
    .record(
      z.string().max(64),
      z.object({
        /** 覆盖默认接口地址。空 = 用注册表里的默认值 */
        baseUrl: z.string().max(2048).catch(''),
        /** 这家默认用哪个模型。节点上没单独选时用它 */
        defaultModel: z.string().max(256).catch(''),
        /**
         * 探测验证过可用的模型 id(v0.4.0)。
         *
         * 放在这里而不是另开一个缓存,是刻意的:「这个模型我验过能用」是一条
         * **配置**,该跟着 settings 走(换电脑、分享画布都带上),而不是运行时状态。
         * 节点面板的可搜索下拉框直接消费它 —— 用户在设置页探明了可用模型,
         * 回到节点上就能选到它们。
         *
         * ⚠️ **只存通过的**。跳过(限流/超时)与不可用的都不存:存下来会让用户
         * 以为"已经验过,不可用",而跳过的真实语义是"这次没测出来"。
         * `.catch([])` 兜住手改坏的值 —— 一个坏条目不该连累同段其它字段。
         */
        verifiedModels: z.array(z.string().max(256)).max(500).catch([]),
        /**
         * 最近手填过的模型名/接入点 id(v0.4.1)。
         *
         * 火山方舟的推理接入点(`ark-…`/`ep-…`)拉不到、数量不限,用户每次都要
         * 手填。把这些名字记下来,下次设置页的候选区能一键点选,不必再打一遍。
         * 只在 `addManual` / 探测手填时写入,不自动记服务端拉到的(那本来就列得出)。
         */
        recentModels: z.array(z.string().max(256)).max(20).catch([]),
      }),
    )
    .catch({ ...D.agent.providers }),
})

/** UI 相关设置:界面语言 + 用户自定义快捷键(见 defaults.ts ui 段注释) */
export const UiSettingsSchema = z.object({
  language: z.enum(['en', 'zh']).catch(D.ui.language),
  /** actionId → 用户改过的组合串;缺项 = 用默认键位 */
  keymap: z.record(z.string().max(64), z.string().max(128)).catch({ ...D.ui.keymap }),
})

export const SettingsSchema = z.object({
  version: z.literal(1).catch(1),
  memory: MemorySettingsSchema,
  limits: LimitsSchema,
  workflow: WorkflowSchema,
  agent: AgentSettingsSchema,
  ui: UiSettingsSchema,
})

export type MemorySettings = z.infer<typeof MemorySettingsSchema>
export type LimitSettings = z.infer<typeof LimitsSchema>
export type WorkflowSettings = z.infer<typeof WorkflowSchema>
export type AgentSettings = z.infer<typeof AgentSettingsSchema>
export type UiSettings = z.infer<typeof UiSettingsSchema>
export type Settings = z.infer<typeof SettingsSchema>

/** 唯一默认值来源。与 schema 里的 .catch 同源(SETTING_DEFAULTS),不会漂移 */
export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  memory: { ...D.memory },
  limits: { ...D.limits },
  workflow: { ...D.workflow },
  agent: { ...D.agent },
  ui: { ...D.ui, keymap: { ...D.ui.keymap } },
}

/** 逐段解析。整段不是对象(或整体被破坏)就回退该段默认值 —— 其余段不受牵连 */
function section<T extends z.ZodObject<z.ZodRawShape>>(schema: T, v: unknown): z.infer<T> {
  const r = schema.safeParse(v)
  return (r.success ? r.data : schema.parse({})) as z.infer<T>
}

/**
 * 永不抛的解析入口。settings.json 的内容完全可能被用户手改坏,
 * 而它是在 app ready **之前**读的 —— 那里抛异常等于应用起不来。
 */
export function parseSettings(raw: unknown): Settings {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  return {
    version: 1,
    memory: section(MemorySettingsSchema, o.memory),
    limits: section(LimitsSchema, o.limits),
    workflow: section(WorkflowSchema, o.workflow),
    agent: section(AgentSettingsSchema, o.agent),
    ui: section(UiSettingsSchema, o.ui),
  }
}

/**
 * 需要重启才生效的字段。
 *
 * 这几项都是在 ready **之前**打进 Chromium 命令行开关的,进程起来之后就改不动了。
 * 其余设置(limits / workflow)是运行时读取,保存即生效。
 */
const RESTART_REQUIRED = [
  'disableGpu',
  'lowEndDeviceMode',
  'maxOldSpaceMb',
  'diskCacheMb',
] as const satisfies readonly (keyof MemorySettings)[]

/** 逐字段 diff 出「改了这个,但本次进程还没生效」的清单,UI 据此决定要不要提示重启 */
export function restartRequiredKeys(current: Settings, applied: Settings): string[] {
  const out: string[] = []
  for (const k of RESTART_REQUIRED) {
    if (current.memory[k] !== applied.memory[k]) out.push(`memory.${k}`)
  }
  return out
}
