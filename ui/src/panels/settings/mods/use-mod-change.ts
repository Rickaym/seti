import { useState } from 'react'
import { toast } from 'sonner'
import { apiPatch, errorText } from '@/api'
import { refreshMods } from '@/hooks/useMods'
import { withStepUp } from '@/lib/passkeys'

/** Runs a change to mods with a passkey step-up when Seti asks for one, and refreshes the list. */
export function useModChange() {
  const [busy, setBusy] = useState(false)
  const change = async (work: () => Promise<unknown>, failure = 'Seti did not change the mod') => {
    setBusy(true)
    try {
      await withStepUp(work)
    } catch (e) {
      toast.error(failure, { description: errorText(e), duration: Infinity })
    } finally {
      setBusy(false)
      refreshMods()
    }
  }
  const toggle = async (id: string, on: boolean) => change(async () => apiPatch(`/mods/${id}`, { enabled: on }))
  return { busy, change, toggle }
}
