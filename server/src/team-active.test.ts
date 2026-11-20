import fs from 'node:fs'
import type { TeamMember, TeamPosted } from '@seti/shared'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { messages, sql, tasks } from './db.js'
import { endSession, runTurn } from './runner.js'
import { activity } from './store/activity.js'
import { activeToday, startOfDay, todayZone } from './team-active.js'
import { ensureMember, postTeamMessage, TEAM_LOOP } from './team.js'
import { USER_AUTH } from './test-auth.js'
import { migrateWith } from './test-migration.js'
import { waitIdle } from './wait-idle.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-team-active-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

/** Turns of tasks in `hang` wait for release(). */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeResult } = await import('./fake-sdk.js')
  const state = { hang: new Set<string>(), release: new Map<string, () => void>() }
  const fake = new FakeSdk(async function* ({ signal, session }) {
    const task = session.options.env?.SETI_TASK_ID ?? ''
    if (state.hang.has(task)) {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          resolve()
        })
        state.release.set(task, resolve)
      })
    }
    yield fakeResult()
  })
  return { state, fake }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.fake.query,
}))

const app = createApp()
const LOCAL = { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' }
const LONG_AGO = '2000-01-01T00:00:00.000Z'
let taskNumber = 0
const created: string[] = []

/** A new agent that has not worked today unless the test says so. */
async function newTask(title: string, createdAt = LONG_AGO): Promise<string> {
  taskNumber += 1
  const id = `active-task-${String(taskNumber)}`
  created.push(id)
  await tasks.insert({ id, title, repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
  await sql`UPDATE task SET created_at = ${createdAt}, updated_at = ${createdAt} WHERE id = ${id}`
  await ensureMember({ id, title })
  return id
}

const workedToday = async (title: string) => newTask(title, new Date().toISOString())

const handleOf = async (id: string) => (await ensureMember({ id, title: '' })).handle

const modes = (posted: TeamPosted) => Object.fromEntries(posted.deliveries.map((d) => [d.task_id, d.mode]))

const sdkRow = async (taskId: string, at: string) =>
  sql`INSERT INTO task_message (task_id, kind, payload, outward, created_at)
    VALUES (${taskId}, 'sdk', '{"type":"assistant"}', '[]', ${at})`

async function busy(id: string): Promise<void> {
  sdk.state.hang.add(id)
  await runTurn(id, 'Work on it')
  await vi.waitFor(() => {
    expect(sdk.state.release.has(id)).toBe(true)
  })
}

async function release(id: string): Promise<void> {
  sdk.state.hang.delete(id)
  sdk.state.release.get(id)?.()
  sdk.state.release.delete(id)
  await waitIdle(id)
}

async function settle(posted: TeamPosted): Promise<void> {
  for (const delivery of posted.deliveries) {
    await waitIdle(delivery.task_id)
  }
}

const storeZone = (zone: string | null) =>
  vi.spyOn(activity, 'storedZone').mockResolvedValue(zone === null ? null : { zone, source: 'test' })

beforeEach(async () => {
  await sql`UPDATE task SET archived_at = ${LONG_AGO} WHERE archived_at IS NULL`
  storeZone('UTC')
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const id of created) {
    await endSession(id)
  }
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('today', () => {
  it('starts at local midnight in the zone', () => {
    const at = new Date('2026-11-20T02:00:00Z')
    expect(startOfDay(at, 'UTC').toISOString()).toBe('2026-11-20T00:00:00.000Z')
    expect(startOfDay(at, 'Europe/Berlin').toISOString()).toBe('2026-11-19T23:00:00.000Z')
    expect(startOfDay(at, 'America/New_York').toISOString()).toBe('2026-11-19T05:00:00.000Z')
  })

  it("reads the day in the user's stored timezone, else the host's", async () => {
    storeZone('Asia/Tokyo')
    expect(await todayZone()).toBe('Asia/Tokyo')
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone
    storeZone(null)
    expect(await todayZone()).toBe(host)
    storeZone('Not/AZone')
    expect(await todayZone()).toBe(host)
  })
})

describe('agents active today', () => {
  const AT = new Date('2030-06-15T10:00:00Z')

  it('counts agents created, running or with a turn today, never yesterday only or archived', async () => {
    const createdToday = await newTask('Created today', '2030-06-15T08:00:00.000Z')
    const endedToday = await newTask('Ended today')
    await sql`UPDATE task SET turn_ended_at = '2030-06-15T01:00:00.000Z' WHERE id = ${endedToday}`
    const ranToday = await newTask('Ran today')
    await sdkRow(ranToday, '2030-06-15T03:00:00.000Z')
    const running = await newTask('Running since yesterday')
    await sql`UPDATE task SET status = 'running' WHERE id = ${running}`
    const yesterday = await newTask('Yesterday only', '2030-06-14T09:00:00.000Z')
    await sql`UPDATE task SET turn_ended_at = '2030-06-14T23:59:00.000Z' WHERE id = ${yesterday}`
    await sdkRow(yesterday, '2030-06-14T23:00:00.000Z')
    const archived = await newTask('Archived today', '2030-06-15T08:00:00.000Z')
    await sql`UPDATE task SET archived_at = '2030-06-15T09:00:00.000Z' WHERE id = ${archived}`
    expect(await activeToday(AT)).toEqual(new Set([createdToday, endedToday, ranToday, running]))
    await sql`UPDATE task SET status = 'idle' WHERE id = ${running}`
  })

  it('draws the day boundary in the stored timezone', async () => {
    const late = await newTask('Late turn')
    await sql`UPDATE task SET turn_ended_at = '2030-06-14T21:00:00.000Z' WHERE id = ${late}`
    const evening = new Date('2030-06-15T02:00:00Z')
    storeZone('Europe/Berlin')
    expect(await activeToday(evening)).toEqual(new Set())
    storeZone('America/New_York')
    expect(await activeToday(evening)).toEqual(new Set([late]))
  })
})

describe('@active', () => {
  it('mentions every agent that worked today and stores the list with the message', async () => {
    const first = await workedToday('Ledger sync')
    const second = await workedToday('Billing export')
    const stale = await newTask('Stale agent')
    const archived = await workedToday('Archived agent')
    await sql`UPDATE task SET archived_at = ${new Date().toISOString()} WHERE id = ${archived}`
    const posted = await postTeamMessage({ kind: 'user' }, '@active please rebase on main')
    expect(modes(posted)).toEqual({ [first]: 'start', [second]: 'start' })
    const reached = [
      { handle: await handleOf(first), task_id: first, via: 'active' },
      { handle: await handleOf(second), task_id: second, via: 'active' },
    ].sort((a, b) => a.handle.localeCompare(b.handle))
    expect(posted.message.mentions).toEqual([{ handle: 'active', task_id: null }, ...reached])
    expect(posted.unknown).toEqual([])
    await settle(posted)
    const inputs = (await messages.page(first, 100)).messages.filter((row) => row.kind === 'input')
    expect(inputs.map((row) => row.payload)).toMatchObject([
      { source: 'team', kind: 'mention', message_id: posted.message.id },
    ])
    expect(await messages.page(stale, 100)).toMatchObject({ messages: [] })
  })

  it('joins a running turn at once for the user, like a named mention', async () => {
    const running = await workedToday('Deploy watcher')
    await busy(running)
    const posted = await postTeamMessage({ kind: 'user' }, '@active stop deploying')
    expect(modes(posted)).toEqual({ [running]: 'now' })
    await release(running)
  })

  it('leaves the author out, paces agents and skips muted agents', async () => {
    const author = await workedToday('Release author')
    const running = await workedToday('Busy worker')
    const muted = await workedToday('Muted listener')
    await app.request(`/api/team/members/${muted}`, {
      method: 'PATCH',
      headers: LOCAL,
      body: JSON.stringify({ muted: true }),
    })
    await busy(running)
    const posted = await postTeamMessage({ kind: 'task', taskId: author }, '@active main is green')
    expect(modes(posted)).toEqual({ [running]: 'next', [muted]: 'skipped' })
    expect(posted.message.mentions.map((mention) => mention.task_id)).not.toContain(author)
    await release(running)
  })

  it('holds two agents that keep reaching each other through @active', async () => {
    const a = await workedToday('Loop alpha')
    const b = await workedToday('Loop beta')
    for (let turn = 0; turn <= TEAM_LOOP.exchanges; turn += 1) {
      const [from, to] = turn % 2 === 0 ? [a, b] : [b, a]
      await postTeamMessage({ kind: 'task', taskId: from }, `@active round ${String(turn)}`)
      await waitIdle(to)
    }
    const looped = await postTeamMessage({ kind: 'task', taskId: b }, '@active and again')
    expect(looped.deliveries).toMatchObject([{ task_id: a, mode: 'held', reason: 'loop' }])
  })

  it('posts and reaches nobody when no agent worked today', async () => {
    await newTask('Quiet agent')
    const posted = await postTeamMessage({ kind: 'user' }, '@active anyone around?')
    expect(posted.deliveries).toEqual([])
    expect(posted.message.mentions).toEqual([{ handle: 'active', task_id: null }])
  })

  it('flags the agents that worked today in the roster and refuses @active as a recipient', async () => {
    const today = await workedToday('Roster today')
    const stale = await newTask('Roster stale')
    const response = await app.request('/api/team/members', { headers: LOCAL })
    const roster = ((await response.json()) as { data: TeamMember[] }).data
    const flag = (id: string) => roster.find((member) => member.task_id === id)?.active_today
    expect([flag(today), flag(stale)]).toEqual([true, false])
    const direct = await app.request('/api/team/messages', {
      method: 'POST',
      headers: LOCAL,
      body: JSON.stringify({ text: 'hi', to: 'active' }),
    })
    expect(direct.status).toBe(400)
  })
})

describe('team_active_handle migration', () => {
  const seed = (taken: boolean) => `
    INSERT INTO task (id, title, cwd, status, created_at, updated_at) VALUES
      ('holder', 'Active', '/tmp', 'idle', 'x', 'x'), ('other', 'Other', '/tmp', 'idle', 'x', 'x');
    INSERT INTO team_member (task_id, handle, muted, updated_at) VALUES
      ('holder', 'active', 0, 'x'), ('other', '${taken ? 'active-task' : 'other'}', 0, 'x');`
  const holder = async (taken: boolean) =>
    migrateWith('team_active_handle', seed(taken), async (tx) => {
      const [row] = await tx<{ handle: string }[]>`SELECT handle FROM team_member WHERE task_id = 'holder'`
      return row?.handle
    })

  it('frees @active for the reserved handle', async () => {
    expect(await holder(false)).toBe('active-task')
    expect(await holder(true)).toMatch(/^active-[0-9a-f]{8}$/)
  })
})
