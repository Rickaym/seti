import { modScoped, type ModManifest } from '@seti/shared'
import { modNotifications, modSettings } from '../store/mods.js'

/** A mod's settings as saved, each key the user never set holding the manifest's default. */
export async function settingsWithDefaults(manifest: ModManifest, id = manifest.id): Promise<Record<string, unknown>> {
  const saved = await modSettings.get(id)
  return Object.fromEntries(
    Object.entries(manifest.contributes.settings).map(([key, field]) => [key, saved[key] ?? field.default]),
  )
}

/** Each notification kind of the mod, as `<mod>.<kind>`, and whether the user has it on. */
export async function kindStates(manifest: ModManifest): Promise<Map<string, boolean>> {
  const saved = await modNotifications.get(manifest.id)
  return new Map(
    manifest.contributes.notifications.map((kind) => [
      modScoped(manifest.id, kind.id),
      saved.get(kind.id) ?? kind.default,
    ]),
  )
}

export const kindEnabled = async (manifest: ModManifest, kind: string): Promise<boolean> =>
  (await kindStates(manifest)).get(modScoped(manifest.id, kind)) === true
