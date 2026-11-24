import { randomUUID } from 'node:crypto'
import type { AuditPage, DreamNight, DreamSettings } from '@seti/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { messages, tasks } from '../db.js'
import { dreamNights, dreamOptOuts, dreamSettings, nightRuns } from '../store/dream-nights.js'
import { dreamRuns } from '../store/dreams.js'
import { sandboxPolicy } from '../store/sandbox.js'
import { USER_AUTH } from '../test-auth.js'
import { dreamBriefLines } from './brief.js'
import { dreamTick, type DreamTickDeps } from './ticker.js'

const app = createApp()

async function get<T>(url: string): Promise<T> {
  const res = await app.request(`/api${url}`, { headers: { host: 'localhost', ...USER_AUTH } })
  return ((await res.json()) as { data: T }).data
}

const ISTANBUL: DreamSettings = {
  enabled: true,
  window_start: '01:00',
  window_end: '05:00',
  zone: 'Europe/Istanbul',
  model: 'claude-sonnet-5-5',
  dream_budget_usd: 1,
  night_budget_usd: 5,
  at_once: 1,
  cleanups: false,
}

async function agent(title: string, prompts: number, patch: { sandbox?: boolean } = {}): Promise<string> {
  const id = randomUUID()
  await tasks.insert({ id, title, repo_id: null, cwd: `/tmp/${id}`, worktree: false, pr_urls: [], ...patch })
  for (let i = 0; i < prompts; i++) {
    await messages.insert(id, { kind: 'prompt', payload: { text: `Work item ${String(i)}` } }, [])
  }
  return id
}

/** A clock, gates and a start that only claims the planned dream, so no session runs. */
function harness(at: string) {
  const started: string[] = []
  const state = {
    now: Date.parse(at),
    gate: null as string | null,
    refusal: null as { text: string; wait: boolean } | null,
  }
  const deps: DreamTickDeps = {
    now: () => state.now,
    gates: async () => Promise.resolve(state.gate),
    random: () => 0,
    start: async (task, planned) => {
      if (state.refusal !== null) {
        return state.refusal
      }
      started.push(task.title)
      await nightRuns.claim(planned.id, 'claude-sonnet-5-5', new Date(state.now).toISOString())
      return null
    },
  }
  const tick = async (iso?: string) => {
    if (iso !== undefined) {
      state.now = Date.parse(iso)
    }
    await dreamTick(deps)
  }
  return { started, state, tick }
}

const finish = async (taskId: string) => {
  const [run] = await dreamRuns.forTask(taskId, 1)
  if (run !== undefined) {
    await dreamRuns.end(run.id, {
      state: 'done',
      reason: null,
      cost_usd: 0.3,
      steps: 4,
      denials: 0,
      memory_changes: 1,
      report: {
        summary: 'Tidied',
        tidied: [],
        remembered: [],
        asks: ['Keep the old deploy notes?'],
        found: [],
        nothing_to_do: false,
      },
    })
  }
}

beforeAll(async () => {
  await sandboxPolicy.save({ enabled: true, allowed_domains: [], hidden_paths: [] })
})

describe('nightly Dreaming', () => {
  it('stays off until turned on, then plans a night once, busiest first, and leaves the rest out by reason', async () => {
    const busy = await agent('Busy', 3)
    const quiet = await agent('Quiet', 1)
    await agent('Idle', 0)
    const opted = await agent('Opted', 2)
    await dreamOptOuts.setTask(opted, false)
    await agent('Loose', 2, { sandbox: false })
    const { started, tick } = harness('2026-11-24T22:30:00Z')
    await tick()
    expect(await dreamNights.latest()).toBeUndefined()
    await dreamSettings.set(ISTANBUL)
    await tick()
    expect(started).toEqual(['Busy'])
    const night = await get<DreamNight>('/dreams?night=2026-11-25')
    expect(night).toMatchObject({ night: '2026-11-25', state: 'open', window_start: '2026-11-24T22:00:00.000Z' })
    expect(night.skipped).toEqual({ nothing_new: 1, opted_out: 1, not_sandboxed: 1 })
    expect(night.runs.map((run) => [run.task_id, run.state])).toEqual([
      [busy, 'running'],
      [quiet, 'planned'],
    ])
    await tick('2026-11-24T22:31:00Z')
    expect(started).toEqual(['Busy'])
    await finish(busy)
    await tick('2026-11-24T22:31:30Z')
    expect(started).toEqual(['Busy'])
    await tick('2026-11-24T22:32:00Z')
    expect(started).toEqual(['Busy', 'Quiet'])
    const audit = await get<AuditPage>('/audit?area=dream&limit=50')
    expect(audit.events.filter((event) => event.kind === 'dream.night_planned')).toHaveLength(1)
    await finish(quiet)
    await tick('2026-11-25T02:00:00Z')
    expect((await dreamNights.get('2026-11-25'))?.state).toBe('ended')
    const since = new Date(Date.now() - 60_000).toISOString()
    const [line] = await dreamBriefLines(since, new Date(Date.now() + 60_000).toISOString())
    expect(line).toMatchObject({ task_id: null, title: 'Dreams', text: '2 agents dreamt, 2 want you, $0.60' })
  })

  it('waits on the gates and on agents at work, then skips at the window end with the last reason', async () => {
    const id = await agent('Gated', 2)
    const { started, state, tick } = harness('2026-11-25T22:10:00Z')
    state.gate = 'host busy: load 14.0 of 12.0'
    await tick()
    expect(started).toEqual([])
    state.gate = null
    state.refusal = { text: 'The agent is at work; dream when its turn and background work end.', wait: true }
    await tick('2026-11-25T22:20:00Z')
    await tick('2026-11-25T22:25:00Z')
    const [planned] = (await nightRuns.of('2026-11-26')).filter((run) => run.task_id === id)
    expect([planned?.state, planned?.reason]).toEqual(['planned', expect.stringMatching(/at work/)])
    await tick('2026-11-26T02:00:00Z')
    const [skipped] = (await nightRuns.of('2026-11-26')).filter((run) => run.task_id === id)
    expect([skipped?.state, skipped?.reason]).toEqual(['skipped', expect.stringMatching(/at work/)])
    const audit = await get<AuditPage>('/audit?area=dream&limit=50')
    expect(audit.events.find((event) => event.kind === 'dream.night_ended')?.detail).toMatchObject({
      night: '2026-11-26',
    })
    await dreamOptOuts.setTask(id, false)
  })

  it('plans a dream a restart cut once more, and fails it when a second cut comes', async () => {
    const id = await agent('Cut twice', 2)
    const { started, tick } = harness('2026-11-26T22:05:00Z')
    await tick()
    expect(started).toEqual(['Cut twice'])
    await dreamRuns.cutRunning('Seti restarted during the dream.')
    await tick('2026-11-26T22:30:00Z')
    await tick('2026-11-26T22:35:00Z')
    expect(started).toEqual(['Cut twice', 'Cut twice'])
    await dreamRuns.cutRunning('Seti restarted during the dream.')
    await tick('2026-11-26T22:45:00Z')
    expect(started).toHaveLength(2)
    await tick('2026-11-27T02:00:00Z')
    const [run] = (await nightRuns.of('2026-11-27')).filter((r) => r.task_id === id)
    expect(run).toMatchObject({ state: 'failed', attempt: 2 })
    await dreamOptOuts.setTask(id, false)
  })

  it('ends the night when Dreaming is turned off, and records once a night Seti missed', async () => {
    const id = await agent('Switched off', 2)
    const { state, tick } = harness('2026-11-27T22:05:00Z')
    state.refusal = { text: 'The agent waits on you: answer its open request first.', wait: true }
    await tick()
    await dreamSettings.set({ ...ISTANBUL, enabled: false })
    await tick('2026-11-27T22:20:00Z')
    const [run] = (await nightRuns.of('2026-11-28')).filter((r) => r.task_id === id)
    expect([run?.state, run?.reason]).toEqual(['skipped', expect.stringMatching(/waits on you/)])
    expect((await dreamNights.get('2026-11-28'))?.state).toBe('ended')
    await dreamSettings.set(ISTANBUL)
    await tick('2026-12-01T03:30:00Z')
    await tick('2026-12-01T03:31:00Z')
    expect((await dreamNights.get('2026-12-01'))?.state).toBe('missed')
    const audit = await get<AuditPage>('/audit?area=dream&limit=50')
    expect(audit.events.filter((event) => event.kind === 'dream.night_missed')).toHaveLength(1)
    await dreamOptOuts.setTask(id, false)
  })

  it('finds the window on nights the clocks change, in Berlin and in New York', async () => {
    await agent('Daylight', 2)
    await dreamSettings.set({ ...ISTANBUL, zone: 'Europe/Berlin', window_start: '02:30', window_end: '04:00' })
    const { started, tick } = harness('2026-03-29T00:59:00Z')
    await tick()
    expect(await dreamNights.get('2026-03-29')).toBeUndefined()
    await tick('2026-03-29T01:00:00Z')
    expect(await dreamNights.get('2026-03-29')).toMatchObject({ window_start: '2026-03-29T01:00:00.000Z' })
    expect(started).toContain('Daylight')
    await tick('2026-03-29T02:00:00Z')
    await dreamSettings.set({ ...ISTANBUL, zone: 'America/New_York', window_start: '01:30', window_end: '05:00' })
    await tick('2026-11-01T05:29:00Z')
    expect(await dreamNights.get('2026-11-01')).toBeUndefined()
    await tick('2026-11-01T05:30:00Z')
    expect(await dreamNights.get('2026-11-01')).toMatchObject({
      window_start: '2026-11-01T05:30:00.000Z',
      window_end: '2026-11-01T10:00:00.000Z',
    })
  })
})
