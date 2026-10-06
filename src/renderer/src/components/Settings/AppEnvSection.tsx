import { useEffect, useState, type JSX } from 'react'
import type { AgentSettings, DetectResult } from '../../types'
import { unwrap } from '../../lib/unwrap'

/**
 * 换一台电脑之后,用户最先撞上的两件事都在这一个分区里:
 *   ① claude 可执行文件在哪(别人机器上装的路径几乎一定不同);
 *   ② 画布和历史数据存哪(我要不要把它跟程序一起拷走)。
 * 所以把这两件事放在一起叫「运行环境」—— 它们回答的是同一个问题:
 * **这台机器上,这东西靠什么跑、东西放哪。**
 */

const INSTALL_CMD = 'npm i -g @anthropic-ai/claude-code'

export function AppEnvSection({
  value,
  onChange,
}: {
  value: AgentSettings
  onChange: (next: AgentSettings) => void
}): JSX.Element {
  const [paths, setPaths] = useState<Record<string, string> | null>(null)
  const [probe, setProbe] = useState<DetectResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        setPaths(unwrap<Record<string, string>>(await window.api.app.paths()))
      } catch {
        /* 路径只是展示,取不到就不显示,不让它挡住设置页 */
      }
    })()
  }, [])

  const detect = async (overridePath?: string): Promise<void> => {
    setBusy(true)
    try {
      setProbe(unwrap<DetectResult>(await window.api.agents.detect('claude', overridePath)))
    } catch (e) {
      setProbe({ found: false, kind: 'cli', message: (e as Error).message, tried: [] })
    } finally {
      setBusy(false)
    }
  }

  const browse = async (): Promise<void> => {
    const picked = unwrap<string | null>(await window.api.dialog.pickFile('选择 claude 可执行文件'))
    if (picked) {
      onChange({ ...value, claudePath: picked })
      // 选完顺手探一次:让用户在点"保存"之前就知道这个路径对不对
      await detect(picked)
    }
  }

  const copyCmd = (): void => {
    void navigator.clipboard.writeText(INSTALL_CMD).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  /*
   * DetectResult 是判别联合:found:true 又分 cli / api 两形态,而这里探的
   * 一定是 claude(CLI)。把它收窄成两个具名量,渲染里就不必再堆 kind 判断。
   * cliFound 有值 = 成功且是 CLI;failMsg 有值 = 失败时的原因文案。
   */
  const cliFound = probe?.found && probe.kind === 'cli' ? probe : null
  const failMsg = probe && !probe.found ? probe.message : null

  return (
    <>
      <h3>Claude CLI</h3>

      <div className="field">
        <div className="fcap">可执行文件路径</div>
        <input
          type="text"
          className="fpath"
          /*
           * 受控空串 = 自动探测。placeholder 把这个语义写出来,
           * 否则用户看到空框会以为"没配好"。
           */
          placeholder="留空 = 自动探测(npm 全局安装位置 / PATH)"
          value={value.claudePath}
          onChange={(e) => onChange({ ...value, claudePath: e.target.value })}
          spellCheck={false}
        />
        <div className="fhint">
          换电脑后如果顶栏显示「未检测到 claude」,先在这里点一次<b>检测</b>;
          还是找不到,就把 npm 全局安装位置下 <code>@anthropic-ai\claude-code\bin\claude.exe</code>
          的完整路径填进来。改动<b>保存后立即生效</b>,不需要重启。
        </div>
        <div className="btnrow">
          <button type="button" onClick={() => void browse()} disabled={busy}>
            浏览…
          </button>
          <button
            type="button"
            onClick={() => void detect(value.claudePath || undefined)}
            disabled={busy}
          >
            {busy ? '检测中…' : '检测'}
          </button>
          <button
            type="button"
            onClick={() => {
              onChange({ ...value, claudePath: '' })
              void detect(undefined)
            }}
            disabled={busy}
          >
            恢复自动
          </button>
        </div>

        {probe && (
          <div className={cliFound ? 'note ok' : 'note err'}>
            {cliFound ? (
              <>
                ✅ 找到 <code>{cliFound.exe}</code>
                {cliFound.version ? ` · ${cliFound.version}` : ''}
                <div className="fhint">来源:{cliFound.source}</div>
              </>
            ) : (
              <>
                ❌ {failMsg ?? '未找到 claude'}
                <div className="fhint">
                  没装 claude 的话,先在命令行执行:
                  <code>{INSTALL_CMD}</code>
                  <button type="button" className="tiny" onClick={copyCmd}>
                    {copied ? '已复制' : '复制'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <h3>数据位置</h3>
      {paths ? (
        <>
          <div className="pathbox" title={paths.projectRoot}>
            {paths.projectRoot}
          </div>
          <div className="fhint">
            当前模式:<b>{paths.rootModeLabel}</b>。
            {paths.portable === '1'
              ? '整个程序文件夹拷到别的电脑,画布和历史会跟着一起走。'
              : '要把它变成"拷走就走"的绿色版,在程序的 exe 同级目录放一个空文件 portable.flag 再启动。'}
            <br />
            画布 / 历史:{paths.dataRoot}
            <br />
            依赖的 CLI 是<b>本机安装</b>的,不会被打进这个包。
          </div>
          <div className="btnrow">
            <button type="button" onClick={() => void window.api.shell.openPath(paths.projectRoot)}>
              打开数据文件夹
            </button>
            <button type="button" onClick={() => void window.api.shell.openPath(paths.settingsFile)}>
              打开设置文件
            </button>
          </div>
        </>
      ) : (
        <div className="note">读取中…</div>
      )}
    </>
  )
}
