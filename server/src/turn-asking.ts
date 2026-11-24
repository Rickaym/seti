import {
  closingQuestion,
  type ProseQuestion,
  type Task,
  type TaskStatus,
  type TurnBlock,
  payloadEvents,
  turnBlocksOf,
} from '@seti/shared'
import { messages } from './db.js'
import { redactSecrets } from './scrub.js'
import type { StoredPayload } from './stored-rows.js'

/** The text and tool calls of stored agent messages, in order; unreadable ones are left out. */
export const turnBlocks = (rows: readonly StoredPayload[]): TurnBlock[] =>
  rows.flatMap((row) => turnBlocksOf(payloadEvents(row.payload, row.runtime)))

/** What the task's last turn ended by asking the user in prose. */
const turnQuestion = async (taskId: string): Promise<ProseQuestion> =>
  closingQuestion(turnBlocks(await messages.turnEnding(taskId)))

/** Whether a turn that ended in `status` asked the user something; only a clean end can. */
export async function turnAsks(taskId: string, status: TaskStatus): Promise<boolean> {
  return status === 'idle' && (await turnQuestion(taskId)).asks
}

/** The question each asking agent ended on, kept until its task changes again. */
const asked = new Map<string, { at: string; question: string | null }>()
const ASKED_KEPT = 500

/** The question an asking agent's turn ended on, on one line with credentials redacted. */
export async function askedQuestion(task: Pick<Task, 'id' | 'asking' | 'updated_at'>): Promise<string | null> {
  if (!task.asking) {
    asked.delete(task.id)
    return null
  }
  const known = asked.get(task.id)
  if (known?.at === task.updated_at) {
    return known.question
  }
  const found = (await turnQuestion(task.id)).question
  const question = found === '' ? null : redactSecrets(found)
  asked.delete(task.id)
  asked.set(task.id, { at: task.updated_at, question })
  for (const old of asked.keys()) {
    if (asked.size <= ASKED_KEPT) {
      break
    }
    asked.delete(old)
  }
  return question
}
