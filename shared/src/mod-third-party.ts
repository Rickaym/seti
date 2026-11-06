import { MOD_POINTS, usedPoints } from './mod-contributions.js'
import { thirdPartyHostProblem } from './mod-scopes.js'
import type { ModActivation, ModManifest } from './mods.js'
import { secretNameProblem } from './secret-names.js'
import { TEAM_RESERVED_HANDLES } from './team.js'

/** Ids no third-party mod may take: Seti's own names, chat's reserved handles and Mods' add page. */
const RESERVED_IDS: ReadonlySet<string> = new Set([
  'seti',
  'core',
  'system',
  'mod',
  'mods',
  'add',
  ...TEAM_RESERVED_HANDLES,
])

/** Names that would pass a mod off as Seti or its assistant. */
const RESERVED_NAMES: ReadonlySet<string> = new Set(['seti', 'ea', 'executive assistant'])

/** Capabilities that reach core services, held only by mods reviewed with Seti. */
const BUNDLED_ONLY_CAPABILITIES: ReadonlySet<string> = new Set(['seti.version', 'tasks.ask', 'workspaces.layout'])

type Rule = (manifest: ModManifest, bundledIds: ReadonlySet<string>) => string | null

const identity: Rule = (manifest, bundledIds) => {
  if (RESERVED_IDS.has(manifest.id) || bundledIds.has(manifest.id)) {
    return `The id ${manifest.id} is taken by Seti; pick another`
  }
  return RESERVED_NAMES.has(manifest.name.trim().toLowerCase())
    ? `The name ${manifest.name} belongs to Seti; pick another`
    : null
}

const startsOff: Rule = (manifest) => {
  if (manifest.defaultEnabled) {
    return 'A third-party mod starts off until you turn it on; remove defaultEnabled'
  }
  return manifest.activation.includes('onStartup')
    ? 'A third-party mod runs only when an event names it; remove onStartup'
    : null
}

const capabilities: Rule = (manifest) => {
  for (const capability of manifest.capabilities) {
    if (BUNDLED_ONLY_CAPABILITIES.has(capability.name)) {
      return `Only mods bundled with Seti may ask for ${capability.name}`
    }
    const hosts = capability.name === 'net.fetch' || capability.name === 'connection' ? capability.hosts : []
    const problem = hosts.map(thirdPartyHostProblem).find((found) => found !== null)
    if (problem !== undefined) {
      return problem
    }
  }
  return null
}

const points: Rule = (manifest) => {
  const closed = usedPoints(manifest.contributes).find((point) => !MOD_POINTS[point].thirdParty)
  return closed === undefined ? null : `It adds ${closed}, which this Seti cannot take from third-party mods yet`
}

const files: Rule = (manifest) => {
  if (manifest.main !== undefined && !manifest.main.endsWith('.js')) {
    return 'main is one .js file, such as logic.js'
  }
  const pages = [...manifest.contributes.views, ...manifest.contributes.fileViewers]
  const page = pages.find((entry) => entry.entry?.endsWith('.html') !== true)
  if (page !== undefined) {
    return `${page.title} needs an entry: a self-contained .html file in the package`
  }
  const secret = manifest.contributes.fileViewers
    .flatMap((viewer) => viewer.extensions)
    .find((extension) => secretNameProblem(`file.${extension}`) !== null)
  if (secret !== undefined) {
    return `.${secret} files hold keys or credentials, which Seti never hands to a third-party viewer`
  }
  const chorded = manifest.contributes.commands.find((command) => command.chord !== undefined)
  if (chorded !== undefined) {
    return `${chorded.title} binds a key chord, which only mods Seti ships do`
  }
  const header = manifest.contributes.commands.find((command) => command.for.includes('agentHeader'))
  if (header !== undefined) {
    return `${header.title} sits in the agent header, which only mods Seti ships add to`
  }
  const poller = manifest.contributes.channelSources.find((source) => source.kind !== 'webhook')
  return poller === undefined ? null : `${poller.title} is a poller template, which only mods Seti ships add`
}

const has = (manifest: ModManifest, name: string) => manifest.capabilities.some((entry) => entry.name === name)

/** Each event, whether the manifest declares something for it to run. */
const EVENT_NEEDS: Readonly<Record<Exclude<ModActivation, 'onStartup'>, (manifest: ModManifest) => boolean>> = {
  onCommand: (manifest) => manifest.contributes.commands.length > 0,
  onWebhook: (manifest) => manifest.contributes.channelSources.some((source) => source.kind === 'webhook'),
  onSchedule: (manifest) => manifest.contributes.schedules.length > 0,
  onTaskEvent: (manifest) => manifest.contributes.taskEvents.length > 0,
}

const events: Rule = (manifest) => {
  for (const [event, declared] of Object.entries(EVENT_NEEDS)) {
    const named = manifest.activation.includes(event as ModActivation)
    if (named !== declared(manifest)) {
      return named ? `${event} has nothing to run: declare what fires it` : `What it declares needs ${event}`
    }
    if (named && manifest.main === undefined) {
      return `${event} runs code, so name it in main`
    }
  }
  return manifest.contributes.taskEvents.length > 0 && !has(manifest, 'tasks.read')
    ? 'Task events need the tasks.read capability'
    : null
}

const RULES: readonly Rule[] = [identity, startsOff, capabilities, points, files, events]

/** Why Seti refuses the manifest from a third party, or null; bundledIds are the ids Seti ships. */
export function thirdPartyProblem(manifest: ModManifest, bundledIds: ReadonlySet<string>): string | null {
  for (const rule of RULES) {
    const problem = rule(manifest, bundledIds)
    if (problem !== null) {
      return problem
    }
  }
  return null
}
