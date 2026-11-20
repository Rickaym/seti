import { startFailure } from '@seti/shared'
import type { NextMessage } from './next-message.js'

/**
 * Messages of a task whose session could not start, kept until the user sends another message,
 * retries the turn or restarts the session. Automatic turns do not try again in the meantime.
 */
const unstarted = new Map<string, NextMessage[]>()

export function keepUnstarted(taskId: string, backlog: NextMessage[]): void {
  unstarted.set(taskId, backlog)
}

/** The kept messages, oldest first, which the session about to open sends; null when none. */
export function takeUnstarted(taskId: string): NextMessage[] | null {
  const kept = unstarted.get(taskId) ?? null
  unstarted.delete(taskId)
  return kept
}

/** The first kept message of each task that has some, for the records side after a restart. */
export const unstartedFirsts = (): Record<string, { first: string | null }> =>
  Object.fromEntries(
    [...unstarted].map(([taskId, [first]]) => [taskId, { first: first === undefined ? null : (first.prompt ?? '') }]),
  )

/** The error a session failed with, which says so when the session could not start. */
export function sessionError(e: unknown, started: boolean): string {
  const text = e instanceof Error ? e.message : String(e)
  return started ? text : startFailure(text)
}
