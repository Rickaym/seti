import type { JournalEntry, TaskSession } from '@seti/shared'

type SessionChanged = Extract<JournalEntry, { type: 'session.changed' }>

/** Each agent's open session as its node last reported it; an agent without one has no entry. */
const mirror = new Map<string, SessionChanged>()

/** Who wants to hear when an agent's turn starts, by agent. */
const turnWatchers = new Map<string, Set<() => void>>()

/** Calls `listener` each time a turn of the agent starts, however short; returns the unwatch. */
export function watchTurnStarts(taskId: string, listener: () => void): () => void {
  const listeners = turnWatchers.get(taskId) ?? new Set()
  listeners.add(listener)
  turnWatchers.set(taskId, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      turnWatchers.delete(taskId)
    }
  }
}

/** Takes the state a node reported for the agent's session. */
export function mirrorSession(taskId: string, state: SessionChanged): void {
  const started = state.running && mirror.get(taskId)?.running !== true
  if (state.open || state.running || state.background > 0) {
    mirror.set(taskId, state)
  } else {
    mirror.delete(taskId)
  }
  if (started) {
    turnWatchers.get(taskId)?.forEach((listener) => {
      listener()
    })
  }
}

/** The agents whose session the node last reported open or working. */
export const mirroredAgents = (): string[] => [...mirror.keys()]

/** Whether the task has a Claude Code process open, and how much background work runs in it. */
export function sessionState(taskId: string): TaskSession {
  const state = mirror.get(taskId)
  return { open: state?.open === true, background: state?.background ?? 0 }
}

/** Whether a turn is in progress; a session open only for background work does not count. */
export const isRunning = (taskId: string): boolean => mirror.get(taskId)?.running === true

/**
 * Why pending updates cannot queue for the running turn, or null when none runs or they can.
 * Updates that join the turn at its next step do not wait behind the ones queued for its end.
 */
export function autoQueueBlocker(taskId: string, joining = false): string | null {
  const state = mirror.get(taskId)
  if (state?.running !== true) {
    return null
  }
  if (!state.accepting) {
    return 'The running turn is starting or being cut short'
  }
  return state.autoQueued && !joining ? 'Updates already wait for the running turn to end' : null
}
