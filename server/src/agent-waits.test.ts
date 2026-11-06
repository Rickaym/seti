import { auditQuery, type AgentInput, type Task } from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { archiveTask } from './archive.js'
import { messages, now, tasks } from './db.js'
import { wakeTask } from './inputs.js'
import { setPlannerModel } from './planner.js'
import { runTurn } from './runner.js'
import { SETI_TOOLS } from './seti-tools/catalog.js'
import { callSetiTool } from './seti-tools/server.js'
import { agentWaits } from './store/agent-waits.js'
import { auditEvents } from './store/audit.js'
import { eaInbox } from './store/inbox.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'

/** `say: <text>` ends the turn with that text; `slow` holds the turn until release() runs. */
const sdk = await vi.hoisted(async () => {
  const fakes = await import('./fake-sdk.js')
  const gate = { open: Promise.resolve(), release: (): void => undefined }
  const fake = new fakes.FakeSdk(async function* (fakeTurn) {
    if (fakeTurn.text.includes('slow')) {
      await gate.open
    }
    yield fakes.fakeAssistant(/say: (.*)$/s.exec(fakeTurn.text)?.[1] ?? 'ok')
    yield fakes.fakeResult()
  })
  return { fake, query: fake.query, gate }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

function holdTurns(): void {
  sdk.gate.open = new Promise((resolve) => {
    sdk.gate.release = () => {
      resolve()
    }
  })
}

const app = createApp()
let count = 0

async function newTask(extra: Partial<Pick<Task, 'seti_control' | 'input_mode'>> = {}): Promise<Task> {
  const id = `agent-wait-${String(++count)}`
  await tasks.insert({ id, title: `Agent ${String(count)}`, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  if (extra.seti_control !== undefined) {
    await tasks.setSetiControl(id, extra.seti_control)
  }
  if (extra.input_mode !== undefined) {
    await tasks.setInputMode(id, extra.input_mode)
  }
  const task = await tasks.get(id)
  if (!task) {
    throw new Error('task was not stored')
  }
  return task
}

const byText = (a: string, b: string) => a.localeCompare(b, 'en')
const controller = async () => newTask({ seti_control: 'full' })

async function call(caller: Task, name: string, args: unknown) {
  const entry = SETI_TOOLS.find((tool) => tool.name === name)
  if (!entry) {
    throw new Error(`no seti tool ${name}`)
  }
  const result = await callSetiTool(entry, caller.id, args)
  return { text: result.content.map((block) => block.text).join(''), isError: 'isError' in result }
}

async function turn(id: string, prompt: string): Promise<void> {
  await runTurn(id, prompt)
  await waitIdle(id)
}

const agentUpdates = async (id: string): Promise<AgentInput[]> =>
  (await messages.page(id, 200)).messages.flatMap((row) =>
    row.kind === 'input' && row.payload.source === 'agent' ? [row.payload] : [],
  )

afterEach(() => {
  sdk.gate.release()
  setPlannerModel(async () => Promise.reject(new Error('no model in tests')))
})

describe('await_agent', () => {
  it('hands the end of the next turn to the waiting agent once, with the final message', async () => {
    const caller = await controller()
    const target = await newTask()
    const result = await call(caller, 'await_agent', { task: target.id })
    expect(result).toEqual({ isError: false, text: expect.stringContaining('ends its next turn') as unknown })
    await turn(target.id, 'say: All 42 tests pass.')
    await vi.waitFor(async () => {
      expect(await agentUpdates(caller.id)).toHaveLength(1)
    })
    const [update] = await agentUpdates(caller.id)
    expect(update).toMatchObject({
      kind: 'idle',
      task_id: target.id,
      subject: target.title,
      title: `${target.title} finished its turn`,
      body: 'All 42 tests pass.',
    })
    // Stands in for the debounced wake, which fires a few seconds later.
    await wakeTask(caller.id)
    await waitIdle(caller.id)
    const prompt = sdk.fake.prompts.findLast((text) => text.includes('<agent-turn'))
    expect(prompt).toContain(`<agent-turn agent="${target.title}" task_id="${target.id}" ended="idle">`)
    expect(prompt).toContain('All 42 tests pass.')

    await turn(target.id, 'say: again')
    await waitIdle(caller.id)
    expect(await agentUpdates(caller.id)).toHaveLength(1)
    const [event] = (await auditEvents.page(auditQuery.parse({ kind: 'task.wait_added', limit: 1 }))).events
    expect(event).toMatchObject({ actor: 'agent', subject_id: target.id, detail: { agent_id: caller.id } })
  })

  it('waits for the current turn of a running agent', async () => {
    const caller = await controller()
    const target = await newTask()
    holdTurns()
    await runTurn(target.id, 'slow, then say: done at last')
    const result = await call(caller, 'await_agent', { task: target.id })
    expect(result.text).toContain('ends its current turn')
    sdk.gate.release()
    await waitIdle(target.id)
    await vi.waitFor(async () => {
      expect((await agentUpdates(caller.id)).map((update) => update.body)).toEqual(['done at last'])
    })
  })

  it('serves several waiters on one agent, and one waiter on several agents', async () => {
    const [first, second] = [await controller(), await controller()]
    const [one, two] = [await newTask(), await newTask()]
    for (const [caller, target] of [
      [first, one],
      [second, one],
      [first, two],
    ] as const) {
      expect((await call(caller, 'await_agent', { task: target.id })).isError).toBe(false)
    }
    await turn(one.id, 'say: one done')
    await turn(two.id, 'say: two done')
    await vi.waitFor(async () => {
      expect((await agentUpdates(first.id)).map((update) => update.body).toSorted(byText)).toEqual([
        'one done',
        'two done',
      ])
      expect((await agentUpdates(second.id)).map((update) => update.body)).toEqual(['one done'])
    })
  })

  it('is cancelled when either agent is archived', async () => {
    const caller = await controller()
    const [target, other] = [await newTask(), await newTask()]
    await call(caller, 'await_agent', { task: target.id })
    await call(caller, 'await_agent', { task: other.id })
    expect(await agentWaits.count(caller.id)).toBe(2)
    await archiveTask(target.id, { actor: 'user', removeWorktree: false })
    await vi.waitFor(async () => {
      expect(await agentWaits.count(caller.id)).toBe(1)
    })
    await archiveTask(caller.id, { actor: 'user', removeWorktree: false })
    await vi.waitFor(async () => {
      expect(await agentWaits.count(caller.id)).toBe(0)
    })
    await turn(other.id, 'say: nobody listens')
    expect(await agentUpdates(caller.id)).toEqual([])
  })

  it('refuses itself, an agent with Seti control off, and a waiter whose updates are off', async () => {
    const caller = await controller()
    const target = await newTask()
    expect((await call(caller, 'await_agent', { task: caller.id })).text).toContain('You cannot wait for yourself')
    expect((await call(await newTask({ seti_control: 'off' }), 'await_agent', { task: target.id })).text).toContain(
      'Seti control is off',
    )
    const deaf = await newTask({ seti_control: 'full', input_mode: 'off' })
    expect((await call(deaf, 'await_agent', { task: target.id })).text).toContain('Your updates are off')
    expect(await agentWaits.count(deaf.id)).toBe(0)
  })

  it('reports a turn that errored with its error', async () => {
    const caller = await controller()
    const target = await newTask()
    await call(caller, 'await_agent', { task: target.id })
    await tasks.setStatus(target.id, 'error', 'Agent crashed: out of memory')
    const { deliverAgentWaits } = await import('./agent-waits.js')
    await deliverAgentWaits(target.id, 'error')
    await vi.waitFor(async () => {
      expect(await agentUpdates(caller.id)).toMatchObject([
        { kind: 'error', title: `${target.title} stopped with an error`, body: 'Error: Agent crashed: out of memory' },
      ])
    })
  })
})

describe('notify_when_done', () => {
  it('on start_task hands back the end of the new agent first turn', async () => {
    const caller = await controller()
    setPlannerModel(async () => Promise.resolve({ title: 'Child agent' }))
    const started = await call(caller, 'start_task', { prompt: 'say: child finished', notify_when_done: true })
    expect(started.isError).toBe(false)
    const { id } = JSON.parse(started.text) as { id: string }
    await waitIdle(id)
    await vi.waitFor(async () => {
      expect(await agentUpdates(caller.id)).toMatchObject([{ task_id: id, body: 'child finished' }])
    })
  })

  it('is refused to the user, who does not wait through Seti', async () => {
    const target = await newTask()
    const res = await app.request(`/api/tasks/${target.id}/messages`, {
      method: 'POST',
      headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi', notify_when_done: true }),
    })
    expect(res.status).toBe(400)
    expect(await agentWaits.count(null)).toBe(0)
  })
})

describe('the EA', () => {
  it('waits once through watch_task and hears in its inbox', async () => {
    const target = await newTask()
    const res = await app.request('/api/ea/watches', {
      method: 'POST',
      headers: { host: 'localhost', ...EA_AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ task_id: target.id, once: true }),
    })
    expect(res.status).toBe(200)
    expect(await agentWaits.count(null)).toBe(1)
    await turn(target.id, 'say: report ready')
    await vi.waitFor(async () => {
      const due = await eaInbox.due(now(), 50)
      expect(due.filter((item) => item.task_id === target.id)).toMatchObject([
        { kind: 'watch_event', event: 'turn_finished', title: `${target.title} finished its turn`, body: 'done' },
      ])
    })
    expect(await agentWaits.count(null)).toBe(0)
  })
})
