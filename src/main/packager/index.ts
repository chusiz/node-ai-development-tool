import type { ChildProcess } from 'node:child_process'
import type { BuiltinActionRequest, BuiltinActionResult } from '../workflow/builtinAction'
import { killProcessTree } from '../agents/kill'
import { packageProject } from './electronBuilder'

/**
 * 打包执行器:持有**活着的打包子进程表**,执行一次内置打包,并接入
 * 既有的取消/退出链路。
 *
 * ## 为什么要有 live 表
 *
 * 打包可能跑几十秒到几分钟。点「取消」或关应用时,必须能立刻找到那个
 * 还在跑的子进程把它杀掉 —— 而运行态(runner)只管"这个节点状态是 running",
 * 进程句柄只有这里知道。账本只此一份:run() 注册、退出注销、cancel/killAll 查杀。
 *
 * ## 取消语义
 *
 * `cancel(nodeId)` 是**幂等无副作用的**:没在跑就返回 false,runner 的
 * `manager.cancel(id) || packager.cancel(id)` 链条因此可以无脑串。
 * 杀进程走 killProcessTree(与 SessionManager 同一个实现):electron-builder
 * 会派生代码签名/打包工具等子进程,只杀父进程会留孤儿。
 */
export class Packager {
  /** nodeId → 正在跑的打包子进程 */
  private live = new Map<string, ChildProcess>()
  /** 被 cancel 过的节点。子进程 close 时据此把结果判成"已取消" */
  private killed = new Set<string>()

  /** 执行一次内置打包。成功回传产物路径 + 日志;失败回传 ok:false + 人话 error */
  async run(req: BuiltinActionRequest): Promise<BuiltinActionResult> {
    if (this.live.has(req.nodeId)) {
      // 理论到不了:调度器保证一个节点同时在跑的只有一路。兜一层防账本漏记
      return { ok: false, log: '', error: `节点 ${req.nodeId} 已有一个打包在跑` }
    }
    try {
      return await packageProject(req, {
        register: (child) => this.live.set(req.nodeId, child),
        unregister: () => this.live.delete(req.nodeId),
        isKilled: () => this.killed.has(req.nodeId),
        markKilled: () => this.killed.add(req.nodeId),
      })
    } finally {
      // 无论成败,跑完就出账 —— cancel 后 killAll 不该再对已退出的 pid 做文章
      this.live.delete(req.nodeId)
      this.killed.delete(req.nodeId)
    }
  }

  /** 取消某个节点的打包子进程(供 RunnerEnv.cancelNode 调用)。返回是否真有在跑的 */
  cancel(nodeId: string): boolean {
    const child = this.live.get(nodeId)
    if (!child) return false
    this.killed.add(nodeId)
    if (child.pid) void killProcessTree(child.pid)
    return true
  }

  /**
   * 退出清场:杀掉全部打包子进程树。与 manager.killAll() 并列,
   * 由 index.ts 的 before-quit 与 settingsRelaunch 调用。
   *
   * ⚠️ 打包进程也会派生 node 子进程(前置 build、代码签名工具),同样要连树杀
   * —— 复用 killProcessTree 就是为此。
   */
  killAll(): void {
    for (const [id, child] of this.live) {
      this.killed.add(id)
      if (child.pid) void killProcessTree(child.pid)
    }
    this.live.clear()
  }
}
