import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { BuiltinActionRequest, BuiltinActionResult } from '../workflow/builtinAction'
import { killProcessTree } from '../agents/kill'
import { slugify } from './slug'
import { scanNewImages } from './artifactScan'
import { runLocalCommand } from './providers/localCommand'
import { runHttp } from './providers/http'
import type { ImageCtl, ProviderCtx, ProviderResult } from './types'

/**
 * 图像执行器:内置动作节点 `image` 的主进程实现。
 *
 * ## 职责
 *   ① 前置校验(项目文件夹没设 / provider 未配置 / 同节点并发);
 *   ② 阶段二编排({{env:}} + provider 占位符在 provider 里;这里只负责目录、计时、扫描);
 *   ③ 产物判定("命令成功但没出图"必须判失败);
 *   ④ 自持 live / abort 账本,cancel / killAll 接入取消与退出链路。
 *
 * ## 阶段一 vs 阶段二
 *   阶段一({{prev}}/{{input}}/{{node:}})在**调度侧 runner** 做 —— 那里才拿得到上游产出。
 *   这里(req.prompt)拿到的是已展开的纯文本。
 *
 * ## 产物目录(PRD §3.1)
 *   `<项目文件夹>/assets/generated/<slug>/img-<ts>-<i>.<ext>`
 *   - slug 由节点标题确定性生成(同名节点落同一目录);
 *   - 项目文件夹为空 → **失败**(不兜底沙箱):下游 agent 的 cwd = 项目文件夹,
 *     图片若落沙箱,注入的相对路径就无意义了(D3)。
 */

/** 张数夹到 1..8(与 nodeRegistry.clampN 同一套根因修复:非有限值回落 1,不让 NaN 漏给 provider) */
function clampN(n: number): number {
  const v = Number(n)
  if (!Number.isFinite(v)) return 1
  return Math.max(1, Math.min(8, Math.trunc(v)))
}

export class ImageGen {
  /** nodeId → 正在跑的出图子进程(local-command) */
  private live = new Map<string, ChildProcess>()
  /** nodeId → 正在飞行的 HTTP 请求(可 abort) */
  private aborts = new Map<string, AbortController>()
  /** 被 cancel / killAll 标记过的节点。provider close 时据此把结局判成"已取消" */
  private killed = new Set<string>()

  /** provider 生命周期记账句柄(账本只此一份,见注释) */
  private readonly ctl: ImageCtl = {
    registerChild: (id, c) => this.live.set(id, c),
    unregisterChild: (id) => this.live.delete(id),
    registerAbort: (id, ac) => this.aborts.set(id, ac),
    unregisterAbort: (id) => this.aborts.delete(id),
    isKilled: (id) => this.killed.has(id),
    markKilled: (id) => this.killed.add(id),
  }

  /** 执行一次出图。成功回传**相对 projectDir** 的产物路径列表 + 日志 */
  async run(req: BuiltinActionRequest): Promise<BuiltinActionResult> {
    // ---- 前置校验(对应 §4 错误 1 / 2 / 11)----
    if (this.live.has(req.nodeId) || this.aborts.has(req.nodeId)) {
      return { ok: false, log: '', error: '这个图像节点已经有一个出图任务在跑了' }
    }
    if (!req.projectDir || !req.projectDir.trim()) {
      return {
        ok: false,
        log: '',
        error: '图像节点要有个地方存图:项目文件夹还没设 —— 先放一个项目节点并选好文件夹,或给画布设置项目文件夹',
      }
    }
    const p = req.imageProvider
    if (!p) {
      return { ok: false, log: '', error: '这个图像节点还没配置出图方式 —— 在右栏选择出图方式(本地命令 / HTTP)并填写配置' }
    }
    if (p.kind === 'local-command' && !(p.command ?? '').trim()) {
      return { ok: false, log: '', error: '这个图像节点还没配置出图方式 —— 本地命令还是空的,在右栏填写出图命令' }
    }
    if (p.kind === 'http' && !(p.endpoint ?? '').trim()) {
      return { ok: false, log: '', error: '这个图像节点还没配置出图方式 —— HTTP endpoint 还是空的,在右栏填写' }
    }

    const projectDir = req.projectDir.trim()
    const slug = slugify(req.nodeTitle ?? '', req.nodeId)
    const outDir = path.join(projectDir, 'assets', 'generated', slug)
    /*
     * ⚠️ 先建目录再扫描:否则"历史空目录"会因 ENOENT 被当成"没出图",
     * 而其实只是目录还没建出来(PRD §5.6 边界)。
     */
    await fsp.mkdir(outDir, { recursive: true })
    const startTs = Date.now() // 产物判定基准(错误 5 / 12)
    const n = clampN(req.imageParams?.n ?? 1)
    const size = req.imageParams?.size ?? '1024x1024'
    const seed = req.imageParams?.seed

    const ctx: ProviderCtx = {
      nodeId: req.nodeId,
      projectDir,
      outDir,
      prompt: req.prompt ?? '',
      negativePrompt: req.imageParams?.negativePrompt,
      n,
      size,
      seed,
      startTs,
      onProgress: req.onProgress,
    }

    let result: ProviderResult
    try {
      result =
        p.kind === 'http' ? await runHttp(p, ctx, this.ctl) : await runLocalCommand(p, ctx, this.ctl)
    } finally {
      // 无论成败,跑完就出账 —— cancel 后 killAll 不该再对已退出的 pid / 已结束的请求做文章
      this.live.delete(req.nodeId)
      this.aborts.delete(req.nodeId)
      this.killed.delete(req.nodeId)
    }

    if (result.status === 'cancelled') return { ok: false, log: result.log, error: '出图已取消' }
    if (result.status === 'timeout') {
      const sec = (p.kind === 'http' ? p.timeoutSec ?? 120 : p.timeoutSec ?? 600)
      return { ok: false, log: result.log, error: `出图超过 ${sec} 秒仍未完成,已终止` }
    }
    if (result.status === 'fail') return { ok: false, log: result.log, error: result.error ?? '出图失败' }

    // ---- 成功退出 → 扫描"本次新产出"(错误 5 / 12)----
    const found = await scanNewImages(outDir, startTs)
    const rels = found.map((f) => path.relative(projectDir, f.abs).split(path.sep).join('/'))
    if (rels.length === 0) {
      // 情况 5:退出码 0,但 outDir 里没有任何**本次新产出**的图片
      return {
        ok: false,
        log: result.log,
        error: `命令执行完了,但没有在 ${outDir} 找到新图片 —— 可能没把结果写到 {{outDir}}`,
      }
    }

    // 情况 12:实产 < n → 成功 + warn(不失败)
    if (rels.length < n) req.onProgress?.(`只生成了 ${rels.length}/${n} 张`)

    return { ok: true, log: result.log, artifacts: rels }
  }

  /**
   * 取消某节点的出图(供环境层的 cancelBuiltin 调用)。返回是否真有在跑的。
   * 有子进程杀子进程树;有 HTTP 请求则 abort。幂等无副作用。
   */
  cancel(nodeId: string): boolean {
    const child = this.live.get(nodeId)
    if (child) {
      this.killed.add(nodeId)
      if (child.pid) void killProcessTree(child.pid)
      return true
    }
    const ac = this.aborts.get(nodeId)
    if (ac) {
      this.killed.add(nodeId)
      ac.abort()
      return true
    }
    return false
  }

  /** 退出清场:杀掉全部出图子进程 / 中断全部请求。由 killAllBuiltin 调用 */
  killAll(): void {
    for (const [id, child] of this.live) {
      this.killed.add(id)
      if (child.pid) void killProcessTree(child.pid)
    }
    for (const [id, ac] of this.aborts) {
      this.killed.add(id)
      ac.abort()
    }
    this.live.clear()
    this.aborts.clear()
  }
}
