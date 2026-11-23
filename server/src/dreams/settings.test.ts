import { randomUUID } from 'node:crypto'
import type { AuditPage, DreamSettings } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { asAgent } from '../access.js'
import { createApp } from '../app.js'
import { tasks } from '../db.js'
import { sessionOptions } from '../session-spec.js'
import { dreamSettings } from '../store/dream-nights.js'
import { dreamRuns } from '../store/dreams.js'
import { workspaceRows } from '../store/workspaces.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'
import { dreamsOn, setTaskDreaming, updateDreamSettings } from './settings.js'

const app = createApp()

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- names the response data type
async function send<T>(method: string, url: string, body?: unknown, auth: Record<string, string> = USER_AUTH) {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const parsed = (await res.json()) as { data?: T; error?: { detail: string } }
  return { status: res.status, data: parsed.data, error: parsed.error?.detail ?? '' }
}

async function agent(seti_control: 'self' | 'full' = 'full') {
  const id = randomUUID()
  const task = { id, title: `Agent ${id.slice(0, 4)}`, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] }
  await tasks.insert({ ...task, seti_control })
  const stored = await tasks.get(id)
  if (stored === undefined) {
    throw new Error('not stored')
  }
  return stored
}

const refusal = async (fn: () => Promise<unknown>) =>
  fn().then(
    () => null,
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  )

describe('Dreaming settings', () => {
  it('start off, need a zone to turn on, check what they are given, and audit each change', async () => {
    expect((await send<DreamSettings>('GET', '/dreams/settings')).data).toMatchObject({
      enabled: false,
      window_start: '01:00',
      window_end: '05:00',
      zone: null,
      model: 'claude-sonnet-5-5',
    })
    expect((await send('PUT', '/dreams/settings', { enabled: true })).error).toMatch(/Choose the zone/)
    expect((await send('PUT', '/dreams/settings', { zone: 'Mars/Olympus' })).error).toMatch(/Unknown zone/)
    expect((await send('PUT', '/dreams/settings', { dream_budget_usd: 6 })).error).toMatch(/more than the night/)
    expect((await send('PUT', '/dreams/settings', { window_end: '01:00' })).error).toMatch(/different start/)
    expect((await send('PUT', '/dreams/settings', { window_start: '1am' })).status).toBe(400)
    const on = await send<DreamSettings>('PUT', '/dreams/settings', { enabled: true, zone: 'Europe/Istanbul' }, EA_AUTH)
    expect(on.data).toMatchObject({ enabled: true, zone: 'Europe/Istanbul' })
    const audit = await send<AuditPage>('GET', '/audit?area=dream&limit=10')
    const changed = audit.data?.events.find((event) => event.kind === 'dream.settings_changed')
    expect(changed).toMatchObject({ summary: 'Turned Dreaming on' })
    expect(changed?.detail).toMatchObject({ enabled: true, enabled_was: false, via: 'ea' })
  })

  it("stay the user's and the EA's: agents cannot change them, whatever their level", async () => {
    const lead = await agent('full')
    expect(await refusal(async () => asAgent(lead, async () => updateDreamSettings({ at_once: 3 })))).toMatch(
      /Agents cannot change Dreaming settings/,
    )
  })

  it('switch an agent or a workspace out, and keep agents below Full and on themselves from switching', async () => {
    await dreamSettings.set({ ...(await dreamSettings.get()), enabled: true, zone: 'Europe/Istanbul' })
    const lead = await agent('full')
    const helper = await agent('self')
    const other = await agent('full')
    expect(await dreamsOn(other)).toBe(true)
    expect(await refusal(async () => asAgent(helper, async () => setTaskDreaming(other, false)))).toMatch(/Below/)
    expect(await refusal(async () => asAgent(lead, async () => setTaskDreaming(lead, false)))).toMatch(/yourself/)
    await asAgent(lead, async () => setTaskDreaming(other, false))
    expect(await dreamsOn(other)).toBe(false)
    expect((await send<{ tasks: string[] }>('GET', '/dreams/off')).data?.tasks).toContain(other.id)
    expect((await send('PUT', `/tasks/${other.id}/dreaming`, { on: true })).status).toBe(200)
    expect(await dreamsOn(other)).toBe(true)
    const [workspace] = await workspaceRows.list()
    expect((await send('PUT', `/workspaces/${workspace?.id ?? ''}/dreaming`, { on: false })).status).toBe(200)
    expect(await dreamsOn(other)).toBe(false)
    const options = await sessionOptions(lead, new AbortController())
    expect(options.settings).not.toHaveProperty('autoDreamEnabled')
    await send('PUT', `/workspaces/${workspace?.id ?? ''}/dreaming`, { on: true })
    const covered = await sessionOptions(lead, new AbortController())
    expect(covered.settings).toMatchObject({ autoDreamEnabled: false })
  })

  it('counts dreams as having run once one starts', async () => {
    const task = await agent()
    await dreamRuns.start({ task_id: task.id, night: '2026-11-23', kind: 'manual', model: 'claude-sonnet-5-5' })
    expect(await dreamRuns.any()).toBe(true)
  })
})
