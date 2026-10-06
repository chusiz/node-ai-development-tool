import { create } from 'zustand'
import type { ProcessMetricEntry, Settings, SettingsPayload } from '../types'
import { unwrap } from '../lib/unwrap'

/** 内存快照的轮询间隔。2s 足够看出趋势,又不会让 getAppMetrics 成为负担 */
const METRICS_INTERVAL_MS = 2000

interface SettingsState {
  /** null = 还没从主进程取到。取值之前不渲染表单,避免闪一屏默认值再跳变 */
  payload: SettingsPayload | null
  metrics: ProcessMetricEntry[]
  error: string | null

  load(): Promise<void>
  save(next: Settings): Promise<void>
  relaunch(): Promise<void>
  refreshMetrics(): Promise<void>
}

export const useSettingsStore = create<SettingsState>((set) => ({
  payload: null,
  metrics: [],
  error: null,

  async load() {
    try {
      set({ payload: unwrap(await window.api.settings.get()), error: null })
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  async save(next) {
    // 整份替换,不做字段合并 —— 合并语义会让"两个界面各改一半"变得不可推理
    set({ payload: unwrap(await window.api.settings.set(next)), error: null })
  },

  async relaunch() {
    // 主进程内部先 killAll 再 relaunch,这里不需要先取消节点
    unwrap(await window.api.settings.relaunch())
  },

  async refreshMetrics() {
    const metrics = unwrap(await window.api.settings.metrics())
    // 按内存降序,UI 直接照着画,不必自己排
    metrics.sort((a, b) => b.workingSetKb - a.workingSetKb)
    set({ metrics })
  },
}))

/*
 * 内存轮询的引用计数。
 *
 * 顶栏徽标和设置面板都要用内存数,但**只能有一个定时器** ——
 * 否则两边各自 setInterval,IPC 调用次数翻倍。
 * 用引用计数而非布尔标志:StrictMode 下 effect 会跑两次(挂载→卸载→挂载),
 * 布尔标志会让第二个订阅者把第一个的定时器清掉。
 */
let timer: ReturnType<typeof setInterval> | null = null
let refs = 0

export function acquireMetricsPolling(): () => void {
  refs++
  if (!timer) {
    void useSettingsStore.getState().refreshMetrics()
    timer = setInterval(() => {
      void useSettingsStore.getState().refreshMetrics()
    }, METRICS_INTERVAL_MS)
  }

  let done = false
  return () => {
    if (done) return
    done = true
    if (--refs === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}
