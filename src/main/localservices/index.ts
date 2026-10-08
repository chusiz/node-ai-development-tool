/**
 * 本地生图服务管理(v0.4.2):检测 / 后台静默启动 / 停止 SD WebUI(A1111)。
 *
 * 目标:用户不用再手动开 SD 的窗口 —— chusiz 里一键「启动」,服务在后台
 * 运行(无窗口),API 就绪后图像节点直接可用。
 *
 * 启动用整合包内置 python 直接跑 `launch.py --api`(绕开 webui.bat 创建
 * venv 的慢路径,实测可用)。日志落 logDir/sd-webui.log。
 *
 * ⚠️ 本模块**不依赖 electron**(纯 node):register.ts 注入 logDir
 * (app.getPath('userData')),命令行脚本直接跑也不会崩。
 */
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { killProcessTree } from '../agents/kill'

export interface LocalSdStatus {
  /** SD API 是否在响应 */
  running: boolean
  /** 服务端口(默认 7860) */
  port: number
  /** API 返回的可用模型标题 */
  models: string[]
  /** 找到的 SD WebUI 整合包目录(服务模式用;找不到为 null) */
  dir: string | null
  /** 本模块后台拉起的进程 pid(外部手动开的记不了,为 null) */
  pid: number | null
  /** 可用的本地 python 推理环境(直出模式用;提取的运行时优先,整合包 python 次之) */
  pythonPath: string | null
  /** 可用的 checkpoint 模型文件(直出模式用) */
  checkpoint: string | null
}

/** 由本模块后台拉起的 SD WebUI 进程 pid */
let managedPid: number | null = null

export const DEFAULT_SD_PORT = 7860

/** 大小写不敏感的子串匹配(目录探测用) */
function nameHits(name: string, keywords: string[]): boolean {
  const lower = name.toLowerCase()
  return keywords.some((k) => lower.includes(k))
}

/**
 * 本地生图运行时(提取的 python + checkpoint):可经环境变量配置,
 * 未配置时回落整合包内 python / models。整合包删掉后直出仍可用(配置好这两个 env 即可)。
 */
const EXTRACTED_RUNTIME = process.env.CHUSIZ_SD_PYTHON ?? ''
const EXTRACTED_CHECKPOINT = process.env.CHUSIZ_SD_CHECKPOINT ?? ''

/** SD WebUI 整合包常见位置:深度 1-2 的通配探测,命中第一个就停 */
async function resolveSdDir(): Promise<string | null> {
  const roots: Array<{ dir: string; depth: number }> = [
    { dir: process.env.CHUSIZ_SD_WEBUI_ROOT ?? 'D:\\ui', depth: 1 },
    { dir: 'D:\\', depth: 2 },
  ]
  const hits: string[] = []
  for (const root of roots) {
    const walk = async (p: string, depth: number): Promise<void> => {
      if (depth < 0) return
      let entries: Dirent[] = []
      try {
        entries = await fsp.readdir(p, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const full = path.join(p, e.name)
        // 特征:目录名含 sd-webui / stable-diffusion-webui / aki,且内有 launch.py
        if (
          nameHits(e.name, ['sd-webui', 'stable-diffusion', 'webui-aki', 'aki']) &&
          (await exists(path.join(full, 'launch.py')))
        ) {
          hits.push(full)
          return
        }
        if (depth > 0) await walk(full, depth - 1)
      }
    }
    await walk(root.dir, root.depth)
    if (hits.length > 0) return hits[0]
  }
  return hits[0] ?? null
}

/** python 推理环境:提取的运行时优先,整合包 python 次之 */
async function resolvePython(): Promise<string | null> {
  if (await exists(EXTRACTED_RUNTIME)) return EXTRACTED_RUNTIME
  const dir = await resolveSdDir()
  if (!dir) return null
  const p = path.join(dir, 'python', 'python.exe')
  return (await exists(p)) ? p : null
}

/** checkpoint:提取的模型优先,整合包 models 目录首个 .safetensors 次之 */
async function resolveCheckpoint(): Promise<string | null> {
  if (await exists(EXTRACTED_CHECKPOINT)) return EXTRACTED_CHECKPOINT
  const dir = await resolveSdDir()
  if (!dir) return null
  const sdDir = path.join(dir, 'models', 'Stable-diffusion')
  try {
    const files = await fsp.readdir(sdDir)
    const hit = files.find((f) => f.endsWith('.safetensors') || f.endsWith('.ckpt'))
    return hit ? path.join(sdDir, hit) : null
  } catch {
    return null
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

/** 拉模型列表;服务没起/没就绪 → 抛错(调用方决定语义) */
async function fetchModels(port: number): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${port}/sdapi/v1/sd-models`, {
    signal: AbortSignal.timeout(3000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const arr = (await res.json()) as Array<{ title?: string; model_name?: string }>
  return (arr ?? []).map((m) => m.title ?? m.model_name ?? '').filter(Boolean)
}

export async function sdStatus(port = DEFAULT_SD_PORT): Promise<LocalSdStatus> {
  const dir = await resolveSdDir()
  const pythonPath = await resolvePython()
  const checkpoint = await resolveCheckpoint()
  let running = false
  let models: string[] = []
  try {
    models = await fetchModels(port)
    running = true
  } catch {
    /* 未运行 */
  }
  return { running, port, models, dir, pid: managedPid, pythonPath, checkpoint }
}

export interface SdStartResult extends LocalSdStatus {
  /** 本次是否真的由本模块启动(已在运行则为 false) */
  started: boolean
  error?: string
}

export async function sdStart(port = DEFAULT_SD_PORT, logDir?: string): Promise<SdStartResult> {
  const dir = await resolveSdDir()
  const pythonPath = await resolvePython()
  const checkpoint = await resolveCheckpoint()
  if (!dir) {
    return {
      running: false,
      port,
      models: [],
      dir: null,
      pid: null,
      pythonPath,
      checkpoint,
      started: false,
      error: '没找到 SD WebUI 安装目录 —— 服务模式需要整合包本体(含 launch.py)。若整合包已删,请用「本地模型直出」预设(不依赖服务)',
    }
  }

  // 已在运行 → 直接复用,不重复拉起
  try {
    const models = await fetchModels(port)
    return { running: true, port, models, dir, pid: managedPid, pythonPath, checkpoint, started: false }
  } catch {
    /* 没在跑,继续启动 */
  }

  const py = path.join(dir, 'python', 'python.exe')
  if (!(await exists(py))) {
    return {
      running: false,
      port,
      models: [],
      dir,
      pid: null,
      pythonPath,
      checkpoint,
      started: false,
      error: '目录里没有 python\\python.exe —— 不是有效的 SD WebUI 整合包',
    }
  }

  const logDir2 = logDir ?? path.join(process.env.APPDATA ?? os.tmpdir(), 'node-ai-development-tool')
  await fsp.mkdir(logDir2, { recursive: true })
  const logPath = path.join(logDir2, 'sd-webui.log')
  const outFd = await fsp.open(logPath, 'a')

  const child = spawn(py, ['launch.py', '--nowebui', '--api'], {
    cwd: dir,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', outFd.fd, outFd.fd],
  })
  managedPid = child.pid ?? null

  // 轮询就绪(首次启动要加载模型,给 240s 余量)
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000))
    try {
      const models = await fetchModels(port)
      return { running: true, port, models, dir, pid: managedPid, pythonPath, checkpoint, started: true }
    } catch {
      /* 继续等 */
    }
  }
  return {
    running: false,
    port,
    models: [],
    dir,
    pid: managedPid,
    pythonPath,
    checkpoint,
    started: false,
    error: `启动超时(240s) —— 日志在 ${logPath},常见原因:显存不足 / 端口被占用 / 模型损坏`,
  }
}

export async function sdStop(): Promise<{ ok: boolean; message: string }> {
  if (!managedPid) {
    return { ok: false, message: '当前没有由本工具启动的 SD 服务在跑(手动开的请自行关窗口)' }
  }
  await killProcessTree(managedPid)
  managedPid = null
  return { ok: true, message: '已停止本地 SD 服务' }
}
