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
