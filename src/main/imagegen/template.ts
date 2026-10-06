/**
 * 阶段二占位符展开 —— 图像执行器专用。
 *
 * ## 展开时机(本次要点)
 *
 *   阶段一(调度侧 runner):{{prev}} {{input}} {{node:<id>}} {{title:<id>}} → resolvedPrompt
 *   阶段二(本文件,主进程执行器):
 *     ②-a 先展开 {{env:VAR}}(纯字符串查表,无依赖;D5 缺失 → 报错,不展开为空)
 *     ②-b 后展开 provider 占位符 {{prompt}}/{{promptFile}}/{{outDir}}/{{n}}/{{size}}/{{seed}}
 *
 * 为什么 env 必须先展开:resolvedPrompt 里可能残留 {{env:...}},provider 占位符要把
 * resolvedPrompt 填进去,先做 env 才能兜住。
 *
 * 为什么 {{env:}} 只能在主进程展开:① 环境变量只存在于主进程;② 若在渲染进程展开,
 * 密钥会进渲染进程内存 / 经过 IPC,违背"密钥不进前端"的设计意图。
 */

/**
 * `{{prompt}}` 的字面匹配。
 *
 * ⚠️ 在 `local-command` 的命令模板里**禁用**(命中即硬失败):画面描述来自不可信
 * 输入(上游 agent 产出 / 项目文件内容),把它原样拼进 shell 命令行就是命令注入。
 * 跨平台 shell 转义做不对(Windows 是 cmd.exe,`& | > < ^ %` 与引号嵌套语义与
 * POSIX sh 完全不同,且 %VAR% 的展开发生在解析之后 —— 没有单一正确转义),所以
 * 结论明确:本地命令**默认不接收** {{prompt}}。
 */
export const PROMPT_TOKEN_RE = /\{\{\s*prompt\s*\}\}/

/**
 * JSON 字符串字面量内部的安全转义:去掉 JSON.stringify 结果最外层的引号,
 * 只留转义后的正文。用于把不可信文本嵌入 JSON 字符串(如 `"prompt":"{{prompt}}"`)。
 *
 * 例:`"; echo pwned` → `\"; echo pwned`,嵌进 `"{{prompt}}"` 后仍是合法 JSON,
 * 解析回来字段值 === 原文本(结构未被破坏)。
 */
export function escapeJsonInner(s: string): string {
  return JSON.stringify(s).slice(1, -1)
}

/** 去掉 CR/LF —— 用于 HTTP header 值(防 header 注入)。header 语义不同于 JSON,不做 json 转义 */
export function stripCrlf(s: string): string {
  return s.replace(/[\r\n]+/g, ' ')
}

/**
 * 展开 `{{env:VAR}}`。缺失的变量名收集进 `missing`(由调用方按 D5 报错)。
 *
 * 只认合法环境变量名(`[A-Za-z_][A-Za-z0-9_]*`),避免 `{{env:}}` 里塞进奇怪东西。
 */
export function expandEnv(tpl: string, env: NodeJS.ProcessEnv): { text: string; missing: string[] } {
  const missing: string[] = []
  const text = tpl.replace(/\{\{\s*env:([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_whole, name: string) => {
    const v = env[name]
    if (v === undefined) {
      if (!missing.includes(name)) missing.push(name)
      return ''
    }
    return v
  })
  return { text, missing }
}

/**
 * 展开一组已知 provider 占位符。只替换 `map` 里有的键,其余(如用户手误的
 * `{{foo}}`)**原样保留** —— 与项目其它模板渲染一致:保留比静默变空串好排查。
 */
export function expandTokens(tpl: string, map: Record<string, string>): string {
  return tpl.replace(/\{\{([^{}]+)\}\}/g, (whole, rawName: string) => {
    const name = rawName.trim()
    return Object.prototype.hasOwnProperty.call(map, name) ? map[name] : whole
  })
}
