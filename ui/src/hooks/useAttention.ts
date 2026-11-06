import { AWAY_MS, type AttentionState } from '@seti/shared'
import { useMemo } from 'react'
import { apiPost } from '@/api'
import { usePolled } from '@/hooks/usePolled'
import { createPolledResource } from '@/lib/polled'

const attention = createPolledResource<AttentionState>('/attention', 10_000)

const NONE: readonly string[] = []
const BRIEF_BUILD_MS = 1500

/** The since-you-left brief waiting for the user, and the agents the EA reports on. */
export function useAttention() {
  const { data } = usePolled(attention)
  const eaList = data?.ea_tasks ?? NONE
  const eaKey = eaList.join(' ')
  const eaTasks = useMemo(() => new Set(eaKey === '' ? [] : eaKey.split(' ')), [eaKey])
  return { brief: data?.brief ?? null, eaTasks, awayMs: data?.away_ms ?? AWAY_MS }
}

/** Asks again soon after the page comes back, once the server has had time to build the brief. */
export function refreshAttentionSoon(): void {
  window.setTimeout(() => {
    attention.refresh()
  }, BRIEF_BUILD_MS)
}

/** Drops the brief on every device; throws when Seti refuses. */
export async function dismissBrief(id: string): Promise<void> {
  await apiPost('/attention/brief/seen', { id })
  attention.refresh()
}
