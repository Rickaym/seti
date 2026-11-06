import type { ModDetail } from '@seti/shared'
import { useCallback } from 'react'
import { toast } from 'sonner'
import { apiPatch, errorText } from '@/api'
import { refreshModSettings } from '@/mods/mod-settings'

export type Save = (change: { settings?: Record<string, unknown>; notifications?: Record<string, boolean> }) => void

/** Saves a mod's settings and notification kinds, then hands back the mod as Seti now has it. */
export function useModSettingsSave(id: string, onSaved: (detail: ModDetail) => void): Save {
  return useCallback(
    (change) => {
      apiPatch<ModDetail>(`/mods/${id}`, change).then(
        (next) => {
          onSaved(next)
          refreshModSettings(id)
        },
        (e: unknown) => {
          toast.error('Seti did not save the setting', { description: errorText(e), duration: Infinity })
        },
      )
    },
    [id, onSaved],
  )
}
