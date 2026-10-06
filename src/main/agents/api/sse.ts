import { createLineReader, type LineReader } from '../ndjson'

/**
 * SSE(Server-Sent Events)行解析。
 *
 * ## 为什么能复用 NDJSON 的读取器
 *
 * 两者都是"按行切、行内自成一条消息",差别只在**行首前缀**。真正麻烦的那件事
 * ——一个 chunk 结尾只有半行——是同一个问题,ndjson.ts 的缓冲逻辑已经解掉了。
 * 所以这里只做前缀剥离,不重写一遍缓冲。
 *
 * ## 只认 `data:`
 *
 * SSE 规范里还有 `event:` / `id:` / `retry:` 和注释行(`:` 开头,常用作心跳)。
 * 这些**全部忽略**,理由是实测三家都把自己的事件类型写在 data 的 JSON 里
 * (OpenAI 在 choices 上、Anthropic 在 `type` 字段、Gemini 在 candidates 上)——
 * 读 `event:` 反而要多维护一份"事件名 → 处理分支"的映射,而且那份映射
 * 各家还不一致。以 data 为准,只用一条解析路径。
 *
 * ⚠️ 心跳行必须显式跳过:OpenAI 在长思考期间会定期发 `: ping`,
 * 不跳的话就会把它喂给 JSON.parse,然后每一跳在诊断里留一条噪音。
 */
export function createSseReader(onData: (payload: string) => void): LineReader {
  return createLineReader((line) => {
    if (!line) return
    // 注释 / 心跳。SSE 规范里以冒号开头的行都是注释
    if (line.startsWith(':')) return
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (payload) onData(payload)
  })
}
