import { randomUUID } from 'node:crypto'
import { openSeedDb } from './db.js'
import { paths } from './env.js'

/** Turns in a seeded long transcript: a prompt and a reply each, 2 rows per turn. */
const LONG_TURNS = 3000

/** The turns whose reply carries the needle: one in the loaded tail and two far back. */
export const NEEDLE_TURNS = [2990, 2500, 40] as const

/** The turn whose Bash call and its output mention the needle, when a seed asks for one. */
export const TOOL_TURN = 1500

/**
 * An idle agent with a long transcript; the replies of NEEDLE_TURNS mention `needle`.
 * With `tools`, TOOL_TURN also runs a Bash call whose command and output mention it.
 */
export async function seedLongTranscript(title: string, needle: string, tools = false): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const at = new Date().toISOString()
  await db.idleTask(id, title, paths.checkout, at)
  await db.run(
    `INSERT INTO task_message (task_id, kind, payload, outward, created_at)
     SELECT ?, kind, payload, '[]', ? FROM generate_series(1, ?::int) AS turn,
     LATERAL (VALUES
       (1, 'prompt', json_build_object('text', 'Turn ' || turn || ': keep going')::text),
       (2, 'sdk', json_build_object(
         'type', 'assistant', 'parent_tool_use_id', NULL, 'session_id', 'long-session', 'uuid', md5(turn::text),
         'message', json_build_object('id', 'msg_' || turn, 'type', 'message', 'role', 'assistant',
           'model', 'claude', 'content', json_build_array(json_build_object('type', 'text', 'text',
             'Reply ' || turn || CASE WHEN turn = ANY(?::int[]) THEN ' found the ' || ? || ' here' ELSE ' done' END)))
       )::text),
       (3, 'sdk', json_build_object(
         'type', 'assistant', 'parent_tool_use_id', NULL, 'session_id', 'long-session', 'uuid', md5('call' || turn),
         'message', json_build_object('id', 'msg_call_' || turn, 'type', 'message', 'role', 'assistant',
           'model', 'claude', 'content', json_build_array(json_build_object('type', 'tool_use',
             'id', 'toolu_find_' || turn, 'name', 'Bash', 'input', json_build_object('command', 'echo ' || ?))))
       )::text),
       (4, 'sdk', json_build_object(
         'type', 'user', 'parent_tool_use_id', NULL, 'session_id', 'long-session', 'uuid', md5('result' || turn),
         'message', json_build_object('role', 'user', 'content', json_build_array(json_build_object(
           'type', 'tool_result', 'tool_use_id', 'toolu_find_' || turn, 'content', ? || ' from the tool')))
       )::text)
     ) AS row(position, kind, payload)
     WHERE row.position <= 2 OR turn = ?
     ORDER BY turn, position`,
    id,
    at,
    LONG_TURNS,
    `{${NEEDLE_TURNS.join(',')}}`,
    needle,
    needle,
    needle,
    tools ? TOOL_TURN : -1,
  )
  await db.close()
  return id
}

/** Group chat notes from the user; the notes at `marked` mention `needle`. */
export async function seedTeamNotes(count: number, needle: string, marked: readonly number[]): Promise<void> {
  const db = openSeedDb()
  const base = Date.now() - 60 * 60_000
  for (let n = 0; n < count; n += 1) {
    const text = marked.includes(n) ? `Note ${String(n)} about the ${needle} plan` : `Note ${String(n)} chatter`
    await db.run(
      `INSERT INTO team_message (author_kind, author_task_id, author_handle, text, mentions, created_at)
       VALUES ('user', NULL, NULL, ?, '[]', ?)`,
      text,
      new Date(base + n * 1000).toISOString(),
    )
  }
  await db.close()
}
