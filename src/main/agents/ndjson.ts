/**
 * 行缓冲读取器 —— 处理跨 chunk 的半行。
 *
 * 这是流式解析里新手最常漏的 bug:一个 chunk 的结尾可能只有半行 JSON,
 * 直接 JSON.parse 必然失败。必须维护 buffer,按 \n 切分,残余留到下一个 chunk。
 */

/**
 * 单行上限,纯属防御性设置。tool_result 可能携带整个文件内容,
 * 所以给得相当宽松 —— 宁可占内存也不要因为截断而破坏 JSON。
 */
const MAX_LINE = 64 * 1024 * 1024

export interface LineReader {
  push(chunk: string): void
  /** 流结束时调用,吐出最后没有换行符收尾的残余 */
  flush(): void
}

export function createLineReader(onLine: (line: string) => void): LineReader {
  let buf = ''

  return {
    push(chunk: string): void {
      buf += chunk
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line.length > 0) onLine(line)
      }
      if (buf.length > MAX_LINE) {
        onLine(buf)
        buf = ''
      }
    },

    flush(): void {
      const rest = buf.replace(/\r?\n$/, '')
      buf = ''
      if (rest.length > 0) onLine(rest)
    },
  }
}

export interface JsonLineReader extends LineReader {}

/**
 * NDJSON 读取器。
 *
 * ⚠️ 实测 stderr 会混入非 JSON 行,例如:
 *   [claude-code:unrecognized_model] {"model":"deepseek-flash","query_source":"sdk"}
 * 因此**不能假设每行都是 JSON**,解析失败必须走 onUnparsed 而不是抛异常。
 */
export function createJsonLineReader(
  onObject: (obj: unknown) => void,
  onUnparsed: (line: string) => void,
): JsonLineReader {
  return createLineReader((line) => {
    try {
      onObject(JSON.parse(line))
    } catch {
      onUnparsed(line)
    }
  })
}
