import { useGraphStore } from '../stores/graphStore'
import { useRuntimeStore } from '../stores/runtimeStore'
import { useUiStore } from '../stores/uiStore'

/**
 * 删除一个节点 —— 画布上的 ×、顶栏「删除选中」、键盘 Delete 三条入口共用这一份。
 *
 * 抽出来的理由很简单:确认框里的那句话必须**三处一模一样**。
 * 只说「确定删除吗?」等于没问 —— 用户既不知道线会不会一起没,也不知道
 * 跑着的进程会怎么样。复制三份的话,迟早有一处漏掉"会先中断运行"这半句。
 *
 * 返回是否真的删掉了。调用方通常不需要用返回值,但"没删"和"删了"
 * 在自动化测试里是两件事,所以留出来。
 */
export async function deleteNodeWithConfirm(id: string): Promise<boolean> {
  const n = useGraphStore.getState().nodes.find((x) => x.id === id)
  if (!n) return false

  const running = useRuntimeStore.getState().runtimes[id]?.status === 'running'
  const msg =
    `删除「${n.data.title}」?\n\n` +
    (running ? '它正在运行,会先被中断。\n' : '') +
    '与它相连的线会一起删掉。磁盘上的历史日志会保留。'
  if (!window.confirm(msg)) return false

  // 先中断再摘节点 —— 反过来会让进程继续往一个已经不存在的节点里写日志
  if (running) await window.api.session.cancel(id)
  useGraphStore.getState().removeNode(id)
  if (useUiStore.getState().selectedNodeId === id) useUiStore.getState().select(null)
  return true
}
