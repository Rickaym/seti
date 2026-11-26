import { describe, expect, it } from 'vitest'
import {
  credentialFindings,
  MAX_LONG_DETAIL_TEXT,
  MAX_SUMMARY,
  redactCredentials,
  redactSecrets,
  scrubDetail,
  scrubInput,
  scrubSummary,
  scrubValue,
} from './scrub.js'

describe('redactSecrets', () => {
  it.each([
    ['curl -H "Authorization: Bearer abc.def.ghi" https://api.example.com', 'Authorization: [redacted]'],
    ['curl -H "authorization: token ghp_abc" x', 'authorization: [redacted]'],
    ['http x.test "Bearer abcdef123456"', 'Bearer [redacted]'],
    ['stripe --api sk_live_1234567890abcdef', 'stripe --api [redacted]'],
    ['git push https://ada:hunter2@github.com/acme/app.git', 'https://[redacted]@github.com/acme/app.git'],
    ['echo ghp_1234567890abcdefABCDEF', 'echo [redacted]'],
    ['GH=github_pat_11ABCDEFG0123456789_abcdef', '[redacted]'],
    ['export KEY=sk-ant-api03-abcdefghijklmnop', '[redacted]'],
    ['slack xoxb-1234-5678-abcdefgh', 'slack [redacted]'],
    ['aws AKIAABCDEFGHIJKLMNOP s3 ls', 'aws [redacted] s3 ls'],
    ['webhook secret whsec_abcdefghijkl', 'webhook secret [redacted]'],
    ['jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4', 'jwt [redacted]'],
    ['deploy --token abc123 --env prod', '--token [redacted] --env prod'],
    ['mysql --password=s3cret -u root', '--password=[redacted] -u root'],
    ['curl "https://x.test/?api_key=abcd&q=1"', 'api_key=[redacted]&q=1'],
    ['GITHUB_TOKEN=abc123 gh pr create', 'GITHUB_TOKEN=[redacted] gh pr create'],
    ['{"password": "pw", "user": "me"}', '"password": [redacted], "user": "me"'],
    ['curl -H "X-Api-Key: abc123" x', 'X-Api-Key: [redacted]'],
  ])('redacts %s', (input, expected) => {
    const out = redactSecrets(input)
    expect(out).toContain(expected)
    expect(out).not.toMatch(/hunter2|ghp_1234|sk-ant|sk_live|xoxb-1234|AKIAABCD|whsec_|s3cret|abc123|abcd&|abcdef123/)
  })

  it.each(['git push origin feat/audit-log', 'gh pr create --fill --base dev', 'kubectl apply -f deploy.yaml'])(
    'leaves ordinary commands alone: %s',
    (command) => {
      expect(redactSecrets(command)).toBe(command)
    },
  )
})

describe('scrubSummary', () => {
  it('folds whitespace into one line', () => {
    expect(scrubSummary('  git push \n  origin\tmain  ')).toBe('git push origin main')
  })

  it('truncates long text with an ASCII ellipsis', () => {
    const out = scrubSummary('x'.repeat(1000))
    expect(out).toHaveLength(MAX_SUMMARY)
    expect(out.endsWith('...')).toBe(true)
  })

  it('redacts before truncating so a cut never leaks a token prefix', () => {
    const out = scrubSummary(`${'a '.repeat(140)}ghp_abcdefghijklmnopqrstuvwxyz0123456789`)
    expect(out).not.toContain('ghp_')
  })
})

describe('scrubDetail', () => {
  it('scrubs strings and string lists and keeps other values', () => {
    const detail = scrubDetail({
      command: 'curl -H "Authorization: Bearer abc"',
      names: ['ok', 'token=abc'],
      count: 3,
      flag: true,
      none: null,
    })
    expect(detail).toEqual({
      command: 'curl -H "Authorization: [redacted]"',
      names: ['ok', 'token=[redacted]'],
      count: 3,
      flag: true,
      none: null,
    })
  })
})

describe('scrubDetail long fields', () => {
  it('keeps named fields multi-line and longer, still redacted', () => {
    const text = `line one\n${'x'.repeat(1000)}\nkey ghp_abcdefghijklmnop1234`
    const detail = scrubDetail({ text, other: text }, ['text'])
    expect(detail.text).toBe(`line one\n${'x'.repeat(1000)}\nkey [redacted]`)
    expect(String(detail.other)).toHaveLength(500)
    expect(String(detail.other)).not.toContain('\n')
  })

  it('cuts named fields at the long limit', () => {
    expect(String(scrubDetail({ text: 'y'.repeat(9000) }, ['text']).text)).toHaveLength(MAX_LONG_DETAIL_TEXT)
  })
})

describe('scrubInput', () => {
  it('blanks secret-named strings and redacts secret-looking text at any depth', () => {
    expect(
      scrubInput({
        channel: 'C1',
        client_secret: 'abc',
        headers: [{ Authorization: 'Basic abc' }],
        retries: 3,
        nested: { note: 'use sk-ant-api03-abcdefghijklmnop' },
      }),
    ).toEqual({
      channel: 'C1',
      client_secret: '[redacted]',
      headers: [{ Authorization: '[redacted]' }],
      retries: 3,
      nested: { note: 'use [redacted]' },
    })
  })
})

describe('credentialFindings', () => {
  const token = `ghp_${'a1B2c3D4'.repeat(5)}`
  const key = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXk=', '-----END OPENSSH PRIVATE KEY-----']

  it('names the line and kind of each credential, never its value', () => {
    const text = [
      'plain prose about tokens and keys',
      `export GITHUB_TOKEN=${token}`,
      ...key,
      'AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"',
      'curl https://deploy:hunter2hunter2@example.com/',
      'API_KEY=$API_KEY',
    ].join('\n')
    const findings = credentialFindings(text)
    expect(findings).toEqual([
      { line: 2, kind: 'access token' },
      { line: 2, kind: 'secret in an env line' },
      { line: 3, kind: 'private key' },
      { line: 6, kind: 'secret in an env line' },
      { line: 7, kind: 'password in a URL' },
    ])
    expect(JSON.stringify(findings)).not.toContain(token)
  })

  it('agrees with redactCredentials on whether text holds a credential', () => {
    for (const text of ['nothing here', `token ${token}`, key.join('\n'), 'PASSWORD=correcthorse', 'name = value']) {
      expect(credentialFindings(text).length > 0, text).toBe(redactCredentials(text) !== text)
    }
  })

  it('flags a private key cut short', () => {
    expect(credentialFindings('x\n-----BEGIN RSA PRIVATE KEY-----\nMIIE')).toEqual([{ line: 2, kind: 'private key' }])
  })
})

describe('session material', () => {
  const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const jwt = [
    b64url({ alg: 'HS256', typ: 'JWT' }),
    b64url({ sub: 'test-user', role: 'authenticated' }),
    'c2lnbmF0dXJlLWZvci10ZXN0',
  ].join('.')
  const refresh = 'rTkn12345678'
  const session = JSON.stringify({
    access_token: jwt,
    token_type: 'bearer',
    refresh_token: refresh,
    user: { id: 'u1' },
  })
  const blob = `base64-${Buffer.from(session).toString('base64')}`
  const ref = 'abcdefghijklmnopqrst'
  const sb = `sb-${ref}-auth-token`
  const storage = JSON.stringify(
    {
      cookies: [
        { name: sb, value: blob, domain: 'localhost', path: '/', httpOnly: false },
        { name: 'theme', value: 'dark', domain: 'localhost', path: '/' },
      ],
      origins: [
        {
          origin: 'http://localhost:3000',
          localStorage: [
            { name: sb, value: session },
            { name: 'ui', value: 'compact' },
          ],
        },
      ],
    },
    null,
    2,
  )
  const leaks = [
    jwt.split('.')[1] ?? '',
    refresh,
    blob.slice(7, 40),
    blob.slice(60, 90),
    's%3Aabc123',
    'a1b2c3d4e5',
    'dXNlcjpw',
  ]

  it.each([
    ['a raw cookie header', `Cookie: ${sb}=${blob}; theme=dark`, `Cookie: ${sb}=[redacted]; theme=[redacted]`],
    [
      'a chunked cookie',
      `cookie: ${sb}.0=${blob.slice(0, 60)}; ${sb}.1=${blob.slice(60)}`,
      `${sb}.0=[redacted]; ${sb}.1=[redacted]`,
    ],
    [
      'a set-cookie header',
      'Set-Cookie: sid=s%3Aabc123.sig; Path=/; HttpOnly; SameSite=Lax',
      'sid=[redacted]; Path=/; HttpOnly; SameSite=Lax',
    ],
    [
      'headers as JSON',
      `{"cookie": "${sb}=${blob}", "accept": "*/*"}`,
      `{"cookie": "${sb}=[redacted]", "accept": "*/*"}`,
    ],
    ['headers as a dict', `{'Cookie': 'connect.sid=s%3Aabc123.x'}`, `{'Cookie': 'connect.sid=[redacted]'}`],
    ['basic authorization', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'Authorization: Basic [redacted]'],
    ['token authorization in JSON', '"authorization": "Token a1b2c3d4e5f6g7h8"', '"authorization": "Token [redacted]"'],
    [
      'negotiate proxy authorization',
      'Proxy-Authorization: Negotiate a1b2c3d4e5YIIGhg==',
      'Proxy-Authorization: Negotiate [redacted]',
    ],
    ['a schemeless authorization', 'authorization: a1b2c3d4e5f6g7h8i9', 'authorization: [redacted]'],
    ['a JWT after an encoded quote', `%22${jwt}%22`, '%22[redacted]%22'],
    ['a base64 session', `value: ${blob}`, 'value: base64-[redacted]'],
    ['a Supabase key in local storage', `{"${sb}": ${JSON.stringify(session)}}`, `{"${sb}": "[redacted]"}`],
    [
      'an escaped token in a JSON string',
      `{\\"refresh_token\\":\\"${refresh}\\"}`,
      '{\\"refresh_token\\":\\"[redacted]\\"}',
    ],
    [
      'a NextAuth cookie',
      `__Secure-next-auth.session-token=${refresh}; Path=/`,
      '__Secure-next-auth.session-token=[redacted]',
    ],
    ['a host cookie', `__Host-session=${refresh}`, '__Host-session=[redacted]'],
    ['a PHP session', 'PHPSESSID=9a8b7c6d5e4f3a2b1c0d', 'PHPSESSID=[redacted]'],
    ['a Django session', 'sessionid=a1b2c3d4e5f6g7h8', 'sessionid=[redacted]'],
    ['a Rails session', `_shop_session=${refresh}`, '_shop_session=[redacted]'],
    [
      'a redirect fragment',
      `/cb#access_token=${jwt}&refresh_token=${refresh}&expires_in=3600`,
      '&refresh_token=[redacted]&expires_in=3600',
    ],
    [
      'a form body',
      `grant_type=refresh_token&refresh_token=${refresh}`,
      'grant_type=refresh_token&refresh_token=[redacted]',
    ],
    ['an id token in JSON', `{"id_token": "${refresh}abc"}`, '{"id_token": "[redacted]"}'],
    ['storage state', storage, `"value": "[redacted]"`],
    ['inspected cookies', `{\n  name: '${sb}',\n  value: '${blob}',\n  domain: 'localhost'\n}`, `value: '[redacted]'`],
    ['a netrc line', `machine api.example.test login ada password ${refresh}`, 'login ada password [redacted]'],
    ['a netrc block', `machine api.example.test\n  login ada\n  password ${refresh}`, '  password [redacted]'],
    [
      'curl -b',
      `curl -b 'sid=${refresh}; theme=dark' https://x.test`,
      `curl -b 'sid=[redacted]; theme=[redacted]' https://x.test`,
    ],
    ['curl --cookie', `curl --cookie ${sb}=${refresh} https://x.test`, `--cookie ${sb}=[redacted] https://x.test`],
    ['curl -H with a session header', `curl -H 'X-Session-Token: ${refresh}' x`, `-H 'X-Session-Token: [redacted]' x`],
    [
      'document.cookie output',
      `> document.cookie\n'_ga=GA1.1.123.456; ${sb}=${blob}'`,
      `'_ga=[redacted]; ${sb}=[redacted]'`,
    ],
  ])('redacts %s', (_name, input, expected) => {
    expect(redactCredentials(input)).toContain(expected)
    for (const out of [redactCredentials(input), redactSecrets(input)]) {
      for (const leak of leaks) {
        expect(out).not.toContain(leak)
      }
    }
    expect(credentialFindings(input).length).toBeGreaterThan(0)
  })

  it('keeps the storage state readable and hides only its sessions', () => {
    const out = JSON.parse(redactCredentials(storage)) as typeof storage
    expect(JSON.stringify(out)).toContain('"value":"dark"')
    expect(JSON.stringify(out)).toContain('"value":"compact"')
    expect(JSON.stringify(out)).not.toContain(refresh)
  })

  it('redacts by key in parsed JSON, storage pairs included', () => {
    const value = {
      headers: { Cookie: `${sb}=${blob}`, Authorization: 'Basic dXNlcjpwYXNzd29yZA==', Accept: '*/*' },
      [sb]: session,
      session_id: '3f2c9a1e-8b7d-4c6e-9f0a-1b2c3d4e5f60',
      cookies: [
        { name: sb, value: refresh },
        { name: 'theme', value: 'dark' },
      ],
    }
    expect(scrubValue(value)).toEqual({
      headers: { Cookie: `${sb}=[redacted]`, Authorization: 'Basic [redacted]', Accept: '*/*' },
      [sb]: '[redacted]',
      session_id: '3f2c9a1e-8b7d-4c6e-9f0a-1b2c3d4e5f60',
      cookies: [
        { name: sb, value: '[redacted]' },
        { name: 'theme', value: 'dark' },
      ],
    })
  })

  it.each([
    'git checkout -b feature/cookies',
    'const cookie = req.headers.cookie',
    "res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly`)",
    'session = requests.Session()',
    'headers: { Authorization: `Bearer ${token}` }',
    'Authorization: Bearer <token>',
    '"session_id": "3f2c9a1e-8b7d-4c6e-9f0a-1b2c3d4e5f60"',
    'client.refresh(access_token=access_token, refresh_token=self.refresh_token)',
    'The access_token field holds the token; read the Set-Cookie header.',
    '<SessionProvider session={session}>',
    'sid=abc',
    'Cookie: ${cookieHeader}',
    "{ name: 'commit', value: '9fda298e1c0b7a6d5e4f3a2b1c0d9e8f7a6b5c4d' }",
    'machine learning password manager',
    'curl -H "Content-Type: application/json" -b cookies.txt https://x.test',
    'Bearer authentication tokens expire after an hour.',
  ])('leaves %s alone', (input) => {
    expect(redactCredentials(input)).toBe(input)
    expect(credentialFindings(input)).toEqual([])
  })

  it('is idempotent', () => {
    const once = redactCredentials(storage)
    expect(redactCredentials(once)).toBe(once)
  })
})
