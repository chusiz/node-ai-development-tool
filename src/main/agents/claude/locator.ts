import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'

const run = promisify(execFile)

export interface ClaudeLocation {
  /** 真正的可执行文件路径(永远是 .exe,不是 .cmd) */
  exe: string
  version: string | null
  /** 从哪一级找到的,便于排查 */
  source: 'configured' | 'npm-package-bin' | 'path-exe' | 'cmd-shim'
  /** 探测过程中尝试过的路径 */
  tried: string[]
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile()
  } catch {
    return false
  }
}

/**
 * 从 .cmd 壳里提取真实 .exe 路径。
 *
 * claude.cmd 的实际内容形如:
 *   "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
 * 直接 spawn .cmd 必须经过 cmd.exe,会引入引号转义和 GBK 代码页两个坑,
 * 所以这里一定要把真实 exe 解析出来。
 */
async function resolveCmdShim(cmdPath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(cmdPath, 'utf8')
    const m = content.match(/"([^"]*\.exe)"/i)
    if (!m) return null
    const abs = path.resolve(path.dirname(cmdPath), m[1])
    return (await isFile(abs)) ? abs : null
  } catch {
    return null
  }
}

async function readVersion(exe: string): Promise<string | null> {
  try {
    const { stdout } = await run(exe, ['--version'], { windowsHide: true, timeout: 20_000 })
    return stdout.trim().split(/\r?\n/)[0] || null
  } catch {
    return null
  }
}

/**
 * 定位 claude 可执行文件,多级回退。
 *
 * 优先级:用户显式配置 > npm 包内原生二进制 > PATH 里的 .exe > 从 .cmd 壳解析。
 * 返回的 exe 一定是可直接 spawn 的 .exe —— 这是绕开 cmd.exe 的前提。
 */
export async function locateClaude(configuredPath?: string): Promise<ClaudeLocation> {
  const tried: string[] = []

  if (configuredPath) {
    tried.push(configuredPath)
    if (await isFile(configuredPath)) {
      return {
        exe: configuredPath,
        version: await readVersion(configuredPath),
        source: 'configured',
        tried,
      }
    }
  }

  // 本机实测路径,优先级最高(能在 PATH 之前命中,避免拿到 .cmd)
  const appData = process.env.APPDATA
  if (appData) {
    const p = path.join(
      appData,
      'npm',
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe',
    )
    tried.push(p)
    if (await isFile(p)) {
      return { exe: p, version: await readVersion(p), source: 'npm-package-bin', tried }
    }
  }

  try {
    const { stdout } = await run('where', ['claude'], { windowsHide: true, timeout: 15_000 })
    const candidates = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)

    // 先找 .exe
    for (const c of candidates) {
      tried.push(c)
      if (c.toLowerCase().endsWith('.exe') && (await isFile(c))) {
        return { exe: c, version: await readVersion(c), source: 'path-exe', tried }
      }
    }
    // 退而求其次:从 .cmd 壳里挖出真实 exe
    for (const c of candidates) {
      if (c.toLowerCase().endsWith('.cmd')) {
        const real = await resolveCmdShim(c)
        if (real) {
          return { exe: real, version: await readVersion(real), source: 'cmd-shim', tried }
        }
      }
    }
  } catch {
    /* where 不可用或找不到,继续 */
  }

  throw new Error(
    ['未能定位 claude 可执行文件。', '已尝试以下路径:', ...tried.map((t) => '  ' + t)].join('\n'),
  )
}
