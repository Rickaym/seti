import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { CODEX_SETTINGS_DEFAULTS } from '@seti/shared'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyState, installCodex, sweepCodex } from './codex-install.js'
import { CODEX_ROOT } from './config.js'
import { auditEvents } from './store/audit.js'
import { codexSettings } from './store/codex-settings.js'
import { fakeBuild, FakeRegistry, markerProgram } from './test-codex-registry.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-codex-install-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

const registry = await new FakeRegistry().start()
const dirOf = (version: string) => path.join(CODEX_ROOT, version)
const stagingOf = (version: string) => path.join(CODEX_ROOT, `.staging-${version}`)
const ZERO_SHA512 = `sha512-${Buffer.alloc(64).toString('base64')}`

beforeEach(async () => {
  await sweepCodex()
  registry.mode = 'serve'
  registry.ranges.length = 0
  await codexSettings.set({ ...CODEX_SETTINGS_DEFAULTS, enabled: true })
})

afterAll(async () => {
  await registry.close()
  await codexSettings.set(CODEX_SETTINGS_DEFAULTS)
  await sweepCodex()
})

describe("Seti's own copy of Codex", () => {
  it('installs a good download once, alone in a read-only folder, and records it', async () => {
    const build = fakeBuild(scratch, '1.0.1', '/bin/sleep')
    const pin = registry.pin(build)
    const both = [installCodex('user', pin), installCodex('user', pin)]
    expect(await copyState(pin)).toEqual({ state: 'installing' })
    await Promise.all(both)
    const program = path.join(dirOf('1.0.1'), 'codex')
    expect(await copyState(pin)).toEqual({ state: 'ready', program })
    expect(registry.ranges, 'two asks at once fetch once').toEqual([null])
    expect(new Set(fs.readdirSync(dirOf('1.0.1')))).toEqual(new Set(['codex', 'codex-code-mode-host']))
    expect(fs.statSync(program).mode & 0o777).toBe(0o500)
    expect(fs.statSync(path.join(dirOf('1.0.1'), 'codex-code-mode-host')).mode & 0o777).toBe(0o500)
    expect(fs.statSync(dirOf('1.0.1')).mode & 0o777).toBe(0o500)
    expect(() => {
      fs.writeFileSync(path.join(dirOf('1.0.1'), 'codex-path'), '')
    }).toThrow(/EACCES/)
    expect(() => {
      fs.appendFileSync(program, 'x')
    }).toThrow(/EACCES/)
    expect(fs.existsSync(stagingOf('1.0.1'))).toBe(false)
    expect(await auditEvents.latest('system.runtime_installed')).toMatchObject({
      actor: 'user',
      detail: { runtime: 'codex', version: '1.0.1', sha256: build.sha256, from: new URL(registry.origin).host },
    })
    await installCodex('user', pin)
    expect(registry.ranges, 'an installed version is not fetched again').toHaveLength(1)
  })

  it('refuses a tarball that fails its sha512, deletes it and never runs it', async () => {
    const marker = path.join(scratch, 'ran-sha512')
    const pin = registry.pin(fakeBuild(scratch, '1.0.2', markerProgram(scratch, '1.0.2', marker)), {
      integrity: ZERO_SHA512,
    })
    await installCodex('user', pin)
    expect(await copyState(pin)).toMatchObject({ state: 'failed', failure: { reason: 'checksum' } })
    expect(fs.existsSync(dirOf('1.0.2'))).toBe(false)
    expect(fs.existsSync(stagingOf('1.0.2'))).toBe(false)
    expect(fs.existsSync(marker)).toBe(false)
    expect(await auditEvents.latest('system.runtime_install_failed')).toMatchObject({
      detail: { version: '1.0.2', reason: 'checksum' },
    })
  })

  it('refuses a program that fails its sha256, deletes it and never runs it', async () => {
    const marker = path.join(scratch, 'ran-sha256')
    const pin = registry.pin(fakeBuild(scratch, '1.0.3', markerProgram(scratch, '1.0.3', marker)), {
      sha256: 'f'.repeat(64),
    })
    await installCodex('system', pin)
    expect(await copyState(pin)).toMatchObject({
      state: 'failed',
      failure: { reason: 'checksum', message: expect.stringContaining('sha256') as string },
    })
    expect(fs.existsSync(dirOf('1.0.3'))).toBe(false)
    expect(fs.existsSync(stagingOf('1.0.3'))).toBe(false)
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('refuses a code mode host that fails its sha256, and installs nothing', async () => {
    const pin = registry.pin(fakeBuild(scratch, '1.0.11', '/bin/sleep'), { hostSha256: 'f'.repeat(64) })
    await installCodex('system', pin)
    expect(await copyState(pin)).toMatchObject({
      state: 'failed',
      failure: { reason: 'checksum', message: expect.stringContaining('code mode host') as string },
    })
    expect(fs.existsSync(dirOf('1.0.11'))).toBe(false)
    expect(fs.existsSync(stagingOf('1.0.11'))).toBe(false)
  })

  it('fetches again a copy installed before Codex needed its code mode host', async () => {
    const pin = registry.pin(fakeBuild(scratch, '1.0.12', '/bin/sleep'))
    await installCodex('user', pin)
    const host = path.join(dirOf('1.0.12'), 'codex-code-mode-host')
    fs.chmodSync(dirOf('1.0.12'), 0o700)
    fs.rmSync(host)
    expect(await copyState(pin)).toMatchObject({ state: 'failed' })
    await installCodex('system', pin)
    expect(await copyState(pin)).toMatchObject({ state: 'ready' })
    expect(fs.existsSync(host)).toBe(true)
  })

  it('fails a cut download as a network failure, and the next try finishes it', async () => {
    const pin = registry.pin(fakeBuild(scratch, '1.0.4', '/bin/sleep'))
    registry.mode = 'cut'
    await installCodex('user', pin)
    expect(await copyState(pin)).toMatchObject({ state: 'failed', failure: { reason: 'network' } })
    registry.mode = 'serve'
    await installCodex('user', pin)
    expect((await copyState(pin)).state).toBe('ready')
  })

  it('resumes a download from the bytes an earlier cut left', async () => {
    const build = fakeBuild(scratch, '1.0.9', '/bin/sleep')
    const pin = registry.pin(build)
    const kept = Math.floor(build.tarball.length / 2)
    fs.mkdirSync(stagingOf('1.0.9'), { recursive: true })
    fs.writeFileSync(path.join(stagingOf('1.0.9'), 'codex.tgz'), build.tarball.subarray(0, kept))
    await installCodex('user', pin)
    expect(registry.ranges.at(-1)).toBe(`bytes=${String(kept)}-`)
    expect((await copyState(pin)).state).toBe('ready')
  })

  it('starts a cut download over when the registry serves no ranges', async () => {
    const pin = registry.pin(fakeBuild(scratch, '1.0.5', '/bin/sleep'))
    registry.mode = 'cut'
    await installCodex('user', pin)
    registry.mode = 'whole'
    await installCodex('user', pin)
    expect((await copyState(pin)).state).toBe('ready')
  })

  it('says so when the registry is down or the pin has no build for this machine', async () => {
    const pin = registry.pin(fakeBuild(scratch, '1.0.6', '/bin/sleep'))
    registry.mode = 'down'
    await installCodex('user', pin)
    expect(await copyState(pin)).toMatchObject({ state: 'failed', failure: { reason: 'network' } })
    const elsewhere = { version: '1.0.7', platforms: {} }
    await installCodex('user', elsewhere)
    expect(await copyState(elsewhere)).toMatchObject({ state: 'failed', failure: { reason: 'platform' } })
  })

  it('fails a copy that changed on disk, and installs it again on the next try', async () => {
    const pin = registry.pin(fakeBuild(scratch, '1.0.8', '/bin/sleep'))
    await installCodex('user', pin)
    const program = path.join(dirOf('1.0.8'), 'codex')
    fs.chmodSync(program, 0o700)
    fs.appendFileSync(program, 'changed')
    expect(await copyState(pin)).toMatchObject({ state: 'failed', failure: { reason: 'checksum' } })
    await installCodex('user', pin)
    expect(await copyState(pin)).toEqual({ state: 'ready', program })
  })

  it('installs a new pin and removes the old version only once no process runs it', async () => {
    const old = registry.pin(fakeBuild(scratch, '2.0.0', '/bin/sleep'))
    await installCodex('system', old)
    const busy = spawn(path.join(dirOf('2.0.0'), 'codex'), ['60'])
    await once(busy, 'spawn')
    const next = registry.pin(fakeBuild(scratch, '2.0.1', '/bin/sleep'))
    await installCodex('system', next)
    expect((await copyState(next)).state).toBe('ready')
    expect(await sweepCodex(next)).toEqual([])
    expect(fs.existsSync(dirOf('2.0.0')), 'a running agent keeps its version').toBe(true)
    busy.kill()
    await once(busy, 'exit')
    expect(await sweepCodex(next)).toEqual(['2.0.0'])
    expect(fs.existsSync(dirOf('2.0.0'))).toBe(false)
    expect(await auditEvents.latest('system.runtime_removed')).toMatchObject({ detail: { version: '2.0.0' } })
  })

  it('removes every copy once Codex is off or runs a program of the user', async () => {
    const pin = registry.pin(fakeBuild(scratch, '3.0.0', '/bin/sleep'))
    await installCodex('user', pin)
    await codexSettings.set({ ...CODEX_SETTINGS_DEFAULTS, enabled: true, program: '/opt/codex' })
    await sweepCodex(pin)
    expect(fs.readdirSync(CODEX_ROOT)).toEqual([])
  })
})
