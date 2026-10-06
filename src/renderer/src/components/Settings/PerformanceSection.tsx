import { useEffect, type JSX } from 'react'
import type { MemorySettings } from '../../types'
import { acquireMetricsPolling, useSettingsStore } from '../../stores/settingsStore'
import { fmtMb, mb } from './MemoryMeter'

/*
 * 各开关的诚实说明。
 *
 * 我们**没有实测** Electron 38 / Chromium 140 下每一项的精确收益,
 * 所以这里只写方向与代价,不写数字 —— 真实数字由下面的表当场测给用户看。
 */
const SWITCHES: {
  key: keyof MemorySettings
  label: string
  hint: string
  kind: 'bool' | 'number'
  danger?: string
}[] = [
  {
    key: 'disableGpu',
    label: '关闭硬件加速',
    hint: '单点收益最大的一项。代价:画布平移/缩放改走 CPU,会明显发涩。',
    kind: 'bool',
  },
  {
    key: 'lowEndDeviceMode',
    label: '低端设备模式',
    hint: '一次性下调多项缓存与线程预算。代价:滚动与动画质量下降。',
    kind: 'bool',
  },
  {
    key: 'maxOldSpaceMb',
    label: '渲染进程堆上限 (MB)',
    hint: '封顶 V8 老生代。过低会 OOM 崩溃,下限硬卡 256。',
    kind: 'number',
    danger: '256 以下不接受 —— 那个量级下渲染进程会直接崩。',
  },
  {
    key: 'diskCacheMb',
    label: '磁盘缓存上限 (MB)',
    hint: '保护 D 盘空间,不省内存。0 = 不限制。',
    kind: 'number',
  },
]

export function PerformanceSection({
  value,
  onChange,
}: {
  value: MemorySettings
  onChange: (next: MemorySettings) => void
}): JSX.Element {
  const metrics = useSettingsStore((s) => s.metrics)
  const refresh = useSettingsStore((s) => s.refreshMetrics)

  useEffect(() => {
    const release = acquireMetricsPolling()
    void refresh()
    return release
  }, [refresh])

  const total = metrics.reduce((n, m) => n + m.workingSetKb, 0)
  // 条形图以最大进程为基准 —— 用总和做基准的话,小的那几条会细到看不见
  const peak = metrics.reduce((n, m) => Math.max(n, m.workingSetKb), 1)

  const set = <K extends keyof MemorySettings>(k: K, v: MemorySettings[K]): void => {
    onChange({ ...value, [k]: v })
  }

  return (
    <>
      <h3>进程内存(实测)</h3>

      {metrics.length === 0 ? (
        <div className="note">读取中…</div>
      ) : (
        <>
          <div className="memlist">
            {metrics.map((m) => (
              <div className="memrow" key={m.pid}>
                <span className="memtype">{m.type}</span>
                <span className="membar">
                  <i style={{ width: `${Math.max(2, (m.workingSetKb / peak) * 100)}%` }} />
                </span>
                <span className="memval">{fmtMb(m.workingSetKb)}</span>
                <span className="mempk" title="峰值">
                  {mb(m.peakKb) > mb(m.workingSetKb) ? `峰 ${fmtMb(m.peakKb)}` : ''}
                </span>
              </div>
            ))}
          </div>
          <div className="kv total">
            <span className="k">合计</span>
            <span className="v">{fmtMb(total)}</span>
          </div>
        </>
      )}

      <div className="note">
        这是 <code>app.getAppMetrics()</code> 的原始读数,用于**自己验证**下面每个开关的收益。
        多开一个窗口就多一个渲染进程,这是架构性的下限,任何开关都救不了。
      </div>

      <h3>Chromium 开关</h3>
      {SWITCHES.map((sw) => (
        <div className="field" key={sw.key}>
          <label className="flabel">
            {sw.kind === 'bool' ? (
              <input
                type="checkbox"
                checked={value[sw.key] as boolean}
                onChange={(e) => set(sw.key, e.target.checked as never)}
              />
            ) : (
              <input
                className="fnum"
                type="number"
                min={sw.key === 'maxOldSpaceMb' ? 256 : 0}
                max={sw.key === 'maxOldSpaceMb' ? 8192 : 4096}
                step={sw.key === 'maxOldSpaceMb' ? 128 : 64}
                value={value[sw.key] as number}
                onChange={(e) => set(sw.key, Number(e.target.value) as never)}
              />
            )}
            <span>{sw.label}</span>
          </label>
          <div className="fhint">{sw.hint}</div>
        </div>
      ))}
    </>
  )
}
