import type { Resources, ResourceSummary } from '@seti/shared'
import { usePolled } from '@/hooks/usePolled'
import { createPolledResource } from '@/lib/polled'

const resources = createPolledResource<Resources>('/resources', 5000)
const summary = createPolledResource<ResourceSummary>('/resources/summary', 10_000)

export const useResources = () => usePolled(resources)

export const useResourceSummary = () => usePolled(summary)

export const refreshResources = () => {
  resources.refresh()
  summary.refresh()
}
