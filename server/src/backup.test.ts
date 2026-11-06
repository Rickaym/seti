import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  backupDatabase,
  decryptFile,
  listBackups,
  nextBackupDelay,
  readBackupPrivateKey,
  readBackupPublicKey,
  restoreDump,
  writeBackupKeyPair,
} from './backup.js'
import { sql } from './db.js'
import { connect, databaseOf, dropDatabase, ensureDatabase, withDatabase } from './pg.js'

const MARKER = 'transcript line that must never appear in a backup file'
const live = process.env.SETI_DATABASE_URL ?? ''

let root: string

function keyPair(name: string) {
  const file = path.join(root, `${name}.key`)
  const line = writeBackupKeyPair(file)
  return { file, publicKey: readBackupPublicKey(line.slice('SETI_BACKUP_PUBLIC_KEY='.length)) }
}

const backups = () => path.join(root, 'backups')

beforeAll(async () => {
  await sql`CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`
  for (let i = 0; i < 500; i += 1) {
    const body = `${MARKER} ${String(i)}`
    await sql`INSERT INTO note (id, body) VALUES (${i}, ${body})`
  }
})

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-backup-test-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('encrypted backups', () => {
  it('round-trips the live database through an owner-only encrypted file', async () => {
    const { file: keyFile, publicKey } = keyPair('owner')
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600)
    const at = new Date('2026-09-27T17:15:00.000Z')
    const result = await backupDatabase(live, { dir: backups(), recipient: publicKey, keep: 3, at })
    expect(path.basename(result.file)).toBe('seti-20260927T171500Z.pgdump.enc')
    expect(fs.statSync(result.file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(backups()).mode & 0o777).toBe(0o700)
    expect(fs.readdirSync(backups())).toEqual([path.basename(result.file)])
    expect(fs.readFileSync(result.file).includes(MARKER)).toBe(false)

    const dump = path.join(root, 'restored.pgdump')
    await decryptFile(result.file, dump, readBackupPrivateKey(keyFile))
    const restoredUrl = withDatabase(live, `${databaseOf(live)}_r`)
    try {
      await ensureDatabase(restoredUrl)
      await restoreDump(dump, restoredUrl)
      const restored = connect(restoredUrl, 1)
      try {
        const rows = await restored<{ body: string }[]>`SELECT body FROM note ORDER BY id`
        expect(rows).toHaveLength(500)
        expect(rows[499]?.body).toBe(`${MARKER} 499`)
      } finally {
        await restored.end()
      }
    } finally {
      await dropDatabase(restoredUrl)
    }
  }, 30_000)

  it('refuses another key and a changed file without leaving output behind', async () => {
    const { publicKey } = keyPair('owner')
    const stranger = keyPair('stranger')
    const { file } = await backupDatabase(live, { dir: backups(), recipient: publicKey, keep: 3 })
    const target = path.join(root, 'restored.db')
    await expect(decryptFile(file, target, readBackupPrivateKey(stranger.file))).rejects.toThrow(/another key/)

    const owner = readBackupPrivateKey(path.join(root, 'owner.key'))
    const bytes = fs.readFileSync(file)
    bytes[bytes.length - 100] = (bytes[bytes.length - 100] ?? 0) ^ 0xff
    const tampered = path.join(root, 'tampered.db.enc')
    fs.writeFileSync(tampered, bytes)
    await expect(decryptFile(tampered, target, owner)).rejects.toThrow(/failed authentication/)
    expect(fs.existsSync(target)).toBe(false)
    expect(fs.existsSync(`${target}.partial`)).toBe(false)

    fs.writeFileSync(tampered, 'not a backup at all. '.repeat(10))
    await expect(decryptFile(tampered, target, owner)).rejects.toThrow(/Not a Seti backup/)
  })

  it('keeps only the newest backups', async () => {
    const { publicKey } = keyPair('owner')
    for (const day of ['01', '02', '03', '04']) {
      const at = new Date(`2026-09-${day}T03:00:00.000Z`)
      await backupDatabase(live, { dir: backups(), recipient: publicKey, keep: 2, at })
    }
    expect(listBackups(backups())).toEqual(['seti-20260903T030000Z.pgdump.enc', 'seti-20260904T030000Z.pgdump.enc'])
  })

  it('never overwrites an existing private key file', () => {
    keyPair('owner')
    expect(() => writeBackupKeyPair(path.join(root, 'owner.key'))).toThrow(/EEXIST/)
  })

  it('refuses keys that are not X25519 backup keys', () => {
    expect(() => readBackupPublicKey('bm90IGEga2V5')).toThrow(/SETI_BACKUP_PUBLIC_KEY is not a backup public key/)
    const other = path.join(root, 'other.key')
    fs.writeFileSync(other, 'SOMETHING_ELSE=1\n')
    expect(() => readBackupPrivateKey(other)).toThrow(/no SETI_BACKUP_PRIVATE_KEY line/)
  })
})

describe('nextBackupDelay', () => {
  const hour = 60 * 60 * 1000

  it('backs up at once without a backup or when the newest is overdue', () => {
    expect(nextBackupDelay(null, 10 * hour, 24 * hour)).toBe(0)
    expect(nextBackupDelay(0, 30 * hour, 24 * hour)).toBe(0)
  })

  it('waits out the rest of the interval after a recent backup', () => {
    expect(nextBackupDelay(0, 20 * hour, 24 * hour)).toBe(4 * hour)
  })
})
