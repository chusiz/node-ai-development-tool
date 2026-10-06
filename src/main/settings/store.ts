import type { App } from 'electron'
import { SETTINGS_FILE } from '../paths'
import { readJsonSafeSync, writeJsonAtomic } from '../persist/atomic'
import {
  DEFAULT_SETTINGS,
  parseSettings,
  restartRequiredKeys,
  type Settings,
} from '../../shared/settings'

/**
 * 本次进程启动时实际生效的设置。
 *
 * 与 live 分开记的理由:`disableGpu` 这类开关一旦打进命令行就没法回退,
 * 用户改了值之后必须能回答"哪个字段改了但还没生效" —— 靠这两份 diff 算出来,
 * 而不是靠维护一张手写的「需要重启的字段」表(那种表迟早和现实脱节)。
 */
let applied: Settings = DEFAULT_SETTINGS

/** 当前值。改设置后立刻更新,运行时读取(limits / workflow)走这里 */
let live: Settings = DEFAULT_SETTINGS
/**
 * live 是否已经按真实来源填充过。
 *
 * ⚠️ 主进程启动时序里 `captureApplied(s)` 会先把文件读出来的 s 灌进来;
 * 但脚本路径(fullflow / e2e / 无 Electron 宿主)不会走启动时序,此时
 * `getSettings()` 永远返回 DEFAULT_SETTINGS —— 用户在 settings.json 里配的
 * 默认模型/地址全读不到,节点就回落内置旧模型名。加这个标志做惰性兜底:
 * 首次读取时直接读文件。应用内 captureApplied 已先执行,行为不受影响。
 */
let liveInitialized = false

/**
 * 同步读设置。**永不抛**。
 *
 * 调用点在 initPaths() 之后、任何 Electron API 之前 —— 那里没有任何
 * 兜底空间(抛出去就是应用起不来),所以坏文件/坏字段一律降级成默认值。
 */
export function readSettingsSync(file: string = SETTINGS_FILE): Settings {
  return parseSettings(readJsonSafeSync<unknown>(file, {}))
}

/**
 * 把需要 ready 之前生效的开关打进去。
 *
 * ⚠️ 必须在 `app.whenReady()` 之前调用,ready 之后再调**静默无效** ——
 * 这是 Chromium 的既成约定,不报错,所以只能在调用点用注释钉住。
 */
export function applyBootSwitches(app: App, s: Settings): void {
  if (s.memory.disableGpu) {
    app.disableHardwareAcceleration()
    // 二重保险:与上面有重叠,但不同 Electron 版本下生效路径不完全一致
    app.commandLine.appendSwitch('disable-gpu-compositing')
  }

  if (s.memory.lowEndDeviceMode) app.commandLine.appendSwitch('enable-low-end-device-mode')

  app.commandLine.appendSwitch('js-flags', `--max-old-space-size=${s.memory.maxOldSpaceMb}`)

  // disk-cache-dir 已经在 paths.ts 里指到 D 盘,这里只是给它加一个容量上限
  if (s.memory.diskCacheMb > 0) {
    app.commandLine.appendSwitch('disk-cache-size', String(s.memory.diskCacheMb * 1024 * 1024))
  }
}

/**
 * 记下「本次进程实际生效的值」。启动时序里紧接着 applyBootSwitches 调用。
 */
export function captureApplied(s: Settings): void {
  applied = s
  live = s
  liveInitialized = true
}

export function getSettings(): Settings {
  if (!liveInitialized) {
    liveInitialized = true
    live = readSettingsSync()
  }
  return live
}

export function getApplied(): Settings {
  return applied
}

/** 落盘 + 更新 live。写盘走原子写,崩在中间不会留下半截 JSON */
export async function saveSettings(next: Settings): Promise<Settings> {
  await writeJsonAtomic(SETTINGS_FILE, next)
  live = next
  return live
}

/** UI 需要的完整视图:当前值 / 生效值 / 待重启字段 */
export function settingsPayload(): {
  current: Settings
  applied: Settings
  restartRequired: string[]
  settingsFile: string
} {
  return {
    current: live,
    applied,
    restartRequired: restartRequiredKeys(live, applied),
    settingsFile: SETTINGS_FILE,
  }
}
