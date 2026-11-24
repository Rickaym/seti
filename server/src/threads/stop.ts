import type { ListedThread, ThreadStopReason } from '@seti/shared'
import { audit } from '../audit.js'
import { now } from '../db.js'
import { fromAgent, fromEa, refuseOtherAgent } from '../ea-guard.js'
import { HttpError } from '../http.js'
import { threadReplies } from '../store/thread-replies.js'
import { threadFollows } from '../store/threads.js'
import { requireTask } from '../tasks.js'

const whoStops = (): ThreadStopReason => {
  if (fromEa()) {
    return 'ea'
  }
  return fromAgent() ? 'agent' : 'user'
}

/** Stops an agent following one thread it posted in; its replies no longer reach it (THR-5). */
export async function stopFollowing(taskId: string, followId: number): Promise<ListedThread> {
  refuseOtherAgent(taskId)
  const task = await requireTask(taskId)
  const follow = (await threadFollows.forTask(task.id)).find((thread) => thread.id === followId)
  if (follow === undefined) {
    throw new HttpError(404, `${task.title} follows no thread ${String(followId)}`)
  }
  const reason = whoStops()
  const stopped = await threadReplies.stop(followId, reason, now())
  if (stopped === undefined) {
    return follow
  }
  const where = follow.channel_name === null ? `${follow.service} ${follow.channel}` : `#${follow.channel_name}`
  await audit.record({
    actor: 'user',
    kind: 'task.thread_stopped',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Stopped task "${task.title}" following a thread in ${where}`,
    detail: { title: task.title, follow_id: follow.id, service: follow.service, channel: follow.channel, reason },
  })
  return { ...stopped, channel_name: follow.channel_name }
}
