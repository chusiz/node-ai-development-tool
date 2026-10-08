import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 数据根是怎么定下来的。UI 要把它显示出来 —— 用户换机器之后第一件想知道的事
 * 就是"我的东西存哪了",靠猜不如直接告诉他。
 */
export type RootMode = 'env' | 'dev' | 'portable' | 'userdata' | 'fallback'

/** 绿色版的开关文件。放在 exe 旁边,存在即表示"数据跟着这个文件夹走" */
export const PORTABLE_FLAG = 'portable.flag'

/**
 * `electron` 在**纯 node** 里被 require 时导出的是二进制路径字符串(不是模块对象),
 * 于是 `app` 是 undefined。e2e 就是跑在纯 node 里的,它会 import 本文件 ——
 * 这里必须先判断宿主,否则模块顶层就会 `undefined.isPackaged` 直接炸掉整个测试。
 */
const hasElectronApp =
  typeof app === 'object' && app !== null && typeof (app as { getPath?: unknown }).getPath === 'function'

/**
 * 解析数据根。**优先级从高到低**,每一级都有明确的"为什么"。
 *
 * ### ① `CLAUDE_CANVAS_HOME` 环境变量
 * 运维/多实例/自己指定盘符。只接受绝对路径 —— 相对路径的含义取决于启动方式,
 * 与其猜一个,不如当作没设。
 *
 * ### ② 开发态:仓库根
 * `electron .` 的 appPath 就是项目根。开发时数据仍落在仓库根下的 data 目录,
 * 换机器 clone 下来也一样能跑(数据跟着仓库走)。
 *
 * ### ③ 打包态 + exe 旁边有 `portable.flag`:绿色版
 * 数据放在 exe 同级目录。整个文件夹拷到 U 盘/另一台电脑,画布和历史一起搬过去。
 * 用**显式开关文件**而不是"目录可写就用它"这种隐式判断 —— 隐式判断在
 * Program Files 里会静默变成不可写,报错现场离原因十万八千里。
 *
 * ### ④ 兜底:用户级 AppData
 * NSIS 装到 `%LOCALAPPDATA%\Programs\...`,AppData 一定可写,不需要管理员权限。
 * 这是"装到任何一台 Windows 上都能跑"的那条路。
 */
function resolveRoot(): { root: string; mode: RootMode } {
  const envHome = process.env['CHUSIZ_HOME']
  if (envHome && path.isAbsolute(envHome)) {
    return { root: path.normalize(envHome), mode: 'env' }
  }

  // 非 Electron 宿主(e2e / 脚本):以 cwd 为根,与开发态行为一致
  if (!hasElectronApp) return { root: process.cwd(), mode: 'dev' }

  if (!app.isPackaged) {
    try {
      return { root: app.getAppPath(), mode: 'dev' }
    } catch {
      return { root: process.cwd(), mode: 'dev' }
    }
  }

  try {
    const exeDir = path.dirname(app.getPath('exe'))
    if (fs.existsSync(path.join(exeDir, PORTABLE_FLAG))) return { root: exeDir, mode: 'portable' }
  } catch {
    /* exe 路径取不到(极罕见),继续往下兜 */
  }

  try {
    const newRoot = path.join(app.getPath('appData'), 'node-ai-development-tool')
    // 改名迁移:老版本数据在 %APPDATA%\chusiz 与 %APPDATA%\ClaudeCanvas,
    // 首次运行搬到新目录,避免用户"数据丢了"(chusiz 已改名为 node-ai-development-tool)
    const oldRoots = [
      path.join(app.getPath('appData'), 'chusiz'),
      path.join(app.getPath('appData'), 'ClaudeCanvas'),
    ]
    if (!fs.existsSync(newRoot)) {
      for (const oldRoot of oldRoots) {
        if (fs.existsSync(oldRoot)) {
          try {
            fs.renameSync(oldRoot, newRoot)
            break
          } catch {
            /* 迁移失败(占用/权限)不阻塞启动 —— 数据留在原位,用户仍能读旧目录 */
          }
        }
      }
    }
    return { root: newRoot, mode: 'userdata' }
  } catch {
    // 连 AppData 都拿不到 —— 用 HOME 下的隐藏目录,至少不至于起不来
    return { root: path.join(os.homedir(), '.node-ai-development-tool'), mode: 'fallback' }
  }
}

const resolved = resolveRoot()

/**
 * 所有数据的根。这个文件必须在 app ready 之前被调用(index.ts 顶层)。
 *
 * 历史:这里曾经写死开发机的盘符路径(临时磁盘约束)。
 * 写死就意味着这个包装到别的电脑上会往一个不存在的盘符写 —— 打包分发的基本前提
 * 是数据根必须能自己算出来。见上面 resolveRoot() 的四级回退。
 */
export const PROJECT_ROOT = resolved.root
export const ROOT_MODE: RootMode = resolved.mode
export const DATA_ROOT = path.join(PROJECT_ROOT, 'data')
export const WORKSPACES_ROOT = path.join(PROJECT_ROOT, 'workspaces')

/*
 * ⚠️ 应用元数据与 agent 的 cwd 必须物理分离。
 *
 * `workspaces/` 是 agent 的工作目录,它会在里面 ls / rm / 覆盖文件。
 * 把 graph.json、会话日志放进去,agent 一个 `rm -rf .` 就把全部会话历史毁了。
 * 所以元数据一律在 `data/` 下,`workspaces/` 保持为纯净沙箱。
 */
export const CANVASES_ROOT = path.join(DATA_ROOT, 'canvases')
export const RUNS_ROOT = path.join(DATA_ROOT, 'runs')
export const SETTINGS_FILE = path.join(DATA_ROOT, 'settings.json')
export const CUSTOM_AGENTS_FILE = path.join(DATA_ROOT, 'agents', 'custom.json')

/**
 * API Key 的落盘位置(v0.4.0)。
 *
 * ⚠️ **必须与 settings.json 分开**。
 * settings.json 是用户会备份、会跟着绿色版一起拷走、甚至可能连同画布一起分享的
 * 文件。把密钥放进去,等于让"分享一个画布"顺带泄露所有服务商的 Key ——
 * 而用户绝不会预期这件事。分开之后,settings.json 可以随便传,
 * secrets.json 是明确标注敏感、内容经过系统加密的独立文件(见 shared/secrets.ts)。
 */
export const SECRETS_FILE = path.join(DATA_ROOT, 'secrets.json')

export const DEFAULT_CANVAS_ID = 'default'

/**
 * id 白名单。canvasId / nodeId 都来自渲染进程,直接拼进路径的话
 * `../../..` 能一路写到 C 盘去。这里只放行安全字符,其余一律拒绝。
 */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export function assertSafeId(kind: 'canvasId' | 'nodeId', id: string): string {
  if (!ID_RE.test(id)) throw new Error(`非法的 ${kind}: ${JSON.stringify(id)}`)
  return id
}

export function canvasRoot(canvasId: string): string {
  return path.join(CANVASES_ROOT, assertSafeId('canvasId', canvasId))
}
export function canvasGraphFile(canvasId: string): string {
  return path.join(canvasRoot(canvasId), 'graph.json')
}
/** 多开冲突检测:里面记 {pid, startedAt} */
export function canvasLockFile(canvasId: string): string {
  return path.join(canvasRoot(canvasId), 'canvas.lock')
}
export function canvasBlobsDir(canvasId: string): string {
  return path.join(canvasRoot(canvasId), 'blobs')
}
export function nodeDir(canvasId: string, nodeId: string): string {
  return path.join(canvasRoot(canvasId), 'nodes', assertSafeId('nodeId', nodeId))
}
export function nodeMetaFile(canvasId: string, nodeId: string): string {
  return path.join(nodeDir(canvasId, nodeId), 'meta.json')
}
export function runFile(runId: string): string {
  return path.join(RUNS_ROOT, `${assertSafeId('nodeId', runId)}.json`)
}

/**
 * 某个画布自己的沙箱 —— 节点没指定目录时 agent 的 cwd。
 *
 * 粒度选**画布**而不是节点:同一条流水线上的节点本来就该看见彼此
 * 在同一块地上留下的文件(下游要"查前一个节点的项目,让自己适配"),
 * 每个节点各给一个空目录,那句提示就成了假话。
 *
 * ⚠️ 这里**只放 agent 的产物**。应用元数据一律在 data/ 下 —— agent 会在
 * 自己的 cwd 里 ls / rm,把 graph.json 放进来就是等着被删。
 */
export function canvasWorkspace(canvasId: string): string {
  return path.join(WORKSPACES_ROOT, assertSafeId('canvasId', canvasId))
}

export function ensureCanvasWorkspace(canvasId: string): string {
  return ensureDir(canvasWorkspace(canvasId))
}

/* ============================================================
   技能库
   ============================================================ */

/**
 * 全局技能库 —— 一个 **plugin 目录**,靠 `claude --plugin-dir <SKILLS_ROOT>` 注入。
 *
 * ⚠️ 这里不是 `--add-dir`。
 * 本机 `claude --help` 里 `--add-dir` 的原文是 "Additional directories to allow
 * **tool access** to" —— 它管的是工具能碰哪些文件,不是上下文。而 `--plugin-dir`
 * 被明确列在"显式提供上下文"那一组(--system-prompt / --settings / --mcp-config 并列)。
 *
 * 实测过(不是照文档抄的):放一个带 `zzprobe` 技能的临时 plugin 目录,`--plugin-dir`
 * 指过去,`claude -p "列出你能用的技能"` 里出现 `haowan-skills:zzprobe`;
 * 去掉这个参数就不出现。对照组成立,所以结论是稳的。
 *
 * 代价:plugin 提供的技能名带命名空间(`haowan-skills:pdf`),不是裸 `pdf`。
 * 这是 plugin 机制固有的,UI 里要写清楚,别让用户自己去撞。
 */
export const SKILLS_ROOT = path.join(DATA_ROOT, 'skills')

/** plugin 清单所在处。plugin.json 只需 name/description/author,skills/ 是自动扫的 */
export const SKILLS_PLUGIN_META_DIR = path.join(SKILLS_ROOT, '.claude-plugin')
export const SKILLS_PLUGIN_FILE = path.join(SKILLS_PLUGIN_META_DIR, 'plugin.json')

/** 启用中的技能。每个技能一个子目录,里面必须有 SKILL.md */
export const SKILLS_ENABLED_DIR = path.join(SKILLS_ROOT, 'skills')

/**
 * 停用的技能。
 *
 * ⚠️ 故意放在 plugin 根目录**之外**。
 * 放里面的话,`skills-disabled/` 就成了 plugin 目录里一个加载器不认识的子目录 ——
 * 它现在会被忽略,但那是"它现在恰好不扫这里",不是我们说了算的。挪出来,
 * "停用"就变成一条我们完全控制的事实:文件根本不在 plugin 目录里。
 */
export const SKILLS_DISABLED_DIR = path.join(DATA_ROOT, 'skills-disabled')

/**
 * 应用自己的技能来源记录(从哪装的、什么时候)。
 *
 * ⚠️ 同样放在 plugin 目录**之外** —— plugin 目录里只应该有加载器认识的东西。
 */
export const SKILLS_META_FILE = path.join(DATA_ROOT, 'skills-meta.json')

/** 技能名的规范:小写字母数字 + 单连字符分隔,见 skills/parse.ts 的校验 */
export function skillDir(name: string, enabled: boolean): string {
  return path.join(enabled ? SKILLS_ENABLED_DIR : SKILLS_DISABLED_DIR, name)
}

export function ensureSkillsDirs(): void {
  ensureDir(SKILLS_ROOT)
  ensureDir(SKILLS_PLUGIN_META_DIR)
  ensureDir(SKILLS_ENABLED_DIR)
  ensureDir(SKILLS_DISABLED_DIR)
}

function ensureDir(p: string): string {
  try {
    fs.mkdirSync(p, { recursive: true })
  } catch {
    /* 已存在或无权限,后续写入时会暴露更明确的错误 */
  }
  return p
}

/** 按需建出某个画布的全部目录 */
export function ensureCanvasDirs(canvasId: string): void {
  assertSafeId('canvasId', canvasId)
  ensureDir(canvasRoot(canvasId))
  ensureDir(canvasBlobsDir(canvasId))
  ensureDir(path.join(canvasRoot(canvasId), 'nodes'))
}

export function ensureNodeDir(canvasId: string, nodeId: string): string {
  return ensureDir(nodeDir(canvasId, nodeId))
}

/**
 * 把 Electron 所有会写盘的目录重定向到**数据根**之下。
 *
 * 不调用的话,userData / Chromium 缓存 / 崩溃转储 / 日志会全部堆到
 * `C:\Users\<user>\AppData\Roaming\<appName>`,和我们的 data/ 分成两摊,
 * 绿色版"整个文件夹搬走"就搬不干净。
 */
export function initPaths(): void {
  ensureDir(DATA_ROOT)
  ensureDir(WORKSPACES_ROOT)
  ensureDir(CANVASES_ROOT)
  ensureDir(RUNS_ROOT)
  ensureDir(path.dirname(CUSTOM_AGENTS_FILE))

  const sub = (name: string): string => ensureDir(path.join(DATA_ROOT, name))

  // 非 Electron 宿主(e2e / fullflow 脚本):目录已建好,没有 userData 可重定向
  if (!hasElectronApp) return

  app.setPath('userData', sub('userData'))
  app.setPath('sessionData', sub('sessionData'))
  app.setPath('logs', sub('logs'))
  app.setPath('crashDumps', sub('crashDumps'))
  app.setPath('temp', sub('temp'))

  // Chromium 的磁盘缓存不在 userData 之下,需单独指定
  app.commandLine.appendSwitch('disk-cache-dir', sub('cache'))
}

/** 数据根模式的展示文案。UI 直接显示,不在这里写死中文以外的逻辑 */
export const ROOT_MODE_LABEL: Record<RootMode, string> = {
  env: '环境变量 CHUSIZ_HOME 指定',
  dev: '开发态(仓库根)',
  portable: '绿色版(数据在程序目录内)',
  userdata: '用户目录(安装版默认)',
  fallback: '用户主目录(兜底)',
}

/** 供 UI 展示,便于验证"数据确实落在预期位置" */
export function pathsInfo(): Record<string, string> {
  return {
    projectRoot: PROJECT_ROOT,
    rootMode: ROOT_MODE,
    rootModeLabel: ROOT_MODE_LABEL[ROOT_MODE],
    portable: ROOT_MODE === 'portable' ? '1' : '0',
    dataRoot: DATA_ROOT,
    workspacesRoot: WORKSPACES_ROOT,
    canvasesRoot: CANVASES_ROOT,
    runsRoot: RUNS_ROOT,
    settingsFile: SETTINGS_FILE,
    userData: app.getPath('userData'),
    logs: app.getPath('logs'),
    crashDumps: app.getPath('crashDumps'),
  }
}
