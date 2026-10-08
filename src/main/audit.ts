/**
 * 生成代码安全审计(v0.6.4,改进建议第六条):
 *   - 依赖审计:项目有 package.json 时跑 `npm audit --json`,报告漏洞数(高危/严重);
 *   - 密钥泄露检测:扫描生成代码中的硬编码密钥模式(sk- / AKIA / ark- / github_pat 等)。
 *
 * 纯 node 实现(无 electron 依赖),供:
 *   - 输出节点打包前自动调用(packager 前置);
 *   - MCP / e2e 直接调用。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** 硬编码密钥的常见形态。宁可误报多一个,不可漏一个 —— 误报只进报告,不阻断打包 */
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'OpenAI/Anthropic sk-', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'Volcengine ark-', re: /\bark-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  { name: 'GitHub PAT', re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g },
  { name: 'GitHub classic token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: 'Private key header', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
]

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'release', 'win-unpacked', '.tmp', '__pycache__', 'venv', '.venv'])
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.html', '.css', '.py', '.go', '.rs', '.java', '.sh', '.ps1', '.bat', '.cmd', '.md', '.yml', '.yaml', '.env', '.txt'])

export interface AuditSecretHit {
  file: string
  pattern: string
  /** 命中的密钥片段(脱敏:只留前 8 位 + …) */
  snippet: string
}

export interface AuditReport {
  ok: boolean
  secrets: AuditSecretHit[]
  /** npm audit 结果。null = 项目无 package.json 或 npm 不可用 */
  npmAudit: {
    vulnerabilities: number
    critical: number
    high: number
  } | null
  /** 审计动作的完整文本(写给用户/写进产物报告) */
  summary: string
}

/** 纯函数:从一段文本里提取命中的密钥模式(可单测) */
export function scanSecretsInText(text: string): { pattern: string; snippet: string }[] {
  const hits: { pattern: string; snippet: string }[] = []
  for (const { name, re } of SECRET_PATTERNS) {
    const m = text.match(re)
    if (m) {
      for (const raw of m.slice(0, 3)) {
        hits.push({ pattern: name, snippet: raw.length > 12 ? `${raw.slice(0, 8)}…(len ${raw.length})` : raw })
      }
    }
  }
  return hits
}

/** 纯函数:是否该扫这个文件(可单测) */
export function shouldScanFile(p: string): boolean {
  const base = path.basename(p)
  if (base.startsWith('.')) return base === '.env'
  return TEXT_EXT.has(path.extname(p).toLowerCase())
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) await walk(p, out)
    else if (e.isFile() && shouldScanFile(p)) out.push(p)
  }
}

/** 递归扫描项目目录里的密钥。dir 不存在 → 空结果(不报错) */
export async function scanSecretsInDir(dir: string): Promise<AuditSecretHit[]> {
  if (!dir || !fs.existsSync(dir)) return []
  const files: string[] = []
  await walk(dir, files)
  const hits: AuditSecretHit[] = []
  for (const f of files) {
    if (hits.length >= 50) break // 报告上限,防刷屏
    let text: string
    try {
      text = await fs.promises.readFile(f, 'utf8')
    } catch {
      continue
    }
    for (const h of scanSecretsInText(text)) {
      hits.push({ file: path.relative(dir, f), pattern: h.pattern, snippet: h.snippet })
    }
  }
  return hits
}

/** 跑 npm audit(有 package.json 且有 npm 时)。失败 → null(审计失败不算打包失败) */
export async function runNpmAudit(dir: string): Promise<AuditReport['npmAudit']> {
  const pkg = path.join(dir, 'package.json')
  if (!fs.existsSync(pkg)) return null
  return new Promise((resolve) => {
    const child = spawn('npm', ['audit', '--json'], {
      cwd: dir,
      windowsHide: true,
      shell: false,
      timeout: 60_000,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      // npm audit 退出码非 0 = 有漏洞(这正是我们想要的信号),不代表失败
      if (code === null) return resolve(null)
      try {
        const j = JSON.parse(out)
        const meta = j?.metadata?.vulnerabilities
        if (!meta) return resolve(null)
        resolve({
          vulnerabilities: meta.total ?? 0,
          critical: meta.critical ?? 0,
          high: meta.high ?? 0,
        })
      } catch {
        // npm 老版本 / 网络不通:给不出结构化结果,不阻塞
        resolve(null)
      }
    })
  })
}

/** 对项目目录做完整审计:密钥扫描 + npm audit */
export async function auditProject(dir: string): Promise<AuditReport> {
  const [secrets, npmAudit] = await Promise.all([scanSecretsInDir(dir), runNpmAudit(dir)])

  const lines: string[] = []
  if (secrets.length === 0) lines.push('✅ 未发现硬编码密钥')
  else {
    lines.push(`⚠️ 发现 ${secrets.length} 处疑似硬编码密钥:`)
    for (const s of secrets.slice(0, 10)) lines.push(`  - ${s.file}: ${s.pattern} (${s.snippet})`)
    if (secrets.length > 10) lines.push(`  … 其余 ${secrets.length - 10} 处略`)
  }
  if (!npmAudit) {
    lines.push('ℹ️ 无 package.json 或 npm 不可用,跳过依赖审计')
  } else if (npmAudit.vulnerabilities === 0) {
    lines.push('✅ npm audit:0 个已知漏洞')
  } else {
    lines.push(
      `⚠️ npm audit:${npmAudit.vulnerabilities} 个漏洞(高危 ${npmAudit.high} / 严重 ${npmAudit.critical})`,
    )
  }

  return {
    ok: secrets.length === 0 && (npmAudit?.vulnerabilities ?? 0) === 0,
    secrets,
    npmAudit,
    summary: lines.join('\n'),
  }
}
