import { useMemo, useState, type JSX } from 'react'
import { SHORTCUTS, type ShortcutDef, type ShortcutGroup } from '../lib/shortcuts'
import { Icon, type IconName } from './Icons'

/**
 * 快捷键浮层。
 *
 * ## 内容完全由 `lib/shortcuts.ts` 那张表渲染
 *
 * 这份 UI 里没有一行硬编码的按键 —— 加了键、改了键,这里跟着变,
 * 不存在"文档比代码新"的经典问题。本次重画只动**呈现**:搜索、分组导航、
 * 鼠标操作参考区,数据来源一个没换。
 *
 * ## 为什么加搜索
 *
 * 表长到十几行之后,"我记得有个键能缩放,是哪个来着"就变成了一次通读。
 * 搜索按**按键 / 名称 / 说明**三处一起匹配(用户可能记得住其中任意一种),
 * 于是无论从哪个线索进来都能一步命中。
 *
 * ## 为什么单列到底、不做左右分栏
 *
 * 之前是两列密排,好处是一屏看得完,代价是"按键"和"说明"的对应关系要靠
 * 眼睛横着追,列与列之间还会互相干扰。重画成单列 + 分组标题:
 * 扫读是纵向的(符合"从上往下找一行"),行高留够,一条是一条。
 * 浮层本身有滚动,内容多也不是问题。
 */

/** 分组顺序固定,免得每次改动表里条目的先后,帮助里的顺序就跟着抖 */
const GROUP_ORDER: ShortcutGroup[] = ['运行', '编辑', '视图', '导航']

/** 分组图标。让四段有一条快速的视觉索引 */
const GROUP_ICON: Record<ShortcutGroup, IconName> = {
  运行: 'play',
  编辑: 'terminal',
  视图: 'search',
  导航: 'keyboard',
}

/**
 * 鼠标操作参考。
 *
 * **刻意不放进 SHORTCUTS 表**:那张表是"按键 → 动作"的可执行注册表
 * (每一条都带 match/run,由 App 层的监听真的去执行)。鼠标手势没有可匹配的
 * 键事件,塞进去就得给 match/run 编假实现 —— 表一旦混进"不能执行的条目",
 * 它作为"唯一事实源"的可信度就没了。所以这里是一份**纯说明**,
 * 和按键表并列展示,各自诚实。
 */
const MOUSE_OPS: { icon: IconName; keys: string; label: string; hint?: string }[] = [
  { icon: 'mouse', keys: '拖动节点', label: '移动节点位置', hint: '位置会随画布一起存盘' },
  { icon: 'play', keys: '拖右侧圆点', label: '连线到另一个节点', hint: '方向不对的连线会被当场拒绝并说明原因' },
  { icon: 'scissors', keys: '鼠标移到线上按 E', label: '剪断连线', hint: '也可以点选连线后按 Delete' },
  { icon: 'dot', keys: '双击节点标题', label: '就地改名', hint: '不用跑到右栏的配置页' },
  { icon: 'search', keys: '滚轮', label: '上下平移画布' },
  { icon: 'plus', keys: '空白处拖拽', label: '框选多个节点', hint: '选中后可一起拖动 / 删除' },
]

function Keys({ def }: { def: ShortcutDef }): JSX.Element {
  return (
    <div className="sc-keys">
      {def.keys.map((k, i) => (
        <span key={`${k}-${i}`} className="sc-key">
          {/* 分隔符是独立的 span 而不是 CSS 伪元素 —— 读屏软件也能念出"加" */}
          {i > 0 && <span className="sc-sep">+</span>}
          <span className={i === def.keys.length - 1 ? 'kbd main' : 'kbd'}>{k}</span>
        </span>
      ))}
    </div>
  )
}

export function ShortcutsHelp({ onClose }: { onClose(): void }): JSX.Element {
  const [q, setQ] = useState('')

  const needle = q.trim().toLowerCase()
  const groups = useMemo(() => {
    // 按键 / 名称 / 说明三处一起匹配 —— 用户记得住的可能是其中任意一种
    const hit = (s: ShortcutDef): boolean =>
      !needle ||
      `${s.keys.join('+')} ${s.label} ${s.hint ?? ''} ${s.group}`.toLowerCase().includes(needle)
    return GROUP_ORDER.map((group) => ({
      group,
      items: SHORTCUTS.filter((s) => s.group === group && hit(s)),
    })).filter((g) => g.items.length > 0)
  }, [needle])

  const total = groups.reduce((n, g) => n + g.items.length, 0)

  return (
    <div
      className="sc-overlay"
      // 点遮罩即关。弹窗上 stopPropagation,所以不会误关
      onClick={onClose}
    >
      <div
        className="sc-modal"
        role="dialog"
        aria-modal="true"
        aria-label="快捷键"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sc-head">
          <h2>
            <Icon name="keyboard" size={15} />
            快捷键
          </h2>
          <span className="sc-sub">输入框里打字时,只有带修饰键的组合仍然生效</span>
          <span className="spacer" />
          <button className="sc-close" onClick={onClose} title="关闭 (Esc)" aria-label="关闭">
            <Icon name="close" size={13} />
          </button>
        </header>

        {/* 搜索:表长了之后,"我记得有个键能缩放"不该变成一次通读 */}
        <div className="sc-search">
          <Icon name="search" size={13} />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜按键、名称或说明,比如「缩放」「Ctrl+S」「保存」"
            spellCheck={false}
            aria-label="搜索快捷键"
          />
          {q && (
            <button className="sc-clear" onClick={() => setQ('')} title="清空搜索" aria-label="清空搜索">
              <Icon name="close" size={11} />
            </button>
          )}
        </div>

        <div className="sc-body">
          {total === 0 && <div className="sc-none">没有匹配「{q}」的快捷键。</div>}

          {groups.map(({ group, items }) => (
            <section className="sc-group" key={group}>
              <h3>
                <Icon name={GROUP_ICON[group]} size={12} />
                {group}
                <span className="sc-count">{items.length}</span>
              </h3>
              <div className="sc-list">
                {items.map((s) => (
                  <div className="sc-item" key={s.id}>
                    <Keys def={s} />
                    <div className="sc-text">
                      <div className="sc-label">{s.label}</div>
                      {s.hint && <div className="sc-hint">{s.hint}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}

          {/*
            鼠标操作区:只在没搜索时显示 —— 搜索是在"找某个键",
            这时候把一张不可搜索的手势表压在下面只会干扰结果。
          */}
          {!needle && (
            <section className="sc-group sc-mouse">
              <h3>
                <Icon name="mouse" size={12} />
                鼠标操作
              </h3>
              <div className="sc-list">
                {MOUSE_OPS.map((m) => (
                  <div className="sc-item" key={m.keys}>
                    <div className="sc-keys">
                      <span className="sc-gesture">
                        <Icon name={m.icon} size={12} />
                        {m.keys}
                      </span>
                    </div>
                    <div className="sc-text">
                      <div className="sc-label">{m.label}</div>
                      {m.hint && <div className="sc-hint">{m.hint}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        <footer className="sc-foot">
          按 <span className="kbd">Esc</span> 逐层关闭浮层 · 这份表由代码里的按键定义直接渲染,与真实行为同源
        </footer>
      </div>
    </div>
  )
}
