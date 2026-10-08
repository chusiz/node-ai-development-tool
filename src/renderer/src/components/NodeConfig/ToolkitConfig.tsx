import type { JSX } from 'react'
import { useGraphStore, useResolvedProjectDir } from '../../stores/graphStore'
import { Icon, type IconName } from '../Icons'
import { DeleteRow, TitleField } from './NodeConfigPanel'

const kindToIcon: Record<string, IconName> = {
  lint: 'lint',
  git: 'git',
  deps: 'deps',
  context: 'context',
  contract: 'contract',
  cost: 'cost',
  diff: 'diff',
  deploy: 'deploy',
}

/**
 * v0.6.6 工程化节点群(8 种)的共用配置面板:
 *   lint / git / deps / context / contract / cost / diff / deploy
 * 按 kind 渲染各自的专属字段;全部是确定性 builtin,不出现 Agent/模型字段。
 */
export function ToolkitConfig({ nodeId }: { nodeId: string }): JSX.Element | null {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId))
  const patchConfig = useGraphStore((s) => s.patchConfig)
  const { dir: projectDir } = useResolvedProjectDir()

  if (!node) return null
  const kind = node.data.kind ?? ''

  const patch = (part: Record<string, unknown>) => patchConfig(nodeId, part)

  const intro: Record<string, string> = {
    lint: '确定性静态检查,不启动 AI 会话:在项目目录跑检查命令,退出码 0 = 通过,失败信息交下游。',
    git: '本地版本操作(status / commit / log / branch),只碰项目目录里的 .git,**不 push 外部仓库**。',
    deps: '读取 package.json / requirements.txt,报告依赖清单、缺失检测与版本信息。',
    context: '项目记忆:把代码风格 / 命名规范 / 已定义接口写进项目,下游节点可用 {{prev}} 引用。',
    contract: '从上游产出的代码里提取 API 路由,生成 OpenAPI 契约文件(assets/generated/openapi.yaml)。',
    cost: '运行摘要:汇总本轮各节点状态 / 耗时 / 产出规模,估算 token 成本(粗算,以实际计费为准)。',
    diff: '现状快照:扫描项目文件树与规模,增量修改前先让 AI 看清现状。',
    deploy: '把 Web 产物复制成可上传的部署包(vercel / netlify / 静态),产物须先由「输出节点(buildTarget=web)」生成。',
  }

  return (
    <div className="node-config">
      <div className="fhint">
        <Icon name={kindToIcon[kind] ?? 'play'} size={12} />
        <b>{intro[kind] ?? '工程化节点'}</b>
      </div>

      <TitleField nodeId={nodeId} value={node.data.title} />

      {kind === 'lint' && (
        <>
          <label className="cfglabel col">
            <span>检查命令</span>
            <input
              value={node.data.lintParams?.command ?? 'npx tsc --noEmit'}
              placeholder="npx tsc --noEmit"
              onChange={(e) => patch({ lintParams: { ...(node.data.lintParams ?? {}), command: e.target.value } })}
              spellCheck={false}
            />
            <div className="fhint">
              缺省 <code>npx tsc --noEmit</code>;也可以写 <code>npx eslint .</code> 等。
            </div>
          </label>
          <label className="cfglabel narrow">
            <span>超时(秒)</span>
            <input
              type="number"
              min={5}
              max={3600}
              value={node.data.lintParams?.timeoutSec ?? 300}
              onChange={(e) => patch({ lintParams: { ...(node.data.lintParams ?? {}), timeoutSec: Number(e.target.value) } })}
            />
          </label>
        </>
      )}

      {kind === 'git' && (
        <>
          <label className="cfglabel col">
            <span>操作</span>
            <select
              value={node.data.gitParams?.op ?? 'commit'}
              onChange={(e) => patch({ gitParams: { ...(node.data.gitParams ?? {}), op: e.target.value as 'status' | 'commit' | 'log' | 'branch' } })}
            >
              <option value="commit">提交(自动 add + commit)</option>
              <option value="status">查看工作区状态</option>
              <option value="log">最近 5 条提交</option>
              <option value="branch">当前分支</option>
            </select>
          </label>
          {node.data.gitParams?.op === 'commit' && (
            <label className="cfglabel col">
              <span>提交信息</span>
              <input
                value={node.data.gitParams?.message ?? ''}
                placeholder="留空 = 自动生成"
                onChange={(e) => patch({ gitParams: { ...(node.data.gitParams ?? {}), message: e.target.value } })}
                spellCheck={false}
              />
            </label>
          )}
          <div className="fhint warn">
            <Icon name="alert" size={12} />
            只做本地提交,不会 push 到远端。
          </div>
        </>
      )}

      {kind === 'deps' && (
        <label className="cfglabel col">
          <span>识别方式</span>
          <select
            value={node.data.depsParams?.manager ?? 'auto'}
            onChange={(e) => patch({ depsParams: { manager: e.target.value as 'auto' | 'npm' | 'pip' } })}
          >
            <option value="auto">自动识别(npm / pip)</option>
            <option value="npm">只看 package.json</option>
            <option value="pip">只看 requirements.txt</option>
          </select>
        </label>
      )}

      {kind === 'context' && (
        <label className="cfglabel col">
          <span>记忆内容</span>
          <textarea
            rows={6}
            value={node.data.contextParams?.text ?? ''}
            placeholder={'例如:\n- 使用 TypeScript + React\n- 组件命名 PascalCase\n- 已定义接口:GET /api/users'}
            onChange={(e) => patch({ contextParams: { text: e.target.value } })}
            spellCheck={false}
          />
          <div className="fhint">写在这里的风格 / 规范 / 接口清单会落盘并交给下游 AI 节点。</div>
        </label>
      )}

      {kind === 'contract' && (
        <label className="cfglabel col">
          <span>补充说明(可选)</span>
          <textarea
            rows={4}
            value={node.data.contractParams?.text ?? ''}
            placeholder={'可补充路由说明;留空则只从上游代码自动提取 app.get/post 等路由'}
            onChange={(e) => patch({ contractParams: { text: e.target.value } })}
            spellCheck={false}
          />
        </label>
      )}

      {kind === 'deploy' && (
        <label className="cfglabel col">
          <span>部署平台</span>
          <select
            value={node.data.deployParams?.platform ?? 'vercel'}
            onChange={(e) => patch({ deployParams: { platform: e.target.value as 'vercel' | 'netlify' | 'static' } })}
          >
            <option value="vercel">Vercel(vercel.json)</option>
            <option value="netlify">Netlify(netlify.toml)</option>
            <option value="static">纯静态(任意托管)</option>
          </select>
        </label>
      )}

      {kind !== 'lint' && kind !== 'git' && kind !== 'deps' && kind !== 'context' && kind !== 'contract' && kind !== 'deploy' && (
        <div className="fhint">
          <Icon name="info" size={12} />
          本节点无需配置参数,运行即可。
        </div>
      )}

      <div className="cfglabel col">
        <span>工作目录</span>
        <div className="cwd-picker">
          <div className={`cwd-value ${projectDir ? '' : 'unset'}`} title={projectDir || '上游项目节点还没选文件夹'}>
            {projectDir || '继承项目文件夹(未设置)'}
          </div>
        </div>
      </div>

      <DeleteRow nodeId={nodeId} />
    </div>
  )
}
