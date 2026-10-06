import type { BuiltinActionRequest, BuiltinActionResult } from '../workflow/builtinAction'

/**
 * 内置动作执行器注册表。
 *
 * 镜像现有 `../agents/registry.ts`(注释写着"加第二个 CLI 只需新增一个适配器目录
 * 并 registerAdapter(),核心代码零改动")的做法:
 *
 *   - `output` → `packager`(已有 Packager,原样搬进来注册)
 *   - `image`(新)→ `imagegen` 执行器
 *
 * 于是"两类执行器(会话 / 内置动作)"与"多个内置动作(package / image / 未来
 * video…)"都被注册表吸收:加视频节点 = 加一个 action 执行器 + 注册表一条声明,
 * `runner` 一行不改(`runNode` 顶部只看 `executor==='builtin'`,再按 `def.action`
 * 把请求递给 `runBuiltinAction`)。
 *
 * ⚠️ 这是**主进程**的注册表,不在 shared —— 执行器实现层会拖进 child_process / fs,
 * 只能活在主进程。渲染端与 shared 都不该看见它。
 */
export interface BuiltinActionExecutor {
  run(req: BuiltinActionRequest): Promise<BuiltinActionResult>
  /** 有子进程 / 可中断请求的执行器才实现。返回是否真有在跑的(幂等无副作用) */
  cancel?(nodeId: string): boolean
  /** 退出清场 */
  killAll?(): void
}

const actions = new Map<string, BuiltinActionExecutor>()

/**
 * 加一个内置动作(视频/音频/…)只需新增执行器目录并在这里 register,
 * 核心代码零改动。重复注册同名 action 会覆盖 —— 允许测试里替换实现。
 */
export function registerBuiltinAction(action: string, exec: BuiltinActionExecutor): void {
  actions.set(action, exec)
}

/**
 * 取执行器。未注册是**编程错误**(注册表与注册表声明不同步),故直接抛。
 *
 * ⚠️ 动作名为空时必须**显式写出"(空)"**。
 * 嵌套子图超过 `MAX_SUBGRAPH_DEPTH` 没能完全展开时,残留的子图节点会走到这里 ——
 * 而 `subgraph` 的 `NodeTypeDef` 刻意没有 `action` 字段(它是占位执行器,
 * 永远不该活着见到 runner)。于是一个**结构完全正常、只是嵌套太深**的子图,
 * 报出来的是"未注册的内置动作:"后面什么都没有,用户对着一个他从没配过
 * "内置动作"的东西完全不知道该做什么 —— 真实原因一个字都没提。
 * 补上这一句至少让"动作名是空的"这件事本身可见。
 */
export function getBuiltinAction(action: string): BuiltinActionExecutor {
  const a = actions.get(action)
  if (!a) throw new Error(`未注册的内置动作: ${action || '(空 —— 多半是子图嵌套过深,没完全展开)'}`)
  return a
}

/**
 * 取消:遍历所有执行器,谁命中谁说了算。
 *
 * 与 v2 `manager.cancel(id) || packager.cancel(id)` 同一语义,只是不再点名 packager
 * —— 加一个内置动作不用回来改这里。一个节点同一时刻只可能在跑其中一类,所以
 * 无脑串是安全的。
 */
export function cancelBuiltin(nodeId: string): boolean {
  for (const a of actions.values()) if (a.cancel?.(nodeId)) return true
  return false
}

/** 退出清场:杀掉全部内置动作子进程。由 before-quit / settingsRelaunch 调用 */
export function killAllBuiltin(): void {
  for (const a of actions.values()) a.killAll?.()
}

/** 仅测试用:清空注册表(避免跨用例互相污染) */
export function __resetBuiltinActions(): void {
  actions.clear()
}
