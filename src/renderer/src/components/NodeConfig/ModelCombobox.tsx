import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import {
  MODEL_SOURCE_LABEL,
  currentValueCandidate,
  filterModels,
  mergeModelCandidates,
  type ModelCandidate,
  type ModelDef,
  type ModelSource,
} from '../../types'

/**
 * 可输入 + 实时过滤的模型选择框。
 *
 * ## 为什么不是 `<select>`
 *
 * 用户报的原话是「有些模型版本多,没法输入,比如火山」。原生 `<select>` 不可搜索,
 * 而**模型多的服务商恰恰是最需要它的那些**:
 *   - **火山方舟**:用户在控制台自建的推理接入点(`ep-…` / `ark-…`)**数量不限**,
 *     而且它们**根本不在 `/api/v3/models` 的返回里** —— 拉取功能对它们完全无效;
 *   - **聚合/中转站**:一个 Key 打通全网,上百个模型平铺。
 *
 * 也就是说"翻下拉框"这条路在真正需要它的地方是走不通的 —— 不是慢,是找不到。
 *
 * ## 三条设计约束
 *
 * 1. **可以直接敲,不必先点开** —— 用户敲了就用这个值。最快的路径永远是一路到底,
 *    任何"先选来源再填值"的两步式都会把用户挡在外面。
 * 2. **敲字时浮出过滤候选** —— 敲到一半才想起名字时,候选能帮他确认;
 *    纯输入框只能靠记忆。
 * 3. **手填不受清单限制** —— 填一个注册表里没有的名字,值就是它。这是内置清单
 *    一定会过时这一事实的兜底(见 shared/providers.ts 顶部),动它就等于把用户卡死。
 *
 * ## 键盘与外部点击
 *
 * 局部按键**不进全局快捷键表**(`lib/shortcuts.ts`)。那个表会被帮助浮层
 * (`ShortcutsHelp`)原样渲染出来,把组件内的 ↑↓/Enter 塞进去等于污染用户看到的
 * "这份应用的快捷键"—— 而它们只在光标恰好落在这个框里时才成立。
 *
 * 菜单项拿**真实 DOM 焦点** —— 但**只在用户按 ↑↓ 主动进列表之后**,
 * 于是方向键移动、Enter 原生激活、焦点环由系统给,一样都不少,
 * 而输入框在此之前始终握着焦点(否则"点进来直接敲"的第一个字会丢)。
 * `pointerdown` 捕获阶段判点外,与 Canvas.tsx 的 `addWrapRef` 同一套写法。
 */

/**
 * 候选来源角标。
 *
 * 颜色沿用既有 `badge` 的三档语义,但**不借用 `mem`**(那是内存表的专用修饰类,
 * 语义无关)。手填这一档刻意用**中性灰**而不是 ok/warn:
 * 它既不是"已验证"也不是"警告",而是"未验证但允许" —— 给了 ok 会误导成可信。
 *
 * 而"已验证"(探测跑过、确实拿到过回复)反过来用 **ok**:它是本控件里
 * 唯一有服务端回执的来源,给中性灰等于把这份证据藏起来了 ——
 * 那用户探一轮探测的意义就只剩"少几个可选",而他真正要的是"知道哪个对"。
 */
function SourceBadge({ source }: { source: ModelSource }): JSX.Element {
  const cls = source === 'verified' ? 'ok' : source === 'remote' ? 'ok' : source === 'builtin' ? 'warn' : ''
  const isVerified = source === 'verified'
  return (
    <span
      className={`badge ${cls}`.trim()}
      aria-label={`来源:${MODEL_SOURCE_LABEL[source]}`}
      title={isVerified ? '探测验证过:确实拿到过回复' : undefined}
    >
      {MODEL_SOURCE_LABEL[source]}
    </span>
  )
}

export function ModelCombobox({
  value,
  candidates,
  onChange,
  disabled,
  /** 空输入时那一行提示用的名字(=用默认时实际会用的那个) */
  defaultLabel,
  placeholder = '输入模型名,可直接粘贴接入点 id',
}: {
  value: string | undefined
  /** 候选列表。不含"当前值",组件内部会补 —— 见 currentValueCandidate */
  candidates: readonly ModelCandidate[]
  onChange: (next: string) => void
  disabled?: boolean
  defaultLabel?: string
  placeholder?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  /*
   * 当前值也作为一条候选参与过滤与展示。
   *
   * 只在这一处补,而不是让每个调用方各自拼 —— 三处调用点(节点面板 / 设置页 /
   * 未来的工作流)拼法一旦不一致,就会出现"某个面板里看不到自己填的值"。
   */
  const all = useMemo(
    () => [...candidates, ...currentValueCandidate(candidates, value)],
    [candidates, value],
  )

  /** 过滤结果跟着输入框走。这是整个控件唯一的"搜索"逻辑 */
  const shown = useMemo(() => filterModels(all, value ?? ''), [all, value])

  /*
   * 点外部关闭。
   *
   * 必须用 `pointerdown` + 捕获阶段:等到 `click` 就晚了 —— 那时菜单已经因为
   * "点到了外面"被关掉,而用户点的那个控件又会拿到焦点,焦点一跑这里就得跟着关。
   * 捕获阶段在 React 合成事件之前跑,判定才不会和被点的那个控件抢时序。
   */
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  /**
   * 框内按键。**刻意不注册进全局快捷键表** —— 见文件顶部说明。
   *
   * ⚠️ **输入框始终保持焦点**,菜单展开时也不抢。这不是疏忽而是被测试要求的:
   * 用户要能"点进来直接敲",一旦展开就把焦点挪到第一项,他打的第一个字就丢了
   * —— 那正好把本控件唯一比 `<select>` 强的地方(不用先展开就能输入)又砸了。
   *
   * 菜单项的**真实 DOM 焦点**只在用户主动按 ↑↓ 进去之后才交出去(见 `focusRow`),
   * 于是方向键移动、Enter 原生激活、焦点环由系统给,一样都不少。
   */
  const focusRow = (delta: number | 'first' | 'last'): void => {
    const items = itemRefs.current.filter((el): el is HTMLButtonElement => el !== null)
    if (items.length === 0) return
    const idx = items.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      delta === 'first'
        ? 0
        : delta === 'last'
          ? items.length - 1
          : (idx + delta + items.length) % items.length
    items[idx < 0 && delta !== 'first' && delta !== 'last' ? (delta > 0 ? 0 : items.length - 1) : next]?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      /*
       * 关掉菜单,但**不**动输入框的值 —— 用户可能只是瞥了一眼候选列表。
       * `stopPropagation` 是必须的:全局那张表里有一条 `escape`,它会顺手
       * "取消选中节点",而焦点在输入框里时用户多半只是想关掉浮层。
       */
      e.stopPropagation()
      setOpen(false)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      // 按方向键就是"我要用候选了" —— 这一刻才把焦点交出去
      if (!open) setOpen(true)
      focusRow(e.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (e.key === 'Home' && open) {
      e.preventDefault()
      focusRow('first')
      return
    }
    if (e.key === 'End' && open) {
      e.preventDefault()
      focusRow('last')
    }
  }

  /** 选中一条候选。回填输入框并收起菜单,焦点还给输入框(便于接着改) */
  const pick = (m: ModelCandidate): void => {
    onChange(m.id)
    setOpen(false)
    inputRef.current?.focus()
  }

  const empty = shown.length === 0

  return (
    <div className="model-combo" ref={wrapRef}>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-label="模型"
        placeholder={placeholder}
        value={value ?? ''}
        /*
         * 敲字**立刻**生效 —— 不经过"选中候选"这一步。
         *
         * 这是本控件最重要的一行:用户可以完全不看候选,直接把名字敲进去,
         * 也不用先展开任何浮层。空值就是空值,`effectiveModel` 会把它回落成
         * 内置首选(见 shared/providers.ts)。
         */
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
      />

      {open && (
        <div className="model-combo-list" role="listbox">
          {/*
           * "用默认"那一档排在最前。
           *
           * 只在输入框为空时出现:它是"清空即回落"的唯一入口,而用户往往
           * 正是想回到默认时才开始在候选里翻。
           */}
          {!value?.trim() && (
            <button
              type="button"
              role="option"
              aria-selected={false}
              ref={(el) => {
                itemRefs.current[0] = el
              }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange('')
                inputRef.current?.focus()
              }}
            >
              {defaultLabel ? `用默认(${defaultLabel})` : '用默认'}
            </button>
          )}

          {shown.map((m, i) => (
            <button
              key={`${m.source}:${m.id}`}
              type="button"
              role="option"
              aria-selected={m.id === value}
              /*
               * 下标 +1:"用默认"那一档占着 0,候选从 1 起。
               * 两边必须用同一个坐标系,否则 ↑↓ 会跳过第一项或越界到 undefined。
               */
              ref={(el) => {
                itemRefs.current[i + (value?.trim() ? 0 : 1)] = el
              }}
              /*
               * `onMouseDown` 阻止默认:否则按下鼠标的瞬间输入框先失焦,
               * 焦点判外会把菜单关掉,这一下 click 就落空了(典型症状:
               * "点列表项没反应")。Enter 走的是按钮原生激活,不受影响。
               */
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(m)}
            >
              <span className="mc-label">
                {m.label}
                {m.tag ? ` · ${m.tag}` : ''}
              </span>
              {/* id 与 label 不一致时才显示 id —— 一样的话是重复信息,占地方不值 */}
              {m.id !== m.label && <code className="mc-id">{m.id}</code>}
              <SourceBadge source={m.source} />
            </button>
          ))}

          {empty && (
            <div className="mc-empty">
              {/*
               * 没有匹配时**必须明确告诉用户"照样能用"**。
               *
               * 这是"手填"与"被拒绝"的边界:候选为空只意味着列表里没有,
               * 绝不能让用户以为这个名字不合法 —— 方舟的接入点 id 天生不在任何
               * 列表里,这里要是写成"未找到该模型",用户就会去翻控制台一个个比对。
               */}
              没有匹配的候选 —— 上面输入的名字会<b>原样</b>使用,不受清单限制。
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 按来源把一份 `ModelDef[]` 标成候选 —— 三处调用点共用,避免拼法漂移。
 *
 * `source` 传 `fetchModels` 给出的那个(它已经分清了服务端拉的还是回落的内置),
 * 于是"界面上标的来源"与"主进程说的来源"永远一致 —— 用户看到的角标就是
 * `ListOutcome.source` 的原话,不是组件自己猜的。
 */
export function buildCandidates(
  models: readonly ModelDef[],
  source: ModelSource,
): ModelCandidate[] {
  return mergeModelCandidates([{ source, models }])
}
