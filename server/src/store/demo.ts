import { sql } from '../db.js'
import { connect, databaseOf, forceDrop, withDatabase } from '../pg.js'
import type { SeedRun } from './demo-seed.js'

/** The demo runs only on databases named like this, so a slip never drops a real one. */
const DEMO_DATABASE = /^seti_demo(?:_[a-z0-9_]+)?$/

const numbered = (query: string) => {
  let count = 0
  return query.replace(/\?/g, () => `$${String(++count)}`)
}

/** Runs the shared seed statements on the demo's pool. */
export const demoSeedRun: SeedRun = async (query, ...values) => {
  await sql.unsafe(numbered(query), values)
}

/** Drops the demo database so the next start seeds a fresh one; refuses any other name. */
export async function dropDemoDatabase(url: string): Promise<void> {
  const name = databaseOf(url)
  if (!DEMO_DATABASE.test(name)) {
    throw new Error(`The demo drops its database on every start, so it must be named seti_demo, not ${name}`)
  }
  const admin = connect(withDatabase(url, 'postgres'), 1)
  try {
    await forceDrop(admin, name)
  } finally {
    await admin.end()
  }
}

export async function countSessions(): Promise<number> {
  return (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM auth_session`).at(0)?.n ?? 0
}
