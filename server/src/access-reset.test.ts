import { randomUUID } from 'node:crypto'
import type { TaskAccessView } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { resetTaskAccess } from './access-reset.js'
import { asAgent, asMod } from './access.js'
import { createApp } from './app.js'
import { sql, tasks } from './db.js'
import { taskAccess } from './store/access.js'
import { contextPacks, taskContextPacks } from './store/context.js'
import { credentialAccess } from './store/credential-access.js'
import { profiles } from './store/credentials.js'
import { taskMcpChoices } from './store/mcp.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'

const app = createApp()

const reset = async (taskId: string, auth: Record<string, string> = USER_AUTH) =>
  app.request(`/api/tasks/${taskId}/access/reset`, {
    method: 'POST',
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    body: '{}',
  })

async function agentOn(profileId: string) {
  const id = randomUUID()
  await tasks.insert({ id, title: 'resettable', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  await tasks.setProfile(id, profileId)
  return id
}

describe('resetting an agent to its credential', () => {
  it("drops every own choice, so each item follows the credential's set, and audits it once", async () => {
    const ops = (await profiles.create(`Ops ${randomUUID().slice(0, 6)}`)).id
    const pack = (await contextPacks.create({ name: `p ${randomUUID().slice(0, 6)}`, description: '', body: 'x' })).id
    await credentialAccess.set(ops, 'pack', pack, true)
    const id = await agentOn(ops)
    await taskContextPacks.setOne(id, pack, false)
    const res = await reset(id)
    expect(res.status).toBe(200)
    const view = ((await res.json()) as { data: TaskAccessView }).data
    expect(view.items.find((item) => item.id === pack)).toMatchObject({
      override: null,
      credential: true,
      enabled: true,
    })
    const events = await sql<{ summary: string }[]>`SELECT summary FROM audit_event WHERE subject_id = ${id}`
    expect(events.map((event) => event.summary)).toEqual([
      `Reset 1 own access choices of task "resettable" to ${(await profiles.get(ops))?.name ?? ''} and the defaults`,
    ])
  })

  it('refuses the EA, agents and mods, so a held-back off choice stays', async () => {
    const id = await agentOn('default')
    await taskAccess.set(id, 'aws', 'aws', true)
    await taskMcpChoices.set(id, { github: false })
    expect((await reset(id, EA_AUTH)).status).toBe(403)
    const task = await tasks.get(id)
    if (task === undefined) {
      throw new Error('no task')
    }
    const agent = { id: randomUUID(), title: 'Starter', seti_control: 'full' as const }
    await expect(asAgent(agent, async () => resetTaskAccess(task))).rejects.toMatchObject({ status: 403 })
    await expect(asMod({ id: 'sample', grants: [] }, async () => resetTaskAccess(task))).rejects.toMatchObject({
      status: 403,
    })
    expect([await taskAccess.all(id, 'aws'), await taskMcpChoices.get(id)]).toEqual([{ aws: true }, { github: false }])
  })

  it('switches the credential and resets in one step for the user, never for the EA', async () => {
    const ops = (await profiles.create(`Ops ${randomUUID().slice(0, 6)}`)).id
    const id = await agentOn('default')
    await taskAccess.set(id, 'aws', 'aws', false)
    const patch = async (auth: Record<string, string>) =>
      app.request(`/api/tasks/${id}`, {
        method: 'PATCH',
        headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ profile_id: ops, reset_access: true }),
      })
    expect((await patch(EA_AUTH)).status).toBe(403)
    expect((await patch(USER_AUTH)).status).toBe(200)
    expect((await tasks.get(id))?.profile_id).toBe(ops)
    expect(await taskAccess.all(id, 'aws')).toEqual({})
  })
})
