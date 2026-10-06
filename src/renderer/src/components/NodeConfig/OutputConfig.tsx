import { useState, type JSX } from 'react'
import { unwrap } from '../../lib/unwrap'
import { useGraphStore } from '../../stores/graphStore'
import { DeleteRow, TitleField } from './NodeConfigPanel'
import type { BuildOptions, BuildTarget } from '../../../../shared/canvas'

/**
 * 输出节点(output)的配置面板 —— **内置动作节点**,与 Agent 类显著不同。
 *
 * ⚠️ 本面板**绝不出现** Agent / 权限模式 / Prompt 模板 / 上游失败策略 / 重试
 * 等字段(PRD §4.2 的硬性要求)。输出节点不走会话,那些字段对它没有意义;
 * 显示了反而让人以为"改了重试打包会自动重试"。
 */
export function OutputConfig({ nodeId }: { nodeId: string }): JSX.Element | null {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId))
  const patchConfig = useGraphStore((s) => s.patchConfig)
  const [busy, setBusy] = useState(false)

  if (!node) return null
  const opts: BuildOptions = node.data.buildOptions ?? {}
  const target = node.data.buildTarget ?? 'exe'

  const patchOptions = (patch: Partial<BuildOptions>): void => {
    patchConfig(nodeId, { buildOptions: { ...opts, ...patch } })
  }

  const pickOutDir = async (): Promise<void> => {
    setBusy(true)
    try {
      const picked = unwrap(
        await window.api.dialog.pickDirectory('选择产物输出目录', opts.outDir || undefined),
      )
      if (picked) patchOptions({ outDir: picked })
    } finally {
      setBusy(false)
    }
  }

  const pickIcon = async (): Promise<void> => {
    setBusy(true)
    try {
      const picked = unwrap(await window.api.dialog.pickFile('选择应用图标(.ico)'))
      if (picked) patchOptions({ icon: picked })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="node-config">
      <div className="fhint warn">
        <b>内置打包能力 · 不启动 AI 会话 · 不消耗 token。</b>
        打包由主进程直接执行(electron-builder 链路),失败不自动重试。
      </div>

      <TitleField nodeId={nodeId} value={node.data.title} />

      <label className="cfglabel">
        <span>打包方式</span>
        <select
          value={target}
          onChange={(e) => patchConfig(nodeId, { buildTarget: e.target.value as BuildTarget })}
        >
          <option value="exe">Windows 应用 (.exe)</option>
          {/* P1 链路:Android 需要完整工具链,Web 需要封装层 —— 先如实灰置 */}
          <option value="apk" disabled title="即将支持(P1):需要 Android SDK / Gradle 工具链">
            Android 应用 (.apk) — 即将支持
          </option>
          <option value="web" disabled title="即将支持(P1):静态站点打包">
            Web 静态站点 — 即将支持
          </option>
          {/* v0.4.1:Godot 项目是文件夹即项目 → zip 交付 */}
          <option value="game">Godot 游戏项目 (.zip)</option>
        </select>
      </label>
      <div className="fhint">
        <b>选 exe 时</b>:软件节点需产出 <b>Electron 应用</b>(项目里有{' '}
        <code>package.json + main.js + index.html</code>),打包器自动用内置 electron-builder 打成
        可执行 exe(便携单文件 / 安装包由项目 build.win.target 决定)。建议在软件节点 prompt 里写清:
        "生成一个可直接打包成 Windows exe 的 Electron 应用,包含 package.json / main.js / index.html,
        界面引用项目 assets 下的图片素材"。参考教程见《Electron 应用打包指南》。
      </div>

      <label className="cfglabel">
        <span>应用名</span>
        <input
          value={opts.appName ?? ''}
          placeholder="留空 = 用项目 package.json 里的名称"
          onChange={(e) => patchOptions({ appName: e.target.value })}
        />
      </label>

      <label className="cfglabel">
        <span>版本号</span>
        <input
          value={opts.version ?? ''}
          placeholder="留空 = 用项目 package.json 里的版本"
          onChange={(e) => patchOptions({ version: e.target.value })}
        />
      </label>

      <div className="cfglabel col">
        <span>输出目录</span>
        <div className="cwd-picker">
          <div className={`cwd-value ${opts.outDir ? '' : 'unset'}`} title={opts.outDir || '默认:项目文件夹\\dist'}>
            {busy && !opts.outDir ? '选择中…' : opts.outDir || '默认:项目文件夹\\dist'}
          </div>
          <button onClick={() => void pickOutDir()} disabled={busy}>
            {opts.outDir ? '换目录…' : '选择目录…'}
          </button>
        </div>
      </div>

      <div className="cfglabel col">
        <span>应用图标</span>
        <div className="cwd-picker">
          <div className={`cwd-value ${opts.icon ? '' : 'unset'}`} title={opts.icon || '默认:项目自己的配置'}>
            {opts.icon || '默认(项目自带)'}
          </div>
          <button onClick={() => void pickIcon()} disabled={busy}>
            {opts.icon ? '换图标…' : '选择 .ico…'}
          </button>
        </div>
      </div>

      <label className="cfglabel">
        <span>
          <input
            type="checkbox"
            checked={opts.compress ?? false}
            onChange={(e) => patchOptions({ compress: e.target.checked })}
          />{' '}
          压缩(asar)
        </span>
      </label>

      <label className="cfglabel col">
        <span>打包命令(高级)</span>
        <input
          value={opts.customCommand ?? ''}
          placeholder="留空 = 内置 electron-builder 默认链路"
          disabled
          title="P0 灰置,归 P1:自定义命令覆盖"
        />
        <div className="fhint">P0 暂不支持自定义命令,一律走内置 electron-builder 链路。</div>
      </label>

      <DeleteRow nodeId={nodeId} />
    </div>
  )
}
