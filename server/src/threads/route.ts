import type { FollowedThread, ThreadInput, ThreadStopReason } from '@seti/shared'
import { audit } from '../audit.js'
import { now, tasks } from '../db.js'
import { deliverInputs } from '../inputs.js'
import { threadReplies, type PendingReply } from '../store/thread-replies.js'
import { threadSource } from './sources.js'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/** Replies wait this long, so an agent's own message is recorded before its echo is routed. */
export const REPLY_SETTLE_MS = 10_000
/** Replies one thread hands its agent in an hour; the rest are recorded, not sent. */
export const THREAD_RATE = 10
const QUIET_MS = 7 * DAY_MS
const AGE_MS = 30 * DAY_MS
const ROUTE_EVERY_MS = 5000
const EXPIRE_EVERY_MS = 10 * MINUTE_MS
const DUE_BATCH = 50

const before = (at: string, ms: number) => new Date(Date.parse(at) - ms).toISOString()

const STOP_WORDS: Record<ThreadStopReason, string> = {
  user: 'stopped by the user',
  ea: 'stopped by the EA',
  agent: 'stopped by the agent',
  quiet: 'quiet for 7 days',
  age: 'followed for 30 days',
  cap: 'over the cap',
  archived: 'the agent is archived',
}

const ids = (follow: { id: number; service: string; channel: string; thread: string }) => ({
  follow_id: follow.id,
  service: follow.service,
  channel: follow.channel,
  thread: follow.thread,
})

/** Records that Seti stopped following a thread by itself. */
async function auditStop(follow: FollowedThread, reason: ThreadStopReason): Promise<void> {
  const title = (await tasks.get(follow.task_id))?.title ?? follow.task_id
  await audit.record({
    actor: 'system',
    kind: 'task.thread_stopped',
    subject_type: 'task',
    subject_id: follow.task_id,
    summary: `Task "${title}" stopped following ${follow.service} ${follow.channel}: ${STOP_WORDS[reason]}`,
    detail: { title, ...ids(follow), reason },
  })
}

async function threadInput(reply: PendingReply): Promise<ThreadInput> {
  const source = threadSource(reply.service)
  const who = (await source?.author(reply.author, reply.author_name)) ?? reply.author_name ?? reply.author
  const where = (await source?.place(reply.channel)) ?? `${reply.service} ${reply.channel}`
  return {
    source: 'thread',
    kind: 'reply',
    subject: who,
    title: `${who} replied in ${where}`,
    body: (await source?.readable(reply.text)) ?? reply.text,
    url: reply.url,
    service: reply.service,
    channel: reply.channel,
    thread: reply.thread,
    message: reply.message,
    from: reply.author,
    bot: reply.bot,
    follow_id: reply.follow_id,
    received_at: reply.received_at,
    ...(reply.bot ? { delivery: 'with_message' as const } : {}),
  }
}

/** What becomes of one reply: own messages and stopped or busy threads are recorded, not sent. */
async function outcomeOf(reply: PendingReply, at: string): Promise<string> {
  if (await threadReplies.isAgentSend(reply.service, reply.channel, reply.message)) {
    return 'own'
  }
  if (reply.stopped) {
    return 'stopped'
  }
  if ((await threadReplies.sentSince(reply.follow_id, before(at, HOUR_MS))) >= THREAD_RATE) {
    return 'rate'
  }
  const { outcome } = await deliverInputs(reply.task_id, [await threadInput(reply)])
  if (outcome === 'skipped') {
    const stopped = await threadReplies.stop(reply.follow_id, 'archived', at)
    if (stopped !== undefined) {
      await auditStop(stopped, 'archived')
    }
  }
  return outcome
}

async function auditReply(reply: PendingReply, outcome: string): Promise<void> {
  const title = (await tasks.get(reply.task_id))?.title ?? reply.task_id
  await audit.record({
    actor: 'system',
    kind: 'task.thread_reply',
    subject_type: 'task',
    subject_id: reply.task_id,
    summary: `A reply in ${reply.service} ${reply.channel} for task "${title}": ${outcome}`,
    detail: {
      title,
      ...ids({ ...reply, id: reply.follow_id }),
      message: reply.message,
      author: reply.author,
      bytes: reply.bytes,
      outcome,
    },
  })
}

async function routeReply(reply: PendingReply, at: string): Promise<void> {
  const outcome = await outcomeOf(reply, at)
  await threadReplies.settle(reply.id, outcome, at)
  if (outcome === 'own') {
    return
  }
  if (outcome === 'delivered' || outcome === 'queued' || outcome === 'held') {
    await threadReplies.counted(reply.follow_id)
  }
  await auditReply(reply, outcome)
}

/** Routes replies that waited `REPLY_SETTLE_MS` to the agents that follow their threads (THR-4). */
export async function routeDueReplies(at = now()): Promise<number> {
  const due = await threadReplies.due(before(at, REPLY_SETTLE_MS), DUE_BATCH)
  for (const reply of due) {
    await routeReply(reply, at)
  }
  return due.length
}

/** Stops threads gone quiet or followed too long, and forgets old routed replies (THR-5). */
export async function expireThreads(at = now()): Promise<number> {
  const stopped = await threadReplies.expire(before(at, QUIET_MS), before(at, AGE_MS), at)
  for (const follow of stopped) {
    await auditStop(follow, follow.stop_reason ?? 'quiet')
  }
  await threadReplies.prune(before(at, AGE_MS))
  return stopped.length
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Runs work now and every `ms`, never two runs at once. */
function every(ms: number, work: () => Promise<unknown>, what: string): void {
  let busy = false
  const run = () => {
    if (busy) {
      return
    }
    busy = true
    work()
      .catch((e: unknown) => {
        process.stderr.write(`threads: could not ${what}: ${message(e)}\n`)
      })
      .finally(() => {
        busy = false
      })
  }
  setInterval(run, ms).unref()
  run()
}

/** Routes thread replies every few seconds and expires followed threads every few minutes. */
export function startThreadRouting(): void {
  every(ROUTE_EVERY_MS, async () => routeDueReplies(), 'route thread replies')
  every(EXPIRE_EVERY_MS, async () => expireThreads(), 'expire followed threads')
}
