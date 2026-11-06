import { grantScopes, type Disposer, type ModCapability, type ModManifest } from '@seti/shared'
import { modVersions } from '../store/mod-packages.js'
import { modFramePages } from './frames/source.js'
import { scheduleModEvents } from './logic/service.js'
import { modStatusItems } from './ops/basics.js'
import { listenToTaskEvents } from './task-events.js'
import { serveThemes } from './theme-tokens.js'
import { registerLogicPoints } from './third-party-points.js'

/** Serves the pages of the pinned version to the mod's sandboxed frames while it runs. */
async function servePages(manifest: ModManifest, hash: string, track: (dispose: Disposer) => Disposer) {
  const version = await modVersions.get(manifest.id, hash)
  if (version === undefined) {
    return
  }
  const { files, script_hashes: hashes } = version
  track(
    modFramePages.register({
      modId: manifest.id,
      hash,
      page: (entry) => {
        const bytes = files.get(entry)
        return bytes === undefined ? null : { html: bytes.toString('utf8'), scriptHashes: hashes[entry] ?? [] }
      },
    }),
  )
}

/**
 * Starts what a third-party mod runs beyond its declarations: pages, commands, webhook sources,
 * schedules, task events and status items, each answered by its logic in the sandbox.
 */
export async function startThirdParty(
  manifest: ModManifest,
  installed: { hash: string; grants: readonly ModCapability[] },
  track: (dispose: Disposer) => Disposer,
): Promise<void> {
  await servePages(manifest, installed.hash, track)
  await serveThemes(manifest, installed.hash, track)
  registerLogicPoints(manifest, track)
  listenToTaskEvents(manifest, grantScopes(installed.grants)['tasks.read']?.agents, track)
  if (manifest.main !== undefined && manifest.contributes.schedules.length > 0) {
    track(scheduleModEvents(manifest.id, manifest.contributes.schedules))
  }
  track(() => {
    for (const [key, item] of modStatusItems) {
      if (item.mod === manifest.id) {
        modStatusItems.delete(key)
      }
    }
  })
}
