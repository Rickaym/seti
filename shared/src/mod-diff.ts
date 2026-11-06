import type { ModContributions } from './mod-contributions.js'
import { describeCapability, type ModCapability, type ModCapabilityName, type ModManifest } from './mods.js'

/** One difference between what a mod holds and what a new version asks for, in plain words. */
export interface ModDiffEntry {
  /** The capability name, or the contribution point, such as views. */
  key: ModCapabilityName | keyof ModContributions
  text: string
}

/** added or widened entries need the user's consent; removed ones apply on their own. */
export interface ModCapabilityDiff {
  added: ModDiffEntry[]
  widened: ModDiffEntry[]
  /** Capabilities dropped or narrowed. */
  removed: ModDiffEntry[]
}

type Granted = Pick<ModManifest, 'capabilities' | 'contributes'>

/** No filter means every agent; a filter is within another that lists all of it. */
const agentsWithin = (next: readonly string[] | undefined, old: readonly string[] | undefined) =>
  old === undefined || old.length === 0 || (next !== undefined && next.length > 0 && within(next, old))

const within = (next: readonly string[], old: readonly string[]) => next.every((entry) => old.includes(entry))

const sameSet = (a: readonly string[], b: readonly string[]) => within(a, b) && within(b, a)

type Scope<K extends ModCapabilityName> = Extract<ModCapability, { name: K }>
type Narrower = { [K in ModCapabilityName]: (next: Scope<K>, old: Scope<K>) => boolean }

/** Whether a new scope reaches no further than the old; a different glob or host is wider. */
const NARROWER: Narrower = {
  'tasks.read': (next, old) => agentsWithin(next.agents, old.agents),
  'agents.context': (next, old) => agentsWithin(next.agents, old.agents),
  'tasks.manage': (next, old) => within(next.actions, old.actions),
  'chat.post': (next, old) => (!next.public || old.public) && (!next.direct || old.direct),
  'files.read': (next, old) => agentsWithin(next.agents, old.agents) && within(next.paths, old.paths),
  'net.fetch': (next, old) => within(next.hosts, old.hosts),
  connection: (next, old) => old.variable === next.variable && within(next.hosts, old.hosts),
  storage: () => true,
  notify: () => true,
  'seti.version': () => true,
  'workspaces.layout': () => true,
  'tasks.ask': () => true,
}

const narrowerOrEqual = <K extends ModCapabilityName>(next: Scope<K>, old: Scope<K>): boolean =>
  (NARROWER[next.name] as (next: Scope<K>, old: Scope<K>) => boolean)(next, old)

const extra = <T extends string>(next: readonly T[], old: readonly T[]) => next.filter((entry) => !old.includes(entry))

/** The part of a widened scope that is new, so the consent view shows only the difference. */
function extraOf(next: ModCapability, old: ModCapability): ModCapability {
  if (next.name === 'net.fetch' && old.name === 'net.fetch') {
    return { ...next, hosts: extra(next.hosts, old.hosts) }
  }
  if (next.name === 'connection' && old.name === 'connection' && old.variable === next.variable) {
    return { ...next, hosts: extra(next.hosts, old.hosts) }
  }
  if (next.name === 'tasks.manage' && old.name === 'tasks.manage') {
    return { ...next, actions: extra(next.actions, old.actions) }
  }
  if (next.name === 'files.read' && old.name === 'files.read' && agentsWithin(next.agents, old.agents)) {
    const paths = extra(next.paths, old.paths)
    return paths.length > 0 ? { ...next, paths } : next
  }
  return next
}

function capabilityDiff(old: readonly ModCapability[], next: readonly ModCapability[]): ModCapabilityDiff {
  const diff: ModCapabilityDiff = { added: [], widened: [], removed: [] }
  for (const capability of next) {
    const before = old.find((entry): entry is typeof capability => entry.name === capability.name)
    const entry = { key: capability.name, text: describeCapability(capability) }
    if (before === undefined) {
      diff.added.push(entry)
    } else if (!narrowerOrEqual(capability, before)) {
      diff.widened.push({ key: capability.name, text: describeCapability(extraOf(capability, before)) })
    } else if (JSON.stringify(capability) !== JSON.stringify(before)) {
      diff.removed.push(entry)
    }
  }
  for (const capability of old) {
    if (!next.some((entry) => entry.name === capability.name)) {
      diff.removed.push({ key: capability.name, text: describeCapability(capability) })
    }
  }
  return diff
}

interface Reach {
  key: keyof ModContributions
  wider: string
  fewer: string
  /** The declaration reduced to what must not change. */
  of: (contributes: ModContributions) => string[]
}

/** The declarations whose growth lets a mod reach further. */
const REACH: readonly Reach[] = [
  {
    key: 'notifications',
    wider: 'Sends a new kind of notification',
    fewer: 'Sends fewer kinds of notification',
    of: (c) => c.notifications.map((kind) => kind.id),
  },
  {
    key: 'contextProviders',
    wider: 'Adds new or changed text to agents',
    fewer: 'Adds less text to agents',
    of: (c) => c.contextProviders.map((provider) => `${provider.id}\n${provider.text}`),
  },
  {
    key: 'views',
    wider: 'Shows a new view',
    fewer: 'Shows fewer views',
    of: (c) => c.views.map((view) => `${view.id}@${view.where}`),
  },
  {
    key: 'fileViewers',
    wider: 'Opens new kinds of files',
    fewer: 'Opens fewer kinds of files',
    of: (c) => c.fileViewers.map((viewer) => `${viewer.id}:${viewer.extensions.join(',')}:${String(viewer.text)}`),
  },
  {
    key: 'schedules',
    wider: 'Runs on a new or faster schedule',
    fewer: 'Runs on fewer schedules',
    of: (c) => c.schedules.map((entry) => `${entry.id}@${entry.every}`),
  },
  {
    key: 'taskEvents',
    wider: 'Hears new agent events',
    fewer: 'Hears fewer agent events',
    of: (c) => [...c.taskEvents],
  },
  {
    key: 'commands',
    wider: 'Offers new or changed commands to you, the EA or agents',
    fewer: 'Offers fewer commands',
    of: (c) =>
      c.commands.map((entry) =>
        JSON.stringify([entry.id, entry.title, entry.description, entry.for, entry.level, entry.changes, entry.args]),
      ),
  },
  {
    key: 'slashCommands',
    wider: 'Adds new or changed slash commands',
    fewer: 'Adds fewer slash commands',
    of: (c) => c.slashCommands.map((entry) => `${entry.name}>${entry.command ?? ''}`),
  },
  {
    key: 'channelSources',
    wider: 'Takes a new channel source',
    fewer: 'Takes fewer channel sources',
    of: (c) => c.channelSources.map((source) => `${source.kind}:${source.id}`),
  },
]

/**
 * What a new manifest adds, widens or removes against what the mod was granted. Anything not
 * identical counts as wider, so in doubt Seti asks.
 */
export function diffCapabilities(old: Granted, next: Granted): ModCapabilityDiff {
  const diff = capabilityDiff(old.capabilities, next.capabilities)
  for (const reach of REACH) {
    const before = reach.of(old.contributes)
    const after = reach.of(next.contributes)
    if (!within(after, before)) {
      diff.widened.push({ key: reach.key, text: reach.wider })
    } else if (!sameSet(after, before)) {
      diff.removed.push({ key: reach.key, text: reach.fewer })
    }
  }
  return diff
}

/** Whether an update must wait for the user's consent. */
export const needsConsent = (diff: ModCapabilityDiff): boolean => diff.added.length + diff.widened.length > 0
