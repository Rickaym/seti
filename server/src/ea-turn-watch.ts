import type { Task, TaskEvent, TaskStatus } from '@seti/shared'
import { inBackground } from './background.js'
import { tasks } from './db.js'
import { guarded, queueNotice, type WatchNotice } from './ea-watch.js'
import { agentWaits } from './store/agent-waits.js'
import { eaWatches } from './store/inbox.js'
import { attentionOf, lastResult } from './task-attention.js'

/** Each new state of a task replaces the EA's undelivered item about its last one. */
const STATE = 'state'

/** An agent that cannot go on without the user: blocked on a request, or asking a question. */
function waitsOnUser(task: Task, words: string): WatchNotice {
  const notice = { event: 'needs_you', severity: 'warning', urgent: true, subject: STATE } as const
  if (task.blocked !== null) {
    return { ...notice, title: `${task.title} is waiting on you`, body: task.blocked }
  }
  return { ...notice, title: `${task.title} is asking you`, body: words }
}

/** How the task's turn ended, as the EA reads it; null for a status that ends no turn. */
async function turnEndNotice(task: Task, status: TaskStatus): Promise<WatchNotice | null> {
  if (status === 'error') {
    const title = `${task.title} stopped with an error`
    return {
      event: 'turn_errored',
      title,
      body: task.last_error ?? '',
      severity: 'critical',
      urgent: true,
      subject: STATE,
    }
  }
  if (status === 'stopped' || status === 'interrupted') {
    return { event: 'stopped', title: `${task.title} was stopped`, severity: 'warning', subject: STATE }
  }
  if (status !== 'idle') {
    return null
  }
  const words = await lastResult(task.id)
  if ((await attentionOf(task, status)) === 'needs_you') {
    return waitsOnUser(task, words)
  }
  return {
    event: 'turn_finished',
    title: `${task.title} finished its turn`,
    body: words,
    severity: 'success',
    subject: STATE,
  }
}

export async function watchTurnEnd(taskId: string, status: TaskStatus): Promise<void> {
  await guarded('a turn end', async () => {
    const task = await tasks.get(taskId)
    if (!task || (await eaWatches.get(taskId)) === undefined) {
      return
    }
    const notice = await turnEndNotice(task, status)
    if (notice !== null) {
      await queueNotice(task, notice)
    }
  })
}

/** Tells the EA how a turn it waited for ended, unless its watch on the task already did. */
export async function noticeAwaitedTurn(task: Task, status: TaskStatus): Promise<void> {
  const notice = await turnEndNotice(task, status)
  if (notice !== null && (await eaWatches.get(task.id)) === undefined) {
    await queueNotice(task, notice)
  }
}

async function noticeBlocked(taskId: string): Promise<void> {
  await guarded('a blocked agent', async () => {
    const task = await tasks.get(taskId)
    if (task === undefined || task.blocked === null) {
      return
    }
    if ((await eaWatches.get(taskId)) !== undefined || (await agentWaits.eaWaits(taskId))) {
      await queueNotice(task, waitsOnUser(task, ''))
    }
  })
}

/** Task event listener: a task the EA watches or awaits is blocked on the user's answer. */
export function watchBlocked(taskId: string, event: TaskEvent): void {
  if (event.type === 'blocked' && event.blocked !== null) {
    inBackground('ea watch', async () => noticeBlocked(taskId))
  }
}
