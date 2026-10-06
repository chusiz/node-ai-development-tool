import { existsSync } from 'node:fs'
import type { AgentAdapter, NodeEvent, SessionOptions } from '../types'
import { locateClaude } from './locator'
import { sanitizeEnv } from './env'
import { normalizeClaudeEvent, extractClaudeSessionId } from './normalize'
import { SKILLS_ROOT } from '../../paths'

export const claudeAdapter: AgentAdapter = {
  id: 'claude',
  displayName: 'Claude Code',

  // prompt 走 stdin:规避 Windows 32767 字符 argv 上限,且免去全部引号转义
  promptDelivery: 'stdin',
  lineMode: 'json',

  capabilities: {
    headless: true,
    streamJson: true,
    resume: true,
    specifySessionId: true,
    tools: true,
    fork: true,
  },

  async detect(configuredPath?: string) {
    try {
      return await locateClaude(configuredPath)
    } catch {
      return null
    }
  },

  // promptDelivery 是 'stdin',所以这里的 prompt 参数**故意不用**
  buildArgs(opts: SessionOptions): string[] {
    // -p = 无头;stream-json 需要 --verbose 才会吐出完整事件流
    const args = ['-p', '--output-format', 'stream-json', '--verbose']

    // 首轮自己指定 id(不必等 init 回传);后续轮用 resume 接续
    if (opts.isFirstTurn) {
      args.push('--session-id', opts.sessionId)
    } else {
      args.push('--resume', opts.sessionId)
    }

    // 扇出到多节点时用分叉,不污染原始会话
    if (opts.fork) args.push('--fork-session')

    if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode)

    if (opts.dangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions')
    } else {
      // ⚠️ 最隐蔽的坑:我们不是 SDK 宿主,没人应答权限询问。
      // 不显式给 none 的话,任何需要询问的操作都会让进程**永久挂起**,
      // 表现就是节点一直转圈。见 plan §5.4 三层防御。
      args.push('--permission-prompts', 'none')
    }

    if (opts.maxBudgetUsd != null) {
      args.push('--max-budget-usd', String(opts.maxBudgetUsd))
    }

    /*
     * 全局技能库。`--plugin-dir` 是**实测**出来的注入方式(不是照文档抄的):
     * 同一个临时 plugin 目录,加这个参数 `claude -p "列出你能用的技能"` 里
     * 出现 `haowan-skills:zzprobe`,去掉就不出现。
     *
     * ⚠️ 不是 `--add-dir`。本机 `claude --help` 里 `--add-dir` 的原文是
     * "Additional directories to allow tool access to" —— 它管的是工具能碰
     * 哪些文件,不是上下文。
     *
     * 目录不存在就不加:指一个不存在的路径给 claude 会得到一个启动告警,
     * 而"用户还没装过任何技能"完全正常,不该有噪音。
     */
    if (existsSync(SKILLS_ROOT)) args.push('--plugin-dir', SKILLS_ROOT)

    if (opts.extraArgs?.length) args.push(...opts.extraArgs)

    return args
  },

  parseEvent(obj: unknown): NodeEvent[] {
    return normalizeClaudeEvent(obj)
  },

  extractSessionId(obj: unknown): string | null {
    return extractClaudeSessionId(obj)
  },

  sanitizeEnv(env: NodeJS.ProcessEnv, nodeId?: string): NodeJS.ProcessEnv {
    // ⚠️ nodeId 必须透传:env.ts 一直支持注入 HAOWAN_NODE_ID,
    // 但之前这里没往下传,导致那个能力从来没生效过。
    return sanitizeEnv(env, nodeId)
  },
}
