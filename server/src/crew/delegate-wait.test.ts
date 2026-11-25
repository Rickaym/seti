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
  const parked: (() => void)[] = []
  const fake = new FakeSdk(async function* (turn) {
    if (turn.text.includes('hold on')) {
      await new Promise<void>((resolve) => gates.set('held', resolve))
    }
    if (turn.text.includes('park')) {
      await new Promise<void>((resolve) => parked.push(resolve))
    }
    yield fakeAssistant(turn.text.includes('check the logs') ? 'The logs show two retries.' : 'Reported.')
    yield { ...fakeResult(), total_cost_usd: turn.text.includes('expensive') ? 6 : 0 }
  })
  return { fake, gates, parked }
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

function deleteTool() {
  const tool = SETI_TOOLS.find((candidate) => candidate.name === 'delete_agent')
  if (tool === undefined) {
    throw new Error('no delete_agent tool')
  }
  return tool
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

  it('refuses a fifth running helper, also when the starts come at once', async () => {
    const lead = await make()
    const results = await Promise.all(Array.from({ length: 6 }, async () => start(lead, { prompt: 'park here' })))
    expect(results.filter((result) => !result.error)).toHaveLength(4)
    for (const refused of results.filter((result) => result.error)) {
      expect(refused.text).toContain('You have 4 agents running already')
    }
    expect((await start(lead, { prompt: 'one more' })).text).toContain('You have 4 agents running already')
    await vi.waitFor(() => {
      expect(sdk.parked).toHaveLength(4)
    })
    for (const release of sdk.parked.splice(0)) {
      release()
    }
    for (const helper of await sql<{ id: string }[]>`SELECT id FROM task WHERE delegated_by = ${lead.id}`) {
      await waitIdle(helper.id)
    }
  })

  it('refuses a start once a day of helpers cost the budget, as their turns recorded, and keeps them from deletion', async () => {
    const lead = await make()
    for (let index = 0; index < 2; index += 1) {
      const { text } = await start(lead, { prompt: 'expensive work', wait_minutes: 5 })
      expect(text).toContain('ended=\\"idle\\"')
    }
    const [spent] = await sql<{ usd: number }[]>`SELECT SUM(cost_usd)::float8 AS usd FROM task
      WHERE delegated_by = ${lead.id}`
    expect(spent?.usd).toBe(12)
    expect((await start(lead, { prompt: 'one more' })).text).toContain('have cost $10 or more')
    const helper = await helperOf(lead.id)
    const deleted = await callSetiTool(deleteTool(), lead.id, { task: helper })
    expect(deleted.isError).toBe(true)
    expect(await tasks.get(helper)).toBeDefined()
  })
})
