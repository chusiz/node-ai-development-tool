import type { Envelope } from '../types'

/**
 * 拆信封。主进程的每个 handler 都会把异常包成 `{ ok:false, error }`,
 * 在这里统一变成 throw —— 调用方写普通的 try/catch 就行,不必到处判 ok。
 */
export function unwrap<T>(res: Envelope<T>): T {
  if (!res || res.ok !== true) throw new Error(res?.error ?? '未知错误')
  return res.data
}
