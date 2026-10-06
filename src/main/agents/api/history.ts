import path from 'node:path'
import { nodeDir, ensureNodeDir } from '../../paths'
import { readJsonSafe, writeJsonAtomic } from '../../persist/atomic'
import type { ChatMessage } from './types'

/**
 * API 型节点的对话历史。
 *
 * ## 为什么这一路必须自己存历史,而 CLI 那一路不用
 *
 * Claude CLI 有自己的会话存储:我们给 `--session-id` / `--resume`,它自己
 * 把上下文接上,我们一句历史都不用碰。API 直连没有这种东西 —— 协议是
 * 无状态的,每次请求都得把**完整的 messages 数组**重新发一遍。
 * 所以"多轮对话"这件事在这里必须由我们落地:,否则每一轮都是失忆的。
 *
 * ## 存哪、存什么
 *
 * `data/canvases/<canvasId>/nodes/<nodeId>/api-messages.json`
 *
 * 跟随节点目录而不是全局单文件:节点被删/被 reset 时,历史跟着一起走,
 * 不会留下永远没人读的孤儿数据。这也让「新会话」按钮的实现变得很直白
 * (删掉这个文件即可)。
 *
 * ⚠️ **只存对话,不存 Key**。这个文件是完全明文、用户可读可改的,
 * 它的内容还会被下游节点看见(注入上游产出时),所以绝不能放敏感信息。
 */

function historyFile(canvasId: string, nodeId: string): string {
  return path.join(nodeDir(canvasId, nodeId), 'api-messages.json')
}

/**
 * 上限。
 *
 * 上下文是有限资源:一个跑了 200 轮的工具循环,历史能到几 MB —— 每次都原样
 * 发出去,既烧钱又会撞上模型的上下文窗口。所以按**条数 + 总字节**双限。
 *
 * 从**头部**丢(保留最近的):丢掉最早的对话意味着模型忘了开头,但这比
 * "因为超限而整个请求失败"好得多。而且用户随时可以点「新会话」重来。
 */
const MAX_MESSAGES = 120
const MAX_TOTAL_CHARS = 400_000
/** 单条上限。一个巨大的 tool_result(比如读了整个文件)不该独占整个上下文 */
const MAX_ONE_CHARS = 60_000

const EMPTY: ChatMessage[] = []

/**
 * 读历史。**永不抛** —— 读不出来就是"没有历史"。
 *
 * 这个函数在每次发请求前都会被调用,它抛异常等于 API 型节点整个不能用。
 * 文件是我们自己写的,坏了最可能是外部改坏,那种情况下从零开始比报错好。
 */
export async function loadHistory(canvasId: string, nodeId: string): Promise<ChatMessage[]> {
  const raw = await readJsonSafe<unknown>(historyFile(canvasId, nodeId), EMPTY)
  if (!Array.isArray(raw)) return []
  const out: ChatMessage[] = []
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue
    const o = m as Record<string, unknown>
    const role = o.role
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') continue
    if (typeof o.content !== 'string') continue
    const msg: ChatMessage = { role, content: o.content }
    if (typeof o.toolCallId === 'string') msg.toolCallId = o.toolCallId
    if (typeof o.name === 'string') msg.name = o.name
    if (Array.isArray(o.toolCalls)) {
      msg.toolCalls = o.toolCalls
        .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
        .map((t) => ({
          id: typeof t.id === 'string' ? t.id : '',
          name: typeof t.name === 'string' ? t.name : '',
          args: typeof t.args === 'string' ? t.args : '',
        }))
        .filter((t) => t.name)
    }
    out.push(msg)
  }
  return out
}

/**
 * 裁剪历史到上限内。**成对保留**是关键。
 *
 * ⚠️ 不能只按条数从头部切:assistant 请求工具调用那一条与紧随其后的
 * tool 结果那一条是**严格配对**的(服务商侧会校验)。切在它们中间,
 * 剩下的第一条就成了"孤立的 tool 结果",下一次请求直接 400。
 * 所以切口要往前退,直到落在一个安全的边界上。
 */
export function trimHistory(msgs: ChatMessage[]): ChatMessage[] {
  let start = Math.max(0, msgs.length - MAX_MESSAGES)

  // 从 start 往前走,跳过所有"回应某个调用的 tool 消息"
  while (start > 0 && start < msgs.length && msgs[start]!.role === 'tool') start--

  const sliced = msgs.slice(start)

  // 再按总长度收:从头部继续丢,同样要避开配对边界
  let total = sliced.reduce((n, m) => n + m.content.length, 0)
  let head = 0
  while (total > MAX_TOTAL_CHARS && head < sliced.length - 1) {
    // 不要切在 tool 前面 —— 那样会留下没有对应请求的 tool 结果
    if (sliced[head]!.role === 'assistant' && sliced[head + 1]?.role === 'tool') head += 2
    else head++
    total = sliced.slice(head).reduce((n, m) => n + m.content.length, 0)
  }

  const out = head > 0 ? sliced.slice(head) : sliced

  // 最后把单条超长的压掉。工具结果最容易超(整个文件内容)
  return out.map((m) =>
    m.content.length > MAX_ONE_CHARS
      ? { ...m, content: `${m.content.slice(0, MAX_ONE_CHARS)}\n…(内容过长,已截断)` }
      : m,
  )
}

export async function saveHistory(
  canvasId: string,
  nodeId: string,
  msgs: ChatMessage[],
): Promise<void> {
  ensureNodeDir(canvasId, nodeId)
  await writeJsonAtomic(historyFile(canvasId, nodeId), trimHistory(msgs))
}

/** 「新会话」用:把历史清空。文件留着也无所谓,空数组同样表达"从头开始" */
export async function clearHistory(canvasId: string, nodeId: string): Promise<void> {
  await saveHistory(canvasId, nodeId, [])
}
