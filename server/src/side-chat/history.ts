import { randomUUID } from 'node:crypto'
import type { Aside, AsideAsker, Task } from '@seti/shared'
import { currentRequestSource } from '../access.js'
import { audit } from '../audit.js'
import { now } from '../db.js'
import { refuseHiddenDirect } from '../direct-privacy.js'
import { refuseOtherAgent } from '../ea-guard.js'
import { HttpError } from '../http.js'
import { asides } from '../store/asides.js'
import { requireTask } from '../tasks.js'

/**
 * Earlier exchanges of the chat a follow-up hands the fork. The fork already reads the agent's
 * whole session, so these only carry the thread of the side chat; six keep it while every
 * follow-up's prompt stays a few thousand tokens however long the chat grows.
 */
export const REPLAY_EXCHANGES = 6
/** Longest earlier answer a follow-up replays, in characters; the rest is cut. */
export const REPLAY_ANSWER_CHARS = 3000

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 3)}...` : text)

/** The prompt the fork gets: the chat's newest earlier exchanges, then the new question. */
export async function promptOf(taskId: string, chatId: string, question: string): Promise<string> {
  const earlier = await asides.chat(taskId, chatId, REPLAY_EXCHANGES)
  if (earlier.length === 0) {
    return question
  }
  const lines = earlier.flatMap((e) => [
    `Question: ${e.question}`,
    `Answer: ${clip(e.answer, REPLAY_ANSWER_CHARS)}`,
    '',
  ])
  return ['Earlier in this side chat:', '', ...lines, 'New question:', question].join('\n')
}

/** Who is asking now: the EA, an agent through its Seti tools, or else the user. */
function askerNow(): { asked_by: AsideAsker; asker_id: string | null; asker_title: string | null } {
  const source = currentRequestSource()
  if (source?.via === 'ea') {
    return { asked_by: 'ea', asker_id: null, asker_title: null }
  }
  if (source?.via === 'agent') {
    return { asked_by: 'agent', asker_id: source.taskId, asker_title: source.title }
  }
  return { asked_by: 'user', asker_id: null, asker_title: null }
}

/** An answered question, its answer already redacted, as the engine stores it. */
export interface Answered {
  taskId: string
  chatId: string
  question: string
  answer: string
  costUsd: number | null
  askedAt: string
}

/** Stores an answered question as an aside of the agent, never as a transcript row. */
export async function storeAside(answered: Answered): Promise<Aside> {
  return asides.add({
    id: randomUUID(),
    task_id: answered.taskId,
    chat_id: answered.chatId,
    question: answered.question,
    answer: answered.answer,
    ...askerNow(),
    cost_usd: answered.costUsd,
    asked_at: answered.askedAt,
    answered_at: now(),
  })
}

/** The agent whose asides are read or deleted, refused where a side question would be. */
async function readable(taskId: string): Promise<Task> {
  refuseOtherAgent(taskId)
  const task = await requireTask(taskId)
  await refuseHiddenDirect(task.id)
  return task
}

/** The agent's newest asides, oldest first. */
export async function listAsides(taskId: string): Promise<Aside[]> {
  const task = await readable(taskId)
  return asides.list(task.id)
}

/** Deletes one aside of the agent and audits that it did, without its question or answer. */
export async function deleteAside(taskId: string, id: string): Promise<void> {
  const task = await readable(taskId)
  const gone = await asides.remove(task.id, id)
  if (gone === null) {
    throw new HttpError(404, 'That aside is already gone')
  }
  await audit.record({
    actor: 'user',
    kind: 'task.aside_deleted',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Deleted an aside of agent "${task.title}"`,
    detail: { title: task.title, asked_by: gone.asked_by, asked_at: gone.asked_at },
  })
}

/** Deletes every aside of the agent and audits how many went. */
export async function clearAsides(taskId: string): Promise<number> {
  const task = await readable(taskId)
  const count = await asides.clear(task.id)
  await audit.record({
    actor: 'user',
    kind: 'task.asides_cleared',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Cleared ${String(count)} ${count === 1 ? 'aside' : 'asides'} of agent "${task.title}"`,
    detail: { title: task.title, count },
  })
  return count
}
