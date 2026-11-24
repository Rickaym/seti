import { randomBytes } from 'node:crypto'
import { channelCreateInput, connectionCreateInput, SETTINGS_SECTIONS, type SettingsDoc } from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as access from '../access.js'
import { createApp } from '../app.js'
import { createChannel } from '../channels/actions.js'
import { createConnection } from '../connections.js'
import { credentialsOverview, setProfileGitHub } from '../credential-profiles.js'
import { secrets } from '../secrets.js'
import { userSettings } from '../store/user.js'
import { USER_AUTH } from '../test-auth.js'
import { withBundledMods } from '../test-mods.js'
import { undocumented, type JsonSchema } from './test-schema.js'

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
const HEADERS = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006', ...USER_AUTH }
const EA = { via: 'ea' }

async function get(path: string): Promise<Response> {
  return app.request(`/api/settings-doc${path}`, { headers: HEADERS })
}

async function read<T>(path: string, as: Record<string, unknown> | null = null): Promise<T> {
  source.current = as
  const res = await get(path)
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: T }).data
}

describe('the settings document', () => {
  it('documents every key and holds a value for every section', async () => {
    const schema = await read<JsonSchema>('/schema')
    expect(undocumented(schema)).toEqual([])
    const doc = await read<SettingsDoc>('')
    expect(doc.version).toBe(1)
    expect(doc.revision).toMatch(/^[0-9a-f]{64}$/)
    for (const path of Object.keys(SETTINGS_SECTIONS)) {
      const [group = '', page = ''] = path.split('.')
      expect((doc[group] as Record<string, unknown> | undefined)?.[page], path).toBeDefined()
    }
  })

  it('parses against the schema the routes validate with, a name Seti does not know yet too', async () => {
    await userSettings.set({ name: '' })
    const doc = await read<Record<string, Record<string, unknown>>>('')
    expect(doc.app?.general).toMatchObject({ name: null })
    for (const [path, section] of Object.entries(SETTINGS_SECTIONS)) {
      const [group = '', page = ''] = path.split('.')
      const parsed = section.schema.safeParse(doc[group]?.[page])
      expect(parsed.error?.issues ?? [], path).toEqual([])
    }
  })

  it('keeps security settings out of the EA document and its schema', async () => {
    const doc = await read<Record<string, Record<string, Record<string, unknown>>>>('', EA)
    expect(doc.security).toBeUndefined()
    expect(doc.agents?.storage).toBeUndefined()
    expect(doc.agents?.runtimes).toBeUndefined()
    expect(doc.agents?.channels?.poller_access).toBeUndefined()
    expect(doc.app?.ea).toBeDefined()
    const schema = await read<JsonSchema>('/schema', EA)
    expect(Object.keys(schema.properties ?? {})).not.toContain('security')
    const user = await read<SettingsDoc>('')
    expect(user.revision).not.toBe(doc.revision)
  })

  it('refuses agents, mods and paired devices on every route', async () => {
    const refused = [
      { via: 'agent', taskId: 't1', title: 'Agent', scope: 'full' },
      { via: 'mod', id: 'sample', grants: [], scopes: {}, eventId: null, caller: null },
      { via: 'device', deviceId: 'd1', name: 'Phone', scopes: ['widget'], showNames: false },
    ]
    for (const as of refused) {
      for (const path of ['', '/schema']) {
        source.current = as
        expect((await get(path)).status, `${as.via} ${path}`).toBe(403)
      }
    }
  })
})

describe('secrets in the settings document', () => {
  it('never carries a value, only whether it is set', async () => {
    const mark = () => `planted${randomBytes(12).toString('hex')}`
    const connectionValue = mark()
    const claudeToken = mark()
    const githubToken = `ghp_${mark()}`
    const ownerToken = `ghp_${mark()}`
    const connection = connectionCreateInput.parse({
      name: 'planted_api',
      kind: 'key',
      env: 'PLANTED_API_KEY',
      hosts: ['api.planted.example'],
      values: { value: connectionValue },
    })
    await createConnection(connection)
    await secrets.set('claude_oauth_token', claudeToken, 'settings')
    const [profile] = (await credentialsOverview()).profiles
    await setProfileGitHub(profile?.id ?? 'default', null, githubToken)
    await setProfileGitHub(profile?.id ?? 'default', 'planted-org', ownerToken)
    const { secret: webhookSecret } = await createChannel(
      channelCreateInput.parse({ name: 'planted-hook', preset: 'github' }),
    )
    expect(webhookSecret).toMatch(/.{16,}/)

    const outputs = [
      JSON.stringify(await read('')),
      JSON.stringify(await read('/schema')),
      JSON.stringify(await read('', EA)),
      JSON.stringify(await read('/schema', EA)),
    ]
    for (const output of outputs) {
      for (const planted of [connectionValue, claudeToken, githubToken, ownerToken, String(webhookSecret)]) {
        expect(output).not.toContain(planted)
      }
    }
    const doc = await read<Record<string, Record<string, Record<string, unknown>>>>('')
    expect(doc.security?.connections).toMatchObject({ connections: { planted_api: { values: { value: 'set' } } } })
    expect(doc.security?.credentials).toMatchObject({ agent_tokens: { claude_oauth_token: 'set' } })
  })
})
