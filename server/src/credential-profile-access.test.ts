import { randomUUID } from 'node:crypto'
import type { CredentialProfile } from '@seti/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { asAgent, asMod } from './access.js'
import { createApp } from './app.js'
import { setProfileAccess, setProfileHost } from './credential-profiles.js'
import { sql, tasks } from './db.js'
import { allowedFor } from './store/change-requests.js'
import { contextPacks } from './store/context.js'
import { credentialAccess } from './store/credential-access.js'
import { profiles } from './store/credentials.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'

const app = createApp()

async function send(method: string, url: string, body?: unknown, auth: Record<string, string> = USER_AUTH) {
  return app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function data<T>(res: Response): Promise<T> {
  const text = await res.text()
  expect(res.status, text).toBe(200)
  return (JSON.parse(text) as { data: T }).data
}

let ops: string
let pack: string

beforeEach(async () => {
  ops = (await profiles.create(`Ops ${randomUUID().slice(0, 6)}`)).id
  pack = (await contextPacks.create({ name: `style ${randomUUID().slice(0, 6)}`, description: '', body: 'x' })).id
})

describe("editing a credential's access", () => {
  it('sets, shows and drops an item, and audits the agents that follow it', async () => {
    const id = randomUUID()
    await tasks.insert({ id, title: 'follower', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
    await tasks.setProfile(id, ops)
    const set = await data<CredentialProfile>(
      await send('PUT', `/credentials/profiles/${ops}/access`, { kind: 'pack', id: pack, enabled: true }),
    )
    expect(set.access.items).toEqual([{ kind: 'pack', id: pack, enabled: true }])
    const [event] = await sql<{ summary: string; detail: string }[]>`SELECT summary, detail FROM audit_event
      WHERE subject_id = ${ops} ORDER BY id DESC LIMIT 1`
    expect(event?.summary).toMatch(/^Set the context pack style \w+ to on in the credential Ops/)
    expect(JSON.parse(event?.detail ?? '{}')).toMatchObject({ change: 'access_item', agents_affected: 1 })
    const dropped = await data<CredentialProfile>(
      await send('PUT', `/credentials/profiles/${ops}/access`, { kind: 'pack', id: pack, enabled: null }),
    )
    expect(dropped.access.items).toEqual([])
  })

  it('refuses an item Seti does not know', async () => {
    const res = await send('PUT', `/credentials/profiles/${ops}/access`, { kind: 'pack', id: 'nope', enabled: true })
    expect(res.status).toBe(404)
  })

  it('adds and removes hosts its agents reach', async () => {
    const id = randomUUID()
    await tasks.insert({ id, title: 'h', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
    await tasks.setProfile(id, ops)
    const added = await data<CredentialProfile>(
      await send('POST', `/credentials/profiles/${ops}/hosts`, { host: 'API.Stripe.com' }),
    )
    expect(added.access.hosts).toEqual(['api.stripe.com'])
    expect(await allowedFor(id)).toContain('api.stripe.com')
    expect((await send('POST', `/credentials/profiles/${ops}/hosts`, { host: 'not a host' })).status).toBe(400)
    await data(await send('DELETE', `/credentials/profiles/${ops}/hosts/api.stripe.com`))
    expect(await allowedFor(id)).not.toContain('api.stripe.com')
  })

  it('refuses the EA, agents and mods on every route that writes it', async () => {
    const routes = [
      ['PUT', `/credentials/profiles/${ops}/access`, { kind: 'pack', id: pack, enabled: true }],
      ['POST', `/credentials/profiles/${ops}/hosts`, { host: 'api.stripe.com' }],
      ['DELETE', `/credentials/profiles/${ops}/hosts/api.stripe.com`, undefined],
    ] as const
    for (const [method, url, body] of routes) {
      expect((await send(method, url, body, EA_AUTH)).status, `${method} ${url}`).toBe(403)
    }
    const agent = { id: 't1', title: 'Agent', seti_control: 'full' as const }
    for (const write of [
      async () => setProfileAccess(ops, { kind: 'pack', id: pack, enabled: true }),
      async () => setProfileHost(ops, 'api.stripe.com', true),
    ]) {
      await expect(asAgent(agent, write)).rejects.toMatchObject({ status: 403 })
      await expect(asMod({ id: 'sample', grants: [] }, write)).rejects.toMatchObject({ status: 403 })
    }
    expect(await credentialAccess.of(ops, 'pack')).toEqual({})
  })
})
