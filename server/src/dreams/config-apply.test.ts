import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { dreamReport, type DreamConfigDecision, type DreamProposal, type DreamTidy, type Task } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { asAgent } from '../access.js'
import { createApp } from '../app.js'
import { sql, tasks } from '../db.js'
import { dreamRuns } from '../store/dreams.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'
import { applyConfig, configSnapshot, TIDIES_PER_DREAM, type ConfigSnapshot } from './config-apply.js'
import { undoTidy } from './config-undo.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-dream-config-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  return root
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

const app = createApp()
const DAY_MS = 24 * 60 * 60_000
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString()
const SECRET = 'whsec-never-in-a-dream-5f2c'

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- names the response data type
async function send<T>(method: string, url: string, auth: Record<string, string> = USER_AUTH) {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    ...(method === 'GET' ? {} : { body: '{}' }),
  })
  const parsed = (await res.json()) as { data?: T; error?: { detail: string } }
  return { status: res.status, data: parsed.data, error: parsed.error?.detail ?? '' }
}

async function agent(title: string): Promise<Task> {
  const id = randomUUID()
  const cwd = path.join(scratch, 'work', id)
  fs.mkdirSync(cwd, { recursive: true })
  await tasks.insert({ id, title, repo_id: null, cwd, worktree: false, pr_urls: [], sandbox: true })
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('not stored')
  }
  return task
}

/** A webhook with a secret, or a poller with secret names, hosts and a script. */
async function channel(name: string, source: 'webhook' | 'poller' = 'webhook'): Promise<string> {
  const id = randomUUID()
  await sql`INSERT INTO channel (id, name, preset, secret, created_at, updated_at, source)
    VALUES (${id}, ${name}, ${source === 'poller' ? 'poller' : 'generic'}, ${source === 'webhook' ? SECRET : null},
      ${daysAgo(90)}, ${daysAgo(90)}, ${source})`
  if (source === 'poller') {
    await sql`INSERT INTO channel_poller (channel_id, script, preset, interval_s, timeout_s, extra_hosts, secrets, enabled)
      VALUES (${id}, ${'curl https://poll.example.invalid --token $API_TOKEN'}, 'custom', 3600, 30,
        ${'["poll.example.invalid"]'}, ${'["API_TOKEN"]'}, false)`
  }
  return id
}

async function subscribe(task: Task, channelId: string, days: number, events: string[] | null = null) {
  const [row] = await sql<{ id: number }[]>`INSERT INTO channel_subscription
      (channel_id, target, task_id, events, delivery, created_at)
    VALUES (${channelId}, 'task', ${task.id}, ${events === null ? null : JSON.stringify(events)}, 'after_turn',
      ${daysAgo(days)}) RETURNING id::int AS id`
  if (row === undefined) {
    throw new Error('not subscribed')
  }
  return row.id
}

/** An event the channel took on a day, delivered to the subscription when one is named. */
async function event(channelId: string, days: number, kind: string, subscription?: number) {
  const [row] = await sql<{ id: number }[]>`INSERT INTO channel_event
      (channel, dedupe_key, source, severity, title, detail, occurred_at, created_at, kind)
    VALUES (${channelId}, ${randomUUID()}, 'test', 'info', 't', 'd', ${daysAgo(days)}, ${daysAgo(days)}, ${kind})
    RETURNING id::int AS id`
  if (row !== undefined && subscription !== undefined) {
    await sql`INSERT INTO channel_event_delivery (event_id, subscription_id, delivered_at)
      VALUES (${row.id}, ${subscription}, ${daysAgo(days)})`
  }
}

const startRun = async (task: Task) =>
  dreamRuns.start({ task_id: task.id, night: '2026-11-25', kind: 'manual', model: 'claude-sonnet-5-5' })

const apply = (decision: DreamConfigDecision['decision']) => (item: string) => ({
  item,
  decision,
  reason: 'its release shipped on 2026-10-01',
})

async function dreamOf(task: Task): Promise<{ run: Awaited<ReturnType<typeof startRun>>; snapshot: ConfigSnapshot }> {
  const run = await startRun(task)
  return { run, snapshot: await configSnapshot(task.id, run.night) }
}

const subscriptionRow = async (id: number) =>
  sql`SELECT id::int AS id, channel_id, target, task_id, events, mode, delivery, created_at
    FROM channel_subscription WHERE id = ${id}`

const deliveries = async (id: number) =>
  sql`SELECT event_id::int AS event_id, delivered_at FROM channel_event_delivery
    WHERE subscription_id = ${id} ORDER BY event_id`

describe("a dream's configuration list", () => {
  it('lists only its own unused subscriptions, with facts and no secret, script or host', async () => {
    const task = await agent('Lister')
    const other = await agent('Bystander')
    const hook = await channel('ci-alerts')
    const poller = await channel('jira-watch', 'poller')
    const quiet = await subscribe(task, hook, 60, ['deploy.done'])
    const off = await subscribe(task, poller, 45)
    const busyHook = await channel('busy')
    const busy = await subscribe(task, busyHook, 60)
    await event(hook, 3, 'build.failed')
    await event(hook, 50, 'deploy.done', quiet)
    await event(busyHook, 2, 'push', busy)
    await subscribe(task, await channel('young'), 5)
    const foreign = await subscribe(other, hook, 60)

    const { snapshot } = await dreamOf(task)
    expect([...snapshot.items.keys()].sort((a, b) => a.localeCompare(b))).toEqual(
      [`sub-${String(quiet)}`, `sub-${String(off)}`].sort((a, b) => a.localeCompare(b)),
    )
    expect(snapshot.text).toContain(`sub-${String(quiet)}: webhook "ci-alerts", takes deploy.done`)
    expect(snapshot.text).toContain('kinds build.failed, none for this agent')
    expect(snapshot.text).toContain(`sub-${String(off)}: poller "jira-watch"`)
    expect(snapshot.text).toContain('the poller is off, every 3600 s')
    expect(snapshot.text).toContain('Its other subscriptions (2)')
    const everything = JSON.stringify([...snapshot.items.values()]) + (snapshot.text ?? '')
    for (const hidden of [SECRET, 'API_TOKEN', 'poll.example.invalid', 'curl', `sub-${String(foreign)}`]) {
      expect(everything).not.toContain(hidden)
    }
  })
})

describe("applying a dream's configuration decisions", () => {
  it('applies a listed unused subscription, audited as the dream, and Undo restores it exactly', async () => {
    const task = await agent('Applier')
    const hook = await channel('release-watch')
    const sub = await subscribe(task, hook, 70, ['release'])
    await event(hook, 40, 'release', sub)
    await event(hook, 35, 'release', sub)
    const before = { row: await subscriptionRow(sub), deliveries: await deliveries(sub) }
    const { run, snapshot } = await dreamOf(task)

    const out = await applyConfig({ task, run, snapshot }, [apply('apply')(`sub-${String(sub)}`)], 'done')
    expect(out.found).toEqual([])
    expect(out.applied.map((t) => [t.label, t.state])).toEqual([['release-watch', 'applied']])
    expect(await subscriptionRow(sub)).toEqual([])
    const [audited] = await sql<{ actor: string; detail: string }[]>`SELECT actor, detail::text AS detail
      FROM audit_event WHERE kind = 'system.channel_unsubscribed' AND subject_id = ${task.id}`
    expect(audited?.actor).toBe('system')
    expect(JSON.parse(audited?.detail ?? '{}')).toMatchObject({ via: 'dream', run: run.id, channel: 'release-watch' })

    const tidies = await send<DreamTidy[]>('GET', `/dreams/tidies?task=${task.id}`)
    expect(tidies.data?.map((t) => t.reason)).toEqual(['its release shipped on 2026-10-01'])
    const id = out.applied[0]?.id ?? 0
    await expect(asAgent(task, async () => undoTidy(id))).rejects.toThrow(/Agents cannot/)
    const undone = await send<DreamTidy>('POST', `/dreams/tidies/${String(id)}/undo`, EA_AUTH)
    expect(undone.data?.state).toBe('undone')
    expect({ row: await subscriptionRow(sub), deliveries: await deliveries(sub) }).toEqual(before)
    expect((await send('POST', `/dreams/tidies/${String(id)}/undo`)).status).toBe(409)
    const [undoAudit] =
      await sql`SELECT 1 FROM audit_event WHERE kind = 'dream.tidy_undone' AND subject_id = ${task.id}`
    expect(undoAudit).toBeDefined()
    expect((await configSnapshot(task.id, run.night)).items.size).toBe(0)
  })

  it('refuses what it did not list, what is not a subscription, another agent and past the cap', async () => {
    const task = await agent('Capped')
    const other = await agent('Neighbour')
    const subs = await Promise.all(
      Array.from({ length: TIDIES_PER_DREAM + 1 }, async (_, i) =>
        subscribe(task, await channel(`old-${String(i)}`), 40),
      ),
    )
    const theirHook = await channel('theirs')
    const theirs = await subscribe(other, theirHook, 40)
    const { run, snapshot } = await dreamOf(task)
    const [first] = snapshot.items.values()
    if (first === undefined) {
      throw new Error('nothing listed')
    }
    const lookalike = { ...first, id: theirs, channel_id: theirHook }
    const forged: ConfigSnapshot = {
      ...snapshot,
      items: new Map([...snapshot.items, [`sub-${String(theirs)}`, lookalike]]),
    }
    const decisions = [
      ...subs.map((sub) => apply('apply')(`sub-${String(sub)}`)),
      apply('apply')(`sub-${String(theirs)}`),
      apply('apply')('sub-999999'),
      apply('apply')('host-api.example.com'),
      apply('apply')('mcp-github'),
    ]
    const out = await applyConfig({ task, run, snapshot: forged }, decisions, 'done')
    expect(out.applied).toHaveLength(TIDIES_PER_DREAM)
    expect(out.found).toEqual([
      `Seti: did not apply sub-${String(subs.at(-1))}: Seti applies at most ${String(TIDIES_PER_DREAM)} changes a dream`,
      `Seti: did not apply sub-${String(theirs)}: it is gone or no longer the agent's`,
      'Seti: did not apply sub-999999: it was not in the list Seti gave',
      'Seti: did not apply host-api.example.com: a dream changes only the subscriptions Seti listed',
      'Seti: did not apply mcp-github: a dream changes only the subscriptions Seti listed',
    ])
    expect(await subscriptionRow(theirs)).toHaveLength(1)
  })

  it('applies nothing when the dream was cut, stopped or failed', async () => {
    const task = await agent('Cut')
    const sub = await subscribe(task, await channel('cut-short'), 40)
    const { run, snapshot } = await dreamOf(task)
    for (const ended of ['cut', 'stopped', 'failed'] as const) {
      const out = await applyConfig({ task, run, snapshot }, [apply('apply')(`sub-${String(sub)}`)], ended)
      expect(out).toEqual({
        applied: [],
        found: ['Seti: changed no configuration, since the dream did not end on its own'],
      })
    }
    expect(await subscriptionRow(sub)).toHaveLength(1)
  })

  it('refuses a subscription that delivered or changed during the dream', async () => {
    const task = await agent('Moving')
    const hook = await channel('woke-up')
    const woke = await subscribe(task, hook, 40)
    const refiltered = await subscribe(task, await channel('refiltered'), 40)
    const { run, snapshot } = await dreamOf(task)
    await event(hook, 0, 'push', woke)
    await sql`UPDATE channel_subscription SET events = '["push"]' WHERE id = ${refiltered}`
    const out = await applyConfig(
      { task, run, snapshot },
      [apply('apply')(`sub-${String(woke)}`), apply('apply')(`sub-${String(refiltered)}`)],
      'done',
    )
    expect(out.applied).toEqual([])
    expect(out.found).toEqual([
      `Seti: did not apply sub-${String(woke)}: it delivered since, or the user kept it`,
      `Seti: did not apply sub-${String(refiltered)}: it changed during the dream`,
    ])
  })

  it('files a proposal the user alone allows, which then applies with an Undo', async () => {
    const task = await agent('Unsure')
    const sub = await subscribe(task, await channel('maybe-later'), 40)
    const { run, snapshot } = await dreamOf(task)
    const out = await applyConfig({ task, run, snapshot }, [apply('propose')(`sub-${String(sub)}`)], 'done')
    expect(out).toEqual({ applied: [], found: [] })
    const pending = await send<DreamProposal[]>('GET', `/dreams/proposals?task=${task.id}`)
    expect(pending.data?.map((p) => [p.kind, p.target])).toEqual([['unsubscribe', 'maybe-later']])
    const id = String(pending.data?.[0]?.id)
    const ea = await app.request(`/api/dreams/proposals/${id}`, {
      method: 'POST',
      headers: { host: 'localhost', ...EA_AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    })
    expect(ea.status).toBe(403)
    const allowed = await app.request(`/api/dreams/proposals/${id}`, {
      method: 'POST',
      headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    })
    expect(((await allowed.json()) as { data: DreamProposal }).data.state).toBe('allowed')
    expect(await subscriptionRow(sub)).toEqual([])
    expect((await send<DreamTidy[]>('GET', `/dreams/tidies?task=${task.id}`)).data?.map((t) => t.state)).toEqual([
      'applied',
    ])
  })

  it('takes decisions only in a well-formed report', () => {
    const report = { summary: 'Tidied', config: [{ item: 'sub-1', decision: 'apply', reason: 'done' }] }
    expect(dreamReport.safeParse(report).success).toBe(true)
    for (const config of [
      [{ item: 'sub-1', decision: 'delete', reason: 'x' }],
      [{ item: 'sub 1; rm -rf', decision: 'apply', reason: 'x' }],
      [{ item: 'sub-1', decision: 'apply', reason: '' }],
      [{ item: 'sub-1', decision: 'apply', reason: 'x', value: 'secret' }],
      Array.from({ length: 11 }, (_, i) => ({ item: `sub-${String(i)}`, decision: 'apply', reason: 'x' })),
    ]) {
      expect(dreamReport.safeParse({ summary: 'Tidied', config }).success).toBe(false)
    }
  })
})
