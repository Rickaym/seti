import fs from 'node:fs'
import type { ChannelInput, ChannelSecret, EaInboxItem, EaWatch, PrInput } from '@seti/shared'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { messages, sql, tasks } from './db.js'
import { watchPrInputs } from './ea-watch.js'
import type { WatchedPr } from './github.js'
import { deliverInputs, wakeTask } from './inputs.js'
import type { PrSnapshot } from './pr-events.js'
import { createPrInputPoller } from './pr-inputs.js'
import { agentWaits } from './store/agent-waits.js'
import { auditEvents } from './store/audit.js'
import { setStall } from './task-blocked.js'
import { linkTaskPr } from './tasks.js'
import { USER_AUTH, EA_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-watch-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

/** Turns end at once, with an error result while `fail` is set and a question while `ask` is. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeAssistant, fakeResult } = await import('./fake-sdk.js')
  const state = { fail: false, ask: false }
  const fake = new FakeSdk(async function* () {
    if (state.ask) {
      yield await Promise.resolve(fakeAssistant('Shall I merge it?'))
    }
    yield await Promise.resolve(fakeResult(state.fail))
  })
  return { state, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const app = createApp()
const LOCAL = {
  host: '127.0.0.1:3006',
  ...USER_AUTH,
  origin: 'http://127.0.0.1:3006',
  'content-type': 'application/json',
}
const BOT = { ...LOCAL, ...EA_AUTH }
const PR = 'https://github.com/acme/web/pull/7'
let count = 0

async function newTask(mode: 'wake' | 'queue' | 'off' = 'wake', title = 'Voicemail'): Promise<string> {
  count += 1
  const id = `watch-task-${String(count)}`
  await tasks.insert({ id, title, repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
  await tasks.setInputMode(id, mode)
  return id
}

const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = BOT) =>
  app.request(`/api${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

async function watch(taskId: string) {
  const res = await request('POST', '/ea/watches', { task_id: taskId, note: 'the user wants to know' })
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: EaWatch }).data
}

const events = async (taskId: string) =>
  sql<EaInboxItem[]>`SELECT * FROM ea_inbox WHERE task_id = ${taskId} AND kind = 'watch_event' ORDER BY id`

const eventNames = async (taskId: string) => (await events(taskId)).map((e) => e.event)

/** Stands in for the EA taking everything that waits. */
async function takeAll(): Promise<void> {
  await sql`UPDATE ea_inbox SET delivered_at = ${new Date().toISOString()} WHERE delivered_at IS NULL`
}

async function turn(taskId: string, prompt: string): Promise<void> {
  expect((await request('POST', `/tasks/${taskId}/messages`, { prompt }, LOCAL)).status).toBe(200)
  await waitIdle(taskId)
}

const failing: PrInput = {
  source: 'pr',
  kind: 'ci_failed',
  subject: 'acme/web#7',
  title: 'CI failed on acme/web#7',
  body: 'Failing checks on aaaaaaa:\n- test (failure)',
  url: PR,
}
const review: PrInput = { ...failing, kind: 'review', title: 'octo approved acme/web#7', body: 'Looks good' }

beforeEach(async () => {
  sdk.state.fail = false
  sdk.state.ask = false
  await sql`DELETE FROM ea_inbox`
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('task watches', () => {
  it('lists, audits and removes watches; a task nobody watches makes no events', async () => {
    const watched = await newTask()
    const other = await newTask('wake', 'Dashboard')
    expect(await watch(watched)).toMatchObject({ task_id: watched, task_title: 'Voicemail' })
    expect(await auditEvents.latest('ea.watch_added')).toMatchObject({ subject_id: watched, detail: { via: 'ea' } })
    const listed = ((await (await request('GET', '/ea/watches')).json()) as { data: EaWatch[] }).data
    expect(listed.map((w) => w.task_id)).toContain(watched)

    expect((await request('POST', `/tasks/${other}/messages`, { prompt: 'go' }, LOCAL)).status).toBe(200)
    await waitIdle(other)
    expect(await events(other)).toEqual([])

    expect((await request('DELETE', `/ea/watches/${watched}`)).status).toBe(200)
    expect((await request('DELETE', `/ea/watches/${watched}`)).status).toBe(404)
    expect(await auditEvents.latest('ea.watch_removed')).toMatchObject({ subject_id: watched })
  })

  it('queues turn ends, questions and errors for the EA without touching the task', async () => {
    const id = await newTask()
    await watch(id)
    await turn(id, 'go')
    await vi.waitFor(async () => {
      expect(await eventNames(id)).toEqual(['turn_finished'])
    })
    await takeAll()
    sdk.state.ask = true
    await turn(id, 'again')
    await vi.waitFor(async () => {
      expect(await eventNames(id)).toEqual(['turn_finished', 'needs_you'])
    })
    await takeAll()
    sdk.state.ask = false
    sdk.state.fail = true
    await turn(id, 'once more')
    await vi.waitFor(async () => {
      expect(await eventNames(id)).toEqual(['turn_finished', 'needs_you', 'turn_errored'])
    })
    const [finished, asking, errored] = await events(id)
    expect(finished).toMatchObject({ title: 'Voicemail finished its turn', body: 'done', severity: 'success' })
    expect(finished?.urgent).toBe(false)
    expect(asking).toMatchObject({ title: 'Voicemail is asking you', severity: 'warning', urgent: true })
    expect(errored).toMatchObject({ title: 'Voicemail stopped with an error', severity: 'critical', urgent: true })
    const rows = (await messages.page(id, 100)).messages
    expect(rows.some((row) => row.kind === 'input' || row.kind === 'notice')).toBe(false)
  })

  it('keeps one current state per task until the EA takes it', async () => {
    const id = await newTask()
    await watch(id)
    sdk.state.fail = true
    await turn(id, 'go')
    await vi.waitFor(async () => {
      expect(await eventNames(id)).toEqual(['turn_errored'])
    })
    sdk.state.fail = false
    await turn(id, 'try again')
    await vi.waitFor(async () => {
      expect((await events(id)).map((e) => [e.event, e.urgent])).toEqual([['turn_finished', false]])
    })
  })

  it('tells the EA at once when a task it watches or waits on is blocked on the user', async () => {
    const watched = await newTask('wake', 'Linear sync')
    const awaited = await newTask('wake', 'Awaited')
    const other = await newTask('wake', 'Ignored')
    await watch(watched)
    await agentWaits.add(null, awaited, new Date().toISOString())
    const reason = 'Sign in to the linear MCP server in Seti'
    for (const id of [watched, awaited, other]) {
      await setStall(id, 'mcp', reason)
    }
    await vi.waitFor(async () => {
      expect(await events(watched)).toMatchObject([
        { event: 'needs_you', title: 'Linear sync is waiting on you', body: reason, urgent: true },
      ])
      expect(await eventNames(awaited)).toEqual(['needs_you'])
    })
    expect(await events(other)).toEqual([])
    for (const id of [watched, awaited, other]) {
      await setStall(id, 'mcp', null)
    }
  })

  it('reports a linked PR, CI results and merges on its PRs', async () => {
    const id = await newTask('off')
    await watch(id)
    await linkTaskPr(id, PR)
    const pr = (state: WatchedPr['state'], ci: WatchedPr['ci'], oid: string): WatchedPr => ({
      url: PR,
      subject: 'acme/web#7',
      state,
      closed_at: null,
      conflicting: false,
      head_oid: oid,
      ci,
      checks: ci === 'failure' ? [{ name: 'test', state: 'failure', detail: 'failure', url: null }] : [],
      reviews: [],
      comments: [],
    })
    const snapshots = new Map<string, PrSnapshot>()
    const deliver = vi.fn(async () => Promise.resolve())
    let current = pr('open', 'pending', 'a1')
    const poller = createPrInputPoller({
      watched: async () => Promise.resolve([PR]),
      listeners: async () => Promise.resolve([]),
      subtask: async () => Promise.resolve(null),
      snapshot: async (url) => Promise.resolve(snapshots.get(url)),
      save: async (url, next) => {
        snapshots.set(url, next)
        return Promise.resolve()
      },
      fetch: async () => Promise.resolve(new Map([[PR, current]])),
      viewer: async () => Promise.resolve('me'),
      deliver,
      eaWatchers: async () => Promise.resolve([id]),
      notifyEa: watchPrInputs,
      onError: (e) => {
        throw e
      },
    })
    await poller.poll()
    current = pr('open', 'failure', 'a1')
    await poller.poll()
    const failed = (await events(id)).find((e) => e.event === 'ci_failed')
    expect(failed).toMatchObject({ severity: 'critical', urgent: true })
    current = pr('open', 'success', 'b2')
    await poller.poll()
    expect((await events(id)).map((e) => [e.id, e.event, e.severity, e.urgent])).toEqual([
      [expect.any(Number), 'pr_linked', 'info', false],
      [failed?.id, 'ci_passed', 'success', false],
    ])
    await takeAll()
    current = pr('open', 'failure', 'c3')
    await poller.poll()
    current = pr('merged', 'failure', 'c3')
    await poller.poll()
    expect(await eventNames(id)).toEqual(['pr_linked', 'ci_passed', 'ci_failed', 'merged'])
    expect(deliver).not.toHaveBeenCalled()
    expect((await messages.page(id, 100)).messages).toEqual([])
  })

  it('says when updates wait for the user, not when a turn takes them', async () => {
    const held = await newTask('queue', 'Held')
    const woken = await newTask('wake', 'Woken')
    await watch(held)
    await watch(woken)
    await deliverInputs(held, [review])
    await deliverInputs(woken, [review])
    // Stands in for the debounced wake, which fires a few seconds later.
    await wakeTask(woken)
    await waitIdle(woken)
    const [waiting] = await events(held)
    expect(waiting).toMatchObject({ event: 'updates_waiting', title: 'Held has 1 update waiting' })
    expect(waiting?.body).toBe('- octo approved acme/web#7')
    await deliverInputs(held, [{ ...review, kind: 'comment', title: 'octo commented on acme/web#7' }])
    expect(await events(held)).toMatchObject([
      {
        id: waiting?.id,
        title: 'Held has 2 updates waiting',
        body: '- octo approved acme/web#7\n- octo commented on acme/web#7',
      },
    ])
    expect((await events(woken)).map((e) => e.event)).toEqual(['turn_finished'])
  })

  it('passes on waiting channel updates only from channels the EA subscribes to', async () => {
    const newChannel = async (name: string) => {
      const res = await request('POST', '/channels', { name, preset: 'generic' }, LOCAL)
      return ((await res.json()) as { data: ChannelSecret }).data.channel.id
    }
    const followed = await newChannel('Followed feed')
    const ignored = await newChannel('Ignored feed')
    expect((await request('POST', `/channels/${followed}/subscriptions`, { target: 'ea' }, LOCAL)).status).toBe(200)
    const update = (channelId: string, title: string): ChannelInput => ({
      source: 'channel',
      kind: 'alert',
      channel: channelId,
      channel_id: channelId,
      event_id: 1,
      severity: 'warning',
      subject: 'Feed',
      title,
      body: '',
      url: null,
      received_at: new Date().toISOString(),
    })
    const held = await newTask('queue', 'Feeds')
    await watch(held)

    await deliverInputs(held, [update(ignored, 'Ignored alert')])
    expect(await events(held)).toEqual([])
    await deliverInputs(held, [update(followed, 'Followed alert'), update(ignored, 'Ignored again')])
    const [waiting] = await events(held)
    expect(waiting).toMatchObject({ title: 'Feeds has 1 update waiting', body: '- Followed alert' })
  })
})
