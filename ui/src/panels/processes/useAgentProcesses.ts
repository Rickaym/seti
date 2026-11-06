import type { AgentProcesses } from '@seti/shared'
import { useState } from 'react'
import { usePolledGet } from './usePolledGet'

/** How often an open panel refreshes. */
export const OPEN_POLL_MS = 2000
const BADGE_POLL_MS = 5000
/** A framed agent without focus only keeps its badge roughly current. */
const BACKGROUND_POLL_MS = 30_000

export interface AgentProcessesState {
  open: boolean
  setOpen: (open: boolean) => void
  /** Shells and processes running now, for a badge. */
  running: number
  polled: ReturnType<typeof usePolledGet<AgentProcesses>>
}

/** Polls the agent's shells and processes while its session or panel is open, slower out of focus. */
export function useAgentProcesses(taskId: string, sessionOpen: boolean, focused: boolean): AgentProcessesState {
  const [open, setOpen] = useState(false)
  const path = `/tasks/${taskId}/processes`
  const badgeMs = focused ? BADGE_POLL_MS : BACKGROUND_POLL_MS
  const polled = usePolledGet<AgentProcesses>(open || sessionOpen ? path : null, open ? OPEN_POLL_MS : badgeMs)
  return { open, setOpen, running: polled.data?.running ?? 0, polled }
}

export const processesLabel = (running: number) => (running > 0 ? `Processes, ${String(running)} running` : 'Processes')
