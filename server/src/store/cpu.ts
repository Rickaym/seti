import type { CpuCap } from '@seti/shared'
import { now, sql } from '../db.js'

interface CapRow {
  quota_percent: number | null
  updated_at: string
}

export const cpuSettings = {
  /** The saved default cap of every agent and when it was saved; null before one is saved. */
  get: async (): Promise<{ cap: CpuCap; updated_at: string } | null> => {
    const [row] = await sql<CapRow[]>`SELECT quota_percent, updated_at FROM cpu_settings WHERE id = 1`
    return row === undefined ? null : { cap: { quota_percent: row.quota_percent }, updated_at: row.updated_at }
  },
  set: async (cap: CpuCap): Promise<void> => {
    await sql`INSERT INTO cpu_settings (id, quota_percent, updated_at) VALUES (1, ${cap.quota_percent}, ${now()})
      ON CONFLICT (id) DO UPDATE SET quota_percent = excluded.quota_percent, updated_at = excluded.updated_at`
  },
}

export const taskCpuCaps = {
  get: async (taskId: string): Promise<CpuCap | null> => {
    const [row] = await sql<CapRow[]>`SELECT quota_percent, updated_at FROM task_cpu_cap WHERE task_id = ${taskId}`
    return row === undefined ? null : { quota_percent: row.quota_percent }
  },
  /** Gives the task a cap of its own, or with null takes it back to the default. */
  set: async (taskId: string, cap: CpuCap | null): Promise<void> => {
    if (cap === null) {
      await sql`DELETE FROM task_cpu_cap WHERE task_id = ${taskId}`
      return
    }
    await sql`INSERT INTO task_cpu_cap (task_id, quota_percent, updated_at) VALUES (${taskId}, ${cap.quota_percent}, ${now()})
      ON CONFLICT (task_id) DO UPDATE SET quota_percent = excluded.quota_percent, updated_at = excluded.updated_at`
  },
}
