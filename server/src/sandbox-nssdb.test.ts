import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { binaryPath, findBinary } from './binaries.js'
import { loadSandboxCa } from './sandbox-ca.js'
import { browserDbOf } from './sandbox-nssdb.js'

const certutil = binaryPath('certutil')
const roots: string[] = []

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-nssdb-'))
  roots.push(root)
  return path.join(root, 'sandbox-ca')
}

const listed = (program: string, db: string, flag: '-L' | '-K') => {
  try {
    return execFileSync(program, [flag, '-d', `sql:${db}`], { encoding: 'utf8', stdio: 'pipe' })
  } catch (e) {
    const error = e as { stdout?: string; stderr?: string }
    return `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
}

afterAll(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('the NSS database for browsers in a sandbox', () => {
  it.skipIf(certutil === null)('trusts each Seti CA for TLS servers only and holds no key', async () => {
    const program = certutil ?? 'certutil'
    const ca = await loadSandboxCa(tempRoot())
    expect(ca.browserDb).toBe(browserDbOf(ca.publicDir))
    const db = browserDbOf(ca.publicDir)
    expect(listed(program, db, '-L')).toMatch(/Seti sandbox egress CA 1\s+C,,\s*$/m)
    expect(listed(program, db, '-K')).toContain('no keys found')
    for (const name of fs.readdirSync(db)) {
      expect(fs.statSync(path.join(db, name)).mode & 0o022).toBe(0)
    }
    expect(fs.readdirSync(ca.publicDir).toSorted((a, b) => a.localeCompare(b, 'en'))).toEqual([
      'bundle.pem',
      'ca.pem',
      'nssdb',
    ])

    expect(await ca.cover(['app.example.test'])).toBe(true)
    expect(listed(program, db, '-L')).toMatch(/Seti sandbox egress CA 2\s+C,,\s*$/m)
    expect(fs.readdirSync(ca.publicDir).toSorted((a, b) => a.localeCompare(b, 'en'))).toEqual([
      'bundle.pem',
      'ca.pem',
      'nssdb',
    ])
  })

  it('writes none and mounts none when the host has no certutil', async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-nssdb-bin-'))
    roots.push(bin)
    fs.symlinkSync(findBinary('openssl'), path.join(bin, 'openssl'))
    vi.stubEnv('PATH', bin)
    try {
      const ca = await loadSandboxCa(tempRoot())
      expect(ca.browserDb).toBeNull()
      expect(fs.existsSync(browserDbOf(ca.publicDir))).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
