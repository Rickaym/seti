import { closingQuestion, type ProseQuestion, type Task, type TaskStatus, type TurnBlock } from '@seti/shared'
import { messages } from './db.js'
import { redactSecrets } from './scrub.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const stringOf = (value: unknown) => (typeof value === 'string' ? value : undefined)

function blocksOf(payload: string): TurnBlock[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return []
  }
  const message = isRecord(parsed) ? parsed.message : undefined
  const content = isRecord(message) ? message.content : undefined
  if (!Array.isArray(content)) {
    return []
  }
  return content.filter(isRecord).flatMap((block) => {
    const type = stringOf(block.type)
    return type === undefined ? [] : [{ type, text: stringOf(block.text), name: stringOf(block.name) }]
  })
}

/** The content blocks of stored assistant messages, in order; unreadable ones are left out. */
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
