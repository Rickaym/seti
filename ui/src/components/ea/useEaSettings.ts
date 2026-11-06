import type { EaSettings, EaSettingsInput } from '@seti/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet, apiPut, errorText } from '@/api'
import { createPolledResource } from '@/lib/polled'

const SETTINGS_PATH = '/ea/settings'

/** The settings every tab follows, so joining on open sees a change made in another browser. */
export const eaSettingsResource = createPolledResource<EaSettings>(SETTINGS_PATH, 30_000)

/** The EA settings stored in Seti; `save` reports a refusal instead of throwing. */
export function useEaSettings(onSaved: () => void) {
  const [settings, setSettings] = useState<EaSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    apiGet<EaSettings>(SETTINGS_PATH).then(
      (loaded) => {
        if (live) {
          setSettings(loaded)
        }
      },
      (e: unknown) => {
        if (live) {
          setError(errorText(e))
        }
      },
    )
    return () => {
      live = false
    }
  }, [])

  const saving = useRef<Promise<void>>(Promise.resolve())

  /** Saves one at a time, so replies land in the order the changes were made. */
  const save = useCallback(
    async (input: EaSettingsInput) => {
      const run = saving.current.then(async () => {
        try {
          setSettings(await apiPut<EaSettings>(SETTINGS_PATH, input))
          setError(null)
          eaSettingsResource.refresh()
          onSaved()
        } catch (e) {
          setError(errorText(e))
        }
      })
      saving.current = run
      return run
    },
    [onSaved],
  )

  return { settings, error, save }
}

export type EaSettingsState = ReturnType<typeof useEaSettings>
