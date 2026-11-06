import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { runBackup } from './backup-schedule.js'
import { writeBackupKeyPair } from './backup.js'
import { auditEvents } from './store/audit.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-backup-schedule-test-'))
const live = process.env.SETI_DATABASE_URL ?? ''

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('runBackup', () => {
  it('records each backup and each failure in the audit log', async () => {
    const publicKey = writeBackupKeyPair(path.join(root, 'owner.key')).slice('SETI_BACKUP_PUBLIC_KEY='.length)
    const dir = path.join(root, 'backups')
    await runBackup(live, dir, { publicKey, keep: 2, intervalHours: 24 })
    const created = await auditEvents.latest('system.backup_created')
    expect(created?.actor).toBe('system')
    expect(created?.detail.file).toMatch(/^seti-\d{8}T\d{6}Z\.pgdump\.enc$/)
    expect(fs.readdirSync(dir)).toHaveLength(1)

    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    await runBackup(live, dir, { publicKey: 'bm90IGEga2V5', keep: 2, intervalHours: 24 })
    expect((await auditEvents.latest('system.backup_failed'))?.detail.error).toMatch(/not a backup public key/)
    stderr.mockRestore()
  })
})
