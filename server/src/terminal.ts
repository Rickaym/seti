import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import {
  extraDirs,
  type Task,
  type TerminalClose,
  type TerminalServerMessage,
  type TerminalSize,
  type TerminalStatus,
} from '@seti/shared'
import { audit } from './audit.js'
import { inBackground, onShutdown } from './background.js'
import { TERMINAL_SHELL } from './config.js'
import { now, tasks } from './db.js'
import { HttpError } from './http.js'
import { planScope } from './memory-cap.js'
import { launch } from './memory-scope.js'
import { hostLimitsEnv, sandboxFor, sandboxStamp } from './session-options.js'
import { sandboxPolicy } from './store/sandbox.js'
import { terminalAudit, type AgentRef } from './terminal-audit.js'
import {
  FALLBACK_SHELL,
  hangUp,
  LOGIN_ARGS,
  loginEnv,
  loginShell,
  OutputFrames,
  Scrollback,
  spawnPty,
  TERM,
  type PtyOptions,
  type PtyProcess,
} from './terminal-io.js'

/** How long a terminal no browser shows keeps running, so a reload or reopened panel finds it. */
export const TERMINAL_GRACE_MS = 15 * 60_000
/** Live terminals at most, across agents and the home folder. */
const MAX_TERMINALS = 16
/** Names the memory scope of shells in the home folder, which belong to no agent. */
const HOME_SCOPE = 'home'
const WATCH_MS = 5000
/** Output queued to a browser past this pauses the shell until it drains below the low mark. */
const HIGH_WATER = 1024 * 1024
const LOW_WATER = 256 * 1024
const DRAIN_POLL_MS = 50
const TERMINAL_ENV = { TERM, COLORTERM: 'truecolor' }

/** One browser connection showing a terminal. */
export interface TerminalClient {
  output: (data: Buffer) => void
  message: (message: TerminalServerMessage) => void
  close: () => void
  /** Bytes sent to the browser and not yet on the wire, or 0 when the transport cannot tell. */
  backlog: () => number
}

const CLOSE_TEXT: Record<TerminalClose, string> = {
  exited: 'The shell exited',
  stopped: 'Stopped from Seti',
  replaced: 'Opened in another window',
  settings: "The agent's sandbox or directory changed",
  archived: 'The agent was archived',
  deleted: 'The agent was deleted',
  idle: 'No window showed it for 15 minutes',
  shutdown: 'Seti stopped',
  flood: 'The browser sent input too fast',
  failed: 'The shell could not start',
  gone: 'The shell ended while no window showed it',
}

/** What the user did; Seti ends a terminal for every other reason. */
const BY_USER: ReadonlySet<TerminalClose> = new Set(['exited', 'stopped'])

export const closedMessage = (reason: TerminalClose, code: number | null = null, detail = CLOSE_TEXT[reason]) =>
  ({ type: 'closed', reason, exit_code: code, detail }) satisfies TerminalServerMessage

/** Where a terminal runs: in an agent's directory and sandbox, or in the home folder. */
interface Place {
  task: Task | null
  cwd: string
}

const placeOf = (task: Task | null): Place => ({ task, cwd: task?.cwd ?? os.homedir() })

const terminals = new Map<string, Terminal>()

/** A shell that just started: its id, where it runs and what its process is made of. */
interface Started {
  id: string
  place: Place
  key: string
  pty: PtyProcess
  shell: string
  sandboxed: boolean
}

/** A shell in a pseudo-terminal, shown in at most one browser at a time. */
class Terminal {
  readonly id: string
  readonly taskId: string | null
  readonly key: string
  private readonly task: AgentRef | null
  private readonly info: Omit<TerminalStatus, 'attached' | 'ends_at'>
  private readonly pty: PtyProcess
  private readonly scrollback = new Scrollback()
  private readonly frames = new OutputFrames((data) => {
    this.client?.output(data)
    this.flow()
  })
  private client: TerminalClient | null = null
  private grace: NodeJS.Timeout | null = null
  private endsAt: number | null = null
  private drain: NodeJS.Timeout | null = null
  private closed: TerminalClose | null = null

  constructor({ id, place, key, pty, shell, sandboxed }: Started) {
    this.id = id
    this.taskId = place.task?.id ?? null
    this.task = place.task === null ? null : { id: place.task.id, title: place.task.title }
    this.key = key
    this.pty = pty
    this.info = { id, task_id: this.taskId, pid: pty.pid, shell, cwd: place.cwd, sandboxed, started_at: now() }
    pty.onData((text) => {
      this.output(text)
    })
    pty.once('exit', (code) => {
      this.exited(code)
    })
  }

  status(): TerminalStatus {
    const endsAt = this.endsAt === null ? null : new Date(this.endsAt).toISOString()
    return { ...this.info, attached: this.client !== null, ends_at: endsAt }
  }

  /** Names this shell in `ready`, so a browser that reconnects can resume where it was. */
  private readonly shell = randomUUID()

  attach(client: TerminalClient, size: TerminalSize, reattached: boolean, since: ShellPosition | null): void {
    const previous = this.client
    this.client = client
    if (previous !== null) {
      previous.message(closedMessage('replaced'))
      previous.close()
    }
    this.stopGrace()
    this.frames.clear()
    this.pty.resize(size.cols, size.rows)
    const missed = since?.shell === this.shell ? this.scrollback.since(since.at) : null
    const { from, bytes } =
      missed === null || since === null ? this.scrollback.kept() : { from: since.at, bytes: missed }
    const { sandboxed, cwd } = this.info
    client.message({ type: 'ready', reattached, shell: this.shell, from, sandboxed, cwd })
    if (bytes.length > 0) {
      client.output(bytes)
    }
    this.flow()
  }

  detach(client: TerminalClient): void {
    if (this.client !== client) {
      return
    }
    this.client = null
    this.frames.clear()
    this.flow()
    this.endsAt = Date.now() + TERMINAL_GRACE_MS
    this.grace = setTimeout(() => {
      this.end('idle')
    }, TERMINAL_GRACE_MS)
    this.grace.unref()
  }

  input(client: TerminalClient, data: string): void {
    if (client === this.client) {
      this.pty.write(data)
    }
  }

  resize(client: TerminalClient, size: TerminalSize): void {
    if (client === this.client) {
      this.pty.resize(size.cols, size.rows)
    }
  }

  /** Ends the shell and everything it started, and tells the browser showing it why. */
  end(reason: TerminalClose): void {
    if (this.closed !== null) {
      return
    }
    this.close(reason, null)
    hangUp(this.info.pid)
  }

  private exited(code: number | null): void {
    if (this.closed === null) {
      this.close('exited', code)
    }
  }

  private close(reason: TerminalClose, code: number | null): void {
    this.closed = reason
    if (terminals.get(this.id) === this) {
      terminals.delete(this.id)
    }
    this.frames.flush()
    this.frames.clear()
    this.stopGrace()
    if (this.drain !== null) {
      clearInterval(this.drain)
      this.drain = null
    }
    this.client?.message(closedMessage(reason, code))
    this.client?.close()
    this.client = null
    const { cwd, sandboxed, started_at } = this.info
    const detail = { terminal: this.id, reason, cwd, sandboxed, exit_code: code, opened_at: started_at }
    const entry = terminalAudit(this.task, true, `Closed a terminal (${CLOSE_TEXT[reason]})`, detail)
    inBackground('terminal: could not record its end', async () =>
      audit.record({ ...entry, actor: BY_USER.has(reason) ? 'user' : 'system' }),
    )
  }

  private stopGrace(): void {
    if (this.grace !== null) {
      clearTimeout(this.grace)
      this.grace = null
    }
    this.endsAt = null
  }

  private output(text: string): void {
    const chunk = Buffer.from(text, 'utf8')
    this.scrollback.add(chunk)
    if (this.client !== null) {
      this.frames.add(chunk)
    }
  }

  /** Pauses the shell while the browser falls behind and resumes it once it caught up. */
  private flow(): void {
    const backlog = this.client?.backlog() ?? 0
    if (this.drain === null && backlog > HIGH_WATER) {
      this.pty.pause()
      this.drain = setInterval(() => {
        this.flow()
      }, DRAIN_POLL_MS)
    } else if (this.drain !== null && backlog < LOW_WATER) {
      clearInterval(this.drain)
      this.drain = null
      this.pty.resume()
    }
  }
}

/** What the terminal's process is made of; a change in it means a new terminal. */
async function terminalKey({ task, cwd }: Place): Promise<string> {
  if (task === null) {
    return JSON.stringify({ cwd, sandbox: null })
  }
  const policy = await sandboxPolicy.get()
  const sandbox = policy.enabled && task.sandbox ? { ...(await sandboxStamp(task)), dirs: extraDirs(task) } : null
  return JSON.stringify({ cwd, sandbox })
}

/**
 * Starts the user's login shell as a terminal window does, in the agent's directory or the home
 * folder, in a scope held to its cap. In an agent's sandbox it starts bash with the sandbox's
 * environment instead: the sandbox's home is its own, so the user's rc files are not there.
 */
async function startTerminal(id: string, place: Place, key: string, size: TerminalSize): Promise<Terminal> {
  if (terminals.size >= MAX_TERMINALS) {
    throw new HttpError(429, `${String(MAX_TERMINALS)} terminals are open; close one to open another`)
  }
  const { task, cwd } = place
  if (!fs.existsSync(cwd)) {
    throw new HttpError(400, `Working directory ${cwd} no longer exists`)
  }
  const sandbox = task === null ? null : await sandboxFor(task)
  const scope = await planScope(task?.id ?? HOME_SCOPE, 'terminal')
  const start = (env: PtyOptions['env']) => (program: string, args: string[]) =>
    spawnPty(program, args, { cwd, env, size })
  let pty: PtyProcess
  let shell = FALLBACK_SHELL
  if (sandbox === null) {
    const { username, homedir } = os.userInfo()
    shell = TERMINAL_SHELL === '' ? loginShell() : loginShell(TERMINAL_SHELL)
    const runtime = scope === null ? {} : { XDG_RUNTIME_DIR: scope.host.runtimeDir }
    const env = { ...loginEnv(process.env, { username, homedir, shell }), ...hostLimitsEnv(scope?.cap ?? null) }
    pty = launch(scope, shell, [...LOGIN_ARGS], start({ ...env, ...runtime }))
  } else {
    const env = { ...sandbox.env, ...TERMINAL_ENV }
    const run = sandbox.command(shell, LOGIN_ARGS, { env, scope, interactive: true })
    pty = launch(scope, run.program, run.args, start(run.env))
  }
  const terminal = new Terminal({ id, place, key, pty, shell, sandboxed: sandbox !== null })
  terminals.set(id, terminal)
  watch()
  const detail = { terminal: id, cwd, sandboxed: sandbox !== null }
  await audit.record({ ...terminalAudit(task, false, 'Opened a terminal', detail), actor: 'user' })
  return terminal
}

const opening = new Map<string, Promise<unknown>>()

/** Runs one open of a terminal at a time, so two windows never start two shells for one tab. */
async function serially<T>(id: string, work: () => Promise<T>): Promise<T> {
  const next = (opening.get(id) ?? Promise.resolve()).then(work, work)
  opening.set(id, next)
  try {
    return await next
  } finally {
    if (opening.get(id) === next) {
      opening.delete(id)
    }
  }
}

/** The task when it may have a terminal: it exists and is not archived. */
async function terminalTask(taskId: string): Promise<Task> {
  const task = await tasks.get(taskId)
  if (task === undefined) {
    throw new HttpError(404, 'Task not found')
  }
  if (task.archived_at !== null) {
    throw new HttpError(409, `Agent "${task.title}" is archived; restore it to open a terminal`)
  }
  return task
}

/** Where terminal `id` may run for `taskId`; refused when the agent is gone or another owns it. */
export async function terminalPlace(id: string, taskId: string | null): Promise<Place> {
  const running = terminals.get(id)
  if (running !== undefined && running.taskId !== taskId) {
    throw new HttpError(409, 'This terminal runs for another agent')
  }
  return placeOf(taskId === null ? null : await terminalTask(taskId))
}

/** Which terminal a browser asks for, for which agent, and whether it may start a new shell. */
export interface TerminalRequest {
  id: string
  taskId: string | null
  /** Only reattach: a terminal that ended stays ended. */
  resume: boolean
  /** The shell and output the browser already has, from before it lost its socket. */
  since: ShellPosition | null
}

/** How far a browser got in a shell's output. */
interface ShellPosition {
  shell: string
  at: number
}

function refuse(client: TerminalClient, reason: TerminalClose): void {
  client.message(closedMessage(reason))
  client.close()
}

/**
 * Shows terminal `id` in `client`, starting it when it does not run and the browser asks for a
 * new shell. One whose agent's sandbox or directory changed ends first. A browser showing it
 * before loses it.
 */
export async function attachTerminal(request: TerminalRequest, client: TerminalClient, size: TerminalSize) {
  await serially(request.id, async () => {
    const place = await terminalPlace(request.id, request.taskId)
    const key = await terminalKey(place)
    let terminal = terminals.get(request.id)
    if (terminal !== undefined && terminal.key !== key) {
      terminal.end('settings')
      terminal = undefined
      if (request.resume) {
        refuse(client, 'settings')
        return
      }
    }
    if (terminal === undefined && request.resume) {
      refuse(client, 'gone')
      return
    }
    const reattached = terminal !== undefined
    terminal ??= await startTerminal(request.id, place, key, size)
    terminal.attach(client, size, reattached, request.since)
  })
}

/** The browser went away; the terminal keeps running for the grace period. */
export function detachTerminal(id: string, client: TerminalClient): void {
  terminals.get(id)?.detach(client)
}

export function writeTerminal(id: string, client: TerminalClient, data: string): void {
  terminals.get(id)?.input(client, data)
}

export function resizeTerminal(id: string, client: TerminalClient, size: TerminalSize): void {
  terminals.get(id)?.resize(client, size)
}

/** Ends every terminal of the agent, as it is archived or deleted. */
export function endAgentTerminals(taskId: string, reason: TerminalClose): void {
  for (const terminal of [...terminals.values()]) {
    if (terminal.taskId === taskId) {
      terminal.end(reason)
    }
  }
}

/** The user's stop, from its tab or the Processes view; returns what ran. */
export function stopTerminal(id: string): TerminalStatus {
  const terminal = terminals.get(id)
  if (terminal === undefined) {
    throw new HttpError(404, 'This terminal is no longer running')
  }
  const status = terminal.status()
  terminal.end('stopped')
  return status
}

export function terminalStatus(id: string): TerminalStatus | null {
  return terminals.get(id)?.status() ?? null
}

/** The agent's running terminals, oldest first. */
export function agentTerminals(taskId: string): TerminalStatus[] {
  return [...terminals.values()].filter((terminal) => terminal.taskId === taskId).map((terminal) => terminal.status())
}

/** Ends every terminal, as Seti stops. */
export function stopTerminals(): void {
  for (const terminal of [...terminals.values()]) {
    terminal.end('shutdown')
  }
}

onShutdown(async () => {
  stopTerminals()
  return Promise.resolve()
})

/** Ends agents' terminals whose agent is gone or archived, or whose sandbox or directory changed. */
export async function recheckTerminals(): Promise<void> {
  for (const terminal of [...terminals.values()]) {
    if (terminal.taskId === null) {
      continue
    }
    const task = await tasks.get(terminal.taskId)
    if (task === undefined) {
      terminal.end('deleted')
    } else if (task.archived_at !== null) {
      terminal.end('archived')
    } else if ((await terminalKey(placeOf(task))) !== terminal.key) {
      terminal.end('settings')
    }
  }
}

let watcher: NodeJS.Timeout | null = null

function watch(): void {
  watcher ??= setInterval(() => {
    if (terminals.size === 0 && watcher !== null) {
      clearInterval(watcher)
      watcher = null
      return
    }
    inBackground('terminal: could not check its settings', recheckTerminals)
  }, WATCH_MS)
  watcher.unref()
}
