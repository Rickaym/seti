import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { CODEX_SETTINGS_DEFAULTS, DEFAULT_PROFILE_ID, type CodexStatus } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { asAgent } from './access.js'
import { createApp } from './app.js'
import { installCodex, sweepCodex } from './codex-install.js'
import { retryCodex, updateCodexSettings } from './codex-status.js'
import { CODEX_ROOT } from './config.js'
import { sql, tasks } from './db.js'
import { launchPlan } from './launch-plan.js'
import { startingSpec } from './session-spec.js'
import { auditEvents } from './store/audit.js'
import { codexSettings } from './store/codex-settings.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'
import { clearConnections, keyConnection } from './test-connections.js'

const { scratch, registry, version } = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const { fakeBuild, FakeRegistry } = await import('./test-codex-registry.js')
  const root = fs.mkdtempSync(nodePath.join(tmpdir(), 'seti-codex-route-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  const fake = await new FakeRegistry().start()
  const pinFile = nodePath.join(root, 'pin.json')
  fs.writeFileSync(pinFile, JSON.stringify(fake.pin(fakeBuild(root, '9.1.0', '/bin/sleep'))))
  process.env.SETI_CODEX_PIN = pinFile
  return { scratch: root, registry: fake, version: '9.1.0' }
})

const app = createApp()
const HEADERS = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006', 'content-type': 'application/json' }
const status = async () =>
  (
    (await (await app.request('/api/runtimes', { headers: { ...HEADERS, ...USER_AUTH } })).json()) as {
      data: { codex: CodexStatus }
    }
  ).data.codex
const call = async (method: 'PUT' | 'POST', url: string, body: object, auth: object = USER_AUTH) => {
  const response = await app.request(`/api/runtimes/codex${url}`, {
    method,
    headers: { ...HEADERS, ...auth },
    body: JSON.stringify(body),
  })
  return { status: response.status, codex: ((await response.json()) as { data?: CodexStatus }).data }
}
const PROGRAM = path.join(CODEX_ROOT, version, 'codex')

const openaiKey = async (name: string, profiles: string[]) =>
  keyConnection(name, 'not-a-key', {
    hosts: ['api.openai.com'],
    header: { name: 'Authorization', template: 'Bearer {{value}}' },
    profile_ids: profiles,
  })

afterAll(async () => {
  await registry.close()
  await codexSettings.set(CODEX_SETTINGS_DEFAULTS)
  await sweepCodex()
  await clearConnections()
})

describe('turning Codex on in Settings', () => {
  it('installs the pinned version, then reads no key until the default credential holds one', async () => {
    await clearConnections()
    const turned = await call('PUT', '', { enabled: true })
    expect(turned).toMatchObject({ status: 200, codex: { state: 'installing', binary: null } })
    await installCodex('user')
    expect(await status()).toMatchObject({ state: 'no_key', version, binary: PROGRAM, failure: null })
    await openaiKey('route_outside', [])
    expect((await status()).keyElsewhere, 'names the one key the default credential lacks').toBe('route_outside')
    await openaiKey('route_default', [DEFAULT_PROFILE_ID])
    expect(await status()).toMatchObject({ state: 'ready', keyElsewhere: null })
    expect(await auditEvents.latest('system.runtime_installed')).toMatchObject({ actor: 'user' })
  })

  it("starts a Codex agent's process on Seti's copy, its folder read-only in the sandbox", async () => {
    const at = { id: 'route-codex', title: 'Codex', repo_id: null, cwd: scratch, worktree: false, pr_urls: [] }
    await tasks.insert({ ...at, sandbox: true })
    await sql`UPDATE task SET runtime = 'codex' WHERE id = 'route-codex'`
    const task = await tasks.get('route-codex')
    if (task === undefined) {
      throw new Error('the task was not stored')
    }
    const { spec } = await startingSpec(task)
    expect(spec.vendor).toMatchObject({ binary: PROGRAM })
    expect((await launchPlan(task)).sandbox?.readOnly).toContain(path.dirname(PROGRAM))
  })

  it('refuses the EA and agents, who neither turn Codex on nor retry its install', async () => {
    expect((await call('PUT', '', { enabled: false }, EA_AUTH)).status).toBe(403)
    expect((await call('POST', '/retry', {}, EA_AUTH)).status).toBe(403)
    const caller = { id: 'route-agent', title: 'Agent', seti_control: 'full' as const }
    await expect(asAgent(caller, async () => retryCodex())).rejects.toThrow(/Agents cannot/)
    await expect(asAgent(caller, async () => updateCodexSettings({ enabled: false }))).rejects.toThrow(/Agents/)
    expect((await codexSettings.get()).enabled).toBe(true)
  })

  it('removes its copy when turned off, shows why an install failed, and retries', async () => {
    await call('PUT', '', { enabled: false })
    expect(existsSync(path.join(CODEX_ROOT, version))).toBe(false)
    registry.mode = 'down'
    await call('PUT', '', { enabled: true })
    await installCodex('user')
    expect(await status()).toMatchObject({ state: 'failed', failure: { reason: 'network' }, binary: null })
    registry.mode = 'serve'
    expect((await call('POST', '/retry', {})).codex?.state).toBe('installing')
    await installCodex('user')
    expect((await status()).state).toBe('ready')
  })

  it('keeps a program the user named working as before and fetches nothing for it', async () => {
    const own = path.join(scratch, 'own-codex')
    writeFileSync(own, `#!/bin/sh\necho "codex-cli ${version}"\n`)
    chmodSync(own, 0o755)
    const asked = registry.ranges.length
    expect((await call('PUT', '', { program: own })).codex).toMatchObject({ state: 'ready', binary: own })
    expect(registry.ranges).toHaveLength(asked)
    expect(existsSync(own)).toBe(true)
    expect(existsSync(path.join(CODEX_ROOT, version)), "Seti's copy goes, the user's program stays").toBe(false)
  })
})
