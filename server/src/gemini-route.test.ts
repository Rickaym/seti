import { DEFAULT_PROFILE_ID, GEMINI_SETTINGS_DEFAULTS, type GeminiStatus, type RuntimesStatus } from '@seti/shared'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { asAgent } from './access.js'
import { createApp } from './app.js'
import { fetchGemini, holdsBundle } from './gemini-fetch.js'
import { installGemini } from './gemini-install.js'
import { updateGeminiSettings } from './gemini-status.js'
import { InstallError } from './pinned-download.js'
import { auditEvents } from './store/audit.js'
import { geminiSettings } from './store/gemini-settings.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'
import { clearConnections, keyConnection } from './test-connections.js'

await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  process.env.SETI_HOME = nodePath.join(mkdtempSync(nodePath.join(tmpdir(), 'seti-gemini-route-')), 'seti')
})

vi.mock('./gemini-fetch.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchGemini: vi.fn(),
  holdsBundle: vi.fn(),
}))

const app = createApp()
const HEADERS = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006', 'content-type': 'application/json' }
const runtimes = async () =>
  (
    (await (await app.request('/api/runtimes', { headers: { ...HEADERS, ...USER_AUTH } })).json()) as {
      data: RuntimesStatus
    }
  ).data
const status = async (): Promise<GeminiStatus> => (await runtimes()).gemini
const call = async (method: string, route: string, body: object = {}, auth: object = USER_AUTH) =>
  app.request(`/api/runtimes/gemini${route}`, { method, headers: { ...HEADERS, ...auth }, body: JSON.stringify(body) })

/** Seti's copy is on disk once a fetch has passed, as `holdsBundle` would find it. */
let held = false

const fetchPasses = async () => {
  held = true
  return Promise.resolve({ entry: '/nowhere/gemini.js', fetched: true })
}

beforeEach(async () => {
  held = false
  vi.mocked(holdsBundle).mockImplementation(async () => Promise.resolve(held))
  vi.mocked(fetchGemini).mockImplementation(fetchPasses)
  await geminiSettings.set(GEMINI_SETTINGS_DEFAULTS)
  await clearConnections()
})

afterAll(async () => {
  await geminiSettings.set(GEMINI_SETTINGS_DEFAULTS)
  await clearConnections()
})

describe('the Gemini runtime in Settings', () => {
  it('starts off and offers no Gemini model', async () => {
    expect(await status()).toMatchObject({ state: 'off', failure: null, pinned: '0.71.1', keyed: [] })
    expect((await status()).pricesAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect((await runtimes()).offers.map((offer) => offer.runtime)).not.toContain('gemini')
  })

  it('installs on enable, waits for a key, then offers its models with Gemini 4 marked unproven', async () => {
    expect((await call('PUT', '', { enabled: true })).status).toBe(200)
    await installGemini('user')
    expect(vi.mocked(fetchGemini)).toHaveBeenCalled()
    expect(await status()).toMatchObject({ state: 'no_key', keyElsewhere: null })
    await keyConnection('gemini_route_key', 'not-a-key', {
      hosts: ['generativelanguage.googleapis.com'],
      header: { name: 'x-goog-api-key', template: '{{value}}' },
      profile_ids: [DEFAULT_PROFILE_ID],
    })
    expect(await status()).toMatchObject({ state: 'ready', keyed: [DEFAULT_PROFILE_ID] })
    const offer = (await runtimes()).offers.find((each) => each.runtime === 'gemini')
    expect(offer?.models.find((model) => model.id === 'gemini-3.8-flash')?.label).toBe('gemini-3.8-flash')
    expect(offer?.models.find((model) => model.id === 'gemini-4-carbon')?.label).toBe('gemini-4-carbon (unproven)')
    const recorded = await auditEvents.latest('system.runtime_changed')
    expect(recorded?.detail).toMatchObject({ runtime: 'gemini', changed: ['enabled'] })
  })

  it('shows a failed install with its reason until Retry installs it', async () => {
    // every fetch fails, whether this call joins the install the PUT started or runs its own
    vi.mocked(fetchGemini).mockRejectedValue(new InstallError('network', 'The registry did not answer'))
    await call('PUT', '', { enabled: true })
    await installGemini('user')
    expect(await status()).toMatchObject({ state: 'failed', failure: { reason: 'network' } })
    vi.mocked(fetchGemini).mockImplementation(fetchPasses)
    expect((await call('POST', '/retry')).status).toBe(200)
    await installGemini('user')
    expect((await status()).state).toBe('no_key')
  })

  it('refuses a change from the EA or an agent, and a model it does not offer', async () => {
    expect((await call('PUT', '', { enabled: true }, EA_AUTH)).status).toBe(403)
    expect((await call('POST', '/retry', {}, EA_AUTH)).status).toBe(403)
    const caller = { id: 'gemini-agent', title: 'Agent', seti_control: 'full' as const }
    await expect(asAgent(caller, async () => updateGeminiSettings({ enabled: true }))).rejects.toThrow()
    expect((await call('PUT', '', { default_model: 'gemini-9' })).status).toBe(400)
    expect((await call('PUT', '', { default_model: 'gemini-4-neon' })).status).toBe(200)
    expect(await geminiSettings.get()).toMatchObject({ enabled: false, default_model: 'gemini-4-neon' })
  })
})
