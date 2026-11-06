import { previewStatus, type ModKit, type ModPrChipProps, type PreviewStatus } from '@seti/mod-api'
import type { ReactNode } from 'react'
import { previewLink } from './preview-link'

const PREVIEW: Record<Exclude<PreviewStatus, 'none'>, { tone: 'success' | 'warning' | 'muted'; label: string }> = {
  ready: { tone: 'success', label: 'preview' },
  stale: { tone: 'warning', label: 'preview stale' },
  expired: { tone: 'muted', label: 'preview expired' },
}

/** The PR's preview state, a link that opens the preview while it is up; nothing without one. */
export function previewBadge({ Tag }: ModKit) {
  return function PreviewBadge({ pr }: ModPrChipProps): ReactNode {
    const status = previewStatus(pr.preview)
    if (status === 'none') {
      return null
    }
    const tag = <Tag tone={PREVIEW[status].tone}>{PREVIEW[status].label}</Tag>
    const href = previewLink(pr)
    return href === null ? (
      tag
    ) : (
      <a className="shrink-0 hover:underline" href={href} target="_blank" rel="noreferrer" title="Open the preview">
        {tag}
      </a>
    )
  }
}
