import { useEffect, useState, type JSX } from 'react'
import { SHORTCUT_ACTIONS, effectiveKeymap, comboParts } from '../../lib/keymap'
import type { UiSettings } from '../../../../shared/settings'
import { t } from '../../lib/i18n'

/**
 * 设置 →「界面与快捷键」(v0.6.6)。
 *
 * 两块:
 *   1. 语言 —— English / 中文,写 settings.ui.language(默认英文,海外优先);
 *   2. 快捷键 —— 每个动作一行,点键位进入"录制"态,按下一组键即绑定;
 *      冲突(同一个组合被别的动作占用)当场拦截并指出是哪个动作,
 *      点「默认」把该动作恢复出厂键位。
 *
 * 键位写进 settings.ui.keymap(随 settings.json 备份迁移),与帮助浮层、
 * 快捷键调度共用同一份 effectiveKeymap —— 改完即全局生效。
 */

/** 把一次 keydown 转成组合串(与 keymap 的 combo 格式一致)。纯修饰键(无主键)不录 */
function comboFromEvent(e: KeyboardEvent): string | null {
  const mods: string[] = []
  if (e.ctrlKey || e.metaKey) mods.push(e.metaKey ? 'Cmd' : 'Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  let main = e.key
  if (main === 'Control' || main === 'Alt' || main === 'Shift' || main === 'Meta') return null
  if (main.length === 1) main = main.toUpperCase()
  return [...mods, main].join('+')
}

/** 这个组合是否已被别的动作占用。占用则返回那个动作的 id,否则 null */
function conflictFor(ui: UiSettings | undefined, selfId: string, combo: string): string | null {
  const km = effectiveKeymap(ui)
  for (const a of SHORTCUT_ACTIONS) {
    if (a.id === selfId) continue
    if ((km[a.id] ?? a.defaultCombos).includes(combo)) return a.id
  }
  return null
}

/** 录制后把该动作的键位写进 ui.keymap;「默认」则删掉该条(回到出厂) */
function withCombo(ui: UiSettings | undefined, id: string, combo: string | null): UiSettings {
  const base: UiSettings = { language: ui?.language ?? 'en', keymap: { ...(ui?.keymap ?? {}) } }
  if (combo === null) delete base.keymap[id]
  else base.keymap[id] = combo
  return base
}

export function UiSection({
  value,
  onChange,
}: {
  value: UiSettings | undefined
  onChange(ui: UiSettings): void
}): JSX.Element {
  const [recording, setRecording] = useState<string | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)

  // 录制态:捕获下一次 keydown(阻止它继续冒泡到快捷键表),转成组合串并落键
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const combo = comboFromEvent(e)
      if (!combo) return
      const other = conflictFor(value, recording, combo)
      if (other) {
        setConflict(other)
        setRecording(null)
        return
      }
      setConflict(null)
      onChange(withCombo(value, recording, combo))
      setRecording(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, value, onChange])

  const km = effectiveKeymap(value)

  return (
    <section className="settings-section">
      <h3>{t('settings.uiTitle')}</h3>

      {/* 语言:默认英文(海外优先),可在设置里切回中文,保存后全局生效 */}
      <div className="field">
        <label className="flabel">{t('settings.language')}</label>
        <div className="radio-row">
          {(['en', 'zh'] as const).map((lang) => (
            <label key={lang} className="radio-item">
              <input
                type="radio"
                name="ui-lang"
                checked={value?.language === lang}
                onChange={() => onChange({ language: lang, keymap: value?.keymap ?? {} })}
              />
              <span>{lang === 'en' ? 'English' : '中文'}</span>
            </label>
          ))}
        </div>
        <div className="fhint">{t('settings.languageHint')}</div>
      </div>

      <div className="settings-section-sep" />

      {/* 快捷键:每个动作一行,点键位录制;冲突当场提示 */}
      <div className="keymap-list">
        {SHORTCUT_ACTIONS.map((a) => {
          const combos = km[a.id] ?? a.defaultCombos
          const isRecording = recording === a.id
          return (
            <div className="keymap-row" key={a.id}>
              <div className="keymap-text">
                <div className="keymap-label">{t(`shortcut.${a.id}`)}</div>
                {t(`shortcut.${a.id}.hint`) && <div className="keymap-hint">{t(`shortcut.${a.id}.hint`)}</div>}
              </div>
              <div className="keymap-keys">
                {combos.map((c) => (
                  <span key={c} className="sc-key">
                    {comboParts(c).map((part, j) => (
                      <span key={`${c}-${part}`}>
                        {j > 0 && <span className="sc-sep">+</span>}
                        <span className="kbd">{part}</span>
                      </span>
                    ))}
                  </span>
                ))}
                {isRecording && <span className="kbd rec">{t('settings.recording')}</span>}
                <button
                  className="keymap-edit"
                  title={t('settings.recordHint')}
                  onClick={() => {
                    setConflict(null)
                    setRecording(isRecording ? null : a.id)
                  }}
                >
                  {isRecording ? t('settings.cancel') : t('settings.change')}
                </button>
                <button
                  className="keymap-reset"
                  title={t('settings.resetHint')}
                  disabled={!value?.keymap?.[a.id]}
                  onClick={() => onChange(withCombo(value, a.id, null))}
                >
                  {t('settings.defaultKeys')}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {conflict && (
        <div className="errbox">
          {t('settings.conflict', undefined, { other: t(`shortcut.${conflict}`) })}
        </div>
      )}
    </section>
  )
}
