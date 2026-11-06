import type { ModConsentLine } from './mod-admin.js'
import type { ModContributions } from './mod-contributions.js'
import type { ModCapabilityDiff } from './mod-diff.js'
import { describeCapability, hostWords, type ModCapability, type ModManifest } from './mods.js'

/** What the user can bind a connection capability to: the connections with that variable. */
export type ConnectionChoices = (
  capability: Extract<ModCapability, { name: 'connection' }>,
) => ModConsentLine['connections']

const listOf = (items: readonly string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`

const UNITS: Readonly<Record<string, [string, string]>> = {
  m: ['minute', 'minutes'],
  h: ['hour', 'hours'],
  d: ['day', 'days'],
}

/** A schedule such as 15m in words: every 15 minutes. */
export function everyWords(every: string): string {
  const match = /^(\d+)([mhd])$/.exec(every)
  const [one, many] = UNITS[match?.[2] ?? ''] ?? ['', '']
  const count = Number(match?.[1] ?? 0)
  return count === 1 ? `every ${one}` : `every ${String(count)} ${many}`
}

/** A context text with each settings placeholder shown as the setting's title in brackets. */
export function contextPreview(text: string, contributes: ModContributions): string {
  return text.replace(/\{\{settings\.([a-zA-Z0-9_-]+)\}\}/g, (_match, key: string) => {
    const field = contributes.settings[key]
    return `[${field?.title ?? key}]`
  })
}

const DETAILS: Partial<Record<ModCapability['name'], string>> = {
  connection: 'Seti adds the key on its own server, only on requests to these hosts.',
  'net.fetch': 'Every host is two-way: what it reads elsewhere in Seti it can send to these hosts.',
  'tasks.manage': 'Never archives, deletes or restarts agents, and never changes their permissions or keys.',
}

function detailOf(capability: ModCapability, manifest: ModManifest): string | null {
  if (capability.name === 'agents.context') {
    return manifest.contributes.contextProviders
      .map((provider) => contextPreview(provider.text, manifest.contributes))
      .join('\n\n')
  }
  return DETAILS[capability.name] ?? null
}

/** Each capability in Seti's words, with the text it adds to agents and the connections to bind. */
export function consentLines(manifest: ModManifest, choices: ConnectionChoices): ModConsentLine[] {
  const notifications = manifest.contributes.notifications.map((kind) => kind.title)
  return manifest.capabilities.map((capability) => ({
    capability,
    text: describeCapability(capability, { mod: manifest.name, notifications }),
    detail: detailOf(capability, manifest),
    connections: capability.name === 'connection' ? choices(capability) : null,
  }))
}

const slashName = (name: string) => `/${name}`
const dotted = (extension: string) => `.${extension}`

const titles = (items: readonly { title: string }[]) => listOf(items.map((item) => item.title))

/** What the mod adds to Seti, in plain words; capabilities say what it may do. */
export function modAdds(contributes: ModContributions): string[] {
  const adds: string[] = []
  const add = (when: boolean, text: () => string) => {
    if (when) {
      adds.push(text())
    }
  }
  const settings = Object.values(contributes.settings)
  add(settings.length > 0, () => `Settings: ${titles(settings)}`)
  add(contributes.commands.length > 0, () => `Commands: ${titles(contributes.commands)}`)
  add(
    contributes.slashCommands.length > 0,
    () => `Slash commands: ${listOf(contributes.slashCommands.map((slash) => slashName(slash.name)))}`,
  )
  for (const view of contributes.views) {
    adds.push(`The view ${view.title}, ${view.phone ? 'on phones too' : 'on larger screens'}`)
  }
  for (const viewer of contributes.fileViewers) {
    adds.push(`Opens ${listOf(viewer.extensions.map(dotted))} files`)
  }
  add(contributes.statusBar.length > 0, () => `Status bar items: ${titles(contributes.statusBar)}`)
  add(contributes.themes.length > 0, () => `Themes: ${titles(contributes.themes)}`)
  add(contributes.channelSources.length > 0, () => `Channel sources: ${titles(contributes.channelSources)}`)
  for (const schedule of contributes.schedules) {
    adds.push(`Runs ${everyWords(schedule.every)}`)
  }
  add(
    contributes.taskEvents.length > 0,
    () => `Hears agent events: ${listOf(contributes.taskEvents.map((event) => event.replace(/_/g, ' ')))}`,
  )
  add(contributes.auditKinds.length > 0, () => `Audit records of its own: ${listOf(contributes.auditKinds)}`)
  return adds
}

const READS = new Set(['tasks.read', 'files.read', 'connection'])

/** The warnings that apply to this mod; every view's scripts can reach the network. */
export function consentWarnings(manifest: ModManifest, isolated: boolean): string[] {
  const warnings: string[] = []
  const pages = manifest.contributes.views.length + manifest.contributes.fileViewers.length
  if (pages > 0) {
    const reads = manifest.capabilities.some((capability) => READS.has(capability.name))
    warnings.push(
      `Its views run scripts, which can reach the internet through WebRTC; browsers cannot fully stop that.${
        reads ? ' A view could send what the mod reads to the internet.' : ''
      }`,
    )
  }
  if (manifest.contributes.fileViewers.length > 0) {
    warnings.push('Its file viewers read every file you open with them, and can pass what they read to its logic.')
  }
  const wildcards = manifest.capabilities
    .flatMap((capability) => ('hosts' in capability ? capability.hosts : []))
    .filter((host) => host.startsWith('*.'))
  if (wildcards.length > 0) {
    warnings.push(`It reaches ${listOf([...new Set(wildcards)].map(hostWords))}.`)
  }
  const unicode = manifest.capabilities
    .flatMap((capability) => ('hosts' in capability ? capability.hosts : []))
    .find((host) => host.split('.').some((label) => label.startsWith('xn--')))
  if (unicode !== undefined) {
    warnings.push(`${unicode} uses non-Latin letters; check it is the site you expect.`)
  }
  if (!isolated && manifest.main !== undefined) {
    warnings.push('Runs without network isolation on this machine: bwrap is not installed.')
  }
  return warnings
}

/** An update's difference in Seti's words: what it now also does, and what it no longer does. */
export function diffChanges(diff: ModCapabilityDiff): string[] {
  return [
    ...diff.added.map((entry) => `Now also: ${entry.text}`),
    ...diff.widened.map((entry) => `Now also: ${entry.text}`),
    ...diff.removed.map((entry) => `No longer: ${entry.text}`),
  ]
}
