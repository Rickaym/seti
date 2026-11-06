import fs from 'node:fs'
import path from 'node:path'
import { type CommandCatalog, type MessagePage, type MessageRow, type ShellResult, type TaskEvent } from '@seti/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { messages, tasks } from './db.js'
import { modHost } from './mods/bundled.js'
import { isRunning, stopTurn, subscribe } from './runner.js'
import { runShell } from './shell.js'
import { auditEvents } from './store/audit.js'
import { USER_AUTH } from './test-auth.js'
import { withBundledMods } from './test-mods.js'
import { waitIdle } from './wait-idle.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-shell-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

/** Turns record their prompt and finish at once or wait for Stop; probes list commands. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, aborted, fakeResult } = await import('./fake-sdk.js')
  const state = { prompts: [] as string[], hang: false }
  const fake = new FakeSdk(async function* ({ text, signal }) {
    state.prompts.push(text)
    if (state.hang) {
      await aborted(signal)
      return
    }
    yield fakeResult()
  })
  const probe = {
    initializationResult: async () =>
      Promise.resolve({
        commands: [
          { name: 'btw', description: 'Claude Code side question', argumentHint: '<question>', builtin: true },
          { name: 'compact', description: 'Free up context', argumentHint: '<optional instructions>', builtin: true },
          { name: 'color', description: 'Set the prompt bar color', argumentHint: '', builtin: true },
          { name: '__remote-workflow', description: 'internal', argumentHint: '', builtin: true },
          { name: 'slack:standup', description: 'Standup update', argumentHint: '' },
        ],
        agents: [],
        models: [],
        account: {},
      }),
    mcpServerStatus: async () => Promise.resolve([]),
    close: () => undefined,
  }
  const query = (params: Parameters<typeof fake.query>[0]) =>
    params.options?.perTaskStopAffordance === true ? fake.query(params) : probe
  return { state, query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const TASK = 'shell-task'
const app = createApp()
const headers = { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' }

withBundledMods()

const post = async (url: string, body: unknown = {}) =>
  app.request(`/api/tasks/${TASK}${url}`, { method: 'POST', headers, body: JSON.stringify(body) })

/** Resolves with the next finished shell run of the task. */
async function nextShell(taskId = TASK): Promise<ShellResult> {
  return new Promise((resolve) => {
    const stop = subscribe(taskId, (event: TaskEvent) => {
      if (event.type === 'message' && event.row.kind === 'shell') {
        stop()
        resolve(event.row.payload)
      }
    })
  })
}

async function shell(command: string): Promise<ShellResult> {
  const done = nextShell()
  const res = await post('/shell', { command })
  expect(res.status).toBe(200)
  return done
}

beforeAll(async () => {
  await tasks.insert({ id: TASK, title: 'Shell', repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
})

beforeEach(() => {
  sdk.state.prompts.length = 0
  sdk.state.hang = false
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('POST /api/tasks/:id/shell', () => {
  it('runs in the task directory and records the output as a shell message', async () => {
    fs.writeFileSync(path.join(scratch, 'marker.txt'), 'x')
    const result = await shell('pwd; ls')
    expect(result).toMatchObject({ command: 'pwd; ls', cwd: scratch, exit_code: 0, ended_by: null, stderr: '' })
    expect(result.stdout).toContain(`${fs.realpathSync(scratch)}\n`)
    expect(result.stdout).toContain('marker.txt')
    expect((await messages.page(TASK, 1)).messages[0]).toMatchObject({
      kind: 'shell',
      payload: { run_id: result.run_id },
    })
  })

  it('keeps the exit code and stderr of a failing command', async () => {
    const result = await shell('echo out; echo oops >&2; exit 3')
    expect(result).toMatchObject({ exit_code: 3, stdout: 'out\n', stderr: 'oops\n', ended_by: null })
  })

  it('publishes progress while the command runs', async () => {
    const seen: string[] = []
    const stop = subscribe(TASK, (event) => {
      if (event.type === 'shell') {
        seen.push(event.progress.stdout)
      }
    })
    await shell('echo first; sleep 0.6; echo second')
    stop()
    expect(seen[0]).toBe('')
    expect(seen).toContain('first\n')
  })

  it('ends a command that runs past the timeout', async () => {
    const task = await tasks.get(TASK)
    if (!task) {
      throw new Error('missing task')
    }
    const done = nextShell()
    await runShell(task, 'sleep 30', 1000)
    expect(await done).toMatchObject({ ended_by: 'timeout', exit_code: null, signal: 'SIGTERM' })
  })

  it('stops on request, keeping the output so far, and refuses a second command meanwhile', async () => {
    const command = 'echo started; sleep 30'
    const done = nextShell()
    const started = new Promise<void>((resolve) => {
      const stop = subscribe(TASK, (event) => {
        if (event.type === 'shell' && event.progress.stdout === 'started\n') {
          stop()
          resolve()
        }
      })
    })
    expect((await post('/shell', { command })).status).toBe(200)
    const second = await post('/shell', { command: 'ls' })
    expect(second.status).toBe(409)
    await started
    expect((await post('/shell/stop')).status).toBe(200)
    expect(await done).toMatchObject({ ended_by: 'user', exit_code: null, stdout: 'started\n' })
    expect((await post('/shell/stop')).status).toBe(409)
    const stopped = (await auditEvents.page({ kind: 'task.shell_stopped', limit: 1 })).events[0]
    expect(stopped).toMatchObject({ actor: 'user', subject_id: TASK, detail: { command } })
  })

  it('records the command in the audit log with secrets scrubbed', async () => {
    const token = ['abcdef', '0123456789'].join('')
    await shell(`echo curl -H "Authorization: Bearer ${token}" https://example.invalid`)
    const [event] = (await auditEvents.page({ kind: 'task.shell_run', limit: 1 })).events
    expect(event).toMatchObject({ actor: 'user', subject_type: 'task', subject_id: TASK })
    expect(JSON.stringify(event)).not.toContain(token)
    expect(event?.summary).toContain('[redacted]')
    expect(event?.detail.cwd).toBe(scratch)
  })

  it('rejects an empty command and an unknown task', async () => {
    expect((await post('/shell', { command: '   ' })).status).toBe(400)
    const res = await app.request('/api/tasks/missing/shell', {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: 'ls' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/tasks/:id/messages with /btw', () => {
  it('refuses it with the side chat on or off, so a side question never reaches the agent', async () => {
    for (const on of [true, false]) {
      await modHost.setEnabled('side-chat', on)
      for (const prompt of ['/btw why?', '  /BTW', '/btw']) {
        const res = await post('/messages', { prompt })
        expect(res.status).toBe(400)
        expect(await res.text()).toContain(on ? 'never goes to the agent' : 'Side chat, which is off')
      }
    }
    await modHost.setEnabled('side-chat', true)
    expect(sdk.state.prompts).toEqual([])
  })
})

describe('shell commands and agent turns', () => {
  it('refuses a shell command while the agent works, and a turn while a command runs', async () => {
    sdk.state.hang = true
    expect((await post('/messages', { prompt: 'work' })).status).toBe(200)
    expect(isRunning(TASK)).toBe(true)
    const refused = await post('/shell', { command: 'ls' })
    expect(refused.status).toBe(409)
    await stopTurn(TASK)
    await waitIdle(TASK)

    const done = nextShell()
    expect((await post('/shell', { command: 'sleep 10' })).status).toBe(200)
    expect((await post('/messages', { prompt: 'too early' })).status).toBe(409)
    await post('/shell/stop')
    await done
  })

  it('prepends the shell runs since the last turn to the next prompt only', async () => {
    expect((await post('/messages', { prompt: 'baseline' })).status).toBe(200)
    await waitIdle(TASK)
    await shell('echo seti-context-one')
    await shell('echo nope >&2; exit 2')
    expect((await post('/messages', { prompt: '/compact' })).status).toBe(200)
    await waitIdle(TASK)
    expect((await post('/messages', { prompt: 'What did I run?' })).status).toBe(200)
    await waitIdle(TASK)
    expect((await post('/messages', { prompt: 'And now?' })).status).toBe(200)
    await waitIdle(TASK)

    const [baseline, compact, asked, followUp] = sdk.state.prompts
    expect(
      baseline?.endsWith(
        '<bash-input>sleep 10</bash-input>\n<bash-exit-code>ended by user</bash-exit-code>\n<bash-stdout></bash-stdout>\n<bash-stderr></bash-stderr>\n\nThe message from the user follows.\n\nbaseline',
      ),
    ).toBe(true)
    expect(compact).toBe('/compact')
    expect(asked).toContain('The user ran these commands in the task directory')
    expect(asked).toContain('<bash-input>echo seti-context-one</bash-input>')
    expect(asked).toContain('<bash-stdout>seti-context-one\n</bash-stdout>')
    expect(asked).toContain('<bash-exit-code>2</bash-exit-code>\n<bash-stdout></bash-stdout>\n<bash-stderr>nope\n')
    expect(asked?.endsWith('\n\nWhat did I run?')).toBe(true)
    expect(asked).not.toContain('sleep 10')
    expect(followUp).toBe('And now?')

    const prompts = (await messages.page(TASK, 50)).messages.flatMap((row) =>
      row.kind === 'prompt' ? [row.payload.text] : [],
    )
    expect(prompts.slice(-2)).toEqual(['What did I run?', 'And now?'])
  })
})

describe('shell messages in the transcript', () => {
  const get = async (url: string) => app.request(`/api/tasks/${TASK}${url}`, { headers })

  it('trims long output on the wire and serves the stored message in full', async () => {
    const big = await shell('head -c 200000 /dev/zero | tr "\\0" "y"; echo; echo END-OF-OUTPUT')
    expect(big.stdout).toContain('END-OF-OUTPUT')
    const page = ((await (await get('/messages?limit=1')).json()) as { data: MessagePage }).data
    const [row] = page.messages
    expect(row?.trimmed).toEqual(['stdout'])
    expect(row?.kind === 'shell' && row.payload.stdout).toContain('[trimmed for display: first 16 KB of 196 KB shown]')
    expect(row?.kind === 'shell' && row.payload.stdout).not.toContain('END-OF-OUTPUT')
    expect(page.has_older).toBe(true)

    const full = ((await (await get(`/messages/${String(row?.id)}`)).json()) as { data: MessageRow }).data
    expect(full.trimmed).toBeUndefined()
    expect(full.kind === 'shell' && full.payload.stdout).toContain('END-OF-OUTPUT')
  })

  it('pages through shell rows like any other message', async () => {
    const all = (await messages.page(TASK, 500)).messages
    const shells = all.filter((row) => row.kind === 'shell')
    expect(shells.length).toBeGreaterThan(5)
    const middle = shells[2]?.id ?? 0
    const before = ((await (await get(`/messages?before=${String(middle)}&limit=2`)).json()) as { data: MessagePage })
      .data
    expect(before.messages.map((row) => row.id)).toEqual(
      all
        .filter((row) => row.id < middle)
        .slice(-2)
        .map((r) => r.id),
    )
  })
})

describe('GET /api/tasks/:id/stream', () => {
  it('sends shell progress events and then the finished shell message', async () => {
    const res = await app.request(`/api/tasks/${TASK}/stream?tail=1`, { headers })
    const body: ReadableStream<Uint8Array> | null = res.body
    const reader = body?.getReader()
    if (!reader) {
      throw new Error('no body')
    }
    const done = nextShell()
    expect((await post('/shell', { command: 'echo streamed; sleep 0.3' })).status).toBe(200)
    const decoder = new TextDecoder()
    let text = ''
    while (!/event: message\ndata: [^\n]*"kind":"shell"/.test(text)) {
      const chunk = await reader.read()
      text += decoder.decode(chunk.value, { stream: true })
    }
    await reader.cancel()
    await done
    const events = [...text.matchAll(/^event: (\w+)$/gm)].map((match) => match[1])
    expect(events[0]).toBe('backlog')
    expect(events.indexOf('shell')).toBeGreaterThan(0)
    expect(events.at(-1)).toBe('message')
    expect(text).toContain('"stdout":"streamed\\n"')
  })
})

describe('GET /api/tasks/:id/commands', () => {
  it('lists the commands of the task directory with unsupported ones flagged and internal ones hidden', async () => {
    const res = await app.request(`/api/tasks/${TASK}/commands`, { headers })
    expect(res.status).toBe(200)
    const catalog = ((await res.json()) as { data: CommandCatalog }).data
    expect(catalog).toMatchObject({ cwd: scratch, fresh: true, approximate: false })
    expect(catalog.commands.map((c) => [c.name, c.builtin, c.unsupported !== null])).toEqual([
      ['btw', true, false],
      ['color', true, true],
      ['compact', true, false],
      ['slack:standup', false, false],
    ])
    expect(catalog.commands[0]).toMatchObject({ name: 'btw', argument_hint: '[question]', builtin: true })
    expect(catalog.commands[0]?.description).toBe('Ask a side question; the agent is not interrupted')
  })

  it('serves directory lists for the New task dialog and rejects missing directories', async () => {
    const ok = await app.request(`/api/commands?cwd=${encodeURIComponent(scratch)}`, { headers })
    expect(ok.status).toBe(200)
    const listed = ((await ok.json()) as { data: CommandCatalog }).data.commands
    expect(listed.find((c) => c.name === 'btw')?.description).toBe('Claude Code side question')
    const missing = await app.request(`/api/commands?cwd=${encodeURIComponent(path.join(scratch, 'nope'))}`, {
      headers,
    })
    expect(missing.status).toBe(400)
    expect((await app.request('/api/commands?cwd=relative/dir', { headers })).status).toBe(400)
  })
})
