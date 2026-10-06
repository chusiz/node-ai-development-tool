import { spawn, type ChildProcess } from 'node:child_process'
import type { BuiltinActionRequest, BuiltinActionResult } from '../workflow/builtinAction'
import { killProcessTree } from '../agents/kill'

/**
 * 测试执行器:在**项目目录**里跑一条用户给的测试命令,把退出码与日志回传。
 *
 * ## 为什么是内置动作,而不是一个"跑 npm test 的 agent"
 *
 * 跑测试不需要判断力:在哪个目录跑、跑什么命令、看退出码 —— 全是确定的事。
 * 让一个 LLM 会话去"帮我跑一下 npm test"要烧 token、要几十秒的思考,还会
 * 出现"它说通过了但其实没跑"这种最坏情况。内置执行器**只认退出码**,
 * 通没通过是客观事实,没有解释空间。
 *
 * ## 与 Packager 同构(账本 / 取消 / 清场)
 *
 * 三个方法一对一是刻意的:`live` 表记活着的子进程、`cancel` 幂等无副作用、
 * `killAll` 退场连树杀。runner 的 `cancelBuiltin` 会遍历注册表无脑串,
 * 所以这里的每个方法都必须能安全地被随便调用。
 *
 * ## ⚠️ shell:true 是显式例外(理由与 imagegen 的 local-command 一致)
 *
 * 用户填的**本质是一条命令行**(`npm run test:unit && npm run lint`),带
 * 引号、`&&`、管道 —— 这些 `shell:false` 表达不了。执行器**不拼**任何来自
 * 上游产出的文本进命令行(命令完全由用户在节点配置里手填),所以没有注入面:
 * 唯一的输入源就是配置面板 / graph.json,那是用户自己的东西。
 */
export class TestRunner {
  /** nodeId → 正在跑的测试子进程 */
  private live = new Map<string, ChildProcess>()
  /** 被 cancel / 超时杀掉的节点。close 时据此把结果判成"已取消 / 超时" */
  private killed = new Set<string>()
  /** 因超时被杀的节点(与"用户主动取消"结局不同,文案也该不同) */
  private timedOut = new Set<string>()

  async run(req: BuiltinActionRequest): Promise<BuiltinActionResult> {
    const cmd = (req.testCommand ?? '').trim()
    if (!cmd) return { ok: false, log: '', error: '还没填写要跑的测试命令' }
    if (!req.projectDir) {
      return { ok: false, log: '', error: '没有项目文件夹,不知道在哪儿跑测试(先给项目节点选个文件夹)' }
    }
    if (this.live.has(req.nodeId)) {
      // 理论到不了:调度器保证一个节点同时在跑的只有一路。兜一层防账本漏记
      return { ok: false, log: '', error: `节点 ${req.nodeId} 已有一个测试在跑` }
    }

    const cwd = req.projectDir
    const timeoutSec = clampTimeout(req.testTimeoutSec)

    const acc = new LogAccumulator(req.onProgress)
    const done = (r: BuiltinActionResult): BuiltinActionResult => {
      this.live.delete(req.nodeId)
      this.killed.delete(req.nodeId)
      this.timedOut.delete(req.nodeId)
      return r
    }

    return await new Promise<BuiltinActionResult>((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(cmd, {
          // ⚠️ 见文件头:用户给的是一条命令行,必须经 shell
          shell: true,
          cwd,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        resolve(done({ ok: false, log: acc.text(), error: `无法启动测试命令:${msg}` }))
        return
      }

      this.live.set(req.nodeId, child)
      acc.pump(child.stdout)
      acc.pump(child.stderr)

      const timer = setTimeout(() => {
        this.timedOut.add(req.nodeId)
        this.killed.add(req.nodeId)
        acc.note(`⏱ 超过 ${timeoutSec} 秒,已强制结束`)
        if (child.pid) void killProcessTree(child.pid)
      }, timeoutSec * 1000)

      child.on('error', (e) => {
        clearTimeout(timer)
        const code = (e as NodeJS.ErrnoException).code
        /*
         * shell:true 下 shell 本身总是存在的,所以 ENOENT 几乎只可能是 **cwd 不存在**
         * (项目文件夹被删了 / 路径写错了)。这条要单独说清,不然用户会去查命令。
         */
        const err =
          code === 'ENOENT'
            ? `找不到项目文件夹「${cwd}」—— 它可能已被移动或删除,检查一下项目节点里的目录`
            : `无法启动测试命令:${e.message}`
        resolve(done({ ok: false, log: acc.text(), error: err }))
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        const wasKilled = this.killed.has(req.nodeId)
        const wasTimeout = this.timedOut.has(req.nodeId)
        const log = acc.text()

        if (wasKilled) {
          resolve(
            done({
              ok: false,
              log,
              exitCode: code,
              error: wasTimeout
                ? `测试超时(${timeoutSec} 秒),已强制结束`
                : '测试已取消',
            }),
          )
          return
        }

        if (code === 0) {
          resolve(done({ ok: true, log, exitCode: 0 }))
          return
        }

        // "没跑起来"(命令不存在)与"跑起来了但没过"是两件事,文案必须分开 ——
        // 前者要用户去查命令/安装,后者要用户去看失败的用例
        const notFound = notFoundHint(code, log)
        resolve(
          done({
            ok: false,
            log,
            exitCode: code,
            error: notFound
              ? '找不到要执行的命令 —— 它可能没安装或不在 PATH 里'
              : `测试未通过(退出码 ${code ?? '未知'})`,
          }),
        )
      })
    })
  }

  /** 取消某个节点的测试子进程。返回是否真有在跑的(幂等无副作用) */
  cancel(nodeId: string): boolean {
    const child = this.live.get(nodeId)
    if (!child) return false
    this.killed.add(nodeId)
    if (child.pid) void killProcessTree(child.pid)
    return true
  }

  /** 退出清场:杀掉全部测试子进程树(测试脚本常会再派生 node 子进程,必须连树杀) */
  killAll(): void {
    for (const [id, child] of this.live) {
      this.killed.add(id)
      if (child.pid) void killProcessTree(child.pid)
    }
    this.live.clear()
  }
}

/** 超时夹到 5..3600 秒。normalize 已把关,这里守第二道(磁盘上的值可能是任意数) */
function clampTimeout(n: number | undefined): number {
  const v = Number(n)
  if (!Number.isFinite(v)) return 300
  return Math.max(5, Math.min(3600, Math.trunc(v)))
}

/**
 * "命令不存在"的启发式判定。
 *
 * 与 imagegen 的 local-command 同一套阈值:Windows 经 cmd.exe 表现为 9009,
 * POSIX 上是 127 或 "command not found"。判不出来时不硬猜 —— 那就是"跑起来了但没过",
 * 已经是完整的信息(退出码 + 日志)。
 */
function notFoundHint(code: number | null, log: string): boolean {
  return (
    code === 9009 ||
    code === 127 ||
    /is not recognized|command not found|不是内部或外部命令|找不到|拒绝访问/i.test(log)
  )
}

/**
 * 日志累积器。
 *
 * 测试命令的输出可能非常大(全量测试 + 覆盖率报告轻松几十万字符),而这份日志
 * 要经 IPC 传回渲染进程、还要写进节点产出。所以设一个上限:超了就**丢掉最早的行**
 * 并留下一条说明 —— 失败原因几乎总在尾部(失败的用例、堆栈),保尾比保头有用。
 */
const MAX_LOG_CHARS = 200_000

class LogAccumulator {
  private lines: string[] = []
  private chars = 0
  private dropped = 0

  constructor(private readonly onLine?: (line: string) => void) {}

  /** 按行收割流。乱码只影响可读性,不影响成败判定(判定只看退出码) */
  pump(stream: NodeJS.ReadableStream | null): void {
    if (!stream) return
    let buf = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      buf += chunk
      for (;;) {
        const nl = buf.indexOf('\n')
        if (nl < 0) break
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (line.trim()) this.push(line)
      }
    })
  }

  /** 追加一条带前缀的说明行(超时提示等,不由子进程产出) */
  note(line: string): void {
    this.push(line)
  }

  private push(line: string): void {
    this.onLine?.(line)
    this.lines.push(line)
    this.chars += line.length + 1
    while (this.chars > MAX_LOG_CHARS && this.lines.length > 1) {
      const dropped = this.lines.shift()
      this.chars -= (dropped?.length ?? 0) + 1
      this.dropped++
    }
  }

  text(): string {
    const head = this.dropped > 0 ? [`(前面 ${this.dropped} 行过长,已省略)`] : []
    return [...head, ...this.lines].join('\n')
  }
}
