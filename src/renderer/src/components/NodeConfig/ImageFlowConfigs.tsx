import { type JSX } from 'react'
import { useGraphStore } from '../../stores/graphStore'
import { DeleteRow, TitleField } from './NodeConfigPanel'

/**
 * 生图工作区(v0.5.0)配置面板:
 *   - PromptConfig:正向提示词文本
 *   - NegativeConfig:负向提示词文本
 *   - SamplerConfig:出图方式(本地命令 / HTTP)+ 参数
 *   - ImageOutputConfig:图片输出(终点,说明面板)
 */

export function PromptConfig({ nodeId }: { nodeId: string }): JSX.Element | null {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId))
  const patchConfig = useGraphStore((s) => s.patchConfig)
  if (!node) return null
  return (
    <div className="node-config">
      <div className="fhint warn">
        <b>正向提示词 · 生图工作区。</b>
        写画面"要什么",连到「采样出图」节点作为画面描述。支持多行。
      </div>
      <TitleField nodeId={nodeId} value={node.data.title} />
      <label className="cfglabel col">
        <span>正向提示词(画面要什么)</span>
        <textarea
          className="tpl"
          rows={5}
          value={node.data.promptText ?? ''}
          placeholder={'例:像素风格地牢场景,石墙,火把,祭坛,暖色调\n例:a cute orange cat sitting on a wooden table, soft lighting'}
          onChange={(e) => patchConfig(nodeId, { promptText: e.target.value })}
          spellCheck={false}
        />
      </label>
      <div className="fhint">
        这是纯数据节点,不执行任何动作 —— 运行它只是把这段文本交给下游的采样出图节点。
      </div>
      <DeleteRow nodeId={nodeId} />
    </div>
  )
}

export function NegativeConfig({ nodeId }: { nodeId: string }): JSX.Element | null {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId))
  const patchConfig = useGraphStore((s) => s.patchConfig)
  if (!node) return null
  return (
    <div className="node-config">
      <div className="fhint warn">
        <b>负向提示词 · 生图工作区。</b>
        写画面"不要什么"(模糊 / 畸形 / 水印等),连到「采样出图」节点作为负面约束。
      </div>
      <TitleField nodeId={nodeId} value={node.data.title} />
      <label className="cfglabel col">
        <span>负向提示词(画面不要什么)</span>
        <textarea
          className="tpl"
          rows={5}
          value={node.data.negativeText ?? ''}
          placeholder={'例:blurry, low quality, deformed, watermark, text'}
          onChange={(e) => patchConfig(nodeId, { negativeText: e.target.value })}
          spellCheck={false}
        />
      </label>
      <div className="fhint">
        留空 = 不限制(但建议保留基础负面词,出图质量更稳)。
      </div>
      <DeleteRow nodeId={nodeId} />
    </div>
  )
}

export function SamplerConfig({ nodeId }: { nodeId: string }): JSX.Element | null {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId))
  const patchConfig = useGraphStore((s) => s.patchConfig)
  if (!node) return null

  const provider = node.data.imageProvider
  const isHttp = provider?.kind === 'http'
  const params = node.data.imageParams ?? {}

  const setProvider = (kind: 'local-command' | 'http'): void => {
    const base: NonNullable<typeof provider> =
      kind === 'http'
        ? { kind: 'http', endpoint: '', method: 'POST', headers: {}, bodyTemplate: '', responsePath: '', responseType: 'base64', format: 'png', timeoutSec: 120 }
        : { kind: 'local-command', command: '', cwd: '', timeoutSec: 600 }
    patchConfig(nodeId, { imageProvider: base })
  }
  const setProviderField = (patch: Record<string, unknown>): void => {
    const cur: NonNullable<typeof provider> = provider ?? (isHttp
      ? { kind: 'http', endpoint: '', method: 'POST', headers: {}, bodyTemplate: '', responsePath: '', responseType: 'base64', format: 'png', timeoutSec: 120 }
      : { kind: 'local-command', command: '', cwd: '', timeoutSec: 600 })
    patchConfig(nodeId, { imageProvider: { ...cur, ...patch } })
  }

  return (
    <div className="node-config">
      <div className="fhint warn">
        <b>采样出图 · 生图工作区。</b>
        合并上游「正向/负向提示词」出图,与图像节点同一引擎(本地命令 / HTTP 接口),不启动 AI 会话。
      </div>
      <TitleField nodeId={nodeId} value={node.data.title} />

      <span className="cfglabel">出图方式</span>
      <div className="seg">
        <button className={!isHttp ? 'on' : ''} onClick={() => setProvider('local-command')}>
          本地命令
        </button>
        <button className={isHttp ? 'on' : ''} onClick={() => setProvider('http')}>
          HTTP 接口
        </button>
      </div>

      {!isHttp ? (
        <>
          <label className="cfglabel col">
            <span>命令模板({'{promptFile}'} = 正向提示词,{'{negativePrompt}'} = 负向提示词)</span>
            <textarea
              className="tpl"
              rows={3}
              value={provider?.kind === 'local-command' ? (provider.command ?? '') : ''}
              placeholder={'python scripts/txt2img.py --prompt-file ' + '{' + '{promptFile}' + '}' + ' --out ' + '{' + '{outDir}' + '}' + ' --n ' + '{' + '{n}' + '}' + ' --size ' + '{' + '{size}' + '}' + ' --seed ' + '{' + '{seed}' + '}' + ' --negative ' + '{' + '{negativePrompt}' + '}'}
              onChange={(e) => setProviderField({ command: e.target.value })}
              spellCheck={false}
            />
          </label>
        </>
      ) : (
        <label className="cfglabel col">
          <span>HTTP 接口地址</span>
          <input
            type="text"
            value={provider?.kind === 'http' ? (provider.endpoint ?? '') : ''}
            placeholder={'http://127.0.0.1:7860/sdapi/v1/txt2img'}
            onChange={(e) => setProviderField({ endpoint: e.target.value })}
          />
        </label>
      )}

      <div className="cfgrow">
        <label className="cfglabel">
          <span>张数</span>
          <input
            type="number"
            min={1}
            max={8}
            value={params.n ?? 1}
            onChange={(e) => patchConfig(nodeId, { imageParams: { ...params, n: Number(e.target.value) } })}
          />
        </label>
        <label className="cfglabel">
          <span>尺寸</span>
          <input
            type="text"
            value={params.size ?? '512x512'}
            onChange={(e) => patchConfig(nodeId, { imageParams: { ...params, size: e.target.value } })}
          />
        </label>
        <label className="cfglabel">
          <span>种子(留空 = 随机)</span>
          <input
            type="number"
            value={params.seed ?? ''}
            placeholder="随机"
            onChange={(e) => patchConfig(nodeId, { imageParams: { ...params, seed: e.target.value ? Number(e.target.value) : undefined } })}
          />
        </label>
      </div>

      <div className="fhint">
        出图落在项目的 <code>assets/generated/</code> 下。接「图片输出」或「交接」节点即可拿到素材清单。
      </div>
      <DeleteRow nodeId={nodeId} />
    </div>
  )
}

export function ImageOutputConfig({ nodeId }: { nodeId: string }): JSX.Element | null {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId))
  if (!node) return null
  return (
    <div className="node-config">
      <div className="fhint warn">
        <b>图片输出 · 生图工作区终点。</b>
        扫描项目 <code>assets/generated/</code> 下的图片,输出素材清单(不生成新图)。
      </div>
      <TitleField nodeId={nodeId} value={node.data.title} />
      <div className="fhint">
        在生图工作区完成后,切到「软件制作」工作区,放一个「交接」节点 ——
        它会读取同一份素材目录,把图片清单交给软件节点,AI 制作时按相对路径直接引用。
        生图与软件制作通过项目文件夹天然衔接,无需复制图片。
      </div>
      <DeleteRow nodeId={nodeId} />
    </div>
  )
}
