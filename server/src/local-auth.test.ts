import { describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { credential } from './credentials.js'
import { auditEvents } from './store/audit.js'

const app = createApp({ access: null, verify: null })
const HOST = { host: 'seti.localhost:3006', origin: 'http://seti.localhost:3006' }

const userToken = credential('local-token-user') ?? ''
const eaToken = credential('local-token-ea') ?? ''

async function signIn(token: string) {
  return app.request('/api/local-session', {
    method: 'POST',
    headers: { ...HOST, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
}

const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''

describe('local browser sign-in', () => {
  it('trades the user token for an HttpOnly session cookie that reaches the API', async () => {
    expect((await app.request('/api/system', { headers: HOST })).status).toBe(401)
    const res = await signIn(userToken)
    expect(res.status).toBe(200)
    const header = res.headers.get('set-cookie') ?? ''
    expect(header).toMatch(/HttpOnly/)
    expect(header).toMatch(/SameSite=Strict/)
    expect(header).not.toContain(userToken)
    const cookie = cookieOf(res)
    expect((await app.request('/api/system', { headers: { ...HOST, cookie } })).status).toBe(200)
    const state = await app.request('/api/auth', { headers: { ...HOST, cookie } })
    expect(await state.json()).toEqual({
      data: { signed_in: true, method: 'local', passkeys: false, local: true },
      meta: {},
    })
    expect(await auditEvents.latest('system.local_signin')).toMatchObject({ detail: { ok: true } })
  })

  it('refuses a wrong token and the EA token, and audits the attempt', async () => {
    const wrong = await signIn('not-the-token-of-this-seti-at-all-0000')
    expect(wrong.status).toBe(401)
    expect(wrong.headers.get('set-cookie')).toBeNull()
    expect(await auditEvents.latest('system.local_signin')).toMatchObject({ detail: { ok: false } })
    expect((await signIn(eaToken)).status).toBe(401)
  })

  it('refuses a forged cookie', async () => {
    const cookie = `seti_local=${Buffer.alloc(32, 7).toString('base64url')}`
    expect((await app.request('/api/system', { headers: { ...HOST, cookie } })).status).toBe(401)
  })

  it('signs out by clearing the cookie', async () => {
    const res = await app.request('/api/local-session', { method: 'DELETE', headers: HOST })
    expect(res.headers.get('set-cookie')).toMatch(/seti_local=;/)
  })
})
