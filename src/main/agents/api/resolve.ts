import type { StartRequest } from '../../../shared/ipc'
import type { ProviderDef } from '../../../shared/providers'
import { effectiveBaseUrl, effectiveModel } from '../../../shared/providers'
import { getSettings } from '../../settings/store'
import { keyFor } from '../../secrets/store'
import { DEFAULT_API_TIMEOUT_MS, DEFAULT_MAX_TURNS } from './session'
import type { ApiCtx } from './types'

/**
 * 从一次启动请求拼出 API 会话需要的全部上下文。
 *
 * 单独一个文件的理由:这里要同时问**三个**不同的来源 ——
 * 请求(节点上的选择)、设置(用户覆盖的地址与默认模型)、密钥库(明文 Key),
 * 而且中间有校验。散在 manager 里会让那段调度代码变得没法读。
 *
 * 返回判别联合而不是抛异常:缺 Key / 缺地址都是**用户配置问题**,
 * 需要的是"告诉他去设置页点哪个按钮",而不是一个栈。
 */
export function buildApiCtx(
  req: StartRequest,
  provider: ProviderDef,
  cwd: string,
): { ok: true; ctx: ApiCtx } | { ok: false; message: string } {
  const cfg = getSettings().agent.providers[provider.id] ?? { baseUrl: '', defaultModel: '' }

  const baseUrl = effectiveBaseUrl(provider, cfg.baseUrl)
  if (!baseUrl) {
    return {
      ok: false,
      message:
        `「${provider.label}」还没有填接口地址。\n` +
        `到 设置 → 模型服务 → ${provider.label},把 Base URL 填上(通常以 /v1 结尾)。`,
    }
  }

  const apiKey = keyFor(provider.id)
  if (!apiKey && !provider.optionalKey) {
    return {
      ok: false,
      message:
        `「${provider.label}」还没有配置 API Key。\n` +
        `到 设置 → 模型服务 → ${provider.label} 填入 Key` +
        (provider.keyUrl ? `(申请地址:${provider.keyUrl})` : '') +
        `,点「测试连接」确认可用后再运行节点。`,
    }
  }

  // 模型:节点上的选择 > 设置里的默认 > 注册表首选
  const model = effectiveModel(req.agentId, req.model, cfg.defaultModel)
  if (!model) {
    return {
      ok: false,
      message:
        `「${provider.label}」还没有选模型。\n` +
        `在节点配置面板里选一个,或到 设置 → 模型服务 点「拉取模型」看有哪些可用。`,
    }
  }

  return {
    ok: true,
    ctx: {
      nodeId: req.nodeId,
      canvasId: req.canvasId,
      provider,
      baseUrl,
      apiKey,
      model,
      cwd,
      /*
       * 权限模式复用 CLI 那套词汇,不另起一套。
       *
       * 理由是用户在**节点上**只看到一个「权限模式」下拉框 —— 它不该因为
       * 底下跑的是 CLI 还是 API 而变化。映射关系在 tools.ts 里:
       * plan = 只读,其余 = 可读写可执行命令(bypassPermissions 在此之上
       * 不再额外放宽,因为 API 这条路上没有"权限询问"这回事,
       * 它就是最宽的那一档)。
       */
      permissionMode: req.permissionMode ?? 'acceptEdits',
      maxTurns: DEFAULT_MAX_TURNS,
      timeoutMs: req.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    },
  }
}
