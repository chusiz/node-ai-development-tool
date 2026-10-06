/*
 * chart 节点(v0.6.2)的图表渲染器 —— ECharts SSR 输出 SVG。
 *
 * ## 为什么选 ECharts SSR 而非 node-canvas
 *   - 纯 JS 能力:不需要编译原生模块(node-canvas 在 Windows 上要装预编译二进制);
 *   - 输出 SVG:可无损放大、可直接嵌进 README / 网页 / 飞书文档;
 *   - echarts 已是本项目渲染端在用的库,主进程复用同一份依赖。
 *
 * ## 数据格式(宽容解析,JSON.parse 为唯一入口)
 *   - 柱/折线:{"categories":["A","B"],"series":[10,20]} | [{"name":"A","value":10},…] | [10,20,30]
 *   - 饼/漏斗:[{"name":"A","value":10},…] | {"data":[…]} | {"categories":[…],"series":[…]}
 *   - 散点:[[x,y],…] | [{"name":"点1","value":[x,y]},…]
 * 解析失败 = 节点失败 + 一句人话(绝不把坏数据画成一张看不懂的图)。
 */

import * as echarts from 'echarts'
import type { ChartType } from '../../shared/canvas'

export type { ChartType }

export interface ChartRenderRequest {
  chartType: ChartType
  title?: string
  width: number
  height: number
  /** 已展开占位符的**数据文本**(JSON 或可转成 JSON 的描述) */
  dataText: string
}

export type ChartRenderResult =
  | {
      ok: true
      /** 完整 SVG 文本(可直接落盘 / 预览) */
      svg: string
      /** 数据里取到的数据点数(给人看的摘要) */
      dataPoints: number
    }
  | {
      ok: false
      error: string
    }

/** 图表类型 → 展示名(提示文案用) */
export const CHART_TYPE_LABEL: Record<ChartType, string> = {
  bar: '柱状图',
  line: '折线图',
  pie: '饼图',
  scatter: '散点图',
  funnel: '漏斗图',
}

/** 去掉首尾空白与可能包裹的 ```json … ``` / 说明文字,只留 JSON 段 */
function extractJson(dataText: string): string {
  const text = dataText.trim()
  // 取第一个 { 或 [ 到最后一个 } 或 ] —— 宽容处理模型/上游把说明文字和 JSON 混在一起的情况
  const start = text.search(/[[{]/)
  if (start < 0) return text
  const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'))
  if (end < start) return text
  return text.slice(start, end + 1)
}

/** 把任意可转成数据的输入归一成 ECharts option。失败 = 人话错误。 */
export function buildChartOption(req: ChartRenderRequest): { ok: true; option: echarts.EChartsCoreOption; dataPoints: number } | { ok: false; error: string } {
  const { chartType, title, dataText } = req
  const raw = extractJson(dataText)
  if (!raw) return { ok: false, error: '数据是空的 —— 在节点里写一份 JSON 数据,或把上游产出接进来' }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: `数据不是合法 JSON(${e instanceof Error ? e.message : String(e)})\n请写形如 {"categories":["一月","二月"],"series":[10,20]} 的数据,或接一个产出 JSON 的上游节点` }
  }

  const base: echarts.EChartsCoreOption = {
    title: title ? { text: title, left: 'center', textStyle: { fontSize: 15 } } : undefined,
    tooltip: { trigger: chartType === 'pie' || chartType === 'funnel' ? 'item' : 'axis' },
  }

  // 归一化:任何输入形状 → { categories?: string[], values: number[], pairs?: [number,number][] }
  let categories: string[] | undefined
  let values: number[] = []
  let pairs: [number, number][] = []

  let arr: unknown = parsed
  // 对象形状:{data:[…]} 或 {categories:[…],series:[…]}
  if (!Array.isArray(parsed) && typeof parsed === 'object' && parsed !== null) {
    const obj = parsed as Record<string, unknown>
    if (Array.isArray(obj.data)) {
      arr = obj.data
    } else if (Array.isArray(obj.categories) && Array.isArray(obj.series)) {
      categories = obj.categories.map(String)
      const vals = obj.series
      if (!vals.every((v) => typeof v === 'number' && Number.isFinite(Number(v)))) {
        return { ok: false, error: 'series 里混进了非数字 —— 用 [{"name":"A","value":10}] 或纯数字数组' }
      }
      values = (vals as number[]).map(Number)
      if (categories.length !== values.length) {
        return { ok: false, error: `categories 有 ${categories.length} 项但 series 有 ${values.length} 项 —— 两段长度要一致` }
      }
      // categories/series 已归一化完毕,数组解析段不再需要原始数据
      arr = []
    } else {
      return { ok: false, error: '对象形状不认识 —— 用 {"categories":[…],"series":[…]} 或 {"data":[…]}' }
    }
  }
  if (!Array.isArray(arr)) return { ok: false, error: '数据主体必须是数组 —— 数组 / {"categories","series"} / {"data":[…]}} 都可以' }

  const looksObjectArray = arr.length > 0 && arr.every((v) => typeof v === 'object' && v !== null && !Array.isArray(v))
  if (looksObjectArray) {
    const items = arr as Array<Record<string, unknown>>
    if (items[0] && typeof items[0].value === 'number') {
      categories = items.map((v) => String(v.name ?? '')).filter(Boolean)
      values = items.map((v) => Number(v.value))
    } else if (Array.isArray(items[0]?.value)) {
      pairs = items.map((v) => {
        const p = v.value as [number, number]
        return [Number(p[0]), Number(p[1])]
      })
    } else {
      return { ok: false, error: `数据项形状不认识 —— 用 [{"name":"A","value":10}] 或 [10,20,30] 或 [[x,y],…]` }
    }
  } else if (arr.length > 0 && Array.isArray(arr[0])) {
    pairs = arr.map((p) => {
      const q = p as [number, number]
      return [Number(q[0]), Number(q[1])]
    })
  } else if (arr.every((v) => typeof v === 'number' && Number.isFinite(Number(v)))) {
    values = arr.map((v) => Number(v))
  } else if (arr.length === 0) {
    return { ok: false, error: '数据数组是空的 —— 没东西可画' }
  } else {
    return { ok: false, error: `数据项类型不认识 —— 用 [{"name":"A","value":10}] 或 [10,20,30] 或 [[x,y],…]` }
  }

  const dataPoints = Math.max(values.length, pairs.length, categories?.length ?? 0)
  if (dataPoints === 0) return { ok: false, error: '数据解析出来是空的 —— 检查一下字段名(name/value)' }

  const opt: echarts.EChartsCoreOption = { ...base }

  if (chartType === 'pie' || chartType === 'funnel') {
    const items = categories && categories.length === values.length
      ? categories.map((c, i) => ({ name: c, value: values[i] }))
      : values.map((v, i) => ({ name: categories?.[i] ?? `项${i + 1}`, value: v }))
    if (chartType === 'pie') {
      opt.series = [{ type: 'pie', radius: ['38%', '62%'], data: items, label: { show: true, formatter: '{b}: {c}' } }]
      opt.legend = { bottom: 0 }
    } else {
      opt.series = [{ type: 'funnel', left: '12%', width: '60%', data: items, label: { position: 'inside' } }]
    }
  } else if (chartType === 'scatter') {
    opt.xAxis = { type: 'value' }
    opt.yAxis = { type: 'value' }
    opt.series = [{ type: 'scatter', symbolSize: 14, data: pairs }]
    opt.grid = { left: 50, right: 30, top: 40, bottom: 40 }
  } else {
    // bar / line 共用同一数据形状
    const cats = categories ?? values.map((_, i) => `项${i + 1}`)
    opt.xAxis = { type: 'category', data: cats }
    opt.yAxis = { type: 'value' }
    opt.grid = { left: 50, right: 30, top: 40, bottom: 40 }
    opt.series = [{ type: chartType === 'line' ? 'line' : 'bar', data: values, smooth: chartType === 'line' }]
  }
  return { ok: true, option: opt, dataPoints }
}

/** ECharts SSR:option → SVG 文本(线程内同步完成,无子进程) */
export function renderChartSvg(option: echarts.EChartsCoreOption, width: number, height: number): string {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height })
  chart.setOption(option)
  const svg = chart.renderToSVGString()
  chart.dispose()
  return svg
}

/** 完整入口:数据文本 → SVG。失败给一句能直接指导改法的人话。 */
export function renderChart(req: ChartRenderRequest): ChartRenderResult {
  const built = buildChartOption(req)
  if (!built.ok) return { ok: false, error: built.error }
  try {
    const svg = renderChartSvg(built.option, req.width, req.height)
    if (!svg.includes('<svg')) return { ok: false, error: '渲染器没有产出 SVG —— 试试把画布尺寸调大一点' }
    return { ok: true, svg, dataPoints: built.dataPoints }
  } catch (e) {
    return { ok: false, error: `SVG 渲染失败:${e instanceof Error ? e.message : String(e)}` }
  }
}
