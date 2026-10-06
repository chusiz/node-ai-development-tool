import { create } from 'zustand'
import type { SkillEntry } from '../types'
import { unwrap } from '../lib/unwrap'

interface SkillsState {
  /** null = 还没从主进程读过。和 settingsStore 同样的约定:没读到就不画列表 */
  skills: SkillEntry[] | null
  /** 正在进行的操作(启用/停用/删除/导入)。同一个时刻只允许一个 */
  busy: string | null
  error: string | null
  /** 上一次操作的结果,给用户一个"刚才那下成了"的确认 */
  notice: string | null

  load(): Promise<void>
  setEnabled(name: string, enabled: boolean): Promise<void>
  remove(name: string): Promise<void>
  /** 导入本地文件夹。不做确认框 —— 这一步不动任何已有数据,失败也是干净的 */
  importLocal(sourceDir: string): Promise<void>
  openDir(): Promise<void>
  clearNotice(): void
}

export const useSkillsStore = create<SkillsState>((set, get) => {
  /** 每个操作都要:占住 busy → 执行 → 无论成败重新拉列表 → 放锁 */
  const run = async (key: string, fn: () => Promise<string | null>): Promise<void> => {
    if (get().busy) return
    set({ busy: key, error: null, notice: null })
    try {
      const notice = await fn()
      set({ notice })
    } catch (e) {
      set({ error: (e as Error).message })
    } finally {
      set({ busy: null })
      /*
       * 无论成功失败都重拉一遍。
       *
       * 失败那一支尤其重要:比如删除时目录正被占用,主进程可能删掉了一半
       * (启用那边成了、停用那边失败)。此时界面上的列表已经是错的,
       * 不重拉就会一直显示一个真实状态未知的条目。
       */
      await get().load()
    }
  }

  return {
    skills: null,
    busy: null,
    error: null,
    notice: null,

    async load() {
      try {
        set({ skills: unwrap(await window.api.skills.list()), error: null })
      } catch (e) {
        set({ error: (e as Error).message })
      }
    },

    async setEnabled(name, enabled) {
      await run(`toggle:${name}`, async () => {
        unwrap(await window.api.skills.setEnabled(name, enabled))
        return enabled ? `已启用「${name}」` : `已停用「${name}」`
      })
    },

    async remove(name) {
      await run(`remove:${name}`, async () => {
        unwrap(await window.api.skills.remove(name))
        return `已删除「${name}」`
      })
    },

    async importLocal(sourceDir) {
      await run('import', async () => {
        const { name } = unwrap(await window.api.skills.importLocal(sourceDir))
        return `已装好「${name}」`
      })
    },

    async openDir() {
      try {
        unwrap(await window.api.skills.openDir())
      } catch (e) {
        set({ error: (e as Error).message })
      }
    },

    clearNotice() {
      set({ notice: null })
    },
  }
})
