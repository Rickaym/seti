import { AWS_ACCESS_ID, PLANNED_TITLE_MAX, type AccessChoice, type PlannerOutput, type TaskSetup } from '@seti/shared'

export interface PlannerCatalog {
  repos: { id: string; slug: string; description: string; path?: string }[]
  packs: { id: string; name: string; description: string; linked_by_default: boolean; builtin: boolean }[]
  /** `local_to`: the directories whose local config alone has the server. */
  mcp: { name: string; default_enabled: boolean; local_to?: string[] }[]
  ssh_hosts: { alias: string; default_enabled: boolean }[]
  /** An AWS role exists for the default credential profile. */
  aws: { available: boolean; default_enabled: boolean }
}

/** What the caller fixed already, so the planner leaves it alone. */
export interface PlanPins {
  title?: string | undefined
  repo_ids?: readonly string[] | undefined
  worktree?: boolean | undefined
  /** A pinned directory: no repos. */
  cwd?: string | undefined
  /** The EA never grants SSH or AWS, whatever the planner says. */
  fromEa?: boolean
  /** Nor does an agent starting another with its seti tools. */
  fromAgent?: boolean
}

export interface AgentPlan {
  title: string
  repo_ids: string[]
  worktree: boolean
  context_pack_ids: string[]
  mcp_enabled: string[]
  mcp_disabled: string[]
  /** SSH hosts and AWS granted beyond their defaults. */
  access: AccessChoice[]
  setup: TaskSetup
}

const QUOTE_MARKS = new Set(['"', "'", '`'])

/** Drops quotes and spaces around a title, and a final period. */
function unquote(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && (QUOTE_MARKS.has(text.charAt(start)) || text.charAt(start) === ' ')) {
    start += 1
  }
  while (end > start && (QUOTE_MARKS.has(text.charAt(end - 1)) || ' .'.includes(text.charAt(end - 1)))) {
    end -= 1
  }
  return text.slice(start, end)
}

/** Cuts at a word boundary so a clipped title never ends mid-word. */
export function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text
  }
  const cut = text.slice(0, max + 1)
  const space = cut.lastIndexOf(' ')
  return (space > max / 2 ? cut.slice(0, space) : text.slice(0, max)).trimEnd()
}

const upperFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** A title from the message itself: its first line's opening words, the command sign dropped. */
export function fallbackTitle(message: string): string {
  const line =
    message
      .split('\n')
      .map((part) => part.replace(/^[/!#>*\-\s]+/, '').trim())
      .find((part) => part !== '') ?? ''
  const title = clip(unquote(line.replace(/\s+/g, ' ')), PLANNED_TITLE_MAX)
  return title === '' ? 'New agent' : upperFirst(title)
}

export function cleanTitle(raw: string, message: string): string {
  const title = clip(unquote(raw.replace(/\s+/g, ' ')), PLANNED_TITLE_MAX)
  return title === '' ? fallbackTitle(message) : upperFirst(title)
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The name appears on its own in the text, not as part of a longer word. */
const mentions = (text: string, name: string) =>
  new RegExp(`(?:^|[^\\w-])${escapeRegex(name)}(?:$|[^\\w-])`, 'i').test(text)

const AWS_WORDS = /\b(?:aws|amazon web services|cloudwatch|s3|ec2|ecs|eks|rds|dynamodb|cloudformation|route ?53)\b/i

/** A host is asked for only when the message names its alias; ambiguity grants nothing. */
export const asksForHost = (message: string, alias: string) => mentions(message, alias)

export const asksForAws = (message: string) => AWS_WORDS.test(message)

const byName = <T extends { name: string }>(items: readonly T[], name: string) =>
  items.find((item) => item.name.toLowerCase() === name.trim().toLowerCase())

function pickRepos(names: readonly string[], catalog: PlannerCatalog, withheld: string[]) {
  const picked: PlannerCatalog['repos'] = []
  for (const name of names) {
    const wanted = name.trim().toLowerCase()
    const repo = catalog.repos.find(
      (candidate) => candidate.slug.toLowerCase() === wanted || candidate.slug.toLowerCase().endsWith(`/${wanted}`),
    )
    if (repo === undefined) {
      withheld.push(`unknown repo ${name}`)
    } else if (!picked.includes(repo)) {
      picked.push(repo)
    }
  }
  return picked.slice(0, 10)
}

type Pack = PlannerCatalog['packs'][number]

const findPacks = (names: readonly string[], pool: readonly Pack[]) => [
  ...new Set(
    names.flatMap((name) => {
      const pack = byName(pool, name)
      return pack === undefined ? [] : [pack]
    }),
  ),
]

function pickPacks(raw: PlannerOutput, catalog: PlannerCatalog) {
  const defaults = catalog.packs.filter((pack) => pack.linked_by_default)
  const linked = findPacks(
    raw.link_packs,
    catalog.packs.filter((pack) => !pack.linked_by_default),
  )
  const unlinked = findPacks(
    raw.unlink_packs,
    defaults.filter((pack) => !pack.builtin),
  )
  const packs = [...defaults.filter((pack) => !unlinked.includes(pack)), ...linked]
  return {
    ids: packs.map((pack) => pack.id),
    linked: linked.map((pack) => pack.name),
    unlinked: unlinked.map((pack) => pack.name),
  }
}

type McpEntry = PlannerCatalog['mcp'][number]

/** What an MCP choice is checked against: the message and the directories the agent works in. */
interface McpAsk {
  message: string
  repoPaths: readonly string[]
  withheld: string[]
}

/** A local server of other directories goes on only when the message names it, like an SSH host. */
function grantLocal(server: McpEntry, { message, repoPaths, withheld }: McpAsk): boolean {
  const dirs = server.local_to ?? []
  if (dirs.length === 0) {
    return true
  }
  if (dirs.some((dir) => repoPaths.includes(dir))) {
    return false
  }
  if (!mentions(message, server.name)) {
    withheld.push(`MCP ${server.name}: not asked for explicitly`)
    return false
  }
  return true
}

function pickMcp(raw: PlannerOutput, catalog: PlannerCatalog, ask: McpAsk) {
  const flip = (names: readonly string[], fromDefault: boolean) => [
    ...new Set(
      names.flatMap((name) => {
        const server = byName(catalog.mcp, name)
        return server?.default_enabled === fromDefault ? [server] : []
      }),
    ),
  ]
  const disabled = flip(raw.disable_mcp, true).map((server) => server.name)
  const enabled = flip(raw.enable_mcp, false)
    .filter((server) => !disabled.includes(server.name))
    .filter((server) => grantLocal(server, ask))
    .map((server) => server.name)
  return { enabled, disabled }
}

interface Grant {
  granted: boolean
  withheld: string | null
}

interface GrantAsk {
  asked: boolean
  /** Already on by default, so there is nothing to grant. */
  byDefault: boolean
  available: boolean
  explicit: boolean
  /** Who asked that cannot grant access, if anyone. */
  grantless: 'the EA' | 'an agent' | null
}

function grant(label: string, { asked, byDefault, available, explicit, grantless }: GrantAsk): Grant {
  if (!asked || byDefault) {
    return { granted: false, withheld: null }
  }
  if (grantless !== null) {
    return { granted: false, withheld: `${label}: ${grantless} cannot grant it` }
  }
  if (!available) {
    return { granted: false, withheld: `${label}: not configured` }
  }
  return explicit
    ? { granted: true, withheld: null }
    : { granted: false, withheld: `${label}: not asked for explicitly` }
}

function grantlessOf(pins: PlanPins): GrantAsk['grantless'] {
  if (pins.fromEa === true) {
    return 'the EA'
  }
  return pins.fromAgent === true ? 'an agent' : null
}

/** SSH hosts and AWS the answer asks for, each held to the rules. */
function pickAccess(raw: PlannerOutput, message: string, catalog: PlannerCatalog, grantless: GrantAsk['grantless']) {
  const granted: { choice: AccessChoice; label: string }[] = []
  const withheld: string[] = []
  const take = (label: string, choice: AccessChoice, result: Grant) => {
    if (result.granted) {
      granted.push({ choice, label })
    } else if (result.withheld !== null) {
      withheld.push(result.withheld)
    }
  }
  for (const alias of new Set(raw.ssh_hosts.map((name) => name.trim()).filter((name) => name !== ''))) {
    const host = catalog.ssh_hosts.find((candidate) => candidate.alias === alias)
    take(
      `SSH ${alias}`,
      { kind: 'ssh', id: alias, enabled: true },
      grant(`SSH ${alias}`, {
        asked: true,
        byDefault: host?.default_enabled === true,
        available: host !== undefined,
        explicit: asksForHost(message, alias),
        grantless,
      }),
    )
  }
  take(
    'AWS',
    { kind: 'aws', id: AWS_ACCESS_ID, enabled: true },
    grant('AWS', {
      asked: raw.aws,
      byDefault: catalog.aws.default_enabled,
      available: catalog.aws.available,
      explicit: asksForAws(message),
      grantless,
    }),
  )
  return { granted, withheld }
}

/** The model's answer to a message, or an empty one with the reason the call failed. */
export interface PlannerAnswer {
  raw: PlannerOutput
  message: string
  reason: string | null
  ms: number
}

/** Holds the answer to the rules: only what exists, SSH or AWS only when configured and named. */
export function checkPlan(answer: PlannerAnswer, catalog: PlannerCatalog, pins: PlanPins = {}): AgentPlan {
  const { raw, message } = answer
  const withheld: string[] = []
  const pinnedRepos = pins.repo_ids?.map((id) => catalog.repos.find((repo) => repo.id === id))
  const picked =
    pins.cwd !== undefined
      ? []
      : (pinnedRepos?.filter((repo) => repo !== undefined) ?? pickRepos(raw.repos, catalog, withheld))
  const worktree = picked.length > 0 && (pins.repo_ids === undefined ? raw.worktree : (pins.worktree ?? true))
  const packs = pickPacks(raw, catalog)
  const repoPaths = [...picked.flatMap((repo) => (repo.path === undefined ? [] : [repo.path])), pins.cwd ?? '']
  const mcp = pickMcp(raw, catalog, { message, repoPaths, withheld })
  const access = pickAccess(raw, message, catalog, grantlessOf(pins))
  withheld.push(...access.withheld)
  const setup: TaskSetup = {
    planner: answer.reason === null ? 'model' : 'fallback',
    fallback_reason: answer.reason,
    repos: picked.map((repo) => repo.slug),
    worktree,
    packs_linked: packs.linked,
    packs_unlinked: packs.unlinked,
    mcp_enabled: mcp.enabled,
    mcp_disabled: mcp.disabled,
    access: access.granted.map((item) => item.label),
    withheld,
    ms: answer.ms,
  }
  return {
    title: pins.title ?? cleanTitle(raw.title, message),
    repo_ids: pins.repo_ids === undefined ? picked.map((repo) => repo.id) : [...pins.repo_ids],
    worktree,
    context_pack_ids: packs.ids,
    mcp_enabled: mcp.enabled,
    mcp_disabled: mcp.disabled,
    access: access.granted.map((item) => item.choice),
    setup,
  }
}
