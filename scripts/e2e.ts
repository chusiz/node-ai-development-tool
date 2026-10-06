/**
 * 阶段 1 验收测试(无头)。
 *
 * 直接驱动真实的 SessionManager / adapter / ndjson / normalize ——
 * 不是另写一份复制品,所以测过的就是应用里跑的。
 *
 * 验收标准(plan §8.2):
 *   1. 定位到 claude.exe 并读出 2.1.289
 *   2. 发"只回复两个字:成功",事件流正确归一化
 *   3. 发"我刚才让你回复什么" → 必须答出"成功"(证明 --resume 跨进程记忆成立)
 *   4. 两轮之间用不同的 nodeId 复现"退出重进"场景
 */
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { SessionManager } from '../src/main/agents/manager'
import { getAdapter, registerAdapter } from '../src/main/agents/registry'
import type { AgentAdapter } from '../src/main/agents/types'
import { NodeLogWriter } from '../src/main/persist/nodeLog'
import { NodeLogHub } from '../src/main/persist/hub'
import { applyBootSwitches, readSettingsSync } from '../src/main/settings/store'
import {
  canvasBlobsDir,
  canvasRoot,
  canvasWorkspace,
  ensureSkillsDirs,
  nodeDir,
  skillDir,
  SKILLS_PLUGIN_FILE,
} from '../src/main/paths'
import {
  deleteSkill,
  forgetOrigin,
  installSkillDir,
  listSkills,
  setSkillEnabled,
} from '../src/main/skills/store'
import { parseSkillMd, validateSkillName } from '../src/main/skills/parse'
import { DEFAULT_SETTINGS, parseSettings, restartRequiredKeys } from '../src/shared/settings'
import { buildIndex, CycleError, normalizeEdges } from '../src/main/workflow/graph'
import { detectCanvasCycle, subgraphInnerCycleHint } from '../src/shared/graph'
import { getBuiltinAction } from '../src/main/builtin/registry'
import { WorkflowRunner, formatTestOutput, parseRouterPick, type NodeRunSnapshot, type RunnerEnv } from '../src/main/workflow/runner'
import { makeRunnerEnv } from '../src/main/workflow/env'
import {
  DEFAULT_MERGE_TEMPLATE,
  defaultPromptFor,
  expandSubgraphs,
  extractOutput,
  formatBranchManifest,
  graphIssuesFor,
  MAX_SUBGRAPH_DEPTH,
  renderTemplate,
  specFromGraph,
  validateGraph,
  type GraphIssue,
  type MergeBranchInfo,
  type NodeSpecSource,
} from '../src/shared/workflow'
import {
  effectiveCwd,
  migrateGraph,
  resolveProjectDir,
  type CanvasGraph,
  type NodeConfig,
  type NodeKind,
  type SubgraphTemplate,
} from '../src/shared/canvas'
import { loadGraph, saveGraph } from '../src/main/canvas/store'
import { resolveStartCwd, startSession } from '../src/main/startSession'
import { agentListEntries } from '../src/main/agents/list'
import { Packager } from '../src/main/packager'
import { resolveBuilder } from '../src/main/packager/electronBuilder'
import { addEntryList, applyTypeDefaults, connectionError, getNodeType, NODE_TYPES, workspaceNodeList, canvasIdFor, WORKFLOW_TEMPLATES } from '../src/shared/nodeRegistry'
import { ImageGen } from '../src/main/imagegen'
import { Handoff } from '../src/main/handoff'
import { pickByPath, runHttp } from '../src/main/imagegen/providers/http'
import { runLocalCommand } from '../src/main/imagegen/providers/localCommand'
import type { ImageCtl, ProviderCtx } from '../src/main/imagegen/types'
import { slugify } from '../src/main/imagegen/slug'
import {
  readThumb,
  resolveSafeImagePath,
  type ImageDecoder,
  type ThumbSource,
} from '../src/main/images/readThumb'
import { formatImageOutput } from '../src/main/workflow/runner'
import type {
  BuiltinActionRequest,
  BuiltinActionResult,
} from '../src/main/workflow/builtinAction'
import type {
  PersistedRecord,
  StartRequest,
  StartResult,
  WorkflowNodeSpec,
  WorkflowSpec,
} from '../src/shared/ipc'
import type { RunState } from '../src/shared/workflow'
/* ---- 失败归类(重试策略的判据)---- */
import {
  classifyFailure,
  classifyHttpStatus,
  type FailureKind,
  type FailureVerdict,
  type SessionOutcome,
} from '../src/shared/failure'
/* ---- 多服务商 / API 直连(v0.4.0)---- */
import {
  apiAgentId,
  currentValueCandidate,
  defaultModelMap,
  effectiveBaseUrl,
  effectiveModel,
  filterModels,
  isApiAgent,
  mergeModelCandidates,
  MODEL_SOURCE_LABEL,
  providerIdOfAgent,
  PROVIDERS,
  PROVIDER_GROUPS,
  providerOfAgent,
  providersInGroup,
  type ModelCandidate,
} from '../src/shared/providers'
import { envKeyName, looksLikeKey, maskKey } from '../src/shared/secrets'
import { buildChatRequest, parseChunk } from '../src/main/agents/api/protocols'
import { resolveInsideRoot, toolsFor } from '../src/main/agents/api/tools'
import { trimHistory } from '../src/main/agents/api/history'
import { authHeaders, fetchModels, jsonHeaders, toModelDefs } from '../src/main/providers'
import { probeModels } from '../src/main/providers/probe'
/* ---- 模型可用性探测(v0.4.0)---- */
import {
  buildProbeCandidates,
  classifyProbeResponse,
  estimateProbeCost,
  groupProbeResults,
  pickFirstAvailable,
  PROBE_CONCURRENCY,
  PROBE_MAX_TOKENS,
  PROBE_PROMPT,
  PROBE_VERDICT_LABEL,
  verifiedCandidates,
  verifiedModelIds,
  type ProbeResult,
} from '../src/shared/probe'
import type { ChatMessage, ToolDef } from '../src/main/agents/api/types'
import type { NodeEvent, SessionStatus } from '../src/shared/ipc'
import { escapeJsonInner } from '../src/main/imagegen/template'

const CWD = 'D:\\haowan\\workspaces\\default'
/*
 * 画布归属。测试直接驱动 SessionManager(绕开 IPC),而 manager 自己不用 canvasId ——
 * 它只有日志中枢才需要。但 StartRequest 把它标成必填,是为了逼渲染进程每次都说清
 * 「这一轮属于哪个画布」,免得日志写错目录。这里用一个固定 id 满足契约。
 */
const CANVAS = 'e2e'
/** 工作流测试单独用一个画布 id:它要写 blob 文件,和别的测试的目录分开好清理 */
const WF_CANVAS = 'e2e-workflow'

let exitResolve: (() => void) | null = null
const waitExit = (): Promise<void> =>
  new Promise((r) => {
    exitResolve = r
  })

const texts: string[] = []
/** stderr 原样留一份 —— 判断"LLM 到底能不能用"时它是第一手证据(API Error 就在这上面) */
const stderrLines: string[] = []
let lastResult: NodeEvent & { k: 'result' } | null = null

const mgr = new SessionManager({
  events: (_id, evs) => {
    for (const e of evs) {
      switch (e.k) {
        case 'init':
          console.log(`  [init]     sid=${e.sessionId.slice(0, 8)}… model=${e.model} tools=${e.tools?.length}`)
          break
        case 'text':
          texts.push(e.text)
          console.log(`  [text]     ${JSON.stringify(e.text)}`)
          break
        case 'thinking':
          console.log(`  [thinking] ${e.text.slice(0, 60).replace(/\n/g, ' ')}…`)
          break
        case 'tool_use':
          console.log(`  [tool_use] ${e.name}`)
          break
        case 'tool_result':
          console.log(`  [result]   ${e.content.slice(0, 80).replace(/\n/g, ' ')}`)
          break
        case 'result':
          lastResult = e
          console.log(`  [done]     isError=${e.isError} cost=$${e.costUsd} ${e.durationMs}ms`)
          break
        case 'error':
          console.log(`  [ERROR]    ${e.message}`)
          break
        case 'raw':
          console.log(`  [raw]      ${JSON.stringify(e.payload).slice(0, 120)}`)
          break
      }
    }
  },
  exit: (_id, status: SessionStatus, code) => {
    console.log(`  → exit status=${status} code=${code}`)
    exitResolve?.()
    exitResolve = null
  },
  sessionId: (_id, sid) => console.log(`  (authoritative sid = ${sid})`),
  log: (_id, line) => {
    stderrLines.push(line)
    console.log(`  (stderr) ${line.slice(0, 160)}`)
  },
})

/*
 * 断言三态统计(T09):
 *   - pass / fail 由 assert 记账,退出码**只看真实失败**(failCount > 0);
 *   - skip 是"依赖真实 LLM 但 LLM 不可用"的断言 —— 环境问题不该把
 *     `npm run verify` 永远染红,否则真实回归会被淹没在 402 噪音里。
 */
let passCount = 0
let failCount = 0
let skipCount = 0
/** 非 null = 真实 LLM 不可用的人话原因;之后的模型类断言(llmAssert)全部 SKIP */
let llmUnavailable: string | null = null

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passCount++
    console.log(`  ✅ ${msg}`)
  } else {
    failCount++
    console.log(`  ❌ ${msg}`)
    process.exitCode = 1
  }
}

/** 跳过一条断言。只记账,不动退出码 —— 跳过是"没测",不是"失败" */
function skip(msg: string, reason: string): void {
  skipCount++
  console.log(`  ⏭ SKIP ${msg}(${reason})`)
}

/**
 * 依赖**真实模型输出**的断言。
 *
 * LLM 不可用时改记 SKIP(条件成立与否已无意义 —— 错的是环境,不是代码);
 * 机制类断言(参数拼装、调度、落盘)必须继续用 assert,不许躲进 SKIP。
 */
function llmAssert(cond: boolean, msg: string): void {
  if (llmUnavailable) skip(msg, llmUnavailable)
  else assert(cond, msg)
}

/**
 * 从真实会话的输出信号里探测 LLM 是否不可用。
 *
 * 匹配顺序:明确的 API 错误(原句带回,最有信息量)→ 账户/鉴权类 →
 * 网络类。返回 null = LLM 可用,照常断言。
 */
function detectLlmDown(signals: { text: string[]; stderr: string[] }): string | null {
  const all = [...signals.text, ...signals.stderr].join('\n')
  const apiErr = all.match(/API Error:\s*(401|402|403|429)[^\n]*/)
  if (apiErr) return apiErr[0].trim()
  if (/unrecognized_model|insufficient|invalid_api_key|authentication/i.test(all)) {
    return '账户/鉴权不可用'
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo/i.test(all)) return '网络不可达'
  return null
}

/**
 * 持久化回归测试。
 *
 * 不 spawn 任何 agent —— 纯逻辑,所以跑得极快且完全确定性。
 * 用例覆盖的是"数据写下去还能原样读回来"这一类最容易出错的地方。
 */
async function persistTests(): Promise<void> {
  const CANVAS = 'e2e-canvas'
  const NODE = 'n-test'
  const canvasDir = canvasRoot(CANVAS)

  await fs.rm(canvasDir, { recursive: true, force: true })

  const w = new NodeLogWriter(CANVAS)

  // --- seq 连续 ---
  const s1 = await w.appendUser(NODE, '你好')
  const r2 = await w.appendEvents(NODE, [
    { k: 'text', ts: Date.now(), text: '好的' },
    { k: 'thinking', ts: Date.now(), text: '让我想想' },
  ])
  const s3 = await w.appendDiag(NODE, { type: 'system', subtype: 'hook_started' })
  const s4 = await w.appendNotice(NODE, 'warn', '上游产出过大,已落盘')

  assert(s1 === 1, `首个 seq 是 1(实际 ${s1})`)
  assert(r2.seq === 2, `事件批的起始 seq 是 2(实际 ${r2.seq})`)
  assert(s3 === 4 && s4 === 5, `诊断与提示分别拿到 4/5(实际 ${s3}/${s4})`)

  await w.flush()
  const tail = await w.readTail(NODE, 0)
  const seqs = tail.recs.map((r) => r.seq)
  assert(
    JSON.stringify(seqs) === JSON.stringify([1, 2, 3, 4, 5]),
    `读回的 seq 严格连续且有序:${JSON.stringify(seqs)}`,
  )

  // --- 大内容外溢 ---
  const big = 'x'.repeat(100_000)
  const spilled = await w.appendEvents(NODE, [
    { k: 'tool_result', ts: Date.now(), toolUseId: 't1', content: big, isError: false },
  ])
  const rec = spilled.recs[0]
  assert(rec.t === 'event' && rec.ev.k === 'tool_result', '外溢记录仍是 tool_result 事件')
  assert(rec._truncated === true, '被标记为已截断')
  assert(rec._bytes === 100_000, `记录了原始长度(${rec._bytes})`)
  assert(!!rec._blob, '拿到了 blob 引用')
  const inlineLen = rec.t === 'event' && rec.ev.k === 'tool_result' ? rec.ev.content.length : -1
  assert(inlineLen > 0 && inlineLen < 100_000, `内联的是预览而非全文(${inlineLen} 字符)`)

  const restored = rec._blob ? await w.readBlob(rec._blob) : null
  assert(restored === big, 'blob 能读回完整内容,且与原文逐字节一致')

  // --- 崩溃半行 ---
  await w.flush()
  const segFile = path.join(nodeDir(CANVAS, NODE), 'log.000.jsonl')
  const beforeSize = (await fs.stat(segFile)).size
  // 模拟"写到一半断电":追加一段没有换行结尾的、不完整的 JSON
  await fs.appendFile(segFile, '{"seq":999,"ts":1,"t":"user","text":"写到一半', 'utf8')

  const after = await w.readTail(NODE, 0)
  assert(after.torn === true, '检测到末尾有损坏行')
  assert(
    after.recs.length === 6,
    `坏行被丢弃,前面 6 条完好(实际 ${after.recs.length})`,
  )
  assert(
    after.recs.every((r) => typeof r.seq === 'number' && Number.isFinite(r.seq)),
    '所有读回的记录都结构完整',
  )
  console.log(`  (段文件从 ${beforeSize} 字节增长到 ${(await fs.stat(segFile)).size} 字节)`)

  // --- 重启后 seq 必须接着走,不能从 0 重来 ---
  // 磁盘上此刻有 6 条完好记录(1..5 + 大 tool_result 外溢占用的第 6 条),
  // 所以新写入必须是 7 —— 若从 0 重来(或只数到 5),这里就会撞上已有 seq。
  const lastOnDisk = after.recs[after.recs.length - 1].seq
  const w2 = new NodeLogWriter(CANVAS)
  const s5 = await w2.appendUser(NODE, '重启后第一条')
  assert(
    s5 === lastOnDisk + 1 && lastOnDisk > 1,
    `重启后 seq 从磁盘续上(期望 ${lastOnDisk + 1},实际 ${s5})`,
  )

  await w2.resetNode(NODE)
  const afterReset = await w2.readTail(NODE, 0)
  assert(afterReset.recs.length === 0, 'resetNode 清空了日志')

  await w2.flush()
  await fs.rm(canvasDir, { recursive: true, force: true })
}

/**
 * 「重启后还能接上上下文」的回归测试。
 *
 * 不做这一步的话,磁盘上那些日志就只是日志:渲染进程重启后不知道上一轮的
 * sessionId,下一句话会开一个全新会话 —— 用户看到的现象是"记得的东西全丢了"。
 *
 * 不 spawn agent:直接驱动 NodeLogHub,用第二份 hub 实例模拟"新进程"
 * (内存里的 nodeId→canvasId 映射表全空,和真实重启一样)。
 */
async function hydrateTests(): Promise<void> {
  const CANVAS = 'e2e-hydrate'
  const NODE = 'n-hyd'
  await fs.rm(canvasRoot(CANVAS), { recursive: true, force: true })

  const logged: string[] = []
  const mkHub = (): NodeLogHub =>
    new NodeLogHub({
      log: (_n, _c, recs) => {
        for (const r of recs) logged.push(`${r.t}#${r.seq}`)
      },
      progress: () => {},
      exit: () => {},
    })

  const h1 = mkHub()
  h1.register(NODE, CANVAS, {
    nodeId: NODE,
    agentId: 'claude',
    cwd: CWD,
    sessionId: null,
    isFirstTurn: true,
    turns: 0,
    status: 'running',
    model: null,
    lastCostUsd: null,
    lastDurationMs: null,
  })
  await h1.appendUser(NODE, '记住:密码是 42')
  h1.appendEvents(NODE, [
    // 首轮启动时渲染进程还不知道 sessionId,只有 init 事件里有 ——
    // absorb 必须把它写进 meta,否则重启后就只能开新会话
    { k: 'init', ts: Date.now(), sessionId: 'sess-abc-123', model: 'deepseek-flash', tools: ['Read'] },
    { k: 'text', ts: Date.now(), text: '记住了' },
  ])
  await h1.flush(NODE)

  // —— 模拟重启 ——
  const h2 = mkHub()
  const st = await h2.readStateOf(CANVAS, NODE, 100)
  assert(st.meta !== null, '重启后读到了 meta.json')
  assert(st.meta?.sessionId === 'sess-abc-123', `sessionId 落到了磁盘(${st.meta?.sessionId})`)
  assert(st.meta?.turns === 1, `轮数由主进程记账(实际 ${st.meta?.turns})`)
  assert(
    st.meta?.status === 'interrupted',
    `磁盘上的 running 被识别为「被中断」而不是「完成」(实际 ${st.meta?.status})`,
  )
  assert(st.total === 3, `磁盘上 3 条记录(user + init + text,实际 ${st.total})`)

  const first = st.recs[0]
  assert(
    first?.t === 'user' && first.text === '记住:密码是 42',
    '用户消息原样读回(它由主进程写入,重启后不能丢)',
  )

  /*
   * readStateOf 顺带补上了 nodeId → canvasId 的映射。
   * 不补的话 appendUser 里的 `if (!canvasId) return` 会**静默丢弃**重启后的第一句话 ——
   * 表现为界面正常、但日志里没这条,而且 seq 也不会前进。
   */
  logged.length = 0
  await h2.appendUser(NODE, '密码是多少')
  assert(logged.length === 1, `重启后追加的消息确实落盘了(实际 ${logged.length} 条)`)

  const st2 = await h2.readStateOf(CANVAS, NODE, 100)
  assert(st2.meta?.turns === 2, `轮数继续累加(实际 ${st2.meta?.turns})`)
  const last = st2.recs[st2.recs.length - 1]
  assert(last?.t === 'user' && last.text === '密码是多少', '新消息排在最后,seq 接着走')

  /*
   * register 每轮都会被调用,不能把累计值清零。
   * 这条断言钉住的是:重启后开新的一轮,轮数从磁盘上的 2 继续到 3,
   * 而不是又变回 1(那样 "cwd 是否已锁定" 的判断也会跟着错)。
   */
  h2.register(NODE, CANVAS, {
    nodeId: NODE,
    agentId: 'claude',
    cwd: CWD,
    sessionId: 'sess-abc-123',
    isFirstTurn: false,
    turns: 0,
    status: 'running',
    model: null,
    lastCostUsd: null,
    lastDurationMs: null,
  })
  await h2.appendUser(NODE, '第三轮')
  await h2.flush(NODE)
  const st3 = await h2.readStateOf(CANVAS, NODE, 100)
  assert(st3.meta?.turns === 3, `新一轮的 register 不清零累计轮数(实际 ${st3.meta?.turns})`)
  assert(
    st3.meta?.model === 'deepseek-flash',
    `上一轮的 model 没有被 register 抹掉(实际 ${st3.meta?.model})`,
  )
  assert(st3.meta?.sessionId === 'sess-abc-123', 'sessionId 在轮次之间保持不变(--resume 才接得上)')

  /*
   * —— 发现型 sessionId:不靠 init 事件,只靠权威回调 ——
   *
   * Codex / Qwen 这一类根本不回传 Claude 形状的 `init` 事件,上面那条
   * absorb 路径对它们完全失效。这条断言要钉住的是:`hub.setSessionId`
   * **单独**就能把 id 落盘,且换个 hub 实例(模拟重启)读得回来。
   *
   * 上面那个节点走的是 absorb 那条路,这里刻意**不发任何 init 事件** ——
   * 两条路必须各自都能独立成立,不能是"看着像测了回调、其实还是 absorb 兜的底"。
   */
  const N2 = 'n-discovery'
  h2.register(N2, CANVAS, {
    nodeId: N2,
    agentId: 'codex',
    cwd: CWD,
    sessionId: null,
    isFirstTurn: true,
    turns: 0,
    status: 'running',
    model: null,
    lastCostUsd: null,
    lastDurationMs: null,
  })
  await h2.appendUser(N2, '随便说句话')
  // 只有 text 事件,没有任何 init —— absorb 从这里捞不到 id
  h2.appendEvents(N2, [{ k: 'text', ts: Date.now(), text: '好' }])
  h2.setSessionId(N2, 'sess-discovery-xyz')
  await h2.flush(N2)

  const h3 = mkHub()
  const stDisc = await h3.readStateOf(CANVAS, N2, 100)
  assert(
    stDisc.meta?.sessionId === 'sess-discovery-xyz',
    `发现型 id 靠回调就能落盘并跨重启读回(实际 ${stDisc.meta?.sessionId})`,
  )

  /*
   * 空 id 必须被无视。回调链路上任何一环给个空串就调 setSessionId 的话,
   * meta 里的好 id 会被抹成空 —— 表现为"本来能续上的会话突然续不上了"。
   */
  h2.setSessionId(N2, '')
  await h2.flush(N2)
  const stEmpty = await h3.readStateOf(CANVAS, N2, 100)
  assert(
    stEmpty.meta?.sessionId === 'sess-discovery-xyz',
    `空 sessionId 被忽略,好 id 没被抹掉(实际 ${stEmpty.meta?.sessionId})`,
  )

  await fs.rm(canvasRoot(CANVAS), { recursive: true, force: true })
}

/**
 * 节点产出提取的边界。
 *
 * 这件事看起来平平无奇,但它是**工作流里唯一的数据通道** ——
 * 上游写的东西能不能到下游,全看这一个函数。错了不会报错,
 * 只是下游收到空串,然后表现成"它怎么什么都没做"。
 */
async function extractTests(): Promise<void> {
  const rec = (ev: NodeEvent, seq = 1): PersistedRecord => ({ seq, ts: 0, t: 'event', ev })
  const text = (t: string, seq: number): PersistedRecord => rec({ k: 'text', ts: 0, text: t }, seq)
  const result = (t: string | null, seq: number): PersistedRecord =>
    rec(
      { k: 'result', ts: 0, text: t, sessionId: null, costUsd: null, durationMs: null, isError: false },
      seq,
    )

  /*
   * ① 空 result 不能吞掉正文。
   *
   * Codex 那类 agent 的 result 事件只带元数据、text 是空串,正文全在 text 事件里。
   * 老写法 `result ?? chunks.join('')` 会选到那个空串 —— 整段正文消失,且不报错。
   */
  {
    const out = extractOutput([text('第一段。', 1), text('第二段。', 2), result('', 3)])
    assert(out.text === '第一段。第二段。', `空 result 不吞正文(实际 ${JSON.stringify(out.text)})`)
  }

  // ② 纯空白也算"没有":只带换行/空格的 result 同样不该盖掉正文
  {
    const out = extractOutput([text('正文', 1), result('   \n  ', 2)])
    assert(out.text === '正文', '纯空白的 result 同样不吞正文')
  }

  // ③ 有正文的 result 仍然优先 —— 修 ① 不能把"以 result 为准"这条推翻
  //    (result 才是最终答复,text 事件里混着过程旁白)
  {
    const out = extractOutput([text('我先想想…', 1), result('结论是 42', 2)])
    assert(out.text === '结论是 42', '有正文的 result 依然优先于 text 事件')
  }

  // ④ 后来的 result 覆盖先前的:一个节点可能被重试过多次
  {
    const out = extractOutput([result('第一次(错的)', 1), result('第二次(对的)', 2)])
    assert(out.text === '第二次(对的)', '后面的 result 覆盖前面的')
  }

  // ⑤ 截断:超长正文按上限切,并如实报告 truncated
  {
    const out = extractOutput([text('x'.repeat(50), 1)], 10)
    assert(out.text.length === 10 && out.truncated, '超长正文按上限截断并标记 truncated')
  }

  // ⑥ 什么都没有 → 空串,不抛
  {
    const out = extractOutput([])
    assert(out.text === '' && !out.truncated, '空日志返回空串而不是抛错')
  }
}

/**
 * 设置解析 + 启动开关的回归测试。
 *
 * 同样不 spawn 任何 agent。这里要钉住的是两条容易出事的性质:
 *   ① settings.json 被手改坏时**必须降级,不能抛** —— 它是在 app ready 之前读的,
 *      那里抛异常等于应用起不来,用户还没界面可点就先崩了;
 *   ② 坏字段只回退它自己,不能牵连同段其它字段。
 */
async function settingsTests(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haowan-settings-'))
  const file = path.join(tmp, 'settings.json')

  // --- 空文件 → 全默认 ---
  const empty = parseSettings({})
  assert(
    JSON.stringify(empty) === JSON.stringify(DEFAULT_SETTINGS),
    '空对象解析出全默认值',
  )
  assert(empty.memory.disableGpu === true, '默认关闭硬件加速(省内存优先)')
  assert(empty.memory.maxOldSpaceMb >= 1024, '默认堆上限不低于下限 1024')

  // --- 部分覆盖:未提到的字段保持默认 ---
  const partial = parseSettings({ memory: { disableGpu: false } })
  assert(partial.memory.disableGpu === false, '显式 false 被保留')
  assert(
    partial.memory.lowEndDeviceMode === DEFAULT_SETTINGS.memory.lowEndDeviceMode &&
      partial.limits.maxItemsPerNode === DEFAULT_SETTINGS.limits.maxItemsPerNode,
    '同段与其它段未提到的字段各自保持默认',
  )

  // --- 坏值只回退坏字段,不牵连邻居 ---
  const bad = parseSettings({
    memory: { disableGpu: false, maxOldSpaceMb: '不是数字' },
    limits: { maxItemsPerNode: 'x', maxToolResultChars: 123 },
  })
  assert(bad.memory.maxOldSpaceMb === DEFAULT_SETTINGS.memory.maxOldSpaceMb, '坏数字回退默认')
  assert(bad.memory.disableGpu === false, '❗坏字段没有牵连同段的好字段')
  assert(bad.limits.maxToolResultChars === 123, '❗好字段照常生效')
  assert(bad.limits.maxItemsPerNode === DEFAULT_SETTINGS.limits.maxItemsPerNode, '另一个坏字段也回退')

  // 越界值走的是"拒绝"而不是"夹紧":10 < 256 → 回退默认,而不是变成 256
  const outOfRange = parseSettings({ memory: { maxOldSpaceMb: 10 } })
  assert(
    outOfRange.memory.maxOldSpaceMb === DEFAULT_SETTINGS.memory.maxOldSpaceMb,
    '越界值被拒绝并回退默认(而非夹紧到边界)',
  )

  // --- 整个文件不是对象 / 是坏 JSON ---
  assert(
    JSON.stringify(parseSettings('完全不是对象')) === JSON.stringify(DEFAULT_SETTINGS),
    '非对象输入 → 全默认,不抛',
  )
  await fs.writeFile(file, '{ 这不是合法 JSON', 'utf8')
  const fromBadFile = readSettingsSync(file)
  assert(
    JSON.stringify(fromBadFile) === JSON.stringify(DEFAULT_SETTINGS),
    '① 损坏的 settings.json 读成默认值,不抛异常',
  )

  // --- 落盘 → 读回 ---
  await fs.writeFile(file, JSON.stringify({ memory: { disableGpu: false, maxOldSpaceMb: 2048 } }), 'utf8')
  const round = readSettingsSync(file)
  assert(round.memory.disableGpu === false && round.memory.maxOldSpaceMb === 2048, '设置能原样读回')

  // --- 待重启字段的 diff ---
  // 基准用 round 自身,每次只动一个字段,这样 diff 里出现的必然是"被测的那个"
  const noDiff = restartRequiredKeys(round, round)
  assert(noDiff.length === 0, '值与生效值一致时不提示重启')

  const gpuFlipped = { ...round, memory: { ...round.memory, disableGpu: !round.memory.disableGpu } }
  const changed = restartRequiredKeys(gpuFlipped, round)
  assert(
    JSON.stringify(changed) === JSON.stringify(['memory.disableGpu']),
    `只在开关类字段上提示重启:${JSON.stringify(changed)}`,
  )

  const limitsChanged = restartRequiredKeys(
    { ...round, limits: { ...round.limits, maxItemsPerNode: 999 } },
    round,
  )
  assert(limitsChanged.length === 0, '上限类字段即时生效,不要求重启')

  // --- 启动开关:默认必须打上关 GPU ---
  const calls: string[] = []
  const fakeApp = {
    disableHardwareAcceleration: () => calls.push('disableHardwareAcceleration'),
    commandLine: {
      appendSwitch: (k: string, v?: string) => calls.push(v === undefined ? k : `${k}=${v}`),
    },
  }
  calls.length = 0
  applyBootSwitches(fakeApp as never, DEFAULT_SETTINGS)
  assert(calls.includes('disableHardwareAcceleration'), '② 默认设置下确实关掉了硬件加速')
  assert(calls.includes('disable-gpu-compositing'), '同时打上 disable-gpu-compositing')
  assert(
    calls.some((c) => c.startsWith('js-flags=--max-old-space-size=')),
    `堆上限进了 js-flags:${calls.find((c) => c.startsWith('js-flags'))}`,
  )

  calls.length = 0
  applyBootSwitches(fakeApp as never, parseSettings({ memory: { disableGpu: false } }))
  assert(!calls.includes('disableHardwareAcceleration'), '关掉该开关后不再关闭硬件加速')
  assert(!calls.includes('disable-gpu-compositing'), '也不再多打 compositing 开关')

  await fs.rm(tmp, { recursive: true, force: true })
}

/**
 * 工作流引擎的回归测试。
 *
 * **不 spawn 任何 agent** —— 调度器本身不 import Electron / manager / fs,
 * 依赖全部经 `RunnerEnv` 注入,所以这里配一个假的 env 就能把
 * "产出传递 / 溢出降级 / 失败传播与重试 / 环检测" 四条关键性质全跑完,
 * 而且完全确定性:不看模型脸色,不花 API 钱。
 *
 * 测的仍然是**应用里跑的那一份 runner.ts** —— 不是另写的复制品。
 */
interface FakeAttempt {
  ok: boolean
  output: string
  /**
   * 本次失败的归类结果。喂它就能测"不可重试 → 不退避"这条路径,
   * 不必真去 spawn 一个会吐 402 的 agent(见 classifyFailure 那组断言)。
   * 留空 = 没归出类,也就是升级前的行为(照常退避重试)。
   */
  failure?: FailureVerdict
}

class FakeEnv implements RunnerEnv {
  /** nodeId → 每次 startNode 收到的 prompt,按顺序 */
  readonly prompts = new Map<string, string[]>()
  /**
   * startNode 收到的**完整**请求,按顺序。
   *
   * 为什么 prompts 不够:模型名这类字段的 bug 从 prompt 里完全看不出来 ——
   * runner 少传一个 model,prompt 照样一字不差。必须把整个 req 留下来才能断言。
   */
  readonly requests: StartRequest[] = []
  readonly notices: { nodeId: string; level: string; text: string }[] = []
  readonly persisted: RunState[] = []
  readonly cancelled: string[] = []
  private plans = new Map<string, FakeAttempt[]>()
  private current = new Map<string, FakeAttempt>()

  /** 给某个节点排一串"这次会怎样"。用完之后默认成功且产出为空 */
  plan(nodeId: string, attempts: FakeAttempt[]): void {
    this.plans.set(nodeId, [...attempts])
  }

  prompt(nodeId: string, nth = 0): string {
    return this.prompts.get(nodeId)?.[nth] ?? ''
  }

  async stateOf(_canvasId: string, nodeId: string): Promise<NodeRunSnapshot> {
    // 每次运行都当成"已经有会话" —— 工作流要续用节点已有的会话,
    // 这里同时钉住"runner 确实把 sessionId 传下去了"这一点
    return { sessionId: `sess-${nodeId}`, lastSeq: 0 }
  }

  async logsAfter(
    _canvasId: string,
    nodeId: string,
    watermark: number,
    _limit: number,
  ): Promise<PersistedRecord[]> {
    const out = this.current.get(nodeId)?.output ?? ''
    return [
      {
        seq: watermark + 1,
        ts: Date.now(),
        t: 'event',
        ev: {
          k: 'result',
          ts: Date.now(),
          text: out,
          sessionId: `sess-${nodeId}`,
          costUsd: 0,
          durationMs: 1,
          isError: false,
        },
      },
    ]
  }

  async startNode(req: StartRequest): Promise<StartResult> {
    const list = this.prompts.get(req.nodeId) ?? []
    list.push(req.prompt)
    this.prompts.set(req.nodeId, list)
    this.requests.push(req)
    const plan = this.plans.get(req.nodeId) ?? []
    this.current.set(req.nodeId, plan.shift() ?? { ok: true, output: '' })
    return { nodeId: req.nodeId, sessionId: req.sessionId ?? 'new', isFirstTurn: false, exe: 'fake', args: [] }
  }

  async waitFor(nodeId: string): Promise<SessionOutcome> {
    const a = this.current.get(nodeId)
    if (a?.ok) return { status: 'done', code: 0 }
    // 归类结果原样透出 —— 调度器就是靠它决定还要不要退避的
    return { status: 'error', code: 1, ...(a?.failure ? { failure: a.failure } : {}) }
  }

  cancelNode(nodeId: string): boolean {
    this.cancelled.push(nodeId)
    return true
  }

  notice(nodeId: string, level: 'info' | 'warn' | 'error', text: string): void {
    this.notices.push({ nodeId, level, text })
  }

  emit(): void {
    /* 进度推送不参与断言 */
  }

  persist(state: RunState): void {
    this.persisted.push(state)
  }

  logTailLimit = 100

  // ---------- nodes-v2:内置动作(output)路径 ----------

  /** runBuiltinAction 收到的请求,按顺序 —— 分流断言就看它 */
  readonly builtinCalls: BuiltinActionRequest[] = []
  private builtinPlans = new Map<string, BuiltinActionResult[]>()

  /** 给某个节点的打包排一串结果。用完之后默认成功(带一个假产物路径) */
  planBuiltin(nodeId: string, results: BuiltinActionResult[]): void {
    this.builtinPlans.set(nodeId, [...results])
  }

  async runBuiltinAction(req: BuiltinActionRequest): Promise<BuiltinActionResult> {
    this.builtinCalls.push(req)
    const plan = this.builtinPlans.get(req.nodeId) ?? []
    const next = plan.shift() ?? { ok: true, artifactPath: `D:\\fake\\${req.nodeId}.exe`, log: 'fake 打包完成' }
    // 模拟真实 Packager:进度会经 onProgress 冒泡(与真实链路同一形状)
    req.onProgress?.(next.ok ? '[fake] 打包进行中…' : `[fake] 失败:${next.error ?? ''}`)
    return next
  }
}

function nodeSpec(id: string, tpl: string, extra: Partial<WorkflowNodeSpec> = {}): WorkflowNodeSpec {
  /*
   * executor / action 从**注册表派生**(与 specFromGraph 同一真相源):
   * 内置动作节点(output/image)才因此被 runner 分流到 runBuiltinNode。
   * 若这里写死 session,内置动作节点的测试就会静默走错分支。
   */
  const kind: NodeKind = extra.kind ?? 'feature'
  const def = getNodeType(kind)
  return {
    id,
    title: id.toUpperCase(),
    /*
     * v2 默认 = feature/serial:与旧测试的注入语义完全一致(v1 节点迁移后
     * 就是 feature/serial),所以下面所有 v1 时代的断言不需要改一行。
     */
    kind,
    executor: def.executor,
    action: def.action,
    mode: 'serial',
    cwd: CWD,
    // 内置动作节点没有会话,不该带 agentId(镜像 normalizeConfig 的补全规则)
    agentId: def.executor === 'session' ? 'claude' : undefined,
    promptTemplate: tpl,
    failurePolicy: 'skip',
    retry: 0,
    ...extra,
  }
}

function specOf(nodes: WorkflowNodeSpec[], edges: [string, string][], extra: Partial<WorkflowSpec> = {}): WorkflowSpec {
  return {
    runId: 'r-test',
    canvasId: WF_CANVAS,
    targets: [],
    nodes,
    edges: edges.map(([source, target]) => ({ source, target })),
    input: '',
    maxParallel: 2,
    inlineLimitBytes: 32768,
    spillPolicy: 'file',
    ...extra,
  }
}

/**
 * 项目文件夹:画布一个,节点可覆盖,空目录不许跑。
 *
 * 这几条纯函数断言值得单独测,因为「节点在哪个目录里跑」是个静默出错的属性:
 * 配错了不会报错,只会让 agent 去改别的目录里的文件 —— 那是不可逆的。
 */
async function projectDirTests(): Promise<void> {
  const PROJECT = 'D:\\proj\\my-thing'

  assert(effectiveCwd(PROJECT, '') === PROJECT, '节点没配目录时跟随项目文件夹')
  assert(effectiveCwd(PROJECT, 'D:\\other') === 'D:\\other', '节点自己配了目录就用自己的')
  assert(effectiveCwd('', 'D:\\other') === 'D:\\other', '项目文件夹为空不影响节点自己的目录')
  assert(effectiveCwd('', '') === '', '两层都空 = 用户没说过要在哪儿干活(落点由主进程兜底,见下)')
  assert(effectiveCwd(undefined, undefined) === '', '字段缺失(老画布)也走同一条降级路径')

  // specFromGraph 必须和 effectiveCwd 得出同一个结论,否则界面显示的目录
  // 和调度器实际用的目录会不一致 —— 那种不一致没人能看出来
  const spec = specFromGraph({
    canvasId: 'e2e',
    projectDir: PROJECT,
    nodes: [
      { id: 'a', data: { title: 'A' } },
      { id: 'b', data: { title: 'B', cwd: 'D:\\solo' } },
    ],
    edges: [],
    maxParallel: 2,
    inlineLimitBytes: 32768,
  })
  const a = spec.nodes.find((n) => n.id === 'a')
  const b = spec.nodes.find((n) => n.id === 'b')
  assert(a?.cwd === PROJECT, `没配 cwd 的节点在工作流里也跟随项目文件夹(实际 ${a?.cwd})`)
  assert(b?.cwd === 'D:\\solo', `配了 cwd 的节点不被项目文件夹覆盖(实际 ${b?.cwd})`)

  /*
   * 没指定目录 → 落到画布沙箱。**不是抛错。**
   *
   * 这一段原来断言的是「空 cwd 被主进程拒绝」。方向是对的(必须有一个地方
   * 兜住安全边界),但把它实现成了**准入门槛**:想随便跟 AI 说句话,
   * 得先编一个项目目录出来。用户的原话是「我还是需要调用ai,你现在直接
   * 没法给ai对话了」—— 洞堵上了,功能也一起堵死了。
   *
   * 真正的边界是「agent 不许落在应用自己的目录里」(它默认 acceptEdits,
   * 在这儿起来就能改源码),而沙箱满足这一点,所以它既安全又能直接聊。
   */
  const sandbox = resolveStartCwd(CANVAS, '')
  const norm = (p: string): string => p.replace(/\\/g, '/')
  assert(
    norm(sandbox) === `D:/haowan/workspaces/${CANVAS}`,
    `空 cwd 落到画布沙箱(实际 ${sandbox})`,
  )
  assert(existsSync(sandbox), '沙箱目录会按需建出来,不用用户先去手动创建')
  assert(
    !norm(sandbox).startsWith('D:/haowan/src'),
    `沙箱绝不在应用源码目录里(实际 ${sandbox})`,
  )

  /*
   * 明确指定了目录就用它 —— 但它必须真实存在。
   * 不校验的话,一个手改坏的路径会让 spawn 抛一条只提 exe 名字的 ENOENT,
   * 报错里看不到是哪个目录写错了。
   *
   * 这里必须用一个**真实存在**的目录:PROJECT('D:\proj\my-thing')是编出来的,
   * 只适合上面那些纯字符串比较(specFromGraph / effectiveCwd)。
   */
  const realDir = 'D:\\haowan\\workspaces'
  assert(resolveStartCwd(CANVAS, realDir) === realDir, '指定了目录就用指定的那个')
  let badMsg = ''
  try {
    resolveStartCwd(CANVAS, 'D:\\definitely\\not\\here')
  } catch (e) {
    badMsg = (e as Error).message
  }
  assert(badMsg.includes('不存在'), `不存在的目录被明确拒绝,而不是留给 spawn 报错(实际:${badMsg})`)

  /*
   * 走到真实的 startSession 也不能因为空 cwd 抛错 ——
   * 上面测的是纯函数,这条测的是"两条路真的都放行了"。
   * 用一个不存在的 hub/manager 让它走两步就炸,只要**不是**因为 cwd 炸就算过。
   */
  let sessionMsg = ''
  try {
    await startSession({} as NodeLogHub, {} as SessionManager, {
      nodeId: 'n-sandbox',
      canvasId: CANVAS,
      agentId: 'claude',
      cwd: '',
      prompt: '你好',
    })
  } catch (e) {
    sessionMsg = (e as Error).message
  }
  assert(
    !sessionMsg.includes('工作目录') && !sessionMsg.includes('cwd'),
    `startSession 不再因空 cwd 拒绝(实际:${sessionMsg})`,
  )
}

/**
 * 画布存取往返:存下去的东西必须原样读回来。
 *
 * 这条来自两次真实翻车:
 *  ① 用户连的两个节点,重启后连线没了(存盘被一个卡住的标志静默挡住);
 *  ② 我新加的 projectDir 没写进 GraphSchema,而 z.object 默认**丢弃未声明的键** ——
 *     于是项目文件夹界面上设得好好的,一存盘就没了,且**不报任何错**。
 * 两者都是"静默丢数据",靠肉眼看界面永远发现不了,只能靠这条往返断言钉住。
 *
 * 同时钉住 schema 的边界:坏数据必须被拒绝,而不是把半个画布写进去。
 */
async function canvasStoreTests(): Promise<void> {
  const CID = 'e2e-canvas-store'
  /*
   * 故意用 v1 形状(type:'agent'、version:1)构造:
   * saveGraph 现在会把 v1 迁成当前代落盘,loadGraph 再读回也是当前代 ——
   * 下面的断言钉住"存 v1 读回当前代且内容无损"这条兼容线(P0-9)。
   */
  const graph = {
    version: 1,
    name: '往返测试画布',
    projectDir: 'D:\\proj\\往返',
    nodes: [
      { id: 'n1', type: 'agent', position: { x: 10, y: 20 }, data: { title: '节点 1', agentId: 'claude', cwd: '' } },
      {
        id: 'n2',
        type: 'agent',
        position: { x: 320, y: 20 },
        data: { title: '节点 2', agentId: 'claude', cwd: 'D:\\solo' },
      },
    ],
    edges: [{ id: 'e-n1-n2', source: 'n1', target: 'n2' }],
    viewport: { x: -5, y: 7, zoom: 1.25 },
  }

  await saveGraph(CID, graph)
  const back = await loadGraph(CID)

  assert(back !== null, '存进去的画布读得回来')
  /*
   * 主进程 loadGraph 一律经 migrateGraph:存 v1 读回来的就是当前代(version:3,
   * 旧 agent → feature/serial),存当前代原样。这条就是 P0-9 的存取侧钉子。
   */
  assert(back?.version === 3, `loadGraph 迁移到 version:3(实际 ${back?.version})`)
  assert(
    !!back && back.nodes.every((n) => (n as { type?: string }).type === 'feature'),
    'v1 的 agent 节点经存取往返后全部是 feature',
  )
  assert(
    (back?.nodes[0]?.data as { mode?: string } | undefined)?.mode === 'serial',
    '迁移补上了 mode=serial',
  )
  assert(back?.projectDir === graph.projectDir, `项目文件夹没被 zod 剥掉(实际 ${JSON.stringify(back?.projectDir)})`)
  assert(back?.edges.length === 1, `连线还在(实际 ${back?.edges.length} 条)`)
  assert(back?.edges[0]?.source === 'n1' && back?.edges[0]?.target === 'n2', '连线的方向没变')
  assert(back?.nodes.length === 2, '两个节点都在')
  // data 内部不归主进程管,但必须**一个字都不动**地原样带回
  assert(
    (back?.nodes[1]?.data as { cwd?: string } | undefined)?.cwd === 'D:\\solo',
    'node.data 里的自定义字段原样保留(主进程不该懂它,但也不该弄丢)',
  )
  assert(back?.viewport.zoom === 1.25, '视口缩放原样保留')

  // 老画布(阶段 2 之前存的,没有 projectDir 键)必须还能读进来,而不是整份作废
  await saveGraph(CID, {
    version: 1,
    name: '老画布',
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  })
  const legacy = await loadGraph(CID)
  assert(legacy !== null, '缺 projectDir 的老画布不会被判成坏数据')
  assert(legacy?.projectDir === '', `缺字段时兜成空串(实际 ${JSON.stringify(legacy?.projectDir)})`)

  // 坏数据要被拒绝并抛出,而不是悄悄写进去
  let rejected = ''
  try {
    await saveGraph(CID, { version: 1, name: 'x', nodes: [{ id: '' }], edges: [], viewport: {} })
  } catch (e) {
    rejected = (e as Error).message
  }
  assert(rejected.includes('画布数据不合法'), `坏画布被拒绝(实际:${rejected})`)
}

async function workflowGraphTests(): Promise<void> {
  /*
   * 分层用**最长路径深度**,不是朴素的 Kahn 轮次。
   *
   * 菱形 s→a, s→b, a→c, b→c:c 有两级上游,深度必须是 2。
   * 若把 a、b 当成"第 1 层的同伴"就给 c 也标 1,同层就出现了依赖关系 ——
   * 并发起来 c 会读到还没写完的 a/b 产出。
   */
  const diamond = buildIndex(['s', 'a', 'b', 'c'], [
    { source: 's', target: 'a' },
    { source: 's', target: 'b' },
    { source: 'a', target: 'c' },
    { source: 'b', target: 'c' },
  ])
  assert(diamond.depth.get('c') === 2, `菱形汇点深度为 2(实际 ${diamond.depth.get('c')})`)
  assert(diamond.depth.get('a') === 1 && diamond.depth.get('b') === 1, '两个中间节点深度为 1')

  /*
   * 长边也要算进去:s→c 直接相连,同时 s→a→b→c。
   * c 的深度取**最长**路径,直接那条边不能把它拉浅。
   */
  const long = buildIndex(['s', 'a', 'b', 'c'], [
    { source: 's', target: 'a' },
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
    { source: 's', target: 'c' },
  ])
  assert(long.depth.get('c') === 3, `绕远的那条路决定深度(实际 ${long.depth.get('c')})`)

  // 自环与重复边要在建索引前被清掉 —— UI 上从自己拉回自己是可以连出来的
  const norm = normalizeEdges(['a', 'b'], [
    { source: 'a', target: 'a' },
    { source: 'a', target: 'b' },
    { source: 'a', target: 'b' },
    { source: 'a', target: 'ghost' },
  ])
  assert(norm.length === 1, `自环/重复/未知节点的边被清掉(剩 ${norm.length} 条)`)

  // 环检测要指出一条**闭合路径**,否则图一大用户不知道该删哪条线
  let cycle: string[] = []
  try {
    buildIndex(['a', 'b', 'c'], [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'a' },
    ])
    assert(false, '有环的图必须抛 CycleError')
  } catch (e) {
    if (e instanceof CycleError) {
      cycle = e.cycle
      assert(e.cycle.length === 4, `环路径闭合(4 个元素,实际 ${e.cycle.length}:${e.cycle.join('→')})`)
      assert(e.cycle[0] === e.cycle[e.cycle.length - 1], '环路径首尾是同一个节点')
      assert(new Set(e.cycle).size === 3, '环上确实是 3 个不同的节点')
    } else {
      throw e
    }
  }
  void cycle
}

async function workflowRunTests(): Promise<void> {
  await fs.rm(canvasRoot(WF_CANVAS), { recursive: true, force: true })

  // ---------- ① 产出沿连线传递 ----------
  {
    const env = new FakeEnv()
    env.plan('A', [{ ok: true, output: 'A 的结论:密码是 42' }])
    env.plan('B', [{ ok: true, output: 'B 基于 A 的报告' }])
    env.plan('C', [{ ok: true, output: 'C 基于 B 的报告' }])

    const runner = new WorkflowRunner(env)
    const state = await runner.run(
      specOf(
        [nodeSpec('A', ''), nodeSpec('B', '这是上游给的:{{input}}\n请据此继续'), nodeSpec('C', '{{prev}}')],
        [
          ['A', 'B'],
          ['B', 'C'],
        ],
      ),
    )

    assert(state.status === 'done', `A→B→C 全部完成(实际 ${state.status})`)
    assert(
      env.prompt('B').includes('密码是 42'),
      `B 收到了 A 的产出(实际模板渲染结果:${JSON.stringify(env.prompt('B').slice(0, 120))})`,
    )
    assert(
      env.prompt('C').includes('B 基于 A 的报告'),
      `C 收到了 B 的产出,链路一路传下去(${JSON.stringify(env.prompt('C').slice(0, 80))})`,
    )
    // A 没有上游,模板留空 → 提示词就是空输入,不该串进别人的产出
    assert(!env.prompt('A').includes('B 基于'), '源头节点没被下游产出污染')

    /*
     * 流水线上下文:下游除了拿到产出,还得知道**自己在流水线里、项目在哪**。
     * 不知道的话它只会把上游那段文字当成全部事实,而不会去项目目录里看
     * 上游到底改成了什么样 —— 用户要的"下一个节点据此适配自己"就落不了地。
     */
    assert(
      env.prompt('B').includes('[流水线上下文]') && env.prompt('B').includes('上游是'),
      `下游拿到了流水线上下文(${JSON.stringify(env.prompt('B').slice(0, 60))})`,
    )
    assert(
      env.prompt('B').includes(CWD) || env.prompt('B').includes('项目文件夹'),
      '上下文里点明了项目文件夹,并允许它自己去看',
    )
    // 源头节点不该被加上这段 —— 它没有上游,加了就是自说自话
    assert(!env.prompt('A').includes('[流水线上下文]'), '源头节点没有流水线上下文(它没有上游)')
    assert(env.persisted.length >= 1, '运行态落了盘(否则刷新渲染进程后 RunBar 会凭空消失)')
  }

  // ---------- ①b 没配项目文件夹时,下游照样要知道共享目录在哪 ----------
  {
    /*
     * spec.cwd 为空**不等于**这个节点没有目录 —— 主进程会兜到画布沙箱,
     * 而流水线上所有节点共用同一个沙箱。照着 spec.cwd 判断的话,
     * 开场白会在真正有共享目录的时候缺掉最关键的一句,下游于是把上游那段
     * 文字当成全部事实,不会去目录里看它到底改成了什么样 ——
     * 而"后写的节点读先写的代码、据此适配"正是搭流水线的全部意义。
     */
    const env = new FakeEnv()
    env.plan('A', [{ ok: true, output: 'A 写完了框架' }])
    env.plan('B', [{ ok: true, output: 'B 接了点歌' }])

    const runner = new WorkflowRunner(env)
    await runner.run(
      specOf(
        [nodeSpec('A', '写框架', { cwd: '' }), nodeSpec('B', '加入点歌:{{input}}', { cwd: '' })],
        [['A', 'B']],
      ),
    )

    const want = canvasWorkspace(WF_CANVAS)
    assert(
      env.prompt('B').includes(want),
      `cwd 为空时下游仍被告知共享目录(${want}),实际:${JSON.stringify(env.prompt('B').slice(0, 160))}`,
    )
    assert(
      !env.prompt('B').includes('项目文件夹是 \n'),
      '不会留下一句没有路径的空话',
    )
  }

  // ---------- ② 产出过大时降到文件 ----------
  {
    const env = new FakeEnv()
    const big = 'X'.repeat(40_000)
    env.plan('A', [{ ok: true, output: big }])
    env.plan('B', [{ ok: true, output: 'ok' }])

    const runner = new WorkflowRunner(env)
    await runner.run(
      specOf([nodeSpec('A', ''), nodeSpec('B', '{{input}}')], [['A', 'B']], {
        inlineLimitBytes: 32768,
        spillPolicy: 'file',
      }),
    )

    const b = env.prompt('B')
    assert(
      b.includes(canvasBlobsDir(WF_CANVAS)),
      `超过内联上限的产出换成了文件路径(${JSON.stringify(b.slice(0, 160))})`,
    )
    assert(!b.includes(big), '全文**没有**被塞进提示词(否则首字延迟会炸)')
    assert(b.includes('Read'), '提示下游用 Read 工具取全文')

    // 落盘的必须是**完整**内容,不是那份 2000 字预览
    const files = await fs.readdir(canvasBlobsDir(WF_CANVAS))
    assert(files.length === 1, `写出了一个 blob(实际 ${files.length} 个)`)
    const back = await fs.readFile(path.join(canvasBlobsDir(WF_CANVAS), files[0]), 'utf8')
    assert(back.length === big.length, `blob 里是完整内容(实际 ${back.length} 字符)`)

    // truncate 策略不依赖 Read 工具,给没有工具能力的 CLI 用
    const env2 = new FakeEnv()
    env2.plan('A', [{ ok: true, output: big }])
    env2.plan('B', [{ ok: true, output: 'ok' }])
    await new WorkflowRunner(env2).run(
      specOf([nodeSpec('A', ''), nodeSpec('B', '{{input}}')], [['A', 'B']], {
        inlineLimitBytes: 32768,
        spillPolicy: 'truncate',
      }),
    )
    const b2 = env2.prompt('B')
    assert(b2.includes('已截断'), 'truncate 策略走的是截断而不是文件路径')
    assert(b2.length < 40_000, `截断后确实短了(实际 ${b2.length} 字符)`)
  }

  // ---------- ③ 失败传播 + 重试 ----------
  {
    const env = new FakeEnv()
    env.plan('A', [{ ok: false, output: '' }])
    env.plan('B', [{ ok: true, output: 'b' }])
    env.plan('C', [{ ok: true, output: 'c' }])

    const runner = new WorkflowRunner(env)
    const state = await runner.run(
      specOf([nodeSpec('A', ''), nodeSpec('B', ''), nodeSpec('C', '')], [
        ['A', 'B'],
        ['B', 'C'],
      ]),
    )

    assert(state.status === 'failed', `有节点失败时整次运行转 failed(实际 ${state.status})`)
    assert(state.nodes['A']?.status === 'failed', 'A 是 failed')
    assert(state.nodes['B']?.status === 'skipped', `B 被跳过(实际 ${state.nodes['B']?.status})`)
    assert(
      state.nodes['C']?.status === 'skipped',
      `跳过失效**沿链路传播**到 C(实际 ${state.nodes['C']?.status})`,
    )
    assert(!env.prompts.has('B'), 'B 根本没有被启动过 —— 不是"跑了但结果被丢掉"')
    assert(
      env.notices.some((n) => n.nodeId === 'A' && n.level === 'error'),
      '失败在节点自己的日志里留了可见记录',
    )

    // continue 策略:把失败当空产出,下游照跑
    const env2 = new FakeEnv()
    env2.plan('A', [{ ok: false, output: '' }])
    env2.plan('B', [{ ok: true, output: 'b' }])
    const st2 = await new WorkflowRunner(env2).run(
      specOf([nodeSpec('A', '', { failurePolicy: 'continue' }), nodeSpec('B', '')], [['A', 'B']]),
    )
    assert(st2.nodes['B']?.status === 'done', `continue 策略下下游照常跑(实际 ${st2.nodes['B']?.status})`)

    // 重试:第一次失败,第二次成功
    const env3 = new FakeEnv()
    env3.plan('A', [{ ok: false, output: '' }, { ok: true, output: '第二次成了' }])
    env3.plan('B', [{ ok: true, output: 'b' }])
    const st3 = await new WorkflowRunner(env3).run(
      specOf([nodeSpec('A', '', { retry: 2 }), nodeSpec('B', '{{prev}}')], [['A', 'B']]),
    )
    assert(st3.nodes['A']?.status === 'done', `重试后转为成功(实际 ${st3.nodes['A']?.status})`)
    assert(st3.nodes['A']?.attempts === 2, `记录了尝试次数(实际 ${st3.nodes['A']?.attempts})`)
    assert(
      env3.prompt('B').includes('第二次成了'),
      '下游拿到的是**重试成功那一次**的产出,不是失败那次的空值',
    )
  }

  /*
   * ---------- ③b 失败分类:退避重试只对"重试有用"的失败做 ----------
   *
   * 这是纯逻辑 + 假 env,**零 LLM 依赖**,所以一条都不许躲进 SKIP。
   *
   * 背景:升级前所有失败一律退避重试(1+2+4+8+8 ≈ 23 秒)。而"余额不足"这类
   * 错误重试多少次都不会变 —— 用户只看到进度条在挪,不知道发生了什么。
   * 修法是引入 shared/failure.ts 的保守判定:**只对明确认识的几类**判不可重试,
   * 其余一律维持原行为。这一节把"该判的判了"与"不该判的没判"两侧都钉住。
   */
  {
    // ---- ① 明确不可重试的几类,逐条核对 ----
    const PERMANENT: { text: string; kind: FailureKind; label: string }[] = [
      {
        text: 'API Error: 402 Insufficient Balance (request_id: req_01HX)',
        kind: 'balance',
        label: '402 余额不足',
      },
      { text: 'API Error: 401 Unauthorized', kind: 'auth', label: '401 鉴权失败' },
      { text: 'API Error: 403 Forbidden', kind: 'auth', label: '403 无权限' },
      {
        text: '[claude-code:unrecognized_model] {"model":"deepseek-flash"}',
        kind: 'model',
        label: '模型名写错(unrecognized_model)',
      },
      { text: 'You exceeded your current quota, please check your plan', kind: 'quota', label: '配额用尽' },
      {
        text: 'The model `gpt-5-typo` does not exist or you do not have access to it',
        kind: 'model',
        label: '模型不存在(报文里模型名把两个关键词隔开了)',
      },
    ]
    for (const c of PERMANENT) {
      const v = classifyFailure(c.text)
      assert(v.retryable === false, `${c.label} 判为不可重试(实际 retryable=${v.retryable})`)
      assert(v.kind === c.kind, `${c.label} 归类为 ${c.kind}(实际 ${v.kind})`)
      assert(v.hint.length > 0, `${c.label} 有一条面向用户的提示`)
    }

    // ---- ② 负向对照:归不出来的**仍然可重试** ----
    /*
     * 这一条与上面那组同等重要。
     *
     * 判定写"保守"很容易,写"过头"也很容易 —— 而过头的那一种不会让这组测试变红,
     * 它只会让用户在网络抖动时看着本该成功的运行被判死。所以必须有一条**反向**断言:
     * 任何不含已知特征的错误,都必须回到升级前的可重试行为。
     */
    const RETRYABLE: { text: string; label: string }[] = [
      { text: 'spawn EAGAIN resource temporarily unavailable', label: '进程启动时的瞬时错误' },
      { text: 'connect ETIMEDOUT 10.0.0.5:443', label: '网络超时' },
      { text: 'upstream returned 503 Service Unavailable', label: '5xx' },
      { text: 'error: stream closed before message completed', label: '流被截断' },
      { text: '', label: '空错误文本' },
      { text: '第 402 行有个笔误', label: '无关文本里恰好出现了 402 这个数' },
    ]
    for (const c of RETRYABLE) {
      const v = classifyFailure(c.text)
      assert(
        v.retryable !== false,
        `${c.label} 保持可重试、不被误判为永久失败(实际 kind=${v.kind})`,
      )
    }
    assert(
      classifyFailure('stream closed').kind === 'unknown',
      '归不出来的落在 unknown 上(= 可重试),而不是被塞进某个已知类别',
    )
    assert(classifyFailure('stream closed').hint === '', '归不出类时不给处置建议,让调用方回落自己的措辞')

    // ---- ③ API 直连那条路:判据是状态码,不是文案 ----
    assert(classifyHttpStatus(402, '{"error":"insufficient balance"}').retryable === false, 'API 402 判为不可重试')
    assert(classifyHttpStatus(401, '').kind === 'auth', 'API 401 归为鉴权失败')
    assert(classifyHttpStatus(403, '').kind === 'auth', 'API 403 归为鉴权失败')
    assert(classifyHttpStatus(429, '').retryable !== false, 'API 429 纯限流仍可重试(退避之后大概率就过了)')
    assert(
      classifyHttpStatus(429, '{"error":{"code":"insufficient_quota"}}').retryable === false,
      'API 429 但报文写着配额不足 → 判为不可重试(那不是限流)',
    )
    assert(classifyHttpStatus(500, 'boom').retryable !== false, 'API 5xx 保持可重试')
    assert(classifyHttpStatus(400, 'bad request').retryable !== false, '没列出的 4xx 保持可重试(宁可多试几次)')

    // ---- ④ 不可重试的错误**不走退避** ----
    const envP = new FakeEnv()
    const perm = classifyFailure('API Error: 402 Insufficient Balance (request_id: req_01HX)')
    // 排 6 次失败:如果调度器还在退避,这些都会被消耗掉
    envP.plan('A', Array.from({ length: 6 }, () => ({ ok: false, output: '', failure: perm })))
    const stP = await new WorkflowRunner(envP).run(
      specOf([nodeSpec('A', '', { retry: 5 })], []),
    )
    assert(stP.nodes['A']?.status === 'failed', `不可重试的失败直接判 failed(实际 ${stP.nodes['A']?.status})`)
    assert(
      stP.nodes['A']?.attempts === 1,
      `不可重试时**只试一次**,不随 spec.retry 增长(实际 ${stP.nodes['A']?.attempts} 次)`,
    )
    assert(
      (envP.prompts.get('A')?.length ?? 0) === 1,
      `实际只启动了 1 次会话(实际 ${envP.prompts.get('A')?.length ?? 0} 次)`,
    )
    assert(
      !envP.notices.some((n) => n.level === 'warn' && n.text.includes('后重试')),
      '没有发出"xxx ms 后重试"——退避那一段整段跳过了',
    )

    // ---- ⑤ 可重试的失败**仍然退避**(负向对照,防止把 ② 的判据用反) ----
    const envR = new FakeEnv()
    envR.plan('A', [{ ok: false, output: '' }, { ok: true, output: '重试成了' }])
    const stR = await new WorkflowRunner(envR).run(specOf([nodeSpec('A', '', { retry: 2 })], []))
    assert(
      stR.nodes['A']?.status === 'done' && stR.nodes['A']?.attempts === 2,
      `没归类的失败仍然退避重试并能救回来(实际 ${stR.nodes['A']?.status}/${stR.nodes['A']?.attempts})`,
    )

    // ---- ⑥ 人话提示:不含 request_id,原文仍在日志里 ----
    const shown = stP.nodes['A']?.error ?? ''
    assert(shown.length > 0, '失败原因写进了节点状态(用户看得到)')
    assert(!shown.includes('request_id'), `面向用户的文案里没有 request_id(实际:${shown})`)
    assert(!/API Error:\s*402/.test(shown), `没有把服务商的原文甩给用户(实际:${shown})`)
    assert(shown.includes('余额'), `换成了能照着做的人话(实际:${shown})`)
    assert(stP.nodes['A']?.errorKind === 'balance', '失败类别一并带到运行态(UI 据此显示"改配置"而非"再试")')
    assert(stP.nodes['A']?.errorRetryable === false, '明确标记本次失败重试也没用')
    assert(
      envP.notices.some((n) => n.level === 'warn' && n.text.includes('req_01HX')),
      '原始错误文本仍然进了节点日志 —— 排查只有它有用,只是不拿它当文案',
    )
    assert(
      envP.notices.some((n) => n.level === 'error' && !n.text.includes('request_id')),
      '人话提示也发进节点日志了(RunBar 已订阅 nodeLog,无需新增 IPC 通道)',
    )
  }

  // ---------- ④ 有环:跑之前就报错,并指出环上的边 ----------
  {
    const env = new FakeEnv()
    const runner = new WorkflowRunner(env)
    let caught: unknown = null
    try {
      await runner.run(
        specOf([nodeSpec('A', ''), nodeSpec('B', '')], [
          ['A', 'B'],
          ['B', 'A'],
        ]),
      )
    } catch (e) {
      caught = e
    }
    assert(caught instanceof CycleError, '有环时在**任何节点启动之前**就抛错')
    assert(!env.prompts.size, '确实一个 agent 都没启动')
    if (caught instanceof CycleError) {
      assert(caught.cycle.length === 3 && caught.cycle[0] === caught.cycle[2], '错误里带着闭合的环路径')
    }
  }

  // ---------- ⑤ 只跑一部分:带上游,不带上游的上游之外的 ----------
  {
    const env = new FakeEnv()
    env.plan('A', [{ ok: true, output: 'a' }])
    env.plan('B', [{ ok: true, output: 'b' }])
    env.plan('C', [{ ok: true, output: 'c' }])

    const runner = new WorkflowRunner(env)
    // 只跑 B:A→B 是它的上游,得跟着跑;C 是它的下游,不该被牵连
    const state = await runner.run(
      specOf([nodeSpec('A', ''), nodeSpec('B', '{{prev}}'), nodeSpec('C', '{{prev}}')], [
        ['A', 'B'],
        ['B', 'C'],
      ], { targets: ['B'] }),
    )

    assert(state.nodes['A'] !== undefined, 'A 作为上游被带上一起跑')
    assert(state.nodes['C'] === undefined, 'C 是下游,不在这次范围内')
    assert(!env.prompts.has('C'), 'C 的 agent 没被启动')
    assert(env.prompt('B').includes('a'), 'B 仍然拿到了 A 的产出(带上游才有意义)')
  }

  // ---------- ⑥ 模板里取不到的变量:原样保留 + 提醒,不抛 ----------
  {
    const env = new FakeEnv()
    env.plan('A', [{ ok: true, output: 'a' }])
    const st = await new WorkflowRunner(env).run(
      specOf([nodeSpec('A', '{{input}}\n另外参考 {{node:nope}}')], []),
    )
    assert(st.status === 'done', '有未知变量的模板不会让整次运行失败')
    assert(env.prompt('A').includes('{{node:nope}}'), '未知变量原样留在提示词里(比静默变成空串好排查)')
    assert(
      env.notices.some((n) => n.level === 'warn' && n.text.includes('node:nope')),
      '并且发了一条可见的提醒',
    )
  }

  await fs.rm(canvasRoot(WF_CANVAS), { recursive: true, force: true })
}

/**
 * 失败分类在**真实 AgentSession** 上的接线(v0.6.0)。
 *
 * 上面 ③b 测的是「判定规则对不对」与「调度器用得对不对」,用的都是假 env。
 * 但两者之间还有一段必须有人负责:**错误文本到底有没有被收进去**。
 *
 * 那一段是本改动里最容易静默失效的地方:判定函数再对,只要 session.ts
 * 忘了把 stderr / 非 JSON 行喂给它,真实运行时它拿到的就是一段空文本,
 * 于是**每一次失败都归不出类** —— 功能看起来还在(只是退化成旧行为),
 * 断言也照样全绿。所以这里用一个**真的会吐指定文本的假可执行文件**
 * 驱动真实的 AgentSession,把它归出的类别读出来。
 *
 * 不 spawn 真 agent:走的是 node 自己写的 .mjs,不花钱、不看模型脸色。
 */
async function failureClassificationWiringTests(): Promise<void> {
  const CANVAS = 'e2e-fail-class'
  const dir = path.join(os.tmpdir(), 'haowan-e2e-fail-class')
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })

  /*
   * 假 agent:从 argv 后面读"要吐哪一行",打到 stderr 然后以非 0 退出。
   * 用它是为了让**真实的行缓冲 + 真实的子进程管道**参与进来 ——
   * 直接构造 AgentSession 再手调回调,测不到"半行 / 跨 chunk"这些真实情况。
   */
  const script = path.join(dir, 'fake-agent.mjs')
  await fs.writeFile(
    script,
    [
      "const line = process.argv[2] ?? 'boom'",
      'process.stderr.write(line + "\\n")',
      "process.stderr.write('trailing partial line without newline')",
      'process.exit(3)',
    ].join('\n'),
    'utf8',
  )

  /*
   * 假 agent 适配器。
   *
   * 走的是**真实**的 AgentSession(真 spawn、真管道、真行缓冲),只是把可执行文件
   * 换成了 node + 上面那个脚本。要这么绕一圈而不是直接调 classifyFailure:
   * 判定与调度之间那段"错误文本有没有被收进去"的接线,只有真跑一次才算测到。
   *
   * `nextStderr` 用可变持有者传值 —— 适配器接口是同步的,没有地方挂闭包参数。
   */
  let nextStderr = ''
  registerAdapter({
    id: 'fake-fail',
    displayName: '假 agent(仅 e2e)',
    capabilities: {
      headless: true,
      // 走 json 分支:那才是 claude 实际用的那条路,
      // 也是"非 JSON 行 → onStderr + 错误收集"真正生效的地方
      streamJson: true,
      resume: false,
      specifySessionId: false,
      tools: false,
      fork: false,
    },
    promptDelivery: 'argv',
    lineMode: 'json',
    detect: async () => ({
      // node + 脚本路径 = 真实的"两段式"入口(npm 全局装的纯 JS CLI 也是这个形状)
      exe: process.execPath,
      prefixArgs: [script],
      version: '0.0.0-e2e',
      source: 'e2e',
      tried: [script],
    }),
    buildArgs: () => [nextStderr],
    parseEvent: () => [],
    extractSessionId: () => null,
    sanitizeEnv: (env) => env,
  })
  const FAKE = 'fake-fail'

  /** 用真实 AgentSession 跑一句 stderr,返回它归出的失败类别 */
  async function classifyViaStderr(text: string): Promise<{
    status: string
    failure: FailureVerdict | undefined
    stderr: string[]
  }> {
    nextStderr = text
    const hub = new NodeLogHub({ log: () => {}, progress: () => {}, exit: () => {} })
    const stderr: string[] = []
    const mgr = new SessionManager({
      events: (id, evs) => hub.appendEvents(id, evs),
      exit: (id, s, c) => hub.appendExit(id, s, c),
      sessionId: () => {},
      log: (_id, line) => stderr.push(line),
    })
    await hub.register('wiring-node', CANVAS, {
      nodeId: 'wiring-node',
      agentId: FAKE,
      cwd: dir,
      sessionId: null,
      isFirstTurn: true,
      turns: 0,
      status: 'running',
      model: null,
      lastCostUsd: null,
      lastDurationMs: null,
    })
    const started = await mgr.start({
      nodeId: 'wiring-node',
      canvasId: CANVAS,
      agentId: FAKE,
      cwd: dir,
      prompt: 'go',
    })
    assert(started.nodeId === 'wiring-node', '假 agent 真的被拉起来了(否则下面几条都是空断言)')
    const outcome = await mgr.waitFor('wiring-node')
    return { status: outcome.status, failure: outcome.failure, stderr }
  }

  // ① 真实管道里的一行 402 → 归为余额不足、不可重试
  {
    const r = await classifyViaStderr('API Error: 402 Insufficient Balance (request_id: req_abc123)')
    assert(r.status === 'error', `非 0 退出被记为 error(实际 ${r.status})`)
    assert(
      r.failure?.retryable === false,
      `真实 stderr 里的 402 判为不可重试(实际 ${JSON.stringify(r.failure?.kind)})`,
    )
    assert(r.failure?.kind === 'balance', `归类为 balance(实际 ${r.failure?.kind})`)
    assert(
      (r.failure?.raw ?? '').includes('req_abc123'),
      '原始文本留在了 failure.raw 里(排查靠它)',
    )
    assert(
      !r.failure?.hint.includes('request_id'),
      '人话提示里没有 request_id',
    )
    assert(
      r.stderr.some((l) => l.includes('402')),
      '诊断行照旧走 onStderr —— 加错误收集没有改变既有旁路',
    )
  }

  // ② 负向对照:一条不含已知特征的 stderr → 归不出类,仍可重试
  {
    const r = await classifyViaStderr('worker pool resized, retrying in 2s')
    assert(r.status === 'error', `同样以 error 结束(实际 ${r.status})`)
    assert(
      r.failure?.retryable !== false,
      `不含已知特征的 stderr 保持可重试(实际 kind=${r.failure?.kind})`,
    )
    assert(
      r.failure?.kind === 'unknown',
      `归到 unknown 而不是被塞进某个已知类别(实际 ${r.failure?.kind})`,
    )
  }

  // ③ 半行(没有换行符收尾)也进得来 —— 真实崩溃常常就断在这里
  {
    const r = await classifyViaStderr('API Error: 402 Insufficient Balance')
    assert(
      r.stderr.some((l) => l.includes('trailing partial line')),
      '末尾没有换行符的残余也被 flush 出来了(行缓冲的既有行为没被破坏)',
    )
    assert(r.failure?.retryable === false, '半行拼在后面也不影响判定')
  }

  /*
   * ④ 边界:text 模式的 stdout **不进**错误判定。
   *
   * 那一支的每一行都是 agent 写给用户看的正文,不是诊断信息。收进来会有两个坏处:
   * 正文里"error at line 401"这种句子(改代码时极常见)会被鉴权规则命中,
   * 把一次瞬时失败误判成永久失败 —— 那正好违反保守原则。
   * 这条断言就是钉住"正文不算错误证据"这条边界。
   */
  {
    const textScript = path.join(dir, 'fake-text-agent.mjs')
    await fs.writeFile(
      textScript,
      [
        // 正文里故意带一句会被鉴权规则命中的话
        "process.stdout.write('Fixed the bug: see error at line 401 of server.js\\n')",
        'process.exit(4)',
      ].join('\n'),
      'utf8',
    )
    const TEXT_FAKE = 'fake-text'
    registerAdapter({
      id: TEXT_FAKE,
      displayName: '假 text 模式 agent(仅 e2e)',
      capabilities: {
        headless: true,
        streamJson: false,
        resume: false,
        specifySessionId: false,
        tools: false,
        fork: false,
      },
      promptDelivery: 'argv',
      lineMode: 'text',
      detect: async () => ({
        exe: process.execPath,
        prefixArgs: [textScript],
        version: '0.0.0-e2e',
        source: 'e2e',
        tried: [textScript],
      }),
      buildArgs: () => [],
      parseEvent: () => [],
      extractSessionId: () => null,
      sanitizeEnv: (env) => env,
      parsePlainText: (line) => [{ k: 'text', ts: Date.now(), text: line }],
    })

    const hub = new NodeLogHub({ log: () => {}, progress: () => {}, exit: () => {} })
    const mgr = new SessionManager({
      events: (id, evs) => hub.appendEvents(id, evs),
      exit: (id, s, c) => hub.appendExit(id, s, c),
      sessionId: () => {},
      log: () => {},
    })
    await hub.register('text-node', CANVAS, {
      nodeId: 'text-node',
      agentId: TEXT_FAKE,
      cwd: dir,
      sessionId: null,
      isFirstTurn: true,
      turns: 0,
      status: 'running',
      model: null,
      lastCostUsd: null,
      lastDurationMs: null,
    })
    await mgr.start({
      nodeId: 'text-node',
      canvasId: CANVAS,
      agentId: TEXT_FAKE,
      cwd: dir,
      prompt: 'go',
    })
    const out = await mgr.waitFor('text-node')
    assert(out.status === 'error', `text 模式非 0 退出同样记为 error(实际 ${out.status})`)
    assert(
      out.failure?.retryable !== false,
      `text 模式的正文不算错误证据 —— 里面那句 "error at line 401" 没有被鉴权规则命中(实际 kind=${out.failure?.kind})`,
    )
  }

  await fs.rm(dir, { recursive: true, force: true })
  await fs.rm(canvasRoot(CANVAS), { recursive: true, force: true })
}

/**
 * 子图:展开的正确性 / 展开副作用可见 / 环能定位到画布上(零 LLM)。
 *
 * ## 为什么这一节值得单独存在
 *
 * 在它出现之前,整个 e2e(4000+ 行)对子图的断言是**零** —— 测试全绿
 * 完全不代表子图是对的。本节全部是纯函数断言:不 spawn agent、不看模型脸色,
 * 所以本机API 欠费也不影响它们跑(机制类断言一律 `assert`,不许躲进 SKIP)。
 *
 * ## 每组在拦什么
 *
 *   -§1 撞名:外部已占`sg::x` 而内部有 `x`。修前展开出两个 `sg::x`,
 *     runner 的 `new Map(nodes.map(n => [n.id, n]))` 只留一个,另一个的
 *     整份 spec(promptTemplate / cwd)被**静默丢弃** —— 用户点运行看到节点跑起来了,
 *     跑的却是另一个节点的提示词,不报错不警告。
 *   - §2 空模板:子图节点被消掉、**外部线一并删掉**,而下游**照样会被调度**,
 *     只是收不到任何输入。文案里写"跳过"是撒谎(见 P1-1)。
 *   - §3 多入线:模板只记了部分映射时,查不到的入线**全部落到同一个兜底入口**。
 *   - §4 嵌套上限:到上限还剩子图 → 主进程报"未注册的内置动作:"(空动作名),
 *     真实原因一个字没提。
 *   - §5 环:机制上必须抛(不死循环),且提示要指得到画布上真实的节点。
 *   - §6 两端口径一致:渲染端的检查列表与主进程校验的必须是**同一张图**。
 */

/** 造一个子图模板(只填 e2e 用得到的字段,其余靠默认值) */
function tplOf(
  nodes: { id: string; title: string; data?: Record<string, unknown> }[],
  edges: { source: string; target: string }[],
  extra: Partial<SubgraphTemplate> = {},
): SubgraphTemplate {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: (n.data?.kind as NodeKind) ?? 'feature',
      position: { x: 0, y: 0 },
      data: { title: n.title, kind: 'feature', ...n.data } as NodeConfig,
    })),
    edges: edges.map((e, i) => ({ id: `e${i}`, source: e.source, target: e.target })),
    inMap: [],
    outMap: [],
    entryIds: nodes.length > 0 ? [nodes[0].id] : [],
    exitIds: nodes.length > 0 ? [nodes[nodes.length - 1].id] : [],
    ...extra,
  }
}

/** 造一个 feature 节点源 */
function fnode(id: string, title: string, data: Record<string, unknown> = {}): {
  id: string
  data: NodeSpecSource
} {
  return { id, data: { kind: 'feature', title, ...data } as NodeSpecSource }
}

async function subgraphHardeningTests(): Promise<void> {
  console.log('\n  --- 1. 展开后内部id 撞名(P0-1)---')
  {
    //外部已存在 `sg::x`,子图内部也有 `x` —— 前缀命名空间**已被占用**
    const nodes = [
      { id: 'sg', data: { kind: 'subgraph', title: '子图', subgraph: tplOf([{ id: 'x', title: '内部X' }], []) } as NodeSpecSource },
      fnode('sg::x', '外部占位X'),
    ]
    const r = expandSubgraphs(nodes, [])

    // ① id 唯一
    const ids = r.nodes.map((n) => n.id)
    assert(
      new Set(ids).size === ids.length,
      `撞名后展开出的 id仍唯一(${ids.length} 个节点,实际 ${new Set(ids).size} 个不同 id)`,
    )

    // ② 没有悬空端点 —— remap 漏改任何一处 edges/inMap/outMap 就会在这里露出来
    const idSet = new Set(ids)
    const dangling = r.edges.filter((e) => !idSet.has(e.source) || !idSet.has(e.target))
    assert(dangling.length === 0, `撞名 remap 后没有悬空端点的边(实际 ${dangling.length} 条)`)

    // ③ 两个节点的 title 都还在 —— 没被对方覆盖(节点身份不能靠 title 区分)
    const titles = r.nodes.map((n) => n.data.title)
    assert(
      titles.includes('内部X') && titles.includes('外部占位X'),
      `撞名后两个节点的 title 都保留(实际 ${JSON.stringify(titles)})`,
    )

    // ④ 走真实路径:runner 的 Map 必须装得下每一个节点
    const spec = specFromGraph({
      canvasId: 'c',
      nodes,
      edges: [],
      maxParallel: 2,
      inlineLimitBytes: 1024,
    })
    const byId = new Map(spec.nodes.map((n) => [n.id, n]))
    assert(
      byId.size === spec.nodes.length,
      `spec 里的每个节点都能进 runner 的 Map(实际 Map.size=${byId.size} / nodes=${spec.nodes.length})`,
    )
    assert(
      spec.nodes.some((n) => n.promptTemplate === undefined || n.title === '内部X'),
      '内部节点的 title 进了 spec(没被外部节点顶掉)',
    )
  }

  console.log('\n  --- 2. 空模板子图:线被删、下游仍跑(P1-1)---')
  {
    const nodes = [
      fnode('A', 'A'),
      { id: 'sg', data: { kind: 'subgraph', title: '空子图' } as NodeSpecSource },
      fnode('Z', 'Z'),
    ]
    const edges = [
      { source: 'A', target: 'sg' },
      { source: 'sg', target: 'Z' },
    ]
    const r = expandSubgraphs(nodes, edges)

    // ④ Z 仍在图里,但收不到任何入线
    assert(r.nodes.some((n) => n.id === 'Z'), '空子图被消掉后下游 Z 仍在 nodes 里(会被调度)')
    assert(
      !r.edges.some((e) => e.target === 'Z'),
      `空子图被消掉后没有边指向 Z(实际 ${JSON.stringify(r.edges)})—— 它会"跑了但没收到东西"`,
    )
    assert(r.nodes.some((n) => n.id === 'A'), '上游 A 仍在 nodes 里')

    // ⑤ warnings 报出"断开"
    assert(
      r.warnings.some((w) => w.includes('断开')),
      `warnings 报出"断开上下游"(实际 ${JSON.stringify(r.warnings)})`,
    )

    // ⑮ 渲染端检查列表同时有"内容为空"与"下游失去前驱"
    const issues = graphIssuesFor({ nodes, edges, projectDir: '' })
    const hasEmpty = issues.some((i) => i.message.includes('内容为空'))
    // Z 是串行节点且没有前驱 —— validateGraph 的串行规则会报"需要接在某个节点后面"
    const zOrphan = issues.some(
      (i) => i.nodeId === 'Z' && (i.message.includes('没有接在') || i.message.includes('接在某个节点后面')),
    )
    assert(hasEmpty, '渲染端报出子图"内容为空"')
    assert(zOrphan, '渲染端报出下游 Z 失去了前驱(不是静默跑一遍)')
    assert(
      !issues.some((i) => i.message.includes('跳过') && i.message.includes('内容为空')),
      '没有把"断开"说成"跳过"',
    )

    // ⑯ 文案钉死:不含"跳过"、含"断开"
    const emptyMsg = issues.find((i) => i.message.includes('内容为空'))?.message ?? ''
    assert(!emptyMsg.includes('跳过'), `"内容为空"文案不含"跳过"(实际 ${JSON.stringify(emptyMsg)})`)
    assert(emptyMsg.includes('断开'), `"内容为空"文案含"断开"(实际 ${JSON.stringify(emptyMsg)})`)

    // 同一条文案只出现一次(两处来源按文案去重)
    const emptyCount = issues.filter((i) => i.message.includes('内容为空')).length
    assert(emptyCount === 1, `"内容为空"只报一次,不重复(实际 ${emptyCount} 次)`)
  }

  console.log('\n  --- 3. 多入线落到兜底入口(P1-2)---')
  {
    const tpl = tplOf(
      [
        { id: 'e1', title: '内部入口1' },
        { id: 'e2', title: '内部入口2' },
      ],
      [],
      { inMap: [{ from: 'A', to: 'e1' }] },
    )
    const nodes = [
      fnode('A', 'A'),
      fnode('B', 'B'),
      fnode('C', 'C'),
      { id: 'sg', data: { kind: 'subgraph', title: '子图', subgraph: tpl } as NodeSpecSource },
    ]
    const edges = [
      { source: 'A', target: 'sg' },
      { source: 'B', target: 'sg' },
      { source: 'C', target: 'sg' },
    ]
    const r = expandSubgraphs(nodes, edges)

    // ⑥ unmappedIn 含没被映射的 B、C
    const rec = r.unmappedIn.find((u) => u.subgraphId === 'sg')
    assert(!!rec, 'unmappedIn 记下了这个子图')
    assert(
      !!rec && rec.externals.includes('B') && rec.externals.includes('C'),
      `unmappedIn 含未被映射的 B、C(实际 ${JSON.stringify(rec?.externals)})`,
    )
    assert(!!rec && !!rec.fallback, `unmappedIn 说清兜底落点(实际 ${rec?.fallback})`)
    assert(
      r.warnings.some((w) => w.includes('兜底入口')),
      `warnings 说清兜底入口是谁(实际 ${JSON.stringify(r.warnings)})`,
    )

    // ⑦ B、C **确实都连到 e1** —— 把当前行为钉住。
    //    这里刻意**不**"顺手修成轮询分配":那会改变串行叠加的语义,
    //    是一个需要用户明确拍板的决定,不是 bug 修复。
    const bTarget = r.edges.find((e) => e.source === 'B')?.target
    const cTarget = r.edges.find((e) => e.source === 'C')?.target
    assert(bTarget === cTarget, `B、C 落到同一个入口(实际 B→${bTarget},C→${cTarget})`)
    assert(
      bTarget === 'sg::e1' && cTarget === 'sg::e1',
      `B、C 都连到第一个入口 sg::e1(实际 B→${bTarget},C→${cTarget})`,
    )
    // 而 e2 成了孤儿:没人喂它
    assert(
      !r.edges.some((e) => e.target === 'sg::e2'),
      'e2 没有外部入线(成孤儿)—— 正是这条警告要说清的事',
    )
  }

  console.log('\n  --- 4. 映射完整时不得有噪音警告 ---')
  {
    const tpl = tplOf(
      [
        { id: 'e1', title: '内部入口1' },
        { id: 'e2', title: '内部入口2' },
      ],
      [],
      {
        inMap: [
          { from: 'A', to: 'e1' },
          { from: 'B', to: 'e1' },
          { from: 'C', to: 'e1' },
        ],
      },
    )
    const nodes = [
      fnode('A', 'A'),
      fnode('B', 'B'),
      fnode('C', 'C'),
      { id: 'sg', data: { kind: 'subgraph', title: '子图', subgraph: tpl } as NodeSpecSource },
    ]
    const edges = [
      { source: 'A', target: 'sg' },
      { source: 'B', target: 'sg' },
      { source: 'C', target: 'sg' },
    ]
    const r = expandSubgraphs(nodes, edges)
    // ⑧ entryIds 非空且映射完整 → unmappedIn 为空
    assert(r.unmappedIn.length === 0, `映射完整时 unmappedIn 为空(实际 ${JSON.stringify(r.unmappedIn)})`)
    assert(
      r.warnings.length === 0,
      `映射完整时不产生噪音警告(实际 ${JSON.stringify(r.warnings)})—— 永远为真的警告等于没有警告`,
    )
  }

  console.log('\n  --- 5. 嵌套上限与残留(P1-3)---')
  {
    /** 造 depth 层嵌套,最内层一个普通节点 */
    const nest = (depth: number): { id: string; data: NodeSpecSource }[] => {
      let inner: SubgraphTemplate = tplOf([{ id: 'leaf', title: '叶' }], [])
      for (let i = 0; i < depth - 1; i++) {
        inner = tplOf([{ id: 'n', title: `层${i}`, data: { kind: 'subgraph', subgraph: inner } }], [], {
          entryIds: ['n'],
          exitIds: ['n'],
        })
      }
      return [{ id: 'top', data: { kind: 'subgraph', title: '顶', subgraph: inner } as NodeSpecSource }]
    }

    // ⑨ 上限内:完全展开,零残留、零警告
    const okR = expandSubgraphs(nest(MAX_SUBGRAPH_DEPTH), [])
    const okRest = okR.nodes.filter((n) => (n.data.kind ?? 'feature') === 'subgraph')
    assert(
      okRest.length === 0,
      `${MAX_SUBGRAPH_DEPTH} 层嵌套完全展开(残留 ${okRest.length} 个)`,
    )
    assert(okR.warnings.length === 0, `${MAX_SUBGRAPH_DEPTH} 层嵌套不产生警告`)

    // 超过上限:残留被钉住 + 必须有 warn 指向真实原因
    const overR = expandSubgraphs(nest(MAX_SUBGRAPH_DEPTH + 5), [])
    const overRest = overR.nodes.filter((n) => (n.data.kind ?? 'feature') === 'subgraph')
    assert(
      overRest.length > 0,
      `${MAX_SUBGRAPH_DEPTH + 5} 层嵌套有残留(实际 ${overRest.length} 个)—— 上限边界被钉住`,
    )
    assert(
      overR.warnings.some((w) => w.includes('嵌套') && w.includes(String(MAX_SUBGRAPH_DEPTH))),
      `超限有 warn 指向"嵌套层数"而不是静默(实际 ${JSON.stringify(overR.warnings)})`,
    )
    // 空动作名的错误消息必须能看出"动作名是空的"
    let builtinMsg = ''
    try {
      getBuiltinAction('')
    } catch (e) {
      builtinMsg = (e as Error).message
    }
    assert(
      builtinMsg.includes('(空'),
      `未注册内置动作时空动作名有显式说明(实际 ${JSON.stringify(builtinMsg)})`,
    )
  }

  console.log('\n  --- 6. 环:必须抛,且指得到画布( P0-2 / P1-4)---')
  {
    // ⑪ 模板内 i1→i2、i2→i1
    const tpl = tplOf(
      [
        { id: 'i1', title: 'i1' },
        { id: 'i2', title: 'i2' },
      ],
      [
        { source: 'i1', target: 'i2' },
        { source: 'i2', target: 'i1' },
      ],
    )
    const spec = specFromGraph({
      canvasId: 'c',
      nodes: [{ id: 'sg', data: { kind: 'subgraph', title: '子图', subgraph: tpl } as NodeSpecSource }],
      edges: [],
      maxParallel: 2,
      inlineLimitBytes: 1024,
    })
    const specIds = spec.nodes.map((n) => n.id)
    let threwInner = false
    try {
      buildIndex(specIds, normalizeEdges(specIds, spec.edges))
    } catch (e) {
      threwInner = e instanceof CycleError
    }
    assert(threwInner, '模板内 i1→i2、i2→i1 抛 CycleError(不是死循环)')

    // ⑫ A→子图→A 跨前缀环
    const tpl2 = tplOf(
      [
        { id: 'i1', title: 'i1' },
        { id: 'i2', title: 'i2' },
      ],
      [{ source: 'i1', target: 'i2' }],
      { inMap: [{ from: 'A', to: 'i1' }], outMap: [{ from: 'i2', to: 'A' }] },
    )
    const nodes2 = [
      fnode('A', 'A'),
      { id: 'sg', data: { kind: 'subgraph', title: '子图', subgraph: tpl2 } as NodeSpecSource },
    ]
    const edges2 = [
      { source: 'A', target: 'sg' },
      { source: 'sg', target: 'A' },
    ]
    const spec2 = specFromGraph({
      canvasId: 'c',
      nodes: nodes2,
      edges: edges2,
      maxParallel: 2,
      inlineLimitBytes: 1024,
    })
    const ids2 = spec2.nodes.map((n) => n.id)
    let threwCross = false
    try {
      buildIndex(ids2, normalizeEdges(ids2, spec2.edges))
    } catch (e) {
      threwCross = e instanceof CycleError
    }
    assert(threwCross, 'A→子图→A 的跨前缀环抛 CycleError(前缀防住了自环,但跨前缀环是真的)')

    /*
     * P0-2 的核心:主进程那一次检测跑在**展开后** —— 环上的 id 画布上不存在,
     * 高亮一条都点不亮。所以渲染端必须在**未展开**的图上先检一次。
     * 下面直接断言那条真实路径(shared/graph.detectCanvasCycle)。
     */
    const outerCycleNodes = [fnode('A', 'A'), fnode('B', 'B'), fnode('C', 'C')]
    const outerCycleEdges = [
      { source: 'A', target: 'B' },
      { source: 'B', target: 'C' },
      { source: 'C', target: 'A' },
    ]
    const canvasCycle = detectCanvasCycle(outerCycleNodes, outerCycleEdges)
    assert(canvasCycle !== null, '未展开图上的 A→B→C→A 被 detectCanvasCycle 检出')
    const canvasIds = new Set(outerCycleNodes.map((n) => n.id))
    assert(
      !!canvasCycle && canvasCycle.cycle.every((id) => canvasIds.has(id)),
      `渲染端预检的 cycle 每个 id 都在画布上(实际 ${JSON.stringify(canvasCycle?.cycle)})—— 这才能高亮`,
    )
    assert(
      canvasCycle !== null &&
        canvasCycle.cycle.length > 1 &&
        canvasCycle.cycle[0] === canvasCycle.cycle[canvasCycle.cycle.length - 1],
      'cycle 是闭合路径(首尾同一个),Canvas 才能两两配成边',
    )
    // 对照:主进程那一次的 cycle 全是画布上不存在的 id —— 这正是必须预检的原因
    const mainCycleIds = spec2.nodes.map((n) => n.id)
    let mainCycle: string[] = []
    try {
      buildIndex(ids2, normalizeEdges(ids2, spec2.edges))
    } catch (e) {
      if (e instanceof CycleError) mainCycle = e.cycle
    }
    const missingOnCanvas = mainCycle.filter((id) => !canvasIds.has(id) && !id.startsWith('sg::'))
    assert(
      mainCycle.some((id) => id.includes('::')),
      `对照:展开后检出的 cycle 带前缀 id(${JSON.stringify(mainCycle)})—— 正是它点不亮任何边`,
    )
    assert(mainCycleIds.length > 0 && missingOnCanvas.length === 0, '对照组的非子图 id 仍能在 spec 里找到')

    // 子图内部成环:必须给一句指得到位的提示(而不是裸id)
    const innerHint = subgraphInnerCycleHint([
      { id: 'sg', data: { kind: 'subgraph', title: '子图', subgraph: tpl } as NodeSpecSource },
    ])
    assert(innerHint !== null, '子图内部成环被 subgraphInnerCycleHint 检出')
    assert(
      !!innerHint && innerHint.includes('i1') && innerHint.includes('i2'),
      `内部环提示用节点标题而不是裸 id(实际 ${JSON.stringify(innerHint)})`,
    )
    assert(!!innerHint && innerHint.includes('展开'), '内部环提示告诉用户下一步做什么')
    // 无环时不得有噪音
    assert(
      subgraphInnerCycleHint([
        { id: 'sg', data: { kind: 'subgraph', title: '好子图', subgraph: tplOf([{ id: 'a', title: 'a' }, { id: 'b', title: 'b' }], [{ source: 'a', target: 'b' }]) } as NodeSpecSource },
      ]) === null,
      '子图内部无环时不产生提示',
    )
  }

  console.log('\n  --- 7. 幂等 ---')
  {
    const tpl = tplOf(
      [
        { id: 'a', title: 'a' },
        { id: 'b', title: 'b' },
      ],
      [{ source: 'a', target: 'b' }],
    )
    const nodes = [
      fnode('X', 'X'),
      { id: 'sg', data: { kind: 'subgraph', title: '子图', subgraph: tpl } as NodeSpecSource },
    ]
    const edges = [
      { source: 'X', target: 'sg' },
      { source: 'sg', target: 'X' },
    ]
    const r1 = expandSubgraphs(nodes, edges, [])
    const r2 = expandSubgraphs(r1.nodes, r1.edges, r1.targets)
    // ⑩ 对已展开结果再跑一次 → 输出不变
    assert(
      JSON.stringify(r1.nodes) === JSON.stringify(r2.nodes),
      `对已展开结果再跑一次,节点不变(实际 ${JSON.stringify(r2.nodes.map((n) => n.id))})`,
    )
    assert(
      JSON.stringify(r1.edges) === JSON.stringify(r2.edges),
      `对已展开结果再跑一次,边不变(实际 ${JSON.stringify(r2.edges)})`,
    )
    assert(
      JSON.stringify(r1.targets) === JSON.stringify(r2.targets),
      '对已展开结果再跑一次,targets 不变',
    )
    /*
     * 幂等的一部分:第二次展开**不再报**任何警告。
     * (第一次会报 —— 这个 fixture 的 inMap/outMap 都是空的,X→sg 与 sg→X
     * 查不到映射,确实该报"落到兜底入口"。关键在于同一条事实不被反复报。)
     */
    assert(
      r2.warnings.length === 0,
      `对已展开结果再跑一次不重复报警告(实际 ${JSON.stringify(r2.warnings)})`,
    )
    assert(
      r1.warnings.length > 0,
      `第一次展开报出了 X 落到兜底入口(实际 ${JSON.stringify(r1.warnings)})`,
    )
  }

  console.log('\n  --- 8. 两端校验口径一致(P0-3,最防回归的一条)---')
  {
    /*
     * fixture:子图内含 project(projectDir 空) + test(testCommand 空)。
     * 修前:渲染端(未展开的图)= 1 条,主进程(展开后的 spec)= 3 条 ——
     * 三种不同后果取决于你看哪一端。
     */
    const tpl = tplOf(
      [
        { id: 'ip', title: '内部项目', data: { kind: 'project', projectDir: '' } },
        { id: 'it', title: '内部测试', data: { kind: 'test', testCommand: '' } },
      ],
      [{ source: 'ip', target: 'it' }],
      { entryIds: ['ip'], exitIds: ['it'] },
    )
    const nodes = [{ id: 'sg', data: { kind: 'subgraph', title: '子图', subgraph: tpl } as NodeSpecSource }]
    const edges: { source: string; target: string }[] = []

    //⑬ 展开后的图必须能查出子图内部的 test 问题
    const exp = expandSubgraphs(nodes, edges)
    const expIssues = validateGraph({ nodes: exp.nodes, edges: exp.edges, projectDir: '' })
    assert(
      expIssues.some((i) => i.message.includes('还没填写要跑的测试命令')),
      '展开后的图报出子图内部 test 节点"还没填写要跑的测试命令"',
    )

    // 主进程那一侧:validateGraph 吃 spec.nodes(已展开)
    const spec = specFromGraph({
      canvasId: 'c',
      nodes,
      edges,
      maxParallel: 2,
      inlineLimitBytes: 1024,
    })
    const mainIssues = validateGraph({
      nodes: spec.nodes.map((n) => ({ id: n.id, data: n })),
      edges: spec.edges,
      projectDir: spec.projectDir,
    })
    assert(mainIssues.length === 3, `主进程口径 3 条(实际 ${mainIssues.length})`)

    // ⑭ 渲染端(用同一个 graphIssuesFor)条数与内容都与主进程相等
    const rendererIssues = graphIssuesFor({ nodes, edges, projectDir: '' })
    assert(
      rendererIssues.length === mainIssues.length,
      `渲染端与主进程条数相等(渲染端 ${rendererIssues.length} / 主进程 ${mainIssues.length})—— 修前是 1 vs 3`,
    )
    const norm = (xs: GraphIssue[]): string[] => xs.map((i) => i.message).sort()
    assert(
      JSON.stringify(norm(rendererIssues)) === JSON.stringify(norm(mainIssues)),
      '渲染端与主进程逐条文案相同',
    )

    // 反向:渲染端**不该**多报"没有项目节点"(展开后图里明明有 project 节点)
    assert(
      !rendererIssues.some((i) => i.message.includes('没有项目节点')),
      '展开后图里明明有 project 节点,不该再报"画布上没有项目节点"',
    )

    // 子图自身的校验不能因为展开而消失(空模板那条)
    const emptyNodes = [
      { id: 'sg2', data: { kind: 'subgraph', title: '空子图' } as NodeSpecSource },
      fnode('Z2', 'Z2'),
    ]
    const emptyIssues = graphIssuesFor({
      nodes: emptyNodes,
      edges: [{ source: 'sg2', target: 'Z2' }],
      projectDir: '',
    })
    assert(
      emptyIssues.some((i) => i.message.includes('内容为空')),
      '子图节点自身的 V13(内容为空)在展开后依然报得出来',
    )
  }

  console.log('\n  --- 9. 图标表完整性(防将来加类型漏图标静默渲染空白)---')
  {
    /*
     * 遍历注册表里每个 NodeTypeDef 的 badge.icon,逐个查 Icons.tsx 的表。
     * 漏一个的表现是节点角标**渲染成空白** —— 不报错、不抛异常,e2e 全绿,
     * 只能靠肉眼发现。所以在这里钉住。
     */
    const iconsSrc = await fs.readFile(
      path.join(import.meta.dirname ?? __dirname, '..', 'src', 'renderer', 'src', 'components', 'Icons.tsx'),
      'utf8',
    )
    const missing: string[] = []
    for (const def of Object.values(NODE_TYPES) as { badge?: { icon?: string } }[]) {
      const icon = def.badge?.icon
      if (!icon) continue
      // ICONS 表的条目形如 `  project: (` —— 按行首两空格 + key + 冒号匹配
      if (!new RegExp(`^\\s{2}${icon}:`, 'm').test(iconsSrc)) missing.push(icon)
    }
    assert(missing.length === 0, `每个 NodeTypeDef.badge.icon 都在 Icons.tsx 的表里(缺 ${missing.join(',') || '无'})`)

    // 反向:注册表里的图标名必须都真实存在(不是打错字)
    const allIcons = (Object.values(NODE_TYPES) as { badge?: { icon?: string } }[])
      .map((d) => d.badge?.icon)
      .filter((x): x is string => !!x)
    assert(allIcons.length > 0, `注册表里至少有一个图标声明(实际 ${allIcons.length} 个)`)
  }
}

/**
 * QA 回归:两个"看起来绿、实际错"的缺陷(2026-10 独立验证时构造出来)。
 *
 * 两条都不是"补测试",是**补上断言没覆盖到的形状**:
 * 原有断言挑的样本恰好落在安全区,所以它们恒绿。
 */
async function qaRegressionTests(): Promise<void> {
  console.log('\n  --- 1. specFromGraph 必须把"用户配没配目录"拍进 spec(否则主进程误报)---')
  {
    /*
     * 缺陷:`WorkflowNodeSpec` 只有 `cwd`(解析后的值),没有 `projectDir`(用户配没配)。
     * 而 runner.ts把 spec.nodes 直接当 `NodeSpecSource` 传给 validateGraph,
     * V3 读的是 `first.data.projectDir` —— 于是每个**配好了目录**的项目节点
     * 都被判成"还没选文件夹"。用户去设置里一看目录好好设着,最后怀疑是 bug。
     *
     * 为什么原有两条"还没选文件夹"断言抓不到:它们的场景是**缺目录**,
     * 缺目录时新旧行为都报 —— 恰好绕开了这个 case。
     *
     * ⚠️ 断言**必须**走 specFromGraph → validateGraph 这条真实路径。
     * 直接调 validateGraph 喂画布节点等于断言一份复制品,什么也钉不住。
     */
    const proj = (
      id: string,
      dir: string | undefined,
      extra: Record<string, unknown> = {},
    ): { id: string; data: NodeSpecSource } => ({
      id,
      data: { kind: 'project', title: id, ...(dir === undefined ? {} : { projectDir: dir }), ...extra } as NodeSpecSource,
    })
    /** 主进程那一侧的真实形状(runner.ts 里逐字照抄) */
    const mainIssues = (
      nodes: { id: string; data: NodeSpecSource }[],
      edges: { source: string; target: string }[],
    ): GraphIssue[] => {
      const spec = specFromGraph({ canvasId: 'c', nodes, edges, maxParallel: 2, inlineLimitBytes: 1024 })
      return validateGraph({
        nodes: spec.nodes.map((n) => ({ id: n.id, data: n })),
        edges: spec.edges,
        projectDir: spec.projectDir,
      })
    }

    //① 配了目录 → 主进程不得报"还没选文件夹"
    {
      const nodes = [proj('P', 'D:/work/proj'), fnode('F', 'F')]
      const issues = mainIssues(nodes, [{ source: 'P', target: 'F' }])
      const fp = issues.filter((i) => i.message.includes('还没选文件夹'))
      assert(
        fp.length === 0,
        `主进程:配了目录的项目节点不被误报"还没选文件夹"(实际 ${fp.length} 条:${JSON.stringify(fp.map((i) => i.message))})`,
      )
    }

    // ② projectDir 必须**原样**进 spec,不是解析后的 cwd(否则"没配但有兜底"会被当成"配好了")
    {
      const spec = specFromGraph({
        canvasId: 'c',
        nodes: [proj('P', 'D:/work/proj')],
        edges: [],
        maxParallel: 2,
        inlineLimitBytes: 1024,
      })
      assert(
        spec.nodes[0].projectDir === 'D:/work/proj',
        `spec.projectDir 拍的是用户配的原值(实际 ${JSON.stringify(spec.nodes[0].projectDir)})`,
      )
      // 没配的必须是空串,不能是解析后的兜底值
      const spec2 = specFromGraph({
        canvasId: 'c',
        nodes: [proj('Q', undefined)],
        edges: [],
        projectDir: 'D:/canvas/legacy',
        maxParallel: 2,
        inlineLimitBytes: 1024,
      })
      assert(
        spec2.nodes[0].projectDir === '' && spec2.nodes[0].cwd === 'D:/canvas/legacy',
        `没配时 projectDir='' 而 cwd 回落到画布级(实际 projectDir=${JSON.stringify(spec2.nodes[0].projectDir)} cwd=${JSON.stringify(spec2.nodes[0].cwd)})`,
      )
      assert(
        spec2.nodes[0].projectDir !== spec2.nodes[0].cwd,
        'projectDir 与 cwd 语义不同:没配 + 有兜底时两者必须不同(混用会把兜底误报成"配好了")',
      )
    }

    // ③ 依赖 resolvedProjectDir 的规则(test/image/doc/V5)同样受这个缺陷影响
    for (const [label, node, kw] of [
      ['test', { kind: 'test', title: '跑测试', testCommand: 'npm test' }, '项目文件夹还没设'],
      ['doc', { kind: 'doc', title: '写文档' }, '项目文件夹还没设'],
      ['image', { kind: 'image', title: '出图' }, '项目文件夹还没设'],
    ] as const) {
      const nodes: { id: string; data: NodeSpecSource }[] = [
        proj('P', 'D:/work/proj'),
        { id: 'X', data: node as unknown as NodeSpecSource },
      ]
      const issues = mainIssues(nodes, [{ source: 'P', target: 'X' }])
      const fp = issues.filter((i) => i.message.includes(kw))
      assert(
        fp.length === 0,
        `主进程:上游项目配了目录时 ${label} 节点不被误报"${kw}"(实际 ${fp.length} 条)`,
      )
    }

    // ④ 反向:真没配目录时**仍然必须报**(别把真问题一起"修"没了)
    {
      const nodes = [proj('P2', undefined), fnode('F2', 'F2')]
      const issues = mainIssues(nodes, [{ source: 'P2', target: 'F2' }])
      assert(
        issues.filter((i) => i.message.includes('还没选文件夹')).length === 1,
        '主进程:确实没配目录时仍然报"还没选文件夹"(修法没有把真问题一起修掉)',
      )
    }

    // ⑤ 两端口径必须一致 —— 这才是 P0-3 真正要保证的东西
    {
      const nodes = [proj('P3', 'D:/work/proj'), fnode('F3', 'F3')]
      const edges = [{ source: 'P3', target: 'F3' }]
      const rend = graphIssuesFor({ nodes, edges, projectDir: '' })
      const main = mainIssues(nodes, edges)
      const norm = (xs: GraphIssue[]): string[] => xs.map((i) => i.message).sort()
      assert(
        JSON.stringify(norm(rend)) === JSON.stringify(norm(main)),
        `渲染端与主进程逐条文案相同(渲染端 ${JSON.stringify(norm(rend))} / 主进程 ${JSON.stringify(norm(main))})`,
      )
    }

    // ⑥ 子图内部的项目节点走同一条路
    {
      const nodes: { id: string; data: NodeSpecSource }[] = [
        {
          id: 'sg',
          data: {
            kind: 'subgraph',
            title: '子图',
            subgraph: tplOf(
              [
                { id: 'ip', title: '内部项目', data: { kind: 'project', projectDir: 'D:/work/inner' } },
                { id: 'it', title: '内部测试', data: { kind: 'test', testCommand: 'npm test' } },
              ],
              [{ source: 'ip', target: 'it' }],
              { entryIds: ['ip'], exitIds: ['it'] },
            ),
          } as NodeSpecSource,
        },
      ]
      const fp = mainIssues(nodes, []).filter((i) => i.message.includes('还没选文件夹'))
      assert(fp.length === 0, `主进程:子图内部配了目录的项目节点不被误报(实际 ${fp.length} 条)`)
    }
  }

  console.log('\n  --- 2. failure.raw 必须保留尾部(错误行在最后,不能从头切)---')
  {
    /*
     * 缺陷:`clip()` 用 `slice(0, max)` 从**头部**截断 500 字符。
     * 而 `raw` 的唯一用途是排查,错误几乎总是整段输出的**最后几行** ——
     * 于是前500 字符恰好是 `reading file src/module-3.ts` 这类噪声,
     * 真正带 `request_id` 的错误行被整段切掉。用户拿着这行去搜工单搜不到东西。
     *
     * 为什么原有断言抓不到:它用**一行**短 stderr,总长 < 500 → RAW_MAX 根本没触发。
     */
    const noise = Array.from({ length: 59 }, (_, i) => `log line ${i}: reading file src/module-${i}.ts`).join('\n')
    const stderr = `${noise}\nAPI Error: 402 Insufficient Balance (request_id: req_QA_TAIL)`
    const v = classifyFailure(stderr)
    assert(v.raw.length <= 500, `raw 不超过 RAW_MAX(实际 ${v.raw.length})`)
    assert(
      v.raw.includes('req_QA_TAIL'),
      `raw 保留尾部:噪声 59 行时 request_id 仍在(实际尾部 ${JSON.stringify(v.raw.slice(-60))})`,
    )
    assert(v.raw.includes('402'), 'raw 保留尾部:错误行本身仍在')
    assert(
      !v.raw.includes('log line 0:'),
      'raw 优先保留尾部 —— 开头那批噪声行被舍掉(证明确实是尾截而非头截)',
    )

    // 短文本必须原样保留(尾截不能把正常长度也切掉)
    const short = classifyFailure('API Error: 402 Insufficient Balance (request_id: req_short)')
    assert(short.raw === 'API Error: 402 Insufficient Balance (request_id: req_short)', '短文本原样保留,不加省略号')

    // 错误行正好跨切点时,关键串要完整
    const noise2 = Array.from({ length: 59 }, (_, i) => `L${i} `.repeat(7)).join('\n')
    const v2 = classifyFailure(`${noise2}\nAPI Error: 402 Insufficient Balance (request_id: req_EDGE)`)
    assert(
      v2.raw.includes('req_EDGE'),
      `错误行跨 500 字符切点时关键串仍完整(实际尾部 ${JSON.stringify(v2.raw.slice(-50))})`,
    )
  }
}

/**
 * 失败分类的**攻击面固化**(纯函数,零 LLM,所以一条都不许躲进 SKIP)。
 *
 * ## 这一节为什么存在
 *
 * `shared/failure.ts` 的判定表是"看到关键词就判死",所以它天然有两个方向的脆弱面:
 *
 *   - **判据写宽** → 把瞬时错误/无关文本误判成永久失败,本该成功的运行被当场判死
 *     (这是**错判**,比多等几秒严重得多);
 *   - **判据写窄 / 证据被截断** → 真·永久错误没被认出来,白等一轮退避
 *     (这是**漏判**,方向是安全的)。
 *
 * 前一类的风险不会让任何现有断言变红 —— 现有断言测的是"该判的判了",
 * 判据一旦写宽,它们照样全绿,而用户在网络抖动时看着运行被判死。
 * 所以这一节把**攻击输入**搬进来当常驻断言:输入是攻击者视角的,
 * 不是"正常报错长什么样"。
 *
 * 来源:QA 用独立装置(`.tmp/qa-harness/qa-attack.ts`,已 gitignore)打出来的攻击矩阵。
 * 装置不随仓库走,所以这里把**结论**固化成断言 —— 否则下一轮只能从报告里重建。
 *
 * ## ⚠️ 读断言前必读:下面两组断言钉的是「当前行为」,不是「期望行为」
 *
 * 第②组的每一条都是**已知的漏判**。它们变红不代表"修好了",只代表
 * **行为变了,需要有人想清楚**。详见 `docs/known-failure-classification-limits.md`。
 *
 * 千万不要因为看到"这里漏判"就去加激进的判定规则把方向搞反 ——
 * 漏判的代价是多等约 23 秒退避(然后照样报同一个错);
 * 错判的代价是**本该成功的运行被永远判死**,那比现状坏得多。
 */
function failureAttackSurfaceTests(): void {
  /*
   * ---------- ① 守住方向:防"将来有人把判据写宽" ----------
   *
   * 这一组是本节真正的正向价值:每一条拦的都是一个具体的过度判定。
   */
  console.log('\n  --- 1. 判据不许写宽:无关文本里的数字/装饰/外语都不得判死 ---')
  {
    /*
     * `402` 单独出现是有风险的(日志里别处也可能有这个数),所以规则表要求
     * 附近有错误语境词(error/status/code/api/http…)。这条约束**很容易在
     * "提高召回率"的名义下被拆掉** —— 有人会想"日志里 402 后面跟着
     * Insufficient Balance 的情况挺多的,直接见 402 就判吧"。
     *
     * 拆掉之后下面这些全部变成错判。它们的共同形态是:
     * **数字是真的,错误语境是假的**(行号、字节数、耗时、退出码、测试计数)。
     */
    const BARE_NUMBERS: { text: string; label: string }[] = [
      { text: '第 402 行有个笔误', label: '中文行号' },
      { text: '第 401 行有个笔误', label: '中文行号(401,鉴权码那一档)' },
      { text: 'wrote 402 bytes to disk', label: '字节数' },
      { text: 'processed 402 items', label: '处理条数' },
      { text: 'HTTP 200 OK, took 402ms', label: '耗时(前面还带着个 200)' },
      { text: 'at offset 402', label: '偏移量' },
      { text: 'line 402:', label: '英文行号' },
      { text: 'chunk 401 of 402', label: '分片计数(401/402 都在)' },
      { text: 'pid 402 exited', label: '进程号' },
      { text: '耗时 402 毫秒', label: '中文耗时' },
      { text: '余额 402 元', label: '中文语境里的"余额"+数字(看着像,实则不是报错)' },
      { text: '温度 402 度', label: '中文语境里的无关量词' },
      { text: 'retry 3/402', label: '重试计数' },
    ]
    for (const c of BARE_NUMBERS) {
      const v = classifyFailure(c.text)
      assert(
        v.retryable !== false,
        `${c.label}里的 402 不被当成状态码 → 保持可重试(实际 kind=${v.kind})`,
      )
    }

    /*
     * 装饰符号(emoji)落在错误语境词与 402 **之间**。
     * `❌ 402 付款失败` 读起来完全像一条报错,但规则要求 `error|status|code|api|http`
     * 出现在 402 的 16 个非单词字符以内 —— emoji 不属于这些词,所以不命中。
     *
     * ⚠️ 这是**依赖具体字符类**的巧合,不是设计出来的语义判断。
     * 固化它是为了:有人若把规则改成"402 前面 16 个字符内有任何非字母就算语境",
     * 这条会立刻变红 —— 那时候必须回头看是不是把 emoji/中文量词也算成了语境。
     */
    for (const t of ['❌ 402 付款失败', '✅ 402 tests passed', '⚠️ 402 warnings', '🎉 error at line 401']) {
      const v = classifyFailure(t)
      assert(
        v.retryable !== false,
        `emoji/装饰前缀不构成错误语境:${JSON.stringify(t)} 保持可重试(实际 kind=${v.kind})`,
      )
    }

    /*
     * 词表只有中文,没有日文。`モデルが存在しません`(模型不存在)语义上完全等价于
     * `模型不存在`,但判不出来 → 漏判(安全方向:多退避一轮,不会错杀)。
     *
     * 固化它的意义是**记录词表的语言边界**:将来有人扩词表(加日文/韩文/俄文)
     * 会看到这条变红,那是好事;而如果有人为了"多语言支持"把匹配改成**按语种
     * 模糊匹配**,这条会静默变成别的样子 —— 那是需要重新评估的事。
     */
    const vJp = classifyFailure('モデルが存在しません')
    assert(
      vJp.retryable !== false,
      `词表只覆盖中文,日文"模型不存在"判不出来 → 漏判方向安全(实际 kind=${vJp.kind})`,
    )

    // 反过来:词表里有的中文必须命中(证明上一条不是"中文整体不认")
    assert(
      classifyFailure('模型名无效').kind === 'model',
      '中文词表本身有效("模型名无效" 判 model)—— 与上一条对照,漏的只是语种',
    )
    assert(
      classifyFailure('模型不存在').kind === 'model',
      '中文"模型不存在"判 model',
    )

    /*
     * 状态码规则要求**附近有错误语境词**,这一组钉住那个语境词确实生效 ——
     * 否则上面那组"数字不是状态码"的保护就可能是在靠"规则根本没生效"蒙对。
     * 两条必须同时成立,才说明判据是"有语境才判"而不是"碰运气"。
     */
    for (const t of ['error 402', 'ERROR: 402', 'status=402', 'status: 402', 'api 402', 'HTTP 402']) {
      assert(
        classifyFailure(t).kind === 'balance',
        `错误语境词 + 402 判 balance:${JSON.stringify(t)}(证明上一组不是靠"规则没生效"蒙对)`,
      )
    }
    /*
     * 语境词的**距离上限是 16 个非单词字符**(`\W{0,16}`),实测卡在 16/17 之间。
     *
     * ⚠️ 顺带钉住一个反直觉的事实:`\W` **会匹配换行**,所以"error"和"402"
     * 隔着 16 个空行仍然判 balance。方向上这偏保守(容易判死),但它同时意味着:
     * 有人若把 `{0,16}` 放宽到 `{0,64}`,下面这条 17 空格的断言会变红,
     * 那正是需要有人停下来想的时刻(日志里 64 字符内出现无关 402 的概率明显上升)。
     */
    assert(
      classifyFailure('error' + ' '.repeat(16) + '402').kind === 'balance',
      '语境词与状态码的间隔上限:16 个非单词字符仍判 balance(`\\W{0,16}` 的上界)',
    )
    assert(
      classifyFailure('error' + ' '.repeat(17) + '402').kind === 'unknown',
      '间隔超过 16 个字符就不再算语境 → 不判死(`\\W{0,16}` 的下界,防止有人把它放宽)',
    )

    /*
     * text 模式的 stdout 正文会被整段送进判定。正文里"error at line 401 of server.js"
     * 是改代码时极常见的一句 —— 它有 `error`、有数字,却**不是** agent 报的错。
     *
     * 上面第 3 节(failureClassificationWiringTests)已经从接线侧钉过同一条,
     * 这里从纯函数侧再钉一次:接线那侧将来若改成不过滤正文,纯函数这条不会变红,
     * 反之亦然 —— 两边都要各自站得住。
     */
    const vBody = classifyFailure('error at line 401 of server.js')
    assert(
      vBody.retryable !== false,
      `text 模式正文里的 "error at line 401" 不算错误证据(实际 kind=${vBody.kind})`,
    )

    /*
     * 空白输入:6 种形态全部回到 unknown/可重试。
     *
     * 这条看着平凡,但它是"表里没有的,一律可重试"这条总则的**最小可观测面** ——
     * 如果哪天有人给规则表加一条 `.+` 之类的兜底(例如"非空即视为错误"),
     * 这里会全线变红。空串那条尤其重要:agent 启动即崩时 stderr 可能完全是空的。
     */
    for (const t of ['', ' ', '\n', '\n\n\n', '\t\t', '   \n   ']) {
      const v = classifyFailure(t)
      assert(
        v.retryable !== false,
        `空白输入 ${JSON.stringify(t)} 回到可重试(实际 kind=${v.kind})`,
      )
    }
    // raw 必须原样带回空白(不能被悄悄 trim 掉 —— 排查时要看到"确实什么都没吐")
    assert(
      classifyFailure('   \n   ').raw === '   \n   ',
      '空白输入的 raw 原样保留(不 trim:排查时要能看出"确实没吐任何东西")',
    )

    /*
     * 词表大小写:规则都带 `/i`,服务商的大小写写法五花八门
     * (`INSUFFICIENT_QUOTA` 全大写是真实存在的形态)。
     *
     * `insufficientquota`(无分隔)也判 quota —— 因为规则写的是 `[\s_-]*`
     * 而不是 `[\s_-]+`,零分隔也算命中。有人若"收紧"成 `+`,
     * 下面这条会变红:那等于把一批真实服务商的报文判成可重试(漏判,安全但丢收益)。
     */
    for (const [t, kind] of [
      ['INSUFFICIENT_QUOTA', 'quota'],
      ['insufficient_quota', 'quota'],
      ['Insufficient_Quota', 'quota'],
      ['INSUFFICIENTQUOTA', 'quota'],
      ['insufficientquota', 'quota'],
      ['Unauthorized', 'auth'],
      ['UNAUTHORIZED', 'auth'],
    ] as [string, FailureKind][]) {
      assert(
        classifyFailure(t).kind === kind,
        `大小写/分隔变体仍命中:${JSON.stringify(t)} → ${kind}(规则带 /i 且分隔是 * 不是 +)`,
      )
    }

    /*
     * 404 / 429 的**二次确认**:状态码本身不作判据,要用响应体再过一遍。
     *
     * 404 绝大多数时候确实是"模型名写错"(配置问题),但 CDN/网关在部署切换期间
     * 也会短暂回 404 —— 直接拿状态码当判据就是赌。429 同理:多数是限流(退避后
     * 大概率就过了),但有的服务拿 429 报配额不足。
     *
     * 这一组是"保守"这个设计决策的**直接体现**,也是最容易被"优化掉"的一组
     * (有人会想"404 就是模型名写错,直接判死省一次重试")。
     */
    assert(
      classifyHttpStatus(404, '').retryable !== false,
      '404 报文为空时保持可重试(CDN/网关切换期间会短暂 404,拿状态码当判据就是赌)',
    )
    assert(
      classifyHttpStatus(404, 'Not Found').retryable !== false,
      '404 + "Not Found"(纯状态短语,不含可归类的特征)仍可重试',
    )
    assert(
      classifyHttpStatus(404, 'model not found').kind === 'model',
      '404 + 响应体写着 "model not found" → 二次确认判 model(那才是配置问题)',
    )
    assert(
      classifyHttpStatus(404, 'The model `x` does not exist').kind === 'model',
      '404 + "does not exist" 报文 → 判 model',
    )
    assert(
      classifyHttpStatus(429, '').retryable !== false,
      '429 纯限流保持可重试(退避之后大概率就过了)',
    )
    assert(
      classifyHttpStatus(429, 'rate limit exceeded').retryable !== false,
      '429 + "rate limit exceeded" 是**限流**不是配额 → 保持可重试(别把这判成 quota)',
    )
    assert(
      classifyHttpStatus(429, 'quota exceeded').kind === 'quota',
      '429 + "quota exceeded" → 判 quota(那不是限流,重试无用)',
    )
    assert(
      classifyHttpStatus(429, 'insufficient_quota').kind === 'quota',
      '429 + "insufficient_quota"(OpenAI 系的真实形态)→ 判 quota',
    )
    // 4xx 里没列出的、5xx、以及 0/999 这类"根本不是状态码"的值:一律可重试
    for (const [s, d] of [
      [400, 'bad request'],
      [400, 'invalid_request_error: model does not exist'],
      [422, 'unauthorized'],
      [500, 'boom'],
      [0, 'unauthorized'],
      [999, 'unauthorized'],
    ] as [number, string][]) {
      assert(
        classifyHttpStatus(s, d).retryable !== false,
        `classifyHttpStatus(${s}, ${JSON.stringify(d)}) 保持可重试(只有 401/402/403 直接判、404/429 需二次确认)`,
      )
    }
  }

  /*
   * ---------- ①' 进程退出码 ≠ HTTP 状态码(已修;这是**期望行为**,红了就是 bug) ----------
   *
   * ## 这条与上一节「已知局限」性质不同,别混为一谈
   *
   * 上一节那三条是**漏判**:真错误没认出来,多等 23 秒,结果最终是对的。
   * 本节这条曾经是**错判**:agent 因别的原因崩了、退出码恰好是 401/402/403,
   * 用户被告知"API 余额不足,请去充值" —— 充值完什么都没变。
   *
   * 按 `failure.ts` 自己声明的原则("宁可漏判,不可错判"),**错判是明令禁止的那一类**。
   * 所以下面每一条钉的都是**期望行为**,变红 = 出了 bug,该修。
   *
   * ## 缺陷根因
   *
   * `(?:http|status|code|error|api)\W{0,16}\b402\b` 里的 `code` 既是
   * HTTP 状态码的语境词(`status code: 402`),又是进程退出码的语境词
   * (`exit code 402`),单看形态区分不了。
   *
   * ## 修法与它的边界
   *
   * 识别到退出码短语时,让短语里的 `code`/`status` 不再算语境词
   * (`maskExitCodeContext`)。**不是**"整条返回 unknown"——
   * 那会连带放过同一段文本里真正的 HTTP 证据。
   */
  console.log('\n  --- 1b. 进程退出码 ≠ HTTP 状态码(错判方向,已修,红了就是 bug)---')
  {
    /*
     * 核心三条:`code` 与 `status` 两个入口都要覆盖。
     *
     * ⚠️ 只修 `code` 是不够的 —— `exit status 402` / `process exited with status 403`
     * 走的是同一个缺陷的另一个入口,漏掉它们等于只补了一半。
     */
    for (const [t, why] of [
      ['exit code 402', 'code 入口'],
      ['Exit code: 401', 'code 入口(大写 E + 冒号)'],
      ['process exited with code 403', 'code 入口(process exited with 形态)'],
      ['exit status 402', 'status 入口(同一个缺陷的第二个入口)'],
      ['process exited with status 403', 'status 入口'],
      ['returned code 402', 'code 入口(returned 形态)'],
    ] as [string, string][]) {
      const v = classifyFailure(t)
      assert(
        v.kind === 'unknown' && v.retryable !== false,
        `进程退出码不当作 HTTP 状态码(${why}):${JSON.stringify(t)} → 保持可重试,不引导用户去充值(实际 kind=${v.kind})`,
      )
    }

    /*
     * 下面这三条是**修法不能太粗暴**的证明,缺一就说明修错了。
     *
     * 特别注意第 2 条:如果实现成"识别到退出码短语就整条返回 unknown",
     * `exit code 1, status=402` 会被放过 —— 那是**把一次错判换成了另一次错判**
     * (这段文本里真的有余额不足,却按可重试处理,于是又白等 23 秒)。
     */
    assert(
      classifyFailure('status code: 402').kind === 'balance',
      '合法语境仍然成立:"status code: 402" 判 balance(别把 code 整体删掉,否则真实 API 报文也检不出来)',
    )
    assert(
      classifyFailure('exit code 1, status=402').kind === 'balance',
      '同一段文本里有退出码也有真 HTTP 证据 → 仍按 status 判 balance(别因为有退出码就整条放过)',
    )
    assert(
      classifyFailure('exit code 1, status=401').kind === 'auth',
      '同上,鉴权侧:exit code 1 + status=401 → 判 auth',
    )
    // 退出码是 1/0 这类常见值时,本来就不该判死(防回归:掩码别误伤这一侧)
    for (const t of ['exit code 0', 'exit code 1', 'exit 1', 'exited with code 1']) {
      assert(
        classifyFailure(t).kind === 'unknown',
        `退出码 ${t} 本来就可重试,掩码后仍可重试(防掩码误伤)`,
      )
    }
    // 真实 API 报文一个字都不能动(掩码只该影响退出码短语内部)
    for (const [t, kind] of [
      ['API Error: 402 Insufficient Balance (request_id: req_01HX)', 'balance'],
      ['HTTP/1.1 401 Unauthorized', 'auth'],
      ['status=429', 'unknown'],
      ['error 402', 'balance'],
      ['code: 429 quota exceeded', 'quota'],
    ] as [string, FailureKind][]) {
      assert(
        classifyFailure(t).kind === kind,
        `掩码未误伤真实报文:${JSON.stringify(t)} → ${kind}`,
      )
    }
    // 状态码路径不受影响:API 直连那条路本来就不看文案,只看拿到的状态码
    assert(
      classifyHttpStatus(402, 'exit code 402').kind === 'balance',
      'classifyHttpStatus 仍以状态码为准(退出码文案不影响 API 直连路的判定)',
    )
  }

  /*
   * ---------- ② 已知局限方向:钉住「当前会漏判」这个事实 ----------
   *
   * ⚠️⚠️ **以下每一条钉的都是当前的漏判,不是期望行为。**
   *
   * 三条局限的共同点:**证据在到达判定函数之前就被截断了**,所以规则表根本没机会看到它。
   * 方向全都是**漏判(安全)** —— 多退避一轮(1+2+4+8+8 ≈ 23 秒),最后仍然报同一个错。
   *
   * **不要因为看到这些断言就去"修"。** 修的方向只能是"再加一条更宽的规则",
   * 那会把方向搞反:误判成不可重试 = 本该成功的运行被当场判死,比现状坏得多。
   * 正确的修法是**把证据留下**(放大 errorTail 的行数 / 改成按字节保留),
   * 而不是让判定更激进。
   *
   * 背景与代价分析见 `docs/known-failure-classification-limits.md`。
   */

  console.log('\n  --- 2. 已知局限:证据在到达判定前就被截断(漏判,方向安全,勿"修")---')
  {
    /*
     * 局限① **环形缓冲头部**:CLI 的输出先进 NodeLogWriter 的 60 行环形缓冲,
     * 而 `classifyFailure` 拿到的是**缓冲之后**的文本。
     * 于是"第 1 行的 402 + 后面 80 行日志"里,证据在进判定之前就被挤出去了。
     *
     * ⚠️ 下面第一条钉的是**漏判**(402 在第 1 行 → unknown/可重试),
     * 第二条钉的是**设计假设成立**(402 在末行 → 判死)。
     * 这一对的用处:任何人改 `errorTail` 的行数(60 → N)时,
     * 两条会**同时**变红,逼他去看 docs 里写的代价,而不是默默改掉。
     *
     * 危害不止"多等 23 秒":它消解的是本轮改动的**核心卖点**(不可重试立刻停)。
     * 用户这轮刚学会"余额不足会立刻停",一旦撞上这条就会怀疑整个分类不可靠。
     */
    const ring = (lines: string[]): string[] => {
      const buf: string[] = []
      for (const l of lines) {
        buf.push(l.trim())
        if (buf.length > 60) buf.splice(0, buf.length - 60)
      }
      return buf
    }
    const noise = (n: number): string[] => Array.from({ length: n }, () => 'verbose log line')

    // 402 在第 1 行 + 60 行噪声 → 证据正好被挤出缓冲 → **漏判**
    {
      const kept = ring(['API Error: 402 Insufficient Balance', ...noise(60)])
      assert(
        kept.length === 60 && !kept.some((l) => l.includes('402')),
        `局限① 前置条件:60 行噪声正好把第 1 行的 402 挤出缓冲(缓冲 ${kept.length} 行,含 402 的行 ${kept.filter((l) => l.includes('402')).length} 条)`,
      )
      const v = classifyFailure(kept.join('\n'))
      assert(
        v.kind === 'unknown' && v.retryable !== false,
        `局限①【当前行为=漏判,勿"修"】证据在第 1 行且被 60 行缓冲挤掉 → 判不出来,按可重试处理(实际 kind=${v.kind})`,
      )
    }
    // 同一形状下,证据在最后一行 → 判死(证明①的方向确实是"证据在不在",不是规则坏了)
    {
      const kept = ring([...noise(80), 'API Error: 402 Insufficient Balance'])
      assert(
        classifyFailure(kept.join('\n')).kind === 'balance',
        '局限① 的对照:同样 80 行日志,但 402 在末行 → 判 balance(错误几乎总在最后,这是设计假设)',
      )
    }
    // 边界:59 行噪声时证据还在(第 1 行)→ 判死。改行数时这条与上面那条一起变红。
    {
      const kept = ring(['API Error: 402 Insufficient Balance', ...noise(59)])
      assert(
        kept.length === 60 && kept[0]?.includes('402'),
        `局限① 边界前置条件:59 行噪声时第 1 行仍在缓冲内(缓冲 ${kept.length} 行)`,
      )
      assert(
        classifyFailure(kept.join('\n')).kind === 'balance',
        '局限① 边界:59 行噪声(证据刚好保住)→ 判 balance。与上面"60 行→漏判"构成一对,改 errorTail 行数必看',
      )
    }
    // 另一类证据被挤掉也一样漏判(证明这不是 402 专属)
    assert(
      classifyFailure(ring(['[claude-code:unrecognized_model] {"model":"x"}', ...noise(80)]).join('\n'))
        .kind === 'unknown',
      '局限① 的另一形状:unrecognized_model 在第 1 行被挤掉 → 同样漏判(不是 402 专属)',
    )

    /*
     * 局限② **混合文本**:规则表是**顺序遍历、命中即判**。
     * 一段 stderr 里既有旧的 402 日志、末尾才是真因(网络断了)时,整段会被判死。
     *
     * ⚠️ 钉的是"**两种顺序都判 balance**"这个当前行为。
     * 有人若按直觉去实现"以末尾为准",这两条会变红 —— 那时候要意识到:
     * 末尾优先是**更激进**的方向(更容易判死),与本模块的保守原则相悖。
     *
     * 方向说明:真出现这种文本时,判死**不算错判**(确实有 402 证据在场),
     * 代价只是"多停了一次本可成功的运行"。
     */
    const BAL_HEAD = 'API Error: 402 Insufficient Balance'
    const NET_TAIL = 'Error: connect ETIMEDOUT 10.0.0.5:443'
    for (const [t, label] of [
      [`${BAL_HEAD}\n${NET_TAIL}`, '402 在前、瞬时在后'],
      [`${NET_TAIL}\n${BAL_HEAD}`, '瞬时在前、402 在后(真因)'],
    ] as [string, string][]) {
      const v = classifyFailure(t)
      assert(
        v.kind === 'balance' && v.retryable === false,
        `局限②【当前行为,勿改成"末尾优先"】${label} → 两种顺序都判 balance(规则表顺序遍历、命中即判)`,
      )
    }
    // 对照:只有瞬时证据(没有 402)时必须可重试 —— 否则上面那两条就没意义了
    assert(
      classifyFailure(NET_TAIL).kind === 'unknown',
      '局限② 的对照:只有瞬时证据时不判死(证明上一条的判死来自 402 证据本身,不是"文本够长就判死")',
    )

    /*
     * 局限③ **INPUT_MAX 之后的证据**:判定输入被 `slice(0, 4000)`,
     * 所以单行超长(比如整个堆栈压成一行)时,4000 字符之后的证据在判定阶段就已丢失。
     *
     * ⚠️ 钉的是漏判。修法同样**不是**放宽规则,而是保留更多输入
     * (或改成先抽尾部再判定)。
     */
    {
      const EV = ' API Error: 402 Insufficient Balance'
      const t = 'A'.repeat(4254) + EV
      assert(
        t.length > 4000 && t.indexOf('402') > 4000,
        `局限③ 前置条件:超长单行 ${t.length} 字符,402 在下标 ${t.indexOf('402')}(> INPUT_MAX=4000)`,
      )
      const v = classifyFailure(t)
      assert(
        v.kind === 'unknown' && v.retryable !== false,
        `局限③【当前行为=漏判,勿"修"】证据落在 INPUT_MAX 之后 → 判不出来,按可重试处理(实际 kind=${v.kind})`,
      )
    }
    // 对照:同样内容但整体落在 4000 字符内 → 判死(证明漏判的原因确实是 INPUT_MAX)
    {
      const EV = ' API Error: 402 Insufficient Balance'
      const t = 'A'.repeat(3964) + EV
      assert(
        t.length === 4000,
        `局限③ 的对照前置条件:同样的证据,总长 ${t.length} 字符(正好 ≤ INPUT_MAX)`,
      )
      assert(
        classifyFailure(t).kind === 'balance',
        '局限③ 的对照:证据落在 INPUT_MAX 之内 → 判 balance(漏判的原因确实是那 4000 字符的截断)',
      )
    }
  }
}

/**
 * 真实 agent 跑一遍两节点链路。
 *
 * 上面那组用假 env,覆盖的是**调度算法**;这一组覆盖的是**接线** ——
 * hub.metaOf → 真日志 → extractOutput → 模板渲染 → 下一个节点 spawn。
 * 这几段里任何一处接错,假 env 都是发现不了的(它把 logsAfter 换成了常量)。
 *
 * 用一个**独立**的 manager + hub:上面那个 mgr 的回调只打日志、不写盘,
 * 而这条链路要的正是"日志真的落到了 hub 里再被读出来"。
 */
async function workflowRealTests(): Promise<void> {
  const CANVAS = 'e2e-wf-live'
  const A = 'wf-a'
  const B = 'wf-b'
  await fs.rm(canvasRoot(CANVAS), { recursive: true, force: true })

  const hub = new NodeLogHub({
    log: () => {},
    progress: () => {},
    exit: () => {},
  })
  const wfMgr = new SessionManager({
    events: (id, evs) => hub.appendEvents(id, evs),
    exit: (id, s, c) => hub.appendExit(id, s, c),
    sessionId: () => {},
    log: () => {},
  })

  const runner = new WorkflowRunner(
    makeRunnerEnv({ manager: wfMgr, hub, emit: () => {} }),
  )

  // 只在 A→B 传得过去时才可能出现在 B 的产出里的暗号
  const SECRET = '蓝色鲸鱼'

  try {
    const state = await runner.run(
      specOf(
        [
          nodeSpec(A, '{{input}}'),
          nodeSpec(B, '上游节点给了你一段文字。请只回复那四个字,不要有任何其它内容。\n上游内容:\n{{prev}}'),
        ],
        [[A, B]],
        {
          input: `只回复这四个字,不要有任何其它内容:${SECRET}`,
          maxParallel: 1,
          // specOf 默认写的是 workFlow 那个画布;这里必须换成局部这个,
          // 否则日志落在别的目录,后面按 CANVAS 读就是空的
          canvasId: CANVAS,
        },
      ),
    )

    // 状态与产出取决于模型/API —— LLM 欠费时这五条只会一直红,改记 SKIP
    llmAssert(state.status === 'done', `真实链路整体完成(实际 ${state.status})`)
    llmAssert(state.nodes[A]?.status === 'done', `A 成功(实际 ${state.nodes[A]?.status})`)
    llmAssert(state.nodes[B]?.status === 'done', `B 成功(实际 ${state.nodes[B]?.status})`)

    // 从**磁盘上的日志**里读 B 的产出 —— 与调度器用的是同一条读取路径
    const recsB = await hub.logsAfter(CANVAS, B, 0, 500)
    const outB = extractOutput(recsB).text
    console.log(`  B 的产出: ${JSON.stringify(outB.slice(0, 120))}`)
    llmAssert(
      outB.includes(SECRET),
      `❗上游产出真的跨节点传过去了 —— B 说出了只有 A 才知道的暗号`,
    )

    // A 那一轮的用户消息必须也落了盘(走的是与点「发送」同一个入口)
    const recsA = await hub.logsAfter(CANVAS, A, 0, 500)
    const firstA = recsA[0]
    assert(
      firstA?.t === 'user' && firstA.text.includes('只回复这四个字'),
      '调度器启动节点时,用户消息与手动发送走同一条路径写进了日志',
    )
    llmAssert(
      hub !== null && (await hub.metaOf(CANVAS, B)).sessionId !== null,
      'B 的 sessionId 落了盘(下一次运行才接得上同一个会话)',
    )
  } finally {
    wfMgr.killAll()
    await fs.rm(canvasRoot(CANVAS), { recursive: true, force: true })
  }
}

/**
 * 技能库:解析 / 装入 / 启停 / 删除 / 路径穿越防线。
 *
 * 这一段**不碰网络、不起 agent** —— 技能库的所有逻辑都是纯 fs 操作,
 * 所以可以完整地在这里测干净。真 claude 能不能看见技能是另一回事,
 * 由 step 0 的一次性实测(带 --plugin-dir 与不带的正反对照)负责,
 * 不适合放进每次都跑的 e2e(那要花一次真实的 API 调用)。
 */
async function skillsTests(): Promise<void> {
  const NAME = 'e2e-skill-probe'
  // 源目录放在 D 盘本仓库的工作区内 —— 不落 C 盘,而且是已知可清理的位置
  const SRC = path.join(canvasRoot(WF_CANVAS), '_skillsrc')

  const cleanup = async (): Promise<void> => {
    for (const enabled of [true, false]) {
      await fs.rm(skillDir(NAME, enabled), { recursive: true, force: true })
    }
    await fs.rm(SRC, { recursive: true, force: true })
    await forgetOrigin(NAME)
  }

  await cleanup()
  ensureSkillsDirs()

  try {
    // ---------- ① 解析:纯函数 ----------
    {
      const md = [
        '---',
        'name: pdf-tools',
        'description: Use when: the user wants PDFs',
        'version: 1.2.0',
        'user-invocable: true',
        'license: Apache 2.0',
        '---',
        '',
        '# PDF',
        '正文第一段,当 description 缺省时用它。',
      ].join('\n')
      const p = parseSkillMd(md, 'wrong-dir-name')

      assert(p.name === 'pdf-tools', `以 frontmatter 的 name 为准(实际 ${p.name})`)
      assert(p.declaredName === 'pdf-tools', '记下了声明的名字')
      // 值里的冒号必须保住 —— 只按第一个冒号切
      assert(
        p.description === 'Use when: the user wants PDFs',
        `description 里的冒号没被切掉(实际 ${JSON.stringify(p.description)})`,
      )
      assert(p.hasDescription, '认得 frontmatter 里的 description')
      // 多余的键(version/license/…)不能让它判成格式错误
      assert(p.nameProblem === null, '容忍规范之外的 frontmatter 键')
    }

    {
      // 省略 name = 取目录名,是规范允许的,不是问题
      const p = parseSkillMd('---\ndescription: 说明\n---\n', 'my-skill')
      assert(p.name === 'my-skill', '省略 name 时用目录名兜底')
      assert(p.declaredName === null, '没声明就记 null')
      assert(p.nameProblem === null, '省略 name 不算命名问题(规范允许)')
    }

    {
      // 没有 frontmatter 块:description 取正文首个非标题段落
      const p = parseSkillMd('# 标题\n\n这是第一段。\n\n第二段。', 'plain')
      assert(p.name === 'plain', '没有 frontmatter 也能解析')
      assert(!p.hasDescription, '没有 frontmatter 就没有 description')
      assert(p.fallbackDescription === '这是第一段。', `正文首段兜底(实际 ${p.fallbackDescription})`)
    }

    {
      // BOM:Windows 上从别处拷来的文件常带
      const p = parseSkillMd('\ufeff---\nname: bommed\n---\n', 'x')
      assert(p.name === 'bommed', 'BOM 被剥掉,frontmatter 照样认得出来')
    }

    {
      // 规范:小写字母数字 + 单连字符;保留词不许用
      assert(validateSkillName('good-name-1') === null, '合法名字放行')
      assert(validateSkillName('Bad Name') !== null, '大写和空格被拒')
      assert(validateSkillName('-leading') !== null, '连字符开头被拒')
      assert(validateSkillName('a--b') !== null, '连续连字符被拒')
      assert(validateSkillName('my-claude-thing') !== null, '保留词被拒')
      assert(validateSkillName('x'.repeat(65)) !== null, '超长被拒')
    }

    // ---------- ② 装入:从本地文件夹 ----------
    {
      await fs.mkdir(path.join(SRC, 'whatever-the-folder-is-called'), { recursive: true })
      const srcSkill = path.join(SRC, 'whatever-the-folder-is-called')
      await fs.writeFile(
        path.join(srcSkill, 'SKILL.md'),
        '---\nname: ' + NAME + '\ndescription: 端到端探针\n---\n\n正文\n',
        'utf8',
      )
      // 附属文件也要跟着搬 —— 只搬 SKILL.md 会得到一个跑不起来的技能
      await fs.mkdir(path.join(srcSkill, 'references'), { recursive: true })
      await fs.writeFile(path.join(srcSkill, 'references', 'a.txt'), 'x', 'utf8')

      const { name } = await installSkillDir(srcSkill, { kind: 'local', path: srcSkill, at: 1 })
      // 目录名和 frontmatter 不一致时,按**声明名**落盘
      assert(name === NAME, `按声明名落盘,不是源目录名(实际 ${name})`)
      assert(
        existsSync(path.join(skillDir(NAME, true), 'SKILL.md')),
        'SKILL.md 到位',
      )
      assert(
        existsSync(path.join(skillDir(NAME, true), 'references', 'a.txt')),
        '附属文件一起搬进来了(references/ 少一个文件技能就可能跑不起来)',
      )
      // plugin 清单必须存在 —— 缺了它 --plugin-dir 什么都不加载,
      // 而界面上技能明明列得出来("列得出来但不生效"最难查)
      assert(existsSync(SKILLS_PLUGIN_FILE), 'plugin.json 被自动补齐')
    }

    // ---------- ③ 重复装入必须被拒 ----------
    {
      let msg = ''
      try {
        await installSkillDir(path.join(SRC, 'whatever-the-folder-is-called'), { kind: 'manual' })
      } catch (e) {
        msg = (e as Error).message
      }
      assert(msg.includes('已经有一个'), `同名技能拒绝覆盖,而不是静默毁掉(实际:${msg})`)
    }

    // ---------- ④ 列表 ----------
    {
      const list = await listSkills()
      const me = list.find((s) => s.name === NAME)
      assert(!!me, '装好的技能出现在列表里')
      assert(me?.enabled === true, '默认是启用状态')
      assert(me?.description === '端到端探针', '读出了 description')
      assert(me?.descriptionFromBody === false, 'description 来自 frontmatter,不是正文兜底')
      assert(me?.invokeAs === `haowan-skills:${NAME}`, `调用名带命名空间(实际 ${me?.invokeAs})`)
      assert((me?.fileCount ?? 0) >= 2, `统计到了文件数(实际 ${me?.fileCount})`)
      assert(me?.origin?.kind === 'local', '来源记录下来了')
    }

    // ---------- ⑤ 停用 = 移出 plugin 目录 ----------
    {
      await setSkillEnabled(NAME, false)
      assert(!existsSync(skillDir(NAME, true)), '停用后目录不在启用区了')
      assert(existsSync(skillDir(NAME, false)), '停用后目录在停用区')

      const me = (await listSkills()).find((s) => s.name === NAME)
      assert(me?.enabled === false, '列表如实反映停用')
      // 停用 = 模型看不见它。给个调用名会让人以为能用
      assert(me?.invokeAs === '', '停用的技能不给调用名')

      await setSkillEnabled(NAME, true)
      assert(existsSync(skillDir(NAME, true)), '能再启用回来')
    }

    // ---------- ⑥ 路径穿越防线 ----------
    {
      /*
       * 这是这个模块里最需要守住的一条:deleteSkill 会对
       * `<用户给的名字>` 拼出来的路径做 recursive rm。
       * 少了名字校验,`../../..` 就是一次任意目录删除。
       */
      for (const evil of ['../../evil', '..', 'C:\\Windows', 'a/b', '']) {
        let thrown = false
        try {
          await deleteSkill(evil)
        } catch {
          thrown = true
        }
        assert(thrown, `拒绝删除可疑名字 ${JSON.stringify(evil)}`)
      }
      assert(existsSync(skillDir(NAME, true)), '上面几次拒绝没有误伤真技能')
    }

    // ---------- ⑦ 一个文件夹里多个技能:让用户挑,别替他选 ----------
    {
      const multi = path.join(SRC, 'multi')
      for (const n of ['one-skill', 'two-skill']) {
        await fs.mkdir(path.join(multi, n), { recursive: true })
        await fs.writeFile(path.join(multi, n, 'SKILL.md'), `---\nname: ${n}\n---\n`, 'utf8')
      }
      let msg = ''
      try {
        await installSkillDir(multi, { kind: 'manual' })
      } catch (e) {
        msg = (e as Error).message
      }
      assert(msg.includes('2 个技能'), `多技能仓库要求点名(实际:${msg})`)
      assert(msg.includes('one-skill') && msg.includes('two-skill'), '把候选名字都列了出来')
    }

    // ---------- ⑧ 删除 ----------
    {
      await deleteSkill(NAME)
      assert(!existsSync(skillDir(NAME, true)), '删除后启用区没有残留')
      assert(!existsSync(skillDir(NAME, false)), '删除后停用区也没有残留')
      assert(!(await listSkills()).some((s) => s.name === NAME), '列表里不再出现')
    }
  } finally {
    await cleanup()
  }
}

/* ==================== 18. 合成适配器:共用管道,不需要任何真 CLI ==================== */

/**
 * 合成 CLI 的内联脚本(由 node.exe 执行)。
 *
 * 用它而不是真 CLI,是因为四个目标 agent(Codex / Qwen / CodeBuddy / Gemini)
 * **本机一台都没装**。共用管道(ndjson 分帧、事件归一化、sessionId 提取、
 * 续轮 argv、退出码判定、超时/取消)如果只能在装了真 CLI 的机器上才测得到,
 * 那等于没测。这里用 node.exe 冒充一个行为完全已知的 CLI,把每条性质钉死。
 */
const SYNTH_SCRIPT = `
const CFG = __CFG__;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('error', () => {});
process.stdin.on('end', () => {
  const sid = CFG.first ? ('synth-' + process.pid) : CFG.sid;
  out({ t: 'sid', id: sid });
  out({ t: 'tick', label: '干活中' });
  if (CFG.mode === 'err') {
    out({ t: 'text', text: '出错了' });
    out({ t: 'result', text: '失败', error: true });
    process.exit(0);
  }
  if (CFG.mode === 'sleep') {
    out({ t: 'text', text: '开始长任务' });
    setTimeout(() => {}, 120000);
    return;
  }
  const argvPrompt = process.argv[1] || '';
  out({ t: 'text', text: 'STDIN=' + input + '|ARGV=' + argvPrompt });
  out({ t: 'result', text: 'SID=' + sid, error: false });
  process.exit(CFG.code || 0);
});
`

/**
 * 造一个合成适配器。
 *
 * ⚠️ 关键设计:id 只能从 CLI **自己吐出来的行**里拿到(没有 Claude 形状的 init,
 * capabilities.specifySessionId 也是 false),所以它走的正是"发现型 sessionId"那条路 ——
 * A1 修的 `hub.setSessionId` 在这里才第一次被真正走到。
 */
function synthAdapter(
  id: string,
  cfg: { mode?: 'ok' | 'err' | 'sleep'; code?: number; delivery?: 'stdin' | 'argv' },
): AgentAdapter {
  const delivery = cfg.delivery ?? 'stdin'
  return {
    id,
    displayName: `合成 CLI (${id})`,
    promptDelivery: delivery,
    lineMode: 'json',

    capabilities: {
      headless: true,
      streamJson: true,
      resume: true,
      // id 由 CLI 自己生成 —— 这正是"发现型"的定义
      specifySessionId: false,
      tools: false,
      fork: false,
    },

    // node.exe 一定存在,所以这个"CLI"永远探测得到。这正是 A2 成立的前提
    async detect() {
      return { exe: process.execPath, version: process.version, source: 'e2e 合成', tried: [] }
    },

    buildArgs(opts, prompt) {
      const script = SYNTH_SCRIPT.replace(
        '__CFG__',
        JSON.stringify({
          first: opts.isFirstTurn,
          sid: opts.sessionId,
          mode: cfg.mode ?? 'ok',
          code: cfg.code ?? 0,
        }),
      )
      const args = ['-e', script]
      // 首轮 / 续轮的分支形状与真实 CLI 一致,这样 resume 那条路是真被走到了
      if (opts.isFirstTurn) args.push('--new-session')
      else args.push('--resume', opts.sessionId)
      if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode)
      // argv 投递:prompt 作为**独立的一个 argv 元素**追加,不拼进命令字符串
      if (delivery === 'argv' && prompt) args.push(prompt)
      return args
    },

    parseEvent(obj) {
      const o = obj as { t?: string; text?: string; label?: string; error?: boolean }
      const ts = Date.now()
      if (o.t === 'text') return [{ k: 'text', ts, text: o.text ?? '' }]
      if (o.t === 'tick') return [{ k: 'progress', ts, label: o.label ?? '' }]
      if (o.t === 'result') {
        return [
          {
            k: 'result',
            ts,
            text: o.text ?? null,
            sessionId: null,
            costUsd: null,
            durationMs: null,
            isError: !!o.error,
          },
        ]
      }
      // 'sid' 行刻意**不产生任何事件** —— 发现型 id 就是这个形状:
      // 光看事件流看不出 id 在哪,只能靠 extractSessionId 那条回调
      return []
    },

    extractSessionId(obj) {
      const o = obj as { t?: string; id?: string }
      return o.t === 'sid' && typeof o.id === 'string' ? o.id : null
    },

    sanitizeEnv(env, nodeId) {
      return { ...env, HAOWAN_SYNTH: '1', ...(nodeId ? { HAOWAN_NODE_ID: nodeId } : {}) }
    },
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 共用管道的端到端验证,**全程不碰任何真实 CLI**。
 *
 * 覆盖:发现型 sessionId / 续轮 resume / prompt 投递模式 / 权限映射 /
 * 退出码映射 / 超时 / 取消。这些性质过去只靠 claude 那条路间接覆盖,
 * 换 agent 时一旦漂了就没人发现。
 */
async function synthTests(): Promise<void> {
  const SCANVAS = 'e2e-synth'
  const AGENT = 'e2e-synth'
  const AGENT_ARGV = 'e2e-synth-argv'
  const AGENT_EXIT3 = 'e2e-synth-exit3'
  const AGENT_ERR = 'e2e-synth-err'
  const AGENT_SLEEP = 'e2e-synth-sleep'

  registerAdapter(synthAdapter(AGENT, {}))
  registerAdapter(synthAdapter(AGENT_ARGV, { delivery: 'argv' }))
  registerAdapter(synthAdapter(AGENT_EXIT3, { code: 3 }))
  registerAdapter(synthAdapter(AGENT_ERR, { mode: 'err' }))
  registerAdapter(synthAdapter(AGENT_SLEEP, { mode: 'sleep' }))

  await fs.rm(canvasRoot(SCANVAS), { recursive: true, force: true })
  // SessionManager 不做 cwd 校验,但 spawn 会 —— 目录必须真实存在
  await fs.mkdir(CWD, { recursive: true })

  const events: NodeEvent[] = []
  const progresses: string[] = []
  const notices: string[] = []
  const hub = new NodeLogHub({
    log: (_n, _c, recs) => {
      for (const r of recs) {
        if (r.t === 'event') events.push(r.ev)
        else if (r.t === 'notice') notices.push(r.text)
      }
    },
    progress: (_n, ev) => progresses.push(ev.label),
    exit: () => {},
  })
  const smgr = new SessionManager({
    events: (n, evs) => hub.appendEvents(n, evs),
    exit: (n, s, c) => hub.appendExit(n, s, c),
    sessionId: (n, sid) => hub.setSessionId(n, sid),
    log: () => {},
  })

  const start = (nodeId: string, agentId: string, prompt: string, extra: Record<string, unknown> = {}) =>
    startSession(hub, smgr, {
      nodeId,
      canvasId: SCANVAS,
      cwd: CWD,
      agentId,
      prompt,
      ...extra,
    } as StartRequest)

  // ---------- ① 首轮:发现型 id + stdin 投递 + 事件归一化 + progress 隔离 ----------
  events.length = 0
  progresses.length = 0

  const r1 = await start('synth-1', AGENT, '你好世界')
  assert(r1.isFirstTurn, '合成 CLI 首轮走 --new-session')
  assert(!r1.args.includes('--resume'), '首轮不带 --resume')

  const o1 = await smgr.waitFor('synth-1')
  assert(o1.status === 'done', `干净退出判为 done(实际 ${o1.status})`)

  assert(
    events.some((e) => e.k === 'text' && e.text.includes('STDIN=你好世界')),
    'prompt 确实通过 stdin 送到了子进程',
  )
  assert(
    events.some((e) => e.k === 'result' && e.text?.startsWith('SID=')),
    'result 事件被归一化出来了',
  )
  assert(progresses.length === 1, `progress 走了独立通道(实际 ${progresses.length} 条)`)

  const st1 = await hub.readStateOf(SCANVAS, 'synth-1', 200)
  const sid1 = st1.meta?.sessionId ?? ''
  assert(sid1.startsWith('synth-'), `发现型 id 通过权威回调落到了 meta(实际 ${sid1})`)
  assert(
    !st1.recs.some((r) => r.t === 'event' && r.ev.k === 'progress'),
    'progress 不落盘(每轮几十条,写盘没有意义)',
  )

  // ---------- ② 续轮:--resume 带上 id,CLI 回传的还是同一个 ----------
  events.length = 0
  const r2 = await start('synth-2', AGENT, '第二句', { sessionId: sid1 })
  assert(!r2.isFirstTurn, '带 sessionId → 非首轮')
  assert(r2.args.includes('--resume') && r2.args.includes(sid1), '续轮走 --resume 并带上那个 id')

  const o2 = await smgr.waitFor('synth-2')
  assert(o2.status === 'done', `续轮正常结束(实际 ${o2.status})`)

  const st2 = await hub.readStateOf(SCANVAS, 'synth-2', 200)
  assert(st2.meta?.sessionId === sid1, `续轮回传的仍是同一个 id(实际 ${st2.meta?.sessionId})`)
  assert(
    events.some((e) => e.k === 'result' && e.text === `SID=${sid1}`),
    'CLI 收到的确实是它被要求恢复的那个会话',
  )

  // ---------- ③ argv 投递:prompt 走参数,stdin 必须是空的 ----------
  events.length = 0
  const r3 = await start('synth-3', AGENT_ARGV, '走参数的那句')
  assert(r3.args.includes('走参数的那句'), 'argv 投递:prompt 在参数里')

  await smgr.waitFor('synth-3')
  const echo3 = events.find((e) => e.k === 'text' && e.text?.startsWith('STDIN='))
  const echo3Text = echo3?.k === 'text' ? echo3.text : undefined
  assert(
    echo3Text === 'STDIN=|ARGV=走参数的那句',
    `argv 模式下 prompt 不会**再**写一遍 stdin(实际 ${echo3Text})`,
  )

  // ---------- ④ 权限映射 ----------
  const r4 = await start('synth-4', AGENT, 'x', { permissionMode: 'plan' })
  assert(
    r4.args.includes('--permission-mode') && r4.args.includes('plan'),
    '权限模式按请求透传',
  )
  assert(
    !r4.args.includes('--permission-prompts'),
    'claude 专属开关不会被塞进通用适配器',
  )
  await smgr.waitFor('synth-4')

  // ---------- ⑤ 退出码映射 ----------
  await start('synth-5a', AGENT_EXIT3, 'x')
  const o5a = await smgr.waitFor('synth-5a')
  assert(o5a.status === 'error' && o5a.code === 3, `非零退出码判为 error(实际 ${o5a.status}/${o5a.code})`)

  await start('synth-5b', AGENT_ERR, 'x')
  const o5b = await smgr.waitFor('synth-5b')
  assert(o5b.status === 'error', `退出码 0 但带 error 事件,同样判为 error(实际 ${o5b.status})`)

  // ---------- ⑥ 超时 ----------
  await start('synth-6', AGENT_SLEEP, 'x', { timeoutMs: 700 })
  const o6 = await smgr.waitFor('synth-6')
  assert(o6.status === 'timeout', `超时被如实判定(实际 ${o6.status})`)

  // ---------- ⑦ 取消 ----------
  await start('synth-7', AGENT_SLEEP, 'x')
  await sleep(400) // 等它真的起来,否则 cancel 会落在"还没进 live 表"的窗口里
  assert(smgr.cancel('synth-7'), '取消请求被受理')
  const o7 = await smgr.waitFor('synth-7')
  assert(o7.status === 'killed', `取消被如实判定(实际 ${o7.status})`)
  assert(smgr.runningNodeIds().length === 0, '取消后没有残留活跃进程')

  smgr.killAll()
  await fs.rm(canvasRoot(SCANVAS), { recursive: true, force: true })
}

/**
 * nodes-v2 · T01:数据契约 —— 迁移幂等 / resolveProjectDir / validateGraph / specFromGraph。
 *
 * 全是纯函数,不 spawn 任何东西。这一层是整个增量的"真相源":
 * 渲染端与主进程共用同一份实现,这里测的就是两边都将执行的那份代码。
 */
async function nodesV2ContractTests(): Promise<void> {
  // ---------- ① migrateGraph:v1 → 当前代(version:3),幂等 ----------
  {
    const v1 = {
      version: 1,
      name: '旧画布',
      projectDir: 'D:\\proj\\old',
      nodes: [
        { id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { title: 'A', agentId: 'claude', cwd: '' } },
        { id: 'b', type: 'agent', position: { x: 1, y: 1 }, data: { title: 'B' } },
      ],
      edges: [{ id: 'e-a-b', source: 'a', target: 'b' }],
      viewport: { x: 0, y: 0, zoom: 1 },
    }
    const m1: CanvasGraph = migrateGraph(v1)
    assert(m1.version === 3, `迁移后 version 是 3(实际 ${m1.version})`)
    assert(
      m1.nodes.every((n) => n.type === 'feature' && n.data.kind === 'feature' && n.data.mode === 'serial'),
      '每个旧 agent 节点都变成 feature/serial(语义零变化)',
    )
    assert(m1.nodes[0]?.data.title === 'A', '节点配置字段一个不丢')
    assert(m1.edges.length === 1 && m1.edges[0]?.source === 'a' && m1.edges[0]?.target === 'b', '连线原样保留')

    // 幂等性**不依赖 version 号**:再迁一次结果必须不变(主进程迁完渲染进程又迁)
    const m2 = migrateGraph(m1)
    assert(JSON.stringify(m2) === JSON.stringify(m1), '再迁一次结果不变(幂等)')

    // 手改的坏输入也不能炸:null / 缺字段 / 节点缺 position
    const m3 = migrateGraph(null)
    assert(m3.version === 3 && m3.nodes.length === 0, 'null 输入降级为空当前代画布,不抛')
    const m4 = migrateGraph({ nodes: [{ id: 'x', type: 'agent' }] })
    assert(m4.nodes.length === 1 && m4.nodes[0]?.type === 'feature' && !!m4.nodes[0]?.position, '缺 position 的节点被兜底,不抛')
  }

  // ---------- ② resolveProjectDir:三态 ----------
  {
    const proj = { data: { kind: 'project' as NodeKind, projectDir: 'D:\\proj\\a' } }
    const r1 = resolveProjectDir([proj], 'D:\\legacy')
    assert(r1.dir === 'D:\\proj\\a' && r1.source === 'node', `有项目节点 → 以节点为准(实际 ${JSON.stringify(r1)})`)

    const r2 = resolveProjectDir([{ data: { kind: 'feature' as NodeKind } }], 'D:\\legacy')
    assert(r2.dir === 'D:\\legacy' && r2.source === 'canvas', `无项目节点 → 画布级兜底(实际 ${JSON.stringify(r2)})`)

    const r3 = resolveProjectDir([], undefined)
    assert(r3.dir === '' && r3.source === 'none', `都没有 → none(实际 ${JSON.stringify(r3)})`)

    // 项目节点存在但没填目录 → 不能算 node 来源(空串是"没说过",不是"选了个空")
    const r4 = resolveProjectDir([{ data: { kind: 'project' as NodeKind, projectDir: '  ' } }], 'D:\\legacy')
    assert(r4.source === 'canvas', 'project 节点目录为空白时回落画布级,而不是返回空串的 node')

    // 节点 data 缺失的防御:resolveProjectDir 只读 data?.kind/projectDir
    const r5 = resolveProjectDir([{} as never], undefined)
    assert(r5.source === 'none', 'data 缺失的节点不会让它抛')
  }

  // ---------- ③ validateGraph:V1..V8 全 warn ----------
  {
    const n = (id: string, kind: NodeKind, extra: Record<string, unknown> = {}): { id: string; data: Record<string, unknown> } => ({
      id,
      data: { title: id, kind, ...extra },
    })
    const msgs = (issues: GraphIssue[]): string => issues.map((i) => i.message).join('|')
    const warnIds = (issues: GraphIssue[]): string[] => issues.filter((i) => i.nodeId).map((i) => i.nodeId as string)

    // V1:没有项目节点
    let issues = validateGraph({ nodes: [n('f', 'feature')], edges: [], projectDir: 'D:\\legacy' })
    assert(issues.every((i) => i.level === 'warn'), 'V1..V8 全部是 warn 级(不阻断)')
    assert(msgs(issues).includes('项目节点'), `V1:没有项目节点时提示(实际 ${msgs(issues)})`)

    // V2:多个项目节点(挂在第二个上)
    issues = validateGraph({ nodes: [n('p1', 'project', { projectDir: 'a' }), n('p2', 'project', { projectDir: 'b' })], edges: [], projectDir: '' })
    assert(warnIds(issues).includes('p2'), 'V2:多项目节点提示挂在第二个上')

    // V3:项目节点没选文件夹
    issues = validateGraph({ nodes: [n('p', 'project', { projectDir: '' })], edges: [], projectDir: '' })
    assert(msgs(issues).includes('还没选文件夹'), `V3:项目节点缺目录(实际 ${msgs(issues)})`)

    // V4:串行无上游 / 有上游不报
    issues = validateGraph({ nodes: [n('s', 'feature', { mode: 'serial' })], edges: [], projectDir: 'x' })
    assert(msgs(issues).includes('需要接在某个节点后面'), `V4:串行无上游(实际 ${msgs(issues)})`)
    issues = validateGraph({
      nodes: [n('a', 'project', { projectDir: 'd' }), n('s', 'feature', { mode: 'serial' })],
      edges: [{ source: 'a', target: 's' }],
      projectDir: '',
    })
    assert(!msgs(issues).includes('需要接在某个节点后面'), 'V4:串行有上游时不提示')

    // V5:output 触达不了 project 且没有画布级兜底
    issues = validateGraph({ nodes: [n('o', 'output')], edges: [], projectDir: '' })
    assert(msgs(issues).includes('输出节点'), `V5:output 触达不到项目且无兜底(实际 ${msgs(issues)})`)
    issues = validateGraph({ nodes: [n('o', 'output')], edges: [], projectDir: 'D:\\legacy' })
    assert(!msgs(issues).includes('输出节点'), 'V5:有画布级兜底时不提示(兼容旧画布)')
    issues = validateGraph({
      nodes: [n('p', 'project', { projectDir: 'd' }), n('o', 'output')],
      edges: [{ source: 'p', target: 'o' }],
      projectDir: '',
    })
    assert(!msgs(issues).includes('输出节点'), 'V5:output 能触达项目节点时不提示')

    // V6:merge 汇入 <2
    issues = validateGraph({ nodes: [n('m', 'merge')], edges: [], projectDir: 'x' })
    assert(msgs(issues).includes('至少连接 2 条'), `V6:merge 汇入不足(实际 ${msgs(issues)})`)

    // V7:端口方向 —— project 有入边 / output 有出边
    issues = validateGraph({
      nodes: [n('p', 'project', { projectDir: 'd' }), n('o', 'output')],
      edges: [
        { source: 'o', target: 'p' },
        { source: 'o', target: 'p' },
      ],
      projectDir: '',
    })
    assert(msgs(issues).includes('不该有入边'), `V7:project 有入边(实际 ${msgs(issues)})`)
    issues = validateGraph({
      nodes: [n('p', 'project', { projectDir: 'd' }), n('o', 'output'), n('f', 'feature')],
      edges: [
        { source: 'p', target: 'o' },
        { source: 'o', target: 'f' },
      ],
      projectDir: '',
    })
    assert(msgs(issues).includes('不该有出边'), 'V7:output 有出边')

    // V8(v0.6.0 起):buildTarget 全部可用 —— apk/web 不再是灰置,而是差异化 info 提示
    issues = validateGraph({ nodes: [n('o', 'output', { buildTarget: 'apk' })], edges: [], projectDir: 'd' })
    assert(
      msgs(issues).includes('Android') && !msgs(issues).includes('暂不可用'),
      `V8:apk 目标给出 Android 提示且不再灰置(实际 ${msgs(issues)})`,
    )
    issues = validateGraph({ nodes: [n('o', 'output', { buildTarget: 'web' })], edges: [], projectDir: 'd' })
    assert(msgs(issues).includes('Web 包'), `V8:web 目标给出 Web 打包提示(实际 ${msgs(issues)})`)
    issues = validateGraph({ nodes: [n('o', 'output', { buildTarget: 'game' })], edges: [], projectDir: 'd' })
    assert(!msgs(issues).includes('Android') && !msgs(issues).includes('Web 包'), 'V8:game 目标无多余提示')

    // ---------- V10..V12:本次新增的三个类型 ----------
    // V10:审查节点需要上游(没有上游 = 没东西可审)
    issues = validateGraph({ nodes: [n('r', 'review')], edges: [], projectDir: 'd' })
    assert(msgs(issues).includes('没有东西可审'), `V10:review 无上游(实际 ${msgs(issues)})`)
    issues = validateGraph({
      nodes: [n('p', 'project', { projectDir: 'd' }), n('r', 'review')],
      edges: [{ source: 'p', target: 'r' }],
      projectDir: '',
    })
    assert(!msgs(issues).includes('没有东西可审'), 'V10:review 有上游时不提示')

    // V11:测试节点必须填命令 + 要有目录
    issues = validateGraph({ nodes: [n('t', 'test', { testCommand: '  ' })], edges: [], projectDir: '' })
    assert(msgs(issues).includes('还没填写要跑的测试命令'), `V11:test 无命令(实际 ${msgs(issues)})`)
    assert(msgs(issues).includes('要有个地方跑测试'), `V11:test 无项目目录(实际 ${msgs(issues)})`)
    issues = validateGraph({
      nodes: [n('t', 'test', { testCommand: 'npm test' })],
      edges: [],
      projectDir: 'D:\\proj',
    })
    assert(!msgs(issues).includes('测试节点'), `V11:test 配齐后不提示(实际 ${msgs(issues)})`)

    // V12:文档节点要目录 + 要上游
    issues = validateGraph({ nodes: [n('d2', 'doc')], edges: [], projectDir: '' })
    assert(msgs(issues).includes('要有个地方落笔'), `V12:doc 无目录(实际 ${msgs(issues)})`)
    assert(msgs(issues).includes('不知道要为哪块改动写文档'), `V12:doc 无上游(实际 ${msgs(issues)})`)
  }

  // ---------- ④ specFromGraph:按 kind 解析 cwd / output 无 agentId ----------
  {
    const spec = specFromGraph({
      canvasId: 'e2e',
      projectDir: 'D:\\legacy',
      nodes: [
        { id: 'p', data: { title: 'P', kind: 'project', projectDir: 'D:\\proj\\a', brief: '计算器' } },
        { id: 'o', data: { title: 'O', kind: 'output', buildTarget: 'exe', buildOptions: { appName: 'X' } } },
        { id: 'f', data: { title: 'F', kind: 'feature', mode: 'parallel' } },
        { id: 'g', data: { title: 'G', kind: 'feature', cwd: 'D:\\solo' } },
      ],
      edges: [],
      maxParallel: 2,
      inlineLimitBytes: 32768,
    })
    const p = spec.nodes.find((x) => x.id === 'p')
    const o = spec.nodes.find((x) => x.id === 'o')
    const f = spec.nodes.find((x) => x.id === 'f')
    const g = spec.nodes.find((x) => x.id === 'g')

    assert(p?.cwd === 'D:\\proj\\a', `project 节点的 cwd 是它自己的 projectDir(实际 ${p?.cwd})`)
    assert(p?.brief === '计算器', 'brief 进了 spec(主进程无画布状态,只能靠 spec 带过去)')
    assert(o?.agentId === undefined && o?.buildTarget === 'exe', 'output 节点没有 agentId 且带 buildTarget')
    assert(o?.failurePolicy === 'skip' && o?.retry === 0, 'output 保留结构完整(但不走失败策略/重试路径)')
    assert(f?.cwd === 'D:\\proj\\a', `feature 无 cwd → 跟随项目节点(实际 ${f?.cwd})`)
    assert(g?.cwd === 'D:\\solo', 'feature 自己配了 cwd 就用自己的(节点覆盖仍然成立)')
    assert(spec.projectDir === 'D:\\legacy', '画布级 projectDir 带进 spec(主进程校验兜底用)')
  }
}

/**
 * nodes-v2 · T02:调度器分流 + 注入规则分派(假 env)。
 *
 * 覆盖:输出节点分流(不走 startNode/waitFor)/ 并行不自动注入但显式引用放行 /
 * merge 默认模板 + 多前驱分节 / project brief 前置。
 */
async function nodesV2RunTests(): Promise<void> {
  await fs.rm(canvasRoot(WF_CANVAS), { recursive: true, force: true })

  // ---------- ① 输出节点走内置动作路径,不碰会话 ----------
  {
    const env = new FakeEnv()
    env.plan('P', [{ ok: true, output: 'P 的产出' }])
    env.planBuiltin('O', [{ ok: true, artifactPath: 'D:\\proj\\dist\\app.exe', log: '打包日志若干' }])

    const runner = new WorkflowRunner(env)
    const state = await runner.run(
      specOf(
        [
          nodeSpec('P', '', { kind: 'project', brief: '这是一个计算器项目', cwd: 'D:\\proj' }),
          nodeSpec('O', '', { kind: 'output', agentId: undefined, buildTarget: 'exe', cwd: 'D:\\proj' }),
        ],
        [['P', 'O']],
      ),
    )

    assert(state.status === 'done', `项目→输出 全链完成(实际 ${state.status})`)
    assert(state.nodes['O']?.status === 'done', `输出节点 done(实际 ${state.nodes['O']?.status})`)
    assert(!env.prompts.has('O'), '输出节点**没有**走会话路径(startNode 未被调用)')
    const call = env.builtinCalls.find((c) => c.nodeId === 'O')
    assert(!!call, '输出节点走到了 runBuiltinAction')
    assert(call?.action === 'package' && call?.projectDir === 'D:\\proj' && call?.buildTarget === 'exe',
      `内置动作请求形状正确(实际 ${JSON.stringify(call)})`)
    assert(env.notices.some((x) => x.nodeId === 'O' && x.level === 'info'), '打包进度经 notice 冒泡(节点日志可见)')

    // project 节点仍是一轮会话(M3):brief 前置为项目说明
    assert(
      env.prompt('P').includes('[项目说明] 这是一个计算器项目'),
      `project 节点的 brief 前置到 prompt(实际 ${JSON.stringify(env.prompt('P').slice(0, 80))})`,
    )
  }

  // ---------- ①b 输出节点打包失败:不重试,直接 failed ----------
  {
    const env = new FakeEnv()
    env.planBuiltin('O', [{ ok: false, log: 'err log', error: 'electron-builder 失败(退出码 3)' }])
    const state = await new WorkflowRunner(env).run(
      specOf([nodeSpec('O', '', { kind: 'output', agentId: undefined, cwd: 'D:\\proj' })], []),
    )
    assert(state.nodes['O']?.status === 'failed', `打包失败 → failed(实际 ${state.nodes['O']?.status})`)
    assert(state.nodes['O']?.attempts === 1, '输出节点**不套** agent 的重试语义(attempts=1)')
    assert(
      env.notices.some((x) => x.nodeId === 'O' && x.level === 'error' && x.text.includes('打包失败')),
      '失败原因进了节点日志',
    )
  }

  // ---------- ② 并行不自动注入上游 feature 产出;显式 {{node:<id>}} 放行(M2) ----------
  {
    const env = new FakeEnv()
    env.plan('F1', [{ ok: true, output: 'F1 的机密产出' }])
    env.plan('PL', [{ ok: true, output: 'pl' }])
    env.plan('PLX', [{ ok: true, output: 'plx' }])

    const state = await new WorkflowRunner(env).run(
      specOf(
        [
          nodeSpec('F1', '做功能一'),
          nodeSpec('PL', '并行做:{{prev}}', { kind: 'feature', mode: 'parallel' }),
          nodeSpec('PLX', '显式引用:{{node:F1}}', { kind: 'feature', mode: 'parallel' }),
        ],
        [
          ['F1', 'PL'],
          ['F1', 'PLX'],
        ],
      ),
    )
    assert(state.status === 'done', `并行支路跑完(实际 ${state.status})`)

    const pl = env.prompt('PL')
    assert(!pl.includes('F1 的机密产出'), `并行节点**不含**上游 feature 的自动注入(实际 ${JSON.stringify(pl.slice(0, 120))})`)
    assert(pl.includes('[并行支路边界]'), '并行节点换上了支路边界开场白')
    assert(
      env.prompt('PLX').includes('F1 的机密产出'),
      '显式 {{node:<id>}} 引用仍然放行(用户主动 opt-in)',
    )
  }

  // ---------- ②b 串行仍注入上游产出(回归:分派不能把串行也过滤了) ----------
  {
    const env = new FakeEnv()
    env.plan('P', [{ ok: true, output: 'P 写好了框架' }])
    env.plan('S', [{ ok: true, output: 's' }])
    await new WorkflowRunner(env).run(
      specOf(
        [nodeSpec('P', '', { kind: 'project', cwd: 'D:\\proj' }), nodeSpec('S', '{{prev}}')],
        [['P', 'S']],
      ),
    )
    assert(env.prompt('S').includes('P 写好了框架'), '串行节点的上游注入语义不变')
    assert(env.prompt('S').includes('[流水线上下文]'), '串行节点的流线上下文不变')
  }

  // ---------- ③ merge:空模板用默认合并模板;多前驱分节 ----------
  {
    const env = new FakeEnv()
    env.plan('A1', [{ ok: true, output: '支路一成果' }])
    env.plan('A2', [{ ok: true, output: '支路二成果' }])
    env.plan('M', [{ ok: true, output: 'm' }])

    await new WorkflowRunner(env).run(
      specOf(
        [nodeSpec('A1', ''), nodeSpec('A2', ''), nodeSpec('M', '', { kind: 'merge' })],
        [
          ['A1', 'M'],
          ['A2', 'M'],
        ],
      ),
    )
    const m = env.prompt('M')
    assert(m.includes('整合进项目'), 'merge 空模板时用 DEFAULT_MERGE_TEMPLATE')
    assert(m.includes('收敛冲突'), '默认模板里说清了冲突收敛职责')
    assert(m.includes('## 来自「A1」') && m.includes('## 来自「A2」'), '多前驱按标题分节')
    assert(m.includes('支路一成果') && m.includes('支路二成果'), '两条支路的成果都在 prompt 里')
    assert(env.prompt('M').includes(CWD), 'merge 的 {{projectDir}} 被填成了项目文件夹')

    // 默认模板的形状回归:{{prev}} 在模板里(材料在指令后)
    assert(DEFAULT_MERGE_TEMPLATE.includes('{{prev}}') && DEFAULT_MERGE_TEMPLATE.includes('{{projectDir}}'),
      'DEFAULT_MERGE_TEMPLATE 引用 {{prev}} 与 {{projectDir}}')
  }

  // ---------- ③b 输出节点也会被 validateGraph 提示(V8) ----------
  {
    const env = new FakeEnv()
    env.planBuiltin('O', [{ ok: true, artifactPath: 'x', log: '' }])
    await new WorkflowRunner(env).run(
      specOf([nodeSpec('O', '', { kind: 'output', agentId: undefined, buildTarget: 'apk' })], []),
    )
    assert(
      env.notices.some((x) => x.nodeId === 'O' && x.text.includes('Android')),
      'run() 里的图校验把 V8(apk 目标提示)写进了节点日志',
    )
  }

  await fs.rm(canvasRoot(WF_CANVAS), { recursive: true, force: true })
}

/**
 * 整合节点的**唯一职责**:让上游「串行支路」与「并行支路」的改动互相兼容。
 *
 * 这个职责全靠两件事支撑,所以两件都要钉住:
 *   ① **判据** —— 每条上游支路的性质(改动已经在项目里 / 可能已被覆盖),
 *      以及它是否已被另一条包含。串行是叠加语义,包含关系不标出来,
 *      整合节点就会把上游的成果重复落实一遍 —— 这正是"合不到一块"最常见的来源;
 *   ② **边界** —— 这份判据只给整合节点。别的节点拿到 `{{branches}}` 必须原样保留,
 *      否则"整合"这个概念会悄悄渗进每一种节点。
 *
 * 零 LLM、零网络:跑的是应用里那份 runner 与那两个纯函数(不是复制品)。
 */
async function mergeCompatTests(): Promise<void> {
  await fs.rm(canvasRoot(WF_CANVAS), { recursive: true, force: true })

  // ---------- ① formatBranchManifest:空清单 / 角色文案 / 包含关系 ----------
  {
    assert(formatBranchManifest([]) === '', '空清单渲染成空串(模板里那行整行消失,不留 {{branches}})')

    const b = (id: string, role: MergeBranchInfo['role'], subsumedByTitle?: string): MergeBranchInfo => ({
      id,
      title: id.toUpperCase(),
      role,
      subsumedByTitle,
    })

    const base = formatBranchManifest([b('p', 'project'), b('s', 'serial')])
    assert(base.includes('## 支路清单(共 2 条)'), `清单带条数(实际 ${JSON.stringify(base.slice(0, 40))})`)
    assert(base.includes('项目节点'), 'project 角色如实说明(基线,不含功能改动)')
    assert(base.includes('已经在项目里'), '串行支路标为"改动已经在项目里"(它不是待合并的材料)')
    /*
     * 负向对照:一条并行支路都没有时**不许**出现覆盖风险。
     * 报了就是噪声,而噪声会训练用户忽略这类警告 —— 真出事那次也一起被忽略。
     */
    assert(!base.includes('互相覆盖'), '没有并行支路时不报覆盖风险')

    const twoPar = formatBranchManifest([b('a', 'parallel'), b('b', 'parallel')])
    assert(twoPar.includes('可能已被别的支路覆盖'), '并行支路标为"改动可能已被覆盖"')
    assert(twoPar.includes('这 2 条并行支路'), `>=2 条并行支路报覆盖风险(实际 ${JSON.stringify(twoPar)})`)

    /*
     * 已被包含的那条**不参与"有几条在抢"的计数**。
     * 它的现状已经落在包含它的支路里,单独再算一遍,会把
     * "1 条真在抢 + 1 条早已被吸收"误报成 2 条并行冲突。
     */
    const oneRacing = formatBranchManifest([b('a', 'parallel', 'B'), b('b', 'parallel')])
    assert(!oneRacing.includes('这 2 条并行支路'), '被包含的并行支路不参与覆盖计数(实际只剩 1 条在抢)')
    assert(oneRacing.includes('已被「B」包含'), '被包含的支路被明确标出')

    const sub = formatBranchManifest([b('a', 'serial', 'B'), b('b', 'serial')])
    assert(sub.includes('**不要重复落实**'), '被包含的支路明确"不要重复落实"')
    assert(sub.includes('串行链是叠加的'), '有包含关系时补一句"同一件事别做两遍"')
  }

  // ---------- ② 串行链汇入整合节点:上游被标为「已被包含」 ----------
  {
    const env = new FakeEnv()
    env.plan('P', [{ ok: true, output: 'P' }])
    env.plan('A', [{ ok: true, output: 'A 的成果' }])
    env.plan('B', [{ ok: true, output: 'B 的成果' }])
    env.plan('M', [{ ok: true, output: 'm' }])
    await new WorkflowRunner(env).run(
      specOf(
        [
          nodeSpec('P', '', { kind: 'project', cwd: CWD }),
          nodeSpec('A', '做 A'),
          nodeSpec('B', '在 A 之上做 B:{{prev}}'),
          nodeSpec('M', '', { kind: 'merge' }),
        ],
        [
          ['P', 'A'],
          ['A', 'B'],
          // A 和 B 都汇入 M —— 这是"串行链 + 整合"最容易踩的组合
          ['A', 'M'],
          ['B', 'M'],
        ],
      ),
    )
    const m = env.prompt('M')
    assert(m.includes('## 支路清单(共 2 条)'), `整合节点收到支路清单(实际 ${JSON.stringify(m.slice(0, 160))})`)
    assert(m.includes('已被「B」包含'), 'A 是 B 的上游 → 标为被 B 包含(叠加语义,不是两条独立支路)')
    assert(m.includes('串行功能'), '两条上游都被识别为串行')
    assert(!m.includes('这 2 条并行支路'), '串行链不报并行覆盖风险(负向对照)')
    // 判据与材料都在:{{branches}} 是"哪些已经在项目里",{{prev}} 是各支路自述
    assert(m.includes('A 的成果') && m.includes('B 的成果'), '{{prev}} 里两条支路自述都在(判据不能替代材料)')
  }

  // ---------- ③ 两条并行支路汇入:报覆盖风险 ----------
  {
    const env = new FakeEnv()
    env.plan('P', [{ ok: true, output: 'P' }])
    env.plan('X', [{ ok: true, output: 'X 的成果' }])
    env.plan('Y', [{ ok: true, output: 'Y 的成果' }])
    env.plan('M', [{ ok: true, output: 'm' }])
    await new WorkflowRunner(env).run(
      specOf(
        [
          nodeSpec('P', '', { kind: 'project', cwd: CWD }),
          nodeSpec('X', '做 X', { kind: 'feature', mode: 'parallel' }),
          nodeSpec('Y', '做 Y', { kind: 'feature', mode: 'parallel' }),
          nodeSpec('M', '', { kind: 'merge' }),
        ],
        [
          ['P', 'X'],
          ['P', 'Y'],
          ['X', 'M'],
          ['Y', 'M'],
        ],
      ),
    )
    const m = env.prompt('M')
    assert(
      m.includes('这 2 条并行支路'),
      `并行支路的覆盖风险进了 prompt(实际 ${JSON.stringify(m.slice(0, 200))}）`,
    )
    assert(m.includes('以项目里的实际文件为准'), '风险提示要求以实际文件为准,不要只信支路自述')
    /*
     * 互不相干的并行支路之间没有祖先关系 → 不该出现"串行链是叠加的"那句。
     * 这句只由清单在有包含关系时补,所以它是包含关系的**独占信号**。
     */
    assert(!m.includes('串行链是叠加的'), '两条并行支路间没有包含关系,不补"别做两遍"那句')
  }

  // ---------- ④ 判据只给整合节点:别的节点 {{branches}} 原样保留 ----------
  {
    const env = new FakeEnv()
    env.plan('P', [{ ok: true, output: 'P' }])
    env.plan('C', [{ ok: true, output: 'c' }])
    await new WorkflowRunner(env).run(
      specOf(
        [nodeSpec('P', '', { kind: 'project', cwd: CWD }), nodeSpec('C', '{{branches}}')],
        [['P', 'C']],
      ),
    )
    assert(
      env.prompt('C').includes('{{branches}}'),
      '非整合节点不注入支路清单(变量原样保留 —— 未知变量机制负责把话说清楚)',
    )
  }

  // ---------- ⑤ 运行前校验:并行汇入的风险要提前说(V9) ----------
  {
    const n = (id: string, kind: NodeKind, mode?: 'serial' | 'parallel'): { id: string; data: Record<string, unknown> } => ({
      id,
      data: { title: id, kind, ...(mode ? { mode } : {}) },
    })
    const msgs = (issues: GraphIssue[]): string => issues.map((i) => i.message).join('|')

    let iss = validateGraph({
      nodes: [n('x', 'feature', 'parallel'), n('y', 'feature', 'parallel'), n('m', 'merge')],
      edges: [
        { source: 'x', target: 'm' },
        { source: 'y', target: 'm' },
      ],
      projectDir: 'x',
    })
    assert(msgs(iss).includes('并行支路汇入'), `V9:两条并行支路汇入时提前报风险(实际 ${msgs(iss)})`)
    assert(iss.every((i) => i.level === 'warn'), 'V9 同样是 warn 级(它不该挡住一次合法的运行)')

    // 只有 1 条并行支路 → 没人能覆盖它,不该报
    iss = validateGraph({
      nodes: [n('x', 'feature', 'parallel'), n('y', 'feature', 'serial'), n('m', 'merge')],
      edges: [
        { source: 'x', target: 'm' },
        { source: 'y', target: 'm' },
      ],
      projectDir: 'x',
    })
    assert(!msgs(iss).includes('并行支路汇入'), `只有 1 条并行支路时不报(实际 ${msgs(iss)})`)

    // 两条串行 → 叠加语义,不报
    iss = validateGraph({
      nodes: [n('x', 'feature', 'serial'), n('y', 'feature', 'serial'), n('m', 'merge')],
      edges: [
        { source: 'x', target: 'm' },
        { source: 'y', target: 'm' },
      ],
      projectDir: 'x',
    })
    assert(!msgs(iss).includes('并行支路汇入'), '串行汇入不报并行覆盖风险(负向对照)')

    // 项目节点汇入也不算并行
    iss = validateGraph({
      nodes: [n('p', 'project'), n('y', 'feature', 'parallel'), n('m', 'merge')],
      edges: [
        { source: 'p', target: 'm' },
        { source: 'y', target: 'm' },
      ],
      projectDir: 'x',
    })
    assert(!msgs(iss).includes('并行支路汇入'), '项目节点不是功能支路,不计入并行覆盖风险')
  }

  // ---------- ⑥ 默认合并指令:判据与材料都在,且零上游时不残留 ----------
  {
    assert(
      DEFAULT_MERGE_TEMPLATE.includes('{{branches}}') &&
        DEFAULT_MERGE_TEMPLATE.includes('{{prev}}') &&
        DEFAULT_MERGE_TEMPLATE.includes('{{projectDir}}'),
      '默认合并指令同时引用判据({{branches}})与材料({{prev}})',
    )

    const env = new FakeEnv()
    env.plan('M', [{ ok: true, output: 'm' }])
    await new WorkflowRunner(env).run(specOf([nodeSpec('M', '', { kind: 'merge' })], []))
    assert(
      !env.prompt('M').includes('{{branches}}'),
      `零上游时 {{branches}} 渲染成空、不在 prompt 里残留(实际 ${JSON.stringify(env.prompt('M').slice(0, 120))})`,
    )
  }

  /*
   * ---------- ⑦ 校验结论要真的送到用户眼前 ----------
   *
   * 只断言"validateGraph 返回了这条 warn"是不够的:它得**冒泡到节点日志**
   * 才算用户看得见(V8 那条)走的也是这条路)。
   * 一个没人看到的警告等于没有 —— 而这正是"并行支路改同一片文件"最容易翻车之处。
   */
  {
    const env = new FakeEnv()
    env.plan('P', [{ ok: true, output: 'P' }])
    env.plan('X', [{ ok: true, output: 'x' }])
    env.plan('Y', [{ ok: true, output: 'y' }])
    env.plan('M', [{ ok: true, output: 'm' }])
    await new WorkflowRunner(env).run(
      specOf(
        [
          nodeSpec('P', '', { kind: 'project', cwd: CWD }),
          nodeSpec('X', '做 X', { kind: 'feature', mode: 'parallel' }),
          nodeSpec('Y', '做 Y', { kind: 'feature', mode: 'parallel' }),
          nodeSpec('M', '', { kind: 'merge' }),
        ],
        [
          ['P', 'X'],
          ['P', 'Y'],
          ['X', 'M'],
          ['Y', 'M'],
        ],
      ),
    )
    const mLogs = env.notices.filter((x) => x.nodeId === 'M').map((x) => x.text)
    assert(
      mLogs.some((t) => t.includes('并行支路汇入')),
      `V9 的提示经 notice 冒泡到整合节点的日志(实际 ${JSON.stringify(mLogs)})`,
    )
  }

  await fs.rm(canvasRoot(WF_CANVAS), { recursive: true, force: true })
}

/**
 * nodes-v2 · T03:内置打包器(真 Packager + 合成"目标项目")。
 *
 * 不依赖真实 electron-builder:在临时目录里造一个假的目标项目 ——
 * 它"自带"一个 electron-builder(node_modules/.../cli.js 其实是个 node 脚本),
 * 覆盖成功 / 前置 build / 失败 / 取消 / 产物定位 / 入口缺失六条链路。
 * 这样测到的是**应用里跑的那份 Packager**,不是复制品。
 */
async function packagerTests(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haowan-pack-'))
  const mk = async (name: string, cliScript: string, withBuild: boolean): Promise<string> => {
    const proj = path.join(tmp, name)
    await fs.mkdir(path.join(proj, 'node_modules', 'electron-builder', 'out', 'cli'), { recursive: true })
    await fs.writeFile(
      path.join(proj, 'package.json'),
      JSON.stringify({ name, scripts: withBuild ? { build: 'node scripts/build.js' } : {} }),
      'utf8',
    )
    if (withBuild) {
      await fs.mkdir(path.join(proj, 'scripts'), { recursive: true })
      // 前置 build 的"产物":一个标记文件 —— 用来证明它真的先跑过
      await fs.writeFile(
        path.join(proj, 'scripts', 'build.js'),
        'require("node:fs").writeFileSync(require("node:path").join(__dirname, "..", "built.flag"), "1")',
        'utf8',
      )
    }
    await fs.writeFile(path.join(proj, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'), cliScript, 'utf8')
    return proj
  }

  const pk = new Packager()
  const callPack = (nodeId: string, projectDir: string, onProgress?: (l: string) => void) =>
    pk.run({
      canvasId: 'e2e-pack',
      nodeId,
      action: 'package',
      projectDir,
      buildTarget: 'exe',
      buildOptions: {},
      onProgress,
    })

  try {
    // ---------- ① 成功:前置 build 先跑,产物定位到最新的非 win-unpacked exe ----------
    {
      const proj = await mk(
        'proj-ok',
        [
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "console.log('synthetic builder argv=' + JSON.stringify(process.argv.slice(2)));",
          "if (process.argv.includes('--fail')) process.exit(3);",
          "const dist = path.join(process.cwd(), 'dist');",
          'fs.mkdirSync(dist, { recursive: true });',
          // 先写"真产物",再写 win-unpacked 里的(更晚的 mtime)——
          // 产物定位必须**排除** win-unpacked,否则会挑错
          "fs.writeFileSync(path.join(dist, 'MyApp Setup 1.0.0.exe'), 'exe');",
          "setTimeout(() => {",
          "  fs.mkdirSync(path.join(dist, 'win-unpacked'), { recursive: true });",
          "  fs.writeFileSync(path.join(dist, 'win-unpacked', 'inner.exe'), 'exe');",
          "  console.log('building... done');",
          "  process.exit(0);",
          "}, 30);",
        ].join('\n'),
        true,
      )

      const progress: string[] = []
      const res = await callPack('pk-ok', proj, (l) => progress.push(l))
      assert(res.ok === true, `打包成功(实际 ${res.ok} ${res.error ?? ''})`)
      assert(
        !!res.artifactPath && res.artifactPath.endsWith('MyApp Setup 1.0.0.exe'),
        `产物定位取到最新的非 win-unpacked exe(实际 ${res.artifactPath})`,
      )
      assert(existsSync(path.join(proj, 'built.flag')), 'M1:目标项目有 build 脚本 → 前置 build 先执行了')
      assert(progress.some((l) => l.includes('building')), '打包日志经 onProgress 冒泡')
      assert(
        res.log.includes('synthetic builder argv') && res.log.includes('--win'),
        `electron-builder 收到了 --win 参数(实际 ${JSON.stringify(res.log.slice(0, 120))})`,
      )
      assert(res.log.includes('--publish'), '必带 --publish never(打包不许有网络副作用)')
    }

    // ---------- ② 打包器失败:人话报错 + 日志带回 ----------
    {
      const proj = await mk(
        'proj-fail',
        "console.error('boom: 编译失败');\nprocess.exit(3);\n",
        false,
      )
      const res = await callPack('pk-fail', proj)
      assert(res.ok === false, '非零退出码 → ok:false')
      assert((res.error ?? '').includes('electron-builder 失败'), `失败原因为人话(实际 ${res.error})`)
      assert(res.log.includes('boom'), '子进程的日志被带了回来')
    }

    // ---------- ③ 取消:cancel 返回 true,run 的 promise 以"已取消"收尾 ----------
    {
      const proj = await mk(
        'proj-cancel',
        "console.log('开始长任务');\nsetTimeout(() => {}, 60000);\n",
        false,
      )
      const pending = callPack('pk-cancel', proj)
      await sleep(600) // 等子进程真的起来
      assert(pk.cancel('pk-cancel') === true, 'cancel 命中了在跑的打包子进程')
      const res = await pending
      assert(res.ok === false && (res.error ?? '').includes('取消'), `取消后 run 以失败收尾(实际 ${JSON.stringify(res.error)})`)
      /*
       * 进程退出、run() 出账**之后**,再 cancel 才不该命中。
       * (cancel 时进程往往还没退完 —— kill 是异步的 —— 那一小段窗口里
       * live 表还在,再 cancel 返回 true 是"又杀了一次已判死的进程",
       * 无副作用;拿它当幂等性断言反而是错的。)
       */
      assert(pk.cancel('pk-cancel') === false, '进程退出出账后,重复 cancel 不再命中')
    }

    // ---------- ④ 入口缺失:人话报错 ----------
    {
      const proj = path.join(tmp, 'proj-empty')
      await fs.mkdir(proj, { recursive: true })
      assert(resolveBuilder(proj) === null, 'resolveBuilder 找不到入口返回 null')
      const res = await callPack('pk-nobuilder', proj)
      assert(res.ok === false && (res.error ?? '').includes('npm install'), `入口缺失给了可执行的建议(实际 ${res.error})`)
    }

    // ---------- ⑤ killAll 是安全的兜底 ----------
    {
      pk.killAll()
      assert(true, 'killAll 在没有在跑进程时安全空转')
    }
  } finally {
    pk.killAll()
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

/**
 * T03 · 四类型行为零回归(注册表化之后仍逐条成立)。
 *
 * 目标:把"把类型知识从 8 处散点收成一张声明表"这次重构**没有改变**
 * `project / feature / merge / output` 的行为,变成**可执行证据**。
 * 覆盖:校验(V1..V8)/ 端口(onConnect)/ 默认值(normalizeConfig)/
 * 入口(ADD_ENTRIES)/ 分流(executor)/ 迁移与规格(migrateGraph / specFromGraph)。
 *
 * ⚠️ 全部走**应用里真正跑的那份实现**:校验/迁移/规格来自 shared,端口/默认值/入口
 * 来自渲染端真实模块(它们都是纯逻辑,无头 node 里可安全 import —— 测的不是复制品)。
 */
/**
 * v0.6.1 工程化 agent 编排测试:agent 循环(轮次/doneHint/重试)与 router 分支
 * (编号/标签/未解析兜底)。全部走 FakeEnv,零 LLM、零网络。
 */
async function agentOrchestrationTests(): Promise<void> {
  // ---- agent 循环:doneHint 命中提前收尾 ----
  {
    const env = new FakeEnv()
    env.plan('A', [
      { ok: true, output: '第一轮:框架已搭好,还没完成。' },
      { ok: true, output: '第二轮:全部完成。任务完成' },
    ])
    const st = await new WorkflowRunner(env).run(
      specOf([nodeSpec('A', '写一个应用', { kind: 'agent', maxRounds: 4, doneHint: '任务完成' })], []),
    )
    assert(st.nodes['A']?.status === 'done', `agent 循环完成(实际 ${st.nodes['A']?.status})`)
    const turns = env.prompts.get('A')?.length ?? 0
    assert(turns === 2, `agent 在 doneHint 命中后提前收尾(实际 ${turns} 轮)`)
    assert((env.prompts.get('A')?.[0].includes('写一个应用')) === true, 'agent 首轮用 composePrompt 的正常模板')
    assert((env.prompts.get('A')?.[1].includes('任务完成')) === true, 'agent 后续轮把完成标志写进续聊指令')
    assert(env.notices.some((n) => n.nodeId === 'A' && n.text.includes('第 2/4 轮')), 'agent 轮次进节点日志')
    assert(env.notices.some((n) => n.nodeId === 'A' && n.text.includes('提前收尾')), 'agent 完成标志提示')
  }

  // ---- agent 循环:跑满 maxRounds(产出 = 最后一轮) ----
  {
    const env = new FakeEnv()
    for (let i = 0; i < 6; i++) env.plan('A', [{ ok: true, output: '还在推进,没完成。' }])
    const st = await new WorkflowRunner(env).run(
      specOf([nodeSpec('A', 'x', { kind: 'agent', maxRounds: 3, doneHint: 'DONE' })], []),
    )
    const turns = env.prompts.get('A')?.length ?? 0
    assert(turns === 3, `agent 跑满 3 轮(实际 ${turns})`)
    assert(st.nodes['A']?.status === 'done', 'agent 轮次到顶仍 done')
  }

  // ---- agent 会话失败走统一重试语义 ----
  {
    const env = new FakeEnv()
    env.plan('A', [
      { ok: false, output: '', failure: { kind: 'quota', retryable: true, hint: '超时', raw: 'x' } },
      { ok: true, output: '好了。任务完成' },
    ])
    const st = await new WorkflowRunner(env).run(
      specOf([nodeSpec('A', 'x', { kind: 'agent', maxRounds: 2, retry: 1 })], []),
    )
    assert(st.nodes['A']?.status === 'done', `agent 会话失败可重试(实际 ${st.nodes['A']?.status})`)
  }

  // ---- router:编号解析 + 分支激活/跳过 ----
  {
    const env = new FakeEnv()
    env.plan('R', [{ ok: true, output: '分支2' }])
    const st = await new WorkflowRunner(env).run(
      specOf(
        [
          nodeSpec('R', '', { kind: 'router', routes: ['有Bug', '通过'] }),
          nodeSpec('A', '修 bug'),
          nodeSpec('B', '打包上线'),
        ],
        [
          ['R', 'A'],
          ['R', 'B'],
        ],
      ),
    )
    assert(st.nodes['R']?.status === 'done', 'router 完成')
    assert(st.nodes['B']?.status === 'done', `选中分支(B,第 2 条出边)被执行(实际 ${st.nodes['B']?.status})`)
    assert(st.nodes['A']?.status === 'skipped', `未选分支(A)被跳过(实际 ${st.nodes['A']?.status})`)
    assert(env.notices.some((n) => n.nodeId === 'R' && n.text.includes('选中:分支2(通过)')), 'router 日志说明选中分支')
  }

  // ---- router:标签命中 ----
  {
    const env = new FakeEnv()
    env.plan('R', [{ ok: true, output: '我选“通过”这条路' }])
    const st = await new WorkflowRunner(env).run(
      specOf(
        [nodeSpec('R', '', { kind: 'router', routes: ['有Bug', '通过'] }), nodeSpec('A', 'x'), nodeSpec('B', 'x')],
        [
          ['R', 'A'],
          ['R', 'B'],
        ],
      ),
    )
    assert(
      st.nodes['B']?.status === 'done' && st.nodes['A']?.status === 'skipped',
      `router 标签命中(实际 A=${st.nodes['A']?.status} B=${st.nodes['B']?.status})`,
    )
  }

  // ---- router:未解析 → 全分支激活 + warn ----
  {
    const env = new FakeEnv()
    env.plan('R', [{ ok: true, output: '乱七八糟' }])
    const st = await new WorkflowRunner(env).run(
      specOf(
        [nodeSpec('R', '', { kind: 'router' }), nodeSpec('A', 'x'), nodeSpec('B', 'x')],
        [
          ['R', 'A'],
          ['R', 'B'],
        ],
      ),
    )
    assert(st.nodes['A']?.status === 'done' && st.nodes['B']?.status === 'done', 'router 未解析 → 全部分支激活(宁可多跑)')
    assert(env.notices.some((n) => n.nodeId === 'R' && n.level === 'warn' && n.text.includes('无法解析')), 'router 未解析有 warn 提示')
  }

  // ---- parseRouterPick 纯函数 ----
  {
    const p1 = parseRouterPick('分支3', [], ['a', 'b', 'c'])
    assert(p1.index === 2 && p1.activeTargets[0] === 'c', `parseRouterPick 编号解析(实际 ${p1.label})`)
    const p2 = parseRouterPick('选“修 bug”', ['修 bug', '上线'], ['a', 'b'])
    assert(p2.index === 0 && p2.activeTargets[0] === 'a', 'parseRouterPick 标签解析')
    const p3 = parseRouterPick('看情况', [], ['a'])
    assert(p3.unparsed === true && p3.activeTargets.length === 1, 'parseRouterPick 未解析兜底全激活')
  }
}

async function nodesV2ZeroRegressionTests(): Promise<void> {
  // ---------- ① 校验:V1..V8 逐条 ----------
  {
    type N = { id: string; data: Record<string, unknown> }
    const n = (id: string, kind: NodeKind, extra: Record<string, unknown> = {}): N => ({
      id,
      data: { title: id, kind, ...extra },
    })
    const msgs = (issues: GraphIssue[]): string => issues.map((i) => i.message).join('|')
    const warnIds = (issues: GraphIssue[]): string[] =>
      issues.filter((i) => i.nodeId).map((i) => i.nodeId as string)

    // V1:没有项目节点(有兜底 / 无兜底两种文案)
    let iss = validateGraph({ nodes: [n('f', 'feature')], edges: [], projectDir: 'D:\\legacy' })
    assert(iss.every((i) => i.level === 'warn'), 'V1..V8 仍全部是 warn 级(不阻断合法旧画布)')
    assert(msgs(iss).includes('项目节点'), `V1:无项目节点 + 有画布兜底 → 提示(实际 ${msgs(iss)})`)
    iss = validateGraph({ nodes: [n('f', 'feature')], edges: [], projectDir: '' })
    assert(msgs(iss).includes('沙箱'), `V1:无项目节点 + 无兜底 → 换文案(实际 ${msgs(iss)})`)

    // V2:多个项目节点(提示挂在第二个上)
    iss = validateGraph({
      nodes: [n('p1', 'project', { projectDir: 'a' }), n('p2', 'project', { projectDir: 'b' })],
      edges: [],
      projectDir: '',
    })
    assert(warnIds(iss).includes('p2'), 'V2:多项目节点提示挂在第二个上')

    // V3:项目节点没选文件夹
    iss = validateGraph({ nodes: [n('p', 'project', { projectDir: '' })], edges: [], projectDir: '' })
    assert(msgs(iss).includes('还没选文件夹'), `V3:项目节点缺目录(实际 ${msgs(iss)})`)

    // V4:串行无上游 / 有上游不报
    iss = validateGraph({ nodes: [n('s', 'feature', { mode: 'serial' })], edges: [], projectDir: 'x' })
    assert(msgs(iss).includes('需要接在某个节点后面'), `V4:串行无上游(实际 ${msgs(iss)})`)
    iss = validateGraph({
      nodes: [n('a', 'project', { projectDir: 'd' }), n('s', 'feature', { mode: 'serial' })],
      edges: [{ source: 'a', target: 's' }],
      projectDir: '',
    })
    assert(!msgs(iss).includes('需要接在某个节点后面'), 'V4:串行有上游时不提示')

    // V5:output 触达 project 三态
    iss = validateGraph({ nodes: [n('o', 'output')], edges: [], projectDir: '' })
    assert(msgs(iss).includes('输出节点'), `V5:output 触达不到项目且无兜底(实际 ${msgs(iss)})`)
    iss = validateGraph({ nodes: [n('o', 'output')], edges: [], projectDir: 'D:\\legacy' })
    assert(!msgs(iss).includes('输出节点'), 'V5:有画布级兜底时不提示')
    iss = validateGraph({
      nodes: [n('p', 'project', { projectDir: 'd' }), n('o', 'output')],
      edges: [{ source: 'p', target: 'o' }],
      projectDir: '',
    })
    assert(!msgs(iss).includes('输出节点'), 'V5:output 能触达项目节点时不提示')

    // V6:merge 汇入 < 2
    iss = validateGraph({ nodes: [n('m', 'merge')], edges: [], projectDir: 'x' })
    assert(msgs(iss).includes('至少连接 2 条'), `V6:merge 汇入不足(实际 ${msgs(iss)})`)

    // V7:端口方向(**由 ports 推导**)project 入边 / output 出边
    iss = validateGraph({
      nodes: [n('p', 'project', { projectDir: 'd' }), n('o', 'output')],
      edges: [
        { source: 'o', target: 'p' },
        { source: 'o', target: 'p' },
      ],
      projectDir: '',
    })
    assert(msgs(iss).includes('不该有入边'), `V7:project 有入边(实际 ${msgs(iss)})`)
    iss = validateGraph({
      nodes: [n('p', 'project', { projectDir: 'd' }), n('o', 'output'), n('f', 'feature')],
      edges: [
        { source: 'p', target: 'o' },
        { source: 'o', target: 'f' },
      ],
      projectDir: '',
    })
    assert(msgs(iss).includes('不该有出边'), `V7:output 有出边(实际 ${msgs(iss)})`)

    // V8(v0.6.0):buildTarget 全部可用,apk 给 info 提示而非灰置
    iss = validateGraph({ nodes: [n('o', 'output', { buildTarget: 'apk' })], edges: [], projectDir: 'd' })
    assert(
      msgs(iss).includes('Android') && !msgs(iss).includes('暂不可用'),
      `V8:apk 目标有 Android 提示且不再灰置(实际 ${msgs(iss)})`,
    )

    // 回归:所有校验都不含 error 级(本增量 error 级留空,避免误阻断旧画布)
    assert(!iss.some((i) => i.level === 'error'), '校验结果里没有 error 级')
  }

  // ---------- ② 端口:连线合法性(由 ports 推导,渲染端 onConnect 用的同一函数) ----------
  {
    // project 有入边 → 拒(target:0):任何类型 → project 都不行
    assert(
      (connectionError('feature', 'project', 'F', 'P') ?? '').includes('不能被别的节点连入'),
      'ports:指向 project 的入边被拒(project.target=0)',
    )
    assert((connectionError('image', 'project', 'I', 'P') ?? '').includes('不能被别的节点连入'), 'ports:image→project 同样被拒')
    // output 有出边 → 拒(source:0)
    assert(
      (connectionError('output', 'feature', 'O', 'F') ?? '').includes('不能往下游连线'),
      'ports:output 的出边被拒(output.source=0)',
    )
    // feature / merge 之间放行
    assert(connectionError('feature', 'merge', 'F', 'M') === null, 'ports:feature→merge 放行')
    assert(connectionError('project', 'feature', 'P', 'F') === null, 'ports:project→feature 放行')
    assert(connectionError('image', 'feature', 'I', 'F') === null, 'ports:image→feature 放行(1 入 1 出中间节点)')
  }

  // ---------- ③ 默认值:applyTypeDefaults(渲染端 normalizeConfig 委托的同一实现) ----------
  {
    // project / feature / merge:会话类,补 agent 字段(与升级前逐字段等价)
    const p = applyTypeDefaults({}, 'project')
    assert(p.kind === 'project' && p.title === '项目节点', `project 默认 title/kind(实际 ${p.title}/${p.kind})`)
    assert(
      p.agentId === 'claude' && p.cwd === '' && p.promptTemplate === '' && p.failurePolicy === 'skip' && p.retry === 0,
      'project 会话字段补全与升级前一致',
    )
    assert(p.projectDir === '' && p.brief === '', 'project 的 projectDir/brief 默认空串')

    const f = applyTypeDefaults({}, 'feature')
    assert(f.kind === 'feature' && f.title === '功能节点' && f.mode === 'serial', `feature 默认 serial(实际 ${f.mode})`)
    assert(applyTypeDefaults({ mode: 'parallel' }, 'feature').mode === 'parallel', 'feature 显式 parallel 被保留')

    const m = applyTypeDefaults({}, 'merge')
    assert(m.kind === 'merge' && m.title === '整合节点' && m.agentId === 'claude', 'merge 默认走会话、有默认标题')

    // output:内置动作,**不含**任何 agent 专属字段(PRD §4.2)
    const o = applyTypeDefaults({}, 'output')
    assert(o.kind === 'output' && o.title === '输出节点', 'output 默认 title/kind')
    assert(o.buildTarget === 'exe' && o.buildOptions !== undefined, 'output 默认 buildTarget=exe / buildOptions={}')
    assert(
      o.agentId === undefined &&
        o.cwd === undefined &&
        o.promptTemplate === undefined &&
        o.permissionMode === undefined &&
        o.failurePolicy === undefined &&
        o.retry === undefined,
      'output **不带**任何 agent 专属字段',
    )

    // image:新类型,默认 provider=local-command、张数=1、尺寸 1024x1024
    const i = applyTypeDefaults({}, 'image')
    assert(i.kind === 'image' && i.title === '图像节点', 'image 默认 title/kind')
    assert(
      i.imageParams?.n === 1 && i.imageParams?.size === '1024x1024',
      `image 默认张数/尺寸(实际 ${JSON.stringify(i.imageParams)})`,
    )
    assert(i.imageProvider?.kind === 'local-command', 'image 默认出图方式=本地命令')
    assert(i.agentId === undefined, 'image 不带 agentId(不启动会话)')
    assert(applyTypeDefaults({ imageParams: { n: 999 } }, 'image').imageParams?.n === 8, 'image 张数上限夹到 8')
    assert(applyTypeDefaults({ imageParams: { n: 0 } }, 'image').imageParams?.n === 1, 'image 张数下限夹到 1')
    // 根因修复:非数字 / 非有限值必须回落 1(旧 `Math.trunc(n || 1)` 对 'abc' 会算出 NaN)
    assert(
      applyTypeDefaults({ imageParams: { n: 'abc' as unknown as number } }, 'image').imageParams?.n === 1,
      "image 张数 'abc' → 回落 1(不是 NaN)",
    )

    // handoff:交接节点(v0.4.2)—— 内置动作、默认交接说明为空、不带 agentId
    const h = applyTypeDefaults({}, 'handoff')
    assert(h.kind === 'handoff' && h.title === '交接节点', 'handoff 默认 title/kind')
    assert(h.handoffNote === '' || h.handoffNote === undefined, 'handoff 默认无用途说明')
    assert(h.agentId === undefined, 'handoff 不带 agentId(不启动会话)')
    assert(applyTypeDefaults({ handoffNote: '游戏素材' }, 'handoff').handoffNote === '游戏素材', 'handoff 保留用途说明')
    // 交接→feature 放行(1 入 1 出中间节点,桥接生图与软件制作)
    assert(connectionError('handoff', 'feature', 'H', 'F') === null, 'ports:handoff→feature 放行')
    assert(applyTypeDefaults({ imageParams: { n: NaN } }, 'image').imageParams?.n === 1, 'image 张数 NaN → 回落 1')
    assert(
      applyTypeDefaults({ imageParams: { n: Infinity } }, 'image').imageParams?.n === 1,
      'image 张数 Infinity → 回落 1',
    )
    assert(applyTypeDefaults({ imageParams: { n: 3.9 } }, 'image').imageParams?.n === 3, 'image 张数取整(3.9 → 3)')
  }

  // ---------- ④ 入口:addEntryList()(渲染端 Canvas 的同一实现) ----------
  {
    const entries = addEntryList()
    /*
     * 十九条入口 = 十个类型里 feature 占两条(串行 / 并行),v0.4.1 新增 game / video,
     * v0.4.2 新增 handoff,v0.5.0 新增生图工作区四节点(prompt / prompt_negative / sampler / image_output),
     * v0.6.1 新增 agent(循环/并行两条)与 router。
     * 顺序 = NODE_TYPES 的键插入顺序;新类型追加在末尾,老入口的相对位置不动 ——
     * 菜单里的数字键直选(1-9)依赖这个顺序,挪一下用户的肌肉记忆就废了。
     */
    assert(entries.length === 20, `添加入口恰好 20 项(实际 ${entries.length})`)
    assert(
      entries.map((e) => e.kind).join(',') ===
        'project,feature,feature,merge,output,image,review,test,doc,game,video,handoff,agent,agent,router,chart,prompt,prompt_negative,sampler,image_output',
      `入口顺序/类型正确(实际 ${entries.map((e) => e.kind).join(',')})`,
    )
    /*
     * label + hint + icon 必须与声明表**逐字相等**。
     *
     * 这条专门钉住"声明表漏写 addEntries → 静默降级成 label=def.label、hint=''"
     * 这个坑:merge 曾经就因此把「整合 / 把多条支路合回同一个项目」丢成了「整合 / 空」。
     * 现在每条入口都带 icon,所以 icon 一起钉 —— 漏写 icon 会让菜单里那一行
     * 变成"没有图标的孤儿行"(形状上和别的行差一个槽位,一眼能看出错位)。
     *
     * ⚠️ 标签里**不含 emoji** 是本次重画的一部分:图标由 icon 字段单独给
     * (渲染端查 Icons.tsx),文字里再塞一个 emoji 会变成"图标 + 彩色卡通"两层。
     */
    const expectedEntries = [
      { kind: 'project', label: '项目', icon: 'project', hint: '画布起点:项目文件夹的唯一权威来源' },
      { kind: 'feature', label: '串行功能', icon: 'serial', hint: '在上游成果上叠加(注入上游产出)' },
      { kind: 'feature', label: '并行功能', icon: 'parallel', hint: '另起支路独立做(不注入上游产出)' },
      { kind: 'merge', label: '整合', icon: 'merge', hint: '把多条支路合回同一个项目' },
      { kind: 'output', label: '输出', icon: 'output', hint: '内置打包交付(不耗 token)' },
      { kind: 'image', label: '图像', icon: 'image', hint: '给项目生成美术素材(不耗 token)' },
      { kind: 'review', label: '审查', icon: 'review', hint: '只读评审上游成果,产出一份问题清单(不改代码)' },
      { kind: 'test', label: '测试', icon: 'test', hint: '在项目里跑测试命令,结果交给下游(不耗 token)' },
      { kind: 'doc', label: '文档', icon: 'doc', hint: '按上游改动补写 / 更新文档(README、接口说明等)' },
      { kind: 'game', label: '游戏', icon: 'game', hint: '用 Godot 引擎制作 2D/3D 游戏(生成项目文件,Godot 编辑器打开即可运行)' },
      {
        kind: 'video',
        label: '视频',
        icon: 'video',
        hint: '理解视频内容:抽帧交给视觉模型分析,产出文字理解(不耗 LLM 会话 token,但视觉模型会计费)',
      },
      {
        kind: 'handoff',
        label: '交接',
        icon: 'handoff',
        hint: '把图像节点生成的图片交接给软件制作节点:自动收集素材并生成清单,下游直接用',
      },
      { kind: 'agent', label: '智能体(循环)', icon: 'agent', hint: '同一角色多轮迭代:直到输出含「完成标志」或达到最大轮次' },
      { kind: 'agent', label: '智能体(并行)', icon: 'parallel', hint: '独立支路的智能体(并行跑,不自动注入上游产出)' },
      { kind: 'router', label: '路由(分支)', icon: 'router', hint: 'LLM 看完上游成果后选一条出边分支激活,其余分支自动跳过' },
      { kind: 'chart', label: '图表', icon: 'chart', hint: '可视化:把上游文本里的 JSON 数据渲染成 SVG 图表,随项目打包交付' },
      { kind: 'prompt', label: '正向提示词', icon: 'prompt', hint: '生图:写画面要什么,连到采样出图节点' },
      {
        kind: 'prompt_negative',
        label: '负向提示词',
        icon: 'prompt',
        hint: '生图:写画面不要什么(模糊/畸形等),连到采样出图节点',
      },
      {
        kind: 'sampler',
        label: '采样出图',
        icon: 'sampler',
        hint: '生图:接正向/负向提示词,选择模型与参数出图(复用图像节点引擎)',
      },
      {
        kind: 'image_output',
        label: '图片输出',
        icon: 'image_output',
        hint: '生图:终点节点,列出本次生成的图片清单(图片已随项目保存)',
      },
    ]
    const actualEntries = entries.map((e) => ({
      kind: e.kind,
      label: e.label,
      icon: e.icon,
      hint: e.hint,
    }))
    assert(
      JSON.stringify(actualEntries) === JSON.stringify(expectedEntries),
      `二十条入口的 label/icon/hint 与声明表逐字相等(实际 ${JSON.stringify(actualEntries)})`,
    )
    // 文字里不许再有 emoji / 几何图形字符 —— 图标一律走 icon 字段
    const emojiish = /[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u
    assert(
      entries.every((e) => !emojiish.test(e.label) && !emojiish.test(e.hint)),
      `入口文案里没有 emoji/符号(实际 ${JSON.stringify(entries.map((e) => e.label))})`,
    )
    const serial = entries.find((e) => e.key === 'serial')
    const parallel = entries.find((e) => e.key === 'parallel')
    assert(serial?.kind === 'feature' && serial?.preset?.mode === 'serial', '「串行」入口 → feature + preset.mode=serial')
    assert(
      parallel?.kind === 'feature' && parallel?.preset?.mode === 'parallel',
      '「并行」入口 → feature + preset.mode=parallel',
    )
    // 同 kind 的两个入口图标必须不同,否则菜单里"串行 / 并行"长得一样
    assert(
      serial?.icon === 'serial' && parallel?.icon === 'parallel',
      '串行 / 并行入口各自有不同图标',
    )
  }

  // ---------- ⑤ 分流:executor 决定走会话还是内置动作 ----------
  {
    assert(
      NODE_TYPES.project.executor === 'session' &&
        NODE_TYPES.feature.executor === 'session' &&
        NODE_TYPES.merge.executor === 'session',
      'project/feature/merge 是会话执行器',
    )
    // review / doc 是会话类(它们要判断力:挑问题、组织文档)
    assert(
      NODE_TYPES.review.executor === 'session' && NODE_TYPES.doc.executor === 'session',
      'review / doc 是会话执行器',
    )
    assert(
      NODE_TYPES.output.executor === 'builtin' && NODE_TYPES.output.action === 'package',
      'output 是内置动作(package)',
    )
    assert(NODE_TYPES.image.executor === 'builtin' && NODE_TYPES.image.action === 'image', 'image 是内置动作(image)')
    // test 是内置动作:通没通过由退出码决定,不经过模型解释
    assert(
      NODE_TYPES.test.executor === 'builtin' && NODE_TYPES.test.action === 'test',
      'test 是内置动作(test)',
    )

    // runner:output 走 builtin、feature 走 session(假 env)
    const env = new FakeEnv()
    env.plan('F', [{ ok: true, output: 'f 产出' }])
    env.planBuiltin('O', [{ ok: true, artifactPath: 'D:\\proj\\app.exe', log: 'ok' }])
    const state = await new WorkflowRunner(env).run(
      specOf([nodeSpec('F', '做点事'), nodeSpec('O', '', { kind: 'output', cwd: 'D:\\proj' })], [['F', 'O']]),
    )
    assert(state.status === 'done', `feature→output 全链完成(实际 ${state.status})`)
    assert(env.prompts.has('F') && !env.prompts.has('O'), 'feature 走会话、output 不走会话')
    assert(
      env.builtinCalls.some((c) => c.nodeId === 'O' && c.action === 'package'),
      'output 走到了 builtin(package)',
    )

    /*
     * ---------- test 节点:内置动作,但产出必须**传下去** ----------
     *
     * 它和 output 的关键差别就在这里:output 是终点(没有出边),测试节点是
     * 链上的中间节点 —— 下游要靠"测试过了没、不过是什么"决定继续还是停。
     * 所以这一段钉的是"测试结果真的进了下游的 prompt",而不是"函数被调用了"。
     */
    const envT = new FakeEnv()
    envT.plan('F1', [{ ok: true, output: 'F1 改完了' }])
    envT.planBuiltin('T', [
      {
        ok: false,
        log: 'FAIL src/a.test.ts\n  期望 1 得到 2',
        error: '测试未通过(退出码 1)',
        exitCode: 1,
      },
    ])
    envT.plan('F2', [{ ok: true, output: 'F2 收到' }])
    const stateT = await new WorkflowRunner(envT).run(
      specOf(
        [
          nodeSpec('F1', '改代码'),
          nodeSpec('T', '', {
            kind: 'test',
            cwd: 'D:\\proj',
            testCommand: 'npm test',
            testTimeoutSec: 60,
            // 明确"测试红了也要让下游看到结果";默认 skip 那条在下面单独钉
            failurePolicy: 'continue',
          }),
          nodeSpec('F2', '继续:{{prev}}'),
        ],
        [
          ['F1', 'T'],
          ['T', 'F2'],
        ],
      ),
    )
    assert(
      envT.builtinCalls.some((c) => c.nodeId === 'T' && c.action === 'test'),
      'test 走到了 builtin(test)',
    )
    assert(
      envT.builtinCalls.some((c) => c.nodeId === 'T' && c.testCommand === 'npm test' && c.testTimeoutSec === 60),
      'test 请求里带着命令与超时(runner 的透传)',
    )
    assert(envT.prompts.has('F1') && !envT.prompts.has('T'), 'feature 走会话、test 不走会话')
    /*
     * 整次运行的状态仍是 failed —— 这是 runner 既有语义(有节点失败就算 failed),
     * 和"下游有没有继续跑"是两件事。真正要钉的是**下游确实跑了**:
     * 失败策略是 continue 时,测试红了不该把后面的节点一起掐死。
     */
    assert(
      stateT.nodes['F2']?.status === 'done',
      `test 失败 + continue → 下游照常执行(实际 ${stateT.nodes['F2']?.status})`,
    )
    assert(stateT.status === 'failed', '整次运行如实报 failed(有节点失败,与下游是否继续无关)')
    assert(envT.prompt('F2').includes('[测试结果] 未通过'), 'test 产出(测试结论)注入到了下游 prompt')
    assert(envT.prompt('F2').includes('期望 1 得到 2'), '测试日志尾部也随产出传给了下游')

    // formatTestOutput:成败两条路的产出形状(纯函数,单独钉)
    const okOut = formatTestOutput({ ok: true, log: 'all good', exitCode: 0 })
    const badOut = formatTestOutput({
      ok: false,
      log: 'FAIL x',
      error: '测试未通过(退出码 1)',
      exitCode: 1,
    })
    assert(
      okOut.startsWith('[测试结果] 通过') && okOut.includes('all good'),
      `通过时的产出形状(${okOut.split('\n')[0]})`,
    )
    assert(
      badOut.startsWith('[测试结果] 未通过') && badOut.includes('FAIL x'),
      `未通过时既有结论也有日志(${badOut.split('\n')[0]})`,
    )

    /*
     * 默认失败策略的另一侧:test 用默认的 skip 时,测试红了**下游必须被跳过**
     * —— 这是安全的一侧(测试没过就别往下打包 / 整合)。这条不钉住的话,
     * 某天把默认值改成 continue 也不会有任何测试报警。
     */
    const envS = new FakeEnv()
    envS.planBuiltin('T2', [{ ok: false, log: 'boom', error: '测试未通过(退出码 1)', exitCode: 1 }])
    envS.plan('F3', [{ ok: true, output: '不该跑到我' }])
    const stateS = await new WorkflowRunner(envS).run(
      specOf(
        [nodeSpec('T2', '', { kind: 'test', cwd: 'D:\\proj', testCommand: 'npm test' }), nodeSpec('F3', '接着做')],
        [['T2', 'F3']],
      ),
    )
    assert(stateS.nodes['T2']?.status === 'failed', `测试失败 → 节点 failed(实际 ${stateS.nodes['T2']?.status})`)
    assert(stateS.nodes['F3']?.status === 'skipped', `测试失败 + 默认 skip → 下游被跳过(实际 ${stateS.nodes['F3']?.status})`)
    assert(!envS.prompts.has('F3'), '被跳过的下游不会真的起会话')
  }

  // ---------- ⑥ 迁移 / 规格:migrateGraph v1→v3 幂等 + specFromGraph 四类型 ----------
  {
    const v1 = {
      version: 1,
      name: 'x',
      projectDir: 'D:\\o',
      nodes: [{ id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { title: 'A', agentId: 'claude', cwd: '' } }],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    }
    const m1 = migrateGraph(v1)
    assert(
      m1.version === 3 && m1.nodes[0]?.type === 'feature' && m1.nodes[0]?.data.mode === 'serial',
      'migrateGraph:v1 agent → feature/serial, version=3',
    )
    assert(JSON.stringify(migrateGraph(m1)) === JSON.stringify(m1), 'migrateGraph 再迁一次不变(幂等)')

    const spec = specFromGraph({
      canvasId: 'e2e',
      projectDir: 'D:\\legacy',
      nodes: [
        { id: 'p', data: { title: 'P', kind: 'project', projectDir: 'D:\\proj\\a', brief: '计算器' } },
        { id: 'f', data: { title: 'F', kind: 'feature', mode: 'parallel' } },
        { id: 'g', data: { title: 'G', kind: 'merge' } },
        { id: 'o', data: { title: 'O', kind: 'output', buildTarget: 'exe' } },
        { id: 'i', data: { title: 'I', kind: 'image', imageProvider: { kind: 'local-command', command: 'x' } } },
      ],
      edges: [],
      maxParallel: 2,
      inlineLimitBytes: 32768,
    })
    const byId = (id: string): WorkflowNodeSpec | undefined => spec.nodes.find((x) => x.id === id)
    assert(byId('p')?.executor === 'session' && byId('p')?.cwd === 'D:\\proj\\a', 'spec:project 会话 + cwd 取自身 projectDir')
    assert(
      byId('f')?.executor === 'session' && byId('f')?.mode === 'parallel' && byId('f')?.agentId === 'claude',
      'spec:feature 会话/mode/agentId',
    )
    assert(byId('g')?.executor === 'session' && byId('g')?.agentId === 'claude', 'spec:merge 会话')
    assert(
      byId('o')?.executor === 'builtin' && byId('o')?.action === 'package' && byId('o')?.agentId === undefined,
      'spec:output 内置 package、无 agentId',
    )
    assert(byId('o')?.buildTarget === 'exe', 'spec:output 带 buildTarget')
    assert(
      byId('i')?.executor === 'builtin' && byId('i')?.action === 'image' && byId('i')?.agentId === undefined,
      'spec:image 内置 image、无 agentId',
    )
    assert(byId('i')?.imageProvider?.kind === 'local-command', 'spec:image 带 imageProvider')
  }

  // ---------- ⑦ 本次新增的三类型:默认值 / 默认模板 / spec 透传 ----------
  {
    // ---- review:会话节点,默认**只读**(plan)----
    const r = applyTypeDefaults({}, 'review')
    assert(r.kind === 'review' && r.title === '审查节点', `review 默认 title/kind(实际 ${r.kind}/${r.title})`)
    assert(r.agentId === 'claude', 'review 是会话节点,补 agentId')
    assert(
      r.permissionMode === 'plan',
      `review 默认权限 = 只读 plan —— 一个叫"审查"的节点不该默认能改文件(实际 ${r.permissionMode})`,
    )
    assert(
      applyTypeDefaults({ permissionMode: 'acceptEdits' }, 'review').permissionMode === 'acceptEdits',
      'review 用户显式给的权限不被默认值覆盖',
    )

    // ---- doc:会话节点,无特殊默认 ----
    const d = applyTypeDefaults({}, 'doc')
    assert(d.kind === 'doc' && d.title === '文档节点' && d.agentId === 'claude', 'doc 默认 title/kind/agentId')

    // ---- test:内置动作,无 agentId;命令/超时有默认;超时夹取 ----
    const t = applyTypeDefaults({}, 'test')
    assert(t.kind === 'test' && t.title === '测试节点', `test 默认 title/kind(实际 ${t.kind}/${t.title})`)
    assert(t.agentId === undefined, 'test 不带 agentId(不启动会话)')
    assert(
      t.testCommand === 'npm test' && t.testTimeoutSec === 300,
      `test 默认命令/超时(实际 ${t.testCommand}/${t.testTimeoutSec})`,
    )
    assert(applyTypeDefaults({ testTimeoutSec: 0 }, 'test').testTimeoutSec === 5, 'test 超时下限夹到 5')
    assert(applyTypeDefaults({ testTimeoutSec: 99999 }, 'test').testTimeoutSec === 3600, 'test 超时上限夹到 3600')
    assert(
      applyTypeDefaults({ testTimeoutSec: 'abc' as unknown as number }, 'test').testTimeoutSec === 300,
      "test 超时 'abc' → 回落 300(不是 NaN)",
    )
    assert(
      applyTypeDefaults({ testCommand: 'pnpm test' }, 'test').testCommand === 'pnpm test',
      'test 显式命令被保留',
    )

    /*
     * ---- 默认模板 ----
     *
     * merge 那份是老的(e2e 一直逐字钉着),review / doc 是本次新增的。
     * 三个都必须能用真实的上游产出**渲染出来** —— 变量名写错(比如写成
     * {{projectdir}})时 renderTemplate 会把它原样留下并报 unknown,
     * 那条路径在运行时只会进一条 warn 日志,不看这条断言就发现不了。
     */
    assert(
      defaultPromptFor('merge').includes('整合进项目') && defaultPromptFor('merge').includes('{{prev}}'),
      'merge 默认模板仍是既有的那份(没被这次改动动过)',
    )
    assert(
      defaultPromptFor('review').includes('不要修改任何文件') && defaultPromptFor('review').includes('{{prev}}'),
      'review 默认模板要求只读,并带 {{prev}}',
    )
    assert(
      defaultPromptFor('doc').includes('跟着它的风格写') && defaultPromptFor('doc').includes('{{prev}}'),
      'doc 默认模板要求跟随现有文档风格,并带 {{prev}}',
    )
    assert(
      defaultPromptFor('feature') === '{{input}}' && defaultPromptFor('project') === '{{input}}',
      '未登记默认模板的类型回落 {{input}}(升级前行为不变)',
    )
    for (const k of ['merge', 'review', 'doc'] as const) {
      const rendered = renderTemplate(defaultPromptFor(k), {
        prev: '上游成果',
        projectDir: 'D:\\p',
        input: '',
        // merge 模板里的 {{branches}} 由调度器按拓扑算出来注入;零上游时是空串
        branches: '',
      })
      assert(
        rendered.unknown.length === 0,
        `${k} 默认模板的变量全部可渲染(未取到:${rendered.unknown.join(',')})`,
      )
      assert(rendered.text.includes('上游成果'), `${k} 默认模板真的把上游产出渲染进去了`)
    }

    // ---- specFromGraph:test 的专属字段只在 test 上出现 ----
    const spec = specFromGraph({
      canvasId: 'e2e',
      projectDir: 'D:\\legacy',
      nodes: [
        { id: 'p', data: { title: 'P', kind: 'project', projectDir: 'D:\\proj\\a' } },
        { id: 'r', data: { title: 'R', kind: 'review' } },
        { id: 'd2', data: { title: 'D', kind: 'doc' } },
        { id: 't', data: { title: 'T', kind: 'test', testCommand: 'npm run test:unit', testTimeoutSec: 120 } },
        // 干扰项:普通 feature 上挂着 testCommand(手改 graph.json 能造出来),
        // 它**不该**被拍进 spec —— 否则别的节点会莫名带着一个测试命令上路
        { id: 'f', data: { title: 'F', kind: 'feature', testCommand: '不该出现' } },
      ],
      edges: [],
      maxParallel: 2,
      inlineLimitBytes: 32768,
    })
    const byId = (id: string): WorkflowNodeSpec | undefined => spec.nodes.find((x) => x.id === id)
    assert(
      byId('r')?.executor === 'session' && byId('r')?.agentId === 'claude',
      'spec:review 会话 + agentId',
    )
    assert(
      byId('d2')?.executor === 'session' && byId('d2')?.agentId === 'claude',
      'spec:doc 会话 + agentId',
    )
    assert(
      byId('t')?.executor === 'builtin' &&
        byId('t')?.action === 'test' &&
        byId('t')?.agentId === undefined &&
        byId('t')?.testCommand === 'npm run test:unit' &&
        byId('t')?.testTimeoutSec === 120,
      `spec:test 内置 test、无 agentId、带命令与超时(实际 ${JSON.stringify(byId('t'))})`,
    )
    assert(byId('f')?.testCommand === undefined, 'spec:test 专属字段不会泄漏到 feature 节点上')
  }
}

/** 1×1 透明 PNG(mkimage.js / fakeimage-server.js 同款字节,用于造历史/越权样本) */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAwAB/9pM3xoAAAAASUVORK5CYII=',
  'base64',
)

/**
 * 无头 e2e 的假图片解码器 —— 与 Electron `nativeImage` 的最小结构接口一致。
 * e2e 跑在纯 node 里(没有 nativeImage),但 readThumb 的**安全校验**正是要测的,
 * 所以只把"解码成图"这一步换成假的,前缀校验 / realpath / 扩展名 / 大小全走真代码。
 */
const fakeDecoder: ImageDecoder = (buf) => {
  const make = (width: number, height: number): ThumbSource => ({
    isEmpty: () => buf.length === 0,
    getSize: () => ({ width, height }),
    resize: (o) => make(o.width, o.height),
    toDataURL: () => `data:image/png;base64,${buf.toString('base64').slice(0, 16)}`,
  })
  return make(1024, 768)
}

/** 读假出图服务启动后打印的实际端口(`READY <port>`) */
function waitReady(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('假出图服务启动超时')), 8000)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk
      const m = buf.match(/READY (\d+)/)
      if (m) {
        clearTimeout(timer)
        resolve(Number(m[1]))
      }
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

/**
 * T07 · 图像节点:两 provider / 取消 / S1·S2 攻击样例(**零 LLM 依赖**)。
 *
 * 全部用合成手法:local-command 用 `mkimage.js` 写 PNG,http 用本地假服务
 * (`fakeimage-server.js`)返回 base64 / url。**不启动任何 agent 会话、不耗 token**,
 * 所以本节断言**零 skip** —— 不受"真实 LLM 是否可用"影响。
 *
 * 把 QA 最该挑刺的两条暗沟写成断言:S1(命令/JSON 注入)、S2(任意文件读取)。
 */
/**
 * v0.6.2 图表节点:数据解析(柱/饼/散点 + 容错)+ ECharts SSR 出 SVG。
 * echarts 已在 dependencies,node 直接可跑;零网络、零子进程。
 */
async function chartNodeTests(): Promise<void> {
  const { buildChartOption, renderChart, CHART_TYPE_LABEL } = await import('../src/main/chartgen/render')

  // ---- 柱/折线:{"categories","series"} ----
  {
    const r = buildChartOption({ chartType: 'bar', width: 800, height: 480, dataText: '{"categories":["一月","二月"],"series":[10,20]}' })
    assert(r.ok && r.dataPoints === 2, `柱状图解析 2 个数据点(实际 ${JSON.stringify(r)})`)
  }
  // ---- 柱:对象数组 ----
  {
    const r = buildChartOption({ chartType: 'bar', width: 800, height: 480, dataText: '[{"name":"A","value":3},{"name":"B","value":5}]' })
    assert(r.ok && r.dataPoints === 2, `对象数组解析(实际 ${JSON.stringify(r)})`)
  }
  // ---- 饼:对象数组 → 有 series.data ----
  {
    const r = buildChartOption({ chartType: 'pie', width: 800, height: 480, dataText: '[{"name":"A","value":3},{"name":"B","value":5}]' })
    assert(r.ok && r.option.series !== undefined, `饼图解析(实际 ${JSON.stringify(r)})`)
  }
  // ---- 散点:[[x,y],…] ----
  {
    const r = buildChartOption({ chartType: 'scatter', width: 800, height: 480, dataText: '[[1,2],[3,5],[8,9]]' })
    assert(r.ok && r.dataPoints === 3, `散点解析(实际 ${JSON.stringify(r)})`)
  }
  // ---- 说明文字 + JSON 混排(模型/上游常见输出):宽容提取 ----
  {
    const r = buildChartOption({ chartType: 'bar', width: 800, height: 480, dataText: '这是销量数据:\n{"categories":["A","B"],"series":[1,2]}\n请画图' })
    assert(r.ok && r.dataPoints === 2, `混排文本宽容提取(实际 ${JSON.stringify(r)})`)
  }
  // ---- 非法 JSON → 人话失败 ----
  {
    const r = buildChartOption({ chartType: 'bar', width: 800, height: 480, dataText: '不是json 随便写' })
    assert(!r.ok && r.error.includes('合法 JSON'), `非法 JSON 人话失败(实际 ${r.ok ? 'ok' : r.error.slice(0, 40)})`)
  }
  // ---- 空数据 ----
  {
    const r = buildChartOption({ chartType: 'bar', width: 800, height: 480, dataText: '[]' })
    assert(!r.ok, '空数组 → 失败')
  }
  // ---- 数据形状不认识 ----
  {
    const r = buildChartOption({ chartType: 'bar', width: 800, height: 480, dataText: '{"foo":"bar"}' })
    assert(!r.ok && r.error.includes('不认识'), `形状不认识 → 人话(实际 ${r.ok ? 'ok' : r.error.slice(0, 40)})`)
  }

  // ---- ECharts SSR 出 SVG(真实渲染) ----
  {
    const res = renderChart({ chartType: 'line', title: '月度销量', width: 800, height: 480, dataText: '{"categories":["一月","二月","三月"],"series":[10,20,15]}' })
    assert(res.ok, `ECharts SSR 渲染成功(实际 ${JSON.stringify(res)})`)
    if (res.ok) {
      assert(res.svg.includes('<svg') && res.svg.includes('月度销量'), 'SVG 含 svg 根与标题')
    }
  }

  // ---- ChartGen 执行器全链路:落盘 + 产出相对路径 ----
  {
    const { ChartGen } = await import('../src/main/chartgen/ChartGen')
    const os = await import('node:os')
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const dir = path.join(os.tmpdir(), `chusiz-e2e-chart-${Date.now()}`)
    const gen = new ChartGen()
    const res = await gen.run({
      canvasId: 'c',
      nodeId: 'CH',
      action: 'chart',
      projectDir: dir,
      nodeTitle: '销量图',
      prompt: '{"categories":["A","B"],"series":[1,2]}',
      chartParams: { chartType: 'bar', width: 640, height: 400, title: '销量' },
    })
    assert(res.ok, `ChartGen 执行成功(实际 ${JSON.stringify(res.error ?? '')})`)
    if (res.ok) {
      const rel = res.artifacts?.[0] ?? ''
      assert(rel.includes('assets/generated/charts/') && rel.endsWith('chart.svg'), `产物相对路径(实际 ${rel})`)
      const abs = path.join(dir, ...rel.split('/'))
      const svg = await fs.readFile(abs, 'utf8')
      assert(svg.includes('<svg'), '落盘 SVG 可读')
      assert((res.handoffText?.includes('图表完成')) === true, '产出文本可交下游')
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  assert(Object.keys(CHART_TYPE_LABEL).length === 5, '五种图表类型标签齐备')
}

async function imageChainTests(): Promise<void> {
  const ROOT = path.join(os.tmpdir(), `haowan-image-${Date.now().toString(36)}`)
  const PROJECT = path.join(ROOT, 'proj')
  const FIXTURES = path.join(process.cwd(), 'scripts', 'fixtures')
  const MKIMAGE = path.join(FIXTURES, 'mkimage.js')
  const FAKESRV = path.join(FIXTURES, 'fakeimage-server.js')
  /** node 可执行文件 + 合成出图脚本 —— 当成"用户的出图命令" */
  const NODE_CMD = `"${process.execPath}" "${MKIMAGE}"`

  await fs.mkdir(PROJECT, { recursive: true })

  /** 起一个用给定 provider 跑一拍的 ImageGen 请求(默认节点标题「主角待机」→ slug 同名目录) */
  const runImg = (over: Partial<BuiltinActionRequest>): Promise<BuiltinActionResult> =>
    new ImageGen().run({
      canvasId: 'e2e-image',
      nodeId: 'img',
      action: 'image',
      projectDir: PROJECT,
      nodeTitle: '主角待机',
      prompt: '一个像素风主角',
      imageParams: { n: 1, size: '512x512' },
      ...over,
    })

  let server: ChildProcess | null = null
  try {
    // ==================== ① local-command:真实落盘链路 ====================
    {
      const progress: string[] = []
      const res = await runImg({
        nodeId: 'img-local',
        imageParams: { n: 3, size: '512x512' },
        imageProvider: { kind: 'local-command', command: NODE_CMD, timeoutSec: 30 },
        onProgress: (l) => progress.push(l),
      })
      assert(res.ok === true, `local-command 出图成功(实际 ${res.ok} ${res.error ?? ''})`)
      assert((res.artifacts?.length ?? 0) === 3, `回传 3 张相对路径(实际 ${res.artifacts?.length})`)
      const slugDir = `assets/generated/${slugify('主角待机', 'img-local')}`
      assert(
        (res.artifacts ?? []).every((r) => r.startsWith(slugDir + '/')),
        `产物落在 ${slugDir}/ 下(实际 ${JSON.stringify(res.artifacts)})`,
      )
      assert(
        (res.artifacts ?? []).every((r) => !path.isAbsolute(r) && !r.includes('\\')),
        '回传的是相对路径(posix 风格,可直接注入下游)',
      )
      assert(existsSync(path.join(PROJECT, res.artifacts![0])), '文件确实落盘')
      assert(progress.some((l) => l.includes('mkimage')), '出图日志经 onProgress 冒泡')

      // 同名节点 → 同一 slug 目录(确定性;不重复断言张数,因 2s 时钟余量会把上一拍也算进来)
      const res2 = await runImg({
        nodeId: 'img-local-again',
        imageParams: { n: 1 },
        imageProvider: { kind: 'local-command', command: NODE_CMD, timeoutSec: 30 },
      })
      assert(
        (res2.artifacts ?? []).every((r) => r.startsWith(slugDir + '/')),
        '同名节点两次运行落同一目录(确定性)',
      )
    }

    // ==================== ② 维度/张数:未配置 / 无项目文件夹 ====================
    {
      const noCfg = await runImg({ nodeId: 'img-noconf', imageProvider: { kind: 'local-command', command: '' } })
      assert(
        noCfg.ok === false && (noCfg.error ?? '').includes('还没配置出图方式'),
        `未配置出图方式 → 人话失败(实际 ${noCfg.error})`,
      )
      const noProj = await runImg({ nodeId: 'img-noproj', projectDir: '', imageProvider: { kind: 'local-command', command: NODE_CMD } })
      assert(
        noProj.ok === false && (noProj.error ?? '').includes('存图'),
        `项目文件夹为空 → 失败且不兜底沙箱(实际 ${noProj.error})`,
      )
    }

    // ==================== ③ 产物判定:exit0 无图 / 实产<n / 历史文件不计 ====================
    {
      const none = await runImg({
        nodeId: 'img-none',
        nodeTitle: '空产出',
        imageProvider: { kind: 'local-command', command: `${NODE_CMD} --none` },
      })
      assert(
        none.ok === false && (none.error ?? '').includes('新图片'),
        `命令成功但没出新图 → 失败(实际 ${none.error})`,
      )

      const progress: string[] = []
      const partial = await runImg({
        nodeId: 'img-partial',
        nodeTitle: '部分产出',
        imageParams: { n: 3 },
        imageProvider: { kind: 'local-command', command: `${NODE_CMD} --count 1` },
        onProgress: (l) => progress.push(l),
      })
      assert(
        partial.ok === true && (partial.artifacts?.length ?? 0) === 1,
        `0<产出<n → 成功(实际 ${partial.artifacts?.length})`,
      )
      assert(progress.some((l) => l.includes('1/3')), `实产<n 给 warning(实际 ${JSON.stringify(progress)})`)

      // 历史文件(mtime 早于本次运行)不计入产出
      const HIST = path.join(ROOT, 'hist')
      const histDir = path.join(HIST, 'assets', 'generated', slugify('历史产出', 'img-hist'))
      await fs.mkdir(histDir, { recursive: true })
      const oldFile = path.join(histDir, 'old.png')
      await fs.writeFile(oldFile, PNG_1x1)
      const past = new Date(Date.now() - 3600_000)
      await fs.utimes(oldFile, past, past)
      const res = await runImg({
        nodeId: 'img-hist',
        projectDir: HIST,
        nodeTitle: '历史产出',
        imageParams: { n: 1 },
        imageProvider: { kind: 'local-command', command: `${NODE_CMD} --count 1` },
      })
      assert(
        res.ok === true && res.artifacts?.length === 1 && !res.artifacts![0].endsWith('old.png'),
        `mtime 早于本次运行的历史文件不计入产出(实际 ${JSON.stringify(res.artifacts)})`,
      )
    }

    // ==================== ④ D5:缺 {{env:VAR}} → 失败 + 人话 ====================
    {
      const res = await runImg({
        nodeId: 'img-env',
        imageProvider: { kind: 'local-command', command: `${NODE_CMD} {{env:HAOWAN_NO_SUCH_VAR_9Z}}` },
      })
      assert(
        res.ok === false && (res.error ?? '').includes('环境变量'),
        `D5:缺 {{env:VAR}} → 失败 + 人话(实际 ${res.error})`,
      )
    }

    // ==================== ④b 纵深防御:provider 不信任 n / seed(架构 §5.3) ====================
    {
      const ctl: ImageCtl = {
        registerChild() {},
        unregisterChild() {},
        registerAbort() {},
        unregisterAbort() {},
        isKilled: () => false,
        markKilled() {},
      }
      const mkCtx = (n: number, seed?: number): ProviderCtx => ({
        nodeId: 'img-guard',
        projectDir: PROJECT,
        outDir: PROJECT,
        prompt: 'p',
        n,
        size: '512x512',
        seed,
        startTs: Date.now(),
      })

      // http:非有限 n / 非数字 seed → 直接 fail(在发请求**之前**拦下)
      const badN = await runHttp({ kind: 'http', endpoint: 'http://127.0.0.1:1/' }, mkCtx(NaN), ctl)
      assert(
        badN.status === 'fail' && (badN.error ?? '').includes('张数'),
        `provider(http):n=NaN → 人话失败(实际 ${badN.error})`,
      )
      const badSeed = await runHttp(
        { kind: 'http', endpoint: 'http://127.0.0.1:1/' },
        mkCtx(1, '1},"x":"' as unknown as number),
        ctl,
      )
      assert(
        badSeed.status === 'fail' && (badSeed.error ?? '').includes('随机种子'),
        `provider(http):seed 为字符串 → 人话失败(实际 ${badSeed.error})`,
      )
      // local-command:同样的守卫(不会真的去 spawn)
      const lcBadN = await runLocalCommand({ kind: 'local-command', command: `${NODE_CMD} --none` }, mkCtx(NaN), ctl)
      assert(
        lcBadN.status === 'fail' && (lcBadN.error ?? '').includes('张数'),
        `provider(local-command):n=NaN → 人话失败(实际 ${lcBadN.error})`,
      )

      // 端到端:字符串 seed 经 ImageGen.run 也**不再能破坏请求体**(executor 层最后一道拦下)
      const res = await runImg({
        nodeId: 'img-badseed',
        imageParams: { n: 1, seed: '1},"x":"' as unknown as number },
        imageProvider: {
          kind: 'http',
          endpoint: 'http://127.0.0.1:1/',
          method: 'POST',
          bodyTemplate: '{"seed":{{seed}}}',
          responsePath: 'data[0].b64_json',
        },
      })
      assert(
        res.ok === false && (res.error ?? '').includes('随机种子'),
        `executor:字符串 seed 被拦下、不再拼进请求体(实际 ${res.error})`,
      )
    }

    // ==================== ⑤ 取消:杀子进程、节点 cancelled、已生成图片保留 ====================
    {
      const gen = new ImageGen()
      const pending = gen.run({
        canvasId: 'e2e-image',
        nodeId: 'img-cancel',
        action: 'image',
        projectDir: PROJECT,
        nodeTitle: '取消测试',
        prompt: 'x',
        imageParams: { n: 1 },
        // 写 1 张后挂起 30s:留出足够窗口给 e2e 发取消
        imageProvider: { kind: 'local-command', command: `${NODE_CMD} --count 1 --sleep 30000`, timeoutSec: 60 },
      })
      await sleep(900) // 等子进程真的起来并写出文件
      assert(gen.cancel('img-cancel') === true, '取消命中了在跑的出图子进程')
      const res = await pending
      assert(res.ok === false && (res.error ?? '').includes('取消'), `取消后 run 以失败收尾(实际 ${JSON.stringify(res.error)})`)
      assert(gen.cancel('img-cancel') === false, '进程退出出账后,重复 cancel 不再命中')
      const cancelDir = path.join(PROJECT, 'assets', 'generated', slugify('取消测试', 'img-cancel'))
      const files = await fs.readdir(cancelDir)
      assert(files.some((f) => f.endsWith('.png')), '已生成的图片在取消后仍然保留')
      gen.killAll()
      assert(true, 'killAll 在没有在跑出图时安全空转')
    }

    // ==================== ⑤b 交接节点(handoff):扫图 → 素材清单 ====================
    {
      // 图像节点已产出的图就在 assets/generated/<slug>/ 下 —— 造两张假图即可被扫到
      const handoffSlugDir = path.join(PROJECT, 'assets', 'generated', slugify('主角待机', 'img-local'))
      await fs.mkdir(handoffSlugDir, { recursive: true })
      await fs.writeFile(path.join(handoffSlugDir, 'hero.png'), 'x')
      await fs.writeFile(path.join(handoffSlugDir, 'map.jpg'), 'y')

      const res = await new Handoff().run({
        canvasId: 'e2e-handoff',
        nodeId: 'handoff-1',
        action: 'handoff',
        projectDir: PROJECT,
        handoffNote: '游戏主角与地图素材',
      })
      assert(res.ok === true, `交接节点收集素材成功(实际 ${res.error ?? ''})`)
      assert(res.handoffText !== undefined && res.handoffText.includes('hero.png') && res.handoffText.includes('map.jpg'), '清单包含两张图的相对路径')
      assert(res.handoffText !== undefined && res.handoffText.includes('游戏主角与地图素材'), '清单带用途说明')
      assert(!res.handoffText!.includes('\\'), '清单里是 posix 相对路径(可注入下游)')

      // 项目文件夹没设 → 人话失败
      const noProj = await new Handoff().run({
        canvasId: 'c', nodeId: 'h', action: 'handoff', projectDir: '',
      })
      assert(noProj.ok === false && (noProj.error ?? '').includes('项目文件夹还没设'), '交接节点:无项目文件夹 → 人话失败')

      // 无图片 → 人话失败(先跑图像节点)
      const EMPTY_PROJ = path.join(ROOT, 'empty-handoff')
      await fs.mkdir(EMPTY_PROJ, { recursive: true })
      const noImg = await new Handoff().run({
        canvasId: 'c', nodeId: 'h2', action: 'handoff', projectDir: EMPTY_PROJ,
      })
      assert(noImg.ok === false && (noImg.error ?? '').includes('没找到任何图片'), '交接节点:无图 → 人话失败(提示先跑图像节点)')
    }

    // ==================== ⑤b 生图工作区(v0.5.0):双页面 / 画布 id / 节点注册 ====================
    {
      // 工作区节点集合互斥:生图页只有生图节点,软件页只有软件节点
      const imgEntries = workspaceNodeList('image').map((e) => e.kind)
      const appEntries = workspaceNodeList('app').map((e) => e.kind)
      assert(
        imgEntries.includes('prompt') &&
          imgEntries.includes('prompt_negative') &&
          imgEntries.includes('sampler') &&
          imgEntries.includes('image_output') &&
          imgEntries.includes('handoff') &&
          imgEntries.length === 5,
        `生图工作区添加入口恰好 5 项(实际 ${imgEntries.join(',')})`,
      )
      assert(
        !imgEntries.includes('project') && !imgEntries.includes('feature') && !imgEntries.includes('output'),
        '生图页不出现软件节点(项目/功能/输出)',
      )
      assert(
        appEntries.includes('project') && appEntries.includes('output') && !appEntries.includes('prompt'),
        '软件页不出现生图节点(正向提示词),保留项目/输出',
      )

      // 画布 id = 项目 + 工作区;default 项目的软件画布兼容旧画布
      assert(canvasIdFor('default', 'app') === 'default', 'default 项目软件画布 = 旧画布 default(无缝升级)')
      assert(canvasIdFor('default', 'image') === 'default-image', 'default 项目生图画布 = default-image')
      assert(canvasIdFor('mygame', 'image') === 'mygame-image', '新项目生图画布 = <项目>-image(多项目并行)')
      assert(canvasIdFor('mygame', 'app') === 'mygame-app', '新项目软件画布 = <项目>-app')

      // 注册表默认值:提示词节点 / 采样器
      const p = applyTypeDefaults({}, 'prompt')
      assert(p.promptText === '', '正向提示词节点默认空文本')
      assert(applyTypeDefaults({ promptText: 'a cat' }, 'prompt').promptText === 'a cat', '正向提示词保留文本')
      const n2 = applyTypeDefaults({}, 'prompt_negative')
      assert((n2.negativeText ?? '').length > 0, '负向提示词节点有默认负面词')
      const s = applyTypeDefaults({}, 'sampler')
      assert(s.imageProvider?.kind === 'local-command', '采样出图节点默认本地命令出图')
      assert(s.imageParams?.size === '512x512', '采样出图默认 512x512')
      const o = applyTypeDefaults({}, 'image_output')
      assert(o.kind === 'image_output', '图片输出节点注册生效')

      // 执行器动作映射:runner 只认 action(数据),生图节点全走内置动作
      assert(getNodeType('prompt').action === 'noop', 'prompt 节点动作 = noop(纯文本)')
      assert(getNodeType('sampler').action === 'sampler', 'sampler 节点动作 = sampler(复用图像引擎)')
      assert(getNodeType('image_output').action === 'image-output', 'image_output 动作 = image-output(素材清单)')
    }

    // ==================== ⑤c 内置模板工作流(v0.6.0/0.6.1):结构 / 归属 / 边下标 ====================
    {
      const names = Object.keys(WORKFLOW_TEMPLATES)
      assert(names.length === 5, `内置模板恰好 5 个(实际 ${names.join(',')})`)
      const expectKinds: Record<string, string[]> = {
        'desktop-app': ['project', 'feature', 'review', 'test', 'output'],
        'mobile-web': ['project', 'feature', 'output'],
        'pixel-game': ['project', 'image', 'handoff', 'game', 'output'],
        'image-flows': ['prompt', 'prompt_negative', 'sampler', 'image_output'],
        'agent-orchestration': ['project', 'agent', 'agent', 'agent', 'merge', 'agent', 'output'],
      }
      for (const name of names) {
        const t = WORKFLOW_TEMPLATES[name]
        const kinds = t.nodes.map((n) => n.kind)
        assert(
          JSON.stringify(kinds) === JSON.stringify(expectKinds[name]),
          `${name}:节点顺序/类型正确(${kinds.join(',')})`,
        )
        const okEdges = t.edges.every(([from, to]) => from >= 0 && to < t.nodes.length && from < to)
        assert(okEdges, `${name}:边下标全部合法且指向后方(${JSON.stringify(t.edges)})`)
      }
      assert(WORKFLOW_TEMPLATES['image-flows'].workspace === 'image', '生图模板归属生图工作区')
      assert(
        WORKFLOW_TEMPLATES['desktop-app'].workspace === 'app' &&
          WORKFLOW_TEMPLATES['mobile-web'].workspace === 'app' &&
          WORKFLOW_TEMPLATES['pixel-game'].workspace === 'app',
        '软件模板归属软件制作工作区',
      )
      assert(
        WORKFLOW_TEMPLATES['desktop-app'].nodes[4].preset?.buildTarget === 'exe' &&
          WORKFLOW_TEMPLATES['mobile-web'].nodes[2].preset?.buildTarget === 'web' &&
          WORKFLOW_TEMPLATES['pixel-game'].nodes[4].preset?.buildTarget === 'game' &&
          WORKFLOW_TEMPLATES['agent-orchestration'].nodes[6].preset?.buildTarget === 'exe',
        '模板输出节点带正确打包目标(exe/web/game)',
      )
      assert(
        WORKFLOW_TEMPLATES['image-flows'].edges.length === 3,
        '生图模板 3 条连线(正→采样,负→采样,采样→输出)',
      )
      // agent-orchestration(v0.6.1):编排模板的结构承诺
      const orch = WORKFLOW_TEMPLATES['agent-orchestration']
      assert(orch.workspace === 'app', '编排模板归属软件制作工作区')
      assert(orch.nodes[1].preset?.agentRole !== undefined && orch.nodes[1].preset?.maxRounds === 2, '规划智能体带角色与轮次预置')
      assert(orch.nodes[3].preset?.mode === 'parallel', '执行支路 B 是并行模式')
      assert(orch.edges.length === 7, `编排模板 7 条连线(实际 ${orch.edges.length})`)
      assert(
        orch.edges.some(([f]) => f === 1) && orch.edges.some(([, t]) => t === 0) === false,
        '规划智能体有出边、项目节点是源头(无入边)',
      )
    }

    // ==================== ⑥ S1 攻击样例:注入串一进命令行就硬失败 ====================
    {
      const res = await runImg({
        nodeId: 'img-s1-cmd',
        prompt: '"; echo pwned',
        imageProvider: { kind: 'local-command', command: `${NODE_CMD} "{{prompt}}"` },
      })
      assert(res.ok === false, 'S1:命令含 {{prompt}} → 硬失败(绝不拼接)')
      assert(
        (res.error ?? '').includes('{{promptFile}}'),
        `S1:错误提示改用 {{promptFile}}(实际 ${res.error})`,
      )

      // JSON 转义:各注入串经 {{prompt}} 嵌进请求体后,**仍是合法 JSON 且字段值原样**
      const samples = [
        '"; echo pwned',
        '$(touch x)',
        '& del *',
        '"><script>alert(1)</script>',
        'a\nb\r\nc',
        '\\ backslash " quote } ]',
        '__proto__: 1',
      ]
      let allOk = true
      for (const s of samples) {
        const body = `{"prompt":"${escapeJsonInner(s)}","n":1}`
        let parsedPrompt: string | undefined
        try {
          parsedPrompt = (JSON.parse(body) as { prompt: string }).prompt
        } catch {
          parsedPrompt = undefined
        }
        if (parsedPrompt !== s) allOk = false
      }
      assert(allOk, 'S1:全部注入串经 JSON 转义后仍是合法 JSON 且字段值逐字相等')
    }

    // ==================== ⑦ 启动假 HTTP 服务;base64 / url 两条落盘 + 请求体保真 ====================
    server = spawn(process.execPath, [FAKESRV], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const port = await waitReady(server)
    const base = `http://127.0.0.1:${port}/`

    {
      const res = await runImg({
        nodeId: 'img-http-b64',
        nodeTitle: 'http基64',
        imageParams: { n: 1 },
        imageProvider: {
          kind: 'http',
          endpoint: base,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          bodyTemplate: '{"prompt":"{{prompt}}","n":{{n}}}',
          responsePath: 'data[0].b64_json',
          responseType: 'base64',
          format: 'png',
          timeoutSec: 30,
        },
      })
      assert(res.ok === true, `http(base64) 出图成功(实际 ${res.ok} ${res.error ?? ''})`)
      assert((res.artifacts?.length ?? 0) >= 1, `http(base64) 落盘 ≥1 张(实际 ${res.artifacts?.length})`)
      assert((res.artifacts ?? []).every((r) => r.endsWith('.png')), 'http 产物扩展名按 format=png')
      assert(
        (res.artifacts ?? []).every((r) => r.startsWith(`assets/generated/${slugify('http基64', 'img')}/`)),
        'http 产物落在 slug 目录下',
      )
    }

    {
      const res = await runImg({
        nodeId: 'img-http-url',
        nodeTitle: 'http链接',
        imageParams: { n: 1 },
        imageProvider: {
          kind: 'http',
          endpoint: `${base}?mode=url`,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          bodyTemplate: '{"prompt":"{{prompt}}"}',
          responsePath: 'data[0].url',
          responseType: 'url',
          format: 'png',
          timeoutSec: 30,
        },
      })
      assert(res.ok === true, `http(url) 出图成功(实际 ${res.ok} ${res.error ?? ''})`)
      assert(existsSync(path.join(PROJECT, res.artifacts![0])), 'http(url):provider 下载并落盘成功')
    }

    // S1·HTTP 保真:注入串进到请求体后,服务端解析出的 prompt 字段与原串逐字相等
    {
      const INJECTION = '"; echo pwned && del * && <script>'
      const res = await runImg({
        nodeId: 'img-s1-http',
        nodeTitle: 's1注入',
        prompt: INJECTION,
        imageProvider: {
          kind: 'http',
          endpoint: base,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          bodyTemplate: '{"prompt":"{{prompt}}","n":{{n}}}',
          responsePath: 'data[0].b64_json',
          responseType: 'base64',
          format: 'png',
          timeoutSec: 30,
        },
      })
      assert(res.ok === true, 'S1(HTTP):注入串没让请求失败(体仍是合法 JSON)')
      const last = (await (await fetch(`${base}__last`)).json()) as { raw: string }
      const parsed = JSON.parse(last.raw) as { prompt: string }
      assert(parsed.prompt === INJECTION, `S1(HTTP):服务端收到的 prompt 与原串逐字相等(实际 ${JSON.stringify(parsed.prompt)})`)
    }

    // 响应取值:安全路径解析,拒绝原型污染键、不 eval
    {
      const obj = { data: [{ b64_json: 'x' }], a: 1 }
      assert(pickByPath(obj, 'data[0].b64_json') === 'x', '安全取值:正常路径可取')
      assert(pickByPath(obj, '__proto__') === undefined, '安全取值:拒绝 __proto__')
      assert(pickByPath(obj, 'constructor') === undefined, '安全取值:拒绝 constructor')
      assert(pickByPath(obj, 'data.constructor') === undefined, '安全取值:拒绝深层 constructor')
      assert(pickByPath(obj, 'prototype') === undefined, '安全取值:拒绝 prototype')
      assert(pickByPath(obj, 'nope.x') === undefined, '安全取值:不存在路径 → undefined')
    }

    // ==================== ⑧ S2 攻击样例:只读图片通道白名单 ----------
    {
      const S2PROJ = path.join(ROOT, 's2')
      const goodRel = 'assets/generated/主角/pic.png'
      const goodAbs = path.join(S2PROJ, ...goodRel.split('/'))
      await fs.mkdir(path.dirname(goodAbs), { recursive: true })
      await fs.writeFile(goodAbs, PNG_1x1)

      assert((await resolveSafeImagePath(S2PROJ, goodRel)) !== null, 'S2:合法落点(assets/generated/**)解析成功')

      const bad = [
        '../../../../etc/passwd',
        '..\\..\\x.png',
        'assets/generated/../../secret.png',
        'C:\\Windows\\x.png',
        '\\\\server\\share\\x.png',
        '/etc/passwd',
        'assets/generated/主角/pic.txt', // 扩展名不在白名单
      ]
      for (const rel of bad) {
        assert((await resolveSafeImagePath(S2PROJ, rel)) === null, `S2:越权/非法路径一律 null → ${JSON.stringify(rel)}`)
      }

      // 合法图片经 readThumb → 缩放后的小尺寸 dataUrl(注入假解码器)
      const thumb = await readThumb(S2PROJ, goodRel, fakeDecoder)
      assert(thumb !== null && thumb.dataUrl.startsWith('data:'), 'S2:合法图片经 readThumb 返回 dataUrl')
      assert(!!thumb && thumb.w <= 160 && thumb.h <= 160, `S2:缩略图已缩放到 ≤160(实际 ${thumb?.w}x${thumb?.h})`)
      assert((await readThumb(S2PROJ, 'assets/generated/主角/missing.png', fakeDecoder)) === null, 'S2:不存在的文件 → null')

      // 符号链接 / junction 逃逸:realpath 再校验必须拦下
      {
        const outside = path.join(ROOT, 's2-outside')
        await fs.mkdir(outside, { recursive: true })
        await fs.writeFile(path.join(outside, 'evil.png'), PNG_1x1)
        const link = path.join(S2PROJ, 'assets', 'generated', 'escape')
        await fs.symlink(outside, link, 'junction')
        assert(
          (await resolveSafeImagePath(S2PROJ, 'assets/generated/escape/evil.png')) === null,
          'S2:junction 指向白名单外 → 被 realpath 拦下',
        )
      }

      // 超大文件:超过 20MB 上限 → null(不读进内存)
      {
        const bigRel = 'assets/generated/主角/big.png'
        const bigAbs = path.join(S2PROJ, ...bigRel.split('/'))
        await fs.writeFile(bigAbs, Buffer.alloc(20 * 1024 * 1024 + 1))
        assert((await resolveSafeImagePath(S2PROJ, bigRel)) === null, 'S2:超过大小上限的文件 → null')
      }
    }

    // ==================== ⑨ 图像中间节点:项目 → 串行 → 图像 → 串行(假 env,零会话) ====================
    {
      const env = new FakeEnv()
      env.plan('P', [{ ok: true, output: 'P 搭好了框架' }])
      env.plan('S1', [{ ok: true, output: 'S1 定好了风格' }])
      const rel = 'assets/generated/主角待机/img-1.png'
      env.planBuiltin('IMG', [{ ok: true, artifacts: [rel], log: '[图像] 已写入 img-1.png' }])
      env.plan('S2', [{ ok: true, output: 'S2 用上了图片' }])

      const state = await new WorkflowRunner(env).run(
        specOf(
          [
            nodeSpec('P', '', { kind: 'project', cwd: 'D:\\proj', brief: '一个游戏' }),
            nodeSpec('S1', '定风格'),
            nodeSpec('IMG', '画:{{prev}}', { kind: 'image' }),
            nodeSpec('S2', '用图:{{node:IMG}}'),
          ],
          [
            ['P', 'S1'],
            ['S1', 'IMG'],
            ['IMG', 'S2'],
          ],
        ),
      )
      assert(state.status === 'done', `图像链路全链完成(实际 ${state.status})`)
      assert(state.nodes['IMG']?.status === 'done', '图像节点 done')
      assert(state.nodes['IMG']?.attempts === 1, '图像节点不套重试(attempts===1)')
      assert(!env.prompts.has('IMG'), '图像节点**没有**走会话路径(不启动 LLM)')
      assert(!!env.builtinCalls.find((c) => c.nodeId === 'IMG' && c.action === 'image'), '图像节点走到了 builtin(image)')
      const call = env.builtinCalls.find((c) => c.nodeId === 'IMG')
      assert(
        call?.prompt === '画:S1 定好了风格',
        `阶段一展开:{{prev}} 填成了上游产出(实际 ${JSON.stringify(call?.prompt)})`,
      )
      assert((state.nodes['IMG']?.artifacts ?? []).includes(rel), '产物相对路径写进了 RunNodeState.artifacts')
      const s2 = env.prompt('S2')
      assert(s2.includes(rel), `下游 prompt 里出现图片相对路径(实际 ${JSON.stringify(s2.slice(0, 140))})`)
      assert(s2.includes('[图像产出]'), '下游拿到的是 formatImageOutput 形状的产出')
    }
  } finally {
    if (server && server.pid) {
      server.kill()
      await sleep(50)
    }
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * T08 · 多服务商 / API 直连(**零网络、零 LLM、零子进程**)。
 *
 * 这一节把"填自己的 Key 直连云端模型"这条新链路上最容易出错、也最该被 QA
 * 挑刺的四块钉死:
 *
 *   1. **服务商契约** —— agentId 编码/解码、模型与地址的优先级、脏 agentId 不炸;
 *   2. **密钥脱敏** —— maskKey 绝不泄露中间段(它是唯一会离开主进程的东西);
 *   3. **协议解析** —— 三家(OpenAI / Anthropic / Gemini)的流式报文
 *      → 统一 StreamChunk。这里是"加一家服务商"的成本所在,也是手写最容易错的地方;
 *   4. **工具围栏** —— 路径穿越 / 绝对路径 / UNC / 设备名 / 符号链接逃逸 / NUL,
 *      以及 plan 模式下**根本不暴露**写工具(而不是事后再拒)。
 *
 * 全部确定性,不吃 token,所以本节断言零 SKIP。
 */
async function providerApiTests(): Promise<void> {
  /* ================================================================
     1. 服务商契约(shared/providers)
     ================================================================ */
  console.log('\n  --- 1. 服务商契约:agentId 编码 / 模型优先级 / 脏数据 ---')

  assert(apiAgentId('deepseek') === 'api:deepseek', 'apiAgentId 拼出 api:<id>')
  assert(providerOfAgent('api:deepseek')?.id === 'deepseek', 'providerOfAgent 能解回服务商')
  assert(providerOfAgent('api:根本没有这家') === null, '前缀对但服务商不存在 → null(不抛)')
  assert(providerOfAgent('claude') === null, 'CLI 型 agentId → null')
  assert(providerOfAgent(undefined) === null, 'undefined agentId → null')
  assert(providerOfAgent('API:deepseek') === null, '前缀大小写敏感(不做模糊匹配)')
  assert(isApiAgent('api:x') === true && isApiAgent('claude') === false, 'isApiAgent 只认前缀')

  const ds = providerOfAgent('api:deepseek')!
  assert(
    effectiveModel('api:deepseek', '', '') === ds.models[0]!.id,
    `三层都没给 → 用内置首选(实际 ${effectiveModel('api:deepseek', '', '')})`,
  )
  assert(
    effectiveModel('api:deepseek', 'deepseek-reasoner', 'deepseek-chat') === 'deepseek-reasoner',
    '节点选的最优先',
  )
  assert(
    effectiveModel('api:deepseek', '  ', 'deepseek-reasoner') === 'deepseek-reasoner',
    '节点值只有空白 = 没选,回落到服务商默认',
  )
  assert(
    effectiveModel('api:不存在的服务商', '', '') === '',
    '前缀对但服务商不认识、又没给 fallback → 空串(不抛,让节点回落成 CLI 默认)',
  )
  assert(
    effectiveBaseUrl(ds, 'https://proxy.example.com/v1///') === 'https://proxy.example.com/v1',
    'override 去掉尾部斜杠(否则拼出 //chat/completions)',
  )
  assert(effectiveBaseUrl(ds, '   ') === ds.baseUrl, 'override 空白 = 用内置地址')

  {
    const ids = PROVIDERS.map((p) => p.id)
    assert(new Set(ids).size === ids.length, `服务商 id 全局唯一(共 ${ids.length} 家)`)
    const covered = PROVIDER_GROUPS.reduce((n, g) => n + providersInGroup(g.id).length, 0)
    assert(covered === PROVIDERS.length, `PROVIDER_GROUPS 覆盖了全部服务商(${covered}/${PROVIDERS.length})`)
    // 每家至少要能给出一个模型 —— 否则节点上选它之后模型框是空的,直接卡死
    const noModel = PROVIDERS.filter((p) => p.models.length === 0 && !p.listModels)
    assert(noModel.length === 0, `没有"既不内置模型也不能拉列表"的服务商(${noModel.map((p) => p.id).join(',') || '无'})`)
  }

  /* ================================================================
     2. 鉴权头(写错的表现都是 401,而报错文本不告诉你该用哪个)
     ================================================================ */
  console.log('\n  --- 2. 鉴权头:bearer / x-api-key / anthropic-version ---')

  {
    const bearer = authHeaders(ds, 'sk-abc')
    assert(bearer.Authorization === 'Bearer sk-abc', 'bearer 型来自 Authorization')
    assert(bearer['x-api-key'] === undefined, 'bearer 型不额外发 x-api-key')

    const anth = providerOfAgent('api:anthropic')!
    const ah = authHeaders(anth, 'sk-ant-1')
    assert(ah['x-api-key'] === 'sk-ant-1', 'Anthropic 用 x-api-key')
    assert(ah.Authorization === undefined, 'Anthropic 不发 Authorization(发了反而可能被拒)')
    assert(ah['anthropic-version'] === '2023-06-01', 'Anthropic 必带 anthropic-version')

    const ollama = providerOfAgent('api:ollama')!
    const oh = authHeaders(ollama, '')
    assert(oh.Authorization === undefined, 'authStyle=none(本地)不发任何鉴权头')
  }

  /* ================================================================
     3. 密钥脱敏 —— 唯一会离开主进程的东西必须证明它不含明文
     ================================================================ */
  console.log('\n  --- 3. 密钥脱敏:短 Key 全遮 / 长 Key 只露首尾 ---')

  {
    const short = 'sk-12345' // 8 字符
    const m1 = maskKey(short)
    assert(m1 === '********', `≤8 字符整把遮掉(实际 ${JSON.stringify(m1)})`)
    assert(!m1.includes('1') && !m1.includes('s'), '短 Key 遮罩里不含任何原文片段')

    const long = 'sk-abcdefghijklmnopqrstuvwxyz-0123456789'
    const m2 = maskKey(long)
    assert(m2.startsWith('sk-a') && m2.endsWith('6789'), `长 Key 保留前 4 后 4(实际 ${m2})`)
    // 中间段一个字符都不许出现 —— 这才是"脱敏"的实质
    const middle = long.slice(4, -4)
    assert(!m2.includes(middle), '中间段完全不出现在脱敏串里')
    assert(m2.length < long.length, `脱敏串比原文短(不泄露长度:${m2.length} vs ${long.length})`)

    assert(maskKey('') === '', '空 Key → 空串')
    assert(maskKey('   ') === '', '纯空白 Key → 空串')

    const inner = long.slice(4, 8)
    assert(!maskKey(long).includes(inner), '紧邻首 4 位之后的原文也不泄露')
  }

  console.log('\n  --- 4. 环境变量名与 Key 形状校验 ---')

  {
    const n = envKeyName('api:my-gateway')
    assert(/^[A-Z0-9_]+$/.test(n), `envKeyName 只含 A-Z0-9_(实际 ${n})`)
    assert(n === 'CLAUDE_CANVAS_API_MY_GATEWAY', '冒号/短横被折成下划线')
    assert(looksLikeKey('sk-abcdefgh') === true, '够长无空白的 Key 通过形状检查')
    assert(looksLikeKey('short') === false, '太短的被拦下')
    assert(looksLikeKey('abc def ghi') === false, '含空格被拦下')
    assert(looksLikeKey('') === false, '空串被拦下')
  }

  /* ================================================================
     5. 请求构造:三种协议的报文形状
     ================================================================ */
  console.log('\n  --- 5. 请求构造:OpenAI / Anthropic / Gemini ---')

  const TOOLS: ToolDef[] = toolsFor('acceptEdits')
  const base = {
    apiKey: 'sk-test-key',
    model: 'test-model',
    tools: TOOLS,
  }
  const hdr = (init: RequestInit): Record<string, string> => init.headers as Record<string, string>
  const bodyOf = (init: RequestInit): Record<string, any> => JSON.parse(String(init.body))

  {
    const req = buildChatRequest({ ...base, provider: ds, baseUrl: ds.baseUrl, messages: [{ role: 'user', content: 'hi' }] })
    const b = bodyOf(req.init)
    assert(req.url === `${ds.baseUrl}/chat/completions`, `OpenAI 走 /chat/completions(实际 ${req.url})`)
    assert(hdr(req.init).Authorization === 'Bearer sk-test-key', 'OpenAI 鉴权头正确')
    assert(b.stream === true, 'OpenAI 请求 stream=true')
    assert(b.model === 'test-model', 'model 逐字进报文')
    assert(Array.isArray(b.messages) && b.messages[0].content === 'hi', '普通 user 消息原样带上')
    assert(b.tools?.[0]?.type === 'function', 'OpenAI 工具用 {type:function,function:{…}}')
    assert(typeof b.tools[0].function.parameters === 'object', '工具参数是 JSON Schema 对象')
  }

  {
    // 带 tool_calls 的 assistant 消息:content 必须是 null 而不是省略(部分实现会判非法)
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', args: '{"path":"a.txt"}' }] },
      { role: 'tool', content: 'ok', toolCallId: 'c1', name: 'read_file' },
    ]
    const b = bodyOf(buildChatRequest({ ...base, provider: ds, baseUrl: ds.baseUrl, messages: msgs }).init)
    assert(b.messages[0].tool_calls[0].function.name === 'read_file', 'assistant 的 tool_calls 带上了')
    assert(b.messages[0].content === null, '带 tool_calls 时 content 落成 null(不是省略)')
    assert(b.messages[1].role === 'tool' && b.messages[1].tool_call_id === 'c1', 'tool 消息带 tool_call_id 配对')
  }

  {
    const anth = providerOfAgent('api:anthropic')!
    /*
     * 一次请求两个工具调用 —— 这是 Anthropic 最容易踩的地方:
     * 它要求 user/assistant **严格交替**,而两条并排的 tool 结果天然会变成
     * 两条相邻的 user。实现必须把它们合并进同一条 user 消息的 content 数组。
     */
    const msgs: ChatMessage[] = [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'tu1', name: 'list_dir', args: '{"path":"."}' },
          { id: 'tu2', name: 'read_file', args: '{"path":"a.txt"}' },
        ],
      },
      { role: 'tool', content: 'files', toolCallId: 'tu1', name: 'list_dir' },
      { role: 'tool', content: 'body', toolCallId: 'tu2', name: 'read_file' },
    ]
    const req = buildChatRequest({ ...base, provider: anth, baseUrl: anth.baseUrl, messages: msgs })
    const b = bodyOf(req.init)
    assert(req.url === `${anth.baseUrl}/messages`, `Anthropic 走 /messages(实际 ${req.url})`)
    assert(b.system === '你是助手', 'system 提到顶层(system 参数)')
    assert(b.max_tokens > 0, 'max_tokens 必填且已给(Anthropic 漏了直接 400)')
    assert(
      b.messages.every((m: any) => m.role !== 'system'),
      'messages 里不再出现 system 角色(Anthropic 不收)',
    )

    // out 应为:[user 'hi', assistant(tool_use×2), user(tool_result×2)]
    assert(b.messages.length === 3, `两条 tool 结果被合并成一条 user(实际 ${b.messages.length} 条消息)`)
    const uses = b.messages[1]?.content?.filter((c: any) => c.type === 'tool_use') ?? []
    assert(uses.length === 2, `assistant 带出两个 tool_use 块(实际 ${uses.length})`)
    assert(uses[0]?.input?.path === '.', 'tool_use.input 是对象(不是 JSON 串)')
    const results = b.messages[2]?.content?.filter((c: any) => c.type === 'tool_result') ?? []
    assert(b.messages[2]?.role === 'user', 'tool 结果挂在 user 角色下')
    assert(results.length === 2, `两个 tool_result 合并进同一条 user(实际 ${results.length})`)
    assert(
      results[0]?.tool_use_id === 'tu1' && results[1]?.tool_use_id === 'tu2',
      'tool_result 用 tool_use_id 逐一配对',
    )
    assert(b.tools[0].input_schema !== undefined, 'Anthropic 工具用 input_schema')
    assert(
      b.messages.every((m: any) => !('__merged' in m)),
      '内部合并标记 __merged 绝不发给服务商',
    )
    // 严格交替:不能出现两条相邻的 user
    let adjacentUser = false
    for (let i = 1; i < b.messages.length; i++) {
      if (b.messages[i].role === 'user' && b.messages[i - 1].role === 'user') adjacentUser = true
    }
    assert(!adjacentUser, '不产生相邻 user(Anthropic 会把连续 user 判成非法报文)')
  }

  {
    const gem = providerOfAgent('api:gemini')!
    const msgs: ChatMessage[] = [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'files', toolCallId: 'x', name: 'list_dir' },
    ]
    const req = buildChatRequest({ ...base, provider: gem, baseUrl: gem.baseUrl, messages: msgs })
    const b = bodyOf(req.init)
    assert(req.url.includes(':streamGenerateContent'), 'Gemini 走 :streamGenerateContent')
    assert(req.url.includes('alt=sse'), 'Gemini 必须带 alt=sse(否则回来的是 JSON 数组流)')
    assert(req.url.includes('key=sk-test-key'), 'Gemini 用 query 传 Key')
    assert(hdr(req.init).Authorization === undefined, 'Gemini 不发 Authorization 头')
    assert(b.systemInstruction?.parts?.[0]?.text === '你是助手', 'Gemini system 走 systemInstruction')
    assert(Array.isArray(b.contents) && b.contents.every((c: any) => c.role !== 'system'), 'contents 里去掉 system 角色')
    assert(b.contents.some((c: any) => c.parts?.[0]?.functionResponse), 'tool 结果转成 functionResponse')
    assert(b.tools[0].functionDeclarations[0].name === 'read_file', 'Gemini 工具用 functionDeclarations')
  }

  /* ================================================================
     5b. 模型解析链路(defaultModel 接进运行规格 / GET 不带 Content-Type /
         模型列表的多种返回形状)
     ================================================================ */
  console.log('\n  --- 5b. 模型解析链路:默认模型进 spec / GET 头 / 列表形状 ---')

  /*
   * 这一节拦的是"配好了服务商却说用不了"那个 bug。
   *
   * 断链有**两跳**,少修一跳都还是坏:
   *   ① specFromGraph 只认节点自己的 data.model,设置里的 defaultModel 没进运行规格;
   *   ② runner 调 startNode 时压根没传 model —— 就算 spec 里带了,这一跳也会丢掉。
   * 两跳都断了的话,主进程永远只能退回内置清单第一项,于是每次报"模型名不对"。
   */

  const DM = 'deepseek-reasoner'
  const dmMap = defaultModelMap({ deepseek: { defaultModel: DM } })

  /** 按给定 agentId/model 造一份 spec,只看那一个节点的 model 字段 */
  const specModelOf = (agentId: string | undefined, model: string | undefined, dm?: Record<string, string>): string | undefined => {
    const spec = specFromGraph({
      canvasId: 'c',
      nodes: [{ id: 'N1', data: { kind: 'feature', agentId, model } }],
      edges: [],
      maxParallel: 1,
      inlineLimitBytes: 1024,
      defaultModels: dm,
    })
    return spec.nodes[0]!.model
  }

  // ① 节点没选模型 + 设置里有默认 → spec.model 必须等于 defaultModel
  assert(
    specModelOf('api:deepseek', undefined, dmMap) === DM,
    `节点没选 + 设置有默认 → spec.model 落到设置默认 ${DM}(实际 ${JSON.stringify(specModelOf('api:deepseek', undefined, dmMap))})`,
  )
  assert(
    specModelOf('api:deepseek', '', dmMap) === DM,
    '节点 model 是空串(面板选了"用默认"就存这个)→ 同样落到设置默认',
  )
  assert(
    specModelOf('api:deepseek', '   ', dmMap) === DM,
    '节点 model 只有空白 = 没选,不是"一个叫空白的模型"',
  )

  // ② 【负向对照】节点显式选了 + 设置里也有默认 → 节点的值必须赢
  assert(
    specModelOf('api:deepseek', 'deepseek-chat', dmMap) === 'deepseek-chat',
    `节点显式选的赢过设置默认(实际 ${JSON.stringify(specModelOf('api:deepseek', 'deepseek-chat', dmMap))})`,
  )

  // ③ CLI 型 agent 即使有 defaultModel 也不参与
  assert(specModelOf('claude', undefined, dmMap) === undefined, 'CLI 型 agent → spec.model 仍 undefined')
  assert(
    specModelOf(undefined, undefined, dmMap) === undefined,
    '没有 agentId → spec.model undefined',
  )
  assert(
    specModelOf('api:deepseek', undefined, defaultModelMap({ deepseek: { defaultModel: '' } })) === 'deepseek-chat',
    '设置里默认模型是空串 → 继续回落到内置首选(空串不能当成"用户配了个空模型")',
  )
  assert(
    specModelOf('api:deepseek', undefined, undefined) === 'deepseek-chat',
    '完全不传 defaultModels(老调用方)→ 行为与改动前一致,回内置首选',
  )
  assert(
    specModelOf('api:deepseek', undefined, defaultModelMap({ deepseek: { defaultModel: '  x  ' } })) === 'x',
    'defaultModel 两端空白被 trim(否则会带着空格进请求体)',
  )

  // ④ 换 agent 后 model 被清空这条既有行为:清成空串后回落到"设置默认"而不是旧模型
  assert(
    specModelOf(
      'api:zhipu',
      undefined,
      defaultModelMap({ zhipu: { defaultModel: 'glm-4.6' } }),
    ) === 'glm-4.6',
    '换 agent 后 model 被清空 → 落到新服务商自己的默认,不会带着上一个的模型名跑',
  )

  // defaultModels 是从渲染端传进来的(settings.json 用户能手改),坏值不许把画布搞崩
  assert(
    specModelOf('api:deepseek', undefined, { deepseek: 123 as unknown as string }) === 'deepseek-chat',
    'defaultModels 里是数字(手改坏settings.json)→ 忽略它并回落内置首选,而不是抛异常',
  )
  assert(
    specModelOf('api:deepseek', undefined, { deepseek: null as unknown as string }) === 'deepseek-chat',
    'defaultModels 里是 null → 同样忽略,不抛',
  )

  // ⑤ defaultModelMap 自己:空串必须剔掉,否则 spec 会把"没配"误当成"配了个空模型"
  assert(
    JSON.stringify(defaultModelMap({ a: { defaultModel: '' }, b: { defaultModel: '  ' }, c: { defaultModel: 'm' } })) ===
      JSON.stringify({ c: 'm' }),
    'defaultModelMap 剔掉空串与纯空白项',
  )
  assert(JSON.stringify(defaultModelMap(undefined)) === '{}', 'defaultModelMap(undefined) → 空对象(不抛)')
  assert(JSON.stringify(defaultModelMap({ x: undefined })) === '{}', 'defaultModelMap 容忍 undefined 条目')

  /*
   * ⑥【第二跳】runner 必须把 spec.model 传给 startNode。
   *
   * 上面 ① 证明 spec 里已经有值了,但 runner 那一跳曾经压根不传 model ——
   * 于是 spec 算对了也没用,主进程照样退回内置清单第一项。
   * 这里用**真实的 WorkflowRunner** + 假 env 跑一次,抓 startNode 实际收到的 req。
   */
  {
    const env = new FakeEnv()
    const spec = specFromGraph({
      canvasId: 'e2e-model',
      nodes: [{ id: 'A', data: { kind: 'feature', agentId: 'api:deepseek', model: 'deepseek-chat' } }],
      edges: [],
      maxParallel: 1,
      inlineLimitBytes: 1024,
      defaultModels: dmMap,
      projectDir: CWD,
    })
    await new WorkflowRunner(env).run(spec)
    const req = env.requests.find((r) => r.nodeId === 'A')
    assert(!!req, '真实 runner 确实调了一次 startNode')
    assert(
      req?.model === 'deepseek-chat',
      `runner 把 spec.model 传给了 StartRequest(实际 ${JSON.stringify(req?.model)})—— 少这一行,用户在节点上选的模型会被丢掉`,
    )
    assert(req?.agentId === 'api:deepseek', 'agentId 照常传下去(没被这次改动影响)')
  }

  // ⑥b 节点没选模型时,runner 传下去的应是**设置里的默认**,不是内置首选
  {
    const env = new FakeEnv()
    const spec = specFromGraph({
      canvasId: 'e2e-model2',
      nodes: [{ id: 'B', data: { kind: 'feature', agentId: 'api:deepseek' } }],
      edges: [],
      maxParallel: 1,
      inlineLimitBytes: 1024,
      defaultModels: dmMap,
      projectDir: CWD,
    })
    await new WorkflowRunner(env).run(spec)
    const req = env.requests.find((r) => r.nodeId === 'B')
    assert(
      req?.model === DM,
      `节点没选模型时,runner 传下去的是设置里的默认 ${DM}(实际 ${JSON.stringify(req?.model)})`,
    )
  }

  // ⑥c CLI 型节点不该凭空多出一个 model
  {
    const env = new FakeEnv()
    const spec = specFromGraph({
      canvasId: 'e2e-model3',
      nodes: [{ id: 'C', data: { kind: 'feature', agentId: 'claude' } }],
      edges: [],
      maxParallel: 1,
      inlineLimitBytes: 1024,
      defaultModels: dmMap,
      projectDir: CWD,
    })
    await new WorkflowRunner(env).run(spec)
    const req = env.requests.find((r) => r.nodeId === 'C')
    assert(req !== undefined && req.model === undefined, 'CLI 型节点:model 仍是 undefined(不给下游"模型可换"的错觉)')
  }

  // ⑦ GET /models 不带 Content-Type,POST 仍带(一對,缺一说明改过头或改漏了)
  {
    const anth = providerOfAgent('api:anthropic')!
    const getH = authHeaders(ds, 'sk-abc')
    assert(
      getH['Content-Type'] === undefined,
      'GET /models 不带 Content-Type(带了会被不少网关判非法 → 401/403)',
    )
    assert(getH.Authorization === 'Bearer sk-abc', 'GET 仍然带鉴权头(不能把鉴权也一起去掉)')
    assert(authHeaders(anth, 'sk-a')['Content-Type'] === undefined, 'Anthropic 的 GET 同样不带 Content-Type')
    assert(authHeaders(anth, 'sk-a')['anthropic-version'] === '2023-06-01', 'Anthropic 的 GET 仍带 anthropic-version')

    const postH = jsonHeaders(ds, 'sk-abc')
    assert(postH['Content-Type'] === 'application/json', 'POST /chat 仍带 Content-Type')
    assert(postH.Authorization === 'Bearer sk-abc', 'POST 仍带鉴权头')
    assert(jsonHeaders(anth, 'sk-a')['anthropic-version'] === '2023-06-01', 'Anthropic 的 POST 仍带 anthropic-version')
    // 真实请求构造走一遍:聊天请求必须带 Content-Type
    const chatH = hdr(buildChatRequest({ ...base, provider: ds, baseUrl: ds.baseUrl, messages: [{ role: 'user', content: 'hi' }] }).init)
    assert(chatH['Content-Type'] === 'application/json', 'buildChatRequest 产出的 POST 带 Content-Type')
  }

  // ⑧ toModelDefs 必须认全三种(以上四种)返回形状 —— 中转站裸数组是最高频的漏网
  {
    const openai = toModelDefs({ data: [{ id: 'gpt-4o' }, { id: 'o3' }] }, 'openai')
    assert(openai.length === 2 && openai[0]!.id === 'gpt-4o', 'OpenAI 形状 {data:[{id}]}')

    const gem = toModelDefs(
      { models: [{ name: 'models/gemini-2.5-pro' }, { name: 'models/text-embedding-004' }] },
      'gemini',
    )
    assert(gem.some((m) => m.id === 'gemini-2.5-pro'), 'Gemini 形状 {models:[{name}]},并剥掉 models/ 前缀')
    assert(
      !gem.some((m) => /embedding/i.test(m.id)),
      `embedding 这类不能对话的模型被滤掉(实际 ${gem.map((m) => m.id).join(',')})`,
    )

    // ⚠️ 中转站(One-API / New-API / 自建反代)最常见的形状
    const bare = toModelDefs([{ id: 'deepseek-chat' }, { id: 'glm-4.6' }], 'openai')
    assert(
      bare.length === 2 && bare.map((m) => m.id).join(',') === 'deepseek-chat,glm-4.6',
      `中转站裸数组 [{id}] 也能解析(实际 ${JSON.stringify(bare.map((m) => m.id))})—— 这是"拉不到模型"最高频的成因`,
    )
    const strArr = toModelDefs(['gpt-4o', 'gpt-4o-mini'], 'openai')
    assert(strArr.length === 2, `字符串数组 ["gpt-4o"] 也能解析(实际 ${strArr.length} 条)`)
    assert(toModelDefs({ 未知字段: 1 }, 'openai').length === 0, '完全不认识的东西返回空(不猜、不抛)')
    assert(toModelDefs(null, 'openai').length === 0, 'null → 空')
    assert(toModelDefs(undefined, 'openai').length === 0, 'undefined → 空')
  }

  // ⑨ providerIdOfAgent:查设置用的键(与 providerOfAgent 不同,它不要求服务商已注册)
  assert(providerIdOfAgent('api:deepseek') === 'deepseek', 'providerIdOfAgent 剥出 providerId')
  assert(providerIdOfAgent('claude') === undefined, 'CLI 型 → undefined')
  assert(providerIdOfAgent(undefined) === undefined, 'undefined → undefined')
  assert(providerIdOfAgent('api:') === undefined, '只有前缀没有 id → undefined(不是空串)')
  assert(
    providerIdOfAgent('api:根本没注册这家') === '根本没注册这家',
    '未注册的服务商也要能解出 id —— 否则查不到用户自己配的默认模型',
  )
  assert(
    specModelOf(
      'api:根本没注册这家',
      undefined,
      defaultModelMap({ 根本没注册这家: { defaultModel: 'my-model' } }),
    ) === 'my-model',
    '未注册的服务商 + 设置里有默认 → 仍能落到设置默认(这是"配了却说用不了"的一类)',
  )

  /*
   * ⑩ 拉取失败的文案必须说清"现在是内置清单",且不能误导。
   *
   * 这些 message 是用户在设置页看到的**唯一**线索。逐字钉住关键短语,
   * 免得以后有人把它简化成"拉取失败"四个字 —— 那样用户仍然不知道自己在用内置清单,
   * 还是会等到运行时才撞上 unrecognized_model。
   */
  {
    // 两条回落路径:没填地址 / 连不上(用不可路由端口,确定性地失败,不发真请求)
    const noUrl = await fetchModels({ ...ds, baseUrl: '' }, '', 'sk-1')
    const unreachable = await fetchModels(ds, 'http://127.0.0.1:1/v1', 'sk-1')
    for (const r of [noUrl, unreachable]) {
      assert(r.source === 'builtin', '拉不到时 source 是 builtin(不是 remote —— 别谎报成功)')
      assert(r.models.length === ds.models.length, '回落时给的是内置清单(不是空数组)')
      assert(
        (r.message ?? '').includes('内置清单'),
        `回落文案明确写出「内置清单」(实际 ${JSON.stringify(r.message)})—— 用户靠这几个字判断有没有真拉到`,
      )
      assert(
        !(r.message ?? '').includes('成功'),
        `回落文案里不能出现"成功"(会让人以为拉到了真列表,实际 ${JSON.stringify(r.message)})`,
      )
    }
    assert(
      (noUrl.message ?? '').includes('Base URL'),
      `没填地址时说的是"还缺 Base URL",不是含糊的"拉取失败"(实际 ${JSON.stringify(noUrl.message)})`,
    )
    assert(
      (unreachable.message ?? '').includes('拉取失败'),
      '连不上时明说是"拉取失败"',
    )
  }

  /* ================================================================
     6. 流式解析:三家报文 → 统一 StreamChunk
     ================================================================ */
  console.log('\n  --- 6. 流式解析:OpenAI 增量 / 思维链 / 工具碎片 ---')

  {
    const chunks = parseChunk('openai', {
      choices: [{ delta: { content: '你' }, finish_reason: null }],
    })
    assert(chunks.length === 1 && chunks[0]!.k === 'text' && (chunks[0] as any).text === '你', 'OpenAI delta.content → text')

    const r = parseChunk('openai', { choices: [{ delta: { reasoning_content: '想' } }] })
    assert(r[0]?.k === 'reasoning', 'OpenAI reasoning_content → reasoning')

    const r2 = parseChunk('openai', { choices: [{ delta: { reasoning: '想' } }] })
    assert(r2[0]?.k === 'reasoning', 'OpenAI reasoning(别名)→ reasoning')

    const t = parseChunk('openai', {
      choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_a', function: { name: 'read_file', arguments: '{"pa' } }] } }],
    })
    assert(t[0]?.k === 'tool_delta' && (t[0] as any).index === 1, 'tool_calls 的 index 被保留(靠它拼回同一次调用)')
    assert((t[0] as any).id === 'call_a' && (t[0] as any).name === 'read_file', 'id/name 分片被取出')

    const t2 = parseChunk('openai', { choices: [{ delta: { tool_calls: [{ function: { arguments: 'th"}' } }] } }] })
    assert(t2[0]?.k === 'tool_delta' && (t2[0] as any).index === 0, '报文省略 index 时默认为 0')

    const f = parseChunk('openai', { choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
    assert(f[0]?.k === 'finish' && (f[0] as any).reason === 'tool_calls', 'finish_reason → finish')

    const u = parseChunk('openai', { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } })
    assert(u[0]?.k === 'usage' && (u[0] as any).inputTokens === 10, 'usage → usage')

    const e = parseChunk('openai', { error: { message: 'rate limited' } })
    assert(e[0]?.k === 'error' && (e[0] as any).message.includes('rate limited'), '200 报文里夹的 error 被识别')
  }

  console.log('\n  --- 7. 流式解析:Anthropic 块事件 ---')

  {
    const a1 = parseChunk('anthropic', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } })
    assert(a1[0]?.k === 'text' && (a1[0] as any).text === '好', 'text_delta → text')

    const a2 = parseChunk('anthropic', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '嗯' } })
    assert(a2[0]?.k === 'reasoning', 'thinking_delta → reasoning')

    const a3 = parseChunk('anthropic', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu_9', name: 'run_command' } })
    assert(a3[0]?.k === 'tool_delta' && (a3[0] as any).id === 'tu_9' && (a3[0] as any).index === 2, 'content_block_start(tool_use)→ tool_delta')

    const a4 = parseChunk('anthropic', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"a":' } })
    assert(a4[0]?.k === 'tool_delta' && (a4[0] as any).args === '{"a":', 'input_json_delta → tool_delta.args')

    const a5 = parseChunk('anthropic', { type: 'message_delta', usage: { output_tokens: 7 }, delta: { stop_reason: 'end_turn' } })
    assert(a5.some((c) => c.k === 'usage') && a5.some((c) => c.k === 'finish'), 'message_delta 同时给 usage 与 finish')

    const a6 = parseChunk('anthropic', { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } })
    assert(a6[0]?.k === 'usage' && (a6[0] as any).inputTokens === 5, 'message_start 带 input usage')

    const a7 = parseChunk('anthropic', { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } })
    assert(a7[0]?.k === 'error', '流中途 error 事件被识别(200 之后也会出错)')

    const a8 = parseChunk('anthropic', { type: 'ping' })
    assert(a8.length === 0, '未知事件类型被安全忽略(不炸、不产生垃圾)')
  }

  console.log('\n  --- 8. 流式解析:Gemini parts / functionCall ---')

  {
    const g1 = parseChunk('gemini', { candidates: [{ content: { parts: [{ text: '嗨' }] } }] })
    assert(g1[0]?.k === 'text' && (g1[0] as any).text === '嗨', 'parts[].text → text')

    const g2 = parseChunk('gemini', { candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'a' } } }] } }] })
    assert(g2[0]?.k === 'tool_delta' && (g2[0] as any).name === 'read_file', 'functionCall → tool_delta(name)')
    assert(JSON.parse((g2[0] as any).args).path === 'a', 'Gemini 的 args 是对象,被序列化成串')

    const g3 = parseChunk('gemini', {
      candidates: [
        { content: { parts: [{ functionCall: { name: 'a', args: {} } }, { functionCall: { name: 'b', args: {} } }] } },
      ],
    })
    const idx = g3.filter((c) => c.k === 'tool_delta').map((c) => (c as any).index)
    assert(idx[0] === 0 && idx[1] === 1, `同报文的多个 functionCall 各自编号(实际 ${idx.join(',')})`)

    const g4 = parseChunk('gemini', { candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 9 } })
    assert(g4.some((c) => c.k === 'finish') && g4.some((c) => c.k === 'usage'), 'finishReason + usageMetadata 都被取出')
  }

  console.log('\n  --- 9. 对抗:畸形 / 恶意报文不得让解析器抛异常 ---')

  {
    const bad: unknown[] = [
      null,
      undefined,
      'a string',
      42,
      [],
      {},
      { choices: 'not-an-array' },
      { choices: [null] },
      { choices: [{ delta: 'not-an-object' }] },
      { choices: [{ delta: { tool_calls: 'nope' } }] },
      { candidates: [{ content: { parts: 'nope' } }] },
      { candidates: [{ content: { parts: [null, 1, 'x'] } }] },
      { error: null },
      { error: { nested: { deep: { unknown: true } } } },
    ]
    let threw = ''
    for (const proto of ['openai', 'anthropic', 'gemini'] as const) {
      for (const o of bad) {
        try {
          const out = parseChunk(proto, o)
          if (!Array.isArray(out)) {
            threw = `${proto} 返回了非数组`
            break
          }
        } catch (e) {
          threw = `${proto} 对 ${JSON.stringify(o) ?? String(o)} 抛了:${(e as Error).message}`
          break
        }
      }
    }
    assert(threw === '', `三种协议 × ${bad.length} 个畸形报文全部安全返回(实际 ${threw || '无异常'})`)

    /*
     * error 的形状各家不一:可能是字符串、{message}、{type,message},也可能整个缺失。
     * 契约是"无论如何都要给出一句非空说明" —— 空着的话用户只看到一个红框、
     * 不知道发生了什么,那比不报错还糟。
     */
    const ue = parseChunk('openai', { error: { weird: true } })
    assert(
      ue.length === 1 && ue[0]!.k === 'error' && String((ue[0] as any).message).length > 0,
      '未知形状的 error 也给出非空说明',
    )
    const ue2 = parseChunk('anthropic', { type: 'error' })
    assert((ue2[0] as any)?.message === '未知错误', 'error 字段整个缺失 → 兜底为「未知错误」')
    const ue3 = parseChunk('gemini', { error: 'quota exceeded' })
    assert((ue3[0] as any)?.message === 'quota exceeded', 'error 是纯字符串时原样带回')
  }

  /* ================================================================
     10. 工具集:plan 模式必须"看不见"写工具
     ================================================================ */
  console.log('\n  --- 10. 工具集:plan 只暴露只读(而不是事后拒绝) ---')

  {
    const plan = toolsFor('plan').map((t) => t.name)
    const edit = toolsFor('acceptEdits').map((t) => t.name)
    assert(!plan.includes('write_file') && !plan.includes('edit_file'), 'plan 模式不含任何写工具')
    assert(!plan.includes('run_command'), 'plan 模式不含 run_command(否则等于给了整台机器)')
    assert(plan.includes('read_file') && plan.includes('list_dir'), 'plan 模式仍能读文件/列目录')
    assert(
      edit.includes('write_file') && edit.includes('edit_file') && edit.includes('run_command'),
      'acceptEdits 模式才放出写与执行',
    )
    assert(
      toolsFor('dontAsk').length === edit.length,
      'dontAsk 与 acceptEdits 同档(API 侧没有交互确认通道,文档已说明)',
    )
    for (const t of TOOLS) {
      assert(typeof t.name === 'string' && typeof t.parameters === 'object', `工具 ${t.name} 有名字与 JSON Schema 参数`)
    }
  }

  /* ================================================================
     11. 路径围栏
     ================================================================ */
  console.log('\n  --- 11. 路径围栏:穿越 / 绝对路径 / UNC / 设备名 / NUL / 符号链接 ---')

  {
    const ROOT = path.join(os.tmpdir(), `haowan-api-fence-${Date.now().toString(36)}`)
    const OUTSIDE = path.join(os.tmpdir(), `haowan-api-outside-${Date.now().toString(36)}`)
    await fs.mkdir(ROOT, { recursive: true })
    await fs.mkdir(OUTSIDE, { recursive: true })
    await fs.writeFile(path.join(ROOT, 'ok.txt'), 'hello', 'utf8')

    try {
      const okCase = resolveInsideRoot(ROOT, 'ok.txt')
      assert(okCase.ok === true, '根内的普通相对路径通过')
      const okNested = resolveInsideRoot(ROOT, path.join('sub', 'deep', 'new.txt'))
      assert(okNested.ok === true, '根内还不存在的嵌套新文件也通过(写新文件要靠它)')

      const cases: [string, string][] = [
        ['../../etc/passwd', '相对穿越'],
        ['..', '退到父目录'],
        ['a/../../../../../../x', '多级回退后越界'],
        [path.join(ROOT, '..', 'evil.txt'), '../ 拼出的兄弟目录'],
        ['/etc/passwd', 'POSIX 绝对路径'],
        ['C:\\Windows\\System32\\drivers\\etc\\hosts', 'Windows 绝对路径'],
        ['\\\\server\\share\\x.txt', 'UNC 路径'],
        ['//server/share/x', '双斜杠 UNC'],
        ['x\0.txt', 'NUL 字节注入'],
        ['', '空路径'],
      ]
      for (const [input, label] of cases) {
        const r = resolveInsideRoot(ROOT, input)
        assert(r.ok === false, `拒绝 ${label}:${JSON.stringify(input)}`)
      }
      assert(resolveInsideRoot(ROOT, 123 as unknown as string).ok === false, '非字符串路径被拒')

      if (process.platform === 'win32') {
        /*
         * 设备名必须**逐段**拦。只看第一段的实现会让 `sub/NUL.txt` 漏过去,
         * 而 Win32 按路径分量识别设备名 —— 那正是"能写到哪个名字"的能力边界。
         */
        const devCases: [string, string][] = [
          ['CON', '顶层 CON'],
          ['NUL', '顶层 NUL'],
          ['sub/NUL.txt', '嵌套段里的 NUL.txt'],
          ['sub\\deep\\CON', '嵌套段里的 CON'],
          ['NUL.txt', '带扩展名的 NUL(Windows 忽略扩展名)'],
          ['NUL.', '结尾点被 Windows 剥掉后仍是 NUL'],
          ['NUL ', '结尾空格被 Windows 剥掉后仍是 NUL'],
          ['COM1', '串口设备'],
          ['LPT1', '并口设备'],
          ['aux/log.txt', '小写 aux 段'],
        ]
        for (const [input, label] of devCases) {
          const r = resolveInsideRoot(ROOT, input)
          assert(r.ok === false, `拒绝 Windows 设备名 ${label}:${JSON.stringify(input)}`)
        }
        // 负向对照:长得像但不是设备名的必须放行,否则就是在误伤正常文件名
        for (const keep of ['console.txt', 'com10.txt', 'nulls.md', 'auxiliary/notes.txt', 'lpt.txt']) {
          const r = resolveInsideRoot(ROOT, keep)
          assert(r.ok === true, `放行正常文件名(不是设备名):${keep}`)
        }
      } else {
        skip('Windows 设备名拦截', '当前不是 win32')
      }

      // 符号链接逃逸:resolve 看不出异常,只有 realpath 能拦。
      // Windows 上目录 junction 不需要管理员权限,失败则如实 SKIP。
      const linkPath = path.join(ROOT, 'escape')
      let linked = false
      try {
        await fs.symlink(OUTSIDE, linkPath, 'junction')
        linked = true
      } catch {
        try {
          await fs.symlink(OUTSIDE, linkPath, 'dir')
          linked = true
        } catch {
          linked = false
        }
      }
      if (linked) {
        const esc = resolveInsideRoot(ROOT, 'escape/evil.txt')
        assert(esc.ok === false, '符号链接指向根外 → realpath 后被拦下')
        const esc2 = resolveInsideRoot(ROOT, path.join('escape', '..', 'escape', 'x.txt'))
        assert(esc2.ok === false, '绕行路径同样被 realpath 拦下')
      } else {
        skip('符号链接逃逸拦截', '当前环境不允许创建链接(需权限)')
      }
    } finally {
      await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {})
      await fs.rm(OUTSIDE, { recursive: true, force: true }).catch(() => {})
    }
  }

  /* ================================================================
     12. 历史裁剪:不许切散 assistant↔tool 的配对
     ================================================================ */
  console.log('\n  --- 12. 历史裁剪:配对边界 / 单条超长 ---')

  {
    // 130 条,超过 120 的条数上限;第 10 条是 tool → 切口必须往前退
    const msgs: ChatMessage[] = []
    for (let i = 0; i < 130; i++) {
      msgs.push({ role: i === 10 ? 'tool' : 'user', content: `m${i}`, toolCallId: i === 10 ? 'c1' : undefined })
    }
    const out = trimHistory(msgs)
    /*
     * 切口本来落在 index 10(130-120),而那一条是 tool —— 必须往前退一格到 9。
     * 断言首条恰好是 m9:既证明裁剪发生了,又证明它没有停在"孤立 tool 结果"上。
     * (结果是 121 条而不是 120,配对安全优先于严格上限,这是有意的。)
     */
    assert(out.length < msgs.length, `确实发生了裁剪(实际 ${out.length}/${msgs.length})`)
    assert(out[0]!.role === 'user' && out[0]!.content === 'm9', `切口退到配对边界(实际首条 ${out[0]!.content}/${out[0]!.role})`)

    // 正常情况:短历史原样返回
    const small: ChatMessage[] = [{ role: 'user', content: 'hi' }]
    assert(trimHistory(small).length === 1, '短历史不被裁剪')

    // 单条超长(tool 结果最容易超)
    const huge: ChatMessage[] = [{ role: 'tool', content: 'x'.repeat(70_000), toolCallId: 'c' }]
    const h = trimHistory(huge)
    assert(h[0]!.content.length < 70_000, `单条超长被截断(实际 ${h[0]!.content.length})`)
    assert(h[0]!.content.includes('已截断'), '截断处留下标记(用户知道内容不全)')

    // 总长度超限时必须从头部丢,且保留最近的
    const many: ChatMessage[] = []
    for (let i = 0; i < 20; i++) many.push({ role: 'user', content: `u${i}-`.padEnd(30_000, 'z') })
    const t = trimHistory(many)
    assert(t.length < 20, `总长度超限时从头部丢(实际剩 ${t.length})`)
    assert(t[t.length - 1]!.content.startsWith('u19-'), '最近的一条被保留')
  }

  /* ================================================================
     13. 节点下拉的数据源:CLI 与 API 混装,分组/能力/Key 就绪态
     ================================================================ */
  console.log('\n  --- 13. agentListEntries:CLI 与 API 混装成一个列表 ---')

  {
    const entries = agentListEntries()
    const cli = entries.filter((e) => e.kind === 'cli')
    const api = entries.filter((e) => e.kind === 'api')

    assert(cli.length >= 1 && api.length === PROVIDERS.length, `${cli.length} 个 CLI + ${api.length} 个服务商`)
    assert(
      new Set(entries.map((e) => e.id)).size === entries.length,
      '下拉里没有重复 id(重复会让选中项行为诡异)',
    )
    assert(
      entries.every((e) => e.groupLabel.length > 0),
      '每一项都有分组标题(UI 直接拿它开 optgroup,不自己判断分组)',
    )
    assert(entries[0]?.kind === 'cli', 'CLI 排在前面(本机工具是默认心智)')
    assert(
      api.every((e) => e.id.startsWith('api:') && e.providerId && e.id === `api:${e.providerId}`),
      'API 项的 id 与 providerId 自洽',
    )
    // 本地/自定义服务商不需要 Key,不能被标成"未配 Key"
    for (const id of ['ollama', 'lmstudio', 'custom']) {
      const e = api.find((x) => x.providerId === id)
      assert(e?.keyReady === true, `${id} 无 Key 也标记为可用(optionalKey 生效)`)
    }
    // 需要 Key 的:没有 Key 时必须如实报告,但**依然出现在列表里**
    assert(
      providerOfAgent(api.find((x) => x.providerId === 'deepseek')!.id) !== null,
      '没配 Key 的付费服务商仍留在下拉里(否则用户不知道有它可用)',
    )
    assert(
      api.every((e) => e.kind !== 'api' || e.capabilities.tools === true),
      'API 型声明有工具能力(能改代码干活是这次的硬要求)',
    )
    /*
     * 实测标记必须如实。第三方 CLI 的启动参数会随版本变,若不标注,
     * 一旦跑不通用户只会以为是自己的配置错了 —— 那是把我们的不确定性推给他。
     */
    assert(cli.find((e) => e.id === 'claude')?.verified === true, 'claude 标记为已实测')
    assert(
      cli.filter((e) => e.id !== 'claude').every((e) => e.verified === false),
      '其余 CLI(含腾讯 CodeBuddy)如实标记为未实测',
    )
    assert(api.every((e) => e.verified === undefined), 'API 型没有"实测"这个概念,不打标记')
  }
}

/* ================================================================
   T29 · 模型自动识别:返回形状兼容 / 去重 / 不误伤 / 地址真的被用
   ================================================================

   用户的原话是"让模型可以自动识别 api 的模型是哪个版本",而他实际遇到的
   症状是"配置了服务商却拉不到模型"。这两句话之间隔着一条真实的因果链:

     服务端返回了列表 → toModelDefs 认得那个形状 → 过滤没滤掉能用的 →
     fetchModels 用了用户填的地址 → message 说清了现在显示的是什么

   链上**任何一环断了,用户看到的都是同一句话**:下拉框里那一份内置清单。
   而内置清单里没有他要的模型 → 运行时 `unrecognized_model`。
   "配置看着没问题,就是跑不起来"就是这么来的。

   所以这一节把整条链拆成可断言的段,每段钉死一个失效点。
   全部走假 fetch,**零网络、零 token**,故本节零 SKIP。
*/
async function modelDiscoveryTests(): Promise<void> {
  const ds = providerOfAgent('api:deepseek')!
  const gem = providerOfAgent('api:gemini')!

  /* ================================================================
     29.1 返回形状:五种都得认出来
     ================================================================
     `toModelDefs` 认不出的形状,症状与"服务端没返回列表"**完全一样**
     (回落内置清单 + 一句"没找到列表")。所以每种形状都要单独钉住。
  */
  console.log('\n  --- 29.1 返回形状:裸数组 / 字符串数组 / data / models / result ---')

  // ① 裸数组 —— 中转站(One-API / New-API / 自建反代)最常见,也是修复前的主要缺口
  {
    const bare = toModelDefs([{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }], 'openai')
    assert(
      bare.length === 2,
      `裸数组 [{id}] 认得出 2 条(实际 ${bare.length} 条:${JSON.stringify(bare.map((m) => m.id))})`,
    )
    assert(bare[0]!.id === 'gpt-4o', '裸数组原样取出 id')
  }

  // ② 字符串数组 —— 数组里直接就是模型名,按"元素必是对象"取字段会全落空
  {
    const strs = toModelDefs(['a', 'b'], 'openai')
    assert(strs.length === 2, `字符串数组 ["a","b"] 认得出 2 条(实际 ${strs.length})`)
    assert(
      strs.every((m) => m.id === m.label),
      '字符串数组没有显示名,label 退回 id(而不是空串)',
    )
  }
  {
    const wrapped = toModelDefs({ models: ['gpt-4o', 'gpt-4o-mini'] }, 'gemini')
    assert(
      wrapped.length === 2,
      `{models:["字符串"]} 认得出 2 条(实际 ${wrapped.length} 条:${JSON.stringify(wrapped.map((m) => m.id))})`,
    )
  }

  // ③ OpenAI 官方形状(防回归:这是本来就对的那条,不能被新分支挤掉)
  {
    const data = toModelDefs({ data: [{ id: 'gpt-4o' }] }, 'openai')
    assert(data.length === 1 && data[0]!.id === 'gpt-4o', '{data:[{id}]} 仍认得(防回归)')
  }
  {
    // 有的网关把 id 叫 name —— 只认 id 就会整批丢失
    const byName = toModelDefs({ data: [{ name: 'gpt-4o' }] }, 'openai')
    assert(byName.length === 1 && byName[0]!.id === 'gpt-4o', '{data:[{name}]} 也认得(id 字段被叫 name)')
  }
  {
    const r = toModelDefs({ result: [{ id: 'gpt-4o' }] }, 'openai')
    assert(r.length === 1, '{result:[…]} 套一层信封也认得')
  }

  // ④ Gemini:必须剥掉 `models/` 前缀(请求时要的是不带前缀的名字)
  {
    const g = toModelDefs({ models: [{ name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' }] }, 'gemini')
    assert(g.length === 1 && g[0]!.id === 'gemini-2.5-pro', 'Gemini 剥掉 models/ 前缀(防回归)')
    assert(g[0]!.label === 'Gemini 2.5 Pro', 'Gemini 的 displayName 留作显示名')
  }

  /*
   * ⑤ 认不出来就返回空,**绝不猜**。
   * 猜出来的模型名会被原样发给 API,那比"回落内置清单"坏得多:
   * 前者让用户看到一条看不懂的运行时错误,后者至少还能用。
   */
  {
    assert(toModelDefs(null, 'openai').length === 0, 'null → 空,不抛')
    assert(toModelDefs('字符串', 'openai').length === 0, '整个响应是字符串 → 空,不猜')
    assert(toModelDefs({}, 'openai').length === 0, '空对象 → 空')
    assert(toModelDefs({ foo: 'bar' }, 'openai').length === 0, '认不出的信封 → 空(不乱取字段)')
    assert(toModelDefs([{ nope: 1 }], 'openai').length === 0, '数组元素没有 id/name → 跳过')
  }

  /* ================================================================
     29.2 去重:同一模型绝不能出现两条
     ================================================================
     不去重的后果不是"多一行",而是下拉框里两个一模一样的选项,
     用户会以为是两个不同的模型,选中其中"另一个"然后拿到 404。
  */
  console.log('\n  --- 29.2 去重:id/name 同义 / 大小写 / models 前缀 / 双信封 ---')

  {
    const same = toModelDefs({ data: [{ id: 'x', name: 'x' }] }, 'openai')
    assert(same.length === 1, `{data:[{id:"x",name:"x"}]} 出 1 条不是 2 条(实际 ${same.length})`)
  }
  {
    // 同一家的响应里 data 与 models 常同时存在且大量重叠
    const both = toModelDefs({ data: [{ id: 'gpt-4o' }], models: [{ id: 'gpt-4o' }, { id: 'o3' }] }, 'openai')
    assert(
      both.length === 2,
      `data 与 models 同时存在时合并且去重,出 2 条(实际 ${both.length}:${JSON.stringify(both.map((m) => m.id))})`,
    )
  }
  {
    const pfx = toModelDefs({ models: [{ name: 'models/gemini-2.5-pro' }, { id: 'gemini-2.5-pro' }] }, 'gemini')
    assert(pfx.length === 1, '`models/x` 与 `x` 认作同一个,出 1 条(实际 ' + pfx.length + ')')
  }
  {
    const cased = toModelDefs({ data: [{ id: 'GPT-4o' }, { id: 'gpt-4o' }] }, 'openai')
    assert(cased.length === 1, '仅大小写不同的两个 id 合成一条(实际 ' + cased.length + ')')
    // ⚠️ 下发到 API 的必须保留**原始** id 大小写,不能被归一化改写
    assert(cased[0]!.id === 'GPT-4o', `下发 id 保留服务端原样的大小写(实际 ${cased[0]!.id})`)
  }
  {
    // 显示名不许被第二遍改写:有的网关 name 只是显示名,有的语义完全不同
    const keep = toModelDefs({ data: [{ id: 'gpt-4o', display_name: 'GPT-4o' }, { id: 'gpt-4o', display_name: 'X' }] }, 'openai')
    assert(keep[0]!.label === 'GPT-4o', '重复项不覆盖先到的显示名(实际 ' + keep[0]!.label + ')')
  }

  /* ================================================================
     29.3 不误伤:能对话的一个都不能滤掉(负向对照,最重要的一节)
     ================================================================
     过滤的代价是不对称的:滤多了模型从下拉消失、用户彻底用不了;
     滤少了只是多几行噪声。所以这一节全用**真实存在的对话模型 id** 做对照,
     任何一条挂了都意味着"有个用户会发现他的模型不见了"。
  */
  console.log('\n  --- 29.3 不误伤:真实对话模型必须全部保留 ---')

  const CHAT_MUST_KEEP = [
    // 官方
    'gpt-4o', 'gpt-4o-mini', 'gpt-5', 'gpt-5-mini', 'o3', 'o4-mini',
    'claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5',
    'gemini-2.5-pro', 'gemini-2.5-flash', 'gemma-3-27b-it',
    // 国内
    'deepseek-chat', 'deepseek-reasoner', 'qwen3-coder-plus', 'qwen-max',
    'glm-4.6', 'kimi-k2-turbo-preview', 'hunyuan-turbos-latest',
    // 聚合站(模型名带厂商前缀与斜杠,是最容易误伤的形态)
    'anthropic/claude-sonnet-4.5', 'openai/gpt-5', 'google/gemini-2.5-pro',
    'deepseek-ai/DeepSeek-V3', 'moonshotai/kimi-k2-instruct',
    'Qwen/Qwen3-235B-A22B-Instruct-2507',
    // 本地(Ollama 风格:name 家族 + 冒号 tag)
    'qwen3:8b', 'deepseek-r1:7b', 'llama-3.3-70b-versatile',
    // 多模态:能对话,绝不能因为名字里有 voice/vision 就滤掉
    'gpt-4o-audio-preview', 'gpt-4-vision-preview', 'qwen2.5-vl-72b-instruct',
    'gemini-2.5-flash-image',
    // 中转站常见的"厂商私有命名",靠白名单一定会被误杀
    'my-gateway-chat-v2', 'internal-llm-prod',
  ]
  {
    const kept = toModelDefs(CHAT_MUST_KEEP.map((id) => ({ id })), 'openai')
    const lost = CHAT_MUST_KEEP.filter((id) => !kept.some((m) => m.id === id))
    assert(
      lost.length === 0,
      `${CHAT_MUST_KEEP.length} 个真实对话模型全部保留,一个都没被误伤(误伤:${lost.join(',') || '无'})`,
    )
  }
  {
    /*
     * ⚠️ 改前这里用的是白名单 `^(gemini|gemma)`,意味着"中转站用 Gemini 协议
     * 转 OpenAI 模型"时用户会一个模型都看不到。这条断言钉住新行为。
     */
    const viaGemini = toModelDefs({ models: [{ name: 'models/gpt-4o' }, { name: 'models/gemini-2.5-pro' }] }, 'gemini')
    assert(
      viaGemini.length === 2,
      'gemini 协议下不认识前缀的模型不再被白名单滤掉(实际 ' + viaGemini.length + ' 条)',
    )
  }

  /* ================================================================
     29.4 非对话模型要被滤掉(否则用户在一堆 embedding 里挑花眼)
     ================================================================
     滤这些不是为了列表好看,是因为它们**能列出但不能聊**:
     选中的表现是运行时 400/404 —— 又是一次"配置没问题却跑不起来"。
  */
  console.log('\n  --- 29.4 非对话模型过滤:embedding / 语音 / 图像 / 审核 ---')

  const MUST_DROP = [
    'text-embedding-3-large', 'text-embedding-ada-002', 'nomic-embed-text',
    'bge-m3', 'gte-base', 'bge-reranker-v2-m3',
    'whisper-1', 'tts-1', 'text-to-speech-1',
    'dall-e-3', 'stable-diffusion-xl', 'imagen-3.0-generate-001',
    'omni-moderation-latest', 'text-moderation-stable',
  ]
  {
    const left = toModelDefs(MUST_DROP.map((id) => ({ id })), 'openai')
    const survived = MUST_DROP.filter((id) => left.some((m) => m.id === id))
    assert(
      survived.length === 0,
      `${MUST_DROP.length} 个非对话模型全部被滤掉(漏网:${survived.join(',') || '无'})`,
    )
  }
  {
    const g = toModelDefs(
      { models: [{ name: 'models/text-embedding-004' }, { name: 'models/gemini-embedding-exp' }] },
      'gemini',
    )
    assert(g.length === 0, 'Gemini 的 embedding / aqa 类同样被滤掉(实际留下 ' + g.length + ' 条)')
  }
  {
    // 混合场景:滤掉的只是非对话那部分,能用的必须留下
    const mixed = toModelDefs(
      { data: [{ id: 'gpt-4o' }, { id: 'text-embedding-3-large' }, { id: 'whisper-1' }] },
      'openai',
    )
    assert(
      mixed.length === 1 && mixed[0]!.id === 'gpt-4o',
      '混合列表里只留下对话模型(实际 ' + JSON.stringify(mixed.map((m) => m.id)) + ')',
    )
  }

  /* ================================================================
     29.5 拉取链路:假 fetch 拦住,验证 URL / source / message
     ================================================================
     绝不发真网络请求 —— 一是慢,二是会把 CI 的网络当成被测对象。
     装的是全局 fetch,`fetchModels` 内部走 `fetchWithTimeout` → `fetch`,
     所以拦全局就拦得住。
  */
  console.log('\n  --- 29.5 拉取链路:用的是不是用户填的地址 / source / message ---')

  /** 装一个只回固定报文的假 fetch,并记录它收到的 URL 与 headers */
  const stubFetch = (payload: unknown, status = 200): { urls: string[]; restore: () => void } => {
    const urls: string[] = []
    const g = globalThis as unknown as { fetch: unknown }
    const orig = g.fetch
    g.fetch = async (url: unknown) => {
      urls.push(String(url))
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      } as Response
    }
    return { urls, restore: () => { g.fetch = orig } }
  }

  // ① 用户改过地址 → 请求必须打到**他那个**地址,不是内置地址
  {
    const MINE = 'https://my-own-gateway.example.com/v1'
    const { urls, restore } = stubFetch({ data: [{ id: 'gpt-4o' }] })
    const r = await fetchModels(ds, MINE, 'sk-test')
    restore()
    assert(urls[0] === `${MINE}/models`, `用户填的地址真的被用(实际请求 ${urls[0]})`)
    assert(
      urls[0] !== `${ds.baseUrl}/models`,
      '没有偷偷回落到内置地址(用户改过地址时必须打他自己的服务端)',
    )
    assert(r.source === 'remote', '拉到就标 remote')
    assert(r.models[0]!.id === 'gpt-4o', '拉到的是服务端那份,不是内置清单')
    assert(!!r.message && r.message.includes(MINE), '成功时 message 回显了实际用的地址')
  }
  {
    // 地址带尾部斜杠 / 纯空白:空白回落内置,斜杠不能拼出 //
    const { urls, restore } = stubFetch({ data: [] })
    await fetchModels(ds, '   ', 'sk-test')
    restore()
    assert(urls[0] === `${ds.baseUrl}/models`, `纯空白地址回落内置(实际 ${urls[0]})`)
  }
  {
    const { urls, restore } = stubFetch({ data: [] })
    await fetchModels(ds, 'https://x.example.com/v1///', 'sk-test')
    restore()
    assert(!urls[0]!.includes('//models'), `尾部斜杠被理顺(实际 ${urls[0]})`)
  }
  {
    // 自定义服务商还没填地址 → 根本不该发请求
    const custom = providerOfAgent('api:custom')!
    const { urls, restore } = stubFetch({ data: [] })
    const r = await fetchModels(custom, '', '')
    restore()
    assert(urls.length === 0, '没填地址时一个请求都不该发(实际发了 ' + urls.length + ' 个)')
    assert(r.source === 'builtin', '没填地址 → builtin')
    assert(!!r.message && r.message.includes('内置清单'), '没填地址时 message 说清了在用内置清单')
  }

  // ② 裸数组走完整链路(修前这里是 0 条 → 回落内置清单,现修)
  {
    const { restore } = stubFetch([{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }])
    const r = await fetchModels(ds, 'https://g.example.com/v1', 'sk-test')
    restore()
    assert(
      r.source === 'remote' && r.models.length === 2,
      `裸数组走完整链路也是 remote/2 条(实际 ${r.source}/${r.models.length})`,
    )
  }

  // ③ source 两种取值下 message 分别长什么样
  {
    const { restore } = stubFetch({ data: [{ id: 'gpt-4o' }] })
    const r = await fetchModels(ds, 'https://g.example.com/v1', 'sk-test')
    restore()
    console.log(`  [remote] ${r.message}`)
    assert(!!r.message && r.message.includes('已拉'), 'remote 的 message 明说"已拉取"')
    assert(!!r.message && !r.message.includes('失败'), 'remote 的 message 不说"失败"')
  }
  {
    const { restore } = stubFetch({ nope: 1 })
    const r = await fetchModels(ds, 'https://g.example.com/v1', 'sk-test')
    restore()
    console.log(`  [builtin-无列表] ${r.message}`)
    assert(r.source === 'builtin', '认不出形状 → builtin')
    assert(!!r.message && r.message.includes('内置清单'), 'builtin 的 message 明说"内置清单"')
    assert(!!r.message && r.message.includes('手填'), 'builtin 的 message 给出下一步(手填模型名)')
  }

  // ④ 读到了但全被过滤 —— 必须说清"读到了 N 个",而不是笼统的"没找到"
  {
    const { restore } = stubFetch({ data: [{ id: 'text-embedding-3-large' }, { id: 'whisper-1' }] })
    const r = await fetchModels(ds, 'https://g.example.com/v1', 'sk-test')
    restore()
    console.log(`  [全被过滤] ${r.message}`)
    assert(r.source === 'builtin', '全被过滤 → builtin(修前这里是 remote 且 message 为 undefined)')
    assert(!!r.message && r.message.includes('2'), '说清了服务端返回了几个(实际 message:' + r.message + ')')
    assert(!!r.message && r.message.includes('都不是对话模型'), '区分开"没读到"与"读到但全被过滤"')
    assert(!!r.message && r.message.includes('手填'), '给出下一步动作')
  }

  // ⑤ 401/403 → 提示 Key 并附申请地址;404 → 提示 /v1
  {
    const { restore } = stubFetch({ error: 'Unauthorized' }, 401)
    const r = await fetchModels(ds, 'https://g.example.com/v1', 'sk-test')
    restore()
    console.log(`  [401] ${r.message}`)
    assert(!!r.message && r.message.includes('Key'), '401 的 message 点名 Key')
    assert(!!r.message && r.message.includes(String(ds.keyUrl)), '401 的 message 附上申请地址')
  }
  {
    const { restore } = stubFetch({ error: 'forbidden' }, 403)
    const r = await fetchModels(ds, 'https://g.example.com/v1', 'sk-test')
    restore()
    assert(!!r.message && r.message.includes('Key'), '403 走同一条 Key 提示(不是笼统报错)')
  }
  {
    const { restore } = stubFetch({ error: 'not found' }, 404)
    const r = await fetchModels(ds, 'https://g.example.com/v1', 'sk-test')
    restore()
    console.log(`  [404] ${r.message}`)
    assert(!!r.message && r.message.includes('/v1'), '404 的 message 提示 /v1(最高频的错)')
    assert(!!r.message && r.message.includes('手填'), '404 的 message 也给出兜底动作')
  }
  {
    // 没填 Key 时额外提醒 —— 401 最常见的原因就是这个
    const { restore } = stubFetch({ error: 'Unauthorized' }, 401)
    const r = await fetchModels(ds, 'https://g.example.com/v1', '')
    restore()
    assert(!!r.message && r.message.includes('还没填 API Key'), '没填 Key 时提醒填 Key')
  }
  {
    const { restore } = stubFetch({ error: 'boom' }, 500)
    const r = await fetchModels(ds, 'https://g.example.com/v1', 'sk-test')
    restore()
    assert(!!r.message && r.message.includes('服务商侧'), '5xx 说清不是用户的配置问题')
  }

  // ⑥ 连不上(网络层)—— 措辞必须与 HTTP 层区分开
  {
    const g = globalThis as unknown as { fetch: unknown }
    const orig = g.fetch
    g.fetch = async () => { throw new Error('ECONNREFUSED') }
    const r = await fetchModels(ds, 'https://g.example.com/v1', 'sk-test')
    g.fetch = orig
    console.log(`  [连不上] ${r.message}`)
    assert(r.source === 'builtin', '连不上 → builtin')
    assert(!!r.message && r.message.includes('连不上'), '网络层错误说"连不上"而非 HTTP 状态码')
    assert(!!r.message && r.message.includes('内置清单'), '连不上时也明说在用内置清单')
  }
  {
    // 本机服务连不上要给的是"确认它启动了",不是"检查 Key"
    const ollama = providerOfAgent('api:ollama')!
    const g = globalThis as unknown as { fetch: unknown }
    const orig = g.fetch
    g.fetch = async () => { throw new Error('ECONNREFUSED') }
    const r = await fetchModels(ollama, '', '')
    g.fetch = orig
    assert(!!r.message && r.message.includes('本机'), '本地服务连不上 → 提示确认已启动(实际 ' + r.message + ')')
  }

  /* ================================================================
     29.7 手动填写这条兜底路径必须真的通
     ================================================================
     「自动识别」不可能对所有服务端都成立(私有网关不开放 /models、
     权限只覆盖部分模型、返回格式从没被见过)。所以**手填**是最终的兜底,
     它必须能穿过设置 → 持久化 → effectiveModel 整条链路。
  */
  console.log('\n  --- 29.7 兜底:手填模型名能一路传到运行时 ---')
  {
    // 与设置页写盘的字段名一致(src/shared/settings.ts 的 providers[id].defaultModel)
    const HAND = 'my-gateway-chat-v2'
    assert(
      effectiveModel('api:deepseek', '', HAND) === HAND,
      '设置里手填的 defaultModel 会被运行时采用(字段名对得上)',
    )
    assert(
      effectiveModel('api:deepseek', 'deepseek-reasoner', HAND) === 'deepseek-reasoner',
      '节点上单独选了模型时仍以节点的为准(手填只是回落,不是覆盖)',
    )
    // 手填的东西不必在注册表里 —— 私有命名是它存在的全部理由
    assert(
      !PROVIDERS.some((p) => p.models.some((m) => m.id === HAND)),
      '手填的模型名不需要在注册表内置清单里存在(否则手填就白做了)',
    )
    // 空白手填不能把节点打空:那会让节点回落成 CLI 默认,症状更隐蔽
    assert(
      effectiveModel('api:deepseek', '', '   ') === ds.models[0]!.id,
      '只填了空白 = 没填,回落到内置首选而不是空串',
    )
  }
}

/* ================================================================
   30. 可搜索模型框:过滤 / 来源标注 / 去重 / 手填不受限(零网络 · 零 LLM)

   用户报的原话是「有些模型版本多,没法输入,比如火山」。拆开看是三件事:
     ① 得能**直接敲** —— 候选只是辅助,不是门槛;
     ② 敲字时能**搜得到** —— 方舟接入点数量不限,原生 select 只能一路翻;
     ③ 填进去的值**原样生效** —— 清单外的名字(接入点、私有网关命名)必须能用。

   这一节只测**纯逻辑**(filterModels / mergeModelCandidates /
   currentValueCandidate / effectiveModel)。UI 交互(浮层、键盘、点外关闭)
   依赖真实 DOM 与焦点,纯 node 环境下测不了 —— 那部分由 typecheck + 手工
   核对覆盖,不为凑数写假断言。
   ================================================================ */
async function modelSearchTests(): Promise<void> {
  console.log('\n  --- 30.1 过滤:大小写不敏感 / 匹配 id / 匹配 label / 空查询全给 ---')

  /** 一份覆盖各种真实命名的候选表 —— 刻意用会"被误伤"的那些形态 */
  const LIST: ModelCandidate[] = [
    { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5', source: 'remote' },
    { id: 'qwen3:8b', label: 'Qwen3 8B', source: 'remote' },
    { id: 'my-gateway-chat-v2', label: '私有网关', source: 'custom' },
    { id: 'doubao-seed-1-6-250615', label: '豆包 Seed 1.6', source: 'builtin' },
    { id: 'deepseek-chat', label: 'DeepSeek Chat', source: 'builtin' },
  ]

  // ① 空查询返回全部(而不是空列表)。一上来就空着会被误解成"这家没有模型"
  assert(
    filterModels(LIST, '').length === LIST.length,
    '空查询返回全部候选(用户要能一眼看到这家有什么)',
  )
  assert(
    filterModels(LIST, '    ').length === LIST.length,
    '纯空白查询同样按空查询处理(不是搜"空格")',
  )

  // ② 大小写不敏感 —— 用户照着显示名敲大写 C 是最自然的动作
  assert(
    filterModels(LIST, 'CLAUDE').some((m) => m.id === 'anthropic/claude-sonnet-4.5'),
    '大写查询能搜到小写的 id(大小写不敏感)',
  )
  assert(
    filterModels(LIST, 'claude sonnet').some((m) => m.id === 'anthropic/claude-sonnet-4.5'),
    '按显示名(带空格)也能搜到 —— label 同样参与匹配',
  )
  assert(
    filterModels(LIST, 'qwen3 8b').some((m) => m.id === 'qwen3:8b'),
    '显示名与 id 写法不同时也能搜到(qwen3 8b → qwen3:8b)',
  )

  // ③ 匹配 id 的**任意子串**,不只前缀 —— 版本号在末尾,搜版本是最常见的找法
  assert(
    filterModels(LIST, '250615').some((m) => m.id === 'doubao-seed-1-6-250615'),
    '能按 id 中段的版本号搜到(子串匹配,不是前缀匹配)',
  )
  assert(
    filterModels(LIST, 'gateway').some((m) => m.id === 'my-gateway-chat-v2'),
    '能按 id 中段搜到私有网关命名',
  )

  // ④ 无匹配返回空数组(不是 null、不是原表)。上层据此显示"没有匹配"那句人话
  assert(filterModels(LIST, 'zzz-不存在-zzz').length === 0, '无匹配返回空数组')
  assert(filterModels([], 'qwen').length === 0, '空列表 + 任意查询仍是空数组,不抛')

  console.log('\n  --- 30.2 过滤不误伤:三类最容易丢的命名 ---')
  // 这三个是真实存在、且**极易被过严的过滤规则弄丢**的形态
  assert(
    filterModels(LIST, 'anthropic/claude').length === 1,
    '带厂商前缀的 id 能搜到(斜杠不该被当成路径分隔)',
  )
  assert(
    filterModels(LIST, 'qwen3:8b').length === 1,
    'Ollama 的 tag 语法(冒号)能原样搜到',
  )
  assert(
    filterModels(LIST, 'my-gateway-chat-v2').length === 1,
    '中转私有命名能完整搜到(连字符不该被拆开)',
  )
  // 负向对照:上面三个"搜到"不是因为宽松到什么都匹配
  assert(
    !filterModels(LIST, 'anthropic/claude').some((m) => m.id === 'qwen3:8b'),
    '搜厂商前缀不会把别的模型也带出来(不是无脑全给)',
  )

  console.log('\n  --- 30.3 排序:完全一致 > 前缀 > 子串 ---')
  {
    const r = filterModels(LIST, 'deepseek')
    assert(r[0]?.id === 'deepseek-chat', '完全一致的 id 排在最前(第一个就是他要的)')
    const c = filterModels(LIST, 'claude')
    assert(c[0]?.id === 'anthropic/claude-sonnet-4.5', '只有一个命中时排第一')
    // 排序不能把同档位的原有顺序搅乱(稳定排序)
    const stable = filterModels(LIST, '')
    assert(
      stable.map((m) => m.id).join(',') === LIST.map((m) => m.id).join(','),
      '空查询时保持入参顺序(服务端列表的排序不被过滤搅乱)',
    )
  }

  console.log('\n  --- 30.4 来源标注:合并去重 + 优先级 ---')
  {
    const merged = mergeModelCandidates([
      {
        source: 'remote',
        models: [{ id: 'doubao-seed-1-6-250615', label: '豆包 Seed 1.6(实时)' }],
      },
      { source: 'builtin', models: [{ id: 'doubao-seed-1-6-250615', label: '豆包 Seed 1.6' }] },
    ])
    assert(merged.length === 1, '同一个模型在两路来源里各出现一次时只留一条(不重复列)')
    assert(merged[0]?.source === 'remote', '来源冲突时先传入的赢(服务端实时优先于内置)')
  }
  {
    // 大小写不同的同一个模型也必须去重 —— 但下发到 API 的 id 大小写不能被改写
    const merged = mergeModelCandidates([
      { source: 'remote', models: [{ id: 'GPT-4o', label: 'GPT-4o' }] },
      { source: 'builtin', models: [{ id: 'gpt-4o', label: 'gpt-4o' }] },
    ])
    assert(merged.length === 1, '仅大小写不同的同一个模型也去重')
    assert(merged[0]?.id === 'GPT-4o', '去重不改写 id 大小写(改写等于替用户改错)')
  }
  {
    // 重复项允许补 label:先到那条 label===id 时,后到的显示名填上
    const merged = mergeModelCandidates([
      { source: 'remote', models: [{ id: 'x', label: 'x' }] },
      { source: 'builtin', models: [{ id: 'x', label: '显示名' }] },
    ])
    assert(merged[0]?.label === '显示名', '重复项允许后到的补上 label')
    // 反向:先到那条已有像样的 label,不能被覆盖成别的
    const keep = mergeModelCandidates([
      { source: 'remote', models: [{ id: 'y', label: '原名' }] },
      { source: 'builtin', models: [{ id: 'y', label: '别的名' }] },
    ])
    assert(keep[0]?.label === '原名', '已有 label 不被后来的重复项覆盖')
  }
  {
    const merged = mergeModelCandidates([
      { source: 'remote', models: [{ id: '  ', label: '空 id' }] },
      { source: 'builtin', models: [{ id: 'ok', label: '' }] },
    ])
    assert(merged.length === 1 && merged[0]?.id === 'ok', '空 id 被丢弃,不占一行')
    assert(merged[0]?.label === 'ok', 'label 为空时回落成 id 本身(不显示空白)')
  }
  assert(
    MODEL_SOURCE_LABEL.remote === '服务端' &&
      MODEL_SOURCE_LABEL.builtin === '内置' &&
      MODEL_SOURCE_LABEL.custom === '手填',
    '三种来源都有中文角标(用户需要知道自己在选哪一种)',
  )

  console.log('\n  --- 30.5 当前值入列:填过的名字不会被自己藏起来 ---')
  {
    const arkEp = 'ark-00000000-0000-0000-0000-000000000000'
    const cands = buildArkCandidates()
    // 用户报的那个真实接入点:它**不在任何可拉取的列表里**,必须靠手填这一条兜住
    const withCur = [...cands, ...currentValueCandidate(cands, arkEp)]
    assert(
      withCur.some((m) => m.id === arkEp && m.source === 'custom'),
      '当前填的接入点 id 以「手填」身份出现在候选里(确认值在这儿,且未验证)',
    )
    assert(
      filterModels(withCur, '000000000000').length === 1,
      '已填的接入点能按其中一段搜到(下次换节点不用重新想)',
    )
    // 已在列表里的值不再重复列
    const dup = currentValueCandidate(cands, cands[0]!.id)
    assert(dup.length === 0, '已在候选列表里的值不重复列一行(否则像是两个模型)')
    assert(currentValueCandidate(cands, '').length === 0, '空值不产生候选')
    assert(currentValueCandidate(cands, '   ').length === 0, '纯空白不产生候选(空白=没填)')
  }

  console.log('\n  --- 30.6 手填不受清单限制(负向对照)---')
  {
    // 负向对照的核心:一个注册表里**根本不存在**的名字,值就是它
    const HAND = 'my-gateway-chat-v2'
    assert(
      effectiveModel('api:ark', HAND, '') === HAND,
      '填一个注册表里没有的名字,运行时用的就是它(不被改写成清单里的)',
    )
    assert(
      !PROVIDERS.some((p) => p.models.some((m) => m.id === HAND)),
      '负向对照成立:这个名字确实不在任何内置清单里',
    )
    // 真实接入点 id 同样原样通过
    const EP = 'ark-00000000-0000-0000-0000-000000000000'
    assert(
      effectiveModel('api:ark', EP, '') === EP,
      '火山接入点 id 原样送到运行时(用户实际在用的那个形态)',
    )
    // 空白视作没填 —— 控件改成"敲了就生效"之后这条更关键:
    // 用户可能敲了又删空,不能让节点因此变成空模型
    const ark = providerOfAgent('api:ark')!
    assert(
      effectiveModel('api:ark', '   ', '') === ark.models[0]!.id,
      '只敲了空白 = 没填,回落内置首选(控件改成自由输入后尤其要成立)',
    )
    assert(
      effectiveModel('api:ark', '', '   ') === ark.models[0]!.id,
      '设置里只填了空白同样回落内置首选',
    )
  }

  console.log('\n  --- 30.7 方舟接入点:拉不到时的提示必须指向"粘贴 id" ---')
  {
    const ark = providerOfAgent('api:ark')!
    // 这条 hint 是用户在这家唯一能看到的操作指引,过时就等于没有
    assert(!!ark.hint && ark.hint.includes('ep-'), 'ark 的 hint 说清接入点 id 长什么样(ep-)')
    assert(!!ark.hint && ark.hint.includes('ark-'), 'ark 的 hint 也提到 ark- 前缀(用户实际发来的形态)')
    assert(
      !!ark.hint && ark.hint.includes('粘'),
      'ark 的 hint 明确说"粘进模型框"—— 这是这家的唯一可行路径',
    )
    assert(
      !ark.hint!.includes('填在自定义里即可'),
      '旧的过时措辞("填在自定义里")已被替换掉',
    )
  }
}

/** 造一份方舟形态的候选表:两个基础模型 + 若干接入点(接不进 /models 的那些) */
function buildArkCandidates(): ModelCandidate[] {
  return mergeModelCandidates([
    { source: 'builtin', models: providerOfAgent('api:ark')!.models },
    {
      source: 'remote',
      models: [
        { id: 'ep-20260507230659-skvgn', label: 'curl_bot_test' },
        { id: 'ep-20260101120000-abcde', label: 'prod-gateway' },
      ],
    },
  ])
}

/* ================================================================
   31. 模型可用性探测:成本上限 / 并发封顶 / 限流中止 / 三档分开
   ================================================================

   ⚠️ 全部走假 fetch,**零网络、零真实 token**,故本节零 SKIP。
   装的是全局 fetch(与 29.5 节同一手法):`probeModels` 内部走
   `fetchWithTimeout` → `fetch`,而候选池那一路走 `fetchModels` → 同一个
   全局 fetch,所以拦全局就拦得住全部出网请求。
*/
async function modelProbeTests(): Promise<void> {
  const ds = providerOfAgent('api:deepseek')!
  const ark = providerOfAgent('api:ark')!

  /* ================================================================
     31.1 成本上限:探测请求必须夹着 max_tokens
     ================================================================
     这一节是整个功能的安全前提。`buildOpenai` 原本**完全不带** `max_tokens`
     (OpenAI 系默认无上限),批量探 15 个模型就是 15 份"模型想写多少写多少"的
     账单 —— 而用户点一次就花一次,他毫不知情。
  */
  console.log('\n  --- 31.1 成本上限:每个探测请求都带最小输出限制(最重要)---')
  {
    const sent: string[] = []
    const bodies: Record<string, unknown>[] = []
    const restore = stubProbeFetch(
      sent,
      () => ({ status: 200, body: { choices: [{ message: { content: '1' } }] } }),
      { bodies },
    )

    await probeModels(ds, { baseUrl: 'https://x.example.com/v1', key: 'sk-test-1234' })
    restore()

    /*
     * 断言两件事,缺一不可:
     *   1. **真的发了请求**(否则下面那些"都有 max_tokens"是空断言 —— 发了 0 个请求
     *      的假实现同样"通过"这一条,那是最危险的假绿);
     *   2. 每一个都带 max_tokens 且值很小。
     */
    assert(bodies.length > 0, `探测真的发出了请求(实际 ${bodies.length} 个)—— 否则本节其余断言是空断言`)
    assert(
      bodies.every((b) => typeof b.max_tokens === 'number'),
      'OpenAI 系探测请求**每一个**都带 max_tokens(修前完全没有这个字段)',
    )
    assert(
      bodies.every((b) => (b.max_tokens as number) <= PROBE_MAX_TOKENS),
      `max_tokens 被压到 ${PROBE_MAX_TOKENS} 以内(批量探测才不会烧钱)`,
    )
    assert(
      PROBE_MAX_TOKENS <= 1,
      `输出上限就是 1 个 token(实际 ${PROBE_MAX_TOKENS})—— 这是"敢做批量探测"的前提`,
    )
    // 负向对照:不能是流式请求 —— 探测要的是一份完整 JSON,半截 SSE 判不出三档
    assert(
      bodies.every((b) => b.stream === false),
      '探测请求是非流式(要一份完整 JSON 才能判档;半截 SSE 判不出"有没有回话")',
    )
  }
  {
    // ⚠️ 负向对照:同一个构造器在**不传** maxTokens 时不该凭空多出这个字段。
    // 这一条拦"为了让断言过而给所有请求硬塞 max_tokens"——那会把正常对话也
    // 限制成 1 个 token,是比不做探测更严重的事故。
    const noCap = buildChatRequest({
      provider: ds,
      baseUrl: 'https://x.example.com/v1',
      apiKey: 'sk-1',
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: '你好' }],
      tools: [],
    })
    const body = JSON.parse(String(noCap.init.body)) as Record<string, unknown>
    assert(
      body.max_tokens === undefined,
      '不传 maxTokens 时正常会话请求里**没有**这个字段(没顺手给所有请求加上限)',
    )
  }
  {
    // prompt 必须短、且能触发一次完整回复(空 prompt 有些服务商会返回空响应,
    // 那样就分不出"能用但没话说"与"模型不存在")
    assert(PROBE_PROMPT.length <= 8, `探测 prompt 短到不能再短(实际 ${JSON.stringify(PROBE_PROMPT)} 的长度 ${PROBE_PROMPT.length})`)
    assert(PROBE_PROMPT.trim().length > 0, '探测 prompt 非空(空 prompt 会让部分服务商返回空响应)')
  }
  {
    // Anthropic 那一支本来就必填 max_tokens(写死 8192),探测要能把它压下来
    const anth = providerOfAgent('api:anthropic')!
    const capped = buildChatRequest({
      provider: anth,
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-1',
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: PROBE_PROMPT }],
      tools: [],
      maxTokens: PROBE_MAX_TOKENS,
    })
    const body = JSON.parse(String(capped.init.body)) as Record<string, unknown>
    assert(
      body.max_tokens === PROBE_MAX_TOKENS,
      `Anthropic 探测请求的 max_tokens 被压到 ${PROBE_MAX_TOKENS}(原本写死 8192,批量探测会烧钱)`,
    )
    // 不传时必须仍是 8192 —— 正常会话的输出预算不能被探测参数改掉
    const normal = buildChatRequest({
      provider: anth,
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-1',
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: '你好' }],
      tools: [],
    })
    assert(
      (JSON.parse(String(normal.init.body)) as Record<string, unknown>).max_tokens === 8192,
      '不传 maxTokens 时 Anthropic 仍是 8192(正常会话的输出预算没被改)',
    )
  }
  {
    // Gemini 的输出上限在 generationConfig 里,不是顶层 max_tokens
    const gem = providerOfAgent('api:gemini')!
    const capped = buildChatRequest({
      provider: gem,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'k',
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: PROBE_PROMPT }],
      tools: [],
      maxTokens: PROBE_MAX_TOKENS,
    })
    const body = JSON.parse(String(capped.init.body)) as Record<string, unknown>
    const cfg = body.generationConfig as Record<string, unknown> | undefined
    assert(
      !!cfg && cfg.maxOutputTokens === PROBE_MAX_TOKENS,
      `Gemini 探测请求带 generationConfig.maxOutputTokens=${PROBE_MAX_TOKENS}(各家字段不同,漏了就没限住)`,
    )
  }

  /* ================================================================
     31.2 并发封顶:不能一次发 15 个
     ================================================================
     突发并发会被限流,而用户看到的是"**全部失败**" —— 比不探测更糟。
     用假 fetch 数**同时在飞**的请求数,取峰值。
  */
  console.log('\n  --- 31.2 并发封顶:峰值并发 ≤ 3 ---')
  {
    let inflight = 0
    let peak = 0
    const restore = stubProbeFetch([], () => ({ status: 200, body: {} }), {
      onRequest: () => {
        inflight++
        peak = Math.max(peak, inflight)
      },
      onSettle: () => {
        inflight--
      },
      delayMs: 5,
    })

    const report = await probeModels(ds, { baseUrl: 'https://x.example.com/v1', key: 'sk-test-1234' })
    restore()

    assert(peak <= PROBE_CONCURRENCY, `并发峰值 ${peak} ≤ ${PROBE_CONCURRENCY}(突发 15 个会被限流,用户看到的是"全部失败")`)
    assert(peak > 1, `确实并发跑起来了(峰值 ${peak})—— 否则这条约束是空断言`)
    assert(report.total > 0, `这一轮探了 ${report.total} 个候选`)
  }
  {
    // 默认值本身:PROBE_CONCURRENCY 必须是个小数字,不是 15
    assert(
      PROBE_CONCURRENCY >= 1 && PROBE_CONCURRENCY <= 5,
      `PROBE_CONCURRENCY = ${PROBE_CONCURRENCY}(1~5 的小值;再大就压不住了)`,
    )
  }

  /* ================================================================
     31.3 限流:必须立刻停,且判成 skipped 而不是 missing
     ================================================================
     这一节拦的是最严重的那个错判:**把限流说成"模型不存在"**。
     后果是用户据此把能用的模型全删掉,而真实原因只是"等一会儿"。
  */
  console.log('\n  --- 31.3 限流:立即停止 + 判 skipped(不是 missing)---')
  {
    const sent: string[] = []
    const restore = stubProbeFetch(
      sent,
      () => ({ status: 429, body: { error: { message: 'rate limited' } } }),
    )

    /*
     * 用 lmstudio 而不是 ark:它的内置清单是**空的**,于是候选池恰好等于
     * 手填的那几个 —— 候选数与顺序完全由测试掌控。
     * (用 ark 会额外混进两个内置模型,"停止剩余"就不好数了。)
     */
    const empty = providerOfAgent('api:lmstudio')!
    const report = await probeModels(empty, {
      baseUrl: 'http://localhost:1234/v1',
      key: 'sk-test-1234',
      manualModels: ['ark-ep-a', 'ark-ep-b', 'ark-ep-c', 'ark-ep-d', 'ark-ep-e', 'ark-ep-f'],
    })
    restore()

    assert(report.rateLimited, '429 触发后报告标记为「被限流」')
    // ⚠️ 核心:限流 ≠ 模型不存在
    assert(
      report.results.every((r) => r.verdict !== 'missing'),
      '429 判成 skipped,**没有任何一个被判成 missing**(把限流说成模型不存在是本功能最严重的错判)',
    )
    // 候选池有 6 个,但远不该把 6 个都发出去
    assert(report.total === 6, `候选共 ${report.total} 个(内置清单为空,恰好是手填的 6 个)`)
    assert(
      sent.length < report.total,
      `限流后**停止**了剩余探测(发出 ${sent.length} 个 / 候选 ${report.total} 个)`,
    )
    // 没发出去的那些也要有条目,且说清"没测、不是不行"
    const notSent = report.results.filter((r) => !sent.includes(r.id))
    console.log(`  [DBG429] sent=${JSON.stringify(sent)} resultsLen=${report.results.length} notSent=${notSent.length}`)
    console.log(`  [DBG429] ids=${JSON.stringify(report.results.map((r) => r.id))}`)
    assert(notSent.length > 0, '未发出的候选也出现在结果里(不是从报告里消失)')
    assert(
      notSent.every((r) => r.verdict === 'skipped'),
      '未发出的候选判为 skipped(不是 missing)',
    )
    assert(
      notSent.every((r) => r.reason.includes('不代表')),
      '未发出的候选说清"不代表…"(用户必须能区分限流与不存在)',
    )
    assert(
      notSent.every((r) => r.reason.includes('限流')),
      '未发出的候选点明原因是限流(不是模型问题)',
    )
  }
  {
    // 分类层的直接断言:429 恒为 skipped + rateLimited,与文案无关
    const r429 = classifyProbeResponse(429, '')
    assert(r429.verdict === 'skipped', 'HTTP 429 → skipped')
    assert(r429.rateLimited, 'HTTP 429 → 触发中止标记')
    assert(r429.reason.includes('限流'), '429 的理由点名"限流"')
    assert(
      r429.reason.includes('不代表模型不可用'),
      '429 的理由明说"不代表模型不可用"(这两件事必须分开)',
    )
    // 文案是"配额耗尽"时也**仍然**是 skipped —— 它是账户问题,不是模型问题
    const r429Quota = classifyProbeResponse(429, 'You exceeded your current quota, insufficient_quota')
    assert(
      r429Quota.verdict === 'skipped' && r429Quota.rateLimited,
      '429 + 配额耗尽文案 → 仍是 skipped(账户问题不是模型问题)',
    )
  }

  /* ================================================================
     31.4 三档分类:ok / missing / skipped 分得对
     ================================================================
  */
  console.log('\n  --- 31.4 分类:拿到回复=ok / 模型不存在=missing / 没测出来=skipped ---')
  {
    const ok = classifyProbeResponse(200, '{"choices":[{"message":{"content":"1"}}]}')
    assert(ok.verdict === 'ok', 'HTTP 200 → ok(唯一能确定"可用"的情形)')

    // ⚠️ 2xx + 空响应体**也**是 ok:200 本身就是"链路/Key/模型名都对"的证据。
    // 早先版本要求必须有正文,那会让一批正常模型被误判成"没测出来"。
    const okEmpty = classifyProbeResponse(200, '')
    assert(okEmpty.verdict === 'ok', 'HTTP 200 且响应体为空 → 仍是 ok(200 本身就是证据)')

    const m1 = classifyProbeResponse(404, '{"error":{"message":"The model `gpt-9` does not exist"}}')
    assert(m1.verdict === 'missing', '404 + "does not exist" → missing')
    const m2 = classifyProbeResponse(400, '{"error":{"code":"unrecognized_model"}}')
    assert(m2.verdict === 'missing', '400 + unrecognized_model → missing')
    const m3 = classifyProbeResponse(404, '{"error":{"message":"model not found"}}')
    assert(m3.verdict === 'missing', '404 + "model not found" → missing')
    const m4 = classifyProbeResponse(404, '模型不存在')
    assert(m4.verdict === 'missing', '404 + 中文「模型不存在」→ missing')
    assert(
      classifyProbeResponse(401, 'Unauthorized').verdict === 'missing',
      '401 → missing(Key 没有该模型权限,对"能否选它"就是不可用)',
    )
    assert(
      classifyProbeResponse(403, 'Forbidden').verdict === 'missing',
      '403 → missing',
    )

    const s1 = classifyProbeResponse(500, 'internal error')
    assert(s1.verdict === 'skipped', '5xx → skipped(服务端故障不是模型问题)')
    const s2 = classifyProbeResponse(0, '', 'fetch failed')
    assert(s2.verdict === 'skipped', '网络失败 → skipped')
    assert(s2.reason.includes('不代表模型不可用'), '网络失败的理由说明"不代表模型不可用"')
    const s3 = classifyProbeResponse(0, '', 'The operation was aborted due to timeout')
    assert(s3.verdict === 'skipped', '超时 → skipped("这次没测出来")')

    // ⚠️ 账户问题必须抢在前面 —— 一次欠费会让全部候选都"失败",
    // 判成"这些模型不可用"会把用户引向完全错误的方向(他该做的是充值)。
    const b1 = classifyProbeResponse(402, 'Insufficient balance')
    assert(b1.verdict === 'skipped', '402 余额不足 → skipped(账户问题,不是模型问题)')
    const b2 = classifyProbeResponse(403, 'insufficient_quota')
    assert(b2.verdict === 'skipped', '403 + 配额耗尽 → skipped(同样是账户问题)')
    assert(
      b1.reason.includes('账户') || b1.reason.includes('余额'),
      '账户类失败的理由点名账户/余额(用户据此知道该去充值而不是换模型)',
    )

    // ⚠️ 404 + 含糊文案 → skipped,不是 missing。
    // 这是 `classifyHttpStatus` 的保守口径(CDN 切量时也会短 404),
    // 赌错了等于把能用的模型判死 —— 那是拿"看不到的希望"换"多等 3 秒"。
    const amb = classifyProbeResponse(404, '')
    assert(amb.verdict === 'skipped', '404 但正文含糊 → skipped(网关瞬时 404 不该判死模型)')

    // 三档的中文标签都在,UI 直接显示
    assert(
      PROBE_VERDICT_LABEL.ok === '可用' &&
        PROBE_VERDICT_LABEL.missing === '不可用' &&
        PROBE_VERDICT_LABEL.skipped === '跳过',
      '三档都有中文短标签(UI 直接显示,不在组件里各写一份)',
    )
  }
  {
    // 整轮链路:假 fetch 按模型名给不同响应,验证**按候选逐个归类**而不是一刀切
    const restore = stubProbeFetch([], (model) => {
      if (model === 'good-1') return { status: 200, body: { choices: [{ message: { content: '1' } }] } }
      if (model === 'missing-1') return { status: 404, body: { error: { message: 'model not found' } } }
      if (model === 'boom-1') return { status: 503, body: { error: 'unavailable' } }
      return { status: 200, body: { choices: [{ message: { content: '1' } }] } }
    })

    const empty = providerOfAgent('api:lmstudio')!
    const report = await probeModels(empty, {
      baseUrl: 'http://localhost:1234/v1',
      key: 'sk-test-1234',
      manualModels: ['good-1', 'missing-1', 'boom-1'],
    })
    restore()

    const g = groupProbeResults(report.results)
    assert(
      g.ok.some((r) => r.id === 'good-1'),
      '拿到回复的模型判为 ok',
    )
    assert(
      g.missing.some((r) => r.id === 'missing-1'),
      '404 model not found 的模型判为 missing',
    )
    assert(
      g.skipped.some((r) => r.id === 'boom-1'),
      '503 的模型判为 skipped(**不是** missing —— 服务端故障不是模型问题)',
    )
    // 顺序必须与候选池一致 —— UI 的三组各自按此渲染,顺序乱跳很难点
    assert(
      report.results.map((r) => r.id).join(',') === 'good-1,missing-1,boom-1',
      `结果顺序与候选池一致(实际 ${report.results.map((r) => r.id).join(',')})`,
    )
  }

  /* ================================================================
     31.5 候选池:去重 / 真实列表优先 / 手填能进池
     ================================================================
  */
  console.log('\n  --- 31.5 候选池:去重 / 真实列表优先 / 手填接入点能进池 ---')
  {
    const p = buildProbeCandidates({
      remote: [{ id: 'gpt-4o', label: 'GPT-4o' }],
      builtin: [{ id: 'gpt-4o', label: 'GPT-4o(内置)' }],
      manual: ['ark-00000000-0000-0000-0000-000000000000'],
    })
    assert(p.total === 2, `服务端列表与内置清单重复时只留一条 + 手填 1 条 = 2(实际 ${p.total}:${JSON.stringify(p.candidates.map((c) => c.id))})`)
    assert(p.source === 'remote', '能拉到真实列表时 source = remote(那是服务端的权威回答)')
    assert(
      p.candidates.some((c) => c.id === 'ark-00000000-0000-0000-0000-000000000000'),
      '手填的接入点 id 进了候选池(火山场景的全部意义 —— 它拉不到,只能手填)',
    )
    assert(p.manualMissing.length === 0, '手填的名字全部进了池,manualMissing 为空')
  }
  {
    // 大小写不同的同一个模型也去重
    const p = buildProbeCandidates({
      remote: [{ id: 'GPT-4o', label: 'GPT-4o' }],
      builtin: [{ id: 'gpt-4o', label: 'gpt-4o' }],
    })
    assert(p.total === 1, `仅大小写不同的同一个模型合成一条(实际 ${p.total})`)
    // ⚠️ 下发给 API 的 id 保留服务端原样大小写 —— 改写等于替用户改错
    assert(p.candidates[0]!.id === 'GPT-4o', `下发 id 保留服务端原样的大小写(实际 ${p.candidates[0]!.id})`)
  }
  {
    // 拉不到真实列表 → 退回内置清单
    const p = buildProbeCandidates({ remote: [], builtin: ark.models })
    assert(p.source === 'builtin', '拉不到服务端列表时 source = builtin')
    assert(p.total === ark.models.length, `退回内置清单的条数正确(实际 ${p.total} / ${ark.models.length})`)
  }
  {
    // ⚠️ 手填重复(仅大小写不同)不能进两次 —— 否则同一个 id 白白发两个计费请求
    const EP = 'ark-00000000-0000-0000-0000-000000000000'
    const p = buildProbeCandidates({
      remote: [{ id: 'gpt-4o', label: 'GPT-4o' }],
      builtin: [],
      manual: [EP, EP.toUpperCase(), `  ${EP}  `],
    })
    assert(p.total === 2, `手填的同一个接入点(重复/大小写/带空格)只留一条(实际 ${p.total}:${JSON.stringify(p.candidates.map((c) => c.id))})`)
  }
  {
    // 空串与纯空白不该占候选(用户可能只是敲了一格空格)
    const p = buildProbeCandidates({ remote: [], builtin: [], manual: ['', '   '] })
    assert(p.total === 0, '空串与纯空白不产生候选')
  }
  {
    // ⚠️ 火山场景端到端:方舟内置 2 个基础模型 + 2 个接入点,全都得进池
    const p = buildProbeCandidates({
      remote: [],
      builtin: ark.models,
      manual: ['ark-00000000-0000-0000-0000-000000000000', 'ep-00000000000000000-xxxxx'],
    })
    assert(
      p.candidates.filter((c) => c.source === 'custom').length === 2,
      '方舟的两个接入点都以「手填」身份进池(拉不到的那部分只能这样补)',
    )
    assert(p.total === ark.models.length + 2, `方舟候选 = 内置 ${ark.models.length} + 手填 2 = ${p.total}`)
  }

  /* ================================================================
     31.6 成本告知:UI 必须能说出"会发几个请求"
     ================================================================
  */
  console.log('\n  --- 31.6 成本知情:告诉用户会发几个请求 ---')
  {
    const msg = estimateProbeCost(15)
    assert(msg.includes('15'), `成本提示里写明请求数(实际:${msg})`)
    assert(msg.includes(String(PROBE_MAX_TOKENS)), '成本提示里写明输出上限 token')
    assert(
      msg.includes(`${15 * PROBE_MAX_TOKENS}`),
      `成本提示里写明总输出上限(${15 * PROBE_MAX_TOKENS} 个 token)`,
    )
    assert(estimateProbeCost(0).includes('不会发出任何请求'), '零候选时明说"不会发出任何请求"')
    // 负向对照:不该编出一个具体金额 —— 各家单价差几个数量级,我们也不知道折扣
    assert(!/\d+(\.\d+)?\s*(元|美元|\$|¥)/.test(msg), '不编造具体金额(应用不知道用户拿到的是哪一档单价)')
  }

  /* ================================================================
     31.7 探测结果能被 ModelCombobox 消费
     ================================================================
  */
  console.log('\n  --- 31.7 探测结果喂进可搜索下拉框(纯逻辑层) ---')
  {
    const results: ProbeResult[] = [
      { id: 'gpt-4o', verdict: 'ok', reason: '', latencyMs: 120 },
      { id: 'ark-09d8-b6d72', verdict: 'ok', reason: '', latencyMs: 300 },
      { id: 'gpt-3.5-turbo', verdict: 'missing', reason: '模型不存在', latencyMs: 90 },
      { id: 'gpt-4.1', verdict: 'skipped', reason: '限流', latencyMs: 0 },
    ]

    const ids = verifiedModelIds(results)
    assert(
      ids.join(',') === 'gpt-4o,ark-09d8-b6d72',
      `只有 ok 档被记进设置(实际 ${JSON.stringify(ids)})—— 跳过/不可用的存下来会让用户以为"验过、不可用"`,
    )

    const cands = verifiedCandidates(results)
    assert(cands.length === 2, `只有 ok 档进入候选(实际 ${cands.length})`)
    assert(
      cands.every((c) => c.source === 'verified'),
      '探测验证过的候选标为 verified 源(UI 上带「已验证」角标)',
    )
    assert(
      cands.every((c) => c.tag === '已验证'),
      '验证过的候选带「已验证」角标',
    )

    // 真的能被那个可搜索下拉框消费:合并 + 过滤,两段都用它自己的函数
    const merged = mergeModelCandidates([
      { source: 'verified', models: cands },
      { source: 'remote', models: [{ id: 'gpt-4o', label: 'GPT-4o' }, { id: 'o3', label: 'o3' }] },
    ])
    assert(merged.length === 3, `与其它来源合并去重后共 ${merged.length} 个(gpt-4o 只出现一次)`)
    assert(
      merged.find((m) => m.id === 'gpt-4o')?.source === 'verified',
      '同一个模型在验证过与远程列表都有时,「已验证」赢(它有服务端回执,更可信)',
    )
    // 搜索:节点面板上的那个框按 id 中段也能搜到接入点
    assert(
      filterModels(merged, 'b6d72').length === 1,
      '接入点 id 能按中段搜到(用户在节点上换节点不必重新想名字)',
    )
    // ⚠️ 负向对照:不可用的那个不该出现在候选里 —— 存进去等于把用户引向 404
    assert(
      !merged.some((m) => m.id === 'gpt-3.5-turbo'),
      '验证为「不可用」的模型不进候选(否则用户会选到一个必然 404 的名字)',
    )
    assert(
      !merged.some((m) => m.id === 'gpt-4.1'),
      '「跳过」的模型也不进候选(它没被证伪,下次重试可能就通了)',
    )
    assert(
      MODEL_SOURCE_LABEL.verified === '已验证',
      'verified 这个来源有中文角标(用户需要知道这个模型是验过的)',
    )
  }

  /* ================================================================
     31.8 「用第一个可用模型」:挑的是最快那个
     ================================================================
  */
  console.log('\n  --- 31.8 直接选用:第一个可用模型 ---')
  {
    const results: ProbeResult[] = [
      { id: 'slow-big', verdict: 'ok', reason: '', latencyMs: 30000 },
      { id: 'fast-small', verdict: 'ok', reason: '', latencyMs: 120 },
      { id: 'broken', verdict: 'missing', reason: '', latencyMs: 50 },
    ]
    assert(
      pickFirstAvailable(results) === 'fast-small',
      '「用第一个可用」挑的是**最快**的那个 ok(列表第一项可能是个 30 秒的大模型)',
    )
    assert(pickFirstAvailable([]) === null, '一个可用都没有时返回 null(不返回 undefined)')
    assert(
      pickFirstAvailable([{ id: 'x', verdict: 'skipped' as const, reason: '', latencyMs: 0 }]) === null,
      '只有 skipped 时不提供"用第一个"(跳过的不是"可用")',
    )
  }
  {
    // 分组:三档各自成列,顺序保持
    const results: ProbeResult[] = [
      { id: 'a', verdict: 'ok', reason: '', latencyMs: 1 },
      { id: 'b', verdict: 'missing', reason: '', latencyMs: 1 },
      { id: 'c', verdict: 'skipped', reason: '', latencyMs: 1 },
      { id: 'd', verdict: 'ok', reason: '', latencyMs: 1 },
    ]
    const g = groupProbeResults(results)
    assert(g.ok.length === 2 && g.missing.length === 1 && g.skipped.length === 1, '三档分组正确')
    assert(g.ok.map((r) => r.id).join(',') === 'a,d', '组内保持原顺序(UI 按此渲染,顺序乱跳很难点)')
    assert(groupProbeResults([]).ok.length === 0, '空结果的分组不抛')
  }

  /* ================================================================
     31.9 缺前置条件时:不发请求,说清下一步
     ================================================================
  */
  console.log('\n  --- 31.9 没填地址/Key:一个请求都不该发 ---')
  {
    const sent: string[] = []
    const restore = stubProbeFetch(sent, () => ({ status: 200, body: {} }))

    const custom = providerOfAgent('api:custom')!
    const noUrl = await probeModels(custom, { baseUrl: '', key: 'sk-test-1234' })
    const noKey = await probeModels(ds, { baseUrl: 'https://x.example.com/v1', key: '' })
    restore()

    assert(sent.length === 0, `没填地址/Key 时一个请求都不该发(实际发了 ${sent.length} 个)`)
    assert(noUrl.total === 0 && noUrl.note.includes('接口地址'), '没填地址时说清缺地址')
    assert(noKey.total === 0 && noKey.note.includes('Key'), '没填 Key 时说清缺 Key')
  }
  {
    // 本机服务不用 Key(optionalKey)—— 不能因为没 Key 就拦住探测
    const ollama = providerOfAgent('api:ollama')!
    const sent: string[] = []
    const restore = stubProbeFetch(sent, () => ({ status: 200, body: { choices: [{ message: { content: '1' } }] } }))
    const r = await probeModels(ollama, { baseUrl: '', key: '' })
    restore()
    assert(r.note.includes('接口地址'), 'Ollama 没填地址也说清缺地址(它有内置地址,但用户可能填错了)')
    assert(sent.length === 0, '没填地址时不发请求')
  }
  {
    // 一个候选都没有时:说清"手填也能验",而不是干瞪眼
    const lm = providerOfAgent('api:lmstudio')!
    const sent: string[] = []
    const restore = stubProbeFetch(sent, () => ({ status: 200, body: {} }))
    const r = await probeModels(lm, { baseUrl: '', key: '' })
    restore()
    assert(sent.length === 0, 'LM Studio 内置清单为空且没填地址 → 不发请求')
  }
  {
    // 候选为空但用户手填了 → 必须能探(这是火山路径的兜底)
    const lm = providerOfAgent('api:lmstudio')!
    const sent: string[] = []
    const restore = stubProbeFetch(sent, () => ({ status: 200, body: { choices: [{ message: { content: '1' } }] } }))
    const r = await probeModels(lm, {
      baseUrl: 'http://localhost:1234/v1',
      key: '',
      manualModels: ['my-local-model'],
    })
    restore()
    assert(sent.length === 1, `内置清单为空但手填了名字 → 照探(实际发了 ${sent.length} 个)`)
    assert(r.results[0]?.verdict === 'ok', '手填的名字探出 ok')
    assert(r.note.includes('手填') || r.note.includes('加入'), '说清"手填也能验"这条出路')
  }
}

/**
 * 装一个假 fetch,专供探测测试。
 *
 * 与 29.5 节那个 `stubFetch` 分开是因为需求不同:这里要能
 *   - 按**模型名**分别给不同响应(测逐个归类);
 *   - 记下每个请求的**报文**(测 max_tokens 有没有被夹住);
 *   - 记录**同时在飞**的请求数(测并发封顶);
 *   - 可控延迟(否则并发根本观测不到 —— 假 fetch 太快,峰值永远是 1)。
 *
 * ⚠️ **模型名是从报文里取的,不是从 URL**。
 * OpenAI 系把 model 放在 body(`POST /chat/completions` 的 URL 里没有它),
 * 只有 Gemini 把它放进路径(`/models/{m}:generateContent`)。按 URL 匹配会
 * 一条都匹配不上,而那种情况下所有候选都拿到同一个默认响应 ——
 * "逐个归类"那几条断言会**假绿**。所以这里两种都取。
 *
 * `sent` 收**模型名**(测"发了几个 / 停了没有"),报文另存到 `bodies`。
 *
 * ⚠️ 拦的是全局 fetch,所以 `fetchModels`(候选池那一路)与探测请求
 * 全都出不去 —— 本节零真实网络请求。
 */
function stubProbeFetch(
  sent: string[],
  respond: (model: string, url: string) => { status: number; body: unknown },
  opts?: { bodies?: Record<string, unknown>[]; onRequest?: () => void; onSettle?: () => void; delayMs?: number },
): () => void {
  const g = globalThis as unknown as { fetch: unknown }
  const orig = g.fetch
  const delayMs = opts?.delayMs ?? 0
  g.fetch = async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    } catch {
      /* GET /models 没有 body,解析不出来是正常的 */
    }
    // 模型名:优先取 body(OpenAI 系),取不到再从 URL 路径里抠(Gemini)
    const fromBody = typeof body.model === 'string' ? body.model : ''
    const fromUrl = /\/models\/([^/:]+):/.exec(u)?.[1] ?? ''
    const model = fromBody || fromUrl

    opts?.onRequest?.()
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    // 只有探测请求才计数;/models 那一路不算(它不是"挨个验证"的一部分)
    if (!u.endsWith('/models')) {
      sent.push(model)
      opts?.bodies?.push(body)
    }
    const { status, body: resBody } = respond(model, u)
    const text = JSON.stringify(resBody)
    // 在返回前结算"这一发结束了"。放在 delay 之后是对的:延迟期间这一发
    // 确实还占着一个并发槽,那正是并发峰值要测的东西。
    opts?.onSettle?.()
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => resBody,
      text: async () => text,
    } as Response
  }
  return () => {
    g.fetch = orig
  }
}

const main = async (): Promise<void> => {
  console.log('\n========== 1. 探测 claude ==========')
  const adapter = getAdapter('claude')
  const loc = await adapter.detect()
  console.log(loc)
  assert(!!loc, '定位到 claude 可执行文件')
  assert(!!loc && loc.exe.toLowerCase().endsWith('.exe'), '拿到的是 .exe 而非 .cmd 壳')
  assert(!!loc?.version, `读出版本: ${loc?.version}`)

  console.log('\n========== 2. 第一轮(全新会话) ==========')
  const r1 = await mgr.start({ nodeId: 'e2e-1', canvasId: CANVAS, cwd: CWD, prompt: '只回复两个字:成功' })
  console.log('  argv:', r1.args.join(' '))
  await waitExit()
  /*
   * LLM 可用性探测(T09):只在第一轮真实会话跑完后探一次,结果管到脚本结束。
   * 探在**机制断言之前**:这样第 2 节自己的模型断言也能正确地变成 SKIP。
   */
  llmUnavailable = detectLlmDown({ text: [...texts], stderr: [...stderrLines] })
  if (llmUnavailable) {
    console.log(
      `\n  ⚠️ 真实 LLM 不可用(${llmUnavailable})—— 本节之后的模型相关断言改为 SKIP,机制类断言照常执行\n`,
    )
  }
  assert(r1.isFirstTurn, '首轮走 --session-id')
  assert(r1.args.includes('--permission-prompts'), '带上 --permission-prompts(防永久挂起)')
  llmAssert(texts.join('').includes('成功'), `模型回复包含"成功":${JSON.stringify(texts.join(''))}`)
  llmAssert(lastResult !== null && !lastResult.isError, 'result 事件 isError=false')

  console.log('\n========== 3. 第二轮 --resume(同 session) ==========')
  texts.length = 0
  const r2 = await mgr.start({
    nodeId: 'e2e-2',
    canvasId: CANVAS,
    cwd: CWD,
    sessionId: r1.sessionId,
    prompt: '我刚才让你回复哪两个字?只回复那两个字。',
  })
  console.log('  argv:', r2.args.join(' '))
  await waitExit()
  assert(!r2.isFirstTurn, '非首轮走 --resume')
  assert(r2.args.includes('--resume'), 'argv 里确实有 --resume')
  const answered = texts.join('')
  console.log(`  第二轮回答: ${JSON.stringify(answered)}`)
  llmAssert(answered.includes('成功'), '❗跨进程记忆成立 —— 答出了第一轮的内容')

  console.log('\n========== 4. 模拟"退出重进":新会话不得串味 ==========')
  texts.length = 0
  const r3 = await mgr.start({ nodeId: 'e2e-3', canvasId: CANVAS, cwd: CWD, prompt: '只回复两个字:干净' })
  await waitExit()
  assert(r3.sessionId !== r1.sessionId, '新会话拿到不同的 sessionId')
  const t3 = texts.join('')
  assert(!t3.includes('成功'), '新会话没有被上一个会话污染')

  console.log('\n========== 5. 同 nodeId 并发 start:必须恰好一个成功 ==========')
  /*
   * 这是原来那个 TOCTOU 竞态的直接回归测试。
   *
   * 老实现里「检查是否忙碌」与「写入 live 表」之间隔着一个 await exeFor(),
   * 两次并发调用都在那个 await 之前通过了检查,于是双双 spawn ——
   * 两路进程写同一个节点。
   *
   * 现在检查与占位(pending.add)在同一个同步块里,第二次调用必然被挡下。
   * 断言是确定性的:不依赖 exeFor 是否命中缓存。
   */
  const raceReq = { nodeId: 'e2e-race', canvasId: CANVAS, cwd: CWD, prompt: '只回复两个字:竞争' }
  const settled = await Promise.allSettled([mgr.start(raceReq), mgr.start(raceReq)])
  const accepted = settled.filter((s) => s.status === 'fulfilled')
  const rejected = settled.filter((s) => s.status === 'rejected')

  assert(accepted.length === 1, `两个并发 start 恰好一个被接受(实际 ${accepted.length})`)
  assert(rejected.length === 1, `另一个被拒绝(实际 ${rejected.length})`)
  for (const r of rejected) {
    if (r.status === 'rejected') {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
      console.log(`  拒绝理由: ${msg}`)
      assert(msg.includes('正在运行中'), '拒绝理由是「节点正在运行中」')
    }
  }

  console.log('\n========== 6. waitFor:等这一轮真正跑完 ==========')
  const outcome = await mgr.waitFor('e2e-race')
  console.log(`  waitFor → status=${outcome.status} code=${outcome.code}`)
  // 结局是 error 还是 done 取决于模型/API 是否正常 —— 属模型类断言
  llmAssert(outcome.status !== 'error', `waitFor 拿到真实结局(实际 ${outcome.status})`)
  assert(mgr.runningNodeIds().length === 0, '跑完后 live 表已清空,没有残留活跃节点')

  console.log('\n========== 7. 跑完之后该节点必须能再次启动 ==========')
  // 回归「onExit 无条件 delete」那个缺陷:若旧进程的 close 把新会话从表里删掉,
  // 这里要么起不来,要么取消了也停不掉。
  const again = await mgr.start({ ...raceReq, prompt: '只回复两个字:再来' })
  assert(!!again.sessionId, '同一节点在上一轮结束后可以再次启动')
  const againOutcome = await mgr.waitFor('e2e-race')
  llmAssert(againOutcome.status !== 'error', `第二轮同样拿到真实结局(实际 ${againOutcome.status})`)

  console.log('\n========== 8. 持久化:seq 连续 / 崩溃半行 / 大内容外溢 ==========')
  await persistTests()

  console.log('\n========== 9. 重启后接上上下文:hub 读回 sessionId / 轮数 / 中断态 ==========')
  await hydrateTests()

  console.log('\n========== 10. 设置:损坏文件降级 / 逐字段回退 / 启动开关 ==========')
  await settingsTests()

  console.log('\n========== 11. 工作流图:最长路径分层 / 环路径 ==========')
  await workflowGraphTests()

  console.log('\n========== 12. 工作流调度:产出传递 / 溢出降级 / 失败传播 / 重试 ==========')
  await workflowRunTests()

  console.log('\n========== 13. 工作流真实链路:两个节点,产出真的传过去了 ==========')
  await workflowRealTests()

  console.log('\n========== 14. 项目文件夹:节点继承 / 单独覆盖 / 空目录落沙箱 ==========')
  await projectDirTests()

  console.log('\n========== 15. 画布存取往返:连线/项目文件夹/老画布/坏数据 ==========')
  await canvasStoreTests()

  console.log('\n========== 16. 技能库:解析 / 装入 / 启停 / 删除 / 路径穿越 ==========')
  await skillsTests()

  console.log('\n========== 17. 产出提取:result 优先 / 空 result 不吞正文 / 截断 ==========')
  await extractTests()

  console.log('\n========== 18. nodes-v2 数据契约:迁移幂等 / resolveProjectDir / 图校验 / spec ==========')
  await nodesV2ContractTests()

  console.log('\n========== 19. nodes-v2 调度:输出分流 / 并行不注入 / merge 分节 / brief ==========')
  await nodesV2RunTests()

  console.log('\n========== 20. nodes-v2 打包器:成功 / 失败 / 取消 / 产物定位 ==========')
  await packagerTests()

  console.log('\n========== 21. 四类型行为零回归(注册表化后逐条不变) ==========')
  await nodesV2ZeroRegressionTests()

  console.log('\n========== 21b. 工程化 agent 编排:agent 循环 / router 分支(零 LLM) ==========')
  await agentOrchestrationTests()

  console.log('\n========== 22. 图像节点:两 provider / 取消 / S1·S2 攻击样例(零 LLM) ==========')
  await imageChainTests()

  console.log('\n========== 22b. 图表节点:数据解析容错 / ECharts SSR 出 SVG(零网络) ==========')
  await chartNodeTests()

  console.log('\n========== 23. 多服务商 / API 直连:契约·脱敏·协议解析·工具围栏(零网络) ==========')
  await providerApiTests()

  console.log('\n========== 24. 整合节点:串行叠加 vs 并行覆盖,合不到一块的判据(零 LLM) ==========')
  await mergeCompatTests()

  console.log('\n========== 25. 失败分类:不可重试的不退避 / 归不出的照旧退避(零 LLM) ==========')
  await failureClassificationWiringTests()

  console.log('\n========== 26. 子图:展开防撞名 / 副作用可见 / 环指得到画布(零 LLM) ==========')
  await subgraphHardeningTests()

  console.log('\n========== 27. QA 回归:spec 拍不拍 projectDir / raw 是否保留尾部(零 LLM) ==========')
  await qaRegressionTests()

  console.log('\n========== 28. QA 攻击面:判据不许写宽 + 三条已知漏判局限(零 LLM) ==========')
  failureAttackSurfaceTests()

  console.log('\n========== 29. 模型自动识别:五种返回形状 / 去重 / 不误伤 / 地址真被用(零网络) ==========')
  await modelDiscoveryTests()

  console.log('\n========== 30. 可搜索模型框:过滤 / 来源 / 去重 / 手填不受限(零网络) ==========')
  await modelSearchTests()

  console.log('\n========== 31. 模型可用性探测:成本上限 / 并发封顶 / 限流中止 / 三档分开(零网络) ==========')
  await modelProbeTests()

  console.log('\n========== 结果 ==========')
  // 三态汇总(T09):失败决定退出码;跳过如实披露,不冒充通过
  console.log(`通过 ${passCount} / 跳过 ${skipCount} / 失败 ${failCount}`)
  console.log(failCount > 0 ? '存在失败项' : '全部通过')
  if (skipCount > 0) {
    console.log(`  ⚠️ 有 ${skipCount} 条依赖真实 LLM 的断言被跳过(原因:${llmUnavailable ?? '环境不可用'})`)
  }
}

main()
  .catch((e) => {
    console.error('测试脚本自身抛错:', e)
    process.exitCode = 1
  })
  .finally(() => {
    mgr.killAll()
  })
