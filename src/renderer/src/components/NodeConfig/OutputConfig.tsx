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
        <span>打包目标</span>
        <select
          value={target}
          onChange={(e) => patchConfig(nodeId, { buildTarget: e.target.value as BuildTarget })}
        >
          <option value="exe">Windows 应用 (.exe)</option>
          <option value="web">Web 静态站点 (.zip,手机/网页可用)</option>
          <option value="apk">Android 应用 (.apk)</option>
          {/* v0.4.1:Godot 项目是文件夹即项目 → zip 交付 */}
          <option value="game">Godot 游戏项目 (.zip)</option>
        </select>
      </label>
      <div className="fhint">
        <b>目标说明</b>
        <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
          <li>
            <b>exe</b>:软件节点需产出 <b>Electron 应用</b>(项目里有 <code>package.json + main.js +
            index.html</code>),内置 electron-builder 打成可执行 exe。
          </li>
          <li>
            <b>web</b>:软件节点产出带 <code>index.html</code> 的 Web 应用,打包器先跑构建脚本,再把静态产物
            打成 zip —— 解压即可部署到任意静态托管 / 手机浏览器打开。
          </li>
          <li>
            <b>apk</b>:本机有 Android SDK 时经 Capacitor + Gradle 真打 <code>.apk</code>;没有 SDK 时自动
            降级为 Web 应用包(PWA),不空手失败。
          </li>
          <li>
            <b>game</b>:游戏节点产出的 Godot 项目打成 zip,用 Godot 4.x 打开即可运行(可进一步导出 exe / apk)。
          </li>
        </ul>
      </div>

      <label className="cfglabel">
        <span>应用名</span>
        <input
          value={opts.appName ?? ''}
          placeholder="留空 = 用项目里的名称"
          onChange={(e) => patchOptions({ appName: e.target.value })}
        />
      </label>

      <label className="cfglabel">
        <span>版本号</span>
        <input
          value={opts.version ?? ''}
          placeholder="留空 = 用项目里的版本"
          onChange={(e) => patchOptions({ version: e.target.value })}
        />
      </label>

      {target === 'apk' && (
        <label className="cfglabel">
          <span>Android 包名</span>
          <input
            value={opts.appId ?? ''}
            placeholder="如 com.yourname.app(默认 com.chusiz.app)"
            onChange={(e) => patchOptions({ appId: e.target.value })}
          />
        </label>
      )}

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
