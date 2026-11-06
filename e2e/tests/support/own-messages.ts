import { randomUUID } from 'node:crypto'
import { openSeedDb, type SeedDb } from './db.js'
import { paths } from './env.js'

/** Replies after each ask; the first ask's run past the first page, so reaching it loads more. */
export const REPLIES = [220, 40, 40, 40] as const

export const ask = (turn: number) => `Ask ${String(turn)}: look into the flaky deploy`
export const reply = (turn: number, step: number) => `Turn ${String(turn)} step ${String(step)} checked`

/** Appends `count` top-level replies for one turn, numbered from 1. */
async function insertReplies(db: SeedDb, id: string, turn: number, count: number): Promise<void> {
  await db.run(
    `INSERT INTO task_message (task_id, kind, payload, outward, created_at)
     SELECT ?, 'sdk', json_build_object(
       'type', 'assistant', 'parent_tool_use_id', NULL, 'session_id', 'own-session',
       'uuid', md5(? || '-' || step),
       'message', json_build_object('id', 'msg_' || ? || '_' || step, 'type', 'message', 'role', 'assistant',
         'model', 'claude', 'content', json_build_array(json_build_object('type', 'text',
           'text', 'Turn ' || ? || ' step ' || step || ' checked')))
     )::text, '[]', ? FROM generate_series(1, ?::int) AS step ORDER BY step`,
    id,
    `${id}-${String(turn)}`,
    String(turn),
    String(turn),
    new Date().toISOString(),
    count,
  )
}

/** An idle agent whose turns run `replies` long after each ask, so the asks sit far apart. */
export async function seedAsks(title: string, replies: readonly number[]): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const at = new Date().toISOString()
  await db.idleTask(id, title, paths.checkout, at)
  for (const [index, count] of replies.entries()) {
    await db.message(id, 'prompt', JSON.stringify({ text: ask(index + 1) }), at)
    await insertReplies(db, id, index + 1, count)
  }
  await db.close()
  return id
}

/** An idle agent whose long turns bury each of the user's asks under many replies. */
export const seedOwnMessages = async (title: string): Promise<string> => seedAsks(title, REPLIES)
