import type { AgentColor, TaskDisplayStatus } from '@seti/shared'
import { useSyncExternalStore } from 'react'
import { agentColorAttr } from '@/lib/agent-color-sheet'
import { agentAccents } from '@/lib/status-markers'
import { cn } from '@/lib/utils'
import { MarkerBoundary } from './ModStatusMarker'
import { GLYPH_COLOUR, statusLightTitle } from './status-label'

interface ModAgentAccentProps {
  status: TaskDisplayStatus
  subagents: number
  agent: { id: string; color: AgentColor | null }
  place: 'list' | 'needsYou'
  className?: string
}

/**
 * The accent an enabled mod draws at a row's left edge, or nothing with none. While it shows, the
 * row's CSS drops the colour bar and hides the status marker from sight, keeping it for screen
 * readers; a view that throws or draws nothing or only a blank brings both back.
 */
export function ModAgentAccent({ status, subagents, agent, place, className }: ModAgentAccentProps) {
  const [accent] = useSyncExternalStore(agentAccents.subscribe, agentAccents.list, agentAccents.list)
  if (accent === undefined) {
    return null
  }
  const View = accent.view
  return (
    <MarkerBoundary key={accent.key} fallback={null}>
      <span
        data-agent-accent=""
        aria-hidden
        title={statusLightTitle(status, subagents)}
        {...agentColorAttr(agent.color)}
        className={cn('flex shrink-0', GLYPH_COLOUR[status], className)}
      >
        <View status={status} agent={{ id: agent.id, color: agent.color }} place={place} />
      </span>
    </MarkerBoundary>
  )
}
