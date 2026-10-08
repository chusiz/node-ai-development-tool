import { type JSX } from 'react'
import { useGraphStore, useResolvedProjectDir } from '../../stores/graphStore'
import { DeleteRow, TitleField } from './NodeConfigPanel'
import { Icon } from '../Icons'
import type { PythonParams } from '../../../../shared/canvas'

/**
 * Python 节点(python)的配置面板(v0.6.4 多语言节点):
 * 子进程跑一段 Python 脚本,stdout 交给下游 —— 复用 AI/ML 生态,不消耗 token。
 */
export function PythonConfig({ nodeId }: { nodeId: string }): JSX.Element | null {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId))
  const { dir: projectDir } = useResolvedProjectDir()
  if (!node) return null

  const p: PythonParams = node.data.pythonParams ?? { script: '' }
  const patch = (x: Partial<PythonParams>) =>
    useGraphStore.getState().patchConfig(nodeId, { pythonParams: { ...p, ...x } })

  return (
    <div className="node-config">
      <TitleField nodeId={nodeId} value={node.data.title} />

      <div className="fhint">
        <Icon name="python" size={12} />
        子进程跑 <b>Python 脚本</b>,stdout 交给下游节点。工作目录 = 项目目录(权限最小化:
        脚本只能写项目内文件)。<b>不启动 AI 会话 · 不消耗 token</b>。
      </div>

      <label className="cfglabel col">
        <span>脚本(源码)</span>
        <textarea
          rows={6}
          value={p.script ?? ''}
          placeholder={'print("hello from chusiz")\n# stdout 会交给下游节点'}
          onChange={(e) => patch({ script: e.target.value, scriptPath: '' })}
          className="cfg-textarea mono"
          spellCheck={false}
        />
        <div className="fhint">填了源码就优先用源码;也可以不填源码、只指定下面的 .py 文件。</div>
      </label>

      <label className="cfglabel col">
        <span>脚本文件(相对项目目录)</span>
        <input
          value={p.scriptPath ?? ''}
          placeholder="如 scripts/gen_data.py(源码为空时生效)"
          onChange={(e) => patch({ scriptPath: e.target.value })}
        />
      </label>

      <label className="cfglabel col">
        <span>命令行参数(逐项)</span>
        <input
          value={(p.args ?? []).join(' ')}
          placeholder="空格分隔,如 --size 32"
          onChange={(e) => patch({ args: e.target.value.split(/\s+/).filter(Boolean) })}
        />
        <div className="fhint">参数不做 shell 展开,原样逐项传给脚本。</div>
      </label>

      <label className="cfglabel">
        <span>Python 可执行文件</span>
        <input
          value={p.pythonPath ?? ''}
          placeholder="留空 = 用 PATH 里的 python"
          onChange={(e) => patch({ pythonPath: e.target.value })}
        />
      </label>

      <label className="cfglabel">
        <span>超时(秒)</span>
        <input
          type="number"
          value={p.timeoutSec ?? 300}
          min={5}
          max={3600}
          onChange={(e) => patch({ timeoutSec: Number(e.target.value) })}
        />
      </label>

      {projectDir ? (
        <div className="fhint">脚本会落到 <code>{projectDir}</code> 的 <code>assets/scripts/</code> 下执行。</div>
      ) : (
        <div className="fhint warn">还没有项目目录 —— 先放一个项目节点并指定目录。</div>
      )}

      <DeleteRow nodeId={nodeId} />
    </div>
  )
}
