import { describe, expect, it } from 'vitest'
import { linkLabel } from './link-label'

const CUT = String.fromCodePoint(0x2026)
const E_ACUTE = String.fromCodePoint(0xe9)
const U_UMLAUT = String.fromCodePoint(0xfc)
const SETI = 'https://seti.example.test'
const AGENT = '7d3f1c2a-1b2c-4d5e-8f90-123456789abc'

/** URL, label, service, icon. */
const SERVICES: [string, string, string, string | null][] = [
  ['https://acme.slack.com/archives/C08ABCDEF12/p1731000000123456', 'Slack message', 'slack', null],
  [
    'https://acme.slack.com/archives/C08ABCDEF12/p1731000000123456?thread_ts=1731000000.123456&cid=C08ABCDEF12',
    'Slack thread',
    'slack',
    null,
  ],
  ['https://acme.slack.com/archives/C08ABCDEF12', 'Slack channel', 'slack', null],
  [
    'https://acme.slack.com/files/U08ABCDEF12/F08ABCDEF12/q3-release-evaluation.pdf',
    'Slack file q3 release evaluation',
    'slack',
    null,
  ],
  ['https://acme.slack.com/files/U08ABCDEF12/F08ABCDEF12', 'Slack file', 'slack', null],
  ['https://github.com/acme/widgets/pull/123', 'acme/widgets#123', 'github', 'github'],
  ['https://github.com/acme/widgets/pull/123/files', 'acme/widgets#123', 'github', 'github'],
  ['https://github.com/acme/widgets/issues/45', 'acme/widgets#45', 'github', 'github'],
  ['https://github.com/acme/widgets/commit/5ae1a2fd0c3b9e1d2f', 'acme/widgets@5ae1a2f', 'github', 'github'],
  ['https://github.com/acme/widgets', 'acme/widgets', 'github', 'github'],
  ['https://github.com/acme', 'acme', 'github', 'github'],
  ['https://github.com/acme/widgets/actions/runs/987654321/job/1', 'Run 987654321', 'github', 'github'],
  ['https://github.com/acme/widgets/blob/main/src/app.ts#L12-L20', 'acme/widgets/src/app.ts:12', 'github', 'github'],
  [
    'https://github.com/acme/widgets/blob/main/ui/src/components/service-icon/ServiceIcon.tsx',
    `acme/widgets/ui/${CUT}/ServiceIcon.tsx`,
    'github',
    'github',
  ],
  ['https://linear.app/acme/issue/ENG-123/fix-the-thing', 'ENG-123', 'linear', 'linear'],
  ['https://acme.atlassian.net/browse/OPS-42', 'OPS-42', 'jira', 'jira'],
  ['https://acme.atlassian.net/jira/software/projects/OPS/boards/1?selectedIssue=OPS-7', 'OPS-7', 'jira', 'jira'],
  ['https://acme.sentry.io/issues/4512345678/?project=1', 'Sentry issue 4512345678', 'sentry', 'sentry'],
  ['https://sentry.io/organizations/acme/issues/77/', 'Sentry issue 77', 'sentry', 'sentry'],
  [
    'https://www.notion.so/acme/Release-plan-Q3-0123456789abcdef0123456789abcdef',
    'Release plan Q3',
    'notion',
    'notion',
  ],
  ['https://www.notion.so/0123456789abcdef0123456789abcdef', 'Notion page', 'notion', 'notion'],
  ['https://docs.google.com/document/d/1AbC/edit', 'Google Doc', 'google-doc', 'googledocs'],
  ['https://docs.google.com/spreadsheets/d/1AbC/edit#gid=0', 'Google Sheet', 'google-sheet', 'googlesheets'],
  ['https://docs.google.com/presentation/d/1AbC/edit', 'Google Slides', 'google-slides', 'googleslides'],
  ['https://drive.google.com/drive/folders/1AbC', 'Drive folder', 'google-drive', 'googledrive'],
  ['https://drive.google.com/file/d/1AbC/view', 'Drive file', 'google-drive', 'googledrive'],
  ['https://www.figma.com/design/AbC123/Checkout-flow?node-id=1-2', 'Checkout flow', 'figma', 'figma'],
  ['https://vercel.com/acme/storefront/9xK3pQ7rTz', 'storefront deployment', 'vercel', 'vercel'],
  ['https://eu-central-1.console.aws.amazon.com/ecs/v2/clusters?region=eu-central-1', 'AWS ECS', 'aws', null],
  ['https://console.aws.amazon.com/cloudwatch/home', 'AWS CloudWatch', 'aws', null],
  [
    'https://portal.azure.com/#@acme.test/resource/subscriptions/1/resourceGroups/rg/providers/Microsoft.Web/sites/shop/overview',
    'Azure shop',
    'azure',
    null,
  ],
  ['https://portal.azure.com/#home', 'Azure portal', 'azure', null],
  ['https://app.datadoghq.com/dashboard/abc-123/api-latency', 'Datadog dashboard', 'datadog', 'datadog'],
  ['https://app.datadoghq.eu/monitors/42', 'Datadog monitor', 'datadog', 'datadog'],
  ['https://acme.grafana.net/d/abc123/api-latency?orgId=1', 'api latency', 'grafana', 'grafana'],
  ['https://claude.ai/code/artifact/0b1c2d3e-aaaa-bbbb-cccc-1234567890ab', 'Claude artifact', 'claude', 'claude'],
  ['https://claude.ai/artifact/abc', 'Claude artifact', 'claude', 'claude'],
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'YouTube video', 'youtube', 'youtube'],
  ['https://youtu.be/dQw4w9WgXcQ?t=42', 'YouTube video', 'youtube', 'youtube'],
]

/** URL and label of links no service claims, shown as host and path. */
const WEB: [string, string][] = [
  ['https://www.example.com/', 'example.com'],
  ['https://example.com/docs/setup', 'example.com/docs/setup'],
  ['http://localhost:5173/settings', 'localhost:5173/settings'],
  ['https://example.com:8443/a?b=c#d', 'example.com:8443/a'],
  [
    'https://example.com/a/b/c/d/e/f/g/h/a-very-long-final-segment-name.html',
    `example.com/a/${CUT}/a-very-long-final-segment-n${CUT}`,
  ],
  ['https://example.com/caf%C3%A9/men%C3%BC', `example.com/caf${E_ACUTE}/men${U_UMLAUT}`],
  ['https://xn--r8jz45g.jp/', 'xn--r8jz45g.jp'],
  ['https://acme.slack.com/client/T1/C2', 'acme.slack.com/client/T1/C2'],
  ['https://acme.slack.com/files/settings', 'acme.slack.com/files/settings'],
  ['https://github.com/settings/tokens', 'github.com/settings/tokens'],
  ['https://evilgithub.com/acme/widgets/pull/1', 'evilgithub.com/acme/widgets/pull/1'],
  ['https://github.com.evil.test/acme/widgets', 'github.com.evil.test/acme/widgets'],
  ['https://github.com@evil.test/acme/widgets/pull/1', 'evil.test/acme/widgets/pull/1'],
]

describe('linkLabel', () => {
  it.each(SERVICES)('names %s', (url, label, service, icon) => {
    expect(linkLabel(url)).toMatchObject({ label, service, icon })
  })

  it.each(WEB)('shows %s as its host and path', (url, label) => {
    expect(linkLabel(url)).toMatchObject({ label, service: 'web', icon: null, glyph: 'link' })
  })

  it.each(['javascript:alert(1)', 'data:text/html,hi', 'mailto:a@example.com', 'ftp://example.com/x', 'not a url', ''])(
    'refuses %s',
    (url) => {
      expect(linkLabel(url)).toBeNull()
    },
  )

  it('labels a very long URL briefly and refuses one past the cap', () => {
    const long = `https://example.com/${'segment/'.repeat(400)}end`
    const info = linkLabel(long)
    expect(info?.label.length).toBeLessThan(60)
    expect(linkLabel(`https://example.com/${'x'.repeat(9000)}`)).toBeNull()
  })

  it("names this Seti's agents, files, shares and pages", () => {
    expect(linkLabel(`${SETI}/#/agents/${AGENT}`, SETI)).toMatchObject({ label: 'Agent', agent: AGENT, glyph: 'agent' })
    expect(linkLabel(`${SETI}/#agents/${AGENT}/files/workspace/notes/plan.md`, SETI)).toMatchObject({
      label: 'plan.md',
      service: 'seti',
      glyph: 'file',
    })
    expect(linkLabel(`${SETI}/share/abc123`, SETI)).toMatchObject({ label: 'Shared file', glyph: 'share' })
    expect(linkLabel(`${SETI}/#/settings/credentials`, SETI)).toMatchObject({ label: 'Seti settings' })
    expect(linkLabel(`${SETI}/#/agents/${AGENT}`)).toMatchObject({ service: 'web' })
  })
})
