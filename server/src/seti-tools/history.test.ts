import type { AgentActivity, MessageBody, Task, TranscriptWindow } from '@seti/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { archiveTask } from '../archive.js'
import { sql, tasks, type BackfillMessage } from '../db.js'
import { fakeResult } from '../fake-sdk.js'
import { resolveWindow } from '../history-window.js'
import { reminderStore } from '../store/reminders.js'
import { agentCall, assistant, bash, completedResult, toolResult } from '../subtask-fixtures.js'
import { SETI_TOOLS } from './catalog.js'
import { USER_AUTH } from '../test-auth.js'
import { callSetiTool } from './server.js'

const ZONE = 'Indian/Cocos'
const BUSY = 'history-busy'
const QUIET = 'history-quiet'
const OLD = 'history-old'
const SUBAGENTS = 300
const PRS = 30
const DAYS = ['2026-10-25', '2026-10-26', '2026-10-27']
const TURNS_PER_DAY = 40
const REPLY = 'The rollout is checked and the dashboards agree with the logs. '.repeat(16)

const base = { repo_id: null, cwd: '/tmp', worktree: false, session_id: null, source_session_id: null }

/** A Orion-sized day: a prompt, a subagent, a command and a long reply per turn, from 03:00 UTC. */
function busyDay(day: string, dayIndex: number): BackfillMessage[] {
  const rows: BackfillMessage[] = []
  for (let turn = 0; turn < TURNS_PER_DAY; turn++) {
    const minute = (offset: number) =>
      new Date(Date.parse(`${day}T03:00:00.000Z`) + (turn * 15 + offset) * 60_000).toISOString()
    const id = `toolu_${String(dayIndex)}_${String(turn)}`
    const at = (body: MessageBody, offset: number) => rows.push({ body, at: minute(offset) })
    at({ kind: 'prompt', payload: { text: `${day} prompt ${String(turn)}` } }, 0)
    for (let sub = 0; sub < Math.ceil(SUBAGENTS / (DAYS.length * TURNS_PER_DAY)); sub++) {
      const subId = `${id}_${String(sub)}`
      at(agentCall(subId, `Review part ${subId}`), 1)
      at(completedResult(subId, `a_${subId}`, 'Done.'), 2)
    }
    at(bash(`${id}_bash`, 'pnpm test'), 3)
    at(toolResult(`${id}_bash`, 'all passed'), 4)
    at(assistant([{ type: 'text', text: `${day} reply ${String(turn)}. ${REPLY}` }]), 5)
    at({ kind: 'sdk', payload: { ...fakeResult(), result: `${day} final ${String(turn)}` } } as MessageBody, 6)
  }
  return rows
}

function toolNamed(name: string) {
  const found = SETI_TOOLS.find((entry) => entry.name === name)
  if (!found) {
    throw new Error(`no seti tool ${name}`)
  }
  return found
}

let caller: Task

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- names the result type
async function call<T>(name: string, args: unknown): Promise<{ text: string; value: T }> {
  const result = await callSetiTool(toolNamed(name), caller.id, args)
  const text = result.content.map((block) => block.text).join('')
  expect('isError' in result, text).toBe(false)
  return { text, value: JSON.parse(text) as T }
}

beforeAll(async () => {
  const prUrls = Array.from({ length: PRS }, (_, i) => `https://github.com/acme/app/pull/${String(i + 1)}`)
  await tasks.insertImported(
    { ...base, id: BUSY, title: 'Orion', pr_urls: prUrls },
    DAYS.flatMap((day, index) => busyDay(day, index)),
  )
  await sql`UPDATE task_pr SET linked_at = '2026-10-27T05:00:00.000Z' WHERE task_id = ${BUSY}
    AND pr_url = 'https://github.com/acme/app/pull/30'`
  await sql`UPDATE task_pr SET linked_at = '2026-10-20T05:00:00.000Z' WHERE task_id = ${BUSY}
    AND pr_url <> 'https://github.com/acme/app/pull/30'`
  await tasks.insertImported({ ...base, id: QUIET, title: 'Quiet', pr_urls: [] }, [
    { body: { kind: 'prompt', payload: { text: 'late on the 26th, local time' } }, at: '2026-10-26T18:00:00.000Z' },
    { body: { kind: 'prompt', payload: { text: 'on the 25th' } }, at: '2026-10-25T10:00:00.000Z' },
  ])
  await tasks.insertImported({ ...base, id: OLD, title: 'Old', pr_urls: [] }, [
    { body: { kind: 'prompt', payload: { text: 'archived work' } }, at: '2026-10-27T04:00:00.000Z' },
    { body: assistant([{ type: 'text', text: 'Archived reply.' }]), at: '2026-10-27T04:01:00.000Z' },
  ])
  await archiveTask(OLD, { actor: 'user', removeWorktree: false })
  await tasks.insert({ ...base, id: 'history-caller', title: 'Caller', pr_urls: [] })
  await sql`UPDATE task SET seti_level = 'full' WHERE id = 'history-caller'`
  const found = await tasks.get('history-caller')
  if (!found) {
    throw new Error('caller was not stored')
  }
  caller = found
})

describe('resolveWindow', () => {
  const now = new Date('2026-10-28T06:00:00.000Z')

  it('reads dates as whole local days and words against the clock', async () => {
    const day = await resolveWindow({ since: '2026-10-27', until: '2026-10-27', timezone: ZONE })
    expect(day.stored).toEqual({ from: '2026-10-26T17:30:00.000Z', to: '2026-10-27T17:30:00.000Z' })
    expect(day.view).toMatchObject({ since: '2026-10-27 00:00', until: '2026-10-28 00:00', timezone: ZONE })
    const yesterday = await resolveWindow({ since: 'yesterday', until: 'Yesterday', timezone: ZONE }, undefined, now)
    expect(yesterday.stored).toEqual(day.stored)
    const today = await resolveWindow({ timezone: 'UTC' }, 'today', now)
    expect(today.stored).toEqual({ from: '2026-10-28T00:00:00.000Z', to: null })
  })

  it('takes ISO times with an offset as given and local times in the zone', async () => {
    const window = await resolveWindow({ since: '2026-10-27T09:00', until: '2026-10-27T05:00:00Z', timezone: ZONE })
    expect(window.stored).toEqual({ from: '2026-10-27T02:30:00.000Z', to: '2026-10-27T05:00:00.000Z' })
  })

  it('refuses words it cannot read and windows that end first', async () => {
    await expect(resolveWindow({ since: 'last tuesday' })).rejects.toThrow('is not a time')
    await expect(resolveWindow({ since: '2026-10-27', until: '2026-10-26', timezone: ZONE })).rejects.toThrow(
      'ends before it starts',
    )
    await expect(resolveWindow({ since: 'today', timezone: 'Mars/Base' })).rejects.toThrow('Unknown timezone')
  })

  it("falls back to the user's stored timezone, then UTC", async () => {
    expect((await resolveWindow({})).view).toMatchObject({
      timezone: 'UTC',
      timezone_from: 'no timezone stored in Seti',
    })
    const schedule = { cron: '0 9 * * *', timezone: 'Asia/Rangoon' }
    const settings = { script: 'export default () => null', interval_s: 600, schedule, enabled: false }
    await reminderStore.create('zone-reminder', 'Zone', settings, '2026-10-01T00:00:00.000Z')
    expect((await resolveWindow({})).view).toMatchObject({
      timezone: 'Asia/Rangoon',
      timezone_from: 'the latest cron reminder',
    })
    await sql`DELETE FROM channel WHERE id = 'zone-reminder'`
  })
})

describe('get_task', () => {
  it('stays small for an agent with hundreds of subagents and many PRs, transcript first', async () => {
    const { text, value } = await call<Record<string, unknown>>('get_task', { task: BUSY })
    expect(text.length).toBeLessThan(20_000)
    expect(Object.keys(value).slice(0, 5)).toEqual(['id', 'title', 'status', 'workspace', 'transcript'])
    expect(value.subtasks).toEqual({
      counts: { completed: 360 },
      running: [],
      others: 'list_subtasks lists them',
    })
    expect(value.pr_urls).toHaveLength(10)
    expect(value.pr_count).toBe(PRS)
    expect((value.transcript as string[]).at(-1)).toContain('2026-10-27T12:51Z status: Turn finished')
  })
})

describe('list_subtasks', () => {
  it('lists the newest first up to a limit, with counts and a status filter', async () => {
    const { value } = await call<{ total: number; listed: string; subtasks: { description: string }[] }>(
      'list_subtasks',
      { task: BUSY },
    )
    expect(value.total).toBe(360)
    expect(value.listed).toBe('newest 30 of 360')
    expect(value.subtasks).toHaveLength(30)
    expect(value.subtasks[0]?.description).toMatch(/^Review part toolu_2_39_/)
    const none = await call<{ subtasks: unknown[] }>('list_subtasks', { task: BUSY, status: 'running' })
    expect(none.value.subtasks).toEqual([])
  })
})

describe('read_transcript', () => {
  it('reads one local day of prompts and replies, oldest first, paging back with the cursor', async () => {
    const window = { task: BUSY, since: '2026-10-27', until: '2026-10-27', timezone: ZONE }
    const first = await call<TranscriptWindow>('read_transcript', { ...window, limit: 30 })
    expect(first.text.length).toBeLessThan(26_000)
    expect(first.value.window).toMatchObject({ since: '2026-10-27 00:00', until: '2026-10-28 00:00' })
    expect(first.value.lines.at(-1)).toMatch(/^2026-10-27 19:20 agent: 2026-10-27 reply 39\./)
    expect(first.value.lines.every((line) => / (user|agent): /.test(line))).toBe(true)
    const seen = [...first.value.lines]
    let cursor = first.value.older_cursor
    while (cursor !== null) {
      const page = await call<TranscriptWindow>('read_transcript', { ...window, limit: 30, cursor })
      seen.unshift(...page.value.lines)
      cursor = page.value.older_cursor
    }
    expect(seen).toHaveLength(2 * TURNS_PER_DAY)
    expect(seen[0]).toBe('2026-10-27 09:30 user: 2026-10-27 prompt 0')
  })

  it('adds tool and subagent lines with include_tools', async () => {
    const { value } = await call<TranscriptWindow>('read_transcript', {
      task: BUSY,
      since: '2026-10-27T19:00',
      until: '2026-10-27T19:30',
      timezone: ZONE,
      include_tools: true,
    })
    const kinds = new Set(value.lines.map((line) => line.split(' ')[2]))
    expect(kinds).toEqual(new Set(['user:', 'agent:', 'tool:', 'subtask:', 'status:']))
    expect(value.older_cursor).toBeNull()
  })

  it('reads an archived agent from its archive', async () => {
    const { value } = await call<TranscriptWindow>('read_transcript', {
      task: OLD,
      since: '2026-10-27',
      timezone: ZONE,
    })
    expect(value.task).toMatchObject({ id: OLD, archived: true })
    expect(value.lines).toEqual(['2026-10-27 10:30 user: archived work', '2026-10-27 10:31 agent: Archived reply.'])
  })
})

describe('agent_activity', () => {
  it('lists each agent with turns in the window, most active first, with its last reply and new PRs', async () => {
    const { text, value } = await call<AgentActivity>('agent_activity', {
      since: '2026-10-27',
      until: '2026-10-27',
      timezone: ZONE,
    })
    expect(text.length).toBeLessThan(5_000)
    expect(value.agents.map((agent) => agent.id)).toEqual([BUSY, QUIET])
    expect(value.agents[0]).toMatchObject({
      title: 'Orion',
      prompts: 40,
      replies: 40,
      first_at: '2026-10-27 09:30',
      last_at: '2026-10-27 19:21',
      prs_linked: ['https://github.com/acme/app/pull/30'],
      last_reply: '2026-10-27 final 39',
    })
    expect(value.agents[1]).toMatchObject({ prompts: 1, replies: 0, last_reply: null })
    expect(value.archived_since.map((agent) => agent.id)).toEqual([OLD])
    const limited = await call<AgentActivity>('agent_activity', { since: '2026-10-25', timezone: ZONE, limit: 1 })
    expect(limited.value.agents.map((agent) => agent.id)).toEqual([BUSY])
    expect(limited.value.more).toBe(1)
  })
})

describe('history routes', () => {
  const app = createApp()
  const get = async <T>(path: string): Promise<T> => {
    const res = await app.request(`/api/history${path}`, { headers: { host: 'localhost', ...USER_AUTH } })
    expect(res.status).toBe(200)
    return ((await res.json()) as { data: T }).data
  }

  it('serve the activity view and one transcript window to the EA', async () => {
    const window = 'since=2026-10-26T17:30:00Z&until=2026-10-27T17:30:00Z'
    const seen = await get<AgentActivity>(`/activity?${window}`)
    expect(seen.agents.map((agent) => agent.id)).toEqual([BUSY, QUIET])
    const read = await get<TranscriptWindow>(`/tasks/${QUIET}?${window}&include_tools=true&limit=5`)
    expect(read.lines).toHaveLength(1)
    expect(read.lines[0]).toContain('user: late on the 26th, local time')
  })

  it('refuse a time it cannot read', async () => {
    const res = await app.request('/api/history/activity?since=soon', { headers: { host: 'localhost', ...USER_AUTH } })
    expect(res.status).toBe(400)
  })
})
