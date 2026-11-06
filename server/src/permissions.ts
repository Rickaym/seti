import fs from 'node:fs'
import path from 'node:path'

const GROUP_OTHER = 0o077

/** The database with its WAL, SHM and manual copies, and env files holding keys and tokens. */
const PRIVATE_FILE = /^seti\.db|\.env$/

interface PermissionFix {
  path: string
  from: number
  to: number
}

const octal = (mode: number) => `0${(mode & 0o777).toString(8)}`

function tighten(target: string, fixes: PermissionFix[]): void {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false })
  if (stat === undefined || stat.isSymbolicLink() || (stat.mode & GROUP_OTHER) === 0) {
    return
  }
  const from = stat.mode & 0o777
  const to = from & ~GROUP_OTHER
  fs.chmodSync(target, to)
  fixes.push({ path: target, from, to })
}

function tightenDir(dir: string, files: (name: string) => boolean, fixes: PermissionFix[]): void {
  tighten(dir, fixes)
  const entries = fs.readdirSync(dir, { withFileTypes: true, recursive: false })
  for (const entry of entries) {
    if (entry.isFile() && files(entry.name)) {
      tighten(path.join(dir, entry.name), fixes)
    }
  }
}

const PRIVATE_DIRS = ['credentials', 'dev-credentials'] as const

/** Makes Seti's home, database, env files, credentials and backups owner-only; returns fixes. */
export function secureHome(home: string, backups: string): PermissionFix[] {
  const fixes: PermissionFix[] = []
  if (!fs.existsSync(home)) {
    return fixes
  }
  tightenDir(home, (name) => PRIVATE_FILE.test(name), fixes)
  for (const dir of [backups, ...PRIVATE_DIRS.map((name) => path.join(home, name))]) {
    if (fs.existsSync(dir)) {
      tightenDir(dir, () => true, fixes)
    }
  }
  return fixes
}

/** Tightens at startup and tells the journal about anything that was more open than owner-only. */
export function enforcePrivateHome(home: string, backups: string): void {
  try {
    for (const fix of secureHome(home, backups)) {
      process.stderr.write(`permissions: ${fix.path} was ${octal(fix.from)}, now ${octal(fix.to)}\n`)
    }
  } catch (e) {
    process.stderr.write(`permissions: could not check ${home}: ${e instanceof Error ? e.message : String(e)}\n`)
  }
}
