/*
 * 画布撤销/重做的**纯历史栈** —— shared 层,零依赖(不碰 React / Electron),
 * 渲染端 graphStore 与 e2e 共用同一份实现(测的就是跑在应用里的那份)。
 *
 * ## 为什么是「存改动之前」而不是「存改动之后」
 *
 * 撤销语义最直观的实现:每次改动前把旧状态拍快照压进 undo 栈。
 * 恢复时把**当前**状态压进 redo 栈、弹出 undo 的栈顶。两边对称,
 * 不需要"初始化哨兵"(存改后方案的 undo 栈底必须垫一份初始状态,漏垫就退不动)。
 *
 * ## 序列化由调用方给
 *
 * 快照相等性比较需要序列化(JSON),而快照的类型(T)由 graphStore 决定
 * (React Flow 节点,不该出现在 shared 的 import 里)。构造时注入,
 * 本类对 T 一无所知 —— 它只是个"带去重的双栈"。
 *
 * ## 两条去重(都在 push 里)
 *
 *   ① before === after(这次改动没产生实际变化,比如把配置改成原值)不记 ——
 *      否则撤销一步等于没动,用户要连按好几次才回得去;
 *   ② before === 栈顶(连续两次一样的状态)不追加 —— 上一次已经记过同一份了。
 */

export class HistoryStack<T> {
  private undoStack: T[] = []
  private redoStack: T[] = []

  constructor(
    private readonly serialize: (v: T) => string,
    private readonly limit = 50,
  ) {}

  /** 记一条历史:把「改动之前」的快照压进 undo 栈,并清空 redo(新改动让重做失效) */
  push(before: T, after: T): void {
    const s = this.serialize
    if (s(before) === s(after)) return
    const top = this.undoStack[this.undoStack.length - 1]
    if (top !== undefined && s(top) === s(before)) return
    this.undoStack.push(before)
    if (this.undoStack.length > this.limit) this.undoStack.shift()
    this.redoStack = []
  }

  /**
   * 撤销:弹出 undo 栈顶作为恢复目标,把当前状态压进 redo。
   * 没有可撤销的返回 null(调用方保持现状)。
   */
  undoPop(current: T): T | null {
    const entry = this.undoStack.pop()
    if (entry === undefined) return null
    this.redoStack.push(current)
    if (this.redoStack.length > this.limit) this.redoStack.shift()
    return entry
  }

  /** 重做:镜像的镜像。没有可重做的返回 null */
  redoPop(current: T): T | null {
    const entry = this.redoStack.pop()
    if (entry === undefined) return null
    this.undoStack.push(current)
    if (this.undoStack.length > this.limit) this.undoStack.shift()
    return entry
  }

  /** 换画布 / 载入新图:历史属于那张图,不跟着走 */
  clear(): void {
    this.undoStack = []
    this.redoStack = []
  }

  get undoDepth(): number {
    return this.undoStack.length
  }

  get redoDepth(): number {
    return this.redoStack.length
  }
}
