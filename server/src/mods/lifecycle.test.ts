import fs from 'node:fs'
import path from 'node:path'
import type { ModBisectState, ModList } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { auditEvents } from '../store/audit.js'
import { data, install, listed, manifestOf, refused, writePackage } from '../test-mod-packages.js'
import { modHost } from './bundled.js'
import { modFramePages } from './frames/source.js'
import { modLogicHost } from './logic-host.js'
import { applyDueUpdates } from './updates.js'

const hosts = (extra: string[] = []) => [
  { name: 'net.fetch', hosts: ['api.example.com', ...extra] },
  { name: 'storage' },
]

beforeAll(async () => {
  await data('/mod-admin/dev-mode', 'PUT', { on: true })
})

afterAll(async () => {
  await data('/mod-admin/dev-mode', 'PUT', { on: false })
  modHost.stopAll()
})

describe('updates', () => {
  it('waits for consent when an update adds a host, and the old version keeps running', async () => {
    const folder = writePackage(manifestOf('grows'))
    const before = await install(folder)
    writePackage(manifestOf('grows', { version: '1.1.0', capabilities: hosts(['evil.example.com']) }), folder)
    const checked = await data<{ message: string }>('/mod-admin/mods/grows/update/check', 'POST', {})
    expect(checked.message).toBe('Grows 1.1.0 asks for more and waits for you')
    const pending = (await listed('grows'))?.install
    expect(pending).toMatchObject({ hash: before.install?.hash, pending: { reason: 'consent', version: '1.1.0' } })
    expect(pending?.pending?.changes).toEqual([
      'Now also: Sends and receives data with evil.example.com. It can send what it reads there.',
    ])
    expect(modHost.get('grows')?.installed?.hash).toBe(before.install?.hash)
    await applyDueUpdates(new Date(Date.now() + 200 * 3_600_000))
    expect((await listed('grows'))?.install?.hash).toBe(before.install?.hash)

    await data('/mod-admin/mods/grows/update/apply', 'POST', { hash: pending?.pending?.hash })
    const after = await listed('grows')
    expect(after).toMatchObject({ version: '1.1.0', running: true, install: { pending: null } })
    expect(modHost.get('grows')?.installed?.grants[0]).toEqual({
      name: 'net.fetch',
      hosts: ['api.example.com', 'evil.example.com'],
    })
    await auditEvents.settled()
    expect(await auditEvents.latest('mod.updated')).toMatchObject({ subject_id: 'grows', detail: { version: '1.1.0' } })
  })

  it('applies a same-capability update only after its delay, and can roll back', async () => {
    const folder = writePackage(manifestOf('steady'))
    const first = await install(folder)
    writePackage(manifestOf('steady', { version: '1.0.1', capabilities: hosts().slice(1) }), folder)
    await data('/mod-admin/mods/steady/update/check', 'POST', {})
    const staged = (await listed('steady'))?.install?.pending
    expect(staged).toMatchObject({ reason: 'delay', version: '1.0.1' })
    expect(Date.parse(staged?.applies_at ?? '') - Date.parse(staged?.since ?? '')).toBe(24 * 3_600_000)
    await applyDueUpdates(new Date(Date.now() + 23 * 3_600_000))
    expect((await listed('steady'))?.version).toBe('1.0.0')
    await applyDueUpdates(new Date(Date.now() + 25 * 3_600_000))
    const updated = await listed('steady')
    expect(updated?.version).toBe('1.0.1')
    expect(updated?.install?.versions.map((version) => version.hash)).toEqual([first.install?.hash])
    await auditEvents.settled()
    expect(await auditEvents.latest('mod.updated')).toMatchObject({ actor: 'system', subject_id: 'steady' })

    await data('/mod-admin/mods/steady/rollback', 'POST', { hash: first.install?.hash })
    expect(await listed('steady')).toMatchObject({ version: '1.0.0', running: true })
    await auditEvents.settled()
    expect(await auditEvents.latest('mod.rolled_back')).toMatchObject({ detail: { widened: true } })
  })

  it('skips a pending update, keeping the old version', async () => {
    const folder = writePackage(manifestOf('skipper'))
    await install(folder)
    writePackage(manifestOf('skipper', { version: '2.0.0' }), folder)
    await data('/mod-admin/mods/skipper/update/check', 'POST', {})
    const hash = (await listed('skipper'))?.install?.pending?.hash
    await data('/mod-admin/mods/skipper/update/skip', 'POST', { hash })
    expect(await listed('skipper')).toMatchObject({ version: '1.0.0', install: { pending: null } })
  })
})

describe('the logic host', () => {
  it('hands the runtime the pinned script and grants of a running mod, and nothing once it is off', async () => {
    const views = [{ id: 'board', title: 'Board', where: 'section', phone: true, entry: 'views/board.html' }]
    const folder = writePackage(manifestOf('scripted', { main: 'logic.js', contributes: { views } }))
    fs.writeFileSync(path.join(folder, 'logic.js'), 'export default { commands: {} }')
    fs.mkdirSync(path.join(folder, 'views'))
    fs.writeFileSync(path.join(folder, 'views/board.html'), '<p>Board</p><script>go()</script>')
    const mod = await install(folder)
    const target = await modLogicHost.target('scripted')
    expect(target).toMatchObject({
      modId: 'scripted',
      hash: mod.install?.hash,
      script: 'export default { commands: {} }',
      grants: ['net.fetch', 'storage'],
    })
    expect(target?.scopes['net.fetch']).toMatchObject({ hosts: ['api.example.com'] })
    const page = modFramePages.get('scripted')?.page('views/board.html')
    expect(page).toMatchObject({
      html: '<p>Board</p><script>go()</script>',
      scriptHashes: [expect.stringMatching(/^sha256-/)],
    })
    await data('/mods/scripted', 'PATCH', { enabled: false })
    expect(await modLogicHost.target('scripted')).toBeNull()
    expect(modFramePages.get('scripted')).toBeUndefined()
  })
})

describe('mod bisect', () => {
  it('finds a planted culprit by halving, then restores every other mod', async () => {
    for (const id of ['alpha', 'bravo', 'charlie', 'delta', 'echo']) {
      await install(writePackage(manifestOf(id)))
    }
    const before = new Map((await data<ModList>('/mods')).mods.map((mod) => [mod.id, mod.enabled]))
    let state = await data<ModBisectState>('/mod-admin/bisect', 'POST')
    const suspects = state.suspects.length
    expect(suspects).toBeGreaterThanOrEqual(5)
    expect(state.suspects).not.toContain('previews')
    expect(state.suspects.filter((id) => modHost.get(id)?.manifest?.required === true)).toEqual([])
    let steps = 1
    while (state.culprit === null) {
      expect(modHost.get('previews')?.enabled).toBe(true)
      const broken = modHost.get('charlie')?.enabled === true
      state = await data<ModBisectState>('/mod-admin/bisect/answer', 'POST', { broken })
      steps += 1
    }
    expect(state.culprit).toBe('charlie')
    expect(steps).toBeLessThanOrEqual(Math.ceil(Math.log2(suspects)) + 1)
    expect((await data<ModList>('/mods')).bisect?.culprit).toBe('charlie')
    expect((await refused('/mod-admin/bisect/answer', 'POST', { broken: true })).status).toBe(409)
    await data('/mod-admin/bisect', 'DELETE')
    const after = new Map((await data<ModList>('/mods')).mods.map((mod) => [mod.id, mod.enabled]))
    expect(after).toEqual(before)
    await auditEvents.settled()
    expect(await auditEvents.latest('mod.bisect_step')).toMatchObject({ detail: { ended: true } })
  })
})

describe('dev mods', () => {
  it('loads a folder after consent, reloads on change, and unloads when Developer mode is off', async () => {
    const folder = writePackage(manifestOf('devmod'))
    const loaded = await data<{ message: string; preview: { hash: string } }>('/mod-admin/dev', 'POST', {
      path: folder,
    })
    expect(loaded.message).toBe('Approve Devmod (dev) in Seti, Settings, Mods')
    await data('/mod-admin/install', 'POST', { mod_id: 'devmod', hash: loaded.preview.hash })
    expect(await listed('devmod')).toMatchObject({ running: true, install: { source_kind: 'dev' } })

    fs.writeFileSync(path.join(folder, 'README.md'), 'Changed')
    await vi.waitFor(async () => {
      expect((await listed('devmod'))?.install?.hash).not.toBe(loaded.preview.hash)
    })
    writePackage(manifestOf('devmod', { capabilities: hosts(['more.example.com']) }), folder)
    await vi.waitFor(async () => {
      expect((await listed('devmod'))?.install?.pending?.reason).toBe('consent')
    })

    await data('/mod-admin/dev-mode', 'PUT', { on: false })
    expect(await listed('devmod')).toBeUndefined()
    expect((await refused('/mod-admin/dev', 'POST', { path: folder })).status).toBe(409)
    await data('/mod-admin/dev-mode', 'PUT', { on: true })
    expect(await listed('devmod')).toMatchObject({ install: { source_kind: 'dev' } })
  })
})
