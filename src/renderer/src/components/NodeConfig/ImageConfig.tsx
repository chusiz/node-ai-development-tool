import { useEffect, useState, type JSX } from 'react'
import { useGraphStore } from '../../stores/graphStore'
import { DeleteRow, TitleField, insertVar, useUpstreams } from './NodeConfigPanel'
import { Icon } from '../Icons'
import type { ImageParams, ImageProviderConfig } from '../../../../shared/canvas'

/**
 * 图像节点(image)的配置面板 —— **内置动作节点**,与 OutputConfig 同一原则。
 *
 * ⚠️ 本面板**绝不出现** Agent / 权限模式 / Prompt 模板(LLM 版)/ 上游失败策略 /
 * 重试 等 agent 专属字段(PRD §5.2 的硬性要求)。图像节点不走会话,显示了反而
 * 让人以为"改了重试会自动重试出图"。
 *
 * 字段分组:① 基本 ② 画面描述 ③ 生成参数 ④ 出图方式(本地命令 / HTTP)⑤ 产物。
 */

/** 默认的本地命令 provider(切换 provider / 缺字段时用) */
function defaultProvider(kind: ImageProviderConfig['kind']): ImageProviderConfig {
  return kind === 'http'
    ? {
        kind: 'http',
        endpoint: '',
        method: 'POST',
        headers: {},
        bodyTemplate: '',
        responsePath: '',
        responseType: 'base64',
        format: 'png',
        timeoutSec: 120,
      }
    : { kind: 'local-command', command: '', cwd: '', timeoutSec: 600 }
}

/** 请求头对象 ⇄ 多行文本("Key: Value" 每行一条)。用户按行编辑比键值对表格顺手 */
function headersToText(h: Record<string, string> | undefined): string {
  return Object.entries(h ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}
function textToHeaders(t: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of t.split('\n')) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const k = line.slice(0, i).trim()
    const v = line.slice(i + 1).trim()
    if (k) out[k] = v
  }
  return out
}

/**
 * 本地生图预设(v0.4.2):一键填充 provider 配置,三条路:
 *   - 「本地模型直出」:chusiz 直接用 diffusers 加载本地 checkpoint 出图,
 *     **完全不走 SD WebUI 服务**(local-command 方式)
 *   - 「SD WebUI 服务」:模型常驻内存、出图快,配合面板「本地服务」一键后台启动
 *   - 「OpenAI 兼容本地服务」:vLLM / llama.cpp 等 /v1/images/generations
 *   - ComfyUI:原生 /prompt 是 workflow JSON(节点图),静态模板表达不了,
 *     用「本地命令」配合它的 CLI/python 客户端封装(见命令区提示)。
 */
interface PresetCtx {
  /** 探测到的 SD WebUI 安装目录(找不到为 null) */
  sdDir: string | null
  /** 直出脚本 txt2img.py 的绝对路径(项目 scripts 下) */
  scriptPath: string
  /** 可用的本地 python 推理环境(提取的运行时优先;整合包删掉后仍可用) */
  pythonPath: string | null
}
interface LocalPreset {
  id: string
  label: string
  hint?: string
  /** 预设切换到的 provider kind(默认 http) */
  kind?: ImageProviderConfig['kind']
  apply: (ctx: PresetCtx) => Partial<ImageProviderConfig>
}
const LOCAL_PRESETS: LocalPreset[] = [
  {
    id: '',
    label: '自定义(手动填写)',
    apply: () => ({}),
  },
  {
    id: 'sd-direct',
    label: '本地模型直出(不启动 SD 服务)',
    kind: 'local-command',
    hint: 'chusiz 直接用整合包 python + diffusers 加载本地 checkpoint 出图,完全不走 SD WebUI 服务。',
    apply: ({ pythonPath, scriptPath }) =>
      pythonPath && scriptPath
        ? {
            kind: 'local-command',
            command: `"${pythonPath}" "${scriptPath}" --prompt-file "{{promptFile}}" --out "{{outDir}}" --n {{n}} --size {{size}} --seed {{seed}} --negative "{{negativePrompt}}"`,
            timeoutSec: 600,
          }
        : { kind: 'local-command', command: '', timeoutSec: 600 },
  },
  {
    id: 'a1111',
    label: 'SD WebUI 服务(模型常驻,出图快)',
    hint: '模型常驻内存、出图快;配合面板「本地服务」一键后台启动,无需开 SD 窗口。',
    apply: () => ({
      kind: 'http',
      endpoint: 'http://127.0.0.1:7860/sdapi/v1/txt2img',
      method: 'POST',
      headers: {},
      bodyTemplate:
        '{"prompt":{{promptJson}},"negative_prompt":{{negativePromptJson}},"steps":24,"width":{{width}},"height":{{height}},"seed":{{seed}},"batch_size":{{n}}}',
      responsePath: 'images',
      responseType: 'base64',
      format: 'png',
      timeoutSec: 600,
    }),
  },
  {
    id: 'openai',
    label: 'OpenAI 兼容本地服务(/v1/images/generations)',
    hint: 'vLLM / llama.cpp / 各类 OpenAI 兼容图像服务。默认端口 8000,可按实际改。',
    apply: () => ({
      kind: 'http',
      endpoint: 'http://127.0.0.1:8000/v1/images/generations',
      method: 'POST',
      headers: {},
      bodyTemplate: '{"prompt":{{promptJson}},"n":{{n}},"size":"{{size}}"}',
      responsePath: 'data[0].b64_json',
      responseType: 'base64',
      format: 'png',
      timeoutSec: 300,
    }),
  },
]

/** 预设 id 判定:配置与某个预设"完全一致"才算命中(端点/命令模板都要对上),
 *  任何手动改动都会退回「自定义」,避免预设下拉与已填内容打架。 */
function presetIdFor(p: ImageProviderConfig, ctx: PresetCtx): string {
  for (const preset of LOCAL_PRESETS) {
    const want = preset.apply(ctx)
    const wantKind = preset.kind ?? 'http'
    if (p.kind !== wantKind) continue
    if (wantKind === 'local-command') {
      const wc = (want as Partial<Extract<ImageProviderConfig, { kind: 'local-command' }>>).command ?? ''
      const pc = (p as Extract<ImageProviderConfig, { kind: 'local-command' }>).command
      if (wc !== '' && wc === pc) return preset.id
    } else {
      const hp = p as Extract<ImageProviderConfig, { kind: 'http' }>
      const hw = want as Partial<Extract<ImageProviderConfig, { kind: 'http' }>>
      if (
        (hw.endpoint ?? '') === (hp.endpoint ?? '') &&
        (hw.bodyTemplate ?? '') === (hp.bodyTemplate ?? '') &&
        (hw.responsePath ?? '') === (hp.responsePath ?? '')
      ) {
        return preset.id
      }
    }
  }
  return ''
}

export function ImageConfig({ nodeId }: { nodeId: string }): JSX.Element | null {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId))
  const patchConfig = useGraphStore((s) => s.patchConfig)
  const upstreams = useUpstreams(nodeId)

  if (!node) return null
  const params: ImageParams = node.data.imageParams ?? {}
  const provider: ImageProviderConfig = node.data.imageProvider ?? defaultProvider('local-command')

  const patchParams = (p: Partial<ImageParams>): void => {
    patchConfig(nodeId, { imageParams: { ...params, ...p } })
  }

  const switchProvider = (kind: ImageProviderConfig['kind']): void => {
    if (kind === provider.kind) return
    // 换 provider = 换一套字段,直接换成该 provider 的默认对象
    patchConfig(nodeId, { imageProvider: defaultProvider(kind) })
  }

  const patchLocal = (p: Partial<Extract<ImageProviderConfig, { kind: 'local-command' }>>): void => {
    if (provider.kind !== 'local-command') return
    patchConfig(nodeId, { imageProvider: { ...provider, ...p } })
  }
  const patchHttp = (p: Partial<Extract<ImageProviderConfig, { kind: 'http' }>>): void => {
    if (provider.kind !== 'http') return
    patchConfig(nodeId, { imageProvider: { ...provider, ...p } })
  }

  // ---- 本地模型探测:SD 目录 + 直出脚本路径(预设「本地模型直出」用) ----
  const [presetCtx, setPresetCtx] = useState<PresetCtx>({ sdDir: null, scriptPath: '', pythonPath: null })
  useEffect(() => {
    let alive = true
    void (async () => {
      const [paths, st] = await Promise.all([window.api.app.paths(), window.api.localSd.status()])
      if (!alive) return
      const root = paths.ok ? ((paths.data as Record<string, string>)?.projectRoot ?? '') : ''
      setPresetCtx({
        sdDir: st.ok ? st.data.dir : null,
        scriptPath: root ? root.replace(/[\\/]+$/, '') + '\\scripts\\txt2img.py' : '',
        pythonPath: st.ok ? st.data.pythonPath : null,
      })
    })()
    return () => {
      alive = false
    }
  }, [])

  /** 选预设:一次调用把完整 provider 写好(切 kind + 填字段,避免两次 patch 互相覆盖) */
  const onPreset = (id: string): void => {
    const preset = LOCAL_PRESETS.find((x) => x.id === id)
    if (!preset) return
    const kind = preset.kind ?? 'http'
    const want = preset.apply(presetCtx)
    patchConfig(nodeId, { imageProvider: { ...defaultProvider(kind), ...want } as ImageProviderConfig })
  }

  // ---- 本地服务(SD WebUI)一键启停 ----
  const [sdState, setSdState] = useState<{ running: boolean; starting: boolean; message: string }>({
    running: false,
    starting: false,
    message: '',
  })
  const refreshSd = async (): Promise<void> => {
    const st = await window.api.localSd.status()
    if (st.ok) {
      setSdState((s) => ({
        ...s,
        running: st.data.running,
        message: st.data.running
          ? `运行中 · 模型:${st.data.models.join('、')}`
          : st.data.dir
            ? '未运行(可一键启动,后台静默运行,无需开 SD 窗口)'
            : '未找到 SD WebUI 安装目录',
      }))
    }
  }
  useEffect(() => {
    void refreshSd()
  }, [])
  const startSd = async (): Promise<void> => {
    setSdState((s) => ({ ...s, starting: true, message: '正在后台启动(首次加载模型约 1-2 分钟)…' }))
    const st = await window.api.localSd.start()
    if (st.ok) {
      setSdState((s) => ({
        ...s,
        starting: false,
        running: st.data.running,
        message: st.data.running ? `已就绪 · ${st.data.models.join('、')}` : (st.data as { error?: string }).error ?? '',
      }))
    } else {
      setSdState((s) => ({ ...s, starting: false, message: st.error ?? '启动失败' }))
    }
  }
  const stopSd = async (): Promise<void> => {
    const st = await window.api.localSd.stop()
    if (st.ok) setSdState((s) => ({ ...s, running: false, message: '已停止' }))
    else setSdState((s) => ({ ...s, message: st.error ?? '停止失败' }))
  }

  return (
    <div className="node-config">
      <div className="fhint warn">
        <b>内置出图能力 · 不启动 AI 会话 · 不消耗 token。</b>
        出图由主进程直接执行(本地命令或 HTTP),失败不自动重试。密钥请用 <code>{'{{env:变量名}}'}</code>。
      </div>

      {/* ① 基本 */}
      <TitleField nodeId={nodeId} value={node.data.title} />

      {/* ② 画面描述 */}
      <label className="cfglabel col">
        <span>画面描述</span>
        <textarea
          className="tpl"
          rows={3}
          value={node.data.promptTemplate ?? ''}
          placeholder={'例:像素风主角待机动作,4 帧,透明背景\n可用 {{prev}} {{input}} {{node:<id>}};密钥用 {{env:变量名}}'}
          onChange={(e) => patchConfig(nodeId, { promptTemplate: e.target.value })}
          spellCheck={false}
        />
      </label>

      {/* ②-b 负提示词(ComfyUI 式,v0.4.1):告诉模型不要画什么 */}
      <label className="cfglabel col">
        <span>负提示词(可选)</span>
        <textarea
          className="tpl"
          rows={2}
          value={params.negativePrompt ?? ''}
          placeholder={'例:模糊,变形,多余的手指,低质量\nHTTP 请求体里用 {{negativePrompt}} 取'}
          onChange={(e) => patchParams({ negativePrompt: e.target.value })}
          spellCheck={false}
        />
      </label>
      <div className="fhint">
        <code>{'{{negativePrompt}}'}</code> 会像 <code>{'{{prompt}}'}</code> 一样做 JSON 转义;
        不支持负提示词的本地命令可忽略此字段。
      </div>
      <div className="tpl-vars">
        <span className="hint">点一下插到光标处:</span>
        <button className="mini" onClick={() => insertVar(nodeId, '{{input}}')} title="所有上游产出 + 这次运行的输入">
          input
        </button>
        <button className="mini" onClick={() => insertVar(nodeId, '{{prev}}')} title="直接上游的产出">
          prev
        </button>
        {upstreams.map((u) => (
          <button
            key={u.id}
            className="mini"
            onClick={() => insertVar(nodeId, `{{node:${u.id}}}`)}
            title={`只取「${u.title}」的产出`}
          >
            {u.title}
          </button>
        ))}
      </div>
      <div className="fhint">
        支持 <code>{'{{prev}}'}</code> <code>{'{{input}}'}</code> <code>{'{{node:<id>}}'}</code>;
        HTTP 请求体里 <code>{'{{prompt}}'}</code> 会自动做 JSON 转义,安全嵌入。
      </div>

      {/* ③ 生成参数 */}
      <div className="cfgrow">
        <label className="cfglabel narrow">
          <span>张数</span>
          <input
            type="number"
            min={1}
            max={8}
            value={params.n ?? 1}
            onChange={(e) => patchParams({ n: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })}
          />
        </label>
        <label className="cfglabel">
          <span>尺寸</span>
          <input
            value={params.size ?? '1024x1024'}
            placeholder="1024x1024"
            onChange={(e) => patchParams({ size: e.target.value })}
          />
        </label>
        <label className="cfglabel narrow">
          <span>种子</span>
          <input
            type="number"
            value={params.seed ?? ''}
            placeholder="留空=随机"
            onChange={(e) => patchParams({ seed: e.target.value === '' ? undefined : Number(e.target.value) })}
          />
        </label>
      </div>

      {/* ④ 出图方式 */}
      <div className="cfglabel col">
        <span>出图方式</span>
        <div className="image-config-provider">
          <label>
            <input
              type="radio"
              name={`provider-${nodeId}`}
              checked={provider.kind === 'local-command'}
              onChange={() => switchProvider('local-command')}
            />{' '}
            本地命令(默认,不需要 API key)
          </label>
          <label>
            <input
              type="radio"
              name={`provider-${nodeId}`}
              checked={provider.kind === 'http'}
              onChange={() => switchProvider('http')}
            />{' '}
            HTTP 接口
          </label>
        </div>
      </div>

      {/* ④-b 本地生图预设(两种出图方式共用):一键填好配置 */}
      <div className="cfglabel col">
        <span>本地生图预设</span>
        <select value={presetIdFor(provider, presetCtx)} onChange={(e) => onPreset(e.target.value)}>
          {LOCAL_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <div className="fhint" style={{ marginTop: 4 }}>
          {LOCAL_PRESETS.find((p) => p.id === presetIdFor(provider, presetCtx))?.hint ??
            '选预设自动填好命令/请求体/响应路径;服务没启动时运行会报"连接失败",可先用下面「本地服务」一键启动。'}
        </div>
      </div>

      {/* ④-c 本地服务(SD WebUI)一键启停:后台静默运行,不用开 SD 窗口 */}
      <div className="cfgrow" style={{ alignItems: 'center' }}>
        <span className="hint" style={{ flex: 1 }}>
          本地 SD 服务:
          {sdState.running ? (
            <b style={{ color: 'var(--ok, #2e7d32)' }}> ● 运行中</b>
          ) : (
            <b> ○ 未运行</b>
          )}
        </span>
        <button className="mini" disabled={sdState.starting} onClick={() => void startSd()}>
          {sdState.starting ? '启动中…' : '一键启动'}
        </button>
        <button className="mini" disabled={!sdState.running || sdState.starting} onClick={() => void stopSd()}>
          停止
        </button>
      </div>
      <div className="fhint">{sdState.message || '后台启动 SD WebUI(模型常驻),图像节点可直接出图;也可选上方「本地模型直出」完全不用服务。'}</div>

      {provider.kind === 'local-command' ? (
        <>
          <label className="cfglabel col">
            <span>命令</span>
            <input
              value={provider.command ?? ''}
              placeholder={'python D:/tools/gen.py --prompt-file "{{promptFile}}" --out "{{outDir}}" --count {{n}} --size {{size}}'}
              onChange={(e) => patchLocal({ command: e.target.value })}
              spellCheck={false}
            />
          </label>
          <div className="fhint warn">
            <Icon name="alert" size={12} />
            命令里<b>不要写</b> <code>{'{{prompt}}'}</code>(有命令注入风险);画面描述请用{' '}
            <code>{'{{promptFile}}'}</code> 或环境变量 <code>CANVAS_PROMPT</code>。
          </div>
          <div className="fhint">
            <b>ComfyUI 用户:</b>ComfyUI 原生接口要传 workflow JSON,这里适合配合它的 CLI /
            python 客户端出图,例如{' '}
            <code>{'python C:/ComfyUI/comfy_api.py --workflow wf.json --prompt-file "{{promptFile}}" --out "{{outDir}}"'}</code>
            —— 把"出图"封装成一条命令,chusiz 只负责扫描结果图片。
          </div>
          <div className="cfgrow">
            <label className="cfglabel col">
              <span>工作目录</span>
              <input
                value={provider.cwd ?? ''}
                placeholder="默认:项目文件夹"
                onChange={(e) => patchLocal({ cwd: e.target.value })}
              />
            </label>
            <label className="cfglabel narrow">
              <span>超时(秒)</span>
              <input
                type="number"
                min={1}
                value={provider.timeoutSec ?? 600}
                onChange={(e) => patchLocal({ timeoutSec: Number(e.target.value) || 600 })}
              />
            </label>
          </div>
        </>
      ) : (
        <>
          <label className="cfglabel col">
            <span>Endpoint</span>
            <input
              value={provider.endpoint ?? ''}
              placeholder="https://.../v1/images/generations"
              onChange={(e) => patchHttp({ endpoint: e.target.value })}
              spellCheck={false}
            />
          </label>
          <div className="cfgrow">
            <label className="cfglabel narrow">
              <span>方法</span>
              <select
                value={provider.method ?? 'POST'}
                onChange={(e) => patchHttp({ method: e.target.value as 'GET' | 'POST' })}
              >
                <option value="POST">POST</option>
                <option value="GET">GET</option>
              </select>
            </label>
            <label className="cfglabel narrow">
              <span>超时(秒)</span>
              <input
                type="number"
                min={1}
                value={provider.timeoutSec ?? 120}
                onChange={(e) => patchHttp({ timeoutSec: Number(e.target.value) || 120 })}
              />
            </label>
          </div>
          <label className="cfglabel col">
            <span>请求头</span>
            <textarea
              rows={2}
              value={headersToText(provider.headers)}
              placeholder={'Authorization: Bearer {{env:OPENAI_API_KEY}}'}
              onChange={(e) => patchHttp({ headers: textToHeaders(e.target.value) })}
              spellCheck={false}
            />
          </label>
          <label className="cfglabel col">
            <span>请求体模板</span>
            <textarea
              className="tpl"
              rows={3}
              value={provider.bodyTemplate ?? ''}
              placeholder={'{"prompt":"{{prompt}}","n":{{n}},"size":"{{size}}"}'}
              onChange={(e) => patchHttp({ bodyTemplate: e.target.value })}
              spellCheck={false}
            />
          </label>
          <div className="fhint">
            <code>{'{{prompt}}'}</code> 放在 JSON 字符串里(会自动转义);整值用 <code>{'{{promptJson}}'}</code>。
          </div>
          <div className="cfgrow">
            <label className="cfglabel col">
              <span>响应图片位置</span>
              <input
                value={provider.responsePath ?? ''}
                placeholder="data[0].b64_json"
                onChange={(e) => patchHttp({ responsePath: e.target.value })}
                spellCheck={false}
              />
            </label>
            <label className="cfglabel narrow">
              <span>响应类型</span>
              <select
                value={provider.responseType ?? 'base64'}
                onChange={(e) => patchHttp({ responseType: e.target.value as 'base64' | 'url' })}
              >
                <option value="base64">base64</option>
                <option value="url">url</option>
              </select>
            </label>
            <label className="cfglabel narrow">
              <span>格式</span>
              <input
                value={provider.format ?? 'png'}
                onChange={(e) => patchHttp({ format: e.target.value })}
              />
            </label>
          </div>
        </>
      )}

      {/* ⑤ 产物 */}
      <div className="cfglabel col">
        <span>输出目录</span>
        <div className="cwd-value unset" title="图片落在项目文件夹下的 assets/generated/ 里,按节点名分子目录">
          assets/generated/(节点名)/
        </div>
      </div>

      <DeleteRow nodeId={nodeId} />
    </div>
  )
}
