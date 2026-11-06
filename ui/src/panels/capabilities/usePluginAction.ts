import { useState } from 'react'
import { toast } from 'sonner'
import { errorText } from '@/api'

/** Agents read Claude Code plugins when a session starts, so changes reach running ones later. */
export const NEXT_SESSION_NOTE = 'Running agents pick this up in their next session.'

/** Runs one plugin or marketplace change with a busy flag, a success toast and a failure toast. */
export function usePluginAction(onDone: () => void) {
  const [busy, setBusy] = useState(false)

  const run = async (action: () => Promise<unknown>, done: string, description?: string) => {
    setBusy(true)
    try {
      await action()
      toast.success(done, description === undefined ? undefined : { description })
      onDone()
      return true
    } catch (e) {
      toast.error(errorText(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  return { busy, run }
}
