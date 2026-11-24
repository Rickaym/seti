import { chmodSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { CODEX_SETTINGS_DEFAULTS, DEFAULT_PROFILE_ID, type RuntimesStatus } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { asAgent } from './access.js'
import { createApp } from './app.js'
import { setBypass } from './bypass.js'
import { updateCodexSettings } from './codex-status.js'
import { sql, tasks } from './db.js'
import { auditEvents } from './store/audit.js'
import { codexSettings } from './store/codex-settings.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'
import { clearConnections, keyConnection } from './test-connections.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-runtimes-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

/** A stand-in program that reports a version as `codex --version` does. */
function program(name: string, version: string): string {
  const file = path.join(scratch, name)
  writeFileSync(file, `#!/bin/sh\necho "codex-cli ${version}"\n`)
  chmodSync(file, 0o755)
  return file
}

const app = createApp()
const HEADERS = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006', 'content-type': 'application/json' }
const runtimes = async (auth: object = USER_AUTH) =>
  (
    (await (await app.request('/api/runtimes', { headers: { ...HEADERS, ...auth } })).json()) as {
      data: RuntimesStatus
    }
  ).data
const status = async (auth: object = USER_AUTH) => (await runtimes(auth)).codex
const offered = async () => (await runtimes()).offers.map((offer) => offer.runtime)
const change = async (body: object, auth: object = USER_AUTH) =>
  app.request('/api/runtimes/codex', { method: 'PUT', headers: { ...HEADERS, ...auth }, body: JSON.stringify(body) })

/** A key connection in the default credential with a header on OpenAI's API and a dummy value. */
const openaiKey = async () =>
  keyConnection('runtimes_openai', 'not-a-key', {
    hosts: ['api.openai.com'],
    header: { name: 'Authorization', template: 'Bearer {{value}}' },
    profile_ids: [DEFAULT_PROFILE_ID],
  })

afterAll(async () => {
  await codexSettings.set(CODEX_SETTINGS_DEFAULTS)
  await clearConnections()
})

describe('the Codex runtime in Settings', () => {
  it('starts off, with the pinned version and the price table date', async () => {
    await codexSettings.set(CODEX_SETTINGS_DEFAULTS)
    expect(await status(EA_AUTH)).toMatchObject({ state: 'off', version: null, pinned: '0.171.0' })
    expect((await status()).pricesAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect((await runtimes()).offers).toEqual([{ runtime: 'claude', models: [], efforts: [] }])
  })

  it('is ready only on, with a program of the pinned version and a key, and records each change', async () => {
    await clearConnections()
    expect((await change({ enabled: true })).status).toBe(200)
    expect((await status()).state).toBe('not_set_up')
    await change({ program: path.join(scratch, 'nowhere') })
    expect((await status()).state).toBe('missing')
    await change({ program: program('old-codex', '0.170.0') })
    expect(await status()).toMatchObject({ state: 'update_needed', version: '0.170.0' })
    await change({ program: program('codex', '0.171.0') })
    expect(await status()).toMatchObject({ state: 'no_key', version: '0.171.0', keyed: [] })
    await openaiKey()
    expect(await status()).toMatchObject({ state: 'ready', keyed: [DEFAULT_PROFILE_ID] })
    expect(await offered()).toEqual(['claude', 'codex'])
    expect((await runtimes()).offers[1]).toMatchObject({
      models: ['gpt-5.5'],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    })
    const recorded = await auditEvents.latest('system.runtime_changed')
    expect(recorded?.detail).toMatchObject({ runtime: 'codex', changed: ['program'] })
  })

  it('refuses a change from the EA, an agent or a relative path, and keeps evaluator_decides off', async () => {
    expect((await change({ evaluator_decides: true }, EA_AUTH)).status).toBe(403)
    const caller = { id: 'runtimes-agent', title: 'Agent', seti_control: 'full' as const }
    await expect(asAgent(caller, async () => updateCodexSettings({ evaluator_decides: true }))).rejects.toThrow()
    expect((await change({ program: 'codex' })).status).toBe(400)
    expect((await codexSettings.get()).evaluator_decides).toBe(false)
  })
})

describe('a new Codex agent', () => {
  const start = async (body: object) =>
    app.request('/api/tasks', { method: 'POST', headers: { ...HEADERS, ...USER_AUTH }, body: JSON.stringify(body) })

  it('is refused while Codex is off, also when only its model names it, and never runs a Codex model on Claude Code', async () => {
    await codexSettings.set(CODEX_SETTINGS_DEFAULTS)
    const off = await start({ title: 'Port', prompt: 'port it', runtime: 'codex' })
    expect(off.status).toBe(409)
    expect(await off.text()).toContain('Codex is off')
    const byModel = await start({ title: 'Port', prompt: 'port it', model: 'gpt-5.5' })
    expect(byModel.status).toBe(409)
    expect(await byModel.text()).toContain('Codex is off')
    const mixed = await start({ title: 'Port', prompt: 'port it', runtime: 'claude', model: 'gpt-5.5' })
    expect(mixed.status).toBe(400)
    expect(await mixed.text()).toContain('gpt-5.5 runs on Codex, not on Claude Code')
    const unknown = await start({ title: 'Port', prompt: 'port it', model: 'claude-opus-5-5' })
    expect(unknown.status).toBe(400)
    expect(await unknown.text()).toContain('No runtime offers claude-opus-5-5')
  })

  it('is refused on a credential without an OpenAI key, with where the user adds one', async () => {
    await clearConnections()
    await codexSettings.set({ ...CODEX_SETTINGS_DEFAULTS, enabled: true, program: program('codex', '0.171.0') })
    const bare = await start({ title: 'Port', prompt: 'port it', runtime: 'codex' })
    expect(bare.status).toBe(409)
    expect(await bare.text()).toContain('has no OpenAI key')
    await keyConnection('runtimes_pending', 'not-a-key', {
      hosts: ['api.openai.com'],
      profile_ids: [DEFAULT_PROFILE_ID],
    })
    expect((await status()).state).toBe('no_key')
  })

  it('has no Bypass', async () => {
    await tasks.insert({
      id: 'runtimes-codex',
      title: 'Codex',
      repo_id: null,
      cwd: scratch,
      worktree: false,
      pr_urls: [],
    })
    await sql`UPDATE task SET runtime = 'codex' WHERE id = 'runtimes-codex'`
    const task = await tasks.get('runtimes-codex')
    if (task === undefined) {
      throw new Error('the task was not stored')
    }
    await expect(setBypass(task, 2)).rejects.toThrow(/Codex agents have no Bypass/)
  })
})
