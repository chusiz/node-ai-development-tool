import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/**
 * 距底部多少像素以内仍算「贴着底」。
 * 给一点余量是因为行高取整、以及最后一条还在流式增长时高度会跳。
 */
const THRESHOLD_PX = 60

export interface PinToBottom<T extends HTMLElement> {
  ref: RefObject<T | null>
  onScroll: () => void
  scrollToBottom: () => void
  /** 当前是否贴着底。只在跨过阈值时变化,可用于显示「回到底部」按钮 */
  atBottom: boolean
}

/**
 * 滚动跟随:新内容到达时自动滚到底,但用户往上翻看历史时不把他拽回来。
 *
 * ## 为什么不能用 `scroll-behavior: smooth`
 *
 * 这是原来那个 bug 的根因。`el.scrollTop = el.scrollHeight` 在 CSS 声明的
 * smooth 下会变成一段**动画**,动画的每一中间帧都会触发 scroll 事件 ——
 * 而那些帧里元素离底部还很远,于是「是否贴底」的标志被翻成 false,
 * 此后所有流式更新都不再跟随。表现就是用户说的「每次都要手动拖到底」。
 *
 * 所以程序化滚动一律用 `behavior: 'instant'`,滚完即刻到位,
 * 它触发的那次 scroll 事件读到的距离是 0,标志自然保持 true。
 *
 * ## 为什么做成 hook 而不是组件内的 ref
 *
 * 节点画布上每个节点都有一份独立的滚动状态。放在 App 级别的单例 ref 里
 * (原来的 streamRef / pinnedRef),多节点下会互相覆盖。
 */
export function usePinToBottom<T extends HTMLElement>(deps: unknown[]): PinToBottom<T> {
  const ref = useRef<T>(null)
  const pinned = useRef(true)
  const [atBottom, setAtBottom] = useState(true)

  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= THRESHOLD_PX
    // 只在跨过阈值时 setState —— scroll 事件很密,每次都 setState 会拖垮渲染
    if (near !== pinned.current) {
      pinned.current = near
      setAtBottom(near)
    }
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'instant' })
    pinned.current = true
    setAtBottom(true)
  }, [])

  useEffect(() => {
    if (!pinned.current) return
    const el = ref.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'instant' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { ref, onScroll, scrollToBottom, atBottom }
}
