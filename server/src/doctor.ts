import { execFile } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { binaryPath } from './binaries.js'

type CheckState = 'ok' | 'info' | 'warn' | 'fail'

/** One finding: what was checked, how it stands, and the command or step that fixes it. */
export interface Check {
  section: string
  state: CheckState
  label: string
  fix?: string
}

const MARKS: Record<CheckState, string> = { ok: 'ok  ', info: 'info', warn: 'warn', fail: 'FAIL' }

/** The findings grouped by section, with a closing count; plain ASCII for any terminal. */
export function report(checks: readonly Check[]): string {
  const lines: string[] = []
  let section = ''
  for (const check of checks) {
    if (check.section !== section) {
      section = check.section
      lines.push('', section)
    }
    lines.push(`  ${MARKS[check.state]}  ${check.label}`)
    if (check.fix !== undefined) {
      lines.push(...check.fix.split('\n').map((line, index) => `        ${index === 0 ? 'fix: ' : '     '}${line}`))
    }
  }
  const count = (state: CheckState) => checks.filter((check) => check.state === state).length
  const fails = count('fail')
  const warns = count('warn')
  lines.push(
    '',
    fails + warns === 0
      ? 'Everything Seti needs is in place.'
      : `${plural(fails, 'problem')}, ${plural(warns, 'warning')}.`,
  )
  return `${lines.join('\n').trimStart()}\n`
}

const plural = (count: number, noun: string) => `${String(count)} ${noun}${count === 1 ? '' : 's'}`

interface RunResult {
  code: number
  stdout: string
}

/** Runs a program without a shell; a missing program or a timeout is a non-zero code, not a throw. */
export async function runQuiet(file: string, args: readonly string[], timeoutMs = 10_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, [...args], { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout) => {
      const failed = typeof error?.code === 'number' ? error.code : 127
      resolve({ code: error === null ? 0 : failed, stdout: stdout.trim() })
    })
  })
}

/** Whether `version` (such as v24.1.0 or 10.32.1) is at least `minimum`. */
export function atLeast(version: string, minimum: string): boolean {
  const parts = (text: string) => (/\d+(?:\.\d+)*/.exec(text)?.[0] ?? '0').split('.').map(Number)
  const have = parts(version)
  const want = parts(minimum)
  for (let i = 0; i < want.length; i += 1) {
    const a = have[i] ?? 0
    const b = want[i] ?? 0
    if (a !== b) {
      return a > b
    }
  }
  return true
}

/** A program on PATH or in ~/.local/bin, where the installers of uv and Claude Code put them. */
export function findProgram(name: string): string | null {
  return binaryPath(name) ?? binaryPath(name, path.join(os.homedir(), '.local', 'bin'))
}

const REQUIRED_CREDENTIALS = ['secret-key', 'local-token-user', 'local-token-ea'] as const
const TOKEN_MIN = 32

/** The size of a credential file and whether others may read it; null when it is missing. */
function inspect(file: string): { size: number; open: boolean } | null {
  try {
    const stat = fs.statSync(file)
    const size = fs.readFileSync(file, 'utf8').trim().length
    return { size, open: (stat.mode & 0o077) !== 0 }
  } catch {
    return null
  }
}

/** Checks the credential files the server loads, by size and mode only; values are never shown. */
export function credentialChecks(dir: string, dev: boolean): Check[] {
  const section = 'Key files'
  if (dev) {
    return [{ section, state: 'info', label: `development run: Seti creates its own key files in ${dir}` }]
  }
  if (!fs.existsSync(dir)) {
    return [{ section, state: 'fail', label: `no key file directory at ${dir}`, fix: 'scripts/install.sh' }]
  }
  const checks: Check[] = []
  if ((fs.statSync(dir).mode & 0o077) !== 0) {
    checks.push({ section, state: 'warn', label: `${dir} is readable by others`, fix: `chmod 700 ${dir}` })
  }
  for (const name of REQUIRED_CREDENTIALS) {
    const file = path.join(dir, name)
    const found = inspect(file)
    const short = name !== 'secret-key' && found !== null && found.size < TOKEN_MIN
    if (found === null || found.size === 0 || short) {
      const why = found === null ? 'missing' : 'empty or too short'
      checks.push({ section, state: 'fail', label: `${name} is ${why}`, fix: 'scripts/install.sh creates it' })
    } else if (found.open) {
      checks.push({ section, state: 'warn', label: `${name} is readable by others`, fix: `chmod 600 ${file}` })
    } else {
      checks.push({ section, state: 'ok', label: `${name} set` })
    }
  }
  return checks
}

/** Which optional keys hold a value: the EA's chat, voice and TURN keys, and the tunnel token. */
export function optionalKeys(dir: string, names: readonly string[]): { set: string[]; unset: string[] } {
  const set = names.filter((name) => (inspect(path.join(dir, name))?.size ?? 0) > 0)
  return { set, unset: names.filter((name) => !set.includes(name)) }
}

/** Whether something already listens on the port, found by trying to listen there. */
export async function portBusy(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => {
      resolve(true)
    })
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => {
        resolve(false)
      })
    })
  })
}

/** A URL host part for a listen address: wildcards become loopback, IPv6 gets brackets. */
export function loopbackFor(host: string): string {
  if (host === '0.0.0.0' || host === '') {
    return '127.0.0.1'
  }
  if (host === '::') {
    return '[::1]'
  }
  return host.includes(':') ? `[${host}]` : host
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

export const isLoopback = (host: string) => LOOPBACK.has(host) || host.startsWith('127.')

/** The URL without its password, so a DATABASE_URL or REDIS_URL can be shown. */
export function redact(url: string): string {
  if (!URL.canParse(url)) {
    return url
  }
  const parsed = new URL(url)
  if (parsed.password !== '') {
    parsed.password = '***'
  }
  return parsed.toString()
}

export async function answers(url: string, timeoutMs = 3000): Promise<number | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    await res.body?.cancel()
    return res.status
  } catch {
    return null
  }
}

/** Rejects when the work takes longer than `ms`, so a hung connection cannot stall the doctor. */
export async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`no answer within ${String(ms / 1000)} s`))
    }, ms)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}
