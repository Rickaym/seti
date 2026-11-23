import { closingQuestion, type ProseQuestion, type Task, type TaskStatus, type TurnBlock } from '@seti/shared'
import { messages } from './db.js'
import { payloadEvents } from './events/read.js'
import { redactSecrets } from './scrub.js'

/** The blocks a turn's closing question is read from: what the agent wrote, and its tool calls. */
function blocksOf(payload: string): TurnBlock[] {
  return payloadEvents(payload).flatMap((event): TurnBlock[] => {
    if (event.type === 'message' && event.role === 'agent') {
      return [{ type: 'text', text: event.text }]
    }
    return event.type === 'tool.started' ? [{ type: 'tool_use', name: event.call.name }] : []
  })
}

/** The text and tool calls of stored agent messages, in order; unreadable ones are left out. */
export const turnBlocks = (payloads: readonly string[]): TurnBlock[] => payloads.flatMap(blocksOf)

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
