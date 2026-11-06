import { listedStatus, failed, type TaskListEntry } from '@seti/shared'

const DISMISSED_KEY = 'seti.failures.dismissed'
const SINCE_KEY = 'seti.failures.since'
/** Dismissals kept, newest last; failures this old have long left the list. */
const KEPT_DISMISSALS = 200

/** More pending failures than this collapse into one toast. */
export const COLLAPSE_ABOVE = 2

/** One failure of one agent: a task's status changes bump its updated_at, so the pair is unique. */
export const failureId = (task: Pick<TaskListEntry, 'id' | 'updated_at'>) => `${task.id}@${task.updated_at}`

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage can be blocked; dismissals then last for this visit only.
  }
}

/** When this browser first watched; older failures stay in Needs you without a toast. */
export function failuresSince(now: Date = new Date()): string {
  const stored = read(SINCE_KEY)
  if (stored !== null) {
    return stored
  }
  const since = now.toISOString()
  write(SINCE_KEY, since)
  return since
}

function loadDismissed(): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(read(DISMISSED_KEY) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

let dismissedIds: ReadonlySet<string> | null = null
const listeners = new Set<() => void>()

export const dismissedFailures = (): ReadonlySet<string> => {
  dismissedIds ??= loadDismissed()
  return dismissedIds
}

export function subscribeDismissed(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Marks failures seen for good in this browser, so no toast raises them again. */
export function dismissFailures(ids: readonly string[]): void {
  const current = dismissedFailures()
  if (ids.every((id) => current.has(id))) {
    return
  }
  const next = new Set([...current, ...ids])
  dismissedIds = next
  write(DISMISSED_KEY, JSON.stringify([...next].slice(-KEPT_DISMISSALS)))
  for (const listener of listeners) {
    listener()
  }
}

/** Agents that failed since `since`, not dismissed, muted or open now; newest first. */
export function pendingFailures(
  tasks: readonly TaskListEntry[],
  { since, dismissed, openId }: { since: string; dismissed: ReadonlySet<string>; openId: string | null },
): TaskListEntry[] {
  return tasks
    .filter(
      (task) =>
        failed(listedStatus(task)) &&
        Date.parse(task.updated_at) > Date.parse(since) &&
        task.id !== openId &&
        !task.notifications_muted &&
        !dismissed.has(failureId(task)),
    )
    .toSorted((a, b) => b.updated_at.localeCompare(a.updated_at))
}
