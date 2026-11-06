import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import {
  awsOutcomeLine,
  type AccessDefault,
  type CapabilitiesSnapshot,
  type McpServer,
  type Task,
  type TaskAccessView,
} from '@seti/shared'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { taskSsh } from './agent-access.js'
import { createApp } from './app.js'
import { taskAws } from './aws-access.js'
import type * as AwsCredentials from './aws-credentials.js'
import type * as Capabilities from './capabilities.js'
import { sql, tasks } from './db.js'
import { taskDeniedServers } from './mcp-selection.js'
import { taskPluginConfigs } from './plugins.js'
import { sandboxPrompt } from './sandbox-prompt.js'
import { setupKey } from './session-options.js'
import { accessDefaults, taskAccess } from './store/access.js'
import { auditEvents } from './store/audit.js'
import { contextPacks, taskContextPacks } from './store/context.js'
import { profiles } from './store/credentials.js'
import { setiPlugins } from './store/plugins.js'
import { setHosts, sshHostStore, sshKeys } from './store/ssh.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'
import { migrateWith } from './test-migration.js'
import { taskFile } from './workspace/render.js'

const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeResult } = await import('./fake-sdk.js')
  return new FakeSdk(function* () {
    yield fakeResult()
  })
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof Sdk>()),
  query: (params: Parameters<typeof sdk.query>[0]) => sdk.query(params),
}))

const HOST_ROLE = 'arn:aws:iam::123456789012:role/seti-host'

vi.mock('./aws-credentials.js', async (importOriginal) => ({
  ...(await importOriginal<typeof AwsCredentials>()),
  knownHostRole: () => HOST_ROLE,
}))

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
    probed_at: '2026-09-30T00:00:00.000Z',
    duration_ms: 1,
    pending_timed_out: false,
    account: { email: null, organization: null, subscription_type: null, api_provider: null },
    servers: [server('clickup'), server('sentry')],
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

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-agent-access-'))
const app = createApp()

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

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

const KEY = {
  id: 'access-key',
  name: 'access',
  type: 'ssh-ed25519',
  public_key: 'ssh-ed25519 AAAA access',
  fingerprint: 'SHA256:access',
  source: 'generated' as const,
  path: null,
  created_at: '2026-09-30T00:00:00.000Z',
  updated_at: '2026-09-30T00:00:00.000Z',
}

const login = { user: 'ops', key_id: KEY.id, options: [] }

/** Hosts jump, k8s through jump, and db on port 2222, each logging in as ops with one key. */
async function seedHosts(): Promise<void> {
  await sql`DELETE FROM ssh_host`
  if ((await sshKeys.get(KEY.id)) === undefined) {
    await sshKeys.insert(KEY)
  }
  await sshHostStore.insert('jump', { ...login, hostname: '203.0.113.9', port: 22, jump: null })
  await sshHostStore.insert('k8s', { ...login, hostname: '198.51.100.9', port: 22, jump: 'jump' })
  await sshHostStore.insert('db', { ...login, hostname: '198.51.100.7', port: 2222, jump: null })
}

const hostBody = (hostname: string, extra: object = {}) => ({
  hostname,
  port: 2222,
  user: 'ops',
  key_id: KEY.id,
  ...extra,
})

let count = 0
async function newTask(): Promise<Task> {
  const id = `access-task-${String(++count)}`
  await tasks.insert({ id, title: id, repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
  const task = await tasks.get(id)
  if (!task) {
    throw new Error('Task was not stored')
  }
  return task
}

const view = async (task: Task) => data<TaskAccessView>(await send('GET', `/tasks/${task.id}/access`))
const setAccess = async (task: Task, kind: string, id: string, enabled: boolean | null) =>
  data<TaskAccessView>(await send('PUT', `/tasks/${task.id}/access`, { kind, id, enabled }))
const setDefault = async (kind: string, id: string, enabled: boolean) =>
  data<AccessDefault[]>(await send('PUT', '/access/defaults', { kind, id, enabled }))
const item = (access: TaskAccessView, kind: string, id: string) =>
  access.items.find((entry) => entry.kind === kind && entry.id === id)

beforeEach(async () => {
  await sql`DELETE FROM access_default`
  await seedHosts()
})

describe('ssh hosts, one by one', () => {
  it('keeps every host off by default and turns one on for one agent only, with its jump host', async () => {
    const [mine, other] = [await newTask(), await newTask()]
    expect(item(await view(mine), 'ssh', 'k8s')).toMatchObject({ default_enabled: false, override: null })
    const after = await setAccess(mine, 'ssh', 'k8s', true)
    expect(item(after, 'ssh', 'k8s')).toMatchObject({
      enabled: true,
      override: true,
      detail: '198.51.100.9:22 via jump',
    })
    expect(item(after, 'ssh', 'jump')).toMatchObject({ enabled: false, override: null, jump_for: ['k8s'] })
    expect(item(await view(other), 'ssh', 'k8s')).toMatchObject({ enabled: false, override: null })

    const ssh = await taskSsh(mine.id)
    expect(ssh.usable).toEqual(['k8s'])
    expect(ssh.hosts.map((host) => host.alias)).toEqual(['jump', 'k8s'])
    expect(ssh.firstHops).toEqual(['203.0.113.9:22'])
    expect(ssh.knownHosts).toEqual(new Set(['198.51.100.9', '203.0.113.9']))
    expect(await taskSsh(other.id)).toMatchObject({ enabled: [], hosts: [], firstHops: [] })
  })

  it('reaches a host only when it and every jump host on its way have a key', async () => {
    const task = await newTask()
    await setAccess(task, 'ssh', 'k8s', true)
    await sql`UPDATE ssh_host SET key_id = NULL WHERE alias = 'jump'`
    const access = await setAccess(task, 'ssh', 'db', true)
    expect(item(access, 'ssh', 'k8s')).toMatchObject({ enabled: true, missing_key: ['jump'] })
    expect(item(access, 'ssh', 'db')).toMatchObject({ enabled: true, missing_key: [] })
    expect(item(access, 'ssh', 'jump')).toMatchObject({ enabled: false, jump_for: [], missing_key: ['jump'] })
    expect(await taskSsh(task.id)).toMatchObject({
      enabled: ['db', 'k8s'],
      usable: ['db'],
      firstHops: ['198.51.100.7:2222'],
    })
  })

  it('grants a host through the credential to every agent using it, beside its own grants', async () => {
    const [inSet, outside] = [await newTask(), await newTask()]
    const set = await data<{ id: string }>(await send('POST', '/credentials/profiles', { name: 'Ops hosts' }))
    await tasks.setProfile(inSet.id, set.id)
    await setAccess(inSet, 'ssh', 'db', true)
    const bundled = await data<{ ssh_hosts: string[] }>(
      await send('PUT', `/credentials/profiles/${set.id}/ssh-hosts/k8s`),
    )
    expect(bundled.ssh_hosts).toEqual(['k8s'])
    expect(await auditEvents.latest('system.profile_changed')).toMatchObject({
      summary: 'Every agent using Ops hosts gets the ssh host k8s',
      detail: { change: 'ssh_host_added', host: 'k8s' },
    })
    expect(item(await view(inSet), 'ssh', 'k8s')).toMatchObject({ enabled: true, in_set: true, override: null })
    expect(await taskSsh(inSet.id)).toMatchObject({ usable: ['db', 'k8s'] })
    expect(item(await view(outside), 'ssh', 'k8s')).toMatchObject({ enabled: false, in_set: false })

    const refused = await send('PUT', `/tasks/${inSet.id}/access`, { kind: 'ssh', id: 'k8s', enabled: false })
    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain('k8s comes with the credential Ops hosts')

    await data(await send('DELETE', `/credentials/profiles/${set.id}/ssh-hosts/k8s`))
    expect(await taskSsh(inSet.id)).toMatchObject({ usable: ['db'] })
    await data(await send('PUT', `/credentials/profiles/${set.id}/ssh-hosts/jump`))
    await send('DELETE', `/credentials/profiles/${set.id}`)
    expect(await setHosts.list()).toEqual([])
    expect((await auditEvents.latest('system.profile_deleted'))?.detail).toMatchObject({ ssh_hosts_removed: ['jump'] })
    expect((await send('PUT', '/credentials/profiles/default/ssh-hosts/nowhere')).status).toBe(404)
  })

  it('gives a host on by default to every agent without an override, and stores only differences', async () => {
    const [mine, other] = [await newTask(), await newTask()]
    const catalog = await setDefault('ssh', 'db', true)
    expect(catalog.find((entry) => entry.kind === 'ssh' && entry.id === 'db')?.default_enabled).toBe(true)
    expect((await taskSsh(other.id)).firstHops).toEqual(['198.51.100.7:2222'])
    expect((await taskSsh(other.id)).knownHosts).toEqual(new Set(['[198.51.100.7]:2222']))

    expect(item(await setAccess(mine, 'ssh', 'db', false), 'ssh', 'db')).toMatchObject({
      enabled: false,
      override: false,
    })
    expect(await taskAccess.all(mine.id, 'ssh')).toEqual({ db: false })
    expect(item(await setAccess(mine, 'ssh', 'db', true), 'ssh', 'db')).toMatchObject({ enabled: true, override: null })
    expect(await taskAccess.all(mine.id, 'ssh')).toEqual({})
    await setAccess(mine, 'ssh', 'db', false)
    expect(item(await setAccess(mine, 'ssh', 'db', null), 'ssh', 'db')).toMatchObject({ enabled: true, override: null })
  })

  it('restarts the session at the next turn and tells the agent only its hosts', async () => {
    const task = await newTask()
    const before = await setupKey(task)
    expect(await sandboxPrompt(task.id)).not.toContain('SSH reaches')
    await setAccess(task, 'ssh', 'k8s', true)
    const withK8s = await setupKey(task)
    expect(withK8s).not.toBe(before)
    expect(await sandboxPrompt(task.id)).toContain('SSH reaches only these hosts: k8s (ssh <alias>)')
    await setAccess(task, 'ssh', 'db', true)
    const withDb = await setupKey(task)
    expect(withDb).not.toBe(withK8s)

    await data(await send('PUT', '/ssh/hosts/db', hostBody('198.51.100.7', { user: 'root' })))
    const newUser = await setupKey(task)
    expect(newUser).not.toBe(withDb)
    await data(await send('PUT', '/ssh/hosts/db', hostBody('198.51.100.8', { user: 'root' })))
    const newAddress = await setupKey(task)
    expect(newAddress).not.toBe(newUser)
    await data(
      await send(
        'PUT',
        '/ssh/hosts/db',
        hostBody('198.51.100.8', { user: 'root', options: [{ name: 'Compression', value: 'yes' }] }),
      ),
    )
    expect(await setupKey(task)).not.toBe(newAddress)
    await sql`UPDATE ssh_host SET key_id = NULL WHERE alias = 'k8s'`
    expect(await sandboxPrompt(task.id)).toContain('SSH reaches only these hosts: db (ssh <alias>)')
  })

  it('audits overrides and defaults without secrets', async () => {
    const task = await newTask()
    await setAccess(task, 'ssh', 'k8s', true)
    expect(await auditEvents.latest('task.access_changed')).toMatchObject({
      subject_id: task.id,
      summary: `Turned on ssh host k8s for task "${task.title}"`,
      detail: { access: 'ssh', item: 'k8s', enabled: true, override: true, default_enabled: false },
    })
    await setAccess(task, 'ssh', 'k8s', null)
    expect((await auditEvents.latest('task.access_changed'))?.summary).toBe(
      `Turned off (the default) ssh host k8s for task "${task.title}"`,
    )
    await setDefault('ssh', 'k8s', true)
    expect(await auditEvents.latest('system.access_default_changed')).toMatchObject({
      subject_id: 'ssh:k8s',
      detail: { access: 'ssh', item: 'k8s', enabled: true },
    })
  })

  it('drops the default, overrides and set entries of a deleted host', async () => {
    const task = await newTask()
    await setDefault('ssh', 'db', true)
    await setDefault('ssh', 'k8s', true)
    await setAccess(task, 'ssh', 'k8s', false)
    await data(await send('PUT', '/credentials/profiles/default/ssh-hosts/k8s'))
    await data(await send('DELETE', '/ssh/hosts/k8s'))
    expect(await accessDefaults.all('ssh')).toEqual({ db: true })
    expect(await taskAccess.all(task.id, 'ssh')).toEqual({})
    expect(await setHosts.forProfile('default')).toEqual([])
    expect((await auditEvents.latest('system.ssh_host_deleted'))?.detail).toMatchObject({
      removed_from_sets: ['Default'],
    })
    expect((await send('PUT', `/tasks/${task.id}/access`, { kind: 'ssh', id: 'k8s', enabled: true })).status).toBe(404)
  })
})

describe('AWS from the credential', () => {
  const ROLE = 'arn:aws:iam::123456789012:role/devops-agent'
  let sets = 0
  async function credentialSet(role: string | null) {
    const set = await profiles.create(`Set ${String(++sets)}`)
    if (role !== null) {
      await profiles.setAws(set.id, { role_arn: role, external_id: null, region: 'us-east-1', session_minutes: 60 })
    }
    return set
  }
  const pickSet = async (task: Task, profileId: string) =>
    data<Task>(await send('PATCH', `/tasks/${task.id}`, { profile_id: profileId }))
  const taskMd = async (task: Task) => (await taskFile(task.id))?.text ?? ''

  it('turns AWS on, audited, when the agent gets a set with a role, and names the role', async () => {
    const task = await newTask()
    const set = await credentialSet(ROLE)
    expect(await taskAws(task.id)).toBe(false)
    await pickSet(task, set.id)
    expect(await taskAws(task.id)).toBe(true)
    expect(await auditEvents.latest('task.access_changed')).toMatchObject({
      subject_id: task.id,
      summary: `Turned on AWS for task "${task.title}"`,
      detail: { access: 'aws', enabled: true, override: true },
    })
    const access = await view(task)
    expect(access.aws).toEqual({ state: 'on', role: ROLE, region: 'us-east-1' })
    expect(awsOutcomeLine(access.aws)).toBe('AWS: devops-agent (us-east-1)')
    expect(item(access, 'aws', 'aws')).toMatchObject({ name: 'AWS', detail: 'devops-agent (us-east-1)' })
    expect(await taskMd(task)).toContain(`- AWS: on, the role ${ROLE} in us-east-1`)

    await setAccess(task, 'aws', 'aws', false)
    expect((await view(task)).aws.state).toBe('off')
    expect(await taskMd(task)).toContain(
      '- AWS: off. Your credential has the role devops-agent; ask the user to turn on AWS for you in your settings.',
    )
  })

  it('leaves AWS as it is when the EA gives the agent a set with a role', async () => {
    const task = await newTask()
    const set = await credentialSet(ROLE)
    await data(await send('PATCH', `/tasks/${task.id}`, { profile_id: set.id }, EA_AUTH))
    expect(await taskAws(task.id)).toBe(false)
    expect(await taskAccess.all(task.id, 'aws')).toEqual({})
    expect((await view(task)).aws).toEqual({ state: 'off', role: ROLE, region: 'us-east-1' })
    expect(await auditEvents.latest('task.profile_changed')).toMatchObject({
      actor: 'user',
      subject_id: task.id,
      detail: { profile: set.name, via: 'ea' },
    })
    expect((await auditEvents.latest('task.access_changed'))?.subject_id).not.toBe(task.id)

    const userTask = await newTask()
    await pickSet(userTask, set.id)
    expect(await taskAws(userTask.id)).toBe(true)
    const audited = await auditEvents.latest('task.profile_changed')
    expect(audited).toMatchObject({ actor: 'user', subject_id: userTask.id })
    expect(audited?.detail).not.toHaveProperty('via')
  })

  it('leaves AWS off for a set without a role and says why', async () => {
    const task = await newTask()
    const set = await credentialSet(null)
    await pickSet(task, set.id)
    expect(await taskAws(task.id)).toBe(false)
    expect(await taskAccess.all(task.id, 'aws')).toEqual({})
    const access = await view(task)
    expect(access.aws).toEqual({ state: 'no_role', profile: set.name })
    expect(awsOutcomeLine(access.aws)).toBe(`AWS: no role in ${set.name}`)
    expect(item(access, 'aws', 'aws')?.detail).toBe(`no role in ${set.name}`)
    expect(await taskMd(task)).toContain(`- AWS: off; your credential ${set.name} has no AWS role.`)
  })

  it("says an unsandboxed agent uses this machine's own AWS, not the credential", async () => {
    const task = await newTask()
    await pickSet(task, (await credentialSet(ROLE)).id)
    await tasks.setSandbox(task.id, false)
    const access = await view(task)
    expect(access.aws).toEqual({ state: 'host', host_role: HOST_ROLE })
    expect(access.github).toEqual({ state: 'host' })
    expect(awsOutcomeLine(access.aws)).toBe("AWS: this machine's own role (seti-host), not the credential")
    expect(await taskMd(task)).toContain(
      `- AWS: you run outside the sandbox, so AWS calls use this machine's own role (${HOST_ROLE}), not your credential.`,
    )
  })
})

describe('AWS, MCP servers, packs and plugins in the same model', () => {
  it('keeps AWS off by default, with a default and overrides that outlive a new default', async () => {
    const [mine, other] = [await newTask(), await newTask()]
    expect(await taskAws(mine.id)).toBe(false)
    await setAccess(mine, 'aws', 'aws', true)
    expect([await taskAws(mine.id), await taskAws(other.id)]).toEqual([true, false])
    await setDefault('aws', 'aws', true)
    expect(await taskAws(other.id)).toBe(true)
    expect(item(await view(mine), 'aws', 'aws')).toMatchObject({ enabled: true, override: true })
    await setAccess(other, 'aws', 'aws', false)
    expect(await taskAws(other.id)).toBe(false)
  })

  it('turns packs, plugins and MCP servers on and off per agent with the same call', async () => {
    const [mine, other] = [await newTask(), await newTask()]
    const pack = await contextPacks.create({ name: 'Access pack', description: 'd', body: 'b' })
    await setAccess(mine, 'pack', pack.id, true)
    expect((await taskContextPacks.list(mine.id)).map((entry) => entry.name)).toContain('Access pack')
    await setDefault('pack', pack.id, true)
    expect((await taskContextPacks.list(other.id)).map((entry) => entry.name)).toContain('Access pack')
    expect(item(await view(mine), 'pack', pack.id)).toMatchObject({ enabled: true, override: true })

    const plugin = await setiPlugins.create({ name: 'opt-in', path: scratch, version: null, description: '' })
    await setDefault('plugin', plugin.id, false)
    await setAccess(mine, 'plugin', plugin.id, true)
    expect(await taskPluginConfigs(mine.id)).toEqual([{ type: 'local', path: scratch }])
    expect(await taskPluginConfigs(other.id)).toEqual([])

    await setAccess(mine, 'mcp', 'sentry', false)
    expect(await taskDeniedServers(mine.id)).toEqual(['sentry'])
    expect(item(await view(mine), 'mcp', 'sentry')).toMatchObject({
      enabled: false,
      override: false,
      detail: 'configured',
    })
    expect(await taskDeniedServers(other.id)).toEqual([])
  })

  it('starts an agent with overrides and records what it reaches', async () => {
    const created = await data<Task>(
      await send('POST', '/tasks', {
        title: 'With access',
        prompt: 'Go',
        cwd: scratch,
        access: [
          { kind: 'ssh', id: 'k8s', enabled: true },
          { kind: 'aws', id: 'aws', enabled: true },
          { kind: 'mcp', id: 'clickup', enabled: true },
        ],
      }),
    )
    expect(await taskAccess.all(created.id, 'ssh')).toEqual({ k8s: true })
    expect(await auditEvents.latest('task.created')).toMatchObject({
      subject_id: created.id,
      detail: { ssh_hosts: ['k8s'], aws: true, mcp_enabled: [] },
    })
    const missing = await send('POST', '/tasks', {
      title: 'Unknown host',
      prompt: 'Go',
      cwd: scratch,
      access: [{ kind: 'ssh', id: 'nowhere', enabled: true }],
    })
    expect(missing.status).toBe(400)
    expect((await tasks.list()).map((task) => task.title)).not.toContain('Unknown host')
  })
})

describe('the access migration', () => {
  async function migrateAccess(seed: string) {
    return migrateWith('access_defaults', seed, async (tx, schema) => {
      const access = await tx`SELECT task_id, kind, item, enabled FROM task_access ORDER BY task_id, kind, item`
      const defaults = await tx`SELECT kind, item FROM access_default`
      const packs = await tx`SELECT task_id, pack_id, linked FROM task_context_pack
        WHERE pack_id <> '5e710000-0000-4000-8000-000000000001' ORDER BY task_id, pack_id`
      const guide = await tx`SELECT task_id, linked FROM task_context_pack
        WHERE pack_id = '5e710000-0000-4000-8000-000000000001' ORDER BY task_id`
      const columns = await tx`SELECT column_name FROM information_schema.columns
        WHERE table_schema = ${schema} AND table_name = 'task' AND column_name IN ('aws', 'ssh')`
      return {
        access: [...access],
        defaults: [...defaults],
        packs: [...packs],
        guide: [...guide],
        columns: [...columns],
      }
    })
  }

  const SEED = `
    INSERT INTO ssh_settings (id, config, updated_at) VALUES (1,
      E'# agents\\nHost jump\\n  HostName 203.0.113.9\\n\\nhost k8s kube\\n  hostname 198.51.100.9\\n  ProxyJump jump\\nHost=db\\n  Port 2222\\n',
      'x');
    INSERT INTO task (id, title, cwd, status, created_at, updated_at, ssh, aws)
      VALUES ('on', 'On', '/tmp', 'idle', 'x', 'x', true, true), ('off', 'Off', '/tmp', 'idle', 'x', 'x', false, false);
    INSERT INTO context_pack (id, name, body, created_at, updated_at) VALUES ('mine', 'Mine', 'b', 'x', 'x');
    INSERT INTO task_context_pack (task_id, pack_id) VALUES ('on', 'mine'), ('on', '5e710000-0000-4000-8000-000000000001');`

  it('turns the ssh switch into overrides of every host and AWS into an override, keeping access', async () => {
    const result = await migrateAccess(SEED)
    expect(result).toMatchObject({
      access: [
        { task_id: 'on', kind: 'aws', item: 'aws', enabled: true },
        { task_id: 'on', kind: 'ssh', item: 'db', enabled: true },
        { task_id: 'on', kind: 'ssh', item: 'jump', enabled: true },
        { task_id: 'on', kind: 'ssh', item: 'k8s', enabled: true },
        { task_id: 'on', kind: 'ssh', item: 'kube', enabled: true },
      ],
      defaults: [],
      columns: [],
    })
  })

  it('keeps pack links as they were: links of packs off by default, unlinks of packs on by default', async () => {
    expect(await migrateAccess(SEED)).toMatchObject({
      packs: [{ task_id: 'on', pack_id: 'mine', linked: true }],
      guide: [{ task_id: 'off', linked: false }],
    })
  })
})
