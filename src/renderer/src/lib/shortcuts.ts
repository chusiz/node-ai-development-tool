import { flushGraphSave, useGraphStore } from '../stores/graphStore'
import { useUiStore } from '../stores/uiStore'
import { useWorkflowStore } from '../stores/workflowStore'
import { deleteNodeWithConfirm } from './nodeOps'
import { comboMatches, getKeymap } from './keymap'
import { exportWorkflowFile, importWorkflowFile } from './workflowIO'

/**
 * 快捷键的**行为表**(v0.6.6 起键位可自定义)。
 *
 * 键位不再写在每条 def 里 —— 那是 `lib/keymap.ts` 的事(默认键位 + 用户在
 * 设置页覆盖的键位,存 settings.ui.keymap)。这里只回答"命中之后干什么",
 * 帮助浮层 / 设置面板 / 匹配引擎都从 keymap 读同一份当前键位,不会漂移。
 *
 * 约定(与 Composer 的 Enter 发送、NodeShell 的改名输入框对齐):
 *   凡是**输入框里打字会自然产生的字符**(Delete / Backspace / Enter / ?),
 *   一律 global:false —— 否则用户想在提示词里删个字,节点先没了。
 *   凡是**带修饰键的组合**(Ctrl/Cmd + …)一律 global:true,它们是命令,不是文本。
 */

export type ShortcutGroup = 'run' | 'edit' | 'view' | 'nav'

export interface ShortcutDef {
  /** 稳定标识:keymap 的 key、帮助浮层的 key、e2e 想断言也能按它找 */
  id: string
  group: ShortcutGroup
  /** i18n key:label 与 hint 见 lib/i18n.ts 的 shortcut.<id> / shortcut.<id>.hint */
  labelKey: string
  hintKey?: string
  /** true = 焦点在任何输入框里时仍然生效 */
  global?: boolean
  run(e: KeyboardEvent): void
}

/** Ctrl 与 Cmd 视为同一个修饰键 —— 两端各用各的习惯,不必为此写两份表 */
function mod(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey
}

/** 归一到小写字母,免得大小写与 CapsLock 影响匹配 */
function lc(e: KeyboardEvent): string {
  return e.key.length === 1 ? e.key.toLowerCase() : e.key
}

/** 焦点是否落在"用户正在打字"的控件里 */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true
}

/**
 * 焦点是否在"按 Enter 就等于点它"的控件上。
 *
 * 这一条是为了**别抢按钮的 Enter**:键盘用户 Tab 到「▶ 跑全部」再按 Enter,
 * 那是"运行",不是"把光标送进输入框"。我们的 Enter 快捷键必须让路。
 */
export function isActivatableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'button' || tag === 'a' || tag === 'select' || tag === 'textarea' || tag === 'input') {
    return true
  }
  return typeof el.getAttribute === 'function' && el.getAttribute('role') === 'button'
}

/** 当前那次运行的主进程镜像。没跑过 / 已结束都返回 null */
function activeRun(): { status: string } | null {
  const st = useWorkflowStore.getState()
  return st.activeRunId ? (st.runs[st.activeRunId] ?? null) : null
}

/** 现在能不能发起一次运行 —— 与 RunBar 按钮的 disabled 条件保持一致 */
function canStartRun(): boolean {
  const st = useWorkflowStore.getState()
  if (st.starting) return false
  if (activeRun()?.status === 'running') return false
  return true
}

export const SHORTCUTS: ShortcutDef[] = [
  /* ---------------- 运行 ---------------- */
  {
    id: 'run-all',
    group: 'run',
    labelKey: 'shortcut.run-all',
    hintKey: 'shortcut.run-all.hint',
    global: true,
    run: () => {
      const st = useWorkflowStore.getState()
      if (!canStartRun() || useGraphStore.getState().nodes.length === 0) return
      void st.runAll()
    },
  },
  {
    id: 'run-selected',
    group: 'run',
    labelKey: 'shortcut.run-selected',
    hintKey: 'shortcut.run-selected.hint',
    global: true,
    run: () => {
      const st = useWorkflowStore.getState()
      const target = useUiStore.getState().selectedNodeId
      if (!canStartRun() || !target) return
      void st.runTargets([target])
    },
  },
  {
    id: 'cancel-run',
    group: 'run',
    labelKey: 'shortcut.cancel-run',
    global: true,
    run: () => {
      const st = useWorkflowStore.getState()
      const run = st.activeRunId ? st.runs[st.activeRunId] : null
      if (!st.activeRunId || run?.status !== 'running') return
      void st.cancel(st.activeRunId)
    },
  },

  /* ---------------- 编辑 ---------------- */
  {
    id: 'save',
    group: 'edit',
    labelKey: 'shortcut.save',
    hintKey: 'shortcut.save.hint',
    global: true,
    run: () => void flushGraphSave(),
  },
  {
    id: 'undo',
    group: 'edit',
    labelKey: 'shortcut.undo',
    hintKey: 'shortcut.undo.hint',
    global: true,
    run: () => useGraphStore.getState().undo(),
  },
  {
    id: 'redo',
    group: 'edit',
    labelKey: 'shortcut.redo',
    hintKey: 'shortcut.redo.hint',
    global: true,
    run: () => useGraphStore.getState().redo(),
  },
  {
    id: 'delete-node',
    group: 'edit',
    labelKey: 'shortcut.delete-node',
    hintKey: 'shortcut.delete-node.hint',
    run: () => {
      const { selectedEdgeId, selectedNodeId } = useUiStore.getState()
      /*
       * 两者互斥(见 uiStore.selectedEdgeId 的注释),所以顺序不影响结果 ——
       * 先看连线只是让"这一下删的是谁"读起来更直白。
       *
       * 切连线**不弹确认**:重新拉一条的代价很小;而删节点会毁掉对话历史,
       * 两者代价不对称,所以确认框只留给后者。
       */
      if (selectedEdgeId) return useGraphStore.getState().removeEdge(selectedEdgeId)
      if (selectedNodeId) void deleteNodeWithConfirm(selectedNodeId)
    },
  },
  {
    id: 'add-node',
    group: 'edit',
    labelKey: 'shortcut.add-node',
    hintKey: 'shortcut.add-node.hint',
    global: true,
    run: () => {
      const ui = useUiStore.getState()
      ui.setAddMenuOpen(!ui.addMenuOpen)
    },
  },
  {
    id: 'focus-composer',
    group: 'edit',
    labelKey: 'shortcut.focus-composer',
    hintKey: 'shortcut.focus-composer.hint',
    run: () => {
      const ta = document.querySelector<HTMLTextAreaElement>('.inspector .composer textarea')
      ta?.focus()
    },
  },
  {
    id: 'duplicate-node',
    group: 'edit',
    labelKey: 'shortcut.duplicate-node',
    hintKey: 'shortcut.duplicate-node.hint',
    global: true,
    run: () => {
      const id = useUiStore.getState().selectedNodeId
      if (id) useGraphStore.getState().duplicateNode(id)
    },
  },
  {
    id: 'rename-node',
    group: 'edit',
    labelKey: 'shortcut.rename-node',
    hintKey: 'shortcut.rename-node.hint',
    global: true,
    run: () => {
      const ui = useUiStore.getState()
      if (ui.selectedNodeId) ui.requestRename(ui.selectedNodeId)
    },
  },

  /* ---------------- 视图 ---------------- */
  {
    id: 'fit-view',
    group: 'view',
    labelKey: 'shortcut.fit-view',
    global: true,
    run: () => canvasBridge()?.fitView(),
  },
  {
    id: 'chat-tab',
    group: 'view',
    labelKey: 'shortcut.chat-tab',
    global: true,
    run: () => {
      const ui = useUiStore.getState()
      if (ui.selectedNodeId) ui.setInspectorTab('chat')
    },
  },
  {
    id: 'config-tab',
    group: 'view',
    labelKey: 'shortcut.config-tab',
    global: true,
    run: () => {
      const ui = useUiStore.getState()
      if (ui.selectedNodeId) ui.setInspectorTab('config')
    },
  },
  {
    id: 'toggle-workspace',
    group: 'view',
    labelKey: 'shortcut.toggle-workspace',
    hintKey: 'shortcut.toggle-workspace.hint',
    global: true,
    run: () => {
      const ui = useUiStore.getState()
      ui.setWorkspace(ui.workspace === 'app' ? 'image' : 'app')
    },
  },

  /* ---------------- 导航 ---------------- */
  {
    id: 'shortcuts-help',
    group: 'nav',
    labelKey: 'shortcut.shortcuts-help',
    run: () => {
      const ui = useUiStore.getState()
      ui.setShowShortcuts(!ui.showShortcuts)
    },
  },
  {
    id: 'settings',
    group: 'nav',
    labelKey: 'shortcut.settings',
    global: true,
    run: () => useUiStore.getState().setShowSettings(true),
  },
  {
    id: 'toggle-skills',
    group: 'nav',
    labelKey: 'shortcut.toggle-skills',
    global: true,
    run: () => {
      const ui = useUiStore.getState()
      ui.setShowSkills(!ui.showSkills)
    },
  },
  {
    id: 'export-workflow',
    group: 'nav',
    labelKey: 'shortcut.export-workflow',
    global: true,
    run: () => void exportWorkflowFile(),
  },
  {
    id: 'import-workflow',
    group: 'nav',
    labelKey: 'shortcut.import-workflow',
    global: true,
    run: () => void importWorkflowFile(),
  },
  {
    id: 'focus-project',
    group: 'nav',
    labelKey: 'shortcut.focus-project',
    global: true,
    run: () => {
      const el = document.querySelector<HTMLElement>('.topbar select.proj-select, .topbar select')
      el?.focus()
    },
  },
  {
    id: 'escape',
    group: 'nav',
    labelKey: 'shortcut.escape',
    hintKey: 'shortcut.escape.hint',
    global: true,
    run: () => {
      const ui = useUiStore.getState()
      if (ui.showShortcuts) return ui.setShowShortcuts(false)
      if (ui.showSettings) return ui.setShowSettings(false)
      if (ui.showSkills) return ui.setShowSkills(false)
      if (ui.addMenuOpen) return ui.setAddMenuOpen(false)
      // 焦点还在输入框里 → 这一下 Esc 交给输入框自己处理(NodeShell 的改名框靠它放弃修改)
      if (isTypingTarget(document.activeElement)) return
      ui.select(null)
    },
  },
]

/* ------------------------------------------------------------------ */
/* 画布动作桥接                                                        */
/* ------------------------------------------------------------------ */

/**
 * fitView 只有 ReactFlowProvider 内部拿得到,而快捷键监听在 App 层 ——
 * 用一个显式的小槽把两者接起来,比把整张快捷键表挪进画布组件干净:
 * 「跑全部」「删节点」这些跟画布没关系,不该被关进 Provider 里。
 */
export interface CanvasBridge {
  fitView(): void
}

let bridge: CanvasBridge | null = null

export function setCanvasBridge(b: CanvasBridge | null): void {
  bridge = b
}

function canvasBridge(): CanvasBridge | null {
  return bridge
}

/**
 * 跑一遍快捷键表。
 *
 * 键位从 keymap(默认 + 用户自定义)读;返回是否命中 —— 命中即代表这一次
 * 按键已经被"业务"消费掉,useShortcuts 会 preventDefault,免得同时触发
 * 浏览器/React Flow 的默认行为。
 */
export function dispatchShortcut(e: KeyboardEvent): boolean {
  const km = getKeymap()
  for (const def of SHORTCUTS) {
    if (!def.global && isTypingTarget(e.target)) continue
    const combos = km[def.id]
    if (!combos || !combos.some((c) => comboMatches(e, c))) continue
    def.run(e)
    return true
  }
  return false
}

// mod / lc 保留给扩展动作使用(如未来按修饰键状态分支),避免误删后编译报错
export { mod, lc }
