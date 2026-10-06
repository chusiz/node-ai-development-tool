import fs from 'node:fs'
import type { StartRequest, StartResult } from '../shared/ipc'
import type { SessionManager } from './agents/manager'
import type { NodeLogHub } from './persist/hub'
import { canvasWorkspace, ensureCanvasWorkspace } from './paths'

/**
 * 算出这个节点**会用**哪个目录,但**不碰磁盘**。
 *
 * 和 `resolveStartCwd` 分开是为了给流水线用:下游节点的开场白里要写
 * 「项目文件夹是 X,上游可能已经改过文件了,自己去看」—— 那句话在
 * **拼 prompt 的时候**就要有,而那时还不到 spawn,不该顺手建目录。
 *
 * 两处必须用同一个判断。分开写两份的话,「选项目文件夹」这条路上的
 * 节点和流水线里的节点就可能得出两个不同的答案 —— 而当这两处不一致时,
 * 表现是提示词里报的目录和 agent 实际所在的目录不是一个地方,
 * 那是最难查的一类 bug(它什么都不报,只是行为微妙地不对)。
 */
export function plannedCwd(canvasId: string, requested: string | undefined): string {
  const asked = (requested ?? '').trim()
  return asked || canvasWorkspace(canvasId)
}

/**
 * 这一轮 agent 到底在哪个目录里跑。
 *
 * 规则两条,都不能省:
 *
 * ① **明确指定了目录 → 用它,但它必须真实存在。**
 *    不校验的话,一个手改坏了的路径会让 spawn 抛一条只提 exe 名字的 ENOENT,
 *    报错里看不到那个写错的目录,查起来很费劲。
 *
 * ② **没指定 → 落到这个画布自己的沙箱**(`workspaces/<canvasId>`),
 *    **绝不落到应用自己的目录。**
 *
 * 第 ② 条是安全边界:agent 默认权限是 acceptEdits,在 `D:\haowan` 下起来
 * 就等于拿到了这个项目的源码写权限。上一版为了堵这个洞,**直接抛错**要求
 * "必须先选项目文件夹"—— 洞是堵上了,可最基本的功能也一起堵死了:
 * 想随便跟 AI 说句话,得先编一个项目目录出来。用户的原话是
 * 「我还是需要调用ai,你现在直接没法给ai对话了」。
 *
 * 沙箱才是对的做法:照常能聊,而 agent 的落脚点是一个空的、跟源码无关的目录。
 * 真正要改项目时,用户再指定项目文件夹 —— 那是**功能**,不是准入门槛。
 */
export function resolveStartCwd(canvasId: string, requested: string | undefined): string {
  const asked = (requested ?? '').trim()

  // 走沙箱这一支:目录是我们自己造的,不存在是正常的(第一次跑),
  // 建出来就行。拿存在性去卡它反而会在第一次运行时误报。
  if (!asked) return ensureCanvasWorkspace(canvasId)

  // 用户指定了这一支:路径同样经 plannedCwd 算(不是直接拿 asked),
  // 保证"提示词里写的目录"和"agent 实际所在的目录"永远是同一个字符串
  const dir = plannedCwd(canvasId, asked)
  let ok = false
  try {
    ok = fs.statSync(dir).isDirectory()
  } catch {
    ok = false
  }
  if (!ok) throw new Error(`这个目录不存在或不是文件夹:${dir}`)
  return dir
}

/**
 * 启动一轮会话的**唯一入口**。
 *
 * 界面上点「发送」和工作流调度器启动一个节点,必须走同一条路径 ——
 * 否则两条路会漂:一边登记了画布归属、落了用户消息、更新了轮数,
 * 另一边直接 spawn,日志里就没有那句 prompt,刷新后历史也少一轮。
 *
 * `resolveStartCwd` 也必须放在这里,理由同上:它是两条路唯一的共同点。
 * 只挂在渲染进程那条路上的话,工作流调度的节点就绕过去了 ——
 * 那正是上面第 ② 条要防的事(没配目录的节点在应用源码目录里跑起来)。
 *
 * ⚠️ 顺序:先登记画布归属并**等用户消息落盘广播完**,再 spawn。
 * 反过来的话,agent 的头几条事件会先于用户那句话出现在日志里,
 * seq 顺序和界面顺序就都对不上了。
 */
export async function startSession(
  hub: NodeLogHub,
  manager: SessionManager,
  req: StartRequest,
): Promise<StartResult> {
  // 解析出来的目录必须**同时**用于登记和 spawn:只改一边的话,
  // meta.json 里写的目录和 agent 实际所在的目录就不是同一个了
  const cwd = resolveStartCwd(req.canvasId, req.cwd)

  hub.register(req.nodeId, req.canvasId, {
    nodeId: req.nodeId,
    agentId: req.agentId ?? 'claude',
    cwd,
    sessionId: req.sessionId ?? null,
    isFirstTurn: !req.sessionId,
    turns: 0,
    status: 'running',
    model: null,
    lastCostUsd: null,
    lastDurationMs: null,
  })
  await hub.appendUser(req.nodeId, req.prompt)
  return manager.start({ ...req, cwd })
}
