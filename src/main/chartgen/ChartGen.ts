/*
 * chart 节点(v0.6.2)执行器 —— 与 Packager / ImageGen 同级的内置动作执行器。
 *
 * 输入:projectDir + 已展开占位符的数据文本(req.prompt)+ 图表参数(chartParams)。
 * 流程:渲染 SVG → 落盘 assets/generated/charts/<slug>/chart.svg → 产出相对路径文本。
 * 产物随项目一起打包交付(输出节点打包时整个 assets/ 一起带上)。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { BuiltinActionRequest, BuiltinActionResult } from '../workflow/builtinAction'
import { CHART_TYPE_LABEL, renderChart, type ChartRenderRequest } from './render'

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'chart'
}

export class ChartGen {
  async run(req: BuiltinActionRequest): Promise<BuiltinActionResult> {
    const dir = req.projectDir
    if (!dir) {
      return { ok: false, log: '', error: '还没有指定项目文件夹 —— 先在画布上放一个「项目」节点并选好目录' }
    }
    const dataText = (req.prompt ?? '').trim()
    if (!dataText) {
      return { ok: false, log: '', error: '图表数据是空的 —— 在节点配置里写一份 JSON 数据,或把上游产出接进来' }
    }
    const params = req.chartParams
    const renderReq: ChartRenderRequest = {
      chartType: params?.chartType ?? 'bar',
      title: params?.title || undefined,
      width: params?.width ?? 800,
      height: params?.height ?? 480,
      dataText,
    }
    const res = renderChart(renderReq)
    if (!res.ok) return { ok: false, log: '', error: res.error }

    const outDir = path.join(dir, 'assets', 'generated', 'charts', `${slug(req.nodeTitle ?? req.nodeId)}-${Date.now()}`)
    await fs.mkdir(outDir, { recursive: true })
    const file = path.join(outDir, 'chart.svg')
    await fs.writeFile(file, res.svg, 'utf8')

    const rel = path.relative(dir, file).replace(/\\/g, '/')
    const label = CHART_TYPE_LABEL[renderReq.chartType]
    const text =
      `[图表完成] ${label}已生成(数据点 ${res.dataPoints})\n` +
      `图表文件:${rel}\n` +
      `把该相对路径写进 README / 文档,打包时它会随项目一起交付。`
    req.onProgress?.(`${label}渲染完成:${res.dataPoints} 个数据点 → ${rel}`)
    return { ok: true, artifacts: [rel], handoffText: text, log: text }
  }
}
