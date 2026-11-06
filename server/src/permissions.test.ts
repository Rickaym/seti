import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SETI_HOME, WORKTREE_ROOT } from './config.js'
import { sql } from './db.js'
import { enforcePrivateHome, secureHome } from './permissions.js'

let root: string
let home: string
let backups: string

const mode = (target: string) => fs.statSync(target).mode & 0o777

const setMode = (target: string, perms: number) => {
  fs.chmodSync(target, perms)
}

function file(name: string, perms: number, dir = home): string {
  const target = path.join(dir, name)
  fs.writeFileSync(target, 'x')
  setMode(target, perms)
  return target
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-perms-test-'))
  home = path.join(root, 'seti')
  backups = path.join(home, 'backups')
  fs.mkdirSync(backups, { recursive: true })
  setMode(home, 0o755)
  setMode(backups, 0o775)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('secureHome', () => {
  it('makes the home, database files, env files and backups owner-only', () => {
    const db = file('seti.db', 0o644)
    const wal = file('seti.db-wal', 0o664)
    const copy = file('seti.db.bak-20260927', 0o644)
    const env = file('seti.env', 0o640)
    const backup = file('seti-20260927.db.enc', 0o644, backups)
    const fixes = secureHome(home, backups)
    expect(mode(home)).toBe(0o700)
    expect(mode(backups)).toBe(0o700)
    for (const target of [db, wal, copy, env, backup]) {
      expect(mode(target)).toBe(0o600)
    }
    expect(fixes).toContainEqual({ path: home, from: 0o755, to: 0o700 })
    expect(fixes).toContainEqual({ path: env, from: 0o640, to: 0o600 })
    expect(fixes).toHaveLength(7)
  })

  it('keeps owner bits and leaves private and unrelated entries alone', () => {
    const script = file('run.env', 0o750)
    const notes = file('notes.txt', 0o644)
    const tight = file('ea.env', 0o600)
    fs.symlinkSync(notes, path.join(home, 'link.env'))
    const fixes = secureHome(home, backups).map((fix) => fix.path)
    expect(mode(script)).toBe(0o700)
    expect(mode(notes)).toBe(0o644)
    expect(fixes).not.toContain(tight)
    expect(fixes).not.toContain(path.join(home, 'link.env'))
    expect(secureHome(home, backups)).toEqual([])
  })

  it('does nothing when the home does not exist yet', () => {
    expect(secureHome(path.join(root, 'missing'), path.join(root, 'missing', 'backups'))).toEqual([])
  })

  it('warns about each change on stderr', () => {
    file('seti.env', 0o644)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    enforcePrivateHome(home, backups)
    expect(stderr.mock.calls.map(([line]) => line)).toEqual([
      `permissions: ${home} was 0755, now 0700\n`,
      `permissions: ${path.join(home, 'seti.env')} was 0644, now 0600\n`,
      `permissions: ${backups} was 0775, now 0700\n`,
    ])
    stderr.mockRestore()
  })
})

describe('the database', () => {
  it('keeps no database file in the owner-only home', async () => {
    await sql`CREATE TABLE IF NOT EXISTS permissions_probe (id INTEGER)`
    expect(mode(SETI_HOME)).toBe(0o700)
    expect(mode(WORKTREE_ROOT)).toBe(0o700)
    expect(fs.readdirSync(SETI_HOME).filter((name) => name.startsWith('seti.db'))).toEqual([])
  })
})
