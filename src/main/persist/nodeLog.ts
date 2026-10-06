import fsp from 'node:fs/promises'
import path from 'node:path'
import type { NodeEvent } from '../../shared/events'
import type { LogRecord, PersistedRecord } from '../../shared/log'
import { canvasBlobsDir, nodeDir } from '../paths'
import { writeBlob } from './blob'
import {
  appendLines,
  flushAppends,
  listLogSegments,
  readJsonlTail,
  writeJsonAtomic,
  ensureDir,
} from './atomic'

export interface NodeLogLimits {
  /** 单个日志分段的字节上限,超过就滚到下一段 */
  segmentBytes: number
  /** 单条内容超过这个字节数就外溢成 blob */
  blobThreshold: number
  /** 外溢后内联保留的预览长度 */
  previewChars: number
}

export const DEFAULT_LOG_LIMITS: NodeLogLimits = {
  segmentBytes: 8 * 1024 * 1024,
  blobThreshold: 64 * 1024,
  previewChars: 2048,
}

export interface AppendResult {
  /** 本批的起始 seq */
  seq: number
  /**
   * 外溢处理之后的记录 —— **调用方必须广播这一份,而不是原始事件**。
   * 广播原始事件的话,一个 10MB 的 tool_result 会原样冲进 IPC 与渲染进程内存。
   */
  recs: PersistedRecord[]
}

interface NodeState {
  seq: number
  seg: number
  segBytes: number
}

/**
 * 一路会话的日志写盘。
 *
 * ## 为什么自己写日志而不是读 claude 的原生 transcript
 *
 * 原生 transcript 的格式随版本漂移(`cost-state` / `last-prompt` /
 * `permission-mode` 等内部状态都出现过),拿它当 UI 的数据源等于把渲染层
 * 绑在一个不稳定的契约上。自己归一化成稳定 schema 才抗版本变化。
 * 原生 transcript 只用于 `--resume` 和导入历史。
 *
 * ## 为什么分段而不是单文件
 *
 * 读尾部只需读最后 1~2 段,不需要维护字节偏移索引 ——
 * 索引文件本身就是崩溃时最容易不一致的东西。
 */
export class NodeLogWriter {
  private states = new Map<string, NodeState>()

  constructor(
    private readonly canvasId: string,
    private readonly limits: NodeLogLimits = DEFAULT_LOG_LIMITS,
  ) {}

  private segFile(nodeId: string, idx: number): string {
    return path.join(nodeDir(this.canvasId, nodeId), `log.${String(idx).padStart(3, '0')}.jsonl`)
  }

  /**
   * 首次触碰某个节点时,从磁盘恢复 seq 与分段位置。
   * 不恢复的话重启后 seq 会从 0 重新开始,与已有日志冲突。
   */
  private async ensureLoaded(nodeId: string): Promise<NodeState> {
    const cached = this.states.get(nodeId)
    if (cached) return cached

    const segs = listLogSegments(nodeDir(this.canvasId, nodeId))
    const state: NodeState = { seq: 0, seg: 0, segBytes: 0 }

    if (segs.length > 0) {
      const last = segs[segs.length - 1]
      const m = /log\.(\d{3})\.jsonl$/.exec(last)
      state.seg = m ? Number(m[1]) : 0
      try {
        state.segBytes = (await fsp.stat(last)).size
      } catch {
        state.segBytes = 0
      }
      const { recs } = await readJsonlTail<LogRecord>(last, 0)
      if (recs.length > 0) state.seq = recs[recs.length - 1].seq
    }

    this.states.set(nodeId, state)
    return state
  }

  private nextSeq(nodeId: string): number {
    const st = this.states.get(nodeId)!
    return ++st.seq
  }

  /**
   * 写整批记录。
   *
   * seq 在**同步段**内分配完毕,所以并发调用也不会出现重复或空洞。
   */
  private async write(nodeId: string, recs: PersistedRecord[]): Promise<void> {
    if (recs.length === 0) return

    const st = await this.ensureLoaded(nodeId)
    const lines = recs.map((r) => JSON.stringify(r))
    // +1 是每行末尾的 \n
    const bytes = lines.reduce((n, l) => n + Buffer.byteLength(l, 'utf8') + 1, 0)

    if (st.segBytes > 0 && st.segBytes + bytes > this.limits.segmentBytes) {
      st.seg += 1
      st.segBytes = 0
    }

    await appendLines(this.segFile(nodeId, st.seg), lines)
    st.segBytes += bytes
  }

  private async toBlob(text: string): Promise<{ hash: string; preview: string; bytes: number }> {
    const { hash, bytes } = await writeBlob(this.canvasId, text)
    return { hash, preview: text.slice(0, this.limits.previewChars), bytes }
  }

  /** 内容过大就外溢。返回处理后的记录(可能需要换成截断版) */
  private async spill(rec: LogRecord): Promise<PersistedRecord> {
    if (rec.t !== 'event') return rec
    const ev = rec.ev
    const limit = this.limits.blobThreshold

    const big =
      (ev.k === 'tool_result' && ev.content.length > limit) ||
      (ev.k === 'result' && (ev.text?.length ?? 0) > limit) ||
      (ev.k === 'text' && ev.text.length > limit) ||
      (ev.k === 'thinking' && ev.text.length > limit)

    if (!big) return rec

    const raw =
      ev.k === 'tool_result' ? ev.content : ev.k === 'result' ? (ev.text ?? '') : (ev as { text: string }).text
    const { hash, preview, bytes } = await this.toBlob(raw)

    const trimmed: NodeEvent =
      ev.k === 'tool_result'
        ? { ...ev, content: preview }
        : ev.k === 'result'
          ? { ...ev, text: preview }
          : ({ ...ev, text: preview } as NodeEvent)

    return { seq: rec.seq, ts: rec.ts, t: 'event', ev: trimmed, _blob: hash, _bytes: bytes, _truncated: true }
  }

  /** 用户发的话。由主进程写入,渲染进程只做镜像,不做乐观插入 */
  async appendUser(nodeId: string, text: string, ts = Date.now()): Promise<number> {
    await this.ensureLoaded(nodeId)
    const seq = this.nextSeq(nodeId)
    await this.write(nodeId, [{ seq, ts, t: 'user', text }])
    return seq
  }

  /** 一批 agent 事件。返回外溢处理后的记录,调用方应当广播**这一份** */
  async appendEvents(nodeId: string, events: NodeEvent[]): Promise<AppendResult> {
    await this.ensureLoaded(nodeId)

    const recs: PersistedRecord[] = []
    for (const ev of events) {
      const seq = this.nextSeq(nodeId)
      recs.push(await this.spill({ seq, ts: ev.ts, t: 'event', ev }))
    }

    await this.write(nodeId, recs)
    return { seq: recs[0]?.seq ?? 0, recs }
  }

  /** 诊断信息:未识别的原始事件等。不进主消息流 */
  async appendDiag(nodeId: string, payload: unknown, ts = Date.now()): Promise<number> {
    await this.ensureLoaded(nodeId)
    const seq = this.nextSeq(nodeId)
    await this.write(nodeId, [{ seq, ts, t: 'diag', payload }])
    return seq
  }

  /** 应用自己发的提示(降级、截断、重试),用户可见 */
  async appendNotice(
    nodeId: string,
    level: 'info' | 'warn' | 'error',
    text: string,
    ts = Date.now(),
  ): Promise<number> {
    await this.ensureLoaded(nodeId)
    const seq = this.nextSeq(nodeId)
    await this.write(nodeId, [{ seq, ts, t: 'notice', level, text }])
    return seq
  }

  /** 日志尾部,跨最后两个分段 —— 单段可能只有一条记录 */
  async readTail(
    nodeId: string,
    limit: number,
  ): Promise<{ recs: LogRecord[]; torn: boolean; total: number }> {
    const segs = listLogSegments(nodeDir(this.canvasId, nodeId))
    if (segs.length === 0) return { recs: [], torn: false, total: 0 }

    const picked = segs.slice(-2)
    const collected: LogRecord[] = []
    let torn = false
    let total = 0

    for (const seg of picked) {
      const r = await readJsonlTail<LogRecord>(seg, 0)
      collected.push(...r.recs)
      total += r.total
      torn = torn || r.torn
    }

    collected.sort((a, b) => a.seq - b.seq)
    return { recs: limit > 0 ? collected.slice(-limit) : collected, torn, total }
  }

  /**
   * 取水位**之后**的记录 —— 也就是"这一轮新产生的"。
   *
   * 工作流要拿它提取本轮产出。用 `readTail` 再自己按 seq 过滤是不行的:
   * 一个长会话的尾部 200 条可能全落在水位之前,过滤完是空的,
   * 于是下游拿到空输入,而且看不出哪里错了。
   *
   * 从最新段往回读,凑够 limit 条就停。上限 8 段是防呆 ——
   * 正常一轮不会跨这么多段(每段 8MB),真跨了说明产出极大,
   * 那时候 extractOutput 也会截断,再往前读没有意义。
   */
  async readAfter(nodeId: string, watermark: number, limit: number): Promise<LogRecord[]> {
    const segs = listLogSegments(nodeDir(this.canvasId, nodeId))
    const out: LogRecord[] = []

    for (let i = segs.length - 1; i >= 0 && i >= segs.length - 8; i--) {
      const r = await readJsonlTail<LogRecord>(segs[i], 0)
      // 段内本身是升序的,但 push 到 out 的顺序是"从新到旧",最后整体排序
      for (const rec of r.recs) if (rec.seq > watermark) out.push(rec)
      if (out.length >= limit) break
    }

    out.sort((a, b) => a.seq - b.seq)
    return limit > 0 ? out.slice(-limit) : out
  }

  /** 按需读取外溢的完整内容(UI 的"展开"按钮走这里) */
  async readBlob(hash: string): Promise<string | null> {
    if (!/^[0-9a-f]{40}$/.test(hash)) return null
    try {
      return await fsp.readFile(path.join(canvasBlobsDir(this.canvasId), `${hash}.txt`), 'utf8')
    } catch {
      return null
    }
  }

  /**
   * 清空一个节点的日志(新会话)。
   * seq 从 0 重来 —— 旧文件已被删除,不存在冲突。
   */
  async resetNode(nodeId: string): Promise<void> {
    const dir = nodeDir(this.canvasId, nodeId)
    for (const seg of listLogSegments(dir)) {
      await fsp.rm(seg, { force: true })
    }
    await fsp.rm(path.join(dir, 'meta.json'), { force: true })
    this.states.set(nodeId, { seq: 0, seg: 0, segBytes: 0 })
  }

  /** 轮次边界 / 退出前:确保排队中的写入已经落盘 */
  async flush(): Promise<void> {
    await flushAppends()
  }
}

/** 节点会话元数据。与日志分开存,读取廉价,列表秒开 */
export interface NodeMeta {
  version: 1
  nodeId: string
  agentId: string
  cwd: string
  sessionId: string | null
  isFirstTurn: boolean
  turns: number
  status: string
  model: string | null
  lastCostUsd: number | null
  lastDurationMs: number | null
  lastSeq: number
  pid?: number
  startedAt: number
  endedAt?: number
}

export async function writeNodeMeta(canvasId: string, meta: NodeMeta): Promise<void> {
  await writeJsonAtomic(path.join(nodeDir(canvasId, meta.nodeId), 'meta.json'), meta)
}

/**
 * 读回 meta。读不出来就返回 null。
 *
 * 刻意**不用 zod 校验**:meta 是我们自己写的,而且它只是索引 ——
 * 字段缺了/类型漂了就逐个降级,没必要因为一个多余字段让整份元数据消失。
 */
export async function readNodeMeta(canvasId: string, nodeId: string): Promise<NodeMeta | null> {
  try {
    const raw = await fsp.readFile(path.join(nodeDir(canvasId, nodeId), 'meta.json'), 'utf8')
    const o = JSON.parse(raw) as Partial<NodeMeta>
    if (typeof o !== 'object' || o === null) return null
    return {
      version: 1,
      nodeId,
      agentId: typeof o.agentId === 'string' ? o.agentId : 'claude',
      cwd: typeof o.cwd === 'string' ? o.cwd : '',
      sessionId: typeof o.sessionId === 'string' ? o.sessionId : null,
      isFirstTurn: o.isFirstTurn === true,
      turns: typeof o.turns === 'number' ? o.turns : 0,
      status: typeof o.status === 'string' ? o.status : 'idle',
      model: typeof o.model === 'string' ? o.model : null,
      lastCostUsd: typeof o.lastCostUsd === 'number' ? o.lastCostUsd : null,
      lastDurationMs: typeof o.lastDurationMs === 'number' ? o.lastDurationMs : null,
      lastSeq: typeof o.lastSeq === 'number' ? o.lastSeq : 0,
      pid: typeof o.pid === 'number' ? o.pid : undefined,
      startedAt: typeof o.startedAt === 'number' ? o.startedAt : 0,
      endedAt: typeof o.endedAt === 'number' ? o.endedAt : undefined,
    }
  } catch {
    return null
  }
}
