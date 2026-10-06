/**
 * SKILL.md 的解析与校验。
 *
 * 纯函数,没有 fs —— 这样 e2e 可以直接喂字符串进来测,不用先铺一堆文件。
 *
 * ## 为什么只认 frontmatter 里的两个键,却要容忍所有键
 *
 * 我们只需要 `name` 和 `description`。但真实技能的 frontmatter 远不止这两个:
 * 本机 impeccable 那份用的是 `name / description / version / user-invocable /
 * argument-hint / license`。严格"只允许这两个键"的话,一份完全正常的技能
 * 会被判成格式错误 —— 而用户看到的只是"装不进去",无从排查。
 *
 * 所以解析器收下所有标量键,调用方只取自己要的两个,其余原样留着。
 */

export interface Frontmatter {
  /** 所有标量键。值统一是字符串(数字/布尔也按字面量存) */
  data: Record<string, string>
  /** `---` 之后剩下的正文 */
  body: string
  /** 有没有 frontmatter 块。没有也不算错 —— 规范说 name 缺省取目录名 */
  hasBlock: boolean
}

const FENCE = /^---\s*$/

/**
 * 解析 YAML frontmatter 的**标量子集**。
 *
 * 不引 yaml 依赖:技能 frontmatter 里实际用到的只有标量和很短的折叠块,
 * 为这个引一个解析器不划算。但也不是"只切冒号"—— 值里带冒号很常见
 * (`description: Use when: the user ...`),所以只按**第一个**冒号切。
 */
export function parseFrontmatter(text: string): Frontmatter {
  // BOM:Windows 上从别处复制来的文件常带,不剥掉的话第一行的 `---` 匹配不上
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = src.split(/\r?\n/)

  if (lines.length === 0 || !FENCE.test(lines[0])) {
    return { data: {}, body: src, hasBlock: false }
  }

  const end = lines.findIndex((l, i) => i > 0 && FENCE.test(l))
  if (end < 0) {
    // 只有开头没有结尾 —— 当成没有 frontmatter,正文照旧。
    // 不报错:一份被截断的文件至少还能显示,报错则什么都看不到
    return { data: {}, body: src, hasBlock: false }
  }

  const data: Record<string, string> = {}
  let pendingKey: string | null = null

  for (let i = 1; i < end; i++) {
    const line = lines[i]
    if (!line.trim() || line.trimStart().startsWith('#')) continue

    const at = line.indexOf(':')
    if (at < 0) {
      // 续行:比键更缩进的一行,接到上一个键上(折叠块标量 `>` / `|` 的常见写法)
      if (pendingKey && /^\s+\S/.test(line)) {
        data[pendingKey] = `${data[pendingKey]} ${line.trim()}`.trim()
      }
      continue
    }

    // 值里带缩进又带冒号的行(比如列表项)不能当新键 —— 用缩进判断:
    // 顶层键是顶格的
    if (/^\s/.test(line) && pendingKey) {
      data[pendingKey] = `${data[pendingKey]} ${line.trim()}`.trim()
      continue
    }

    const key = line.slice(0, at).trim()
    const value = unquote(line.slice(at + 1).trim())
    data[key] = value
    pendingKey = key
  }

  return { data, body: lines.slice(end + 1).join('\n'), hasBlock: true }
}

/** 去掉一层包裹引号。技能里偶尔写成 `description: "..."` */
function unquote(v: string): string {
  if (v.length >= 2) {
    const a = v[0]
    const b = v[v.length - 1]
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return v.slice(1, -1)
  }
  return v
}

/**
 * 技能名规范。
 *
 * 这些不是我们自己定的审美:规范要求 `^[a-z0-9]+(-[a-z0-9]+)*$`、≤64 字符、
 * 不含保留词、且**与所在目录名一致**。不按这个来的名字,Claude Code 认不认
 * 不好说 —— 而"装了但没生效"是最难查的一类问题。所以在**装进来的那一刻**
 * 就按规范定名,而不是等用户去猜为什么没用。
 */
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const RESERVED = ['anthropic', 'claude']

export function validateSkillName(name: string): string | null {
  if (!name) return '技能名不能为空'
  if (name.length > 64) return '技能名最长 64 个字符'
  if (!NAME_RE.test(name)) {
    return '技能名只能用「小写字母、数字、单个连字符」,且不能以连字符开头或结尾'
  }
  if (RESERVED.some((r) => name.includes(r))) {
    return `技能名不能包含保留词 ${RESERVED.join(' / ')}`
  }
  return null
}

export interface ParsedSkill {
  /** 权威名字:优先 frontmatter 的 name,否则目录名 */
  name: string
  description: string
  /** frontmatter 里的原始值(可能和 name 不同),用来提示用户 */
  declaredName: string | null
  /** 正文前这么多字符,给 UI 做预览 */
  bodyPreview: string
  /** 名字不合规范时的问题描述;null = 没问题 */
  nameProblem: string | null
  /** 有没有 Description:没有的话界面上这一栏是空的,不是我们解析失败 */
  hasDescription: boolean
  /** 正文按段落切出的第一段,description 缺省时用它(和 Claude Code 的行为一致) */
  fallbackDescription: string
}

const MAX_DESCRIPTION = 1024

/**
 * 把一份 SKILL.md 解析成 UI 要的东西。
 *
 * `dirName` 是权威兜底:规范允许省略 `name`(取目录名)。
 */
export function parseSkillMd(text: string, dirName: string): ParsedSkill {
  const { data, body } = parseFrontmatter(text)

  const declared = (data['name'] ?? '').trim()
  const name = declared || dirName

  const desc = (data['description'] ?? '').trim()
  const firstPara = body
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0 && !p.startsWith('#'))

  return {
    name,
    description: desc.slice(0, MAX_DESCRIPTION),
    declaredName: declared || null,
    bodyPreview: body.trim().slice(0, 400),
    /*
     * 名字问题**只在 frontmatter 里真的写了 name 时才报**。
     * 没写 name 时用目录名兜底 —— 那是规范允许的,不是问题。
     */
    nameProblem: declared ? validateSkillName(declared) : null,
    hasDescription: desc.length > 0,
    fallbackDescription: (firstPara ?? '').slice(0, MAX_DESCRIPTION),
  }
}
