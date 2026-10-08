import { useState, type JSX } from 'react'
import { Icon } from '../components/Icons'

/**
 * 新手引导(v0.6.4,改进建议第二条"降低第一次上手的挫败感"):
 * 画布右上角的「?」按钮打开 5 步交互式引导 —— 从拖入第一个节点到看到第一个产物,
 * 每步都有说明。仅提示,不强制:点关闭或点完即消失。
 */

interface GuideStep {
  title: string
  body: string
  do: string
}

const STEPS: GuideStep[] = [
  {
    title: '1. 放一个项目节点',
    body: '项目节点是整个工作流的「项目文件夹」权威来源。它决定所有产物写到哪里。',
    do: '左侧节点面板 → 拖「项目」到画布 → 在右侧面板选一个文件夹。',
  },
  {
    title: '2. 接一个功能节点',
    body: '功能节点是 AI 干活的节点:写代码、改代码都在这。串行模式会把上游成果一起交给 AI。',
    do: '把「功能」节点连到项目节点下游,填一句要做什么。',
  },
  {
    title: '3. 加质量闸门(可选但推荐)',
    body: '测试节点在项目目录里跑测试命令,不过就失败 —— 把「AI 改坏了」挡在打包之前。',
    do: '连一个「测试」节点,填上测试命令(如 npm test)。',
  },
  {
    title: '4. 接输出节点',
    body: '输出节点把项目打包成可分发产物:Windows 应用(exe)、Web 应用、游戏包。打包前自动做安全审计。',
    do: '连「输出」节点 → 选打包目标 → 点「运行」。',
  },
  {
    title: '5. 看产物与预览',
    body: '跑完在输出节点上能看到产物;面板里的「预览产物」按钮能直接打开 exe / 网页,不用去文件夹找。',
    do: '运行结束后点「预览产物」。出错时节点上会出现「送修」按钮,一键建修复节点。',
  },
]

export function GuideOverlay(): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState(0)
  if (!open) {
    return (
      <button
        className="guide-fab"
        title="新手引导:5 分钟做出第一个应用"
        aria-label="新手引导"
        onClick={() => {
          setStep(0)
          setOpen(true)
        }}
      >
        ?
      </button>
    )
  }
  const s = STEPS[step]
  return (
    <div className="guide-mask" onClick={() => setOpen(false)}>
      <div className="guide-card" onClick={(e) => e.stopPropagation()}>
        <div className="guide-head">
          <span className="guide-title">
            <Icon name="logo" size={14} /> 新手引导
          </span>
          <button className="guide-close" aria-label="关闭引导" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>
        <div className="guide-body">
          <div className="guide-step-title">{s.title}</div>
          <div className="guide-step-body">{s.body}</div>
          <div className="guide-step-do">{s.do}</div>
        </div>
        <div className="guide-foot">
          <span className="guide-dots">
            {STEPS.map((_, i) => (
              <span key={i} className={`dot ${i === step ? 'on' : ''}`} />
            ))}
          </span>
          <span className="guide-nav">
            <button disabled={step === 0} onClick={() => setStep(step - 1)}>
              上一步
            </button>
            {step < STEPS.length - 1 ? (
              <button onClick={() => setStep(step + 1)}>下一步</button>
            ) : (
              <button onClick={() => setOpen(false)}>开始使用</button>
            )}
          </span>
        </div>
      </div>
    </div>
  )
}
