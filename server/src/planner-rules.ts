import { AWS_ACCESS_ID, type AccessChoice, type PlannerOutput, type TaskSetup } from '@seti/shared'
import { titleFor } from './planner-title.js'

export interface PlannerCatalog {
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
  /** The EA never grants SSH or AWS, whatever the planner says. */
  fromEa?: boolean
  /** Nor does an agent starting another with its seti tools. */
  fromAgent?: boolean
}

export interface AgentPlan {
  title: string
  context_pack_ids: string[]
  mcp_enabled: string[]
  mcp_disabled: string[]
  /** SSH hosts and AWS granted beyond their defaults. */
  access: AccessChoice[]
  setup: TaskSetup
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

/** What an MCP choice is checked against: the message, and where refusals are noted. */
interface McpAsk {
  message: string
  withheld: string[]
}

/** A local server of other directories goes on only when the message names it, like an SSH host. */
function grantLocal(server: McpEntry, { message, withheld }: McpAsk): boolean {
  if ((server.local_to ?? []).length === 0) {
    return true
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
  const packs = pickPacks(raw, catalog)
  const mcp = pickMcp(raw, catalog, { message, withheld })
  const access = pickAccess(raw, message, catalog, grantlessOf(pins))
  withheld.push(...access.withheld)
  const titled = pins.title === undefined ? titleFor(raw.title, message) : { title: pins.title, problem: null }
  const setup: TaskSetup = {
    planner: answer.reason === null ? 'model' : 'fallback',
    fallback_reason: answer.reason ?? titled.problem,
    packs_linked: packs.linked,
    packs_unlinked: packs.unlinked,
    mcp_enabled: mcp.enabled,
    mcp_disabled: mcp.disabled,
    access: access.granted.map((item) => item.label),
    withheld,
    ms: answer.ms,
  }
  return {
    title: titled.title,
    context_pack_ids: packs.ids,
    mcp_enabled: mcp.enabled,
    mcp_disabled: mcp.disabled,
    access: access.granted.map((item) => item.choice),
    setup,
  }
}
