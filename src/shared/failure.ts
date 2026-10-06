/**
 * 失败分类 —— 「这个错误重试一次有没有用」。
 *
 * ## 为什么要有这一层
 *
 * 调度器原来的重试是**无差别**的:任何失败都退避重试(1s → 2s → 4s → 8s,封顶 6 次)。
 * 对网络抖动、进程被 kill、5xx 这类**瞬时**错误,那样是对的;
 * 但 `402 余额不足` / `401 鉴权失败` / `模型名写错` 重试多少次都不会变 ——
 * 用户只看到进度条在那儿一秒一秒地挪,却始终不知道发生了什么。
 * 白等二十秒,换来的还是同一个错误。
 *
 * ## 判定原则:保守
 *
 * **只对明确认识的几类判"不可重试"**,其余一律按可重试处理(维持既有行为)。
 * 方向是刻意选定的:
 *
 *   - 误判成"可重试" → 多等十几秒,用户烦,但结果最终还是对的;
 *   - 误判成"不可重试" → 本来能成功的运行被当场判死,用户白等的是**看不到的希望**。
 *
 * 后者严重得多。所以新增规则时的门槛是「我确知它不会自愈」,而不是「它看起来像」。
 * 宁可漏判(继续退避重试,老样子),不可错判。
 *
 * ## 本模块零依赖
 *
 * 纯逻辑、不 import 任何东西(含 zod),所以渲染进程可以安全地**按值**引用 ——
 * 这与 `shared/` 里其余带 zod 的模块不同,那些只能 `import type`。
 */
import type { SessionStatus } from './events'

/**
 * 失败类别。
 *
 * ⚠️ 这是一个**封闭集合**,不是给 UI 随便扩展的标签:每一项都对应一条确定的
 * 不可重试规则。加一项就要同时在 `NON_RETRYABLE_RULES` 里给它一条规则,
 * 否则它永远是 `unknown`(= 可重试),那比误判安全。
 */
export type FailureKind =
  /** 账户余额 / 计费不足 */
  | 'balance'
  /** 配额(用量上限)耗尽 */
  | 'quota'
  /** 鉴权失败:Key 无效、无权限 */
  | 'auth'
  /** 模型名或接口地址不存在 */
  | 'model'
  /**
   * 归不出来的失败。
   *
   * **它等价于「可重试」** —— 见文件顶部的保守原则。
   * 保留这一项而不是让 `kind` 可选,是为了让调用方必须显式处理它:
   * 忘了处理会被 TypeScript 挑出来,而不是悄悄走错分支。
   */
  | 'unknown'

export interface FailureVerdict {
  /**
   * 这次失败**重试有没有用**。
   *
   * 只有命中 `NON_RETRYABLE_RULES` 之一才是 false。判定不出来的为 true ——
   * 调用方应当用 `=== false` 判不可重试,而不是 `!retryable`(那样会把
   * 将来可能新增的第三态也当成不可重试)。
   */
  retryable: boolean
  kind: FailureKind
  /**
   * 面向用户的人话提示 —— 告诉他**该做什么**,不是把服务商的原文甩过去。
   *
   * `kind === 'unknown'` 时为空串:没归出类就没有可信的处置建议,
   * 硬编一句通用文案只会误导人,那种情况让调用方回落到自己的措辞。
   */
  hint: string
  /**
   * 参与判定的原始错误文本(已截断)。
   *
   * **只进日志,不面向用户** —— 里面通常混着 `request_id`、内部路径、
   * 上游报文,拿它当文案用户读不懂,拿它当契约又随时会变。排查时看它。
   */
  raw: string
}

/**
 * 一轮会话跑完之后的结局。
 *
 * `failure` 只在**确实失败**且**归出了类**时才有值。调度器判"要不要退避重试"
 * 只看它 —— 缺省就是可重试(维持升级前的行为)。
 */
export interface SessionOutcome {
  status: SessionStatus
  code: number | null
  failure?: FailureVerdict
}

/** 归类之后给用户看的话。全角标点 + 句末破折号,与项目其余文案同一风格 */
const KIND_HINT: Record<Exclude<FailureKind, 'unknown'>, string> = {
  balance:
    'API 余额不足,重试也不会自动恢复 —— 请到「设置 → 模型服务」检查账户余额,或换一个服务商。',
  quota: 'API 配额已经用尽,重试要等到配额重置 —— 可先换一家服务商,或等下一个计费周期。',
  auth: 'API 鉴权没通过,重试不会自动恢复 —— 请到「设置 → 模型服务」核对 API Key 与该模型的访问权限。',
  model: '模型名或接口地址不对,重试不会自动恢复 —— 请到「设置 → 模型服务」用「拉取模型」核对模型名与 Base URL。',
}

/**
 * 原始错误文本最多留这么多字符进日志。再长对排查没有额外价值,只会撑爆日志行。
 *
 * ⚠️ 截断必须从**尾部**取(`slice(-RAW_MAX)`),不能从头部。
 *
 * 这不是风格偏好,是正确性:`raw` 的**唯一用途**是排查(见 `FailureVerdict.raw`
 * 的注释),而错误几乎总是整段输出的**最后几行**(前面是正常日志)。
 * 从头部截 500 字符 = 恰好把错误行切掉、只留一堆 `reading file src/module-3.ts`。
 * 用户拿着这行去搜工单,搜不到任何东西 —— 而 `request_id` 就在被切掉的那半行里。
 *
 * 实测:59 行噪声 + 末行 `API Error: 402 … (request_id: req_X)`,
 * 头部截断得到 500 字符纯噪声,连 `402` 都不在里面。
 */
const RAW_MAX = 500

/** 判定时的输入上限。超长文本(整段堆栈)对关键词匹配没有额外帮助 */
const INPUT_MAX = 4000

/**
 * 进程退出码 ≠ HTTP 状态码。
 *
 * `code` 与 `status` 这两个词**同时**是 HTTP 状态码的语境词(`status code: 402`)
 * 和进程退出码的语境词(`exit code 402`),单看形态区分不了。而 agent 崩在别的原因上、
 * 退出码恰好是 401/402/403 时,把 `exit code 402` 判成"余额不足"是这个分类器
 * **最坏的输出**:方向是**错判**(可重试的运行被判死),而用户会被引导去充值 ——
 * 充值完什么都没变,比"多等 23 秒"坏得多。
 *
 * ⚠️ 这与本文件顶部声明的保守原则的关系:那三条"证据被截断"的局限都是
 * **在安全方向上漏判**,而这一条是**在明令禁止的方向上错判** ——
 * 它违背的是本模块自己的设计契约,不是外部环境限制。所以必须修,不能只记着。
 *
 * 覆盖的形态:`exit code N` / `Exit code: N` / `exited with code N` /
 * `process exited with code N` / `returned code N`,以及把 `code` 换成 `status`
 * 的那几种(`exit status 402` —— **同一个缺陷的第二个入口**,别只修 `code`)。
 */
const EXIT_CODE_PHRASE =
  /(?:exit(?:ed)?|process\s+exited?|return(?:s|ed)?)(?:\s+with)?(?:\s+(?:code|status))?\s*[:=]?\s*-?\d+/gi

/**
 * 把退出码短语里的 `code` / `status` 换成等长的哑元字符。
 *
 * ## 为什么不直接"整条返回 unknown"
 *
 * 那样会连带放过同一段文本里**真正的** HTTP 证据 ——
 * `exit code 1, status=402` 里退出码是可重试的,但 `status=402` 是余额不足,
 * 整条放过就变成了一次错判。哪一边错都不对,所以**按语境词区分**:
 * 只让退出码短语内部的那个词失效,短语之外的 `status`/`http`/`api` 照常生效。
 *
 * ## 为什么换成等长的"哑元"而不是直接删掉
 *
 * 删掉会让两侧的空白/符号连成一片,有可能把原本被词边界挡住的
 * `\W{0,16}` 意外**接起来**(凭空造出新的语境距离)。换成等长的字母串
 * 不会改变长度、也不会新建任何 `\W` 桥,可审计性更好:
 * 掩码前后长度一致,判定结果只可能因为"那个词不再是语境词"而变。
 */
function maskExitCodeContext(text: string): string {
  return text.replace(EXIT_CODE_PHRASE, (phrase) => phrase.replace(/\b(?:code|status)\b/gi, (w) => 'x'.repeat(w.length)))
}

/**
 * 不可重试规则表。**表里没有的,一律可重试。**
 *
 * 顺序有意义:更具体的规则排在前面。`insufficient_quota` 命中的是"配额",
 * 而 `402` 命中的是"余额" —— 两者都要排在通用状态码规则之前,
 * 否则一个欠费请求会被报成"鉴权失败",提示用户去检查 Key,方向完全错。
 */
const NON_RETRYABLE_RULES: ReadonlyArray<{
  kind: Exclude<FailureKind, 'unknown'>
  re: RegExp
}> = [
  /*
   * ① 余额 / 计费。
   * `402` 单独出现是有风险的(日志里别处也可能有这个数),所以要求
   * 附近有错误语境;`insufficient balance` 这类词本身已经足够明确,单独列。
   */
  {
    kind: 'balance',
    re: /insufficient[\s_-]*(balance|funds?)|billing[\s_-]*(error|hard|required)|payment[\s_-]*required|余额不足|额度不足|账户余额|欠费|(?:http|status|code|error|api)\W{0,16}\b402\b|\b402\b\W{0,16}(?:error|required|payment)/i,
  },
  /* ② 配额耗尽。必须排在"限流"之前 —— 有的服务拿 429 报配额,那不是限流 */
  {
    kind: 'quota',
    re: /insufficient[\s_-]*quota|quota[\s_-]*(exceeded|exhausted)|exceeded your current quota|monthly limit|billing[\s_-]*limit|配额不足|配额已用尽|超出配额|用量上限/i,
  },
  /* ③ 鉴权。同样要求状态码附近有错误语境,避免把行号 / 偏移量当成状态码 */
  {
    kind: 'auth',
    re: /unauthorized|forbidden|invalid[\s_-]*(api[\s_-]*)?key|invalid[\s_-]*authentication|authentication[\s_-]*(error|failed)|permission[\s_-]*(denied|error)|鉴权失败|密钥无效|密钥已过期|无权限|未授权|(?:http|status|code|error|api)\W{0,16}\b40[13]\b|\b40[13]\b\W{0,16}(?:error|denied)/i,
  },
  /*
   * ④ 模型 / 接口不存在。
   * `unrecognized_model` 是 CLI 型实测会打到 stderr 的原文(见 ndjson.ts 的注释),
   * 所以它是这一组里最有价值的一条。
   *
   * 中间那段 `{0,80}` 是给模型名留的位置:各家报文都长成
   * 「The model `xxx` does not exist」,模型名会把 "model" 与 "does not exist" 隔开,
   * 要求两者紧邻就永远匹配不上 —— 而这条恰恰是最该判成不可重试的一类。
   */
  {
    kind: 'model',
    re: /unrecognized[\s_-]*model|unknown[\s_-]*model|model[\s_-]*(not[\s_-]*found|unavailable)|invalid[\s_-]*model|no such model|model[^\n]{0,80}?(?:does[\s_-]*not[\s_-]*exist|not[\s_-]*found|unknown|invalid)|(?:does[\s_-]*not[\s_-]*exist|not[\s_-]*found|no[\s_-]*such)[^\n]{0,40}?model|模型不存在|模型名无效|模型不可用|接口不存在/i,
  },
]

/**
 * 截断到 `max` 字符,**保留尾部**(见 RAW_MAX 的注释:错误在最后,不能从头切)。
 *
 * 刻意不在末尾加 `…`:留着半行比加个省略号更有用 ——
 * `request_id` 这类要拿去搜的关键串可能正好被腰斩,加省略号只是提醒"这里没了",
 * 而保留尾部时关键串大概率是完整的。
 */
function clip(s: string, max: number): string {
  return s.length > max ? s.slice(-max) : s
}

function verdict(kind: FailureKind, raw: string): FailureVerdict {
  return {
    retryable: kind === 'unknown',
    kind,
    hint: kind === 'unknown' ? '' : KIND_HINT[kind],
    raw: clip(raw, RAW_MAX),
  }
}

/**
 * 从一段错误文本(CLI 的 stderr / 事件流,或 API 的响应体)里判定失败类别。
 *
 * **无法归类时返回 `kind: 'unknown'` + `retryable: true`**,也就是维持调用方
 * 原来的退避重试行为。这是刻意的:宁可多重试几次,也不要把瞬时错误误判成永久失败。
 */
export function classifyFailure(raw: string): FailureVerdict {
  /*
   * 掩码放在 `slice` **之后**:掩码不改变长度,两者 commutes,但先切再掩
   * 保证判定输入的上限恒为 INPUT_MAX —— 掩码永远看不到被截掉的那半段。
   */
  const text = maskExitCodeContext((raw ?? '').slice(0, INPUT_MAX))
  for (const rule of NON_RETRYABLE_RULES) {
    if (rule.re.test(text)) return verdict(rule.kind, raw)
  }
  return verdict('unknown', raw)
}

/**
 * 按 HTTP 状态码判定 —— API 直连那条路**不看文案,看状态码**。
 *
 * 同一段文案在 CLI 与 API 两条路上的形态差别很大(一边是 `API Error: 402 …`,
 * 另一边是我们自己拼的 `鉴权失败(HTTP 401) · …`),让文案去承担判据必然漏。
 * API 这条路本来就拿着状态码,用它是更可靠的证据。
 *
 * 仍然只覆盖明确的几类:4xx 里没列出的(400 Bad Request 之类)、5xx、
 * 以及所有网络层错误都归 `unknown` → 可重试。
 */
export function classifyHttpStatus(status: number, detail: string): FailureVerdict {
  if (status === 401 || status === 403) return verdict('auth', detail)
  if (status === 402) return verdict('balance', detail)
  if (status === 404) {
    /*
     * 404 **不直接**判成不可重试。
     *
     * 它绝大多数时候确实是"模型名写错 / Base URL 少了 /v1"(配置问题,重试无用),
     * 但 CDN 与网关在部署切换期间也会短暂回 404。把状态码本身当判据就赌对了。
     * 所以这里再拿响应体过一遍关键词:能归出类才判不可重试,归不出就照旧可重试。
     * 代价是最坏情况多退避重试一轮,换来的是不会把瞬时 404 判死。
     */
    const byText = classifyFailure(detail)
    return byText.retryable ? verdict('unknown', detail) : byText
  }
  if (status === 429) {
    /*
     * 429 绝大多数是**限流**,退避之后大概率就过了 → 可重试。
     * 但有的服务拿 429 报"配额/欠费"(OpenAI 系的 `insufficient_quota` 就是),
     * 那种重试多少次都一样,所以这里再按文案过一遍。
     */
    const byText = classifyFailure(detail)
    return byText.retryable ? verdict('unknown', detail) : byText
  }
  return verdict('unknown', detail)
}
