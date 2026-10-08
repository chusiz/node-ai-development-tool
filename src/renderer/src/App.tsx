import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Canvas } from './flow/Canvas'
import { GuideOverlay } from './components/GuideOverlay'
import { SessionBridge } from './components/SessionBridge'
import { RunBar } from './components/Workflow/RunBar'
import { InspectorPanel } from './components/Inspector/InspectorPanel'
import { ProjectDirButton } from './components/ProjectDirButton'
import { SettingsPanel } from './components/Settings/SettingsPanel'
import { SkillsDrawer } from './components/Skills/SkillsDrawer'
import { ShortcutsHelp } from './components/ShortcutsHelp'
import { Icon } from './components/Icons'
import { WindowControls } from './components/WindowControls'
import { FirstRunBanner } from './components/FirstRunBanner'
import { MemoryMeter } from './components/Settings/MemoryMeter'
import { useShortcuts } from './hooks/useShortcuts'
import { useSettingsStore } from './stores/settingsStore'
import { flushGraphSave, useGraphStore } from './stores/graphStore'
import { useRuntimeStore } from './stores/runtimeStore'
import { useUiStore } from './stores/uiStore'
import { unwrap } from './lib/unwrap'
import { agentDisplayNameMap } from './lib/agentNames'
import { t } from './lib/i18n'
import { canvasIdFor, WORKSPACE_LABEL, type WorkspaceId } from '../../shared/nodeRegistry'
import { effectiveModel, providerIdOfAgent } from '../../shared/providers'
import type { DetectResult } from './types'

/**
 * 画布 id = 项目 + 工作区(双工作区 + 多项目并行,v0.5.0):
 *   - default 项目的软件制作画布兼容旧画布 'default'(旧数据无缝升级);
 *   - 其余 = `<projectId>-<workspace>`,如 mygame-image / mygame-app。
 * 数据布局 `data/canvases/<id>/` 天然支持多画布。
 */
const WORKSPACE_LIST: WorkspaceId[] = ['app', 'image']

export default function App(): JSX.Element {
  const [detect, setDetect] = useState<DetectResult | null>(null)
  const [bootErr, setBootErr] = useState<string | null>(null)

  const loaded = useGraphStore((s) => s.loaded)
  const nodeCount = useGraphStore((s) => s.nodes.length)
  const canvasName = useGraphStore((s) => s.name)
  const saving = useGraphStore((s) => s.saving)
  const saveError = useGraphStore((s) => s.saveError)
  const addNode = useGraphStore((s) => s.addNode)
  /*
   * 只在**节点集合**变化时补历史,不跟着 nodes 数组走 ——
   * 拖动会改 nodes 的引用(位置在 data 之外),跟着它跑就等于每拖一下读一遍磁盘。
   * 拼成字符串做依赖,zustand 的 Object.is 才拦得住无谓的重跑。
   */
  const nodeIdsKey = useGraphStore((s) => s.nodes.map((n) => n.id).join('\u0001'))
  const hydrate = useRuntimeStore((s) => s.hydrate)
  const select = useUiStore((s) => s.select)
  const showSettings = useUiStore((s) => s.showSettings)
  const setShowSettings = useUiStore((s) => s.setShowSettings)
  const showSkills = useUiStore((s) => s.showSkills)
  const setShowSkills = useUiStore((s) => s.setShowSkills)
  const showShortcuts = useUiStore((s) => s.showShortcuts)
  const setShowShortcuts = useUiStore((s) => s.setShowShortcuts)
  const workspace = useUiStore((s) => s.workspace)
  const setWorkspace = useUiStore((s) => s.setWorkspace)
  const projectId = useUiStore((s) => s.projectId)
  const setProjectId = useUiStore((s) => s.setProjectId)
  const projects = useUiStore((s) => s.projects)
  const addProject = useUiStore((s) => s.addProject)

  // 画布 id = 项目 + 工作区;切换时重载对应画布
  const canvasId = canvasIdFor(projectId, workspace)

  // 全应用唯一的按键监听。挂在 App 上,生命周期与窗口一致
  useShortcuts()

  useEffect(() => {
    void useGraphStore.getState().load(canvasId)
  }, [canvasId])

  /*
   * 画布读出来之后,把每个节点的历史从磁盘补回来。
   *
   * 不做这一步的话,"重启后能接上上下文"就只是磁盘上的一堆文件:
   * 界面是空的,而且因为渲染进程不知道上一轮的 sessionId,下一句话会开个新会话 ——
   * 用户看到的现象就是"记得的东西全丢了"。
   */
  useEffect(() => {
    if (!loaded) return
    const ids = nodeIdsKey ? nodeIdsKey.split('\u0001') : []
    if (ids.length === 0) return
    void hydrate(canvasId, ids)
  }, [loaded, nodeIdsKey, hydrate, canvasId])

  const recheck = useCallback(async (): Promise<void> => {
    try {
      setDetect(unwrap<DetectResult>(await window.api.agents.detect('claude')))
      setBootErr(null)
    } catch (e) {
      setBootErr((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void recheck()
  }, [recheck])

  /*
   * 顶栏「当前模型」入口:显示设置里配置的默认模型(任意供应商,
   * 火山方舟 / Gemini / 自定义 API / 本地模型……),不再绑死 claude。
   * 取 providers 里第一个填了 defaultModel 的;没填则提示去设置。
   */
  const agentProviders = useSettingsStore((s) => s.payload?.current?.agent?.providers)
  const selectedNodeId = useUiStore((s) => s.selectedNodeId)
  const selectedNode = useGraphStore((s) =>
    selectedNodeId ? s.nodes.find((n) => n.id === selectedNodeId) : undefined,
  )

  /* agent id → 显示名(顶栏 title 里给用户看名字,而不是 claude-cli 这种内部 id) */
  const [agentNames, setAgentNames] = useState<Record<string, string> | null>(null)
  useEffect(() => {
    void agentDisplayNameMap().then(setAgentNames)
  }, [])

  /*
   * 顶栏模型入口的取值优先级:
   *   选中了会话节点 → 显示该节点实际生效的模型(节点显式选的 > 该供应商默认 > 内置首选);
   *   否则 → 全局默认(设置里第一个配了 defaultModel 的供应商)。
   * 每个节点都可在「节点配置」里单独选自己的 agent 和模型,顶栏随之反映。
   */
  const globalModel = useMemo(() => {
    if (!agentProviders) return null
    for (const cfg of Object.values(agentProviders)) {
      const m = (cfg?.defaultModel ?? '').trim()
      if (m) return m
    }
    return null
  }, [agentProviders])

  const nodeModel = useMemo(() => {
    if (!selectedNode) return null
    const pid = providerIdOfAgent(selectedNode.data.agentId)
    const def = pid ? (agentProviders?.[pid]?.defaultModel ?? '') : ''
    const eff = effectiveModel(selectedNode.data.agentId, selectedNode.data.model, def)
    return eff || null
  }, [selectedNode, agentProviders])

  const shownModel = selectedNode ? nodeModel : globalModel
  const agentName = selectedNode
    ? agentNames?.[selectedNode.data.agentId ?? ''] ?? selectedNode.data.agentId ?? null
    : null
  const modelTitle = selectedNode
    ? `${t('topbar.modelTitle.node', undefined, { name: selectedNode.data.title ?? selectedNode.id, agent: agentName ?? t('topbar.modelTitle.defaultAgent'), model: shownModel ?? t('topbar.modelTitle.defaultModel') })}`
    : shownModel
      ? t('topbar.modelTitle.global', undefined, { model: shownModel })
      : t('topbar.modelTitle.none')

  /*
   * 设置面板关掉之后重探一次。
   *
   * 用户去设置里干的事,十有八九就是"把 claude 路径填对"。不重探的话,
   * 他改完保存、关掉设置,顶栏和横幅还挂着刚才那个"未检测到" —— 明明已经修好了,
   * 界面却还在说他没修,只能再开一次设置面板来回确认。
   */
  const settingsOpenRef = useRef(false)
  useEffect(() => {
    if (settingsOpenRef.current && !showSettings) void recheck()
    settingsOpenRef.current = showSettings
  }, [showSettings, recheck])

  /*
   * 关窗前补一次存盘。
   *
   * 存盘是 500ms 去抖的,最后几次改动很可能还躺在定时器里。
   * 这里**不能** await(浏览器不给 beforeunload 异步的机会),但 flush 内部
   * 会立刻发起一次 invoke —— 主进程收到消息后才关窗口,写盘能赶上。
   */
  useEffect(() => {
    const onUnload = (): void => {
      void flushGraphSave()
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  /*
   * DetectResult 自 v0.4.0 起是判别联合(found:true 还分 cli / api 两种形态)。
   * 顶栏已不再显示 claude 徽标(改为「当前模型」入口),detect 仅供 FirstRunBanner 使用。
   */

  return (
    <div className="app">
      <SessionBridge />

      <div className="topbar">
        <span className="brand">Node AI Development Tool</span>

        {/* 项目选择器:多项目并行 —— 每个项目有自己的生图 + 软件制作画布 */}
        <select
          className="project-select"
          title={t('topbar.project')}
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>

        {/* 工作区切换:生图 / 软件制作 两个独立页面(图标化,悬停显示名称) */}
        <div className="ws-tabs" role="tablist">
          {WORKSPACE_LIST.map((ws) => {
            const label = t(`ws.${ws}`)
            return (
              <button
                key={ws}
                role="tab"
                aria-selected={workspace === ws}
                title={label}
                aria-label={label}
                className={workspace === ws ? 'ws-tab on' : 'ws-tab'}
                onClick={() => setWorkspace(ws)}
              >
                <Icon name={ws === 'app' ? 'terminal' : 'image'} size={14} />
              </button>
            )
          })}
        </div>

        <span className="badge">{canvasName}</span>
        <span className="badge">{t('topbar.nodes', undefined, { n: String(nodeCount) })}</span>

        <ProjectDirButton />

        <span className="spacer" />

        {saveError ? (
          <span className="badge err" title={saveError}>
            {t('topbar.saveFailed')}
          </span>
        ) : (
          saving && <span className="badge">{t('topbar.saving')}</span>
        )}

        {/* 模型入口:选中节点时显示该节点的模型,否则显示全局默认。绿=已配置,红=未配置。点击打开设置 */}
        <button
          className={shownModel ? 'badge ok model-flag' : 'badge err model-flag'}
          title={modelTitle}
          aria-label={shownModel ? t('topbar.model', undefined, { m: shownModel }) : t('topbar.modelConfigure')}
          onClick={() => setShowSettings(true)}
        >
          <Icon name="terminal" size={12} />
        </button>

        <MemoryMeter />
        <button onClick={() => setShowSkills(true)} title={t('topbar.skills')} aria-label={t('topbar.skills')}>
          <Icon name="skill" size={14} />
        </button>
        <button
          className="ghost"
          onClick={() => setShowShortcuts(true)}
          title={t('topbar.shortcuts')}
          aria-label={t('topbar.shortcuts')}
        >
          <Icon name="keyboard" size={14} />
        </button>
        <button onClick={() => setShowSettings(true)} title={t('topbar.settings')} aria-label={t('topbar.settings')}>
          <Icon name="settings" size={14} />
        </button>

        {/* 无边框窗口的自绘窗口控制 —— 必须顶栏最后一个,固定贴右缘 */}
        <WindowControls />
      </div>

      {/* 首次运行/换机器时的 CLI 缺失引导。放在 topbar 与 body 之间:
          .app 是纵向 flex,它独占一行,不会挤进 .body 的横向布局里 */}
      <FirstRunBanner
        detect={detect}
        bootErr={bootErr}
        onRecheck={() => void recheck()}
        onOpenSettings={() => setShowSettings(true)}
      />

      <div className="body">
        {loaded ? (
          /*
           * 两段式:上面是画布,下面是运行条。
           *
           * 运行条**不是浮层** —— 之前它绝对定位在画布上沿,会盖住节点。
           * 做成布局里的一行之后,无论窗口多小都挡不住任何东西。
           */
          <div className="canvas-wrap">
            <div className="canvas-stage">
              <Canvas />
              {/* v0.6.4 新手引导:画布右上角「?」,5 步讲完第一单 */}
              <GuideOverlay />
              {/* 空画布时给一个明确的起点,而不是让用户对着干净背景发愣 */}
              {nodeCount === 0 && (
                <div className="canvas-empty">
                  <div className="big">
                    <Icon name="logo" size={34} />
                  </div>
                  <div>
                    {workspace === 'image'
                      ? '生图工作区是空的'
                      : '软件制作画布是空的'}
                  </div>
                  <div className="sub">
                    {workspace === 'image' ? (
                      <>
                        放一个「正向提示词」节点开始:写下画面要什么,连「负向提示词」和
                        「采样出图」,再接「图片输出 / 交接」,就是一条完整生图流水线。
                        切换工作区到「软件制作」后,交接节点能直接引用这批素材。
                      </>
                    ) : (
                      <>
                        先放一个项目节点试试:它是项目文件夹的权威来源,
                        之后接串行/并行功能、整合、输出,连成一条完整流水线
                      </>
                    )}
                  </div>
                  <div className="sub keys">
                    放好之后:点节点在右栏对话 · <span className="kbd">Ctrl</span>
                    <span className="sc-sep">+</span>
                    <span className="kbd">Enter</span> 跑全部 · <span className="kbd">?</span> 看全部快捷键
                  </div>
                  <button
                    className="primary"
                    onClick={() => {
                      /*
                       * 起点节点按工作区给:软件 = 项目节点(目录权威来源);
                       * 生图 = 正向提示词(画面描述起点)。
                       *
                       * ⚠️ 页签必须**和选中一起**交给 store(第二个参数),不能
                       * 先 select 再 setInspectorTab —— 那样会被 Inspector 里
                       * "换节点就回对话页"的 effect 抢回去,用户落在对话页,
                       * 看到没有输入框的表单提示「要让它改你的项目,再去节点配置…」,
                       * 于是以为要自己手打路径。原因详见 uiStore.selectionTab。
                       */
                      select(addNode(undefined, workspace === 'image' ? 'prompt' : 'project'), 'config')
                    }}
                  >
                    {workspace === 'image' ? '+ 放置正向提示词节点' : '+ 放置项目节点'}
                  </button>
                </div>
              )}
            </div>
            {nodeCount > 0 && <RunBar />}
          </div>
        ) : (
          <div className="canvas-wrap loading">正在读取画布…</div>
        )}
        <InspectorPanel />
      </div>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      {showSkills && <SkillsDrawer onClose={() => setShowSkills(false)} />}
      {showShortcuts && <ShortcutsHelp onClose={() => setShowShortcuts(false)} />}
    </div>
  )
}
