import { describe, expect, it } from 'vitest'
import { sql, tasks } from './db.js'
import { eaInbox } from './store/inbox.js'
import { dayStart, teamZone, workedToday } from './team-active.js'

const ZONE = 'Asia/Kolkata'
/** Noon on 2026-11-20 in Kolkata, which is UTC+05:30; that day began at 18:30 UTC the day before. */
const NOON = Date.parse('2026-11-20T06:30:00.000Z')

async function newTask(id: string): Promise<string> {
  await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  return id
}

/** Records a turn's prompt at `at`; a queued one joined a running turn instead of starting one. */
async function prompt(taskId: string, at: string, queued?: 'delivered'): Promise<void> {
  const payload = JSON.stringify({ text: 'Work on it', ...(queued === undefined ? {} : { queued }) })
  await sql`INSERT INTO task_message (task_id, kind, payload, outward, created_at)
    VALUES (${taskId}, 'prompt', ${payload}, '[]', ${at})`
}

async function storeZone(zone: string): Promise<void> {
  const at = new Date(NOON).toISOString()
  await eaInbox.add({
    kind: 'followup',
    event: 'followup',
    title: 'Check the deploy',
    body: '',
    url: null,
    severity: 'info',
    source: 'the EA',
    task_id: null,
    timezone: zone,
    due_at: at,
    created_at: at,
  })
}

describe('dayStart', () => {
  it('is local midnight in the zone', () => {
    expect(dayStart(NOON, ZONE)).toBe('2026-11-19T18:30:00.000Z')
    expect(dayStart(NOON, 'UTC')).toBe('2026-11-20T00:00:00.000Z')
    expect(dayStart(Date.parse('2026-11-20T04:00:00.000Z'), 'America/New_York')).toBe('2026-11-19T05:00:00.000Z')
  })

  it('follows a daylight saving change', () => {
    expect(dayStart(Date.parse('2026-03-29T12:00:00.000Z'), 'Europe/Berlin')).toBe('2026-03-28T23:00:00.000Z')
    expect(dayStart(Date.parse('2026-03-30T12:00:00.000Z'), 'Europe/Berlin')).toBe('2026-03-29T22:00:00.000Z')
  })
})

describe('workedToday', () => {
  it("counts the day in the host's zone until Seti stores the user's, then in the user's", async () => {
    expect(await teamZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    await storeZone(ZONE)
    expect(await teamZone()).toBe(ZONE)
  })

  it('takes turns that started from local midnight, never earlier ones or messages queued into a turn', async () => {
    await storeZone(ZONE)
    const late = await newTask('worked-late-yesterday')
    const early = await newTask('worked-early-today')
    const joined = await newTask('joined-a-turn-today')
    const never = await newTask('never-ran')
    await prompt(late, '2026-11-19T18:29:00.000Z')
    await prompt(early, '2026-11-19T18:31:00.000Z')
    await prompt(joined, '2026-11-19T18:00:00.000Z')
    await prompt(joined, '2026-11-20T05:00:00.000Z', 'delivered')
    const today = await workedToday(NOON)
    expect(today).toContain(early)
    expect(today).not.toContain(late)
    expect(today).not.toContain(joined)
    expect(today).not.toContain(never)
    expect(await workedToday(Date.parse('2026-11-19T18:00:00.000Z'))).toContain(late)
  })

  it('leaves out archived agents', async () => {
    await storeZone(ZONE)
    const archived = await newTask('archived-worker')
    await prompt(archived, '2026-11-20T01:00:00.000Z')
    expect(await workedToday(NOON)).toContain(archived)
    await sql`UPDATE task SET archived_at = ${new Date(NOON).toISOString()} WHERE id = ${archived}`
    expect(await workedToday(NOON)).not.toContain(archived)
  })
})
