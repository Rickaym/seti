import type { StorageOverview } from '@seti/shared'
import { usePolled } from '@/hooks/usePolled'
import { createPolledResource } from '@/lib/polled'

const storage = createPolledResource<StorageOverview>('/storage', 4000)

export const useStorage = () => usePolled(storage)

export const refreshStorage = () => {
  storage.refresh()
}
