import { randomBytes } from 'node:crypto'
import type { SettingsDoc, SettingsImportPreview, SettingsPatchResult } from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as access from '../access.js'
import { createApp } from '../app.js'
import { mcpDefaults } from '../store/mcp.js'
import { USER_AUTH } from '../test-auth.js'
import { withBundledMods } from '../test-mods.js'

withBundledMods()

const source = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }))

vi.mock('../access.js', async (importOriginal) => {
  const real = await importOriginal<typeof access>()
  return { ...real, currentRequestSource: () => source.current ?? real.currentRequestSource() }
})

afterEach(() => {
  source.current = null
})

const app = createApp()
const HEADERS = {
  host: '127.0.0.1:3006',
  origin: 'http://127.0.0.1:3006',
  'content-type': 'application/json',
  ...USER_AUTH,
}

type Doc = SettingsDoc & Record<string, Record<string, Record<string, unknown>> | undefined>

async function readDoc(): Promise<Doc> {
  source.current = null
  const res = await app.request('/api/settings-doc', { headers: HEADERS })
  return ((await res.json()) as { data: Doc }).data
}

async function post(path: string, body: unknown, as: Record<string, unknown> | null = null): Promise<Response> {
  source.current = as
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return app.request(`/api/settings-doc/import${path}`, { method: 'POST', headers: HEADERS, body: text })
}

const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

describe('importing settings from a file', () => {
  it('changes nothing when it imports its own export', async () => {
    const doc = await readDoc()
    const preview = await data<SettingsImportPreview>(await post('/preview', { file: doc }))
    expect(preview).toMatchObject({ changes: [], offered: [], problems: [], confirm: [] })
    const result = await data<SettingsPatchResult>(await post('', { file: doc }))
    expect(result).toMatchObject({ revision: null, changed: [] })
    expect((await readDoc()).revision).toBe(doc.revision)
  })

  it('treats the file as hostile: skips security, secrets, code and mods, offers servers one by one', async () => {
    const planted = `planted${randomBytes(12).toString('hex')}`
    const file = {
      version: 1,
      app: { ea: { keep_awake_seconds: 33 } },
      agents: {
        channels: {
          channels: { evil: { source: 'webhook', preset: 'x', filter: { enabled: true, script: 'run()' } } },
        },
      },
      capabilities: { mcp_servers: { defaults: { 'evil server': true } } },
      security: {
        sandbox: { enabled: false, allowed_domains: ['evil.example'] },
        connections: { connections: { stolen: { values: { value: planted } } } },
      },
      mods: { unknownmod: { enabled: true, settings: { x: 1 } } },
      extra: { anything: planted },
    }
    const res = await post('/preview', { file })
    const text = await res.clone().text()
    expect(text).not.toContain(planted)
    const preview = await data<SettingsImportPreview>(res)
    expect(preview.problems).toEqual([])
    expect(preview.changes.map((change) => change.path.join('.'))).toEqual(['app.ea.keep_awake_seconds'])
    expect(preview.offered.map((change) => change.id)).toEqual(['/capabilities/mcp_servers/defaults/evil server'])
    expect(preview.skipped.map((item) => item.path.join('.')).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'agents.channels.channels',
      'extra.anything',
      'mods.unknownmod.enabled',
      'mods.unknownmod.settings',
      'security.connections.connections',
      'security.sandbox.allowed_domains',
      'security.sandbox.enabled',
    ])

    await data<SettingsPatchResult>(await post('', { file }))
    const after = await readDoc()
    expect(after.app?.ea?.keep_awake_seconds).toBe(33)
    expect((await mcpDefaults.all())['evil server']).toBeUndefined()
    expect(after.security?.sandbox?.enabled).toBe(true)

    const accepted = await data<SettingsPatchResult>(
      await post('', { file, accept: ['/capabilities/mcp_servers/defaults/evil server'] }),
    )
    expect(accepted.changed.map((path) => path.join('.'))).toEqual(['capabilities.mcp_servers.defaults.evil server'])
    expect(JSON.stringify(accepted)).not.toContain(planted)
  })

  it('applies nothing from a file with an invalid value, and refuses huge, deep or delegated imports', async () => {
    const doc = await readDoc()
    const bad = { app: { ea: { keep_awake_seconds: 'soon', wake_phrase: 'Hey Bad' } } }
    const preview = await data<SettingsImportPreview>(await post('/preview', { file: bad }))
    expect(preview.problems.map((problem) => problem.path.join('.'))).toContain('app.ea.keep_awake_seconds')
    expect((await post('', { file: bad })).status).toBe(400)
    expect((await readDoc()).revision).toBe(doc.revision)

    const huge = JSON.stringify({ file: { app: { general: { name: 'x'.repeat(10 * 1024 * 1024) } } } })
    expect((await post('', huge)).status).toBe(413)
    const deep = Array.from({ length: 20 }).reduce<Record<string, unknown>>((inner) => ({ a: inner }), {})
    expect((await post('/preview', { file: deep })).status).toBe(400)
    for (const as of [{ via: 'ea' }, { via: 'agent', taskId: 't1', title: 'A', scope: 'full' }]) {
      expect((await post('', { file: bad }, as)).status).toBe(403)
    }
  })
})
