import { execFile } from 'node:child_process'

/**
 * Windows 进程树终止。
 *
 * claude 会派生 Bash / node 子进程,只杀父进程会留一堆孤儿。
 * 因为我们**直接 spawn .exe 而非经 shell**,child.pid 就是 claude 本体的 pid,
 * taskkill /T 能正确遍历整棵子树 —— 又一个"直接 spawn"带来的好处。
 */
export function killProcessTree(pid: number, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* 已退出 */
      }
      resolve()
      return
    }

    const child = execFile(
      'taskkill',
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: timeoutMs },
      // 进程可能已退出,报错是正常情况,一律吞掉
      () => resolve(),
    )
    child.on('error', () => resolve())
  })
}

/** 探活:用于启动时清理上次异常退出留下的孤儿进程 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
