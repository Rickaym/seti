import { useEffect } from 'react'
import { apiPatch } from '@/api'
import { refreshMods, useMods } from '@/hooks/useMods'
import { syncMods } from './host'
import { moveLegacyChoices } from './legacy-choices'
import { useModChordKeys } from './mod-chords'
import { useModPaletteCommands } from './useModCommands'

let legacyMoved = false

const enableMod = async (id: string): Promise<void> => {
  await apiPatch(`/mods/${id}`, { enabled: true })
}

/** Keeps the UI halves of mods in step with the server, and offers their commands and chords. */
export function useModHost(): void {
  const { data } = useMods()
  useEffect(() => {
    if (data === undefined) {
      return
    }
    void syncMods(data)
    if (!legacyMoved) {
      legacyMoved = true
      moveLegacyChoices(data, enableMod)
        .then((changed) => {
          if (changed) {
            refreshMods()
          }
        })
        .catch(() => {
          legacyMoved = false
        })
    }
  }, [data])
  useModPaletteCommands(data)
  useModChordKeys()
}
