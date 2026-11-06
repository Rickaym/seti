import { randomUUID } from 'node:crypto'
import { openSeedDb } from './db.js'
import { paths } from './env.js'

/** One server-sent event, as the task stream writes it. */
export function sse(event: string, data: unknown, id?: number): string {
  const idLine = id === undefined ? '' : `id: ${String(id)}\n`
  return `event: ${event}\n${idLine}data: ${JSON.stringify(data)}\n\n`
}

/** Matches the task's live stream, the only way its first page of messages arrives. */
export const stream = (taskId: string) => new RegExp(`/api/tasks/${taskId}/stream`)

/** Seeds an idle agent with a short exchange; `reply` is the text its last message shows. */
export async function seedLoadingTask(title: string): Promise<{ id: string; reply: string }> {
  const db = openSeedDb()
  const id = randomUUID()
  const at = new Date().toISOString()
  const reply = `Reply for ${title}: the change is ready to review.`
  const assistant = (text: string) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        id: randomUUID(),
        type: 'message',
        role: 'assistant',
        model: 'claude',
        content: [{ type: 'text', text }],
      },
      parent_tool_use_id: null,
      session_id: 'loading-session',
      uuid: randomUUID(),
    })
  await db.idleTask(id, title, paths.checkout, at)
  await db.message(id, 'prompt', JSON.stringify({ text: `Start ${title}` }), at)
  await db.message(id, 'sdk', assistant('Looking at the code first.'), at)
  await db.message(id, 'sdk', assistant(reply), at)
  await db.close()
  return { id, reply }
}
