import {
  describeCapabilities,
  modChangeInput,
  modSettingsSchema,
  modScoped,
  modSwitches,
  modTitle,
  needsRestart,
  usedPoints,
  type ModChangeInput,
  type ModDetail,
  type ModInfo,
  type ModList,
} from '@seti/shared'
import { audit } from '../audit.js'
import { fromAgent, fromEa, refuseAtSelf, refuseMod } from '../ea-guard.js'
import { describeIssues, HttpError } from '../http.js'
import { isolation } from '../script-sandbox.js'
import { bisectState } from './bisect.js'
import { modHost } from './bundled.js'
import { requireUserConsent } from './consent-guard.js'
import { isRequired, requiredReason, type HostedMod } from './host.js'
import { modDocs, modIcon } from './listing.js'
import { installInfo } from './updates.js'
import { kindStates, settingsWithDefaults } from './values.js'
import { modDevMode } from '../store/mod-lifecycle.js'
import { modNotifications, modSettings } from '../store/mods.js'

const nameOf = (mod: HostedMod) => mod.manifest?.name ?? 'a mod'

/** A mod whose manifest Seti could not read: listed with why, never run. */
const unreadable = (mod: HostedMod): ModInfo => ({
  id: '',
  name: 'Unreadable mod',
  display_name: 'Unreadable mod',
  icon: null,
  version: '',
  description: '',
  author: null,
  tier: mod.tier,
  enabled: false,
  running: false,
  security_sensitive: false,
  required: false,
  restart: false,
  capabilities: [],
  points: [],
  problem: mod.problem,
  held_by_safe_mode: false,
  notifications: [],
  settings: [],
  off_switches: [],
  manifest: null,
  install: null,
})

async function infoOf(mod: HostedMod): Promise<ModInfo> {
  const manifest = mod.manifest
  if (manifest === null) {
    return unreadable(mod)
  }
  const [kinds, icon] = await Promise.all([kindStates(manifest), modIcon(mod)])
  const fields = Object.entries(manifest.contributes.settings)
  const values = fields.length === 0 ? {} : await settingsWithDefaults(manifest)
  return {
    id: manifest.id,
    name: manifest.name,
    display_name: modTitle(manifest),
    icon,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author ?? null,
    tier: mod.tier,
    enabled: mod.enabled,
    running: mod.disposers !== null,
    security_sensitive: manifest.securitySensitive,
    required: isRequired(mod),
    restart: needsRestart(manifest),
    capabilities: describeCapabilities(manifest),
    points: usedPoints(manifest.contributes),
    problem: mod.problem,
    held_by_safe_mode: modHost.heldBySafeMode(mod),
    notifications: manifest.contributes.notifications.map((kind) => ({
      id: kind.id,
      title: kind.title,
      description: kind.description ?? null,
      enabled: kinds.get(modScoped(manifest.id, kind.id)) ?? kind.default,
    })),
    settings: fields.map(([key, field]) => ({ key, field, value: values[key] ?? null })),
    off_switches: modSwitches(manifest.contributes).filter((key) => values[key] === false),
    manifest,
    install: mod.tier === 'third-party' ? await installInfo(manifest.id, manifest.version) : null,
  }
}

function hostedMod(id: string): HostedMod {
  const mod = modHost.get(id)
  if (mod?.manifest === null || mod === undefined) {
    throw new HttpError(404, `Seti has no mod ${id}`)
  }
  return mod
}

export async function listMods(): Promise<ModList> {
  const mods = await Promise.all(modHost.list().map(infoOf))
  const thirdParty = mods.some((mod) => mod.tier === 'third-party')
  return {
    safe_mode: modHost.safeModeOn(),
    safe_mode_forced: modHost.safeModeForced,
    dev_mode: await modDevMode.get(),
    bisect: await bisectState(),
    unisolated: thirdParty && isolation().isolation !== 'bwrap',
    mods,
  }
}

export async function modDetail(id: string): Promise<ModDetail> {
  const mod = hostedMod(id)
  return { ...(await infoOf(mod)), ...(await modDocs(mod)) }
}

/**
 * The EA and agents at Full may change themes and ordinary bundled mods; a third-party or
 * security-sensitive mod stays the user's, and no mod ever changes a mod.
 */
function refuseDelegates(mod: HostedMod): void {
  refuseMod('turn mods on or off or change them')
  if (!fromEa() && !fromAgent()) {
    return
  }
  if (mod.tier === 'third-party' || mod.manifest?.securitySensitive === true) {
    throw new HttpError(403, `Only the user changes the ${nameOf(mod)} mod, in Seti`)
  }
  refuseAtSelf('turn mods on or off or change them')
}

async function toggle(mod: HostedMod, enabled: boolean): Promise<void> {
  if (mod.enabled === enabled) {
    return
  }
  await modHost.setEnabled(mod.manifest?.id ?? '', enabled).catch((e: unknown) => {
    throw new HttpError(409, `The ${nameOf(mod)} mod could not start: ${e instanceof Error ? e.message : String(e)}`)
  })
  await audit.record({
    actor: 'user',
    kind: enabled ? 'mod.enabled' : 'mod.disabled',
    subject_type: 'mod',
    subject_id: mod.manifest?.id ?? null,
    summary: `Turned the ${nameOf(mod)} mod ${enabled ? 'on' : 'off'}`,
    detail: { mod: mod.manifest?.id ?? '', version: mod.manifest?.version ?? '' },
  })
}

async function saveSettings(mod: HostedMod, change: ModChangeInput): Promise<void> {
  const manifest = mod.manifest
  if (manifest === null) {
    return
  }
  const settings = change.settings ?? {}
  const parsed = modSettingsSchema(manifest.contributes.settings).safeParse(settings)
  if (!parsed.success) {
    throw new HttpError(400, describeIssues(parsed.error))
  }
  const kinds = change.notifications ?? {}
  const unknown = Object.keys(kinds).find((kind) => !manifest.contributes.notifications.some((k) => k.id === kind))
  if (unknown !== undefined) {
    throw new HttpError(400, `${manifest.name} has no notification kind ${unknown}`)
  }
  await modSettings.put(manifest.id, parsed.data)
  await modNotifications.put(manifest.id, kinds)
  const keys = [...Object.keys(parsed.data), ...Object.keys(kinds).map((kind) => `notifications.${kind}`)]
  await audit.record({
    actor: 'user',
    kind: 'mod.settings_changed',
    subject_type: 'mod',
    subject_id: manifest.id,
    summary: `Changed the settings of the ${manifest.name} mod`,
    detail: { mod: manifest.id, keys },
  })
}

/** Turns a mod on or off and saves its settings and notification kinds, as the caller may. */
export async function changeMod(id: string, raw: ModChangeInput): Promise<ModDetail> {
  const change = modChangeInput.parse(raw)
  const mod = hostedMod(id)
  refuseDelegates(mod)
  if (change.enabled === false && isRequired(mod)) {
    throw new HttpError(409, requiredReason(mod))
  }
  if (change.enabled === true && mod.tier === 'third-party' && !mod.enabled) {
    await requireUserConsent({ stepUp: true })
  }
  if (change.settings !== undefined || change.notifications !== undefined) {
    await saveSettings(mod, change)
  }
  if (change.enabled !== undefined) {
    await toggle(mod, change.enabled)
  }
  return modDetail(id)
}

/** Safe mode is the user's alone: it decides whether third-party code may run at all. */
export async function setModSafeMode(on: boolean): Promise<ModList> {
  refuseMod('change safe mode')
  if (fromEa() || fromAgent()) {
    throw new HttpError(403, 'Only the user turns safe mode on or off, in Seti')
  }
  if (modHost.safeModeSetting() === on) {
    return listMods()
  }
  await modHost.setSafeMode(on)
  await audit.record({
    actor: 'user',
    kind: 'mod.safe_mode_changed',
    subject_type: 'mod',
    summary: `Turned mod safe mode ${on ? 'on' : 'off'}`,
    detail: { safe_mode: on, forced: modHost.safeModeForced },
  })
  return listMods()
}
