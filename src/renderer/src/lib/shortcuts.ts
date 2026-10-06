import { flushGraphSave, useGraphStore } from '../stores/graphStore'
import { useUiStore } from '../stores/uiStore'
import { useWorkflowStore } from '../stores/workflowStore'
import { deleteNodeWithConfirm } from './nodeOps'

/**
 * 快捷键的**唯一事实源**。
 *
 * 为什么是一张表而不是一堆散落的 addEventListener:
 *   - 帮助浮层直接渲染这张表 —— 新增/改键只改一处,不会出现
 *     "界面上写 Ctrl+Enter、代码里认 Ctrl+Return"这种漂移;
 *   - 匹配与执行分离:match 只管"是不是这个键",run 只管"干嘛",
 *     免得两者混在 if/else 里,读的人要同时想两件事;
 *   - `global` 一个布尔就说清了"在输入框里打字时还算不算数"。
 *
 * 约定(与 Composer 的 Enter 发送、NodeShell 的改名输入框对齐):
 *   凡是**输入框里打字会自然产生的字符**(Delete / Backspace / Enter / ?),
 *   一律 global:false —— 否则用户想在提示词里删个字,节点先没了。
 *   凡是**带修饰键的组合**(Ctrl/Cmd + …)一律 global:true,它们是命令,不是文本。
 */

export type ShortcutGroup = '运行' | '编辑' | '视图' | '导航'

export interface ShortcutDef {
  /** 稳定标识,帮助浮层做 key,e2e 想断言也能按它找 */
  id: string
  group: ShortcutGroup
  /** 展示用的按键片段。最后一片是"主键",帮助浮层会加重它 */
  keys: string[]
  label: string
  /** 补充说明(可为空) */
  hint?: string
  /** true = 焦点在任何输入框里时仍然生效 */
  global?: boolean
  match(e: KeyboardEvent): boolean
  run(): void
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
    group: '运行',
    keys: ['Ctrl', 'Enter'],
    label: '跑完整张图',
    hint: '按连线顺序,与运行条的「▶ 跑全部」等价',
    global: true,
    match: (e) => mod(e) && e.key === 'Enter' && !e.shiftKey,
    run: () => {
      const st = useWorkflowStore.getState()
      if (!canStartRun() || useGraphStore.getState().nodes.length === 0) return
      void st.runAll()
    },
  },
  {
    id: 'run-selected',
    group: '运行',
    keys: ['Ctrl', 'Shift', 'Enter'],
    label: '只跑选中节点',
    hint: '连同它的上游一起跑',
    global: true,
    match: (e) => mod(e) && e.shiftKey && e.key === 'Enter',
    run: () => {
      const st = useWorkflowStore.getState()
      const target = useUiStore.getState().selectedNodeId
      if (!canStartRun() || !target) return
      void st.runTargets([target])
    },
  },
  {
    id: 'cancel-run',
    group: '运行',
    keys: ['Ctrl', 'Shift', 'C'],
    label: '取消当前运行',
    global: true,
    match: (e) => mod(e) && e.shiftKey && lc(e) === 'c',
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
    group: '编辑',
    keys: ['Ctrl', 'S'],
    label: '立即保存画布',
    hint: '平时是 500ms 自动存盘,这个是"现在就写"',
    global: true,
    match: (e) => mod(e) && lc(e) === 's',
    run: () => void flushGraphSave(),
  },
  {
    id: 'undo',
    group: '编辑',
    keys: ['Ctrl', 'Z'],
    label: '撤销',
    hint: '加删节点 / 连线 / 拖动 / 改配置都可回退,最多 50 步',
    global: true,
    match: (e) => mod(e) && !e.shiftKey && lc(e) === 'z',
    run: () => useGraphStore.getState().undo(),
  },
  {
    id: 'redo',
    group: '编辑',
    keys: ['Ctrl', 'Shift', 'Z'],
    label: '重做',
    hint: '把刚撤销的那一步再做回来',
    global: true,
    match: (e) => mod(e) && e.shiftKey && lc(e) === 'z',
    run: () => useGraphStore.getState().redo(),
  },
  {
    id: 'delete-node',
    group: '编辑',
    keys: ['Delete'],
    label: '删除选中的节点 / 切断选中的连线',
    hint: '连线直接断;节点会问一次,运行中会先中断',
    match: (e) => e.key === 'Delete' || e.key === 'Backspace',
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
    group: '编辑',
    keys: ['Ctrl', 'K'],
    label: '添加节点',
    hint: '菜单里 ↑↓ 选,Enter 确认,数字键直选',
    global: true,
    match: (e) => mod(e) && lc(e) === 'k',
    run: () => {
      const ui = useUiStore.getState()
      ui.setAddMenuOpen(!ui.addMenuOpen)
    },
  },
  {
    id: 'focus-composer',
    group: '编辑',
    keys: ['Enter'],
    label: '给选中节点说话',
    hint: '把光标送进右栏输入框',
    match: (e) => e.key === 'Enter' && !isActivatableTarget(e.target),
    run: () => {
      const ta = document.querySelector<HTMLTextAreaElement>('.inspector .composer textarea')
      ta?.focus()
    },
  },

  /* ---------------- 视图 ---------------- */
  {
    id: 'fit-view',
    group: '视图',
    keys: ['Ctrl', '0'],
    label: '缩放到刚好装下',
    global: true,
    match: (e) => mod(e) && e.key === '0',
    run: () => canvasBridge()?.fitView(),
  },
  {
    id: 'toggle-tab',
    group: '视图',
    keys: ['Ctrl', '1 / 2'],
    label: '对话 / 节点配置',
    hint: 'Ctrl+1 对话,Ctrl+2 节点配置',
    global: true,
    // Ctrl+1 与 Ctrl+2 是**同一行帮助**,所以合成一条 def;
    // 具体按的是哪个键在 match 里记下(它紧接着就会被 run 读到)
    match: (e) => {
      if (!mod(e) || (e.key !== '1' && e.key !== '2')) return false
      lastDigit = e.key
      return true
    },
    run: () => {
      const ui = useUiStore.getState()
      if (!ui.selectedNodeId) return
      ui.setInspectorTab(lastDigit === '1' ? 'chat' : 'config')
    },
  },

  /* ---------------- 导航 ---------------- */
  {
    id: 'shortcuts-help',
    group: '导航',
    keys: ['?'],
    label: '打开/关闭这份快捷键表',
    match: (e) => e.key === '?',
    run: () => {
      const ui = useUiStore.getState()
      ui.setShowShortcuts(!ui.showShortcuts)
    },
  },
  {
    id: 'settings',
    group: '导航',
    keys: ['Ctrl', ','],
    label: '打开设置',
    global: true,
    match: (e) => mod(e) && e.key === ',',
    run: () => useUiStore.getState().setShowSettings(true),
  },
  {
    id: 'escape',
    group: '导航',
    keys: ['Esc'],
    label: '关闭浮层 / 回到画布',
    hint: '逐层关:浮层 → 菜单 → 取消选中',
    global: true,
    match: (e) => e.key === 'Escape',
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

/**
 * Ctrl+1 / Ctrl+2 共用一条 def **只是为了帮助浮层里它们能显示成一行**。
 * 具体按的是哪个键,由那条 def 的 match 在命中时写进这里,run 立刻读走 ——
 * 同一个事件循环内的一写一读,不存在竞态。
 */
let lastDigit: '1' | '2' = '1'

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
 * 返回是否命中 —— 命中即代表这一次按键已经被"业务"消费掉,
 * useShortcuts 会 preventDefault,免得同时触发浏览器/React Flow 的默认行为。
 */
export function dispatchShortcut(e: KeyboardEvent): boolean {
  for (const def of SHORTCUTS) {
    if (!def.global && isTypingTarget(e.target)) continue
    if (!def.match(e)) continue
    def.run()
    return true
  }
  return false
}
