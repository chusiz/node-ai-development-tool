import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import type {
  AgentSettings,
  ModelDef,
  ProbeReport,
  ProbeResult,
  ProviderView,
  ProviderTestResult,
  SecretStoreInfo,
} from '../../types'
import {
  PROVIDER_GROUPS,
  providersInGroup,
  envKeyName,
  looksLikeKey,
  estimateProbeCost,
  groupProbeResults,
  pickFirstAvailable,
  PROBE_VERDICT_LABEL,
  verifiedModelIds,
} from '../../types'
import { ModelCombobox, buildCandidates } from '../NodeConfig/ModelCombobox'
import { unwrap } from '../../lib/unwrap'
import { Icon } from '../Icons'

/**
 * 「自带 Key 直连云端模型」的服务商管理。
 *
 * ## 这个分区要回答的三个问题
 *
 *   1. **我填了没有?** —— 每家一个状态徽标(已配置 / 未配置 / 来自环境变量);
 *   2. **填的对不对?** —— 一个「测试」按钮,真发一次最小请求,把 401 / 404 / 超时
 *      翻成人话(原始报错是「fetch failed」这种,等于没说);
 *   3. **它把 Key 存哪了?** —— 顶部一条密钥库说明,加密与否如实写出来。
 *
 * ## 为什么 Key 的写入是"立即"的,而地址 / 默认模型是"跟着保存走"
 *
 * Key 与其它设置存在两个不同的地方:Key 进加密的 `secrets.json`,地址与默认模型
 * 进可分享的 `settings.json`(见 shared/secrets.ts 顶部)。所以 Key 一填就落盘
 * (走 IPC 直存),而地址 / 默认模型改的是本页的**草稿**,点右下「保存」才写。
 * 把 Key 也塞进草稿会逼着我们把它序列化进 settings,那正是要避免的事情。
 */

/**
 * 「模型来源」那一行小字的措辞。
 *
 * ## 为什么必须一眼看出"这份列表是真是假"
 *
 * 用户报的原话是"明明配置了服务商却用不了,运行时报模型名不对"。而这两种列表
 * **长得一模一样** —— 都是一个下拉框,默认模型都选了第一项,界面上没有任何区别。
 * 用户没有任何线索知道自己选的是内置清单(可能已经过期半年),于是只能反复重装、
 * 反复换 Key,而真正该做的是"去把它自己网关的真实模型名填进去"。
 *
 * 所以这里用能一眼分辨的说法:**说清数量、说清来源、说清下一步**。
 * 尤其 `builtin` 那条不能写成"可能滞后"这种轻描淡写的话 ——
 * 用户看到"可能"会理解为"大概没事",而实际上这份列表**正在**让他的节点跑不起来。
 */
function sourceNote(source: 'remote' | 'builtin', n: number): string {
  return source === 'remote'
    ? `已拉取服务端真实列表(${n} 个)`
    : `当前显示的是内置清单(${n} 个,不是实时的)`
}

/**
 * 探测结果的三组展示。
 *
 * ## 为什么必须分成三组,而且第三组要单独解释
 *
 * 用户真正要分辨的是**两件不同的事**:
 *   - 「这个模型服务端不认」→ 别选它(第 2 组);
 *   - 「这次没测出来」→ **不知道**,得再试(第 3 组)。
 *
 * 把后两者混在一张"不可用"列表里,一次限流就会让用户把能用的模型全删掉 ——
 * 而他其实什么都不知道。方向错了,比没测更糟。
 *
 * 所以「跳过」这一组**带自己的说明行**,写明"这不代表模型不可用",
 * 并且带一个「只重试这些」的入口(重试仍然是一次批量请求,同样告知数量)。
 */
function ProbeResultGroups({
  report,
  onPick,
  onRetrySkipped,
  retrying,
}: {
  report: ProbeReport
  /** 点某个可用模型 → 选用它 */
  onPick: (id: string) => void
  /** 只重试"跳过"的那批(限流后用户最需要的下一步) */
  onRetrySkipped: () => void
  retrying: boolean
}): JSX.Element {
  const g = useMemo(() => groupProbeResults(report.results), [report.results])
  const first = pickFirstAvailable(report.results)

  return (
    <div className="probe-result">
      {/*
       * 限流横幅必须排在三组**之前**。
       *
       * 它的作用是改写整份结果的解读:下面那些"跳过"不是"这些模型有问题",
       * 而是"这次没测完"。用户先看到这一行,再看下面的分组,才不会把限流
       * 读成一批模型不可用。
       */}
      {report.rateLimited && (
        <div className="note warn">
          <Icon name="alert" size={12} /> 被限流了(HTTP 429),已停止后续探测。
          <div className="fhint">
            <b>这不代表这些模型不可用</b> —— 只是这一次没测完。请<b>稍后再试</b>;
            连着快速重复验证最容易再触发限流。
          </div>
        </div>
      )}

      {/* ✅ 可用 —— 用户要的"直接选用"就在这一组里 */}
      <div className="probe-group">
        <div className="probe-group-head">
          <span className={`badge ok`}>{PROBE_VERDICT_LABEL.ok}</span>
          <span className="count">{g.ok.length} 个</span>
          <span className="spacer" />
          {/*
           * 「用第一个可用模型」—— 用户说"然后直接选用",这就是那一步。
           *
           * 挑的是**最快**的那个而不是候选池第一项(见 pickFirstAvailable):
           * 列表第一项可能是个 30 秒的大模型,而用户要的是"现在就能用的那个"。
           */}
          {first && (
            <button type="button" className="tiny-link" onClick={() => onPick(first)}>
              用第一个可用模型({first.length > 22 ? `${first.slice(0, 22)}…` : first})
            </button>
          )}
        </div>
        {g.ok.length === 0 ? (
          <div className="fhint">这一轮没有验证出可用的模型。</div>
        ) : (
          <div className="probe-items">
            {g.ok.map((r) => (
              <button
                key={r.id}
                type="button"
                className="probe-item ok"
                onClick={() => onPick(r.id)}
                title="点击选为默认模型"
              >
                <code>{r.id}</code>
                <span className="hint">{r.latencyMs}ms</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ❌ 不可用 —— 服务端明确说不认 */}
      <div className="probe-group">
        <div className="probe-group-head">
          <span className={`badge err`}>{PROBE_VERDICT_LABEL.missing}</span>
          <span className="count">{g.missing.length} 个</span>
        </div>
        {g.missing.length === 0 ? (
          <div className="fhint">没有被服务端拒绝的模型。</div>
        ) : (
          <div className="probe-items">
            {g.missing.map((r) => (
              <div key={r.id} className="probe-item missing" title={r.reason}>
                <code>{r.id}</code>
                <span className="hint">{r.reason}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ⏸️ 跳过 —— "没测出来",绝不能算进不可用 */}
      <div className="probe-group">
        <div className="probe-group-head">
          <span className={`badge warn`}>{PROBE_VERDICT_LABEL.skipped}</span>
          <span className="count">{g.skipped.length} 个</span>
          <span className="spacer" />
          {g.skipped.length > 0 && (
            <button type="button" className="tiny-link" onClick={onRetrySkipped} disabled={retrying}>
              {retrying ? '重试中…' : '只重试这些'}
            </button>
          )}
        </div>
        {g.skipped.length === 0 ? (
          <div className="fhint">这一轮没有跳过的模型。</div>
        ) : (
          <>
            {/*
             * 这一行是整个组件里最重要的一句文案。
             * 「跳过」= 没测出来,不是模型不对。用户必须先看到它,
             * 否则上面那批"不可用"会被当成"这家的模型只有这些"。
             */}
            <div className="fhint warn">
              <Icon name="alert" size={12} />
              这些是<b>这次没测出来</b>(限流 / 超时 / 服务端故障),<b>不代表模型不可用</b>。
            </div>
            <div className="probe-items">
              {g.skipped.map((r) => (
                <div key={r.id} className="probe-item skipped" title={r.reason}>
                  <code>{r.id}</code>
                  <span className="hint">{r.reason}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * 单家服务商卡片。
 *
 * 默认模型那一行用 `ModelCombobox` —— 与节点面板同一个控件,理由见那里的注释:
 * 设置页的这份值会经 `defaultModelMap` 进运行规格,是用户填接入点 id 最常经过的一站。
 */
function ProviderCard({
  view,
  baseUrl,
  defaultModel,
  verifiedModels,
  recentModels,
  onBaseUrl,
  onDefaultModel,
  onVerifiedModels,
  onRecentModels,
}: {
  view: ProviderView
  /** 草稿里的地址覆盖值(空 = 用内置地址) */
  baseUrl: string
  /** 草稿里的默认模型(空 = 用内置首选) */
  defaultModel: string
  /** 草稿里探测验证过可用的模型 */
  verifiedModels: string[]
  /** 草稿里最近手填过的模型名/接入点 id(v0.4.1) */
  recentModels: string[]
  onBaseUrl: (v: string) => void
  onDefaultModel: (v: string) => void
  onVerifiedModels: (v: string[]) => void
  onRecentModels: (v: string[]) => void
}): JSX.Element {
  const { def, secret } = view

  const [keyInput, setKeyInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [models, setModels] = useState<ModelDef[]>(def.models)
  const [modelSource, setModelSource] = useState<'remote' | 'builtin'>('builtin')
  const [test, setTest] = useState<ProviderTestResult | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  /** 上次拉取到底是"真拉到了"还是"在用内置的"。UI 靠它决定候选角标与提示 */
  const [listFallback, setListFallback] = useState<string | null>(null)

  /* ---------------- 批量探测 ---------------- */
  /** 上一轮的探测报告。三组展示直接渲染它 */
  const [probeReport, setProbeReport] = useState<ProbeReport | null>(null)
  /** 探测中 = true。按钮与重试按钮据此禁用 */
  const [probing, setProbing] = useState(false)
  /** 成本确认:点第一次按钮只到这一步,再点一次才真发请求 */
  const [confirmProbe, setConfirmProbe] = useState(false)
  /**
   * 用户手填的候选模型名(接入点 id 走这里)。
   *
   * ⚠️ 这一路是**火山场景的全部意义**:接入点 id 不在任何可拉取的列表里,
   * 没有它,探测对方舟用户等于白做。
   */
  const [manualModels, setManualModels] = useState<string[]>([])
  const [manualInput, setManualInput] = useState('')
  /**
   * 探测进度(主进程经 `provider:probeProgress` 推进度)。
   *
   * ⚠️ **主进程赋值,渲染进程只读** —— 与日志 `seq` 同一口径:渲染侧不猜
   * "大概到第几个了",凭空插一个假的进度只会让用户以为卡住了。
   * 没收到任何事件时为 null,此时进度条不显示(而不是显示 0/N 骗人)。
   */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  useEffect(() => {
    // 只收本卡片的进度:设置页可能同时展开多张服务商卡片
    return window.api.providers.onProbeProgress((p) => {
      if (p.providerId !== def.id) return
      setProgress({ done: p.done, total: p.total })
    })
  }, [def.id])

  const statusText =
    secret.source === 'store' ? '已配置' : secret.source === 'env' ? '来自环境变量' : '未配置'
  const statusCls = secret.hasKey || def.optionalKey ? 'ok' : 'err'

  /**
   * 「用默认」那一档显示的名字 = 内置首选。
   *
   * 取自 `def.models` 而不是 `models`(那份可能是服务端实时列表):留空即回落时
   * 走的是 `effectiveModel`,它读的是注册表内置首选。显示"默认"却指向实时列表
   * 的第一项,会让用户以为两者是一回事 —— 而它们确实可能不是。
   */
  const defaultLabel = def.models[0]?.label ?? def.models[0]?.id ?? ''

  const saveKey = async (): Promise<void> => {
    const k = keyInput.trim()
    if (!looksLikeKey(k)) {
      setMsg('这把 Key 看起来不像 —— 至少 8 个字符、不含空格。')
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      await unwrap(await window.api.secrets.set(def.id, k))
      setKeyInput('')
      setMsg('已保存(加密落盘)。')
      // 保存后立刻拉一次真实模型列表 —— 能拉到就说明地址与 Key 都对
      void refreshModels(k)
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const clearKey = async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      await unwrap(await window.api.secrets.clear(def.id))
      setMsg('已清除。')
      setTest(null)
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const refreshModels = useCallback(
    async (useKey?: string): Promise<void> => {
      setBusy(true)
      /*
       * 上一次的拉取结果先清掉,否则刷新成功后旧的"回落"提示还挂着 ——
       * 用户会以为这次也失败了。失败时下面再写回新的。
       */
      setListFallback(null)
      try {
        const r = unwrap(
          await window.api.providers.models(def.id, {
            key: useKey || undefined,
            baseUrl: baseUrl || undefined,
          }),
        )
        if (r.models.length > 0) setModels(r.models)
        setModelSource(r.source)
        /*
         * ⚠️ 只在真回落时记下原因 —— 这条提示是用户判断"我到底配对了没有"
         * 的唯一依据。之前失败只写进 msg(一行灰字),而 msg 同时还承载
         * "Key 已保存"这类好消息,两者混在一行里互相盖掉,于是用户看到的是
         * "保存成功"却悄悄在用内置清单,直到运行时才报模型名不对。
         */
        if (r.source === 'builtin') setListFallback(r.message ?? '当前显示的是内置清单')
      } catch (e) {
        setListFallback(`拉取真实模型列表失败:${(e as Error).message}`)
        setMsg((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [def.id, baseUrl],
  )

  const runTest = async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    setTest(null)
    try {
      const r = unwrap(
        await window.api.providers.test(def.id, {
          // 输入框里还没保存的那把优先 —— 用户的心智是"拿我刚粘的这把去试"
          key: keyInput.trim() || undefined,
          baseUrl: baseUrl || undefined,
          model: defaultModel || undefined,
        }),
      )
      setTest(r)
    } catch (e) {
      setTest({ ok: false, message: (e as Error).message, latencyMs: null, model: null })
    } finally {
      setBusy(false)
    }
  }

  /**
   * 跑一轮(或多轮)探测。
   *
   * `only` 给定时只探那批 id(「只重试这些」走这条),否则探整个候选池。
   * 两种情况都是**真实计费请求**,所以成本确认那道门对两者同样适用。
   */
  const runProbe = useCallback(
    async (only?: readonly string[]): Promise<void> => {
      setProbing(true)
      setMsg(null)
      // 上一轮的陈进度必须清掉,否则新的一轮会先显示旧的 N/N
      setProgress(null)
      try {
        const manual = only && only.length > 0 ? only : manualModels
        const r = unwrap(
          await window.api.providers.probe(def.id, {
            // 输入框里还没保存的那把优先 —— 与「测试连接」同一口径
            key: keyInput.trim() || undefined,
            baseUrl: baseUrl || undefined,
            manualModels: [...manual],
          }),
        )
        setProbeReport(r)
        setConfirmProbe(false)
        /*
         * 探测通过的写进设置草稿(与 defaultModel 同级),节点面板就能选到。
         *
         * ⚠️ 只写 `ok` 那批 —— 跳过与不可用的都不写。存下来会让用户以为
         * "已经验过,不可用",而跳过的真实语义是"这次没测出来"。
         * 「只重试」这一轮是**并集**而不是覆盖:上一轮验过的模型不该因为
         * 这一轮只重试了别人而从列表里消失。
         */
        const passed = verifiedModelIds(r.results)
        onVerifiedModels([...new Set([...verifiedModels, ...passed])])
        /*
         * A2:「直接选用」。
         *
         * 这一轮探出了可用模型,就把**最快那个**直接设为默认 —— 用户要的
         * 正是"有回复的就是正确的,然后直接选用",不该再让他多点一下。
         * 只在默认模型还没定的时候自动设;用户已经选过就不再覆盖(尊重已有选择,
         * 提示栏里仍给出最快可用项,想换随时点)。
         */
        const first = pickFirstAvailable(r.results)
        if (first && !defaultModel.trim()) {
          onDefaultModel(first)
          setMsg(`已自动选用验证通过的「${first}」为默认模型(响应最快)。点右下「保存」写入设置。`)
        } else if (first) {
          setMsg(`本轮验证通过 ${passed.length} 个,最快为「${first}」,可点它直接选用。`)
        }
      } catch (e) {
        setMsg((e as Error).message)
        setConfirmProbe(false)
      } finally {
        setProbing(false)
      }
    },
    [def.id, keyInput, baseUrl, manualModels, verifiedModels, defaultModel, onVerifiedModels, onDefaultModel],
  )

  /**
   * 点「逐个验证可用模型」。
   *
   * ⚠️ **两次点击才真发请求**:第一次只展开成本告知,第二次才发。
   *
   * 这不是繁琐 —— 探测是**用户点一次就真扣费一次**的动作,而一个不带数量的
   * 「确定吗?」等于没告知(用户不知道那是 3 个请求还是 30 个)。成本文案由
   * `estimateProbeCost` 给出,它把"输出上限共几个 token"这个事实摆出来,
   * 比编一个金额诚实(各家单价差几个数量级,而且我们不知道用户拿到哪档折扣)。
   */
  const onProbeClick = (): void => {
    if (confirmProbe) {
      void runProbe()
      return
    }
    setConfirmProbe(true)
  }

  /** 把手填的名字加入候选池。已加过的不重复加 */
  const addManual = (): void => {
    const id = manualInput.trim()
    if (!id) return
    // 去重口径与候选池一致(归一化后比较),否则同一个 id 会探两次
    if (manualModels.some((m) => m.toLowerCase() === id.toLowerCase())) {
      setMsg(`「${id}」已经在候选里了,不必重复添加。`)
      setManualInput('')
      return
    }
    setManualModels([...manualModels, id])
    setManualInput('')
    // A4:手填的名字记进「最近使用」,下次一键点选即可,不必重打
    const next = [id, ...recentModels.filter((m) => m.toLowerCase() !== id.toLowerCase())].slice(0, 20)
    onRecentModels(next)
    setMsg(`已把「${id}」加入候选,点「逐个验证可用模型」时会一起验证。`)
  }

  /** A4:点「最近使用」里的名字 → 直接加入候选(不进输入框) */
  const addRecent = (id: string): void => {
    if (manualModels.some((m) => m.toLowerCase() === id.toLowerCase())) {
      setMsg(`「${id}」已经在候选里了。`)
      return
    }
    setManualModels([...manualModels, id])
    setMsg(`已把「${id}」加入候选。`)
  }

  const removeManual = (id: string): void => {
    setManualModels(manualModels.filter((m) => m !== id))
  }

  /** 探测通过了 → 选它当默认模型 */
  const pickProbed = (id: string): void => {
    onDefaultModel(id)
    setMsg(`已把默认模型设为「${id}」。点右下「保存」写入设置。`)
  }

  /*
   * 成本告知要用到"这一轮会探多少个"。
   *
   * ⚠️ 这里是**估算**,不是承诺:主进程还会把服务端列表与手填名一起去重
   * (同名只探一次),所以实际发出的请求数通常**略少于**这个数。
   * 取"当前列表 + 内置清单 + 手填"的最大可能值,宁可报多不报少 ——
   * 少报了才是"静默扣费"。
   */
  const estimateTotal = useMemo(() => {
    const ids = new Set<string>()
    for (const m of models) ids.add(m.id.toLowerCase())
    for (const m of def.models) ids.add(m.id.toLowerCase())
    for (const m of manualModels) ids.add(m.trim().toLowerCase())
    if (defaultModel.trim()) ids.add(defaultModel.trim().toLowerCase())
    return ids.size
  }, [models, def.models, manualModels, defaultModel])

  /*
   * 进度百分比。**没收到事件就不显示** —— 显示 `0/N` 是在骗用户,
   * 而主进程从"开始"到"第一个请求完成"之间确实有真实耗时。
   */
  const probeDoneCount = progress?.done ?? 0
  const probeTotal = progress?.total ?? 0
  const probeDonePercent = probeTotal > 0 ? Math.min(100, Math.round((probeDoneCount / probeTotal) * 100)) : 0

  return (
    <div className="provider-card">
      <div className="provider-head">
        <span className={`badge ${statusCls}`}>{statusText}</span>
        <span className="provider-name">{def.label}</span>
        {/* 本地推理服务:无需 Key、跑起来就能用 —— 给个一眼可见的徽标,别让人以为也要填 Key */}
        {(def.id === 'ollama' || def.id === 'lmstudio') && <span className="badge ok">本地推理 · 无需 Key</span>}
        {secret.masked && <code className="provider-mask">{secret.masked}</code>}
        {/*
         * 模型来源徽标:与上面的 Key 状态徽标同一套视觉语言(`badge`),
         * 但语义相反 —— 上面回答"填了没有",这个回答"**列出来的那些是真的吗**"。
         * 放在卡片头部而不是模型行下面,是因为它属于"这家服务商整体是什么状态",
         * 且分组折叠时也还看得见。
         */}
        <span className={`badge ${modelSource === 'remote' ? 'ok' : 'warn'}`}>
          {modelSource === 'remote' ? '模型列表·实时' : '模型列表·内置'}
        </span>
        <span className="spacer" />
        {def.keyUrl && (
          <button
            type="button"
            className="tiny-link"
            onClick={() => window.open(def.keyUrl, '_blank')}
          >
            申请 Key ↗
          </button>
        )}
      </div>

      <div className="btnrow">
        <input
          type="password"
          className="fkey"
          placeholder={
            secret.source === 'env'
              ? `已从环境变量 ${envKeyName(def.id)} 读到,如需覆盖再填`
              : def.optionalKey
                ? '本地服务可留空'
                : '粘贴 API Key'
          }
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
        />
        <button type="button" className="primary" onClick={() => void saveKey()} disabled={busy || !keyInput.trim()}>
          保存 Key
        </button>
        {secret.source === 'store' && (
          <button type="button" onClick={() => void clearKey()} disabled={busy}>
            清除
          </button>
        )}
        <button type="button" onClick={() => void runTest()} disabled={busy}>
          {busy ? '测试中…' : '测试连接'}
        </button>
      </div>

      {def.baseUrlEditable && (
        <label className="cfglabel">
          <span>接口地址</span>
          <input
            type="text"
            className="fpath"
            placeholder={def.baseUrl || 'https://…/v1'}
            value={baseUrl}
            onChange={(e) => onBaseUrl(e.target.value)}
            spellCheck={false}
          />
        </label>
      )}

      <label className="cfglabel">
        <span>默认模型</span>
        {/*
         * 与节点面板同一个控件(ModelCombobox)。
         *
         * 这一处**必须**跟着换,不是"顺手统一":设置页的这份值会经
         * `defaultModelMap` 进运行规格(spec),节点上没单独选模型时用的就是它 ——
         * 也就是说这是用户填接入点 id 最常经过的一站。两处用不同控件,
         * 用户在设置页就得面对一次"这里能搜、那里只能翻"的割裂。
         */}
        <ModelCombobox
          value={defaultModel}
          candidates={buildCandidates(models, modelSource)}
          onChange={onDefaultModel}
          defaultLabel={defaultLabel}
          placeholder="输入或粘贴模型名 / 接入点 id"
        />
        <div className="fhint">
          <button type="button" className="mini" onClick={() => void refreshModels()} disabled={busy}>
            刷新模型列表
          </button>
          <span className="hint"> · {sourceNote(modelSource, models.length)}</span>
          {verifiedModels.length > 0 && (
            <span className="hint"> · 另有 {verifiedModels.length} 个探测验证过可用</span>
          )}
        </div>
      </label>

      {/* ---------------- 逐个验证可用模型 ---------------- */}

      {/*
       * 这一段回答用户报的那句「有回复的就是正确的,然后直接选用」。
       *
       * 为什么不直接用上面的下拉:方舟有 1.6 / 2.1 / 2.0 等十多个版本,下拉翻不动;
       * 而接入点 id 压根不在任何可拉取的列表里(方舟没给出用 API Key 拉接入点的
       * 接口)。所以只能挨个发请求试 —— 服务端会告诉我们哪个名字它认。
       */}
      <div className="probe-bar">
        <button
          type="button"
          className={confirmProbe ? 'primary' : ''}
          onClick={onProbeClick}
          disabled={probing || busy}
        >
          {probing ? '验证中…' : confirmProbe ? '确认验证(会发请求)' : '逐个验证可用模型'}
        </button>
        {confirmProbe && !probing && (
          <>
            {/*
             * 成本知情。⚠️ 不能省这一句:探测是**点一次就真扣费一次**的动作,
             * 静默发请求等于偷偷扣钱。`estimateProbeCost` 把"会发几个请求、
             * 输出上限共几个 token"摆出来 —— 用户据此自己判断值不值。
             */}
            <span className="hint">{estimateProbeCost(estimateTotal)}</span>
            <button type="button" className="tiny-link" onClick={() => setConfirmProbe(false)}>
              取消
            </button>
          </>
        )}
        {probing && (
          /*
           * 进度用既有的 `.membar`(与性能面板那条同一套视觉),不自造。
           * 数字是"已完成/总数"—— 用户要知道还要等多久。
           */
          <span className="probe-progress">
            <span className="membar">
              <i style={{ width: `${probeDonePercent}%` }} />
            </span>
            <span className="hint">
              验证中 {probeDoneCount}/{probeTotal}
            </span>
          </span>
        )}
      </div>

      {/*
       * 手填候选。**这一路是火山场景的全部意义** —— 接入点 id 不在任何
       * 可拉取的列表里,没有它,探测对方舟用户等于白做。
       */}
      <div className="probe-manual">
        <input
          type="text"
          className="fkey"
          placeholder="模型名 / 接入点 id,如 ark-09d8…-b6d72"
          value={manualInput}
          onChange={(e) => setManualInput(e.target.value)}
          onKeyDown={(e) => {
            // 回车直接加入 —— 用户粘完 id 顺手敲回车是最自然的动作
            if (e.key === 'Enter') {
              e.preventDefault()
              addManual()
            }
          }}
          spellCheck={false}
          autoComplete="off"
          disabled={probing}
        />
        <button type="button" onClick={addManual} disabled={probing || !manualInput.trim()}>
          加入验证
        </button>
      </div>

      {manualModels.length > 0 && (
        <div className="probe-manual-list">
          {manualModels.map((id) => (
            <span key={id} className="badge">
              <code>{id}</code>
              <button
                type="button"
                className="probe-remove"
                onClick={() => removeManual(id)}
                disabled={probing}
                title="从候选里移除"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/*
       * A4:最近手填过的那批名字,一键点选加入候选。
       *
       * 火山接入点(id 以 ark-/ep- 开头)拉不到列表,手填是唯一入口;
       * 把填过的记下来,下次直接点,不用再复制粘贴。
       */}
      {recentModels.length > 0 && (
        <div className="probe-recent">
          <span className="hint">最近使用:</span>
          {recentModels.map((id) => (
            <button
              key={id}
              type="button"
              className="badge chip"
              onClick={() => addRecent(id)}
              disabled={probing}
              title={`把「${id}」加入候选`}
            >
              <code>{id}</code>
            </button>
          ))}
        </div>
      )}

      {probeReport && (
        <>
          <div className="note">{probeReport.note}</div>
          <ProbeResultGroups
            report={probeReport}
            onPick={pickProbed}
            onRetrySkipped={() => {
              const skipped = groupProbeResults(probeReport.results).skipped.map((r: ProbeResult) => r.id)
              if (skipped.length === 0) return
              setConfirmProbe(true)
              void runProbe(skipped)
            }}
            retrying={probing}
          />
        </>
      )}

      {/*
       * 回落提示:这是"自动识别"失败时用户唯一能看到的解释。
       * 用 `note err` 而不是 `fhint` —— 一行灰字会被用户当成装饰划过去,
       * 而这句话里就写着"去手填模型名",那正是他要做的下一步。
       * `listFallback` 里是主进程给的人话(message),这里只补一句兜底动作指引。
       */}
      {listFallback && (
        <div className="note err">
          <Icon name="alert" size={12} /> {listFallback}
          <div className="fhint">
            <Icon name="alert" size={12} /> 若运行时报模型名不对,在上方框里把服务商文档里的
            模型名<b>逐字填进去</b> —— 这一步不依赖任何自动识别,一定能生效。
          </div>
        </div>
      )}

      {/*
       * 拉取结果的可见性。分两种,都是"醒目但不吓人":
       *   - remote:一句确认,让用户知道自动识别成功了(他要的就是这个反馈);
       *   - builtin:说清**现在用的是内置清单**、以及运行时若报模型名不对
       *     该手填 —— 这是"配了服务商却说用不了"最常见的真实成因,
       *     之前它只藏在一行灰字里,用户完全看不到。
       */}
      {listFallback ? (
        <div className="note warn">
          <Icon name="alert" size={12} />
          <div>
            {listFallback}
            <div className="fhint">
              运行时若报「模型名不对 / unrecognized_model」,多半就是这个原因 ——
              内置清单里的名字对不上你改过的接口地址。
              <b>直接在上方框里敲名字或粘贴接入点 id 即可</b>,不必受这份清单限制。
            </div>
          </div>
        </div>
      ) : (
        modelSource === 'remote' && (
          <div className="note ok">
            ✅ 已拉取到服务端真实模型列表(共 {models.length} 个),自动识别完成。
          </div>
        )
      )}

      {def.hint && <div className="fhint">{def.hint}</div>}

      {test && (
        <div className={test.ok ? 'note ok' : 'note err'}>
          {test.ok ? '✅ ' : '❌ '}
          {test.message}
          {test.ok && test.latencyMs != null && ` · ${test.latencyMs}ms`}
          {test.model && <span className="hint"> · {test.model}</span>}
          {test.advice && <div className="fhint warn">{test.advice}</div>}
        </div>
      )}
      {msg && <div className="fhint">{msg}</div>}
    </div>
  )
}

export function ProviderSection({
  value,
  onChange,
}: {
  value: AgentSettings
  onChange: (next: AgentSettings) => void
}): JSX.Element {
  const [views, setViews] = useState<ProviderView[] | null>(null)
  const [store, setStore] = useState<SecretStoreInfo | null>(null)
  const [err, setErr] = useState<string | null>(null)
  /** 只展开用户在看的组,默认全展开会很吵 —— 但首次进来总得看见东西,所以默认开国内 */
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ cn: true })

  useEffect(() => {
    void (async () => {
      try {
        setViews(unwrap<ProviderView[]>(await window.api.providers.list()))
        setStore(unwrap<SecretStoreInfo>(await window.api.secrets.info()))
      } catch (e) {
        setErr((e as Error).message)
      }
    })()
  }, [])

  /*
   * 草稿里某家的配置。onChange 出去的永远是一份新的 providers 对象 ——
   * 直接改 value.providers[id] 会让 SettingsPanel 的 JSON.stringify 脏检查失灵
   * (引用没变),「保存」按钮就一直是灰的。
   */
  const patch = useMemo(
    () =>
      (
        providerId: string,
        field: 'baseUrl' | 'defaultModel' | 'verifiedModels' | 'recentModels',
        v: string | string[],
      ) => {
        const cur = value.providers[providerId] ?? {
          baseUrl: '',
          defaultModel: '',
          verifiedModels: [],
          recentModels: [],
        }
        onChange({
          ...value,
          providers: { ...value.providers, [providerId]: { ...cur, [field]: v } },
        })
      },
    [value, onChange],
  )

  if (err) return <div className="errbox">{err}</div>
  if (!views) return <div className="note">读取服务商…</div>

  const configured = views.filter((v) => v.secret.hasKey).length

  return (
    <>
      <h3>模型服务商(自带 API Key)</h3>

      <div className="note">
        在这里填你自己的 Key,就能在节点上把「Agent」选成对应的服务商,直接用它的模型干活。
        已配置 <b>{configured}</b> 家。
      </div>

      {/* 本地开源大模型引导(v0.4.1):不填 Key、跑起来就能探测到模型 */}
      <div className="local-models-note">
        <b>接入开源本地大模型(Ollama / LM Studio):</b>展开下方「本地推理」分组,地址已内置
        (<code>http://localhost:11434/v1</code> / <code>http://localhost:1234/v1</code>)。
        把本机服务跑起来后,<b>不需要填 Key</b>,直接点「批量探测」—— 探测会自动验证你
        <code>ollama pull</code> 过的每一个模型名,有回复的就是可用的,一键选为默认。
      </div>

      {store && (
        <div className={store.encrypted ? 'fhint' : 'fhint warn'}>
          {store.encrypted ? (
            <>
              密钥用系统凭据加密后存于 <code>{store.file}</code>,明文不会写入设置文件,也不会随画布分享。
            </>
          ) : (
            <>
              <Icon name="alert" size={12} />
              本机没有可用的系统凭据服务,Key 只能<b>明文</b>存于 <code>{store.file}</code>。
              建议改用环境变量:{' '}
              <code>CLAUDE_CANVAS_服务商ID</code>(如 <code>CLAUDE_CANVAS_DEEPSEEK</code>)。
            </>
          )}
        </div>
      )}

      {PROVIDER_GROUPS.map((g) => {
        const list = providersInGroup(g.id)
        if (list.length === 0) return null
        // 触发分组视图的读取:views 与 PROVIDERS 同源同序,按 id 取即可
        const groupViews = list
          .map((def) => views.find((v) => v.def.id === def.id))
          .filter((v): v is ProviderView => !!v)
        const ready = groupViews.filter((v) => v.secret.hasKey).length
        const open = openGroups[g.id] ?? false

        return (
          <div key={g.id} className="provider-group">
            <button
              type="button"
              className="provider-group-head"
              onClick={() => setOpenGroups((s) => ({ ...s, [g.id]: !open }))}
            >
              <span className="caret">{open ? '▾' : '▸'}</span>
              {g.label}
              <span className="count">
                {ready}/{groupViews.length} 已配置
              </span>
            </button>

            {open &&
              groupViews.map((v) => (
                <ProviderCard
                  key={v.def.id}
                  view={v}
                  baseUrl={value.providers[v.def.id]?.baseUrl ?? ''}
                  defaultModel={value.providers[v.def.id]?.defaultModel ?? ''}
                  verifiedModels={value.providers[v.def.id]?.verifiedModels ?? []}
                  recentModels={value.providers[v.def.id]?.recentModels ?? v.recentModels}
                  onBaseUrl={(s) => patch(v.def.id, 'baseUrl', s)}
                  onDefaultModel={(s) => patch(v.def.id, 'defaultModel', s)}
                  onVerifiedModels={(s) => patch(v.def.id, 'verifiedModels', s)}
                  onRecentModels={(s) => patch(v.def.id, 'recentModels', s)}
                />
              ))}
          </div>
        )
      })}

      <div className="fhint">
        想临时用而不落盘?也可以走环境变量:{' '}
        <code>CLAUDE_CANVAS_&lt;服务商ID大写&gt;</code>(优先级低于这里填的)。
      </div>
    </>
  )
}
