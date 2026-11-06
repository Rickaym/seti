import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ClaudeLogin, SignInStart } from '@seti/shared'
import { readConfigDirLogin } from './claude-login-file.js'
import { keepLogin } from './claude-logins.js'
import { CLAUDE_BIN, SETI_HOME } from './config.js'
import { HttpError } from './http.js'

const URL_TIMEOUT_MS = 30_000
const CODE_TIMEOUT_MS = 60_000
const EXPIRE_MS = 10 * 60_000
const MAX_PENDING = 3

/** URL characters only, so the escape codes of an OSC 8 link around it are left out. */
const AUTHORIZE_URL = /https:\/\/[\w.-]+\/[\w./-]*oauth\/authorize\?[\w%&=.~+:/-]+/
const REFUSED = /invalid code|error|failed/i

interface Pending {
  id: string
  name: string
  dir: string
  child: ChildProcessWithoutNullStreams
  output: string
  exited: number | null
  timer: NodeJS.Timeout
  finishing: boolean
}

const exitOf = (entry: Pending): number | null => entry.exited

export interface SignInOptions {
  bin: string
  /** Where each sign-in gets a private Claude Code config directory, removed when it ends. */
  root: string
  env?: NodeJS.ProcessEnv
}

/** Removes what would sign Claude Code in some other way than the login being made. */
function loginEnv(source: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (!['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(key)) {
      env[key] = value
    }
  }
  return { ...env, CLAUDE_CONFIG_DIR: dir, BROWSER: 'false', NO_COLOR: '1' }
}

/**
 * Signs in to a further Claude account with `claude auth login` in a config directory of its
 * own, so the login in use stays untouched: Seti hands the user the sign-in page, then passes
 * the code the page shows to Claude Code and saves the login it wrote.
 */
export function createSignIns(options: SignInOptions) {
  const pending = new Map<string, Pending>()

  const end = (entry: Pending) => {
    clearTimeout(entry.timer)
    pending.delete(entry.id)
    if (entry.exited === null) {
      entry.child.kill('SIGTERM')
    }
    fs.rmSync(entry.dir, { recursive: true, force: true })
  }

  const waitFor = async (entry: Pending, done: () => boolean, ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      const tick = () => {
        if (done()) {
          finish(true)
        }
      }
      const timeout = setTimeout(() => {
        finish(false)
      }, ms)
      const finish = (value: boolean) => {
        clearTimeout(timeout)
        entry.child.stdout.off('data', tick)
        entry.child.stderr.off('data', tick)
        entry.child.off('exit', tick)
        resolve(value)
      }
      entry.child.stdout.on('data', tick)
      entry.child.stderr.on('data', tick)
      entry.child.on('exit', tick)
      tick()
    })

  const start = async (name: string): Promise<SignInStart> => {
    if (pending.size >= MAX_PENDING) {
      throw new HttpError(429, 'Finish or cancel the logins already open first')
    }
    fs.mkdirSync(options.root, { recursive: true, mode: 0o700 })
    const dir = fs.mkdtempSync(path.join(options.root, 'login-'))
    fs.chmodSync(dir, 0o700)
    const child = spawn(options.bin, ['auth', 'login', '--claudeai'], {
      cwd: dir,
      env: loginEnv(options.env ?? process.env, dir),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const id = randomUUID()
    const entry: Pending = {
      id,
      name,
      dir,
      child,
      output: '',
      exited: null,
      finishing: false,
      timer: setTimeout(() => {
        end(entry)
      }, EXPIRE_MS),
    }
    entry.timer.unref()
    const collect = (chunk: Buffer) => {
      entry.output = `${entry.output}${chunk.toString('utf8')}`.slice(-8000)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', () => {
      entry.exited = -1
    })
    child.on('exit', (code) => {
      entry.exited = code ?? -1
    })
    pending.set(id, entry)
    const found = await waitFor(entry, () => AUTHORIZE_URL.test(entry.output) || entry.exited !== null, URL_TIMEOUT_MS)
    const url = AUTHORIZE_URL.exec(entry.output)?.[0]
    if (!found || url === undefined) {
      end(entry)
      throw new HttpError(502, 'Claude Code did not offer a login page; log in with claude in a terminal instead')
    }
    return { id, url }
  }

  const finish = async (id: string, code: string): Promise<{ login: ClaudeLogin; created: boolean }> => {
    const entry = pending.get(id)
    if (entry?.exited !== null) {
      throw new HttpError(404, 'This login has ended; start again')
    }
    if (entry.finishing) {
      throw new HttpError(409, 'This login is already checking a code')
    }
    entry.finishing = true
    const before = entry.output.length
    const refused = () => REFUSED.test(entry.output.slice(before))
    entry.child.stdin.write(`${code}\n`)
    const settled = await waitFor(entry, () => exitOf(entry) !== null || refused(), CODE_TIMEOUT_MS)
    entry.finishing = false
    const exited = exitOf(entry)
    if (!settled || exited === null) {
      throw new HttpError(400, 'Claude Code did not accept that code; copy the whole code and try again')
    }
    const slot = exited === 0 ? readConfigDirLogin(entry.dir) : null
    end(entry)
    if (slot === null) {
      throw new HttpError(400, 'Claude Code did not accept that code; start the login again')
    }
    return keepLogin(entry.name, slot)
  }

  const cancel = (id: string): void => {
    const entry = pending.get(id)
    if (entry !== undefined) {
      end(entry)
    }
  }

  return { start, finish, cancel, open: () => pending.size }
}

export const signIns = createSignIns({ bin: CLAUDE_BIN, root: path.join(SETI_HOME, 'sign-in') })
