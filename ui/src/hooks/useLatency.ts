import { useSyncExternalStore } from 'react'
import { appLink, latencyProbe } from '@/lib/app-link'

export const useLatency = () => useSyncExternalStore(latencyProbe.subscribe, latencyProbe.getSnapshot)

export const useLink = () => useSyncExternalStore(appLink.subscribe, appLink.getSnapshot)
