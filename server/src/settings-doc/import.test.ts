import { randomBytes } from 'node:crypto'
import {
  auditQuery,
  type Revision,
  type SettingsDoc,
  type SettingsImportPreview,
  type SettingsPatchResult,
} from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as access from '../access.js'
import { createApp } from '../app.js'
import { auditEvents } from '../store/audit.js'
import { dreamSettings } from '../store/dream-nights.js'
import { mcpDefaults } from '../store/mcp.js'
import { revisions } from '../store/revisions.js'
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
  vi.restoreAllMocks()
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

/** Everything the server writes to its logs while `run` runs. */
async function logsOf(run: () => Promise<void>): Promise<string> {
  const lines: unknown[] = []
  const keep = (...args: unknown[]) => {
    lines.push(...args)
    return true
  }
  vi.spyOn(process.stdout, 'write').mockImplementation(keep)
  vi.spyOn(process.stderr, 'write').mockImplementation(keep)
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation(keep)
  }
  await run()
  vi.restoreAllMocks()
  return lines.map(String).join('\n')
}

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
      capabilities: { mcp_servers: { defaults: { 'evil server': false } } },
      security: {
        sandbox: { enabled: false, allowed_domains: ['evil.example'] },
        connections: { connections: { stolen: { values: { value: planted } } } },
        credentials: { credentials: { Default: { github: { default: planted } } }, agent_tokens: { x: planted } },
      },
      mods: { unknownmod: { enabled: true, settings: { x: 1 } } },
      extra: { anything: planted },
    }
    const securityBefore = (await readDoc()).security
    const auditBefore = (await auditEvents.page(auditQuery.parse({ limit: 1 }))).events[0]?.id ?? 0
    let preview: SettingsImportPreview | undefined
    let responses = ''
    const logs = await logsOf(async () => {
      const res = await post('/preview', { file })
      responses += await res.clone().text()
      preview = await data<SettingsImportPreview>(res)
      const applied = await post('', { file })
      responses += await applied.text()
      const accepted = await post('', { file, accept: ['/capabilities/mcp_servers/defaults/evil server'] })
      responses += await accepted.text()
    })
    expect(responses).not.toContain(planted)
    expect(logs).not.toContain(planted)
    expect(preview?.problems).toEqual([])
    expect(preview?.changes.map((change) => change.path.join('.'))).toEqual(['app.ea.keep_awake_seconds'])
    expect(preview?.offered.map((change) => change.id)).toEqual(['/capabilities/mcp_servers/defaults/evil server'])
    expect(preview?.skipped.map((item) => item.path.join('.')).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'agents.channels.channels',
      'extra.anything',
      'mods.unknownmod.enabled',
      'mods.unknownmod.settings',
      'security.connections.connections',
      'security.credentials.agent_tokens',
      'security.credentials.credentials',
      'security.sandbox.allowed_domains',
      'security.sandbox.enabled',
    ])

    const after = await readDoc()
    expect(after.app?.ea?.keep_awake_seconds).toBe(33)
    expect(after.security).toEqual(securityBefore)
    expect((await mcpDefaults.all())['evil server']).toBe(false)
    const audited = (await auditEvents.page(auditQuery.parse({ limit: 100 }))).events.filter(
      (event) => event.id > auditBefore,
    )
    expect(audited.length).toBeGreaterThan(0)
    expect(JSON.stringify(audited)).not.toContain(planted)
  })

  it('ignores keys that name a JavaScript prototype anywhere in the file', async () => {
    const start = await readDoc()
    const text = `{"file": {"__proto__": {"polluted": 1}, "constructor": {"prototype": {"polluted": 1}},
      "app": {"ea": {"__proto__": {"keep_awake_seconds": 77}, "constructor": 1}},
      "capabilities": {"mcp_servers": {"defaults": {"__proto__": true, "constructor": true}}}},
      "accept": ["/capabilities/mcp_servers/defaults/__proto__", "/capabilities/mcp_servers/defaults/constructor"]}`
    const preview = await data<SettingsImportPreview>(await post('/preview', text))
    expect(preview).toMatchObject({ changes: [], offered: [], problems: [] })
    expect(preview.skipped.map((item) => item.path.join('.'))).toContain('app.ea.__proto__')
    const result = await data<SettingsPatchResult>(await post('', text))
    expect(result).toMatchObject({ revision: null, changed: [] })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.hasOwn(await mcpDefaults.all(), 'constructor')).toBe(false)
    expect((await readDoc()).revision).toBe(start.revision)
  })

  it('records one import as one revision that one Undo reverts exactly', async () => {
    const start = await readDoc()
    const file = {
      app: { ea: { keep_awake_seconds: 41, wake_phrase: 'Hey Import' } },
      agents: { lifecycle: { dreaming: { at_once: (await dreamSettings.get()).at_once === 2 ? 3 : 2 } } },
    }
    const result = await data<SettingsPatchResult>(await post('', { file }))
    expect(result.changed).toHaveLength(3)
    const revision = await revisions.get(result.revision ?? 0)
    expect(revision?.object_type).toBe('settings')
    expect(Object.keys(revision?.after ?? {}).toSorted((a, b) => a.localeCompare(b))).toEqual([
      '/agents/lifecycle/dreaming/at_once',
      '/app/ea/keep_awake_seconds',
      '/app/ea/wake_phrase',
    ])
    const undo = await app.request(`/api/revisions/${String(result.revision)}/revert`, {
      method: 'POST',
      headers: HEADERS,
      body: '{}',
    })
    expect(undo.status).toBe(200)
    expect(((await undo.json()) as { data: Revision }).data.object_type).toBe('settings')
    expect((await readDoc()).revision).toBe(start.revision)
  })

  it('applies nothing from a file with an invalid value, and refuses huge or deep files', async () => {
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
  })

  it('refuses the EA, agents, mods and paired devices on both import routes', async () => {
    const doc = await readDoc()
    const file = { app: { ea: { keep_awake_seconds: 52 } } }
    const refused = [
      { via: 'ea' },
      { via: 'agent', taskId: 't1', title: 'Agent', scope: 'full' },
      { via: 'mod', id: 'sample', grants: [], scopes: {}, eventId: null, caller: null },
      { via: 'device', deviceId: 'd1', name: 'Phone', scopes: ['widget'], showNames: false },
    ]
    for (const as of refused) {
      expect((await post('/preview', { file }, as)).status, `${as.via} preview`).toBe(403)
      expect((await post('', { file }, as)).status, `${as.via} import`).toBe(403)
    }
    expect((await readDoc()).revision).toBe(doc.revision)
  })
})
