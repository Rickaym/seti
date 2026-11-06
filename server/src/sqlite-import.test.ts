import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { messages, sql, tasks } from './db.js'
import { connect, databaseOf, dropDatabase, ensureDatabase, withDatabase } from './pg.js'
import { LEGACY_SQLITE_SCHEMA } from './sqlite-fixture.js'
import { eventHash } from './store/audit.js'
import {
  copyTable,
  deriveRows,
  planImport,
  postgresAuditChain,
  resetSequences,
  sqliteAuditChain,
  tableParity,
  targetCounts,
} from './store/sqlite-import.js'

const run = promisify(execFile)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-import-'))
const TS = '2026-09-27T09:00:00.000Z'
/** Key order, spacing and unicode a JSON round trip would not keep. */
const RAW_PAYLOAD = '{"type":"assistant", "b":1,"a":["\\u00e9","\u65e5\u672c"],"text":"T\u00e4sk \u2713"}'

function legacy(name: string): DatabaseSync {
  const db = new DatabaseSync(path.join(root, name))
  // Fixtures skip fsync: a statement each takes seconds on a busy disk and times tests out.
  db.exec('PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF')
  db.exec(LEGACY_SQLITE_SCHEMA)
  return db
}

/** A small live-shaped database: gaps in ids, a sealed audit chain, one row in most tables. */
function seedLegacy(db: DatabaseSync): void {
  const exec = (query: string, ...values: (string | number | null)[]) => db.prepare(query).run(...values)
  exec(`INSERT INTO repo VALUES ('r1', 'e2e/web', '/srv/web', 'main', ?)`, TS)
  exec(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, session_id, status, permission_mode, model, cost_usd,
       outward_count, last_error, created_at, updated_at, source_session_id, input_mode, sandbox)
     VALUES ('t1', 'T\u00e4sk \u2713 \u65e5\u672c', 'r1', '/srv/web', 1, 's1', 'idle', 'bypassPermissions', 'opus', 1.25, 3, NULL,
       ?, ?, NULL, 'queue', 0)`,
    TS,
    TS,
  )
  exec(
    `INSERT INTO task (id, title, cwd, status, created_at, updated_at) VALUES ('t2', 'Second', '/tmp', 'error', ?, ?)`,
    TS,
    TS,
  )
  for (const n of [1, 2, 3]) {
    exec(`INSERT INTO task_pr VALUES ('t1', ?, ?, 'agent')`, `https://github.com/e2e/web/pull/${String(n)}`, TS)
  }
  exec(`DELETE FROM task_pr WHERE pr_url LIKE '%/1'`)
  exec(`INSERT INTO task_pr VALUES ('t1', 'https://github.com/e2e/web/pull/0', ?, 'user')`, TS)
  for (let n = 0; n < 6; n++) {
    exec(`INSERT INTO task_message (task_id, kind, payload, created_at) VALUES ('t1', 'sdk', ?, ?)`, RAW_PAYLOAD, TS)
  }
  exec(`DELETE FROM task_message WHERE id = 6`)
  exec(`INSERT INTO context_pack VALUES ('p1', 'Pack', '', 'Body', ?, ?)`, TS, TS)
  exec(`INSERT INTO task_context_pack VALUES ('t1', 'p1')`)
  exec(
    `INSERT INTO routine (id, name, schedule, timezone, prompt, created_at, updated_at)
    VALUES ('old', 'Nightly', '0 3 * * *', 'UTC', 'Check', ?, ?)`,
    TS,
    TS,
  )
  exec(
    `INSERT INTO ea_history (kind, message, through_id, created_at) VALUES ('message', '{"role":"user"}', NULL, ?)`,
    TS,
  )
  exec(`INSERT INTO ea_settings VALUES (1, 1, 'Hey Seti', 30, ?)`, TS)
  exec(`INSERT INTO sandbox_policy VALUES (1, 1, '["github.com"]', '[]', ?)`, TS)
  exec(`INSERT INTO pr_watch VALUES ('https://github.com/e2e/web/pull/2', '{"state":"merged"}', 0, ?)`, TS)
  let prev = '0'.repeat(64)
  for (const id of [1, 2, 3]) {
    const event = {
      id,
      at: TS,
      actor: 'user',
      kind: 'task.created',
      subject_type: 'task',
      subject_id: 't1',
      summary: `Event ${String(id)} \u2713`,
      detail: '{"b":1,"a":2}',
    } as const
    const hash = eventHash(event, prev)
    exec(
      `INSERT INTO audit_event VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      TS,
      'user',
      'task.created',
      'task',
      't1',
      event.summary,
      event.detail,
      prev,
      hash,
    )
    prev = hash
  }
  exec(`INSERT INTO audit_chain VALUES (1, 0, ?, 3, ?)`, '0'.repeat(64), prev)
}

const source = legacy('seti.db')
seedLegacy(source)

beforeAll(async () => {
  const plans = await planImport(source, sql)
  await sql.begin(async (tx) => {
    for (const plan of plans) {
      await copyTable(source, tx, plan)
    }
    await resetSequences(source, tx)
    await deriveRows(tx)
  })
})

afterAll(() => {
  source.close()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('import from SQLite', () => {
  it('copies every table so counts and content hashes match on both sides', async () => {
    const parity = await tableParity(source, sql, await planImport(source, sql))
    expect(parity.filter((row) => !row.match)).toEqual([])
    expect(parity.find((row) => row.table === 'task_message')?.postgres_rows).toBe(5)
    expect(parity.find((row) => row.table === 'task_pr')?.postgres_rows).toBe(3)
  })

  it('keeps the audit chain verifiable with the same head', async () => {
    const [before, after] = [await sqliteAuditChain(source), await postgresAuditChain(sql)]
    expect(before).toMatchObject({ ok: true, checked: 3, head_id: 3 })
    expect(after).toEqual(before)
  })

  it('keeps text byte for byte, numbers exactly and link order', async () => {
    const [row] = await sql<{ payload: string }[]>`SELECT payload FROM task_message WHERE id = 1`
    expect(row?.payload).toBe(RAW_PAYLOAD)
    const task = await tasks.get('t1')
    expect(task).toMatchObject({
      title: 'T\u00e4sk \u2713 \u65e5\u672c',
      cost_usd: 1.25,
      outward_count: 3,
      sandbox: false,
      worktree: true,
    })
    expect(task?.pr_urls).toEqual([
      'https://github.com/e2e/web/pull/2',
      'https://github.com/e2e/web/pull/3',
      'https://github.com/e2e/web/pull/0',
    ])
  })

  it('continues ids after the highest one SQLite handed out, deleted rows included', async () => {
    const row = await messages.insert('t1', { kind: 'seti', payload: { error: 'after import' } }, [])
    expect(row.id).toBe(7)
    expect(await tasks.linkPr('t2', 'https://github.com/e2e/web/pull/9', 'user')).toBe(true)
    const [link] = await sql<{ seq: number }[]>`SELECT seq FROM task_pr WHERE task_id = 't2'`
    expect(link?.seq).toBe(5)
  })

  it('leaves out the tables of features Seti removed', async () => {
    const names = (await planImport(source, sql)).map((plan) => plan.name)
    expect(names).toContain('context_pack')
    expect(names.filter((name) => name.startsWith('routine'))).toEqual([])
  })

  it('refuses tables and columns it would not carry over', async () => {
    const extra = legacy('extra.db')
    extra.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY)')
    await expect(planImport(extra, sql)).rejects.toThrow(/tables this version does not know: notes/)
    extra.close()
    const renamed = legacy('renamed.db')
    renamed.exec('ALTER TABLE repo RENAME COLUMN base_branch TO branch')
    await expect(planImport(renamed, sql)).rejects.toThrow(
      /Table repo differs: missing \[base_branch\], extra \[branch\]/,
    )
    renamed.close()
  })

  it('refuses values Postgres would change instead of storing them altered', async () => {
    const nul = legacy('nul.db')
    nul.prepare(`INSERT INTO repo VALUES ('r2', ?, '/srv', 'main', ?)`).run('bad\0slug', TS)
    const plans = await planImport(nul, sql)
    const repoPlan = plans.find((plan) => plan.name === 'repo')
    expect(repoPlan).toBeDefined()
    if (repoPlan !== undefined) {
      await expect(sql.begin(async (tx) => copyTable(nul, tx, repoPlan))).rejects.toThrow(/NUL character/)
    }
    nul.close()
  })
})

describe('migrate-from-sqlite', () => {
  const server = process.env.SETI_DATABASE_URL ?? ''
  const target = withDatabase(server, `${databaseOf(server)}_cli`)
  const env = { ...process.env, SETI_DATABASE_URL: target }
  const cli = async (...args: string[]) =>
    run(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'migrate-from-sqlite.ts'), ...args], {
      env,
    })

  afterAll(async () => {
    await dropDatabase(target)
  })

  // Three cold tsx starts of the CLI take seconds on a loaded host, past the 5 s default.
  it('migrates into an empty database, reports parity and refuses to run twice', { timeout: 30_000 }, async () => {
    await ensureDatabase(target)
    const { stdout } = await cli(path.join(root, 'seti.db'))
    expect(stdout).toMatch(/copied task_message: 5 rows/)
    expect(stdout).toMatch(/audit chain, postgres: ok, 3 events, head #3/)
    expect(stdout).toMatch(/PARITY OK/)
    expect(stdout).not.toContain('T\u00e4sk')
    const pg = connect(target, 1)
    expect((await targetCounts(pg)).get('task')).toBe(2)
    await pg.end()
    await expect(cli(path.join(root, 'seti.db'))).rejects.toThrow(/already holds rows/)
    const verified = await cli(path.join(root, 'seti.db'), '--verify-only')
    expect(verified.stdout).toMatch(/PARITY OK/)
  })
})
