import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { decryptFile, readBackupPrivateKey, writeBackupKeyPair } from './backup.js'

const USAGE = `Usage:
  backup keygen <private-key-file>
      Writes a new private key file (0600) and prints the SETI_BACKUP_PUBLIC_KEY line for seti.env.
  backup now [--env-file <seti.env>]
      Takes one encrypted pg_dump backup of the Seti database into SETI_HOME/backups.
  backup restore <backup-file> <new-database> --key <private-key-file> [--env-file <seti.env>]
      Decrypts a backup into a new database on the same server and checks its audit chain.
`

const say = (text: string) => process.stdout.write(`${text}\n`)

function keygen(file: string | undefined): void {
  if (file === undefined) {
    throw new Error('keygen needs the path of the private key file to write')
  }
  const line = writeBackupKeyPair(path.resolve(file))
  say(`Wrote the private key to ${path.resolve(file)}. Keep it off this machine, in a password manager.`)
  say('Add this line to ~/.seti/seti.env and restart Seti:')
  say(line)
}

function loadEnv(envFile: string | undefined): void {
  if (envFile !== undefined) {
    process.loadEnvFile(envFile)
  }
}

async function checkRestored(url: string): Promise<void> {
  const { connect } = await import('./pg.js')
  const { verifyAuditChain } = await import('./store/audit.js')
  const restored = connect(url, 1)
  try {
    const [counts] = await restored<{ tasks: number; messages: number; events: number }[]>`SELECT
      (SELECT COUNT(*) FROM task) AS tasks, (SELECT COUNT(*) FROM task_message) AS messages,
      (SELECT COUNT(*) FROM audit_event) AS events`
    const chain = await verifyAuditChain(restored)
    if (!chain.ok) {
      throw new Error(`the restored audit chain is broken at #${String(chain.broken_at)}: ${chain.problem ?? ''}`)
    }
    say(
      `Restored ${String(counts?.tasks ?? 0)} tasks, ${String(counts?.messages ?? 0)} messages and ` +
        `${String(counts?.events ?? 0)} audit events; audit chain ok up to #${String(chain.head_id)}.`,
    )
  } finally {
    await restored.end()
  }
}

async function restore(source: string | undefined, database: string | undefined, key: string | undefined) {
  if (source === undefined || database === undefined || key === undefined) {
    throw new Error('restore needs <backup-file> <new-database> --key <private-key-file>')
  }
  const { DATABASE_URL } = await import('./config.js')
  const { connect, ensureDatabase, withDatabase } = await import('./pg.js')
  const { restoreDump } = await import('./backup.js')
  const url = withDatabase(DATABASE_URL, database)
  const admin = connect(withDatabase(DATABASE_URL, 'postgres'), 1)
  const taken = await admin`SELECT 1 FROM pg_database WHERE datname = ${database}`.finally(async () => admin.end())
  if (taken.length > 0) {
    throw new Error(`database ${database} exists; restore writes only to a new database`)
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-restore-'))
  try {
    const dump = path.join(scratch, 'seti.pgdump')
    await decryptFile(source, dump, readBackupPrivateKey(key))
    await ensureDatabase(url)
    await restoreDump(dump, url)
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
  await checkRestored(url)
  say(`Restored into database ${database}. Point SETI_DATABASE_URL at it to use it.`)
}

async function now(): Promise<void> {
  const { BACKUP, BACKUP_DIR, DATABASE_URL } = await import('./config.js')
  if (BACKUP === null) {
    throw new Error('SETI_BACKUP_PUBLIC_KEY is not set; pass --env-file ~/.seti/seti.env')
  }
  const { backupDatabase, readBackupPublicKey } = await import('./backup.js')
  const result = await backupDatabase(DATABASE_URL, {
    dir: BACKUP_DIR,
    recipient: readBackupPublicKey(BACKUP.publicKey),
    keep: BACKUP.keep,
  })
  say(`Wrote ${result.file} (${String(result.bytes)} bytes).`)
}

async function main(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { key: { type: 'string' }, 'env-file': { type: 'string' } },
  })
  const [command, ...rest] = positionals
  switch (command) {
    case 'keygen':
      keygen(rest[0])
      return
    case 'restore':
      loadEnv(values['env-file'])
      await restore(rest[0], rest[1], values.key)
      return
    case 'now':
      loadEnv(values['env-file'])
      await now()
      return
    case undefined:
    default:
      process.stdout.write(USAGE)
  }
}

try {
  await main(process.argv.slice(2))
} catch (e) {
  process.stderr.write(`backup: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exitCode = 1
}
