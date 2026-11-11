import type {
  Question,
  QuestionAnswer,
  QuestionAnswerer,
  QuestionKind,
  QuestionOption,
  QuestionSecret,
} from '@seti/shared'
import { now, sql } from '../db.js'

type QuestionRecord = Omit<Question, 'options' | 'answer' | 'secret'> & {
  options: string
  answer: string | null
  secret: string | null
}

/** A question as Seti records it when the agent asks. */
export interface NewQuestion {
  id: string
  group_id: string
  task_id: string
  subagent_id: string | null
  tool_use_id: string
  position: number
  header: string
  prompt: string
  kind: QuestionKind
  multi: boolean
  options: QuestionOption[]
  secret?: QuestionSecret
}

const TASK_LIMIT = 100

function parsed<T>(text: string | null, fallback: T): T {
  if (text === null) {
    return fallback
  }
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

const toQuestion = (row: QuestionRecord): Question => ({
  ...row,
  options: parsed<QuestionOption[]>(row.options, []),
  answer: parsed<QuestionAnswer | null>(row.answer, null),
  secret: parsed<QuestionSecret | null>(row.secret, null),
})

const list = (rows: readonly QuestionRecord[]) => rows.map(toQuestion)

const SELECT = sql`SELECT q.id, q.group_id, q.task_id, t.title AS task_title, q.subagent_id, q.tool_use_id,
    q.position, q.header, q.prompt, q.kind, q.multi, q.options, q.secret, q.status, q.answer, q.answered_by,
    q.created_at, q.settled_at
  FROM question q JOIN task t ON t.id = q.task_id`

const RETURNING = sql`RETURNING id, group_id, task_id,
    (SELECT title FROM task WHERE task.id = question.task_id) AS task_title, subagent_id, tool_use_id,
    position, header, prompt, kind, multi, options, secret, status, answer, answered_by, created_at, settled_at`

export const questions = {
  /** Records the questions of one tool call, in order. */
  open: async (rows: readonly NewQuestion[]): Promise<Question[]> => {
    const at = now()
    const stored: Question[] = []
    for (const row of rows) {
      const [record] = await sql<QuestionRecord[]>`INSERT INTO question
        (id, group_id, task_id, subagent_id, tool_use_id, position, header, prompt, kind, multi, options,
          secret, status, created_at)
        VALUES (${row.id}, ${row.group_id}, ${row.task_id}, ${row.subagent_id}, ${row.tool_use_id},
          ${row.position}, ${row.header}, ${row.prompt}, ${row.kind}, ${row.multi},
          ${JSON.stringify(row.options)}, ${row.secret === undefined ? null : JSON.stringify(row.secret)}, 'open',
          ${at})
        ${RETURNING}`
      if (record === undefined) {
        throw new Error('The question was not recorded')
      }
      stored.push(toQuestion(record))
    }
    return stored
  },
  /** Open questions, of one agent or of all, oldest first. */
  openList: async (taskId?: string): Promise<Question[]> =>
    list(
      taskId === undefined
        ? await sql<QuestionRecord[]>`${SELECT} WHERE q.status = 'open' ORDER BY q.created_at, q.group_id, q.position`
        : await sql<QuestionRecord[]>`${SELECT} WHERE q.status = 'open' AND q.task_id = ${taskId}
            ORDER BY q.created_at, q.group_id, q.position`,
    ),
  /** One agent's latest questions in every status, newest first. */
  forTask: async (taskId: string): Promise<Question[]> =>
    list(
      await sql<QuestionRecord[]>`${SELECT} WHERE q.task_id = ${taskId}
        ORDER BY q.created_at DESC, q.position LIMIT ${TASK_LIMIT}`,
    ),
  byIds: async (ids: readonly string[]): Promise<Question[]> =>
    list(await sql<QuestionRecord[]>`${SELECT} WHERE q.id = ANY(${[...ids]})`),
  group: async (groupId: string): Promise<Question[]> =>
    list(await sql<QuestionRecord[]>`${SELECT} WHERE q.group_id = ${groupId} ORDER BY q.position`),
  /** Answers an open question; undefined when it was not open any more. */
  answer: async (id: string, answer: QuestionAnswer, by: QuestionAnswerer): Promise<Question | undefined> =>
    list(
      await sql<QuestionRecord[]>`UPDATE question
        SET status = 'answered', answer = ${JSON.stringify(answer)}, answered_by = ${by}, settled_at = ${now()}
        WHERE id = ${id} AND status = 'open' ${RETURNING}`,
    ).at(0),
  /** Marks an open secret question supplied; it keeps no answer, since the value is never stored. */
  supplied: async (id: string): Promise<Question | undefined> =>
    list(
      await sql<QuestionRecord[]>`UPDATE question SET status = 'answered', answered_by = 'user', settled_at = ${now()}
        WHERE id = ${id} AND status = 'open' AND kind = 'secret' ${RETURNING}`,
    ).at(0),
  /** Dismisses an open question; undefined when it was not open any more. */
  dismiss: async (id: string, by: QuestionAnswerer): Promise<Question | undefined> =>
    list(
      await sql<QuestionRecord[]>`UPDATE question SET status = 'dismissed', answered_by = ${by}, settled_at = ${now()}
        WHERE id = ${id} AND status = 'open' ${RETURNING}`,
    ).at(0),
  /** Expires the group's open questions, as when the agent stops waiting; returns them. */
  expireGroup: async (groupId: string): Promise<Question[]> =>
    list(
      await sql<QuestionRecord[]>`UPDATE question SET status = 'expired', settled_at = ${now()}
        WHERE group_id = ${groupId} AND status = 'open' ${RETURNING}`,
    ),
  /** Expires every open question, as at startup when no process waits on one; returns them. */
  expireAll: async (): Promise<Question[]> =>
    list(
      await sql<QuestionRecord[]>`UPDATE question SET status = 'expired', settled_at = ${now()}
        WHERE status = 'open' ${RETURNING}`,
    ),
}
