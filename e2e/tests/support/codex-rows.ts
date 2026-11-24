import { randomUUID } from 'node:crypto'
import { openSeedDb } from './db.js'
import { paths } from './env.js'

const ROOT = 'e2e-codex-thread'

/** One Codex message as Seti stores it, with what Seti adds beside it. */
export interface CodexRow {
  method: string
  params: Record<string, unknown>
  /** The event the row stands for, as ingest records it. */
  event: string
  unfinished?: string[]
}

const at = (n: number) => new Date(Date.now() - 60_000 + n * 1000).toISOString()

/** A command Codex started in the agent's thread. */
export const commandStarted = (id: string, command: string): CodexRow => ({
  method: 'item/started',
  event: 'tool.started',
  params: {
    threadId: ROOT,
    turnId: 'turn-1',
    item: { type: 'commandExecution', id, command, cwd: paths.checkout, status: 'inProgress', aggregatedOutput: null },
  },
})

/** The agent's turn starting, and ending with the calls it left open. */
export const turnStarted: CodexRow = {
  method: 'turn/started',
  event: 'turn.started',
  params: { threadId: ROOT, turn: { id: 'turn-1', items: [], status: 'inProgress' } },
}

export const turnEnded = (status: 'completed' | 'interrupted', unfinished: string[] = []): CodexRow => ({
  method: 'turn/completed',
  event: 'turn.ended',
  params: { threadId: ROOT, turn: { id: 'turn-1', items: [], status, durationMs: 1000 } },
  ...(unfinished.length === 0 ? {} : { unfinished }),
})

/** Seeds an idle Codex agent whose transcript is a prompt, then these Codex messages in order. */
export async function seedCodexTranscript(title: string, prompt: string, rows: readonly CodexRow[]): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  try {
    await db.idleTask(id, title, paths.checkout, at(0))
    await db.run(`UPDATE task SET runtime = 'codex', requested_model = 'gpt-5.5' WHERE id = ?`, id)
    await db.message(id, 'prompt', JSON.stringify({ text: prompt }), at(1))
    for (const [n, row] of rows.entries()) {
      const payload = {
        root: ROOT,
        message: { method: row.method, params: row.params },
        ...(row.unfinished === undefined ? {} : { unfinished: row.unfinished }),
      }
      await db.run(
        `INSERT INTO task_message (task_id, kind, payload, outward, created_at, runtime, thread, event)
          VALUES (?, 'sdk', ?, '[]', ?, 'codex', '', ?)`,
        id,
        JSON.stringify(payload),
        at(n + 2),
        row.event,
      )
    }
  } finally {
    await db.close()
  }
  return id
}
