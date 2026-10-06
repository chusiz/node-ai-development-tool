/*
 * 节点类型声明表 —— 一个节点类型"是什么"的**唯一真相源**。
 *
 * ## 为什么要有这张表(本次增量的核心目标 A)
 *
 * 升级前,"有哪几种节点类型"这件事散落在 8 个文件里:契约 union、React Flow
 * 组件映射、配置面板 switch、runner 的 kind 分流、validateGraph 的写死规则、
 * 徽标样式、添加入口菜单、graphStore 的默认值/标题。新增一个类型要**同步改
 * 8 处**,漏一处就是"节点画不出来 / 面板空白 / 跑不动 / 校验不认"这类沉默 bug。
 *
 * 这里把这些"类型知识"收成一张可注册的声明表:加一个类型 = 契约 union 加一个字面量
 * + 本表加一条声明 + 该类型自己的组件/面板文件。核心调度器(runner)与画布
 * (Canvas / nodeTypes)**不再出现该类型的名字**。
 *
 * ## 跨层铁律:shared 只放数据,不 import React
 *
 * 组件与配置面板是 **React 概念**,放在渲染端:
 *   - `src/renderer/src/flow/nodeTypes.ts`            —— 画布节点组件映射
 *   - `src/renderer/src/components/NodeConfig/panelRegistry.ts` —— 配置面板映射
 * 本文件**只放数据**(ports / executor / action / 徽标 / 默认值 / 校验 / 添加入口),
 * 因为主进程与渲染进程都要读它(端口校验、调度分流、默认值补全),而 shared 不许
 * import React(项目铁律)。
 */

// ⚠️ 只做 type-import(擦除,不产生运行时环):
//   - NodeConfig 来自 canvas,而 canvas 又从本文件取 NodeKind —— 类型级的环,
//     靠"仅类型"擦除后不存在运行时循环依赖;
//   - GraphIssue / NodeSpecSource 同理来自 workflow。
import type { GraphIssue, NodeSpecSource } from './workflow'
import type { NodeConfig } from './canvas'
// 按值引:normalizeSubgraph 是纯函数(与 canvas 的 migrateGraph 同一族),
// canvas 对 nodeRegistry 只有 type-only 的反向引用,运行时无环
import { normalizeSubgraph } from './canvas'

/**
 * 「空模板子图」的唯一文案(节点注册表 V13 与 `expandSubgraphs` 的 warning 共用)。
 *
 * ## 为什么住在注册表里
 *
 * 依赖方向:`workflow.ts` 按值引 `nodeRegistry`,而 nodeRegistry 对 workflow 只有
 * type-only 的反向引用(见上面的 import 块)。文案要能在两处生成同一个字符串,
 * 就必须放在**两者都能按值引到**的地方 —— 也就是本文件这个叶子。
 * 放进 workflow.ts 会让 nodeRegistry 不得不按值引 workflow,形成运行时环。
 *
 * ## 为什么是**一个**函数而不是两处各写一遍
 *
 * `graphIssuesFor` 按文案去重(同一个问题报两遍会让检查列表看起来像坏了),
 * 而去重的前提是两边**逐字一致**。这靠"记得两处都改"是守不住的。
 *
 * ⚠️ 措辞里**不能出现"跳过"**。运行时展开一个空模板子图,做的是节点消掉 +
 * 外部线一并删掉,而下游节点**照样会被调度** —— 只是收不到任何上游产出。
 * "跳过"暗示下游照跑(只是状态不同),实际是"下游跑了但没收到东西":
 * 在一个可能已被上游改过的项目文件夹上叠加功能,看起来跑通,结果是错的。
 */
export function emptySubgraphMessage(title: string): string {
  return (
    `子图「${title}」内容为空 —— **运行时会断开上下游**:上游产出送不进来,下游拿不到它的结果。` +
    '展开它或删掉它'
  )
}

/**
 * 类型的图标名。
 *
 * ⚠️ 这里存的是**名字**不是图形。注册表是 shared(不许 import React),
 * 而图标是渲染端的 SVG 组件 —— 所以数据里只能是字符串,渲染端用
 * `components/Icons.tsx` 的 `<NodeIcon name=…>` 查表画出来。
 *
 * 之所以专门加这个字段而不是把 emoji 写进 text:emoji 是**字体**渲染的,
 * 各个平台/字体下的字形、颜色、基线都不一样(Windows 的 Segoe UI Emoji 是彩色
 * 卡通图,Linux 上可能直接掉成豆腐块),摆在一排节点上既不统一也不好看;
 * 而且它没法跟着 CSS 变量变色,和整张图的主题脱钩。
 */
export type NodeIconName =
  | 'project'
  | 'serial'
  | 'parallel'
  | 'merge'
  | 'output'
  | 'image'
  | 'review'
  | 'test'
  | 'doc'
  | 'game'
  | 'video'
  | 'handoff'
  | 'subgraph'
  | 'prompt'
  | 'sampler'
  | 'image_output'

/** 类型角标:图标 + 文字 + 颜色类(+ 可选 tooltip) */
export interface NodeBadge {
  /** 图标名(渲染端查 Icons.tsx);纯文字类角标可省略 */
  icon?: NodeIconName
  text: string
  /** 颜色类名(如 kind-output),对应 canvas.css 里的 .node-kind-badge.<cls> */
  cls: string
  title?: string
}

/**
 * 端口布局。框架据此:
 *   ① 画布节点组件的 Handle 布局(有 target 才有左入点、有 source 才有右出点);
 *   ② onConnect 的非法连线拦截(由 ports 推导,不再手写两条 if);
 *   ③ 运行前 validateGraph 的端口方向兜底警告(V7)。
 *
 * `targetMulti` 只是语义标注(能不能接多条入边),React Flow 的原生 Handle
 * 默认就支持多线汇入,这里留字段是为了让"这是不是个汇合点"可被数据化读取。
 */
export interface NodePorts {
  target: 0 | 1
  source: 0 | 1
  targetMulti?: boolean
}

/**
 * 添加入口。**一个 kind 可以有多个入口**(如 feature 的串行/并行),
 * 各自带一个 `preset` 预置配置(graphStore.addNode 会把它并进默认配置)。
 */
export interface AddEntry {
  key: string
  /** 纯文字标签(不带 emoji —— 图标由 `icon` 单独给,见 NodeBadge 的说明) */
  label: string
  hint: string
  /** 菜单项图标名(渲染端查 Icons.tsx) */
  icon?: NodeIconName
  preset?: Partial<NodeConfig>
}

/** 节点级校验上下文(框架组装,类型只读) */
export interface TypeValidateCtx {
  id: string
  data: NodeSpecSource
  /** 直接前驱节点 id(已去掉自环 / 未知节点的边) */
  preds: readonly string[]
  /** 直接后继节点 id */
  succs: readonly string[]
  /** 沿入边向上游 BFS,是否触达某个 project 节点(**不含自身**) */
  hasProjectAncestor(id: string): boolean
  /** 全图里某 kind 的节点数(如 project 唯一性判定) */
  countKind(kind: string): number
  /** 全图解析出的项目文件夹(空串 = 没设) */
  resolvedProjectDir: string
  /**
   * 取**任意节点**的 data(找不到给 undefined)。
   *
   * 给"要依据上游性质做判断"的规则用:整合节点得知道每条汇入支路是串行
   * 还是并行,才知道该提醒什么。只给 `preds`(一串 id)是不够的 ——
   * 那正是升级前那种"拿着 id 却没处查"的写法。
   */
  dataOf(id: string): NodeSpecSource | undefined
}

/**
 * 图级校验上下文。每个**已注册类型**各跑一次 `validateGraph` ——
 * 即使该类型节点数为 0 也要跑(V1"没有项目节点"这条就靠它)。
 */
export interface GraphValidateCtx {
  nodes: readonly { id: string; data: NodeSpecSource }[]
  edges: readonly { source: string; target: string }[]
  resolvedProjectDir: string
}

/**
 * 端口携带物的**语义类型**(类型化端口,数据层)。
 *
 * 这不是数据结构类型(string 之类),而是「这条线交出去的**东西是什么性质**」——
 * 程序模式下边传的统一是文本,但文本的**语义**分五种。语义错配的线
 * (比如把测试报告喂给图像节点当画面描述)结构上合法、运行上也跑得动,
 * 但十有八九不是用户想要的 —— 所以它是**警告层**,不是硬禁。
 */
export type PayloadKind = 'context' | 'handoff' | 'issues' | 'report' | 'artifacts'

/** 携带物语义的中文说法(提示语里用) */
export const PAYLOAD_LABEL: Record<PayloadKind, string> = {
  context: '项目起点(项目说明 / 初始状态)',
  handoff: '交接说明(改了什么、结论是什么)',
  issues: '问题清单(只读审查的产出)',
  report: '测试报告(过没过、失败详情)',
  artifacts: '图片路径(生成的素材清单)',
}

export interface NodeTypeDef {
  label: string
  badge: NodeBadge
  ports: NodePorts
  /** 执行器种类:会话(跑 LLM)还是内置动作(不耗 token) */
  executor: 'session' | 'builtin'
  /** 仅 executor==='builtin':走哪个内置动作(package / image / 未来的 video…) */
  action?: string
  /** 该类型产出的携带物语义。终点(output)与"不直接执行"的类型(subgraph)没有 */
  payload?: PayloadKind
  /**
   * 能**有意义地**接收的携带物;省略 = 不限(默认宽容)。
   * 只用于警告(connectionWarning / validateGraph),**不阻断**连线。
   */
  accepts?: PayloadKind[]
  defaultTitle: string
  /** 通用 normalize 之后套用的默认配置(会被 raw 覆盖) */
  defaultConfig?: Partial<NodeConfig>
  addEntries?: AddEntry[]
  /** 通用 normalize 之后调用,按类型精修(可省略) */
  normalize?(merged: NodeConfig, raw: Partial<NodeConfig>): NodeConfig
  /** 节点级校验(如 feature 串行需上游、output 触达项目、image provider 未配置) */
  validate?(ctx: TypeValidateCtx): GraphIssue[]
  /** 图级校验(如 project 唯一性/必填),按类型注册一次 */
  validateGraph?(ctx: GraphValidateCtx): GraphIssue[]
}

/**
 * ⚠️ 用 `satisfies` 而**不是**注解 `Record<string, NodeTypeDef>`。
 *
 * 注解成 `Record<string, NodeTypeDef>` 会把对象的键类型**退化**为 `string` ——
 * 于是 `keyof typeof NODE_TYPES` 推出的是 `string` 而不是字面量联合,
 * `NodeKind` 就再也变不成 'project' | 'feature' | ... 这种精确联合了。
 * `satisfies` 只做"符合性检查",保留键的字面量类型,联合才推得出来。
 */
export const NODE_TYPES = {
  project: {
    label: '项目',
    badge: { icon: 'project', text: '项目', cls: 'kind-project', title: '画布起点:项目文件夹的唯一权威来源' },
    ports: { target: 0, source: 1 },
    executor: 'session',
    payload: 'context',
    defaultTitle: '项目节点',
    addEntries: [{ key: 'project', label: '项目', icon: 'project', hint: '画布起点:项目文件夹的唯一权威来源' }],
    defaultConfig: { projectDir: '', brief: '' },
    normalize: (m, raw) => ({
      ...m,
      projectDir: typeof raw.projectDir === 'string' ? raw.projectDir : '',
      brief: typeof raw.brief === 'string' ? raw.brief : '',
    }),
    // V1 / V2 / V3:项目节点唯一性 + 目录必填(图级)
    validateGraph: (ctx) => {
      const pros = ctx.nodes.filter((n) => n.data.kind === 'project')
      const out: GraphIssue[] = []
      if (pros.length === 0) {
        out.push({
          level: 'warn',
          message: ctx.resolvedProjectDir
            ? '画布上没有项目节点,当前以画布级 projectDir 兜底(deprecated);建议放一个项目节点作为项目文件夹的权威来源'
            : '画布上没有项目节点,也没设项目文件夹 —— 节点会跑在画布沙箱里',
        })
      } else {
        if (pros.length > 1) {
          // 不强制唯一(用户决策 Q3),但要让用户知道"多放的那几个不生效"
          out.push({
            level: 'warn',
            nodeId: pros[1].id,
            message: `画布上有 ${pros.length} 个项目节点,建议只保留一个(当前以第一个为准)`,
          })
        }
        const first = pros[0]
        if (!(first.data.projectDir ?? '').trim()) {
          out.push({
            level: 'warn',
            nodeId: first.id,
            message: `项目节点「${first.data.title || first.id}」还没选文件夹 —— 下游节点的目录会因此落到画布沙箱`,
          })
        }
      }
      return out
    },
  },
  feature: {
    label: '功能',
    badge: { icon: 'serial', text: '串行', cls: 'kind-serial', title: '在上游成果上叠加(注入上游产出)' },
    ports: { target: 1, source: 1 },
    executor: 'session',
    payload: 'handoff',
    defaultTitle: '功能节点',
    // 一个 kind 多个入口:串行 / 并行(addEntries 各自带 preset.mode)
    addEntries: [
      { key: 'serial', label: '串行功能', icon: 'serial', hint: '在上游成果上叠加(注入上游产出)', preset: { mode: 'serial' } },
      { key: 'parallel', label: '并行功能', icon: 'parallel', hint: '另起支路独立做(不注入上游产出)', preset: { mode: 'parallel' } },
    ],
    defaultConfig: { mode: 'serial' },
    normalize: (m, raw) => ({ ...m, mode: raw.mode === 'parallel' ? 'parallel' : 'serial' }),
    // V4:串行需上游
    validate: (ctx) => {
      if ((ctx.data.mode ?? 'serial') !== 'serial') return []
      if (ctx.preds.length > 0) return []
      return [
        {
          level: 'warn',
          nodeId: ctx.id,
          message: `「${ctx.data.title || ctx.id}」是串行节点,需要接在某个节点后面(串行 = 在上游成果上叠加)`,
        },
      ]
    },
  },
  merge: {
    label: '整合',
    badge: { icon: 'merge', text: '整合', cls: 'kind-merge', title: '让各支路的改动互相兼容、合成一个能跑的程序' },
    ports: { target: 1, source: 1, targetMulti: true },
    executor: 'session',
    payload: 'handoff',
    defaultTitle: '整合节点',
    defaultConfig: {},
    // ⚠️ 必须显式声明 addEntries:否则 addEntryList() 走回落后按钮会变成「整合」、
    //    tooltip 变空 —— 与重构前的「整合 / 把多条支路合回同一个项目」不一致(零回归破口)。
    addEntries: [{ key: 'merge', label: '整合', icon: 'merge', hint: '把多条支路合回同一个项目' }],
    /*
     * V6:汇入 < 2。
     * V9:汇入里 >= 2 条**并行支路** —— 它们共用同一份项目目录、各自独立改,
     *     改动可能互相覆盖。这一条必须说清楚,因为它是"靠提示词协调"留下的
     *     已知缺口:整合节点只拿得到各支路的**自述**,拿不到被覆盖掉的中间状态。
     *     用户以为"有整合节点兜底"而让两条并行支路改同一片文件,是能踩到的坑。
     */
    validate: (ctx) => {
      const out: GraphIssue[] = []
      if (ctx.preds.length < 2) {
        out.push({
          level: 'warn',
          nodeId: ctx.id,
          message:
            ctx.preds.length === 0
              ? `整合节点「${ctx.data.title || ctx.id}」还没有任何支路汇入 —— 建议至少连接 2 条`
              : `整合节点「${ctx.data.title || ctx.id}」只有 ${ctx.preds.length} 条支路汇入,建议至少连接 2 条(整合才有意义)`,
        })
      }

      const racing = ctx.preds.filter((p) => {
        const d = ctx.dataOf(p)
        return (d?.kind ?? 'feature') === 'feature' && d?.mode === 'parallel'
      })
      if (racing.length >= 2) {
        out.push({
          level: 'warn',
          nodeId: ctx.id,
          message:
            `整合节点「${ctx.data.title || ctx.id}」有 ${racing.length} 条并行支路汇入 —— ` +
            '它们共用同一份项目代码,改动可能互相覆盖;整合节点只能依据各支路的自述收敛。' +
            '建议让并行支路各改各的文件,别重叠。',
        })
      }
      return out
    },
  },
  output: {
    label: '输出',
    badge: { icon: 'output', text: '输出', cls: 'kind-output', title: '内置打包 · 不启动 AI 会话 · 不消耗 token' },
    ports: { target: 1, source: 0, targetMulti: true },
    executor: 'builtin',
    action: 'package',
    // 打包要的是"改完的项目状态":测试报告可以(打包前看一眼测试红没红),
    // 图片路径列表不行 —— 那是素材清单,不是代码状态
    accepts: ['context', 'handoff', 'issues', 'report'],
    defaultTitle: '输出节点',
    addEntries: [{ key: 'output', label: '输出', icon: 'output', hint: '内置打包交付(不耗 token)' }],
    defaultConfig: { buildTarget: 'exe', buildOptions: {} },
    normalize: (m, raw) => ({
      ...m,
      buildTarget: raw.buildTarget ?? 'exe',
      buildOptions: raw.buildOptions ?? {},
    }),
    validate: (ctx) => {
      const out: GraphIssue[] = []
      // V5:触达不到项目且无画布级兜底
      if (!ctx.hasProjectAncestor(ctx.id) && !ctx.resolvedProjectDir) {
        out.push({
          level: 'warn',
          nodeId: ctx.id,
          message: `输出节点「${ctx.data.title || ctx.id}」需要能触达项目节点(打包要知道项目文件夹在哪)`,
        })
      }
      // V9(v0.6.0):四目标全部可用,按目标给差异化提示
      const t = ctx.data.buildTarget ?? 'exe'
      const hints: Record<string, string> = {
        exe: '',
        web: `输出节点「${ctx.data.title || ctx.id}」打 Web 包:软件节点需产出带 index.html 的 Web 应用,打包器先跑构建脚本再把静态产物打成 zip`,
        apk: `输出节点「${ctx.data.title || ctx.id}」打 Android 包:需要本机 Android SDK(无则自动降级为 Web 应用包 PWA)`,
        game: '',
      }
      const hint = hints[t] ?? ''
      if (hint) out.push({ level: 'info', nodeId: ctx.id, message: hint })
      return out
    },
  },
  image: {
    // ★ 本增量新增:唯一的新声明(其余四类型是等价重写)
    label: '图像',
    badge: { icon: 'image', text: '图像', cls: 'kind-image', title: '内置出图 · 不启动 AI 会话 · 不消耗 token' },
    // 1 入 1 出:它是链上的**中间节点**(不像 output 是终点)
    ports: { target: 1, source: 1 },
    executor: 'builtin',
    action: 'image',
    // 画面描述来自上游产出:项目起点 / 交接说明都讲得清"要画什么";
    // 测试报告、问题清单、图片路径塞进画面描述基本是接错了
    payload: 'artifacts',
    accepts: ['context', 'handoff'],
    defaultTitle: '图像节点',
    addEntries: [{ key: 'image', label: '图像', icon: 'image', hint: '给项目生成美术素材(不耗 token)' }],
    defaultConfig: {
      imageParams: { n: 1, size: '1024x1024' },
      imageProvider: { kind: 'local-command', command: '', cwd: '', timeoutSec: 600 },
    },
    normalize: (m, raw) => {
      const p = raw.imageProvider
      /*
       * provider 用嵌套对象(与既有 buildOptions 同一做法),而不是再摊 8 个扁平字段。
       * 两种 provider 的字段各自补齐默认值:
       *   - 缺 kind(手改 graph.json)→ 默认本地命令(不需要 key,能离线跑);
       *   - http 的 method/responseType/format 给默认,超时 120;本地命令超时 600。
       * 张数夹到 1..8(界面上是数字框,但磁盘上的值可能是任意数)。
       */
      const provider: NonNullable<NodeConfig['imageProvider']> =
        p?.kind === 'http'
          ? {
              kind: 'http',
              endpoint: p.endpoint ?? '',
              method: p.method ?? 'POST',
              headers: p.headers ?? {},
              bodyTemplate: p.bodyTemplate ?? '',
              responsePath: p.responsePath ?? '',
              responseType: p.responseType ?? 'base64',
              format: p.format ?? 'png',
              timeoutSec: typeof p.timeoutSec === 'number' ? p.timeoutSec : 120,
            }
          : {
              kind: 'local-command',
              command: p?.command ?? '',
              cwd: p?.cwd ?? '',
              timeoutSec: typeof p?.timeoutSec === 'number' ? p.timeoutSec : 600,
            }
      return {
        ...m,
        imageParams: {
          n: clampN(raw.imageParams?.n ?? 1),
          size: typeof raw.imageParams?.size === 'string' ? raw.imageParams.size : '1024x1024',
          seed: typeof raw.imageParams?.seed === 'number' ? raw.imageParams.seed : undefined,
        },
        imageProvider: provider,
      }
    },
    validate: (ctx) => {
      const out: GraphIssue[] = []
      // 项目文件夹为空(与 D3 一致:运行时直接失败,不兜底沙箱 —— 这里给运行前 warn)
      if (!ctx.resolvedProjectDir) {
        out.push({
          level: 'warn',
          nodeId: ctx.id,
          message: `图像节点「${ctx.data.title || ctx.id}」要有个地方存图:项目文件夹还没设`,
        })
      }
      // provider 未配置(本地命令没填 command / HTTP 没填 endpoint)
      const p = ctx.data.imageProvider
      const configured = p?.kind === 'http' ? !!p.endpoint?.trim() : !!p?.command?.trim()
      if (!configured) {
        out.push({
          level: 'warn',
          nodeId: ctx.id,
          message: `图像节点「${ctx.data.title || ctx.id}」还没配置出图方式`,
        })
      }
      return out
    },
  },
  review: {
    label: '审查',
    badge: { icon: 'review', text: '审查', cls: 'kind-review', title: '只读评审:只看不改,产出一份问题清单' },
    // 1 入 1 出:它是链上的**中间节点** —— 问题清单还要交给下游去改
    ports: { target: 1, source: 1 },
    executor: 'session',
    payload: 'issues',
    defaultTitle: '审查节点',
    addEntries: [
      { key: 'review', label: '审查', icon: 'review', hint: '只读评审上游成果,产出一份问题清单(不改代码)' },
    ],
    defaultConfig: {},
    /*
     * 默认**只读**。
     *
     * 「审查」这个词的承诺就是"我不动你的代码"。如果它默认带着 acceptEdits
     * 起来,顺手把发现的问题改了,那是最难排查的一类意外:用户看到的是一份
     * 干净的审查报告,而项目里的文件已经变了 —— 而且改动混在别的支路里,分不清谁改的。
     * 真想让它边审边修,把权限模式改成「接受编辑」就行,那是用户的明确选择。
     */
    normalize: (m) => ({ ...m, permissionMode: m.permissionMode ?? 'plan' }),
    // V10:没有上游 → 没有东西可审
    validate: (ctx) => {
      if (ctx.preds.length > 0) return []
      return [
        {
          level: 'warn',
          nodeId: ctx.id,
          message: `审查节点「${ctx.data.title || ctx.id}」还没有上游 —— 没有东西可审,先把要审的支路连进来`,
        },
      ]
    },
  },
  test: {
    label: '测试',
    badge: { icon: 'test', text: '测试', cls: 'kind-test', title: '内置测试 · 不启动 AI 会话 · 不消耗 token' },
    // 1 入 1 出:上游改完跑测试,结果作为产出交给下游(整合 / 输出)
    ports: { target: 1, source: 1 },
    executor: 'builtin',
    action: 'test',
    payload: 'report',
    defaultTitle: '测试节点',
    addEntries: [
      { key: 'test', label: '测试', icon: 'test', hint: '在项目里跑测试命令,结果交给下游(不耗 token)' },
    ],
    /*
     * failurePolicy **刻意不设默认**。
     *
     * specFromGraph 对缺省值给 'skip' = 测试没过则跳过下游 —— 这是安全的一侧:
     * 测试都红了还继续打包 / 整合,产出的东西没人敢用。用户想"先看全貌再决定",
     * 在面板里改成「当空产出继续」即可,那是明确的选择而不是替他做的主。
     */
    defaultConfig: { testCommand: 'npm test', testTimeoutSec: 300 },
    normalize: (m, raw) => ({
      ...m,
      testCommand:
        typeof raw.testCommand === 'string' ? raw.testCommand : (m.testCommand ?? 'npm test'),
      testTimeoutSec: clampTimeout(raw.testTimeoutSec ?? m.testTimeoutSec ?? 300),
    }),
    // V11:没填命令 / 没目录
    validate: (ctx) => {
      const out: GraphIssue[] = []
      if (!(ctx.data.testCommand ?? '').trim()) {
        out.push({
          level: 'warn',
          nodeId: ctx.id,
          message: `测试节点「${ctx.data.title || ctx.id}」还没填写要跑的测试命令`,
        })
      }
      if (!ctx.resolvedProjectDir) {
        out.push({
          level: 'warn',
          nodeId: ctx.id,
          message: `测试节点「${ctx.data.title || ctx.id}」要有个地方跑测试:项目文件夹还没设`,
        })
      }
      return out
    },
  },
  doc: {
    label: '文档',
    badge: { icon: 'doc', text: '文档', cls: 'kind-doc', title: '补写 / 更新文档,跟着项目现有文档的风格写' },
    ports: { target: 1, source: 1 },
    executor: 'session',
    payload: 'handoff',
    defaultTitle: '文档节点',
    addEntries: [
      { key: 'doc', label: '文档', icon: 'doc', hint: '按上游改动补写 / 更新文档(README、接口说明等)' },
    ],
    defaultConfig: {},
    // V12:文档得落在项目里;而且要知道为哪块写
    validate: (ctx) => {
      const out: GraphIssue[] = []
      if (!ctx.resolvedProjectDir) {
        out.push({
          level: 'warn',
          nodeId: ctx.id,
          message: `文档节点「${ctx.data.title || ctx.id}」要有个地方落笔:项目文件夹还没设`,
        })
      }
      if (ctx.preds.length === 0) {
        out.push({
          level: 'warn',
          nodeId: ctx.id,
          message: `文档节点「${ctx.data.title || ctx.id}」还没有上游 —— 不知道要为哪块改动写文档`,
        })
      }
      return out
    },
  },
  game: {
    // ★ 游戏制作节点(v0.4.1):用 Godot 引擎(开源 MIT、节点化场景架构)做游戏。
    // 参考开源节点化游戏工具:Godot(场景即节点树)、Unreal Blueprint(可视化连线)、
    // GDevelop(事件驱动,AI 描述即可生成)。chusiz 用 LLM 直接产出 Godot 项目
    // (project.godot + .tscn 场景 + GDScript),交给 Godot 编辑器打开即可运行。
    label: '游戏',
    badge: {
      icon: 'game',
      text: '游戏',
      cls: 'kind-game',
      title: '用 Godot 引擎制作 2D/3D 游戏:生成项目文件,交给 Godot 编辑器打开即可运行',
    },
    ports: { target: 1, source: 1 },
    executor: 'session',
    payload: 'handoff',
    defaultTitle: '游戏节点',
    addEntries: [
      {
        key: 'game',
        label: '游戏',
        icon: 'game',
        hint: '用 Godot 引擎制作 2D/3D 游戏(生成项目文件,Godot 编辑器打开即可运行)',
      },
    ],
    defaultConfig: {
      gameEngine: 'godot',
      // 默认模板:让模型产出完整可打开的 Godot 项目,而不是一堆零散想法
      promptTemplate:
        '用 Godot(GDScript)制作一个{需求}。产出必须是一个**可直接用 Godot 编辑器打开运行**的完整项目:\n' +
        '1. project.godot(项目配置,含主场景引用);\n' +
        '2. 场景文件(.tscn,主场景 + 所需子场景,节点树完整);\n' +
        '3. 脚本(.gd,挂在对应节点上,逻辑完整可运行);\n' +
        '4. 必需资源(简单的占位贴图可用代码生成,不要依赖外部下载)。\n' +
        '5. 一份 README.md:说明玩法、Godot 版本要求(4.x)、如何打开与运行。\n' +
        '保持玩法简单、可运行优先:宁可做一个小而完整的原型,不要半成品大项目。',
    },
    normalize: (m, raw) => ({
      ...m,
      gameEngine: raw.gameEngine === 'godot' ? 'godot' : (m.gameEngine ?? 'godot'),
    }),
    // 游戏要落在项目里;而且要知道做什么(需求从上游来)
    validate: (ctx) => {
      const out: GraphIssue[] = []
      if (!ctx.resolvedProjectDir) {
        out.push({
          level: 'warn',
          nodeId: ctx.id,
          message: `游戏节点「${ctx.data.title || ctx.id}」要有个地方放项目:项目文件夹还没设`,
        })
      }
      if (ctx.preds.length === 0) {
        out.push({
          level: 'warn',
          nodeId: ctx.id,
          message: `游戏节点「${ctx.data.title || ctx.id}」还没有上游 —— 不知道要做什么游戏,先连上需求/项目节点`,
        })
      }
      return out
    },
  },
  video: {
    // ★ 视频节点(v0.4.1):让 AI 理解视频内容(抽帧 + 视觉模型分析),
    // 或为软件生成视频内容(视频生成服务,后续版本接入)。
    // 底层与程序节点不同:不是 LLM 文本会话,而是"视频 → 帧 → 视觉模型"的确定性管线。
    label: '视频',
    badge: {
      icon: 'video',
      text: '视频',
      cls: 'kind-video',
      title: '理解视频内容(抽帧 + 视觉模型分析):看视频说了什么、做了什么,交给下游去制作/优化软件',
    },
    ports: { target: 1, source: 1 },
    executor: 'builtin',
    action: 'video',
    payload: 'handoff',
    // 视频理解产出的是"对内容的文字理解",喂给后续节点改软件完全说得通
    accepts: ['context', 'handoff'],
    defaultTitle: '视频节点',
    addEntries: [
      {
        key: 'video',
        label: '视频',
        icon: 'video',
        hint: '理解视频内容:抽帧交给视觉模型分析,产出文字理解(不耗 LLM 会话 token,但视觉模型会计费)',
      },
    ],
    defaultConfig: {
      videoParams: {
        frameEverySec: 3,
        maxFrames: 8,
      },
    },
    normalize: (m, raw) => ({
      ...m,
      videoParams: {
        source: typeof raw.videoParams?.source === 'string' ? raw.videoParams.source : '',
        providerId: typeof raw.videoParams?.providerId === 'string' ? raw.videoParams.providerId : '',
        model: typeof raw.videoParams?.model === 'string' ? raw.videoParams.model : '',
        frameEverySec: clampTimeout(raw.videoParams?.frameEverySec ?? 3),
        maxFrames: clampFrames(raw.videoParams?.maxFrames ?? 8),
      },
    }),
    validate: (ctx) => {
      const out: GraphIssue[] = []
      if (!ctx.resolvedProjectDir) {
        out.push({
          level: 'warn',
          nodeId: ctx.id,
          message: `视频节点「${ctx.data.title || ctx.id}」要有个地方放分析结果:项目文件夹还没设`,
        })
      }
      const s = ctx.data.videoParams?.source?.trim()
      if (!s) {
        out.push({
          level: 'warn',
          nodeId: ctx.id,
          message: `视频节点「${ctx.data.title || ctx.id}」还没填视频文件 —— 填项目内路径或绝对路径`,
        })
      }
      if (!ctx.data.videoParams?.model?.trim()) {
        out.push({
          level: 'warn',
          nodeId: ctx.id,
          message: `视频节点「${ctx.data.title || ctx.id}」还没选视觉模型 —— 需要支持图片输入的多模态模型`,
        })
      }
      return out
    },
  },
  handoff: {
    // ★ 交接节点(v0.4.2):连接「图像节点」与「软件制作节点」的桥。
    // 把上游图像节点产出的图片(assets/generated/...)收集成素材清单,
    // 作为交接文本交给下游 —— 软件节点(project/feature/game/merge…)用
    // {{node:<id>}} 引用后,AI 制作/打包时按相对路径直接用这些素材。
    label: '交接',
    badge: {
      icon: 'handoff',
      text: '交接',
      cls: 'kind-handoff',
      title: '收集上游图片,交接给下游软件制作节点(不耗 token)',
    },
    ports: { target: 1, source: 1 },
    executor: 'builtin',
    action: 'handoff',
    payload: 'handoff',
    // 上游可以是图像节点(图片)或任何产生产物的节点;产出=素材清单文本
    accepts: ['handoff', 'artifacts', 'context'],
    defaultTitle: '交接节点',
    addEntries: [
      {
        key: 'handoff',
        label: '交接',
        icon: 'handoff',
        hint: '把图像节点生成的图片交接给软件制作节点:自动收集素材并生成清单,下游直接用',
      },
    ],
    defaultConfig: { handoffNote: '' },
    normalize: (m, raw) => ({
      ...m,
      handoffNote: typeof raw.handoffNote === 'string' ? raw.handoffNote : '',
    }),
    validate: (ctx) => {
      const out: GraphIssue[] = []
      if (!ctx.resolvedProjectDir) {
        out.push({
          level: 'warn',
          nodeId: ctx.id,
          message: `交接节点「${ctx.data.title || ctx.id}」要能访问项目素材:项目文件夹还没设`,
        })
      }
      return out
    },
  },
  prompt: {
    // ★ 生图工作区(v0.5.0):正向提示词节点 —— 纯数据源,不执行任何动作
    label: '正向提示词',
    badge: { icon: 'prompt', text: '正向', cls: 'kind-prompt', title: '生图工作区:画面要什么(纯文本,不出图)' },
    ports: { target: 0, source: 1 },
    executor: 'builtin',
    action: 'noop',
    payload: 'context',
    defaultTitle: '正向提示词',
    addEntries: [{ key: 'prompt', label: '正向提示词', icon: 'prompt', hint: '生图:写画面要什么,连到采样出图节点' }],
    defaultConfig: { promptText: '' },
    normalize: (m, raw) => ({ ...m, promptText: typeof raw.promptText === 'string' ? raw.promptText : '' }),
    validate: (ctx) => {
      if ((ctx.data.promptText ?? '').trim()) return []
      return [{ level: 'warn', nodeId: ctx.id, message: `「${ctx.data.title || ctx.id}」还没写正向提示词 —— 采样出图没有画面描述` }]
    },
  },
  prompt_negative: {
    // ★ 生图工作区(v0.5.0):负向提示词节点 —— 画面不要什么(纯数据源)
    label: '负向提示词',
    badge: { icon: 'prompt', text: '负向', cls: 'kind-prompt', title: '生图工作区:画面不要什么(纯文本,不出图)' },
    ports: { target: 0, source: 1 },
    executor: 'builtin',
    action: 'noop',
    payload: 'context',
    defaultTitle: '负向提示词',
    addEntries: [{ key: 'prompt_negative', label: '负向提示词', icon: 'prompt', hint: '生图:写画面不要什么(模糊/畸形等),连到采样出图节点' }],
    defaultConfig: { negativeText: 'blurry, low quality, deformed, watermark, text' },
    normalize: (m, raw) => ({
      ...m,
      negativeText: typeof raw.negativeText === 'string' ? raw.negativeText : (m.negativeText ?? ''),
    }),
    validate: (ctx) => {
      if ((ctx.data.negativeText ?? '').trim()) return []
      return [{ level: 'warn', nodeId: ctx.id, message: `「${ctx.data.title || ctx.id}」还没写负向提示词(可留空但建议填基础负面词)` }]
    },
  },
  sampler: {
    // ★ 生图工作区(v0.5.0):采样出图节点 —— 与 image 节点同一引擎(ImageGen),
    // 但提示词从上游的「正向/负向提示词」节点汇入,ComfyUI 式接法。
    label: '采样出图',
    badge: { icon: 'sampler', text: '采样', cls: 'kind-sampler', title: '生图工作区:合并上游提示词,用本地模型/API 出图(不耗 LLM 会话 token)' },
    ports: { target: 1, source: 1, targetMulti: true },
    executor: 'builtin',
    action: 'sampler',
    payload: 'artifacts',
    // 上游汇入的是提示词文本(context / handoff 都可作画面描述)
    accepts: ['context', 'handoff'],
    defaultTitle: '采样出图',
    addEntries: [
      {
        key: 'sampler',
        label: '采样出图',
        icon: 'sampler',
        hint: '生图:接正向/负向提示词,选择模型与参数出图(复用图像节点引擎)',
      },
    ],
    defaultConfig: {
      imageParams: { n: 1, size: '512x512' },
      imageProvider: { kind: 'local-command', command: '', cwd: '', timeoutSec: 600 },
    },
    normalize: (m, raw) => {
      const p = raw.imageProvider
      const provider: NonNullable<NodeConfig['imageProvider']> =
        p?.kind === 'http'
          ? {
              kind: 'http',
              endpoint: p.endpoint ?? '',
              method: p.method ?? 'POST',
              headers: p.headers ?? {},
              bodyTemplate: p.bodyTemplate ?? '',
              responsePath: p.responsePath ?? '',
              responseType: p.responseType ?? 'base64',
              format: p.format ?? 'png',
              timeoutSec: typeof p.timeoutSec === 'number' ? p.timeoutSec : 120,
            }
          : {
              kind: 'local-command',
              command: p?.command ?? '',
              cwd: p?.cwd ?? '',
              timeoutSec: typeof p?.timeoutSec === 'number' ? p.timeoutSec : 600,
            }
      return {
        ...m,
        imageParams: {
          n: clampN(raw.imageParams?.n ?? 1),
          size: typeof raw.imageParams?.size === 'string' ? raw.imageParams.size : '512x512',
          seed: typeof raw.imageParams?.seed === 'number' ? raw.imageParams.seed : undefined,
        },
        imageProvider: provider,
      }
    },
    validate: (ctx) => {
      const out: GraphIssue[] = []
      if (!ctx.resolvedProjectDir) {
        out.push({
          level: 'warn',
          nodeId: ctx.id,
          message: `采样出图节点「${ctx.data.title || ctx.id}」要有个地方存图:项目文件夹还没设`,
        })
      }
      const p = ctx.data.imageProvider
      const configured = p?.kind === 'http' ? !!p.endpoint?.trim() : !!p?.command?.trim()
      if (!configured) {
        out.push({
          level: 'warn',
          nodeId: ctx.id,
          message: `采样出图节点「${ctx.data.title || ctx.id}」还没配置出图方式(本地命令或 HTTP)`,
        })
      }
      return out
    },
  },
  image_output: {
    // ★ 生图工作区(v0.5.0):图片输出节点 —— 生图链的终点:扫描并列出已生成的素材
    label: '图片输出',
    badge: { icon: 'image_output', text: '图片输出', cls: 'kind-output', title: '生图工作区:输出已生成的图片清单(终点节点)' },
    ports: { target: 1, source: 0, targetMulti: true },
    executor: 'builtin',
    action: 'image-output',
    payload: 'artifacts',
    accepts: ['context', 'handoff', 'artifacts'],
    defaultTitle: '图片输出',
    addEntries: [
      {
        key: 'image_output',
        label: '图片输出',
        icon: 'image_output',
        hint: '生图:终点节点,列出本次生成的图片清单(图片已随项目保存)',
      },
    ],
    defaultConfig: {},
    normalize: (m) => m,
    validate: (ctx) => {
      if (ctx.resolvedProjectDir) return []
      return [
        {
          level: 'warn',
          nodeId: ctx.id,
          message: `图片输出节点「${ctx.data.title || ctx.id}」要能访问项目素材:项目文件夹还没设`,
        },
      ]
    },
  },
  subgraph: {
    // ★ Noodl 式的组件复用:一段图封装成一个可再用的节点
    label: '子图',
    badge: {
      icon: 'subgraph',
      text: '子图',
      cls: 'kind-subgraph',
      title: '一段被封起来的节点图:运行时展开成原来的节点执行',
    },
    /*
     * 端口 1 入 1 出(可多入):封装前那几个节点各自接了什么外部线,
     * 封装后由外部线整体接到子图节点上;展开时按 inMap/outMap 精确重接。
     */
    ports: { target: 1, source: 1, targetMulti: true },
    /*
     * 占位执行器:子图节点在 specFromGraph 阶段就被展开成平铺节点,
     * **永远不应该活着见到 runner**。给 'builtin' 是为了让 applyTypeDefaults
     * 不给它补 agent 字段(它自己不执行,内部节点才执行)。
     */
    executor: 'builtin',
    defaultTitle: '子图',
    /*
     * 刻意**不进添加菜单**(addEntries: [] 而不是省略 —— 省略会回落成
     * "一条默认入口"):空的子图没有意义,也没有入口往里塞节点。
     * 它的唯一来路是画布上「选中多个节点 → 封装成子图」。
     */
    addEntries: [],
    defaultConfig: {},
    normalize: (m, raw) => ({ ...m, subgraph: normalizeSubgraph(raw.subgraph) }),
    // V13:模板为空;V14:有上游但没有入口;V15:有下游但没有出口
    validate: (ctx) => {
      const out: GraphIssue[] = []
      const t = ctx.data.subgraph
      if (!t || t.nodes.length === 0) {
        // 文案与理由见 emptySubgraphMessage 的注释(两处必须逐字一致,故共用)
        out.push({
          level: 'warn',
          nodeId: ctx.id,
          message: emptySubgraphMessage(ctx.data.title || ctx.id),
        })
        return out
      }
      if (ctx.preds.length > 0 && t.entryIds.length === 0 && t.nodes.length > 0) {
        out.push({
          level: 'warn',
          nodeId: ctx.id,
          message: `子图「${ctx.data.title || ctx.id}」有上游连入,但内部没有入口节点 —— 外部输入进不去`,
        })
      }
      if (ctx.succs.length > 0 && t.exitIds.length === 0) {
        out.push({
          level: 'warn',
          nodeId: ctx.id,
          message: `子图「${ctx.data.title || ctx.id}」有下游连出,但内部没有出口节点 —— 它的产出交不出去`,
        })
      }
      return out
    },
  },
} satisfies Record<NodeKind, NodeTypeDef>

/**
 * 节点类型的**契约联合** —— 全应用唯一声明处;canvas.ts 只是把它再导出
 * (re-export),老 import 路径不变。
 *
 * ## 为什么不写 `keyof typeof NODE_TYPES`(踩过的坑,别改回去)
 *
 * 设计原意是从注册表**派生**(加一条声明,联合自动多一个字面量)。但
 * `NODE_TYPES` 要 `satisfies NodeTypeDef`,而 `NodeTypeDef` 必然引用
 * `NodeConfig`(`defaultConfig` / `normalize` 的入参),`NodeConfig.kind` 又是
 * `NodeKind` —— 于是形成一条类型解析环:
 *
 *   NodeKind ← keyof typeof NODE_TYPES ← NodeTypeDef ← NodeConfig ← kind: NodeKind
 *
 * TypeScript 在这种环上会**放弃推断**:实测报 `NODE_TYPES implicitly has type
 * 'any'` / `Type alias 'NodeKind' circularly references itself` /
 * `'kind' is referenced directly or indirectly in its own type annotation`。
 * 试过用 `Omit<NodeConfig,'kind'>` 破环 —— 无效,因为 `normalize` 仍要完整的
 * `NodeConfig`(它 spread 整个 merged 配置)。
 *
 * ## 改为「显式联合 + satisfies 双向钉死」,等价保证一条不少
 *
 *   - 少写一个 kind:它仍写在联合里,却不在 NODE_TYPES → `Record<NodeKind,
 *     NodeTypeDef>` 要求全键 → **编译错**;
 *   - 多写一个没在联合里的 kind:NODE_TYPES 有该键、NodeKind 没有 → 对象字面量
 *     的**多余属性检查** → **编译错**。
 *
 * 所以"加一个类型"仍然是「联合加一个字面量 + 本表加一条声明」两处(与架构文档
 * §任务要求一致),且两处必须同步 —— 编译器会逼着你两处一起改,漏一处就红。
 * 注意这里用的是 `satisfies` 而**不是** `const NODE_TYPES: Record<...> = …`
 * 注解:注解会把键退化成 string,`NODE_TYPES` 的取值/导航就失去字面量精度。
 */
export type NodeKind =
  | 'project'
  | 'feature'
  | 'merge'
  | 'output'
  | 'image'
  | 'review'
  | 'test'
  | 'doc'
  | 'game'
  | 'video'
  | 'handoff'
  | 'subgraph'
  | 'prompt'
  | 'prompt_negative'
  | 'sampler'
  | 'image_output'

/**
 * 取类型定义。未知 kind(手改 graph.json 写了 type:'foo')一律**回落 feature**
 * —— 与 migrateGraph / specFromGraph 的既有默认一致,避免 React Flow 因找不到
 * 组件而渲染失败(PRD §7)。
 */
export function getNodeType(kind: string): NodeTypeDef {
  return (NODE_TYPES as Record<string, NodeTypeDef>)[kind] ?? NODE_TYPES.feature
}

/**
 * 张数夹到 1..8。
 *
 * ⚠️ 必须先 `Number()` 再 `Number.isFinite` 判定 —— 用户输入来自磁盘(graph.json 可手改),
 * 可能是 `'abc'` / `NaN` / `Infinity`。旧写法 `Math.trunc(n || 1)` 对 `'abc'` 会算出
 * **NaN**(`'abc'` 是 truthy,不进 `|| 1` 分支,而 `Math.trunc('abc')` = NaN),于是
 * 一路传到 http 请求体变成 `{"n":NaN}`(**非法 JSON**)、localCommand 的 `{{n}}` 变成
 * 字符串 `NaN`。补默认值本来就是 normalize 的职责,吐 NaN 是把问题往下游推。
 */
function clampN(n: number): number {
  const v = Number(n)
  if (!Number.isFinite(v)) return 1
  return Math.max(1, Math.min(8, Math.trunc(v)))
}

/**
 * 内置动作节点的超时(秒)夹到 5..3600。
 *
 * 与 clampN 同一类守卫:值来自磁盘(graph.json 可手改),可能是 `'abc'` / `NaN` /
 * 负数 / 一个把子进程吊到天荒地老的巨大数。补默认值本来就是 normalize 的职责。
 */
function clampTimeout(n: unknown): number {
  const v = Number(n)
  if (!Number.isFinite(v)) return 300
  return Math.max(5, Math.min(3600, Math.trunc(v)))
}

/** 视频抽帧间隔(秒)夹到 1..300;取帧上限夹到 1..30 */
function clampFrames(n: unknown): number {
  const v = Number(n)
  if (!Number.isFinite(v)) return 8
  return Math.max(1, Math.min(30, Math.trunc(v)))
}

// ---------------------------------------------------------------------------
// 由注册表派生的**纯函数** —— 放在 shared 是为了让渲染端与 e2e 共用同一份实现
// (测的就是跑在应用里的那份,不是复制品)。它们都无副作用、无 React/Electron 依赖。
// ---------------------------------------------------------------------------

/**
 * 按类型补全一个节点的配置(把磁盘 / 手改的 raw 变成完整 `NodeConfig`)。
 *
 * 这是"类型默认值"的**唯一实现**:渲染端 `graphStore.normalizeConfig` 直接委托它,
 * e2e(T03)也直接调它。顺序(与升级前逐字段等价):
 *   ① 通用补 title(用 `def.defaultTitle`)与 kind;
 *   ② **会话类**节点补 agent 字段(内置动作节点 output / image / test **绝不补** ——
 *      它们的面板不得出现这些字段、调度也不该看,PRD §4.2);
 *   ③ 套 `def.defaultConfig`(该类型的默认字段);
 *   ④ 最后调 `def.normalize` 按类型精修(如 feature.mode、image.provider)。
 */
export function applyTypeDefaults(raw: unknown, kind: NodeKind): NodeConfig {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<NodeConfig>
  const def = getNodeType(kind)
  const title = typeof o.title === 'string' && o.title ? o.title : def.defaultTitle

  let cfg: NodeConfig = { title, kind }
  if (def.executor === 'session') {
    // ⚠️ 这几行的默认值必须与升级前**逐字相等**(P0-1 零回归);改动等于改用户画的图
    cfg.agentId = typeof o.agentId === 'string' && o.agentId ? o.agentId : 'claude'
    cfg.cwd = typeof o.cwd === 'string' ? o.cwd : ''
    cfg.promptTemplate = typeof o.promptTemplate === 'string' ? o.promptTemplate : ''
    cfg.permissionMode = o.permissionMode
    cfg.failurePolicy = o.failurePolicy ?? 'skip'
    cfg.retry = typeof o.retry === 'number' ? o.retry : 0
    /*
     * ⚠️ v0.4.0 的 model **只在原数据里就有值时才搬**,不给默认值。
     *
     * 给它补一个默认空串的话,所有老节点的 data 都会凭空多出一个字段,
     * 输出对象不再与升级前逐字相等 —— 而上面那条零回归要求是硬约束
     * (e2e 会逐字比对 normalize 的产物)。
     * 语义上也没损失:空串与 undefined 在 effectiveModel 里走同一条兜底。
     */
    if (typeof o.model === 'string' && o.model) cfg.model = o.model
  }
  cfg = { ...cfg, ...(def.defaultConfig ?? {}) }
  return def.normalize ? def.normalize(cfg, o) : cfg
}

/** 一个添加入口 + 它所属的 kind(菜单点击后 `addNode(kind, preset)`) */
export interface ResolvedAddEntry extends AddEntry {
  kind: NodeKind
}

/**
 * 添加入口列表 —— 由 `NODE_TYPES` 的 `addEntries` 生成(渲染端 Canvas 与 e2e 共用)。
 *
 * 一个 kind 可有**多个入口**(如 feature 的串行/并行);没有 `addEntries` 的类型
 * 回落到"一条 = 该类型本身"的默认入口 —— 于是任何新类型只要注册了就自动进菜单,
 * 不需要回来改 Canvas。顺序 = 注册表键的插入顺序。
 */
export function addEntryList(): ResolvedAddEntry[] {
  return (Object.keys(NODE_TYPES) as NodeKind[]).flatMap((kind) => {
    // 经 getNodeType 收窄成 NodeTypeDef(addEntries 可选;字面量联合类型里 merge 没有它)
    const def: NodeTypeDef = getNodeType(kind)
    const entries: AddEntry[] = def.addEntries ?? [{ key: kind, label: def.label, hint: '' }]
    return entries.map((e) => ({ kind, ...e }))
  })
}

// ---------------------------------------------------------------------------
// 双工作区(v0.5.0):生图 / 软件制作 两个独立页面,各自限定自己的节点集合。
// 画布 id = `<projectId>-<workspace>`(projectId 为 default 且 workspace 为 app
// 时兼容旧画布,直接用 'default')。
// ---------------------------------------------------------------------------

export type WorkspaceId = 'app' | 'image'

export const WORKSPACE_LABEL: Record<WorkspaceId, string> = {
  app: '软件制作',
  image: '生图',
}

/** 每个工作区可见的节点类型集合(添加入口菜单 / 校验白名单共用) */
export const WORKSPACE_NODES: Record<WorkspaceId, readonly NodeKind[]> = {
  app: [
    'project',
    'feature',
    'merge',
    'output',
    'image',
    'review',
    'test',
    'doc',
    'game',
    'video',
    'handoff',
    'subgraph',
  ],
  image: ['prompt', 'prompt_negative', 'sampler', 'image_output', 'handoff'],
}

/** 某工作区的添加入口列表(Canvas 添加菜单与 e2e 共用) */
export function workspaceNodeList(ws: WorkspaceId): ResolvedAddEntry[] {
  const allowed = new Set(WORKSPACE_NODES[ws])
  return addEntryList().filter((e) => allowed.has(e.kind))
}

/** 画布 id = 项目 + 工作区;default 项目的 app 工作区兼容旧画布 'default' */
export function canvasIdFor(projectId: string, ws: WorkspaceId): string {
  if (projectId === 'default' && ws === 'app') return 'default'
  return `${projectId}-${ws}`
}

/**
 * 连线合法性(端口方向)—— **由注册表的 `ports` 推导**;非法返回一句人话,合法返回 null。
 *
 * 渲染端 `onConnect` 用它**当场拒绝**(交互层的拒绝要看得见,不能等运行前才提示);
 * e2e(T03)也直接断言它。规则通用:
 *   - `ports.source === 0`:该类型是**终点**,没有输出端口 → 不许往下游连线;
 *   - `ports.target === 0`:该类型是**源头**,没有输入端口 → 不许被连入。
 * 于是任何未来 `source:0` / `target:0` 的类型自动生效,不必手写 if。
 */
export function connectionError(srcKind: string, tgtKind: string, srcTitle: string, tgtTitle: string): string | null {
  const srcDef = getNodeType(srcKind)
  const tgtDef = getNodeType(tgtKind)
  if (srcDef.ports.source === 0) return `「${srcTitle}」是${srcDef.label}节点(终点),不能往下游连线`
  if (tgtDef.ports.target === 0) return `「${tgtTitle}」是${tgtDef.label}节点(源头),不能被别的节点连入`
  return null
}

/**
 * 连线**语义**警告(类型化端口)—— 组合可疑返回一句人话,正常返回 null。
 *
 * 与 `connectionError` 的本质差别:那是**端口方向**错(结构上就接不上,onConnect
 * 当场拒线);这是**携带物语义**错 —— 线已经连上了、跑也跑得动,但十有八九不是
 * 用户想要的(比如把测试报告喂给图像节点当画面描述)。
 *
 * 所以它**只提醒、不阻断**:AI 工作流里偶尔要故意混搭(让节点把测试日志总结
 * 成一段描述再出图,是合法用法),硬禁会把这类用法一起挡掉。
 * 渲染端 onConnect 用它给黄色提示;validateGraph 也调它做运行前兜底(同一份规则)。
 */
export function connectionWarning(
  srcKind: string,
  tgtKind: string,
  srcTitle: string,
  tgtTitle: string,
): string | null {
  const srcDef = getNodeType(srcKind)
  const tgtDef = getNodeType(tgtKind)
  const p = srcDef.payload
  if (!p || !tgtDef.accepts) return null
  if (tgtDef.accepts.includes(p)) return null
  return (
    `「${srcTitle}」交给下游的是${PAYLOAD_LABEL[p]},「${tgtTitle}」要的却是别的 —— ` +
    '这条线语义可疑(已保留,不阻断;若是故意的可忽略)'
  )
}

// ---------------------------------------------------------------------------
// 内置模板工作流(v0.6.0):一键铺图。
// 参考 Langflow / Coze 的模板市场 —— 常用骨架做成"一键生成",新用户不用从零搭。
// e2e 直接断言模板结构(节点数 / 连线数 / 工作区归属)。
// ---------------------------------------------------------------------------

export interface WorkflowTemplateNode {
  kind: NodeKind
  /** 留空 = 自动按注册表 defaultTitle 编号 */
  title?: string
  pos: { x: number; y: number }
  preset?: Partial<NodeConfig>
}

export interface WorkflowTemplate {
  label: string
  desc: string
  /** 模板归属工作区:套用时须在该页(防止生图模板铺到软件页) */
  workspace: WorkspaceId
  nodes: WorkflowTemplateNode[]
  /** 边 = 节点下标对 [from, to] */
  edges: [number, number][]
}

export const WORKFLOW_TEMPLATES: Record<string, WorkflowTemplate> = {
  'desktop-app': {
    label: '桌面应用(打包 exe)',
    desc: '项目 → 生成 Electron 应用 → 审查 → 测试 → 输出 exe,一条完整桌面软件流水线',
    workspace: 'app',
    nodes: [
      {
        kind: 'project',
        title: '项目 1(桌面应用)',
        pos: { x: 40, y: 60 },
        preset: { brief: '一个简洁的桌面待办事项应用 —— 生成可直接打包成 Windows exe 的 Electron 应用(package.json + main.js + index.html)' },
      },
      { kind: 'feature', title: '功能 1(生成应用代码)', pos: { x: 360, y: 60 } },
      { kind: 'review', title: '审查 1', pos: { x: 680, y: 60 } },
      { kind: 'test', title: '测试 1', pos: { x: 1000, y: 60 } },
      { kind: 'output', title: '输出 1(exe)', pos: { x: 1320, y: 60 }, preset: { buildTarget: 'exe' } },
    ],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
    ],
  },
  'mobile-web': {
    label: '手机 / 网页应用',
    desc: '项目 → 生成 Web 应用 → 输出 Web 站点(手机浏览器即用 / 可进一步打 APK)',
    workspace: 'app',
    nodes: [
      {
        kind: 'project',
        title: '项目 1(网页应用)',
        pos: { x: 40, y: 60 },
        preset: { brief: '一个手机友好的网页应用 —— 单页 HTML(index.html + 内联样式与脚本),界面适配 375px 手机屏' },
      },
      { kind: 'feature', title: '功能 1(生成 Web 应用)', pos: { x: 360, y: 60 } },
      { kind: 'output', title: '输出 1(Web)', pos: { x: 680, y: 60 }, preset: { buildTarget: 'web' } },
    ],
    edges: [
      [0, 1],
      [1, 2],
    ],
  },
  'pixel-game': {
    label: '像素小游戏',
    desc: '项目 → 本地模型出像素素材 → 交接 → 游戏 → 输出 Godot 项目 zip',
    workspace: 'app',
    nodes: [
      { kind: 'project', title: '项目 1(像素游戏)', pos: { x: 40, y: 60 }, preset: { brief: '一个像素风格的迷宫寻宝小游戏(Godot 4.x,GDScript)' } },
      { kind: 'image', title: '图像 1(出像素素材)', pos: { x: 360, y: 60 } },
      { kind: 'handoff', title: '交接 1(素材清单)', pos: { x: 680, y: 60 } },
      { kind: 'game', title: '游戏 1', pos: { x: 1000, y: 60 } },
      { kind: 'output', title: '输出 1(游戏 zip)', pos: { x: 1320, y: 60 }, preset: { buildTarget: 'game' } },
    ],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
    ],
  },
  'image-flows': {
    label: '生图工作流',
    desc: '正向 / 负向提示词 → 采样出图 → 图片输出(本地模型直出)',
    workspace: 'image',
    nodes: [
      { kind: 'prompt', title: '正向提示词 1', pos: { x: 40, y: 60 }, preset: { promptText: 'pixel art, warm light, high detail' } },
      { kind: 'prompt_negative', title: '负向提示词 1', pos: { x: 40, y: 320 } },
      { kind: 'sampler', title: '采样出图 1', pos: { x: 380, y: 180 } },
      { kind: 'image_output', title: '图片输出 1', pos: { x: 720, y: 180 } },
    ],
    edges: [
      [0, 2],
      [1, 2],
      [2, 3],
    ],
  },
}
