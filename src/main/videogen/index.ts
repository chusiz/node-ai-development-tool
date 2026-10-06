import fsp from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import type { BuiltinActionRequest, BuiltinActionResult } from '../workflow/builtinAction'
import { slugify } from '../imagegen/slug'
import { keyFor } from '../secrets/store'
import { getProvider } from '../../shared/providers'

/**
 * 视频执行器:内置动作节点 `video` 的主进程实现。
 *
 * ## 底层逻辑为什么与程序节点不同
 *
 * 程序节点是 LLM 文本会话;视频理解是**确定性管线**:
 *   视频 → ffmpeg 抽帧 → 视觉模型逐帧分析 → 汇总文字理解。
 * 不启动 agent 会话、不走 SSE 流式;逐帧请求是 OpenAI 兼容的
 * `/chat/completions`(非流式),每帧一张小图,输出一段描述。
 *
 * ## 成本控制
 *
 * 视觉模型按图计费 → `maxFrames` 就是硬成本上限(默认 8 帧 = 8 个请求,
 * 每个输出上限 300 token)。帧图统一缩到宽 ≤768,不传原始 4K 帧。
 *
 * ## 依赖
 *
 * 抽帧需要本机 ffmpeg(PATH 可找到)。找不到时给清晰的人话提示,
 * 不猜别的工具(Windows 上也没有可靠的内置抽帧器)。
 */
export class VideoGen {
  /** nodeId → 正在飞行的视觉请求(可 abort) */
  private aborts = new Map<string, AbortController>()
  /** 被 cancel / killAll 标记过的节点。据此把结局判成"已取消" */
  private killed = new Set<string>()

  async run(req: BuiltinActionRequest): Promise<BuiltinActionResult> {
    // ---- 前置校验 ----
    if (this.aborts.has(req.nodeId)) {
      return { ok: false, log: '', error: '这个视频节点已经有一个分析任务在跑了' }
    }
    const p = req.videoParams
    if (!p?.source?.trim()) {
      return {
        ok: false,
        log: '',
        error: '视频节点还没填视频文件 —— 在右栏填项目内路径或绝对路径',
      }
    }
    if (!p.providerId?.trim() || !p.model?.trim()) {
      return {
        ok: false,
        log: '',
        error: '视频节点还没选视觉模型 —— 需要支持图片输入的多模态模型(如 doubao-vision / gpt-4o)',
      }
    }
    const provider = getProvider(p.providerId)
    if (!provider) return { ok: false, log: '', error: `未知的服务商:${p.providerId}` }

    // ---- 解析视频路径 ----
    const src = path.isAbsolute(p.source) ? p.source : path.join(req.projectDir, p.source)
    try {
      const st = await fsp.stat(src)
      if (!st.isFile()) return { ok: false, log: '', error: `视频文件不是普通文件:${p.source}` }
    } catch {
      return {
        ok: false,
        log: '',
        error: `找不到视频文件:${p.source}(相对路径按项目文件夹解析为 ${src})`,
      }
    }

    // ---- ffmpeg 探测 ----
    const ffmpeg = findFfmpeg()
    if (!ffmpeg) {
      return {
        ok: false,
        log: '',
        error:
          '抽帧需要 ffmpeg,但 PATH 里找不到 —— 请先安装 ffmpeg(如 winget install ffmpeg / choco install ffmpeg)并重启应用',
      }
    }

    const logs: string[] = []
    const log = (line: string): void => {
      logs.push(line)
      req.onProgress?.(line)
    }
    log(`▶ 开始分析视频:${src}`)
    log(`  抽帧间隔 ${p.frameEverySec ?? 3}s · 上限 ${p.maxFrames ?? 8} 帧 · 模型 ${p.model}`)

    // ---- 逐帧抽帧 + 视觉分析 ----
    const ac = new AbortController()
    this.aborts.set(req.nodeId, ac)
    const frameEvery = Math.max(1, Math.trunc(p.frameEverySec ?? 3))
    const maxFrames = Math.max(1, Math.min(30, Math.trunc(p.maxFrames ?? 8)))
    const key = keyFor(p.providerId)
    const baseUrl = (key ? effectiveBaseUrl(provider) : '') || provider.baseUrl

    const lines: { t: string; text: string }[] = []
    let okFrames = 0
    try {
      for (let i = 0; i < maxFrames; i++) {
        if (this.killed.has(req.nodeId) || ac.signal.aborted) break
        const t = i * frameEvery
        const buf = await extractFrame(ffmpeg, src, t, ac.signal)
        if (!buf) {
          // 超出视频时长(抽不到帧)= 正常结束;其余异常记一行继续下一帧
          if (i === 0) {
            log(`  ⚠️ 第 0 秒就抽不到帧 —— 视频可能为空或损坏`)
          }
          break
        }
        const dataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`
        const desc = await analyzeFrame({
          baseUrl,
          apiKey: key,
          model: p.model,
          frameIndex: i + 1,
          timeSec: t,
          dataUrl,
          signal: ac.signal,
        })
        okFrames++
        lines.push({ t: `[${fmtTime(t)}]`, text: desc })
        log(`  ✓ 第 ${i + 1} 帧(${fmtTime(t)}):${desc.slice(0, 80)}${desc.length > 80 ? '…' : ''}`)
      }
    } catch (e) {
      if (this.killed.has(req.nodeId) || ac.signal.aborted) {
        return { ok: false, log: logs.join('\n'), error: '已取消' }
      }
      return { ok: false, log: logs.join('\n'), error: `分析失败:${e instanceof Error ? e.message : String(e)}` }
    } finally {
      this.aborts.delete(req.nodeId)
    }

    if (okFrames === 0) {
      return {
        ok: false,
        log: logs.join('\n'),
        error: '一帧都没分析出来 —— 视频可能为空、损坏,或 ffmpeg 无法读取该格式',
      }
    }

    // ---- 汇总落盘 ----
    const outDir = path.join(req.projectDir, 'assets', 'generated', slugify(req.nodeTitle ?? 'video', req.nodeId))
    await fsp.mkdir(outDir, { recursive: true })
    const md = `# 视频内容理解\n\n> 来源:${p.source} · 模型:${p.model} · 抽帧间隔 ${frameEvery}s\n\n${lines
      .map((l) => `- ${l.t} ${l.text}`)
      .join('\n')}\n`
    const file = path.join(outDir, 'video-understanding.md')
    await fsp.writeFile(file, md, 'utf8')

    const rel = path.relative(req.projectDir, file).replaceAll('\\', '/')
    log(`✔ 已生成理解文档:${rel}`)
    return {
      ok: true,
      artifacts: [rel],
      // 理解文本直接交给下游({{prev}} / {{node:<id>}} 可取)
      handoffText: md,
      log: logs.join('\n'),
    }
  }

  cancel(nodeId: string): boolean {
    const ac = this.aborts.get(nodeId)
    if (!ac) return false
    this.killed.add(nodeId)
    ac.abort()
    return true
  }

  killAll(): void {
    for (const ac of this.aborts.values()) ac.abort()
    this.aborts.clear()
    for (const id of this.aborts.keys()) this.killed.add(id)
  }
}

/* ============================================================
   抽帧 / 视觉请求
   ============================================================ */

/** PATH 里找 ffmpeg(Windows 上是 ffmpeg.exe) */
function findFfmpeg(): string | null {
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const d of dirs) {
    const cand = path.join(d, name)
    try {
      if (existsSync(cand)) return cand
    } catch {
      /* 忽略坏路径 */
    }
  }
  // 兜底:让 shell 自己找一次(慢但可靠)
  const r = spawnSync(name, ['-version'], { stdio: 'ignore', timeout: 3000 })
  return r.error ? null : name
}

/** 抽第 t 秒的一帧,返回 JPEG buffer;超出时长返回 null */
function extractFrame(ffmpeg: string, src: string, t: number, signal: AbortSignal): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-ss', String(t),
        '-i', src,
        '-frames:v', '1',
        '-vf', 'scale=min(768,iw):-2',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const chunks: Buffer[] = []
    p.stdout.on('data', (d: Buffer) => chunks.push(d))
    let stderr = ''
    p.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000)
    })
    const onAbort = (): void => {
      p.kill('SIGKILL')
    }
    signal.addEventListener('abort', onAbort, { once: true })
    p.on('error', reject)
    p.on('close', (code) => {
      signal.removeEventListener('abort', onAbort)
      const buf = Buffer.concat(chunks)
      if (buf.length === 0) {
        // 没输出 = 该时间点已超出时长(ffmpeg 会报错但没有帧输出)
        resolve(null)
        return
      }
      if (code !== 0 && stderr.includes('does not exist') || stderr.includes('Output file')) {
        resolve(null)
        return
      }
      resolve(buf)
    })
  })
}

interface FrameAnalysisInput {
  baseUrl: string
  apiKey: string
  model: string
  frameIndex: number
  timeSec: number
  dataUrl: string
  signal: AbortSignal
}

/** 让视觉模型看一帧,返回画面描述(OpenAI 兼容 /chat/completions,非流式) */
async function analyzeFrame(a: FrameAnalysisInput): Promise<string> {
  const url = `${a.baseUrl.replace(/\/$/, '')}/chat/completions`
  const body = {
    model: a.model,
    stream: false,
    max_tokens: 300,
    messages: [
      {
        role: 'system',
        content:
          '你是视频内容分析器。用户逐帧发来视频画面,请用简洁中文描述:画面里的内容、人物/物体、界面元素、文字字幕、关键动作。不要臆测画面之外的信息。',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `这是视频的第 ${a.frameIndex} 帧(时间 ${fmtTime(a.timeSec)})。请描述这一帧。` },
          { type: 'image_url', image_url: { url: a.dataUrl } },
        ],
      },
    ],
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(a.apiKey ? { Authorization: `Bearer ${a.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: a.signal,
  })
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300)
    throw new Error(`视觉模型请求失败(HTTP ${res.status})${detail ? ` · ${detail}` : ''}`)
  }
  const raw = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  const text = raw.choices?.[0]?.message?.content?.trim()
  if (!text) throw new Error('视觉模型没有返回内容')
  return text
}

/** 服务的有效地址:与 buildApiCtx 同一回落(用户覆盖 → 内置默认) */
function effectiveBaseUrl(provider: { baseUrl: string }): string {
  return provider.baseUrl
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
