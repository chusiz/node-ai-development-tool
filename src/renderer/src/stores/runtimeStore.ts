import { create } from 'zustand'
import type {
  NodeLogPayload,
  NodeProgressPayload,
  PersistedRecord,
  SessionExitPayload,
  SessionStatus,
} from '../types'
import { useSettingsStore } from './settingsStore'
import { clampEvent, emptyRuntime, isDiagnostic, itemOf, type Item, type NodeRuntime } from './types'

interface RuntimeState {
  runtimes: Record<string, NodeRuntime>

  /** 从磁盘读回一批节点的历史(启动 / 切画布时)。幂等:已有内容的节点不会被覆盖 */
  hydrate(canvasId: string, nodeIds: string[]): Promise<void>
  applyLog(p: NodeLogPayload): void
  applyExit(p: SessionExitPayload): void
  setSessionId(nodeId: string, sessionId: string): void
  pushStderr(nodeId: string, line: string): void
  setStatus(nodeId: string, status: SessionStatus): void
  fail(nodeId: string, message: string): void
  /** 走 emptyRuntime 整体替换,不逐字段手写 */
  reset(nodeId: string): void
  drop(nodeId: string): void
}

/*
 * limits 从 settingsStore 取。settings 在 main.tsx 里 await 过才渲染,
 * 所以这里正常拿得到;拿不到时用一份最小兜底,避免 CI/异常路径下崩掉。
 */
const FALLBACK_LIMITS = {
  maxItemsPerNode: 400,
  maxToolResultChars: 8192,
  maxThinkingChars: 8192,
  maxResultChars: 16384,
  stderrTailLines: 20,
  diagRingSize: 200,
}

function limits(): typeof FALLBACK_LIMITS {
  return useSettingsStore.getState().payload?.current.limits ?? FALLBACK_LIMITS
}

/** 把一批记录并进一个节点的运行时状态。纯函数,便于推理 */
function ingest(cur: NodeRuntime, recs: PersistedRecord[]): NodeRuntime {
  const lim = limits()
  const items: Item[] = [...cur.items]
  const diagnostics: Item[] = [...cur.diagnostics]
  let maxSeq = cur.maxSeq
  let model = cur.model
  let lastCostUsd = cur.lastCostUsd
  let lastDurationMs = cur.lastDurationMs

  for (const raw of recs) {
    // seq 是主进程给的单调序号。去重按 seq 做(见下面的 dedup),
    // 这里只维护水位
    maxSeq = Math.max(maxSeq, raw.seq)

    const rec = raw.t === 'event' ? { ...raw, ev: clampEvent(raw.ev, lim) } : raw

    if (rec.t === 'event') {
      if (rec.ev.k === 'init' && rec.ev.model) model = rec.ev.model
      if (rec.ev.k === 'result') {
        lastCostUsd = rec.ev.costUsd
        lastDurationMs = rec.ev.durationMs
      }
    }

    const item = itemOf(rec)
    if (isDiagnostic(rec)) diagnostics.push(item)
    else items.push(item)
  }

  // 去重 + 按 seq 排序:IPC 不该乱序,但真乱序了 UI 也不该跟着乱
  const dedup = (arr: Item[]): Item[] => {
    const seen = new Set<number>()
    const out: Item[] = []
    for (const it of arr) {
      if (seen.has(it.seq)) continue
      seen.add(it.seq)
      out.push(it)
    }
    out.sort((a, b) => a.seq - b.seq)
    return out
  }

  let finalItems = dedup(items)
  let trimmed = cur.trimmed
  if (finalItems.length > lim.maxItemsPerNode) {
    trimmed += finalItems.length - lim.maxItemsPerNode
    finalItems = finalItems.slice(-lim.maxItemsPerNode)
  }

  let finalDiag = dedup(diagnostics)
  if (finalDiag.length > lim.diagRingSize) finalDiag = finalDiag.slice(-lim.diagRingSize)

  return {
    ...cur,
    items: finalItems,
    diagnostics: finalDiag,
    trimmed,
    maxSeq,
    model,
    lastCostUsd,
    lastDurationMs,
  }
}

export const useRuntimeStore = create<RuntimeState>((set) => {
  /** 分发到 store 时**只替换该节点的切片**,未涉及节点的引用保持稳定 —— 这是整个 per-node 架构的性能基石 */
  const patch = (nodeId: string, fn: (cur: NodeRuntime) => NodeRuntime): void =>
    set((st) => {
      const cur = st.runtimes[nodeId] ?? emptyRuntime(nodeId)
      return { runtimes: { ...st.runtimes, [nodeId]: fn(cur) } }
    })

  return {
    runtimes: {},

    async hydrate(canvasId, nodeIds) {
      /*
       * 一次最多加载多少条。跟 settings 的 maxItemsPerNode 同量级 ——
       * 加载得比能显示的还多没有意义,只会白占内存。
       */
      const limit = limits().maxItemsPerNode

      await Promise.all(
        nodeIds.map(async (nodeId) => {
          // 已经有内容的节点(比如刚跑过一轮)不覆盖 —— 磁盘那会儿还是旧的
          const cur = useRuntimeStore.getState().runtimes[nodeId]
          if (cur && (cur.items.length > 0 || cur.status === 'running')) return

          const res = await window.api.session.logTail(canvasId, nodeId, limit)
          if (!res.ok || res.data.recs.length === 0) return

          const { recs, total, meta } = res.data
          const base = emptyRuntime(nodeId)
          const next: NodeRuntime = {
            ...ingest(base, recs),
            sessionId: meta?.sessionId ?? null,
            turns: meta?.turns ?? 0,
            model: meta?.model ?? null,
            lastCostUsd: meta?.lastCostUsd ?? null,
            lastDurationMs: meta?.lastDurationMs ?? null,
            status: (meta?.status as NodeRuntime['status']) ?? 'idle',
            /*
             * 读回的条数少于磁盘总数 → 前面确实还有,界面上如实说"已折叠"。
             * ⚠️ 这是**下界**:主进程只读最后两个分段(崩溃安全),更早的分段根本没数,
             * 所以真实折叠数可能更多。宁可少说,不可多说。
             */
            trimmed: Math.max(0, total - recs.length),
            error:
              meta?.status === 'interrupted'
                ? '上次运行被中断(应用已退出),这一轮没有跑完。可以直接继续对话。'
                : null,
          }

          set((st) => {
            // 并发补历史时可能已经有人写过这个切片了;再检查一次,谁的都不覆盖谁
            const now = st.runtimes[nodeId]
            if (now && now.items.length > 0) return st
            return { runtimes: { ...st.runtimes, [nodeId]: next } }
          })
        }),
      )
    },

    applyLog(p) {
      patch(p.nodeId, (cur) => ingest(cur, p.recs))
    },

    applyExit(p) {
      patch(p.nodeId, (cur) => ({
        ...cur,
        status: p.status,
        turns: cur.turns + 1,
        // 正常结束时清掉错误;否则保留
        error: p.status === 'done' ? null : cur.error,
      }))
    },

    setSessionId(nodeId, sessionId) {
      patch(nodeId, (cur) => ({ ...cur, sessionId }))
    },

    pushStderr(nodeId, line) {
      const keep = limits().stderrTailLines
      patch(nodeId, (cur) => ({
        ...cur,
        stderrTail: [...cur.stderrTail, line].slice(-Math.max(1, keep)),
      }))
    },

    /*
     * 状态一变,上一轮的红字就必须跟着走。
     *
     * 这里原来只改 status,error 留在原地 —— 于是出现一个非常难解释的现象:
     * 第一次发消息时还没选项目文件夹 → 红字「还没有项目文件夹…」;
     * 用户照着做了、选了文件夹、再发一次也真的跑成功了 ——
     * 那条红字**还在**消息流里挂着(它是个持久气泡,不是那一轮的临时提示)。
     * 用户看到的就是「选了项目文件夹,还在报错」,而其实早就没事了。
     *
     * 一个已经过期的错误提示比没有提示更糟:它让人继续去修一个
     * 已经修好的问题,而且怎么修都消不掉。
     */
    setStatus(nodeId, status) {
      patch(nodeId, (cur) => ({ ...cur, status, error: status === 'error' ? cur.error : null }))
    },

    fail(nodeId, message) {
      patch(nodeId, (cur) => ({ ...cur, status: 'error', error: message }))
    },

    reset(nodeId) {
      set((st) => ({ runtimes: { ...st.runtimes, [nodeId]: emptyRuntime(nodeId) } }))
    },

    drop(nodeId) {
      set((st) => {
        const next = { ...st.runtimes }
        delete next[nodeId]
        return { runtimes: next }
      })
    },
  }
})

/**
 * 高频进度心跳单独放一个 store。
 *
 * 与 runtimeStore 分开的理由:thinking_tokens 这类事件每轮可以爆几十条,
 * 混进 runtimes 会让整棵订阅 runtimeStore 的树跟着重渲染。
 */
interface LiveState {
  progress: Record<string, { label: string; value?: number } | null>
  setProgress(p: NodeProgressPayload): void
  clear(nodeId: string): void
}

export const useLiveStore = create<LiveState>((set) => ({
  progress: {},

  setProgress(p) {
    const label =
      p.ev.label === 'thinking_tokens' && p.ev.value != null
        ? `思考中… ${p.ev.value} tokens`
        : p.ev.label
    set((st) => ({ progress: { ...st.progress, [p.nodeId]: { label, value: p.ev.value } } }))
  },

  clear(nodeId) {
    set((st) => ({ progress: { ...st.progress, [nodeId]: null } }))
  },
}))
