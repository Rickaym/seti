import type { ModTranscriptApi } from '@seti/mod-api'
import type { Disposer, ModManifest } from '@seti/shared'
import { tasks } from '../db.js'
import { publish } from '../task-events.js'

/**
 * Tells the mod's UI half, over an agent's transcript stream, that its blocks there changed. The
 * event carries only the mod's id; the UI half fetches what changed from the mod's own routes.
 * Once the mod is turned off it tells nothing, since its routes are gone.
 */
export function transcriptApi(manifest: ModManifest, track: (dispose: Disposer) => Disposer): ModTranscriptApi {
  let running = true
  track(() => {
    running = false
  })
  return {
    refresh: async (task) => {
      if (manifest.contributes.transcriptBlocks.length === 0) {
        throw new Error(`${manifest.id} refreshes transcript blocks, which its manifest does not declare`)
      }
      if (running && (await tasks.get(task)) !== undefined) {
        publish(task, { type: 'blocks', mod: manifest.id })
      }
    },
  }
}
