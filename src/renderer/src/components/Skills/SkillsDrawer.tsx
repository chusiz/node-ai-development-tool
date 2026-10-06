import { useEffect, useState, type JSX } from 'react'
import type { SkillEntry, SkillOrigin } from '../../types'
import { useSkillsStore } from '../../stores/skillsStore'

/** 人类可读的字节数。技能通常很小,但还是给个界 */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function originText(o: SkillOrigin | null): string {
  if (!o) return '你自己放进去的'
  switch (o.kind) {
    case 'local':
      return `从本地文件夹导入 · ${o.path}`
    case 'github':
      return `从 GitHub 装的 · ${o.url}`
    case 'ai':
      return `让 AI 装的 · 节点 ${o.nodeId}`
    case 'manual':
      return '你自己放进去的'
  }
}

/**
 * 一行技能。
 *
 * 删除做**两步确认**(点一下变成「确认删除」)而不是 `window.confirm`:
 * confirm 在 Electron 里是个会阻塞渲染进程的原生框,而且长得和应用完全不像,
 * 用户很难把它和刚才点的那一行对上号。就地变成确认按钮,上下文一目了然。
 */
function SkillRow({ s }: { s: SkillEntry }): JSX.Element {
  const busy = useSkillsStore((st) => st.busy)
  const setEnabled = useSkillsStore((st) => st.setEnabled)
  const remove = useSkillsStore((st) => st.remove)

  const [confirming, setConfirming] = useState(false)

  // 别的操作开始时,把这个未完成的确认撤掉 —— 否则"确认删除"会挂在那里,
  // 用户过一会儿回来点一下,删的是已经不记得的那个东西
  useEffect(() => {
    if (busy) setConfirming(false)
  }, [busy])

  const working = busy?.endsWith(`:${s.name}`) ?? false

  return (
    <div className={`skill-row${s.enabled ? '' : ' off'}`}>
      <div className="skill-head">
        <code className="skill-name">{s.name}</code>

        {s.enabled ? (
          <span className="skill-state on" title={`模型看到的调用名:${s.invokeAs}`}>
            已启用
          </span>
        ) : (
          <span className="skill-state off">已停用</span>
        )}

        <span className="spacer" />

        <button
          disabled={!!busy}
          onClick={() => void setEnabled(s.name, !s.enabled)}
          title={s.enabled ? '停用后模型就看不见它了' : '启用后模型就能调用它'}
        >
          {working ? '…' : s.enabled ? '停用' : '启用'}
        </button>

        {confirming ? (
          <>
            <button
              className="danger"
              disabled={!!busy}
              onClick={() => {
                setConfirming(false)
                void remove(s.name)
              }}
            >
              确认删除
            </button>
            <button disabled={!!busy} onClick={() => setConfirming(false)}>
              取消
            </button>
          </>
        ) : (
          <button disabled={!!busy} onClick={() => setConfirming(true)}>
            删除
          </button>
        )}
      </div>

      {s.description ? (
        <div className="skill-desc">{s.description}</div>
      ) : (
        <div className="skill-desc empty">（这个技能没写 description）</div>
      )}

      {/*
       * 目录名和 frontmatter 里声明的名字不一致 —— 规范要求一致,但作者写错很常见。
       * 我们按声明名落盘,所以这里只是**告知**,不是错误。
       */}
      {s.declaredName && s.declaredName !== s.name && (
        <div className="skill-issue">
          目录名是「{s.name}」,但 SKILL.md 里声明的是「{s.declaredName}」—— 以目录名为准
        </div>
      )}

      {s.nameProblem && <div className="skill-issue err">名字不合规范:{s.nameProblem}</div>}

      <div className="skill-meta">
        {s.enabled && s.invokeAs && (
          <span className="skill-invoke" title="在提示词里这样引用它">
            {s.invokeAs}
          </span>
        )}
        <span>
          {s.fileCount} 个文件 · {fmtBytes(s.bytes)}
        </span>
        <span className="skill-origin" title={originText(s.origin)}>
          {originText(s.origin).split(' · ')[0]}
        </span>
      </div>
    </div>
  )
}

export function SkillsDrawer({ onClose }: { onClose: () => void }): JSX.Element {
  const skills = useSkillsStore((s) => s.skills)
  const error = useSkillsStore((s) => s.error)
  const notice = useSkillsStore((s) => s.notice)
  const busy = useSkillsStore((s) => s.busy)
  const load = useSkillsStore((s) => s.load)
  const importLocal = useSkillsStore((s) => s.importLocal)
  const openDir = useSkillsStore((s) => s.openDir)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const pickAndImport = async (): Promise<void> => {
    const res = await window.api.dialog.pickDirectory('选一个技能文件夹(里面要有 SKILL.md)')
    if (!res.ok) {
      // 选择器本身失败(比如已经开着一个)—— 这不是"用户点了取消",要说出来
      useSkillsStore.setState({ error: res.error })
      return
    }
    if (res.data) await importLocal(res.data)
  }

  const enabledCount = skills?.filter((s) => s.enabled).length ?? 0

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h2>技能</h2>
          <span className="spacer" />
          <button onClick={onClose}>关闭</button>
        </header>

        <div className="drawer-body">
          <div className="note">
            这里的技能是<strong>全局</strong>的 —— 画布上每个节点都能用。
            装进来的技能,模型看到的调用名带一层命名空间,写出来是{' '}
            <code>haowan-skills:技能名</code>,不是裸名字。
          </div>

          {error && <div className="errbox">{error}</div>}
          {notice && <div className="note ok">{notice}</div>}

          <div className="skill-actions">
            <button disabled={!!busy} onClick={() => void pickAndImport()}>
              导入本地文件夹
            </button>
            <button disabled={!!busy} onClick={() => void openDir()}>
              打开技能文件夹
            </button>
          </div>

          {skills === null ? (
            <div className="note">读取技能库中…</div>
          ) : skills.length === 0 ? (
            <div className="skill-empty">
              <div>技能库是空的</div>
              <div className="sub">
                两种装法:点「导入本地文件夹」选一个现成的,或者点「打开技能文件夹」
                自己把文件夹拷进去 —— 复制完之后回到这里,列表会自动出现。
              </div>
            </div>
          ) : (
            <>
              <h3>
                已装 {skills.length} 个{enabledCount > 0 && ` · 其中 ${enabledCount} 个启用中`}
              </h3>
              {skills.map((s) => (
                <SkillRow key={s.name} s={s} />
              ))}
            </>
          )}
        </div>

        <footer className="drawer-foot">
          <span className="note">
            停用的技能会被移出 plugin 目录 —— 模型**完全看不见**它,不是"关掉了但还在上下文里"
          </span>
        </footer>
      </aside>
    </div>
  )
}
