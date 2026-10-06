import { z } from 'zod'
import { canvasGraphFile, ensureCanvasDirs } from '../paths'
import { readJsonSafe, writeJsonAtomic } from '../persist/atomic'
import { migrateGraph, type CanvasGraph } from '../../shared/canvas'

/*
 * 只做**结构性**校验,不约束 node.data 内部。
 *
 * 理由:画布字段会随功能长(提示词模板、重试策略、失败策略…),而主进程根本不需要
 * 理解它们 —— 它只是保管这份 JSON。把 data 定死的话,渲染进程每加一个字段
 * 都要同时改主进程,漏一次就是"保存失败"。
 * 但 id / position 这些**结构**必须校验:写坏了整个画布就打不开了。
 *
 * nodes-v2:type 放宽为 v1('agent')与 v2 四类型之并;version 同理放宽为 1|2。
 * v0.3.0(image-node):再加 'image' 与 version 3。
 * 宽进严出:磁盘上的旧画布要能读进来(P0-9),读进来之后一律经 migrateGraph
 * 升成当前代再交给调用方/写回磁盘 —— 迁移幂等,重复调用不会重复改写。
 */
const NodeSchema = z.object({
  id: z.string().min(1).max(128),
  // 'agent' 是 v1 的旧值,读旧画布要放行;写盘恒为当前代(经 migrateGraph)
  type: z.union([z.literal('agent'), z.enum(['project', 'feature', 'merge', 'output', 'image'])]),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  data: z.record(z.string(), z.unknown()),
})

const EdgeSchema = z.object({
  id: z.string().min(1).max(128),
  source: z.string().min(1).max(128),
  target: z.string().min(1).max(128),
})

const GraphSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  name: z.string().max(200),
  /*
   * ⚠️ 顶层字段必须**逐个列在这里**,漏一个就会被 zod 静默剥掉。
   * z.object 默认丢弃未声明的键,所以"渲染进程加了字段、主进程忘了加schema"
   * 的后果不是报错,而是**存盘时悄悄丢掉**,重启才发现。
   * projectDir 就踩过这一下:界面能设、能用、能跑,一存盘就没了。
   * .default('') 同时兜住阶段 2 之前存下的老画布(里面没这个键)。
   *
   * v2 起它是 deprecated(权威转移到项目节点),但仍然要留在 schema 里:
   * 无项目节点的旧画布还靠它兜底(resolveProjectDir 的 canvas 分支)。
   */
  projectDir: z.string().max(4096).default(''),
  nodes: z.array(NodeSchema).max(500),
  edges: z.array(EdgeSchema).max(2000),
  viewport: z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().finite() }),
})

/**
 * 读画布。zod 解析通过后**一律** migrateGraph:
 * - v1 旧画布 → 当前代(旧 agent 节点变 feature/serial);
 * - v2 画布 → 幂等原样(迁移函数对已是新代的输入不做任何改写);
 * - v3 画布 → 幂等原样(含 image 节点的画布重复加载不会被改写)。
 * 迁移放在主进程是第一道;渲染端 graphStore.load 还会再兜一次(同样幂等)——
 * 两道都过也不重复改写,这是 migrateGraph 不看 version 号、只看节点形状的原因。
 */
export async function loadGraph(canvasId: string): Promise<CanvasGraph | null> {
  ensureCanvasDirs(canvasId)
  const raw = await readJsonSafe<unknown>(canvasGraphFile(canvasId), null)
  const parsed = GraphSchema.safeParse(raw)
  // 解析不了就当没有画布(渲染进程会建一个空白的),而不是把坏数据丢给 UI 去炸
  return parsed.success ? migrateGraph(parsed.data) : null
}

/**
 * 写画布。渲染进程恒发 v2,但这里也过一遍 migrateGraph:
 * 万一有调用方(或手改的数据)带着 v1 形状进来,落盘的就是升级后的版本
 * —— "保存后升级到 version:2"(P0-9)由这一行保证,不依赖调用方自觉。
 */
export async function saveGraph(canvasId: string, raw: unknown): Promise<void> {
  ensureCanvasDirs(canvasId)
  const parsed = GraphSchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    throw new Error(`画布数据不合法:${first?.path.join('.')} ${first?.message ?? ''}`)
  }
  await writeJsonAtomic(canvasGraphFile(canvasId), migrateGraph(parsed.data))
}
