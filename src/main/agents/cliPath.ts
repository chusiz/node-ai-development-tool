import { getSettings } from '../settings/store'

/**
 * 某个 CLI agent 在设置里被指定的可执行文件路径。
 *
 * 两个存储位要一起看:`cliPaths[agentId]`(v0.4.0 起的统一位置)与
 * `claudePath`(更早版本只支持 claude 时的字段)。
 *
 * ⚠️ **不能删掉对 claudePath 的兜底**。用户升级到新版时,settings.json 里
 * 只有 `claudePath` —— 直接换成只读 cliPaths 的话,他上次辛苦找到的那个
 * 路径会静默失效,表现是"升级完就说找不到 claude 了"。这类回归最难查,
 * 因为功能看起来"只是坏了",没有任何线索指向设置字段换了名字。
 *
 * 空串统一折成 undefined:调用点(adapter.detect)的签名是
 * `configuredPath?: string`,让它一路判空比让 null/''/undefined 三种值
 * 穿到深处少一层分支。
 */
export function configuredCliPath(agentId: string): string | undefined {
  const a = getSettings().agent
  const byNew = a.cliPaths[agentId]
  if (byNew && byNew.trim()) return byNew.trim()
  if (agentId === 'claude') {
    const legacy = a.claudePath
    if (legacy && legacy.trim()) return legacy.trim()
  }
  return undefined
}
