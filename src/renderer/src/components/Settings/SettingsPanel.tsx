import { useEffect, useState, type JSX } from 'react'
import type { LimitSettings, Settings, WorkflowSettings } from '../../types'
import { useSettingsStore } from '../../stores/settingsStore'
import { t } from '../../lib/i18n'
import { AppEnvSection } from './AppEnvSection'
import { PerformanceSection } from './PerformanceSection'
import { ProviderSection } from './ProviderSection'
import { UiSection } from './UiSection'

/** 上限类字段的元信息。与 schema 的区间保持一致(越界值主进程会夹回去) */
const LIMIT_FIELDS: { key: keyof LimitSettings; label: string; hint: string }[] = [
  { key: 'maxItemsPerNode', label: t('settings.limits.maxItemsPerNode'), hint: t('settings.limits.maxItemsPerNode.hint') },
  { key: 'maxToolResultChars', label: t('settings.limits.maxToolResultChars'), hint: t('settings.limits.maxToolResultChars.hint') },
  { key: 'maxThinkingChars', label: t('settings.limits.maxThinkingChars'), hint: '' },
  { key: 'maxResultChars', label: t('settings.limits.maxResultChars'), hint: '' },
  { key: 'stderrTailLines', label: t('settings.limits.stderrTailLines'), hint: t('settings.limits.stderrTailLines.hint') },
  { key: 'diagRingSize', label: t('settings.limits.diagRingSize'), hint: t('settings.limits.diagRingSize.hint') },
]

const WORKFLOW_FIELDS: { key: keyof WorkflowSettings; label: string; hint: string }[] = [
  { key: 'maxParallel', label: t('settings.workflow.maxParallel'), hint: t('settings.workflow.maxParallel.hint') },
  { key: 'inlineLimitBytes', label: t('settings.workflow.inlineLimitBytes'), hint: t('settings.workflow.inlineLimitBytes.hint') },
]

/** 设置分类页签(v0.6.6 起分页展示,不再一页堆到底) */
export type SettingsTab = 'perf' | 'model' | 'ui' | 'adv'
const SETTINGS_TABS: { id: SettingsTab }[] = [
  { id: 'perf' },
  { id: 'model' },
  { id: 'ui' },
  { id: 'adv' },
]

export function SettingsPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const payload = useSettingsStore((s) => s.payload)
  const error = useSettingsStore((s) => s.error)
  const load = useSettingsStore((s) => s.load)
  const save = useSettingsStore((s) => s.save)
  const relaunch = useSettingsStore((s) => s.relaunch)

  const [draft, setDraft] = useState<Settings | null>(null)
  const [busy, setBusy] = useState(false)
  /**
   * 设置分类页签(v0.6.6):性能 / 模型与 Agent / 界面与快捷键 / 高级。
   * 旧版一页全堆,找个选项要翻整条抽屉;分页后每个分类一目了然。
   */
  const [tab, setTab] = useState<SettingsTab>('perf')

  useEffect(() => {
    void load()
  }, [load])

  // 只在主进程的值变化时重置草稿。保存成功后 current === 我们刚发出去的那份,
  // 所以这里不会把用户的编辑抹掉
  useEffect(() => {
    if (payload) setDraft(payload.current)
  }, [payload])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const dirty = draft != null && payload != null && JSON.stringify(draft) !== JSON.stringify(payload.current)
  const needRestart = payload?.restartRequired ?? []

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h2>{t('settings.title')}</h2>
          <span className="spacer" />
          <button onClick={onClose}>{t('settings.close')}</button>
        </header>

        <div className="drawer-body">
          {error && <div className="errbox">{error}</div>}
          {!draft || !payload ? (
            <div className="note">{t('settings.loading')}</div>
          ) : (
            <>
              {needRestart.length > 0 && (
                <div className="restartbar">
                  <div>
                    {t('settings.restartNote', undefined, { items: needRestart.join(', ') })}
                  </div>
                  <button className="primary" onClick={() => void run(relaunch)} disabled={busy}>
                    {t('settings.restartNow')}
                  </button>
                </div>
              )}

              {/* 分类页签:一个 tab 一段设置,不再一页堆到底 */}
              <div className="drawer-tabs" role="tablist">
                {SETTINGS_TABS.map(({ id }) => (
                  <button
                    key={id}
                    role="tab"
                    aria-selected={tab === id}
                    className={tab === id ? 'dtab on' : 'dtab'}
                    onClick={() => setTab(id)}
                  >
                    {t(`settings.tab.${id}`)}
                  </button>
                ))}
              </div>

              {tab === 'perf' && (
                <PerformanceSection
                  value={draft.memory}
                  onChange={(memory) => setDraft({ ...draft, memory })}
                />
              )}

              {tab === 'model' && (
                <>
                  <AppEnvSection
                    value={draft.agent}
                    onChange={(agent) => setDraft({ ...draft, agent })}
                  />
                  <ProviderSection
                    value={draft.agent}
                    onChange={(agent) => setDraft({ ...draft, agent })}
                  />
                </>
              )}

              {tab === 'ui' && (
                <UiSection value={draft.ui} onChange={(ui) => setDraft({ ...draft, ui })} />
              )}

              {tab === 'adv' && (
                <>
                  <h3>{t('settings.msgCap')}</h3>
                  <div className="note">{t('settings.msgCapHint')}</div>
                  {LIMIT_FIELDS.map((f) => (
                    <div className="field inline" key={f.key}>
                      <label className="flabel">
                        <input
                          className="fnum"
                          type="number"
                          min={0}
                          value={draft.limits[f.key]}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              limits: { ...draft.limits, [f.key]: Number(e.target.value) },
                            })
                          }
                        />
                        <span>{f.label}</span>
                      </label>
                      {f.hint && <div className="fhint">{f.hint}</div>}
                    </div>
                  ))}

                  <h3>{t('settings.workflowTitle')}</h3>
                  {WORKFLOW_FIELDS.map((f) => (
                    <div className="field inline" key={f.key}>
                      <label className="flabel">
                        <input
                          className="fnum"
                          type="number"
                          min={1}
                          value={draft.workflow[f.key]}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              workflow: { ...draft.workflow, [f.key]: Number(e.target.value) },
                            })
                          }
                        />
                        <span>{f.label}</span>
                      </label>
                      {f.hint && <div className="fhint">{f.hint}</div>}
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </div>

        <footer className="drawer-foot">
          <button
            className="primary"
            disabled={!dirty || busy || !draft}
            onClick={() =>
              void run(async () => {
                if (draft) await save(draft)
              })
            }
          >
            {dirty ? t('settings.save') : t('settings.saved')}
          </button>
          <button disabled={!dirty || busy || !payload} onClick={() => payload && setDraft(payload.current)}>
            {t('settings.discard')}
          </button>
        </footer>
      </aside>
    </div>
  )
}
