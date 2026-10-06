import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import type { Dirent } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { BuildOptions } from '../../shared/canvas'
import type { BuiltinActionRequest, BuiltinActionResult } from './types'
import { killProcessTree } from '../agents/kill'
import { zipGameProject } from './gameZip'

/**
 * 内置打包链路的默认 recipe:electron-builder(P0 只有 exe)。
 *
 * 只做"纯函数 + 进程编排",不持有任何跨请求状态 —— 活着的子进程表
 * 在 Packager(../index.ts)里,那才是取消/退出的账本。
 */

/** 日志缓冲上限。超大日志只留尾部 —— 既不撑爆内存,也不把 IPC 冲垮 */
const LOG_TAIL_BYTES = 64 * 1024

/**
 * 定位目标项目自带的 electron-builder CLI 入口。
 *
 * 为什么用**目标项目**的而不是宿主应用的:打包用的是用户项目的配置与版本,
 * 宿主的 electron-builder 是 devDependency,打包别人的项目未必兼容。
 *
 * 为什么是 `node <cli.js>` 而不是 spawn `electron-builder.cmd`:
 * 项目全程 shell:false(避免 cmd.exe 的引号解析 + GBK 乱码),而 Windows 上
 * `.cmd` 必须经 shell 才能跑。走 JS 入口既避开 shell,又拿到项目自己的版本。
 * 找不到返回 null(调用方给人话报错,让用户去目标项目里 npm install)。
 */
export function resolveBuilder(projectDir: string): string | null {
  const cli = path.join(projectDir, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
  try {
    return fs.statSync(cli).isFile() ? cli : null
  } catch {
    return null
  }
}

/** 目标项目的 package.json 有没有 build 脚本(有 → 先跑前置 build,见 M1) */
export function hasBuildScript(projectDir: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>
    }
    return typeof pkg.scripts?.build === 'string' && pkg.scripts.build.trim() !== ''
  } catch {
    // 没有 package.json / 解析不了 → 当作没有 build 脚本,直接试 electron-builder
    return false
  }
}

/**
 * 组 electron-builder 的 argv(P0,exe)。
 *
 * `--publish never` 必带:不给的话 electron-builder 在有 CI 环境变量时可能
 * 尝试发布,打包个安装包不该有网络副作用。
 */
export function builderArgv(cliPath: string, buildOptions?: BuildOptions): string[] {
  const o = buildOptions ?? {}
  const args = [cliPath, '--win']
  if (o.outDir && o.outDir.trim()) args.push(`--config.directories.output=${o.outDir.trim()}`)
  if (o.version && o.version.trim()) args.push(`--config.extraMetadata.version=${o.version.trim()}`)
  if (o.appName && o.appName.trim()) args.push(`--config.productName=${o.appName.trim()}`)
  args.push('--publish', 'never')
  return args
}

/**
 * 起 node 子进程(electron-builder / 前置 build 都走它)。
 *
 * ⚠️ 为什么是 `process.execPath + ELECTRON_RUN_AS_NODE` 而不是 PATH 里找 node:
 *   - 全程 shell:false(项目铁律),PATH 拼接这类 shell 把戏一律不用;
 *   - 应用打包分发后,用户机器上未必有 node 在 PATH 里,而 Electron 自带;
 *   - Electron 38 = Node 22,`node --run` 等参数都可用。
 *
 * 注意方向:agent 那侧(spawn claude)刻意**剥掉** ELECTRON_RUN_AS_NODE
 * (见 agents/claude/env.ts,防止被 spawn 的 Electron 系二进制退化成裸 node);
 * 这里正相反,**必须显式设上**,否则 spawn 出来的是 GUI 而不是 node。
 */
function spawnNode(args: string[], cwd: string): ChildProcess {
  return spawn(process.execPath, args, {
    cwd,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
  })
}

/** 带环上限的日志缓冲:只留尾部,读出来永远 ≤ LOG_TAIL_BYTES */
class LogTail {
  private lines: string[] = []
  private bytes = 0

  push(line: string): void {
    this.lines.push(line)
    this.bytes += line.length + 1
    while (this.bytes > LOG_TAIL_BYTES && this.lines.length > 1) {
      const dropped = this.lines.shift() as string
      this.bytes -= dropped.length + 1
    }
  }

  text(): string {
    return this.lines.join('\n')
  }
}

/**
 * 从子进程的 stdout/stderr 按行收割。
 * stderr 也当进度喂 —— electron-builder 的绝大多数输出走 stderr。
 */
function pumpLines(
  stream: NodeJS.ReadableStream | null,
  onLine: (line: string) => void,
): void {
  if (!stream) return
  let buf = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buf += chunk
    for (;;) {
      const nl = buf.indexOf('\n')
      if (nl < 0) break
      const line = buf.slice(0, nl).replace(/\r$/, '')
      buf = buf.slice(nl + 1)
      if (line.trim()) onLine(line)
    }
  })
}

/** 打包子进程的"生命周期记账"句柄 —— 由 Packager 提供,让本文件保持无状态 */
interface ProcControl {
  register(child: ChildProcess): void
  unregister(): void
  isKilled(): boolean
  markKilled(): void
}

/** 跑一个 node 子进程到退出。取消时返回 killed:true */
function runNodeProcess(
  args: string[],
  cwd: string,
  onLine: (line: string) => void,
  ctl: ProcControl,
): Promise<{ code: number | null; killed: boolean }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawnNode(args, cwd)
    } catch (e) {
      reject(e)
      return
    }
    ctl.register(child)
    pumpLines(child.stdout, onLine)
    pumpLines(child.stderr, onLine)
    child.on('error', (e) => {
      ctl.unregister()
      reject(e)
    })
    child.on('close', (code) => {
      ctl.unregister()
      resolve({ code, killed: ctl.isKilled() })
    })
  })
}

/**
 * 在目录树里找最新修改的 *.exe。
 *
 * 排除 `win-unpacked`:那是 electron-builder 的**未打包目录**,里面的 exe
 * 是中间产物;用户要的交付物是外面的 Setup 安装包。也跳过 node_modules
 * (项目若自带预构建产物,不该被误认成本次的成果)。
 * 取最新 mtime:多次打包后 dist 里可能堆着几个旧版本,交付的应当是最新那个。
 */
export async function findArtifact(projectDir: string, outDir?: string): Promise<string | null> {
  const root = outDir && outDir.trim() ? outDir.trim() : path.join(projectDir, 'dist')
  const skip = new Set(['win-unpacked', 'node_modules'])
  let best: { file: string; mtime: number } | null = null

  const walk = async (dir: string, depth: number): Promise<void> => {
    // 深度兜底:产物目录正常不超过 3 层,防符号链接/异常结构把遍历拖死
    if (depth > 4) return
    let entries: Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue
        await walk(full, depth + 1)
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.exe')) {
        try {
          const st = await fsp.stat(full)
          if (!best || st.mtimeMs > best.mtime) best = { file: full, mtime: st.mtimeMs }
        } catch {
          /* 竞态:文件刚被删 —— 跳过 */
        }
      }
    }
  }

  await walk(root, 0)
  return best ? (best as { file: string }).file : null
}

/** 一并返回"取消态"结果的小工具 —— 两条链路(前置 build / 打包)共用 */
function cancelledResult(log: string): BuiltinActionResult {
  return { ok: false, log, error: '打包已取消' }
}

/**
 * 执行一次完整的内置打包(默认 recipe):
 *   ① 解析 electron-builder 入口(没有 → 人话报错);
 *   ② 若项目有 build 脚本,先跑前置 build(M1 决策:不 build 直接打包
 *      常常打出上一版的旧产物,用户拿到的是"看起来成功、内容过时"的包);
 *   ③ 跑 electron-builder --win;
 *   ④ 在输出目录里定位最新 *.exe。
 */
export async function packageProject(
  req: BuiltinActionRequest,
  ctl: ProcControl,
): Promise<BuiltinActionResult> {
  const log = new LogTail()
  const onLine = (line: string): void => {
    log.push(line)
    req.onProgress?.(line)
  }

  if (req.buildTarget === 'game') {
    // ★ 游戏项目打包(v0.4.1):Godot 项目是"文件夹即项目" —— 交付形态 = zip。
    return await zipGameProject(req, ctl)
  }
  if (req.buildTarget !== 'exe') {
    return {
      ok: false,
      log: '',
      error: `打包目标 ${req.buildTarget} 暂不可用(P0 仅支持 exe)`,
    }
  }
  if (!req.projectDir || !req.projectDir.trim()) {
    return {
      ok: false,
      log: '',
      error: '没有指定项目文件夹 —— 请先在项目节点上选择项目文件夹',
    }
  }
  const projectDir = req.projectDir.trim()

  // ① 入口
  const cli = resolveBuilder(projectDir)
  if (!cli) {
    return {
      ok: false,
      log: '',
      error: '目标项目没有安装 electron-builder,请先在其目录执行 npm install',
    }
  }

  // ② 前置 build(M1):有 build 脚本才跑;`node --run` 不经 shell、不依赖 npm 全局安装
  if (hasBuildScript(projectDir)) {
    req.onProgress?.('[内置打包] 检测到 build 脚本,先执行前置构建…')
    const build = await runNodeProcess(['--run', 'build'], projectDir, onLine, ctl)
    if (build.killed) return cancelledResult(log.text())
    if (build.code !== 0) {
      return {
        ok: false,
        log: log.text(),
        error: `前置 build 失败(退出码 ${build.code ?? '未知'}),请查看打包日志`,
      }
    }
  }

  // ③ electron-builder
  req.onProgress?.('[内置打包] 开始执行 electron-builder…')
  let exit: { code: number | null; killed: boolean }
  try {
    exit = await runNodeProcess(builderArgv(cli, req.buildOptions), projectDir, onLine, ctl)
  } catch (e) {
    return {
      ok: false,
      log: log.text(),
      error: `无法启动 electron-builder:${e instanceof Error ? e.message : String(e)}`,
    }
  }
  if (exit.killed) return cancelledResult(log.text())
  if (exit.code !== 0) {
    return {
      ok: false,
      log: log.text(),
      error: `electron-builder 失败(退出码 ${exit.code ?? '未知'}),请查看打包日志`,
    }
  }

  // ④ 定位产物
  const artifact = await findArtifact(projectDir, req.buildOptions?.outDir)
  if (!artifact) {
    return {
      ok: true,
      log:
        log.text() +
        '\n[内置打包] 完成,但没有在输出目录里找到 .exe 产物 —— 请检查 electron-builder 的输出配置',
    }
  }
  req.onProgress?.(`[内置打包] 产物:${artifact}`)
  return { ok: true, artifactPath: artifact, log: log.text() }
}
