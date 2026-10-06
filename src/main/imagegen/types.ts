import type { ChildProcess } from 'node:child_process'

/**
 * 图像执行器内部的类型收口。
 *
 * 请求/结果契约的正身在 `../workflow/builtinAction.ts`(RunnerEnv 要引用它,
 * 而 runner 不许 import 执行器实现层)。这里 re-export 给 imagegen 目录内部用。
 */
export type { BuiltinActionRequest, BuiltinActionResult } from '../workflow/builtinAction'

/** provider 执行结局。产物扫描由 ImageGen 统一做,provider 只回"跑成什么样" */
export type ProviderStatus = 'ok' | 'fail' | 'cancelled' | 'timeout'

export interface ProviderResult {
  status: ProviderStatus
  /** 失败原因(人话)。status==='fail' 时应有 */
  error?: string
  /** 完整日志(stdout/stderr 按行收割,容忍乱码只影响可读性) */
  log: string
}

/**
 * provider 运行上下文 —— 由 ImageGen 组装后递给两个 provider。
 * 只放 provider 需要的东西,不暴露 ImageGen 的账本。
 */
export interface ProviderCtx {
  nodeId: string
  /** 项目文件夹(绝对路径) */
  projectDir: string
  /** 本次实际产物目录(绝对路径,已 mkdir -p) */
  outDir: string
  /** 阶段一已展开的画面描述 */
  prompt: string
  /** 负提示词(v0.4.1,ComfyUI 式):HTTP 后端的 bodyTemplate 用 {{negativePrompt}} 取 */
  negativePrompt?: string
  /** 张数(已夹到 1..8) */
  n: number
  /** 尺寸 */
  size: string
  /** 随机种子。undefined = 每张随机 */
  seed?: number
  /** 本次运行起始时间戳(产物判定基准) */
  startTs: number
  onProgress?(line: string): void
}

/**
 * 生命周期记账句柄 —— 让 provider 保持"无跨请求状态":
 * 活着的子进程 / 可中断的请求这一份账本由 ImageGen 持有,cancel / killAll 查它。
 */
export interface ImageCtl {
  registerChild(nodeId: string, child: ChildProcess): void
  unregisterChild(nodeId: string): void
  registerAbort(nodeId: string, ac: AbortController): void
  unregisterAbort(nodeId: string): void
  /** 该节点是否被 cancel / killAll 标记过(provider 据此把结局判成"已取消") */
  isKilled(nodeId: string): boolean
  markKilled(nodeId: string): void
}
