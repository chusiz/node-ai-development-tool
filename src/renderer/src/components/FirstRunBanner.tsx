import { useState, type JSX } from 'react'
import type { DetectResult } from '../types'
import { t } from '../lib/i18n'

const INSTALL_CMD = 'npm i -g @anthropic-ai/claude-code'
const DOC_URL = 'https://docs.anthropic.com/en/docs/claude-code'

/**
 * 换电脑之后最容易卡住的一步:没装 claude,或者装在一个自动探测找不到的地方。
 *
 * 这件事必须**在画布上说**,不能只靠顶栏一个灰色小徽标 —— 用户会一路点进节点、
 * 敲提示词、发现一直转圈,然后才回头去找原因。所以只要探测失败就横一条横幅,
 * 把"为什么不能跑""怎么装""装到别处了怎么办"三句话一次性说完。
 *
 * 可关闭:用户可能是故意先摆画布、稍后再装 CLI,不该被一直挡着。
 */
export function FirstRunBanner({
  detect,
  bootErr,
  onRecheck,
  onOpenSettings,
}: {
  detect: DetectResult | null
  bootErr: string | null
  onRecheck: () => void
  onOpenSettings: () => void
}): JSX.Element | null {
  const [closed, setClosed] = useState(false)
  const [copied, setCopied] = useState(false)

  // 还没探测完(或已经找到)就不出现。bootErr 也算"没找到"的一种表现
  if (closed || (!bootErr && (!detect || detect.found))) return null

  const copy = (): void => {
    void navigator.clipboard.writeText(INSTALL_CMD).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="firstrun">
      <span className="fr-icon" aria-hidden="true">
        ⚠
      </span>
      <div className="fr-body">
        <div className="fr-title">
          {t('firstrun.title')} <b>claude</b> {t('firstrun.titleTail')}
        </div>
        <div className="fr-hint">
          {t('firstrun.hint1')}
          <code>{INSTALL_CMD}</code>
          <button type="button" className="tiny" onClick={copy}>
            {copied ? t('firstrun.copied') : t('firstrun.copy')}
          </button>
          <br />
          {t('firstrun.hint2')}
          <b>{t('firstrun.exePath')}</b>
          {t('firstrun.hint3')}
          {bootErr ? <span className="fr-err"> {t('firstrun.probeErr')}:{bootErr}</span> : null}
        </div>
      </div>
      <div className="fr-actions">
        <button type="button" onClick={onRecheck}>
          {t('firstrun.recheck')}
        </button>
        <button type="button" className="primary" onClick={onOpenSettings}>
          {t('firstrun.gotoSettings')}
        </button>
        <button
          type="button"
          className="tiny"
          title={`${t('firstrun.docs')} ${DOC_URL}`}
          onClick={() => window.open(DOC_URL, '_blank')}
        >
          {t('firstrun.docs')}
        </button>
        <button type="button" className="tiny" title={t('firstrun.hide')} onClick={() => setClosed(true)}>
          ✕
        </button>
      </div>
    </div>
  )
}
