import { useEffect, useMemo, useState, type JSX } from 'react'
import { useGraphStore } from '../../stores/graphStore'
import { useRuntimeStore } from '../../stores/runtimeStore'
import { useUiStore } from '../../stores/uiStore'
import { CwdPicker } from './CwdPicker'
import { ModelCombobox } from './ModelCombobox'
import type { AgentListEntry, ModelDef, PermissionMode } from '../../types'
import { mergeModelCandidates, providerOfAgent } from '../../types'
import { unwrap } from '../../lib/unwrap'
import { FeatureConfig } from './FeatureConfig'
import { PANEL_BY_KIND } from './panelRegistry'
import { Icon } from '../Icons'

/**
 * 右栏配置面板:按节点类型分派的**薄壳**(P0-7)。
 *
 * 每种 kind 的字段差异全部下沉到各自的子面板;这里只保留"所有面板都要"的
 * 前置判断(节点还在吗)和共享控件 —— 共享控件从 AgentNode 时代的单文件
 * 里拆出来,就是为了让四个子面板引用同一份实现,而不是互相拷贝。
 */

/**
 * 实测自 `claude --help`(2.1.289)。⚠️ 没有 "default",写错会直接启动失败。
 * 这里只列对用户有意义的几个 —— 全列出来反而选不明白。
 */
export const MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'acceptEdits', label: '接受编辑', hint: '自动允许改文件,其它操作照常询问(默认)' },
  { value: 'plan', label: '只做计划', hint: '不改任何文件,只给出方案' },
  { value: 'dontAsk', label: '不询问', hint: '不做权限询问,可能被直接拒绝' },
  { value: 'bypassPermissions', label: '全部放行', hint: '跳过所有权限检查,谨慎使用' },
]

/**
 * 把变量插到模板的**光标处**,而不是简单地追加到末尾。
 *
 * 追加到末尾的话,用户得自己再剪切粘贴到想要的位置 —— 那还不如直接手打。
 * selectionStart 在受控 textarea 上是可靠的(React 不会重置它),
 * 但焦点已经移走时它是 null,所以兜底成"接在最后"。
 *
 * ⚠️ 选择器按 `.node-config textarea.tpl` 找:右栏同一时刻只挂一个配置面板,
 * 取第一个就是当前正在编辑的那个模板框。
 */
export function insertVar(nodeId: string, token: string): void {
  const el = document.querySelector<HTMLTextAreaElement>('.node-config textarea.tpl')
  const cur = useGraphStore.getState().nodes.find((n) => n.id === nodeId)?.data.promptTemplate ?? ''
  const at = el?.selectionStart ?? cur.length
  const end = el?.selectionEnd ?? at
  const next = cur.slice(0, at) + token + cur.slice(end)
  useGraphStore.getState().patchConfig(nodeId, { promptTemplate: next })
  // 插完把光标放到插入内容之后,连续插多个变量时顺序才自然
  if (el) {
    const pos = at + token.length
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }
}

/** 直接上游列表。拼字符串做依赖 + useMemo 派生数组,原因见 useGraphIssues 的注释 */
export function useUpstreams(nodeId: string): { id: string; title: string }[] {
  const upstreamKey = useGraphStore((s) =>
    s.edges
      .filter((e) => e.target === nodeId)
      .map((e) => {
        const title = s.nodes.find((n) => n.id === e.source)?.data.title ?? e.source
        // \u0000 分隔 id 与标题,\u0001 分隔多个上游 —— 两者都不会出现在节点名里
        return `${e.source}\u0000${title}`
      })
      .join('\u0001'),
  )
  return useMemo(() => {
    if (!upstreamKey) return []
    return upstreamKey.split('\u0001').map((pair) => {
      const at = pair.indexOf('\u0000')
      return { id: pair.slice(0, at), title: pair.slice(at + 1) }
    })
  }, [upstreamKey])
}

/** 节点名。四种节点通用 */
export function TitleField({ nodeId, value }: { nodeId: string; value: string }): JSX.Element {
  const patchConfig = useGraphStore((s) => s.patchConfig)
  return (
    <label className="cfglabel">
      <span>节点名</span>
      <input
        value={value}
        onChange={(e) => patchConfig(nodeId, { title: e.target.value })}
        placeholder="给这个节点起个名字"
      />
    </label>
  )
}

/** Agent 下拉。输出节点没有这个字段(它不走会话) */
export function AgentField({ nodeId, value }: { nodeId: string; value?: string }): JSX.Element {
  const patchConfig = useGraphStore((s) => s.patchConfig)
  const [agents, setAgents] = useState<AgentListEntry[]>([])
  const running = useRuntimeStore((s) => s.runtimes[nodeId]?.status === 'running')

  useEffect(() => {
    void (async () => {
      const res = await window.api.agents.list()
      if (res.ok) setAgents(res.data)
    })()
  }, [])

  /*
   * 按 groupLabel 分组渲染 <optgroup>。
   *
   * v0.4.0 起列表里混了 CLI 工具和云端服务商十几项,平铺下来是一长条
   * 看不出结构的名字。分组标题由主进程给(契约里就带着),这里只负责
   * 照分组标题切一刀 —— 渲染进程不判断"谁该跟谁一组",那会多出一份会漂移的逻辑。
   */
  const groups = useMemo(() => {
    const m = new Map<string, AgentListEntry[]>()
    for (const a of agents) {
      const arr = m.get(a.groupLabel)
      if (arr) arr.push(a)
      else m.set(a.groupLabel, [a])
    }
    return [...m.entries()]
  }, [agents])

  /** 没配 Key / 没装的项加个尾巴标注 —— 允许选,但让用户先知道要补什么 */
  const suffixOf = (a: AgentListEntry): string => {
    if (a.kind === 'api') return a.keyReady ? '' : ' · 未配 Key'
    return a.installed === false ? ' · 未安装' : ''
  }

  /** 当前选中的那一项。用来决定是否挂"未实测"提示 */
  const current = agents.find((a) => a.id === (value ?? 'claude'))

  return (
    <>
      <label className="cfglabel">
        <span>Agent</span>
        <select
          value={value ?? 'claude'}
          onChange={(e) => {
            const next = e.target.value
            if (next === (value ?? 'claude')) return
            /*
             * 换 agent 时把 model 清掉:模型名是**跟服务商绑定的**,
             * 把 DeepSeek 的模型名留着去发 Anthropic 的请求 = 必然 404,
             * 而且报错发生在运行那一刻,用户很难联想到"是我刚才换了服务商"。
             * 清掉后 ModelField 会显示"用默认",语义始终自洽。
             */
            patchConfig(nodeId, { agentId: next, model: '' })
          }}
          disabled={running}
        >
          {agents.length === 0 && <option value="claude">claude</option>}
          {groups.map(([label, list]) => (
            <optgroup key={label} label={label}>
              {list.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                  {suffixOf(a)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {current?.verified === false && (
        <div className="fhint">
          这个 CLI 是按官方文档接入的,<b>未在本机实测</b>。跑不通时先确认它升过版:
          <code>{current.displayName}</code> 的启动参数可能已经变了。
        </div>
      )}
    </>
  )
}

/**
 * 模型选择。**只在 Agent 选成 API 型时出现**。
 *
 * CLI 型 agent 的模型不归我们管(它自己读配置),所以这里对非 API 型直接返回 null。
 *
 * 三件事都在这里兜住:
 *   1. 模型输入框 —— 可直接敲 + 实时过滤候选(见 ModelCombobox 的顶部注释:
 *      方舟接入点数量不限且**不在任何可拉取的列表里**,原生 `<select>` 翻不到);
 *   2. 列表来源说清楚 —— 拉不到时用户看到的与拉到了长得一模一样,他分不出来,
 *      于是选错了要等到运行时才报模型名不对;
 *   3. Key 没配的警告 —— 这里是最容易踩的点:用户在节点上选了服务商、开跑,
 *      然后卡在 401。把提示前移到选择现场,而不是等运行报错。
 */
export function ModelField({
  nodeId,
  agentId,
  value,
}: {
  nodeId: string
  agentId?: string
  value?: string
}): JSX.Element | null {
  const patchConfig = useGraphStore((s) => s.patchConfig)
  const running = useRuntimeStore((s) => s.runtimes[nodeId]?.status === 'running')
  const provider = providerOfAgent(agentId)

  const [models, setModels] = useState<ModelDef[]>(() => provider?.models ?? [])
  const [keyReady, setKeyReady] = useState<boolean | null>(null)
  /**
   * 这份列表是**服务端刚拉的**还是**回落的内置清单**。
   *
   * 候选角标直接用它 —— 角标必须说的是主进程的原话,不能由组件自己猜,
   * 否则两处判断会漂移,出现"标着内置、实际是实时的"这种反向错误。
   */
  const [listSource, setListSource] = useState<'remote' | 'builtin'>('builtin')
  /**
   * 拉取失败的原因(= 现在显示的是内置清单)。
   *
   * 之前这里失败只 `catch {}` 掉,用户看到的就是一个和内置清单长得一样的下拉框,
   * 分不清"这是它真实支持的模型"还是"我们内置的、可能过期的名字"。
   */
  const [listFallback, setListFallback] = useState<string | null>(null)
  /**
   * 设置页里探测验证过可用的模型。
   *
   * 存的是**只有 ok 那一档**(见 shared/probe.ts):跳过与不可用的都不存,
   * 因为"跳过"的真实语义是"这次没测出来",存下来会让用户以为
   * "已经验过、不可用"。所以这份列表里的每一条都是**确定能用**的。
   */
  const [verified, setVerified] = useState<string[]>([])

  const providerId = provider?.id

  useEffect(() => {
    if (!providerId) return
    const def = providerOfAgent(agentId)
    if (def) {
      setModels(def.models)
      setListSource('builtin')
    }
    setListFallback(null)
    let alive = true
    void (async () => {
      // 这两次查询互不依赖,失败也只影响提示,不阻断选择 —— 各自 try 掉
      try {
        const list = unwrap(await window.api.providers.list())
        const v = list.find((x) => x.def.id === providerId)
        if (alive && v) {
          setKeyReady(v.secret.hasKey || v.def.optionalKey)
          /*
           * 探测验证过可用的模型一起取回。
           *
           * 这是"设置页探明 → 节点上直接选"那条链路的终点:用户在设置页跑一轮
           * 探测,这里就能在下拉里看到那批**确定能用**的模型,不必再对着
           * 一堆没验过的名字猜哪个对。
           */
          setVerified(v.verifiedModels ?? [])
        }
      } catch {
        /* 拿不到状态就不提示,不挡着用户选模型 */
      }
      try {
        /*
         * 不传 override:主进程会自己回落**用户保存的 Base URL**
         * (见 ipc/register.ts 的 providerModels)。这里传空反而会盖掉它,
         * 于是用户改过地址的站点在设置页能拉到、在这个面板里却拉内置清单。
         */
        const r = unwrap(await window.api.providers.models(providerId))
        if (!alive) return
        if (r.models.length > 0) setModels(r.models)
        setListSource(r.source)
        setListFallback(r.source === 'builtin' ? (r.message ?? '当前显示的是内置清单') : null)
      } catch (e) {
        if (alive) setListFallback(`拉取真实模型列表失败:${(e as Error).message}`)
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- value 只在切换 agentId 时需要重读,不跟着每次敲字跑
  }, [providerId, agentId])

  /*
   * ⚠️ useMemo 必须放在 `if (!provider) return null` **之前**。
   *
   * React #310(Rendered more hooks than during the previous render)就死在这:
   * agent 从 CLI 型(claude)换成 API 型(api:deepseek)时,provider 从 undefined
   * 变 defined —— 条件 return 让上一次渲染停在 useEffect(14 个 hook),
   * 下一次却继续走到 useMemo(15 个 hook),同一组件两次渲染 hooks 数不同,
   * React 直接崩掉整棵组件树。useMemo 只依赖 verified/models/listSource,
   * 与 provider 无关,提前执行是安全的。
   */
  const candidates = useMemo(
    () =>
      mergeModelCandidates([
        /*
         * ⚠️ source 必须标 'verified',不能标 'custom':
         * 角标与配色跟着 source 走 —— 'verified' 是绿色 ok 角标 + "已验证",
         * 'custom' 是中性灰"手填"。探测过 = 有服务端回执,是候选里最可信的一档,
         * 标成手填等于把这份证据藏起来(见 ModelCombobox.tsx 顶部 SourceBadge 注释)。
         * tag 也不挂:角标已经显示"已验证",再挂同名 tag 是重复信息。
         */
        { source: 'verified', models: verified.map((id) => ({ id, label: id })) },
        { source: listSource, models },
      ]),
    [verified, models, listSource],
  )

  if (!provider) return null

  /** "用默认"那一档要显示的名字。与 effectiveModel 的回落顺序一致(内置首选) */
  const fallbackId = provider.models[0]?.id ?? ''
  const defaultLabel = candidates.find((m) => m.id === fallbackId)?.label ?? fallbackId

  return (
    <>
      <label className="cfglabel">
        <span>模型</span>
        {/*
         * 值原样回填、输入原样送出 —— 换 agent 时清空 model 的既有行为
         * (见 AgentField 的注释:模型名是跟服务商绑定的)由 store 那侧保证,
         * 这里不额外干预,免得两处都写一遍清空逻辑。
         */}
        <ModelCombobox
          value={value}
          candidates={candidates}
          onChange={(next) => patchConfig(nodeId, { model: next })}
          disabled={running}
          defaultLabel={defaultLabel}
        />
      </label>
      <div className="fhint">
        {verified.length > 0 && (
          <span className="ok">
            <Icon name="check" size={12} />
            有 {verified.length} 个模型在「设置 ›模型服务商」里探测验证过可用,已排在候选最前。
            {/*
             * A3:「用已验证的第一个」—— 探测验证过了就直接选用,不必在下拉里找。
             * 只在当前值不是已验证模型时显示(已经是了就不用再点)。
             */}
            {!verified.some((id) => id === value) && (
              <button
                type="button"
                className="tiny-link"
                onClick={() => patchConfig(nodeId, { model: verified[0] })}
                disabled={running}
                title="选第一个验证通过的模型"
              >
                用已验证的第一个({verified[0].length > 18 ? `${verified[0].slice(0, 18)}…` : verified[0]})
              </button>
            )}
          </span>
        )}
        {listFallback && (
          <span className="warn">
            <Icon name="alert" size={12} />
            {listFallback} —— 直接在上面的框里敲名字或粘贴接入点 id 即可,不必受这份清单限制。
          </span>
        )}
        {keyReady === false && (
          <span className="warn">
            <Icon name="alert" size={12} />
            还没配置 {provider.label} 的 API Key —— 去「设置 ›模型服务商」填好再跑。
          </span>
        )}
      </div>
    </>
  )
}

/** 权限模式。输出节点没有这个字段 */
export function PermissionField({ nodeId, value }: { nodeId: string; value?: PermissionMode }): JSX.Element {
  const patchConfig = useGraphStore((s) => s.patchConfig)
  const running = useRuntimeStore((s) => s.runtimes[nodeId]?.status === 'running')
  const current = value ?? 'acceptEdits'
  return (
    <>
      <label className="cfglabel">
        <span>权限模式</span>
        <select
          value={current}
          onChange={(e) => patchConfig(nodeId, { permissionMode: e.target.value as PermissionMode })}
          disabled={running}
        >
          {MODES.map((m) => (
            <option key={m.value} value={m.value} title={m.hint}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <div className="fhint">{MODES.find((m) => m.value === current)?.hint}</div>
    </>
  )
}

/** Prompt/合并模板 + 变量按钮。变量按钮是"连线在提示词里怎么用"的唯一可见入口 */
export function TplField({
  nodeId,
  value,
  label = 'Prompt 模板(工作流里用)',
  placeholder = '留空 = 把上游产出直接当提示词\n可用 {{input}} {{prev}} {{node:<id>}}',
  rows = 3,
}: {
  nodeId: string
  value?: string
  label?: string
  placeholder?: string
  rows?: number
}): JSX.Element {
  const patchConfig = useGraphStore((s) => s.patchConfig)
  const upstreams = useUpstreams(nodeId)
  return (
    <>
      <label className="cfglabel col">
        <span>{label}</span>
        <textarea
          className="tpl"
          rows={rows}
          value={value ?? ''}
          placeholder={placeholder}
          onChange={(e) => patchConfig(nodeId, { promptTemplate: e.target.value })}
          spellCheck={false}
        />
      </label>

      <div className="tpl-vars">
        <span className="hint">点一下插到光标处:</span>
        <button className="mini" onClick={() => insertVar(nodeId, '{{input}}')} title="所有上游产出 + 这次运行的输入">
          input
        </button>
        <button className="mini" onClick={() => insertVar(nodeId, '{{prev}}')} title="直接上游的产出">
          prev
        </button>
        {upstreams.map((u) => (
          <button
            key={u.id}
            className="mini"
            onClick={() => insertVar(nodeId, `{{node:${u.id}}}`)}
            title={`只取「${u.title}」的产出`}
          >
            {u.title}
          </button>
        ))}
      </div>

      <div className="fhint">
        这是<b>工作流</b>跑的时候用的模板,不影响你在下面手动对话。
        {upstreams.length === 0 && ' 这个节点还没有上游 —— 拉一条线进来,上面就会多出可点的按钮。'}
      </div>
    </>
  )
}

/** 上游失败策略 + 重试。Agent 类节点专用;输出节点不适用(它不跑会话) */
export function FailureRetryRow({ nodeId, failurePolicy, retry }: {
  nodeId: string
  failurePolicy?: 'stop' | 'skip' | 'continue'
  retry?: number
}): JSX.Element {
  const patchConfig = useGraphStore((s) => s.patchConfig)
  return (
    <div className="cfgrow">
      <label className="cfglabel">
        <span>上游失败时</span>
        <select
          value={failurePolicy ?? 'skip'}
          onChange={(e) =>
            patchConfig(nodeId, { failurePolicy: e.target.value as 'stop' | 'skip' | 'continue' })
          }
        >
          <option value="skip">跳过下游</option>
          <option value="stop">整条停止</option>
          <option value="continue">当空产出继续</option>
        </select>
      </label>

      <label className="cfglabel narrow">
        <span>重试</span>
        <input
          type="number"
          min={0}
          max={5}
          value={retry ?? 0}
          onChange={(e) => patchConfig(nodeId, { retry: Number(e.target.value) })}
        />
      </label>
    </div>
  )
}

/** sessionId(只读)—— 输出节点没有会话,不显示这一行 */
export function SessionRow({ nodeId }: { nodeId: string }): JSX.Element {
  const sessionId = useRuntimeStore((s) => s.runtimes[nodeId]?.sessionId ?? null)
  return (
    <div className="kv">
      <span className="k">sessionId</span>
      <span className="v">{sessionId ?? '(未开始)'}</span>
    </div>
  )
}

/** 删除按钮。四种节点通用 */
export function DeleteRow({ nodeId }: { nodeId: string }): JSX.Element {
  const removeNode = useGraphStore((s) => s.removeNode)
  const select = useUiStore((s) => s.select)
  return (
    <button
      className="danger"
      onClick={() => {
        removeNode(nodeId)
        select(null)
      }}
    >
      删除这个节点
    </button>
  )
}

/**
 * Agent 类节点的通用字段块(节点名之外):Agent / cwd / 权限 / 模板 / 失败重试 / sessionId。
 *
 * cwd 的展示按 kind 有差异,由 `cwd` prop 决定:
 *   - 'picker':可覆盖(CwdPicker,fallback = 解析后的项目文件夹)—— project 节点不用它;
 *   - 'readonly':只读展示"继承项目文件夹"(feature / merge)。
 * 用参数而不是让三个面板各写一遍字段序列:字段顺序和提示文案也是契约的一部分。
 */
export function AgentCommonFields({
  nodeId,
  agentId,
  model,
  permissionMode,
  promptTemplate,
  failurePolicy,
  retry,
  cwd,
  cwdMode,
  tplLabel,
  tplPlaceholder,
}: {
  nodeId: string
  agentId?: string
  /** 仅 API 型 agent 有意义;CLI 型忽略(见 ModelField) */
  model?: string
  permissionMode?: PermissionMode
  promptTemplate?: string
  failurePolicy?: 'stop' | 'skip' | 'continue'
  retry?: number
  /** 当前生效的工作目录(解析后的项目文件夹或节点覆盖值) */
  cwd: string
  cwdMode: 'picker' | 'readonly'
  tplLabel?: string
  tplPlaceholder?: string
}): JSX.Element {
  const running = useRuntimeStore((s) => s.runtimes[nodeId]?.status ?? 'idle') === 'running'
  const turns = useRuntimeStore((s) => s.runtimes[nodeId]?.turns ?? 0)
  const patchConfig = useGraphStore((s) => s.patchConfig)
  // 节点自己的 cwd 覆盖值单独订阅(字符串,走 Object.is)
  const ownCwd = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId)?.data.cwd ?? '')
  // cwd 决定 --resume 能不能接上,会话开始后锁死。要改必须先「新会话」
  const cwdLocked = running || turns > 0

  return (
    <>
      <AgentField nodeId={nodeId} value={agentId} />

      {/* 只有 API 型 agent 才渲染(CLI 型的模型不归我们管);非 API 时它是 null */}
      <ModelField nodeId={nodeId} agentId={agentId} value={model} />

      {cwdMode === 'readonly' ? (
        /*
         * feature / merge 的工作目录**继承项目文件夹**(共享,无隔离)。
         * 不给选择器:v2 语义里改它就是把自己从项目里拆出去,那是旧模型的
         * 特例路径;真要特例,走 P1 的"展开覆盖"再说。
         */
        <div className="cfglabel col">
          <span>工作目录</span>
          <div className="cwd-picker">
            <div className={`cwd-value ${cwd ? '' : 'unset'}`} title={cwd || '上游项目节点还没选文件夹'}>
              {cwd || '继承项目文件夹(未设置)'}
            </div>
          </div>
          <div className="fhint">继承项目节点锚定的项目文件夹(串行/并行/整合共享同一份代码)</div>
        </div>
      ) : (
        <div className="cfglabel col">
          <span>工作目录</span>
          <CwdPicker
            value={ownCwd}
            fallback={cwd}
            onChange={(next) => patchConfig(nodeId, { cwd: next })}
            disabled={cwdLocked}
          />
          {cwdLocked && (
            <div className="fhint warn">
              cwd 决定 <code>--resume</code> 能否接上,会话开始后已锁定。要改请先「新会话」。
            </div>
          )}
        </div>
      )}

      <PermissionField nodeId={nodeId} value={permissionMode} />

      <TplField
        nodeId={nodeId}
        value={promptTemplate}
        label={tplLabel}
        placeholder={tplPlaceholder}
      />

      <FailureRetryRow nodeId={nodeId} failurePolicy={failurePolicy} retry={retry} />

      <SessionRow nodeId={nodeId} />
    </>
  )
}

/** 配置面板入口:按节点类型分派 —— **读注册表映射**,不再 switch(去散点) */
export function NodeConfigPanel({ nodeId }: { nodeId: string }): JSX.Element | null {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId))

  if (!node) return null

  // 未知 type 兜 feature:手改数据缺 kind 的节点按旧语义(= feature)处理,
  // 与 getNodeType / migrateGraph / specFromGraph 的默认一致
  const Panel = PANEL_BY_KIND[node.type] ?? FeatureConfig
  return <Panel nodeId={nodeId} />
}
