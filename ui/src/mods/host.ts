import { claimFileViewers, disposeAll, type Disposer, type ModInfo, type ModList, type ModManifest } from '@seti/shared'
import { toast } from 'sonner'
import { errorText } from '@/api'
import { ModSettingsPage } from '@/panels/settings/mods/ModSettingsPage'
import { modIconComponent } from '@/panels/settings/mods/mod-icon'
import { modSettingsKey } from '@/panels/settings/mods/mod-settings-key'
import { settingsPages } from '@/panels/settings/pages'
import { UI_MODS } from './bundled'
import { registerCommandChords } from './command-chords'
import { registerFrameViews } from './frame-views'
import { registerStatusItems, registerThemeTokens } from './live'
import { registerStyles } from './styles'
import { ModSwitches } from './switches'
import { markModsSynced, trackModSync } from './synced'
import { registerThemes } from './themes'
import { uiApi } from './ui-api'

/** What each running mod registered in this page, to undo when it turns off. */
const running = new Map<string, { disposers: Disposer[]; switches: ModSwitches }>()

const hasSettings = (manifest: ModManifest) =>
  Object.keys(manifest.contributes.settings).length > 0 || manifest.contributes.notifications.length > 0

/** Registers what the manifest declares, runs the UI half, and adds a settings page unless it did. */
async function start(manifest: ModManifest, mod: Pick<ModInfo, 'tier' | 'off_switches' | 'icon'>): Promise<void> {
  const disposers: Disposer[] = []
  const switches = new ModSwitches(mod.off_switches)
  const track = (dispose: Disposer) => {
    disposers.push(dispose)
    return dispose
  }
  try {
    claimFileViewers(manifest, track)
    registerThemes(manifest, track)
    await registerStyles(manifest, track)
    if (mod.tier === 'third-party') {
      registerFrameViews(manifest, track)
      registerStatusItems(manifest, track)
      await registerThemeTokens(manifest, track)
    } else {
      registerCommandChords(manifest, track)
    }
    const own: { page: boolean } = { page: false }
    const markOwnPage = () => {
      own.page = true
    }
    await (await UI_MODS[manifest.id]?.())?.ui?.(uiApi(manifest, { track, ownPage: markOwnPage, switches }))
    if (!own.page && hasSettings(manifest)) {
      const key = modSettingsKey(manifest.id)
      const icon = modIconComponent(mod.icon)
      track(settingsPages.register({ key, label: manifest.name, icon, group: 'Mods', view: ModSettingsPage }))
    }
    running.set(manifest.id, { disposers, switches })
  } catch (e) {
    disposeAll(disposers)
    toast.error(`The ${manifest.name} mod did not start here`, { description: errorText(e), duration: Infinity })
  }
}

function stop(id: string): void {
  disposeAll(running.get(id)?.disposers ?? [])
  running.delete(id)
}

let queue: Promise<void> = Promise.resolve()

/** Starts the UI half of each mod the server runs and stops the rest, one change at a time. */
export async function syncMods(list: ModList): Promise<void> {
  queue = queue.then(async () => {
    for (const mod of list.mods) {
      const manifest = mod.running ? mod.manifest : null
      const started = running.get(mod.id)
      if (manifest !== null && started === undefined) {
        await start(manifest, mod)
      } else if (manifest === null && started !== undefined) {
        stop(mod.id)
      } else {
        started?.switches.apply(mod.off_switches)
      }
    }
    markModsSynced()
  })
  trackModSync(queue)
  return queue
}
