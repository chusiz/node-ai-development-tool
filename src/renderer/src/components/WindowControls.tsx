import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { Icon } from './Icons'

/**
 * 无边框窗口的窗口控制按钮(最小化 / 最大化还原 / 关闭)。
 *
 * 帧被去掉后,这三个按钮是调整/关闭窗口的唯一入口,固定在顶栏右侧
 * (theme.css 的 .win-ctl)。
 *
 * 最大化状态必须经 IPC 订阅同步:用户不一定点这个按钮 —— 双击顶栏拖拽区
 * (或 Win+↑)也能最大化,那次变化不会经过按钮的 onClick,只能等主进程
 * `maximize / unmaximize` 事件推过来,图标才跟得上(□ / 叠框)。
 */
export function WindowControls(): JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let alive = true
    void window.api.windowCtl.isMaximized().then((r) => {
      if (alive && r.ok) setMaximized(r.data.maximized)
    })
    const off = window.api.windowCtl.onMaximizeChanged((m) => {
      if (alive) setMaximized(m)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  return (
    <span className="win-ctl">
      <button
        title="最小化"
        aria-label="最小化"
        onClick={() => void window.api.windowCtl.minimize()}
      >
        <Icon name="minimize" size={13} />
      </button>
      <button
        title={maximized ? '还原' : '最大化'}
        aria-label={maximized ? '还原' : '最大化'}
        onClick={() => void window.api.windowCtl.toggleMaximize()}
      >
        <Icon name={maximized ? 'restore' : 'maximize'} size={13} />
      </button>
      <button
        className="win-ctl-close"
        title="关闭"
        aria-label="关闭"
        onClick={() => void window.api.windowCtl.close()}
      >
        <Icon name="close" size={13} />
      </button>
    </span>
  )
}
