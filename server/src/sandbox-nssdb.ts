import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { binaryPath } from './binaries.js'

/** The files of an NSS database in its sql format, the one Chromium and Chrome read. */
const DB_FILES = ['cert9.db', 'key4.db', 'pkcs11.txt'] as const

/** The NSS database beside the public CA files, which each sandbox gets a copy of. */
export const browserDbOf = (publicDir: string) => path.join(publicDir, 'nssdb')

/** The NSS database a sandbox mounts, or null when none has been written. */
export const writtenBrowserDb = (publicDir: string): string | null => {
  const dir = browserDbOf(publicDir)
  return DB_FILES.every((name) => fs.existsSync(path.join(dir, name))) ? dir : null
}

async function certutil(program: string, args: readonly string[], input = ''): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile(program, args, { timeout: 30_000 }, (error) => {
      if (error === null) {
        resolve()
      } else {
        reject(new Error(`certutil ${args[0] ?? ''} failed: ${error.message}`))
      }
    })
    child.stdin?.end(input)
  })
}

/**
 * Writes an NSS database trusting each CA for TLS servers only, for Chromium and Chrome in a
 * sandbox, which read `~/.pki/nssdb` rather than the CA variables. It holds the certificates and
 * no key. Running sandboxes see the new files; false when the host has no certutil.
 */
export async function writeBrowserDb(publicDir: string, certs: readonly string[]): Promise<boolean> {
  const program = binaryPath('certutil')
  if (program === null) {
    return false
  }
  const target = browserDbOf(publicDir)
  const work = fs.mkdtempSync(path.join(publicDir, '.nssdb-'))
  try {
    const db = `sql:${work}`
    await certutil(program, ['-N', '-d', db, '--empty-password'])
    for (const [index, pem] of certs.entries()) {
      const name = `Seti sandbox egress CA ${String(index + 1)}`
      await certutil(program, ['-A', '-d', db, '-n', name, '-t', 'C,,', '-a'], pem)
    }
    fs.mkdirSync(target, { recursive: true, mode: 0o755 })
    for (const name of DB_FILES) {
      fs.renameSync(path.join(work, name), path.join(target, name))
    }
  } finally {
    for (const name of fs.readdirSync(work)) {
      fs.unlinkSync(path.join(work, name))
    }
    fs.rmdirSync(work)
  }
  return true
}

/**
 * Gives a sandbox a fresh copy of the NSS database to mount as `~/.pki/nssdb`, since NSS opens it
 * read-write and refuses a read-only one; what the agent writes there lasts until its next start.
 * Null when there is none or the copy fails.
 */
export function sandboxBrowserDb(source: string | null, taskDir: string): string | null {
  if (source === null) {
    return null
  }
  const target = path.join(taskDir, 'nssdb')
  try {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 })
    for (const name of DB_FILES) {
      for (const stale of [name, `${name}-journal`, `${name}-wal`, `${name}-shm`]) {
        fs.rmSync(path.join(target, stale), { force: true })
      }
      fs.copyFileSync(path.join(source, name), path.join(target, name), fs.constants.COPYFILE_EXCL)
    }
    return target
  } catch {
    return null
  }
}
