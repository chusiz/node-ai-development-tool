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
    title: '1. Add a Project node',
    body: 'The Project node is the authoritative source of the project folder for the whole workflow. It decides where every artifact is written.',
    do: 'Node panel on the left → drag “Project” to the canvas → pick a folder in the right panel.',
  },
  {
    title: '2. Connect a Feature node',
    body: 'Feature nodes are where the AI works: writing code and editing code happen here. Serial mode hands upstream results to the AI.',
    do: 'Connect a “Feature” node downstream of the Project node and type what you want it to do.',
  },
  {
    title: '3. Add a quality gate (optional but recommended)',
    body: 'The Test node runs test commands in the project directory and fails the run if they don’t pass — stopping “the AI broke it” before packaging.',
    do: 'Connect a “Test” node and fill in the test command (e.g. npm test).',
  },
  {
    title: '4. Connect an Output node',
    body: 'The Output node packages the project into distributable artifacts: Windows apps (exe), Web apps, game bundles. Security audit runs before packaging.',
    do: 'Connect the “Output” node → choose the packaging target → click “Run”.',
  },
  {
    title: '5. See artifacts & preview',
    body: 'After the run you can see artifacts on the Output node; the “Preview artifact” button in the panel opens the exe / webpage directly, no folder digging.',
    do: 'After the run ends, click “Preview artifact”. On error, a “Fix” button appears on the node to create a repair node in one click.',
  },
]

export function GuideOverlay(): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState(0)
  if (!open) {
    return (
      <button
        className="guide-fab"
        title="5-minute guided tour to your first app"
        aria-label="Guided tour"
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
            <Icon name="logo" size={14} /> Guided tour
          </span>
          <button className="guide-close" aria-label="Close tour" onClick={() => setOpen(false)}>
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
              Back
            </button>
            {step < STEPS.length - 1 ? (
              <button onClick={() => setStep(step + 1)}>Next</button>
            ) : (
              <button onClick={() => setOpen(false)}>Start</button>
            )}
          </span>
        </div>
      </div>
    </div>
  )
}
