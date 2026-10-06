import { useState, type JSX } from 'react'
import { unwrap } from '../../lib/unwrap'
import { useGraphStore, useResolvedProjectDir } from '../../stores/graphStore'
import { useRuntimeStore } from '../../stores/runtimeStore'
import { Icon } from '../Icons'
import {
  AgentCommonFields,
  DeleteRow,
  TitleField,
} from './NodeConfigPanel'

/**
 * 项目节点(project)的配置面板。
 *
 * 核心是**项目文件夹选择器(必填)**:v2 起它是整张画布项目文件夹的
 * 唯一权威来源 —— 写的是节点自身的 projectDir 字段,不再是画布级 projectDir
 * (那个已 deprecated,只在没有任何项目节点的旧画布上兜底)。
 */
export function ProjectConfig({ nodeId }: { nodeId: string }): JSX.Element | null {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId))
  const patchConfig = useGraphStore((s) => s.patchConfig)
  const running = useRuntimeStore((s) => s.runtimes[nodeId]?.status === 'running')
  const { dir: resolvedDir, source } = useResolvedProjectDir()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  if (!node) return null

  const pick = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      const picked = unwrap(
        await window.api.dialog.pickDirectory(
          '选择项目文件夹(整张画布的权威目录)',
          node.data.projectDir || resolvedDir || undefined,
        ),
      )
      if (picked) patchConfig(nodeId, { projectDir: picked })
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const dir = node.data.projectDir || ''

  return (
    <div className="node-config">
      <TitleField nodeId={nodeId} value={node.data.title} />

      <div className="cfglabel col">
        <span>项目文件夹(必填 · 权威来源)</span>
        <div className="cwd-picker">
          <div
            className={`cwd-value ${dir ? '' : 'unset'}`}
            title={dir || '还没选择项目文件夹 —— 下游节点将跑在画布沙箱里'}
          >
            {busy ? '选择中…' : dir || '未选择'}
          </div>
          <button onClick={() => void pick()} disabled={busy}>
            {dir ? '换目录…' : '选择文件夹…'}
          </button>
          {dir && (
            <button
              className="mini"
              title="在资源管理器里打开这个目录"
              onClick={() => void window.api.shell.openPath(dir)}
            >
              打开
            </button>
          )}
        </div>
        {err && <div className="fhint err">{err}</div>}
        {/*
          画布级 projectDir 的去向要如实告诉用户(Q1 决策):它 deprecated 了,
          但老画布没有项目节点时仍由它兜底 —— 隐瞒兜底来源的话,
          "界面显示 A 目录、agent 跑在 B 目录"的怀疑就没有排入口。
        */}
        <div className="fhint">
          这是整张画布的项目文件夹权威来源:串行 / 并行 / 整合 / 输出节点都在这里干活。
          {source === 'canvas' && (
            <>
              {' '}
              <Icon name="alert" size={12} />
              当前画布没有项目节点,正在用画布级 projectDir 兜底(deprecated)。
            </>
          )}
        </div>
      </div>

      <label className="cfglabel col">
        <span>项目说明(可选)</span>
        <textarea
          rows={3}
          value={node.data.brief ?? ''}
          placeholder={'这个项目是做什么的?会作为起点上下文交给下游节点'}
          onChange={(e) => patchConfig(nodeId, { brief: e.target.value })}
          spellCheck={false}
        />
      </label>

      <AgentCommonFields
        nodeId={nodeId}
        agentId={node.data.agentId}
        model={node.data.model}
        permissionMode={node.data.permissionMode}
        promptTemplate={node.data.promptTemplate}
        failurePolicy={node.data.failurePolicy}
        retry={node.data.retry}
        // project 节点的生效目录就是它自己的 projectDir(留空回落画布级)
        cwd={dir || resolvedDir}
        cwdMode="picker"
        tplPlaceholder={'留空 = 把运行输入直接当提示词\n项目节点是流水线源头,通常不需要模板'}
      />

      {/* project 节点仍会跑一轮 agent 会话(起点上下文),所以保留 sessionId */}
      <DeleteRow nodeId={nodeId} />
      {running && <div className="fhint">运行中:字段修改保存后,下一轮会话生效</div>}
    </div>
  )
}
