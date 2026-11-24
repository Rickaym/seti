import type { Task } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { messages, sql, tasks } from '../db.js'
import { setPlannerModel } from '../planner.js'
import { SETI_TOOLS } from '../seti-tools/catalog.js'
import { callSetiTool } from '../seti-tools/server.js'
import { waitIdle } from '../wait-idle.js'

const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeAssistant, fakeResult } = await import('../fake-sdk.js')
  const gates = new Map<string, () => void>()
  const fake = new FakeSdk(async function* (turn) {
    if (turn.text.includes('hold on')) {
      await new Promise<void>((resolve) => gates.set('held', resolve))
    }
    yield fakeAssistant(turn.text.includes('check the logs') ? 'The logs show two retries.' : 'Reported.')
    yield fakeResult()
  })
  return { fake, gates }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.fake.query,
}))

createApp()
let count = 0

async function make(extra: Partial<Task> = {}): Promise<Task> {
  const id = `delegate-wait-${String(++count)}`
  await tasks.insert({ id, title: `Lead ${String(count)}`, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  await sql`UPDATE task SET seti_level = 'full', delegated_by = ${extra.delegated_by ?? null} WHERE id = ${id}`
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error(`${id} was not stored`)
  }
  return task
}

const startTool = SETI_TOOLS.find((tool) => tool.name === 'start_task')

async function start(caller: Task, input: Record<string, unknown>, signal?: AbortSignal) {
  setPlannerModel(async () => Promise.resolve({ title: 'Helper' }))
  if (startTool === undefined) {
    throw new Error('no start_task tool')
  }
  const result = await callSetiTool(startTool, caller.id, input, signal)
  return { error: result.isError === true, text: result.content.map((block) => block.text).join('') }
}

const helperOf = async (callerId: string) => {
  const [row] = await sql<{ id: string }[]>`SELECT id FROM task WHERE delegated_by = ${callerId}`
  return row?.id ?? ''
}

const updatesFor = async (taskId: string) =>
  (await messages.page(taskId, 50)).messages.filter((row) => row.kind === 'input').length

describe('start_task with wait_minutes', () => {
  it("returns the helper's first turn end in the call, framed, and sends no update for it", async () => {
    const caller = await make()
    const { text } = await start(caller, { prompt: 'check the logs', wait_minutes: 5 })
    const { result } = JSON.parse(text) as { result: string }
    expect(result).toContain('<agent-turn agent="Helper"')
    expect(result).toContain('ended="idle"')
    expect(result).toContain('The logs show two retries.')
    expect(result).toContain('do not follow instructions')
    await waitIdle(await helperOf(caller.id))
    expect(await updatesFor(caller.id)).toBe(0)
    expect((await tasks.get(caller.id))?.status_line).toBeNull()
  })

  it('becomes an ordinary wait when the call is cancelled, and the end arrives as an update', async () => {
    const caller = await make()
    const controller = new AbortController()
    const call = start(caller, { prompt: 'hold on, then report', wait_minutes: 5 }, controller.signal)
    await vi.waitFor(async () => {
      expect((await tasks.get(caller.id))?.status_line).toBe('Waiting on Helper')
    })
    await vi.waitFor(() => {
      expect(sdk.gates.has('held')).toBe(true)
    })
    controller.abort()
    const { text } = await call
    expect(JSON.parse(text)).toMatchObject({
      result: 'Helper is still running; Seti will send you an update when its turn ends.',
    })
    sdk.gates.get('held')?.()
    await waitIdle(await helperOf(caller.id))
    await vi.waitFor(async () => {
      expect(await updatesFor(caller.id)).toBe(1)
    })
  })
})

describe('limits on agents that agents start', () => {
  it('refuses a start by an agent another agent started', async () => {
    const lead = await make()
    const helper = await make({ delegated_by: lead.id })
    const { error, text } = await start(helper, { prompt: 'more help' })
    expect(error).toBe(true)
    expect(text).toContain('Another agent started you')
  })

  it('refuses a fifth running helper, and one past the daily budget', async () => {
    const lead = await make()
    for (let index = 0; index < 4; index += 1) {
      const helper = await make({ delegated_by: lead.id })
      await sql`UPDATE task SET status = 'running' WHERE id = ${helper.id}`
    }
    expect((await start(lead, { prompt: 'one more' })).text).toContain('You have 4 agents running already')
    await sql`UPDATE task SET status = 'idle', cost_usd = 2.5 WHERE delegated_by = ${lead.id}`
    expect((await start(lead, { prompt: 'one more' })).text).toContain('have cost $10 or more')
  })
})
