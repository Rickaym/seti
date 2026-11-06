import type { ModList } from '@seti/shared'
import { usePolled } from '@/hooks/usePolled'
import { createPolledResource } from '@/lib/polled'

const modsResource = createPolledResource<ModList>('/mods', 60_000)

export const refreshMods = (): void => {
  modsResource.refresh()
}

/** Seti's mods, whether each runs, and safe mode. */
export function useMods() {
  return usePolled(modsResource)
}
