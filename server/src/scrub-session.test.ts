import { describe, expect, it } from 'vitest'
import { goldenCorpus } from './golden/corpus.js'
import { credentialFindings, redactCredentials, scrubValue } from './scrub.js'

/** A day of an agent's work on sign-in code: auth words everywhere, no secret anywhere. */
const SIGN_IN_WORK = `$ git log --oneline -5
9fda298 feat(auth): keep the session cookie HttpOnly and SameSite=Lax
41c0b7a fix(auth): refresh the access token before it expires
d5e4f3a test(auth): cover the sign-out route
$ git checkout -b feat/session-refresh
Switched to a new branch 'feat/session-refresh'
$ cat src/auth/session.ts
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'

export async function getSession() {
  const store = await cookies()
  const client = createServerClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    cookies: { getAll: () => store.getAll(), setAll: (list) => list.forEach((c) => store.set(c.name, c.value, c.options)) },
  })
  const { data } = await client.auth.getSession()
  return data.session
}

export function sessionCookie(token: string) {
  return \`session=\${token}; Path=/; HttpOnly; Secure; SameSite=Lax\`
}
const headers = { Authorization: \`Bearer \${accessToken}\`, 'Content-Type': 'application/json' }
res.setHeader('Set-Cookie', serialize('sid', sid, { httpOnly: true, sameSite: 'lax' }))
const cookie = req.headers.cookie ?? ''
document.cookie = \`theme=\${theme}; path=/\`
await page.context().storageState({ path: 'playwright/.auth/user.json' })
test.use({ storageState: 'playwright/.auth/user.json' })
$ cat app/settings.py
SESSION_COOKIE_AGE = 1209600
SESSION_ENGINE = "django.contrib.sessions.backends.db"
session = requests.Session()
session.headers.update({"Authorization": f"Bearer {token}"})
resp = session.post(url, data={"grant_type": "refresh_token", "refresh_token": refresh_token})
client.refresh(access_token=access_token, refresh_token=self.refresh_token)
$ curl -s -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" https://api.example.test/v1/me
{"id":"u_123","email":"ada@example.test","role":"member","created_at":"2026-11-01T10:00:00Z"}
$ curl -I https://app.example.test/login
HTTP/2 200
content-type: text/html; charset=utf-8
cache-control: private, no-store
x-request-id: 7c1e2a90-5d4b-4f3e-a2c1-0b9d8e7f6a5b
vary: Cookie, Accept-Encoding
$ npm test
 PASS  src/auth/session.test.ts
  sessionCookie
    ok marks the cookie HttpOnly (3 ms)
    ok expires the session after two weeks (1 ms)
 Test Suites: 1 passed, 1 total
 Tests:       2 passed, 2 total
$ npx playwright test auth.spec.ts
Running 3 tests using 3 workers
  ok  1 [chromium] > auth.spec.ts:8:5 > signs in and keeps the session (2.1s)
  ok  2 [chromium] > auth.spec.ts:21:5 > signs out and clears the cookie (1.4s)
  3 passed (4.6s)
The refresh_token rotates on every refresh, so the old one stops working.
Read the Set-Cookie header and the session_id field; never log the access_token.
{"session_id":"3f2c9a1e-8b7d-4c6e-9f0a-1b2c3d4e5f60","type":"result","subtype":"success","duration_ms":4200}
<SessionProvider session={session} refetchInterval={300}>
- sid: string
+ sid: string | null
  token_type: 'bearer'
  expires_in: 3600
machine-readable output, with the default password policy from the docs
`

const LINES = SIGN_IN_WORK.split('\n')

function strings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value]
  }
  if (Array.isArray(value)) {
    return value.flatMap(strings)
  }
  return typeof value === 'object' && value !== null ? Object.values(value).flatMap(strings) : []
}

describe('session redaction on ordinary transcripts', () => {
  it('changes no line of sign-in work that holds no secret', () => {
    const changed = LINES.filter((line) => redactCredentials(line) !== line)
    expect(changed).toEqual([])
    expect(redactCredentials(SIGN_IN_WORK)).toBe(SIGN_IN_WORK)
    expect(credentialFindings(SIGN_IN_WORK)).toEqual([])
    expect(LINES.length).toBeGreaterThan(60)
  })

  it('changes no row of the golden transcripts', () => {
    const rows = goldenCorpus().flatMap((transcript) => transcript.rows)
    const changed = rows.filter((row) => scrubValue(row.payload) !== row.payload)
    expect(changed.map((row) => row.id)).toEqual([])
    expect(rows.flatMap((row) => strings(row.payload)).length).toBeGreaterThan(1000)
  })
})

describe('session redaction cost', () => {
  it.each([
    ['cookie pairs', 'a=b; '],
    ['session names', 'sid='],
    ['cookie labels', 'cookie: '],
    ['base64 starts', 'eyJ'],
    ['storage pairs', `name: 'x', value: `],
    ['header flags', `-H 'X-Token: `],
    ['netrc words', 'machine a.b login c '],
  ])('stays linear on a megabyte of %s', (_name, unit) => {
    const text = unit.repeat(Math.ceil((1024 * 1024) / unit.length))
    const start = process.cpuUsage()
    redactCredentials(text)
    credentialFindings(text)
    const { user, system } = process.cpuUsage(start)
    expect((user + system) / 1000).toBeLessThan(5000)
  })
})
