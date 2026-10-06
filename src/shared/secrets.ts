/**
 * 密钥相关的契约。
 *
 * ## 贯穿全文件的一条铁律:明文 Key 永不离开主进程
 *
 * 渲染进程能拿到的只有 `SecretStatus`(有没有、脱敏后长什么样、从哪来的)。
 * 这不是"顺手加密一下"的洁癖,而是三条具体的风险:
 *
 *   1. 渲染进程是**加载网页内容**的那个进程。它的内存、它的 devtools、
 *      它的任何一次 XSS,都不该能读到用户的 API Key。
 *   2. Key 若进了 `settings.json`,就会跟着画布一起被同步/备份/分享出去 ——
 *      而用户分享画布时绝不会想到里面夹着自己的私有密钥。
 *   3. 报文误打(比如把请求体整条打进诊断日志)会顺手把 Key 写进日志文件。
 *      让密钥从一开始就不出现在那些数据流里,比事后过滤可靠得多。
 *
 * 所以:落盘走 safeStorage 加密(见 main/secrets/store.ts),过 IPC 只走脱敏串。
 *
 * ## 为什么单独一个文件而不是塞进 shared/settings.ts
 *
 * settings.ts 顶部 `import { z } from 'zod'`,而渲染进程要按值引用 maskKey。
 * 放一起会把 zod 拖进渲染进程 bundle(见 defaults.ts 的说明)。
 * 这里保持零依赖,两边都能安全引用。
 */

/** 某个服务商当前有没有可用的 Key */
export interface SecretStatus {
  providerId: string
  hasKey: boolean
  /**
   * 脱敏后的样子,如 `sk-a****c4`。**没有明文**。
   * 没有 Key 时为 null。展示它是为了让用户能确认"填进去的确实是那一把",
   * 而不是只能看到一个是/否。
   */
  masked: string | null
  /**
   * Key 从哪来。
   *   store —— 用户在本应用里填的(加密落盘)
   *   env   —— 来自系统环境变量(本应用只读不写)
   *   none  —— 没有
   *
   * 分开的原因:环境变量优先级低于自己填的,且界面上要说清"这个不是我存的,
   * 是在系统里设的" —— 否则用户会疑惑"我没填过它怎么就有了"。
   */
  source: 'store' | 'env' | 'none'
}

/** 一次连通性测试的结果 */
export interface ProviderTestResult {
  ok: boolean
  /** 成功时是模型回话的摘要(证明链路真通了),失败时是原因 */
  message: string
  /** 往返毫秒数。失败为 null */
  latencyMs: number | null
  /** 实际用的模型名,便于确认"测的是我以为的那个吗" */
  model: string | null
  /**
   * 失败时的纠错提示。
   *
   * 401/404/超时 这三种错,原始报错文本几乎都不说人话
   * (「fetch failed」/「Unauthorized」),所以在这里翻成人话 + 下一步动作。
   */
  advice?: string
}

/**
 * API Key 脱敏。
 *
 * 保留前 4 后 4 是为了"可辨认"—— 用户在平台上往往同时有好几把 Key,
 * 全遮成 `****` 时他没法确认自己填的是哪一把。中间一律替换,不留长度信息
 * (长度也算侧信道)。
 *
 * ⚠️ 长度 ≤ 8 时**整个遮掉**:前后各留 4 就等于把整把 Key 印出来了。
 */
export function maskKey(key: string): string {
  const k = (key ?? '').trim()
  if (!k) return ''
  if (k.length <= 8) return '*'.repeat(k.length)
  const stars = Math.min(6, k.length - 8)
  return `${k.slice(0, 4)}${'*'.repeat(stars)}${k.slice(-4)}`
}

/**
 * 环境变量名:`CLAUDE_CANVAS_<PROVIDER 大写>`。
 *
 * 给三种场景留的口子:
 *   - CI / 脚本化运行,不想让 Key 落盘;
 *   - 公司统一分发配置,Key 由 IT 通过组策略下发;
 *   - 用户就是不想把 Key 交给应用保管。
 *
 * 非字母数字一律折成下划线(`api:xxx` 这种带冒号的 id 也能安全入名)。
 */
export function envKeyName(providerId: string): string {
  return `CLAUDE_CANVAS_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

/**
 * 校验一把 Key 的**形状**是否合理。只做长度与空白检查,不做正则匹配厂商格式 ——
 * 各家的前缀规则一直在变(而且中转服务发的 Key 长什么样都有可能),
 * 拿正则去卡只会误伤。真正的验证是"拿它发一次请求"(见 ProviderTestResult)。
 */
export function looksLikeKey(key: string): boolean {
  const k = (key ?? '').trim()
  return k.length >= 8 && !/\s/.test(k)
}
