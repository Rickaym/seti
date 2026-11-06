import type { PullRequest } from '@seti/shared'
import { useSyncExternalStore } from 'react'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { prChips } from '@/lib/pr-chips'

/** The chips enabled mods add beside an open PR, such as its preview. */
export function PrChips({ pr }: { pr: PullRequest }) {
  const chips = useSyncExternalStore(prChips.subscribe, prChips.list)
  return chips.map(({ key, name, view: View }) => (
    <ErrorBoundary key={key} name={name} kind="item">
      <View pr={pr} />
    </ErrorBoundary>
  ))
}
