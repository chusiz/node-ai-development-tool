import { useLiveStore, useRuntimeStore } from '../stores/runtimeStore'
import { useWorkflowStore } from '../stores/workflowStore'

let off: (() => void) | null = null
let refs = 0

/**
 * 全局**唯一**的会话事件订阅。
 *
 * ## 为什么必须唯一
 *
 * 每个节点各订阅一次的话,N 个节点就是 N 个监听器,而主进程是**全局广播**的 ——
 * 每条消息都要被 N 个监听器各收一遍再各自过滤。10 个节点就是 10 倍 IPC 回调开销。
 * 所以只在最外层订阅一次,然后在这里分发到各个 store。
 *
 * ## 为什么是引用计数而不是布尔标志
 *
 * React StrictMode 下 effect 会跑两次(挂载 → 卸载 → 挂载)。而事件是**增量**的:
 * 用布尔标志的话,第二次挂载看到"已订阅"就不订了,而第一次的卸载已经把监听器摘了 ——
 * 结果是一个监听器都没有,界面永远不动。反过来若标志位没清干净,还会重复订阅,
 * 消息翻倍。引用计数两种都能正确处理。
 */
function install(): () => void {
  const offLog = window.api.session.onLog((p) => useRuntimeStore.getState().applyLog(p))
  const offProgress = window.api.session.onProgress((p) => useLiveStore.getState().setProgress(p))
  const offExit = window.api.session.onExit((p) => {
    useRuntimeStore.getState().applyExit(p)
    useLiveStore.getState().clear(p.nodeId)
  })
  const offStatus = window.api.session.onStatus((p) => {
    if (p.sessionId) useRuntimeStore.getState().setSessionId(p.nodeId, p.sessionId)
    if (p.stderr) useRuntimeStore.getState().pushStderr(p.nodeId, p.stderr)
  })
  const offWorkflow = window.api.workflow.onEvent((ev) => useWorkflowStore.getState().ingest(ev))

  return () => {
    offLog()
    offProgress()
    offExit()
    offStatus()
    offWorkflow()
  }
}

/** 返回**退订函数**。调用方必须在 effect 的清理函数里调用它 */
export function acquireSessionBridge(): () => void {
  refs++
  if (refs === 1) off = install()

  let done = false
  return () => {
    if (done) return
    done = true
    if (--refs === 0) {
      off?.()
      off = null
    }
  }
}
