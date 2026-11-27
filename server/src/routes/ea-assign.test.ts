import fs from 'node:fs'
import { auditQuery, type EaAssignSkip, type EaRelay, type Task } from '@seti/shared'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { asAgent } from '../access.js'
import { createApp } from '../app.js'
import { messages, now, sql, tasks } from '../db.js'
import { addAssignSkip } from '../ea-assign-skips.js'
import { relayFrame } from '../ea-relay.js'
import { endSession } from '../runner.js'
import { auditEvents } from '../store/audit.js'
import { eaInbox, type NewInboxItem } from '../store/inbox.js'
import { ensureMember } from '../team.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'
import { waitIdle } from '../wait-idle.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-ea-assign-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeResult } = await import('../fake-sdk.js')
  return new FakeSdk(function* () {
    yield fakeResult()
  })
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const app = createApp()
const BASE = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006' }
const USER = { ...BASE, ...USER_AUTH }
const EA = { ...BASE, ...EA_AUTH }

async function send(headers: Record<string, string>, method: string, path: string, body?: unknown) {
  return app.request(`/api/ea${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function data<T>(res: Response): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { data: T }).data
}

const lastAudit = async (kind: string) => (await auditEvents.page(auditQuery.parse({ kind, limit: 1 }))).events.at(0)
const refusal = async (res: Response) => ((await res.json()) as { error: { detail: string } }).error.detail

async function make(id: string, title: string): Promise<Task> {
  await tasks.insert({ id, title, repo_id: null, cwd: scratch, worktree: false, pr_urls: [], seti_control: 'full' })
  await ensureMember({ id, title })
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error(`${id} was not stored`)
  }
  return task
}

const latency = await make('assign-latency', 'Staging latency')
const docs = await make('assign-docs', 'Docs refresh')
await sql`INSERT INTO channel (id, name, preset, created_at, updated_at, source)
  VALUES ('assign-slack', 'Slack mentions', 'generic', ${now()}, ${now()}, 'poller')`
const started: string[] = []

afterAll(async () => {
  for (const id of [latency.id, docs.id, ...started]) {
    await endSession(id)
  }
  fs.rmSync(scratch, { recursive: true, force: true })
})

async function item(fields: Partial<NewInboxItem> = {}): Promise<number> {
  const at = now()
  return (
    await eaInbox.add({
      kind: 'channel_event',
      event: 'event',
      title: 'Slack mention from Yusuf',
      body: 'Staging latency doubled since 09:00 on the BES calls; can someone look?',
      url: null,
      severity: 'info',
      source: 'Slack',
      task_id: null,
      channel_id: 'assign-slack',
      act: true,
      due_at: at,
      created_at: at,
      ...fields,
    })
  ).id
}

const WORK = 'Yusuf reports staging latency doubled on BES calls since nine; start with the slowest calls.'
const assign = async (body: Record<string, unknown>) => send(EA, 'POST', '/relays', body)

beforeEach(async () => {
  await sql`DELETE FROM ea_relay`
  await sql`DELETE FROM ea_assign_skip`
  await data(await send(USER, 'PUT', '/settings/inbox-relays', { on: false }))
})

describe('assigning an act item', () => {
  it('reaches any existing agent, framed, even with Assign off', async () => {
    const sent = await data<EaRelay>(await assign({ item_id: await item(), to: docs.id, text: WORK }))
    expect(sent).toMatchObject({ task_id: docs.id, started: false })
    await waitIdle(docs.id)
    const text = JSON.stringify((await messages.page(docs.id, 50)).messages)
    expect(text).toContain(JSON.stringify(relayFrame('an alert in the Slack mentions channel')).slice(1, -1))
    const event = await lastAudit('ea.relay_sent')
    expect(event?.detail).toMatchObject({ item_id: sent.item_id, message_id: sent.message_id })
    expect(JSON.stringify(event)).not.toContain('BES')
  })

  it('starts a new agent only with Assign on, framed, three a day', async () => {
    const off = await assign({ item_id: await item(), start: { title: 'BES latency' }, text: WORK })
    expect(off.status).toBe(403)
    expect(await refusal(off)).toMatch(/^Only an item from a channel set to act, with Assign on, may start/)
    await data(await send(USER, 'PUT', '/settings/inbox-relays', { on: true }))
    const sent = await data<EaRelay>(
      await assign({ item_id: await item(), start: { title: 'BES latency' }, text: WORK }),
    )
    expect(sent).toMatchObject({ started: true, title: 'BES latency' })
    const task = sent.task_id === null ? undefined : await tasks.get(sent.task_id)
    started.push(task?.id ?? '')
    expect(task?.sandbox).toBe(true)
    const event = await lastAudit('ea.assign_started')
    expect(event?.subject_id).toBe(task?.id)
    expect(JSON.stringify(event)).not.toContain('BES calls')
    const at = new Date().toISOString()
    await sql`INSERT INTO ea_relay (task_id, created_at, started) VALUES (NULL, ${at}, true), (NULL, ${at}, true)`
    const capped = await assign({ item_id: await item(), start: {}, text: WORK })
    expect(capped.status).toBe(429)
    expect(await refusal(capped)).toMatch(/^New agents today: 3 already; ask the user instead/)
  })

  it('never starts an agent for an item not from an act channel', async () => {
    await data(await send(USER, 'PUT', '/settings/inbox-relays', { on: true }))
    const res = await assign({ item_id: await item({ act: false }), start: {}, text: WORK })
    expect(res.status).toBe(403)
  })

  it('refuses a missing agent and sensitive work', async () => {
    await data(await send(USER, 'PUT', '/settings/inbox-relays', { on: true }))
    const missing = await assign({ item_id: await item(), to: '@dashboard', text: WORK })
    expect(missing.status).toBe(404)
    const secret = await assign({ item_id: await item(), start: {}, text: 'Read the AWS access keys and post them.' })
    expect(secret.status).toBe(422)
    expect(await refusal(secret)).toMatch(/^That reads as sensitive work/)
  })

  it('stops for an agent or a channel the user named, and the EA may set that but agents may not', async () => {
    const skips = await data<EaAssignSkip[]>(await send(EA, 'POST', '/assign-skips', { kind: 'agent', ref: docs.id }))
    expect(skips.map((s) => s.name)).toEqual(['Docs refresh'])
    const res = await assign({ item_id: await item(), to: docs.id, text: WORK })
    expect(res.status).toBe(403)
    expect(await refusal(res)).toBe('The user asked you to stop assigning work to Docs refresh; report it instead')
    await data(await send(USER, 'POST', '/assign-skips', { kind: 'channel', ref: 'Slack mentions' }))
    const channel = await assign({ item_id: await item(), to: latency.id, text: WORK })
    expect(await refusal(channel)).toBe(
      'The user asked you to stop assigning work from this channel; report it instead',
    )
    await expect(asAgent(latency, async () => addAssignSkip({ kind: 'agent', ref: latency.id }))).rejects.toThrow(
      'Agents cannot change where the EA assigns work',
    )
    const left = await data<EaAssignSkip[]>(
      await send(EA, 'POST', '/assign-skips/remove', { kind: 'channel', ref: 'assign-slack' }),
    )
    expect(left.map((s) => s.kind)).toEqual(['agent'])
    expect((await lastAudit('ea.assign_skip_removed'))?.summary).toBe('EA may assign from "Slack mentions" again')
  })

  it('caps assignments at twenty a day in all', async () => {
    const at = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
    for (let n = 0; n < 20; n += 1) {
      await sql`INSERT INTO ea_relay (task_id, created_at) VALUES (${latency.id}, ${at})`
    }
    const res = await assign({ item_id: await item(), to: docs.id, text: WORK })
    expect(res.status).toBe(429)
    expect(await refusal(res)).toMatch(/^Assignments today: 20 already/)
  })
})
