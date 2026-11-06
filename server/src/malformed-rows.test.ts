import fs from 'node:fs'
import type {
  AgentProcesses,
  DigestLine,
  MessagePage,
  MessageRow,
  SearchResult,
  ShellResult,
  SubtaskBrief,
  TaskInput,
  TaskListEntry,
} from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { archiveTask, unarchiveTask } from './archive.js'
import { messages, now, sql, tasks } from './db.js'
import { invalidateContext, liveContext } from './ea-context.js'
import { taskDocs } from './ea-index-docs.js'
import { sessionMcp } from './mcp-session-status.js'
import { transcriptEvidence } from './pr-evidence.js'
import { shellCall, shellStarted } from './shell-fixtures.js'
import { taskInputs } from './store/inputs.js'
import { prDiscoveryStore } from './store/pr-discovery.js'
import { sessionRestarts, stoppedNotes } from './store/processes.js'
import { shellRuns } from './store/shell.js'
import { agentCall, assistant, completedResult } from './subtask-fixtures.js'
import { USER_AUTH } from './test-auth.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-malformed-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

const TASK = 'malformed-task'
const ARCHIVED = 'malformed-archived'
const TURN = 'malformed-turn'
/** Every malformed payload carries it, so a test can tell that no log line holds content. */
const MARKER = 'MALFORMED-CONTENT-MARKER'
const HUGE = 3_000_000

const app = createApp()
const get = async (path: string, headers: Record<string, string> = {}) =>
  app.request(`/api${path}`, { headers: { host: 'localhost', ...USER_AUTH, ...headers } })

async function data<T>(path: string): Promise<T> {
  const res = await get(path)
  expect(res.status, path).toBe(200)
  return ((await res.json()) as { data: T }).data
}

/** Writes a row as it might sit in the table, past the checks Seti's own writes go through. */
async function store(taskId: string, kind: string, payload: unknown, outward = '[]'): Promise<number> {
  const [row] = await sql<{ id: number }[]>`INSERT INTO task_message (task_id, kind, payload, outward, created_at)
    VALUES (${taskId}, ${kind}, ${JSON.stringify(payload)}, ${outward}, ${now()}) RETURNING id`
  return row?.id ?? 0
}

const MALFORMED: [label: string, kind: string, payload: unknown][] = [
  ['content not a list', 'sdk', { type: 'assistant', parent_tool_use_id: null, message: { content: MARKER } }],
  [
    'blocks not objects',
    'sdk',
    { type: 'assistant', parent_tool_use_id: null, message: { content: [null, 5, { type: 'text', text: 7 }] } },
  ],
  [
    'tool use without an id',
    'sdk',
    {
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_use', id: 5, name: 'Bash', input: { command: `git push ${MARKER}` } }] },
    },
  ],
  [
    'result part without text',
    'sdk',
    {
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: [{ type: 'text' }] }] },
    },
  ],
  ['user without a message', 'sdk', { type: 'user', parent_tool_use_id: null }],
  ['success without a result', 'sdk', { type: 'result', subtype: 'success', is_error: false }],
  ['subagent start without a description', 'sdk', { type: 'system', subtype: 'task_started', task_id: 'sub' }],
  ['update without a patch', 'sdk', { type: 'system', subtype: 'task_updated', task_id: 'sub' }],
  [
    'update ending at no time',
    'sdk',
    { type: 'system', subtype: 'task_updated', task_id: 'sub', patch: { status: 'completed', end_time: 1e20 } },
  ],
  [
    'notification with a numeric summary',
    'sdk',
    {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'sub',
      tool_use_id: 'toolu_agent',
      status: 'completed',
      summary: 5,
      output_file: '',
    },
  ],
  ['init with servers not a list', 'sdk', { type: 'system', subtype: 'init', mcp_servers: MARKER }],
  ['null', 'sdk', null],
  ['a string', 'sdk', MARKER],
  ['a list', 'sdk', [1, 2]],
  ['no type', 'sdk', {}],
  ['a numeric type', 'sdk', { type: 5 }],
  ['unknown kind', 'bogus', { text: MARKER }],
  ['prompt with a numeric text', 'prompt', { text: 5 }],
  ['prompt with attachments not a list', 'prompt', { text: 'hi', attachments: MARKER }],
  ['note without an error', 'seti', { error: null }],
  ['shell run without output', 'shell', { run_id: 'r', command: MARKER }],
  ['update without a title', 'input', { source: 'pr', kind: 'ci_failed', subject: MARKER }],
  ['notice without a title', 'notice', {}],
  [
    'huge and malformed',
    'sdk',
    { type: 'assistant', parent_tool_use_id: null, message: { content: 'x'.repeat(HUGE) } },
  ],
]

const ids = new Map<string, number>()
const writes: string[] = []
const id = (label: string) => ids.get(label) ?? 0
/** Rows each filled task holds, malformed or not, that its own transcript shows. */
const SHOWN = MALFORMED.length + 9

const warnings = () =>
  writes
    .filter((line) => line.includes('unreadable transcript row'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)

async function fill(taskId: string, into: Map<string, number>) {
  const good = into
  good.set('prompt', (await messages.insert(taskId, { kind: 'prompt', payload: { text: 'find the needle' } }, [])).id)
  good.set('agent', (await messages.insert(taskId, agentCall('toolu_agent', 'Look around'), [])).id)
  good.set('report', (await messages.insert(taskId, completedResult('toolu_agent', 'a1', 'All found'), [])).id)
  good.set('shell call', (await messages.insert(taskId, shellCall('toolu_sh', { command: 'sleep 9' }), [])).id)
  const started = shellStarted({ shellId: 'sh1', toolUseId: 'toolu_sh', description: 'sleep', background: true })
  good.set('shell started', (await messages.insert(taskId, started, [])).id)
  for (const [label, kind, payload] of MALFORMED) {
    into.set(label, await store(taskId, kind, payload))
  }
  good.set('bad outward', await store(taskId, 'prompt', { text: 'outward is not json' }, MARKER))
  good.set('newer sdk message', await store(taskId, 'sdk', { type: 'stream_event', event: { type: 'ping' } }))
  const big = {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sh', content: 'y'.repeat(HUGE) }] },
  }
  good.set('huge result', await store(taskId, 'sdk', big))
  good.set('last words', (await messages.insert(taskId, assistant([{ type: 'text', text: 'all good here' }]), [])).id)
  const own = { type: 'assistant', parent_tool_use_id: 'toolu_agent', message: { content: MARKER } }
  good.set('subagent row', await store(taskId, 'sdk', own))
}

const shellRun = (command: string): ShellResult => ({
  run_id: command,
  command,
  cwd: '/tmp',
  started_at: now(),
  exit_code: 0,
  signal: null,
  ended_by: null,
  duration_ms: 5,
  stdout: 'ok',
  stderr: '',
})

const update: TaskInput = { source: 'pr', kind: 'merged', subject: 'o/r#1', title: 'Merged', body: '', url: null }

/** A turn's worth of rows the next turn reads: shell runs and updates, one of each malformed. */
async function fillTurn() {
  await messages.insert(TURN, { kind: 'prompt', payload: { text: 'go' } }, [])
  await store(TURN, 'sdk', { type: 'system', subtype: 'init', mcp_servers: [{ name: 5 }] })
  await store(TURN, 'shell', { run_id: 'r', command: MARKER })
  await messages.insert(TURN, { kind: 'shell', payload: shellRun('ls') }, [])
  await store(TURN, 'input', { source: 'pr', kind: 'ci_failed', subject: MARKER })
  await messages.insert(TURN, { kind: 'input', payload: update }, [])
}

beforeAll(async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    writes.push(String(chunk))
    return true
  })
  for (const task of [TASK, ARCHIVED, TURN]) {
    await tasks.insert({ id: task, title: task, repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
  }
  await fill(TASK, ids)
  await fill(ARCHIVED, new Map())
  await fillTurn()
})

afterAll(() => {
  vi.restoreAllMocks()
  fs.rmSync(scratch, { recursive: true, force: true })
})

const READABLE: [label: string, kind: string][] = [
  ['last words', 'sdk'],
  ['newer sdk message', 'sdk'],
  ['huge result', 'sdk'],
  ['bad outward', 'prompt'],
]

/** Each malformed row on the page reads as unreadable, and each good one as itself. */
function expectUnreadable(rows: readonly MessageRow[]) {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const unreadable = MALFORMED.filter(([label]) => byId.has(id(label)))
  expect(unreadable.length).toBeGreaterThan(0)
  for (const [label, kind] of unreadable) {
    expect(byId.get(id(label)), label).toMatchObject({ kind: 'unreadable', payload: { kind } })
  }
  for (const [label, kind] of READABLE.filter(([name]) => byId.has(id(name)))) {
    expect(byId.get(id(label))?.kind, label).toBe(kind)
  }
  expect(rows.filter((row) => row.kind === 'unreadable')).toHaveLength(unreadable.length)
}

describe('a transcript holding malformed rows', () => {
  it('still lists the agents, with the subagent the good rows describe', async () => {
    const list = await data<TaskListEntry[]>('/tasks')
    const entry = list.find((task) => task.id === TASK)
    expect(entry?.subtask_counts).toMatchObject({ running: 0, completed: 1 })
    const briefs = await data<SubtaskBrief[]>(`/tasks/${TASK}/subtasks`)
    expect(briefs.map((sub) => [sub.tool_use_id, sub.status])).toEqual([['toolu_agent', 'completed']])
    expect((await data<{ id: string }>(`/tasks/${TASK}`)).id).toBe(TASK)
  })

  it('pages every way, each malformed row read as unreadable with the reason', async () => {
    const newest = await data<MessagePage>(`/tasks/${TASK}/messages?limit=500`)
    expect(newest.messages).toHaveLength(SHOWN)
    expectUnreadable(newest.messages)
    expect(newest.messages.find((row) => row.id === id('bad outward'))?.outward).toEqual([])
    expect(newest.messages.find((row) => row.id === id('content not a list'))?.payload).toEqual({
      kind: 'sdk',
      reason: 'message.content: Invalid input: expected array, received string',
    })
    const before = await data<MessagePage>(`/tasks/${TASK}/messages?before=${String(id('last words'))}&limit=10`)
    expectUnreadable(before.messages)
    const after = await data<MessagePage>(`/tasks/${TASK}/messages?after=${String(id('agent'))}&limit=10`)
    expectUnreadable(after.messages)
    const around = await data<MessagePage>(`/tasks/${TASK}/messages?around=${String(id('null'))}&limit=10`)
    expectUnreadable(around.messages)
    const one = await data<MessageRow>(`/tasks/${TASK}/messages/${String(id('huge and malformed'))}`)
    expect(one).toMatchObject({ kind: 'unreadable', payload: { kind: 'sdk' } })
  })

  it('trims a huge readable row for the browser', async () => {
    const page = await data<MessagePage>(`/tasks/${TASK}/messages?limit=500`)
    expect(page.messages.find((row) => row.id === id('huge result'))?.trimmed).toEqual(['toolu_sh'])
  })

  it('streams the backlog', async () => {
    const res = await get(`/tasks/${TASK}/stream?tail=500`)
    const body: ReadableStream<Uint8Array> | null = res.body
    const reader = body?.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (reader !== undefined && !text.includes('event: subtasks')) {
      const chunk = await reader.read()
      text += decoder.decode(chunk.value, { stream: true })
      if (chunk.done) {
        break
      }
    }
    await reader?.cancel()
    const backlog = text.split('\n\n').find((event) => event.includes('event: backlog')) ?? ''
    const line = backlog.split('\n').find((field) => field.startsWith('data: ')) ?? 'data: {}'
    const page = JSON.parse(line.slice('data: '.length)) as MessagePage
    expect(page.messages).toHaveLength(SHOWN)
    expectUnreadable(page.messages)
  })

  it('searches, digests and lists subagents and background shells', async () => {
    const found = await data<SearchResult>(`/tasks/${TASK}/search?q=needle`)
    expect(found.hits.map((hit) => hit.id)).toEqual([id('prompt')])
    const { lines } = await data<{ lines: DigestLine[] }>(`/tasks/${TASK}/digest?limit=200`)
    expect(lines.map((line) => line.text)).toContain('all good here')
    expect(lines.map((line) => line.text)).not.toContain(expect.stringContaining(MARKER))
    const subtasks = await data<SubtaskBrief[]>(`/tasks/${TASK}/subtasks`)
    expect(subtasks.map((sub) => sub.summary)).toEqual(['All found'])
    const sub = await data<MessagePage>(`/tasks/${TASK}/subtasks/toolu_agent/messages`)
    expect(sub.messages.map((row) => [row.id, row.kind])).toEqual([[id('subagent row'), 'unreadable']])
    const processes = await data<AgentProcesses>(`/tasks/${TASK}/processes`)
    expect(processes.shells.map((shell) => shell.id)).toEqual(['sh1'])
  })

  it('builds the EA context, its search documents and PR evidence', async () => {
    invalidateContext(true)
    const context = await liveContext()
    expect(context.tasks.map((task) => task.id)).toContain(TASK)
    expect(context.text).not.toContain(MARKER)
    const rows = (await messages.page(TASK, 500)).messages
    expect(taskDocs({ id: TASK, title: TASK, repo_slug: null }, rows, new Map()).length).toBeGreaterThan(0)
    const evidence = transcriptEvidence(await prDiscoveryStore.evidenceRows(TASK, id('last words')))
    expect(evidence.pushes).toEqual([])
  })

  it('reads what the next turn takes past malformed shell runs, updates, init and prompts', async () => {
    expect((await shellRuns.sinceLastTurn(TURN, 10)).map((run) => run.command)).toEqual(['ls'])
    expect(await taskInputs.pending(TURN, 10)).toEqual([update])
    expect(await sessionMcp(TURN)).toMatchObject({ servers: [] })
    expect(await messages.lastPrompt(TURN)).toMatchObject({ text: 'go', attachments: [] })
    await store(TURN, 'prompt', { text: 5 })
    expect(await messages.lastPrompt(TURN)).toBeNull()
    await store(TURN, 'prompt', { text: 'again' })
    await store(TURN, 'sdk', { type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 'zero' })
    expect(await messages.droppedPrompt(TURN, 'resent')).toBeNull()
    await store(TURN, 'seti', { error: null, stopped: true })
    await store(TURN, 'seti', { error: 'Stopped sleep', stopped: true })
    await store(TURN, 'seti', { error: 'Restarted', session: 5 })
    expect(await stoppedNotes.sinceLastTurn(TURN)).toEqual(['Stopped sleep'])
    expect(await sessionRestarts.sinceLastTurn(TURN)).toEqual([])
  })

  it('logs each malformed row once, with its ids, kind and reason and none of its content', async () => {
    await data<MessagePage>(`/tasks/${TASK}/messages?limit=500`)
    const logged = warnings().filter((line) => line.task_id === TASK)
    const keys = logged.map((line) => Number(line.message_id)).sort((a, b) => a - b)
    const malformed = [...MALFORMED.map(([label]) => id(label)), id('subagent row')].sort((a, b) => a - b)
    expect(keys).toEqual(malformed)
    for (const line of logged) {
      expect(Object.keys(line).sort((a, b) => a.localeCompare(b))).toEqual([
        'kind',
        'level',
        'message_id',
        'msg',
        'reason',
        'task_id',
      ])
    }
    expect(writes.join('')).not.toContain(MARKER)
  })

  it('reads an archived transcript the same way, and restores it', async () => {
    await archiveTask(ARCHIVED, { actor: 'user', removeWorktree: false })
    const page = await data<MessagePage>(`/tasks/${ARCHIVED}/messages?limit=500`)
    expect(page.messages).toHaveLength(SHOWN)
    expect(page.messages.filter((row) => row.kind === 'unreadable')).toHaveLength(MALFORMED.length)
    const { lines } = await data<{ lines: DigestLine[] }>(`/tasks/${ARCHIVED}/digest?limit=200`)
    expect(lines.map((line) => line.text)).toContain('all good here')
    await unarchiveTask(ARCHIVED)
    expect((await messages.page(ARCHIVED, 500)).messages).toHaveLength(SHOWN)
  })
})

describe('storing text Postgres refuses in JSON', () => {
  it('keeps NUL and unpaired surrogates out, so the row is stored and found', async () => {
    writes.length = 0
    const row = await messages.insert(TASK, { kind: 'prompt', payload: { text: 'nul\0byte \uD800 lone' } }, [])
    const replaced = String.fromCodePoint(0xfffd)
    expect((await messages.get(TASK, row.id))?.payload).toEqual({ text: `nul${replaced}byte ${replaced} lone` })
    const found = await data<SearchResult>(`/tasks/${TASK}/search?q=lone`)
    expect(found.hits.map((hit) => hit.id)).toEqual([row.id])
    expect(warnings()).toEqual([])
  })

  it('refuses a payload that is not JSON at all', async () => {
    await expect(sql`INSERT INTO task_message (task_id, kind, payload, created_at)
      VALUES (${TASK}, 'prompt', ${'{not json'}, ${now()})`).rejects.toThrow(/json/i)
  })
})
