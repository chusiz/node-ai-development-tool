import { useCallback } from 'react'
import { effectiveCwd } from '../../../shared/canvas'
import { useGraphStore } from '../stores/graphStore'
import { useLiveStore, useRuntimeStore } from '../stores/runtimeStore'
import { unwrap } from '../lib/unwrap'
import type { StartResult } from '../types'

export interface NodeActions {
  send(prompt: string): Promise<void>
  cancel(): Promise<void>
  newSession(): Promise<void>
}

/**
 * 一个节点的三个动作。
 *
 * 抽出来是因为顶栏与 Inspector 底部的输入框都要用同一份逻辑 ——
 * 复制两份的话,"新会话忘记重置 model"这类 bug 迟早只修在一边。
 */
export function useNodeActions(nodeId: string): NodeActions {
  const canvasId = useGraphStore((s) => s.canvasId)

  const send = useCallback(
    async (prompt: string): Promise<void> => {
      const text = prompt.trim()
      if (!text) return

      const node = useGraphStore.getState().nodes.find((n) => n.id === nodeId)
      if (!node) return

      const rt = useRuntimeStore.getState().runtimes[nodeId]
      if (rt?.status === 'running') return

      /*
       * 空 cwd 照样发得出去 —— 主进程的 resolveStartCwd 会兜到画布沙箱。
       *
       * 这里原来有一段"没目录就不许发"的前置检查,是个错误:
       * 它把「我想跟 AI 说句话」变成了「我得先编一个项目目录出来」。
       * 安全边界在主进程那一条路上(两条入口共用),渲染进程只负责显示
       * 用户配了什么,不该兼职做拦截。
       */
      const cwd = effectiveCwd(useGraphStore.getState().projectDir, node.data.cwd)

      useRuntimeStore.getState().setStatus(nodeId, 'running')

      try {
        const res = unwrap<StartResult>(
          await window.api.session.start({
            nodeId,
            canvasId,
            agentId: node.data.agentId,
            cwd,
            // 首轮不传 → 主进程生成;后续传上一轮 id → --resume 接续
            sessionId: rt?.sessionId ?? undefined,
            prompt: text,
            permissionMode: node.data.permissionMode,
          }),
        )
        // 权威 sessionId 会通过 EV.sessionStatus 回来,这里先设一次让界面立刻有值
        useRuntimeStore.getState().setSessionId(nodeId, res.sessionId)
      } catch (e) {
        useLiveStore.getState().clear(nodeId)
        useRuntimeStore.getState().fail(nodeId, (e as Error).message)
      }
    },
    [nodeId, canvasId],
  )

  const cancel = useCallback(async (): Promise<void> => {
    await window.api.session.cancel(nodeId)
  }, [nodeId])

  const newSession = useCallback(async (): Promise<void> => {
    await window.api.session.cancel(nodeId)
    // 磁盘上的日志一起清掉 —— 只清界面的话,重开应用旧对话又会冒出来
    await window.api.session.reset(canvasId, nodeId)
    useRuntimeStore.getState().reset(nodeId)
    useLiveStore.getState().clear(nodeId)
  }, [nodeId, canvasId])

  return { send, cancel, newSession }
}
