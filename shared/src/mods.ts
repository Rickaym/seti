import { z } from 'zod'
import { requestHost } from './change-requests.js'
import type { ModBisectState, ModInstallInfo } from './mod-admin.js'
import {
  AVAILABLE_VIEW_PLACES,
  MOD_POINTS,
  THIRD_PARTY_VIEW_PLACES,
  modContributions,
  usedPoints,
  type ModPoint,
  type ModSettingField,
} from './mod-contributions.js'
import { modListingFields, type ModDocs, type ModIcon } from './mod-listing.js'
import { modAgentEntry, modGlob } from './mod-scopes.js'
import { thirdPartyProblem } from './mod-third-party.js'

/** The version of the mod API this Seti offers; a manifest's `seti` range must match it. */
export const MOD_API_VERSION = '1.21.0'

/** A mod's id: lowercase words joined by -, so `<mod>.<name>` never reads two ways. */
export const MOD_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

export const modId = z.string().min(2).max(40).regex(MOD_ID, 'A mod id is lowercase words joined by -')

const SEMVER = /^\d+\.\d+\.\d+$/
const RANGE = /^(\^|~|>=)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/

/** The events that run a mod's code; onStartup is for bundled mods alone. */
export const MOD_ACTIVATIONS = ['onStartup', 'onCommand', 'onWebhook', 'onSchedule', 'onTaskEvent'] as const
export type ModActivation = (typeof MOD_ACTIVATIONS)[number]

/** Where a mod comes from, which decides where its code runs and who may turn it on. */
export const MOD_TIERS = ['theme', 'bundled', 'third-party'] as const
export type ModTier = (typeof MOD_TIERS)[number]

/** The names of every capability a manifest can ask for. */
export const MOD_CAPABILITIES = [
  'tasks.read',
  'tasks.manage',
  'chat.post',
  'files.read',
  'net.fetch',
  'connection',
  'storage',
  'notify',
  'agents.context',
  'seti.version',
  'workspaces.layout',
  'tasks.ask',
] as const
export type ModCapabilityName = (typeof MOD_CAPABILITIES)[number]

const hosts = z.array(requestHost).min(1).max(20)
const agentFilter = z.array(modAgentEntry).max(20).optional()

/** What tasks.manage may do to an agent; never archive, delete, restart, permissions or keys. */
export const MOD_TASK_ACTIONS = ['rename', 'pin', 'set_color', 'link_pr', 'unlink_pr', 'start', 'stop'] as const
export type ModTaskAction = (typeof MOD_TASK_ACTIONS)[number]

/** One capability as the manifest asks for it; each is enforced on the server, never trusted. */
export const modCapability = z.discriminatedUnion('name', [
  z.strictObject({ name: z.literal('tasks.read'), agents: agentFilter }),
  z.strictObject({ name: z.literal('tasks.manage'), actions: z.array(z.enum(MOD_TASK_ACTIONS)).min(1).max(7) }),
  z
    .strictObject({
      name: z.literal('chat.post'),
      public: z.boolean().default(false),
      direct: z.boolean().default(false),
    })
    .refine((chat) => chat.public || chat.direct, 'Say whether it posts in public, directly, or both'),
  z.strictObject({ name: z.literal('files.read'), agents: agentFilter, paths: z.array(modGlob).min(1).max(20) }),
  z.strictObject({ name: z.literal('net.fetch'), hosts }),
  z.strictObject({
    name: z.literal('connection'),
    variable: z
      .string()
      .max(64)
      .regex(/^[A-Z][A-Z0-9_]*$/, 'A connection variable is like LINEAR_API_KEY'),
    hosts,
  }),
  z.strictObject({ name: z.literal('storage') }),
  z.strictObject({ name: z.literal('notify') }),
  z.strictObject({ name: z.literal('agents.context'), agents: agentFilter }),
  z.strictObject({ name: z.literal('seti.version') }),
  z.strictObject({ name: z.literal('workspaces.layout') }),
  z.strictObject({ name: z.literal('tasks.ask') }),
])
export type ModCapability = z.output<typeof modCapability>

/** The longest tool name Claude takes. */
const MOD_TOOL_NAME_MAX = 64

/** An agent's seti tool for a mod command; a mod id has no _, so the name reads one way. */
export const modToolName = (mod: string, command: string): string => `mod_${mod}_${command}`

/** `seti-mod.json`: who the mod is, what it may do and what it adds. */
export const modManifest = z
  .strictObject({
    id: modId,
    name: z.string().trim().min(1).max(40),
    version: z.string().regex(SEMVER, 'A version is major.minor.patch, such as 1.0.0'),
    seti: z.string().regex(RANGE, 'A mod API range is like ^1.0, ~1.2, >=1.0 or 1.0.0'),
    description: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .regex(/^[^\r\n]*$/, 'A description is one line'),
    author: z.string().trim().max(80).optional(),
    license: z.string().trim().max(40).optional(),
    ...modListingFields,
    main: z.string().max(200).optional(),
    capabilities: z.array(modCapability).max(20).default([]),
    activation: z.array(z.enum(MOD_ACTIVATIONS)).default([]),
    /** Only the user turns it on or off, never the EA or an agent. */
    securitySensitive: z.boolean().default(false),
    /** On until the user turns it off; for features that moved out of core into a mod. */
    defaultEnabled: z.boolean().default(false),
    /** Part of Seti: always on, never turned off or uninstalled; for bundled mods only. */
    required: z.boolean().default(false),
    contributes: modContributions.default(modContributions.parse({})),
  })
  .superRefine((manifest, ctx) => {
    const names = manifest.capabilities.map((capability) => capability.name)
    const twice = names.find((name, i) => names.indexOf(name) !== i)
    if (twice !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['capabilities'], message: `${twice} is asked for twice` })
    }
    if (manifest.contributes.notifications.length > 0 && !names.includes('notify')) {
      ctx.addIssue({ code: 'custom', path: ['capabilities'], message: 'Notification kinds need the notify capability' })
    }
    const long = manifest.contributes.commands.find(
      (entry) => entry.for.includes('agents') && modToolName(manifest.id, entry.id).length > MOD_TOOL_NAME_MAX,
    )
    if (long !== undefined) {
      const message = `The agent tool ${modToolName(manifest.id, long.id)} is longer than ${String(MOD_TOOL_NAME_MAX)}`
      ctx.addIssue({ code: 'custom', path: ['contributes', 'commands'], message })
    }
  })
export type ModManifest = z.output<typeof modManifest>
export type ModManifestInput = z.input<typeof modManifest>

const parts = (version: string) => version.split('.').map(Number)

/** Whether the mod API version matches a range: exact, ^ (same major), ~ (same minor) or >=. */
export function apiRangeMatches(range: string, version: string = MOD_API_VERSION): boolean {
  const match = RANGE.exec(range)
  if (match === null) {
    return false
  }
  const want = [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)]
  const [major = 0, minor = 0, patch = 0] = parts(version)
  const have = [major, minor, patch]
  const compare = have.map((n, i) => n - (want[i] ?? 0)).find((d) => d !== 0) ?? 0
  const operator = match[1] ?? '='
  const fits: Record<string, boolean> = {
    '^': major === want[0] && compare >= 0,
    '~': major === want[0] && minor === want[1] && compare >= 0,
    '>=': compare >= 0,
    '=': compare === 0,
  }
  return fits[operator] === true
}

/** A viewer only a bundled mod may add: of Seti's own kinds, serving pages, or behind a switch. */
const bundledOnlyViewer = (viewer: ModManifest['contributes']['fileViewers'][number]) =>
  viewer.kinds.length > 0 || viewer.page || viewer.setting !== undefined

/** Context needs its capability, only third-party logic runs schedules, only Seti's are required. */
function tierProblem(manifest: ModManifest, tier: ModTier): string | null {
  const { contextProviders, schedules, taskEvents } = manifest.contributes
  if (manifest.required && tier !== 'bundled') {
    return 'Only mods bundled with Seti may be required; remove required'
  }
  if (contextProviders.length > 0 && !manifest.capabilities.some((entry) => entry.name === 'agents.context')) {
    return 'Context text needs the agents.context capability'
  }
  return tier !== 'third-party' && schedules.length + taskEvents.length > 0
    ? "Schedules and task events run a third-party mod's logic.js; a bundled mod uses its server half"
    : null
}

/**
 * Why Seti cannot run the manifest as a mod of this tier, or null when it can: a point with no
 * registry yet, a point the tier never gets, or a mod API range that does not match.
 */
export function manifestProblem(
  manifest: ModManifest,
  tier: ModTier,
  bundledIds: ReadonlySet<string> = new Set(),
): string | null {
  if (!apiRangeMatches(manifest.seti)) {
    return `It needs mod API ${manifest.seti}, and this Seti offers ${MOD_API_VERSION}`
  }
  const points = usedPoints(manifest.contributes)
  const code = manifest.main !== undefined || manifest.capabilities.length > 0
  if (tier === 'theme' && (code || points.some((point) => point !== 'themes'))) {
    return 'A theme mod adds themes and nothing else, with no code and no capabilities'
  }
  const closed = points.find((point) => tier !== 'bundled' && MOD_POINTS[point].bundledOnly)
  if (closed !== undefined) {
    return `Only mods bundled with Seti may add ${closed}`
  }
  if (tier !== 'bundled' && manifest.contributes.fileViewers.some(bundledOnlyViewer)) {
    return "Only mods bundled with Seti may show Seti's own file kinds, serve pages or switch viewers"
  }
  const missing = points.find((point) => !MOD_POINTS[point].available)
  if (missing !== undefined) {
    return `It adds ${missing}, which this Seti cannot take from mods yet`
  }
  const tiered = tierProblem(manifest, tier)
  if (tiered !== null) {
    return tiered
  }
  const places = tier === 'third-party' ? THIRD_PARTY_VIEW_PLACES : AVAILABLE_VIEW_PLACES
  const place = manifest.contributes.views.find((view) => !places.has(view.where))
  if (place !== undefined) {
    return `It adds a view in ${place.where}, which this Seti cannot place yet`
  }
  return tier === 'third-party' ? thirdPartyProblem(manifest, bundledIds) : null
}

/** Whether any point the mod uses takes full effect only after a restart. */
export const needsRestart = (manifest: ModManifest): boolean =>
  usedPoints(manifest.contributes).some((point: ModPoint) => MOD_POINTS[point].restart)

const listOf = (items: readonly string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`

const agentName = (entry: string) =>
  entry.startsWith('role:') ? `agents with the role ${entry.slice(5)}` : `@${entry}`

const forAgents = (agents: readonly string[] | undefined) =>
  agents === undefined || agents.length === 0 ? 'every agent' : listOf(agents.map(agentName))

/** A host as consent shows it: a wildcard reads as every subdomain of its domain. */
export const hostWords = (host: string): string =>
  host.startsWith('*.') ? `every subdomain of ${host.slice(2)}` : host

const hostList = (names: readonly string[]) => listOf(names.map(hostWords))

const AGENT_VERBS: Partial<Record<ModTaskAction, string>> = { rename: 'renames', pin: 'pins', set_color: 'recolours' }
const PR_VERBS: Partial<Record<ModTaskAction, string>> = { link_pr: 'links', unlink_pr: 'unlinks' }

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

const plural = (verb: string) => `${verb}s`

function manageWords(actions: readonly ModTaskAction[]): string {
  const verbs = (table: Partial<Record<ModTaskAction, string>>) =>
    actions.flatMap((action) => (table[action] === undefined ? [] : [table[action]]))
  const agents = verbs(AGENT_VERBS)
  const prs = verbs(PR_VERBS)
  const doing = [
    ...(agents.length > 0 ? [`${listOf(agents)} agents`] : []),
    ...(prs.length > 0 ? [`${listOf(prs)} their PRs`] : []),
  ]
  const asks = (['start', 'stop'] as const).filter((action) => actions.includes(action))
  const ask = asks.length > 0 ? `Asks you before it ${asks.map(plural).join(' or ')} an agent.` : ''
  return [doing.length > 0 ? `${capitalized(doing.join(' and '))}.` : '', ask].filter(Boolean).join(' ')
}

function chatWords(inPublic: boolean, direct: boolean, as: string): string {
  if (!inPublic) {
    return `Messages one agent at a time directly${as}.`
  }
  const also = direct ? ', and messages one agent directly' : ''
  return `Posts in the group chat${as}${also}.`
}

const notifyWords = (kinds: readonly string[]) =>
  kinds.length > 0 ? `Sends you notifications: ${listOf(kinds)}.` : 'Sends you notifications of its own kinds.'

/** What Seti knows of the mod beyond the capability, to name it and its kinds in the copy. */
export interface CapabilityAbout {
  /** The mod's name, as its posts carry it. */
  mod?: string
  /** The titles of the notification kinds it declares. */
  notifications?: readonly string[]
}

type Describer<K extends ModCapabilityName> = (
  capability: Extract<ModCapability, { name: K }>,
  about: CapabilityAbout,
) => string

const fixed = (words: string) => () => words

/** Each capability in plain words, written by Seti and never by the mod. */
const DESCRIBERS: { [K in ModCapabilityName]: Describer<K> } = {
  'tasks.read': (c) => `Reads ${forAgents(c.agents)}: status, PRs and transcripts. Direct messages stay hidden.`,
  'tasks.manage': (c) => manageWords(c.actions),
  'chat.post': (c, about) => chatWords(c.public, c.direct, about.mod === undefined ? '' : ` as ${about.mod}`),
  'files.read': (c) =>
    `Reads files matching ${listOf(c.paths)} in the folders of ${forAgents(c.agents)}. ` +
    'Never keys, credentials or .env files.',
  'net.fetch': (c) => `Sends and receives data with ${hostList(c.hosts)}. It can send what it reads there.`,
  connection: (c) =>
    `Uses your ${c.variable} connection with ${hostList(c.hosts)}. It never sees the key, ` +
    'and it can send what it reads there.',
  storage: fixed('Keeps up to 1 MB of its own data in Seti.'),
  notify: (_c, about) => notifyWords(about.notifications ?? []),
  'agents.context': (c) => `Adds text of its own to the instructions of ${forAgents(c.agents)}.`,
  'seti.version': fixed('Reads which Seti runs, its changelog and whether a newer one is out.'),
  'workspaces.layout': fixed('Keeps a panel layout for each workspace.'),
  'tasks.ask': fixed('Asks agents side questions, answered from their context without interrupting them.'),
}

/** A capability in plain words, written by Seti and never by the mod, as consent shows it. */
export function describeCapability(capability: ModCapability, about: CapabilityAbout = {}): string {
  const describe = DESCRIBERS[capability.name] as Describer<ModCapabilityName>
  return describe(capability, about)
}

/** The copy of every capability of a manifest, naming the mod and its notification kinds. */
export const describeCapabilities = (manifest: ModManifest): string[] =>
  manifest.capabilities.map((capability) =>
    describeCapability(capability, {
      mod: manifest.name,
      notifications: manifest.contributes.notifications.map((kind) => kind.title),
    }),
  )

/** A notification kind a mod adds, and whether the user has it on. */
export interface ModNotificationKind {
  id: string
  title: string
  description: string | null
  enabled: boolean
}

/** One mod as Settings, Mods lists it. */
export interface ModInfo {
  id: string
  name: string
  /** The manifest's displayName, or its name. */
  display_name: string
  icon: ModIcon | null
  version: string
  description: string
  author: string | null
  tier: ModTier
  /** The user's choice, or the manifest's default until the user makes one. */
  enabled: boolean
  /** Its contributions are registered now. */
  running: boolean
  /** Only the user turns it on or off. */
  security_sensitive: boolean
  /** Part of Seti: always on, so no one turns it off; its settings still change. */
  required: boolean
  /** Some of what it adds takes full effect only after a restart. */
  restart: boolean
  /** Its capabilities in plain words. */
  capabilities: string[]
  /** The contribution points it uses. */
  points: ModPoint[]
  /** Why it cannot run, such as a manifest error; null when it can. */
  problem: string | null
  /** Off because safe mode holds every third-party mod off. */
  held_by_safe_mode: boolean
  notifications: ModNotificationKind[]
  /** Its settings form and the values in force, the manifest's defaults for unset ones. */
  settings: { key: string; field: ModSettingField; value: unknown }[]
  /** Its switches, settings that turn viewers or fence renderers on and off, that are off now. */
  off_switches: string[]
  /** The validated manifest, so the UI registers what it declares; null when it is not valid. */
  manifest: ModManifest | null
  /** How a third-party mod was installed; null for the mods Seti ships. */
  install: ModInstallInfo | null
}

/** A mod as its page reads it: what the listing says, with its README and changelog. */
export type ModDetail = ModInfo & ModDocs

export interface ModList {
  /** Every third-party mod is off; the setting or SETI_SAFE_MODE=1 turns it on. */
  safe_mode: boolean
  /** Safe mode is on because of SETI_SAFE_MODE, so the setting cannot turn it off. */
  safe_mode_forced: boolean
  /** Developer mode: third-party install and dev mods; off by default. */
  dev_mode: boolean
  /** A mod bisect in progress, or null. */
  bisect: ModBisectState | null
  /** Third-party logic runs without bwrap's network isolation on this machine. */
  unisolated: boolean
  mods: ModInfo[]
}

export const modParams = z.object({ id: modId })

export const modListInput = z.strictObject({ safe_mode: z.boolean() })
export type ModListInput = z.input<typeof modListInput>

export const modChangeInput = z
  .strictObject({
    enabled: z.boolean().optional(),
    settings: z.record(z.string().max(40), z.unknown()).optional(),
    notifications: z.record(z.string().max(40), z.boolean()).optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), 'Say what to change')
export type ModChangeInput = z.input<typeof modChangeInput>

/** `<mod>.<name>`: how a mod's commands, kinds and items are named everywhere in Seti. */
export const modScoped = (mod: string, name: string): `${string}.${string}` => `${mod}.${name}`

export const modActionParams = z.object({ id: modId, action: z.string().min(1).max(40) })

export const modActionInput = z.strictObject({ args: z.record(z.string().max(40), z.unknown()).default({}) })

/** What a mod command answered, and the line Seti shows for it. */
export interface ModActionResult {
  mod: string
  action: string
  result: unknown
  text: string
}
