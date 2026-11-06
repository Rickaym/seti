import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TerminalSize } from '@seti/shared'
import { spawn } from 'node-pty'
import type { Launched } from './memory-scope.js'
import { childLookup, Proc } from './proc.js'

/** The terminal type shells in Seti's terminals see, which xterm.js in the browser speaks. */
export const TERM = 'xterm-256color'
/** Arguments that make a shell read its profile and rc files, as a terminal window's shell does. */
export const LOGIN_ARGS = ['-l', '-i'] as const
/** The shell when the account names none Seti can run. */
export const FALLBACK_SHELL = '/bin/bash'

/** Variables of the user's session a terminal keeps; Seti's own settings and pnpm's stay out. */
const SESSION_ENV = [
  'PATH',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TMPDIR',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'SSH_AUTH_SOCK',
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'XDG_DATA_DIRS',
  'XDG_CONFIG_DIRS',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
]

/** PATH entries `pnpm run` adds for the server's own scripts, which a user's shell never has. */
const SCRIPT_PATH = /\/node_modules\/\.bin\/?$|\/node-gyp-bin\/?$/

/** PATH without the server's script entries. */
export const sessionPath = (value: string) =>
  value
    .split(':')
    .filter((dir) => dir !== '' && !SCRIPT_PATH.test(dir))
    .join(':')

const runnable = (file: string) => {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** The account's shell from its passwd entry, or bash when that is missing or refuses logins. */
export function loginShell(shell: string | null = os.userInfo().shell): string {
  if (shell === null || !path.isAbsolute(shell) || /\/(nologin|false)$/.test(shell) || !runnable(shell)) {
    return FALLBACK_SHELL
  }
  return shell
}

export interface Account {
  username: string
  homedir: string
  shell: string
}

/**
 * What a login shell in a terminal window starts with: the account's names and home, the
 * session's locale, PATH and agent sockets, and the terminal type. Nothing else of the server's
 * environment, so its settings, credentials and variables such as ZDOTDIR never reach the shell.
 */
export function loginEnv(source: Readonly<Record<string, string | undefined>>, account: Account) {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (SESSION_ENV.includes(key) || key.startsWith('LC_'))) {
      env[key] = value
    }
  }
  if (env.PATH !== undefined) {
    env.PATH = sessionPath(env.PATH)
  }
  const { username, homedir, shell } = account
  return { ...env, HOME: homedir, USER: username, LOGNAME: username, SHELL: shell, TERM, COLORTERM: 'truecolor' }
}

/** Output a browser gets when it attaches, so a reload shows what the shell printed before. */
const SCROLLBACK_BYTES = 128 * 1024
const KILL_GRACE_MS = 2000

/** The slice of a pseudo-terminal a terminal uses; `launch` can start it in a memory scope. */
export interface PtyProcess extends Launched {
  readonly pid: number
  onData: (listener: (data: string) => void) => void
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  pause: () => void
  resume: () => void
}

export interface PtyOptions {
  cwd: string
  env: Record<string, string | undefined>
  size: TerminalSize
}

type SpawnPty = (program: string, args: string[], options: PtyOptions) => PtyProcess

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void

function signalName(signal: number | undefined): NodeJS.Signals | null {
  const names = Object.entries(os.constants.signals) as [NodeJS.Signals, number][]
  return signal === undefined || signal === 0 ? null : (names.find(([, value]) => value === signal)?.[0] ?? null)
}

/** Starts `program` in a pseudo-terminal of `size`. */
export const spawnPty: SpawnPty = (program, args, { cwd, env, size }) => {
  const pty = spawn(program, args, { name: TERM, cwd, env, cols: size.cols, rows: size.rows })
  const exits: ExitListener[] = []
  let exited = false
  pty.onExit(({ exitCode, signal }) => {
    exited = true
    const name = signalName(signal)
    for (const listener of exits.splice(0)) {
      listener(name === null ? exitCode : null, name)
    }
  })
  return {
    pid: pty.pid,
    once: (_event, listener) => {
      exits.push(listener)
    },
    onData: (listener) => {
      pty.onData(listener)
    },
    write: (data) => {
      pty.write(data)
    },
    // The pty's descriptor is gone once the shell exits, and resizing it then throws.
    resize: (cols, rows) => {
      if (!exited) {
        pty.resize(cols, rows)
      }
    },
    pause: () => {
      pty.pause()
    },
    resume: () => {
      pty.resume()
    },
  }
}

/** The last output of a terminal, cut at a line start once it outgrows its cap. */
export class Scrollback {
  private chunks: Buffer[] = []
  private size = 0
  /** Bytes the shell printed in all, so a browser can say how far it got. */
  private total = 0
  private readonly cap: number

  constructor(cap = SCROLLBACK_BYTES) {
    this.cap = cap
  }

  add(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.size += chunk.length
    this.total += chunk.length
    if (this.size > this.cap * 2) {
      this.trim()
    }
  }

  /** The kept output, and where its first byte sits in all the shell printed. */
  kept(): { from: number; bytes: Buffer } {
    this.trim()
    return { from: this.total - this.size, bytes: Buffer.concat(this.chunks) }
  }

  /** The output after byte `offset`, or null once the cap cut past it or it lies ahead. */
  since(offset: number): Buffer | null {
    const { from, bytes } = this.kept()
    if (offset < from || offset > this.total) {
      return null
    }
    return bytes.subarray(offset - from)
  }

  private trim(): void {
    if (this.size <= this.cap) {
      return
    }
    const all = Buffer.concat(this.chunks)
    const cut = all.length - this.cap
    const line = all.indexOf(0x0a, cut)
    const kept = line === -1 ? all.subarray(cut) : all.subarray(line + 1)
    this.chunks = [kept]
    this.size = kept.length
  }
}

/** A shell's output after the first chunk waits this long, or until this much gathered. */
const FRAME_MS = 6
const FRAME_BYTES = 32 * 1024

/**
 * Gathers a shell's output into frames, so a flood goes out as a few large frames and not
 * thousands of tiny ones. The first chunk after a quiet spell goes out at once, so typing echoes
 * with no delay; chunks after it wait for the window to close or for the size cap.
 */
export class OutputFrames {
  private chunks: Buffer[] = []
  private size = 0
  private window: NodeJS.Timeout | null = null
  private readonly send: (data: Buffer) => void
  private readonly wait: number
  private readonly max: number

  constructor(send: (data: Buffer) => void, wait = FRAME_MS, max = FRAME_BYTES) {
    this.send = send
    this.wait = wait
    this.max = max
  }

  add(chunk: Buffer): void {
    if (this.window === null) {
      this.open()
      this.send(chunk)
      return
    }
    this.chunks.push(chunk)
    this.size += chunk.length
    if (this.size >= this.max) {
      this.flush()
    }
  }

  /** Drops what waits, as the browser it was for is gone or gets the scrollback instead. */
  clear(): void {
    if (this.window !== null) {
      clearTimeout(this.window)
      this.window = null
    }
    this.chunks = []
    this.size = 0
  }

  private open(): void {
    this.window = setTimeout(() => {
      this.window = null
      if (this.size > 0) {
        this.open()
        this.flush()
      }
    }, this.wait)
  }

  /** Sends what waits now, as the shell ends. */
  flush(): void {
    if (this.size === 0) {
      return
    }
    const data = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.size)
    this.chunks = []
    this.size = 0
    if (data !== undefined) {
      this.send(data)
    }
  }
}

/** Token buckets of input bytes and frames per second, each holding up to two seconds' worth. */
export class InputBudget {
  private bytes: number
  private frames: number
  private at: number
  private readonly rate: { bytes: number; frames: number }
  private readonly clock: () => number

  constructor(rate = { bytes: 256 * 1024, frames: 400 }, clock: () => number = Date.now) {
    this.rate = rate
    this.clock = clock
    this.bytes = rate.bytes * 2
    this.frames = rate.frames * 2
    this.at = clock()
  }

  /** False once the browser sends faster than the rate allows. */
  take(bytes: number): boolean {
    const at = this.clock()
    const seconds = Math.max(0, at - this.at) / 1000
    this.at = at
    this.bytes = Math.min(this.rate.bytes * 2, this.bytes + seconds * this.rate.bytes) - bytes
    this.frames = Math.min(this.rate.frames * 2, this.frames + seconds * this.rate.frames) - 1
    return this.bytes >= 0 && this.frames >= 0
  }
}

const proc = new Proc()

/** The process and everything below it now, with start times to tell them from later ones. */
function processTree(pid: number): { pid: number; startTicks: number }[] {
  const children = childLookup(proc)
  const found: { pid: number; startTicks: number }[] = []
  const queue = [pid]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const stat = proc.stat(next)
    if (stat !== null && stat.state !== 'Z' && !found.some((p) => p.pid === stat.pid)) {
      found.push({ pid: stat.pid, startTicks: stat.startTicks })
      queue.push(...children(stat.pid))
    }
  }
  return found
}

function sendSignal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name)
  } catch {
    // It exited already.
  }
}

/** SIGHUP as a closed terminal sends, to the shell's group and all below it; SIGKILL after. */
export function hangUp(pid: number): void {
  const tree = processTree(pid)
  sendSignal(-pid, 'SIGHUP')
  for (const p of tree) {
    sendSignal(p.pid, 'SIGHUP')
  }
  setTimeout(() => {
    sendSignal(-pid, 'SIGKILL')
    for (const p of tree) {
      if (proc.stat(p.pid)?.startTicks === p.startTicks) {
        sendSignal(p.pid, 'SIGKILL')
      }
    }
  }, KILL_GRACE_MS).unref()
}
