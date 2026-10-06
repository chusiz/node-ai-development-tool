/*
 * 从 GitHub / Gitee 安装开源 Skill(v0.6.2,设计 4.4 的 S1 + S3 地基)。
 *
 * 链路:URL 白名单解析 → codeload zip 下载 → adm-zip 解压(防 zip slip)→
 * findSkillMd + validateSkillName → 拷贝进技能库(复用 installSkillDir)。
 * 安全前置(必须与功能同时落地):
 *   ① 只认 github.com / gitee.com 的 https URL;
 *   ② 解压时逐条校验条目路径,拒绝任何"跳出解压目录"的条目(zip slip);
 *   ③ SKILL.md 与 scripts/ 做危险命令扫描,高风险给红色警告(不自动执行)。
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { installSkillDir } from './store'
import type { SkillOrigin } from '../../shared/ipc'

// adm-zip 没有官方类型;运行时是纯 JS,这里补最小类型
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AdmZip = require('adm-zip') as new (file?: string | Buffer) => AdmZipInstance

interface AdmZipInstance {
  getEntries(): { entryName: string; isDirectory: boolean }[]
  extractAllTo(target: string, overwrite: boolean): void
  readAsText(entry: { entryName: string }): string
}

/** 允许的代码托管域名(白名单)。其它一律拒绝 —— 见 S1 安全前置 */
export const ALLOWED_HOSTS = new Set(['github.com', 'gitee.com'])

export interface ParsedRepoUrl {
  host: 'github.com' | 'gitee.com'
  owner: string
  repo: string
  /** 分支/tag。默认 main */
  ref: string
  /** 仓库内子路径(把 zip 解压范围进一步缩小到该目录) */
  subpath: string
}

/** 解析仓库 URL。非法 / 不在白名单 → 返回一句人话错误。 */
export function parseRepoUrl(raw: string): { ok: true; parsed: ParsedRepoUrl } | { ok: false; error: string } {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return { ok: false, error: '这不像一个 URL —— 请粘贴形如 https://github.com/owner/repo 的地址' }
  }
  if (u.protocol !== 'https:') return { ok: false, error: '只支持 https 地址(不允许 http / file / 其它协议)' }
  if (!ALLOWED_HOSTS.has(u.hostname)) {
    return { ok: false, error: `域名不在白名单里 —— 目前只支持 ${[...ALLOWED_HOSTS].join(' / ')}` }
  }
  const segs = u.pathname.split('/').filter(Boolean)
  // 最少 owner/repo;多余段按 /tree/<ref>/<subpath…> 解释
  if (segs.length < 2) return { ok: false, error: '仓库地址至少要 owner/repo 两段,例如 github.com/anthropics/skills' }
  const [owner, repo, mode, ref, ...rest] = segs
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    return { ok: false, error: 'owner / repo 名字含有非法字符' }
  }
  let refValue = ''
  let subpath = ''
  if (segs.length >= 3) {
    if (mode !== 'tree' && mode !== 'blob') {
      return { ok: false, error: `链接格式不支持(第 3 段是「${mode}」)—— 请复制仓库主页地址,或形如 …/tree/main 的地址` }
    }
    if (segs.length === 3) return { ok: false, error: 'tree 后面还要跟分支名,例如 …/tree/main' }
    refValue = ref
    subpath = rest.join('/')
  }
  if (segs.length >= 3 && !refValue) return { ok: false, error: '分支名不能为空' }
  return {
    ok: true,
    parsed: {
      host: u.hostname as 'github.com' | 'gitee.com',
      owner,
      repo,
      ref: refValue || 'main',
      subpath,
    },
  }
}

/** codeload 下载地址(gitee 用自己的归档接口) */
export function zipUrl(p: ParsedRepoUrl): string {
  if (p.host === 'github.com') {
    return `https://codeload.github.com/${p.owner}/${p.repo}/zip/refs/heads/${p.ref}`
  }
  return `https://gitee.com/${p.owner}/${p.repo}/repository/archive/${p.ref}.zip`
}

/** 下载 zip 到临时目录,返回 zip 绝对路径(≤ 64MB,防炸弹) */
export async function downloadZip(url: string): Promise<string> {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) })
  if (!res.ok) {
    throw new Error(`下载失败(HTTP ${res.status})—— 检查 owner/repo/分支拼写是否正确、仓库是否为公开`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength > 64 * 1024 * 1024) {
    throw new Error('压缩包超过 64MB —— 技能仓库不该这么大,拒绝安装(防解压炸弹)')
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chusiz-skill-'))
  const zip = path.join(dir, 'repo.zip')
  await fs.writeFile(zip, buf)
  return zip
}

/**
 * 安全解压:逐条校验条目路径,任何"跳出去"的条目直接整包拒绝(zip slip)。
 * 解压后返回根目录(去掉 GitHub zip 的顶层仓库目录层)。
 */
export async function safeExtract(zipPath: string): Promise<string> {
  const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'chusiz-skill-x-'))
  const zip = new AdmZip(zipPath)
  const entries = zip.getEntries()
  for (const e of entries) {
    if (e.isDirectory) continue
    const norm = e.entryName.replace(/\\/g, '/')
    if (norm.startsWith('/') || norm.split('/').includes('..')) {
      throw new Error(`压缩包里发现了非法路径「${e.entryName}」—— 已拒绝解压(zip slip 防护)`)
    }
    if (norm.length === 0) continue
    // 解压后落点必须在 dest 内(再兜一层)
    const abs = path.resolve(dest, norm)
    if (abs !== dest && !abs.startsWith(dest + path.sep)) {
      throw new Error(`压缩包条目「${e.entryName}」企图写到解压目录之外 —— 已拒绝`)
    }
  }
  zip.extractAllTo(dest, true)
  return dest
}

/** GitHub zip 顶层通常是 `<repo>-<ref>/`;解开这层,返回仓库根 */
async function stripTopLevel(root: string): Promise<string> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  const dirs = entries.filter((e) => e.isDirectory())
  if (dirs.length === 1) {
    const child = path.join(root, dirs[0].name)
    // 该层里是不是有 SKILL.md 或明显是仓库布局?(避免把单技能目录也剥掉)
    const hasSkill = await fs
      .stat(path.join(child, 'SKILL.md'))
      .then(() => true)
      .catch(() => false)
    if (hasSkill) return child
    return root
  }
  return root
}

/** 危险命令扫描:SKILL.md 与 scripts/ 下的脚本里出现即记一条(不自动执行) */
export interface DangerScan {
  /** 命中条目:[文件相对路径, 命中片段] */
  hits: [string, string][]
}

const DANGEROUS_PATTERNS: [RegExp, string][] = [
  [/rm\s+-rf\s+[~/]?\//, 'rm -rf 删根目录'],
  [/curl[^\n]*\|[^\n]*(sh|bash)/i, 'curl | sh 下载即执行'],
  [/Invoke-WebRequest[^\n]*(irm|iex)/i, 'PowerShell 下载即执行'],
  [/\|?\s*(sudo\s+)?bash\s+[^\n]*(<|curl|wget)/i, 'bash 执行远程内容'],
  [/powershell[^\n]*(EncodedCommand|-e\s+)/i, 'PowerShell 编码命令'],
  [/eval\s*\(\s*(process|require|fetch|exec)/i, 'eval 远程/进程内容'],
]

/** 扫一个已解压的技能目录。命中只提示,不阻断安装(装不装由 UI 决定) */
export async function scanDangerousScripts(skillRoot: string, skillMdPath: string): Promise<DangerScan> {
  const hits: [string, string][] = []
  const files = [skillMdPath]
  try {
    const scripts = await fs.readdir(path.join(skillRoot, 'scripts'))
    for (const f of scripts) {
      if (f.endsWith('.md') || f.startsWith('.')) continue
      files.push(path.join(skillRoot, 'scripts', f))
    }
  } catch {
    /* 没有 scripts/ 目录 */
  }
  for (const f of files) {
    let text: string
    try {
      text = await fs.readFile(f, 'utf8')
    } catch {
      continue
    }
    for (const [re, label] of DANGEROUS_PATTERNS) {
      if (re.test(text)) {
        hits.push([path.relative(skillRoot, f).replace(/\\/g, '/'), label])
      }
    }
  }
  return { hits }
}

/**
 * 收集一个目录里的**全部**技能目录(顶层 + 一层子目录)。
 *
 * 与 store.findSkillMd 的区别:远程仓库常是**合集**(如 anthropics/skills
 * 根目录就是几十个技能),逐个挑太反人类 —— 这里直接收齐,UI 显示"将安装 N 个技能"。
 */
export async function collectSkillDirs(searchRoot: string): Promise<string[]> {
  const out: string[] = []
  const top = path.join(searchRoot, 'SKILL.md')
  try {
    if ((await fs.stat(top)).isFile()) return [searchRoot]
  } catch {
    /* 往下找 */
  }
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(searchRoot, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const p = path.join(searchRoot, e.name, 'SKILL.md')
    try {
      if ((await fs.stat(p)).isFile()) out.push(path.join(searchRoot, e.name))
    } catch {
      /* 不是技能目录 */
    }
  }
  return out
}

/**
 * 从 URL 安装技能(设计 4.4 S1):
 * 解析 → 下载 → 安全解压 → 收集技能目录 → 危险扫描 → 复用 installSkillDir 逐个落盘。
 * 返回:技能名列表 + 危险扫描命中(UI 决定是否警示)。
 */
export async function installSkillFromUrl(
  rawUrl: string,
): Promise<{ names: string[]; dangerHits: [string, string][] }> {
  const parsed = parseRepoUrl(rawUrl)
  if (!parsed.ok) throw new Error(parsed.error)
  const zipPath = await downloadZip(zipUrl(parsed.parsed))
  const root = await safeExtract(zipPath)
  const repoRoot = await stripTopLevel(root)

  // 有子路径(tree/main/path):把范围收窄到该子路径
  let searchRoot = repoRoot
  if (parsed.parsed.subpath) {
    const sub = path.resolve(repoRoot, ...parsed.parsed.subpath.split('/'))
    if (sub === repoRoot || !sub.startsWith(repoRoot + path.sep)) {
      throw new Error('子路径越界 —— 已拒绝')
    }
    try {
      await fs.stat(sub)
      searchRoot = sub
    } catch {
      throw new Error(`仓库里没有这个子路径「${parsed.parsed.subpath}」`)
    }
  }

  const skillDirs = await collectSkillDirs(searchRoot)
  if (skillDirs.length === 0) {
    throw new Error('这个仓库里没找到 SKILL.md —— 请确认它是个技能仓库,或给出 tree/main/<技能目录> 的地址')
  }

  // 危险扫描:每个技能目录单独扫(命中只提示,不阻断)
  const dangerHits: [string, string][] = []
  for (const d of skillDirs) {
    const scan = await scanDangerousScripts(d, path.join(d, 'SKILL.md'))
    dangerHits.push(...scan.hits)
  }

  const origin: SkillOrigin = { kind: 'github', url: rawUrl.trim(), at: Date.now() }
  const names: string[] = []
  for (const d of skillDirs) {
    const { name } = await installSkillDir(d, origin)
    names.push(name)
  }
  return { names, dangerHits }
}
