import { memo, type JSX } from 'react'
import { useGraphStore, useResolvedProjectDir } from '../stores/graphStore'
import { NODE_TYPES } from '../../../shared/nodeRegistry'
import { NodeShell, type ShellNodeProps } from './NodeShell'

/**
 * 审查节点(review)—— 会话类节点,和 feature 同族,但**只看不改**。
 *
 * 端口:1 入 1 出。它在链上的位置是"质量闸门":上游改完之后由它挑问题,
 * 挑出来的清单再作为产出交给下游(去改、去整合)。
 *
 * 卡片上要一眼看出两件事:
 *   ① 它现在是**只读**还是被放开了写权限 —— "审查节点把代码改了"是
 *      这个类型最危险的失败模式,用户必须能不看配置面板就知道当前状态;
 *   ② 有没有上游 —— 审的对象就是上游,没有上游就等于空转。
 *
 * 徽标取自注册表(`NODE_TYPES.review.badge`),和图像节点同一做法:
 * 类型图标/文案只有一处定义,卡片不会和菜单/面板漂移。
 */
function ReviewNodeInner({ id, selected }: ShellNodeProps): JSX.Element {
  const { dir: projectDir } = useResolvedProjectDir()
  // 只读 = 权限模式是 plan(注册表 normalize 给的默认值)
  const readOnly = useGraphStore(
    (s) => (s.nodes.find((n) => n.id === id)?.data.permissionMode ?? 'plan') === 'plan',
  )
  const inbound = useGraphStore((s) => s.edges.filter((e) => e.target === id).length)

  return (
    <NodeShell
      id={id}
      selected={selected}
      badge={NODE_TYPES.review.badge}
      hasTargetHandle={NODE_TYPES.review.ports.target === 1}
      hasSourceHandle={NODE_TYPES.review.ports.source === 1}
      kindClass="kind-review"
      meta={
        <>
          {projectDir ? (
            <span className="agent-node-cwd" title={projectDir}>
              {projectDir.split(/[\\/]/).filter(Boolean).slice(-2).join('/')}
            </span>
          ) : (
            <span className="agent-node-cwd">跟随项目文件夹(未设置)</span>
          )}
          <span
            className={readOnly ? 'agent-node-brief' : 'node-soft-hint'}
            title={
              readOnly
                ? '只读评审:不改任何文件,产出一份问题清单'
                : '已放开写权限 —— 这个节点现在会改你的代码,不再是纯审查'
            }
          >
            {readOnly ? '只读' : '可写'}
          </span>
          {inbound === 0 && <span className="node-soft-hint">还没有上游</span>}
        </>
      }
    />
  )
}

export const ReviewNode = memo(ReviewNodeInner)
