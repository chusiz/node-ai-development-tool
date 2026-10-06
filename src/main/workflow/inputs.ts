import { writeBlob } from '../persist/blob'
import type { SpillPolicy, WorkflowNodeSpec } from '../../shared/workflow'

/**
 * 把上游产出注入下游的 prompt。
 *
 * 这一层存在的唯一理由是**别让一个巨大的产出把 prompt 撑爆**:
 * `argv` 模式下 Windows 的硬上限是 32767 字符,超了直接启动失败;
 * stdin 模式虽然没这个限制,但几十 MB 的 prompt 也会让首字延迟变得无法忍受。
 */

export interface SpillContext {
  canvasId: string
  inlineLimitBytes: number
  policy: SpillPolicy
}

/** 溢出后的注入文本:路径 + 规模 + 预览 + 怎么取全文 */
export function spillNotice(file: string, chars: number, previewChars: number, head: string): string {
  return [
    `[上游产出过大,已落盘:${file}]`,
    `完整内容 ${chars} 字符,下面只内联前 ${previewChars} 字符。`,
    `需要全文请用 Read 工具读上面那个路径。`,
    '--- 预览开始 ---',
    head,
    '--- 预览结束 ---',
  ].join('\n')
}

/**
 * 单个上游产出 → 注入文本。
 *
 * `truncate` 与 `file` 的区别很重要:前者不依赖任何工具能力(纯文本 CLI 也能用),
 * 后者要求下游有 Read 工具。所以对 `promptMode: 'argv*'` 的自定义 CLI,
 * 图校验阶段就该把策略强制降为 truncate —— argv 模式下它连工具调用的机会都没有。
 */
export async function injectOne(
  ctx: SpillContext,
  text: string,
): Promise<{ text: string; spilled: boolean; file?: string }> {
  if (text.length <= ctx.inlineLimitBytes) return { text, spilled: false }

  if (ctx.policy === 'fail') {
    throw new Error(
      `上游产出 ${text.length} 字符,超过内联上限 ${ctx.inlineLimitBytes},且策略要求失败`,
    )
  }
  if (ctx.policy === 'truncate') {
    return {
      text: `${text.slice(0, ctx.inlineLimitBytes)}\n… (已截断,原长 ${text.length} 字符)`,
      spilled: true,
    }
  }

  const ref = await writeBlob(ctx.canvasId, text)
  const previewChars = 2000
  return {
    text: spillNotice(ref.file, ref.bytes, previewChars, text.slice(0, previewChars)),
    spilled: true,
    file: ref.file,
  }
}

/**
 * 拼出这个节点的模板变量表。
 *
 * | 变量 | 含义 |
 * |---|---|
 * | `{{input}}` | 所有直接前驱产出拼接,再加用户这次手填的输入 |
 * | `{{prev}}`  | 直接前驱产出(多个时按连线顺序拼接) |
 * | `{{node:<id>}}` / `{{title:<id>}}` | 指哪个取哪个 |
 * | `{{projectDir}}` | 项目文件夹(整合节点默认模板用它) |
 */
export function buildVars(args: {
  spec: WorkflowNodeSpec
  nodeById: Map<string, WorkflowNodeSpec>
  /**
   * 直接前驱,**按边声明的顺序**。
   *
   * ⚠️ 上游过滤(并行跳过 feature)**不在这里做** —— runner 已经按目标节点的
   * kind/mode 过滤完才递进来。保持"给我哪些 preds 就拼哪些"的单纯语义:
   * 若把过滤也搬进来,buildVars 就得懂调度语义,两处各懂一半迟早漂。
   */
  preds: string[]
  /**
   * 每个**已完成祖先**的产出注入文本(已过 spill 处理)。
   * 不只放直接前驱 —— `{{node:<id>}}` 允许下游跳过中间节点直接引用更远的祖先。
   * 这也是并行支路的显式引用(M2)仍然可用的原因:过滤只作用于自动注入的 preds,
   * 这里放的还是全量祖先。
   */
  injected: Map<string, string>
  userInput: string
  /** 项目文件夹。填 {{projectDir}} 变量(整合节点默认模板要用) */
  projectDir?: string
}): Record<string, string> {
  const { spec, nodeById, preds, injected, userInput, projectDir } = args

  // 直接前驱产出。多个前驱时带上标题做分隔,否则下游分不清哪段是谁说的
  const prevParts: string[] = []
  for (const id of preds) {
    const text = injected.get(id)
    if (text === undefined || text === '') continue
    if (preds.length > 1) {
      const title = nodeById.get(id)?.title ?? id
      prevParts.push(`## 来自「${title}」\n${text}`)
    } else {
      prevParts.push(text)
    }
  }
  const prev = prevParts.join('\n\n')

  const vars: Record<string, string> = {
    prev,
    // {{input}} = 上游产出 + 用户这次手填的。手填的放后面,读起来像"基于这些,再要求…"
    input: [prev, userInput].filter(Boolean).join('\n\n'),
    // {{projectDir}}:给整合节点默认模板用。空 = 用户没指定(渲染成空串,模板里的句子依然通顺)
    projectDir: projectDir ?? '',
  }

  // 显式点名引用:允许下游跳过直接前驱去取任意祖先的产出
  for (const [id, text] of injected) {
    vars[`node:${id}`] = text
    vars[`title:${id}`] = nodeById.get(id)?.title ?? id
  }
  // 标题变量对所有节点都可用,不限于有产出的
  for (const [id, s] of nodeById) vars[`title:${id}`] ??= s.title

  return vars
}
