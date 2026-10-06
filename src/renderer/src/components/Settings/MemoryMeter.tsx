import { useEffect, type JSX } from 'react'
import { acquireMetricsPolling, useSettingsStore } from '../../stores/settingsStore'

/** Electron 给的单位就是 KB,转成 MB 只为可读 */
export function mb(kb: number): number {
  return Math.round(kb / 1024)
}

export const fmtMb = (kb: number): string => `${mb(kb)}MB`

/**
 * 顶栏的内存徽标。
 *
 * 自己负责启动轮询(引用计数保证全局只有一个定时器)——
 * 这样把它挂到哪儿都能用,不需要父组件记得去开轮询。
 */
export function MemoryMeter(): JSX.Element | null {
  const metrics = useSettingsStore((s) => s.metrics)
  const refresh = useSettingsStore((s) => s.refreshMetrics)

  useEffect(() => {
    const release = acquireMetricsPolling()
    // 面板打开/关闭会重挂,手动补一次让数字立刻是新的
    void refresh()
    return release
  }, [refresh])

  if (metrics.length === 0) return null

  const total = metrics.reduce((n, m) => n + m.workingSetKb, 0)
  const tip = metrics.map((m) => `${m.type} #${m.pid}  ${fmtMb(m.workingSetKb)}`).join('\n')

  return (
    <span className="badge mem" title={`Electron 各进程常驻内存\n\n${tip}`}>
      <span className="dot ok" />
      {fmtMb(total)}
      <span className="mem-sub">{metrics.length} 进程</span>
    </span>
  )
}
