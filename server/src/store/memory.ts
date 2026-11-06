import { MEMORY_CAP_DEFAULTS, type MemoryCap } from '@seti/shared'
import { now, sql } from '../db.js'

interface CapRow {
  high_mb: number
  max_mb: number
  swap_max_mb: number
  updated_at: string
}

const toCap = (row: CapRow): MemoryCap => ({ high_mb: row.high_mb, max_mb: row.max_mb, swap_max_mb: row.swap_max_mb })

export const memorySettings = {
  /** The default cap of every agent and when it was saved; null while the built-in one applies. */
  get: async (): Promise<{ cap: MemoryCap; updated_at: string | null }> => {
    const [row] = await sql<CapRow[]>`SELECT high_mb, max_mb, swap_max_mb, updated_at FROM memory_settings WHERE id = 1`
    return row === undefined
      ? { cap: MEMORY_CAP_DEFAULTS, updated_at: null }
      : { cap: toCap(row), updated_at: row.updated_at }
  },
  set: async (cap: MemoryCap): Promise<string> => {
    const at = now()
    await sql`INSERT INTO memory_settings (id, high_mb, max_mb, swap_max_mb, updated_at)
      VALUES (1, ${cap.high_mb}, ${cap.max_mb}, ${cap.swap_max_mb}, ${at})
      ON CONFLICT (id) DO UPDATE SET high_mb = excluded.high_mb, max_mb = excluded.max_mb,
        swap_max_mb = excluded.swap_max_mb, updated_at = excluded.updated_at`
    return at
  },
}

export const taskMemoryCaps = {
  get: async (taskId: string): Promise<MemoryCap | null> => {
    const [row] = await sql<CapRow[]>`SELECT high_mb, max_mb, swap_max_mb, updated_at FROM task_memory_cap
      WHERE task_id = ${taskId}`
    return row === undefined ? null : toCap(row)
  },
  /** Gives the task a cap of its own, or with null takes it back to the default. */
  set: async (taskId: string, cap: MemoryCap | null): Promise<void> => {
    if (cap === null) {
      await sql`DELETE FROM task_memory_cap WHERE task_id = ${taskId}`
      return
    }
    await sql`INSERT INTO task_memory_cap (task_id, high_mb, max_mb, swap_max_mb, updated_at)
      VALUES (${taskId}, ${cap.high_mb}, ${cap.max_mb}, ${cap.swap_max_mb}, ${now()})
      ON CONFLICT (task_id) DO UPDATE SET high_mb = excluded.high_mb, max_mb = excluded.max_mb,
        swap_max_mb = excluded.swap_max_mb, updated_at = excluded.updated_at`
  },
}
