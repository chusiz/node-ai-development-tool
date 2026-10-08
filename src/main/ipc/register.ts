import { app, BrowserWindow, dialog, ipcMain, shell, webContents } from 'electron'
import fsp from 'node:fs/promises'
import {
  CH,
  EV,
  type CanvasGraph,
  type DetectResult,
  type Envelope,
  type ProcessMetricEntry,
  type ProbeProgressPayload,
  type ProviderView,
  type SecretStoreInfo,
  type SettingsPayload,
  type StartRequest,
  type WorkflowSpec,
  type FileFilter,
} from '../../shared/ipc'
import { pathsInfo } from '../paths'
import { getAdapter, hasAdapter } from '../agents/registry'
import { agentListEntries } from '../agents/list'
import { configuredCliPath } from '../agents/cliPath'
import { SessionManager } from '../agents/manager'
import { NodeLogHub } from '../persist/hub'
import { loadGraph, saveGraph } from '../canvas/store'
import { parseSettings } from '../../shared/settings'
import { saveSettings, settingsPayload, getSettings } from '../settings/store'
import {
  PROVIDERS,
  effectiveBaseUrl,
  effectiveModel,
  getProvider,
  providerOfAgent,
} from '../../shared/providers'
import { clearKey, keyFor, setKey, statusFor, storeInfo } from '../secrets/store'
import { fetchModels, testProvider } from '../providers'
import { probeModels } from '../providers/probe'
import { startSession } from '../startSession'
import {
  deleteSkill,
  installSkillDir,
  listSkills,
  setSkillEnabled,
  skillsDropDir,
} from '../skills/store'
import { installSkillFromUrl } from '../skills/remote'
import type { SkillMarketItem } from '../../shared/ipc'
import { WorkflowRunner, CycleError } from '../workflow/runner'
import { makeRunnerEnv } from '../workflow/env'
import { readRun } from '../workflow/runLog'
// v0.6.4 启动懒加载:重模块(Packager / ImageGen / VideoGen / Handoff / ChartGen / TestRunner / PythonRunner)
// 改为 type import + 惰性工厂 —— 首次真正用到时才动态 import。冷启动只加载轻模块,
// 图像/打包/图表这些重依赖不再阻塞"画布先可用"。
import type { Packager } from '../packager'
import type { ImageGen } from '../imagegen'
import type { VideoGen } from '../videogen'
import type { Handoff } from '../handoff'
import type { ChartGen } from '../chartgen/ChartGen'
import type { TestRunner } from '../testrun'
import type { PythonRunner } from '../pythonrun'
import { killAllBuiltin, registerBuiltinAction } from '../builtin/registry'
import { auditProject } from '../audit'
import { sdStatus, sdStart, sdStop, type LocalSdStatus, type SdStartResult } from '../localservices'
import { readThumb } from '../images/readThumb'
import type { NodeEvent, SessionStatus } from '../agents/types'

// ---- 惰性单例工厂(首次调用才动态 import 重模块) ----
let _packager: Packager | null = null
const getPackager = async (): Promise<Packager> => (_packager ??= new (await import('../packager')).Packager())
let _imagegen: ImageGen | null = null
const getImagegen = async (): Promise<ImageGen> => (_imagegen ??= new (await import('../imagegen')).ImageGen())
let _testrun: TestRunner | null = null
const getTestrun = async (): Promise<TestRunner> => (_testrun ??= new (await import('../testrun')).TestRunner())
let _videogen: VideoGen | null = null
const getVideogen = async (): Promise<VideoGen> => (_videogen ??= new (await import('../videogen')).VideoGen())
let _handoff: Handoff | null = null
const getHandoff = async (): Promise<Handoff> => (_handoff ??= new (await import('../handoff')).Handoff())
let _chartgen: ChartGen | null = null
const getChartgen = async (): Promise<ChartGen> => (_chartgen ??= new (await import('../chartgen/ChartGen')).ChartGen())
let _pythonrun: PythonRunner | null = null
const getPythonrun = async (): Promise<PythonRunner> => (_pythonrun ??= new (await import('../pythonrun')).PythonRunner())

function ok<T>(data: T): Envelope<T> {
  return { ok: true, data }
}
function fail(e: unknown): Envelope<never> {
  return { ok: false, error: e instanceof Error ? e.message : String(e) }
}

/**
 * 内置技能市场精选(v0.6.2,4.4 S3)。
 *
 * 选品原则(设计报告 4.4.2):本地可运行 / 无第三方账号依赖 / 覆盖互补。
 * 这里只列**真实存在**的公开仓库,不编造子路径 —— 整仓安装时 collectSkillDirs
 * 会把仓库根下一层所有技能目录一次收齐,不用逐个挑。
 * 任意公开技能仓库 URL 都可经「粘贴 URL 安装」入口安装,不限于下表。
 */
const SKILL_MARKET: SkillMarketItem[] = [
  {
    id: 'anthropics-skills',
    label: 'anthropics/skills · 官方全家桶',
    description:
      'Anthropic 官方技能集:docx / pdf / pptx / xlsx 办公读写、web-search / web-fetch 联网检索、' +
      'deep-research 多步研究、artifact-builder HTML 产物、canvas-design 视觉设计等几十个技能(整仓一次装齐)。',
    url: 'https://github.com/anthropics/skills',
    author: 'Anthropic 官方',
    tags: ['官方', '办公文档', '联网检索', '研究', '设计'],
  },
  {
    id: 'obra-superpowers',
    label: 'obra/superpowers · 社区全能技能集',
    description:
      '知名社区技能集(superpowers):写作、编程、研究、日常任务等大量可组合技能,本地可跑、无账号依赖。',
    url: 'https://github.com/obra/superpowers',
    author: 'Jesse Vincent(obra)',
    tags: ['社区', '写作', '编程', '研究'],
  },
]

/** 统一包一层:任何 handler 抛异常都变成 { ok:false, error },渲染侧不必 try/catch */
function handle<A extends unknown[], R>(
  channel: string,
  fn: (...args: A) => R | Promise<R>,
): void {
  ipcMain.handle(channel, async (_e, ...args: unknown[]) => {
    try {
      return ok(await fn(...(args as A)))
    } catch (e) {
      return fail(e)
    }
  })
}

function broadcast(channel: string, payload: unknown): void {
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed()) wc.send(channel, payload)
  }
}

export async function createIpc(): Promise<{
  manager: SessionManager
  hub: NodeLogHub
  runner: WorkflowRunner
}> {
  /*
   * 日志中枢。manager 的回调是同步的,而写盘是异步的 ——
   * 串行化在这里做(见 hub.ts 的注释),否则渲染进程会先收到
   * 「本轮结束」再收到最后几段正文。
   */
  const hub = new NodeLogHub({
    log: (nodeId, canvasId, recs) => broadcast(EV.nodeLog, { nodeId, canvasId, recs }),
    progress: (nodeId, ev) => broadcast(EV.nodeProgress, { nodeId, ev }),
    exit: (nodeId, status, code) => broadcast(EV.sessionExit, { nodeId, status, code }),
  })

  const manager = new SessionManager({
    events: (nodeId: string, events: NodeEvent[]) => hub.appendEvents(nodeId, events),
    exit: (nodeId: string, status: SessionStatus, code: number | null) =>
      hub.appendExit(nodeId, status, code),
    /*
     * ⚠️ 先落盘再广播,两个都不能省。
     *
     * 只广播的话,这个 id 就只活在渲染进程的内存里 —— 重启后 meta 里还是 null,
     * 下一句话会开新会话。之前就是这个缺口:只有 Claude 形状的 init 事件
     * 会让 hub 顺手记下 id(absorb),发现型 id 的 agent 全都是断的。
     */
    sessionId: (nodeId: string, sessionId: string) => {
      hub.setSessionId(nodeId, sessionId)
      broadcast(EV.sessionStatus, { nodeId, sessionId })
    },
    log: (nodeId: string, stderr: string) => broadcast(EV.sessionStatus, { nodeId, stderr }),
  })

  /*
   * 内置动作执行器。**先于** runner 创建并 register 好:
   * RunnerEnv.runBuiltinAction 与 cancelNode 都经内置动作注册表分发
   * —— 输出打包与图像出图各注册一条,runner 只认 `action` 这个数据。
   *
   * ⚠️ 这里不再有人点名 Packager/ImageGen:加一个内置动作(未来 video…)
   * 只需 new 一个执行器 + registerBuiltinAction,调度链路零改动。
   */
  const packager = await getPackager()
  const imagegen = await getImagegen()
  const testrun = await getTestrun()
  registerBuiltinAction('package', {
    run: async (r) => {
      // v0.6.4 安全审计(改进建议第六条):打包前自动做依赖审计 + 密钥泄露检测,结果进 notice 与产物报告
      const report = await auditProject(r.projectDir)
      r.onProgress?.(`[安全审计] ${report.summary.split('\n').join(' | ')}`)
      const res = await packager.run(r)
      if (res.ok && r.projectDir) {
        try {
          const fsp = await import('node:fs/promises')
          const pathMod = await import('node:path')
          const dir = pathMod.join(r.projectDir, 'assets', 'generated', 'audit')
          await fsp.mkdir(dir, { recursive: true })
          await fsp.writeFile(
            pathMod.join(dir, 'audit-report.json'),
            JSON.stringify({ at: new Date().toISOString(), ...report }, null, 2),
            'utf8',
          )
        } catch {
          /* 审计报告写不进去不阻塞打包 */
        }
      }
      return res
    },
    cancel: (id) => packager.cancel(id),
    killAll: () => packager.killAll(),
  })
  registerBuiltinAction('image', {
    run: (r) => imagegen.run(r),
    cancel: (id) => imagegen.cancel(id),
    killAll: () => imagegen.killAll(),
  })
  registerBuiltinAction('test', {
    run: (r) => testrun.run(r),
    cancel: (id) => testrun.cancel(id),
    killAll: () => testrun.killAll(),
  })
  const videogen = await getVideogen()
  registerBuiltinAction('video', {
    run: (r) => videogen.run(r),
    cancel: (id) => videogen.cancel(id),
    killAll: () => videogen.killAll(),
  })
  const handoff = await getHandoff()
  registerBuiltinAction('handoff', {
    run: (r) => handoff.run(r),
  })
  // 可视化图形(v0.6.2):图表节点 —— ECharts SSR 出 SVG,落盘 assets/generated/charts/
  const chartgen = await getChartgen()
  registerBuiltinAction('chart', {
    run: (r) => chartgen.run(r),
  })
  // v0.6.4 多语言节点:python —— 子进程跑脚本,stdout 交下游(改进建议第七条)
  const pythonrun = await getPythonrun()
  registerBuiltinAction('python', {
    run: (r) => pythonrun.run(r),
    cancel: (id) => pythonrun.cancel(id),
  })
  /*
   * 生图工作区(v0.5.0)执行器:
   *   - noop:prompt / prompt_negative 节点 —— 把提示词文本作为节点产出交下去;
   *   - sampler:采样出图节点 —— 与 image 同一引擎(ImageGen),提示词由上游汇入;
   *   - image-output:图片输出节点 —— 与 handoff 同一收尾(扫描素材目录出清单)。
   */
  registerBuiltinAction('noop', {
    run: async (r) => ({
      ok: true,
      handoffText: (r.promptText ?? r.negativeText ?? '').trim(),
      log: '',
    }),
  })
  registerBuiltinAction('sampler', {
    run: (r) => imagegen.run(r),
    cancel: (id) => imagegen.cancel(id),
    killAll: () => imagegen.killAll(),
  })
  registerBuiltinAction('image-output', {
    run: (r) => handoff.run(r),
  })

  /*
   * 工作流调度器。它不直接碰 manager/hub/内置动作执行器 —— 全部经 RunnerEnv 递进去,
   * 于是同一份调度逻辑在 e2e 里可以配一个假的 env 跑,不需要起真 agent。
   */
  const runner = new WorkflowRunner(
    makeRunnerEnv({
      manager,
      hub,
      emit: (ev) => broadcast(EV.workflowRun, ev),
    }),
  )

  handle(CH.appInfo, () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
  }))

  handle(CH.appPaths, (): Record<string, string> => pathsInfo())

  // ---- 本地生图服务(SD WebUI)一键启停(v0.4.2) ----
  handle(CH.localSdStatus, (): Promise<LocalSdStatus> => sdStatus())
  handle(CH.localSdStart, (_e, port?: number): Promise<SdStartResult> => sdStart(port, app.getPath('userData')))
  handle(CH.localSdStop, (): Promise<{ ok: boolean; message: string }> => sdStop())

  handle(CH.agentList, () => agentListEntries())

  handle(
    CH.agentDetect,
    async (agentId: string, overridePath?: string, probe?: boolean): Promise<DetectResult> => {
      /*
       * API 型(`api:<providerId>`):没有可执行文件可探,探的是"Key 配好了没、地址通不通"。
       * 分成两条路而不是硬塞进同一条:CLI 那套 tried/exe/source 对 HTTP 毫无意义。
       */
      const provider = providerOfAgent(agentId)
      if (provider) {
        const cfg = getSettings().agent.providers[provider.id]
        const baseUrl = effectiveBaseUrl(provider, cfg?.baseUrl)
        const model = effectiveModel(agentId, undefined, cfg?.defaultModel)
        const keyReady = provider.optionalKey || statusFor(provider.id).hasKey

        /*
         * 判据是"能不能用",所以 found 只在真能用时为 true。
         * 两处都不能直接用布尔表达式的值去填 found —— 那会让 TS 认为
         * `found: boolean` 而联合类型只接受字面量 true / false,于是报 TS2322。
         * 分支写开还有一层好处:每种失败都能带一句对症的 message。
         */
        if (!keyReady) {
          return {
            found: false,
            kind: 'api',
            message: `未配置 ${provider.label} 的 API Key,请到「设置 › 模型服务商」填写`,
            tried: [baseUrl],
          }
        }
        if (!probe) {
          return { found: true, kind: 'api', providerId: provider.id, baseUrl, model, keyReady }
        }
        // probe=true 时真发一次请求 —— 这是唯一能同时证明"Key 对 + 地址对 + 模型存在"的办法
        const test = await testProvider(provider, { baseUrl: cfg?.baseUrl, model })
        if (!test.ok) {
          return { found: false, kind: 'api', message: test.message, tried: [baseUrl] }
        }
        return {
          found: true,
          kind: 'api',
          providerId: provider.id,
          baseUrl,
          model,
          keyReady,
          test,
        }
      }

      // CLI 型
      if (!hasAdapter(agentId)) {
        return { found: false, kind: 'cli', message: `未知的 agent:${agentId}`, tried: [] }
      }
      const adapter = getAdapter(agentId)
      /*
       * 三级:调用方临时指定(设置页"检测"按钮)> 设置里存的 > 自动探测。
       * overridePath 允许"试探一个还没保存的路径",否则用户得先保存再看结果,
       * 探测失败时设置里就留下了一个坏值。
       */
      const loc = await adapter.detect(overridePath || configuredCliPath(agentId))
      if (!loc) {
        return { found: false, kind: 'cli', message: `未找到 ${adapter.displayName} 可执行文件`, tried: [] }
      }
      return {
        found: true,
        kind: 'cli',
        exe: loc.exe,
        version: loc.version,
        source: loc.source,
        tried: loc.tried,
      }
    },
  )

  /* ---------------- 模型服务商与密钥 ---------------- */

  handle(CH.providerList, (): ProviderView[] => {
    const cfg = getSettings().agent.providers
    return PROVIDERS.map((p) => ({
      def: p,
      secret: statusFor(p.id),
      baseUrlOverride: cfg[p.id]?.baseUrl ?? '',
      defaultModel: cfg[p.id]?.defaultModel ?? '',
      verifiedModels: cfg[p.id]?.verifiedModels ?? [],
      recentModels: cfg[p.id]?.recentModels ?? [],
    }))
  })

  handle(
    CH.providerModels,
    async (providerId: string, override?: { key?: string; baseUrl?: string }) => {
      const p = getProvider(providerId)
      if (!p) throw new Error(`未知的服务商:${providerId}`)
      const cfg = getSettings().agent.providers[providerId]
      // 传进来的 key 是"还没保存、想先试试"的那一把;没有就用已保存的
      const key = override?.key?.trim() || keyFor(providerId)
      const baseUrl = override?.baseUrl ?? cfg?.baseUrl ?? ''
      return fetchModels(p, baseUrl, key)
    },
  )

  handle(
    CH.providerTest,
    async (providerId: string, override?: { key?: string; baseUrl?: string; model?: string }) => {
      const p = getProvider(providerId)
      if (!p) throw new Error(`未知的服务商:${providerId}`)
      const cfg = getSettings().agent.providers[providerId]
      return testProvider(p, {
        baseUrl: override?.baseUrl ?? cfg?.baseUrl,
        key: override?.key?.trim() || keyFor(providerId),
        model: override?.model ?? cfg?.defaultModel,
      })
    },
  )

  handle(
    CH.providerProbe,
    async (
      providerId: string,
      override?: { key?: string; baseUrl?: string; manualModels?: string[] },
    ) => {
      const p = getProvider(providerId)
      if (!p) throw new Error(`未知的服务商:${providerId}`)
      const cfg = getSettings().agent.providers[providerId]
      /*
       * 探测结果**不**在这里落盘。
       *
       * 落盘走 settings 的 `verifiedModels`(与 defaultModel 同级),由渲染进程
       * 在用户点「保存」时一起写 —— 与地址/默认模型同一套草稿-保存语义。
       * 在这里直接写 settings 会绕过那道门:用户探完了没点保存,却已经落盘了,
       * 而地址改动还没落 —— 两份配置对不上,下次启动节点上选到的是旧地址配新模型。
       */
      return probeModels(p, {
        baseUrl: override?.baseUrl ?? cfg?.baseUrl,
        key: override?.key?.trim() || keyFor(providerId),
        manualModels: override?.manualModels,
        /*
         * 进度经既有广播通道冒泡,不开新机制。
         * 带 providerId:设置页可能同时展开多张卡片,渲染侧按 id 过滤
         * (见 shared/ipc.ts 的 ProbeProgressPayload 注释)。
         */
        onProgress: (done, total, aborted) =>
          broadcast(EV.providerProbe, { providerId, done, total, aborted } satisfies ProbeProgressPayload),
      })
    },
  )

  handle(CH.secretSet, (providerId: string, key: string) => {
    if (!getProvider(providerId)) throw new Error(`未知的服务商:${providerId}`)
    // 只回脱敏状态 —— 明文 Key 绝不回渲染进程(见 shared/secrets.ts)
    return setKey(providerId, key)
  })

  handle(CH.secretClear, (providerId: string) => {
    if (!getProvider(providerId)) throw new Error(`未知的服务商:${providerId}`)
    return clearKey(providerId)
  })

  handle(CH.secretInfo, (): SecretStoreInfo => storeInfo())

  // 与工作流调度器共用同一个入口(见 startSession.ts),两条路不会漂
  handle(CH.sessionStart, (req: StartRequest) => startSession(hub, manager, req))

  handle(CH.sessionCancel, (nodeId: string) => ({ cancelled: manager.cancel(nodeId) }))

  /*
   * 读回历史。渲染进程启动/切画布时对每个节点各调一次。
   *
   * 一次返回日志尾部 **和** meta —— 分两次调的话,界面会先出现一堆消息、
   * 过一会儿才补上 sessionId,中间那一瞬用户如果发消息就成了新会话。
   */
  handle(CH.nodeLogTail, (canvasId: string, nodeId: string, limit: number) =>
    hub.readStateOf(canvasId, nodeId, limit),
  )

  handle(CH.nodeBlob, (canvasId: string, hash: string) => hub.readBlob(canvasId, hash))

  /* ---------- 技能库 ----------
   *
   * 增删改之后**不回列表**,而是让渲染侧自己再 list 一次。
   * 返回列表的话,这次操作的结果和界面上的列表就成了两份数据,
   * 并发两次操作(比如快速连点两个删除)就会互相覆盖 —— 后到的那个
   * 带着过期的快照把先删的又画了回来。
   */
  handle(CH.skillList, () => listSkills())

  handle(CH.skillSetEnabled, async (name: string, enabled: boolean) => {
    await setSkillEnabled(name, enabled)
    return { name }
  })

  handle(CH.skillDelete, async (name: string) => {
    await deleteSkill(name)
    return { name }
  })

  handle(CH.skillImportLocal, (sourceDir: string) =>
    installSkillDir(sourceDir, { kind: 'local', path: sourceDir, at: Date.now() }),
  )

  /* ---------- 开源技能市场(v0.6.2,4.4 S1+S3) ---------- */
  handle(CH.skillInstallFromUrl, (url: string) => installSkillFromUrl(url))

  handle(CH.skillMarketList, () => SKILL_MARKET)

  handle(CH.skillOpenDir, async () => {
    const err = await shell.openPath(skillsDropDir())
    if (err) throw new Error(err)
    return { opened: true as const }
  })

  handle(CH.nodeReset, async (canvasId: string, nodeId: string) => {
    // 先取消在跑的会话 —— 否则它接下来的事件会写进刚清空的日志里,
    // 界面出现"清空后又冒出几条"的诡异现象
    manager.cancel(nodeId)
    await hub.flush(nodeId)
    await hub.resetNode(canvasId, nodeId)
    return { reset: true as const }
  })

  /*
   * 工作流的发起。**不走 handle()** —— 环检测的失败要带上"环上那几个节点",
   * 而统一信封的失败分支只有一句 error。UI 拿不到节点就只能去解析错误字符串,
   * 那是把展示格式当契约用,改一个字就崩。
   */
  ipcMain.handle(CH.workflowRun, async (_e, spec: WorkflowSpec): Promise<Envelope<unknown>> => {
    try {
      return ok(await runner.run(spec))
    } catch (e) {
      if (e instanceof CycleError) {
        return { ok: false, error: e.message, detail: { cycle: e.cycle } }
      }
      return fail(e)
    }
  })

  handle(CH.workflowCancel, (runId: string) => ({ cancelled: runner.cancel(runId) }))

  handle(CH.workflowCancelNode, (runId: string, nodeId: string) => ({
    cancelled: runner.cancelNode(runId, nodeId),
  }))

  // 内存里没有(应用重启过)就回磁盘 —— 运行态落盘的全部意义就在这里
  handle(CH.workflowGet, async (runId: string) => runner.get(runId) ?? (await readRun(runId)))

  handle(CH.canvasLoad, (canvasId: string) => loadGraph(canvasId))

  handle(CH.canvasSave, async (canvasId: string, graph: CanvasGraph) => {
    await saveGraph(canvasId, graph)
    return { saved: true as const }
  })

  /*
   * 缩略图只读通道(S2)。渲染端不直接碰 fs,但它要显示图像节点的产出缩略图。
   *
   * 渲染端传「项目文件夹 + 相对路径」进来,**一律当不可信输入**:主进程做
   * 白名单化(assets/generated/**)+ 规范化前缀校验 + realpath 再校验 + 扩展名/大小
   * 限制,只回 nativeImage 缩放后的小尺寸 dataUrl。校验只在主进程 —— 渲染端传绝对
   * 路径 / `..` 一律被拒(见 images/readThumb.ts 的注释)。
   */
  handle(CH.imageReadThumb, (projectDir: string, relPath: string) => readThumb(projectDir, relPath))

  /*
   * 文件/文件夹选择器。
   *
   * 挂在主进程是因为渲染进程没有真实路径的概念(web 沙箱里只有 File 对象),
   * 而 agent 的 cwd 需要的是**绝对路径**。
   *
   * busy 标志:同一个窗口上叠两个模态选择器会让 Windows 上出现点不动的幽灵窗口。
   */
  let dialogBusy = false
  const withDialog = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (dialogBusy) throw new Error('已经有一个选择器打开了')
    dialogBusy = true
    try {
      return await fn()
    } finally {
      dialogBusy = false
    }
  }

  const parentWindow = (): BrowserWindow | undefined =>
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]

  handle(CH.dialogPickDirectory, (title?: string, defaultPath?: string) =>
    withDialog(async () => {
      const win = parentWindow()
      const opts: Electron.OpenDialogOptions = {
        title: title ?? '选择工作目录',
        defaultPath,
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: '用这个目录',
      }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
    }),
  )

  handle(CH.dialogPickFile, (title?: string, filters?: FileFilter[]) =>
    withDialog(async () => {
      const win = parentWindow()
      const opts: Electron.OpenDialogOptions = {
        title: title ?? '选择可执行文件',
        properties: ['openFile'],
        filters:
          filters && filters.length > 0
            ? filters
            : [
                { name: '可执行文件', extensions: ['exe', 'cmd', 'bat'] },
                { name: '全部文件', extensions: ['*'] },
              ],
      }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
    }),
  )

  handle(CH.dialogSaveFile, (title?: string, defaultName?: string, filters?: FileFilter[]) =>
    withDialog(async () => {
      const win = parentWindow()
      const opts: Electron.SaveDialogOptions = {
        title: title ?? '保存文件',
        defaultPath: defaultName ?? 'untitled.json',
        filters:
          filters && filters.length > 0
            ? filters
            : [{ name: '全部文件', extensions: ['*'] }],
      }
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      return res.canceled || !res.filePath ? null : res.filePath
    }),
  )

  handle(CH.fsWriteText, async (filePath: string, content: string) => {
    if (!filePath || typeof filePath !== 'string') throw new Error('缺少文件路径')
    await fsp.writeFile(filePath, String(content), 'utf8')
    return { written: true as const }
  })

  handle(CH.fsReadText, async (filePath: string) => {
    if (!filePath || typeof filePath !== 'string') throw new Error('缺少文件路径')
    return await fsp.readFile(filePath, 'utf8')
  })

  handle(CH.shellOpenPath, async (p: string) => {
    const err = await shell.openPath(p)
    if (err) throw new Error(err)
    return { opened: true as const }
  })

  /*
   * v0.6.4 产物预览(改进建议第二条"产物预览内置化"):
   *   - web  → 在产物目录起一个本地静态服务,打开默认浏览器;
   *   - exe  → 直接启动(单文件绿色包/安装包都直接跑);
   *   - game → 打开 zip 所在目录(Godot 项目需用户自己用 Godot 打开)。
   * 目录不存在 / 不是目录 → 人话报错,不让用户对着一条 ENOENT 猜。
   */
  handle(CH.previewOutput, async (dir: string, target: string) => {
    if (!dir || typeof dir !== 'string') throw new Error('缺少产物目录')
    const { stat } = await import('node:fs/promises')
    let st
    try {
      st = await stat(dir)
    } catch {
      throw new Error(`产物目录不存在:${dir}(先运行输出节点完成打包)`)
    }
    if (!st.isDirectory()) throw new Error(`${dir} 不是目录`)
    if (target === 'web') {
      const http = await import('node:http')
      const fsp2 = await import('node:fs/promises')
      const pathMod = await import('node:path')
      const PORT = 0 // 0 = 系统分配空闲端口
      const server = http.createServer((req, res) => {
        void (async () => {
          try {
            const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
            let p = pathMod.join(dir, urlPath === '/' ? 'index.html' : urlPath)
            if (!p.startsWith(pathMod.resolve(dir))) {
              res.writeHead(403).end('forbidden')
              return
            }
            let data: Buffer
            try {
              data = await fsp2.readFile(p)
            } catch {
              // 目录请求兜底 index.html
              data = await fsp2.readFile(pathMod.join(p, 'index.html'))
            }
            const ext = pathMod.extname(p).toLowerCase()
            const mime =
              { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' }[ext] ?? 'application/octet-stream'
            res.writeHead(200, { 'content-type': mime }).end(data)
          } catch {
            res.writeHead(404).end('not found')
          }
        })()
      })
      await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve))
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 4173
      const url = `http://127.0.0.1:${port}/`
      const err = await shell.openExternal(url)
      void err
      return { opened: true as const, url }
    }
    if (target === 'exe') {
      const { spawn } = await import('node:child_process')
      const fsp2 = await import('node:fs/promises')
      const pathMod = await import('node:path')
      // 在产物目录里找第一个 .exe(dist/ 优先,再兜底根目录)
      const candidates = [pathMod.join(dir, 'dist'), dir]
      let exe: string | null = null
      for (const base of candidates) {
        try {
          const entries = await fsp2.readdir(base)
          const found = entries.find((n) => n.toLowerCase().endsWith('.exe'))
          if (found) {
            exe = pathMod.join(base, found)
            break
          }
        } catch {
          /* 目录不存在就试下一个 */
        }
      }
      if (!exe) {
        await shell.openPath(dir)
        return { opened: true as const }
      }
      const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false })
      child.unref()
      return { opened: true as const }
    }
    // game 等其它:打开所在目录
    const err2 = await shell.openPath(dir)
    if (err2) throw new Error(err2)
    return { opened: true as const }
  })

  // v0.6.4 安全审计:依赖审计 + 密钥泄露检测(改进建议第六条)
  handle(CH.auditProject, async (dir: string) => auditProject(dir))

  handle(CH.settingsGet, (): SettingsPayload => settingsPayload())

  handle(CH.settingsSet, async (raw: unknown): Promise<SettingsPayload> => {
    // 渲染进程传来的东西一律当不可信输入过一遍 schema —— 越界值(比如内存上限
    // 填个负数或 1e9)在这里被夹回合法区间,而不是等到打命令行开关时才炸
    await saveSettings(parseSettings(raw))
    /*
     * 清掉探测缓存。manager 会把 claude.exe 的绝对路径缓存起来(239MB 的二进制,
     * 每次探测都要跑一遍 --version,不缓存太浪费)。不清的话用户在设置里改了路径
     * 却"改了没反应" —— 缓存还指着旧的那个。
     */
    manager.clearExeCache()
    return settingsPayload()
  })

  handle(CH.settingsRelaunch, () => {
    /*
     * ⚠️ 顺序不能反,而且有三步:
     *   ① runner.cancelAll() —— 必须在 killAll **之前**。反过来的话 live 表
     *      已被清空,runner 里等 session.done 的逻辑再也醒不过来,这里就卡死了。
     *      cancelNode 会先经 cancelBuiltin 停掉在跑的内置动作(打包/出图)。
     *   ② manager.killAll() + killAllBuiltin() —— app.exit() **不会**触发
     *      before-quit,不显式杀的话每个正在跑的 claude / electron-builder /
     *      出图子进程都会变成孤儿。
     *   ③ relaunch。
     */
    runner.cancelAll()
    void hub.flushAll().finally(() => {
      manager.killAll()
      killAllBuiltin()
      app.relaunch()
      app.exit(0)
    })
    return { relaunching: true as const }
  })

  handle(CH.systemMetrics, (): ProcessMetricEntry[] =>
    app.getAppMetrics().map((m) => ({
      pid: m.pid,
      type: String(m.type),
      // Electron 的 workingSetSize 单位就是 KB,不要再去乘 1024
      workingSetKb: m.memory?.workingSetSize ?? 0,
      peakKb: m.memory?.peakWorkingSetSize ?? 0,
      cpuPercent: m.cpu?.percentCPUUsage ?? 0,
    })),
  )

  return { manager, hub, runner }
}
