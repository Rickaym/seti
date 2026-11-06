import { randomUUID } from 'node:crypto'
import { auditQuery, type ChangeRequest, type SetiControlLevel, type Task } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { asAgent } from './access.js'
import { createApp } from './app.js'
import { answerChangeRequest, expireChangeRequests, PENDING_MAX } from './change-requests.js'
import { connectionValue } from './connection-values.js'
import { setConnectionValue } from './connections.js'
import { messages, sql, tasks } from './db.js'
import { REQUEST_TOOLS } from './seti-tools/requests.js'
import { callSetiTool } from './seti-tools/server.js'
import { auditEvents } from './store/audit.js'
import { allowedFor } from './store/change-requests.js'
import { connectionRows } from './store/connections.js'
import { profiles } from './store/credentials.js'
import { sandboxPolicy } from './store/sandbox.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'

const app = createApp()
const [requestChange] = REQUEST_TOOLS

async function newTask(level: SetiControlLevel = 'self', sandbox = true): Promise<Task> {
  const id = randomUUID()
  const fields = { title: `Asker ${id.slice(0, 8)}`, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] }
  await tasks.insert({ id, ...fields, seti_control: level, sandbox })
  const task = await tasks.get(id)
  if (!task) {
    throw new Error('task was not stored')
  }
  return task
}

async function ask(caller: Task, change: object, reason = 'The build fetches its fixtures from there.') {
  if (requestChange === undefined) {
    throw new Error('no request_change tool')
  }
  const result = await callSetiTool(requestChange, caller.id, { change, reason })
  const text = result.content.map((block) => block.text).join('')
  return { text, isError: 'isError' in result, json: () => JSON.parse(text) as { request: ChangeRequest } }
}

const answer = async (task: Task, id: string, body: object, auth: Record<string, string> = USER_AUTH) =>
  app.request(`/api/tasks/${task.id}/change-requests/${id}`, {
    method: 'POST',
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const updates = async (taskId: string) =>
  (await messages.page(taskId, 20)).messages.flatMap((row) =>
    row.kind === 'input' && row.payload.source === 'seti' ? [row.payload] : [],
  )

const lastAudit = async (kind: string) => (await auditEvents.page(auditQuery.parse({ kind, limit: 1 }))).events.at(0)

describe('request_change', () => {
  it('files one request per change, shows it as the reason line and audits the agent', async () => {
    const caller = await newTask()
    const filed = await ask(caller, { kind: 'allow_host', host: 'fixtures.example.com' })
    expect(filed.isError).toBe(false)
    const { request } = filed.json()
    expect(request).toMatchObject({ state: 'pending', change: { host: 'fixtures.example.com', port: 443 } })
    expect((await tasks.get(caller.id))?.blocked).toBe('Asks for access to fixtures.example.com:443')
    expect((await ask(caller, { kind: 'allow_host', host: 'fixtures.example.com' })).text).toContain(
      'already waits for the user',
    )
    expect(await lastAudit('task.change_requested')).toMatchObject({
      actor: 'agent',
      subject_id: caller.id,
      detail: { agent_id: caller.id, request_id: request.id, reason: 'The build fetches its fixtures from there.' },
    })
  })

  it.each([
    ['localhost', 'never requestable'],
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- a private address the request must refuse
    ['10.1.2.3', 'never requestable'],
    ['*.com', 'whole top-level domain'],
    ['*.co.uk', 'Every site under co.uk belongs to someone else'],
    ['*.github.io', 'Every site under github.io belongs to someone else'],
  ])('refuses %s outright', async (host, refusal) => {
    const result = await ask(await newTask(), { kind: 'allow_host', host })
    expect(result).toMatchObject({ isError: true })
    expect(result.text).toContain(refusal)
  })

  it('flags a wildcard, refuses an unsandboxed agent, says when nothing is needed, and caps pending ones', async () => {
    const caller = await newTask()
    expect((await ask(caller, { kind: 'allow_host', host: '*.example.org' })).json().request.flags).toEqual([
      'Wildcard: every subdomain of example.org',
    ])
    expect((await ask(await newTask('self', false), { kind: 'allow_host', host: 'a.example.com' })).text).toContain(
      'You run unsandboxed',
    )
    expect((await ask(caller, { kind: 'allow_host', host: 'github.com' })).text).toContain('already reach')
    for (const n of [1, 2, 3, 4]) {
      expect((await ask(caller, { kind: 'allow_host', host: `h${String(n)}.example.com` })).isError).toBe(false)
    }
    const over = await ask(caller, { kind: 'allow_host', host: 'over.example.com' })
    expect(over.text).toContain(`At most ${String(PENDING_MAX)} of your requests can wait`)
  })

  it('is refused for an agent with Seti control off', async () => {
    const result = await ask(await newTask('off'), { kind: 'allow_host', host: 'x.example.com' })
    expect(result.text).toContain('Seti control is off')
  })
})

describe('answering a request', () => {
  it("is the user's alone: the EA and agents are refused", async () => {
    const caller = await newTask()
    const { request } = (await ask(caller, { kind: 'allow_host', host: 'ea.example.com' })).json()
    expect((await answer(caller, request.id, { decision: 'allow' }, EA_AUTH)).status).toBe(403)
    const full = await newTask('full')
    await expect(
      asAgent(full, async () => answerChangeRequest(caller, request.id, { decision: 'allow' })),
    ).rejects.toThrow('Agents cannot answer change requests')
    expect((await tasks.get(caller.id))?.blocked).not.toBeNull()
  })

  it('allows a host for the agent alone, tells it, clears its reason line and audits the user', async () => {
    const caller = await newTask()
    const other = await newTask()
    const { request } = (await ask(caller, { kind: 'allow_host', host: 'one.example.com', port: 8443 })).json()
    const res = await answer(caller, request.id, { decision: 'allow', scope: 'agent' })
    expect(res.status).toBe(200)
    expect(await allowedFor(caller.id)).toContain('one.example.com:8443')
    expect(await allowedFor(other.id)).not.toContain('one.example.com:8443')
    expect((await sandboxPolicy.get()).allowed_domains).not.toContain('one.example.com:8443')
    expect((await tasks.get(caller.id))?.blocked).toBeNull()
    expect(await updates(caller.id)).toEqual([
      expect.objectContaining({ kind: 'allowed', title: 'The user allowed you to reach one.example.com:8443' }),
    ])
    expect(await lastAudit('task.change_allowed')).toMatchObject({
      actor: 'user',
      subject_id: caller.id,
      detail: { title: caller.title, request_id: request.id, scope: 'agent' },
    })
    expect((await answer(caller, request.id, { decision: 'deny' })).status).toBe(409)
  })

  it('allows a host for every agent on the shared allowlist', async () => {
    const caller = await newTask()
    const { request } = (await ask(caller, { kind: 'allow_host', host: 'all.example.com' })).json()
    expect((await answer(caller, request.id, { decision: 'allow', scope: 'all' })).status).toBe(200)
    expect((await sandboxPolicy.get()).allowed_domains).toContain('all.example.com:443')
    expect(await lastAudit('system.sandbox_changed')).toMatchObject({
      detail: { domains_added: ['all.example.com:443'] },
    })
  })

  it('denies, and tells the agent not to ask again', async () => {
    const caller = await newTask()
    const { request } = (await ask(caller, { kind: 'allow_host', host: 'no.example.com' })).json()
    expect((await answer(caller, request.id, { decision: 'deny' })).status).toBe(200)
    expect(await allowedFor(caller.id)).not.toContain('no.example.com:443')
    expect((await updates(caller.id)).at(-1)).toMatchObject({ kind: 'denied' })
    expect(await lastAudit('task.change_denied')).toMatchObject({ actor: 'user', subject_id: caller.id })
  })

  it('allows a key request by adding a connection with no value to the agent credential', async () => {
    const caller = await newTask()
    const change = { kind: 'api_key', env: 'FIXTURE_API_KEY', hosts: ['api.fixture.example.com'] }
    const { request } = (await ask(caller, change)).json()
    expect((await answer(caller, request.id, { decision: 'allow' })).status).toBe(200)
    const [update] = await updates(caller.id)
    expect(update).toMatchObject({ kind: 'allowed', title: 'The user added the connection FIXTURE_API_KEY' })
    const made = (await connectionRows.list()).find((row) => row.env === 'FIXTURE_API_KEY')
    expect(made).toMatchObject({ name: 'fixture_api_key', hosts: ['api.fixture.example.com'], slots: {} })
    expect((await connectionRows.profilesOf(made?.id ?? '')).map((profile) => profile.id)).toEqual([caller.profile_id])
    const value = `fixture-${randomUUID()}`
    await setConnectionValue(made?.id ?? '', 'value', value)
    expect(JSON.stringify(await messages.page(caller.id, 50))).not.toContain(value)
    expect(JSON.stringify(await auditEvents.page(auditQuery.parse({ limit: 20 })))).not.toContain(value)
    expect((await ask(caller, change)).text).toContain('Your credential already has FIXTURE_API_KEY.')
  })

  it('allows a key request with the pasted key, which reaches only the connection', async () => {
    const caller = await newTask()
    const change = { kind: 'api_key', env: 'PASTED_API_KEY', hosts: ['api.pasted.example.com'] }
    const { request } = (await ask(caller, change)).json()
    const value = `pasted-${randomUUID()}`
    const res = await answer(caller, request.id, { decision: 'allow', value })
    expect(res.status).toBe(200)
    const made = (await connectionRows.list()).find((row) => row.env === 'PASTED_API_KEY')
    if (made === undefined) {
      throw new Error('no connection was added')
    }
    expect(await connectionValue(made)).toBe(value)
    expect((await connectionRows.profilesOf(made.id)).map((profile) => profile.id)).toEqual([caller.profile_id])
    const update = (await updates(caller.id)).at(-1)
    expect(update).toMatchObject({
      kind: 'allowed',
      title: 'The user added the connection PASTED_API_KEY with its key',
    })
    expect(`${update?.title ?? ''} ${update?.body ?? ''}`).not.toMatch(/\d/)
    expect(await lastAudit('system.secret_set')).toMatchObject({ subject_id: made.id, detail: { slot: 'value' } })
    const rows = await sql`SELECT * FROM change_request WHERE id = ${request.id}`
    const listed = await app.request(`/api/tasks/${caller.id}/change-requests`, {
      headers: { host: 'localhost', ...USER_AUTH },
    })
    for (const seen of [
      await res.text(),
      await listed.text(),
      JSON.stringify(rows),
      JSON.stringify(await messages.page(caller.id, 50)),
      JSON.stringify(await auditEvents.page(auditQuery.parse({ limit: 50 }))),
    ]) {
      expect(seen).not.toContain(value)
    }
  })

  it('takes a key only from the user, for a connection request, and never echoes it', async () => {
    const caller = await newTask()
    const keyed = (
      await ask(caller, { kind: 'api_key', env: 'REFUSED_KEY', hosts: ['api.refused.example.com'] })
    ).json()
    const value = `refused-${randomUUID()}`
    const ea = await answer(caller, keyed.request.id, { decision: 'allow', value }, EA_AUTH)
    expect(ea.status).toBe(403)
    const full = await newTask('full')
    await expect(
      asAgent(full, async () => answerChangeRequest(caller, keyed.request.id, { decision: 'allow', value })),
    ).rejects.toThrow('Agents cannot answer change requests')
    expect((await connectionRows.list()).some((row) => row.env === 'REFUSED_KEY')).toBe(false)
    const blank = await answer(caller, keyed.request.id, { decision: 'allow', value: '   ' })
    expect(blank.status).toBe(400)
    const hostAsk = (await ask(caller, { kind: 'allow_host', host: 'keyless.example.com' })).json()
    const onHost = await answer(caller, hostAsk.request.id, { decision: 'allow', value })
    expect(onHost.status).toBe(400)
    for (const seen of [await ea.text(), await blank.text(), await onHost.text()]) {
      expect(seen).not.toContain(value)
    }
    expect(await allowedFor(caller.id)).not.toContain('keyless.example.com:443')
  })

  it('refuses a pasted key for a connection that already has one, changing nothing', async () => {
    const first = await newTask()
    const change = { kind: 'api_key', env: 'SHARED_PASTE_KEY', hosts: ['api.shared.example.com'] }
    const before = `before-${randomUUID()}`
    const one = (await ask(first, change)).json()
    expect((await answer(first, one.request.id, { decision: 'allow', value: before })).status).toBe(200)
    const other = await profiles.create(`Other ${randomUUID().slice(0, 8)}`)
    const second = { ...(await newTask()), profile_id: other.id }
    await sql`UPDATE task SET profile_id = ${other.id} WHERE id = ${second.id}`
    const asked = (await ask(second, change)).json()
    const res = await answer(second, asked.request.id, { decision: 'allow', value: `after-${randomUUID()}` })
    expect(res.status).toBe(409)
    expect(await res.text()).toContain('already has its key')
    const made = (await connectionRows.list()).find((row) => row.env === 'SHARED_PASTE_KEY')
    expect(made === undefined ? null : await connectionValue(made)).toBe(before)
  })

  it('expires a request nobody answered and tells the agent', async () => {
    const caller = await newTask()
    const { request } = (await ask(caller, { kind: 'allow_host', host: 'late.example.com' })).json()
    await sql`UPDATE change_request SET expires_at = ${new Date(Date.now() - 1000).toISOString()} WHERE id = ${request.id}`
    await expireChangeRequests()
    expect((await updates(caller.id)).at(-1)).toMatchObject({ kind: 'expired' })
    expect((await tasks.get(caller.id))?.blocked).toBeNull()
    expect(await lastAudit('task.change_expired')).toMatchObject({ actor: 'system', subject_id: caller.id })
  })
})
