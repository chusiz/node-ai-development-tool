import type { AgentAdapter } from './types'
import { claudeAdapter } from './claude/adapter'
import { CLI_ADAPTERS } from './cli/adapters'

/**
 * 适配器注册表。
 *
 * Claude 单独注册(它有一套本机实测出来的实现),其余 CLI 由声明式规格表
 * 批量生成后在这里统一登记。加一个新 CLI = 往 cli/adapters.ts 的 CLI_SPECS
 * 里加一条,本文件不用动。
 *
 * ⚠️ **API 直连型 agent(`api:<providerId>`)不在这张表里**。
 * 它们没有"可执行文件"这个概念,走的是另一条构造路径(见 manager.start 的分叉)。
 * 硬塞进来会逼着 AgentAdapter 接口长出 buildArgs/detect 这类对 HTTP 毫无意义的
 * 成员。两者的共同点只有 LiveSession 那三个方法 —— 在那一层统一就够了。
 */
const adapters = new Map<string, AgentAdapter>()

export function registerAdapter(adapter: AgentAdapter): void {
  adapters.set(adapter.id, adapter)
}

export function getAdapter(id: string): AgentAdapter {
  const a = adapters.get(id)
  if (!a) throw new Error(`未知的 agent 适配器: ${id}`)
  return a
}

export function hasAdapter(id: string): boolean {
  return adapters.has(id)
}

export interface AgentListEntry {
  id: string
  displayName: string
  capabilities: AgentAdapter['capabilities']
}

export function listAdapters(): AgentListEntry[] {
  return [...adapters.values()].map((a) => ({
    id: a.id,
    displayName: a.displayName,
    capabilities: a.capabilities,
  }))
}

registerAdapter(claudeAdapter)
for (const a of CLI_ADAPTERS) registerAdapter(a)
