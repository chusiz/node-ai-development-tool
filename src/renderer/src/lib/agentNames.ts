import type { AgentListEntry } from '../../../shared/ipc'

/**
 * agent id → 显示名 的模块级缓存。
 *
 * agents.list() 是主进程注册表的一次性快照(十几项,基本不变),每次都
 * invoke 是浪费 —— 顶栏和 Inspector 都要用同一个名字映射,各拉各的
 * 会拿到两份列表。缓存成模块单例,谁先拉谁填,后到的直接读。
 */
let cache: Record<string, string> | null = null

export async function agentDisplayNameMap(): Promise<Record<string, string>> {
  if (cache) return cache
  const res = await window.api.agents.list()
  const m: Record<string, string> = {}
  if (res.ok) {
    for (const a of res.data as AgentListEntry[]) {
      m[a.id] = a.displayName
    }
  }
  cache = m
  return m
}
