import { CODEX_SETTINGS_DEFAULTS } from '@seti/shared'
import { useState } from 'react'
import { useRuntimes } from '@/hooks/useRuntimes'
import { codexHint, DEFAULT_PICK, offeredPick, type RuntimePick } from '@/lib/runtime-pick'

/**
 * The start page's pick, back to the default once its model is no longer offered, and the hint a
 * start on Codex shows under the box, or null for Claude Code.
 */
export function useStartPick() {
  const [picked, setPick] = useState<RuntimePick>(DEFAULT_PICK)
  const runtimes = useRuntimes().data
  const pick = offeredPick(picked, runtimes?.offers ?? [])
  const rulesDecide = runtimes?.codex.settings.evaluator_decides ?? CODEX_SETTINGS_DEFAULTS.evaluator_decides
  return { pick, setPick, runtimeHint: pick.runtime === 'codex' ? codexHint(rulesDecide) : null }
}
