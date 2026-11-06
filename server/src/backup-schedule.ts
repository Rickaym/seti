import fs from 'node:fs'
import path from 'node:path'
import { audit } from './audit.js'
import { backupDatabase, listBackups, nextBackupDelay, readBackupPublicKey } from './backup.js'
import type { BackupConfig } from './config.js'

const HOUR_MS = 60 * 60 * 1000

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Takes one encrypted backup and records the outcome in the audit log; never throws. */
export async function runBackup(url: string, dir: string, config: BackupConfig): Promise<void> {
  try {
    const result = await backupDatabase(url, {
      dir,
      recipient: readBackupPublicKey(config.publicKey),
      keep: config.keep,
    })
    await audit.record({
      actor: 'system',
      kind: 'system.backup_created',
      subject_type: 'system',
      summary: `Backed up the database to ${path.basename(result.file)}`,
      detail: { file: path.basename(result.file), bytes: result.bytes, removed: result.removed },
    })
  } catch (e) {
    process.stderr.write(`backup: failed: ${errorText(e)}\n`)
    await audit.record({
      actor: 'system',
      kind: 'system.backup_failed',
      subject_type: 'system',
      summary: 'Database backup failed',
      detail: { error: errorText(e) },
    })
  }
}

function newestBackupMs(dir: string): number | null {
  const newest = listBackups(dir).at(-1)
  return newest === undefined ? null : fs.statSync(path.join(dir, newest)).mtimeMs
}

/** Backs up when the newest backup is older than the interval, then once per interval. */
export function startBackups(url: string, dir: string, config: BackupConfig | null): void {
  if (config === null) {
    process.stdout.write('backup: off, SETI_BACKUP_PUBLIC_KEY is not set\n')
    return
  }
  readBackupPublicKey(config.publicKey)
  const interval = config.intervalHours * HOUR_MS
  const run = () => void runBackup(url, dir, config)
  const delay = nextBackupDelay(newestBackupMs(dir), Date.now(), interval)
  setTimeout(() => {
    run()
    setInterval(run, interval).unref()
  }, delay).unref()
}
