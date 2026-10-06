/**
 * 打包器内部的类型收口。
 *
 * 请求/结果契约的正身在 `../workflow/builtinAction.ts`(RunnerEnv 要引用它,
 * 而 runner 不许 import packager 实现层)。这里 re-export 给 packager 目录
 * 内部用,让"内置动作"这组类型有一个稳定的别名入口。
 */
export type { BuiltinActionRequest, BuiltinActionResult } from '../workflow/builtinAction'
