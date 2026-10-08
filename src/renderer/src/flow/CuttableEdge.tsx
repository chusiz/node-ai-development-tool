import { useRef, useState, type JSX, type MouseEvent } from 'react'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'
import { useGraphStore } from '../stores/graphStore'
import { useUiStore } from '../stores/uiStore'
import { Icon } from '../components/Icons'

/**
 * 可切断的连线。
 *
 * ## 为什么需要它
 *
 * React Flow 默认的连线**只有加法没有减法**:拉得出来,拆不掉。
 * 想拆只能把某一端的节点删了重画 —— 而节点上挂着对话历史和运行记录,
 * 为拆一根线付这个代价明显不合理。所以每条线中点挂一个剪刀,
 * 鼠标移到线上才浮现,点一下断开。
 *
 * ## 为什么悬停状态用 React state 而不是 CSS `:hover`
 *
 * 剪刀是渲染进 `EdgeLabelRenderer` 的,它被 portal 到 `.react-flow__edgelabel-renderer`
 * 那一层 —— 和 `<g class="react-flow__edge">` **不是父子关系**。
 * 所以 `.react-flow__edge:hover .edge-cut { … }` 这种后代选择器永远匹配不上,
 * 只能由组件自己记。悬停事件挂在包住 `BaseEdge` 的 `<g>` 上:
 * 指针落在路径上时 mouseover 会冒泡上来。
 *
 * ## 为什么"隐藏"要延迟 140ms
 *
 * 指针从线上的路径移到剪刀上时,路径先收到 mouseleave、按钮再收到 mouseenter。
 * 若 mouseleave 当场把状态置 false,按钮就在指针落上去的前一帧消失了 ——
 * 表现出来就是「剪刀看得见,但点不到」。延迟一下、并在按钮自己进入时
 * 取消这只定时器,就绕开了这个空档。
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
  selected,
  interactionWidth,
}: EdgeProps): JSX.Element {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  const removeEdge = useGraphStore((s) => s.removeEdge)

  const [hot, setHot] = useState(false)
  /** 延迟隐藏的定时器。放在 ref 里:它不参与渲染,变了也不该触发重渲染 */
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelHide = (): void => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
  }
  /*
   * 悬停 = 打开**上游的数据探针**(它交出了什么)。
   * 剪刀按钮的 onMouseEnter 也走 enter —— 指针从线挪到剪刀上时探针不闪。
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

  /** 被 React Flow 选中时也常驻显示 —— 不然"选中了却看不见操作入口"很别扭 */
  const shown = hot || !!selected

  return (
    <>
      <g onMouseEnter={enter} onMouseLeave={leave}>
        <BaseEdge
          id={id}
          path={edgePath}
          markerStart={markerStart}
          markerEnd={markerEnd}
          style={style}
          interactionWidth={interactionWidth}
        />
      </g>

      <EdgeLabelRenderer>
        <button
          type="button"
          className={`edge-cut nodrag nopan${shown ? ' on' : ''}`}
          /*
           * EdgeLabelRenderer 的内容定位在画布坐标系里,所以要靠 transform 挪到中点。
           * translate(-50%,-50%) 让按钮中心对齐中点(而不是左上角对齐)。
           */
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          title="切断这条连线"
          aria-label="切断这条连线"
          /*
           * 点不到的按钮不该占 Tab 位。隐藏时 tabIndex=-1,
           * 键盘用户走"选中连线 + Delete"那条路(见 shortcuts.ts)。
           */
          tabIndex={shown ? 0 : -1}
          onMouseEnter={enter}
          onMouseLeave={leave}
          // pointerdown 也要拦:否则这一下会被画布当成"开始拖框选"的起点
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            cancelHide()
            removeEdge(id)
          }}
        >
          <span className="edge-cut-label">剪断</span>
        </button>
      </EdgeLabelRenderer>
    </>
  )
}
