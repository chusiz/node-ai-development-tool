/**
 * 交接节点执行器(v0.4.2):连接「图像节点」与「软件制作节点」的桥。
 *
 * 行为(纯内置动作,不耗 token):
 *   ① 扫描项目 `assets/generated/` 下的全部图片(图像节点的产出都在这);
 *   ② 生成 markdown 素材交接清单(相对路径 + 用途说明);
 *   ③ 以 handoffText 作为该节点产出 —— 下游软件节点(project / feature /
 *      merge / game / review…)用 {{node:<id>}} 或 {{prev}} 引用即可拿到清单,
 *      AI 制作/打包时按相对路径引用这些素材。
 *
 * 产物约定:图片已位于项目内(assets/generated/...),无需复制;
 * 交接清单只负责把"有哪些图、在哪、干什么用"说清楚。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Dirent } from 'node:fs'
import type { BuiltinActionRequest, BuiltinActionResult } from '../workflow/builtinAction'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'])

export class Handoff {
  async run(req: BuiltinActionRequest): Promise<BuiltinActionResult> {
    if (!req.projectDir || !req.projectDir.trim()) {
      return {
        ok: false,
        log: '',
        error: '交接节点要能访问项目素材:项目文件夹还没设 —— 先放一个项目节点并选好文件夹',
      }
    }

    const files = await collectImages(req.projectDir)
    if (files.length === 0) {
      return {
        ok: false,
        log: '',
        error: '在 assets/generated/ 下没找到任何图片 —— 先跑一个图像节点出图,再接「交接」节点',
      }
    }

    const note = (req.handoffNote ?? '').trim()
    const lines: string[] = ['## 素材交接清单']
    if (note) lines.push(`用途说明:${note}`)
    lines.push(`共 ${files.length} 张图片(位于项目内,以下为相对项目文件夹的路径,可直接引用):`)
    for (const rel of files) lines.push(`- ${rel}`)
    lines.push('下游制作 / 打包时请按上述相对路径引用素材;图片已随项目保存,可一并打包进产物。')

    const md = lines.join('\n')
    return {
      ok: true,
      handoffText: md,
      log: `收集到 ${files.length} 张图片:\n${files.map((f) => `  - ${f}`).join('\n')}`,
    }
  }
}

/** 递归收集 assets/generated/ 下的图片,返回**相对 projectDir** 的路径(排序稳定) */
async function collectImages(projectDir: string): Promise<string[]> {
  const root = path.join(projectDir, 'assets', 'generated')
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[] = []
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        await walk(full)
        continue
      }
      if (IMAGE_EXT.has(path.extname(e.name).toLowerCase())) {
        out.push(path.relative(projectDir, full).split(path.sep).join('/'))
      }
    }
  }
  await walk(root)
  return out.sort()
}
