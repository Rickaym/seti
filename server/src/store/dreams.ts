import type { DreamReport, DreamRun, DreamState } from '@seti/shared'
import { now, sql } from '../db.js'

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
  end: async (id: number, end: DreamEnd): Promise<DreamRun | undefined> => {
    const report = end.report === null ? null : sql.json({ ...end.report })
    const [row] = await sql<DreamRecord[]>`UPDATE dream_run SET state = ${end.state}, reason = ${end.reason},
        cost_usd = ${end.cost_usd}, steps = ${end.steps}, denials = ${end.denials},
        memory_changes = ${end.memory_changes}, report = ${report}, ended_at = ${now()}
      WHERE id = ${id} RETURNING *`
    return row && toRun(row)
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
  /** Dreams a restart cut: every one still marked running when Seti starts. */
  cutRunning: async (reason: string) =>
    (
      await sql<DreamRecord[]>`UPDATE dream_run SET state = 'cut', reason = ${reason}, ended_at = ${now()}
        WHERE state = 'running' RETURNING *`
    ).map(toRun),
}
