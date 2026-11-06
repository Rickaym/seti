import { useSyncExternalStore } from 'react'
import type { PolledResource, PolledState } from '@/lib/polled'

export function usePolled<T>(resource: PolledResource<T>): PolledState<T> {
  return useSyncExternalStore(resource.subscribe, resource.getSnapshot)
}
