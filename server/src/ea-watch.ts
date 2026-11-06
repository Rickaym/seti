import type { EaNoticeSeverity, PrInput, Task, TaskInput } from '@seti/shared'
import { now, tasks } from './db.js'
import { clip } from './ea-inbox.js'
import { redactSecrets } from './scrub.js'
import { channelSubscriptions } from './store/channel-subscriptions.js'
import { eaInbox, eaWatches } from './store/inbox.js'
import { taskInputs } from './store/inputs.js'

/** The newest waiting updates a notice counts, and how many of them it lists. */
const WAITING_SCAN = 50
const WAITING_LISTED = 10

export interface WatchNotice {
  event: string
  title: string
  body?: string
  url?: string | null
  severity: EaNoticeSeverity
  /** Routes on the urgent tier and skips the EA's settle window. */
  urgent?: boolean
  /** What the event is about, such as `state` or `ci <url>`; a newer one replaces it undelivered. */
  subject?: string
}

/** Queues an event about the task for the EA; the task itself never sees it. */
export async function queueNotice(task: Pick<Task, 'id' | 'title'>, notice: WatchNotice): Promise<void> {
  const at = now()
  await eaInbox.add({
    kind: 'watch_event',
    event: notice.event,
    title: notice.title,
    body: clip(redactSecrets(notice.body ?? '')),
    url: notice.url ?? null,
    severity: notice.severity,
    source: task.title,
    task_id: task.id,
    urgent: notice.urgent ?? false,
    coalesce_key: notice.subject === undefined ? null : `${task.id} ${notice.subject}`,
    due_at: at,
    created_at: at,
  })
}

/** Queues an event for the EA when it watches the task. */
async function watchEvent(task: Pick<Task, 'id' | 'title'>, notice: WatchNotice): Promise<void> {
  if ((await eaWatches.get(task.id)) !== undefined) {
    await queueNotice(task, notice)
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Watch hooks run inside turn cleanup and the PR poller, which must never fail on their account. */
export async function guarded(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    process.stderr.write(`ea watch: could not record ${what}: ${errorText(e)}\n`)
  }
}

export async function watchPrLinked(taskId: string, url: string): Promise<void> {
  await guarded('a PR link', async () => {
    const task = await tasks.get(taskId)
    if (task) {
      const title = `${task.title} linked a pull request`
      await watchEvent(task, { event: 'pr_linked', title, body: url, url, severity: 'info' })
    }
  })
}

interface PrEvent {
  severity: EaNoticeSeverity
  /** CI results replace each other, as do the PR's merge, close and conflict. */
  family: 'ci' | 'pr'
  urgent: boolean
}

const PR_EVENTS: Partial<Record<PrInput['kind'], PrEvent>> = {
  ci_failed: { severity: 'critical', family: 'ci', urgent: true },
  ci_passed: { severity: 'success', family: 'ci', urgent: false },
  merged: { severity: 'success', family: 'pr', urgent: false },
  closed: { severity: 'warning', family: 'pr', urgent: false },
  conflict: { severity: 'warning', family: 'pr', urgent: false },
}

/** CI results and the end of a linked PR; reviews and comments reach the EA as waiting updates. */
export async function watchPrInputs(taskId: string, inputs: readonly PrInput[]): Promise<void> {
  await guarded('PR changes', async () => {
    const task = await tasks.get(taskId)
    if (!task) {
      return
    }
    for (const input of inputs) {
      const pr = PR_EVENTS[input.kind]
      if (pr !== undefined) {
        const body = input.kind === 'ci_failed' ? input.body : ''
        const { severity, urgent } = pr
        const subject = `${pr.family} ${input.url ?? ''}`
        await watchEvent(task, {
          event: input.kind,
          title: input.title,
          body,
          url: input.url,
          severity,
          urgent,
          subject,
        })
      }
    }
  })
}

/** Channel updates reach the EA through a watched task only from channels it subscribes to. */
async function eaVisible(inputs: readonly TaskInput[]): Promise<TaskInput[]> {
  if (!inputs.some((input) => input.source === 'channel')) {
    return [...inputs]
  }
  const followed = await channelSubscriptions.eaChannelIds()
  return inputs.filter((input) => input.source !== 'channel' || followed.has(input.channel_id))
}

function waitingList(inputs: readonly TaskInput[]): string {
  const earlier = inputs.length - WAITING_LISTED
  const lines = inputs.slice(-WAITING_LISTED).map((input) => `- ${input.title}`)
  return [...(earlier > 0 ? [`- ${String(earlier)} earlier`] : []), ...lines].join('\n')
}

/** Updates the task holds for the user rather than taking them in a turn of its own, all as one. */
export async function watchUpdatesWaiting(taskId: string): Promise<void> {
  await guarded('waiting updates', async () => {
    const task = await tasks.get(taskId)
    if (!task || (task.input_mode === 'wake' && task.status === 'running')) {
      return
    }
    const inputs = await eaVisible(await taskInputs.pending(taskId, WAITING_SCAN))
    if (inputs.length === 0) {
      return
    }
    const count = inputs.length
    const title = `${task.title} has ${String(count)} ${count === 1 ? 'update' : 'updates'} waiting`
    const body = waitingList(inputs)
    await watchEvent(task, { event: 'updates_waiting', title, body, severity: 'info', subject: 'updates' })
  })
}
