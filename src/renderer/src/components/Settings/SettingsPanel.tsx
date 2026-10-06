import { useEffect, useState, type JSX } from 'react'
import type { LimitSettings, Settings, WorkflowSettings } from '../../types'
import { useSettingsStore } from '../../stores/settingsStore'
import { AppEnvSection } from './AppEnvSection'
import { PerformanceSection } from './PerformanceSection'
import { ProviderSection } from './ProviderSection'

/** 上限类字段的元信息。与 schema 的区间保持一致(越界值主进程会夹回去) */
const LIMIT_FIELDS: { key: keyof LimitSettings; label: string; hint: string }[] = [
  { key: 'maxItemsPerNode', label: '每节点消息上限', hint: '超出后从头部折叠,并提示「已折叠 N 条」' },
  { key: 'maxToolResultChars', label: '工具结果内联上限 (字符)', hint: '超出部分落到磁盘,展开时按需取回' },
  { key: 'maxThinkingChars', label: '思考内联上限 (字符)', hint: '' },
  { key: 'maxResultChars', label: '本轮结果上限 (字符)', hint: '' },
  { key: 'stderrTailLines', label: 'stderr 保留行数', hint: '只做诊断,不进消息流' },
  { key: 'diagRingSize', label: '诊断环形缓冲条数', hint: '未识别事件(raw)的保留量' },
]

const WORKFLOW_FIELDS: { key: keyof WorkflowSettings; label: string; hint: string }[] = [
  { key: 'maxParallel', label: '并发节点上限 (1–4)', hint: '16GB 内存 + API 限流下的保守值' },
  { key: 'inlineLimitBytes', label: '上游产出内联上限 (字节)', hint: '超出改为向下游注入文件路径' },
]

export function SettingsPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const payload = useSettingsStore((s) => s.payload)
  const error = useSettingsStore((s) => s.error)
  const load = useSettingsStore((s) => s.load)
  const save = useSettingsStore((s) => s.save)
  const relaunch = useSettingsStore((s) => s.relaunch)

  const [draft, setDraft] = useState<Settings | null>(null)
  const [busy, setBusy] = useState(false)

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
          <h2>设置</h2>
          <span className="spacer" />
          <button onClick={onClose}>关闭</button>
        </header>

        <div className="drawer-body">
          {error && <div className="errbox">{error}</div>}
          {!draft || !payload ? (
            <div className="note">读取设置中…</div>
          ) : (
            <>
              {needRestart.length > 0 && (
                <div className="restartbar">
                  <div>
                    已保存,但这些改动要<strong>重启</strong>才生效:
                    <code>{needRestart.join(', ')}</code>
                  </div>
                  <button className="primary" onClick={() => void run(relaunch)} disabled={busy}>
                    立即重启
                  </button>
                </div>
              )}

              <PerformanceSection
                value={draft.memory}
                onChange={(memory) => setDraft({ ...draft, memory })}
              />

              <AppEnvSection
                value={draft.agent}
                onChange={(agent) => setDraft({ ...draft, agent })}
              />

              <ProviderSection
                value={draft.agent}
                onChange={(agent) => setDraft({ ...draft, agent })}
              />

              <h3>消息列表封顶</h3>
              <div className="note">这些是渲染进程侧的裁剪,保存即生效,不需要重启。</div>
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

              <h3>工作流</h3>
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
            {dirty ? '保存' : '已保存'}
          </button>
          <button disabled={!dirty || busy || !payload} onClick={() => payload && setDraft(payload.current)}>
            撤销
          </button>
        </footer>
      </aside>
    </div>
  )
}
