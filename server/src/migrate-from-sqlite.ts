import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'
import type { AuditChainStatus } from '@seti/shared'

const USAGE = `Usage:
  migrate-from-sqlite <seti.db> [--env-file <seti.env>] [--verify-only] [--report <file.json>]
      Copies every table of a SQLite Seti database into the Postgres database Seti uses
      (SETI_DATABASE_URL, or the one SETI_HOME implies), which must be empty, then compares both.
      --verify-only compares without copying. The SQLite file is only read.
`

const say = (text: string) => process.stdout.write(`${text}\n`)

interface Options {
  source: string
  verifyOnly: boolean
  report: string | null
}

function readOptions(argv: string[]): Options | null {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'env-file': { type: 'string' },
      'verify-only': { type: 'boolean', default: false },
      report: { type: 'string' },
    },
  })
  const [source] = positionals
  if (source === undefined) {
    return null
  }
  if (values['env-file'] !== undefined) {
    process.loadEnvFile(values['env-file'])
  }
  return { source: path.resolve(source), verifyOnly: values['verify-only'], report: values.report ?? null }
}

/** Reads a consistent copy, so a Seti still writing the file cannot tear the import. */
async function snapshot(source: string, dir: string): Promise<DatabaseSync> {
  if (!fs.existsSync(source)) {
    throw new Error(`${source} does not exist`)
  }
  const live = new DatabaseSync(source, { readOnly: true })
  const copy = path.join(dir, 'seti.db')
  try {
    await backup(live, copy)
  } finally {
    live.close()
  }
  fs.chmodSync(copy, 0o600)
  return new DatabaseSync(copy, { readOnly: true })
}

const short = (hash: string) => hash.slice(0, 16)

function chainLine(side: string, status: AuditChainStatus): string {
  const state = status.ok ? 'ok' : `BROKEN at #${String(status.broken_at)} (${status.problem ?? ''})`
  return `${side}: ${state}, ${String(status.checked)} events, head #${String(status.head_id)} ${short(status.head_hash)}`
}

async function run(options: Options): Promise<boolean> {
  const { DATABASE_URL } = await import('./config.js')
  const { connect, databaseOf, ensureDatabase, migrate } = await import('./pg.js')
  const importer = await import('./store/sqlite-import.js')
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-migrate-'))
  const target = connect(DATABASE_URL, 2)
  try {
    const source = await snapshot(options.source, scratch)
    try {
      await ensureDatabase(DATABASE_URL)
      await migrate(target)
      const plans = await importer.planImport(source, target)
      say(`Target database: ${databaseOf(DATABASE_URL)}`)
      if (!options.verifyOnly) {
        const counts = await importer.targetCounts(target)
        const filled = [...counts].filter(([, count]) => count > 0).map(([table]) => table)
        if (filled.length > 0) {
          throw new Error(`The target database already holds rows in ${filled.join(', ')}; migrate into an empty one`)
        }
        const started = Date.now()
        await target.begin(async (tx) => {
          for (const plan of plans) {
            const copied = await importer.copyTable(source, tx, plan)
            say(`copied ${plan.name}: ${String(copied)} rows`)
          }
          await importer.resetSequences(source, tx)
          await importer.deriveRows(tx)
        })
        say(`Copied in ${String(Date.now() - started)} ms.`)
      }
      const parity = await importer.tableParity(source, target, plans)
      const chains = {
        sqlite: await importer.sqliteAuditChain(source),
        postgres: await importer.postgresAuditChain(target),
      }
      say('')
      say('table                      sqlite rows  postgres rows  sqlite sha256     postgres sha256   match')
      for (const row of parity) {
        say(
          [
            row.table.padEnd(26),
            String(row.sqlite_rows).padStart(11),
            String(row.postgres_rows).padStart(14),
            ` ${short(row.sqlite_sha256)} `,
            `${short(row.postgres_sha256)} `,
            row.match ? 'yes' : 'NO',
          ].join(' '),
        )
      }
      say('')
      say(chainLine('audit chain, sqlite  ', chains.sqlite))
      say(chainLine('audit chain, postgres', chains.postgres))
      const sameChain =
        chains.sqlite.ok &&
        chains.postgres.ok &&
        chains.sqlite.checked === chains.postgres.checked &&
        chains.sqlite.head_hash === chains.postgres.head_hash
      const ok = parity.every((row) => row.match) && sameChain
      say(ok ? 'PARITY OK' : 'PARITY FAILED')
      if (options.report !== null) {
        fs.writeFileSync(options.report, `${JSON.stringify({ ok, tables: parity, chains }, null, 2)}\n`, {
          mode: 0o600,
        })
      }
      return ok
    } finally {
      source.close()
    }
  } finally {
    await target.end()
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

try {
  const options = readOptions(process.argv.slice(2))
  if (options === null) {
    process.stdout.write(USAGE)
  } else if (!(await run(options))) {
    process.exitCode = 1
  }
} catch (e) {
  process.stderr.write(`migrate-from-sqlite: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exitCode = 1
}
