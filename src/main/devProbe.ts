import fs from 'node:fs'
import { app, type BrowserWindow } from 'electron'
import { getSettings } from './settings/store'
import { canvasGraphFile, DEFAULT_CANVAS_ID } from './paths'

/**
 * 内存探针 —— 只在 `HAOWAN_PROBE=1` 时启用,正常使用永远不会走到这里。
 *
 * 存在的理由:各个 Chromium 开关的实际 MB 收益没有权威数字,只能在本机实测。
 * 有了它,「量一遍」就是一条命令(见 package.json 的 probe / probe:gpu),
 * 而不是靠人肉点开窗口抄数字 —— 也让每次调整开关后都能重新量,
 * 而不是去信一份写死的承诺值。UI 里的 PerformanceSection 显示的是同一份数据。
 */
/**
 * 布局体检:运行条**不许**压住画布上的任何东西。
 *
 * 这条是被真实的吐槽逼出来的 —— 运行条原来绝对定位在画布上沿,把节点标题挡住了。
 * 改成布局里的一行之后,这是结构性保证;但"结构性保证"要有东西盯着才成立,
 * 否则下次谁给它加一句 position:absolute 就又回去了,而且没人会发现。
 *
 * ⚠️ 不能"没有运行条就算通过"。
 * 运行条在画布为空时**根本不渲染**(App.tsx 里的 `nodeCount > 0 &&`),而探针跑的
 * 正是一块空画布 —— 按真身去量,这条检查永远白过,一次也不会拦住回归。
 * 所以测的是**样式表**:真身在就量真身,不在就塞一个同 class 的合成元素量完删掉。
 * 两种情况下量到的都是 `canvas.css` 里那条规则的真实布局效果。
 */
async function layoutChecks(win: BrowserWindow): Promise<{ ok: boolean; detail: string }> {
  const script = `(() => {
    const wrap = document.querySelector('.canvas-wrap')
    const stage = document.querySelector('.canvas-stage')
    if (!wrap || !stage) return { ok: false, detail: '找不到 .canvas-wrap / .canvas-stage' }

    const real = document.querySelector('.run-bar')

    /*
     * ⚠️ 必须**先挂进 DOM 再问计算样式**。
     * Chrome 不会给游离元素套用样式表规则,游离的 div 无论 canvas.css 怎么写,
     * getComputedStyle(...).position 都返回 static —— 那样这条绝对定位守卫
     * 在空画布上永远不触发,恰好漏掉它唯一要防的那种回归。
     */
    let bar = real
    let made = false
    if (!bar) {
      bar = document.createElement('div')
      bar.className = 'run-bar'
      bar.style.visibility = 'hidden'   // 占位但不显形
      wrap.appendChild(bar)
      made = true
    }

    const pos = getComputedStyle(bar).position
    if (pos === 'absolute' || pos === 'fixed') {
      if (made) bar.remove()
      return { ok: false, detail: '运行条是 ' + pos + ' 定位,会浮在画布上' }
    }

    const s = stage.getBoundingClientRect()
    const b = bar.getBoundingClientRect()
    /*
     * 容差 0.5px:getBoundingClientRect 给的是小数(缩放/DPR 都会引入亚像素),
     * flex 把画布压到与运行条严丝合缝时,两个值会差出 0.0009 这种量级。
     * 死抠 overlap <= 0 会让一条本该 OK 的检查永远报 FAIL,
     * 而永远报 FAIL 的检查很快就没人看了 —— 和永远通过一样没用。
     */
    const overlap = Math.min(s.bottom, b.bottom) - Math.max(s.top, b.top)
    if (made) bar.remove()

    return {
      ok: overlap <= 0.5,
      detail: (made ? '合成运行条 ' : '真实运行条 ') +
              'stage.bottom=' + Math.round(s.bottom) + ' bar.top=' + Math.round(b.top) +
              ' 重叠=' + overlap.toFixed(2) + 'px',
    }
  })()`
  try {
    return (await win.webContents.executeJavaScript(script)) as { ok: boolean; detail: string }
  } catch (e) {
    return { ok: false, detail: '体检脚本抛错:' + (e as Error).message }
  }
}

/**
 * 右栏体检:点一个节点,它必须**显示出东西来**。
 *
 * 这条来自一条用户反馈:「点开节点显示无内容」。到底哪儿空了,光看代码
 * 猜不出来(节点点击有接、MessageList 有空态、配置面板看着也正常)——
 * 所以真的去点一下,再把右栏的文字读回来。空就是空,有就是有,不用猜。
 */
async function inspectorChecks(
  win: BrowserWindow,
): Promise<{ ok: boolean; detail: string; text?: string }> {
  const script = `(async () => {
    const snap = () => {
      const insp = document.querySelector('.inspector')
      if (!insp) return { exists: false, text: '', tab: '', app: !!document.querySelector('.app') }
      const text = (insp.innerText || '').replace(/\\s+/g, ' ').trim()
      const active = insp.querySelector('.tabs button.active')
      return {
        exists: true,
        text,
        tab: active ? active.textContent : '(没有 active 页签)',
        app: !!document.querySelector('.app'),
      }
    }

    /*
     * 装错误钩子。React 19 在没有 error boundary 时会把异常重新抛出到全局,
     * 所以 window 的 error / unhandledrejection 能拿到**原始那条消息** ——
     * 而"元素不见了"只是症状,靠它是查不出病因的。
     */
    const errs = []
    const onErr = (e) => errs.push(String(e.message || e.error || e))
    const onRej = (e) => errs.push('unhandledrejection: ' + String(e.reason))
    window.addEventListener('error', onErr)
    window.addEventListener('unhandledrejection', onRej)

    // 点击**之前**的状态也要记 —— 分清"本来就空"和"点了一下才崩"
    const before = snap()

    const node = document.querySelector('.agent-node')
    if (!node) {
      return { ok: true, detail: '画布上没有节点(before: ' + JSON.stringify(before) + '),跳过' }
    }

    // React 17+ 把事件委托挂在根容器上,所以冒泡的合成点击能被 React Flow 收到
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((r) => setTimeout(r, 400))

    const after = snap()
    if (!after.exists) {
      return {
        ok: false,
        detail: '点击**之后** .inspector 消失了(点击前还在:' + before.exists +
                ',整个 .app 还在:' + after.app + ')—— 选中该节点时渲染抛错,React 卸掉了整棵树',
        text: '原始错误:' + (errs.length ? errs.join(' || ') : '(窗口里没捕到,可能被 React 自己吞了)'),
      }
    }
    /*
     * 输入框必须**常驻**:两个页签下都要在。
     * 只测一个页签的话,"配置页没有输入框"这种状态照样是绿的 ——
     * 而用户问的正是那个页签下怎么说话。
     */
    const hasComposer = () => !!document.querySelector('.inspector .composer textarea')
    const onChat = after.tab.indexOf('对话') >= 0
    let composerDetail = ''

    if (onChat) {
      const configBtn = Array.from(document.querySelectorAll('.inspector .tabs button'))
        .find((b) => b.textContent.indexOf('节点配置') >= 0)
      if (!configBtn) {
        return { ok: false, detail: '找不到「节点配置」页签按钮' }
      }
      const chatHas = hasComposer()
      configBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await new Promise((r) => setTimeout(r, 300))
      const configHas = hasComposer()
      const onConfig = !!(document.querySelector('.inspector .tabs button.active')?.textContent || '').includes('节点配置')
      composerDetail = ' | 对话页输入框=' + chatHas + ' 切到配置页后=' + configHas +
                       '(页签确实切过去了=' + onConfig + ')'
      if (!chatHas || !configHas) {
        return { ok: false, detail: '输入框不是常驻的' + composerDetail }
      }
    } else {
      composerDetail = ' | 当前是配置页,输入框=' + hasComposer()
      if (!hasComposer()) return { ok: false, detail: '配置页没有输入框' + composerDetail }
    }

    return {
      ok: after.text.length > 0,
      detail: '点击前页签=' + before.tab + ' / 点击后页签=' + after.tab +
              ' 右栏文字长度=' + after.text.length + composerDetail,
      text: after.text.slice(0, 300),
    }
  })()`
  try {
    return (await win.webContents.executeJavaScript(script)) as {
      ok: boolean
      detail: string
      text?: string
    }
  } catch (e) {
    return { ok: false, detail: '体检脚本抛错:' + (e as Error).message }
  }
}

/**
 * 设置页体检:服务商分区必须**真的渲染出卡片与 Key 输入框**。
 *
 * 为什么值得专门测:这一整块是新的,而它依赖两条容易静默失败的链路 ——
 * `providers.list()` / `secrets.info()` 两个 IPC。任一失败或返回空,
 * 表现都只是"设置里少了一节",不会报错、也不会崩,typecheck 和 e2e 都拦不住
 * (它们跑的是主进程代码,根本碰不到 React)。所以这里真的把抽屉打开、点开分组、
 * 数一数卡片和输入框。
 */
async function settingsChecks(
  win: BrowserWindow,
): Promise<{ ok: boolean; detail: string; text?: string }> {
  const script = `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const errs = []
    window.addEventListener('error', (e) => errs.push(String(e.message || e.error || e)))

    const btn = Array.from(document.querySelectorAll('.topbar button'))
      .find((b) => (b.textContent || '').trim() === '设置')
    if (!btn) return { ok: false, detail: '顶栏找不到「设置」按钮' }
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    // 等两件事:设置草稿 load 完 + ProviderSection 自己的 providers.list/secrets.info
    await wait(1200)

    const drawer = document.querySelector('.drawer')
    if (!drawer) return { ok: false, detail: '点击「设置」后没有出现抽屉' }
    const text = (drawer.innerText || '').replace(/\\s+/g, ' ')

    if (text.indexOf('模型服务商') < 0) {
      return { ok: false, detail: '抽屉里没有「模型服务商」这一节。文字:' + text.slice(0, 220) }
    }

    const groups = Array.from(drawer.querySelectorAll('.provider-group-head'))
    if (groups.length === 0) {
      return { ok: false, detail: '一个服务商分组都没渲染(providers.list 可能失败或返回空)' }
    }

    const cn = groups.find((g) => (g.textContent || '').indexOf('国内服务商') >= 0)

    /*
     * ⚠️ 「国内服务商」默认就是展开的,所以**不能无条件去点它** ——
     * 点了反而把它收起,卡片变成 0,然后报一条假 FAIL(本探针第一版就这么翻过车)。
     * 正确做法:先数,空了再点开,再数。
     */
    const cardsIn = (d) => Array.from(d.querySelectorAll('.provider-card'))
    let cards = cardsIn(drawer)
    let clicked = false
    if (cards.length === 0 && cn) {
      cn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await wait(400)
      cards = cardsIn(drawer)
      clicked = true
    }

    /*
     * Key 输入框数 password 型的 .fkey,不能数全部 .fkey:
     * 探测功能在每张卡片里又加了一个 text 型的「手填候选」输入框,
     * 数全部 .fkey 会得到 2 倍卡片数,报一条假 FAIL。
     */
    const keys = drawer.querySelectorAll('.provider-card input[type="password"]')
    /*
     * 模型选择数 .model-combo,不能数 <select>:
     * 模型选择控件早已从原生 <select> 换成 ModelCombobox(可输入+实时过滤,
     * 见 ModelCombobox.tsx 顶部)——继续数 select 恒为 0,报一条假 FAIL。
     */
    const selects = drawer.querySelectorAll('.provider-card .model-combo')
    const names = cards.map((c) => (c.querySelector('.provider-name')?.textContent || '?').trim())

    if (cards.length === 0) {
      return {
        ok: false,
        detail: '分组都在但展开后一张卡片也没有。分组文字=[' +
                groups.map((g) => (g.textContent || '').replace(/\\s+/g, ' ').trim()).join(' / ') +
                '] 有国内分组=' + !!cn + ' 点了=' + clicked +
                (errs.length ? ' 渲染错误:' + errs.join(' || ') : ''),
      }
    }

    return {
      ok: keys.length === cards.length && selects.length === cards.length,
      detail:
        '分组=' + groups.length +
        ' 卡片=' + cards.length +
        ' Key输入框=' + keys.length +
        ' 模型选择=' + selects.length +
        ' 需要时点开=' + clicked +
        ' 卡片=[' + names.join(',') + ']' +
        (errs.length ? ' 渲染错误:' + errs.join(' || ') : ''),
      text: text.slice(0, 260),
    }
  })()`
  try {
    return (await win.webContents.executeJavaScript(script)) as {
      ok: boolean
      detail: string
      text?: string
    }
  } catch (e) {
    return { ok: false, detail: '设置体检脚本抛错:' + (e as Error).message }
  }
}

/**
 * 节点「模型选择」体检:把 Agent 换成 API 型之后,模型字段必须出现且能选。
 *
 * 这是本次新功能的**唯一可见入口**:节点上选服务商 → 出现模型下拉。
 * 它同样是 typecheck / e2e 碰不到的地方(全靠 React 状态联动:
 * AgentField 的 onChange 写 agentId → ModelField 读 providerOfAgent 决定渲染与否)。
 *
 * ⚠️ 只在画布为空时造节点,测完把节点删掉 —— 探针不许污染用户画布。
 * 画布非空就整体跳过(宁可不测,也不改用户已有的图)。
 */
async function nodeAgentChecks(
  win: BrowserWindow,
): Promise<{ ok: boolean; detail: string }> {
  const script = `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    // 先关掉设置抽屉(上一步打开过)
    const close = Array.from(document.querySelectorAll('.drawer-head button'))
      .find((b) => (b.textContent || '').trim() === '关闭')
    if (close) { click(close); await wait(400) }

    const place = document.querySelector('.canvas-empty button.primary')
    if (!place) {
      return { ok: true, skipped: true, detail: '画布非空 —— 跳过(探针不修改已有画布)' }
    }

    /*
     * 造之前先记下已有节点的 id,造完做差 —— 只有这样才知道**哪个**是新节点。
     *
     * 这一步不是锦上添花:清理必须精确到这一个 id。原来的清理是"点一下当前
     * 选中节点上的删除按钮",而"画布非空 → 跳过"那条路径上,选中的是
     * **用户自己的节点** —— 于是体检一走完,用户的节点连它两端的连线一起没了。
     * (真踩到过:数据根里那个项目节点和两条边凭空消失,而界面看起来一切正常。)
     */
    const idsOf = () =>
      Array.from(document.querySelectorAll('.react-flow__node[data-id]')).map((el) =>
        el.getAttribute('data-id'),
      )
    const idsBefore = idsOf()

    click(place)
    await wait(900)

    const createdId = idsOf().find((id) => idsBefore.indexOf(id) < 0) || ''
    /** 统一带上 createdNodeId —— 每个返回点各写一遍的话,漏一个就漏一次清理 */
    const done = (ok, detail) => ({ ok, detail, createdNodeId: createdId })

    const diag = () => {
      const active = document.querySelector('.inspector .tabs button.active')
      const cfg = document.querySelector('.node-config')
      return '节点数=' + document.querySelectorAll('.agent-node').length +
             ' 页签=' + ((active && active.textContent) || '(无)') +
             ' .node-config=' + (cfg ? '在' : '无') +
             ' 配置字段=' + (cfg
               ? Array.from(cfg.querySelectorAll('.cfglabel > span')).map((s) => (s.textContent || '').trim()).join(',')
               : '')
    }

    const labels = () => Array.from(document.querySelectorAll('.node-config .cfglabel'))
    const byName = (n) =>
      labels().find((l) => ((l.querySelector('span') || {}).textContent || '').trim() === n)

    /*
     * 类型角标必须是「内联 SVG 图标 + 文字」,而不是 emoji。
     *
     * emoji 由系统字体渲染:各机器字形与配色都不一样、不跟主题变色(CSS 的
     * color 对它无效)、字号与基线还飘。换成 SVG 之后这三件事都归 CSS 管。
     * 这条钉住"没有回退到 emoji" —— 类型检查看不见渲染结果,而把 emoji 写回
     * 注册表一样能通过编译。
     */
    const badge = document.querySelector('.agent-node .node-kind-badge')
    const badgeSvg = badge ? badge.querySelector('svg.icon') : null
    const badgeText = badge ? (badge.textContent || '').trim() : ''
    // emoji 区 + 常见几何符号(◇ ▶ ■ ● ✂ ⇄ ↳ ⑂ 等)
    const SYMBOLISH = /[\\u{1F300}-\\u{1FAFF}\\u{2190}-\\u{21FF}\\u{25A0}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{FE0F}]/u
    const badgeEmoji = SYMBOLISH.test(badgeText)

    const agentLabel = byName('Agent')
    if (!agentLabel) {
      return done(false, '放置项目节点后配置页没有 Agent 字段。诊断:' + diag())
    }
    const agentSel = agentLabel.querySelector('select')
    if (!agentSel) return done(false, 'Agent 字段不是下拉框。诊断:' + diag())

    const optgroups = Array.from(agentSel.querySelectorAll('optgroup')).map((g) => g.label)
    const optTotal = agentSel.options.length
    const hasApiOption = Array.from(agentSel.options).some((o) => o.value === 'api:deepseek')
    if (!hasApiOption) {
      return done(false, 'Agent 下拉里没有 api:deepseek 选项(共 ' + optTotal + ' 项)')
    }

    // 换之前不该有「模型」字段 —— 否则等于把 CLI 型也塞了个无意义的模型框
    const modelBefore = !!byName('模型')

    /*
     * React 受控 select:必须用原生 setter 改 value 再派发 change,
     * 直接赋值会被 React 的 value tracker 吞掉、认为没变化。
     */
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(agentSel, 'api:deepseek')
    agentSel.dispatchEvent(new Event('change', { bubbles: true }))
    await wait(1000)

    const modelLabel = byName('模型')
    if (!modelLabel) {
      return done(false, '选了 api:deepseek 之后没有出现「模型」字段。诊断:' + diag())
    }
    const combo = modelLabel.querySelector('.model-combo')
    const comboInput = combo ? combo.querySelector('input') : null
    if (!combo || !comboInput) {
      return done(false, '模型字段不是可输入选择框(ModelCombobox)。诊断:' + diag())
    }
    /*
     * ModelCombobox 的候选在**展开列表**里(role=option 按钮),不展开就数不到。
     * React 受控 input:必须用原生 setter 改 value 再派发 input 事件,直接赋值
     * 会被 React 的 value tracker 吞掉。输入 'deep' 让列表展开并过滤出
     * deepseek-chat(它在注册表的内置清单里)。
     */
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    inputSetter.call(comboInput, 'deep')
    comboInput.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(400)
    const optBtns = Array.from(document.querySelectorAll('.model-combo-list button[role="option"]'))
    const optTexts = optBtns.map((b) => (b.textContent || '').trim())
    const hasBuiltin = optTexts.some((t) => t.indexOf('deepseek-chat') >= 0)
    /*
     * 手填路径 = 清单外的名字照样能用:输入一个必然不在任何清单里的名字,
     * 列表应显示 empty 提示「会原样使用」(ModelCombobox 的 mc-empty 分支)。
     * 这是方舟接入点场景的命脉 —— 接入点 id 天生不在任何列表里。
     */
    inputSetter.call(comboInput, 'probe-no-such-model-zzz')
    comboInput.dispatchEvent(new Event('input', { bubbles: true }))
    /*
     * 给足时间:patchConfig 有 500ms 存盘去抖,输入值要经 store → 重渲染
     * 才会反映到 shown 列表。wait(400) 实测不够(empty 提示没出现),
     * 800ms 覆盖去抖 + 一帧渲染。
     */
    await wait(800)
    const valNow = comboInput ? comboInput.value : '(输入框丢了)'
    const listEl = document.querySelector('.model-combo-list')
    const listOpen = !!listEl
    const listText = listEl ? (listEl.innerText || '').replace(/\s+/g, ' ').slice(0, 120) : '(列表没开)'
    const emptyHint = document.querySelector('.model-combo-list .mc-empty')
    const emptyText = emptyHint ? (emptyHint.textContent || '').trim() : '(没有 empty 提示)'
    /*
     * ⚠️ ModelCombobox 对「清单外输入」的处理**不是** empty 提示:
     * 输入值会直接被渲染成一条 source='custom' 的手填候选(角标文字「手填」,
     * 敲字立刻生效的路径,见 ModelCombobox.tsx 的 input onChange)。
     * 所以手填路径的判据是列表里出现文字含「手填」的候选按钮;
     * mc-empty 只在 shown 完全为空时出现,不适用于这个场景。
     */
    const manualOpt = Array.from(
      document.querySelectorAll('.model-combo-list button[role="option"]'),
    ).find((b) => (b.textContent || '').indexOf('手填') >= 0)
    const hasManual = !!manualOpt
    const panelText = ((document.querySelector('.node-config') || {}).innerText) || ''
    const hasKeyWarn = panelText.indexOf('API Key') >= 0

    /*
     * 还要确认它**真的看得见、点得到**。
     *
     * 元素在 DOM 里、候选也在,不代表它没被底部那个常驻输入框盖住、或被裁在视口外
     * —— 右栏底部有一条永远在的 composer(见 INSPECTOR 体检),配置面板又很长
     * (项目节点在 Agent 之上还有「项目文件夹 / 项目说明」)。只数候选个数的话,
     * "模型选择被压在输入框底下"这种状态照样是绿的。
     * 用 elementFromPoint 打一个点:命中自己 = 真的可交互;命中别人 = 被盖住。
     */
    let geom = '(未拿到)'
    if (comboInput) {
      comboInput.scrollIntoView({ block: 'center' })
      await wait(350)
      const r = comboInput.getBoundingClientRect()
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const hitEl = document.elementFromPoint(cx, cy)
      const hit =
        hitEl === comboInput ? '自己'
        : hitEl && comboInput.contains(hitEl) ? '子元素'
        : hitEl ? '被 ' + (hitEl.className || hitEl.tagName) + ' 挡住'
        : '中心点在视口外'
      geom = 'y=' + Math.round(r.top) + ' h=' + Math.round(r.height) + ' 命中=' + hit
    }

    return done(
      hasBuiltin && hasManual && !modelBefore && geom.indexOf('命中=自己') >= 0 && !!badgeSvg && !badgeEmoji,
      'Agent 分组=[' + optgroups.join('|') + '] 共' + optTotal + '项' +
        ' | 换前有模型字段=' + modelBefore +
        ' | 换后候选=' + optBtns.length + ' 含内置deepseek-chat=' + hasBuiltin +
        ' 含手填提示=' + hasManual + ' 输入值=[' + valNow + '] 列表开=' + listOpen + ' 列表文字=[' + listText + '] empty=[' + emptyText + ']' +
        ' | 未配Key警告=' + hasKeyWarn +
        ' | 角标=' + (badgeSvg ? '含SVG图标' : '无SVG图标') + '/' + (badgeEmoji ? '混入emoji' : '无emoji') +
        ' 文字「' + badgeText + '」' +
        ' | 可见性:' + geom,
    )
  })()`

  let res: { ok: boolean; detail: string; createdNodeId?: string; skipped?: boolean }
  try {
    res = (await win.webContents.executeJavaScript(script)) as typeof res
  } catch (e) {
    res = { ok: false, detail: '节点体检脚本抛错:' + (e as Error).message }
  }

  /*
   * 截图放在「删节点」之前 —— 这是唯一能让人**看见**模型下拉长什么样的办法。
   * 只在真的造出过节点、且体检通过时截:失败现场已经有 detail 说清楚哪里不对,
   * 再给张图反而误导(会显得"界面看起来正常")。
   */
  const shotPath = process.env['HAOWAN_PROBE_SHOT']
  if (shotPath && res.ok && res.createdNodeId) {
    try {
      const img = await win.webContents.capturePage()
      fs.writeFileSync(shotPath, img.toPNG())
      console.log(`NODEAGENT-SHOT ${shotPath}`)
    } catch (e) {
      console.log(`NODEAGENT-SHOT-FAIL ${(e as Error).message}`)
    }
  }

  /*
   * 清理放在主进程侧,而且**只在真的造出过节点时**才做。这一步被两个坑教过:
   *
   *   ① 原来写在渲染脚本的 try/finally 里 —— 脚本自己 reject 时那个 finally
   *      根本不会执行,节点就留在画布上还会被自动存盘;而且不挪出来,
   *      也没法"先截图、后删除"(节点会在脚本返回前就被删掉)。
   *   ② 挪出来之后又写成了**无条件执行** —— 于是"画布非空 → 跳过"这条路径
   *      也跑去点删除按钮,而那一刻选中的是**用户自己的节点**:
   *      一次体检下来,用户的节点连同它两端的连线凭空消失,界面看起来却毫无异常。
   *
   * 所以守卫是两道:主进程只在拿到 createdNodeId 时调用;渲染侧还要再确认
   * "存在的那一个确实是它、而且它确实是当前选中"。
   */
  if (res.createdNodeId) {
    const removed = await cleanupProbeNode(win, res.createdNodeId)
    /*
     * 把**磁盘上**的节点数读回来核对。界面干净不代表文件干净 ——
     * "删了但没落盘"光看界面是发现不了的(见 cleanupProbeNode 的注释)。
     * 探针自己核对,这类污染就从"某天用户发现画布多了个节点"变成一行会喊的日志。
     */
    console.log(
      `NODEAGENT-DISK 清理=${removed ? '已删' : '没删成'} 磁盘节点数=${diskNodeCount()}(应为 0)`,
    )
  }
  return { ok: res.ok, detail: res.detail }
}

/**
 * 删掉探针造出来的那个节点 —— **按 id 精确删**。
 *
 * ⚠️ 绝不能写成"点一下当前选中节点上的删除按钮"。那正是踩过的坑:
 * "画布非空 → 跳过体检"这条路径上,当前选中的是**用户自己的节点**,
 * 于是体检一走完,用户的节点连同它两端的连线一起没了 ——
 * 界面看着毫无异常,文件里却少东西,比留下垃圾难发现得多。
 *
 * 返回是否真的点了删除。没点也不算错(可能已经被别处删掉了、或选中的不是它)。
 */
async function cleanupProbeNode(win: BrowserWindow, createdId: string): Promise<boolean> {
  try {
    const removed = (await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const el = document.querySelector(
        '.react-flow__node[data-id=' + JSON.stringify(${JSON.stringify(createdId)}) + ']'
      )
      if (!el) return false

      /*
       * 先把它点成"当前选中",再动手。
       *
       * 删除按钮是按**当前选中项**生效的;而 .selected 这个类只反映 React Flow
       * 自己内部的选中状态 —— 程序化 addNode + select() 并不会给它加上
       * (所以"有没有 .selected"不能直接当守卫,否则永远判否、清理永远静默跳过)。
       * 点的是它自己,选中项没有变化,Inspector 也就不会"换了节点 → 切回对话页",
       * 配置页还在,删除按钮才够得着。
       */
      const hit = el.querySelector('.agent-node') || el
      hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await wait(420)

      // 点完 React Flow 必须把它标成 selected:这一条成立,才说明 onNodeClick 跑过了,
      // 而 uiStore 的选中与它是 1:1 同步的 —— 于是"删除按钮会删谁"就确定了。
      if (!el.classList.contains('selected')) return false

      const del = Array.from(document.querySelectorAll('.node-config button'))
        .find((b) => (b.textContent || '').indexOf('删除这个节点') >= 0)
      if (!del) return false
      del.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      return true
    })()`)) as boolean

    /*
     * ⚠️ 必须等够**渲染进程的存盘去抖**(graphStore 的 SAVE_DEBOUNCE_MS = 500ms)。
     *
     * 这里原来只等 400ms,于是删除只活在内存里 —— 紧接着的 app.exit(0) 把进程
     * 直接干掉,去抖定时器再没机会跑,节点就**留在了 graph.json 里**。
     * 界面上一片干净、文件里多一个节点,是最难发现的那类污染。
     * (真被咬到过:下一次运行去看数据根,里面躺着一个 agentId=api:deepseek 的孤儿节点。)
     */
    await new Promise((r) => setTimeout(r, 900))
    return removed
  } catch {
    /* 清理失败不改体检结论 —— 但 NODEAGENT-DISK 那一行会把真相说出来 */
    return false
  }
}

/**
 * 数一下默认画布**磁盘上**还剩几个节点。
 *
 * 存在的意义:上面那个"删除没落盘"的坑,界面完全看不出来 ——
 * 只有把文件读回来才知道。让探针自己核对,这类污染就变成一条会喊的日志,
 * 而不是等用户某天发现画布上多了个不认识的节点。
 */
function diskNodeCount(): string {
  try {
    const raw = fs.readFileSync(canvasGraphFile(DEFAULT_CANVAS_ID), 'utf8')
    const g = JSON.parse(raw) as { nodes?: unknown[] }
    return Array.isArray(g.nodes) ? String(g.nodes.length) : '(nodes 不是数组)'
  } catch (e) {
    return '(读不到:' + (e as Error).message + ')'
  }
}

/**
 * 连线切断体检:鼠标移到线上要浮出剪刀,点一下线要消失,而**别的线不许受影响**。
 *
 * 为什么这条必须真机测:整条链路都在渲染层 —— 自定义边类型有没有注册上、
 * `EdgeLabelRenderer` 的 portal 有没有把按钮渲染出来、悬停状态有没有驱动到
 * `.on` 类、点击有没有真的写回 store。typecheck 和 e2e 一条都碰不到
 * (e2e 是纯 node 跑的,压根不 import 渲染进程)。
 *
 * ⚠️ "只有被悬停的那一条浮出剪刀"是这条检查的核心不变量,不是附带信息:
 * 它同时证明了「隐藏的按钮不吃点击」(pointer-events: none)。
 * 若所有按钮都常亮,画布上就散着一堆隐形热点,手滑就切断线。
 *
 * 需要画布上**本来就有连线**才测得了;没有就整条跳过(不报假 FAIL)。
 */
async function edgeCutChecks(
  win: BrowserWindow,
  shotPath?: string,
): Promise<{ ok: boolean; detail: string }> {
  /*
   * 分两段跑,中间在主进程侧截图 —— 剪刀只在**悬停时**存在,点完就没了;
   * 想要一张"鼠标停在线上、剪刀浮出来"的图,就得在悬停之后、点击之前留个空隙,
   * 而渲染脚本自己没法暂停。拆成两段正好把这个空隙让给 capturePage()。
   */
  const arrangeScript = `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const errs = []
    window.addEventListener('error', (e) => errs.push(String(e.message || e.error || e)))

    // 上一步(设置体检)会打开抽屉,它盖着画布 —— 先关掉
    const close = Array.from(document.querySelectorAll('.drawer-head button'))
      .find((b) => (b.textContent || '').trim() === '关闭')
    if (close) { close.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); await wait(300) }

    const edgeEls = () => Array.from(document.querySelectorAll('.react-flow__edge'))
    const n0 = edgeEls().length
    if (n0 === 0) {
      return { ok: true, skipped: true, detail: '画布上没有连线 —— 跳过(这条检查要有线才测得了)' }
    }

    const btns = () => Array.from(document.querySelectorAll('.react-flow__edgelabel-renderer button.edge-cut'))
    const allBtns = btns()
    if (allBtns.length !== n0) {
      return { ok: false, detail: '剪刀按钮数与连线数不一致(连线=' + n0 + ' 按钮=' + allBtns.length + ')' }
    }

    // ① 静止态:所有剪刀都必须"看不见且点不到" —— 隐形热点比没有入口更糟
    const hidden = allBtns.filter((b) => {
      const cs = getComputedStyle(b)
      return cs.opacity === '0' && cs.pointerEvents === 'none'
    })
    if (hidden.length !== allBtns.length) {
      return {
        ok: false,
        detail: '有 ' + (allBtns.length - hidden.length) + '/' + allBtns.length +
                ' 个剪刀在静止态就没藏住(opacity/pointer-events 没归零)',
      }
    }

    // ② 悬停某一条线 → 只有这一条的剪刀浮出来
    const target = edgeEls()[0]
    const path = target.querySelector('.react-flow__edge-interaction') || target.querySelector('.react-flow__edge-path')
    /*
     * 必须派发 mouseover(冒泡):React 的 enter/leave 是靠根容器上的
     * mouseover/mouseout 合成出来的,relatedTarget 为 null 表示"从画布外进来",
     * 于是沿祖先链触发 mouseenter —— 挂在 <g> 上的那条处理器才会跑到。
     * 直接派发 'mouseenter'(不冒泡)是没用的,React 根本不监听它。
     */
    path.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, relatedTarget: null }))
    await wait(320)

    const on = btns().filter((b) => b.classList.contains('on'))
    if (on.length !== 1) {
      return {
        ok: false,
        detail: '悬停后浮出的剪刀数应为 1,实际 ' + on.length +
                '(连线=' + n0 + ' 按钮=' + btns().length + ')' +
                (errs.length ? ' 渲染错误:' + errs.join(' || ') : ''),
      }
    }
    const live = on[0]
    const cs = getComputedStyle(live)
    if (cs.opacity !== '1' || cs.pointerEvents !== 'all') {
      return {
        ok: false,
        detail: '剪刀加了 .on 类但还是点不到(opacity=' + cs.opacity +
                ' pointer-events=' + cs.pointerEvents + ')',
      }
    }
    const label = (live.getAttribute('title') || live.getAttribute('aria-label') || '').trim()

    return {
      ok: true,
      detail:
        '连线=' + n0 + ' | 静止态 ' + allBtns.length + ' 个剪刀全隐藏' +
        ' | 悬停后浮出=' + on.length + ' | 标注「' + label + '」' +
        (errs.length ? ' 渲染错误:' + errs.join(' || ') : ''),
    }
  })()`

  let r1: { ok: boolean; detail: string; skipped?: boolean }
  try {
    r1 = (await win.webContents.executeJavaScript(arrangeScript)) as typeof r1
  } catch (e) {
    return { ok: false, detail: '连线体检(悬停段)脚本抛错:' + (e as Error).message }
  }
  // 跳过 / 已经失败,都不用再跑第二段
  if (!r1.ok || r1.skipped) return { ok: r1.ok, detail: r1.detail }

  if (shotPath) {
    try {
      const img = await win.webContents.capturePage()
      fs.writeFileSync(shotPath, img.toPNG())
      console.log(`EDGECUT-SHOT ${shotPath}`)
    } catch (e) {
      console.log(`EDGECUT-SHOT-FAIL ${(e as Error).message}`)
    }
  }

  /*
   * 第二段:点掉那把已经浮出来的剪刀。
   *
   * ⚠️ 用 `.edge-cut.on` 定位,而不是"第几个按钮":按钮是 portal 出来的,
   * DOM 顺序与连线顺序没有保证。而**浮着的只可能有一个**(上一段刚断言过),
   * 所以"带 .on 的那个"就是本次悬停的那一条 —— 这个选择器本身就是不变量。
   */
  const fireScript = `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const edgeEls = () => Array.from(document.querySelectorAll('.react-flow__edge'))
    const btns = () => Array.from(document.querySelectorAll('.react-flow__edgelabel-renderer button.edge-cut'))

    const n0 = edgeEls().length
    const live = document.querySelector('.react-flow__edgelabel-renderer button.edge-cut.on')
    if (!live) {
      return { ok: false, detail: '走到点击这一步时剪刀已经收起来了(悬停状态没保持住)' }
    }

    live.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await wait(1100)   // 存盘去抖 500ms,留足时间

    const n1 = edgeEls().length
    const after = btns().length
    const stillOn = btns().filter((b) => b.classList.contains('on')).length

    return {
      ok: n1 === n0 - 1 && after === n0 - 1 && stillOn === 0,
      detail:
        '点击后 连线 ' + n0 + ' → ' + n1 + '(期望 ' + (n0 - 1) + ')' +
        ' | 剪刀 ' + n0 + ' → ' + after + ' | 切断后仍亮着=' + stillOn,
    }
  })()`

  let r2: { ok: boolean; detail: string }
  try {
    r2 = (await win.webContents.executeJavaScript(fireScript)) as typeof r2
  } catch (e) {
    return { ok: false, detail: '连线体检(点击段)脚本抛错:' + (e as Error).message }
  }

  /*
   * 第三段:验证**另一条**切断路径 —— 点选连线 → 工具栏的按钮变成「断开连线」→ 点它。
   *
   * 为什么两段都测:剪刀和"选中后删"是两条独立实现的路径(前者自定义边组件自己调
   * removeEdge,后者靠 onEdgeClick → uiStore.selectEdge → 工具栏),共用同一个
   * removeEdge。只测一条的话,另一条断了不会有人发现 —— 而它恰恰是键盘用户走的路。
   * 第二段跑完正好还剩一条线,拿它当材料。
   */
  const selectScript = `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const edgeEls = () => Array.from(document.querySelectorAll('.react-flow__edge'))
    const toolBtns = () => Array.from(document.querySelectorAll('.canvas-tools button'))
      .map((b) => (b.textContent || '').trim())

    const n0 = edgeEls().length
    if (n0 === 0) return { ok: false, detail: '没有剩下的连线了,验证不了「选中后切断」这条路' }

    const g = edgeEls()[0]
    const path = g.querySelector('.react-flow__edge-interaction') || g.querySelector('.react-flow__edge-path')
    path.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await wait(420)

    const btn = Array.from(document.querySelectorAll('.canvas-tools button'))
      .find((b) => (b.textContent || '').indexOf('断开连线') >= 0)
    if (!btn) {
      return {
        ok: false,
        detail: '点选连线后工具栏没出现「断开连线」。现有按钮=[' + toolBtns().join(' | ') + ']',
      }
    }

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await wait(1100)

    const n1 = edgeEls().length
    const stillThere = toolBtns().some((t) => t.indexOf('断开连线') >= 0)
    return {
      ok: n1 === n0 - 1 && !stillThere,
      detail:
        '点选→工具栏「断开连线」: 连线 ' + n0 + ' → ' + n1 +
        ' | 按钮已收回=' + !stillThere,
    }
  })()`

  let r3: { ok: boolean; detail: string }
  try {
    r3 = (await win.webContents.executeJavaScript(selectScript)) as typeof r3
  } catch (e) {
    return { ok: false, detail: '连线体检(选中段)脚本抛错:' + (e as Error).message }
  }

  return {
    ok: r2.ok && r3.ok,
    detail: r1.detail + ' ‖ ' + r2.detail + ' ‖ ' + r3.detail,
  }
}

/**
 * 整合节点面板体检。
 *
 * 与 NODEAGENT 那条不同:**完全不动画布**(不造节点、不删节点),只是选中
 * 画布上已有的整合节点、切到配置页、读文案。所以它对用户数据零风险;
 * 画布上没有整合节点时如实跳过,而不是失败。
 *
 * 要查的是两件**类型检查看不见**的事:
 *   ① 面板真的渲染得出来,且新职责文案在里面(JSX 里嵌了 <b> 与换行,
 *      渲染期抛错的话类型检查一路绿灯);
 *   ② 占位文案里的默认指令首行**确实取自常量** ——
 *      手抄的那一版会漂,而且漂了没人会发现(两边没有机械约束)。
 */
async function mergePanelChecks(win: BrowserWindow): Promise<{ ok: boolean; detail: string }> {
  const script = `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    const node = document.querySelector('.agent-node.kind-merge')
    if (!node) return { ok: true, detail: '画布上没有整合节点 —— 跳过(这条检查只读,不造节点)' }

    click(node)
    await wait(500)

    const cfgTab = Array.from(document.querySelectorAll('.inspector .tabs button'))
      .find((b) => (b.textContent || '').indexOf('节点配置') >= 0)
    if (!cfgTab) return { ok: false, detail: '右栏找不到「节点配置」页签' }
    click(cfgTab)
    await wait(500)

    const panel = document.querySelector('.node-config')
    if (!panel) return { ok: false, detail: '切到配置页后没有 .node-config(面板没渲染出来)' }

    // 职责文案是面板里第一个 .fhint(在 AgentCommonFields 之前)
    const hint = panel.querySelector('.fhint')
    const hintText = ((hint && hint.innerText) || '').replace(/\\s+/g, ' ')
    const tpl = panel.querySelector('textarea')
    const ph = tpl ? (tpl.getAttribute('placeholder') || '') : ''
    const labels = Array.from(panel.querySelectorAll('.cfglabel > span')).map((s) => (s.textContent || '').trim())

    const hasCompat = hintText.indexOf('互相兼容') >= 0
    const hasSerial = hintText.indexOf('串行支路') >= 0
    const phFromConst = ph.indexOf('整合进项目') >= 0
    return {
      ok: hasCompat && hasSerial && phFromConst && labels.indexOf('Agent') >= 0,
      detail:
        '职责文案=' + (hintText ? '「' + hintText.slice(0, 40) + '…」' : '(无)') +
        ' | 含"互相兼容"=' + hasCompat +
        ' | 含"串行支路"=' + hasSerial +
        ' | 占位取自常量=' + phFromConst +
        ' | 配置字段=[' + labels.join(',') + ']',
    }
  })()`
  try {
    return (await win.webContents.executeJavaScript(script)) as { ok: boolean; detail: string }
  } catch (e) {
    return { ok: false, detail: '整合节点面板体检脚本抛错:' + (e as Error).message }
  }
}

/**
 * 重画的界面体检:添加菜单 + 快捷键浮层。
 *
 * **完全不动画布**(只开/关两个浮层,不改任何节点与连线),所以对用户数据零风险。
 *
 * 要查的是三件**类型检查看不见**的事:
 *   ① 九条添加入口都渲染得出来,而且每条都带类型图标(SVG)—— 图标是按
 *      `icon` 字段查表画的,名字写错时查不到只会画出一个空 `<svg>`,
 *      编译期一路绿灯;
 *   ② 菜单与角标里**没有 emoji/符号回退**(重画的核心目标);
 *   ③ 快捷键浮层真的渲染出分组与行,而且搜索能用 —— "整块浮层渲染期抛错"
 *      在类型检查里同样是绿的。
 *
 * 截图两张(添加菜单 / 快捷键浮层),让人能直接看见重画后的样子。
 */
async function uiSkinChecks(
  win: BrowserWindow,
  shotBase?: string,
): Promise<{ ok: boolean; detail: string }> {
  const script = `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const SYMBOLISH = /[\\u{1F300}-\\u{1FAFF}\\u{2190}-\\u{21FF}\\u{25A0}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{FE0F}]/u

    // ---------- ① 添加菜单 ----------
    const addBtn = document.querySelector('.canvas-tools .add-wrap > button')
    if (!addBtn) return { ok: false, detail: '找不到「添加节点」按钮' }
    click(addBtn)
    await wait(420)

    const items = Array.from(document.querySelectorAll('.canvas-tools .add-menu button'))
    const labels = items.map((b) => ((b.querySelector('.add-label') || {}).textContent || '').trim())
    const withIcon = items.filter((b) => b.querySelector('.add-icon svg.icon')).length
    const emojiLabels = labels.filter((t) => SYMBOLISH.test(t))
    const menuText = (document.querySelector('.canvas-tools .add-menu') || {}).innerText || ''

    // 图标必须是**画出来**的:svg 有尺寸与路径,空 svg(名字查不到)会是 0 个子元素
    const shaped = items.filter((b) => {
      const svg = b.querySelector('.add-icon svg.icon')
      return svg && svg.childElementCount > 0 && svg.getBoundingClientRect().width > 4
    }).length

    const second = document.querySelector('.canvas-tools .add-menu button:nth-child(2)')
    if (second) {
      const r = second.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      window.__uiSkinMenuHit = hit ? (second.contains(hit) ? '自己' : '被挡') : '点不到'
    }

    // ---------- ② 快捷键浮层 ----------
    // 菜单还开着,先按 Esc 关掉(与真实用户的路径一致)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wait(260)

    const scBtn = document.querySelector('.topbar button[aria-label="键盘快捷键"]')
    if (!scBtn) return { ok: false, detail: '找不到顶栏的快捷键按钮(aria-label 变了?)' }
    click(scBtn)
    await wait(420)

    const modal = document.querySelector('.sc-modal')
    if (!modal) return { ok: false, detail: '快捷键浮层没有渲染出 .sc-modal' }
    const groups = Array.from(modal.querySelectorAll('.sc-group h3')).map((h) =>
      (h.textContent || '').replace(/\\d+$/, '').trim(),
    )
    const rows = modal.querySelectorAll('.sc-item').length
    const keycaps = modal.querySelectorAll('.kbd').length
    const hasMouse = groups.some((g) => g.indexOf('鼠标操作') >= 0)
    const foot = (modal.querySelector('.sc-foot') || {}).innerText || ''

    /*
     * 搜索:受控 input,必须用原生 setter 改值再派发 input 事件,
     * 直接赋值会被 React 的 value tracker 吞掉(与 NODEAGENT 里改 select 同一个坑)。
     */
    const search = modal.querySelector('.sc-search input')
    if (!search) return { ok: false, detail: '快捷键浮层里没有搜索框' }
    const rowsAll = rows
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(search, '缩放')
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(400)
    const rowsFiltered = document.querySelectorAll('.sc-modal .sc-item').length
    const filteredLabels = Array.from(document.querySelectorAll('.sc-modal .sc-label')).map((d) => d.textContent || '')
    const filterHits = filteredLabels.filter((t) => t.indexOf('缩放') >= 0).length

    // 清空搜索(按钮),把浮层恢复原样并关掉
    const clearBtn = document.querySelector('.sc-modal .sc-clear')
    if (clearBtn) click(clearBtn)
    await wait(260)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wait(320)

    return {
      ok:
        items.length === 9 &&
        withIcon === 9 &&
        shaped === 9 &&
        emojiLabels.length === 0 &&
        groups.length >= 4 &&
        rowsAll >= 12 &&
        keycaps >= 10 &&
        hasMouse &&
        rowsFiltered > 0 &&
        rowsFiltered < rowsAll &&
        filterHits > 0 &&
        !document.querySelector('.sc-modal'),
      detail:
        '添加入口=' + items.length + ' 带图标=' + withIcon + ' 真画出=' + shaped +
        ' | 标签含emoji=' + emojiLabels.length +
        ' | 菜单=' + (menuText ? '「' + menuText.replace(/\\s+/g, ' ').slice(0, 60) + '…」' : '(空)') +
        ' | 菜单第2项可见性=' + (window.__uiSkinMenuHit || '(未测)') +
        ' | 快捷键分组=[' + groups.join(',') + '] 行=' + rowsAll + ' 键帽=' + keycaps +
        ' | 鼠标操作区=' + hasMouse +
        ' | 搜「缩放」→ 行=' + rowsFiltered + '(原' + rowsAll + ') 命中标题=' + filterHits +
        ' | 页脚' + (foot.indexOf('同源') >= 0 ? '同源' : '异常') +
        ' | 关闭后浮层残留=' + !!document.querySelector('.sc-modal'),
    }
  })()`

  /*
   * 截图必须在**浮层还开着**的时候拍,所以这里再开一次菜单 / 浮层,
   * 拍完再关。顺序:菜单 → 截图 → 关闭 → 快捷 → 截图 → 关闭。
   */
  try {
    if (shotBase) {
      const shoot = async (js: string): Promise<void> => {
        await win.webContents.executeJavaScript(js)
        await new Promise((r) => setTimeout(r, 500))
      }
      const menuShot = shotBase.replace(/(\.png)?$/i, '-addmenu.png')
      await shoot(`(() => {
        const b = document.querySelector('.canvas-tools .add-wrap > button')
        if (b && !document.querySelector('.canvas-tools .add-menu')) b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        return true
      })()`)
      fs.writeFileSync(menuShot, (await win.webContents.capturePage()).toPNG())
      console.log(`UISKIN-SHOT ${menuShot}`)
      await shoot(`(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        return true
      })()`)

      const keysShot = shotBase.replace(/(\.png)?$/i, '-keys.png')
      await shoot(`(() => {
        const b = document.querySelector('.topbar button[aria-label="键盘快捷键"]')
        if (b && !document.querySelector('.sc-modal')) b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        return true
      })()`)
      fs.writeFileSync(keysShot, (await win.webContents.capturePage()).toPNG())
      console.log(`UISKIN-SHOT ${keysShot}`)
      await shoot(`(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        return true
      })()`)
    }
    return (await win.webContents.executeJavaScript(script)) as { ok: boolean; detail: string }
  } catch (e) {
    return { ok: false, detail: '界面重画体检脚本抛错:' + (e as Error).message }
  }
}

export async function runProbe(win: BrowserWindow): Promise<void> {
  /*
   * 把渲染进程的错误捞出来。
   *
   * 没有这层,渲染进程崩了只表现为"界面上什么都没有",而体检脚本能查到的
   * 只有"元素不存在"—— 那是症状,不是病因。用户报的「点开节点显示无内容」
   * 就属于这类:必须看到 React 抛的那条原始错误才知道是哪儿。
   */
  win.webContents.on('console-message', (e) => {
    // Electron 38 把参数改成了单个事件对象;旧签名是 (event, level, message, ...)
    const anyE = e as unknown as {
      level?: number | string
      message?: string
      lineNumber?: number
      sourceId?: string
    }
    const level = String(anyE.level ?? '')
    const isErr = level === 'error' || level === '2'
    if (!isErr) return
    console.log(`RENDERER-ERR ${anyE.message ?? ''} @${anyE.sourceId ?? '?'}:${anyE.lineNumber ?? '?'}`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.log(`RENDERER-GONE ${JSON.stringify(details)}`)
  })

  // 等到渲染进程真正加载完
  await new Promise<void>((resolve) => {
    if (!win.webContents.isLoading()) return resolve()
    win.webContents.once('did-finish-load', () => resolve())
  })

  // 刚 did-finish-load 时内存还在往上爬(V8 在扩容、字体/合成器在初始化),
  // 等它稳定下来再读,否则两次运行的数字没有可比性
  const settleMs = Number(process.env['HAOWAN_PROBE_MS'] ?? 5000)
  await new Promise((r) => setTimeout(r, settleMs))

  const s = getSettings()
  const metrics = app.getAppMetrics().map((m) => ({
    type: String(m.type),
    pid: m.pid,
    // Electron 给的就是 KB
    workingSetMb: Math.round((m.memory?.workingSetSize ?? 0) / 1024),
    peakMb: Math.round((m.memory?.peakWorkingSetSize ?? 0) / 1024),
  }))

  console.log(
    'PROBE ' +
      JSON.stringify({
        disableGpu: s.memory.disableGpu,
        lowEndDeviceMode: s.memory.lowEndDeviceMode,
        maxOldSpaceMb: s.memory.maxOldSpaceMb,
        totalMb: metrics.reduce((n, m) => n + m.workingSetMb, 0),
        metrics,
      }),
  )

  const layout = await layoutChecks(win)
  console.log(`LAYOUT ${layout.ok ? 'OK' : 'FAIL'} ${layout.detail}`)

  const insp = await inspectorChecks(win)
  console.log(`INSPECTOR ${insp.ok ? 'OK' : 'FAIL'} ${insp.detail}`)
  if (insp.text) console.log(`INSPECTOR-TEXT ${insp.text}`)

  const st = await settingsChecks(win)
  console.log(`SETTINGS ${st.ok ? 'OK' : 'FAIL'} ${st.detail}`)
  if (st.text) console.log(`SETTINGS-TEXT ${st.text}`)

  const na = await nodeAgentChecks(win)
  console.log(`NODEAGENT ${na.ok ? 'OK' : 'FAIL'} ${na.detail}`)

  // 截图路径由同一个环境变量派生,后缀区分是哪一条检查
  const shot = process.env['HAOWAN_PROBE_SHOT']
  const ec = await edgeCutChecks(win, shot ? shot.replace(/(\.png)?$/i, '-edge.png') : undefined)
  console.log(`EDGECUT ${ec.ok ? 'OK' : 'FAIL'} ${ec.detail}`)

  /*
   * 放在 EDGECUT **之后**:它要选中节点并切页签,先跑的话会把选中态留给
   * 后面的连线检查(那边依赖"点线 → 工具栏变断开连线")。只读的检查不该
   * 影响有状态的检查 —— 顺序本身就是契约的一部分。
   */
  const mp = await mergePanelChecks(win)
  console.log(`MERGEPANEL ${mp.ok ? 'OK' : 'FAIL'} ${mp.detail}`)

  // 重画后的界面(添加菜单 / 快捷键浮层)。不动画布,所以放在最后随便跑
  const ui = await uiSkinChecks(win, shot)
  console.log(`UISKIN ${ui.ok ? 'OK' : 'FAIL'} ${ui.detail}`)

  app.exit(0)
}
