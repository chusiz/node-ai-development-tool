import { nativeImage } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * 缩略图只读通道(S2)—— 渲染端不直接碰 fs,但要显示图像节点的产出缩略图。
 *
 * ## ★ 这个通道绝不能变成"任意文件读取"
 *
 * 渲染端传进来的 `projectDir + relPath` **一律当不可信输入**,主进程做四道校验:
 *   ① **白名单化范围**:只允许 `<projectDir>/assets/generated/**`;
 *   ② **规范化前缀校验**:`path.resolve` 之后必须落在白名单目录内(挡 `..` 穿越);
 *   ③ **realpath 再校验**:软链 / junction 可能指向白名单外 —— 规范化前缀校验
 *      挡不住软链(字符串是合法的,解析后才逃逸),所以必须再 realpath 一次比对;
 *   ④ **扩展名白名单 + 单文件大小上限**。
 * 只回 `nativeImage` 缩放后的**小尺寸缩略图**(零新增依赖)。
 *
 * 校验放**主进程**:渲染端传绝对路径 / `..` 一律拒 —— 渲染端输入不可信。
 *
 * ## Windows 的坑(都覆盖了)
 *   - 盘符大小写:C 与 c 是同一个盘,比较前统一小写;
 *   - `\\?\` 长路径前缀:先剥掉再比较;
 *   - UNC 路径(`\\server\share\x.png`):`path.isAbsolute` 判为绝对 → 直接拒。
 */

/** 允许读取的图片扩展名 */
const EXT_WHITELIST = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
/** 单文件大小上限(约 20MB)—— 超过不读,防 OOM */
const MAX_BYTES = 20 * 1024 * 1024
/** 缩略图最长边(像素) */
const THUMB_MAX = 160

export interface Thumb {
  dataUrl: string
  w: number
  h: number
}

/**
 * 最小结构接口 —— 与 Electron `NativeImage` 兼容,便于 e2e 注入假解码器
 * (e2e 跑在纯 node 环境,没有 Electron 的 nativeImage)。
 */
export interface ThumbSource {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: { width: number; height: number; quality?: string }): ThumbSource
  toDataURL(): string
}
export type ImageDecoder = (buf: Buffer) => ThumbSource

/** 默认解码器:Electron 内置 nativeImage(零新增依赖) */
const defaultDecoder: ImageDecoder = (buf) => nativeImage.createFromBuffer(buf) as unknown as ThumbSource

/**
 * Windows 路径归一化:剥 `\\?\` 前缀 + 小写(盘符/大小写不敏感)。
 * 比较前两边都过一遍,消除"看着不同其实同一文件"的绕过。
 */
function normalizeForCompare(p: string): string {
  let s = p.replace(/^\\\\\?\\/, '')
  if (process.platform === 'win32') s = s.toLowerCase()
  return s
}

/** target 是否严格落在 baseDir 之内(baseDir 自身不算) */
function isInside(baseDir: string, target: string): boolean {
  const b = normalizeForCompare(baseDir).replace(/[\\/]+$/, '')
  const t = normalizeForCompare(target)
  if (t === b) return false
  return t.startsWith(b + path.sep) || t.startsWith(b + '/') || t.startsWith(b + '\\')
}

/**
 * 把「项目文件夹 + 相对路径」解析成一个**已通过全部安全校验**的绝对路径;
 * 不合法一律返回 null。**纯 fs,不依赖 Electron** —— e2e 可直接断言攻击样例。
 */
export async function resolveSafeImagePath(projectDir: string, relPath: string): Promise<string | null> {
  if (!projectDir || !relPath) return null
  try {
    // 绝对路径(盘符 / UNC / `/etc/...`)一律拒 —— 相对路径才可能是白名单内的
    if (path.isAbsolute(relPath)) return null

    const projectRoot = path.resolve(projectDir)
    const baseDir = path.join(projectRoot, 'assets', 'generated')
    const target = path.resolve(projectRoot, relPath)

    // ② 规范化前缀校验(挡 `..` 穿越)
    if (!isInside(baseDir, target)) return null

    // ③ realpath 再校验(挡软链 / junction 逃逸)。realpath 会解析每一段
    const realBase = await fsp.realpath(baseDir)
    const realTarget = await fsp.realpath(target)
    if (!isInside(realBase, realTarget)) return null

    // ④ 扩展名 + 大小
    const ext = path.extname(realTarget).toLowerCase()
    if (!EXT_WHITELIST.has(ext)) return null
    const st = await fsp.stat(realTarget)
    if (!st.isFile() || st.size > MAX_BYTES) return null

    return realTarget
  } catch {
    // 不存在 / 无权限 / 软链解析失败 —— 一律视为不可读
    return null
  }
}

/**
 * 读一张缩略图。校验通过 → 返回缩放后的小尺寸 dataUrl;否则 null。
 *
 * `decode` 可注入(e2e 用假解码器);真应用用 Electron nativeImage。
 */
export async function readThumb(
  projectDir: string,
  relPath: string,
  decode: ImageDecoder = defaultDecoder,
): Promise<Thumb | null> {
  const real = await resolveSafeImagePath(projectDir, relPath)
  if (!real) return null
  try {
    const buf = await fsp.readFile(real)
    const img = decode(buf)
    if (!img || img.isEmpty()) return null
    const { width, height } = img.getSize()
    if (!width || !height) return null
    // 等比缩放到最长边 ≤ THUMB_MAX(小图不放大)
    const scale = Math.min(1, THUMB_MAX / Math.max(width, height))
    const out =
      scale < 1
        ? img.resize({
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale)),
            quality: 'good',
          })
        : img
    const dataUrl = out.toDataURL()
    if (!dataUrl) return null
    const size = out.getSize()
    return { dataUrl, w: size.width, h: size.height }
  } catch {
    return null
  }
}
