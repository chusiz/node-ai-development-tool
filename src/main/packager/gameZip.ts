import { spawn, type ChildProcess } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { BuiltinActionRequest, BuiltinActionResult } from './types'
import { killProcessTree } from '../agents/kill'

/**
 * 游戏项目打包(v0.4.1):Godot 项目是"文件夹即项目" —— 交付形态 = zip。
 *
 * 用系统自带 PowerShell 的 Compress-Archive(Windows 无需装任何东西):
 *   ① 建 `<项目>/dist`(产物目录,与 exe 打包同一约定);
 *   ② 压缩**项目根下除 dist 之外的全部内容**(否则会把 zip 自己压进去);
 *   ③ 产出 `<项目>/dist/<appName或project>-<ts>.zip`。
 *
 * 排除规则保持最小:只排 dist(自己)和 .godot/缓存(Godot 自动生成的,
 * 体积大且无交付价值)。其余原样打包 —— 交付物必须能直接解压后
 * 用 Godot 4.x 打开运行。
 */
export async function zipGameProject(req: BuiltinActionRequest, ctl: ZipCtl): Promise<BuiltinActionResult> {
  const logs: string[] = []
  const onLine = (line: string): void => {
    logs.push(line)
    req.onProgress?.(line)
  }

  if (!req.projectDir || !req.projectDir.trim()) {
    return {
      ok: false,
      log: '',
      error: '没有指定项目文件夹 —— 请先在项目节点上选择项目文件夹',
    }
  }
  const projectDir = req.projectDir.trim()
  const outDir = path.join(projectDir, 'dist')
  try {
    await fsp.mkdir(outDir, { recursive: true })
  } catch (e) {
    return { ok: false, log: logs.join('\n'), error: `创建输出目录失败:${e instanceof Error ? e.message : String(e)}` }
  }

  const appName = (req.buildOptions?.appName ?? '').trim() || 'game'
  const safeName = appName.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'game'
  const zipPath = path.join(outDir, `${safeName}-${Date.now()}.zip`)

  onLine(`[游戏打包] 打包项目目录 → ${zipPath}`)

  // PowerShell 命令:列项目根一级条目,排除 dist / .godot,压缩到 zip。
  // 路径经单引号字面化(内含单引号翻倍),-LiteralPath 避开通配符解析。
  const q = (s: string): string => `'${s.replace(/'/g, "''")}'`
  const ps = [
    `$items = Get-ChildItem -LiteralPath ${q(projectDir)} -Force | Where-Object { $_.Name -ne 'dist' -and $_.Name -ne '.godot' }`,
    `if ($items.Count -eq 0) { Write-Error '项目文件夹里没有可打包的内容'; exit 1 }`,
    `Compress-Archive -Path $items.FullName -DestinationPath ${q(zipPath)} -CompressionLevel Optimal`,
  ].join('; ')

  await new Promise<void>((resolve, reject) => {
    const child: ChildProcess = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true },
    )
    ctl.register?.(child)
    let errTail = ''
    child.stderr?.on('data', (d: Buffer) => {
      errTail = (errTail + d.toString()).slice(-2000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      ctl.unregister?.()
      if (ctl.isKilled?.()) {
        resolve()
        return
      }
      if (code === 0) resolve()
      else reject(new Error(`PowerShell 退出码 ${code ?? '未知'}${errTail ? ' · ' + errTail.slice(0, 300) : ''}`))
    })
  }).catch((e: unknown) => {
    if (ctl.isKilled?.()) return // 已取消:不报错
    throw e
  })

  if (ctl.isKilled?.()) {
    return { ok: false, log: logs.join('\n'), error: '打包已取消' }
  }

  // 产物确认(可能失败的读回):zip 存在且 > 0 字节才算成功
  let st
  try {
    st = await fsp.stat(zipPath)
  } catch {
    return { ok: false, log: logs.join('\n'), error: '压缩完成但找不到 zip 产物 —— 请检查输出目录' }
  }
  if (!st.isFile() || st.size === 0) {
    return { ok: false, log: logs.join('\n'), error: 'zip 产物为空 —— 项目文件夹里可能没有内容' }
  }

  onLine(`✔ 打包完成:${zipPath}(${(st.size / 1024 / 1024).toFixed(1)} MB)`)
  return {
    ok: true,
    artifactPath: zipPath,
    log: logs.join('\n'),
  }
}

/** 与 electron-builder 的 ProcControl 同形状(取消/退出链路共用) */
export interface ZipCtl {
  register?(child: ChildProcess): void
  unregister?(): void
  isKilled?(): boolean
}

/** 取消正在跑的 zip 打包(powershell 子进程树) */
export function killZip(child: ChildProcess | undefined): void {
  if (child?.pid) void killProcessTree(child.pid)
}
