import type { ModDetail, ModManifest } from '@seti/shared'
import { useMemo } from 'react'
import { apiPatch } from '@/api'
import { refreshMods } from '@/hooks/useMods'
import { usePolled } from '@/hooks/usePolled'
import { createPolledResource, type PolledResource } from '@/lib/polled'

const POLL_MS = 60_000

const resources = new Map<string, PolledResource<ModDetail>>()

function resourceOf(id: string): PolledResource<ModDetail> {
  let resource = resources.get(id)
  if (resource === undefined) {
    resource = createPolledResource<ModDetail>(`/mods/${id}`, POLL_MS)
    resources.set(id, resource)
  }
  return resource
}

/** Reads a mod's settings again now, and the mod list whose switches follow them. */
export function refreshModSettings(id: string): void {
  resources.get(id)?.refresh()
  refreshMods()
}

/** A mod's settings as saved, with its manifest's defaults for unset ones; null until they load. */
export function useModSettings(manifest: ModManifest): Record<string, unknown> | null {
  const { data } = usePolled(resourceOf(manifest.id))
  return useMemo(() => {
    if (data === undefined) {
      return null
    }
    const values: Record<string, unknown> = Object.fromEntries(
      Object.entries(manifest.contributes.settings).map(([key, field]) => [key, field.default]),
    )
    for (const { key, value } of data.settings) {
      values[key] = value
    }
    return values
  }, [data, manifest])
}

export async function saveModSettings(id: string, settings: Record<string, unknown>): Promise<void> {
  await apiPatch<ModDetail>(`/mods/${id}`, { settings })
  refreshModSettings(id)
}
