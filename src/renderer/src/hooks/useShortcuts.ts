import { useEffect } from 'react'
import { dispatchShortcut } from '../lib/shortcuts'

/**
 * 把快捷键表挂到 window 上。**整个应用只有这一个按键监听**。
 *
 * ## 为什么用捕获阶段(capture: true)
 *
 * 捕获阶段从 window 往下走,比 React 的合成事件(挂在根容器上)更早。
 * 好处是"这个键归我"能在任何人反应之前就定下来,不会被下面某层的
 * onKeyDown 抢先消费掉。代价是 preventDefault 拦不住已经在冒泡路上的
 * 处理器 —— 所以凡是可能与组件自身按键重叠的组合(Enter 发送、
 * 改名框的 Enter/Esc),都在**定义表那一侧**用 global:false 划清界限,
 * 不靠这里的时序去赌。
 *
 * ## 为什么不依赖 React 的 key 状态
 *
 * 所有动作都从 `useXStore.getState()` 现取,不做闭包捕获 ——
 * 否则这个 effect 就得把一连串 store 值写进依赖数组,重挂监听是小事,
 * 更大的问题是"哪条快捷键读的是旧值"会变成只有运行时才看得见的坑。
 */
export function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // 输入法组字期间不碰 —— 拼音候选窗里的 Esc / Enter 属于输入法,
      // 这时候抢过来会把"取消选字"变成"取消选中节点"
      if (e.isComposing) return
      // 按住不放不重复触发。快捷键都是"一次性命令",
      // 连发只会让 Ctrl+K 一秒开关几十次菜单、Delete 弹一串确认框
      if (e.repeat) return
      if (dispatchShortcut(e)) e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
}
