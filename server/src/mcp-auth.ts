import { randomUUID } from 'node:crypto'
import type { McpAuthDone, McpAuthStart } from '@seti/shared'
import { spawn } from 'node-pty'
import { capabilityCache, probeEnv, scrubUrls } from './capabilities.js'
import { CLAUDE_BIN } from './config.js'
import { HttpError } from './http.js'

/** The slice of a pseudo-terminal child the sign-in uses, so tests can inject a fake. */
export interface LoginProcess {
  onOutput: (listener: (text: string) => void) => void
  onExit: (listener: (code: number) => void) => void
  write: (text: string) => void
  kill: () => void
}

export type SpawnLogin = (server: string, cwd: string) => LoginProcess

export interface AuthTiming {
  idleMs: number
  callMs: number
}

const DEFAULT_TIMING: AuthTiming = { idleMs: 10 * 60 * 1000, callMs: 60_000 }

// The CLI reads the pasted redirect with readline and aborts unless stdin and stdout are TTYs.
const spawnLogin: SpawnLogin = (server, cwd) => {
  const pty = spawn(CLAUDE_BIN, ['mcp', 'login', '--no-browser', '--', server], {
    cwd,
    env: { ...probeEnv(), NO_COLOR: '1' },
    name: 'dumb',
    cols: 10_000,
    rows: 24,
  })
  return {
    onOutput: (listener) => {
      pty.onData(listener)
    },
    onExit: (listener) => {
      pty.onExit(({ exitCode }) => {
        listener(exitCode)
      })
    },
    write: (text) => {
      pty.write(text)
    },
    kill: () => {
      pty.kill()
    },
  }
}

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const ST = `(?:${BEL}|${ESC}\\\\)`
const OSC8_LINK = new RegExp(`${ESC}\\]8;;(https://[^${BEL}${ESC}]+)${ST}`)
const ESCAPES = new RegExp(`${ESC}\\][^${BEL}${ESC}]*${ST}|${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g')
const PLAIN_URL = /https:\/\/\S+(?=\s)/
const SECRET_PARAM = /\b(code|state|token|access_token|refresh_token|id_token)=[^&\s]+/gi
const WAITING = /paste the redirect URL|Waiting for authorization/
const REJECTED = /That doesn't look like a redirect URL[^\r\n]*/

/** The https authorization URL the CLI printed, or null until a complete one has arrived. */
export function findAuthorizationUrl(output: string): string | null {
  const raw = OSC8_LINK.exec(output)?.[1] ?? PLAIN_URL.exec(output.replace(ESCAPES, ''))?.[0]
  if (raw === undefined || !URL.canParse(raw)) {
    return null
  }
  return new URL(raw).protocol === 'https:' ? raw : null
}

/** CLI output safe to return: no escapes, no query strings, no code, state or token values. */
export function scrubOutput(output: string): string {
  const text = scrubUrls(output.replace(ESCAPES, '').replace(SECRET_PARAM, '$1=[redacted]'))
  return text
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('[mcp-sdk]'))
    .join(' ')
}

function failure(output: string, code: number): Error {
  const text = scrubOutput(output)
  return new Error(text === '' ? `claude mcp login exited with ${String(code)}` : text)
}

interface Started {
  url: string
  callbackExpected: boolean
}

function watch(proc: LoginProcess) {
  let output = ''
  let exitCode: number | null = null
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of [...listeners]) {
      listener()
    }
  }
  proc.onOutput((text) => {
    output += text
    notify()
  })
  proc.onExit((code) => {
    exitCode = code
    notify()
  })

  /** Resolves with the first non-undefined value of check, re-run on every output or exit. */
  const until = async <T>(check: () => T | undefined, ms: number, what: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const done = (fn: () => void) => {
        clearTimeout(timer)
        listeners.delete(listener)
        fn()
      }
      const listener = () => {
        try {
          const value = check()
          if (value !== undefined) {
            done(() => {
              resolve(value)
            })
          }
        } catch (e) {
          done(() => {
            reject(e instanceof Error ? e : new Error(String(e)))
          })
        }
      }
      const timer = setTimeout(() => {
        done(() => {
          reject(new Error(`Timed out after ${String(ms)} ms waiting for ${what}`))
        })
      }, ms)
      listeners.add(listener)
      listener()
    })

  return { output: () => output, exitCode: () => exitCode, until }
}

/** One `claude mcp login --no-browser` process kept alive between the two sign-in steps. */
function startLogin(proc: LoginProcess, timing: AuthTiming) {
  const state = watch(proc)

  const started = state.until<Started>(
    () => {
      const url = findAuthorizationUrl(state.output())
      const code = state.exitCode()
      if (url !== null && WAITING.test(state.output())) {
        return { url, callbackExpected: true }
      }
      if (url !== null && code === 0) {
        return { url, callbackExpected: false }
      }
      if (code !== null) {
        throw failure(state.output(), code)
      }
      return undefined
    },
    timing.callMs,
    'an authorization URL',
  )

  const submit = async (callbackUrl: string): Promise<void> => {
    const from = state.output().length
    if (state.exitCode() === null) {
      proc.write(`${callbackUrl}\r`)
    }
    await state.until(
      () => {
        const code = state.exitCode()
        const since = state.output().slice(from)
        if (code === 0) {
          return true
        }
        if (code !== null) {
          throw failure(since, code)
        }
        const rejected = REJECTED.exec(since)
        if (rejected !== null) {
          throw new Error(rejected[0])
        }
        return undefined
      },
      timing.callMs,
      'the sign-in to finish',
    )
  }

  return { started, submit, exited: () => state.exitCode() !== null, kill: proc.kill }
}

interface Live {
  id: string
  server: string
  cwd: string
  login: ReturnType<typeof startLogin>
}

const message = (e: unknown) => scrubOutput(e instanceof Error ? e.message : String(e))

const refreshCapabilities = (cwd: string) => {
  capabilityCache.refresh(cwd).catch((e: unknown) => {
    process.stderr.write(`capability probe after MCP sign-in failed: ${message(e)}\n`)
  })
}

/** Sign-in sessions keyed by id; each process is killed on success, cancel or idle timeout. */
export function createMcpAuth(
  spawnProcess: SpawnLogin = spawnLogin,
  onClosed: (cwd: string) => void = refreshCapabilities,
  timing: AuthTiming = DEFAULT_TIMING,
) {
  const sessions = new Map<string, Live>()
  const timers = new Map<string, NodeJS.Timeout>()

  const close = (id: string): boolean => {
    const live = sessions.get(id)
    if (!live) {
      return false
    }
    clearTimeout(timers.get(id))
    timers.delete(id)
    sessions.delete(id)
    live.login.kill()
    onClosed(live.cwd)
    return true
  }

  const touch = (id: string) => {
    clearTimeout(timers.get(id))
    timers.set(
      id,
      setTimeout(() => close(id), timing.idleMs),
    )
  }

  const begin = async (server: string, cwd: string): Promise<McpAuthStart> => {
    for (const live of [...sessions.values()]) {
      if (live.server === server && live.cwd === cwd) {
        close(live.id)
      }
    }
    const live: Live = { id: randomUUID(), server, cwd, login: startLogin(spawnProcess(server, cwd), timing) }
    sessions.set(live.id, live)
    touch(live.id)
    try {
      const { url, callbackExpected } = await live.login.started
      if (!callbackExpected) {
        close(live.id)
      }
      return { session_id: live.id, authorization_url: url, callback_expected: callbackExpected }
    } catch (e) {
      close(live.id)
      throw new HttpError(502, message(e))
    }
  }

  const complete = async (id: string, callbackUrl: string): Promise<McpAuthDone> => {
    const live = sessions.get(id)
    if (!live) {
      throw new HttpError(404, 'Sign-in session expired or was closed; start again')
    }
    touch(id)
    try {
      await live.login.submit(callbackUrl)
    } catch (e) {
      if (live.login.exited()) {
        close(id)
      }
      throw new HttpError(400, message(e))
    }
    close(id)
    return { server: live.server }
  }

  const serverOf = (id: string): string | null => sessions.get(id)?.server ?? null

  return { start: begin, complete, cancel: close, serverOf }
}

export const mcpAuth = createMcpAuth()
