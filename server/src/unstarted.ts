import { startFailure } from '@seti/shared'
import type { NextMessage } from './agent-session.js'

/**
 * Messages of a task whose session could not start, kept until the user sends another message,
 * retries the turn or restarts the session. Automatic turns do not try again in the meantime.
 */
const unstarted = new Map<string, NextMessage[]>()

export function keepUnstarted(taskId: string, backlog: NextMessage[]): void {
  unstarted.set(taskId, backlog)
}

/** The kept messages, oldest first, which the session about to open sends before its own. */
export function takeUnstarted(taskId: string): NextMessage[] {
  const kept = unstarted.get(taskId) ?? []
  unstarted.delete(taskId)
  return kept
}

/** The task's last session could not start, and nothing has tried again since. */
export const startFailed = (taskId: string) => unstarted.has(taskId)

/** The text of the first kept message, empty for an automatic turn; null when none was kept. */
export function firstUnstarted(taskId: string): string | null {
  const first = unstarted.get(taskId)?.[0]
  return first === undefined ? null : (first.prompt ?? '')
}

/** The error a session failed with, which says so when the session could not start. */
export function sessionError(e: unknown, started: boolean): string {
  const text = e instanceof Error ? e.message : String(e)
  return started ? text : startFailure(text)
}
