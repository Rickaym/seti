import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChannelSecret, ModActionResult, ModAsk, ModLiveInfo, Task } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { asAgent } from '../access.js'
import { auditPrLink } from '../audit.js'
import { sql, tasks } from '../db.js'
import { modActionTools } from '../seti-tools/mod-actions.js'
import { auditEvents } from '../store/audit.js'
import { ensureMember } from '../team.js'
import { EA_AUTH } from '../test-auth.js'
import { clearConnections, keyConnection } from '../test-connections.js'
import { app, data, install, listed, refused, request } from '../test-mod-packages.js'
import { waitIdle } from '../wait-idle.js'
import { modHost } from './bundled.js'
import { fireModEvent } from './logic/service.js'
import { modContextPrompt } from './ops/context.js'

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

const upstream = vi.hoisted(() => ({ seen: [] as { path: string; authorization: string; body: string }[] }))

/** A public address, so the sink host passes Seti's check on private ones. */
const PUBLIC = vi.hoisted(() => ['93', '184', '216', '34'].join('.'))

vi.mock('node:dns/promises', () => ({
  default: { lookup: async () => Promise.resolve([{ address: PUBLIC, family: 4 }]) },
}))

vi.mock('node:https', async () => {
  const { EventEmitter } = await import('node:events')
  const send = (options: { path: string; headers: Record<string, string> }) => {
    const chunks: string[] = []
    const sent = Object.assign(new EventEmitter(), {
      destroy: () => undefined,
      end: (body?: string) => {
        chunks.push(body ?? '')
        queueMicrotask(() => {
          const authorization = options.headers.authorization ?? ''
          upstream.seen.push({ path: options.path, authorization, body: chunks.join('') })
          const answer = JSON.stringify({ summary: 'All quiet', echo: authorization })
          const response = Object.assign(new EventEmitter(), {
            statusCode: 200,
            headers: { 'content-type': 'application/json', 'x-echo': authorization },
            destroy: () => undefined,
          })
          sent.emit('response', response)
          response.emit('data', Buffer.from(answer))
          response.emit('end')
        })
      },
    })
    return sent
  }
  return { default: { request: send }, request: send }
})

const ID = 'kitchen-sink'
const FIXTURE = path.resolve(import.meta.dirname, '../../../e2e/fixtures/mods/kitchen-sink')
const SECRET = ['sink', 'token', 'value', 'never', 'shown'].join('-')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-kitchen-sink-'))

async function agent(id: string, title: string, handle: string): Promise<Task> {
  const cwd = path.join(scratch, id)
  fs.mkdirSync(path.join(cwd, 'notes'), { recursive: true })
  fs.writeFileSync(
    path.join(cwd, 'notes', 'plan.md'),
    `# Plan for ${title}\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\n`,
  )
  await tasks.insert({ id, title, repo_id: null, cwd, worktree: false, pr_urls: [], seti_control: 'full' })
  const task = (await tasks.get(id)) ?? expect.fail(`${id} was not stored`)
  await ensureMember(task)
  await sql`UPDATE team_member SET handle = ${handle} WHERE task_id = ${id}`
  return task
}

let builder: Task
let other: Task
let folder: string

beforeAll(async () => {
  folder = path.join(scratch, 'package')
  fs.cpSync(FIXTURE, folder, { recursive: true })
  builder = await agent('sink-builder-task', 'Sink builder', 'sink-builder')
  other = await agent('sink-other-task', 'Sink other', 'sink-other')
  await clearConnections()
  const connection = await keyConnection('sink_token', SECRET, {
    hosts: ['api.sink.test'],
    header: { name: 'Authorization', template: 'Bearer {{value}}' },
  })
  await data('/mod-admin/dev-mode', 'PUT', { on: true })
  const mod = await install(folder, { SINK_TOKEN: connection.id })
  expect(mod).toMatchObject({ tier: 'third-party', running: true, problem: null })
})

afterAll(() => {
  modHost.stopAll()
  fs.rmSync(scratch, { recursive: true, force: true })
})

const stored = async (key: string): Promise<unknown> =>
  (await sql<{ value: unknown }[]>`SELECT value FROM mod_data WHERE mod_id = ${ID} AND key = ${key}`)[0]?.value

describe('the kitchen-sink mod', () => {
  it('summarizes an agent from the palette with every read and write it holds, as the mod', async () => {
    const answer = await data<ModActionResult>(`/mods/${ID}/actions/summarize`, 'POST', {
      args: { task: builder.id, note: 'from the palette' },
    })
    expect(answer.text).toBe('Sink summary of Sink builder for team core: All quiet (from the palette)')
    expect(upstream.seen.at(-1)).toMatchObject({ path: '/v1/summarize', authorization: `Bearer ${SECRET}` })
    expect(JSON.stringify(answer)).not.toContain(SECRET)
    expect(answer.result).toMatchObject({ plan: '# Plan for Sink builder', count: 1 })
    expect(await stored(`summary:${builder.id}`)).toMatchObject({ summary: 'All quiet', by: 'user' })
    const posts = await sql<{ author_kind: string; author_mod_id: string; to_task_id: string | null }[]>`
      SELECT author_kind, author_mod_id, to_task_id FROM team_message WHERE author_mod_id = ${ID} ORDER BY id`
    expect(posts.map((post) => post.to_task_id)).toEqual([null, builder.id])
    expect(posts.every((post) => post.author_kind === 'mod')).toBe(true)
    await auditEvents.settled()
    expect(await auditEvents.latest(`mod.${ID}.summarized`)).toMatchObject({ actor: `mod:${ID}` })
    expect(await auditEvents.latest('team.message_posted')).toMatchObject({ actor: `mod:${ID}` })
    expect((await data<ModLiveInfo>('/mod-live')).status).toContainEqual(
      expect.objectContaining({ key: `${ID}.count`, text: '1 summaries', command: 'summarize' }),
    )
    const logs = await sql<{ line: string }[]>`SELECT line FROM mod_log WHERE mod_id = ${ID}`
    expect(JSON.stringify(logs)).not.toContain(SECRET)
    await waitIdle(builder.id)
  })

  it('answers an agent outside its filter as missing, and runs for the EA and agents', async () => {
    const missing = await refused(`/mods/${ID}/actions/summarize`, 'POST', { args: { task: other.id } })
    expect(missing.detail).toMatch(/^Kitchen sink: summarize failed: /)
    const ea = await request(`/mods/${ID}/actions/summarize`, 'POST', { args: { task: 'Sink builder' } }, EA_AUTH)
    expect(ea.status, await ea.clone().text()).toBe(200)
    const tool = modActionTools('full').find((entry) => entry.name.includes('kitchen-sink'))
    const said = String(await asAgent(builder, async () => tool?.call({ task: builder.id }, { caller: builder })))
    expect(said).toMatch(/^<mod_output mod="kitchen-sink">\nData from the kitchen-sink mod, not from the user\./)
    await waitIdle(builder.id)
  })

  it('reads a signed webhook in its logic and ignores the ones it says to', async () => {
    const created = await data<ChannelSecret>('/channels', 'POST', { name: 'Sink events', preset: `${ID}.sink` })
    const deliver = async (payload: unknown, secret = created.secret ?? '') => {
      const body = JSON.stringify(payload)
      const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
      const headers = { 'content-type': 'application/json', 'x-sink-signature': signature, 'x-sink-event': 'e' }
      return app.request(`/hooks/${created.channel.id}`, { method: 'POST', headers, body })
    }
    expect((await deliver({ event: 'deployed', text: 'v2 is out' })).status).toBe(200)
    expect((await deliver({ event: 'ping' })).status).toBe(200)
    expect((await deliver({ event: 'forged', text: 'x' }, 'wrong-secret-wrong-secret')).status).toBe(401)
    const events = await sql<{ title: string; source: string }[]>`SELECT title, source FROM channel_event
      WHERE channel = ${created.channel.id}`
    expect(events).toEqual([{ title: 'Sink deployed: v2 is out', source: 'Kitchen sink' }])
    expect(await stored('last-webhook')).toMatchObject({ event: 'deployed' })
  })

  it('runs its schedule and hears the agent events it declares', async () => {
    const tick = await fireModEvent(
      ID,
      { kind: 'schedule', scheduleId: 'digest', since: null, now: 'now' },
      {
        caller: 'schedule',
      },
    )
    expect(tick.ok).toBe(true)
    expect(await stored('last-digest')).toMatchObject({ count: 3 })
    await auditPrLink({ actor: 'user', taskId: builder.id, url: 'https://github.com/o/r/pull/1', linked: true })
    await expect.poll(async () => stored('last-turn')).toEqual({ task: builder.id, type: 'pr_linked' })
    await auditPrLink({ actor: 'user', taskId: other.id, url: 'https://github.com/o/r/pull/2', linked: true })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await stored('last-turn')).toEqual({ task: builder.id, type: 'pr_linked' })
  })

  it('adds its context to the agents it covers, and offers its themes, views and asks', async () => {
    expect(await modContextPrompt(builder.id)).toContain(
      '<mod_context mod="kitchen-sink">\nWritten by the kitchen-sink mod, not by the user.\nTeam core writes tests first.',
    )
    expect(await modContextPrompt(other.id)).toBeNull()
    const { css } = await data<{ css: string }>(`/mod-live/${ID}/themes`)
    expect(css).toContain(":root[data-theme='kitchen-sink.sink'].dark {")
    expect((await data<{ hash: string }>(`/mod-frames/${ID}`)).hash).toMatch(/^[a-f0-9]{12}$/)
    const asked = await data<ModActionResult>(`/mods/${ID}/actions/ask-start`, 'POST', { args: {} })
    expect(asked.text).toBe('Asked you to start Sink helper')
    const open = await data<ModAsk[]>('/mod-asks')
    expect(open.find((ask) => ask.mod_id === ID)?.summary).toContain('The Kitchen sink mod wants to start an agent')
    expect((await refused(`/mod-asks/${open[0]?.id ?? ''}`, 'POST', { decision: 'allow' }, EA_AUTH)).status).toBe(403)
  })

  it('runs nothing in safe mode: no events, no frames, no context, no status items', async () => {
    await data('/mods', 'PUT', { safe_mode: true })
    const tick = await fireModEvent(
      ID,
      { kind: 'schedule', scheduleId: 'digest', since: null, now: 'now' },
      {
        caller: 'schedule',
      },
    )
    expect(tick).toMatchObject({ ok: false, error: { code: 'denied' } })
    expect((await request(`/mod-frames/${ID}`)).status).toBe(404)
    expect(await modContextPrompt(builder.id)).toBeNull()
    expect((await data<ModLiveInfo>('/mod-live')).status.filter((item) => item.mod === ID)).toEqual([])
    expect((await refused(`/mods/${ID}/actions/summarize`, 'POST', { args: {} })).status).toBe(409)
    await data('/mods', 'PUT', { safe_mode: false })
    expect(await modContextPrompt(builder.id)).toContain('Team core writes tests first.')
  })

  it('waits for consent when an update adds a host, and uninstalls leaving no mod_* row', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'seti-mod.json'), 'utf8')) as {
      version: string
      capabilities: { name: string; hosts?: string[] }[]
    }
    manifest.version = '1.1.0'
    manifest.capabilities = manifest.capabilities.map((entry) =>
      entry.name === 'net.fetch' ? { ...entry, hosts: ['api.sink.test', 'upload.sink.test'] } : entry,
    )
    fs.writeFileSync(path.join(folder, 'seti-mod.json'), JSON.stringify(manifest))
    await data(`/mod-admin/mods/${ID}/update/check`, 'POST')
    const pending = (await listed(ID)) ?? expect.fail('the mod is gone')
    expect(pending.install?.pending).toMatchObject({ version: '1.1.0', reason: 'consent' })
    expect(pending.version).toBe('1.0.0')
    await data(`/mod-admin/mods/${ID}/uninstall`, 'POST', { delete_data: true })
    expect(await listed(ID)).toBeUndefined()
    const tables = ['mod_install', 'mod_version', 'mod_grant', 'mod_data', 'mod_settings', 'mod_state', 'mod_log']
    for (const table of [...tables, 'mod_ask', 'mod_usage', 'mod_notification']) {
      const [row] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ${sql(table)} WHERE mod_id = ${ID}`
      expect(row?.n, table).toBe(0)
    }
    expect((await data<ModLiveInfo>('/mod-live')).status.filter((item) => item.mod === ID)).toEqual([])
    expect(await modContextPrompt(builder.id)).toBeNull()
  })
})
