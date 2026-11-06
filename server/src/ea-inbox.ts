import {
  EA_FOLLOWUP_MAX_DEPTH,
  type ChannelEvent,
  type EaFollowup,
  type eaFollowupInput,
  type EaInboxItem,
  type Task,
} from '@seti/shared'
import type { z } from 'zod'
import { audit } from './audit.js'
import { now, tasks } from './db.js'
import { HttpError } from './http.js'
import { eaInbox } from './store/inbox.js'
import { localLabel, normaliseZone, resolveWhen, WhenError } from './when.js'

const BODY_CHARS = 1200

export const clip = (text: string, max = BODY_CHARS) => (text.length <= max ? text : `${text.slice(0, max - 3)}...`)

const followupLabel = (item: EaInboxItem) =>
  item.timezone === null ? item.due_at : localLabel(new Date(item.due_at), item.timezone)

/** What the EA's model reads for an item; the chat shows the item itself. */
export function noticeText(item: EaInboxItem): string {
  const body = item.body === '' ? '' : `\n${item.body}`
  const url = item.url === null ? '' : `\nLink: ${item.url}`
  switch (item.kind) {
    case 'followup': {
      const about = item.task_id === null ? '' : ` It is about the task "${item.source}".`
      return `Inbox: a follow-up you scheduled for ${followupLabel(item)} is due: ${item.title}.${about}`
    }
    case 'reminder':
      return `Inbox: a reminder the user asked for, due ${followupLabel(item)}: ${item.title}.`
    case 'watch_event':
      return `Inbox: from the watched task "${item.source}": ${item.title}.${body}${url}`
    case 'channel_event': {
      const act = item.act ? ' (act: hand its work to an existing agent without asking)' : ''
      return `Inbox: ${item.source} alert (${item.severity})${act}: ${item.title}.${body}${url}`
    }
    case 'team_mention': {
      const message = item.message_id === null ? '' : ` (message ${String(item.message_id)})`
      return `Inbox: ${item.source} mentioned you in the group chat${message}.${body}`
    }
  }
}

type FollowupInput = z.output<typeof eaFollowupInput>

async function depthOf(parentId: number | undefined): Promise<number> {
  if (parentId === undefined) {
    return 0
  }
  const parent = await eaInbox.depth(parentId)
  if (parent === undefined) {
    throw new HttpError(404, 'The follow-up this one continues does not exist')
  }
  if (parent + 1 > EA_FOLLOWUP_MAX_DEPTH) {
    throw new HttpError(
      400,
      `Follow-ups chain at most ${String(EA_FOLLOWUP_MAX_DEPTH)} deep; tell the user instead of checking again`,
    )
  }
  return parent + 1
}

async function taskOf(taskId: string | null | undefined): Promise<Task | null> {
  if (taskId === null || taskId === undefined) {
    return null
  }
  const task = await tasks.get(taskId)
  if (!task) {
    throw new HttpError(404, 'Task not found')
  }
  return task
}

/** Schedules a follow-up or reminder for the time `when` names in the user's timezone. */
export async function scheduleFollowup(input: FollowupInput, at = new Date()): Promise<EaFollowup> {
  let zone: string
  let due: Date
  try {
    zone = normaliseZone(input.timezone ?? 'UTC')
    due = resolveWhen(input.when, zone, at)
  } catch (e) {
    if (e instanceof WhenError) {
      throw new HttpError(400, e.message)
    }
    throw e
  }
  const depth = await depthOf(input.parent_id)
  const task = await taskOf(input.task_id)
  const item = await eaInbox.add({
    kind: input.kind,
    event: 'due',
    title: input.note,
    body: '',
    url: null,
    severity: 'info',
    source: task?.title ?? 'EA',
    task_id: task?.id ?? null,
    timezone: zone,
    depth,
    due_at: due.toISOString(),
    created_at: at.toISOString(),
  })
  const local_due = localLabel(due, zone)
  const what = input.kind === 'reminder' ? 'a reminder' : 'a follow-up'
  await audit.record({
    actor: 'user',
    kind: 'ea.followup_scheduled',
    subject_type: task === null ? 'ea' : 'task',
    subject_id: task?.id ?? null,
    summary: `Scheduled ${what} for ${local_due}: ${clip(input.note, 80)}`,
    detail: { id: item.id, kind: input.kind, due_at: item.due_at, note: input.note, depth },
  })
  return { ...item, local_due }
}

export async function cancelFollowup(id: number): Promise<EaInboxItem> {
  const item = await eaInbox.cancel(id, now())
  if (item === undefined) {
    throw new HttpError(404, 'No scheduled follow-up or reminder with that id')
  }
  await audit.record({
    actor: 'user',
    kind: 'ea.followup_cancelled',
    subject_type: item.task_id === null ? 'ea' : 'task',
    subject_id: item.task_id,
    summary: `Cancelled the ${item.kind === 'reminder' ? 'reminder' : 'follow-up'}: ${clip(item.title, 80)}`,
    detail: { id: item.id, kind: item.kind, due_at: item.due_at },
  })
  return item
}

/**
 * A channel event is urgent when it is critical, or a subject going down with a warning or worse.
 * Events without a severity arrive as info and stay ordinary.
 */
const channelUrgent = (event: Pick<ChannelEvent, 'severity' | 'state'>): boolean =>
  event.severity === 'critical' || (event.state === 'down' && event.severity === 'warning')

/** A stored channel event, queued for the EA as it arrived; `act` lets it hand the work on. */
export async function routeChannelEvent(event: ChannelEvent, act = false): Promise<void> {
  const at = now()
  await eaInbox.add({
    kind: 'channel_event',
    event: event.state ?? 'event',
    title: event.title,
    body: event.detail,
    url: event.url,
    severity: event.severity,
    source: event.source,
    task_id: null,
    urgent: channelUrgent(event),
    act,
    due_at: at,
    created_at: at,
  })
}
