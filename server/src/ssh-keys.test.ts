import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { findBinary } from './binaries.js'
import { generateEd25519, inspectPrivateKey, publicKeyInfo } from './ssh-keys.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-ssh-keys-'))

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const available = (() => {
  try {
    findBinary('ssh-keygen')
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!available)('ssh keys', () => {
  it('generates an ed25519 key that OpenSSH reads, with the fingerprint it reports', async () => {
    const pair = generateEd25519('seti test')
    expect(pair.privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n/)
    expect(pair.publicKey).toMatch(/^ssh-ed25519 \S+ seti test$/)
    const inspected = await inspectPrivateKey(pair.privateKey, 'seti test')
    expect(inspected.fingerprint).toBe(pair.fingerprint)
    expect(inspected.publicKey).toBe(pair.publicKey)
    expect(await publicKeyInfo(pair.publicKey)).toEqual({ type: 'ed25519', fingerprint: pair.fingerprint })
  })

  it('refuses an encrypted key without quoting it', async () => {
    const file = path.join(dir, 'encrypted')
    execFileSync(findBinary('ssh-keygen'), ['-q', '-t', 'ed25519', '-N', 'a passphrase', '-f', file])
    const text = fs.readFileSync(file, 'utf8')
    const error = await inspectPrivateKey(text, 'x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain('not an unencrypted OpenSSH or PEM private key')
    expect(String(error)).not.toContain(text.split('\n')[1] ?? 'unreachable')
  })

  it('reads an imported OpenSSH key and derives its public key', async () => {
    const file = path.join(dir, 'plain')
    execFileSync(findBinary('ssh-keygen'), ['-q', '-t', 'ed25519', '-N', '', '-C', 'old', '-f', file])
    const inspected = await inspectPrivateKey(fs.readFileSync(file, 'utf8'), 'imported')
    const [type, base64] = fs.readFileSync(`${file}.pub`, 'utf8').split(' ')
    expect(inspected.publicKey).toBe(`${type ?? ''} ${base64 ?? ''} imported`)
  })
})
