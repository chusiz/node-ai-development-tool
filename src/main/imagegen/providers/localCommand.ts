import { spawn, type ChildProcess } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ImageProviderConfig } from '../../../shared/canvas'
import { killProcessTree } from '../../agents/kill'
import { expandEnv, expandTokens, escapeJsonInner, PROMPT_TOKEN_RE } from '../template'
import type { ImageCtl, ProviderCtx, ProviderResult } from '../types'

/**
 * provider = local-command(默认,不需要 API key)。
 *
 * ## ★ S1:命令注入防护(本文件最硬的约束)
 *
 * 画面描述(`ctx.prompt`)来自**不可信输入**(上游 agent 产出 / 项目文件内容)。
 * 本 provider **绝不**把它拼进命令行:
 *   - 命 `{{prompt}}` → 硬失败(人话提示改用 `{{promptFile}}` / `CANVAS_PROMPT`);
 *   - 画面描述写进一个**框架生成的临时文件**,命令模板用 `{{promptFile}}` 引用它;
 *   - 同时注入环境变量 `CANVAS_PROMPT` / `CANVAS_OUT_DIR` / `CANVAS_N` / `CANVAS_SIZE` / `CANVAS_SEED`。
 * 于是命令行里**永远不出现画面描述文本** → 无注入面。
 *
 * ## ⚠️ shell:true —— 对项目 `shell:false` 惯例的显式例外
 *
 * packager 全程 shell:false(避开 cmd 引号解析 + GBK 乱码)。这里**必须用 shell**,
 * 因为用户给的**本质是一条命令行**(引号、管道、重定向),shell:false 表达不了。
 * 缓解:出图判定**只依赖文件系统扫描**(artifactScan),不解析 stdout;日志按 utf8 读、
 * 容忍乱码(乱码只影响日志可读性,不影响"是否出图")。
 */

/** 单条命令里我们需要的 provider 分支类型 */
type LocalCfg = Extract<ImageProviderConfig, { kind: 'local-command' }>

/** 取命令的"首段"(可执行文件名),用于 ENOENT / 未识别的报错文案 */
function firstSegment(cmd: string): string {
  const t = cmd.trim().replace(/^["']/, '')
  const sp = t.search(/\s/)
  return (sp < 0 ? t : t.slice(0, sp)).replace(/["']$/, '')
}

/**
 * 写画面描述到临时文件,返回路径。路径由框架生成、**不含用户文本**(安全)。
 * 落在系统临时目录(不落项目里,免得污染素材目录)。
 */
async function writePromptFile(nodeId: string, prompt: string): Promise<string> {
  const f = path.join(os.tmpdir(), `haowan-image-prompt-${nodeId}-${Date.now().toString(36)}.txt`)
  await fsp.writeFile(f, prompt, 'utf8')
  return f
}

/** 安静地删掉临时文件(失败无所谓,不影响出图结果) */
function cleanupPromptFile(f: string): void {
  void fsp.unlink(f).catch(() => {})
}

/** 按行收割子进程输出。乱码只影响可读性,不影响成败判定 */
function pumpLines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
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
      if (line.trim()) onLine(line)
    }
  })
}

export async function runLocalCommand(
  cfg: LocalCfg,
  ctx: ProviderCtx,
  ctl: ImageCtl,
): Promise<ProviderResult> {
  const lines: string[] = []
  const log = (): string => lines.join('\n')
  const onLine = (l: string): void => {
    lines.push(l)
    ctx.onProgress?.(l)
  }

  const rawCmd = cfg.command ?? ''

  // ★ S1:命令模板里出现 {{prompt}} → 硬失败(从根上杜绝拼接)
  if (PROMPT_TOKEN_RE.test(rawCmd)) {
    return {
      status: 'fail',
      log: '',
      error:
        '命令里不能直接拼接画面描述(会有命令注入风险);请改用 {{promptFile}} 或环境变量 CANVAS_PROMPT',
    }
  }

  /* ★ 纵深防御:n / seed 必须是有限数字(理由见 http.ts 同名守卫)。
     normalize 已把关,这里执行器再守一道 —— 否则 `{{seed}}` 会把非数字原样拼进命令行/环境变量。 */
  if (!Number.isFinite(ctx.n)) return { status: 'fail', log: '', error: '张数必须是 1-8 的数字' }
  if (ctx.seed !== undefined && !Number.isFinite(ctx.seed)) {
    return { status: 'fail', log: '', error: '随机种子必须是数字' }
  }

  // ②-a 先展开 {{env:VAR}}(D5:缺失 → 报错,不展开为空)
  const envExp = expandEnv(rawCmd, process.env)
  if (envExp.missing.length > 0) {
    return {
      status: 'fail',
      log: '',
      error: `环境变量 ${envExp.missing.join('、')} 没有设置 —— 先在系统里设置该环境变量,然后重启应用(环境变量在启动时读取)`,
    }
  }

  // 画面描述落临时文件 → {{promptFile}}(路径不含用户文本)
  const promptFile = await writePromptFile(ctx.nodeId, ctx.prompt)

  // ②-b 展开 provider 占位符
  const cmd = expandTokens(envExp.text, {
    outDir: ctx.outDir,
    n: String(ctx.n),
    size: ctx.size,
    seed: ctx.seed != null ? String(ctx.seed) : '',
    promptFile,
    // 负提示词(v0.4.2):模板 token 做 JSON 转义(与 HTTP provider 对齐)
    negativePrompt: escapeJsonInner(ctx.negativePrompt ?? ''),
    negativePromptJson: JSON.stringify(ctx.negativePrompt ?? ''),
  })

  const cwd = cfg.cwd?.trim() || ctx.projectDir
  const timeoutSec = cfg.timeoutSec ?? 600

  return await new Promise<ProviderResult>((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(cmd, {
        // ⚠️ shell:true 是显式例外(见文件头注释)—— 用户给的本是一条命令行
        shell: true,
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // 注入画布专属变量供命令读取(command line 里不必出现 prompt 文本)
          CANVAS_PROMPT: ctx.prompt,
          CANVAS_OUT_DIR: ctx.outDir,
          CANVAS_N: String(ctx.n),
          CANVAS_SIZE: ctx.size,
          CANVAS_SEED: ctx.seed != null ? String(ctx.seed) : '',
          CANVAS_NEGATIVE_PROMPT: ctx.negativePrompt ?? '',
        },
      })
    } catch (e) {
      cleanupPromptFile(promptFile)
      const msg = e instanceof Error ? e.message : String(e)
      resolve({ status: 'fail', log: log(), error: `无法启动出图命令:${msg}` })
      return
    }

    ctl.registerChild(ctx.nodeId, child)
    pumpLines(child.stdout, onLine)
    pumpLines(child.stderr, onLine)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ctl.markKilled(ctx.nodeId)
      if (child.pid) void killProcessTree(child.pid)
    }, timeoutSec * 1000)

    child.on('error', (e) => {
      clearTimeout(timer)
      ctl.unregisterChild(ctx.nodeId)
      cleanupPromptFile(promptFile)
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        resolve({
          status: 'fail',
          log: log(),
          error: `找不到要执行的命令「${firstSegment(cmd)}」—— 它可能没安装或不在 PATH 里`,
        })
      } else {
        resolve({ status: 'fail', log: log(), error: `无法启动出图命令:${e.message}` })
      }
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      ctl.unregisterChild(ctx.nodeId)
      cleanupPromptFile(promptFile)

      if (ctl.isKilled(ctx.nodeId)) {
        // 区分"用户取消"与"超时杀掉":两者结局不同,文案也该不同
        resolve({ status: timedOut ? 'timeout' : 'cancelled', log: log() })
        return
      }
      if (code === 0) {
        resolve({ status: 'ok', log: log() })
        return
      }
      // 非 0 退出。Windows 上"命令不存在"经 cmd.exe 表现为退出码 9009 / 特定 stderr,
      // POSIX 上是 127 / "command not found" —— 都归到情况 3(人话提示装/找路径)。
      const notFound =
        code === 9009 ||
        code === 127 ||
        /is not recognized|command not found|不是内部或外部命令|找不到/i.test(log())
      resolve({
        status: 'fail',
        log: log(),
        error: notFound
          ? `找不到要执行的命令「${firstSegment(cmd)}」—— 它可能没安装或不在 PATH 里`
          : `出图命令失败(退出码 ${code ?? '未知'}),日志见下方`,
      })
    })
  })
}
