/**
 * v0.6.6 工程化节点群执行器(确定性,不耗 LLM token):
 *   lint     — 静态检查(npx tsc --noEmit 或自定义命令),退出码 0 = 通过
 *   git      — 本地版本操作(status / commit / log / branch,**不 push**)
 *   deps     — 依赖清单 + 缺失检测 + 版本(自动识别 npm / pip)
 *   context  — 项目记忆:把风格/规范/接口清单落盘,产出文本供下游 {{prev}} 引用
 *   contract — 接口契约:从上游文本提取路由,生成 OpenAPI 骨架落盘
 *   cost     — 运行摘要与成本估算(数据由调度器经 runSummary 注入)
 *   diff     — 项目现状快照(文件树 + 规模统计),给增量修改当上下文
 *   deploy   — Web 静态部署包:复制产物 + 生成 vercel.json / netlify.toml
 *
 * 全部操作只落在项目目录内(权限最小化),外部副作用一律不做。
 */

import { spawn } from 'node:child_process'
import { existsSync, type Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { BuiltinActionRequest, BuiltinActionResult } from '../workflow/builtinAction'

/** Windows 上 cwd 不存在会导致 spawn 报 ENOENT(chdir 失败),统一校验回退 */
function safeCwd(dir: string | undefined): string | undefined {
  return dir && existsSync(dir) ? dir : undefined
}

function runCommand(command: string, cwd: string | undefined, timeoutSec: number): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh'
    const child = spawn(command, { cwd: safeCwd(cwd), shell, windowsHide: true })
    const timer = setTimeout(() => {
      child.kill()
      resolve({ code: null, out: '', err: `命令超过 ${timeoutSec}s 未结束,已中止` })
    }, Math.max(1, Math.min(3600, timeoutSec)) * 1000)
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (err += String(d)))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: null, out, err: `命令无法启动:${e.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
  })
}

async function readProjectFile(projectDir: string, name: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(projectDir, name), 'utf8')
  } catch {
    return null
  }
}

export class ToolkitRunner {
  async run(r: BuiltinActionRequest): Promise<BuiltinActionResult> {
    switch (r.action) {
      case 'lint':
        return this.lint(r)
      case 'git':
        return this.git(r)
      case 'deps':
        return this.deps(r)
      case 'context':
        return this.context(r)
      case 'contract':
        return this.contract(r)
      case 'cost':
        return this.cost(r)
      case 'diff':
        return this.diff(r)
      case 'deploy':
        return this.deploy(r)
      default:
        return { ok: false, log: '', error: `未知工程化动作:${r.action}` }
    }
  }

  // ---- lint:静态检查(确定性) ----
  private async lint(r: BuiltinActionRequest): Promise<BuiltinActionResult> {
    const cmd = (r.lintParams?.command ?? '').trim() || 'npx tsc --noEmit'
    const { code, out, err } = await runCommand(cmd, r.projectDir, r.lintParams?.timeoutSec ?? 300)
    const tail = (err || out).slice(-800)
    if (code === 0) {
      return { ok: true, log: `[lint] 通过(exit 0):${cmd}`, handoffText: `[lint] 通过:${cmd}` }
    }
    return {
      ok: false,
      log: out + err,
      error: `lint 未通过:${cmd}\n${tail || '(无输出)'}`,
    }
  }

  // ---- git:本地版本操作(不 push) ----
  private async git(r: BuiltinActionRequest): Promise<BuiltinActionResult> {
    const op = r.gitParams?.op ?? 'status'
    const cwd = r.projectDir
    if (op === 'commit') {
      const msg = (r.gitParams?.message ?? '').trim() || 'auto: chusiz workflow'
      // 自动带本地身份:不改全局 git 配置;无身份时 git 默认拒绝提交
      const { code, out, err } = await runCommand(
        `git -c user.name=chusiz -c user.email=chusiz@local add -A && git -c user.name=chusiz -c user.email=chusiz@local commit -m "${msg.replace(/"/g, "'")}"`,
        cwd,
        120,
      )
      if (code !== 0) {
        return { ok: false, log: out + err, error: `git commit 失败:${(err || out).slice(-400)}` }
      }
      return { ok: true, log: out + err, handoffText: `[git] 已提交:${msg}\n${(out + err).slice(-600)}` }
    }
    if (op === 'log') {
      const { code, out, err } = await runCommand('git log --oneline -5', cwd, 60)
      if (code !== 0) return { ok: false, log: out + err, error: `git log 失败:${(err || out).slice(-400)}(项目可能还没初始化 git)` }
      return { ok: true, log: out, handoffText: `[git] 最近提交:\n${out.trim()}` }
    }
    if (op === 'branch') {
      const { code, out, err } = await runCommand('git branch --show-current', cwd, 60)
      if (code !== 0) return { ok: false, log: out + err, error: `git branch 失败:${(err || out).slice(-400)}` }
      return { ok: true, log: out, handoffText: `[git] 当前分支:${out.trim() || '(detached)'}` }
    }
    // status
    const { code, out, err } = await runCommand('git status --short', cwd, 60)
    if (code !== 0) return { ok: false, log: out + err, error: `git status 失败:${(err || out).slice(-400)}(项目可能还没初始化 git)` }
    const lines = out.split(/\r?\n/).filter(Boolean)
    return { ok: true, log: out, handoffText: `[git] 工作区 ${lines.length ? `${lines.length} 处变更:\n${lines.slice(0, 20).join('\n')}` : '干净(无变更)'}` }
  }

  // ---- deps:依赖清单 + 缺失检测 ----
  private async deps(r: BuiltinActionRequest): Promise<BuiltinActionResult> {
    const pkg = await readProjectFile(r.projectDir, 'package.json')
    const reqs = await readProjectFile(r.projectDir, 'requirements.txt')
    if (!pkg && !reqs) {
      return { ok: true, log: '', handoffText: '[deps] 未发现 package.json / requirements.txt(纯静态项目或还没生成依赖清单)' }
    }
    const lines: string[] = []
    if (pkg) {
      try {
        const j = JSON.parse(pkg)
        const all = { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) }
        const names = Object.keys(all)
        lines.push(`npm 项目 · ${names.length} 个依赖`)
        if (names.length > 0) {
          const missing: string[] = []
          const modulesDir = path.join(r.projectDir, 'node_modules')
          for (const n of names) {
            if (!existsSync(path.join(modulesDir, n))) missing.push(n)
          }
          lines.push(`node_modules ${existsSync(modulesDir) ? '存在' : '缺失(还没 npm install)'}${missing.length ? ` · 缺 ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ' 等' : ''}` : ''}`)
        }
        lines.push(`node ${j.engines?.node ?? '未声明'} · scripts:${Object.keys(j.scripts ?? {}).join(', ') || '无'}`)
      } catch {
        lines.push('package.json 解析失败(JSON 语法错误)')
      }
    }
    if (reqs) {
      const deps = reqs.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      lines.push(`pip 项目 · ${deps.length} 个依赖`)
      const pyDirs = ['site-packages', 'Lib/site-packages']
      const venvOk = pyDirs.some((d) => existsSync(path.join(r.projectDir, d)))
      lines.push(`Python 环境 ${venvOk ? '已就绪' : '未检测到本地安装(建议虚拟环境)'} · requirements.txt ${deps.length ? '' : '(空)'}`)
    }
    const text = lines.join('\n')
    return { ok: true, log: text, handoffText: `[deps] ${text}` }
  }

  // ---- context:项目记忆 ----
  private async context(r: BuiltinActionRequest): Promise<BuiltinActionResult> {
    const text = (r.contextParams?.text ?? '').trim()
    if (!text) return { ok: false, log: '', error: 'context 节点还没填写记忆内容(在节点面板里填)' }
    const dir = path.join(r.projectDir, 'assets', 'generated')
    await fs.mkdir(dir, { recursive: true }).catch(() => {})
    await fs.writeFile(path.join(dir, 'context.md'), `# 项目记忆\n\n${text}\n`, 'utf8').catch(() => {})
    return {
      ok: true,
      log: `[context] 已写入 assets/generated/context.md`,
      handoffText: `[项目记忆]\n${text}`,
    }
  }

  // ---- contract:接口契约(从上游文本提取路由 → OpenAPI 骨架) ----
  private async contract(r: BuiltinActionRequest): Promise<BuiltinActionResult> {
    const src = `${r.prompt ?? ''}\n${r.contractParams?.text ?? ''}`
    if (!src.trim()) return { ok: false, log: '', error: 'contract 节点没有可解析的内容:上游产出为空且未手填说明' }
    const routes: string[] = []
    const re = /(?:app\.(get|post|put|delete|patch)\(\s*['"`])(\/[^'"`]+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      routes.push(`${m[1]!.toUpperCase()} ${m[2]}`)
    }
    const fetchRe = /(?:fetch|axios\.\w+)\(\s*['"`]([^'"`]+)['"`]/g
    while ((m = fetchRe.exec(src))) {
      routes.push(`GET ${m[1]}`)
    }
    const unique = [...new Set(routes)]
    const yaml = [
      'openapi: 3.0.3',
      'info:',
      '  title: API 契约(由 chusiz 自动提取)',
      '  version: 0.1.0',
      'paths:',
      ...(unique.length
        ? unique.map((rt) => `  ${rt.split(' ')[1]}:\n    ${rt.split(' ')[0].toLowerCase()}:\n      summary: ${rt}`)
        : ['  # 未在产出中检测到路由,请在节点面板补充说明']),
      '',
    ].join('\n')
    const dir = path.join(r.projectDir, 'assets', 'generated')
    await fs.mkdir(dir, { recursive: true }).catch(() => {})
    await fs.writeFile(path.join(dir, 'openapi.yaml'), yaml, 'utf8').catch(() => {})
    return {
      ok: true,
      log: `[contract] 提取 ${unique.length} 条路由 → assets/generated/openapi.yaml`,
      handoffText: `[接口契约] ${unique.length ? unique.join('\n') : '未检测到路由(见面板补充)'}`,
    }
  }

  // ---- cost:运行摘要(调度器注入 runSummary) ----
  private async cost(r: BuiltinActionRequest): Promise<BuiltinActionResult> {
    const summary = r.runSummary ?? ''
    if (!summary.trim()) return { ok: true, log: '', handoffText: '[cost] 暂无运行数据(本节点之前的节点都未执行)' }
    return { ok: true, log: summary, handoffText: `[运行摘要]\n${summary}` }
  }

  // ---- diff:项目现状快照 ----
  private async diff(r: BuiltinActionRequest): Promise<BuiltinActionResult> {
    const root = r.projectDir
    const lines: string[] = []
    let total = 0
    const extCount: Record<string, number> = {}
    const skip = new Set(['node_modules', '.git', 'dist', 'out', '.next', '__pycache__'])
    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > 4) return
      let items: Dirent[]
      try {
        items = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const it of items) {
        if (skip.has(it.name)) continue
        const full = path.join(dir, it.name)
        if (it.isDirectory()) {
          await walk(full, depth + 1)
        } else {
          total++
          const ext = path.extname(it.name).toLowerCase() || '(无扩展名)'
          extCount[ext] = (extCount[ext] ?? 0) + 1
          if (depth <= 2) lines.push(`  ${path.relative(root, full)}`)
        }
      }
    }
    await walk(root, 0)
    const topExt = Object.entries(extCount).sort((a, b) => b[1] - a[1]).slice(0, 8)
    const text = [
      `项目文件总数:${total}`,
      `类型分布:${topExt.map(([e, c]) => `${e}×${c}`).join(' ') || '无'}`,
      `顶层文件/目录:`,
      ...lines.slice(0, 40),
    ].join('\n')
    const dir2 = path.join(root, 'assets', 'generated')
    await fs.mkdir(dir2, { recursive: true }).catch(() => {})
    await fs.writeFile(path.join(dir2, 'project-snapshot.md'), `# 项目现状\n\n${text}\n`, 'utf8').catch(() => {})
    return { ok: true, log: text, handoffText: `[项目现状]\n${text}` }
  }

  // ---- deploy:Web 静态部署包 ----
  private async deploy(r: BuiltinActionRequest): Promise<BuiltinActionResult> {
    const platform = r.deployParams?.platform ?? 'vercel'
    // 找 dist 下的 web 产物(输出节点 buildTarget=web 的落盘)
    const candidates = [
      path.join(r.projectDir, 'dist', 'web'),
      path.join(r.projectDir, 'dist', 'web-app'),
      path.join(r.projectDir, 'out'),
    ]
    const dist = candidates.find((c) => existsSync(c))
    if (!dist) {
      return {
        ok: false,
        log: '',
        error: 'deploy 节点找不到 Web 产物:请先让「输出节点(buildTarget=web)」打包成功,再连部署节点',
      }
    }
    const deployDir = path.join(r.projectDir, 'deploy')
    await fs.rm(deployDir, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(deployDir, { recursive: true }).catch(() => {})
    await fs.cp(dist, deployDir, { recursive: true }).catch(() => {})
    let cfg = ''
    if (platform === 'netlify') {
      cfg = 'build:\n  command: ""\n  publish: "."\n'
      await fs.writeFile(path.join(deployDir, 'netlify.toml'), cfg, 'utf8')
    } else if (platform === 'static') {
      cfg = '# 静态站点:把本目录上传到任意静态托管即可\n'
      await fs.writeFile(path.join(deployDir, 'README-deploy.txt'), cfg, 'utf8')
    } else {
      cfg = '{ "framework": null, "outputDirectory": "." }\n'
      await fs.writeFile(path.join(deployDir, 'vercel.json'), cfg, 'utf8')
    }
    let size = 0
    try {
      const files = await fs.readdir(deployDir)
      for (const f of files) {
        const st = await fs.stat(path.join(deployDir, f))
        if (st.isFile()) size += st.size
      }
    } catch {
      /* 统计失败不阻塞 */
    }
    return {
      ok: true,
      log: `[deploy] 部署包就绪:deploy/ (${platform}, ${files2Size(size)})`,
      handoffText: `[部署] ${platform} 部署包已生成:deploy/ 目录(共 ${files2Size(size)})。上传到 ${platform === 'netlify' ? 'Netlify Drop' : 'Vercel CLI / 控制台'} 即可上线。`,
    }
  }

  cancel(_id: string): boolean {
    return false
  }

  killAll(): void {
    /* 无全局状态 */
  }
}

function files2Size(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}
