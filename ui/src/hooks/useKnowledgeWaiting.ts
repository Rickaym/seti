import type { KnowledgeSummary } from '@seti/shared'
import { usePolled } from '@/hooks/usePolled'
import { createPolledResource, polledCount } from '@/lib/polled'

const summary = createPolledResource<KnowledgeSummary>('/knowledge/summary', 15_000)

/** How many knowledge proposals wait for the user; they never hold an agent up. */
export function useKnowledgeWaiting(): number {
  return usePolled(summary).data?.proposed ?? 0
}

/** How many knowledge proposals wait, as the Context section's count. */
export const knowledgeWaiting = polledCount(summary, (data) => data.proposed)

/** Reads the count again now, as after the user approved or rejected a proposal. */
export function refreshKnowledgeWaiting(): void {
  summary.refresh()
}
