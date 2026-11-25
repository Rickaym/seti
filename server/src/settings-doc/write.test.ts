import { randomBytes } from 'node:crypto'
import {
  connectionCreateInput,
  DREAM_SETTINGS_DEFAULTS,
  type Revision,
  type SettingsDoc,
  type SettingsPatchResult,
} from '@seti/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as access from '../access.js'
import { createApp } from '../app.js'
import { createConnection } from '../connections.js'
import { archiveSettings } from '../store/archive.js'
import { auditEvents } from '../store/audit.js'
import { dreamSettings } from '../store/dream-nights.js'
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
})

beforeEach(async () => {
  await dreamSettings.set({ ...DREAM_SETTINGS_DEFAULTS })
  await archiveSettings.set({ ...(await archiveSettings.get()), delete_after_days: null })
})

const app = createApp()
const HEADERS = {
  host: '127.0.0.1:3006',
  origin: 'http://127.0.0.1:3006',
  'content-type': 'application/json',
  ...USER_AUTH,
}

type Doc = SettingsDoc & Record<string, Record<string, Record<string, Record<string, unknown>>> | undefined>

async function readDoc(): Promise<Doc> {
  source.current = null
  const res = await app.request('/api/settings-doc', { headers: HEADERS })
  return ((await res.json()) as { data: Doc }).data
}

async function send(body: Record<string, unknown>, as: Record<string, unknown> | null = null): Promise<Response> {
  source.current = as
  return app.request('/api/settings-doc', { method: 'PATCH', headers: HEADERS, body: JSON.stringify(body) })
}

async function write(patch: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<Response> {
  return send({ base_revision: (await readDoc()).revision, patch, ...extra })
}

const dreaming = (doc: Doc) => doc.agents?.lifecycle?.dreaming

describe('writing settings as JSON', () => {
  it('applies a plain change once, audited as the page audits it, as one revision', async () => {
    const before = await auditEvents.latest('dream.settings_changed')
    const res = await write({ agents: { lifecycle: { dreaming: { at_once: 2, model: 'claude-haiku-5-5' } } } })
    expect(res.status).toBe(200)
    const result = ((await res.json()) as { data: SettingsPatchResult }).data
    expect(dreaming(result.doc as Doc)).toMatchObject({ at_once: 2, model: 'claude-haiku-5-5' })
    expect(result.changed.map((path) => path.join('.')).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'agents.lifecycle.dreaming.at_once',
      'agents.lifecycle.dreaming.model',
    ])
    const audited = await auditEvents.latest('dream.settings_changed')
    expect(audited?.id).not.toBe(before?.id)
    expect(audited?.detail).toMatchObject({ changed: ['model', 'at_once'] })
    const revision = await revisions.get(result.revision ?? 0)
    expect(revision).toMatchObject({
      object_type: 'settings',
      before: { '/agents/lifecycle/dreaming/at_once': '1' },
      after: { '/agents/lifecycle/dreaming/at_once': '2' },
    })
  })

  it('undoes a write exactly through its revision', async () => {
    const start = await readDoc()
    const res = await write({
      agents: { lifecycle: { dreaming: { at_once: 3 } } },
      app: { ea: { wake_phrase: 'Hey Doc' } },
    })
    const { revision } = ((await res.json()) as { data: SettingsPatchResult }).data
    const undo = await app.request(`/api/revisions/${String(revision)}/revert`, {
      method: 'POST',
      headers: HEADERS,
      body: '{}',
    })
    expect(undo.status).toBe(200)
    expect(((await undo.json()) as { data: Revision }).data.object_type).toBe('settings')
    const end = await readDoc()
    expect(end.revision).toBe(start.revision)
  })

  it('refuses a whole patch with an invalid key or value, naming the path', async () => {
    const res = await write({
      agents: { lifecycle: { dreaming: { at_once: 9, nap: true } } },
      app: { ea: { wake_phrase: 'Hi Seti' } },
    })
    expect(res.status).toBe(400)
    const { error } = (await res.json()) as { error: { problems: { path: string[]; message: string }[] } }
    const paths = error.problems.map((problem) => problem.path.join('.'))
    expect(paths).toContain('agents.lifecycle.dreaming.at_once')
    expect(paths.some((path) => path.startsWith('agents.lifecycle.dreaming'))).toBe(true)
    expect((await readDoc()).app?.ea?.wake_phrase).not.toBe('Hi Seti')
  })

  it('refuses a patch that names a security setting or a secret, applying none of it', async () => {
    const planted = `planted${randomBytes(12).toString('hex')}`
    const res = await write({
      app: { ea: { keep_awake_seconds: 45 } },
      security: { sandbox: { enabled: false }, connections: { connections: { x: { values: { value: planted } } } } },
    })
    expect(res.status).toBe(403)
    const text = await res.text()
    expect(text).not.toContain(planted)
    expect(text).toContain('security')
    expect((await readDoc()).app?.ea?.keep_awake_seconds).not.toBe(45)
  })

  it('refuses a value that changed since the client read it', async () => {
    const old = await readDoc()
    await dreamSettings.set({ ...DREAM_SETTINGS_DEFAULTS, at_once: 3 })
    const res = await send({
      base_revision: old.revision,
      patch: { agents: { lifecycle: { dreaming: { at_once: 2 } } } },
      expect: [{ path: ['agents', 'lifecycle', 'dreaming', 'at_once'], value: 1 }],
    })
    expect(res.status).toBe(409)
    expect(dreaming(await readDoc())?.at_once).toBe(3)
  })

  it('needs a confirmation to delete archived agents', async () => {
    const patch = { agents: { lifecycle: { auto_archive: { delete_after_days: 30 } } } }
    const res = await write(patch)
    expect(res.status).toBe(409)
    const { error } = (await res.json()) as { error: { confirm: { id: string; consequence: string }[] } }
    expect(error.confirm.map((item) => item.id)).toEqual(['agents.lifecycle.auto_archive.delete_after_days'])
    expect(error.confirm[0]?.consequence).toContain('30 days')
    expect((await write(patch, { confirm: ['agents.lifecycle.auto_archive.delete_after_days'] })).status).toBe(200)
  })

  it('refuses the EA, agents, mods and paired devices', async () => {
    const doc = await readDoc()
    const body = { base_revision: doc.revision, patch: { app: { ea: { keep_awake_seconds: 50 } } } }
    const refused = [
      { via: 'ea' },
      { via: 'agent', taskId: 't1', title: 'Agent', scope: 'full' },
      { via: 'mod', id: 'sample', grants: [], scopes: {}, eventId: null, caller: null },
      { via: 'device', deviceId: 'd1', name: 'Phone', scopes: ['widget'], showNames: false },
    ]
    for (const as of refused) {
      expect((await send(body, as)).status, as.via).toBe(403)
    }
    expect((await readDoc()).app?.ea?.keep_awake_seconds).not.toBe(50)
  })

  it('never writes a secret into an error or a revision', async () => {
    const value = `planted${randomBytes(12).toString('hex')}`
    await createConnection(
      connectionCreateInput.parse({
        name: 'planted_write',
        kind: 'key',
        env: 'PLANTED_W',
        hosts: ['w.example'],
        values: { value },
      }),
    )
    const res = await write({ app: { ea: { keep_awake_seconds: 'x' } } })
    expect(await res.text()).not.toContain(value)
    const ok = await write({ app: { ea: { keep_awake_seconds: 40 } } })
    const { revision } = ((await ok.json()) as { data: SettingsPatchResult }).data
    expect(JSON.stringify(await revisions.get(revision ?? 0))).not.toContain(value)
  })
})
