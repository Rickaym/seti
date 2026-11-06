import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { credential, missingCredential } from './credentials.js'
import { parseKey } from './secret-box.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-credentials-'))

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('credentials', () => {
  it('creates missing keys and tokens for a development run, once, owner-only', () => {
    const source = { dir: path.join(root, 'dev'), dev: true }
    const key = credential('secret-key', source)
    expect(key).not.toBeNull()
    expect(parseKey(key ?? '')).toHaveLength(32)
    expect(credential('secret-key', source)).toBe(key)
    expect(fs.statSync(path.join(source.dir, 'secret-key')).mode & 0o777).toBe(0o600)
    expect(credential('local-token-user', source)?.length).toBeGreaterThanOrEqual(32)
    expect(credential('openai-api-key', source)).toBeNull()
  })

  it('never creates credentials that systemd should have passed', () => {
    const dir = path.join(root, 'systemd')
    fs.mkdirSync(dir)
    const source = { dir, dev: false }
    expect(credential('secret-key', source)).toBeNull()
    expect(fs.existsSync(path.join(dir, 'secret-key'))).toBe(false)
    fs.writeFileSync(path.join(dir, 'openai-api-key'), '\n')
    expect(credential('openai-api-key', source)).toBeNull()
    fs.writeFileSync(path.join(dir, 'local-token-ea'), 'value-from-systemd\n')
    expect(credential('local-token-ea', source)).toBe('value-from-systemd')
    expect(missingCredential('secret-key', source)).toMatch(/scripts\/install\.sh/)
  })
})
