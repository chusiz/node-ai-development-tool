import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { canvasBlobsDir } from '../paths'
import { ensureDir } from './atomic'

/**
 * 内容寻址的大内容存储。
 *
 * 文件名就是内容的 sha1,所以**天然去重**:同一段内容写一百次也只占一份。
 * 两个地方用它 ——
 *   ① 日志里超阈值的 tool_result(避免 10MB 冲进 IPC 和渲染进程内存);
 *   ② 工作流里超限的上游产出(注入文件路径而不是全文)。
 * 抽出来共用,免得同一条"sha1 + 去重 + 目录"的规则写两遍、改一处漏一处。
 */
export interface BlobRef {
  hash: string
  /** 磁盘上的绝对路径,写进 prompt 给下游 agent 用 */
  file: string
  bytes: number
}

export async function writeBlob(canvasId: string, text: string): Promise<BlobRef> {
  const hash = createHash('sha1').update(text, 'utf8').digest('hex')
  const dir = canvasBlobsDir(canvasId)
  await ensureDir(dir)
  const file = path.join(dir, `${hash}.txt`)
  try {
    // 已经写过就跳过 —— 内容寻址的意义就在这里
    await fsp.access(file)
  } catch {
    await fsp.writeFile(file, text, 'utf8')
  }
  return { hash, file, bytes: text.length }
}
