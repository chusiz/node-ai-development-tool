import { useSettingsStore } from '../stores/settingsStore'
import type { UiSettings } from '../../../shared/settings'

/**
 * 快捷键键位的**唯一事实源**(v0.6.6 起可用户自定义)。
 *
 * 旧的 shortcuts.ts 把"键位"硬编码在每条 def 的 keys + match 里;现在键位
 * 抽成一份可覆盖的表:
 *
 *   - `DEFAULT_KEYMAP` —— actionId → 默认键位(一个动作可绑多个键位,
 *     如删除节点默认同时认 Delete 与 Backspace);
 *   - 用户在设置 → 快捷键 里改过某个动作后,键位写进 settings.ui.keymap
 *     (随 settings.json 一起备份迁移),**整组替换**默认键位;
 *   - 匹配与显示都走这里,帮助浮层(?)与设置面板渲染同一份数据,不会漂移。
 *
 * 组合串格式:`Ctrl+Shift+Enter` / `E` / `?` / `F2` / `Ctrl+1`。
 * Ctrl 与 Cmd(meta)视为同一个修饰键 —— 两端各用各的习惯,不必写两份表。
 */

export interface ShortcutActionMeta {
  /** 稳定 id:settings.keymap 的 key、帮助浮层的 key、e2e 按它断言 */
  id: string
  group: 'run' | 'edit' | 'view' | 'nav'
  /** 默认键位(可多个)。第一个是"主显示" */
  defaultCombos: string[]
  /** 是否在输入框打字时也生效(命令类 = true,文本字符类 = false) */
  global: boolean
}

/** 全部可自定义快捷键动作。新增动作只改这一处。 */
export const SHORTCUT_ACTIONS: ShortcutActionMeta[] = [
  /* ---------------- 运行 ---------------- */
  { id: 'run-all', group: 'run', defaultCombos: ['Ctrl+Enter'], global: true },
  { id: 'run-selected', group: 'run', defaultCombos: ['Ctrl+Shift+Enter'], global: true },
  { id: 'cancel-run', group: 'run', defaultCombos: ['Ctrl+Shift+C'], global: true },

  /* ---------------- 编辑 ---------------- */
  { id: 'save', group: 'edit', defaultCombos: ['Ctrl+S'], global: true },
  { id: 'undo', group: 'edit', defaultCombos: ['Ctrl+Z'], global: true },
  { id: 'redo', group: 'edit', defaultCombos: ['Ctrl+Shift+Z'], global: true },
  { id: 'delete-node', group: 'edit', defaultCombos: ['Delete', 'Backspace'], global: false },
  { id: 'add-node', group: 'edit', defaultCombos: ['Ctrl+K'], global: true },
  { id: 'focus-composer', group: 'edit', defaultCombos: ['Enter'], global: false },
  { id: 'duplicate-node', group: 'edit', defaultCombos: ['Ctrl+D'], global: true },
  { id: 'rename-node', group: 'edit', defaultCombos: ['F2'], global: true },
  { id: 'cut-edge', group: 'edit', defaultCombos: ['E'], global: false },

  /* ---------------- 视图 ---------------- */
  { id: 'fit-view', group: 'view', defaultCombos: ['Ctrl+0'], global: true },
  { id: 'chat-tab', group: 'view', defaultCombos: ['Ctrl+1'], global: true },
  { id: 'config-tab', group: 'view', defaultCombos: ['Ctrl+2'], global: true },
  { id: 'toggle-workspace', group: 'view', defaultCombos: ['Ctrl+Tab'], global: true },

  /* ---------------- 导航 ---------------- */
  { id: 'shortcuts-help', group: 'nav', defaultCombos: ['?'], global: false },
  { id: 'settings', group: 'nav', defaultCombos: ['Ctrl+,'], global: true },
  { id: 'toggle-skills', group: 'nav', defaultCombos: ['Ctrl+B'], global: true },
  { id: 'export-workflow', group: 'nav', defaultCombos: ['Ctrl+E'], global: true },
  { id: 'import-workflow', group: 'nav', defaultCombos: ['Ctrl+I'], global: true },
  { id: 'focus-project', group: 'nav', defaultCombos: ['Ctrl+P'], global: true },
  { id: 'escape', group: 'nav', defaultCombos: ['Escape'], global: true },
]

export const DEFAULT_KEYMAP: Record<string, string[]> = Object.fromEntries(
  SHORTCUT_ACTIONS.map((a) => [a.id, a.defaultCombos]),
)

/** 帮助浮层与设置面板显示用:把组合串拆成一段段键名(如 `Ctrl+Enter` → [Ctrl, Enter]) */
export function comboParts(combo: string): string[] {
  return combo.split('+').filter(Boolean)
}

/** 用户自定义(settings.ui.keymap)合并出"每个动作当前生效的键位" */
export function effectiveKeymap(ui: UiSettings | undefined): Record<string, string[]> {
  const user = ui?.keymap ?? {}
  const out: Record<string, string[]> = {}
  for (const a of SHORTCUT_ACTIONS) {
    const custom = user[a.id]
    out[a.id] = custom ? [custom] : a.defaultCombos
  }
  return out
}

/** 非 hook 场景(快捷键调度、CuttableEdge)直接从 store 读当前生效键位 */
export function getKeymap(): Record<string, string[]> {
  return effectiveKeymap(useSettingsStore.getState().payload?.current?.ui)
}

/** 单个组合串是否命中这次按键。Ctrl 与 Cmd 等价;主键大小写/数字键不敏感 */
export function comboMatches(e: KeyboardEvent, combo: string): boolean {
  const parts = comboParts(combo)
  let needCtrl = false
  let needShift = false
  let needAlt = false
  let main = ''
  for (const p of parts) {
    if (p === 'Ctrl' || p === 'Cmd') needCtrl = true
    else if (p === 'Shift') needShift = true
    else if (p === 'Alt') needAlt = true
    else main = p
  }
  if (needCtrl !== (e.ctrlKey || e.metaKey)) return false
  if (needShift !== e.shiftKey) return false
  if (needAlt !== e.altKey) return false
  if (!main) return false
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
  return k === (main.length === 1 ? main.toLowerCase() : main)
}
