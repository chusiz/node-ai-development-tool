/**
 * 节点标题 → 产物目录名。**确定性**(同名节点每次落同一目录,可对比/重跑)
 * 且**文件系统安全**。
 *
 * ⚠️ 与 PRD §3.1 字面("非字母数字替换为 -")的偏差:PRD 自己的示例目录是
 * `assets/generated/主角待机/`,所以这里**保留字母与数字(含中文等 Unicode 字母)**,
 * 只把"文件系统非法字符 / 路径分隔符 / emoji / 控制符"替换掉 —— 否则中文会被
 * 抹成空串,与示例自相矛盾。
 *
 * 例:
 *   像素风主角待机   → 像素风主角待机   (中文原样保留)
 *   主角🖼待机        → 主角-待机       (emoji 被 \p{L}\p{N} 排除 → '-')
 *   a/b\c:d          → a-b-c-d        (路径分隔符 / 非法字符)
 *   空 / 全非法 / Windows 保留名 → 回落 nodeId(保证目录一定合法且非空)
 *
 * 为什么**确定性**很重要:用户重跑时希望落到同一目录,好对比新旧产出;
 * 每次换一个随机目录会让"同名节点落同一目录"这条 P1-6 验收点失效。
 */
export function slugify(title: string, fallback: string): string {
  let s = title.trim().toLowerCase()
  // 非"字母 / 数字"一律 → '-'(\p{L}\p{N} 含中文等 Unicode 字母;emoji、\/:*?"<>|、空格、点都被吃掉)
  s = s.replace(/[^\p{L}\p{N}]+/gu, '-')
  s = s.replace(/^-+|-+$/g, '') // 去首尾 '-'
  // Windows 保留设备名 / 空 → 回落 nodeId。保留名当真去建目录会失败(或行为诡异)
  if (!s || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = fallback
  return s.slice(0, 48) // 目录名长度兜底(路径总长限制)
}
