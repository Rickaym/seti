import { sql } from '../db.js'

/** A backend serving Seti, whose parent is the postmaster, and the size of Seti's database. */
export async function databaseStats(): Promise<{ backendPid: number; databaseBytes: number }> {
  const [row] = await sql<{ pid: number; size: number }[]>`
    SELECT pg_backend_pid() AS pid, pg_database_size(current_database()) AS size`
  if (!row) {
    throw new Error('PostgreSQL returned no row')
  }
  return { backendPid: row.pid, databaseBytes: row.size }
}
