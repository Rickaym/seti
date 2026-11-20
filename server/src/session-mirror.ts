import type { TaskSession } from '@seti/shared'
import type { SessionView } from './agent-session.js'
import type { CutTurn } from './store/restart.js'

/** Each task's session as its host last reported it, from its first message until it is gone. */
const views = new Map<string, SessionView>()

/** The first message of each task whose session could not start, kept for the next session. */
const unstarted = new Map<string, string | null>()

export const sessionMirror = {
  view: (taskId: string, view: SessionView | null): void => {
    if (view === null) {
      views.delete(taskId)
    } else {
      views.set(taskId, view)
    }
  },
  unstarted: (taskId: string, kept: { first: string | null } | null): void => {
    if (kept === null) {
      unstarted.delete(taskId)
    } else {
      unstarted.set(taskId, kept.first)
    }
  },
}

export const sessionView = (taskId: string): SessionView | undefined => views.get(taskId)

/** Ids of the tasks with a session, open or closing. */
export const sessionTaskIds = (): string[] => [...views.keys()]

/** Whether the task has a Claude Code process open, and how much background work runs in it. */
export function sessionState(taskId: string): TaskSession {
  const view = views.get(taskId)
  return { open: view?.open === true, background: view?.background ?? 0 }
}

/** Whether a turn is in progress; a session open only for background work does not count. */
export const isRunning = (taskId: string) => views.get(taskId)?.running === true

/** First message of the task's open session, which may still run subagents it started. */
export const openQuerySince = (taskId: string): number | null => views.get(taskId)?.since ?? null

/**
 * Why pending updates cannot queue for the running turn, or null when none runs or they can.
 * Updates that join the turn at its next step do not wait behind the ones queued for its end.
 */
export function autoQueueBlocker(taskId: string, joining = false): string | null {
  const view = views.get(taskId)
  if (view?.running !== true) {
    return null
  }
  if (!view.accepting) {
    return 'The running turn is starting or being cut short'
  }
  return view.autoQueued && !joining ? 'Updates already wait for the running turn to end' : null
}

/** The turns running now: what started each and how much background work runs with it. */
export const runningTurns = (): CutTurn[] =>
  [...views]
    .filter(([, view]) => view.running && view.open)
    .map(([taskId, view]) => ({ task_id: taskId, kind: view.turnKind, background: view.background }))

/** The task's last session could not start, and nothing has tried again since. */
export const startFailed = (taskId: string) => unstarted.has(taskId)

/** The text of the first kept message, empty for an automatic turn; null when none was kept. */
export const firstUnstarted = (taskId: string): string | null => unstarted.get(taskId) ?? null
