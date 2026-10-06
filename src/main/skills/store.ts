import fs from 'node:fs/promises'
import path from 'node:path'
import {
  SKILLS_ENABLED_DIR,
  SKILLS_DISABLED_DIR,
  SKILLS_META_FILE,
  SKILLS_PLUGIN_FILE,
  ensureSkillsDirs,
  skillDir,
} from '../paths'
import { readJsonSafe, writeJsonAtomic } from '../persist/atomic'
import { parseSkillMd, validateSkillName } from './parse'
import type { SkillEntry, SkillOrigin } from '../../shared/ipc'

/**
 * plugin 清单里的名字 —— 也就是技能调用时的命名空间前缀。
 *
 * 定了就别改:改了之后所有技能的调用名都变(`haowan-skills:pdf` →
 * `别的:pdf`),而用户可能已经把调用名写进了提示词或笔记里。
 */
export const SKILLS_PLUGIN_NAME = 'haowan-skills'

/** 界面和文档里统一的说法,避免同一个东西三处三个叫法 */
export function invokeName(name: string): string {
  return `${SKILLS_PLUGIN_NAME}:${name}`
}

/**
 * 保证 plugin 目录是一份**合法**的清单。
 *
 * 缺了 plugin.json 的目录不是 plugin —— `--plugin-dir` 指过去会什么都不加载,
 * 而界面上技能明明列得出来。那种"列得出来但不生效"最难查,所以在扫描前
 * 先把清单补齐。已经存在就一个字都不动(用户可能自己改过 description)。
 */
async function ensurePluginManifest(): Promise<void> {
  ensureSkillsDirs()
  try {
    await fs.access(SKILLS_PLUGIN_FILE)
    return
  } catch {
    /* 还没有,下面建 */
  }
  await writeJsonAtomic(SKILLS_PLUGIN_FILE, {
    name: SKILLS_PLUGIN_NAME,
    description: 'chusiz 的技能库 —— 在这里装的技能,画布上所有节点都能用',
    version: '1.0.0',
  })
}

/** `data/skills-meta.json` 的形状:技能名 → 来源。名字是键,不存在列表里 */
type SkillsMeta = Record<string, SkillOrigin>

async function readMeta(): Promise<SkillsMeta> {
  const raw = await readJsonSafe<unknown>(SKILLS_META_FILE, {})
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as SkillsMeta
}

/**
 * 记一条来源。
 *
 * 失败**不抛**:来源只是锦上添花,记不上就不记。为了记不住一条"从哪来的"
 * 而让整个安装失败,是把辅助信息当成了关键路径。
 */
export async function recordOrigin(name: string, origin: SkillOrigin): Promise<void> {
  try {
    const meta = await readMeta()
    meta[name] = origin
    await writeJsonAtomic(SKILLS_META_FILE, meta)
  } catch {
    /* 记不住就算了 */
  }
}

export async function forgetOrigin(name: string): Promise<void> {
  try {
    const meta = await readMeta()
    delete meta[name]
    await writeJsonAtomic(SKILLS_META_FILE, meta)
  } catch {
    /* 同上 */
  }
}

/** 递归数一个技能目录:文件数 + 总字节。给 UI 一个"这东西多大"的概念 */
async function measure(dir: string): Promise<{ fileCount: number; bytes: number }> {
  let fileCount = 0
  let bytes = 0
  const walk = async (d: string): Promise<void> => {
    const entries = await fs.readdir(d, { withFileTypes: true })
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        await walk(p)
      } else if (e.isFile()) {
        fileCount++
        try {
          bytes += (await fs.stat(p)).size
        } catch {
          /* 数不到就当 0,不影响能不能用 */
        }
      }
    }
  }
  try {
    await walk(dir)
  } catch {
    /* 目录读不动就报 0,不是致命问题 */
  }
  return { fileCount, bytes }
}

/**
 * 列出技能库。
 *
 * 同时扫启用和停用两边 —— 停用的技能也要看得见,否则界面上"删掉了"和
 * "停用了"长得一样,用户无从分辨哪个还能恢复。
 */
export async function listSkills(): Promise<SkillEntry[]> {
  await ensurePluginManifest()
  const meta = await readMeta()
  const out: SkillEntry[] = []

  for (const [enabled, root] of [
    [true, SKILLS_ENABLED_DIR],
    [false, SKILLS_DISABLED_DIR],
  ] as const) {
    let names: string[]
    try {
      names = await fs.readdir(root)
    } catch {
      continue
    }

    for (const name of names) {
      const dir = path.join(root, name)
      let skillMd: string
      try {
        const st = await fs.stat(dir)
        if (!st.isDirectory()) continue
        skillMd = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8')
      } catch {
        // 没有 SKILL.md 的目录不是技能 —— 跳过,而不是列一个点进去什么都没有的条目
        continue
      }

      const parsed = parseSkillMd(skillMd, name)
      const { fileCount, bytes } = await measure(dir)

      out.push({
        name,
        declaredName: parsed.declaredName,
        description: parsed.hasDescription ? parsed.description : parsed.fallbackDescription,
        descriptionFromBody: !parsed.hasDescription,
        enabled,
        /*
         * 调用名只对**启用中**的技能有意义。
         * 停用的技能不在 plugin 目录里,模型根本看不见它,给个调用名会让用户
         * 以为能用。
         */
        invokeAs: enabled ? invokeName(parsed.name) : '',
        fileCount,
        bytes,
        origin: meta[name] ?? null,
        nameProblem: parsed.nameProblem,
        dir,
      })
    }
  }

  // 启用的排前面,同类按名字 —— 稳定顺序,免得每次刷新条目乱跳
  out.sort((a, b) => (a.enabled === b.enabled ? a.name.localeCompare(b.name) : a.enabled ? -1 : 1))
  return out
}

/**
 * 启用 / 停用 —— 直接把目录在两边**移动**。
 *
 * 不用 settings.json 的 skillOverrides:实测报告显示它在部分版本上对模型
 * 不生效(模型仍然看得见被关掉的技能)。移动目录是可解释的:
 * 停用的技能根本不在 plugin 目录里,模型不可能看见它。
 */
export async function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
  const from = skillDir(name, !enabled)
  const to = skillDir(name, enabled)
  await fs.rename(from, to)
}

/**
 * 删除。整个目录连内容一起删 —— 技能是"一个目录",留一半没有意义。
 *
 * ⚠️ `recursive: true` 作用在一个由**用户给的 name** 拼出来的路径上,
 * 所以进门第一件事就是校验名字。少了这一步,`name = '../../..'` 就是一次
 * 任意目录删除。这是这个文件里最需要守住的一行。
 */
export async function deleteSkill(name: string): Promise<void> {
  const bad = validateSkillName(name)
  if (bad) throw new Error(`技能名不合法,拒绝删除:${bad}`)

  for (const enabled of [true, false]) {
    const dir = skillDir(name, enabled)
    try {
      await fs.rm(dir, { recursive: true, force: true })
    } catch {
      /* 不在这一边就算了 —— 两边都试,删掉哪个算哪个 */
    }
  }
  await forgetOrigin(name)
}

/**
 * 把一个技能目录装进库里。
 *
 * 名字以 **frontmatter 里声明的 name 为准**,不是源目录名 —— 规范要求两者一致,
 * 而作者写错目录名的情况很常见。我们按声明名落盘,于是"装进来就一定合规",
 * 不用把这个问题留给用户。
 *
 * 已存在同名技能时**抛错**而不是覆盖:覆盖会静默毁掉用户已经装好、可能还改过的东西。
 */
export async function installSkillDir(
  sourceDir: string,
  origin: SkillOrigin,
): Promise<{ name: string }> {
  await ensurePluginManifest()

  const src = path.resolve(sourceDir)
  const skillMdPath = await findSkillMd(src)
  if (!skillMdPath) {
    throw new Error('这个文件夹里没有找到 SKILL.md —— 技能目录里必须有它')
  }

  const text = await fs.readFile(skillMdPath, 'utf8')
  const sourceDirName = path.basename(path.dirname(skillMdPath))
  const parsed = parseSkillMd(text, sourceDirName)

  const bad = validateSkillName(parsed.name)
  if (bad) {
    throw new Error(
      `技能名「${parsed.name}」不合规范:${bad}\n` +
        `请在 SKILL.md 的 frontmatter 里把 name 改成小写字母数字加连字符。`,
    )
  }

  const target = skillDir(parsed.name, true)
  try {
    await fs.access(target)
    throw new Error(`已经有一个叫「${parsed.name}」的技能了 —— 先删掉它,或者改个名字`)
  } catch (e) {
    // access 抛 = 目标不存在 = 可以装。别的异常(比如上面那句 throw)继续往上抛
    if (e instanceof Error && e.message.includes('已经有一个')) throw e
  }

  // 复制**SKILL.md 所在的整个目录** —— references/、scripts/ 这些附属文件
  // 是技能的一部分,只搬 SKILL.md 会得到一个跑不起来的技能
  await fs.cp(path.dirname(skillMdPath), target, { recursive: true })
  await recordOrigin(parsed.name, origin)
  return { name: parsed.name }
}

/**
 * 找出技能目录里的 SKILL.md。
 *
 * 允许两种布局,因为两种都常见:
 *   - 目录本身就是技能(顶层就有 SKILL.md)—— 用户按规范打包的
 *   - 目录里装着若干技能(一层子目录里各自有 SKILL.md)—— 从 GitHub 下载下来的仓库
 *
 * 只往下看**一层**:再深就成了漫无目的地遍历整棵仓库树,而子目录布局的
 * 常见形态就是"仓库根 → 技能目录"这一层。
 *
 * 导出给 remote.ts(4.4 GitHub 安装)复用同一份定位逻辑。
 */
export async function findSkillMd(dir: string): Promise<string | null> {
  const top = path.join(dir, 'SKILL.md')
  try {
    if ((await fs.stat(top)).isFile()) return top
  } catch {
    /* 往下找 */
  }

  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }

  const found: string[] = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name, 'SKILL.md')
    try {
      if ((await fs.stat(p)).isFile()) found.push(p)
    } catch {
      /* 不是技能目录 */
    }
  }

  if (found.length === 0) return null
  if (found.length > 1) {
    /*
     * 多个技能 —— 让用户自己挑一个,而不是我们随便选一个装上。
     * 说清楚有几个、分别叫什么,他才好决定。
     */
    throw new Error(
      `这个文件夹里有 ${found.length} 个技能,请选其中某一个:\n` +
        found.map((f) => `  · ${path.basename(path.dirname(f))}`).join('\n'),
    )
  }
  return found[0]
}

/**
 * 「打开技能文件夹」打开哪里。
 *
 * 开**启用中**的那一层,不是 plugin 根:用户点这个按钮,十次里有九次是
 * 想手工丢一个技能进去。落到 `data\skills` 还得再点一层 `skills\` ——
 * 而那一层里还有 `.claude-plugin`,很容易点错。
 */
export function skillsDropDir(): string {
  return SKILLS_ENABLED_DIR
}
