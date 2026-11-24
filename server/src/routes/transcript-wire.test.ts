import fs from 'node:fs'
import {
  isClaudeRow,
  type MessageBody,
  type MessageRow,
  projectClaude,
  type WirePage,
  type WireRow,
} from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { messages, tasks } from '../db.js'
import { bash, toolResult } from '../subtask-fixtures.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'
import { wireRow } from '../transcript.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-wire-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

const TASK = 'wire-task'
const app = createApp()
const stored: MessageRow[] = []

const get = async (path: string, auth: Record<string, string> = USER_AUTH) =>
  app.request(`/api/tasks/${TASK}${path}`, { headers: { host: 'localhost', ...auth } })

async function data<T>(path: string, auth: Record<string, string> = USER_AUTH): Promise<T> {
  const res = await get(path, auth)
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: T }).data
}

/** The data of the first event a never-ending SSE response sends. */
async function firstEvent(res: Response): Promise<string> {
  const body: ReadableStream<Uint8Array> | null = res.body
  const reader = body?.getReader()
  const decoder = new TextDecoder()
  let text = ''
  while (reader !== undefined && !text.includes('\n\n')) {
    const chunk = await reader.read()
    text += decoder.decode(chunk.value, { stream: true })
  }
  await reader?.cancel()
  return (
    text
      .split('\n')
      .find((line) => line.startsWith('data:'))
      ?.slice('data:'.length) ?? ''
  )
}

beforeAll(async () => {
  await tasks.insert({ id: TASK, title: 'Wire', repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
  const bodies: MessageBody[] = [
    { kind: 'prompt', payload: { text: 'Run the tests.' } },
    bash('toolu_big', 'pnpm test'),
    toolResult('toolu_big', 'y'.repeat(200_000), { output: { stdout: 'y'.repeat(200_000) } }),
  ]
  for (const body of bodies) {
    const { id } = await messages.insert(TASK, body, [])
    const row = await messages.get(TASK, id)
    if (row) {
      stored.push(row)
    }
  }
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

/** What a client that asks for events must get for a stored row: its wire copy's events. */
function asEvents(row: MessageRow): WireRow {
  const wire = wireRow(row)
  return isClaudeRow(wire)
    ? {
        id: wire.id,
        task_id: wire.task_id,
        outward: wire.outward,
        created_at: wire.created_at,
        ...(wire.trimmed === undefined ? {} : { trimmed: wire.trimmed }),
        kind: 'events',
        payload: projectClaude(wire.payload),
      }
    : wire
}

describe('transcript reads in the form the client asks for', () => {
  it('sends runtime rows as stored to a client that does not ask for events', async () => {
    const page = await data<WirePage>('/messages')
    expect(page.messages).toEqual(stored.map(wireRow))
    expect(page.messages.map((row) => row.kind)).toEqual(['prompt', 'sdk', 'sdk'])
  })

  it('sends the events of the cut copy to a client that asks for them', async () => {
    const page = await data<WirePage>('/messages?wire=events')
    expect(page.messages).toEqual(stored.map(asEvents))
    const result = page.messages.at(-1)
    expect(result?.trimmed).toEqual(['toolu_big'])
    expect(
      result?.kind === 'events' && result.payload[0]?.type === 'tool.ended' && result.payload[0].result.text,
    ).toMatch(/^y{16384}\n\n\[trimmed for display: first 16 KB of 196 KB shown\]$/)
  })

  it('sends a whole message as events with nothing cut', async () => {
    const id = stored.at(-1)?.id ?? 0
    const row = await data<WireRow>(`/messages/${String(id)}?wire=events`)
    expect(row.kind).toBe('events')
    expect(row.trimmed).toBeUndefined()
    expect(row.kind === 'events' && row.payload[0]?.type === 'tool.ended' && row.payload[0].result.text).toBe(
      'y'.repeat(200_000),
    )
    expect((await data<WireRow>(`/messages/${String(id)}`)).kind).toBe('sdk')
  })

  it('streams the backlog in the form asked for', async () => {
    const events = JSON.parse(await firstEvent(await get('/stream?wire=events'))) as WirePage
    expect(events.messages).toEqual(stored.map(asEvents))
    const raw = JSON.parse(await firstEvent(await get('/stream'))) as WirePage
    expect(raw.messages).toEqual(stored.map(wireRow))
  })

  it('sends the EA events whether or not it asks', async () => {
    const page = await data<WirePage>('/messages', EA_AUTH)
    expect(page.messages).toEqual(stored.map(asEvents))
  })

  it('refuses a form it does not know', async () => {
    expect((await get('/messages?wire=raw')).status).toBe(400)
  })
})
