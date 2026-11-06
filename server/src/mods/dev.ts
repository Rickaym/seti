import fs from 'node:fs'
import type { ModInstallPreview } from '@seti/shared'
import { audit } from '../audit.js'
import { inBackground } from '../background.js'
import { HttpError } from '../http.js'
import { modHost } from './bundled.js'
import { requireUserConsent } from './consent-guard.js'
import { previewOf } from './consent.js'
import { hostInstalled, rememberOrigin, requireDevMode, stageVersion } from './install.js'
import { modDevMode } from '../store/mod-lifecycle.js'
import { modLogs } from '../store/mod-logic.js'
import { modInstalls, type ModInstallRow } from '../store/mod-packages.js'
import { readFrom } from './package/read.js'
import type { ValidPackage } from './package/validate.js'
import { stageUpdate } from './updates.js'

const DEBOUNCE_MS = 300
const POLL_MS = 2000

const watchers = new Map<string, () => void>()
/** The last reload error per dev mod, so a broken save is logged once, not every poll. */
const lastProblem = new Map<string, string>()

export function stopWatching(modId: string): void {
  watchers.get(modId)?.()
  watchers.delete(modId)
  lastProblem.delete(modId)
}

/** A dev mod's new files: the same grants apply at once; anything wider waits for consent. */
async function reloadDev(row: ModInstallRow, pkg: ValidPackage): Promise<string> {
  if (pkg.hash === row.current_hash || pkg.hash === row.pending_hash) {
    return `${pkg.manifest.name} (dev) has not changed`
  }
  return stageUpdate(row, pkg, 'user')
}

function reload(modId: string): void {
  inBackground('dev mod reload', async () => {
    const row = await modInstalls.get(modId)
    if (row?.source_kind !== 'dev') {
      stopWatching(modId)
      return
    }
    try {
      const { pkg } = await readFrom({ kind: 'dev', path: row.source }, modHost.bundledIds)
      lastProblem.delete(modId)
      await reloadDev(row, pkg)
    } catch (e) {
      const problem = e instanceof Error ? e.message : String(e)
      if (lastProblem.get(modId) !== problem) {
        lastProblem.set(modId, problem)
        await modLogs.system(modId, `Reload failed: ${problem}`, 'error')
      }
    }
  })
}

/** Reloads a dev mod on every change in its folder, with a slow poll for where watching fails. */
function watch(row: ModInstallRow): void {
  if (watchers.has(row.mod_id)) {
    return
  }
  let timer: NodeJS.Timeout | null = null
  const soon = () => {
    if (timer !== null) {
      clearTimeout(timer)
    }
    timer = setTimeout(() => {
      reload(row.mod_id)
    }, DEBOUNCE_MS)
  }
  let watcher: fs.FSWatcher | null = null
  try {
    watcher = fs.watch(row.source, { recursive: true }, soon)
  } catch {
    watcher = null
  }
  const poll = setInterval(() => {
    reload(row.mod_id)
  }, POLL_MS)
  poll.unref()
  watchers.set(row.mod_id, () => {
    watcher?.close()
    clearInterval(poll)
    if (timer !== null) {
      clearTimeout(timer)
    }
  })
}

/** Starts watching the dev mods while Developer mode is on, as Seti does when it starts. */
export async function watchDevMods(): Promise<void> {
  if (!(await modDevMode.get())) {
    return
  }
  for (const row of (await modInstalls.all()).filter((entry) => entry.source_kind === 'dev')) {
    watch(row)
  }
}

/** Starts watching a mod the user just installed as a dev mod. */
export async function watchIfDev(modId: string): Promise<void> {
  const row = await modInstalls.get(modId)
  if (row?.source_kind === 'dev') {
    watch(row)
  }
}

/** Developer mode: dev mods and third-party install. Off unloads every dev mod at once. */
export async function setDevMode(on: boolean): Promise<void> {
  await requireUserConsent({ stepUp: true })
  if ((await modDevMode.get()) === on) {
    return
  }
  await modDevMode.set(on)
  for (const row of (await modInstalls.all()).filter((entry) => entry.source_kind === 'dev')) {
    if (on) {
      await hostInstalled(row.mod_id)
      watch(row)
    } else {
      stopWatching(row.mod_id)
      modHost.drop(row.mod_id)
    }
  }
  await audit.record({
    actor: 'user',
    kind: 'mod.dev_mode_changed',
    subject_type: 'mod',
    summary: `Turned Developer mode ${on ? 'on' : 'off'} for mods`,
    detail: { dev_mode: on },
  })
}

/** Loads a folder as a dev mod: the first load waits for consent in Seti, later ones reload. */
export async function loadDev(path: string): Promise<{ message: string; preview: ModInstallPreview | null }> {
  await requireUserConsent({ stepUp: false })
  await requireDevMode()
  const { pkg, origin } = await readFrom({ kind: 'dev', path }, modHost.bundledIds)
  const name = pkg.manifest.name
  const row = await modInstalls.get(pkg.manifest.id)
  if (row !== undefined && row.source_kind !== 'dev') {
    throw new HttpError(409, `${name} is installed from ${row.source}; uninstall it to load it as a dev mod`)
  }
  if (row === undefined) {
    const preview = await previewOf(pkg, origin)
    await stageVersion(pkg, origin)
    rememberOrigin(pkg.manifest.id, pkg.hash, origin)
    return { message: `Approve ${name} (dev) in Seti, Settings, Mods`, preview }
  }
  return { message: await reloadDev(row, pkg), preview: null }
}
