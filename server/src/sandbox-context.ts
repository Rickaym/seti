import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CLAUDE_HOME, CREDENTIALS, DATABASE_URL, REDIS_URL, SETI_HOME } from './config.js'
import type { SandboxContext } from './sandbox.js'

/** Home folders that hold credentials and settings, which no agent edits. */
export const GUARDED_HOME = ['.ssh', '.aws', '.config']

/** The database and cache socket directories, which no sandbox mounts. */
function socketDirs(): string[] {
  const database = new URL(DATABASE_URL).searchParams.get('host')
  const dirs = [database ?? '', REDIS_URL.startsWith('/') ? path.dirname(REDIS_URL) : '']
  return dirs.filter((dir) => dir.startsWith('/') && fs.existsSync(dir)).map((dir) => fs.realpathSync(dir))
}

/** The per-user credentials root systemd fills, and the server's own directory when elsewhere. */
function credentialDirs(): string[] {
  const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${String(os.userInfo().uid)}`
  const root = path.join(runtime, 'credentials')
  const own = CREDENTIALS.dev ? null : CREDENTIALS.dir
  return own === null || own.startsWith(`${root}/`) ? [root] : [root, own]
}

/** What a sandbox on this machine hides and mounts: the home, Seti's data, sockets, credentials. */
export function sandboxContext(): SandboxContext {
  return {
    home: os.homedir(),
    setiHome: SETI_HOME,
    claudeHome: CLAUDE_HOME,
    sockets: socketDirs(),
    credentials: credentialDirs(),
  }
}
