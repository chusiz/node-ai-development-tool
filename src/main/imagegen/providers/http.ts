import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ImageProviderConfig } from '../../../shared/canvas'
import { escapeJsonInner, expandEnv, expandTokens, stripCrlf } from '../template'
import type { ImageCtl, ProviderCtx, ProviderResult } from '../types'

/**
 * provider = http(适配 OpenAI 兼容 /v1/images/generations 及各类在线服务)。
 *
 * ## ★ S1:请求体 JSON 注入防护
 *
 * 画面描述来自不可信输入,嵌进请求体模板时**必须 JSON 转义**:
 *   - `{{prompt}}`        → JSON.stringify(prompt).slice(1, -1)(去外层引号的转义正文,
 *     只能出现在 JSON 字符串字面量**内部**);
 *   - `{{promptJson}}`    → JSON.stringify(prompt)(含引号的整值);
 *   - `{{n}}` / `{{seed}}` → 数字校验后原样;`{{size}}` → JSON 转义(字符串)。
 * 于是注入串(`"; echo pwned` 等)不会破坏 JSON 结构。
 *
 * ## 请求头单独处理
 *
 * header 语义不同于 JSON:`{{env:VAR}}` 用**原始值但剥离 CR/LF**(防 header 注入),
 * 不做 JSON 转义。
 *
 * ## 响应取值走**安全路径解析**
 *
 * `data[0].b64_json` 这类路径只允许"对象按 key、数组按 index"逐段下降;
 * **拒绝** `__proto__` / `prototype` / `constructor`;不 eval、不 new Function。
 * 防"恶意响应把取值路径指到别处"。
 *
 * 响应体与解码后图片都设大小上限(防 OOM)。
 */

type HttpCfg = Extract<ImageProviderConfig, { kind: 'http' }>

/** 响应体字符上限(约 64MB)。超限报错,不 OOM */
const MAX_RESPONSE_CHARS = 64 * 1024 * 1024
/** 单张图片字节上限(约 32MB) */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024

/** 原型污染相关的危险键 —— 安全路径解析遇到即拒绝 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

/**
 * 安全取值路径解析:`data[0].b64_json` / `data.images` → 逐段下降取值。
 *
 * 只允许:对象按自有 key、数组按数字 index;遇到危险原型键 / 不存在 → undefined。
 * **不 eval、不 new Function** —— 那是把恶意响应变成任意代码执行。
 */
export function pickByPath(root: unknown, pathStr: string): unknown {
  if (!pathStr || !pathStr.trim()) return undefined
  // data[0].b64_json → data.0.b64_json → ['data','0','b64_json']
  const parts = pathStr
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((s) => s !== '')

  let cur: unknown = root
  for (const part of parts) {
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(part)) return undefined
      const idx = Number.parseInt(part, 10)
      if (idx >= cur.length) return undefined
      cur = cur[idx]
    } else if (cur !== null && typeof cur === 'object') {
      if (FORBIDDEN_KEYS.has(part)) return undefined
      if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined
      cur = (cur as Record<string, unknown>)[part]
    } else {
      return undefined
    }
    if (cur === undefined) return undefined
  }
  return cur
}

/** 下载一个 URL 到目标文件(带超时 / 取消信号 + 体积上限) */
async function downloadTo(url: string, dest: string, signal: AbortSignal): Promise<void> {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`下载图片失败:HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length === 0) throw new Error('下载到的图片为空')
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('下载的图片过大(超过 32MB)')
  await fsp.writeFile(dest, buf)
}

export async function runHttp(cfg: HttpCfg, ctx: ProviderCtx, ctl: ImageCtl): Promise<ProviderResult> {
  const lines: string[] = []
  const onLine = (l: string): void => {
    lines.push(l)
    ctx.onProgress?.(l)
  }
  const log = (): string => lines.join('\n')
  const fail = (error: string): ProviderResult => ({ status: 'fail', log: log(), error })

  /*
   * ★ 纵深防御:provider **不信任入参**里的 n / seed(架构 §5.3:「{{n}}/{{seed}} 先按
   *   数字校验」)。normalize(applyTypeDefaults)是入口把关,执行器是最后一道 —— 两层都要有。
   *   不这么做的后果:seed 若为字符串(如 `1},"x":"`),会经 `{{seed}}` 原样拼进请求体,
   *   前后各补一个 `}` 就能破坏 JSON 结构 → 请求体语义被注入者控制(即便正常路径不可达)。
   */
  if (!Number.isFinite(ctx.n)) return fail('张数必须是 1-8 的数字')
  if (ctx.seed !== undefined && !Number.isFinite(ctx.seed)) return fail('随机种子必须是数字')

  // --- endpoint(支持 {{env:}})---
  const ep = expandEnv(cfg.endpoint ?? '', process.env)
  if (ep.missing.length > 0) {
    return fail(`环境变量 ${ep.missing.join('、')} 没有设置 —— 先在系统里设置该环境变量,然后重启应用(环境变量在启动时读取)`)
  }
  const endpoint = ep.text

  // --- headers(值支持 {{env:}},剥 CR/LF)---
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(cfg.headers ?? {})) {
    const hv = expandEnv(v, process.env)
    if (hv.missing.length > 0) {
      return fail(`环境变量 ${hv.missing.join('、')} 没有设置 —— 先在系统里设置该环境变量,然后重启应用(环境变量在启动时读取)`)
    }
    headers[k] = stripCrlf(hv.text)
  }

  // --- body({{env:}} 先,provider 占位符后;{{prompt}} JSON 转义)---
  let body: string | undefined
  const bodyTpl = cfg.bodyTemplate ?? ''
  if (bodyTpl.trim()) {
    const be = expandEnv(bodyTpl, process.env)
    if (be.missing.length > 0) {
      return fail(`环境变量 ${be.missing.join('、')} 没有设置 —— 先在系统里设置该环境变量,然后重启应用(环境变量在启动时读取)`)
    }
    // {{width}}/{{height}}:从 size("1024x1024")拆出两个数字 —— A1111 这类本地服务
    // 的 txt2img 协议要分开的宽高,而面板上用户只填一个尺寸串。
    const [wStr, hStr] = ctx.size.split(/[xX×]/)
    body = expandTokens(be.text, {
      prompt: escapeJsonInner(ctx.prompt),
      promptJson: JSON.stringify(ctx.prompt),
      negativePrompt: escapeJsonInner(ctx.negativePrompt ?? ''),
      negativePromptJson: JSON.stringify(ctx.negativePrompt ?? ''),
      n: String(ctx.n),
      size: escapeJsonInner(ctx.size),
      width: String(Number.parseInt(wStr ?? '', 10) || 1024),
      height: String(Number.parseInt(hStr ?? '', 10) || 1024),
      // seed 为空 → "null"(JSON 里合法);有值 → 数字
      seed: ctx.seed != null ? String(ctx.seed) : 'null',
    })
  }

  const method = cfg.method ?? 'POST'
  // ★ 真实缺陷修复(本地 SD WebUI 实测发现):字符串 JSON body 必须有
  //   Content-Type: application/json,否则 FastAPI 类后端(A1111 等)拿到
  //   text/plain 解析不了 → HTTP 422。用户没显式指定时默认补上
  //   (用户显式指定过则以用户为准,大小写不敏感)。
  if (body !== undefined && body.trim() !== '' && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json'
  }
  const timeoutSec = cfg.timeoutSec ?? 120
  const ac = new AbortController()
  ctl.registerAbort(ctx.nodeId, ac)

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctl.markKilled(ctx.nodeId)
    ac.abort()
  }, timeoutSec * 1000)

  try {
    const res = await fetch(endpoint, { method, headers, body, signal: ac.signal })
    if (!res.ok) {
      return fail(
        `图像服务返回 HTTP ${res.status}${res.statusText ? ':' + res.statusText : ''} —— 检查密钥/请求头;{{env:XXX}} 的密钥是否已在环境变量里设置(改完需重启应用)`,
      )
    }

    const text = await res.text()
    if (text.length > MAX_RESPONSE_CHARS) return fail('图像服务的响应过大(超过 64MB),已拒绝')

    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return fail('图像服务的响应不是合法 JSON —— 检查 endpoint 是否指向了图像接口')
    }

    const picked = pickByPath(json, cfg.responsePath ?? '')
    if (picked === undefined || picked === null) {
      return fail('在图像服务的响应里没找到图片 —— 取值路径可能不对')
    }

    // 取值可能是单个字符串,或字符串数组
    const items: string[] = Array.isArray(picked)
      ? picked.filter((x): x is string => typeof x === 'string')
      : typeof picked === 'string'
        ? [picked]
        : []
    if (items.length === 0) return fail('在图像服务的响应里没找到图片 —— 取值路径可能不对')

    const ext = (cfg.format ?? 'png').replace(/[^A-Za-z0-9]/g, '') || 'png'
    const responseType = cfg.responseType ?? 'base64'

    let i = 0
    for (const item of items) {
      i += 1
      const fname = `img-${ctx.startTs}-${String(i).padStart(3, '0')}.${ext}`
      const dest = path.join(ctx.outDir, fname)
      if (responseType === 'url') {
        await downloadTo(item, dest, ac.signal)
        onLine(`[图像] 已下载 ${fname}`)
      } else {
        const buf = Buffer.from(item, 'base64')
        if (buf.length === 0) return fail('base64 解码失败 —— 检查"响应类型"是否应为 base64')
        if (buf.length > MAX_IMAGE_BYTES) return fail('解码后的图片过大(超过 32MB),已拒绝')
        await fsp.writeFile(dest, buf)
        onLine(`[图像] 已写入 ${fname}`)
      }
    }
    return { status: 'ok', log: log() }
  } catch (e) {
    if (ctl.isKilled(ctx.nodeId)) {
      return { status: timedOut ? 'timeout' : 'cancelled', log: log() }
    }
    const msg = e instanceof Error ? e.message : String(e)
    return fail(`请求图像服务失败:${msg}`)
  } finally {
    clearTimeout(timer)
    ctl.unregisterAbort(ctx.nodeId)
  }
}
