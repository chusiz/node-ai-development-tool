import { useState, type JSX } from 'react'
import { unwrap } from '../../lib/unwrap'

/**
 * 工作目录选择器。
 *
 * 走主进程的真实文件夹对话框,不再手打路径 ——
 * Windows 上路径里的反斜杠、盘符、大小写变体都容易打错,
 * 而打错的后果是 agent 在错误的目录里跑(可能在应用自己的目录里乱改文件)。
 *
 * ## 两层目录
 *
 * 画布有一个**项目文件夹**(整个项目就这一个),节点默认都在它里面跑;
 * 单个节点可以覆盖成别的目录。所以这里要同时说清两件事:
 * 「你现在跟随的是哪个目录」和「怎么单独改掉」。
 * 只显示一个空输入框的话,用户会以为还没配好,于是给每个节点各选一次同一个目录。
 */
export function CwdPicker({
  value,
  fallback,
  onChange,
  disabled,
}: {
  /** 这个节点**自己**的目录。空串 = 跟随项目文件夹 */
  value: string
  /** 画布的项目文件夹。没设节点覆盖时实际用的就是它 */
  fallback: string
  onChange: (next: string) => void
  disabled?: boolean
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const pick = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      // 打开位置:优先从当前生效的目录开始,省得每次从「我的电脑」翻
      const startedAt = value || fallback
      const picked = unwrap(
        await window.api.dialog.pickDirectory('选择这个节点的工作目录', startedAt || undefined),
      )
      if (picked) onChange(picked)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const inherited = !value && !!fallback

  return (
    <div className="cwd-picker">
      <div
        className={`cwd-value ${value || fallback ? '' : 'unset'}`}
        title={value || fallback || '应用自带的空目录(workspaces),不会碰你的项目'}
      >
        {value || fallback || '沙箱目录(应用自带)'}
      </div>

      <button onClick={() => void pick()} disabled={disabled || busy}>
        {busy ? '选择中…' : value ? '换目录…' : '单独指定…'}
      </button>

      {/* 有覆盖才谈得上「取消覆盖」;跟着项目走的时候显示它只会让人困惑 */}
      {value && (
        <button
          className="mini"
          title="取消单独指定,改为跟随画布的项目文件夹"
          disabled={disabled}
          onClick={() => onChange('')}
        >
          跟随项目
        </button>
      )}

      {value && (
        <button
          className="mini"
          title="在资源管理器里打开这个目录"
          onClick={() => void window.api.shell.openPath(value)}
        >
          打开
        </button>
      )}

      {inherited && <div className="fhint">跟随画布的项目文件夹</div>}
      {!value && !fallback && (
        <div className="fhint">没指定就跑在沙箱里,不会碰你的项目</div>
      )}
      {err && <div className="fhint err">{err}</div>}
    </div>
  )
}
