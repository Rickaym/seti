import type { ModList } from '@seti/shared'

/** Choices a browser kept before a feature became a bundled mod: the mod's id, the old key. */
const LEGACY_ON_KEYS: Readonly<Record<string, string>> = { vim: 'seti-ui-vim' }

interface LegacyStore {
  getItem: (key: string) => string | null
  removeItem: (key: string) => void
}

/**
 * Moves each choice this browser kept to the server once: a feature it had on turns its mod on,
 * and the old key goes either way. Answers whether it turned a mod on.
 */
export async function moveLegacyChoices(
  list: ModList,
  enable: (id: string) => Promise<void>,
  store: LegacyStore = localStorage,
): Promise<boolean> {
  let changed = false
  for (const [id, key] of Object.entries(LEGACY_ON_KEYS)) {
    const mod = list.mods.find((candidate) => candidate.id === id)
    const choice = store.getItem(key)
    if (mod === undefined || choice === null) {
      continue
    }
    if (choice === 'on' && !mod.enabled) {
      await enable(id)
      changed = true
    }
    store.removeItem(key)
  }
  return changed
}
