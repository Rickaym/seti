import os from 'node:os'
import type { Task } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import type * as access from '../access.js'
import { asAgent, asMod } from '../access.js'
import { createApp } from '../app.js'
import { messages, sql, tasks } from '../db.js'
import { ensureMember } from '../team.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'
import { waitIdle } from '../wait-idle.js'
import { decideModAsk } from './asks.js'
import { callAs, probeManifest, valueOf } from './ops/test-probe.js'
import { runningMods } from './running.js'

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

const device = vi.hoisted(() => ({ on: false }))

vi.mock('../access.js', async (importOriginal) => {
  const real = await importOriginal<typeof access>()
  const deviceSource = { via: 'device', deviceId: 'd1', name: 'Phone', scopes: [], showNames: false }
  return { ...real, currentRequestSource: () => (device.on ? deviceSource : real.currentRequestSource()) }
})

const app = createApp()
const HOST = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006', 'content-type': 'application/json' }

async function agent(id: string, title: string): Promise<Task> {
  await tasks.insert({ id, title, repo_id: null, cwd: os.tmpdir(), worktree: false, pr_urls: [] })
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error(`${id} was not stored`)
  }
  await ensureMember(task)
  return task
}

const target = await agent('mod-asks-target', 'Target')
const HASH = 'a'.repeat(64)
const CAPABILITIES = [{ name: 'tasks.manage', actions: ['rename', 'start', 'stop'] }]
const manager = probeManifest(CAPABILITIES)
const renamer = probeManifest([{ name: 'tasks.manage', actions: ['rename'] }])

/** The probe installed and on, granted what its manifest asks for, as install leaves it. */
async function install(enabled: boolean): Promise<void> {
  const at = new Date().toISOString()
  await sql`INSERT INTO mod_install (mod_id, source_kind, source, current_hash, installed_at, updated_at)
    VALUES ('probe', 'folder', '/mods/probe', ${HASH}, ${at}, ${at}) ON CONFLICT (mod_id) DO NOTHING`
  await sql`INSERT INTO mod_grant (mod_id, hash, idx, capability, granted_at)
    VALUES ('probe', ${HASH}, 0, ${JSON.stringify(CAPABILITIES[0])}::text::jsonb, ${at}) ON CONFLICT DO NOTHING`
  await sql`INSERT INTO mod_state (mod_id, enabled, updated_at) VALUES ('probe', ${enabled}, ${at})
    ON CONFLICT (mod_id) DO UPDATE SET enabled = excluded.enabled`
  if (enabled) {
    runningMods.add('probe')
  } else {
    runningMods.delete('probe')
  }
}

const askOf = async (args: Record<string, unknown>) =>
  (valueOf(await callAs(manager, 'tasks.manage.start', args)) as { asked: string }).asked

describe('tasks.manage', () => {
  it('changes an agent only with the action granted', async () => {
    valueOf(await callAs(renamer, 'tasks.manage.rename', { id: target.id, title: 'Renamed' }))
    expect((await tasks.get(target.id))?.title).toBe('Renamed')
    const [row] = await sql<{ actor: string }[]>`SELECT actor FROM audit_event WHERE kind = 'task.renamed'`
    expect(row?.actor).toBe('mod:probe')
    expect(await callAs(renamer, 'tasks.manage.stop', { id: target.id })).toEqual({
      ok: false,
      error: { code: 'denied', message: 'The mod probe was not granted tasks.manage for stop' },
    })
    expect(await callAs(renamer, 'tasks.manage.pin', { id: target.id, on: true })).toEqual({
      ok: false,
      error: { code: 'denied', message: 'The mod probe was not granted tasks.manage for pin' },
    })
  })
})

describe('mod asks', () => {
  it('starts nothing until the user allows it, and then exactly what was asked', async () => {
    await install(true)
    const before = (await tasks.list()).length
    const asked = await askOf({ title: 'Fix ISS-12', prompt: 'Fix the flaky test in ISS-12' })
    expect(await tasks.list()).toHaveLength(before)
    const ask = await decideModAsk(asked, 'allow')
    expect(ask.state).toBe('done')
    const started = (await tasks.list()).find((task) => task.title === 'Fix ISS-12')
    expect(started).toMatchObject({ sandbox: true, seti_control: 'self', profile_id: 'default', bypass_until: null })
    await waitIdle(started?.id ?? '')
    const first = (await messages.page(started?.id ?? '', 10)).messages.find((row) => row.kind === 'prompt')
    expect(JSON.stringify(first)).toContain('the probe mod')
    expect(JSON.stringify(first)).toContain('Fix the flaky test in ISS-12')
    const [created] = await sql<{ actor: string }[]>`SELECT actor FROM audit_event
      WHERE kind = 'task.created' AND subject_id = ${started?.id ?? ''}`
    expect(created?.actor).toBe('mod:probe')
    await expect(decideModAsk(asked, 'allow')).rejects.toThrow('That ask is already allowed and done')
  })

  it('refuses answers from the EA, agents, mods and devices', async () => {
    const asked = await askOf({ title: 'Never', prompt: 'Never started' })
    const ea = await app.request(`/api/mod-asks/${asked}`, {
      method: 'POST',
      headers: { ...HOST, ...EA_AUTH },
      body: JSON.stringify({ decision: 'allow' }),
    })
    expect(ea.status).toBe(403)
    await expect(asAgent(target, async () => decideModAsk(asked, 'allow'))).rejects.toThrow('Only the user answers')
    await expect(asMod({ id: 'probe', grants: [] }, async () => decideModAsk(asked, 'allow'))).rejects.toThrow(
      'Only the user answers',
    )
    device.on = true
    await expect(decideModAsk(asked, 'allow')).rejects.toThrow('Only the user answers')
    device.on = false
    const denied = await app.request(`/api/mod-asks/${asked}`, {
      method: 'POST',
      headers: { ...HOST, ...USER_AUTH },
      body: JSON.stringify({ decision: 'deny' }),
    })
    expect(denied.status).toBe(200)
    expect((await tasks.list()).some((task) => task.title === 'Never')).toBe(false)
  })

  it('keeps a few asks open at most, and runs nothing for a mod that was turned off', async () => {
    await sql`DELETE FROM mod_ask`
    const asks = [await askOf({ title: 'A', prompt: 'a' }), await askOf({ title: 'B', prompt: 'b' })]
    asks.push((valueOf(await callAs(manager, 'tasks.manage.stop', { id: target.id })) as { asked: string }).asked)
    expect(await callAs(manager, 'tasks.manage.start', { title: 'D', prompt: 'd' })).toEqual({
      ok: false,
      error: { code: 'limit', message: 'The probe mod has 3 asks open already' },
    })
    await install(false)
    const ask = await decideModAsk(asks[0] ?? '', 'allow')
    expect(ask).toMatchObject({ state: 'failed', outcome: 'The probe mod is off or no longer holds tasks.manage' })
    expect((await tasks.list()).some((task) => task.title === 'A')).toBe(false)
  })
})
