import type { ServiceIconKey } from '@seti/shared'

/** The lucide icon a link pill shows when its service has no brand mark. */
export type LinkGlyph = 'agent' | 'artifact' | 'chart' | 'cloud' | 'file' | 'link' | 'message' | 'settings' | 'share'

/** A service Seti recognises in a URL, without fetching it. */
export interface LinkService {
  id: string
  /** Host names it serves; a leading `*.` matches every subdomain of the rest. */
  hosts: readonly string[]
  /** Narrows the service to the paths it owns on a shared host, such as docs.google.com. */
  path?: RegExp
  icon: ServiceIconKey | null
  glyph: LinkGlyph
  /** The pill's label, from the URL and its decoded path segments; null shows the host and path. */
  label: (url: URL, parts: readonly string[]) => string | null
}

const ELLIPSIS = String.fromCodePoint(0x2026)
const PART_LIMIT = 28
const PATH_LIMIT = 36

/** A segment cut to `limit` characters with an ellipsis. */
export const clip = (text: string, limit = PART_LIMIT) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}${ELLIPSIS}`

/** A path short enough for a pill: its first and last segments when the whole is too long. */
export function shortPath(parts: readonly string[]): string {
  const whole = parts.join('/')
  if (whole.length <= PATH_LIMIT || parts.length === 0) {
    return clip(whole, PATH_LIMIT)
  }
  const first = parts[0] ?? ''
  const last = parts.at(-1) ?? ''
  return parts.length === 1 ? clip(last, PATH_LIMIT) : `${clip(first, 12)}/${ELLIPSIS}/${clip(last)}`
}

/** A title written into a URL slug, such as Release-plan-Q3 for "Release plan Q3". */
const unslug = (slug: string) => slug.replace(/[-_+]+/g, ' ').trim()

const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/
const DIGITS = /^\d+$/

/** A Slack file page, `/files/<user>/<file>/<name>`, named by its file name without extension. */
function slackFileLabel([, user = '', file = '', name = '']: readonly string[]): string | null {
  if (!/^[UW][A-Z0-9]{2,}$/.test(user) || !/^F[A-Z0-9]{2,}$/.test(file)) {
    return null
  }
  const title = unslug(name.replace(/\.[a-z0-9]{1,8}$/i, ''))
  return title === '' ? 'Slack file' : `Slack file ${clip(title)}`
}

function slackLabel(url: URL, parts: readonly string[]): string | null {
  const [section, channel, message] = parts
  if (section === 'files') {
    return slackFileLabel(parts)
  }
  if (section !== 'archives' || channel === undefined || !/^[CDG][A-Z0-9]{2,}$/.test(channel)) {
    return null
  }
  if (message === undefined) {
    return 'Slack channel'
  }
  if (!/^p\d{16}$/.test(message)) {
    return null
  }
  return url.searchParams.has('thread_ts') ? 'Slack thread' : 'Slack message'
}

/** First path segments on github.com that are GitHub's own pages, not an owner. */
const GITHUB_PAGES = new Set([
  'about',
  'apps',
  'codespaces',
  'dashboard',
  'explore',
  'features',
  'issues',
  'login',
  'marketplace',
  'new',
  'notifications',
  'orgs',
  'organizations',
  'pricing',
  'pulls',
  'search',
  'settings',
  'sponsors',
  'topics',
])

/** The line a GitHub file link points at, such as `:12` for `#L12-L20`. */
const githubLine = (hash: string) => {
  const line = /^#L(\d+)/.exec(hash)?.[1]
  return line === undefined ? '' : `:${line}`
}

function githubRepoPage(url: URL, slug: string, rest: readonly string[]): string {
  const [kind = '', id = '', ...tail] = rest
  if ((kind === 'pull' || kind === 'issues') && DIGITS.test(id)) {
    return `${slug}#${id}`
  }
  if (kind === 'commit' && /^[0-9a-f]{7,40}$/i.test(id)) {
    return `${slug}@${id.slice(0, 7).toLowerCase()}`
  }
  const run = tail[0] ?? ''
  if (kind === 'actions' && id === 'runs' && DIGITS.test(run)) {
    return `Run ${run}`
  }
  if ((kind === 'blob' || kind === 'tree') && tail.length > 0) {
    return `${slug}/${shortPath(tail)}${githubLine(url.hash)}`
  }
  return `${slug}/${shortPath(rest)}`
}

function githubLabel(url: URL, parts: readonly string[]): string | null {
  const [owner, repo, ...rest] = parts
  if (owner === undefined || GITHUB_PAGES.has(owner.toLowerCase())) {
    return null
  }
  if (repo === undefined) {
    return owner
  }
  const slug = `${owner}/${repo}`
  return rest.length === 0 ? slug : githubRepoPage(url, slug, rest)
}

function jiraLabel(url: URL, parts: readonly string[]): string | null {
  const browsed = parts[0] === 'browse' ? parts[1] : undefined
  const key = browsed ?? url.searchParams.get('selectedIssue') ?? ''
  return ISSUE_KEY.test(key) ? key.toUpperCase() : null
}

function sentryLabel(_url: URL, parts: readonly string[]): string | null {
  const at = parts.indexOf('issues')
  const id = at < 0 ? undefined : parts[at + 1]
  return id !== undefined && DIGITS.test(id) ? `Sentry issue ${id}` : null
}

function notionLabel(_url: URL, parts: readonly string[]): string | null {
  const last = parts.at(-1)
  if (last === undefined) {
    return null
  }
  const title = unslug(last.replace(/-?[0-9a-f]{32}$/i, ''))
  return title === '' ? 'Notion page' : clip(title)
}

function figmaLabel(_url: URL, [kind, key, name]: readonly string[]): string | null {
  if (kind === undefined || key === undefined || !['board', 'design', 'file', 'proto', 'slides'].includes(kind)) {
    return null
  }
  const title = unslug(name ?? '')
  return title === '' ? 'Figma file' : clip(title)
}

function vercelLabel(_url: URL, parts: readonly string[]): string | null {
  const [, project, deployment] = parts
  const isDeployment = parts.length === 3 && /^(?=.*[A-Z0-9])\w{8,}$/.test(deployment ?? '')
  return isDeployment && project !== undefined ? `${clip(project)} deployment` : null
}

/** AWS console services whose short name is not simply upper-cased. */
const AWS_NAMES: Partial<Record<string, string>> = {
  cloudformation: 'CloudFormation',
  cloudfront: 'CloudFront',
  cloudwatch: 'CloudWatch',
  console: 'console',
  dynamodbv2: 'DynamoDB',
  ecr: 'ECR',
  lambda: 'Lambda',
  route53: 'Route 53',
  secretsmanager: 'Secrets Manager',
}

function awsLabel(_url: URL, [service = 'console']: readonly string[]): string {
  const name = AWS_NAMES[service] ?? (service.length <= 4 ? service.toUpperCase() : service)
  return `AWS ${clip(name)}`
}

function azureLabel(url: URL): string {
  const parts = url.hash.split('/')
  const at = parts.indexOf('providers')
  const name = at < 0 ? undefined : parts[at + 3]
  return name === undefined || name === '' ? 'Azure portal' : `Azure ${clip(name)}`
}

const DATADOG_PAGES: Partial<Record<string, string>> = {
  apm: 'Datadog APM',
  dashboard: 'Datadog dashboard',
  incidents: 'Datadog incident',
  logs: 'Datadog logs',
  monitors: 'Datadog monitor',
  notebook: 'Datadog notebook',
}

function grafanaLabel(_url: URL, [kind, , slug]: readonly string[]): string {
  if (kind === 'd' && slug !== undefined) {
    return clip(unslug(slug))
  }
  return kind === 'explore' ? 'Grafana Explore' : 'Grafana'
}

function claudeLabel(_url: URL, parts: readonly string[]): string | null {
  const page = parts[0] === 'code' || parts[0] === 'public' ? parts[1] : parts[0]
  return (page === 'artifact' || page === 'artifacts') && parts.length >= 2 ? 'Claude artifact' : null
}

function youtubeLabel(url: URL, [page]: readonly string[]): string {
  if (url.hostname === 'youtu.be' || (page === 'watch' && url.searchParams.has('v'))) {
    return 'YouTube video'
  }
  if (page === 'shorts') {
    return 'YouTube short'
  }
  return page === 'playlist' ? 'YouTube playlist' : 'YouTube'
}

function driveLabel(_url: URL, parts: readonly string[]): string {
  if (parts.includes('folders')) {
    return 'Drive folder'
  }
  return parts[0] === 'file' ? 'Drive file' : 'Google Drive'
}

const fixed = (label: string) => () => label

/** Every service a link pill names; adding one is one entry here. */
export const LINK_SERVICES: readonly LinkService[] = [
  { id: 'slack', hosts: ['slack.com', '*.slack.com'], icon: null, glyph: 'message', label: slackLabel },
  { id: 'github', hosts: ['github.com', 'www.github.com'], icon: 'github', glyph: 'link', label: githubLabel },
  {
    id: 'linear',
    hosts: ['linear.app'],
    icon: 'linear',
    glyph: 'link',
    label: (_url, [, page, key = '']) => (page === 'issue' && ISSUE_KEY.test(key) ? key.toUpperCase() : null),
  },
  { id: 'jira', hosts: ['*.atlassian.net'], icon: 'jira', glyph: 'link', label: jiraLabel },
  { id: 'sentry', hosts: ['sentry.io', '*.sentry.io'], icon: 'sentry', glyph: 'link', label: sentryLabel },
  {
    id: 'notion',
    hosts: ['notion.so', 'www.notion.so', '*.notion.site'],
    icon: 'notion',
    glyph: 'link',
    label: notionLabel,
  },
  {
    id: 'google-doc',
    hosts: ['docs.google.com'],
    path: /^\/document\//,
    icon: 'googledocs',
    glyph: 'file',
    label: fixed('Google Doc'),
  },
  {
    id: 'google-sheet',
    hosts: ['docs.google.com'],
    path: /^\/spreadsheets\//,
    icon: 'googlesheets',
    glyph: 'file',
    label: fixed('Google Sheet'),
  },
  {
    id: 'google-slides',
    hosts: ['docs.google.com'],
    path: /^\/presentation\//,
    icon: 'googleslides',
    glyph: 'file',
    label: fixed('Google Slides'),
  },
  { id: 'google-drive', hosts: ['drive.google.com'], icon: 'googledrive', glyph: 'file', label: driveLabel },
  { id: 'figma', hosts: ['figma.com', 'www.figma.com'], icon: 'figma', glyph: 'link', label: figmaLabel },
  { id: 'vercel', hosts: ['vercel.com'], icon: 'vercel', glyph: 'link', label: vercelLabel },
  {
    id: 'aws',
    hosts: ['console.aws.amazon.com', '*.console.aws.amazon.com'],
    icon: null,
    glyph: 'cloud',
    label: awsLabel,
  },
  { id: 'azure', hosts: ['portal.azure.com'], icon: null, glyph: 'cloud', label: azureLabel },
  {
    id: 'datadog',
    hosts: ['datadoghq.com', '*.datadoghq.com', 'datadoghq.eu', '*.datadoghq.eu', 'app.ddog-gov.com'],
    icon: 'datadog',
    glyph: 'chart',
    label: (_url, [page = '']) => DATADOG_PAGES[page] ?? 'Datadog',
  },
  { id: 'grafana', hosts: ['*.grafana.net'], icon: 'grafana', glyph: 'chart', label: grafanaLabel },
  { id: 'claude', hosts: ['claude.ai'], icon: 'claude', glyph: 'artifact', label: claudeLabel },
  {
    id: 'youtube',
    hosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'],
    icon: 'youtube',
    glyph: 'link',
    label: youtubeLabel,
  },
]
