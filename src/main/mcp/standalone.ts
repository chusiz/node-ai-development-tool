/**
 * MCP Server 独立入口(v0.6.4):headless 运行 chusiz 工作流,
 * 让 Claude / Cursor 等外部 AI 助手通过 MCP 编排节点画布。
 *
 * 运行:npm run mcp  →  esbuild 打包 → node 执行(读 stdin 的 JSON-RPC)。
 * 本入口不启动 Electron 窗口:initPaths + 真实 SessionManager / NodeLogHub /
 * WorkflowRunner(与 GUI 同一套调度器),外部工具调用即真实执行工作流。
 */

import { initPaths } from '../paths'
initPaths()

import fs from 'node:fs'
import { SessionManager } from '../agents/manager'
import { NodeLogHub } from '../persist/hub'
import { WorkflowRunner } from '../workflow/runner'
import { makeRunnerEnv } from '../workflow/env'
import { registerBuiltinAction } from '../builtin/registry'
import { Packager } from '../packager'
import { ImageGen } from '../imagegen'
import { TestRunner } from '../testrun'
import { VideoGen } from '../videogen'
import { Handoff } from '../handoff'
import { ChartGen } from '../chartgen/ChartGen'
import { PythonRunner } from '../pythonrun'
import { loadGraph } from '../canvas/store'
import { specFromGraph, type RunState } from '../../shared/workflow'
import { getNodeType } from '../../shared/nodeRegistry'
import { McpServer, runStdioTransport, type McpBackend } from './server'

// ---- 内置动作执行器(GUI 同一套) ----
const packager = new Packager()
const imagegen = new ImageGen()
const testrun = new TestRunner()
const videogen = new VideoGen()
const handoff = new Handoff()
const chartgen = new ChartGen()
const pythonrun = new PythonRunner()

registerBuiltinAction('package', { run: (r) => packager.run(r), cancel: (id) => packager.cancel(id), killAll: () => packager.killAll() })
registerBuiltinAction('image', { run: (r) => imagegen.run(r), cancel: (id) => imagegen.cancel(id), killAll: () => imagegen.killAll() })
registerBuiltinAction('test', { run: (r) => testrun.run(r), cancel: (id) => testrun.cancel(id), killAll: () => testrun.killAll() })
registerBuiltinAction('video', { run: (r) => videogen.run(r), cancel: (id) => videogen.cancel(id), killAll: () => videogen.killAll() })
registerBuiltinAction('handoff', { run: (r) => handoff.run(r) })
registerBuiltinAction('chart', { run: (r) => chartgen.run(r) })
registerBuiltinAction('noop', {
  run: async (r) => ({ ok: true, handoffText: (r.promptText ?? r.negativeText ?? '').trim(), log: '' }),
})
registerBuiltinAction('sampler', { run: (r) => imagegen.run(r), cancel: (id) => imagegen.cancel(id), killAll: () => imagegen.killAll() })
registerBuiltinAction('image-output', { run: (r) => handoff.run(r) })
registerBuiltinAction('python', { run: (r) => pythonrun.run(r), cancel: (id) => pythonrun.cancel(id) })

// ---- 调度设施(GUI 同一套) ----
const manager = new SessionManager({
  events: () => {
    /* headless:会话事件不外推 */
  },
  exit: () => {
    /* headless */
  },
  sessionId: () => {
    /* headless */
  },
  log: () => {
    /* headless */
  },
})
const hub = new NodeLogHub({
  log: () => {
    /* headless */
  },
  progress: () => {
    /* headless */
  },
  exit: () => {
    /* headless */
  },
})
const runner = new WorkflowRunner(
  makeRunnerEnv({
    manager,
    hub,
    emit: () => {
      /* headless:事件不外推 */
    },
  }),
)

interface GraphJson {
  nodes?: { id: string; data: Record<string, unknown> }[]
  edges?: { source: string; target: string }[]
  projectDir?: string
}

async function loadGraphFor(canvasId: string | undefined, graphPath: string | undefined): Promise<GraphJson & { id: string }> {
  if (graphPath) {
    const raw = await fs.promises.readFile(graphPath, 'utf8')
    const g = JSON.parse(raw) as GraphJson
    if (!Array.isArray(g.nodes)) throw new Error(`${graphPath} 不是合法画布 JSON(nodes 缺失)`)
    return { ...g, id: 'external' }
  }
  const id = canvasId || 'default'
  const g = await loadGraph(id)
  if (!g) throw new Error(`画布不存在:${id}(还没有保存过任何节点?)`)
  return { nodes: g.nodes.map((n) => ({ id: n.id, data: n.data as Record<string, unknown> })), edges: g.edges, projectDir: g.projectDir, id }
}

function stateLine(s: RunState, nodeId: string, title: string): { nodeId: string; title: string; status: string; resultPreview: string } {
  const n = s.nodes[nodeId]
  return {
    nodeId,
    title,
    status: n?.status ?? 'unknown',
    resultPreview: n?.outputPreview ?? (n?.error ? `✗ ${n.error}` : ''),
  }
}

const backend: McpBackend = {
  listNodes() {
    // 常用节点清单(避免把全部类型刷屏):主流水线节点 + 生图节点
    const kinds = ['project', 'feature', 'agent', 'router', 'merge', 'review', 'test', 'chart', 'python', 'video', 'handoff', 'image', 'game', 'output']
    return kinds
      .map((k) => {
        const def = getNodeType(k)
        return { kind: k, label: def.label, title: def.defaultTitle }
      })
      .filter(Boolean)
  },

  async runWorkflow(args) {
    const g = await loadGraphFor(args.canvasId, args.graphPath)
    const spec = specFromGraph({
      canvasId: g.id,
      nodes: (g.nodes ?? []).map((n) => ({ id: n.id, data: n.data })),
      edges: (g.edges ?? []).map((e) => ({ source: e.source, target: e.target })),
      targets: args.targets,
      maxParallel: 4,
      inlineLimitBytes: 1 << 20,
      projectDir: g.projectDir,
    })
    const state = await runner.run(spec)
    const titleOf = new Map((g.nodes ?? []).map((n) => [n.id, String((n.data as Record<string, unknown>).title ?? n.id)]))
    return {
      ok: true,
      runId: state.runId,
      nodes: Object.keys(state.nodes).map((id) => stateLine(state, id, titleOf.get(id) ?? id)),
    }
  },

  async getNodeResult(args) {
    const id = args.canvasId ?? 'default'
    const recs = await hub.logsAfter(id, args.nodeId, 0, 120)
    let text: string | undefined
    for (let i = recs.length - 1; i >= 0; i--) {
      const r = recs[i]
      if (r.t === 'event' && r.ev.k === 'result' && r.ev.text) {
        text = r.ev.text
        break
      }
      if (r.t === 'notice' && i === recs.length - 1 && r.text) text = r.text
    }
    return { found: recs.length > 0 || text !== undefined, nodeId: args.nodeId, text }
  },
}

async function main(): Promise<void> {
  const server = new McpServer(backend)
  // ⚠️ stdout 只能有 JSON-RPC 消息(MCP stdio 协议),任何日志走 stderr
  process.stderr.write('chusiz MCP server ready (node-ai-development-tool v0.6.4)\n')
  const code = await runStdioTransport(server)
  process.exit(code)
}

void main().catch((e) => {
  process.stderr.write(`chusiz MCP server fatal: ${(e as Error).message}\n`)
  process.exit(1)
})
