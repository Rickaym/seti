import { ADMIN_DATABASE_URL, DATABASE_PREFIX, DATABASE_URL, DEMO_DATABASE_PREFIX, DEMO_DATABASE_URL } from './env.js'
import { connect, databaseOf, forceDrop } from '../../../server/src/pg.js'

export type SeedValue = string | number | null

/** One connection to this worker's server database, for seeding rows the UI then reads. */
export interface SeedDb {
  /** Runs one statement; `?` placeholders take the values in order. */
  run: (query: string, ...values: SeedValue[]) => Promise<void>
  /** Inserts an idle task with no repo, so no agent turn ever starts. */
  idleTask: (id: string, title: string, cwd: string, at: string) => Promise<void>
  /** Appends one transcript row with its payload already as JSON text. */
  message: (taskId: string, kind: string, payload: string, at: string) => Promise<void>
  close: () => Promise<void>
}

const numbered = (query: string) => {
  let count = 0
  return query.replace(/\?/g, () => `$${String(++count)}`)
}

export function openSeedDb(): SeedDb {
  const sql = connect(DATABASE_URL, 1)
  return {
    run: async (query, ...values) => {
      await sql.unsafe(numbered(query), values)
    },
    idleTask: async (id, title, cwd, at) => {
      await sql`INSERT INTO task (id, title, repo_id, cwd, worktree, status, created_at, updated_at)
        VALUES (${id}, ${title}, NULL, ${cwd}, 0, 'idle', ${at}, ${at})`
    },
    message: async (taskId, kind, payload, at) => {
      await sql`INSERT INTO task_message (task_id, kind, payload, outward, created_at)
        VALUES (${taskId}, ${kind}, ${payload}, '[]', ${at})`
    },
    close: async () => sql.end(),
  }
}

/** Drops this worker's database or its demo's, or with `all` every one this run's workers left. */
export async function dropDatabases(scope: 'worker' | 'demo' | 'all'): Promise<void> {
  const sql = connect(ADMIN_DATABASE_URL, 1)
  const prefixed = async () =>
    sql<{ datname: string }[]>`SELECT datname FROM pg_database
      WHERE starts_with(datname, ${DATABASE_PREFIX}) OR starts_with(datname, ${DEMO_DATABASE_PREFIX})`
  const own = { worker: DATABASE_URL, demo: DEMO_DATABASE_URL }
  try {
    const names = scope === 'all' ? (await prefixed()).map((row) => row.datname) : [databaseOf(own[scope])]
    for (const name of names) {
      await forceDrop(sql, name)
    }
  } finally {
    await sql.end()
  }
}
