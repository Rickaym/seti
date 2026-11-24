import { randomUUID } from 'node:crypto'
import type { AccessSavePreview } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { previewAccessSave, saveAccess } from './access-save.js'
import { asAgent, asMod } from './access.js'
import { createApp } from './app.js'
import { sql, tasks } from './db.js'
import { taskAccess } from './store/access.js'
import { taskHosts } from './store/change-requests.js'
import { contextPacks, taskContextPacks } from './store/context.js'
import { credentialAccess, credentialHosts } from './store/credential-access.js'
import { profiles } from './store/credentials.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'

const app = createApp()

async function send(url: string, body: unknown, auth: Record<string, string> = USER_AUTH) {
  return app.request(`/api${url}`, {
    method: 'POST',
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function agent(profileId: string, title: string) {
  const id = randomUUID()
  await tasks.insert({ id, title, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  await tasks.setProfile(id, profileId)
  return id
}

async function setup() {
  const ops = (await profiles.create(`Ops ${randomUUID().slice(0, 6)}`)).id
  const pack = (await contextPacks.create({ name: `p ${randomUUID().slice(0, 6)}`, description: '', body: 'x' })).id
  const [saver, follower, keeper] = [
    await agent(ops, 'saver'),
    await agent(ops, 'follower'),
    await agent(ops, 'keeper'),
  ]
  await taskAccess.set(saver, 'aws', 'aws', true)
  await taskContextPacks.setOne(saver, pack, true)
  await taskHosts.add(saver, 'api.stripe.com')
  await taskAccess.set(keeper, 'aws', 'aws', false)
  return { ops, pack, saver, follower, keeper }
}

describe("saving an agent's access into its credential", () => {
  it('previews what changes for which agents, SSH and AWS first, then saves it', async () => {
    const { ops, pack, saver, follower } = await setup()
    const res = await send(`/credentials/profiles/${ops}/access/preview`, { task_id: saver })
    const preview = ((await res.json()) as { data: AccessSavePreview }).data
    expect(preview.agents.toSorted((a, b) => a.localeCompare(b))).toEqual(['follower', 'keeper'])
    expect(preview.changes[0]).toMatchObject({
      kind: 'aws',
      enabled: true,
      was: null,
      turns: ['follower'],
      keeps: ['keeper'],
    })
    const packChange = preview.changes.find((change) => change.id === pack)
    expect(packChange?.enabled).toBe(true)
    expect(packChange?.turns.toSorted((a, b) => a.localeCompare(b))).toEqual(['follower', 'keeper'])
    expect(preview).toMatchObject({ hosts_added: ['api.stripe.com'], own_cleared: 2, own_hosts_cleared: 1 })

    expect(
      (await send(`/credentials/profiles/${ops}/access/save`, { task_id: saver, expect: '0'.repeat(64) })).status,
    ).toBe(409)
    expect(await credentialAccess.of(ops, 'aws')).toEqual({})
    const saved = await send(`/credentials/profiles/${ops}/access/save`, {
      task_id: saver,
      expect: preview.fingerprint,
    })
    expect(saved.status).toBe(200)
    expect(await credentialAccess.of(ops, 'aws')).toEqual({ aws: true })
    expect(await credentialHosts.list(ops)).toEqual(['api.stripe.com'])
    expect([await taskAccess.all(saver, 'aws'), await taskContextPacks.choices(saver)]).toEqual([{}, {}])
    expect(await taskHosts.list(saver)).toEqual([])
    expect(await taskAccess.all(follower, 'aws')).toEqual({})
    const [event] = await sql<{ detail: string }[]>`SELECT detail FROM audit_event
      WHERE subject_id = ${ops} AND kind = 'system.profile_changed' ORDER BY id DESC LIMIT 1`
    expect(JSON.parse(event?.detail ?? '{}')).toMatchObject({
      change: 'access_saved',
      from_agent: 'saver',
      hosts_added: ['api.stripe.com'],
      own_cleared: 3,
      agents_affected: 2,
    })
  })

  it('refuses a save without a preview, or after an agent joined or chose since', async () => {
    const { ops, saver, follower } = await setup()
    const save = async (fingerprint?: string) =>
      send(`/credentials/profiles/${ops}/access/save`, {
        task_id: saver,
        ...(fingerprint === undefined ? {} : { expect: fingerprint }),
      })
    const look = async () =>
      (
        (await (await send(`/credentials/profiles/${ops}/access/preview`, { task_id: saver })).json()) as {
          data: AccessSavePreview
        }
      ).data
    expect((await save()).status).toBe(400)
    const first = await look()
    await agent(ops, 'newcomer')
    expect((await save(first.fingerprint)).status).toBe(409)
    const second = await look()
    expect(second.agents).toContain('newcomer')
    await taskAccess.set(follower, 'aws', 'aws', false)
    expect((await save(second.fingerprint)).status).toBe(409)
    expect(await credentialAccess.all(ops)).toEqual([])
    expect((await save((await look()).fingerprint)).status).toBe(200)
  })

  it('refuses another credential, the EA, agents and mods', async () => {
    const { ops, saver } = await setup()
    const other = (await profiles.create(`Other ${randomUUID().slice(0, 6)}`)).id
    expect((await send(`/credentials/profiles/${other}/access/preview`, { task_id: saver })).status).toBe(409)
    const { fingerprint } = await previewAccessSave(ops, saver)
    for (const path of ['preview', 'save']) {
      const body = { task_id: saver, expect: fingerprint }
      expect((await send(`/credentials/profiles/${ops}/access/${path}`, body, EA_AUTH)).status).toBe(403)
    }
    const caller = { id: saver, title: 'saver', seti_control: 'full' as const }
    for (const write of [async () => saveAccess(ops, saver, fingerprint), async () => previewAccessSave(ops, saver)]) {
      await expect(asAgent(caller, write)).rejects.toMatchObject({ status: 403 })
      await expect(asMod({ id: 'sample', grants: [] }, write)).rejects.toMatchObject({ status: 403 })
    }
    expect(await credentialAccess.all(ops)).toEqual([])
  })
})
