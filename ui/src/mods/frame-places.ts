import { Registry, type AgentCapabilityName } from '@seti/shared'
import { useSyncExternalStore } from 'react'
import { useAgentLacks } from './agent-needs'

/** A third-party mod's view placed in an agent tab or the side panel; Seti draws its frame. */
export interface PlacedFrame {
  /** `<mod>.<view>`. */
  key: string
  modId: string
  modName: string
  view: string
  title: string
  phone: boolean
  /** What an agent's runtime must offer for the view to show beside it. */
  needs: readonly AgentCapabilityName[]
}

/** Views that open beside one agent, with that agent as their context. */
export const agentTabs = new Registry<PlacedFrame>('agent tab', (view) => view.key)

/** Views that open in Seti's side panel from the palette, with no agent of their own. */
export const sidePanels = new Registry<PlacedFrame>('side panel', (view) => view.key)

export const usePlacedFrames = (registry: Registry<PlacedFrame>): readonly PlacedFrame[] =>
  useSyncExternalStore(registry.subscribe, registry.list)

/** The agent tabs that show beside the agent: those whose needs its runtime meets. */
export function useAgentTabs(agent: string | null): readonly PlacedFrame[] {
  const lacks = useAgentLacks()
  return usePlacedFrames(agentTabs).filter((tab) => lacks(agent, tab.needs) === null)
}

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
