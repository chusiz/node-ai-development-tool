/**
 * 环境变量净化 —— 防节点之间串会话。
 *
 * 本机实测存在的污染变量:
 *   CLAUDE_CODE_SESSION_ID / CLAUDE_CODE_CHILD_SESSION / CLAUDE_CODE_MESSAGING_SOCKET
 *   CLAUDE_CODE_MESSAGING_TOKEN / CLAUDE_PID / CLAUDECODE / CLAUDE_EFFORT
 * 子进程继承它们仍能跑,但多个节点共存时会互相串扰,设计上必须清掉。
 */

const BLOCK_PREFIXES = ['CLAUDE_CODE_', 'CLAUDE_'] as const

const BLOCK_EXACT = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  // Electron 特有的:不删的话被 spawn 的 Electron 系二进制会退化成裸 node
  'ELECTRON_RUN_AS_NODE',
  // 可注入 --require,是真实的代码执行面
  'NODE_OPTIONS',
])

/**
 * ANTHROPIC_* 全部保留 —— DeepSeek 路由 (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN /
 * ANTHROPIC_DEFAULT_*_MODEL) 全靠它们。
 *
 * 应用**从不读取、不存储、不打印**这些值,只是让子进程自然继承。
 */
export function sanitizeEnv(env: NodeJS.ProcessEnv, nodeId?: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (BLOCK_EXACT.has(key)) continue
    if (BLOCK_PREFIXES.some((p) => key.startsWith(p))) continue
    out[key] = value
  }

  // 便于在任务管理器 / 日志里分辨是哪个节点起的进程
  if (nodeId) out.HAOWAN_NODE_ID = nodeId

  return out
}
