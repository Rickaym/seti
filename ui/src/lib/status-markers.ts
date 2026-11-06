import type { ModAgentAccentProps, ModStatusMarkerProps } from '@seti/mod-api'
import { Registry } from '@seti/shared'
import type { ComponentType } from 'react'

/** A mod's drawing of agents' status markers; the first one registered draws them all. */
export interface StatusMarkerEntry {
  key: string
  name: string
  view: ComponentType<ModStatusMarkerProps>
}

export const statusMarkers = new Registry<StatusMarkerEntry>('status marker', (entry) => entry.key)

/** A mod's accent at the left edge of agent rows; the first one registered draws them all. */
export interface AgentAccentEntry {
  key: string
  name: string
  view: ComponentType<ModAgentAccentProps>
}

export const agentAccents = new Registry<AgentAccentEntry>('agent accent', (entry) => entry.key)
