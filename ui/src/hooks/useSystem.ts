import type { SystemInfo } from '@seti/shared'
import { usePolled } from '@/hooks/usePolled'
import { createPolledResource } from '@/lib/polled'

const systemResource = createPolledResource<SystemInfo>('/system', 5000)

/** Server info plus connection health: `error` is set while `/api/system` is not answering. */
export function useSystem() {
  return usePolled(systemResource)
}

/** Polls the server now, as after changing a setting it reports. */
export function refreshSystem(): void {
  systemResource.refresh()
}
