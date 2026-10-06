import type { JSX } from 'react'
import { useGraphStore, useResolvedProjectDir } from '../../stores/graphStore'
import { DEFAULT_MERGE_TEMPLATE } from '../../../../shared/workflow'
import { AgentCommonFields, DeleteRow, TitleField } from './NodeConfigPanel'

/**
 * 整合节点(merge)的配置面板。
 *
 * 与功能节点的差别:它的模板是**合并指令**,默认值 = DEFAULT_MERGE_TEMPLATE
 * (留空时调度器用的就是它)。
 *
 * ⚠️ 占位文案不再手抄默认指令 —— **直接从常量里取首行**。
 * 这里原来写的是"阅读以下各支路的成果,把它们整合进项目 {{projectDir}}…",
 * 与调度器用的那份对着抄的:默认指令一改,面板就开始撒谎,而且没人会发现
 * (面板在渲染进程、常量在主进程链路里,两边没有任何机械约束)。
 * 现在首行是真的从 `shared/workflow.ts` 那份常量里切出来的,漂不了。
 *
 * 面板上还必须写清它的**唯一职责**:让串行支路与并行支路的改动互相兼容。
 * 这两类上游的处理方式相反(串行的改动已经在项目里,并行的可能已被覆盖),
 * 用户不知道这一点的话,搭出来的图会在整合那一步反复出问题。
 */
export function MergeConfig({ nodeId }: { nodeId: string }): JSX.Element | null {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId))
  const { dir: projectDir } = useResolvedProjectDir()

  if (!node) return null

  // 默认指令的首行就是这个节点的职责说明 —— 直接复用,不另写一句
  const tplHead = (DEFAULT_MERGE_TEMPLATE.split('\n')[0] ?? '').trim()

  return (
    <div className="node-config">
      <TitleField nodeId={nodeId} value={node.data.title} />

      <div className="fhint">
        唯一职责:让各支路的改动<b>互相兼容</b>,合成一个能一起工作的程序。
        <br />
        <b>串行支路</b>的改动已经在项目里(别重复落实);<b>并行支路</b>各改各的、
        改动可能互相覆盖 —— 那才是它要收敛的部分。
      </div>

      <AgentCommonFields
        nodeId={nodeId}
        agentId={node.data.agentId}
        model={node.data.model}
        permissionMode={node.data.permissionMode}
        promptTemplate={node.data.promptTemplate}
        failurePolicy={node.data.failurePolicy}
        retry={node.data.retry}
        cwd={projectDir}
        cwdMode="readonly"
        tplLabel="合并指令模板"
        tplPlaceholder={`留空 = 用默认合并指令:\n${'—'}\n${tplHead}\n\n(完整指令见 shared/workflow.ts 的 DEFAULT_MERGE_TEMPLATE)`}
      />

      <DeleteRow nodeId={nodeId} />
    </div>
  )
}
