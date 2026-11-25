import type { FollowedThread, RuntimeEvent } from '@seti/shared'
import { audit } from '../audit.js'
import { now, tasks } from '../db.js'
import { threadFollows } from '../store/threads.js'
import { createSlackSendWatcher } from './slack-send.js'

/** How many threads one agent follows at once; a new one stops the least recently active. */
export const THREAD_CAP = 50

const watchSlackSends = createSlackSendWatcher()

/** Where a thread is, as the audit log names it, such as `slack C123 thread 1700000000.000100`. */
const threadPlace = (follow: FollowedThread) => `${follow.service} ${follow.channel} thread ${follow.thread}`

const ids = (follow: FollowedThread) => ({
  follow_id: follow.id,
  service: follow.service,
  channel: follow.channel,
  thread: follow.thread,
})

async function auditFollow(taskId: string, title: string, follow: FollowedThread): Promise<void> {
  await audit.record({
    actor: 'system',
    kind: 'task.thread_followed',
    subject_type: 'task',
    subject_id: taskId,
    summary: `Task "${title}" follows ${threadPlace(follow)} it posted in`,
    detail: { title, ...ids(follow) },
  })
}

async function auditCapStop(taskId: string, title: string, follow: FollowedThread): Promise<void> {
  await audit.record({
    actor: 'system',
    kind: 'task.thread_stopped',
    subject_type: 'task',
    subject_id: taskId,
    summary: `Task "${title}" stopped following ${threadPlace(follow)}: over ${String(THREAD_CAP)} threads`,
    detail: { title, ...ids(follow), reason: 'cap' },
  })
}

/** Follows the thread of every Slack message the agent sent in these events (THR-1). */
export async function followSentThreads(taskId: string, events: readonly RuntimeEvent[]): Promise<void> {
  const sent = watchSlackSends(taskId, events)
  if (sent.length === 0) {
    return
  }
  const title = (await tasks.get(taskId))?.title ?? taskId
  const at = now()
  for (const message of sent) {
    const { follow, started } = await threadFollows.recordSend(taskId, message, at)
    if (started) {
      await auditFollow(taskId, title, follow)
    }
  }
  for (const stopped of await threadFollows.stopOverCap(taskId, THREAD_CAP, at)) {
    await auditCapStop(taskId, title, stopped)
  }
}
