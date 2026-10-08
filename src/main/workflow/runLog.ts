import fsp from 'node:fs/promises'
import type { RunState } from '../../shared/workflow'
import { RUNS_ROOT, runFile } from '../paths'
import { ensureDir, writeJsonAtomic } from '../persist/atomic'

/**
 * 运行态落盘。
 *
 * 为什么非落不可:**Runner 不持有图,渲染进程每次 run 都传一份快照**。
 * 好处是主进程无状态、运行语义被冻结;代价是刷新渲染进程之后
 * 那次运行的状态在内存里就没了 —— 不落盘的话 RunBar 会凭空消失,
 * 而 agent 还在后台跑着。这也正是"运行语义冻结"的代价账单。
 */

export function persistRun(state: RunState): void {
  // 运行态是纯通知性的:写不进去(磁盘满/被杀软占用)不该影响运行本身
  void (async () => {
    try {
      await ensureDir(RUNS_ROOT)
      await writeJsonAtomic(runFile(state.runId), state)
    } catch {
      /* 丢一次运行态可接受,丢一次会话日志不可接受 —— 两者刻意分开 */
    }
  })()
}

/** 读回某次运行。损坏就返回 null,不抛 —— 重启后 UI 不该因为一个坏文件起不来 */
export async function readRun(runId: string): Promise<RunState | null> {  try {
    const raw = await fsp.readFile(runFile(runId), 'utf8')
    const o = JSON.parse(raw) as Partial<RunState>
    if (!o || typeof o !== 'object' || typeof o.runId !== 'string') return null
    if (!o.nodes || typeof o.nodes !== 'object') return null
    return {
      runId: o.runId,
      canvasId: typeof o.canvasId === 'string' ? o.canvasId : '',
      // 磁盘上写着 running 而进程早没了 —— 上次是被强杀/崩掉的。
      // 报成 interrupted 而不是 done:那一轮确实没跑完。
      status: o.status === 'running' ? 'cancelled' : (o.status ?? 'done'),
      startedAt: typeof o.startedAt === 'number' ? o.startedAt : 0,
      endedAt: typeof o.endedAt === 'number' ? o.endedAt : undefined,
      nodes: o.nodes as RunState['nodes'],
    }
  } catch {
    return null
  }
}

/**
 * v0.6.4 增量执行:找某画布**最近一次成功落盘**的运行态(按 mtime)。
 * 供 runner 在每次 run 开头读取,作为"输入未变 → 复用上次产出"的对照基线。
 */
export async function findLatestRunState(canvasId: string): Promise<RunState | null> {
  try {
    const entries = await fsp.readdir(RUNS_ROOT)
    let best: { m: number; s: RunState } | null = null
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      const runId = name.slice(0, -5)
      try {
        const st = await readRun(runId)
        if (st && st.canvasId === canvasId && st.status === 'done') {
          const stt = await fsp.stat(runFile(runId))
          if (!best || stt.mtimeMs > best.m) best = { m: stt.mtimeMs, s: st }
        }
      } catch {
        /* 单个坏文件跳过,不影响其它 */
      }
    }
    return best?.s ?? null
  } catch {
    return null
  }
}
