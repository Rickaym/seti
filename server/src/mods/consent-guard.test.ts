import { randomUUID } from 'node:crypto'
import { STEP_UP_REFUSAL } from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as access from '../access.js'
import { storeEnforced } from '../seti-auth.js'
import { sessionRows } from '../store/auth.js'
import { USER_AUTH } from '../test-auth.js'
import { app } from '../test-mod-packages.js'
import { requireUserConsent } from './consent-guard.js'

const source = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }))

vi.mock('../access.js', async (importOriginal) => {
  const real = await importOriginal<typeof access>()
  return { ...real, currentRequestSource: () => source.current ?? real.currentRequestSource() }
})

const ONLY_USER = 'Only the user does this, signed in to Seti with a passkey or on this machine'

async function session(): Promise<string> {
  const id = randomUUID()
  const at = new Date().toISOString()
  await sessionRows.insert({
    id,
    token_hash: randomUUID(),
    passkey_id: null,
    host: 'seti.example.com',
    user_agent: 'test',
    ip: null,
    created_at: at,
    last_seen_at: at,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  })
  return id
}

afterEach(async () => {
  source.current = null
  await storeEnforced(false)
})

describe('who may consent to a mod', () => {
  it('refuses a paired device on every consent route, as it refuses the EA, agents and mods', async () => {
    source.current = { via: 'device', deviceId: 'd1', name: 'Phone', scopes: [], showNames: false }
    await expect(requireUserConsent({ stepUp: false })).rejects.toThrow(ONLY_USER)
    for (const [route, method, body] of [
      ['/api/mod-admin/preview', 'POST', { source: { kind: 'folder', path: '/tmp' } }],
      ['/api/mod-admin/install', 'POST', { mod_id: 'guarded', hash: 'a'.repeat(64) }],
      ['/api/mod-admin/mods/guarded/update/apply', 'POST', { hash: 'a'.repeat(64) }],
      ['/api/mod-admin/mods/guarded/rollback', 'POST', { hash: 'a'.repeat(64) }],
      ['/api/mod-admin/dev-mode', 'PUT', { on: true }],
      ['/api/mod-admin/dev', 'POST', { path: '/tmp' }],
      ['/api/mod-admin/mods/guarded/uninstall', 'POST', { delete_data: true }],
    ] as const) {
      const res = await app.request(route, {
        method,
        headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(res.status, route).toBe(403)
    }
  })

  it('asks a browser session for a passkey check from the last five minutes while Require passkey is on', async () => {
    const id = await session()
    source.current = { via: 'session', sessionId: id, passkey: 'Laptop' }
    await expect(requireUserConsent({ stepUp: true })).resolves.toBeUndefined()
    await storeEnforced(true)
    await expect(requireUserConsent({ stepUp: true })).rejects.toThrow(STEP_UP_REFUSAL)
    await expect(requireUserConsent({ stepUp: false })).resolves.toBeUndefined()
    const now = new Date()
    await sessionRows.steppedUp(id, new Date(now.getTime() - 6 * 60_000).toISOString())
    await expect(requireUserConsent({ stepUp: true }, now)).rejects.toThrow(STEP_UP_REFUSAL)
    await sessionRows.steppedUp(id, new Date(now.getTime() - 60_000).toISOString())
    await expect(requireUserConsent({ stepUp: true }, now)).resolves.toBeUndefined()
    source.current = { via: 'local' }
    await expect(requireUserConsent({ stepUp: true })).resolves.toBeUndefined()
  })
})
