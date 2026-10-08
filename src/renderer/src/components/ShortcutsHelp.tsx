import { useMemo, useState, type JSX } from 'react'
import { SHORTCUT_ACTIONS, effectiveKeymap, type ShortcutActionMeta } from '../lib/keymap'
import { useSettingsStore } from '../stores/settingsStore'
import { t } from '../lib/i18n'
import { Icon, type IconName } from './Icons'

/**
 * 快捷键浮层(v0.6.6 重写)。
 *
 * ## 键位从 keymap 读,不硬编码
 *
 * 用户在设置页改过键之后,这张表显示的就是**当前生效**的键位 ——
 * 不是"出厂默认"、更不是代码里的旧值。表由 `SHORTCUT_ACTIONS`(全部可
 * 自定义动作)渲染,label / hint 走 i18n(shortcut.<id> / shortcut.<id>.hint),
 * 加一个动作、改一个键,这里跟着变。
 *
 * ## 为什么不再用 shortcuts.ts 的 SHORTCUTS
 *
 * 那是对外一致的**行为表**(谁负责执行),而帮助要展示的是**键位清单**
 * (哪些动作、默认什么键、现在什么键)。行为表里没有键位,清单从
 * SHORTCUT_ACTIONS + 当前 keymap 合成 —— 数据源各管一段,反而干净。
 */

const GROUP_ORDER: ShortcutActionMeta['group'][] = ['run', 'edit', 'view', 'nav']

const GROUP_ICON: Record<ShortcutActionMeta['group'], IconName> = {
  run: 'play',
  edit: 'terminal',
  view: 'search',
  nav: 'keyboard',
}

/** 鼠标操作参考:纯说明,不进入可执行动作表(手势没有可匹配的键事件) */
const MOUSE_OPS: { icon: IconName; labelKey: string; hintKey?: string }[] = [
  { icon: 'mouse', labelKey: 'sc.mouse.drag', hintKey: 'sc.mouse.drag.hint' },
  { icon: 'play', labelKey: 'sc.mouse.connect', hintKey: 'sc.mouse.connect.hint' },
  { icon: 'scissors', labelKey: 'sc.mouse.cutEdge' },
  { icon: 'dot', labelKey: 'sc.mouse.rename', hintKey: 'sc.mouse.rename.hint' },
  { icon: 'search', labelKey: 'sc.mouse.pan' },
  { icon: 'plus', labelKey: 'sc.mouse.box', hintKey: 'sc.mouse.box.hint' },
]

function Keys({ combos }: { combos: string[] }): JSX.Element {
  return (
    <div className="sc-keys">
      {combos.map((combo, i) => (
        <span key={combo} className="sc-combo">
          {i > 0 && <span className="sc-sep">/</span>}
          {combo.split('+').map((part, j) => (
            <span key={`${combo}-${part}`} className="sc-key">
              {j > 0 && <span className="sc-sep">+</span>}
              <span className={j === combo.split('+').length - 1 ? 'kbd main' : 'kbd'}>{part}</span>
            </span>
          ))}
        </span>
      ))}
    </div>
  )
}

export function ShortcutsHelp({ onClose }: { onClose(): void }): JSX.Element {
  const [q, setQ] = useState('')
  const payload = useSettingsStore((s) => s.payload)

  const keymap = useMemo(() => effectiveKeymap(payload?.current?.ui), [payload?.current?.ui])

  const needle = q.trim().toLowerCase()
  const groups = useMemo(() => {
    const hit = (a: ShortcutActionMeta): boolean => {
      if (!needle) return true
      const hay = `${(keymap[a.id] ?? a.defaultCombos).join(' / ')} ${t(`shortcut.${a.id}`)} ${t(`shortcut.${a.id}.hint`)} ${a.group}`.toLowerCase()
      return hay.includes(needle)
    }
    return GROUP_ORDER.map((group) => ({
      group,
      items: SHORTCUT_ACTIONS.filter((a) => a.group === group && hit(a)),
    })).filter((g) => g.items.length > 0)
  }, [needle, keymap])

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
        aria-label={t('sc.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sc-head">
          <h2>
            <Icon name="keyboard" size={15} />
            {t('sc.title')}
          </h2>
          <span className="sc-sub">{t('sc.sub')}</span>
          <span className="spacer" />
          <button className="sc-close" onClick={onClose} title={t('sc.close')} aria-label={t('sc.close')}>
            <Icon name="close" size={13} />
          </button>
        </header>

        <div className="sc-search">
          <Icon name="search" size={13} />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('sc.searchPlaceholder')}
            spellCheck={false}
            aria-label={t('sc.searchPlaceholder')}
          />
          {q && (
            <button className="sc-clear" onClick={() => setQ('')} title={t('sc.clear')} aria-label={t('sc.clear')}>
              <Icon name="close" size={11} />
            </button>
          )}
        </div>

        <div className="sc-body">
          {total === 0 && <div className="sc-none">{t('sc.none', undefined, { q })}</div>}

          {groups.map(({ group, items }) => (
            <section className="sc-group" key={group}>
              <h3>
                <Icon name={GROUP_ICON[group]} size={12} />
                {t(`group.${group}`)}
                <span className="sc-count">{items.length}</span>
              </h3>
              <div className="sc-list">
                {items.map((a) => (
                  <div className="sc-item" key={a.id}>
                    <Keys combos={keymap[a.id] ?? a.defaultCombos} />
                    <div className="sc-text">
                      <div className="sc-label">{t(`shortcut.${a.id}`)}</div>
                      {t(`shortcut.${a.id}.hint`) && <div className="sc-hint">{t(`shortcut.${a.id}.hint`)}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}

          {!needle && (
            <section className="sc-group sc-mouse">
              <h3>
                <Icon name="mouse" size={12} />
                {t('sc.mouse')}
              </h3>
              <div className="sc-list">
                {MOUSE_OPS.map((m) => (
                  <div className="sc-item" key={m.labelKey}>
                    <div className="sc-keys">
                      <span className="sc-gesture">
                        <Icon name={m.icon} size={12} />
                        {t(m.labelKey)}
                      </span>
                    </div>
                    <div className="sc-text">
                      <div className="sc-label">{t(m.labelKey)}</div>
                      {m.hintKey && <div className="sc-hint">{t(m.hintKey)}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        <footer className="sc-foot">{t('sc.foot')}</footer>
      </div>
    </div>
  )
}
