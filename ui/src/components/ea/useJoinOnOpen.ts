import { useEffect } from 'react'
import { usePolled } from '@/hooks/usePolled'
import { useEaAutoJoin } from './call-context'
import { eaSettingsResource } from './useEaSettings'

/** Joins the call on open while the wake word and Join on open are on and the EA can take calls. */
export function useJoinOnOpen(ready: boolean): void {
  const autoJoin = useEaAutoJoin()
  const settings = usePolled(eaSettingsResource).data
  const wanted = ready && settings?.wake_enabled === true && settings.join_on_open
  useEffect(() => {
    autoJoin.setWanted(wanted)
  }, [autoJoin, wanted])
}
