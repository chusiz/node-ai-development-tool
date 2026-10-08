import { useEffect, useRef, useState, type JSX, type MouseEvent } from 'react'
import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react'
import { useGraphStore } from '../stores/graphStore'
import { useUiStore } from '../stores/uiStore'
import { comboMatches, getKeymap } from '../lib/keymap'

/**
 * 可切断的连线 —— **悬停 + 按 E 剪断**。
 *
 * ## 为什么不用中点按钮
 *
 * 之前在中点挂一个剪刀/文字按钮,一是图标在小尺寸下视觉不居中,
 * 二是按钮会挡住对连线的直接操作。现在的交互:
 * 鼠标悬停到线上 → 线高亮成强调色 → 按 `E` 键即剪断。
 * 悬停时线本身显示系统 tooltip「按 E 剪断连线」,鼠标移开即消失。
 *
 * ## 为什么悬停状态用 React state 而不是 CSS `:hover`
 *
 * 悬停事件挂在包住 `BaseEdge` 的 `<g>` 上 —— 指针落在路径上时
 * mouseover 会冒泡上来,状态由组件自己记,不依赖后代选择器。
 *
 * ## 为什么 E 键只在自己的 `hot` 为真时生效
 *
 * 同一时刻鼠标只悬停在一根线上,其它边的 `hot` 都是 false,
 * 所以每条边各挂一个 keydown 监听不会互相抢 —— 按 E 删的
 * 一定是当前指针下的那根线。`input` / `textarea` / 可编辑元素
 * 聚焦时不响应(用户在打字,不能误删)。
 *
 * ## 为什么把 markerStart / markerEnd / style / interactionWidth 原样透传
 *
 * 这些是 React Flow 算好(或用户设好)的箭头与外层样式。自己另写一套路径
 * 很容易在别人改了箭头配置之后悄悄不一致 —— 转发比重画安全。
 *
 * ⚠️ `className` 不在这里转发:它**不在 EdgeProps 里**。React Flow 把边上的
 * className 直接挂在包裹这个组件的 `<g class="react-flow__edge …">` 上 ——
 * 环检测的 `edge-cycle` 红虚线就是这么生效的,所以这里不用管它。
 */
export function CuttableEdge({
  id,
  source,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerStart,
  markerEnd,
  style,
  interactionWidth,
}: EdgeProps): JSX.Element {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  const removeEdge = useGraphStore((s) => s.removeEdge)

  const [hot, setHot] = useState(false)
  /** 延迟熄灭的定时器。放在 ref 里:它不参与渲染,变了也不该触发重渲染 */
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelHide = (): void => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
  }
  /*
   * 悬停 = 打开**上游的数据探针**(它交出了什么)。
   * 没跑过的上游由 ProbeCard 自己决定不显示,这里无需判断。
   */
  const enter = (e: MouseEvent): void => {
    cancelHide()
    setHot(true)
    useUiStore.getState().setProbe({ nodeId: source, x: e.clientX, y: e.clientY })
  }
  const leave = (): void => {
    cancelHide()
    useUiStore.getState().setProbe(null)
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null
      setHot(false)
    }, 140)
  }

  /*
   * 剪断键(默认 E,可在设置 → 快捷键里自定义):只在当前边被悬停时生效。
   * 悬停瞬间才挂监听,移开就撤 —— 不干扰全局快捷键表。
   * 键位从 keymap 读:用户把剪断改成别的键,这里跟着变。
   */
  useEffect(() => {
    if (!hot) return
    const combos = getKeymap()['cut-edge'] ?? ['E']
    const onKey = (e: KeyboardEvent): void => {
      if (!combos.some((c) => comboMatches(e, c))) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      cancelHide()
      removeEdge(id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hot, id, removeEdge])

  return (
    <g
      onMouseEnter={enter}
      onMouseLeave={leave}
      className={hot ? 'edge-hot' : undefined}
    >
      {hot && <title>{`Cut edge: ${(getKeymap()['cut-edge'] ?? ['E']).join(' / ')}`}</title>}
      <BaseEdge
        id={id}
        path={edgePath}
        markerStart={markerStart}
        markerEnd={markerEnd}
        style={{ ...style, stroke: hot ? 'var(--accent)' : style?.stroke }}
        interactionWidth={interactionWidth}
      />
    </g>
  )
}
