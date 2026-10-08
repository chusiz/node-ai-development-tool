/**
 * Python 节点执行器(v0.6.4,改进建议第七条"多语言节点支持"):
 * 子进程跑一段 Python 脚本,stdout 作为节点产出交给下游。
 *
 * 形态:节点配置里写脚本(或脚本文件相对路径)+ 可选参数;
 * 执行器把脚本落到项目目录 `assets/scripts/<nodeId>.py`,用本机 python 运行,
 * 工作目录 = 项目目录(权限最小化:只能在项目内写文件)。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { BuiltinActionRequest, BuiltinActionResult } from '../workflow/builtinAction'

export interface PythonParams {
  /** 脚本本体(python 源码)。优先于 scriptPath */
  script?: string
  /** 脚本文件相对项目目录的路径(script 为空时读取它) */
  scriptPath?: string
  /** 传给脚本的命令行参数(逐项,不做 shell 展开) */
  args?: string[]
  /** python 可执行文件;空 = 用 PATH 里的 python */
  pythonPath?: string
  /** 超时(秒),缺省 300 */
  timeoutSec?: number
}

const RUNNING = new Set<string>()

export class PythonRunner {
  async run(req: BuiltinActionRequest): Promise<BuiltinActionResult> {
    const p: PythonParams = req.pythonParams ?? {}
    if (!req.projectDir) {
      return { ok: false, log: '', error: 'Python 节点需要一个项目目录:先放一个项目节点并指定目录。' }
    }
    const script = p.script?.trim() ?? ''
    const scriptPath = p.scriptPath?.trim() ?? ''
    if (!script && !scriptPath) {
      return { ok: false, log: '', error: 'Python 节点没写脚本:在配置里填 Python 代码,或指定一个 .py 文件路径。' }
    }

    const scriptsDir = path.join(req.projectDir, 'assets', 'scripts')
    try {
      await fs.promises.mkdir(scriptsDir, { recursive: true })
    } catch {
      /* 目录建不出就由下面的写盘报错 */
    }

    let file: string
    let source: string
    if (script) {
      file = path.join(scriptsDir, `${req.nodeId}.py`)
      source = script
      try {
        await fs.promises.writeFile(file, source, 'utf8')
      } catch (e) {
        return { ok: false, log: '', error: `写脚本失败:${(e as Error).message}` }
      }
    } else {
      file = path.resolve(req.projectDir, scriptPath)
      if (!fs.existsSync(file)) {
        return { ok: false, log: '', error: `脚本文件不存在:${scriptPath}(相对项目目录)。` }
      }
      try {
        source = await fs.promises.readFile(file, 'utf8')
      } catch (e) {
        return { ok: false, log: '', error: `读脚本失败:${(e as Error).message}` }
      }
    }

    const python = p.pythonPath?.trim() || 'python'
    const timeoutSec = p.timeoutSec ?? 300
    RUNNING.add(req.nodeId)

    return new Promise<BuiltinActionResult>((resolve) => {
      const child = spawn(python, [file, ...(p.args ?? [])], {
        cwd: req.projectDir,
        windowsHide: true,
        shell: false,
      })
      const timer = setTimeout(() => {
        RUNNING.delete(req.nodeId)
        child.kill('SIGKILL')
        resolve({
          ok: false,
          log: logs.join('\n').slice(0, 4000),
          error: `Python 执行超时(>${timeoutSec}s),已终止。`,
        })
      }, timeoutSec * 1000)

      let logs: string[] = []
      const push = (d: Buffer): void => {
        const line = d.toString('utf8').trim()
        if (line) {
          logs.push(line)
          req.onProgress?.(line)
        }
      }
      child.stdout.on('data', push)
      child.stderr.on('data', push)
      child.on('error', (e) => {
        clearTimeout(timer)
        RUNNING.delete(req.nodeId)
        resolve({
          ok: false,
          log: logs.join('\n').slice(0, 4000),
          error: `启动 python 失败:${e.message}。检查 Python 是否安装 / pythonPath 是否配对。`,
        })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        RUNNING.delete(req.nodeId)
        const log = logs.join('\n')
        const out = log.length > 6000 ? log.slice(-6000) : log
        if (code === 0) {
          resolve({ ok: true, handoffText: out, artifacts: [], log: out })
        } else {
          resolve({
            ok: false,
            exitCode: code,
            log: out,
            error: `Python 脚本退出码 ${code}。stdout/stderr 见上方日志。`,
          })
        }
      })
    })
  }

  cancel(nodeId: string): boolean {
    return RUNNING.delete(nodeId)
  }
}
