import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'

const run = promisify(execFile)

/**
 * 通用的 CLI 定位器 —— 从 claude 专用的那一版泛化而来(v0.4.0)。
 *
 * ## 为什么不能只靠 `where`
 *
 * Windows 上 npm 全局安装的命令行工具,`where xxx` 拿到的**首先**是
 * `xxx.cmd`(一个批处理壳),而 Node 从 18.20 起出于安全考虑**拒绝**直接
 * spawn `.cmd`/`.bat`(除非 `shell: true`,那又会引入 cmd.exe 的引号与
 * GBK 代码页两个坑)。所以必须把壳里的**真实入口**挖出来。
 *
 * ## 壳里可能是两种东西
 *
 * ```
 * claude.cmd   →  "…\@anthropic-ai\claude-code\bin\claude.exe"  %*     ← 原生二进制
 * gemini.cmd   →  node "…\@google\gemini-cli\dist\index.js"  %*        ← 纯 JS 包
 * ```
 *
 * 第一种直接 spawn 那个 exe 就行。第二种必须**替它找到 node**,再把脚本路径
 * 作为第一个参数传进去 —— 否则我们 spawn 的会是 Electron 自己的 exe,
 * 而 `process.execPath` 在打包后指向应用本体,拿它跑别人的脚本必然失败。
 * 这就是 `prefixArgs` 存在的原因。
 */

export interface CliLocation {
  /** 最终要 spawn 的可执行文件 */
  exe: string
  /** 需要拼在真实参数之前的固定参数(node 跑 .js 时的脚本路径) */
  prefixArgs: string[]
  version: string | null
  source: 'configured' | 'npm-bin' | 'path-exe' | 'cmd-shim' | 'node-shim'
  /** 探测过程中尝试过的路径,失败时全部回报给用户 */
  tried: string[]
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile()
  } catch {
    return false
  }
}

async function readVersion(exe: string, prefixArgs: string[]): Promise<string | null> {
  try {
    const { stdout } = await run(exe, [...prefixArgs, '--version'], {
      windowsHide: true,
      timeout: 25_000,
    })
    return stdout.trim().split(/\r?\n/)[0] || null
  } catch {
    return null
  }
}

/** 找真正的 node。**不能用 process.execPath** —— 打包后那指向本应用自己 */
async function findNode(): Promise<string | null> {
  try {
    const { stdout } = await run('where', ['node'], { windowsHide: true, timeout: 15_000 })
    for (const line of stdout.split(/\r?\n/)) {
      const p = line.trim()
      if (p.toLowerCase().endsWith('.exe') && (await isFile(p))) return p
    }
  } catch {
    /* where 不可用,试常见位置 */
  }
  const guesses = [
    process.env['ProgramFiles'] ? path.join(process.env['ProgramFiles'], 'nodejs', 'node.exe') : '',
    process.env['ProgramFiles(x86)']
      ? path.join(process.env['ProgramFiles(x86)'], 'nodejs', 'node.exe')
      : '',
    process.env['APPDATA'] ? path.join(process.env['APPDATA'], '..', '..', 'nodejs', 'node.exe') : '',
  ].filter(Boolean)
  for (const g of guesses) {
    if (await isFile(g)) return g
  }
  return null
}

/**
 * 从 `.cmd` / 无扩展名的 shim 里挖出真实入口。
 *
 * 先找 `.exe` 引用(原生二进制包装,最理想),再找 `.js`(纯 Node 包)。
 * 两个都没有就返回 null —— 那种 shim 我们确实跑不起来,如实报告比硬 spawn 好。
 */
async function inspectShim(
  shimPath: string,
): Promise<{ exe: string; prefixArgs: string[] } | null> {
  let content: string
  try {
    content = await fs.readFile(shimPath, 'utf8')
  } catch {
    return null
  }

  // ① 引用了某个 .exe
  const exeMatch = content.match(/"([^"]*\.exe)"/i)
  if (exeMatch) {
    const abs = path.resolve(path.dirname(shimPath), exeMatch[1])
    if (await isFile(abs)) return { exe: abs, prefixArgs: [] }
  }

  // ② 引用了某个 .js / .mjs / .cjs —— 需要 node 转发
  const jsMatch = content.match(/"([^"]*\.(?:js|mjs|cjs))"/i)
  if (jsMatch) {
    const script = path.resolve(path.dirname(shimPath), jsMatch[1])
    if (await isFile(script)) {
      const node = await findNode()
      if (node) return { exe: node, prefixArgs: [script] }
    }
  }

  return null
}

/** Windows 上没有扩展名的 shim(部分包会同时放一个)当作 .cmd 看 */
async function shimCandidates(base: string): Promise<string[]> {
  if (process.platform !== 'win32') return [base]
  const out: string[] = []
  if (!/\.[a-z0-9]+$/i.test(base)) {
    out.push(`${base}.cmd`, `${base}.exe`, `${base}.bat`, base)
    // npm 在 Windows 上也会生成 .ps1,我们用不上,但列进 tried 里更完整
  } else {
    out.push(base)
  }
  return out
}

export interface LocateOptions {
  /** 命令名,如 `claude` / `codebuddy` / `codex` */
  command: string
  /**
   * npm 全局安装时,包内原生二进制的候选相对路径
   * (相对 `%APPDATA%\npm\node_modules`)。命中它就能绕开 .cmd 壳。
   */
  npmBins: string[]
  configuredPath?: string
  /** 给 --version 用的前置参数(极少数 CLI 需要) */
  versionPrefixArgs?: string[]
}

export async function locateCli(o: LocateOptions): Promise<CliLocation> {
  const tried: string[] = []
  const vPrefix = o.versionPrefixArgs ?? []

  // ① 用户显式配置的最高优先
  if (o.configuredPath && o.configuredPath.trim()) {
    const p = o.configuredPath.trim()
    tried.push(p)
    if (await isFile(p)) {
      // 用户也可能配一个 .cmd —— 同样要解析
      if (/\.(cmd|bat)$/i.test(p)) {
        const inner = await inspectShim(p)
        if (inner) {
          return {
            ...inner,
            version: await readVersion(inner.exe, [...inner.prefixArgs, ...vPrefix]),
            source: 'configured',
            tried,
          }
        }
      }
      return {
        exe: p,
        prefixArgs: [...vPrefix],
        version: await readVersion(p, vPrefix),
        source: 'configured',
        tried,
      }
    }
  }

  // ② npm 全局包里的原生二进制(能在 PATH 之前命中,避免拿到 .cmd)
  const appData = process.env.APPDATA
  if (appData) {
    for (const rel of o.npmBins) {
      const p = path.join(appData, 'npm', 'node_modules', ...rel.split('/'))
      tried.push(p)
      if (await isFile(p)) {
        return { exe: p, prefixArgs: [...vPrefix], version: await readVersion(p, vPrefix), source: 'npm-bin', tried }
      }
    }
  }

  // ③ PATH。先找 .exe,再退回解析 shim
  try {
    const { stdout } = await run('where', [o.command], { windowsHide: true, timeout: 15_000 })
    const candidates = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)

    for (const c of candidates) {
      tried.push(c)
      if (c.toLowerCase().endsWith('.exe') && (await isFile(c))) {
        return { exe: c, prefixArgs: [...vPrefix], version: await readVersion(c, vPrefix), source: 'path-exe', tried }
      }
    }
    for (const c of candidates) {
      if (!/\.(cmd|bat)$/i.test(c)) continue
      const inner = await inspectShim(c)
      if (inner) {
        return {
          ...inner,
          version: await readVersion(inner.exe, [...inner.prefixArgs, ...vPrefix]),
          // 有 prefixArgs 说明是"node + 脚本";没有就是原生 exe 包装。
          // 分开记是为了排查时说得出"它到底是怎么被拉起来的"
          source: inner.prefixArgs.length ? 'node-shim' : 'cmd-shim',
          tried,
        }
      }
    }
  } catch {
    /* where 不可用或找不到,继续 */
  }

  // ④ 最后试无扩展名/其它后缀的 shim(npm 在某些配置下会生成)
  for (const base of await shimCandidates(o.command)) {
    if (tried.includes(base)) continue
    tried.push(base)
    if (!(await isFile(base))) continue
    const inner = await inspectShim(base)
    if (inner) {
      return {
        ...inner,
        version: await readVersion(inner.exe, [...inner.prefixArgs, ...vPrefix]),
        source: inner.prefixArgs.length ? 'node-shim' : 'cmd-shim',
        tried,
      }
    }
  }

  throw new Error(
    [`未能定位 ${o.command} 可执行文件。`, '已尝试以下位置:', ...tried.map((t) => '  ' + t)].join('\n'),
  )
}
