import { useEffect, useMemo, type JSX } from 'react'
import { usePinToBottom } from '../../hooks/usePinToBottom'
import { useLiveStore, useRuntimeStore } from '../../stores/runtimeStore'
import { useUiStore } from '../../stores/uiStore'
import type { Item } from '../../stores/types'
import { MessageBubble } from './MessageBubble'
import { Icon } from '../Icons'

/**
 * 单个节点的消息流。
 *
 * ⚠️ 吸底 ref 由**每个实例各自持有**(走 usePinToBottom),不是全局单例 ——
 * 多个节点各有一条自己的流,共用一份 ref 会互相覆盖滚动位置。
 */
export function MessageList({ nodeId, canvasId }: { nodeId: string; canvasId: string }): JSX.Element {
  const items = useRuntimeStore((s) => s.runtimes[nodeId]?.items ?? EMPTY)
  const diagnostics = useRuntimeStore((s) => s.runtimes[nodeId]?.diagnostics ?? EMPTY)
  const trimmed = useRuntimeStore((s) => s.runtimes[nodeId]?.trimmed ?? 0)
  const error = useRuntimeStore((s) => s.runtimes[nodeId]?.error ?? null)
  const live = useLiveStore((s) => s.progress[nodeId] ?? null)
  const showDiag = useUiStore((s) => s.showDiag)

  const visible = useMemo(
    () => (showDiag ? [...items, ...diagnostics].sort((a, b) => a.seq - b.seq) : items),
    [items, diagnostics, showDiag],
  )

  const pin = usePinToBottom<HTMLDivElement>([visible, live])

  // 切换节点时重新贴底 —— 否则从长会话切到短会话会停在半空
  useEffect(() => {
    pin.scrollToBottom()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId])

  return (
    <>
      <div className="stream" ref={pin.ref} onScroll={pin.onScroll}>
        {trimmed > 0 && (
          <div className="trimmed-note">已折叠更早的 {trimmed} 条(在磁盘里,后续版本可按需加载)</div>
        )}

        {visible.length === 0 ? (
          <div className="empty">
            <div className="big">
              <Icon name="logo" size={26} />
            </div>
            <div>这个节点还没有对话</div>
            <div className="sub">在下面输入一句话,它会用自己的会话跑</div>
          </div>
        ) : (
          visible.map((it) => <MessageBubble key={it.key} rec={it.rec} canvasId={canvasId} />)
        )}

        {error && <div className="bubble error">{error}</div>}
      </div>

      {/* 用户主动上翻后出现 —— 跟随被他打断了,给一个一键复位 */}
      {!pin.atBottom && visible.length > 0 && (
        <button className="jump-bottom" onClick={pin.scrollToBottom}>
          ↓ 回到底部
        </button>
      )}
    </>
  )
}

/** 稳定的空数组引用,免得每次渲染都造一个新的导致 zustand 选择器频繁触发 */
const EMPTY: Item[] = []
