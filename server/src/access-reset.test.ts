import { randomUUID } from 'node:crypto'
import type { TaskAccessView } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { sql, tasks } from './db.js'
import { taskAccess } from './store/access.js'
import { contextPacks, taskContextPacks } from './store/context.js'
import { credentialAccess } from './store/credential-access.js'
import { profiles } from './store/credentials.js'
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

  it('refuses the EA when an own choice is on SSH or AWS', async () => {
    const id = await agentOn('default')
    await taskAccess.set(id, 'aws', 'aws', true)
    expect((await reset(id, EA_AUTH)).status).toBe(403)
    expect(await taskAccess.all(id, 'aws')).toEqual({ aws: true })
  })
})
