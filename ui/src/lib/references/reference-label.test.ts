import { describe, expect, it } from 'vitest'
import { inlineLabel, slackChannelOf, sourceLabel } from './reference-label'
import type { Reference } from './reference-set'

const ref = (href: string | null, note: string | null = null): Reference => ({ n: 3, href, note, quote: null })
const NONE = new Map<string, string>()
const NAMES = new Map([
  ['C08ABCDEF12', 'deploys'],
  ['D08ABCDEF12', 'Dana'],
])

describe('sourceLabel', () => {
  it('names the Slack channel a permalink points into once Seti knows it', () => {
    const message = 'https://acme.slack.com/archives/C08ABCDEF12/p1731000000123456'
    expect(sourceLabel(ref(message), NONE).label).toBe('Slack message')
    expect(sourceLabel(ref(message), NAMES).label).toBe('Slack message in #deploys')
    expect(sourceLabel(ref(`${message}?thread_ts=1731000000.123456`), NAMES).label).toBe('Slack thread in #deploys')
    expect(sourceLabel(ref('https://acme.slack.com/archives/C08ABCDEF12'), NAMES).label).toBe('#deploys')
    expect(sourceLabel(ref('https://acme.slack.com/archives/D08ABCDEF12/p1731000000123456'), NAMES).label).toBe(
      'Slack message with Dana',
    )
  })

  it('names GitHub and Linear sources by repo and number or issue key, with the host', () => {
    expect(sourceLabel(ref('https://github.com/acme/widgets/pull/12'), NONE)).toMatchObject({
      label: 'acme/widgets#12',
      host: 'github.com',
    })
    expect(sourceLabel(ref('https://linear.app/acme/issue/ENG-42/fix'), NONE)).toMatchObject({
      label: 'ENG-42',
      host: 'linear.app',
    })
    expect(sourceLabel(ref('https://www.example.com/a'), NONE).host).toBe('example.com')
  })

  it('names a footnote without a link by its words, bounded', () => {
    expect(sourceLabel(ref(null, 'Standup notes'), NONE)).toMatchObject({ label: 'Standup notes', host: null })
    expect(sourceLabel(ref(null), NONE).label).toBe('Source 3')
    expect(sourceLabel(ref(null, 'x'.repeat(500)), NONE).label).toHaveLength(60)
  })
})

describe('inlineLabel', () => {
  const inline = (href: string, names = NONE) => inlineLabel(sourceLabel(ref(href), names))

  it('names a bare URL by its service, and a plain web page by its host alone', () => {
    const file = 'https://acme.slack.com/files/U08ABCDEF12/F08ABCDEF12/q3-release-evaluation.pdf'
    expect(inline(file)).toBe('Slack file q3 release evaluation')
    expect(inline('https://acme.slack.com/archives/C08ABCDEF12/p1731000000123456', NAMES)).toBe(
      'Slack message in #deploys',
    )
    expect(inline('https://github.com/acme/widgets/pull/12')).toBe('acme/widgets#12')
    expect(inline('https://linear.app/acme/issue/ENG-42/fix')).toBe('ENG-42')
    expect(inline('https://www.example.com/runbooks/release?step=2')).toBe('example.com')
    expect(sourceLabel(ref('https://www.example.com/runbooks/release'), NONE).label).toBe(
      'example.com/runbooks/release',
    )
  })
})

describe('slackChannelOf', () => {
  it('reads the channel of a Slack archive link only', () => {
    expect(slackChannelOf('https://acme.slack.com/archives/C08ABCDEF12/p1731000000123456')).toBe('C08ABCDEF12')
    expect(slackChannelOf('https://evil.example/archives/C08ABCDEF12')).toBeNull()
    expect(slackChannelOf('https://acme.slack.com/team/U08ABCDEF12')).toBeNull()
    expect(slackChannelOf(null)).toBeNull()
  })
})
