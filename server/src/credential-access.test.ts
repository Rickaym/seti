import { randomUUID } from 'node:crypto'
import type { CapabilitiesSnapshot, McpServer, Task, TaskAccessView } from '@seti/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { asAgent, asMod } from './access.js'
import { effectiveAccess, taskSsh } from './agent-access.js'
import { capOf, capStart } from './agent-cap.js'
import { createApp } from './app.js'
import { taskAws } from './aws-access.js'
import type * as Capabilities from './capabilities.js'
import { securityGain } from './credential-access.js'
import { sql, tasks } from './db.js'
import { taskDeniedServers } from './mcp-selection.js'
import { taskPluginConfigs } from './plugins.js'
import { setSetHost } from './ssh.js'
import { accessDefaults, taskAccess } from './store/access.js'
import { allowedFor } from './store/change-requests.js'
import { contextPacks, packsOfTask } from './store/context.js'
import { credentialAccess } from './store/credential-access.js'
import { profiles } from './store/credentials.js'
import { mcpDefaults, taskMcpChoices } from './store/mcp.js'
import { setiPlugins, taskPluginChoices } from './store/plugins.js'
import { sshHostStore } from './store/ssh.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'

vi.mock('./capabilities.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Capabilities>()
  const server = (name: string): McpServer => ({
    name,
    status: 'connected',
    scope: 'user',
    source: 'user',
    transport: { type: 'http', target: `https://${name}.test/mcp` },
    connector_id: null,
    server_version: null,
    error: null,
    tools: [],
    sign_in: 'none',
  })
  const snapshot: CapabilitiesSnapshot = {
    cwd: '/',
    probed_at: '2026-11-24T00:00:00.000Z',
    duration_ms: 1,
    pending_timed_out: false,
    account: { email: null, organization: null, subscription_type: null, api_provider: null },
    servers: [server('github'), server('stripe')],
    skill_groups: [],
    builtin_commands: [],
    subagents: [],
    models: [],
  }
  return {
    ...actual,
    capabilityCache: {
      ...actual.capabilityCache,
      all: () => [snapshot],
      get: async () => Promise.reject(new Error('tests never probe')),
    },
  }
})

const app = createApp()

async function send(method: string, url: string, body?: unknown, auth: Record<string, string> = USER_AUTH) {
  return app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

const host = { hostname: '192.0.2.7', port: 22, user: 'ops', key_id: null, jump: null, options: [] }

async function newTask(profileId: string): Promise<Task> {
  const id = randomUUID()
  await tasks.insert({ id, title: `agent ${id.slice(0, 4)}`, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  await tasks.setProfile(id, profileId)
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('no task')
  }
  return task
}

const item = (view: TaskAccessView, kind: string, id: string) =>
  view.items.find((entry) => entry.kind === kind && entry.id === id)

let ops: string
let pack: string
let plugin: string
let pluginPath: string

beforeEach(async () => {
  await sql`DELETE FROM ssh_host`
  await sql`DELETE FROM access_default`
  await sql`DELETE FROM mcp_server_default`
  await sshHostStore.insert('db', host)
  await sshHostStore.insert('k8s', host)
  ops = (await profiles.create(`Ops ${randomUUID().slice(0, 6)}`)).id
  pack = (await contextPacks.create({ name: `style ${randomUUID().slice(0, 6)}`, description: '', body: 'x' })).id
  pluginPath = `/tmp/${randomUUID()}`
  plugin = (
    await setiPlugins.create({
      name: `p-${randomUUID().slice(0, 6)}`,
      path: pluginPath,
      version: null,
      description: '',
    })
  ).id
})

describe("a credential's access set", () => {
  it('decides each item for agents without their own choice, over the default', async () => {
    const [follower, own, other] = [await newTask(ops), await newTask(ops), await newTask('default')]
    await accessDefaults.set('ssh', 'k8s', true)
    await mcpDefaults.set('stripe', false)
    for (const [kind, id, enabled] of [
      ['ssh', 'db', true],
      ['ssh', 'k8s', false],
      ['aws', 'aws', true],
      ['mcp', 'stripe', true],
      ['mcp', 'github', false],
      ['pack', pack, true],
      ['plugin', plugin, false],
    ] as const) {
      await credentialAccess.set(ops, kind, id, enabled)
    }
    await taskAccess.set(own.id, 'ssh', 'db', false)
    await taskAccess.set(own.id, 'aws', 'aws', false)
    await taskMcpChoices.set(own.id, { github: true })
    await taskPluginChoices.setOne(own.id, plugin, true)

    expect((await taskSsh(follower.id)).enabled).toEqual(['db'])
    expect((await taskSsh(own.id)).enabled).toEqual([])
    expect((await taskSsh(other.id)).enabled).toEqual(['k8s'])
    expect([await taskAws(follower.id), await taskAws(own.id), await taskAws(other.id)]).toEqual([true, false, false])
    expect(await taskDeniedServers(follower.id)).toEqual(['github'])
    expect(await taskDeniedServers(own.id)).toEqual([])
    expect(await taskDeniedServers(other.id)).toEqual(['stripe'])
    expect((await packsOfTask(follower.id)).map((p) => p.id)).toContain(pack)
    expect((await packsOfTask(other.id)).map((p) => p.id)).not.toContain(pack)
    const loaded = async (task: Task) => (await taskPluginConfigs(task.id)).some((p) => p.path === pluginPath)
    expect([await loaded(follower), await loaded(own), await loaded(other)]).toEqual([false, true, true])

    const view = await effectiveAccess(follower)
    expect(item(view, 'ssh', 'db')).toMatchObject({ credential: true, override: null, enabled: true })
    expect(item(view, 'ssh', 'k8s')).toMatchObject({ credential: false, default_enabled: true, enabled: false })
    expect(item(view, 'mcp', 'stripe')).toMatchObject({ credential: true, default_enabled: false, enabled: true })
    expect(item(view, 'pack', pack)).toMatchObject({ credential: true, enabled: true })
    expect(item(await effectiveAccess(own), 'ssh', 'db')).toMatchObject({ credential: true, override: false })
  })

  it("stores an agent's choice only while it differs from its credential, and audits whose it was", async () => {
    const task = await newTask(ops)
    await credentialAccess.set(ops, 'mcp', 'stripe', true)
    const view = async (enabled: boolean | null) =>
      (await send('PUT', `/tasks/${task.id}/access`, { kind: 'mcp', id: 'stripe', enabled })).json()
    await view(true)
    expect(await taskMcpChoices.get(task.id)).toEqual({})
    await view(false)
    expect(await taskMcpChoices.get(task.id)).toEqual({ stripe: false })
    await view(null)
    const [event] = await sql<{ summary: string }[]>`SELECT summary FROM audit_event
      WHERE subject_id = ${task.id} ORDER BY id DESC LIMIT 1`
    expect(event?.summary).toContain("Turned on (its credential's choice) MCP server stripe")
  })

  it('reaches the hosts of its credential beside the shared allowlist and its own', async () => {
    const task = await newTask(ops)
    await sql`INSERT INTO credential_host (profile_id, host, created_at) VALUES (${ops}, 'api.stripe.com', 'x')`
    expect(await allowedFor(task.id)).toContain('api.stripe.com')
    expect(await allowedFor((await newTask('default')).id)).not.toContain('api.stripe.com')
  })

  it('refuses the EA a move that turns on SSH, AWS or a host, and lets the user', async () => {
    const task = await newTask('default')
    await credentialAccess.set(ops, 'ssh', 'db', true)
    await credentialAccess.set(ops, 'aws', 'aws', true)
    await sql`INSERT INTO credential_host (profile_id, host, created_at) VALUES (${ops}, 'api.stripe.com', 'x')`
    expect(await securityGain(task, ops)).toEqual(['SSH db', 'AWS', 'host api.stripe.com'])
    const refused = await send('PATCH', `/tasks/${task.id}`, { profile_id: ops }, EA_AUTH)
    expect(refused.status).toBe(403)
    expect(await refused.text()).toContain('turns on SSH db, AWS, host api.stripe.com')
    expect((await tasks.get(task.id))?.profile_id).toBe('default')
    expect((await send('PATCH', `/tasks/${task.id}`, { profile_id: ops })).status).toBe(200)
    expect((await tasks.get(task.id))?.profile_id).toBe(ops)
  })

  it('lets the EA move an agent when nothing security turns on', async () => {
    const task = await newTask('default')
    await credentialAccess.set(ops, 'mcp', 'stripe', true)
    await taskAccess.set(task.id, 'ssh', 'db', false)
    await credentialAccess.set(ops, 'ssh', 'db', true)
    expect(await securityGain(task, ops)).toEqual([])
    expect((await send('PATCH', `/tasks/${task.id}`, { profile_id: ops }, EA_AUTH)).status).toBe(200)
  })

  it('keeps an agent-started agent inside its cap whatever its credential later turns on', async () => {
    const caller = await newTask(ops)
    await credentialAccess.set(ops, 'ssh', 'k8s', true)
    const capped = await capStart(await capOf(caller))
    expect(capped.access).toEqual([
      { kind: 'ssh', id: 'db', enabled: false },
      { kind: 'aws', id: 'aws', enabled: false },
    ])
    expect(capped.mcp_disabled).toEqual([])
    const ssh = (held: string[]) => held.filter((line) => line.startsWith('SSH'))
    expect(ssh(capped.held)).toEqual([])
    await taskAccess.set(caller.id, 'ssh', 'k8s', false)
    const tighter = await capStart(await capOf(caller))
    expect(tighter.access.map((choice) => choice.id)).toEqual(['db', 'k8s', 'aws'])
    expect(ssh(tighter.held)).toEqual([`SSH k8s: beyond what ${caller.title} has`])
  })

  it('takes its SSH hosts only from the user', async () => {
    for (const run of [
      async (fn: () => Promise<void>) => asAgent({ id: 't1', title: 'Agent', seti_control: 'full' }, fn),
      async (fn: () => Promise<void>) => asMod({ id: 'sample', grants: [] }, fn),
    ]) {
      await expect(run(async () => setSetHost(ops, 'db', true))).rejects.toMatchObject({ status: 403 })
    }
    expect((await send('PUT', `/credentials/profiles/${ops}/ssh-hosts/db`, undefined, EA_AUTH)).status).toBe(403)
    expect(await credentialAccess.of(ops, 'ssh')).toEqual({})
    expect((await send('PUT', `/credentials/profiles/${ops}/ssh-hosts/db`)).status).toBe(200)
    expect(await credentialAccess.of(ops, 'ssh')).toEqual({ db: true })
  })
})
