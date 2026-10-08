import { useState, type JSX } from 'react'
import { useNodeActions } from '../../hooks/useNodeActions'
import { useLiveStore, useRuntimeStore } from '../../stores/runtimeStore'
import { t } from '../../lib/i18n'

export function Composer({ nodeId }: { nodeId: string }): JSX.Element {
  const [input, setInput] = useState('')
  const status = useRuntimeStore((s) => s.runtimes[nodeId]?.status ?? 'idle')
  const live = useLiveStore((s) => s.progress[nodeId] ?? null)
  const { send, cancel } = useNodeActions(nodeId)

  const running = status === 'running'

  const submit = async (): Promise<void> => {
    const text = input
    setInput('')
    await send(text)
  }

  return (
    <div className="composer">
      <div className="row">
        <textarea
          value={input}
          placeholder={running ? t('inspector.runningPlaceholder') : t('inspector.enterSend')}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            /*
             * ⚠️ 必须排除 Ctrl/Cmd —— 全局快捷键把 Ctrl+Enter 定义成「跑全部」。
             * 不排除的话,在输入框里按 Ctrl+Enter 会**同时**发出这句话和发起一次运行:
             * 用户想要的是"跑流水线",结果多了一条谁也没让它发的消息。
             */
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.ctrlKey &&
              !e.metaKey &&
              // 输入法组字中的 Enter 属于候选窗,不该当成发送
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault()
              void submit()
            }
          }}
          disabled={running}
          rows={2}
        />
        {running ? (
          <button className="danger" onClick={() => void cancel()}>
            {t('inspector.cancel')}
          </button>
        ) : (
          <button className="primary" onClick={() => void submit()} disabled={!input.trim()}>
            {t('inspector.send')}
          </button>
        )}
      </div>
      <div className="hint">
        {live ? (
          <span className="live">
            <span className="dot pulse" />
            {live.label}
          </span>
        ) : (
          <>
            <span className="keys">
              <span className="kbd">Enter</span> {t('inspector.sendWord')} · <span className="kbd">Shift</span>
              <span className="sc-sep">+</span>
              <span className="kbd">Enter</span> {t('inspector.newlineWord')}
            </span>
            <span className="muted">{t('inspector.stdinNote')}</span>
          </>
        )}
      </div>
    </div>
  )
}
