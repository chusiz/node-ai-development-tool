import { useEffect } from 'react'
import { acquireSessionBridge } from '../bridge/sessionBridge'

/**
 * 挂载全局唯一的会话事件订阅。
 *
 * 渲染 `null` 是因为它没有 UI —— 存在的意义就是给那个 effect 一个宿主。
 * 必须在整棵树里**只出现一次**:见 sessionBridge.ts 里关于引用计数的说明。
 */
export function SessionBridge(): null {
  useEffect(() => acquireSessionBridge(), [])
  return null
}
