import {
  listedStatus,
  needsYou,
  tierToasts,
  type AgentNotifyKind,
  type NotificationSettings,
  type TaskListEntry,
} from '@seti/shared'

export interface TurnEvent {
  task: TaskListEntry
  kind: AgentNotifyKind
}

/** A task list as this page last saw it: each agent's last status change, and when it looked. */
export interface Seen {
  changed: ReadonlyMap<string, string>
  at: number
}

/** An agent new to the list counts when it was created after the last look, give or take clocks. */
const CLOCK_SLACK_MS = 60_000

function changedSince(task: TaskListEntry, previous: Seen, since: number): boolean {
  const updated = Date.parse(task.updated_at)
  if (updated <= since) {
    return false
  }
  const before = previous.changed.get(task.id)
  return before === undefined
    ? Date.parse(task.created_at) > previous.at - CLOCK_SLACK_MS
    : updated > Date.parse(before)
}

function kindOf(task: TaskListEntry): AgentNotifyKind | null {
  const shown = listedStatus(task)
  if (needsYou(task.status) || needsYou(shown)) {
    return 'needs_you'
  }
  return task.status === 'idle' && shown !== 'running' ? 'finished' : null
}

/**
 * Agents whose status changed since the previous list into a finished turn or a needs-you state.
 * Only status changes move updated_at, so a turn that started and ended between two polls counts,
 * as does an agent started and finished between them. The first list only sets the baseline.
 */
export function turnEvents(
  previous: Seen | null,
  tasks: readonly TaskListEntry[],
  since: string,
  now: number = Date.now(),
): { events: TurnEvent[]; seen: Seen } {
  const seen: Seen = { changed: new Map(tasks.map((task) => [task.id, task.updated_at])), at: now }
  if (previous === null) {
    return { events: [], seen }
  }
  const after = Date.parse(since)
  const events = tasks.flatMap((task) => {
    const kind = changedSince(task, previous, after) ? kindOf(task) : null
    return kind === null ? [] : [{ task, kind }]
  })
  return { events, seen }
}

/**
 * The events to raise on this page: not muted, not on screen, and not about an agent the EA
 * reports on, whose inbox item is its one surface. Needs-you always shows; a finished turn shows
 * while the active tier toasts.
 */
export function wantedEvents(
  events: readonly TurnEvent[],
  settings: NotificationSettings,
  shown: ReadonlySet<string>,
  eaTasks: ReadonlySet<string> = new Set(),
): TurnEvent[] {
  return events.filter(
    (event) =>
      !event.task.notifications_muted &&
      !shown.has(event.task.id) &&
      !eaTasks.has(event.task.id) &&
      (event.kind === 'needs_you' || tierToasts(settings, 'active')),
  )
}
