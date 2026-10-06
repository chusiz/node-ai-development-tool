import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { PermissionMode } from '../../../shared/events'
import type { ToolDef } from './types'
import { killProcessTree } from '../kill'

/**
 * API 直连 agent 的工具集 —— 让它"能真的改代码"的那一半。
 *
 * ## ⚠️ 先把边界说清楚:这不是沙箱
 *
 * 这个文件里的措施**不是**安全隔离,而是**护栏**。真正的信任链是这样的:
 *
 *   用户自己选的模型(SDK 里是他自己的 Key) → 用户自己选的权限模式 → 工具执行
 *
 * 我们**不**假装能拦住一个恶意模型:它跟用户拥有同样的文件权限,而用户是
 * 主动把 Key 填进来、主动让它在这个目录里干活的。任何"我们做了沙箱"的说法
 * 都是骗人。所以这里只做三件**确实做得到**的事:
 *
 *   ① **路径围栏**:所有文件操作必须落在工作目录内。防的不是恶意模型,
 *      而是模型常见的"顺手去改 C:\Users\...\配置"或把相对路径算错跑到别处 ——
 *      这类错误一旦发生,后果是用户完全没预期的文件被改。
 *      围栏用 resolve + realpath **双重**校验,挡住 `..` 与符号链接/junction。
 *
 *   ② **权限模式分级**:`plan` 模式连 write_file 都不给模型看(不是"给了再拒绝",
 *      而是压根不放进 tools 数组)。模型看不见的工具不可能被调用 ——
 *      这比"调用了再拦"少一整类绕过。
 *
 *   ③ **不给出无限资源**:命令有超时,输出有上限,读取有行数上限。
 *      防的是"一条 `npm run dev` 挂到天荒地老"和"cat 一个 2GB 的日志把内存打爆"。
 *
 * ## 关于 run_command 用 shell
 *
 * 命令是交给平台 shell 跑的(`cmd.exe /d /s /c` 或 `/bin/sh -c`)。不这么做的话
 * `npm install && npm test` 这种最普通的写法就跑不了 —— 而"pipelines 跑不起来"
 * 会让这个功能废掉一半。代价是命令串里的 `&`、`|` 有注入语义,**但注入者就是
 * 用户自己的模型**,与用户自己在终端敲一条命令等价。所以这里选择功能,
 * 并把风险如实写在上面那段里,而不是偷偷换成 argv 拆分(那样会静默地
 * 把一多半命令跑坏,还很难排查)。
 */

/** 单次工具输出回给模型的上限。超了截断 —— 不然一个大文件就能把上下文塞爆 */
const MAX_OUTPUT_CHARS = 24_000
/** 读文件默认行数上限 */
const DEFAULT_READ_LINES = 2000
/** 写文件大小上限(1MB)。代码文件不该这么大 */
const MAX_WRITE_BYTES = 1024 * 1024
/** 命令默认超时 */
const DEFAULT_CMD_TIMEOUT_MS = 120_000

/* ============================================================
   工具声明
   ============================================================ */

const READ_TOOLS: ToolDef[] = [
  {
    name: 'read_file',
    description:
      '读取工作目录内某个文本文件的内容,带行号。大文件请配合 offset/limit 分段读。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作目录的路径,例如 src/main/index.ts' },
        offset: { type: 'number', description: '起始行号(从 1 开始)。可选' },
        limit: { type: 'number', description: `最多读取多少行,默认 ${DEFAULT_READ_LINES}` },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description: '列出工作目录内某个目录下的文件与子目录。省略 path 就是工作目录根。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作目录的目录路径。可选' } },
      required: [],
    },
  },
  {
    name: 'search_files',
    description:
      '在工作目录内搜索。mode=name 按文件名子串匹配;mode=content 搜文件内容(返回命中行)。' +
      '找"某个函数在哪定义"这类问题用 content,找"某个文件在哪"用 name。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查找的字符串' },
        mode: { type: 'string', enum: ['name', 'content'], description: '默认 content' },
        path: { type: 'string', description: '限定在哪个子目录里搜。可选' },
      },
      required: ['query'],
    },
  },
]

const WRITE_TOOLS: ToolDef[] = [
  {
    name: 'write_file',
    description:
      '把内容整体写入工作目录内的某个文件(已存在则覆盖)。父目录会自动创建。' +
      '只做小改动时请优先用 edit_file,不要整文件重写。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作目录的路径' },
        content: { type: 'string', description: '文件的完整内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      '把文件里**唯一出现**的 old 精确替换成 new。这是改代码的首选方式 —— ' +
      '比 write_file 整文件重写安全得多。old 必须逐字匹配(含缩进),且在文件中只出现一次。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作目录的路径' },
        old: { type: 'string', description: '要被替换的原文,必须唯一且逐字匹配' },
        new: { type: 'string', description: '替换后的内容' },
      },
      required: ['path', 'old', 'new'],
    },
  },
]

const RUN_TOOL: ToolDef = {
  name: 'run_command',
  description:
    '在工作目录里执行一条命令(例如 npm test、npm run build、git status),返回标准输出与错误输出。' +
    '命令有超时,别用来起长期驻留的服务。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的完整命令' },
      timeoutSec: { type: 'number', description: '超时秒数,默认 120' },
    },
    required: ['command'],
  },
}

/**
 * 按权限模式挑出**暴露给模型**的工具。
 *
 * ⚠️ 关键在于"暴露"而不是"事后拒绝":模型看不到 write_file,就不可能
 * 试图调用它,也就不存在"它在提示词里被说服绕过检查"的可能。
 *
 * manual 与 acceptEdits 同档的原因:API 型会话没有交互式确认通道
 * (CLI 那边靠 --permission-mode 交给 CLI 自己问)。硬把 manual 做成"只读"
 * 会让用户以为选了个中间档,实际得到的是 plan —— 不如明确按 acceptEdits
 * 处理,并在 README/设置页里说清楚。
 */
export function toolsFor(mode: PermissionMode): ToolDef[] {
  if (mode === 'plan') return [...READ_TOOLS]
  return [...READ_TOOLS, ...WRITE_TOOLS, RUN_TOOL]
}

/* ============================================================
   路径围栏
   ============================================================ */

function isInside(root: string, target: string): boolean {
  const r = path.resolve(root)
  const t = path.resolve(target)
  const win = process.platform === 'win32'
  const a = win ? t.toLowerCase() : t
  const b = win ? r.toLowerCase() : r
  if (a === b) return true
  return a.startsWith(b.endsWith(path.sep) ? b : b + path.sep)
}

/**
 * 对**已存在的那一段**做 realpath,再把不存在的尾巴拼回去。
 *
 * 为什么不能直接 `fs.realpathSync(target)`:写新文件时目标还不存在,
 * realpath 会抛 ENOENT。但它**所在的目录**存在 —— 而符号链接逃逸恰恰发生在
 * 目录那一层(`项目/link -> C:\Windows`)。所以往上找到第一个存在的祖先做
 * realpath,就能拦住这条路,同时不影响"创建新文件"。
 */
function realpathOfLongestExisting(p: string): string {
  const abs = path.resolve(p)
  const tail: string[] = []
  let cur = abs
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur)
      return tail.length ? path.join(real, ...tail.slice().reverse()) : real
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return abs // 一路到卷根都不存在,放弃 realpath
      tail.push(path.basename(cur))
      cur = parent
    }
  }
}

export type ResolveResult = { ok: true; abs: string } | { ok: false; reason: string }

/**
 * 把模型给的路径解析成工作目录内的绝对路径。拒绝一切越界。
 *
 * ## 挡的是什么(每一条都对应一个 e2e 用例)
 *
 *   `../../../etc/passwd` —— resolve 后落在根外 → 拒
 *   `C:\Windows\System32` —— 绝对路径,不在工作目录下 → 拒
 *   `\\server\share\x`    —— UNC,resolve 后不可能是工作目录的子路径 → 拒
 *   指向外部的符号链接/junction —— resolve 通过但 realpath 落在根外 → 拒
 *   `CON` / `NUL` / `COM1` 等保留名 —— Windows 上会打开设备而不是文件 → 拒
 *                               (**逐段**检查:`sub\NUL.txt` 同样命中)
 *   `\0` 注入 —— 会被底层截断成另一个路径 → 拒
 */
export function resolveInsideRoot(root: string, raw: string): ResolveResult {
  if (typeof raw !== 'string') return { ok: false, reason: '路径必须是字符串' }
  if (raw.includes('\0')) return { ok: false, reason: '路径里不能有 NUL 字节' }
  const p = raw.trim()
  if (!p) return { ok: false, reason: '路径不能为空' }

  /*
   * Windows 设备名。`CON` / `NUL` / `COM1` 这类会被系统当成设备打开,
   * 既不是文件也不是目录,而 resolve 完全看不出异常。
   *
   * ⚠️ 必须**逐段**检查,不能只看第一段。Win32 对设备名的识别是按路径分量做的:
   * `sub/NUL.txt` 一样会打开 NUL 设备。之前这里只取了 `p.split(sep)[0]`,
   * 于是 `sub\NUL.txt` 从缝里漏了过去 —— 对一个能写文件的 agent 来说,
   * "能写到哪个名字"就是它的能力边界,这条缝必须补上。
   *
   * 另外两处细节也都对应真实的 Windows 行为:
   *   - 设备名后的**扩展名被忽略**:`NUL.txt` 仍是 NUL 设备;
   *   - 结尾的**点与空格被剥掉**:`NUL.` / `NUL ` 同样命中。
   * 而 `COM10` 之后的数字不再保留(只有 COM1–COM9 是设备),所以正则要锚定到单数字。
   */
  if (process.platform === 'win32') {
    for (const seg of p.split(/[\\/]+/)) {
      const stem = seg.replace(/[. ]+$/, '').replace(/\.[^.]*$/, '').toUpperCase()
      if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
        return { ok: false, reason: `"${seg}" 是 Windows 保留设备名,不能当文件路径用` }
      }
    }
  }

  const abs = path.resolve(root, p)
  if (!isInside(root, abs)) {
    return { ok: false, reason: `路径超出工作目录范围:${p}` }
  }

  const realRoot = realpathOfLongestExisting(root)
  const realTarget = realpathOfLongestExisting(abs)
  if (!isInside(realRoot, realTarget)) {
    return {
      ok: false,
      reason: `路径经符号链接解析后落在工作目录之外:${p}`,
    }
  }

  return { ok: true, abs }
}

/* ============================================================
   工具执行
   ============================================================ */

export interface ToolCtx {
  /** 工作目录。所有文件操作都被围在这个目录里 */
  root: string
  mode: PermissionMode
  /** 取消信号 —— 用户点取消时要能让正在跑的命令停下来 */
  isCancelled(): boolean
}

interface ToolResult {
  content: string
  isError: boolean
}

function ok(s: string): ToolResult {
  return { content: truncate(s), isError: false }
}
function err(s: string): ToolResult {
  return { content: truncate(s), isError: true }
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s
  return `${s.slice(0, MAX_OUTPUT_CHARS)}\n\n…(输出过长,已截断,共 ${s.length} 字符)`
}

/** 参数取值。模型给的 JSON 里字段可能缺失或类型不对,这里统一兜住 */
function pickString(a: Record<string, unknown>, k: string): string {
  const v = a[k]
  return typeof v === 'string' ? v : ''
}
function pickNumber(a: Record<string, unknown>, k: string): number | undefined {
  const v = a[k]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export async function executeTool(
  name: string,
  rawArgs: string,
  ctx: ToolCtx,
): Promise<ToolResult> {
  let args: Record<string, unknown>
  try {
    const parsed = rawArgs?.trim() ? JSON.parse(rawArgs) : {}
    args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return err(`参数不是合法 JSON,无法执行 ${name}。收到的参数:${rawArgs.slice(0, 200)}`)
  }

  // 权限闸门(第二道)。toolsFor 已经按模式裁过列表,这里是纵深防御 ——
  // 万一某条路径把完整列表泄漏给了 plan 模式,这一层还能兜住
  if (ctx.mode === 'plan' && (name === 'write_file' || name === 'edit_file' || name === 'run_command')) {
    return err(`当前是「只做计划」权限模式,不允许 ${name}。需要写入或执行命令请把节点权限模式改成「接受编辑」。`)
  }

  try {
    switch (name) {
      case 'read_file':
        return await readFile(args, ctx)
      case 'list_dir':
        return await listDir(args, ctx)
      case 'search_files':
        return await searchFiles(args, ctx)
      case 'write_file':
        return await writeFile(args, ctx)
      case 'edit_file':
        return await editFile(args, ctx)
      case 'run_command':
        return await runCommand(args, ctx)
      default:
        return err(`没有这个工具:${name}`)
    }
  } catch (e) {
    return err(`${name} 执行失败:${e instanceof Error ? e.message : String(e)}`)
  }
}

/* ---------------- 读 ---------------- */

async function readFile(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const rel = pickString(args, 'path')
  const r = resolveInsideRoot(ctx.root, rel)
  if (!r.ok) return err(r.reason)

  const st = await fsp.stat(r.abs).catch(() => null)
  if (!st) return err(`文件不存在:${rel}`)
  if (st.isDirectory()) return err(`${rel} 是目录,不是文件。用 list_dir 看它下面有什么。`)
  // 二进制文件读出来是一堆乱码,白白吃掉上下文
  if (st.size > MAX_WRITE_BYTES * 4) {
    return err(`${rel} 太大(${Math.round(st.size / 1024)}KB),不适合整个读取。请用 search_files 定位。`)
  }

  const raw = await fsp.readFile(r.abs, 'utf8')
  if (raw.includes('\0')) return err(`${rel} 看起来是二进制文件,已拒绝读取。`)

  const lines = raw.split(/\r?\n/)
  const offset = Math.max(1, pickNumber(args, 'offset') ?? 1)
  const limit = Math.max(1, Math.min(20_000, pickNumber(args, 'limit') ?? DEFAULT_READ_LINES))
  const slice = lines.slice(offset - 1, offset - 1 + limit)

  // 带行号:模型要改文件时得知道行号,而我们后面 edit_file 是按内容匹配的,
  // 行号只帮它定位,不影响正确性
  const body = slice.map((l, i) => `${String(offset + i).padStart(5)}│ ${l}`).join('\n')
  const more = offset - 1 + slice.length < lines.length
  return ok(
    `${rel}(共 ${lines.length} 行${more ? `,以下只到第 ${offset - 1 + slice.length} 行` : ''}):\n${body}`,
  )
}

async function listDir(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const rel = pickString(args, 'path')
  const r = resolveInsideRoot(ctx.root, rel || '.')
  if (!r.ok) return err(r.reason)

  const entries = await fsp.readdir(r.abs, { withFileTypes: true }).catch(() => null)
  if (!entries) return err(`目录不存在:${rel || '.'}`)

  const dirs = entries.filter((e) => e.isDirectory()).map((e) => `${e.name}/`)
  const files = entries.filter((e) => !e.isDirectory()).map((e) => e.name)
  // 目录在前、文件在后,各自排序 —— 让模型一眼看出结构
  const list = [...dirs.sort(), ...files.sort()]
  if (list.length === 0) return ok(`${rel || '.'} 是空目录`)
  return ok(`${rel || '.'}(${dirs.length} 个目录,${files.length} 个文件):\n${list.join('\n')}`)
}

/** 搜索时跳过的目录。不跳的话 node_modules 会让每次搜索都跑几十秒且全是噪音 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'release',
  '.next',
  '.cache',
  '__pycache__',
  'venv',
  '.venv',
])

async function searchFiles(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const query = pickString(args, 'query')
  if (!query) return err('query 不能为空')
  const mode = pickString(args, 'mode') === 'name' ? 'name' : 'content'
  const sub = pickString(args, 'path')
  const base = resolveInsideRoot(ctx.root, sub || '.')
  if (!base.ok) return err(base.reason)

  const hits: string[] = []
  const MAX_HITS = 60
  const MAX_FILES = 4000
  let scanned = 0

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (hits.length >= MAX_HITS || scanned >= MAX_FILES || depth > 8) return
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (hits.length >= MAX_HITS || scanned >= MAX_FILES) return
      const full = path.join(dir, e.name)
      const relPath = path.relative(ctx.root, full).split(path.sep).join('/')
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        await walk(full, depth + 1)
        continue
      }
      scanned++
      if (mode === 'name') {
        if (e.name.toLowerCase().includes(query.toLowerCase())) hits.push(relPath)
        continue
      }
      // content 模式:只搜看起来是文本的文件
      if (!/\.(ts|tsx|js|jsx|mjs|cjs|json|md|txt|css|html|py|go|rs|java|c|cpp|h|yml|yaml|toml|sh|ps1)$/i.test(e.name)) {
        continue
      }
      try {
        const st = await fsp.stat(full)
        if (st.size > 512 * 1024) continue
        const text = await fsp.readFile(full, 'utf8')
        if (text.includes('\0')) continue
        const lines = text.split(/\r?\n/)
        for (let i = 0; i < lines.length && hits.length < MAX_HITS; i++) {
          if (lines[i]!.includes(query)) {
            hits.push(`${relPath}:${i + 1}: ${lines[i]!.trim().slice(0, 160)}`)
          }
        }
      } catch {
        /* 读不了就跳过 */
      }
    }
  }

  await walk(base.abs, 0)

  if (hits.length === 0) return ok(`没有找到匹配「${query}」的内容(已扫描 ${scanned} 个文件)`)
  const capped = hits.length >= MAX_HITS ? `\n\n(已截断,只显示前 ${MAX_HITS} 条)` : ''
  return ok(`找到 ${hits.length} 处匹配:\n${hits.join('\n')}${capped}`)
}

/* ---------------- 写 ---------------- */

async function writeFile(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const rel = pickString(args, 'path')
  const content = args.content
  if (typeof content !== 'string') return err('content 必须是字符串')
  const r = resolveInsideRoot(ctx.root, rel)
  if (!r.ok) return err(r.reason)

  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_WRITE_BYTES) {
    return err(`内容太大(${Math.round(bytes / 1024)}KB),超过 1MB 上限。`)
  }

  await fsp.mkdir(path.dirname(r.abs), { recursive: true })
  await fsp.writeFile(r.abs, content, 'utf8')
  return ok(`已写入 ${rel}(${bytes} 字节,${content.split(/\r?\n/).length} 行)`)
}

async function editFile(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const rel = pickString(args, 'path')
  const oldStr = args.old
  const newStr = args.new
  if (typeof oldStr !== 'string' || typeof newStr !== 'string') {
    return err('old 与 new 都必须是字符串')
  }
  if (!oldStr) return err('old 不能为空')
  const r = resolveInsideRoot(ctx.root, rel)
  if (!r.ok) return err(r.reason)

  const text = await fsp.readFile(r.abs, 'utf8').catch(() => null)
  if (text === null) return err(`文件不存在:${rel}`)

  const first = text.indexOf(oldStr)
  if (first < 0) {
    return err(
      `在 ${rel} 里找不到要替换的内容。请先 read_file 确认原文(缩进与换行必须逐字一致)。`,
    )
  }
  // 唯一性检查:出现多次时替换哪一个都是猜,而猜错会静默改坏别处
  if (text.indexOf(oldStr, first + oldStr.length) >= 0) {
    return err(
      `要替换的内容在 ${rel} 里出现了多次,无法确定改哪一处。` +
        `请把 old 扩大一些(带上前后几行)让它唯一。`,
    )
  }

  const next = text.slice(0, first) + newStr + text.slice(first + oldStr.length)
  await fsp.writeFile(r.abs, next, 'utf8')
  const line = text.slice(0, first).split(/\r?\n/).length
  return ok(`已修改 ${rel}(第 ${line} 行附近)`)
}

/* ---------------- 执行命令 ---------------- */

/**
 * 手滑拦截表。**这不是安全边界** —— 绕过它有一万种写法(别名、脚本、变量拼接)。
 * 它只防一件事:模型把"格式化/关机"这类不可逆操作当成"清理一下"顺手发出去。
 * 真正的边界是权限模式(plan 模式根本不给这个工具)。
 */
const GUARDED = [/\bformat\s+[a-z]:/i, /\bmkfs\b/i, /\bdiskpart\b/i, /\bshutdown\b/i, /\brm\s+-rf\s+\/(\s|$)/i]

async function runCommand(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const command = pickString(args, 'command').trim()
  if (!command) return err('command 不能为空')
  if (ctx.isCancelled()) return err('已被取消')

  for (const re of GUARDED) {
    if (re.test(command)) {
      return err(`这条命令会做不可逆的系统级操作,已拒绝执行:${command}`)
    }
  }

  const timeoutSec = Math.min(600, Math.max(1, pickNumber(args, 'timeoutSec') ?? 120))
  const timeoutMs = timeoutSec * 1000

  const win = process.platform === 'win32'
  const shellExe = win ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'
  const shellArgs = win ? ['/d', '/s', '/c', command] : ['-c', command]

  return await new Promise<ToolResult>((resolve) => {
    let out = ''
    let settled = false
    const finish = (r: ToolResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(cancelPoll)
      resolve(r)
    }

    const child = spawn(shellExe, shellArgs, {
      cwd: ctx.root,
      windowsHide: true,
      // shell:true 在这里是多余的一层 —— 我们已经显式拉起 shell 了。
      // 用 true 会让参数再过一遍 cmd 解析,中文与引号都会出问题
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const append = (s: string): void => {
      // 超过上限后仍然继续消费(见下面 stdout 的 data 处理),
      // 但不再累积 —— 目的是不让内存被一条 `npm run build` 的日志撑爆
      if (out.length < MAX_OUTPUT_CHARS * 2) out += s
    }

    child.stdout?.setEncoding('utf-8')
    child.stderr?.setEncoding('utf-8')
    child.stdout?.on('data', (c: string) => append(c))
    child.stderr?.on('data', (c: string) => append(c))

    const timer = setTimeout(() => {
      if (child.pid !== undefined) void killProcessTree(child.pid)
      else child.kill()
      finish(err(`命令超时(${timeoutSec} 秒)已被终止。输出:\n${out}`))
    }, timeoutMs)

    // 取消轮询:killProcessTree 是异步的,而用户点取消后不该等超时才停
    const cancelPoll = setInterval(() => {
      if (ctx.isCancelled()) {
        if (child.pid !== undefined) void killProcessTree(child.pid)
        else child.kill()
        finish(err(`已被取消。输出:\n${out}`))
      }
    }, 500)

    child.on('error', (e) => finish(err(`无法执行命令:${e.message}`)))
    child.on('close', (code) => {
      const body = out.trim() || '(没有输出)'
      finish(
        code === 0
          ? ok(`命令执行成功(退出码 0):\n${body}`)
          : err(`命令退出码 ${code}:\n${body}`),
      )
    })
  })
}
