import { useState } from 'react'
import { toast } from 'sonner'
import { errorText } from '@/api'

/** Runs a request with a busy flag and a dismissable error toast; true when it went through. */
export function useBusy() {
  const [busy, setBusy] = useState(false)
  const run = async (work: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)
    try {
      await work()
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
