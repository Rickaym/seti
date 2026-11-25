import type { DreamReport, DreamRun, DreamState } from '@seti/shared'
import { now, sql, type Db } from '../db.js'

export type DreamRecord = Omit<DreamRun, 'cost_usd' | 'report'> & {
  cost_usd: number | string
  report: DreamReport | null
  not_before?: string | null
}

export const toRun = ({ not_before: _planned, ...record }: DreamRecord): DreamRun => ({
  ...record,
  cost_usd: Number(record.cost_usd),
})

/** How a dream ended, as it is stored. */
export interface DreamEnd {
  state: Exclude<DreamState, 'running' | 'planned' | 'skipped'>
  reason: string | null
  cost_usd: number
  steps: number
  denials: number
  memory_changes: number
  report: DreamReport | null
}

export const dreamRuns = {
  start: async (run: { task_id: string; night: string; kind: DreamRun['kind']; model: string }): Promise<DreamRun> => {
    const [row] = await sql<DreamRecord[]>`INSERT INTO dream_run (task_id, night, kind, state, model, started_at)
      VALUES (${run.task_id}, ${run.night}, ${run.kind}, 'running', ${run.model}, ${now()}) RETURNING *`
    if (row === undefined) {
      throw new Error('The dream was not recorded')
    }
    return toRun(row)
  },
  /** Ends a running dream; undefined when it runs no more, so a dream ends once. */
  end: async (id: number, end: DreamEnd, db: Db = sql): Promise<DreamRun | undefined> => {
    const report = end.report === null ? null : sql.json({ ...end.report })
    const [row] = await db<DreamRecord[]>`UPDATE dream_run SET state = ${end.state}, reason = ${end.reason},
        cost_usd = ${end.cost_usd}, steps = ${end.steps}, denials = ${end.denials},
        memory_changes = ${end.memory_changes}, report = ${report}, ended_at = ${now()}
      WHERE id = ${id} AND state = 'running' RETURNING *`
    return row && toRun(row)
  },
  /** Records which wording of the dream prompt the dream runs under. */
  promptUsed: async (id: number, version: string): Promise<void> => {
    await sql`UPDATE dream_run SET prompt_version = ${version} WHERE id = ${id}`
  },
  get: async (id: number) => {
    const [row] = await sql<DreamRecord[]>`SELECT * FROM dream_run WHERE id = ${id}`
    return row && toRun(row)
  },
  /** The agent's dreams that started, newest first. */
  forTask: async (taskId: string, limit: number) =>
    (
      await sql<DreamRecord[]>`SELECT * FROM dream_run WHERE task_id = ${taskId}
        AND state NOT IN ('planned', 'skipped') ORDER BY started_at DESC, id DESC LIMIT ${limit}`
    ).map(toRun),
  /** Whether any dream of any agent has started. */
  any: async () => {
    const [row] = await sql<{ started: boolean }[]>`SELECT EXISTS (SELECT 1 FROM dream_run
        WHERE state NOT IN ('planned', 'skipped')) AS started`
    return row?.started === true
  },
  /** The dream of the agent that runs now, if any. */
  running: async (taskId: string) => {
    const [row] = await sql<DreamRecord[]>`SELECT * FROM dream_run WHERE task_id = ${taskId} AND state = 'running'`
    return row && toRun(row)
  },
  /** The agent's dreams that changed memory since its last message went out, oldest first. */
  sinceLastTurn: async (taskId: string) =>
    (
      await sql<DreamRecord[]>`SELECT * FROM dream_run d WHERE d.task_id = ${taskId} AND d.memory_changes > 0
        AND d.ended_at > COALESCE((SELECT MAX(m.created_at) FROM task_message m
          WHERE m.task_id = ${taskId} AND m.kind = 'prompt'), '')
        ORDER BY d.id`
    ).map(toRun),
  /** Every dream still marked running, oldest first; when Seti starts, a restart cut them. */
  allRunning: async () =>
    (await sql<DreamRecord[]>`SELECT * FROM dream_run WHERE state = 'running' ORDER BY id`).map(toRun),
  /** Marks a running dream cut, with the memory files it changed; undefined when it runs no more. */
  cut: async (id: number, reason: string, memoryChanges: number, db: Db): Promise<DreamRun | undefined> => {
    const [row] = await db<DreamRecord[]>`UPDATE dream_run SET state = 'cut', reason = ${reason},
        memory_changes = ${memoryChanges}, ended_at = ${now()}
      WHERE id = ${id} AND state = 'running' RETURNING *`
    return row && toRun(row)
  },
}
