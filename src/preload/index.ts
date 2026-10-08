import { contextBridge, ipcRenderer } from 'electron'
import { CH, EV, type FileFilter, type RendererApi } from '../shared/ipc'

/**
 * 订阅统一返回**退订函数**。
 * 组件卸载时不退订是 Electron 应用最常见的内存泄漏来源
 * (React StrictMode 下 effect 跑两次,监听器直接翻倍)。
 */
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

// 显式标注类型:契约在 shared/ipc.ts,实现不 conform 编译期就报
const api: RendererApi = {
  app: {
    info: () => ipcRenderer.invoke(CH.appInfo),
    paths: () => ipcRenderer.invoke(CH.appPaths),
  },
  agents: {
    list: () => ipcRenderer.invoke(CH.agentList),
    detect: (agentId: string, overridePath?: string, probe?: boolean) =>
      ipcRenderer.invoke(CH.agentDetect, agentId, overridePath, probe),
  },
  /*
   * ⚠️ 这三个方法与 secrets.* 都**不会**让明文 Key 过界:
   * 传进去的 key 是"还没保存、想先试试"的那一把,出来的只有脱敏信息与结果。
   * 明文只在主进程内存里 —— 见 shared/secrets.ts 顶部的说明。
   */
  providers: {
    list: () => ipcRenderer.invoke(CH.providerList),
    models: (providerId: string, override?: { key?: string; baseUrl?: string }) =>
      ipcRenderer.invoke(CH.providerModels, providerId, override),
    test: (providerId: string, override?: { key?: string; baseUrl?: string; model?: string }) =>
      ipcRenderer.invoke(CH.providerTest, providerId, override),
    // 挨个验证一批候选模型。会发多个真实计费请求,UI 必须先告知用户数量
    probe: (
      providerId: string,
      override?: { key?: string; baseUrl?: string; manualModels?: string[] },
    ) => ipcRenderer.invoke(CH.providerProbe, providerId, override),
    // 订阅必须返回退订函数,否则 StrictMode 下 effect 跑两次会翻倍
    onProbeProgress: (cb) => on(EV.providerProbe, cb),
  },
  secrets: {
    set: (providerId: string, key: string) =>
      ipcRenderer.invoke(CH.secretSet, providerId, key),
    clear: (providerId: string) => ipcRenderer.invoke(CH.secretClear, providerId),
    info: () => ipcRenderer.invoke(CH.secretInfo),
  },
  session: {
    start: (req) => ipcRenderer.invoke(CH.sessionStart, req),
    cancel: (nodeId: string) => ipcRenderer.invoke(CH.sessionCancel, nodeId),
    onLog: (cb) => on(EV.nodeLog, cb),
    onProgress: (cb) => on(EV.nodeProgress, cb),
    onExit: (cb) => on(EV.sessionExit, cb),
    onStatus: (cb) => on(EV.sessionStatus, cb),
    logTail: (canvasId: string, nodeId: string, limit: number) =>
      ipcRenderer.invoke(CH.nodeLogTail, canvasId, nodeId, limit),
    blob: (canvasId: string, hash: string) => ipcRenderer.invoke(CH.nodeBlob, canvasId, hash),
    reset: (canvasId: string, nodeId: string) => ipcRenderer.invoke(CH.nodeReset, canvasId, nodeId),
  },
  canvas: {
    load: (canvasId: string) => ipcRenderer.invoke(CH.canvasLoad, canvasId),
    save: (canvasId: string, graph) => ipcRenderer.invoke(CH.canvasSave, canvasId, graph),
  },
  image: {
    // 相对路径 + 项目文件夹一起传;主进程做白名单/前缀/realpath/扩展名/大小校验
    readThumb: (projectDir: string, relPath: string) =>
      ipcRenderer.invoke(CH.imageReadThumb, projectDir, relPath),
  },
  localSd: {
    status: () => ipcRenderer.invoke(CH.localSdStatus),
    start: (port?: number) => ipcRenderer.invoke(CH.localSdStart, port),
    stop: () => ipcRenderer.invoke(CH.localSdStop),
  },
  workflow: {
    run: (spec) => ipcRenderer.invoke(CH.workflowRun, spec),
    cancel: (runId: string) => ipcRenderer.invoke(CH.workflowCancel, runId),
    cancelNode: (runId: string, nodeId: string) =>
      ipcRenderer.invoke(CH.workflowCancelNode, runId, nodeId),
    get: (runId: string) => ipcRenderer.invoke(CH.workflowGet, runId),
    onEvent: (cb) => on(EV.workflowRun, cb),
  },
  skills: {
    list: () => ipcRenderer.invoke(CH.skillList),
    setEnabled: (name: string, enabled: boolean) =>
      ipcRenderer.invoke(CH.skillSetEnabled, name, enabled),
    remove: (name: string) => ipcRenderer.invoke(CH.skillDelete, name),
    importLocal: (sourceDir: string) => ipcRenderer.invoke(CH.skillImportLocal, sourceDir),
    openDir: () => ipcRenderer.invoke(CH.skillOpenDir),
    installFromUrl: (url: string) => ipcRenderer.invoke(CH.skillInstallFromUrl, url),
    marketList: () => ipcRenderer.invoke(CH.skillMarketList),
  },
  dialog: {
    pickDirectory: (title?: string, defaultPath?: string) =>
      ipcRenderer.invoke(CH.dialogPickDirectory, title, defaultPath),
    pickFile: (title?: string, filters?: FileFilter[]) => ipcRenderer.invoke(CH.dialogPickFile, title, filters),
    saveFile: (title?: string, defaultName?: string, filters?: FileFilter[]) =>
      ipcRenderer.invoke(CH.dialogSaveFile, title, defaultName, filters),
  },
  fs: {
    writeText: (filePath, content) => ipcRenderer.invoke(CH.fsWriteText, filePath, content),
    readText: (filePath) => ipcRenderer.invoke(CH.fsReadText, filePath),
  },
  shell: {
    openPath: (p: string) => ipcRenderer.invoke(CH.shellOpenPath, p),
  },
  // v0.6.4 产物预览:web → 起本地静态服务并打开;exe → 直接启动;game → 打开所在目录
  preview: {
    output: (dir: string, target: string) => ipcRenderer.invoke(CH.previewOutput, dir, target),
  },
  // v0.6.4 安全审计:依赖审计 + 密钥泄露检测
  audit: {
    project: (dir: string) => ipcRenderer.invoke(CH.auditProject, dir),
  },
  settings: {
    get: () => ipcRenderer.invoke(CH.settingsGet),
    set: (next) => ipcRenderer.invoke(CH.settingsSet, next),
    relaunch: () => ipcRenderer.invoke(CH.settingsRelaunch),
    metrics: () => ipcRenderer.invoke(CH.systemMetrics),
  },
  /*
   * 无边框窗口控制。帧被去掉后这四件事只能自绘按钮 + IPC 做;
   * onMaximizeChanged 用于切换「最大化/还原」图标。
   */
  windowCtl: {
    minimize: () => ipcRenderer.invoke(CH.winMinimize),
    toggleMaximize: () => ipcRenderer.invoke(CH.winToggleMaximize),
    close: () => ipcRenderer.invoke(CH.winClose),
    isMaximized: () => ipcRenderer.invoke(CH.winIsMaximized),
    onMaximizeChanged: (cb) => on(EV.winMaximizeChanged, cb),
  },
}

contextBridge.exposeInMainWorld('api', api)
