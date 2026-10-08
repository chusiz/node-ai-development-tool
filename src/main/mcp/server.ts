/**
 * MCP (Model Context Protocol) Server(v0.6.4,改进建议第三条):
 * 让 Claude / Cursor 等外部 AI 助手通过 MCP 调用 chusiz 的工作流 ——
 * 节点画布成为 AI 助手的"工具库",而不只是独立应用。
 *
 * 实现:JSON-RPC 2.0 over stdio(换行分隔),零外部依赖、完全可控、可单测。
 * 提供工具:
 *   - list_nodes        列出注册表里的全部节点类型(名字/说明/端口);
 *   - run_workflow      执行一个画布工作流(按 canvasId 或 graphPath),返回各节点结果摘要;
 *   - get_node_result   读指定节点最近一次产出(结果文本/产物路径)。
 *
 * Backend 是注入的:主进程里接真实 runner,MCP 进程里接 headless env,e2e 里接假后端。
 */

export interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpBackend {
  listNodes(): { kind: string; label: string; title?: string }[]
  runWorkflow(args: { canvasId?: string; graphPath?: string; targets?: string[] }): Promise<{
    ok: boolean
    runId?: string
    nodes: { nodeId: string; title: string; status: string; resultPreview: string }[]
    error?: string
  }>
  getNodeResult(args: { canvasId?: string; nodeId: string }): Promise<{
    found: boolean
    nodeId: string
    text?: string
    artifacts?: string[]
  }>
}

const TOOLS: McpToolDef[] = [
  {
    name: 'list_nodes',
    description: '列出 node-ai-development-tool 节点注册表里的全部节点类型(名字、中文说明、输入输出端口)。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'run_workflow',
    description:
      '执行一个节点画布工作流。传 canvasId(项目名,如 default)或 graphPath(画布 JSON 文件绝对路径),可选 targets(只跑指定节点 id 列表);返回每个节点的执行状态与结果摘要。',
    inputSchema: {
      type: 'object',
      properties: {
        canvasId: { type: 'string', description: '画布/项目 id,如 default' },
        graphPath: { type: 'string', description: '画布 JSON 文件绝对路径(与 canvasId 二选一)' },
        targets: { type: 'array', items: { type: 'string' }, description: '只跑这些节点(默认全图)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_node_result',
    description: '读取指定节点最近一次执行的产出(结果文本 / 产物相对路径)。',
    inputSchema: {
      type: 'object',
      properties: {
        canvasId: { type: 'string', description: '画布/项目 id,如 default' },
        nodeId: { type: 'string', description: '节点 id(如 proj-xxx / feat-xxx)' },
      },
      required: ['nodeId'],
      additionalProperties: false,
    },
  },
]

/** JSON-RPC 错误码(MCP 规范) */
const E_PARSE = -32700
const E_INVALID_REQ = -32600
const E_METHOD_NOT_FOUND = -32601
const E_INVALID_PARAMS = -32602
const E_INTERNAL = -32603

export class McpServer {
  private tools = TOOLS
  private initialized = false

  constructor(private readonly backend: McpBackend) {}

  /** 处理一行 JSON-RPC 消息;返回要写回 stdout 的字符串(可能为空 = 通知) */
  async onLine(line: string): Promise<string | null> {
    let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown }
    try {
      msg = JSON.parse(line)
    } catch {
      return this.error(null, E_PARSE, 'Parse error: 不是合法 JSON')
    }
    if (msg.jsonrpc !== '2.0') {
      return this.error(msg.id ?? null, E_INVALID_REQ, 'Invalid Request: 需要 jsonrpc: "2.0"')
    }

    if (msg.method === undefined) return null // 通知/响应,忽略

    try {
      switch (msg.method) {
        case 'initialize':
          this.initialized = true
          return this.ok(msg.id, {
            protocolVersion: '2025-03-26',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'node-ai-development-tool', version: '0.6.4' },
          })
        case 'notifications/initialized':
          return null
        case 'ping':
          return this.ok(msg.id, {})
        case 'tools/list':
          return this.ok(msg.id, { tools: this.tools })
        case 'tools/call': {
          const p = (msg.params ?? {}) as { name?: unknown; arguments?: unknown }
          const name = p.name
          if (typeof name !== 'string') return this.error(msg.id, E_INVALID_PARAMS, 'tools/call 缺 name')
          const args = (p.arguments ?? {}) as Record<string, unknown>
          const text = await this.callTool(name, args)
          return this.ok(msg.id, { content: [{ type: 'text', text }] })
        }
        default:
          return this.error(msg.id, E_METHOD_NOT_FOUND, `Method not found: ${msg.method}`)
      }
    } catch (e) {
      return this.error(msg.id, E_INTERNAL, `Internal error: ${(e as Error).message}`)
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'list_nodes': {
        const nodes = this.backend.listNodes()
        return nodes
          .map((n) => `- ${n.kind}「${n.label}」${n.title ? `: ${n.title}` : ''}`)
          .join('\n')
      }
      case 'run_workflow': {
        const canvasId = typeof args.canvasId === 'string' ? args.canvasId : undefined
        const graphPath = typeof args.graphPath === 'string' ? args.graphPath : undefined
        const targets = Array.isArray(args.targets) ? args.targets.map(String) : undefined
        if (!canvasId && !graphPath) {
          throw new Error('run_workflow 需要 canvasId 或 graphPath 之一')
        }
        const r = await this.backend.runWorkflow({ canvasId, graphPath, targets })
        if (!r.ok) return `执行失败:${r.error ?? '未知错误'}`
        const lines = r.nodes.map(
          (n) => `- ${n.title}(${n.nodeId}): ${n.status}${n.resultPreview ? ` — ${n.resultPreview.slice(0, 120)}` : ''}`,
        )
        return `runId=${r.runId}\n${lines.join('\n')}`
      }
      case 'get_node_result': {
        const nodeId = typeof args.nodeId === 'string' ? args.nodeId : ''
        if (!nodeId) throw new Error('get_node_result 需要 nodeId')
        const canvasId = typeof args.canvasId === 'string' ? args.canvasId : undefined
        const r = await this.backend.getNodeResult({ canvasId, nodeId })
        if (!r.found) return `未找到节点 ${nodeId} 的产出(还没跑过?)`
        const lines = [`节点 ${r.nodeId} 最近产出:`]
        if (r.text) lines.push(r.text.slice(0, 2000))
        if (r.artifacts?.length) lines.push(`产物:\n${r.artifacts.map((a) => `  - ${a}`).join('\n')}`)
        return lines.join('\n')
      }
      default:
        throw new Error(`未知工具:${name}`)
    }
  }

  private ok(id: unknown, result: unknown): string {
    return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result })
  }

  private error(id: unknown, code: number, message: string): string {
    return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
  }
}

/** stdio 传输:逐行读 stdin,响应写 stdout。返回退出码 Promise */
export function runStdioTransport(server: McpServer): Promise<number> {
  return new Promise((resolve) => {
    const rl = require('node:readline').createInterface({ input: process.stdin, crlfDelay: Infinity })
    rl.on('line', (line: string) => {
      if (!line.trim()) return
      server
        .onLine(line)
        .then((out) => {
          if (out) process.stdout.write(out + '\n')
        })
        .catch(() => {
          /* 响应失败不外泄 */
        })
    })
    rl.on('close', () => resolve(0))
    process.stdin.on('error', () => resolve(1))
  })
}
