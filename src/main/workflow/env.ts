import type { WorkflowEvent } from '../../shared/workflow'
import type { SessionManager } from '../agents/manager'
import type { NodeLogHub } from '../persist/hub'
import { startSession } from '../startSession'
import { cancelBuiltin, getBuiltinAction } from '../builtin/registry'
import { persistRun } from './runLog'
import type { RunnerEnv } from './runner'

/**
 * 把调度器接到真实的主进程设施上。
 *
 * 这一层刻意薄:runner 本身不 import Electron / fs / SessionManager / 内置动作实现,
 * 全部从 `RunnerEnv` 进来。所以 e2e 里可以用一个假的 env 把关键断言
 * 跑完,不依赖真实 agent;而这里只负责"把真的那套递过去"。
 *
 * v0.3.0:内置动作不再直接引 Packager,改走**内置动作注册表**
 * (`builtin/registry.ts`)—— runner 只认接口,runtime 里谁实现了哪个 action
 * 由 register.ts 决定。加一个内置动作(package / image / …)不用改本文件。
 */
export function makeRunnerEnv(args: {
  manager: SessionManager
  hub: NodeLogHub
  emit(ev: WorkflowEvent): void
}): RunnerEnv {
  const { manager, hub, emit } = args
  return {
    stateOf: (canvasId, nodeId) => hub.metaOf(canvasId, nodeId),
    logsAfter: (canvasId, nodeId, watermark, limit) =>
      hub.logsAfter(canvasId, nodeId, watermark, limit),
    // 与界面点「发送」共用同一个入口,不另起一条路径
    startNode: (req) => startSession(hub, manager, req),
    waitFor: (nodeId) => manager.waitFor(nodeId),
    /*
     * 取消链路要**同时覆盖**两类进程:agent 会话(manager)与全部内置动作子进程
     * (packager / imagegen,经 cancelBuiltin 遍历注册表)。用 || 串是因为一个节点
     * 同一时刻只可能在跑其中一类;两者都返回"有没有真取消",谁命中谁说了算。
     * 漏掉内置动作那一环的后果是"点了取消、出图/打包还在跑"——用户最不能忍的失控。
     */
    cancelNode: (nodeId) => manager.cancel(nodeId) || cancelBuiltin(nodeId),
    notice: (nodeId, level, text) => hub.appendNotice(nodeId, level, text),
    emit,
    persist: persistRun,
    // 内置动作节点(output / image / …)的执行器:注册表按 action 分发
    runBuiltinAction: (req) => getBuiltinAction(req.action).run(req),
    /*
     * 取本轮记录时的上限。要够到"最后一条 result" ——
     * 一轮重工具调用的会话轻松超过 100 条记录,给太小就会漏掉结论。
     */
    logTailLimit: 600,
  }
}
