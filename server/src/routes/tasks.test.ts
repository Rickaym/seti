import fs from 'node:fs'
import { AGENT_COLOR_PRESETS, type MessagePage, type MessageRow, type TaskListEntry } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { messages, sql, tasks } from '../db.js'
import { publish } from '../runner.js'
import { auditEvents } from '../store/audit.js'
import { prWatch } from '../store/pr-watch.js'
import { assistant, taskProgress } from '../subtask-fixtures.js'
import { USER_AUTH, EA_AUTH } from '../test-auth.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-transcript-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

const TASK = 'transcript-task'
const OTHER = 'other-task'
const app = createApp()
const ids: number[] = []
let bigId = 0

const get = async (path: string, headers: Record<string, string> = {}) =>
  app.request(`/api/tasks${path}`, { headers: { host: 'localhost', ...USER_AUTH, ...headers } })

async function data<T>(path: string): Promise<T> {
  const res = await get(path)
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: T }).data
}

interface SseEvent {
  event: string
  id: string | undefined
  data: string
}

function parseEvents(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((chunk) => chunk.includes('data:'))
    .map((chunk) => {
      const field = (name: string) =>
        chunk
          .split('\n')
          .find((line) => line.startsWith(`${name}:`))
          ?.slice(name.length + 1)
          .trim()
      return { event: field('event') ?? 'message', id: field('id'), data: field('data') ?? '' }
    })
}

/** Reads a never-ending SSE response until `done` holds, then cancels it. */
async function readStream(res: Response, done: (events: SseEvent[]) => boolean): Promise<SseEvent[]> {
  const body: ReadableStream<Uint8Array> | null = res.body
  if (!body) {
    throw new Error('no body')
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const chunk = await reader.read()
    text += decoder.decode(chunk.value, { stream: true })
    const events = parseEvents(text)
    if (chunk.done || done(events)) {
      await reader.cancel()
      return events
    }
  }
}

const promptIds = (rows: MessageRow[]) => rows.map((row) => row.id)

/** The cursor a fresh stream of the task hands out with its opening backlog. */
async function openingCursor(task: string): Promise<string> {
  const [backlog] = await readStream(await get(`/${task}/stream`), (e) => e.length > 0)
  expect(backlog?.event).toBe('backlog')
  return backlog?.id ?? ''
}

/** Marks a waiting queued prompt delivered and tells streams, as the runner does. */
async function settle(task: string, id: number): Promise<void> {
  await messages.settleQueued(task, id, 'delivered')
  const row = await messages.get(task, id)
  if (row) {
    publish(task, { type: 'updated', row })
  }
}

beforeAll(async () => {
  await tasks.insert({ id: TASK, title: 'Long', repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
  await tasks.insert({ id: OTHER, title: 'Other', repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
  for (let i = 0; i < 250; i++) {
    ids.push((await messages.insert(TASK, { kind: 'prompt', payload: { text: `message ${String(i)}` } }, [])).id)
    await messages.insert(OTHER, { kind: 'prompt', payload: { text: 'noise' } }, [])
  }
  const big = await messages.insert(
    TASK,
    {
      kind: 'sdk',
      payload: {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_big', content: 'y'.repeat(200_000) }],
        },
        parent_tool_use_id: null,
      },
    },
    [],
  )
  bigId = big.id
  ids.push(bigId)
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('messages.page', () => {
  it('returns the newest messages in ascending order when no cursor is given', async () => {
    const page = await messages.page(TASK, 10)
    expect(promptIds(page.messages)).toEqual(ids.slice(-10))
    expect(page.has_older).toBe(true)
  })

  it('returns the page just before a cursor and stops at the first message', async () => {
    const before = ids[25] ?? 0
    expect(promptIds((await messages.page(TASK, 10, before)).messages)).toEqual(ids.slice(15, 25))
    const first = await messages.page(TASK, 10, ids[5])
    expect(promptIds(first.messages)).toEqual(ids.slice(0, 5))
    expect(first.has_older).toBe(false)
    expect(await messages.page(TASK, 10, ids[0])).toEqual({ messages: [], has_older: false })
  })
})

describe('GET /api/tasks', () => {
  it('reports the polled state of each linked PR and leaves unpolled ones out', async () => {
    const merged = 'https://github.com/o/r/pull/1'
    const unpolled = 'https://github.com/o/r/pull/2'
    const pr_urls = [merged, unpolled]
    await tasks.insert({ id: 'pr-task', title: 'PRs', repo_id: null, cwd: scratch, worktree: false, pr_urls })
    await prWatch.save(merged, { state: 'merged', conflicting: false, ci: null, review_ids: [], comment_ids: [] })
    const list = await data<TaskListEntry[]>('')
    expect(list.find((task) => task.id === 'pr-task')?.pr_states).toEqual({
      by_url: { [merged]: 'merged' },
      any_merged: true,
    })
    expect(list.find((task) => task.id === TASK)?.pr_states).toEqual({ by_url: {}, any_merged: false })
  })
})

describe('GET /api/tasks/:id/messages', () => {
  it('pages backwards with has_older and trims long tool output', async () => {
    const tail = await data<MessagePage>(`/${TASK}/messages?limit=3`)
    expect(promptIds(tail.messages)).toEqual(ids.slice(-3))
    expect(tail.has_older).toBe(true)
    expect(tail.messages.at(-1)?.trimmed).toEqual(['toolu_big'])
    expect(JSON.stringify(tail.messages.at(-1)).length).toBeLessThan(20_000)

    const earlier = await data<MessagePage>(`/${TASK}/messages?before=${String(ids[3])}&limit=100`)
    expect(promptIds(earlier.messages)).toEqual(ids.slice(0, 3))
    expect(earlier.has_older).toBe(false)
  })

  it('leaves subagent messages and progress reports out, so a long subagent run hides nothing', async () => {
    await tasks.insert({
      id: 'subagent-heavy',
      title: 'Heavy',
      repo_id: null,
      cwd: scratch,
      worktree: false,
      pr_urls: [],
    })
    await messages.insert('subagent-heavy', { kind: 'prompt', payload: { text: 'start' } }, [])
    for (let step = 0; step < 150; step++) {
      await messages.insert(
        'subagent-heavy',
        assistant([{ type: 'text', text: `step ${String(step)}` }], 'toolu_sub'),
        [],
      )
      await messages.insert('subagent-heavy', taskProgress('sub', 'toolu_sub', 'Read', step), [])
    }
    await messages.insert('subagent-heavy', assistant([{ type: 'text', text: 'all done' }]), [])
    const page = await data<MessagePage>('/subagent-heavy/messages?limit=100')
    expect(page.messages.map((row) => row.kind)).toEqual(['prompt', 'sdk'])
    expect(page.has_older).toBe(false)
  })

  it('rejects invalid paging input', async () => {
    expect((await get(`/${TASK}/messages?before=abc`)).status).toBe(400)
    expect((await get(`/${TASK}/messages?limit=0`)).status).toBe(400)
    expect((await get(`/${TASK}/messages?limit=501`)).status).toBe(400)
  })
})

describe('GET /api/tasks/:id/messages/:message_id', () => {
  it('returns the stored message in full', async () => {
    const row = await data<MessageRow>(`/${TASK}/messages/${String(bigId)}`)
    expect(row.trimmed).toBeUndefined()
    expect(JSON.stringify(row)).toContain('y'.repeat(200_000))
  })

  it('only serves messages of the task in the path', async () => {
    expect((await get(`/${OTHER}/messages/${String(bigId)}`)).status).toBe(404)
    expect((await get(`/missing/messages/${String(bigId)}`)).status).toBe(404)
    expect((await get(`/${TASK}/messages/0`)).status).toBe(400)
  })
})

describe('GET /api/tasks/:id/stream', () => {
  it('opens with one backlog event holding the newest messages', async () => {
    const events = await readStream(await get(`/${TASK}/stream?tail=20`), (e) => e.length > 0)
    const [backlog] = events
    expect(backlog?.event).toBe('backlog')
    const page = JSON.parse(backlog?.data ?? '{}') as MessagePage
    expect(promptIds(page.messages)).toEqual(ids.slice(-20))
    expect(page.has_older).toBe(true)
    expect(backlog?.id?.split('.')[0]).toBe(String(bigId))
    expect(page.messages.at(-1)?.trimmed).toEqual(['toolu_big'])
  })

  it('defaults to a tail of 150 messages', async () => {
    const [backlog] = await readStream(await get(`/${TASK}/stream`), (e) => e.length > 0)
    expect((JSON.parse(backlog?.data ?? '{}') as MessagePage).messages).toHaveLength(150)
  })

  it('starts afresh from a bare message id, which carries no record of edits', async () => {
    const res = await get(`/${TASK}/stream`, { 'Last-Event-ID': String(ids.at(-4) ?? 0) })
    const [backlog] = await readStream(res, (e) => e.length > 0)
    expect(backlog?.event).toBe('backlog')
  })

  it('resumes after a cached cursor with only the newer rows, then the current status', async () => {
    const task = 'resume-rows-task'
    await tasks.insert({ id: task, title: 'Resume', repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
    await messages.insert(task, { kind: 'prompt', payload: { text: 'seen' } }, [])
    const cursor = await openingCursor(task)
    const added = [
      await messages.insert(task, { kind: 'prompt', payload: { text: 'new 1' } }, []),
      await messages.insert(task, { kind: 'prompt', payload: { text: 'new 2' } }, []),
    ]
    const res = await get(`/${task}/stream?after=${encodeURIComponent(cursor)}`)
    const events = await readStream(res, (e) => e.some((event) => event.event === 'resumed'))
    expect(events.map((e) => e.event)).toEqual(['message', 'message', 'resumed'])
    expect(events.slice(0, 2).map((e) => (JSON.parse(e.data) as MessageRow).id)).toEqual(added.map((row) => row.id))
    expect(events.at(-1)?.id?.startsWith(`${String(added[1]?.id)}.`)).toBe(true)
  })

  it('sends a resuming stream the rows edited while it was away', async () => {
    const task = 'resume-edit-task'
    await tasks.insert({ id: task, title: 'Edits', repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
    const waiting = await messages.insert(task, { kind: 'prompt', payload: { text: 'later', queued: 'waiting' } }, [])
    await messages.insert(task, { kind: 'prompt', payload: { text: 'plain' } }, [])
    const cursor = await openingCursor(task)
    await settle(task, waiting.id)
    const res = await get(`/${task}/stream`, { 'Last-Event-ID': cursor })
    const events = await readStream(res, (e) => e.some((event) => event.event === 'resumed'))
    expect(events.map((e) => e.event)).toEqual(['updated', 'resumed'])
    const row = JSON.parse(events[0]?.data ?? '{}') as MessageRow
    expect([row.id, row.kind === 'prompt' ? row.payload.queued : null]).toEqual([waiting.id, 'delivered'])
  })

  it('sends a resuming stream the status it changed to while away', async () => {
    const task = 'resume-status-task'
    await tasks.insert({ id: task, title: 'Status', repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
    await messages.insert(task, { kind: 'prompt', payload: { text: 'go' } }, [])
    const cursor = await openingCursor(task)
    await tasks.setStatus(task, 'error', 'boom')
    publish(task, { type: 'status', status: 'error' })
    const res = await get(`/${task}/stream?after=${encodeURIComponent(cursor)}`)
    const events = await readStream(res, (e) => e.some((event) => event.event === 'resumed'))
    expect(events.map((e) => e.event)).toEqual(['resumed'])
    expect(JSON.parse(events[0]?.data ?? '{}')).toEqual({ status: 'error' })
  })

  it('sends a backlog instead when the edit log rolled past the cursor', async () => {
    const task = 'resume-overflow-task'
    await tasks.insert({ id: task, title: 'Overflow', repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
    const row = await messages.insert(task, { kind: 'prompt', payload: { text: 'edited often' } }, [])
    const cursor = await openingCursor(task)
    for (let i = 0; i < 501; i++) {
      publish(task, { type: 'updated', row })
    }
    const [first] = await readStream(
      await get(`/${task}/stream?after=${encodeURIComponent(cursor)}`),
      (e) => e.length > 0,
    )
    expect(first?.event).toBe('backlog')
  })

  it('sends a backlog instead after a server restart or a gap longer than a catch-up', async () => {
    const task = 'resume-reset-task'
    await tasks.insert({ id: task, title: 'Reset', repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
    const seen = await messages.insert(task, { kind: 'prompt', payload: { text: 'seen' } }, [])
    const cursor = await openingCursor(task)
    const restarted = cursor.replace(/\.[0-9a-f]+\./, '.0123abcd.')
    const [afterRestart] = await readStream(await get(`/${task}/stream?after=${restarted}`), (e) => e.length > 0)
    expect(afterRestart?.event).toBe('backlog')
    for (let i = 0; i < 501; i++) {
      await messages.insert(task, { kind: 'prompt', payload: { text: `missed ${String(i)}` } }, [])
    }
    const [afterGap] = await readStream(
      await get(`/${task}/stream?after=${encodeURIComponent(cursor)}`),
      (e) => e.length > 0,
    )
    expect(afterGap?.event).toBe('backlog')
    const page = JSON.parse(afterGap?.data ?? '{}') as MessagePage
    expect(page.messages.some((message) => message.id === seen.id)).toBe(false)
  })

  it('passes on updates to an open stream', async () => {
    const task = 'queued-stream-task'
    await tasks.insert({ id: task, title: 'Queued', repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
    const waiting = await messages.insert(task, { kind: 'prompt', payload: { text: 'later', queued: 'waiting' } }, [])
    let settled = false
    const events = await readStream(await get(`/${task}/stream`), (e) => {
      if (e.some((event) => event.event === 'session') && !settled) {
        settled = true
        void settle(task, waiting.id)
      }
      return e.some((event) => event.event === 'updated')
    })
    const update = JSON.parse(events.find((event) => event.event === 'updated')?.data ?? '{}') as MessageRow
    expect(update.kind === 'prompt' ? update.payload.queued : null).toBe('delivered')
  })

  it('reports no older messages for a short task', async () => {
    const [backlog] = await readStream(await get(`/${OTHER}/stream?tail=500`), (e) => e.length > 0)
    const page = JSON.parse(backlog?.data ?? '{}') as MessagePage
    expect(page.messages).toHaveLength(250)
    expect(page.has_older).toBe(false)
  })
})

describe('PATCH /api/tasks/:id', () => {
  const patch = async (id: string, body: unknown) =>
    app.request(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json', ...EA_AUTH },
      body: JSON.stringify(body),
    })

  it('pins a task to the top of the list and audits it', async () => {
    await tasks.insert({
      id: 'pin-old',
      title: 'Long runner',
      repo_id: null,
      cwd: scratch,
      worktree: false,
      pr_urls: [],
    })
    await sql`UPDATE task SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = 'pin-old'`
    expect((await patch('pin-old', { pinned: true })).status).toBe(200)
    const list = await data<TaskListEntry[]>('')
    expect(list[0]).toMatchObject({ id: 'pin-old', pinned: true })
    expect(await auditEvents.latest('task.pinned_changed')).toMatchObject({
      subject_id: 'pin-old',
      summary: 'Pinned task "Long runner"',
    })
  })

  it('starts a task with a preset, recolours it with a preset or a hex, clears it with null and refuses the rest', async () => {
    await tasks.insert({
      id: 'colour-task',
      title: 'Painted',
      repo_id: null,
      cwd: scratch,
      worktree: false,
      pr_urls: [],
    })
    const colorOf = async () => (await data<TaskListEntry[]>('')).find((task) => task.id === 'colour-task')?.color
    const stored = async (res: Response) => ((await res.json()) as { data: { color: string } }).data.color
    expect(AGENT_COLOR_PRESETS.map((preset) => preset.hex)).toContain(await colorOf())
    expect((await patch('colour-task', { color: null })).status).toBe(200)
    expect(await colorOf()).toBeNull()
    const res = await patch('colour-task', { color: 'teal' })
    expect(res.status).toBe(200)
    expect(await stored(res)).toBe('#3baca6')
    expect(await auditEvents.latest('task.color_changed')).toMatchObject({
      subject_id: 'colour-task',
      summary: 'Coloured task "Painted" teal',
      detail: { color: '#3baca6', previous_color: null, via: 'ea' },
    })
    for (const [sent, kept] of [
      ['#3B82F6', '#3b82f6'],
      [' #f0a ', '#ff00aa'],
      ['RED', '#e8605b'],
    ] as const) {
      expect(await stored(await patch('colour-task', { color: sent })), sent).toBe(kept)
    }
    expect(await auditEvents.latest('task.color_changed')).toMatchObject({ summary: 'Coloured task "Painted" red' })
    await patch('colour-task', { color: '#123456' })
    expect(await auditEvents.latest('task.color_changed')).toMatchObject({ summary: 'Coloured task "Painted" #123456' })
    for (const color of ['purple-ish', '3b82f6', '#12', '#1234', '#12345678', '#ggghhh', '', 3]) {
      expect((await patch('colour-task', { color })).status, String(color)).toBe(400)
    }
    expect((await patch('colour-task', { title: 'Painted' })).status).toBe(200)
    expect(await colorOf()).toBe('#123456')
    expect((await patch('colour-task', { color: null })).status).toBe(200)
    expect(await colorOf()).toBeNull()
    expect(await auditEvents.latest('task.color_changed')).toMatchObject({
      summary: 'Cleared the colour of task "Painted"',
    })
  })

  it('renames a task and audits it once, marked as the EA when the EA asked', async () => {
    await tasks.insert({ id: 'rename-task', title: 'Old', repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
    const res = await patch('rename-task', { title: 'Voicemail retry' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: { title: string } }).data.title).toBe('Voicemail retry')
    const renamed = await auditEvents.latest('task.renamed')
    expect(renamed).toMatchObject({
      actor: 'user',
      subject_id: 'rename-task',
      summary: 'Renamed task "Old" to "Voicemail retry"',
      detail: { title: 'Voicemail retry', previous_title: 'Old', via: 'ea' },
    })
    expect((await patch('rename-task', { title: 'Voicemail retry' })).status).toBe(200)
    expect((await auditEvents.latest('task.renamed'))?.id).toBe(renamed?.id)
    expect((await patch('rename-task', { title: '  ' })).status).toBe(400)
  })
})
