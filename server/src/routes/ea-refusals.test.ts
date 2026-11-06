import fs from 'node:fs'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import type { AccessDefault, ChannelInfo, ChannelSecret, Task, TaskAccessView, WebhookChannelInfo } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { webhooks } from '../channels/service.js'
import { hmacHex } from '../channels/signature.js'
import { tasks } from '../db.js'
import { auditEvents } from '../store/audit.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'
import { withBundledMods } from '../test-mods.js'

withBundledMods()

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-ea-refusals-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof Sdk>()),
  query: (_params: { prompt: unknown; options?: Options }) => {
    const session = (async function* () {
      await Promise.resolve()
      yield* []
    })()
    return Object.assign(session, { close: () => undefined })
  },
}))

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

const app = createApp()
const BASE = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006' }
const USER = { ...BASE, ...USER_AUTH }
const EA = { ...BASE, ...EA_AUTH }

async function send(headers: Record<string, string>, method: string, url: string, body?: unknown) {
  return app.request(`/api${url}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function data<T>(res: Response): Promise<T> {
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: T }).data
}

async function refused(res: Response): Promise<string> {
  expect(res.status).toBe(403)
  return ((await res.json()) as { error: { detail: string } }).error.detail
}

const idleTask = async (id: string) => {
  await tasks.insert({ id, title: id, repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
}

describe('security settings stay with the user', () => {
  it('lets the EA read the sandbox settings but not change them', async () => {
    const sandbox = await data<{ policy: { enabled: boolean } }>(await send(EA, 'GET', '/sandbox'))
    expect(sandbox.policy.enabled).toBe(true)
    const off = { ...sandbox.policy, enabled: false }
    expect(await refused(await send(EA, 'PUT', '/sandbox', off))).toBe(
      'The EA cannot change the sandbox; the user does that in Seti',
    )
    expect(
      (await data<{ policy: { enabled: boolean } }>(await send(USER, 'PUT', '/sandbox', off))).policy.enabled,
    ).toBe(false)
    await data(await send(USER, 'PUT', '/sandbox', sandbox.policy))
  })

  it('refuses the EA every credential and connection route, and lets it assign a credential', async () => {
    const role = { role_arn: 'arn:aws:iam::123456789012:role/seti-read', external_id: null, region: 'us-east-1' }
    const aws = { ...role, session_minutes: 60 }
    const connection = { name: 'vendor', kind: 'key', env: 'VENDOR_KEY', hosts: ['api.example.com'] }
    expect(await refused(await send(EA, 'GET', '/credentials'))).toBe(
      'The EA cannot see or change credentials or their tokens; the user does that in Seti',
    )
    await refused(await send(EA, 'POST', '/credentials/profiles', { name: 'EA made' }))
    await refused(await send(EA, 'PUT', '/credentials/profiles/default/aws', aws))
    await refused(await send(EA, 'PUT', '/credentials/profiles/default/github', { value: 'github_pat_eaeaeaeaea' }))
    await refused(await send(EA, 'DELETE', '/credentials/profiles/default'))
    expect(await refused(await send(EA, 'GET', '/connections'))).toBe(
      'The EA cannot see or change connections or their values; the user does that in Seti',
    )
    await refused(await send(EA, 'POST', '/connections', { ...connection, values: { value: 'secret-value' } }))
    await refused(await send(EA, 'PUT', '/connections/any', connection))
    await refused(await send(EA, 'PUT', '/connections/any/values/value', { value: 'secret-value' }))
    await refused(await send(EA, 'PUT', '/connections/any/credentials', { profile_ids: ['default'] }))
    await refused(await send(EA, 'DELETE', '/connections/any'))

    const created = await data<{ id: string }>(await send(USER, 'POST', '/credentials/profiles', { name: 'Work' }))
    const summaries = await data<{ id: string; name: string }[]>(await send(EA, 'GET', '/credential-profiles'))
    expect(summaries.map((profile) => profile.name)).toEqual(['Default', 'Work'])
    expect(JSON.stringify(summaries)).not.toMatch(/rules|aws|github/)
    await idleTask('ea-profile')
    const task = await data<Task>(await send(EA, 'PATCH', '/tasks/ea-profile', { profile_id: created.id }))
    expect(task.profile_id).toBe(created.id)
    expect(await auditEvents.latest('task.profile_changed')).toMatchObject({
      subject_id: 'ea-profile',
      detail: { profile: 'Work', via: 'ea' },
    })
  })

  it('refuses the EA sign-in, passkeys, ssh changes and the secrets routes, reads included', async () => {
    await refused(await send(EA, 'GET', '/auth'))
    await refused(await send(EA, 'GET', '/auth/passkeys'))
    await refused(await send(EA, 'PUT', '/auth/enforcement', { enforced: false }))
    await refused(await send(EA, 'POST', '/local-session', { token: 'x'.repeat(40) }))
    expect((await send(USER, 'GET', '/auth/passkeys')).status).toBe(200)
    expect((await send(EA, 'GET', '/ssh')).status).toBe(200)
    expect(await refused(await send(EA, 'POST', '/ssh/hosts', { alias: 'ea', hostname: '203.0.113.5' }))).toBe(
      'The EA cannot change ssh hosts, keys or trusted host keys; the user does that in Seti',
    )
    await refused(await send(EA, 'PUT', '/credentials/profiles/default/ssh-hosts/ea', {}))
    await refused(await send(EA, 'PATCH', '/ssh/keys/k', { name: 'ea' }))
    await refused(await send(EA, 'GET', '/secrets'))
    expect((await send(USER, 'GET', '/secrets')).status).toBe(200)
  })

  it('starts EA agents sandboxed and only with the ssh and AWS defaults', async () => {
    const base = { title: 'EA agent', prompt: 'Say hi', cwd: scratch }
    expect(await refused(await send(EA, 'POST', '/tasks', { ...base, sandbox: false }))).toContain(
      'outside the sandbox',
    )
    for (const choice of [
      { kind: 'aws', id: 'aws', enabled: true },
      { kind: 'ssh', id: 'box', enabled: true },
      { kind: 'ssh', id: 'box', enabled: false },
    ]) {
      expect(await refused(await send(EA, 'POST', '/tasks', { ...base, access: [choice] }))).toBe(
        'The EA cannot choose ssh hosts or AWS for agents; the user does that in Seti',
      )
    }
    const byEa = await data<Task>(await send(EA, 'POST', '/tasks', base))
    expect(byEa.sandbox).toBe(true)
    const view = await data<TaskAccessView>(await send(EA, 'GET', `/tasks/${byEa.id}/access`))
    expect(view.items.filter((item) => item.kind === 'aws' || item.kind === 'ssh').every((item) => !item.enabled)).toBe(
      true,
    )
    const byUser = await data<Task>(await send(USER, 'POST', '/tasks', { ...base, sandbox: false }))
    expect(byUser.sandbox).toBe(false)
  })

  it("never lets the EA change an agent's sandbox, ssh hosts or AWS, while it may view them", async () => {
    await idleTask('access-task')
    const key = await data<{ id: string }>(await send(USER, 'POST', '/ssh/keys', { name: 'refusals' }))
    const host = { alias: 'box', hostname: '203.0.113.5', user: 'ops', key_id: key.id }
    await data(await send(USER, 'POST', '/ssh/hosts', host))
    for (const change of [{ sandbox: false }, { sandbox: true }]) {
      await refused(await send(EA, 'PATCH', '/tasks/access-task', change))
      await refused(await send(EA, 'PATCH', '/tasks/access-task', { title: 'Renamed', ...change }))
    }
    for (const change of [
      { kind: 'ssh', id: 'box', enabled: true },
      { kind: 'ssh', id: 'box', enabled: null },
      { kind: 'aws', id: 'aws', enabled: true },
    ]) {
      await refused(await send(EA, 'PUT', '/tasks/access-task/access', change))
      await refused(await send(EA, 'PUT', '/access/defaults', { ...change, enabled: true }))
    }
    const view = await data<TaskAccessView>(await send(EA, 'GET', '/tasks/access-task/access'))
    expect(view.items.find((item) => item.kind === 'ssh' && item.id === 'box')).toMatchObject({ enabled: false })
    const catalog = await data<AccessDefault[]>(await send(EA, 'GET', '/access'))
    expect(catalog.find((item) => item.kind === 'aws')).toMatchObject({ default_enabled: false })
    expect(await auditEvents.latest('system.access_default_changed')).toBeUndefined()

    const mcp = await data<TaskAccessView>(
      await send(EA, 'PUT', '/tasks/access-task/access', { kind: 'mcp', id: 'clickup', enabled: false }),
    )
    expect(mcp.items.find((item) => item.kind === 'mcp' && item.id === 'clickup')).toMatchObject({ override: false })
    const byUser = await data<TaskAccessView>(
      await send(USER, 'PUT', '/tasks/access-task/access', { kind: 'ssh', id: 'box', enabled: true }),
    )
    expect(byUser.items.find((item) => item.kind === 'ssh' && item.id === 'box')).toMatchObject({ enabled: true })
    expect((await tasks.get('access-task'))?.title).toBe('access-task')
    expect((await data<Task>(await send(EA, 'PATCH', '/tasks/access-task', { title: 'Renamed' }))).title).toBe(
      'Renamed',
    )
    expect((await data<Task>(await send(USER, 'PATCH', '/tasks/access-task', { sandbox: false }))).sandbox).toBe(false)
    await data(await send(USER, 'DELETE', '/ssh/hosts/box'))
    await data(await send(USER, 'DELETE', `/ssh/keys/${key.id}`))
  })

  it('refuses the EA every share route and the Sharing switch, reads included', async () => {
    const what = 'The EA cannot share files outside Seti; the user does that in Seti'
    await idleTask('share-task')
    expect(await refused(await send(EA, 'GET', '/shares'))).toBe(what)
    expect(await refused(await send(EA, 'PUT', '/shares/settings', { enabled: true }))).toBe(what)
    expect(await refused(await send(EA, 'POST', '/tasks/share-task/shares', { root: 'cwd', path: 'x.md' }))).toBe(what)
    expect(await refused(await send(EA, 'GET', '/tasks/share-task/shares?root=cwd&path=x.md'))).toBe(what)
    expect(await refused(await send(EA, 'POST', '/shares/revoke-all', {}))).toBe(what)
    expect((await data<{ enabled: boolean }>(await send(USER, 'GET', '/shares'))).enabled).toBe(false)
  })

  it('never runs a shell command for the EA', async () => {
    await idleTask('shell-task')
    expect(await refused(await send(EA, 'POST', '/tasks/shell-task/shell', { command: 'id' }))).toBe(
      'The EA cannot run shell commands; the user does that in Seti',
    )
    expect(await auditEvents.latest('task.shell_run')).toBeUndefined()
    expect((await send(USER, 'POST', '/tasks/missing-task/shell', { command: 'id' })).status).toBe(404)
  })

  it('adds only remote MCP servers without credential headers for the EA, and never finishes OAuth', async () => {
    const stdio = { name: 'local-tool', scope: 'user', transport: 'stdio', command: 'touch', args: ['marker'] }
    await refused(await send(EA, 'POST', '/mcp/servers', stdio))
    const headers = [{ key: 'Authorization', value: 'Bearer abc' }]
    const remote = { name: 'tracker', scope: 'user', transport: 'http', url: 'https://mcp.tracker.test/mcp' }
    await refused(await send(EA, 'POST', '/mcp/servers', { ...remote, headers }))
    const callback = { callback_url: 'http://localhost:1234/callback?code=abc&state=def' }
    await refused(await send(EA, 'POST', '/mcp/auth/some-session/complete', callback))
    expect((await send(USER, 'POST', '/mcp/auth/some-session/complete', callback)).status).not.toBe(403)
  })
})

describe('webhook secrets never reach the EA', () => {
  it('holds a secret the EA had Seti issue until the user reveals it once', async () => {
    const res = await send(EA, 'POST', '/channels', { name: 'Uptime', preset: 'generic' })
    const text = await res.clone().text()
    const created = await data<ChannelSecret>(res)
    expect(created.secret).toBeNull()
    expect(created.channel.secret_pending).toBe('reveal')
    expect(text).not.toContain('whsec_')
    const id = created.channel.id

    await refused(await send(EA, 'POST', `/channels/${id}/reveal`, {}))
    const listed = await send(EA, 'GET', '/channels')
    expect(await listed.clone().text()).not.toContain('whsec_')
    expect((await data<WebhookChannelInfo[]>(listed)).find((info) => info.id === id)?.secret_pending).toBe('reveal')

    const revealed = await data<ChannelSecret>(await send(USER, 'POST', `/channels/${id}/reveal`, {}))
    expect(revealed.secret).toMatch(/^whsec_/)
    expect(revealed.channel.secret_pending).toBeNull()
    expect(await auditEvents.latest('system.channel_secret_revealed')).toMatchObject({ subject_id: id })
    expect((await send(USER, 'POST', `/channels/${id}/reveal`, {})).status).toBe(409)

    const body = JSON.stringify({ title: 'api down', severity: 'critical' })
    const hook = await app.request(`/hooks/${id}`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:3006',
        'content-type': 'application/json',
        'x-seti-signature': `sha256=${hmacHex(revealed.secret ?? '', body)}`,
      },
      body,
    })
    expect(hook.status).toBe(200)

    const rotated = await send(EA, 'POST', `/channels/${id}/rotate`, {})
    expect(await rotated.clone().text()).not.toContain('whsec_')
    expect((await data<ChannelSecret>(rotated)).channel.secret_pending).toBe('reveal')
    const byUser = await data<ChannelSecret>(await send(USER, 'POST', `/channels/${id}/rotate`, {}))
    expect(byUser.secret).toMatch(/^whsec_/)
    expect(byUser.channel.secret_pending).toBeNull()
  })

  it('refuses secret values from the EA and leaves a sender secret for the user to paste', async () => {
    const pasted = ['sentry', 'client', 'secret', 'value'].join('-')
    await refused(await send(EA, 'POST', '/channels', { name: 'Sentry', preset: 'sentry', secret: pasted }))
    const created = await data<ChannelSecret>(await send(EA, 'POST', '/channels', { name: 'Sentry', preset: 'sentry' }))
    expect(created.channel.secret_pending).toBe('paste')
    const id = created.channel.id
    await refused(await send(EA, 'POST', `/channels/${id}/rotate`, { secret: pasted }))
    expect((await send(EA, 'POST', `/channels/${id}/rotate`, {})).status).toBe(400)

    await expect(webhooks.sendTest(id)).rejects.toThrow("the sender's secret is not pasted yet")
    const rotated = await data<ChannelSecret>(await send(USER, 'POST', `/channels/${id}/rotate`, { secret: pasted }))
    expect(rotated.channel.secret_pending).toBeNull()
    expect((await data<ChannelInfo>(await send(USER, 'POST', `/channels/${id}/test`, {}))).deliveries[0]?.status).toBe(
      'accepted',
    )
  })

  it('keeps the user flow: the secret comes back at once and there is nothing to reveal', async () => {
    const created = await data<ChannelSecret>(await send(USER, 'POST', '/channels', { name: 'Mine', preset: 'github' }))
    expect(created.secret).toMatch(/^whsec_/)
    expect(created.channel.secret_pending).toBeNull()
    expect((await send(USER, 'POST', `/channels/${created.channel.id}/reveal`, {})).status).toBe(409)
  })
})
