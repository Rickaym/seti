import type { RuntimesStatus, StoredRuntime } from '@seti/shared'
import { useState } from 'react'
import { useRuntimes } from '@/hooks/useRuntimes'
import { DEFAULT_PICK, offeredPick, startHint, type RuntimePick } from '@/lib/runtime-pick'

/** Whether the user's rules answer the runtime's calls; true where it has no such setting. */
function rulesDecide(runtimes: RuntimesStatus | undefined, runtime: StoredRuntime): boolean {
  const status = runtimes?.[runtime]
  return status === undefined || !('settings' in status) || status.settings.evaluator_decides
}

/**
 * The start page's pick, back to the default once its model is no longer offered, and the hint a
 * start on its runtime shows under the box, or null where it shows none.
 */
export function useStartPick() {
  const [picked, setPick] = useState<RuntimePick>(DEFAULT_PICK)
  const runtimes = useRuntimes().data
  const pick = offeredPick(picked, runtimes?.offers ?? [])
  return { pick, setPick, runtimeHint: startHint(pick.runtime, rulesDecide(runtimes, pick.runtime)) }
}
