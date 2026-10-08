/**
 * 设置的默认值。
 *
 * ## 为什么单独一个文件
 *
 * 这里是**纯字面量**,不 import 任何东西。schema 定义在 `settings.ts`,而那个文件
 * 顶部 `import { z } from 'zod'` —— 渲染进程只要**按值**引用了 settings.ts 里的任何东西
 * (哪怕只是想拿一个默认值),zod 就会被打进渲染进程的 bundle(实测 6 处 ZodError)。
 *
 * 渲染进程只需要类型(走 `import type`,编译期完全擦除)和这几个默认值。
 * 把默认值分出来之后,渲染进程的 zod 引用回到 0,而 schema 的兜底值与默认值
 * 仍然同源 —— 从这一个文件里读,不会漂。
 */
export const SETTING_DEFAULTS = {
  memory: {
    disableGpu: true,
    lowEndDeviceMode: false,
    maxOldSpaceMb: 1024,
    diskCacheMb: 256,
  },
  limits: {
    maxItemsPerNode: 400,
    maxToolResultChars: 8192,
    maxThinkingChars: 8192,
    maxResultChars: 16384,
    stderrTailLines: 20,
    diagRingSize: 200,
  },
  workflow: {
    maxParallel: 2,
    inlineLimitBytes: 32768,
  },
  agent: {
    /**
     * 自定义 claude 可执行文件路径。**空字符串 = 自动探测**。
     *
     * 空串而不是 null:这一路最终是"有没有传参"(见 adapter.detect 的
     * configuredPath?: string),空串在调用点统一折成 undefined,
     * 比让 null 一路穿到 locator 里少一层判断。
     *
     * ⚠️ v0.4.0 起新 CLI 一律写进 `cliPaths`,这里是**旧配置的兼容位**。
     * 读取顺序见 main/agents/cliPath.ts —— 两个都查,cliPaths 优先。
     * 不直接删掉它:用户升级后用旧 settings.json 启动时,那条路径还得认。
     */
    claudePath: '',
    /** 各 CLI agent 的自定义可执行文件路径,按 agentId 索引。空串/缺项 = 自动探测 */
    cliPaths: {},
    /**
     * 各模型服务商的覆盖配置(地址、默认模型),按 providerId 索引。
     *
     * ⚠️ **这里不放 API Key**。Key 走单独的加密存储(data/secrets.json,
     * 见 shared/secrets.ts 顶部的说明)。settings.json 是会被同步、备份、
     * 连同画布一起分享出去的文件,密钥绝不能躺在里面。
     */
    providers: {},
  },
  /**
   * UI 相关设置(v0.6.6 起):界面语言 + 用户自定义快捷键。
   *
   * keymap 的 key = 快捷键动作 id(见 renderer/src/lib/keymap.ts 的 DEFAULT_KEYMAP),
   * value = 用户改过的组合串(如 `Ctrl+Shift+Enter`)。缺项 = 用默认键位。
   * 放这里而不是 localStorage:与其它设置一起备份、一起换电脑迁移。
   */
  ui: {
    /** 界面语言:'en' = English(默认,方便海外查看) / 'zh' = 简体中文 */
    language: 'en' as 'en' | 'zh',
    /** 用户自定义快捷键。空对象 = 全部用默认键位 */
    keymap: {},
  },
} as const
