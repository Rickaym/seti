import { describe, expect, it } from 'vitest'
import {
  credentialSource,
  readAndroidOverride,
  readBackupConfig,
  readCount,
  readEaUrl,
  readPublicAccess,
} from './config.js'

const AUD = 'f'.repeat(64)
const complete = {
  SETI_PUBLIC_URL: 'https://Seti.Example.com/',
  SETI_ACCESS_TEAM: 'myteam.cloudflareaccess.com',
  SETI_ACCESS_AUD: AUD,
}

describe('readPublicAccess', () => {
  it('keeps public access off without a public URL', () => {
    expect(readPublicAccess({})).toBeNull()
    expect(readPublicAccess({ SETI_PUBLIC_URL: '', SETI_ACCESS_TEAM: 'x.cloudflareaccess.com' })).toBeNull()
  })

  it('reads a complete configuration', () => {
    expect(readPublicAccess(complete)).toEqual({
      hostname: 'seti.example.com',
      origin: 'https://seti.example.com',
      cloudflare: { team: 'myteam.cloudflareaccess.com', aud: AUD, allowed: null },
    })
    expect(
      readPublicAccess({ ...complete, SETI_ACCESS_TEAM: 'https://myteam.cloudflareaccess.com/' })?.cloudflare?.team,
    ).toBe('myteam.cloudflareaccess.com')
  })

  it('reads an allowlist of Access identities', () => {
    const allowed = readPublicAccess({
      ...complete,
      SETI_ACCESS_EMAILS: ' Me@Example.com, ops.access\nyou@example.org ',
    })
    expect(allowed?.cloudflare?.allowed).toEqual(new Set(['me@example.com', 'ops.access', 'you@example.org']))
    expect(readPublicAccess({ ...complete, SETI_ACCESS_EMAILS: ' , ' })?.cloudflare?.allowed).toBeNull()
    expect(() => readPublicAccess({ ...complete, SETI_ACCESS_EMAILS: 'me@example.com, a@b@c' })).toThrow(
      /SETI_ACCESS_EMAILS/,
    )
  })

  it('refuses half an Access configuration', () => {
    const noTeam = { ...complete, SETI_ACCESS_TEAM: undefined }
    const noAud = { ...complete, SETI_ACCESS_AUD: ' ' }
    expect(() => readPublicAccess(noTeam)).toThrow(/SETI_ACCESS_TEAM and SETI_ACCESS_AUD/)
    expect(() => readPublicAccess(noAud)).toThrow(/SETI_ACCESS_TEAM and SETI_ACCESS_AUD/)
  })

  it('serves a public URL without Access, behind Seti sign-in alone', () => {
    expect(readPublicAccess({ SETI_PUBLIC_URL: complete.SETI_PUBLIC_URL })).toEqual({
      hostname: 'seti.example.com',
      origin: 'https://seti.example.com',
      cloudflare: null,
    })
  })

  it('refuses malformed values', () => {
    const bad = (overrides: Record<string, string>) => () => readPublicAccess({ ...complete, ...overrides })
    expect(bad({ SETI_PUBLIC_URL: 'seti.example.com' })).toThrow(/not a URL/)
    expect(bad({ SETI_PUBLIC_URL: 'http://seti.example.com' })).toThrow(/bare https origin/)
    expect(bad({ SETI_PUBLIC_URL: 'https://seti.example.com/app' })).toThrow(/bare https origin/)
    expect(bad({ SETI_PUBLIC_URL: 'https://seti.example.com:8443' })).toThrow(/bare https origin/)
    expect(bad({ SETI_PUBLIC_URL: 'https://seti.localhost' })).toThrow(/loopback/)
    expect(bad({ SETI_PUBLIC_URL: 'https://localhost' })).toThrow(/loopback/)
    expect(bad({ SETI_ACCESS_TEAM: 'example.com' })).toThrow(/team domain/)
    expect(bad({ SETI_ACCESS_AUD: 'short' })).toThrow(/audience tag/)
  })
})

describe('readEaUrl', () => {
  it('keeps the origin of an http URL', () => {
    expect(readEaUrl('http://127.0.0.1:3007')).toBe('http://127.0.0.1:3007')
    expect(readEaUrl('http://localhost:4000/')).toBe('http://localhost:4000')
  })

  it('refuses values that are not http origins', () => {
    expect(() => readEaUrl('127.0.0.1:3007')).toThrow(/SETI_EA_URL/)
    expect(() => readEaUrl('ftp://127.0.0.1')).toThrow(/SETI_EA_URL/)
  })
})

describe('readCount', () => {
  it('reads whole days and treats unset as null', () => {
    expect(readCount('X', undefined, 'days')).toBeNull()
    expect(readCount('X', ' ', 'days')).toBeNull()
    expect(readCount('X', ' 30 ', 'days')).toBe(30)
  })

  it('refuses values that are not whole positive days', () => {
    for (const bad of ['0', '-5', '1.5', 'week']) {
      expect(() => readCount('SETI_AUDIT_RETENTION_DAYS', bad, 'days')).toThrow(
        /SETI_AUDIT_RETENTION_DAYS must be a whole number of days/,
      )
    }
  })
})

describe('readBackupConfig', () => {
  it('keeps backups off without a public key and reads the defaults with one', () => {
    expect(readBackupConfig({})).toBeNull()
    expect(readBackupConfig({ SETI_BACKUP_PUBLIC_KEY: ' ' })).toBeNull()
    expect(readBackupConfig({ SETI_BACKUP_PUBLIC_KEY: 'key' })).toEqual({
      publicKey: 'key',
      keep: 14,
      intervalHours: 24,
    })
    expect(
      readBackupConfig({ SETI_BACKUP_PUBLIC_KEY: 'key', SETI_BACKUP_KEEP: '30', SETI_BACKUP_INTERVAL_HOURS: '6' }),
    ).toEqual({ publicKey: 'key', keep: 30, intervalHours: 6 })
    expect(() => readBackupConfig({ SETI_BACKUP_PUBLIC_KEY: 'key', SETI_BACKUP_KEEP: '0' })).toThrow(
      /SETI_BACKUP_KEEP must be a whole number of backups/,
    )
  })
})

describe('readAndroidOverride', () => {
  const print = Array.from({ length: 32 }, () => 'ab').join(':')

  it('has no override without the variables, and reads one with both', () => {
    expect(readAndroidOverride({})).toBeNull()
    expect(readAndroidOverride({ SETI_ANDROID_PACKAGE: 'com.example.seti', SETI_ANDROID_CERT_SHA256: print })).toEqual({
      package_name: 'com.example.seti',
      cert_sha256: [print.toUpperCase()],
    })
  })

  it('refuses half an override', () => {
    expect(() => readAndroidOverride({ SETI_ANDROID_PACKAGE: 'com.example.seti' })).toThrow(/SETI_ANDROID_PACKAGE/)
    expect(() => readAndroidOverride({ SETI_ANDROID_CERT_SHA256: print })).toThrow(/package name/)
  })
})

describe('credentialSource', () => {
  const home = '/home/me/.seti'

  it('reads systemd credentials first, outside tests', () => {
    expect(credentialSource({ CREDENTIALS_DIRECTORY: '/run/c' }, home, false)).toEqual({ dir: '/run/c', dev: false })
    expect(credentialSource({ CREDENTIALS_DIRECTORY: '/run/c', VITEST: 'true' }, home, true).dev).toBe(true)
  })

  it('gives a development run its own directory that it may fill', () => {
    expect(credentialSource({}, home, true)).toEqual({ dir: `${home}/dev-credentials`, dev: true })
    expect(credentialSource({ SETI_DEV_CREDENTIALS_DIR: '/srv/dev' }, home, true).dir).toBe('/srv/dev')
  })

  it('reads the credentials directory without systemd and never fills it', () => {
    expect(credentialSource({}, home, false)).toEqual({ dir: `${home}/credentials`, dev: false })
    expect(credentialSource({ SETI_CREDENTIALS_DIR: '/etc/seti' }, home, false)).toEqual({
      dir: '/etc/seti',
      dev: false,
    })
  })
})
