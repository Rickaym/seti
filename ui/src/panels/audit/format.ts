import { AUDIT_AREAS, type AuditActor, type AuditArea, type AuditEvent } from '@seti/shared'

export const isArea = (value: string): value is AuditArea => (AUDIT_AREAS as readonly string[]).includes(value)

export const AREA_LABELS: Record<AuditArea, string> = {
  task: 'Agents',
  agent: 'Agent actions',
  repo: 'Repos',
  context: 'Context',
  mcp: 'MCP',
  plugin: 'Plugins',
  pr: 'Pull requests',
  account: 'Account',
  seti: 'Agent changes to Seti',
  ea: 'Executive Assistant',
  team: 'Group chat',
  workspace: 'Workspaces',
  mod: 'Mods',
  system: 'System',
}

export const ACTOR_STYLE: Record<AuditActor | 'routine', string> = {
  user: 'bg-actor-user/20 text-foreground',
  agent: 'bg-actor-agent/20 text-foreground',
  routine: 'bg-muted text-muted-foreground',
  system: 'bg-muted text-muted-foreground',
}

/** A mod's events, recorded as `mod:<id>`, read like Seti's own. */
export const actorStyle = (actor: AuditEvent['actor']): string =>
  actor.startsWith('mod:') ? ACTOR_STYLE.system : ACTOR_STYLE[actor as AuditActor | 'routine']

export interface SubjectLink {
  href: string
  label: string
}

const GONE = new Set([
  'task.deleted',
  'repo.removed',
  'context.pack_deleted',
  'plugin.default_removed',
  'system.profile_deleted',
  'system.connection_deleted',
])

const GITHUB_PR = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/

const settingsLink = (page: string, label: string) => () => ({ href: `#settings/${page}`, label })

/** Where an event's subject lives, by subject type; null for subjects without a page. */
const SUBJECT_LINKS: Record<AuditEvent['subject_type'], ((id: string) => SubjectLink) | null> = {
  task: (id) => ({ href: `#agents/${id}`, label: 'Agent' }),
  routine: null,
  pr: null,
  context_file: (id) => ({ href: `#context/${id}`, label: 'File' }),
  context_pack: (id) => ({ href: `#context/pack:${id}`, label: 'Pack' }),
  knowledge_note: () => ({ href: '#context/knowledge:approved', label: 'Knowledge' }),
  repo: settingsLink('repos', 'Repos'),
  mcp_server: settingsLink('mcp', 'MCP servers'),
  plugin: settingsLink('plugins', 'Plugins'),
  credential_profile: (id) => ({ href: `#settings/credentials/${id}`, label: 'Credential' }),
  connection: (id) => ({ href: `#settings/connections/${id}`, label: 'Connection' }),
  account: settingsLink('account', 'Account'),
  ea: settingsLink('ea', 'EA'),
  team: null,
  workspace: null,
  mod: settingsLink('mods', 'Mods'),
  system: null,
}

const detailText = (event: AuditEvent, key: string): string | null => {
  const value = event.detail[key]
  return typeof value === 'string' && value !== '' ? value : null
}

/** A task subject reads as the agent's title when the event recorded one. */
function subjectLink(event: AuditEvent): SubjectLink | null {
  const id = event.subject_id
  if (id === null || GONE.has(event.kind)) {
    return null
  }
  const link = SUBJECT_LINKS[event.subject_type]?.(id) ?? null
  const title = event.subject_type === 'task' ? detailText(event, 'title') : null
  return link !== null && title !== null ? { ...link, label: title } : link
}

/** The GitHub PR an event names by URL, or by repo and number for a preview request. */
function githubPrUrl(event: AuditEvent): string | null {
  const { url, repo, number } = event.detail
  if (typeof url === 'string' && GITHUB_PR.test(url)) {
    return url
  }
  return event.subject_type === 'pr' && typeof repo === 'string' && typeof number === 'number'
    ? `https://github.com/${repo}/pull/${String(number)}`
    : null
}

/** The subject of an event plus a linked pull request when the detail names one. */
export function eventLinks(event: AuditEvent): SubjectLink[] {
  const links: SubjectLink[] = []
  const subject = subjectLink(event)
  if (subject) {
    links.push(subject)
  }
  const taskId = event.detail.task_id
  if (typeof taskId === 'string' && event.subject_type !== 'task') {
    links.push({ href: `#agents/${taskId}`, label: 'Agent' })
  }
  const prLink = githubPrUrl(event)
  if (prLink !== null) {
    links.push({ href: prLink, label: 'PR' })
  }
  return links
}

export const isOutward = (event: AuditEvent) => event.kind === 'agent.outward'

export interface SentDetail {
  tool: string | null
  target: string | null
  text: string | null
  /** The other input fields, pretty-printed when they parse as JSON. */
  input: string | null
  truncated: boolean
}

function prettyJson(text: string | null): string | null {
  if (text === null) {
    return null
  }
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/** What an outward call sent and where; null for other events and for rows without a kept input. */
export function sentDetail(event: AuditEvent): SentDetail | null {
  if (!isOutward(event)) {
    return null
  }
  const target = detailText(event, 'target')
  const text = detailText(event, 'text')
  const input = prettyJson(detailText(event, 'input'))
  if (target === null && text === null && input === null) {
    return null
  }
  return { tool: detailText(event, 'tool'), target, text, input, truncated: event.detail.truncated === true }
}

export interface ViaNote {
  via: 'public' | 'ea'
  text: string
}

/** How a user action reached Seti when it was not typed locally: the public hostname or the EA. */
export function viaNote(event: AuditEvent): ViaNote | null {
  if (event.detail.via === 'ea') {
    return { via: 'ea', text: 'Asked through the EA voice assistant' }
  }
  if (event.detail.via !== 'public') {
    return null
  }
  const identity = event.detail.access_identity
  const text =
    typeof identity === 'string' ? `Through the public hostname as ${identity}` : 'Through the public hostname'
  return { via: 'public', text }
}

export const exactTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium', hourCycle: 'h23' })
