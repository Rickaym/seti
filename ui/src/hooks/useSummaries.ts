import type { CapabilitiesSummary, ChannelsSummary } from '@seti/shared'
import { usePolled } from '@/hooks/usePolled'
import { createPolledResource } from '@/lib/polled'

const capabilitySummary = createPolledResource<CapabilitiesSummary | null>('/capabilities/summary', 30_000)
const channelsSummary = createPolledResource<ChannelsSummary>('/channels/summary', 30_000)

export const useCapabilitySummary = () => usePolled(capabilitySummary)
export const useChannelsSummary = () => usePolled(channelsSummary)
