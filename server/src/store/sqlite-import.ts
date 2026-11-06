import { createHash } from 'node:crypto'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { AuditChainStatus } from '@seti/shared'
import type { Db, Pool } from '../pg.js'
import { checkChain, verifyAuditChain, type Chain, type ChainRecord } from './audit.js'
import { TASK_WORKTREE_BACKFILL } from './schema-tasks.js'

/** Every table, parents before children, with the key both sides order rows by. */
const IMPORT_TABLES: readonly { name: string; key: readonly string[] }[] = [
  { name: 'repo', key: ['id'] },
  { name: 'task', key: ['id'] },
  { name: 'task_repo', key: ['task_id', 'repo_id'] },
  { name: 'task_pr', key: ['task_id', 'pr_url'] },
  { name: 'task_message', key: ['id'] },
  { name: 'context_pack', key: ['id'] },
  { name: 'task_context_pack', key: ['task_id', 'pack_id'] },
  { name: 'seti_plugin', key: ['id'] },
  { name: 'task_plugin_optout', key: ['task_id', 'plugin_id'] },
  { name: 'audit_event', key: ['id'] },
  { name: 'audit_chain', key: ['id'] },
  { name: 'revision', key: ['id'] },
  { name: 'revision_seen', key: ['object_type', 'object_id'] },
  { name: 'pr_watch', key: ['pr_url'] },
  { name: 'task_rewind', key: ['id'] },
  { name: 'pr_discovery_cursor', key: ['task_id'] },
  { name: 'task_pr_dismissed', key: ['task_id', 'pr_url'] },
  { name: 'ea_history', key: ['id'] },
  { name: 'ea_settings', key: ['id'] },
  { name: 'sandbox_policy', key: ['id'] },
]

/** Tables of features Seti removed since; a SQLite database may still hold them, unimported. */
const RETIRED_TABLES = new Set([
  'routine',
  'routine_run',
  'routine_context_pack',
  'routine_repo',
  'routine_plugin_optout',
])

/** Postgres columns SQLite kept implicitly: task_pr link order was its rowid. */
const FROM_ROWID: Readonly<Record<string, string>> = { task_pr: 'seq' }

/** Columns added after the move to Postgres; imported rows take their defaults. */
const POSTGRES_ONLY: Readonly<Record<string, readonly string[]>> = {
  task: [
    'archived_at',
    'pinned',
    'profile_id',
    'setup',
    'seti_control',
    'seti_level',
    'color',
    'workspace_id',
    'notifications_muted',
    'status_line',
    'status_line_at',
    'unseen',
    'asking',
    'blocked',
    'bypass_until',
    'closing_line',
  ],
  task_context_pack: ['linked'],
  ea_settings: ['join_on_open', 'form_of_address'],
  ea_history: ['unseen'],
  context_pack: ['builtin', 'linked_by_default', 'kind'],
}

/** Rows migrations seed in Postgres, which no SQLite file holds. */
const SEEDED: Readonly<Record<string, string>> = { context_pack: 'NOT builtin' }

const imported = (table: string) => (SEEDED[table] === undefined ? '' : ` WHERE ${SEEDED[table]}`)

const SQLITE_INTERNAL = new Set(['sqlite_sequence'])

type Value = string | number | null

interface Column {
  name: string
  type: string
  nullable: boolean
}

export interface TablePlan {
  name: string
  key: readonly string[]
  columns: Column[]
  /** False when the SQLite file has no such table, as before the feature existed. */
  inSqlite: boolean
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

async function targetColumns(db: Db): Promise<Map<string, Column[]>> {
  const rows = await db<{ table_name: string; column_name: string; data_type: string; is_nullable: string }[]>`
    SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`
  const byTable = new Map<string, Column[]>()
  for (const row of rows) {
    const column = { name: row.column_name, type: row.data_type, nullable: row.is_nullable === 'YES' }
    byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), column])
  }
  return byTable
}

const sqliteTables = (source: DatabaseSync) =>
  new Set(
    source
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((row) => String(row.name))
      .filter((name) => !SQLITE_INTERNAL.has(name)),
  )

const sqliteColumns = (source: DatabaseSync, table: string) =>
  source
    .prepare(`SELECT name FROM pragma_table_info(?)`)
    .all(table)
    .map((row) => String(row.name))

/** Matches the SQLite schema to Postgres; throws on anything that would not carry over. */
export async function planImport(source: DatabaseSync, target: Db): Promise<TablePlan[]> {
  const columns = await targetColumns(target)
  const present = sqliteTables(source)
  const known = new Set(IMPORT_TABLES.map((table) => table.name))
  const unknown = [...present].filter((name) => !known.has(name) && !RETIRED_TABLES.has(name))
  if (unknown.length > 0) {
    throw new Error(`The SQLite database has tables this version does not know: ${unknown.join(', ')}`)
  }
  return IMPORT_TABLES.map(({ name, key }) => {
    const all = columns.get(name)
    if (all === undefined) {
      throw new Error(`Postgres has no table ${name}; run the migrations first`)
    }
    const wanted = all.filter((column) => !(POSTGRES_ONLY[name] ?? []).includes(column.name))
    const inSqlite = present.has(name)
    if (inSqlite) {
      const expected = wanted.map((column) => column.name).filter((column) => column !== FROM_ROWID[name])
      const found = sqliteColumns(source, name)
      const missing = expected.filter((column) => !found.includes(column))
      const extra = found.filter((column) => !expected.includes(column))
      if (missing.length > 0 || extra.length > 0) {
        throw new Error(
          `Table ${name} differs: missing [${missing.join(', ')}], extra [${extra.join(', ')}]. ` +
            'Start the SQLite version of Seti once so it upgrades the file, then migrate again.',
        )
      }
    }
    return { name, key, columns: wanted, inSqlite }
  })
}

function sqliteSelect(plan: TablePlan): string {
  const rowid = FROM_ROWID[plan.name]
  const columns = plan.columns.map((column) =>
    column.name === rowid ? `rowid AS ${quote(column.name)}` : quote(column.name),
  )
  return `SELECT ${columns.join(', ')} FROM ${quote(plan.name)} ORDER BY ${plan.key.map(quote).join(', ')}`
}

/** A value as Postgres will hold it; anything that would change on the way is an error. */
// eslint-disable-next-line sonarjs/function-return-type -- SQLite cells are text, numbers or NULL
function checked(table: string, column: Column, value: SQLOutputValue): Value {
  const where = `${table}.${column.name}`
  if (value === null) {
    if (!column.nullable) {
      throw new Error(`${where} is NULL but the column does not allow it`)
    }
    return null
  }
  if (typeof value === 'bigint' || value instanceof Uint8Array) {
    throw new Error(`${where} holds a ${typeof value === 'bigint' ? 'huge integer' : 'blob'}, which cannot carry over`)
  }
  if (column.type === 'text') {
    if (typeof value !== 'string') {
      throw new Error(`${where} holds a number in a text column`)
    }
    if (value.includes('\0')) {
      throw new Error(`${where} holds a NUL character, which Postgres text cannot store`)
    }
    return value
  }
  if (typeof value !== 'number' || (column.type !== 'double precision' && !Number.isInteger(value))) {
    throw new Error(`${where} does not hold a ${column.type}`)
  }
  return value
}

function* sqliteRows(source: DatabaseSync, plan: TablePlan): Generator<Value[]> {
  if (!plan.inSqlite) {
    return
  }
  for (const row of source.prepare(sqliteSelect(plan)).iterate()) {
    yield plan.columns.map((column) => checked(plan.name, column, row[column.name] ?? null))
  }
}

const BATCH_PARAMS = 30_000
const BATCH_BYTES = 8 * 1024 * 1024

const sizeOf = (row: readonly Value[]) =>
  row.reduce<number>((sum, value) => sum + (typeof value === 'string' ? value.length : 8), 0)

async function insertBatch(tx: Db, plan: TablePlan, rows: Value[][]): Promise<void> {
  if (rows.length === 0) {
    return
  }
  const names = plan.columns.map((column) => column.name)
  const values = rows.map((row) => Object.fromEntries(names.map((name, index) => [name, row[index] ?? null])))
  await tx`INSERT INTO ${tx(plan.name)} ${tx(values, names)}`
}

export async function copyTable(source: DatabaseSync, tx: Db, plan: TablePlan): Promise<number> {
  const perBatch = Math.max(1, Math.floor(BATCH_PARAMS / plan.columns.length))
  let batch: Value[][] = []
  let bytes = 0
  let count = 0
  for (const row of sqliteRows(source, plan)) {
    batch.push(row)
    bytes += sizeOf(row)
    count += 1
    if (batch.length >= perBatch || bytes >= BATCH_BYTES) {
      await insertBatch(tx, plan, batch)
      batch = []
      bytes = 0
    }
  }
  await insertBatch(tx, plan, batch)
  return count
}

/** Tables Postgres numbers itself, with the column the sequence feeds. */
const SEQUENCES: Readonly<Record<string, string>> = {
  task_message: 'id',
  audit_event: 'id',
  revision: 'id',
  task_rewind: 'id',
  ea_history: 'id',
  task_pr: 'seq',
}

/** Continues each sequence past the highest id SQLite ever handed out, deleted rows included. */
export async function resetSequences(source: DatabaseSync, tx: Db): Promise<void> {
  const issued = new Map<string, number>()
  if (sqliteTables(source).size > 0) {
    const hasSequence = source.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'`).get()
    const rows = hasSequence === undefined ? [] : source.prepare('SELECT name, seq FROM sqlite_sequence').all()
    for (const row of rows) {
      issued.set(String(row.name), Number(row.seq))
    }
  }
  for (const [table, column] of Object.entries(SEQUENCES)) {
    const [row] = await tx<{ top: number | null }[]>`SELECT MAX(${tx(column)}) AS top FROM ${tx(table)}`
    const top = Math.max(row?.top ?? 0, issued.get(table) ?? 0)
    const sequence = tx`pg_get_serial_sequence(${table}, ${column})`
    await (top > 0 ? tx`SELECT setval(${sequence}, ${top}, true)` : tx`SELECT setval(${sequence}, 1, false)`)
  }
}

/** Fills the Postgres-only tables that follow from imported rows, such as task worktrees. */
export async function deriveRows(tx: Db): Promise<void> {
  await tx.unsafe(TASK_WORKTREE_BACKFILL)
}

/** Row counts of every table; the import refuses a target that holds any rows. */
export async function targetCounts(db: Db): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  for (const { name } of IMPORT_TABLES) {
    const [row] = await db.unsafe<{ count: number }[]>(`SELECT COUNT(*) AS count FROM ${quote(name)}${imported(name)}`)
    counts.set(name, row?.count ?? 0)
  }
  return counts
}

export interface TableParity {
  table: string
  sqlite_rows: number
  postgres_rows: number
  sqlite_sha256: string
  postgres_sha256: string
  match: boolean
}

/** Hashes rows in key order as `[value, ...]` JSON lines, the same way for either side. */
class RowHash {
  private readonly hash = createHash('sha256')
  count = 0

  add(row: readonly Value[]): void {
    this.hash.update(`${JSON.stringify(row)}\n`)
    this.count += 1
  }

  digest(): string {
    return this.hash.digest('hex')
  }
}

const PARITY_BATCH = 1000

async function postgresHash(db: Db, plan: TablePlan): Promise<RowHash> {
  const hash = new RowHash()
  const names = plan.columns.map((column) => column.name)
  const keyed = plan.key.map((column) => {
    const type = plan.columns.find((candidate) => candidate.name === column)?.type
    return type === 'text' ? `${quote(column)} COLLATE "C"` : quote(column)
  })
  const from = `${quote(plan.name)}${imported(plan.name)}`
  const query = `SELECT ${names.map(quote).join(', ')} FROM ${from} ORDER BY ${keyed.join(', ')}`
  for await (const batch of db.unsafe<Record<string, Value>[]>(query).cursor(PARITY_BATCH)) {
    for (const row of batch) {
      hash.add(names.map((name) => row[name] ?? null))
    }
  }
  return hash
}

export async function tableParity(source: DatabaseSync, db: Db, plans: readonly TablePlan[]): Promise<TableParity[]> {
  const report: TableParity[] = []
  for (const plan of plans) {
    const sqlite = new RowHash()
    for (const row of sqliteRows(source, plan)) {
      sqlite.add(row)
    }
    const postgres = await postgresHash(db, plan)
    const [sqliteSha, postgresSha] = [sqlite.digest(), postgres.digest()]
    report.push({
      table: plan.name,
      sqlite_rows: sqlite.count,
      postgres_rows: postgres.count,
      sqlite_sha256: sqliteSha,
      postgres_sha256: postgresSha,
      match: sqlite.count === postgres.count && sqliteSha === postgresSha,
    })
  }
  return report
}

/** Verifies the audit chain the SQLite file holds, exactly as Seti verifies it in Postgres. */
export async function sqliteAuditChain(source: DatabaseSync): Promise<AuditChainStatus> {
  const tables = sqliteTables(source)
  const head = tables.has('audit_chain')
    ? (source.prepare('SELECT anchor_id, anchor_hash, head_id, head_hash FROM audit_chain WHERE id = 1').get() as
        Chain | undefined)
    : undefined
  const rows = tables.has('audit_event')
    ? (source.prepare('SELECT * FROM audit_event ORDER BY id').all() as unknown as ChainRecord[])
    : []
  const events = (async function* () {
    yield await Promise.resolve(rows)
  })()
  return checkChain({ head, events })
}

export const postgresAuditChain = async (database: Pool) => verifyAuditChain(database)
