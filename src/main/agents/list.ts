import type { AgentCapabilities, AgentListEntry } from '../../shared/ipc'
import { PROVIDERS, PROVIDER_GROUPS, apiAgentId } from '../../shared/providers'
import { statusFor } from '../secrets/store'
import { cliMetaOf } from './cli/adapters'
import { listAdapters } from './registry'

/**
 * 节点上「Agent」下拉框的数据源 —— CLI 工具与 API 服务商混装。
 *
 * ## 为什么混成一个列表
 *
 * 对用户来说,节点上要回答的问题只有一个:**这个节点拿什么跑**。
 * 分成两个下拉框会让他先被迫想"我该用哪个框"—— 而那个问题只有懂实现的人
 * 才答得上来。混在一起 + 分组标题,既保住了选择的连贯性,
 * 又用 `groupLabel` 把"本机装的工具"和"填 Key 用的云端服务"分开。
 *
 * ## keyReady 的作用
 *
 * 没配 Key 的服务商**依然出现在列表里**(用户可以先去选好,再去设置页填 Key),
 * 但会带一个 `keyReady: false` —— UI 据此挂提示。若直接把它们从列表里藏掉,
 * 用户根本不知道有这个东西可用。
 */

/**
 * API 型 agent 的能力声明。
 *
 * `resume: true` 是成立的 —— 对话历史由我们自己落盘(见 api/history.ts),
 * 每轮把完整 messages 发出去,语义上等价于续接会话。
 * `specifySessionId: false` 因为它不需要指定:协议无状态,没有 id 可指。
 */
const API_CAPS: AgentCapabilities = {
  headless: true,
  streamJson: true,
  resume: true,
  specifySessionId: false,
  tools: true,
  fork: false,
}

export function agentListEntries(): AgentListEntry[] {
  const cli: AgentListEntry[] = listAdapters().map((a) => ({
    id: a.id,
    displayName: a.displayName,
    capabilities: a.capabilities,
    kind: 'cli',
    // 实测过没有 —— 未实测的要在 UI 上说清,否则报错时用户只会怀疑自己
    verified: cliMetaOf(a.id)?.verified ?? false,
    groupLabel: '本机 CLI 工具',
  }))

  const groupLabelOf = (g: string): string =>
    PROVIDER_GROUPS.find((x) => x.id === g)?.label ?? '其它服务商'

  const api: AgentListEntry[] = PROVIDERS.map((p) => ({
    id: apiAgentId(p.id),
    displayName: p.label,
    capabilities: API_CAPS,
    kind: 'api',
    providerId: p.id,
    models: p.models,
    /*
     * ⚠️ 必须带上 optionalKey。本地推理(Ollama / LM Studio)与「自定义 OpenAI 兼容」
     * 本来就不用填 Key —— 只看 hasKey 的话它们永远显示「未配 Key」,
     * 用户会去瞎填一个没用的密钥,或者干脆以为这个选项是坏的。
     */
    keyReady: p.optionalKey || statusFor(p.id).hasKey,
    groupLabel: groupLabelOf(p.group),
  }))

  return [...cli, ...api]
}
