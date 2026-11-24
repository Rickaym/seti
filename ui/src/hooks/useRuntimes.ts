import type { RuntimesStatus } from '@seti/shared'
import { usePolled } from '@/hooks/usePolled'
import { createPolledResource } from '@/lib/polled'

const runtimesResource = createPolledResource<RuntimesStatus>('/runtimes', 15_000)

/** Where each runtime stands, and the runtimes a new agent may start on now. */
export function useRuntimes() {
  return usePolled(runtimesResource)
}

/** Polls the runtimes now, as after the user changes a runtime's settings. */
export function refreshRuntimes(): void {
  runtimesResource.refresh()
}
