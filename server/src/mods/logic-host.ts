import { audit } from '../audit.js'
import { now } from '../db.js'
import { pushToEveryDevice } from '../notifications.js'
import { modHost } from './bundled.js'
import { installedMods } from '../store/mod-installed.js'
import { modLogs } from '../store/mod-logic.js'
import { modVersions } from '../store/mod-packages.js'
import type { ModLogicTarget } from './logic/events.js'
import type { ModLogicHost } from './logic/service.js'
import { packageHash } from './package/hash.js'
import { grantedFrom } from './scopes.js'

/** Verified logic bundles by package hash; a hash names exactly one script. */
const scripts = new Map<string, string>()

async function scriptOf(modId: string, hash: string, main: string): Promise<string | null> {
  const cached = scripts.get(hash)
  if (cached !== undefined) {
    return cached
  }
  const version = await modVersions.get(modId, hash)
  const bytes = version?.files.get(main)
  if (version === undefined || bytes === undefined || packageHash(version.files) !== hash) {
    return null
  }
  const script = bytes.toString('utf8')
  scripts.set(hash, script)
  return script
}

async function tellUser(target: ModLogicTarget, kind: 'mod.paused' | 'mod.turned_off_by_seti', reason: string) {
  const what = kind === 'mod.paused' ? 'paused' : 'turned off'
  await modLogs.append(target.modId, null, now(), [
    { kind: 'system', level: 'warn', line: `Seti ${what} it: ${reason}` },
  ])
  await audit.record({
    actor: 'system',
    kind,
    subject_type: 'mod',
    subject_id: target.modId,
    summary: `${target.name} was ${what}: ${reason}`,
    detail: { mod: target.modId, hash: target.hash },
  })
  await pushToEveryDevice({
    title: `${target.name} was ${what}`,
    body: reason,
    tag: `mod-${target.modId}`,
    url: '/#settings/mods',
    kind: 'mod_update',
  })
}

/** Which third-party mods run now, from the host, and how Seti stops or pauses one. */
export const modLogicHost: ModLogicHost = {
  target: async (modId) => {
    const mod = modHost.get(modId)
    const manifest = mod?.manifest ?? null
    if (
      mod?.installed === undefined ||
      mod.installed === null ||
      mod.disposers === null ||
      manifest?.main === undefined
    ) {
      return null
    }
    const script = await scriptOf(modId, mod.installed.hash, manifest.main)
    if (script === null) {
      return null
    }
    const { grants, scopes } = grantedFrom(await installedMods.grants(modId))
    return { modId, name: manifest.name, version: manifest.version, hash: mod.installed.hash, script, grants, scopes }
  },
  turnOff: async (target, reason) => {
    await modHost.setEnabled(target.modId, false)
    await tellUser(target, 'mod.turned_off_by_seti', reason)
  },
  paused: async (target, reason) => tellUser(target, 'mod.paused', reason),
}
