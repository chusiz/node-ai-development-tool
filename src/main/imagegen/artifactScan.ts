import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * "本次新产出"扫描 —— 判定"命令成功但没出图"(PRD §4 情况 5)。
 *
 * ## 为什么只看文件系统,不解析 stdout
 *
 * 本地命令经 shell:true 执行(项目 shell:false 的**显式例外**),Windows 上是
 * cmd.exe —— 输出可能是 GBK 乱码,解析 stdout 里的"生成了几张图"不可靠。
 * 文件系统的 mtime 是**唯一稳的判据**:只要图片真落到了 outDir,就一定数得出来。
 *
 * ## CLOCK_SLACK 的用途
 *
 * 部分文件系统时间戳精度只到秒,且"同一秒内写入"会与 startTs 打平;取 2s 是
 * "宁可多认一个本次文件,也不漏"—— 漏判会把成功当失败。
 *
 * ## 已知局限(M-4,接受的边界)
 *
 * 若用户的出图脚本写入文件时**保留了旧 mtime**(如拷贝时 preserve 元数据),
 * 会被判成"历史文件"而漏计 → 误报"没出图"。P0 接受此局限;P1 可加
 * "命令模板提供 {{manifestFile}},命令写出实际产物清单"的显式协议。
 */

/** 产物判定只看这些扩展名 */
export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])

/** 时钟抖动余量(见文件头注释) */
export const CLOCK_SLACK_MS = 2000

export interface ScannedImage {
  abs: string
  name: string
  mtime: number
}

/**
 * 扫描 outDir 下"本次新产出"的图片:扩展名在白名单内 且 mtime >= startTs - slack。
 *
 * - 目录不存在 → 返回 [](调用方已 mkdir -p,这里只是防御);
 * - 深度受限(默认 ≤2 层):防异常目录结构/符号链接把遍历拖死;
 * - 排序:mtime 升序,再按文件名 —— **确定性**,便于 e2e 断言与产物顺序稳定。
 */
export async function scanNewImages(outDir: string, startTs: number, maxDepth = 2): Promise<ScannedImage[]> {
  const out: ScannedImage[] = []
  const floor = startTs - CLOCK_SLACK_MS

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        await walk(full, depth + 1)
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase()
        if (!IMAGE_EXTS.has(ext)) continue
        try {
          const st = await fsp.stat(full)
          if (st.mtimeMs >= floor) out.push({ abs: full, name: e.name, mtime: st.mtimeMs })
        } catch {
          /* 竞态:文件刚被删 —— 跳过 */
        }
      }
    }
  }

  await walk(outDir, 0)
  out.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name))
  return out
}
