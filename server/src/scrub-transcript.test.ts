import type { MessageRow } from '@seti/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { messages, sql, tasks } from './db.js'
import { buildDigest } from './digest.js'
import { redactCredentials, redactSecrets, scrubValue } from './scrub.js'
import { wireRow } from './transcript.js'

/** Fake credentials are assembled at run time, so secret scanners do not flag this file. */
const fake = (...parts: string[]) => parts.join('')

const GH_TOKEN = fake('ghs_', 'a1B2c3D4e5'.repeat(4))
const ELEVEN_KEY = fake('sk_', '0123456789abcdef'.repeat(3))
const JWT = ['eyJhbGciOiJSUzI1NiJ9', 'eyJlbWFpbCI6Im1lQGV4YW1wbGUuY29tIn0', 'c2lnbmF0dXJlLWJ5dGVz'].join('.')
const DB_PASSWORD = fake('Sup3r', 'S3cretPw')
const AWS_KEY = fake('AKIA', 'IOSFODNN7', 'EXAMPLE')
const GOOGLE_KEY = fake('AIza', 'SyD-abcdefghijklmnopqrstuvwxyz12345')
const NPM_TOKEN = fake('npm', '_abcdefghijklmnopqrstuvwxyz0123456789')
const KEY_KIND = fake('OPENSSH PRIVATE', ' KEY')

const ENV_FILE = [
  `DATABASE_URL=postgres://app:${DB_PASSWORD}@db.internal:5432/app`,
  fake('OPENAI_API_KEY=sk-', 'proj-AbCdEf1234567890XyZ'),
  fake('DEEPGRAM_API_KEY=', '3f9a1c0d'.repeat(5)),
  "SESSION_SECRET='a long session secret value'",
  `export ELEVENLABS_API_KEY=${ELEVEN_KEY}`,
  'LOG_LEVEL=debug',
  'NODE_ENV=production',
].join('\n')

const PEM = [
  `-----BEGIN ${KEY_KIND}-----`,
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  'QyNTUxOQAAACBZ2ZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZgAAAJgAAAAAAAAAAA==',
  `-----END ${KEY_KIND}-----`,
].join('\n')

describe('redactCredentials', () => {
  it('redacts the secrets in env file output and keeps the other lines', () => {
    const out = redactCredentials(ENV_FILE)
    expect(out.split('\n')).toEqual([
      'DATABASE_URL=postgres://app:[redacted]@db.internal:5432/app',
      'OPENAI_API_KEY=[redacted]',
      'DEEPGRAM_API_KEY=[redacted]',
      'SESSION_SECRET=[redacted]',
      'export ELEVENLABS_API_KEY=[redacted]',
      'LOG_LEVEL=debug',
      'NODE_ENV=production',
    ])
  })

  it.each([
    ['a private key block', PEM, ['b3BlbnNzaC1rZXkt', 'QyNTUxOQ']],
    ['a token in a remote URL', `origin https://x-access-token:${GH_TOKEN}@github.com/o/r.git (fetch)`, [GH_TOKEN]],
    ['a bearer header', `curl -H "Authorization: Bearer ${JWT}" https://api.example.com`, [JWT]],
    ['an AWS access key', `aws_access_key_id = ${AWS_KEY}`, [AWS_KEY]],
    ['a Google API key', `key: ${GOOGLE_KEY}`, [GOOGLE_KEY]],
    ['an npm token', `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`, [NPM_TOKEN]],
  ])('redacts %s', (_name, input, leaks) => {
    const out = redactCredentials(input)
    expect(out).toContain('[redacted]')
    for (const leak of leaks) {
      expect(out).not.toContain(leak)
    }
  })

  it('keeps the frame of a private key so the transcript still reads', () => {
    expect(redactCredentials(PEM)).toBe(`-----BEGIN ${KEY_KIND}-----\n[redacted]\n-----END ${KEY_KIND}-----`)
  })

  it.each([
    [
      'TypeScript',
      [
        'const token = await getToken(req)',
        'const apiKey = process.env.OPENAI_API_KEY',
        'headers.authorization = `Bearer ${token}`',
        "const secret: string = config.get('secret')",
      ].join('\n'),
    ],
    ['Python', 'API_KEY = os.environ["API_KEY"]\npassword = getpass.getpass()'],
    ['a diff', '-  secret: string\n+  secretRef: string | null\n   token_count: number'],
    [
      'env placeholders',
      'DEEPGRAM_API_KEY=<key>\nTUNNEL_TOKEN=${TOKEN}\nSSH_KEY_PATH=/home/user/.ssh/id_ed25519\nPRIMARY_KEY=id',
    ],
    ['prose', 'Use a bearer token for the Access service; the task-skill loader keeps risk-assessment notes.'],
    ['git remotes', 'ssh://git@github.com/org/repo.git\ngit@github.com:org/repo.git'],
    ['a templated URL', 'postgres://app:${DB_PASSWORD}@db/app'],
    ['ids', 'toolu_01ABCDEFGHJKMNPQRSTVWXYZ 3f2c9a1e-8b7d-4c6e-9f0a-1b2c3d4e5f60 git-sha 9fda298e1c'],
    ['a short bearer mention', 'Authorization: Bearer <token>'],
  ])('leaves %s alone', (_name, input) => {
    expect(redactCredentials(input)).toBe(input)
  })
})

describe('redaction cost', () => {
  it.each([
    ['dotted', 'a.'],
    ['dashed', 'ab-cd-'],
    ['colons', 'a:'],
    ['words', 'x'],
  ])('stays linear on a megabyte of %s text', (_name, unit) => {
    const text = unit.repeat(Math.ceil((1024 * 1024) / unit.length))
    const start = process.cpuUsage()
    redactCredentials(text)
    redactSecrets(text)
    const { user, system } = process.cpuUsage(start)
    expect((user + system) / 1000).toBeLessThan(5000)
  })
})

describe('scrubValue', () => {
  const image = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: fake('AKIA', 'Z'.repeat(16), '/x') },
  }

  it('redacts every string of a message and leaves image data and unchanged parts as they are', () => {
    const clean = { type: 'text', text: 'all good' }
    const payload = {
      type: 'user',
      message: {
        content: [
          clean,
          { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: ENV_FILE }, image] },
        ],
      },
    }
    const out = scrubValue(payload)
    expect(JSON.stringify(out)).not.toContain(DB_PASSWORD)
    expect(out.message.content[0]).toBe(clean)
    expect(JSON.stringify(out)).toContain(image.source.data)
    expect(scrubValue(clean)).toBe(clean)
  })
})

const row = (id: number, kind: MessageRow['kind'], payload: unknown): MessageRow =>
  ({ id, task_id: 'scrub-task', kind, payload, outward: [], created_at: '2026-09-27T00:00:00.000Z' }) as MessageRow

const sdkRow = (id: number, text: string) =>
  row(id, 'sdk', { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } })

describe('stored transcripts', () => {
  beforeAll(async () => {
    await tasks.insert({ id: 'scrub-task', title: 'Scrub', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  })

  it('stores and publishes messages with credentials redacted', async () => {
    const inserted = await messages.insert(
      'scrub-task',
      { kind: 'prompt', payload: { text: `use ${GH_TOKEN} to push` } },
      [],
    )
    expect(inserted.payload).toEqual({ text: 'use [redacted] to push' })
    const [stored] = await sql<{ payload: string }[]>`SELECT payload FROM task_message WHERE id = ${inserted.id}`
    expect(stored?.payload).toBe(JSON.stringify({ text: 'use [redacted] to push' }))
  })

  it('redacts rows stored before scrubbing when they go to the browser', () => {
    const legacy = sdkRow(1, `token ${GH_TOKEN}`)
    expect(JSON.stringify(wireRow(legacy))).not.toContain(GH_TOKEN)
  })

  it('redacts digest lines, commands included', () => {
    const shell = row(2, 'shell', {
      run_id: 'run-1',
      command: 'deploy --token abc123def',
      cwd: '/tmp',
      started_at: '2026-09-27T00:00:00.000Z',
      exit_code: 0,
      signal: null,
      ended_by: null,
      duration_ms: 5,
      stdout: `pushed with ${GH_TOKEN}`,
      stderr: '',
    })
    const lines = buildDigest([sdkRow(1, fake('Set OPENAI_API_KEY=sk-', 'proj-AbCdEf1234567890XyZ for you')), shell])
    const text = lines.map((line) => line.text).join('\n')
    expect(text).not.toMatch(/sk-proj|abc123def|ghs_/)
    expect(text).toContain('--token [redacted]')
  })
})
