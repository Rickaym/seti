import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { atLeast, credentialChecks, loopbackFor, optionalKeys, portBusy, redact, report } from './doctor.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-doctor-'))

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function credentialsDir(name: string, files: Record<string, string>, mode = 0o600): string {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { mode: 0o700 })
  for (const [file, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, file), value, { mode })
  }
  return dir
}

const TOKEN = 'a'.repeat(43)

describe('report', () => {
  it('groups findings by section, indents fixes and counts problems', () => {
    const text = report([
      { section: 'Runtime', state: 'ok', label: 'node 24' },
      { section: 'Runtime', state: 'fail', label: 'pnpm not found', fix: 'corepack enable pnpm' },
      { section: 'Cache', state: 'warn', label: 'Redis away', fix: 'one\ntwo' },
    ])
    expect(text).toBe(
      [
        'Runtime',
        '  ok    node 24',
        '  FAIL  pnpm not found',
        '        fix: corepack enable pnpm',
        '',
        'Cache',
        '  warn  Redis away',
        '        fix: one',
        '             two',
        '',
        '1 problem, 1 warning.',
        '',
      ].join('\n'),
    )
    expect(report([{ section: 'Runtime', state: 'info', label: 'x' }])).toMatch(/Everything Seti needs/)
  })
})

describe('atLeast', () => {
  it('compares dotted versions with prefixes', () => {
    expect(atLeast('v24.1.0', '24.0.0')).toBe(true)
    expect(atLeast('22.11.0', '24.0.0')).toBe(false)
    expect(atLeast('10.32.1', '10.32.1')).toBe(true)
    expect(atLeast('10.9.0', '10.32.1')).toBe(false)
    expect(atLeast('11', '10.32.1')).toBe(true)
  })
})

describe('credentialChecks', () => {
  it('passes owner-only credentials that hold values', () => {
    const dir = credentialsDir('good', { 'secret-key': 'k', 'local-token-user': TOKEN, 'local-token-ea': TOKEN })
    expect(credentialChecks(dir, false).map((check) => check.state)).toEqual(['ok', 'ok', 'ok'])
  })

  it('fails missing, empty and short credentials and warns on open modes, never showing values', () => {
    const dir = credentialsDir('bad', { 'secret-key': '\n', 'local-token-user': 'short-secret-value' }, 0o644)
    const checks = credentialChecks(dir, false)
    expect(checks.map((check) => [check.label, check.state])).toEqual([
      ['secret-key is empty or too short', 'fail'],
      ['local-token-user is empty or too short', 'fail'],
      ['local-token-ea is missing', 'fail'],
    ])
    expect(JSON.stringify(checks)).not.toContain('short-secret-value')
    fs.writeFileSync(path.join(dir, 'local-token-ea'), TOKEN, { mode: 0o644 })
    const last = credentialChecks(dir, false).at(-1)
    expect(last?.state).toBe('warn')
    expect(last?.fix).toMatch(/chmod 600/)
  })

  it('names the fix when the directory is missing and trusts a development run to make its own', () => {
    expect(credentialChecks(path.join(root, 'none'), false)).toMatchObject([{ state: 'fail' }])
    expect(credentialChecks(path.join(root, 'none'), true)).toMatchObject([{ state: 'info' }])
  })

  it('tells set optional keys from empty ones', () => {
    const dir = credentialsDir('optional', { 'openai-api-key': 'sk-x\n', 'deepgram-api-key': '\n' })
    expect(optionalKeys(dir, ['openai-api-key', 'deepgram-api-key', 'elevenlabs-api-key'])).toEqual({
      set: ['openai-api-key'],
      unset: ['deepgram-api-key', 'elevenlabs-api-key'],
    })
  })
})

describe('network helpers', () => {
  it('turns listen addresses into loopback URL hosts and hides passwords', () => {
    expect(loopbackFor('0.0.0.0')).toBe('127.0.0.1')
    expect(loopbackFor('::')).toBe('[::1]')
    expect(loopbackFor('::1')).toBe('[::1]')
    expect(loopbackFor('127.0.0.1')).toBe('127.0.0.1')
    expect(redact('postgres://seti:hunter2@db.example.com/seti')).toBe('postgres://seti:***@db.example.com/seti')
    expect(redact('postgresql:///seti?host=/var/run/postgresql')).toBe('postgresql:///seti?host=/var/run/postgresql')
  })

  it('finds a port another program holds', async () => {
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    expect(await portBusy('127.0.0.1', port)).toBe(true)
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
    expect(await portBusy('127.0.0.1', port)).toBe(false)
  })
})
