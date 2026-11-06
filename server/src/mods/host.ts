import type { ModDefinition } from '@seti/mod-api'
import {
  claimFileViewers,
  disposeAll,
  grantScopes,
  manifestProblem,
  modAuditKind,
  modManifest,
  modScoped,
  type Disposer,
  type ModCapability,
  type ModCapabilityName,
  type ModManifest,
  type ModTier,
} from '@seti/shared'
import { serverApi } from './api.js'
import { registerModContext } from './ops/context.js'
import { modAuditKinds, modCommands, notifyKinds, slashCommands } from './points.js'
import { runningMods } from './running.js'
import { startThirdParty } from './third-party-run.js'
import { pollerTemplates, webhookSources } from '../channels/sources.js'
import { modHostSettings, modStates } from '../store/mods.js'

/** A mod as the host holds it: its manifest once valid, the user's choice and what it registered. */
export interface HostedMod {
  definition: ModDefinition
  tier: ModTier
  /** Null when the manifest is not valid; `problem` then says why. */
  manifest: ModManifest | null
  problem: string | null
  enabled: boolean
  /** What undoes its registrations while it runs; null while it is off. */
  disposers: Disposer[] | null
  /** A third-party mod's installed version; null for the mods Seti ships. */
  installed: InstalledVersion | null
}

/** The version of a third-party mod that runs: its pinned hash and what the user granted. */
interface InstalledVersion {
  hash: string
  grants: readonly ModCapability[]
  /** A dev mod, read unpinned from a folder while Developer mode is on. */
  dev: boolean
}

/** A third-party mod as Seti stored it, ready to host. */
export interface InstalledMod {
  manifest: unknown
  installed: InstalledVersion
}

export interface HostOptions {
  safeModeForced?: boolean
  /** Why the installed files no longer match their pinned hash, checked before every start. */
  pinProblem?: (id: string, hash: string) => Promise<string | null>
  /** The third-party mods to host at start. */
  installed?: () => Promise<readonly InstalledMod[]>
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** A bundled mod marked required: part of Seti, so it is always on. */
export const isRequired = (mod: HostedMod): boolean => mod.tier === 'bundled' && mod.manifest?.required === true

/** Why a required mod stays on, as every refusal to turn it off or remove it says. */
export const requiredReason = (mod: HostedMod): string =>
  `The ${mod.manifest?.name ?? 'required'} mod is part of Seti and always on`

function hosted(definition: ModDefinition, tier: ModTier, bundledIds: ReadonlySet<string>): HostedMod {
  const parsed = modManifest.safeParse(definition.manifest)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue === undefined ? '' : `${issue.path.join('.')}: `
    return {
      definition,
      tier,
      manifest: null,
      problem: `Its manifest is not valid: ${where}${issue?.message ?? ''}`,
      enabled: false,
      disposers: null,
      installed: null,
    }
  }
  return {
    definition,
    tier,
    manifest: parsed.data,
    problem: manifestProblem(parsed.data, tier, bundledIds),
    enabled: tier === 'bundled' && parsed.data.required,
    disposers: null,
    installed: null,
  }
}

/** What a mod holds: a bundled mod what it declares, a third-party mod what the user granted. */
function capabilitiesOf(mod: HostedMod): readonly ModCapability[] {
  if (mod.tier === 'third-party') {
    return mod.installed?.grants ?? []
  }
  return mod.tier === 'bundled' ? (mod.manifest?.capabilities ?? []) : []
}

const grantsOf = (mod: HostedMod): ModCapabilityName[] => capabilitiesOf(mod).map((capability) => capability.name)

/** Registers what the manifest declares as data, before any of the mod's code runs. */
function registerDeclared(manifest: ModManifest, track: (dispose: Disposer) => Disposer): void {
  const { id, contributes } = manifest
  for (const slash of contributes.slashCommands) {
    const command = { name: slash.name, description: slash.description, argument_hint: slash.argumentHint }
    track(
      slashCommands.register({
        command: { ...command, aliases: [], builtin: true, unsupported: null },
        mod: id,
        refusal: `/${slash.name} is a command of the ${manifest.name} mod and never goes to the agent`,
      }),
    )
  }
  for (const kind of contributes.notifications) {
    track(notifyKinds.register({ kind: modScoped(id, kind.id), title: kind.title, mod: id, default: kind.default }))
  }
  for (const kind of contributes.auditKinds) {
    track(modAuditKinds.register({ kind: modAuditKind(id, kind), mod: id }))
  }
  claimFileViewers(manifest, track)
}

/** A channel source the manifest declares whose code the server half did not register. */
function unregisteredSource(manifest: ModManifest): string | undefined {
  const registry = (kind: 'webhook' | 'poller') => (kind === 'webhook' ? webhookSources : pollerTemplates)
  return manifest.contributes.channelSources.find(
    (entry) => !registry(entry.kind).has(modScoped(manifest.id, entry.id)),
  )?.id
}

/** Places the UI half may answer alone; the EA, agents and views reach only the server half. */
const UI_PLACES: ReadonlySet<string> = new Set(['palette', 'agentHeader', 'agentMenu'])

/** A command for agents or the EA whose handler the server half did not register. */
const unanswered = (manifest: ModManifest): string | undefined =>
  manifest.contributes.commands.find(
    (entry) => entry.for.some((where) => !UI_PLACES.has(where)) && !modCommands.has(modScoped(manifest.id, entry.id)),
  )?.id

/**
 * Loads the mods Seti ships, validates their manifests, and turns each one on or off at runtime:
 * everything a mod registers comes back as a disposer, so turning it off leaves nothing behind.
 */
export class ModHost {
  private readonly mods = new Map<string, HostedMod>()
  private safeMode = false
  readonly safeModeForced: boolean
  /** The ids of the mods Seti ships, which no third-party mod may take. */
  readonly bundledIds: ReadonlySet<string>
  private readonly options: HostOptions

  constructor(definitions: readonly { definition: ModDefinition; tier: ModTier }[], options: HostOptions = {}) {
    this.safeModeForced = options.safeModeForced ?? false
    this.options = options
    this.bundledIds = new Set(
      definitions.flatMap(({ definition, tier }) => {
        const parsed = modManifest.safeParse(definition.manifest)
        return parsed.success && tier !== 'third-party' ? [parsed.data.id] : []
      }),
    )
    for (const { definition, tier } of definitions) {
      const mod = hosted(definition, tier, this.bundledIds)
      const id = mod.manifest?.id ?? `invalid-${String(this.mods.size + 1)}`
      if (this.mods.has(id)) {
        throw new Error(`Two mods have the id ${id}`)
      }
      this.mods.set(id, mod)
    }
  }

  /** Reads what the user chose and starts each enabled mod; one that fails stays off with why. */
  async start(): Promise<void> {
    const [states, safeMode] = await Promise.all([modStates.all(), modHostSettings.safeMode()])
    this.safeMode = safeMode
    for (const [id, mod] of this.mods) {
      mod.enabled = isRequired(mod) || (states.get(id) ?? mod.manifest?.defaultEnabled ?? false)
      await this.syncLogged(id)
    }
    for (const entry of (await this.options.installed?.()) ?? []) {
      await this.adopt(entry, states)
    }
  }

  /**
   * Hosts an installed third-party mod, replacing an earlier version of it, and starts it when the
   * user has it on. It can never take the id of a mod Seti ships.
   */
  async adopt(entry: InstalledMod, states?: ReadonlyMap<string, boolean>): Promise<HostedMod> {
    const mod = hosted({ manifest: entry.manifest }, 'third-party', this.bundledIds)
    const id = mod.manifest?.id ?? ''
    const existing = this.mods.get(id)
    if (mod.manifest === null || (existing !== undefined && existing.tier !== 'third-party')) {
      throw new Error(mod.problem ?? `The id ${id} is taken by Seti; pick another`)
    }
    this.deactivate(id)
    mod.installed = entry.installed
    mod.enabled = (states ?? (await modStates.all())).get(id) ?? false
    this.mods.set(id, mod)
    await this.syncLogged(id)
    return mod
  }

  /** Stops a third-party mod and forgets it, as an uninstall or turning off Developer mode does. */
  drop(id: string): void {
    if (this.mods.get(id)?.tier !== 'third-party') {
      return
    }
    this.deactivate(id)
    this.mods.delete(id)
  }

  list(): readonly HostedMod[] {
    return [...this.mods.values()]
  }

  get(id: string): HostedMod | undefined {
    return this.mods.get(id)
  }

  /** Safe mode holds every third-party mod off, from the setting or SETI_SAFE_MODE=1. */
  safeModeOn(): boolean {
    return this.safeModeForced || this.safeMode
  }

  /** The setting alone, which SETI_SAFE_MODE=1 overrides. */
  safeModeSetting(): boolean {
    return this.safeMode
  }

  heldBySafeMode(mod: HostedMod): boolean {
    return mod.tier === 'third-party' && this.safeModeOn()
  }

  /** Saves the choice and starts or stops the mod now; a mod that cannot start is not saved on. */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const mod = this.mods.get(id)
    if (mod === undefined || mod.manifest === null || mod.problem !== null) {
      throw new Error(mod?.problem ?? 'The mod cannot run')
    }
    if (!enabled && isRequired(mod)) {
      throw new Error(requiredReason(mod))
    }
    const was = mod.enabled
    mod.enabled = enabled
    try {
      await this.sync(id)
    } catch (e) {
      mod.enabled = was
      throw e
    }
    await modStates.set(id, enabled)
  }

  async setSafeMode(on: boolean): Promise<void> {
    await modHostSettings.setSafeMode(on)
    this.safeMode = on
    for (const id of this.mods.keys()) {
      await this.syncLogged(id)
    }
  }

  /** Stops every running mod, as a test or a shutdown needs. */
  stopAll(): void {
    for (const id of this.mods.keys()) {
      this.deactivate(id)
    }
  }

  private shouldRun(mod: HostedMod): boolean {
    return mod.enabled && mod.problem === null && mod.manifest !== null && !this.heldBySafeMode(mod)
  }

  /** Starts or stops the mod to match its choice, safe mode and problem. */
  private async sync(id: string): Promise<void> {
    const mod = this.mods.get(id)
    if (mod !== undefined && this.shouldRun(mod)) {
      await this.activate(id)
    } else {
      this.deactivate(id)
    }
  }

  private async syncLogged(id: string): Promise<void> {
    await this.sync(id).catch((e: unknown) => {
      process.stderr.write(`mods: ${id} did not start: ${errorText(e)}\n`)
    })
  }

  private async activate(id: string): Promise<void> {
    const mod = this.mods.get(id)
    const manifest = mod?.disposers === null ? mod.manifest : null
    if (mod === undefined || manifest === null) {
      return
    }
    const disposers: Disposer[] = []
    const track = (dispose: Disposer) => {
      disposers.push(dispose)
      return dispose
    }
    try {
      const pinned = await this.pinnedProblem(mod)
      if (pinned !== null) {
        mod.problem = pinned
        throw new Error(pinned)
      }
      registerDeclared(manifest, track)
      registerModContext(manifest, grantScopes(capabilitiesOf(mod)), track)
      if (mod.installed !== null) {
        await startThirdParty(manifest, mod.installed, track)
      }
      await mod.definition.server?.(serverApi({ manifest, grants: grantsOf(mod), track }))
      const thirdParty = mod.tier === 'third-party'
      const unregistered = thirdParty ? undefined : unregisteredSource(manifest)
      if (unregistered !== undefined) {
        throw new Error(`It declares the channel source ${unregistered}, which its server half does not register`)
      }
      const command = thirdParty ? undefined : unanswered(manifest)
      if (command !== undefined) {
        throw new Error(`It declares the command ${command}, which its server half does not answer`)
      }
      mod.disposers = disposers
      runningMods.add(id)
    } catch (e) {
      disposeAll(disposers)
      throw e
    }
  }

  /** A third-party mod starts only while its stored files still match the hash the user approved. */
  private async pinnedProblem(mod: HostedMod): Promise<string | null> {
    if (mod.installed === null || mod.installed.dev || this.options.pinProblem === undefined) {
      return null
    }
    return this.options.pinProblem(mod.manifest?.id ?? '', mod.installed.hash)
  }

  private deactivate(id: string): void {
    const mod = this.mods.get(id)
    if (mod === undefined || mod.disposers === null) {
      return
    }
    for (const e of disposeAll(mod.disposers)) {
      process.stderr.write(`mods: turning ${id} off: ${e.message}\n`)
    }
    mod.disposers = null
    runningMods.delete(id)
  }
}
