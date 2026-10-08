import { type JSX } from 'react'
import { NodeShell, type ShellNodeProps } from './NodeShell'

/**
 * Python 节点(python)—— **内置动作节点**(v0.6.4 多语言节点):
 * 子进程跑脚本,stdout 交给下游。1 入 1 出,不启动 AI 会话、不消耗 token。
 * 复用 NodeShell 外壳(与 image/output 同族),正文行显示最近一次 stdout。
 */
function PythonNodeInner({ id, selected }: ShellNodeProps): JSX.Element {
  return (
    <NodeShell
      id={id}
      selected={selected}
      badge={{ icon: 'python', text: 'Python', cls: 'kind-python', title: 'Python 节点:子进程跑脚本,stdout 交给下游' }}
      hasTargetHandle
      hasSourceHandle
      kindClass="kind-python"
    />
  )
}

export const PythonNode = PythonNodeInner
