import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import { serve, type WebSocketServerLike } from '@hono/node-server'
import type { AgentProcesses, Task, TerminalServerMessage } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { createApp } from './app.js'
import { archiveTask } from './archive.js'
import { tasks } from './db.js'
import { fakeTimers } from './fake-timers.js'
import type * as SessionOptions from './session-options.js'
import { auditEvents } from './store/audit.js'
import type { TaskSandbox } from './task-sandbox.js'
import type * as TerminalIo from './terminal-io.js'
import { InputBudget, Scrollback } from './terminal-io.js'
import {
  attachTerminal,
  detachTerminal,
  recheckTerminals,
  TERMINAL_GRACE_MS,
  terminalStatus,
  type TerminalClient,
} from './terminal.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = realpathSync(mkdtempSync(nodePath.join(tmpdir(), 'seti-terminal-test-')))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

const SANDBOXED = 'terminal-sandboxed'
const SECRET = 'sk-ant-api03-terminal-test-secret'

/** What the sandboxed task's launcher was asked to run, and the environment it got. */
const launched = vi.hoisted(() => [] as { program: string; args: readonly string[]; env: Record<string, unknown> }[])

const fakeSandbox = (): TaskSandbox => {
  const env = { PATH: process.env.PATH ?? '', HOME: scratch, SETI_SANDBOX: '1' }
  return {
    env,
    spawn: () => {
      throw new Error('A terminal starts its own process')
    },
    command: (program, args, options = {}) => {
      const given = { ...(options.env ?? env) }
      launched.push({ program, args, env: { ...given, interactive: options.interactive } })
      return { program: '/usr/bin/env', args: ['SANDBOX_MARK=inside', program, ...args], env: given }
    },
  }
}

/** What the host shell was started as, with the environment it got. */
const spawned = vi.hoisted(() => [] as { program: string; args: string[]; env: Record<string, string | undefined> }[])

/** Bash stands in for the account's shell, so the developer's own zsh setup never runs here. */
vi.mock('./terminal-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof TerminalIo>()
  return {
    ...actual,
    loginShell: () => '/bin/bash',
    spawnPty: ((program, args, options) => {
      spawned.push({ program, args, env: options.env })
      return actual.spawnPty(program, args, options)
    }) satisfies typeof actual.spawnPty,
  }
})

vi.mock('./session-options.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionOptions>()
  return {
    ...actual,
    sandboxFor: async (task: Task) => Promise.resolve(task.id === SANDBOXED ? fakeSandbox() : null),
  }
})

const app = createApp()
const sockets = new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0, websocket: { server: sockets } })
let origin = ''

const UPGRADE = {
  upgrade: 'websocket',
  connection: 'Upgrade',
  'sec-websocket-version': '13',
  'sec-websocket-key': randomBytes(16).toString('base64'),
}

let made = 0

async function newTask(sandbox = false): Promise<string> {
  made += 1
  const id = sandbox ? SANDBOXED : `terminal-${String(made)}`
  await tasks.insert({ id, title: `Terminal ${id}`, repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
  await tasks.setSandbox(id, sandbox)
  return id
}

function text(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8')
  }
  return (Buffer.isBuffer(data) ? data : Buffer.from(new Uint8Array(data))).toString('utf8')
}

interface Session {
  id: string
  ws: WebSocket
  messages: TerminalServerMessage[]
  output: () => string
  /** Bytes of output received, as a browser counts how far it got. */
  received: () => number
  type: (data: string) => void
}

interface Opening {
  /** The agent the shell runs for; none opens it in the home folder. */
  task?: string
  /** A tab's terminal id, to open it again; a new one by default. */
  id?: string
  resume?: boolean
  /** The shell and output the browser has, to resume from. */
  since?: { shell: string; at: number }
}

function terminalUrl({ task, id = randomUUID(), resume = false, since }: Opening, size = 'cols=100&rows=30'): string {
  const query = new URLSearchParams(size)
  if (task !== undefined) {
    query.set('task', task)
  }
  if (resume) {
    query.set('resume', '1')
  }
  if (since !== undefined) {
    query.set('shell', since.shell)
    query.set('at', String(since.at))
  }
  return `/api/terminals/${id}?${query.toString()}`
}

/** Opens a terminal socket and waits for its first message, `ready` unless `first` says otherwise. */
async function open(opening: Opening = {}, first: TerminalServerMessage['type'] = 'ready'): Promise<Session> {
  const id = opening.id ?? randomUUID()
  const url = `${origin.replace('http', 'ws')}${terminalUrl({ ...opening, id })}`
  const ws = new WebSocket(url, { headers: { origin, ...USER_AUTH } })
  const messages: TerminalServerMessage[] = []
  let output = ''
  let received = 0
  ws.on('message', (data, binary) => {
    if (binary) {
      output += text(data)
      received += Buffer.byteLength(text(data))
    } else {
      messages.push(JSON.parse(text(data)) as TerminalServerMessage)
    }
  })
  await once(ws, 'open')
  await vi.waitFor(() => {
    expect(messages[0]?.type).toBe(first)
  })
  return {
    id,
    ws,
    messages,
    output: () => output,
    received: () => received,
    type: (data) => {
      ws.send(JSON.stringify({ type: 'input', data }))
    },
  }
}

async function closed(session: Session) {
  await vi.waitFor(() => {
    expect(session.messages.some((m) => m.type === 'closed')).toBe(true)
  })
  return session.messages.find((m) => m.type === 'closed')
}

async function gone(pid: number): Promise<void> {
  await vi.waitFor(() => {
    expect(() => process.kill(pid, 0)).toThrow()
  })
}

const status = (id: string) => {
  const found = terminalStatus(id)
  if (found === null) {
    throw new Error('No terminal')
  }
  return found
}

beforeAll(async () => {
  if (!server.listening) {
    await once(server, 'listening')
  }
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  process.env.ANTHROPIC_API_KEY = SECRET
})

afterAll(() => {
  delete process.env.ANTHROPIC_API_KEY
  server.close()
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('the terminal socket', () => {
  it('opens a login shell in the agent directory as the user, with no Anthropic key', async () => {
    const id = await newTask()
    const session = await open({ task: id })
    expect(session.messages[0]).toEqual({
      type: 'ready',
      reattached: false,
      shell: expect.any(String) as string,
      from: 0,
      sandboxed: false,
      cwd: scratch,
    })
    session.type('pwd; echo "key=${ANTHROPIC_API_KEY-none} term=$TERM sum=$((40+2))"\r')
    await vi.waitFor(() => {
      expect(session.output()).toContain(`${scratch}\r\nkey=none term=xterm-256color sum=42`)
    })
    expect(session.output()).not.toContain(SECRET)
    expect(await auditEvents.latest('task.terminal_opened')).toMatchObject({
      actor: 'user',
      subject_id: id,
      detail: { terminal: session.id, cwd: scratch, sandboxed: false },
    })
    session.ws.close()
  })

  it("starts the login shell interactively, with the session environment and none of Seti's", async () => {
    const saved = { ...process.env }
    Object.assign(process.env, {
      LANG: 'C.UTF-8',
      LC_TIME: 'C.UTF-8',
      ZDOTDIR: '/nowhere',
      npm_config_recursive: 'true',
      PATH: `/srv/seti-live/node_modules/.bin:${process.env.PATH ?? ''}`,
    })
    spawned.length = 0
    try {
      const session = await open()
      const { username, homedir } = os.userInfo()
      expect(spawned).toHaveLength(1)
      const [start] = spawned
      expect(start).toMatchObject({ program: '/bin/bash', args: ['-l', '-i'] })
      expect(start?.env).toMatchObject({
        HOME: homedir,
        USER: username,
        LOGNAME: username,
        SHELL: '/bin/bash',
        LANG: 'C.UTF-8',
        LC_TIME: 'C.UTF-8',
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      })
      expect(start?.env.PATH?.split(':')).not.toContain('/srv/seti-live/node_modules/.bin')
      expect(start?.env.PATH?.split(':')).toContain('/usr/bin')
      for (const name of ['ZDOTDIR', 'npm_config_recursive', 'SETI_DATABASE_URL', 'SETI_HOME', 'ANTHROPIC_API_KEY']) {
        expect(start?.env).not.toHaveProperty(name)
      }
      expect(status(session.id).shell).toBe('/bin/bash')
      session.type('shopt -q login_shell && [[ $- == *i* ]] && echo "login+i color=$COLORTERM z=${ZDOTDIR-no}"\r')
      await vi.waitFor(() => {
        expect(session.output()).toContain('login+i color=truecolor z=no')
      })
      session.ws.close()
    } finally {
      for (const name of ['LANG', 'LC_TIME', 'ZDOTDIR', 'npm_config_recursive', 'PATH']) {
        if (saved[name] === undefined) {
          Reflect.deleteProperty(process.env, name)
        } else {
          process.env[name] = saved[name]
        }
      }
    }
  })

  it('opens a shell outside any agent in the home folder, audited as the system', async () => {
    const session = await open()
    expect(session.messages[0]).toEqual({
      type: 'ready',
      reattached: false,
      shell: expect.any(String) as string,
      from: 0,
      sandboxed: false,
      cwd: os.homedir(),
    })
    expect(status(session.id)).toMatchObject({ task_id: null, cwd: os.homedir(), sandboxed: false })
    session.type('echo "key=${ANTHROPIC_API_KEY-none}"\r')
    await vi.waitFor(() => {
      expect(session.output()).toContain('key=none')
    })
    expect(await auditEvents.latest('system.terminal_opened')).toMatchObject({
      actor: 'user',
      subject_type: 'system',
      detail: { terminal: session.id, cwd: os.homedir(), sandboxed: false },
    })
    session.type('exit\r')
    expect(await closed(session)).toMatchObject({ reason: 'exited' })
  })

  it('runs a shell for each tab of one agent, each reattached by its own id', async () => {
    const id = await newTask()
    const first = await open({ task: id })
    const second = await open({ task: id })
    expect(status(first.id).pid).not.toBe(status(second.id).pid)
    first.type('echo first-$((1+1))\r')
    await vi.waitFor(() => {
      expect(first.output()).toContain('first-2')
    })
    first.ws.close()
    const again = await open({ task: id, id: first.id, resume: true })
    expect(again.messages[0]).toMatchObject({ type: 'ready', reattached: true })
    expect(again.output()).toContain('first-2')
    expect(second.output()).not.toContain('first-2')
    again.ws.close()
    second.ws.close()
  })

  it('resumes a browser that lost its socket from where it got to, and replays all for another shell', async () => {
    const task = await newTask()
    const first = await open({ task })
    first.type('echo before-$((1+1))\r')
    await vi.waitFor(() => {
      expect(first.output()).toContain('before-2')
    })
    const ready = first.messages[0]
    if (ready?.type !== 'ready') {
      throw new Error('No ready message')
    }
    const at = ready.from + first.received()
    first.ws.close()
    await vi.waitFor(() => {
      expect(status(first.id).attached).toBe(false)
    })

    const resumed = await open({ task, id: first.id, resume: true, since: { shell: ready.shell, at } })
    expect(resumed.messages[0]).toMatchObject({ type: 'ready', reattached: true, shell: ready.shell, from: at })
    resumed.type('echo after-$((2+2))\r')
    await vi.waitFor(() => {
      expect(resumed.output()).toContain('after-4')
    })
    expect(resumed.output()).not.toContain('before-2')
    resumed.ws.close()
    await vi.waitFor(() => {
      expect(status(first.id).attached).toBe(false)
    })

    const elsewhere = await open({ task, id: first.id, resume: true, since: { shell: randomUUID(), at } })
    expect(elsewhere.messages[0]).toMatchObject({ type: 'ready', shell: ready.shell, from: 0 })
    expect(elsewhere.output()).toContain('before-2')
    expect(elsewhere.output()).toContain('after-4')
    elsewhere.type('exit\r')
    expect(await closed(elsewhere)).toMatchObject({ reason: 'exited' })
  })

  it('tells a tab that comes back for an ended shell that it ended, and starts none', async () => {
    const session = await open({ resume: true }, 'closed')
    expect(session.messages[0]).toMatchObject({ type: 'closed', reason: 'gone' })
    expect(terminalStatus(session.id)).toBeNull()
  })

  it('reattaches within the grace period with what the shell printed, one window at a time', async () => {
    const task = await newTask()
    const first = await open({ task })
    const { id } = first
    first.type('echo marker-$((6*7))\r')
    await vi.waitFor(() => {
      expect(first.output()).toContain('marker-42')
    })
    const { pid } = status(id)
    first.ws.close()
    await vi.waitFor(() => {
      expect(status(id)).toMatchObject({ pid, attached: false, ends_at: expect.any(String) as string })
    })

    const second = await open({ task, id, resume: true })
    expect(second.messages[0]).toMatchObject({ type: 'ready', reattached: true })
    expect(second.output()).toContain('marker-42')
    expect(status(id)).toMatchObject({ pid, attached: true, ends_at: null })

    const third = await open({ task, id, resume: true })
    expect(await closed(second)).toMatchObject({ reason: 'replaced' })
    third.type('exit\r')
    expect(await closed(third)).toMatchObject({ reason: 'exited', exit_code: 0 })
    expect(terminalStatus(id)).toBeNull()
    await gone(pid)
  })

  it('shows in the Processes view and stops from there', async () => {
    const id = await newTask()
    const session = await open({ task: id })
    const headers = { host: '127.0.0.1', origin, ...USER_AUTH }
    const view = async () =>
      ((await (await app.request(`/api/tasks/${id}/processes`, { headers })).json()) as { data: AgentProcesses }).data
    const { pid } = status(session.id)
    expect(await view()).toMatchObject({
      terminals: [{ id: session.id, task_id: id, pid, shell: '/bin/bash', sandboxed: false }],
      running: 1,
    })

    const stop = async () =>
      app.request(`/api/terminals/${session.id}/stop`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: '{}',
      })
    expect((await stop()).status).toBe(200)
    expect(await closed(session)).toMatchObject({ reason: 'stopped' })
    await gone(pid)
    expect(await view()).toMatchObject({ terminals: [], running: 0 })
    expect((await stop()).status).toBe(404)
    await vi.waitFor(async () => {
      expect(await auditEvents.latest('task.terminal_closed')).toMatchObject({
        actor: 'user',
        subject_id: id,
        detail: { reason: 'stopped' },
      })
    })
  })

  it('ends the terminal when the agent is archived', async () => {
    const id = await newTask()
    const session = await open({ task: id })
    const home = await open()
    const { pid } = status(session.id)
    await archiveTask(id, { actor: 'user', removeWorktree: false })
    expect(await closed(session)).toMatchObject({ reason: 'archived' })
    expect(terminalStatus(session.id)).toBeNull()
    expect(terminalStatus(home.id)).not.toBeNull()
    await gone(pid)
    home.ws.close()
  })

  it("ends the terminal when the agent's sandbox setting changes", async () => {
    const id = await newTask()
    const session = await open({ task: id })
    const { pid } = status(session.id)
    await recheckTerminals()
    expect(terminalStatus(session.id)).not.toBeNull()
    await tasks.setSandbox(id, true)
    await recheckTerminals()
    expect(await closed(session)).toMatchObject({ reason: 'settings' })
    await gone(pid)
    await vi.waitFor(async () => {
      expect(await auditEvents.latest('task.terminal_closed')).toMatchObject({
        actor: 'system',
        subject_id: id,
        detail: { reason: 'settings' },
      })
    })
  })

  it("starts through the agent's sandbox launcher, with only the sandbox's environment", async () => {
    await newTask(true)
    const session = await open({ task: SANDBOXED })
    expect(session.messages[0]).toMatchObject({ type: 'ready', sandboxed: true })
    session.type('echo "mark=$SANDBOX_MARK sandbox=$SETI_SANDBOX"\r')
    await vi.waitFor(() => {
      expect(session.output()).toContain('mark=inside sandbox=1')
    })
    expect(launched).toEqual([
      {
        program: '/bin/bash',
        args: ['-l', '-i'],
        env: {
          PATH: process.env.PATH ?? '',
          HOME: scratch,
          SETI_SANDBOX: '1',
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          interactive: true,
        },
      },
    ])
    session.ws.close()
  })

  it('ends a terminal no window shows once the grace period is over', async () => {
    const task = await newTask()
    const id = randomUUID()
    const client: TerminalClient = { output: vi.fn(), message: vi.fn(), close: vi.fn(), backlog: () => 0 }
    await attachTerminal({ id, taskId: task, resume: false, since: null }, client, { cols: 80, rows: 24 })
    const { pid } = status(id)
    await fakeTimers(['setTimeout', 'clearTimeout'])
    try {
      detachTerminal(id, client)
      vi.advanceTimersByTime(TERMINAL_GRACE_MS - 1000)
      expect(terminalStatus(id)).not.toBeNull()
      vi.advanceTimersByTime(1000)
      expect(terminalStatus(id)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
    await gone(pid)
    await vi.waitFor(async () => {
      expect(await auditEvents.latest('task.terminal_closed')).toMatchObject({
        actor: 'system',
        subject_id: task,
        detail: { terminal: id, reason: 'idle' },
      })
    })
  })
})

describe('terminal refusals', () => {
  const request = async (opening: Opening, headers: Record<string, string>, size?: string) =>
    app.request(terminalUrl(opening, size), { headers: { host: '127.0.0.1', ...UPGRADE, ...headers } })
  const detail = async (res: Response) => ((await res.json()) as { error: { detail: string } }).error.detail

  it('needs the local token, Seti as the origin and a WebSocket', async () => {
    const task = await newTask()
    const id = randomUUID()
    expect((await request({ task, id }, { origin })).status).toBe(401)
    const foreign = await request({ task, id }, { origin: 'https://evil.example', ...USER_AUTH })
    expect(foreign.status).toBe(403)
    expect((await request({ task, id }, USER_AUTH)).status).toBe(403)
    const plain = await app.request(terminalUrl({ task, id }), {
      headers: { host: '127.0.0.1', origin, ...USER_AUTH },
    })
    expect(plain.status).toBe(426)
    expect((await request({ task, id }, { origin, ...USER_AUTH }, 'cols=0&rows=24')).status).toBe(400)
    const notUuid = await app.request('/api/terminals/not-a-uuid?cols=80&rows=24', {
      headers: { host: '127.0.0.1', ...UPGRADE, origin, ...USER_AUTH },
    })
    expect(notUuid.status).toBe(400)
    expect((await request({ task: 'missing', id }, { origin, ...USER_AUTH })).status).toBe(404)
    expect(terminalStatus(id)).toBeNull()
  })

  it("never shows one agent's terminal for another agent or outside it", async () => {
    const owner = await newTask()
    const session = await open({ task: owner })
    const other = await newTask()
    const asOther = await request({ task: other, id: session.id, resume: true }, { origin, ...USER_AUTH })
    expect(asOther.status).toBe(409)
    expect((await request({ id: session.id, resume: true }, { origin, ...USER_AUTH })).status).toBe(409)
    session.ws.close()
  })

  it('never opens or stops a terminal for the EA', async () => {
    const task = await newTask()
    const opened = await request({ task }, { origin, ...EA_AUTH })
    expect(opened.status).toBe(403)
    expect(await detail(opened)).toBe('The EA cannot open a terminal; the user does that in Seti')
    expect((await request({}, { origin, ...EA_AUTH })).status).toBe(403)
    const session = await open({ task })
    const stopped = await app.request(`/api/terminals/${session.id}/stop`, {
      method: 'POST',
      headers: { host: '127.0.0.1', origin, ...EA_AUTH, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(stopped.status).toBe(403)
    expect(terminalStatus(session.id)).not.toBeNull()
    session.ws.close()
  })

  it('refuses an archived agent', async () => {
    const task = await newTask()
    await archiveTask(task, { actor: 'user', removeWorktree: false })
    expect((await request({ task }, { origin, ...USER_AUTH })).status).toBe(409)
  })
})

describe('the login shell', () => {
  const actual = async () => vi.importActual<typeof TerminalIo>('./terminal-io.js')

  it("is the account's shell, or bash when it refuses logins or is missing", async () => {
    const { loginShell } = await actual()
    expect(loginShell('/bin/sh')).toBe('/bin/sh')
    expect(loginShell('/usr/sbin/nologin')).toBe('/bin/bash')
    expect(loginShell('/bin/false')).toBe('/bin/bash')
    expect(loginShell('zsh')).toBe('/bin/bash')
    expect(loginShell('/no/such/shell')).toBe('/bin/bash')
    expect(loginShell(null)).toBe('/bin/bash')
  })

  it('keeps PATH entries but the ones pnpm adds for the server', async () => {
    const { sessionPath } = await actual()
    const path = '/a/node_modules/.bin:/c/pnpm/dist/node-gyp-bin:/home/u/.local/bin::/usr/bin'
    expect(sessionPath(path)).toBe('/home/u/.local/bin:/usr/bin')
  })
})

describe('Scrollback', () => {
  it('keeps the newest output, cut at a line start', () => {
    const scrollback = new Scrollback(16)
    scrollback.add(Buffer.from('first line\nsecond\n'))
    scrollback.add(Buffer.from('third line\n'))
    expect(scrollback.kept()).toEqual({ from: 18, bytes: Buffer.from('third line\n') })
    scrollback.add(Buffer.from('x'.repeat(40)))
    expect(scrollback.kept()).toEqual({ from: 53, bytes: Buffer.from('x'.repeat(16)) })
  })

  it('gives the output after an offset it still holds, and null for one cut away or ahead', () => {
    const scrollback = new Scrollback(16)
    scrollback.add(Buffer.from('abc\n'))
    scrollback.add(Buffer.from('def\n'))
    expect(scrollback.since(4)?.toString()).toBe('def\n')
    expect(scrollback.since(8)?.toString()).toBe('')
    expect(scrollback.since(9)).toBeNull()
    scrollback.add(Buffer.from('y'.repeat(30)))
    expect(scrollback.since(4)).toBeNull()
    expect(scrollback.since(38)?.toString()).toBe('')
  })
})

describe('InputBudget', () => {
  it('allows bursts up to two seconds of input and refills over time', () => {
    let at = 0
    const budget = new InputBudget({ bytes: 100, frames: 10 }, () => at)
    expect(budget.take(150)).toBe(true)
    expect(budget.take(60)).toBe(false)
    at = 2000
    expect(budget.take(100)).toBe(true)
    for (let frame = 0; frame < 19; frame += 1) {
      budget.take(0)
    }
    expect(budget.take(0)).toBe(false)
  })
})
