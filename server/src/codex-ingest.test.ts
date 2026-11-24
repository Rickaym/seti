import { eventsOf, rowEvents, type CodexMessage, type MessageRow } from '@seti/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { archivedPage } from './archive.js'
import { messages, sql, tasks } from './db.js'
import { nodeLink } from './node-link.js'
import recorded from './runtimes/codex/reference-turn.json' with { type: 'json' }
import { taskArchives } from './store/archive.js'

const ROOT = '01a20244-c954-7390-bda1-b0194900d368'
const AT = '2026-11-24T00:00:00.000Z'

beforeAll(() => {
  createApp()
})

async function newTask(id: string): Promise<string> {
  await sql`INSERT INTO task (id, title, cwd, status, runtime, created_at, updated_at)
    VALUES (${id}, ${id}, '/tmp', 'idle', 'codex', ${AT}, ${AT})`
  return id
}

const asStored = (message: unknown): CodexMessage => ({ root: ROOT, message })

async function ingest(taskId: string, list: readonly unknown[]): Promise<void> {
  for (const message of list) {
    await nodeLink.journal(taskId, { type: 'message', runtime: 'codex', payload: asStored(message) })
  }
}

const rowsOf = async (taskId: string): Promise<MessageRow[]> => (await messages.page(taskId, 200)).messages

const turnEnds = async (taskId: string) =>
  (await rowsOf(taskId)).flatMap((row) => eventsOf(rowEvents(row), 'turn.ended'))

/** A turn of one model call on the recorded thread, with this usage. */
function oneCallTurn(turnId: string, last: Record<string, number>) {
  const turn = { id: turnId, items: [], status: 'completed', error: null, durationMs: 10 }
  const tokenUsage = { total: last, last, modelContextWindow: 258400 }
  return [
    { method: 'turn/started', params: { threadId: ROOT, turn: { ...turn, status: 'inProgress' } } },
    { method: 'thread/tokenUsage/updated', params: { threadId: ROOT, turnId, tokenUsage } },
    { method: 'turn/completed', params: { threadId: ROOT, turn } },
  ]
}

const CALL = {
  totalTokens: 300_100,
  inputTokens: 300_000,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 100,
  reasoningOutputTokens: 0,
}

describe('a Codex session stored by the control plane', () => {
  it('keeps every message readable as Codex wrote it, by its runtime column', async () => {
    const id = await newTask('codex-rows')
    await ingest(id, recorded)
    const rows = await rowsOf(id)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.kind === 'sdk' && row.runtime === 'codex')).toBe(true)
    const stored = await sql<{ runtime: string }[]>`SELECT DISTINCT runtime FROM task_message WHERE task_id = ${id}`
    expect(stored).toEqual([{ runtime: 'codex' }])
    expect((await tasks.get(id))?.session_id).toBe(ROOT)
  })

  it("ends a turn with its calls' tokens summed and their cost estimated from the price table", async () => {
    const id = await newTask('codex-spend')
    await ingest(id, recorded)
    const [end] = await turnEnds(id)
    expect(end?.usage).toEqual({ input: 900, output: 120, cacheRead: 3000, cacheWrite: 0, reasoning: 36 })
    expect(end?.costEstimated).toBe(true)
    expect(end?.costUsd).toBeCloseTo((900 * 5 + 3000 * 0.5 + 120 * 30) / 1_000_000, 10)
    const [task] = await sql<{ cost_usd: number }[]>`SELECT cost_usd FROM task WHERE id = ${id}`
    expect(task?.cost_usd).toBeCloseTo(end?.costUsd ?? 0, 10)
    const [column] = await sql<{ turn_usd: number }[]>`SELECT turn_usd FROM task_message
      WHERE task_id = ${id} AND event = 'turn.ended'`
    expect(column?.turn_usd).toBeCloseTo(end?.costUsd ?? 0, 10)
  })

  it('counts only the calls of the turn that ended, at long context rates past the threshold', async () => {
    const id = await newTask('codex-turns')
    await ingest(id, recorded)
    await ingest(id, oneCallTurn('turn-2', CALL))
    const [, second] = await turnEnds(id)
    expect(second?.usage).toEqual({ input: 300_000, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
    expect(second?.costUsd).toBeCloseTo((300_000 * 10 + 100 * 45) / 1_000_000, 10)
  })

  it('keeps the tokens and leaves the cost out for a model the table lacks', async () => {
    const id = await newTask('codex-unpriced')
    const [started, ...rest] = recorded
    const thread = { ...(started?.params.thread ?? {}), model: 'gpt-unlisted' }
    await ingest(id, [{ ...started, params: { thread } }, ...rest])
    const [end] = await turnEnds(id)
    expect(end?.usage?.output).toBe(120)
    expect(end?.costUsd).toBeUndefined()
    expect(end?.costEstimated).toBeUndefined()
  })

  it('reads the same from its archive and after a restore', async () => {
    const id = await newTask('codex-archive')
    await ingest(id, recorded)
    const before = await rowsOf(id)
    expect(await taskArchives.archive(id, 'user')).not.toBeNull()
    expect((await archivedPage(id, 200)).messages).toEqual(before)
    expect(await taskArchives.restore(id)).toMatchObject({ rows: before.length })
    expect(await rowsOf(id)).toEqual(before)
    const stored = await sql<{ runtime: string }[]>`SELECT DISTINCT runtime FROM task_message WHERE task_id = ${id}`
    expect(stored).toEqual([{ runtime: 'codex' }])
  })
})
