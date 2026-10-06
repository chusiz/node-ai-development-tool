import type { AgentAdapter, AgentDetectResult, SessionOptions } from '../types'
import type { AgentCapabilities, NodeEvent } from '../../../shared/ipc'
import { locateCli } from './locator'
import {
  extractCodexSessionId,
  extractGeminiSessionId,
  normalizeCodexEvent,
  normalizeGeminiEvent,
  plainTextEvents,
} from './normalize'
import { normalizeClaudeEvent, extractClaudeSessionId } from '../claude/normalize'

/**
 * CLI 型 agent 的**声明式规格表**。
 *
 * ## 为什么是表 + 工厂,而不是七个手写的 adapter 文件
 *
 * 七个 adapter 里,真正的差异只有四样:命令名、参数怎么拼、事件怎么解析、
 * 要清哪些环境变量。其余(detect 的多级回退、sanitizeEnv 的公共部分、
 * parseEvent 的分派、lineMode 的推断)完全一样。手写七遍等于把同一段逻辑
 * 复制七份,而其中任何一份的 bug 都要单独修。
 *
 * 所以这里只描述**差异**,公共部分由 buildCliAdapter 统一实现。
 * 加第 8 个 CLI = 往 CLI_SPECS 里加一条。
 *
 * ## ⚠️ 关于 `verified`
 *
 * 参数与事件格式都是从各家的官方文档抄的,**只有 Claude 那一条是本机实测过的**
 * (它走的是另一条历史路径,见 claude/adapter.ts)。所以每条都带一个
 * `verified` 标记,UI 上如实显示为"已实测"或"按官方文档接入" ——
 * 用户看到后者时就知道:如果行为不对,大概率是这个 CLI 版本变了,
 * 而不是他配错了。这类诚实比假装全都验证过有用得多。
 */

/* ---------------- 环境变量净化 ---------------- */

/**
 * 公共要清的变量。这两个是**真实的代码执行面**,不是"可能串扰":
 *   ELECTRON_RUN_AS_NODE —— 不清的话,Electron 系的子进程会退化成裸 node
 *   NODE_OPTIONS          —— 可以注入 --require,等于任意代码执行
 */
const COMMON_EXACT = ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']

function makeSanitizer(exact: string[], prefixes: string[]) {
  return (env: NodeJS.ProcessEnv, nodeId?: string): NodeJS.ProcessEnv => {
    const out: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) continue
      if (COMMON_EXACT.includes(k)) continue
      if (exact.includes(k)) continue
      if (prefixes.some((p) => k.startsWith(p))) continue
      out[k] = v
    }
    // 便于在任务管理器里分辨是哪个节点起的进程(与 claude 那条路一致)
    if (nodeId) out.HAOWAN_NODE_ID = nodeId
    return out
  }
}

/* ---------------- 规格 ---------------- */

interface CliSpec {
  id: string
  displayName: string
  /** 命令名(PATH 上找的就是它) */
  command: string
  /** npm 全局包内原生二进制的候选相对路径(相对 %APPDATA%\npm\node_modules) */
  npmBins: string[]
  /** 给用户看的安装命令 */
  installCmd: string
  docsUrl?: string
  capabilities: AgentCapabilities
  promptDelivery: 'stdin' | 'argv'
  lineMode: 'json' | 'text'
  parser: (obj: unknown, ts?: number) => NodeEvent[]
  extractSessionId: (obj: unknown) => string | null
  /** argv 模式:把 prompt 拼成参数。stdin 模式下不需要 */
  promptArgs?: (prompt: string) => string[]
  buildArgs(o: SessionOptions): string[]
  sanitize(env: NodeJS.ProcessEnv, nodeId?: string): NodeJS.ProcessEnv
  verified: boolean
  note?: string
}

/** 权限模式 → Codex 的沙箱档位 */
function codexSandbox(mode: SessionOptions['permissionMode']): string {
  if (mode === 'plan') return 'read-only'
  if (mode === 'bypassPermissions') return 'danger-full-access'
  // acceptEdits / auto / dontAsk / manual 都落这一档
  return 'workspace-write'
}

/** 权限模式 → Gemini 的审批档位 */
function geminiApproval(mode: SessionOptions['permissionMode']): string {
  if (mode === 'plan') return 'default'
  if (mode === 'bypassPermissions') return 'yolo'
  return 'auto_edit'
}

export const CLI_SPECS: readonly CliSpec[] = [
  {
    id: 'codebuddy',
    displayName: 'CodeBuddy(腾讯)',
    command: 'codebuddy',
    npmBins: [
      '@tencent-ai/codebuddy-code/bin/codebuddy.exe',
      '@tencent-ai/codebuddy-code/bin/cbc.exe',
      '@tencent-ai/codebuddy-code/bin/codebuddy',
    ],
    installCmd: 'npm i -g @tencent-ai/codebuddy-code',
    docsUrl: 'https://www.codebuddy.cn/docs/cli/quickstart',
    capabilities: {
      headless: true,
      streamJson: true,
      resume: true,
      specifySessionId: true,
      tools: true,
      fork: false,
    },
    promptDelivery: 'stdin',
    lineMode: 'json',
    // CodeBuddy 的事件体系与 Claude Code 同源(它的 headless 文档里
    // init / assistant / result 三类消息的结构一致),所以复用同一套归一化。
    // 万一某天它改了格式,未知事件会落到 raw 而不是崩掉。
    parser: normalizeClaudeEvent,
    extractSessionId: extractClaudeSessionId,
    buildArgs(o) {
      const args = ['-p', '--output-format', 'stream-json', '--verbose']
      if (o.isFirstTurn) args.push('--session-id', o.sessionId)
      else args.push('--resume', o.sessionId)
      if (o.permissionMode) args.push('--permission-mode', o.permissionMode)
      /*
       * ⚠️ 与 Claude 不同,CodeBuddy **没有** `--permission-prompts none`
       * (它的文档明确说 --permission-prompt-tool 不支持)。
       * 靠 --permission-mode 就能避免无人应答时的挂起 —— 所以这里不抄 Claude 那行。
       */
      if (o.dangerouslySkipPermissions) args.push('-y')
      return args
    },
    sanitize: makeSanitizer(
      ['CODEBUDDY_CLI', 'CODEBUDDY', 'CBC'],
      ['CODEBUDDY_', 'CBC_'],
    ),
    verified: false,
    note: '腾讯云官方 CLI。参数与事件体系与 Claude Code 同源,但未在本机实测。',
  },

  {
    id: 'codex',
    displayName: 'Codex CLI(OpenAI)',
    command: 'codex',
    npmBins: ['@openai/codex/bin/codex.exe', '@openai/codex/bin/codex-x86_64-pc-windows-msvc.exe'],
    installCmd: 'npm i -g @openai/codex',
    docsUrl: 'https://developers.openai.com/codex/non-interactive-mode',
    capabilities: {
      headless: true,
      streamJson: true,
      resume: true,
      // Codex 不让我们指定 session id —— 它自己生成 thread_id,我们从
      // thread.started 事件里取回来。所以 specifySessionId 是 false
      specifySessionId: false,
      tools: true,
      fork: false,
    },
    promptDelivery: 'argv',
    lineMode: 'json',
    parser: normalizeCodexEvent,
    extractSessionId: extractCodexSessionId,
    // ⚠️ Codex 没有 -p!无头模式是 exec 子命令,prompt 直接当位置参数
    promptArgs: (p) => [p],
    buildArgs(o) {
      const sb = codexSandbox(o.permissionMode)
      if (o.isFirstTurn) {
        return ['exec', '--json', '--sandbox', sb]
      }
      /*
       * 续接走 `codex exec resume`。⚠️ 这个子命令**不再接受** `-s/--sandbox`,
       * 只能用 `-c` 覆盖配置项(见其文档里沙箱开关的迁移说明)。
       * 照搬首轮的写法会得到一个"未知参数"的退出。
       */
      return ['exec', '--json', 'resume', o.sessionId, '-c', `sandbox_mode="${sb}"`]
    },
    sanitize: makeSanitizer(['CODEX_CLI', 'CODEX'], ['CODEX_']),
    verified: false,
    note: '按 OpenAI 官方文档接入。默认沙箱是只读,本应用会按权限模式显式传 --sandbox。',
  },

  {
    id: 'gemini',
    displayName: 'Gemini CLI(Google)',
    command: 'gemini',
    npmBins: ['@google/gemini-cli/dist/index.js'],
    installCmd: 'npm i -g @google/gemini-cli',
    docsUrl: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md',
    capabilities: {
      headless: true,
      streamJson: true,
      resume: true,
      specifySessionId: false,
      tools: true,
      fork: false,
    },
    promptDelivery: 'argv',
    lineMode: 'json',
    parser: normalizeGeminiEvent,
    extractSessionId: extractGeminiSessionId,
    // -p 后面直接跟 prompt。注意不能在同一个进程里把 prompt 也写进 stdin,
    // 它的参数解析会把那个当冲突(见 session.ts 对 argv 模式的处理)
    promptArgs: (p) => ['-p', p],
    buildArgs(o) {
      const args = ['--output-format', 'stream-json', '--approval-mode', geminiApproval(o.permissionMode)]
      // 续接:直接给 session id(-r latest 会接"最近一次",多节点并发时会串到别的节点)
      if (!o.isFirstTurn) args.push('--resume', o.sessionId)
      return args
    },
    sanitize: makeSanitizer(['GEMINI_CLI'], ['GEMINI_CLI_']),
    verified: false,
    note: '按 Google 官方文档接入。GEMINI_API_KEY 等认证变量会被保留。',
  },

  {
    id: 'qwen',
    displayName: 'Qwen Code(通义)',
    command: 'qwen',
    npmBins: ['@qwen-code/qwen-code/dist/index.js'],
    installCmd: 'npm i -g @qwen-code/qwen-code',
    capabilities: {
      headless: true,
      streamJson: true,
      resume: true,
      specifySessionId: false,
      tools: true,
      fork: false,
    },
    promptDelivery: 'argv',
    lineMode: 'json',
    // Qwen Code 由 Gemini CLI 派生,命令行与事件格式沿用同一套
    parser: normalizeGeminiEvent,
    extractSessionId: extractGeminiSessionId,
    promptArgs: (p) => ['-p', p],
    buildArgs(o) {
      const args = ['--output-format', 'stream-json', '--approval-mode', geminiApproval(o.permissionMode)]
      if (!o.isFirstTurn) args.push('--resume', o.sessionId)
      return args
    },
    sanitize: makeSanitizer([], ['QWEN_CODE_']),
    verified: false,
    note: '由 Gemini CLI 派生的开源分支,沿用其命令行与事件格式。',
  },

  {
    id: 'cursor',
    displayName: 'Cursor CLI',
    command: 'cursor-agent',
    npmBins: [],
    installCmd: 'curl https://cursor.com/install -fsS | bash',
    capabilities: {
      headless: true,
      streamJson: true,
      // Cursor 的社区反馈里 headless 模式在部分版本/平台会挂,不做会话续接更稳
      resume: false,
      specifySessionId: false,
      tools: true,
      fork: false,
    },
    promptDelivery: 'argv',
    lineMode: 'json',
    // 它刻意模仿 Claude Code 的输出结构,所以复用同一套解析
    parser: normalizeClaudeEvent,
    extractSessionId: () => null,
    promptArgs: (p) => [p],
    buildArgs(o) {
      const args = ['-p', '--output-format', 'stream-json']
      // ⚠️ 不加 --force 的话它在 headless 下会停下来等确认,直接挂住
      if (o.permissionMode !== 'plan') args.push('--force')
      return args
    },
    sanitize: makeSanitizer([], ['CURSOR_']),
    verified: false,
    note: '未实测。Cursor 的 headless 模式在部分版本上会挂起,若卡住请换其它 agent。',
  },

  {
    id: 'aider',
    displayName: 'Aider',
    command: 'aider',
    npmBins: [],
    installCmd: 'python -m pip install aider-install && aider-install',
    capabilities: {
      headless: true,
      // 它只吐纯文本,没有事件流 —— 所以工具调用在界面上是看不见的
      streamJson: false,
      resume: false,
      specifySessionId: false,
      tools: true,
      fork: false,
    },
    promptDelivery: 'argv',
    lineMode: 'text',
    parser: () => [],
    extractSessionId: () => null,
    promptArgs: (p) => ['--message', p],
    buildArgs() {
      /*
       * ⚠️ Aider 没有"只读"档位 —— 它的工作方式就是直接改文件。
       * 所以这里固定 --yes(不询问)。plan 模式对它无效,UI 的 note 里说明了这点,
       * 而不是假装尊重了一个它做不到的模式。
       */
      return ['--yes', '--no-auto-commits', '--no-check-update']
    },
    sanitize: makeSanitizer([], []),
    verified: false,
    note: '只吐纯文本、直接改文件,不支持只读模式。工具调用过程在界面上不可见。',
  },
] as const

/* ---------------- 工厂 ---------------- */

/**
 * 把一个规格变成 AgentAdapter。
 *
 * 公共部分(detect 的回退链、parseEvent 的空值保护、lineMode 推断、
 * 纯文本兜底)只在这里实现一次。
 */
export function buildCliAdapter(spec: CliSpec): AgentAdapter {
  return {
    id: spec.id,
    displayName: spec.displayName,
    capabilities: spec.capabilities,
    promptDelivery: spec.promptDelivery,
    lineMode: spec.lineMode,

    async detect(configuredPath?: string): Promise<AgentDetectResult | null> {
      try {
        const loc = await locateCli({
          command: spec.command,
          npmBins: spec.npmBins,
          configuredPath,
        })
        return {
          exe: loc.exe,
          prefixArgs: loc.prefixArgs,
          version: loc.version,
          source: loc.source,
          tried: loc.tried,
        }
      } catch {
        return null
      }
    },

    buildArgs(o: SessionOptions, prompt?: string): string[] {
      const args = spec.buildArgs(o)
      // argv 投递:prompt 必须在这里拼进去(调用方传了才拼,便于单测只验参数)
      if (spec.promptDelivery === 'argv' && spec.promptArgs && prompt !== undefined) {
        args.push(...spec.promptArgs(prompt))
      }
      return args
    },

    parseEvent(obj: unknown): NodeEvent[] {
      try {
        return spec.parser(obj)
      } catch {
        // 解析器出任何意外都降级成 raw —— 一条坏事件绝不该让整轮会话崩掉
        return [{ k: 'raw', ts: Date.now(), payload: obj }]
      }
    },

    extractSessionId(obj: unknown): string | null {
      try {
        return spec.extractSessionId(obj)
      } catch {
        return null
      }
    },

    sanitizeEnv(env: NodeJS.ProcessEnv, nodeId?: string): NodeJS.ProcessEnv {
      return spec.sanitize(env, nodeId)
    },

    parsePlainText: spec.lineMode === 'text' ? (chunk: string) => plainTextEvents(chunk) : undefined,
  }
}

/**
 * Claude 之外的 CLI。Claude 自己有一套历史实现(claude/adapter.ts),
 * 里面挂着技能库注入等本机实测出来的逻辑,不并入这张表以免回归。
 */
export const CLI_ADAPTERS: readonly AgentAdapter[] = CLI_SPECS.map(buildCliAdapter)

/**
 * 给 UI 用的元信息(安装命令、是否实测过、备注)。
 *
 * 单独导出而不是塞进 AgentListEntry:那些字段在主进程和 UI 之间传,
 * 而 AgentListEntry 已经是节点下拉框用的轻量结构,不该再挂一坨说明文字。
 */
export interface CliMeta {
  id: string
  installCmd: string
  docsUrl?: string
  verified: boolean
  note?: string
}

export const CLI_META: readonly CliMeta[] = [
  {
    id: 'claude',
    installCmd: 'npm i -g @anthropic-ai/claude-code',
    verified: true,
    note: '本机实测过(参数、事件流、会话续接)。',
  },
  ...CLI_SPECS.map((s) => ({
    id: s.id,
    installCmd: s.installCmd,
    docsUrl: s.docsUrl,
    verified: s.verified,
    note: s.note,
  })),
]

export function cliMetaOf(id: string): CliMeta | undefined {
  return CLI_META.find((m) => m.id === id)
}
