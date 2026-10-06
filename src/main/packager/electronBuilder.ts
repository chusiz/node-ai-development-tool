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
  if (req.buildTarget === 'web') {
    // ★ Web 静态站点打包(v0.6.0):跑构建脚本 → 定位静态产物 → zip 交付。
    // 参考 n8n / Langflow 的"产物即部署物"思路:web 产物 = 一份可托管的静态站点,
    // 可直接拖进任意静态托管,或用手机浏览器打开(即 PWA 入口)。
    return await packageWeb(req, ctl)
  }
  if (req.buildTarget === 'apk') {
    // ★ Android 打包(v0.6.0):有 Android SDK + Gradle 就走 Capacitor 真打 APK;
    // 缺工具链时**优雅降级**为 Web 应用包(PWA),不空手失败 ——
    // 参考 Dify / n8n 的"环境不足先给可用产物"策略。
    return await packageApk(req, ctl)
  }
  if (req.buildTarget !== 'exe') {
    return {
      ok: false,
      log: '',
      error: `打包目标 ${req.buildTarget} 暂不可用(支持:exe / web / apk / game)`,
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

/**
 * 定位"构建产物目录":优先用户指定,否则按常见约定探测(找到含 index.html 的那个)。
 * 参考 Langflow/ComfyUI 的产物约定:dist / build / out / www 是最普遍的四套。
 */
async function locateWebOut(projectDir: string, outDir?: string): Promise<string | null> {
  const candidates = [outDir, 'dist', 'build', 'out', 'www'].filter(
    (d): d is string => !!d && d.trim() !== '',
  )
  for (const c of candidates) {
    const dir = path.isAbsolute(c) ? c : path.join(projectDir, c)
    try {
      const st = await fsp.stat(path.join(dir, 'index.html'))
      if (st.isFile()) return dir
    } catch {
      /* 该目录没有 index.html → 试下一个 */
    }
  }
  return null
}

/** 用 PowerShell Compress-Archive 把目录打成 zip(排除列表按用途传入) */
async function zipDir(
  srcDir: string,
  zipPath: string,
  excludeNames: string[],
  onLine: (l: string) => void,
  ctl: ProcControl,
): Promise<void> {
  const q = (s: string): string => `'${s.replace(/'/g, "''")}'`
  const ex = excludeNames.map((n) => `$_.Name -ne '${n.replace(/'/g, "''")}'`).join(' -and ')
  const ps = [
    `$items = Get-ChildItem -LiteralPath ${q(srcDir)} -Force | Where-Object { ${ex} }`,
    `if ($items.Count -eq 0) { Write-Error '目录里没有可打包的内容'; exit 1 }`,
    `Compress-Archive -Path $items.FullName -DestinationPath ${q(zipPath)} -CompressionLevel Optimal`,
  ].join('; ')
  await new Promise<void>((resolve, reject) => {
    const child: ChildProcess = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true },
    )
    ctl.register(child)
    let errTail = ''
    child.stderr?.on('data', (d: Buffer) => {
      errTail = (errTail + d.toString()).slice(-2000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      ctl.unregister()
      if (ctl.isKilled()) {
        resolve()
        return
      }
      if (code === 0) resolve()
      else reject(new Error(`PowerShell 退出码 ${code ?? '未知'}${errTail ? ' · ' + errTail.slice(0, 300) : ''}`))
    })
  }).catch((e: unknown) => {
    if (ctl.isKilled()) return
    throw e
  })
}

/**
 * Web 静态站点打包(v0.6.0):
 *   ① 项目有 build 脚本 → 先跑前置构建(与 exe 链路同款);
 *   ② 定位静态产物目录(含 index.html);
 *   ③ 打成 `<项目>/dist/<name>-web-<ts>.zip`。
 * 交付物解压即是一份可托管站点 —— 拖进任意静态托管 / 手机浏览器打开即可用。
 */
async function packageWeb(req: BuiltinActionRequest, ctl: ProcControl): Promise<BuiltinActionResult> {
  const log = new LogTail()
  const onLine = (line: string): void => {
    log.push(line)
    req.onProgress?.(line)
  }
  if (!req.projectDir || !req.projectDir.trim()) {
    return { ok: false, log: '', error: '没有指定项目文件夹 —— 请先在项目节点上选择项目文件夹' }
  }
  const projectDir = req.projectDir.trim()
  const outDir = path.join(projectDir, 'dist')
  await fsp.mkdir(outDir, { recursive: true }).catch(() => undefined)

  const appName = (req.buildOptions?.appName ?? '').trim() || 'web-app'
  const safeName = appName.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'web-app'

  // ① 前置 build
  if (hasBuildScript(projectDir)) {
    onLine('[Web 打包] 检测到 build 脚本,先执行前置构建…')
    const build = await runNodeProcess(['--run', 'build'], projectDir, onLine, ctl)
    if (build.killed) return cancelledResult(log.text())
    if (build.code !== 0) {
      return { ok: false, log: log.text(), error: `前置 build 失败(退出码 ${build.code ?? '未知'}),请查看打包日志` }
    }
  }

  // ② 定位产物
  const webOut = await locateWebOut(projectDir, req.buildOptions?.outDir)
  let zipPath = ''
  if (webOut) {
    zipPath = path.join(outDir, `${safeName}-web-${Date.now()}.zip`)
    onLine(`[Web 打包] 产物目录 ${webOut} → ${zipPath}`)
    await zipDir(webOut, zipPath, ['node_modules', '.git', 'env'], onLine, ctl)
  } else {
    // 没有构建产物:项目根本身就是静态站点(根目录 index.html)→ 整项目打包
    const rootIndex = path.join(projectDir, 'index.html')
    try {
      const st = await fsp.stat(rootIndex)
      if (!st.isFile()) throw new Error('no index.html')
      zipPath = path.join(outDir, `${safeName}-web-${Date.now()}.zip`)
      onLine(`[Web 打包] 未发现构建产物,项目根即静态站点 → ${zipPath}`)
      await zipDir(projectDir, zipPath, ['node_modules', '.git', 'dist', 'env', 'data', '.godot'], onLine, ctl)
    } catch {
      return {
        ok: false,
        log: log.text(),
        error:
          '没有找到可打包的 Web 产物:项目既没有 build 脚本/产物目录(dist/build/out/www),根目录也没有 index.html。请让软件节点产出 Web 应用(带 index.html),或先手动构建一次。',
      }
    }
  }

  if (ctl.isKilled()) return cancelledResult(log.text())
  let st
  try {
    st = await fsp.stat(zipPath)
  } catch {
    return { ok: false, log: log.text(), error: '压缩完成但找不到 zip 产物 —— 请检查输出目录' }
  }
  if (!st.isFile() || st.size === 0) {
    return { ok: false, log: log.text(), error: 'zip 产物为空 —— 构建产物目录里可能没有内容' }
  }
  onLine(`✔ Web 打包完成:${zipPath}(${(st.size / 1024 / 1024).toFixed(1)} MB)`)
  return {
    ok: true,
    artifactPath: zipPath,
    log:
      log.text() +
      '\n[Web 打包] 这是一份静态站点:解压后拖进任意静态托管(Nginx / GitHub Pages / Vercel)即可上线;' +
      '也可放到手机/服务器上直接访问 —— 这就是移动端入口。',
  }
}

/** 探测本机 Android SDK 根目录(常见三处:环境变量 / 本地 AppData) */
function detectAndroidSdk(): string | null {
  const env = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
  if (env && env.trim()) return env.trim()
  const local = path.join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk')
  try {
    return fs.statSync(local).isDirectory() ? local : null
  } catch {
    return null
  }
}

/**
 * Android 打包(v0.6.0):
 *   ① 有 Android SDK → 项目跑 Capacitor 链路(add android + sync + gradle assembleDebug)真打 APK;
 *   ② 无 SDK / 无 Capacitor 依赖 → 自动降级为 Web 应用包(PWA),并在日志里给出两条安装路径:
 *       手机浏览器直接打开 / 装好 SDK 后重试。
 */
async function packageApk(req: BuiltinActionRequest, ctl: ProcControl): Promise<BuiltinActionResult> {
  const log = new LogTail()
  const onLine = (line: string): void => {
    log.push(line)
    req.onProgress?.(line)
  }
  if (!req.projectDir || !req.projectDir.trim()) {
    return { ok: false, log: '', error: '没有指定项目文件夹 —— 请先在项目节点上选择项目文件夹' }
  }
  const projectDir = req.projectDir.trim()

  const sdk = detectAndroidSdk()
  if (!sdk) {
    // 优雅降级:先出 Web 包,再给路径
    onLine('[APK 打包] 未检测到 Android SDK —— 自动降级为 Web 应用包(PWA)')
    const web = await packageWeb(req, ctl)
    return {
      ok: web.ok,
      artifactPath: web.artifactPath,
      log:
        web.log +
        '\n\n[APK 打包] 未检测到 Android SDK(ANDROID_HOME / %LOCALAPPDATA%\\Android\\Sdk)。' +
        '已降级产出 Web 应用包:解压后用手机浏览器打开即可使用(或部署到任意静态托管后扫码访问)。' +
        '要产出真正的 .apk:安装 Android Studio(含 SDK)后重试本节点,或将 Web 应用经 Capacitor 打包。',
      error: web.ok ? undefined : web.error,
    }
  }

  // 项目里要有 Capacitor 依赖
  let hasCapacitor = false
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, unknown>
    }
    hasCapacitor = Object.keys(pkg.dependencies ?? {}).some((k) => k.startsWith('@capacitor/'))
  } catch {
    hasCapacitor = false
  }
  if (!hasCapacitor) {
    onLine('[APK 打包] 项目没有安装 Capacitor —— 先注入依赖再打包')
    const install = await runNodeProcess(
      ['install', '@capacitor/core', '@capacitor/cli', '@capacitor/android', '--no-save'],
      projectDir,
      onLine,
      ctl,
    )
    if (install.killed) return cancelledResult(log.text())
    if (install.code !== 0) {
      return {
        ok: false,
        log: log.text(),
        error: `安装 Capacitor 失败(退出码 ${install.code ?? '未知'})。请让软件节点在 package.json 里带上 @capacitor 依赖,或手动 npm install。`,
      }
    }
  }

  const appName = (req.buildOptions?.appName ?? '').trim() || 'app'
  const appId = (req.buildOptions?.appId ?? '').trim() || 'com.chusiz.app'
  onLine('[APK 打包] 初始化 Android 平台(capacitor add android)…')
  const add = await runNodeProcess(
    ['--run', 'cap', '--', 'add', 'android'],
    projectDir,
    onLine,
    ctl,
  )
  // add 失败(平台已存在等)不致命 —— sync 会自己处理
  if (!add.killed && add.code !== 0) onLine(`[APK 打包] capacitor add 返回 ${add.code}(已存在则无碍),继续 sync…`)

  const sync = await runNodeProcess(['--run', 'cap', '--', 'sync', 'android'], projectDir, onLine, ctl)
  if (sync.killed) return cancelledResult(log.text())
  if (sync.code !== 0) {
    return {
      ok: false,
      log: log.text(),
      error: `capacitor sync 失败(退出码 ${sync.code ?? '未知'})。请检查项目能否正常构建 Web 产物(需先 npm run build)。`,
    }
  }

  onLine('[APK 打包] 执行 Gradle 构建(assembleDebug)…')
  const androidDir = path.join(projectDir, 'android')
  const gradlew = path.join(androidDir, 'gradlew.bat')
  const apk = await new Promise<string | null>((resolve, reject) => {
    // gradlew.bat 是批处理:必须经 cmd.exe 显式解释(shell:false 下这是标准做法,
    // 不用 shell:true —— 那样会把整条命令交给 cmd 的引号解析)。
    const child: ChildProcess = spawn(
      'cmd.exe',
      ['/d', '/s', '/c', `"${gradlew}" assembleDebug --no-daemon`],
      {
        cwd: androidDir,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ANDROID_HOME: sdk },
        windowsHide: true,
      },
    )
    ctl.register(child)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    const pump = (d: string): void => {
      const line = d.trim()
      if (line) {
        onLine(line)
        log.push(line)
      }
    }
    child.stdout?.on('data', pump)
    child.stderr?.on('data', pump)
    child.on('error', reject)
    child.on('close', (code) => {
      ctl.unregister()
      if (ctl.isKilled()) {
        resolve(null)
        return
      }
      if (code !== 0) {
        reject(new Error(`Gradle 退出码 ${code ?? '未知'}`))
        return
      }
      resolve(null)
    })
  }).then(async () => {
    // 定位产物:android/app/build/outputs/apk/debug/app-debug.apk
    const base = path.join(projectDir, 'android', 'app', 'build', 'outputs', 'apk', 'debug')
    const files = await fsp.readdir(base).catch(() => [] as string[])
    const apkFile = files.find((f) => f.endsWith('.apk'))
    return apkFile ? path.join(base, apkFile) : null
  }).catch((e: unknown) => {
    if (ctl.isKilled()) return null
    onLine(`[APK 打包] Gradle 构建失败:${e instanceof Error ? e.message : String(e)}`)
    return null
  })

  if (ctl.isKilled()) return cancelledResult(log.text())
  if (!apk) {
    return {
      ok: false,
      log: log.text(),
      error: 'Gradle 构建未产出 .apk 文件 —— 请查看日志,或在 android/ 目录手动运行 gradlew assembleDebug 排查。',
    }
  }
  onLine(`✔ APK 打包完成:${apk}`)
  return { ok: true, artifactPath: apk, log: log.text() }
}
