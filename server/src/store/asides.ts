import { ASIDE_LIST_MAX, type Aside, type AsideAsker } from '@seti/shared'
import { sql } from '../db.js'

/** An aside as the side chat engine stores it once its answer is done and redacted. */
export interface NewAside {
  id: string
  task_id: string
  chat_id: string
  question: string
  answer: string
  asked_by: AsideAsker
  asker_id: string | null
  asker_title: string | null
  cost_usd: number | null
  asked_at: string
  answered_at: string
}

const COLUMNS = sql`id, task_id, chat_id, question, answer, asked_by, asker_id, asker_title, cost_usd, asked_at,
  answered_at`

export const asides = {
  add: async (row: NewAside): Promise<Aside> => {
    const [stored] = await sql<Aside[]>`INSERT INTO task_aside
        (id, task_id, chat_id, question, answer, asked_by, asker_id, asker_title, cost_usd, asked_at, answered_at)
      VALUES (${row.id}, ${row.task_id}, ${row.chat_id}, ${row.question}, ${row.answer}, ${row.asked_by},
        ${row.asker_id}, ${row.asker_title}, ${row.cost_usd}, ${row.asked_at}, ${row.answered_at})
      RETURNING ${COLUMNS}`
    if (stored === undefined) {
      throw new Error('The aside was not stored')
    }
    return stored
  },

  /** The agent's newest asides, at most `limit`, oldest first. */
  list: async (taskId: string, limit = ASIDE_LIST_MAX): Promise<Aside[]> => {
    const rows = await sql<Aside[]>`SELECT ${COLUMNS} FROM task_aside WHERE task_id = ${taskId}
      ORDER BY asked_at DESC, id DESC LIMIT ${limit}`
    return rows.reverse()
  },

  /** The newest `limit` exchanges of one of the agent's chats, oldest first. */
  chat: async (taskId: string, chatId: string, limit: number): Promise<Aside[]> => {
    const rows = await sql<Aside[]>`SELECT ${COLUMNS} FROM task_aside
      WHERE task_id = ${taskId} AND chat_id = ${chatId} ORDER BY asked_at DESC, id DESC LIMIT ${limit}`
    return rows.reverse()
  },

  /** Deletes one aside of the agent; the aside it deleted, or null when it had none by that id. */
  remove: async (taskId: string, id: string): Promise<Aside | null> => {
    const [gone] = await sql<Aside[]>`DELETE FROM task_aside WHERE task_id = ${taskId} AND id = ${id}
      RETURNING ${COLUMNS}`
    return gone ?? null
  },

  /** Deletes every aside of the agent and says how many there were. */
  clear: async (taskId: string): Promise<number> => {
    const gone = await sql`DELETE FROM task_aside WHERE task_id = ${taskId}`
    return gone.count
  },
}
