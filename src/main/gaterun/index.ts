/**
 * 闸门(Gate)节点执行器(v0.6.5 反馈闭环):
 *   - mode=exit:在项目目录跑一条命令,退出码 0 = 通过;
 *   - mode=text:对上游产出文本做校验(contains / not-contains / regex)。
 * 不通过 = ok:false + 人话错误(含判定详情与修复提示),由调度器拦住下游并触发自动修复。
 *
 * 纯 node 实现(无 electron 依赖),e2e 的假 env 有同款逻辑的分支。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { BuiltinActionRequest, BuiltinActionResult } from '../workflow/builtinAction'

function runExit(
  r: BuiltinActionRequest,
  command: string,
  timeoutSec: number,
): Promise<BuiltinActionResult> {
  return new Promise((resolve) => {
    /*
     * shell 路径显式化:Windows 下 spawn 的 shell:true 依赖 PATH 里的 cmd.exe,
     * 在受限/沙箱环境可能 ENOENT。ComSpec 是系统登记的 cmd 绝对路径,更稳;
     * 非 Windows 回落到 /bin/sh(spawn 会自己找)。
     *
     * ⚠️ cwd 必须真实存在:Windows 上 cwd 指向不存在的目录会让 spawn 报
     * "spawn cmd.exe ENOENT"(chdir 失败伪装成找不到 shell)。目录不存在时
     * 回退到当前进程 cwd,并给用户明示。
     */
    const shell = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh'
    const cwd = r.projectDir && existsSync(r.projectDir) ? r.projectDir : undefined
    const child = spawn(command, {
      cwd,
      shell,
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      child.kill()
      resolve({
        ok: false,
        log: '[闸门] 命令超时',
        error: `闸门命令超过 ${timeoutSec}s 未结束,已中止(命令:${command})`,
      })
    }, Math.max(1, Math.min(3600, timeoutSec)) * 1000)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += String(d)))
    child.stderr.on('data', (d) => (stderr += String(d)))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, log: stderr, error: `闸门命令无法启动:${e.message}(命令:${command})` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const tail = (stderr || stdout).slice(-400)
      if (code === 0) {
        resolve({ ok: true, log: `[闸门] 命令通过(exit 0):${command}`, handoffText: `[闸门] 通过:${command}` })
      } else {
        const hint = (r.gateParams?.hint ?? '').trim()
        resolve({
          ok: false,
          log: stderr,
          error: `闸门未通过:命令退出码 ${code}(命令:${command})${tail ? `\n${tail}` : ''}${hint ? `\n修复提示:${hint}` : ''}`,
        })
      }
    })
  })
}

function runText(r: BuiltinActionRequest): BuiltinActionResult {
  const g = r.gateParams ?? { mode: 'text' as const }
  const rule = g.textRule ?? 'contains'
  const pattern = (g.pattern ?? '').trim()
  const text = r.prompt ?? ''
  const hint = (g.hint ?? '').trim()

  let passed = false
  let detail = ''
  if (rule === 'contains') {
    passed = pattern !== '' && text.includes(pattern)
    detail = `包含「${pattern}」`
  } else if (rule === 'not-contains') {
    passed = pattern === '' || !text.includes(pattern)
    detail = `不包含「${pattern}」`
  } else {
    try {
      passed = pattern !== '' && new RegExp(pattern).test(text)
      detail = `匹配正则「${pattern}」`
    } catch (e) {
      return {
        ok: false,
        log: '[闸门] 正则非法',
        error: `闸门规则里的正则不合法:${(e as Error).message} —— 请检查 pattern`,
      }
    }
  }

  if (passed) {
    return { ok: true, log: `[闸门] 校验通过(${detail})`, handoffText: `[闸门] 通过(${detail})` }
  }
  const snippet = text.length > 200 ? text.slice(0, 200) + '…' : text
  return {
    ok: false,
    log: '[闸门] 校验未通过',
    error: `闸门未通过:要求${detail},但上游产出不满足${hint ? `\n修复提示:${hint}` : ''}\n上游产出开头:${snippet}`,
  }
}

export class GateRunner {
  async run(r: BuiltinActionRequest): Promise<BuiltinActionResult> {
    const g = r.gateParams ?? { mode: 'text' as const, textRule: 'contains' as const }
    if (g.mode === 'exit') {
      const cmd = (g.command ?? '').trim()
      if (!cmd) {
        return { ok: false, log: '', error: '闸门选了「跑命令」但没填命令(在节点面板里填)' }
      }
      return runExit(r, cmd, g.timeoutSec ?? 120)
    }
    return runText(r)
  }

  cancel(_id: string): boolean {
    /* 命令级超时即可,不做全局 kill */
    return false
  }

  killAll(): void {
    /* 无全局状态 */
  }
}
