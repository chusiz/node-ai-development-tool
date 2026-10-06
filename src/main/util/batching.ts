/**
 * IPC 事件聚合。
 *
 * 流式输出在工具调用密集时可能每秒产生几百个事件,逐个 IPC 会打爆渲染进程。
 * 40ms 窗口 ≈ 一帧多一点的延迟 —— 视觉上完全无感,但能把 IPC 次数降一个数量级。
 */
export function createBatcher<T>(
  flush: (items: T[]) => void,
  windowMs = 40,
): { push(item: T): void; flushNow(): void; dispose(): void } {
  let queue: T[] = []
  let timer: NodeJS.Timeout | null = null

  const fire = (): void => {
    timer = null
    if (queue.length === 0) return
    const items = queue
    queue = []
    try {
      flush(items)
    } catch {
      /* 窗口已销毁等情况,丢弃即可,不能因此崩主进程 */
    }
  }

  return {
    push(item: T): void {
      queue.push(item)
      if (timer === null) timer = setTimeout(fire, windowMs)
    },
    flushNow(): void {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      fire()
    },
    dispose(): void {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      queue = []
    },
  }
}
