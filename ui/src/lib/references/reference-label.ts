import { shownSlackName } from '@seti/shared'
import { pillOf, type LinkLabel } from '@/lib/links/link-label'
import { clip } from '@/lib/links/link-services'
import { useSlackNames } from '@/lib/slack-names'
import type { Reference } from './reference-set'

/** How a reference reads: its pill label made specific where Seti knows more, and its host. */
export interface SourceLabel extends LinkLabel {
  /** The host without `www.`; null for a footnote without a link. */
  host: string | null
}

const LABEL_LIMIT = 60
const SLACK_ID = /^[CDG][A-Z0-9]{2,}$/

/** The channel or conversation id a Slack archive link points into; null for any other URL. */
export function slackChannelOf(href: string | null): string | null {
  if (href === null || !URL.canParse(href)) {
    return null
  }
  const url = new URL(href)
  const slack = url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com')
  const [section, channel = ''] = url.pathname.split('/').filter((part) => part !== '')
  return slack && section === 'archives' && SLACK_ID.test(channel) ? channel : null
}

function slackLabel(base: string, channel: string | null, names: ReadonlyMap<string, string>): string {
  const shown = channel === null ? null : shownSlackName(channel, names)
  if (shown === null) {
    return base
  }
  if (base === 'Slack channel') {
    return shown
  }
  return `${base} ${shown.startsWith('#') ? 'in' : 'with'} ${shown}`
}

/** What a reference shows, from its URL, the Slack names Seti knows and the message alone. */
export function sourceLabel(ref: Reference, names: ReadonlyMap<string, string>): SourceLabel {
  const info = ref.href === null ? null : pillOf(ref.href)
  if (ref.href === null || info === null) {
    const label = clip(ref.note ?? `Source ${String(ref.n)}`, LABEL_LIMIT)
    return { label, service: 'note', icon: null, glyph: 'file', host: null }
  }
  const host = new URL(ref.href).host.replace(/^www\./, '')
  const label = info.service === 'slack' ? slackLabel(info.label, slackChannelOf(ref.href), names) : info.label
  return { ...info, label: clip(label, LABEL_LIMIT), host }
}

/** What a bare URL reads as inside a sentence: its label, or only the host for a plain web page. */
export const inlineLabel = (label: SourceLabel): string =>
  label.service === 'web' && label.host !== null ? label.host : label.label

/** The label of a reference, named again once Seti learns the Slack channel it points into. */
export function useSourceLabel(ref: Reference): SourceLabel {
  const channel = slackChannelOf(ref.href)
  const names = useSlackNames(channel === null ? [] : [channel])
  return sourceLabel(ref, names)
}
