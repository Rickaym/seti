import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { openSeedDb } from './db.js'
import { paths } from './env.js'

const PLAN = '# Launch plan\n\n- Ship the chips\n'
export const CODE = 'export function greet(name: string) {\n  return `hi ${name}`\n}\n'
export const OTHER_LINK = 'https://example.com/docs/guide.md'
const FAREWELL = 'export function farewell(name: string) {\n  return `bye ${name}`\n}\n'

const assistant = (text: string) => ({
  type: 'assistant',
  message: { id: randomUUID(), type: 'message', role: 'assistant', model: 'claude', content: [{ type: 'text', text }] },
  parent_tool_use_id: null,
  session_id: 'mentions-session',
  uuid: randomUUID(),
})

/** The Files download link for a file in the agent's working directory, on a public host. */
export const downloadUrl = (id: string, file: string) =>
  `https://seti.example.com/api/tasks/${id}/files/raw?root=cwd&path=${encodeURIComponent(file)}&download=1`

/** An idle agent whose reply and the user's sent and queued messages mention and paste files. */
export async function seedMentions(title: string): Promise<{ id: string; dir: string }> {
  const id = randomUUID()
  const dir = path.join(paths.root, `mentions-${id.slice(0, 8)}`)
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'notes', 'plan.md'), PLAN)
  fs.writeFileSync(path.join(dir, 'notes', 'brief.txt'), 'Keep it short.\n')
  fs.writeFileSync(path.join(dir, 'notes', 'todo.md'), '- tidy\n')
  fs.writeFileSync(path.join(dir, 'src', 'greet.ts'), CODE)
  fs.writeFileSync(path.join(dir, 'src', 'farewell.ts'), FAREWELL)
  const prompt = `Start from notes/brief.txt and this:\n${downloadUrl(id, 'src/farewell.ts')}`
  const reply = [
    'I wrote the plan to notes/plan.md and left out/missing.pdf for later.',
    `The greeting lives here:\n\n${downloadUrl(id, 'src/greet.ts')}`,
    `Background reading: ${OTHER_LINK}`,
  ].join('\n\n')
  const db = openSeedDb()
  const started = new Date(Date.now() - 60_000).toISOString()
  await db.idleTask(id, title, dir, started)
  await db.message(id, 'prompt', JSON.stringify({ text: prompt }), started)
  await db.message(id, 'sdk', JSON.stringify(assistant(reply)), started)
  await db.message(id, 'prompt', JSON.stringify({ text: 'Then tidy notes/todo.md', queued: 'waiting' }), started)
  await db.close()
  return { id, dir }
}
