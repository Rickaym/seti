import fs from 'node:fs'
import type { Options, SDKMessage, SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AuditEvent, RewindResult, RewindTarget, TaskRewind } from '@seti/shared'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { messages, tasks } from './db.js'
import { matchChain, refusalOf, rewindPoints } from './rewind.js'
import { auditEvents } from './store/audit.js'
import { rewinds, type RewindRow } from './store/rewinds.js'
import { USER_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-rewind-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

/** Scripted turns: each turn takes the next script, a list of messages or an error to throw. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk } = await import('./fake-sdk.js')
  const state = {
    calls: [] as Options[],
    scripts: [] as (unknown[] | Error)[],
    chain: [] as unknown[],
    files: { canRewind: true, filesChanged: ['/repo/a.txt'], insertions: 1, deletions: 2 } as unknown,
    fileCalls: [] as { id: string; dryRun: boolean }[],
  }
  const fake = new FakeSdk(async function* () {
    await Promise.resolve()
    const script = state.scripts.shift() ?? []
    if (script instanceof Error) {
      throw script
    }
    yield* script as { type: string }[]
  })
  const files = {
    rewindFiles: async (id: string, options?: { dryRun?: boolean }) => {
      const dryRun = options?.dryRun ?? false
      state.fileCalls.push({ id, dryRun })
      return Promise.resolve(dryRun ? state.files : { canRewind: true, skippedLinks: 0 })
    },
    close: () => undefined,
  }
  const query = (params: Parameters<typeof fake.query>[0]) => {
    if (params.options?.perTaskStopAffordance !== true) {
      return files
    }
    state.calls.push(params.options)
    return fake.query(params)
  }
  const getSessionMessages = async () => Promise.resolve(state.chain)
  return { state, fake, query, getSessionMessages }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
  getSessionMessages: sdk.getSessionMessages,
}))

const SESSION = 'session-1'
const app = createApp()
const headers = { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' }

async function call(method: 'GET' | 'POST', url: string, body?: unknown) {
  const res = await app.request(`/api${url}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = (await res.json()) as { data: unknown; error?: { detail: string } }
  return { status: res.status, data: json.data, error: json.error?.detail }
}

const rewindTo = async (messageId: number | undefined, restore?: string) => {
  const res = await call('POST', `/tasks/rewind-task/rewind`, { message_id: messageId, restore })
  return { ...res, data: res.data as RewindResult }
}

const asSdk = (value: object) => value as unknown as SDKMessage

const init = (session = SESSION) =>
  asSdk({
    type: 'system',
    subtype: 'init',
    session_id: session,
    permissionMode: 'bypassPermissions',
    model: 'claude',
    uuid: crypto.randomUUID(),
  })

const reply = (uuid: string, text: string, session = SESSION) =>
  asSdk({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    uuid,
    session_id: session,
  })

const done = (session = SESSION) =>
  asSdk({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    total_cost_usd: 0,
    duration_ms: 1,
    num_turns: 1,
    session_id: session,
    uuid: crypto.randomUUID(),
  })

const REFUSAL = 'Resume rejected by --resume-drops-turn: resuming at a would discard entries not attributable'

const refused = asSdk({
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  errors: [REFUSAL],
  total_cost_usd: 0,
  duration_ms: 1,
  num_turns: 0,
  session_id: SESSION,
  uuid: crypto.randomUUID(),
})

const entry = (type: 'user' | 'assistant', uuid: string, content: unknown): SessionMessage => ({
  type,
  uuid,
  session_id: SESSION,
  message: { role: type, content },
  parent_tool_use_id: null,
  parent_agent_id: null,
})

let rowId = 0
const row = (fields: Partial<RewindRow>): RewindRow => ({
  id: ++rowId,
  kind: 'sdk',
  created_at: `2026-01-01T00:00:${String(rowId).padStart(2, '0')}Z`,
  text: null,
  queued: null,
  type: null,
  uuid: null,
  session_id: SESSION,
  sidechain: 0,
  ...fields,
})
const prompt = (text: string) => row({ kind: 'prompt', text, session_id: null })
const chainRow = (type: 'assistant' | 'user', uuid: string, session = SESSION) =>
  row({ type, uuid, session_id: session })

const pending = (id: number, messageId: number, last: number): TaskRewind => ({
  id,
  task_id: 't',
  prompt_message_id: messageId,
  last_message_id: last,
  message_count: 0,
  prompt_text: '',
  restore: 'conversation',
  state: 'pending',
  reason: null,
  files_changed: [],
  created_at: '',
})

const latestAudit = async (): Promise<AuditEvent | undefined> => auditEvents.latest('task.rewound')

beforeEach(() => {
  sdk.state.calls.length = 0
  sdk.state.scripts.length = 0
  sdk.state.fileCalls.length = 0
  sdk.state.chain = []
  sdk.state.files = { canRewind: true, filesChanged: ['/repo/a.txt'], insertions: 1, deletions: 2 }
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('rewindPoints', () => {
  const p1 = prompt('first')
  const a1 = chainRow('assistant', 'a1')
  const r1 = row({ type: 'result', uuid: 'r1' })
  const p2 = prompt('/cost')
  const c2 = chainRow('user', 'c2')
  const p3 = prompt('second')
  const a3 = chainRow('assistant', 'a3')
  const sub = row({ type: 'assistant', uuid: 'sub', sidechain: 1 })
  const shell = row({ kind: 'shell', session_id: null })
  const p4 = prompt('third')
  const a4 = chainRow('assistant', 'a4')
  const rows = [p1, a1, r1, p2, c2, p3, a3, sub, shell, p4, a4]

  it('keeps the last top-level chain entry before each prompt and skips slash commands', () => {
    const points = rewindPoints(rows, [], SESSION)
    expect(points.map((p) => [p.text, p.keep, p.message_count])).toEqual([
      ['first', null, 9],
      ['second', 'c2', 5],
      ['third', 'a3', 2],
    ])
    expect(points.every((p) => p.last_message_id === a4.id)).toBe(true)
  })

  it('leaves out rows an earlier rewind dropped, unless Claude Code refused it', () => {
    const history = [pending(1, p3.id, a4.id)]
    expect(rewindPoints(rows, history, SESSION).map((p) => p.text)).toEqual(['first'])
    const refusedRewind = { ...history[0], state: 'refused' } as TaskRewind
    expect(rewindPoints(rows, [refusedRewind], SESSION)).toHaveLength(3)
    const codeOnly = { ...refusedRewind, state: 'applied', restore: 'code' } as TaskRewind
    expect(rewindPoints(rows, [codeOnly], SESSION)).toHaveLength(3)
  })

  it('skips prompts sent during a turn, which have no clean point before them', () => {
    const folded = row({ kind: 'prompt', text: 'also this', queued: 'delivered', session_id: null })
    const removed = row({ kind: 'prompt', text: 'never mind', queued: 'removed', session_id: null })
    const tool = chainRow('user', 't1')
    const queuedRows = [p1, a1, folded, tool, removed, chainRow('assistant', 'a2'), r1, p4, a4]
    expect(rewindPoints(queuedRows, [], SESSION).map((p) => [p.text, p.keep, p.message_count])).toEqual([
      ['first', null, 8],
      ['third', 'a2', 2],
    ])
  })

  it('only keeps entries of the session the task resumes', () => {
    const imported = [prompt('old'), chainRow('assistant', 'x1', 'source'), prompt('mine'), chainRow('user', 'y')]
    expect(rewindPoints(imported, [], SESSION).map((p) => p.text)).toEqual(['old'])
  })
})

describe('matchChain', () => {
  const chain = [
    entry('user', 'u1', 'first'),
    entry('assistant', 'a1', [{ type: 'text', text: 'ok' }]),
    entry('user', 'u2', [{ type: 'text', text: 'Shell output first\n\nsecond' }]),
    entry('user', 't2', [{ type: 'tool_result', tool_use_id: 'x', content: 'second' }]),
    entry('assistant', 'a2', [{ type: 'text', text: 'ok' }]),
  ]

  it('finds the prompt entry after the kept entry and names it as the one dropped turn', () => {
    expect(matchChain(chain, { keep: 'a1', text: 'second' })).toEqual({
      keep_found: true,
      prompt_uuid: 'u2',
      drops_turn: 'u2',
    })
  })

  it('checks nothing when more than one turn is dropped or the session starts over', () => {
    expect(matchChain(chain, { keep: null, text: 'first' })).toEqual({
      keep_found: true,
      prompt_uuid: 'u1',
      drops_turn: null,
    })
    const longer = [...chain, entry('user', 'u3', 'third')]
    expect(matchChain(longer, { keep: 'a1', text: 'second' }).drops_turn).toBeNull()
  })

  it('reports a kept entry missing from a readable chain, and trusts an unreadable one', () => {
    expect(matchChain(chain, { keep: 'gone', text: 'second' }).keep_found).toBe(false)
    expect(matchChain([], { keep: 'a1', text: 'second' })).toEqual({
      keep_found: true,
      prompt_uuid: null,
      drops_turn: null,
    })
  })
})

describe('refusalOf', () => {
  it('matches the refusal in results and thrown errors only', () => {
    expect(refusalOf(refused)).toBe(REFUSAL)
    expect(refusalOf(new Error(`Claude Code returned an error result: ${REFUSAL}`))).toBe(REFUSAL)
    expect(refusalOf(new Error('No message found with message.uuid of: abc'))).toContain('No message found')
    expect(refusalOf(new Error('network down'))).toBeNull()
    expect(refusalOf(done())).toBeNull()
  })
})

describe('task rewind', () => {
  const TASK = 'rewind-task'
  let p1 = 0
  let p2 = 0

  const send = async (text: string, ...scripts: (unknown[] | Error)[]) => {
    sdk.state.scripts.push(...scripts)
    expect((await call('POST', `/tasks/${TASK}/messages`, { prompt: text })).status).toBe(200)
    await waitIdle(TASK)
  }

  const targets = async () => (await call('GET', `/tasks/${TASK}/rewind/targets`)).data as RewindTarget[]

  it('lists earlier prompts newest first and rewinds the conversation on the next turn', async () => {
    await tasks.insert({ id: TASK, title: 'Rewind', repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
    await tasks.setSession(TASK, { sessionId: SESSION, permissionMode: 'bypassPermissions', model: 'claude' })
    p1 = (await messages.insert(TASK, { kind: 'prompt', payload: { text: 'first' } }, [])).id
    await messages.insert(TASK, { kind: 'sdk', payload: init() }, [])
    await messages.insert(TASK, { kind: 'sdk', payload: reply('a1', 'one') }, [])
    await messages.insert(TASK, { kind: 'sdk', payload: done() }, [])
    p2 = (await messages.insert(TASK, { kind: 'prompt', payload: { text: 'second' } }, [])).id
    await messages.insert(TASK, { kind: 'sdk', payload: reply('a2', 'two') }, [])
    await messages.insert(TASK, { kind: 'sdk', payload: done() }, [])

    expect((await targets()).map((t) => [t.message_id, t.text, t.message_count])).toEqual([
      [p2, 'second', 2],
      [p1, 'first', 4],
    ])

    sdk.state.chain = [entry('user', 'u1', 'first'), entry('assistant', 'a1', 'one'), entry('user', 'u2', 'second')]
    const rewound = await rewindTo(p2)
    expect(rewound.status).toBe(200)
    expect(rewound.data.prompt).toBe('second')
    expect(rewound.data.rewind).toMatchObject({ state: 'pending', restore: 'conversation', message_count: 2 })
    expect(await rewinds.pending(TASK)).toMatchObject({ resume_at: 'a1', drops_turn: 'u2' })
    expect(await latestAudit()).toMatchObject({
      subject_id: TASK,
      summary: 'Rewound task "Rewind" to before "second"',
      detail: { prompt: 'second', messages_rewound: 2, restore: 'conversation' },
    })
    expect((await targets()).map((t) => t.text)).toEqual(['first'])

    await send('different', [init(), reply('a3', 'three'), done()])
    expect(sdk.state.calls[0]).toMatchObject({
      resume: SESSION,
      resumeSessionAt: 'a1',
      resumeDropsTurn: 'u2',
      enableFileCheckpointing: true,
    })
    expect(await rewinds.pending(TASK)).toBeUndefined()
    expect((await rewinds.list(TASK)).at(-1)?.state).toBe('applied')
    expect((await messages.page(TASK, 100)).messages.filter((m) => m.kind === 'prompt')).toHaveLength(3)

    await send('plain again', [init(), done()])
    expect(sdk.state.calls).toHaveLength(1)
    expect(sdk.fake.last?.prompts).toEqual(['different', 'plain again'])
    expect((await rewinds.list(TASK)).at(-1)?.state).toBe('applied')
  })

  it('starts a new session when rewinding to the first prompt', async () => {
    expect((await call('POST', `/tasks/${TASK}/rewind`, { message_id: p1 })).status).toBe(200)
    expect(await rewinds.pending(TASK)).toMatchObject({ resume_at: null, drops_turn: null })
    await send('fresh start', [init('session-2'), done('session-2')])
    expect(sdk.state.calls[0]).not.toHaveProperty('resume')
    expect((await tasks.get(TASK))?.session_id).toBe('session-2')
    expect((await targets()).map((t) => t.text)).toEqual(['fresh start'])
  })

  it('maps a refused rewind to a plain resume of the same turn and never retries it', async () => {
    const reset = 'session-3'
    await tasks.setSession(TASK, { sessionId: reset, permissionMode: 'bypassPermissions', model: 'claude' })
    await send('one', [init(reset), reply('b1', 'one', reset), done(reset)])
    await send('two', [init(reset), reply('b2', 'two', reset), done(reset)])
    const two = (await targets())[0]
    expect(two?.text).toBe('two')
    sdk.state.chain = [entry('user', 'v1', 'one'), entry('assistant', 'b1', 'one'), entry('user', 'v2', 'two')]
    await call('POST', `/tasks/${TASK}/rewind`, { message_id: two?.message_id })
    sdk.state.calls.length = 0

    await send('after refusal', [refused], [init(reset), done(reset)])
    expect(sdk.state.calls).toHaveLength(2)
    expect(sdk.state.calls[0]).toMatchObject({ resumeSessionAt: 'b1', resumeDropsTurn: 'v2' })
    expect(sdk.state.calls[1]).toMatchObject({ resume: reset })
    expect(sdk.state.calls[1]).not.toHaveProperty('resumeSessionAt')
    expect((await rewinds.list(TASK)).at(-1)).toMatchObject({ state: 'refused', reason: REFUSAL })
    expect(await rewinds.pending(TASK)).toBeUndefined()
    expect((await tasks.get(TASK))?.status).toBe('idle')

    const again = (await targets()).find((t) => t.text === 'after refusal')
    sdk.state.chain.push(entry('assistant', 'b2', 'two'), entry('user', 'v3', 'after refusal'))
    expect((await call('POST', `/tasks/${TASK}/rewind`, { message_id: again?.message_id })).status).toBe(200)
    sdk.state.calls.length = 0
    await send('thrown refusal', new Error(`Claude Code returned an error result: ${REFUSAL}`), [done(reset)])
    expect(sdk.state.calls).toHaveLength(2)
    expect((await rewinds.list(TASK)).at(-1)?.state).toBe('refused')
    expect((await tasks.get(TASK))?.status).toBe('idle')
  })

  it('previews and restores code through Claude Code file checkpoints', async () => {
    await send('edit files', [init('session-3'), reply('b4', 'edited', 'session-3'), done('session-3')])
    const [latest] = await targets()
    const id = latest?.message_id
    expect(latest?.text).toBe('edit files')
    sdk.state.chain = [
      entry('assistant', 'b2', 'two'),
      entry('user', 'v5', 'thrown refusal'),
      entry('user', 'w1', 'edit files'),
    ]

    const preview = await call('GET', `/tasks/${TASK}/rewind/files?message_id=${String(id)}`)
    expect(preview.data).toEqual({
      can_rewind: true,
      error: null,
      files: ['/repo/a.txt'],
      insertions: 1,
      deletions: 2,
    })
    expect(sdk.state.fileCalls).toEqual([{ id: 'w1', dryRun: true }])

    sdk.state.files = { canRewind: false, error: 'No file checkpoint found for this message.' }
    const noCheckpoint = await call('POST', `/tasks/${TASK}/rewind`, { message_id: id, restore: 'both' })
    expect(noCheckpoint).toMatchObject({ status: 409, error: 'No file checkpoint found for this message.' })
    expect(await rewinds.pending(TASK)).toBeUndefined()

    sdk.state.files = { canRewind: true, filesChanged: ['/repo/a.txt'] }
    const code = await rewindTo(id, 'code')
    expect(code.data.rewind).toMatchObject({ restore: 'code', state: 'applied', files_changed: ['/repo/a.txt'] })
    expect(await rewinds.pending(TASK)).toBeUndefined()
    expect((await targets())[0]?.message_id).toBe(id)

    const both = await rewindTo(id, 'both')
    expect(both.data.rewind).toMatchObject({ restore: 'both', state: 'pending', files_changed: ['/repo/a.txt'] })
    expect(sdk.state.fileCalls.slice(-2)).toEqual([
      { id: 'w1', dryRun: true },
      { id: 'w1', dryRun: false },
    ])
    expect((await latestAudit())?.detail).toMatchObject({ restore: 'both', files_restored: ['/repo/a.txt'] })
  })
})
