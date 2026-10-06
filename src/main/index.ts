// ⚠️ 必须是本文件第一条语句。
// 不先做路径重定向,Electron 会把 userData / Chromium 缓存 / 崩溃转储
// 全部堆到 C 盘 —— 而 C 盘只剩 11.2GB,这是全项目最高优先级的约束。
import { initPaths, SETTINGS_FILE } from './paths'

initPaths()

import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { createIpc } from './ipc/register'
import { runProbe } from './devProbe'
import { applyBootSwitches, captureApplied, readSettingsSync } from './settings/store'
import { killAllBuiltin } from './builtin/registry'
import { CH, EV } from '../shared/ipc'
import type { SessionManager } from './agents/manager'
import type { NodeLogHub } from './persist/hub'
import type { WorkflowRunner } from './workflow/runner'

/*
 * 设置必须在 whenReady **之前**读,而且必须同步。
 *
 * 这里有个绕不开的矛盾:disableHardwareAcceleration / commandLine.appendSwitch
 * 只能在 ready 之前调,而设置是运行时可改的。解法是让读取路径**不依赖 app** ——
 * 用 paths.ts 里的字面常量定位文件,readFileSync + zod 兜底,永不抛
 *(settings.json 是可以被用户手改坏的,而这里抛异常等于应用起不来)。
 *
 * 本次进程实际生效的值会被 captureApplied 记下来,之后与用户新改的值做 diff,
 * 就能算出"哪些字段要重启才生效"。
 */
const bootSettings = readSettingsSync(SETTINGS_FILE)
applyBootSwitches(app, bootSettings)
captureApplied(bootSettings)

let manager: SessionManager | null = null
let hub: NodeLogHub | null = null
let runner: WorkflowRunner | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    /*
     * 默认窗口小一点(原来 1440×900)。右栏固定 420px,1440 宽时画布有
     * 一千多像素,空荡得没必要;而且默认铺满近半个屏幕,多开几个窗口就互相压。
     * 1200×760 装得下三四个节点加右栏,想大就自己拉 —— 尺寸会被记住。
     */
    width: 1200,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    show: false,
    /*
     * 无边框窗口(自绘顶栏 + 窗口控制按钮)。
     *
     * 顶栏的 `-webkit-app-region: drag` 拖动区与按钮的 `no-drag` 早已就绪
     * (theme.css .topbar),这里只是补上缺的那一半:去掉系统边框,
     * 并注册最小化/最大化/关闭的 IPC —— 没有它们,无边框窗口就关不掉。
     */
    frame: false,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 主进程侧已做路径重定向,这里关掉沙箱是为了 preload 能用完整 node API;
      // contextIsolation 仍然开着,渲染进程拿不到裸 require
      sandbox: false,
    },
  })

  /*
   * 无边框的窗口控制。用 `event.sender` 反查窗口而不是闭包捕获 `win`:
   * 应用支持多开(createWindow 每次调用建一个新窗口),闭包只绑第一个窗口,
   * 第二个窗口点「关闭」会关掉第一个 —— 这类 bug 极难在单窗口测试里发现。
   */
  ipcMain.handle(CH.winMinimize, (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize()
  })
  ipcMain.handle(CH.winToggleMaximize, (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w) return { ok: false as const, error: '找不到窗口' }
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
    return { ok: true as const, data: { maximized: w.isMaximized() } }
  })
  ipcMain.handle(CH.winClose, (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close()
  })
  ipcMain.handle(CH.winIsMaximized, (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    return { ok: true as const, data: { maximized: !!w?.isMaximized() } }
  })
  // 最大化/还原状态变化推给渲染进程,自绘按钮据此切换「最大化/还原」图标
  win.on('maximize', () => win.webContents.send(EV.winMaximizeChanged, true))
  win.on('unmaximize', () => win.webContents.send(EV.winMaximizeChanged, false))

  // 首帧就绪再显示,避免白屏闪烁
  win.once('ready-to-show', () => win.show())

  // 外链一律交给系统浏览器,不在应用内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

// 不调用 requestSingleInstanceLock —— 需求本身就要"多开"
void app.whenReady().then(() => {
  const ipc = createIpc()
  manager = ipc.manager
  hub = ipc.hub
  runner = ipc.runner
  const win = createWindow()

  // 内存实测模式(见 devProbe.ts)。平时不设这个环境变量,永远不会走到
  if (process.env['HAOWAN_PROBE']) void runProbe(win)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/*
 * 清场。**三步的顺序是硬约束,写错了会让退出永久挂起**:
 *
 *  ① `runner.cancelAll()` —— 必须在 manager.killAll() **之前**。
 *     runner 里等一个节点是靠 `manager.waitFor()`(它 await session.done)。
 *     killAll 会把 live 表清空,那之后 waitFor 既查不到 live 也查不到
 *     lastExit,永久等下去;而 before-quit 又 preventDefault 了,
 *     结果就是应用关不掉、任务管理器里一堆僵尸。
 *     反过来先取消:runner 标记 cancelled 并从调度循环里退出,
 *     之后 killAll 才有意义。
 *  ② **把日志写完** —— 排队中的 append 还在飞,直接退会丢掉最后几条。
 *     所以要 preventDefault 一次,等 flush 完再真正退。
 *  ③ 再杀进程树。claude 会派生 Bash/node 子进程,不连树杀会留一堆孤儿。
 *     内置动作子进程(electron-builder 打包 / 出图子进程)同样会派生 node 子进程,
 *     因此 killAllBuiltin() 与 manager.killAll() 并列在最后一步
 *     —— 它覆盖注册表里全部内置动作,不再逐一点名 packager。
 */
let quitting = false
app.on('before-quit', (e) => {
  if (quitting) return
  quitting = true
  e.preventDefault()
  // ① 先让调度器松手(它才是那个会 await 会话结束的人)。
  //    cancelNode 会经 cancelBuiltin 先停掉在跑的内置动作子进程。
  runner?.cancelAll()
  runner?.reap()
  runner = null
  // ② 再等日志落盘,③ 最后杀树(agent 会话 + 全部内置动作子进程)
  void (hub?.flushAll() ?? Promise.resolve()).finally(() => {
    manager?.killAll()
    killAllBuiltin()
    manager = null
    hub = null
    app.quit()
  })
})
