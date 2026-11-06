import { Registry } from '@seti/shared'
import { useSyncExternalStore } from 'react'

/** A third-party mod's view placed in an agent tab or the side panel; Seti draws its frame. */
export interface PlacedFrame {
  /** `<mod>.<view>`. */
  key: string
  modId: string
  modName: string
  view: string
  title: string
  phone: boolean
}

/** Views that open beside one agent, with that agent as their context. */
export const agentTabs = new Registry<PlacedFrame>('agent tab', (view) => view.key)

/** Views that open in Seti's side panel from the palette, with no agent of their own. */
export const sidePanels = new Registry<PlacedFrame>('side panel', (view) => view.key)

export const usePlacedFrames = (registry: Registry<PlacedFrame>): readonly PlacedFrame[] =>
  useSyncExternalStore(registry.subscribe, registry.list)

/** The view the side sheet shows: an agent tab with its agent, or a side panel without one. */
export interface OpenFrame {
  key: string
  agentId: string | null
}

let open: OpenFrame | null = null
const listeners = new Set<() => void>()

/** Shows a placed view in the side sheet, or closes the sheet with null. */
export function showFrame(next: OpenFrame | null): void {
  open = next
  for (const listener of listeners) {
    listener()
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useOpenFrame = (): OpenFrame | null => useSyncExternalStore(subscribe, () => open)
