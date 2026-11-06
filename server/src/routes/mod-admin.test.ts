import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { STEP_UP_REFUSAL, type ModDetail, type ModInstallPreview, type ModList } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asAgent, asMod } from '../access.js'
import { sql, tasks } from '../db.js'
import { modHost } from '../mods/bundled.js'
import { setDevMode } from '../mods/dev.js'
import { installMod, previewInstall, rollbackMod, uninstallMod } from '../mods/install.js'
import { FILES_CHANGED } from '../mods/installed.js'
import { auditEvents } from '../store/audit.js'
import { encodeFiles } from '../store/mod-packages.js'
import { EA_AUTH } from '../test-auth.js'
import { keyConnection } from '../test-connections.js'
import { data, install, listed, manifestOf, preview, refused, request, writePackage } from '../test-mod-packages.js'

afterAll(() => {
  modHost.stopAll()
})

describe('Developer mode', () => {
  it('is off by default, and third-party install waits for it', async () => {
    expect((await data<ModList>('/mods')).dev_mode).toBe(false)
    const folder = writePackage(manifestOf('early'))
    expect(await refused('/mod-admin/preview', 'POST', { source: { kind: 'folder', path: folder } })).toEqual({
      status: 409,
      detail: 'Turn on Developer mode in Settings, Mods',
    })
    expect((await data<ModList>('/mod-admin/dev-mode', 'PUT', { on: true })).dev_mode).toBe(true)
    await auditEvents.settled()
    expect(await auditEvents.latest('mod.dev_mode_changed')).toMatchObject({
      actor: 'user',
      detail: { dev_mode: true },
    })
  })
})

describe('installing a third-party mod', () => {
  beforeAll(async () => {
    await data('/mod-admin/dev-mode', 'PUT', { on: true })
  })

  it('shows its icon and README at Check, and on its page once installed', async () => {
    const folder = writePackage(
      manifestOf('atlas', { displayName: 'Atlas maps', icon: 'icon.svg', categories: ['integrations'] }),
    )
    fs.writeFileSync(path.join(folder, 'icon.svg'), '<svg onload="x()"><circle r="4"/></svg>')
    fs.writeFileSync(path.join(folder, 'README.md'), '# Atlas\n\nDraws maps.')
    const checked = await preview(folder)
    expect(checked.readme).toBe('# Atlas\n\nDraws maps.')
    expect(checked.icon?.kind === 'image' && checked.icon.url.startsWith('data:image/svg+xml;base64,')).toBe(true)
    const mod = await install(folder)
    expect(mod).toMatchObject({ display_name: 'Atlas maps', icon: checked.icon })
    const detail = await data<ModDetail>('/mods/atlas')
    expect(detail).toMatchObject({ readme: '# Atlas\n\nDraws maps.', changelog: null })
    await data('/mod-admin/mods/atlas/uninstall', 'POST', { delete_data: true })
  })

  it("shows Seti's own words for what it may do, then installs it on, pinned to its hash", async () => {
    const connection = await keyConnection('LINEAR_API_KEY', 'lin_secret_value', {
      hosts: ['api.linear.app'],
      header: { name: 'Authorization', template: 'Bearer {{value}}' },
    })
    const folder = writePackage(
      manifestOf('linear', {
        name: 'Linear',
        capabilities: [
          { name: 'net.fetch', hosts: ['api.linear.app', '*.linear.dev'] },
          { name: 'connection', variable: 'LINEAR_API_KEY', hosts: ['api.linear.app'] },
          { name: 'files.read', agents: ['builder'], paths: ['notes/**/*.md'] },
          { name: 'storage' },
        ],
      }),
    )
    const checked = await preview(folder)
    expect(checked.problem).toBeNull()
    expect(checked.capabilities.map((line) => line.text)).toEqual([
      'Sends and receives data with api.linear.app and every subdomain of linear.dev. It can send what it reads there.',
      'Uses your LINEAR_API_KEY connection with api.linear.app. It never sees the key, and it can send what it reads there.',
      'Reads files matching notes/**/*.md in the folders of @builder. Never keys, credentials or .env files.',
      'Keeps up to 1 MB of its own data in Seti.',
    ])
    expect(checked.capabilities[1]?.connections).toEqual([{ id: connection.id, name: connection.name }])
    expect(checked.warnings).toEqual(['It reaches every subdomain of linear.dev.'])
    const missing = await refused('/mod-admin/install', 'POST', { mod_id: 'linear', hash: checked.hash })
    expect(missing).toEqual({ status: 400, detail: 'Pick the LINEAR_API_KEY connection Linear uses' })

    const mod = await install(folder, { LINEAR_API_KEY: connection.id })
    expect(mod).toMatchObject({ tier: 'third-party', enabled: true, running: true, problem: null })
    expect(mod.install).toMatchObject({ source_kind: 'folder', hash: checked.hash, pending: null })
    await auditEvents.settled()
    const installed = await auditEvents.latest('mod.installed')
    expect(installed).toMatchObject({
      actor: 'user',
      subject_id: 'linear',
      detail: { hash: checked.hash, hosts: ['api.linear.app', '*.linear.dev'], connections: ['LINEAR_API_KEY'] },
    })
    expect(JSON.stringify(installed)).not.toContain('lin_secret_value')
  })

  it('refuses a package that claims the id of a mod Seti ships', async () => {
    const folder = writePackage(manifestOf('weather'))
    expect(await refused('/mod-admin/preview', 'POST', { source: { kind: 'folder', path: folder } })).toEqual({
      status: 400,
      detail: 'The id weather is taken by Seti; pick another',
    })
  })

  it('keeps a mod off when its stored files no longer match the hash, and audits it', async () => {
    const mod = await install(writePackage(manifestOf('tamper')))
    const hash = mod.install?.hash ?? expect.fail('no hash')
    const forged = encodeFiles(new Map([['seti-mod.json', Buffer.from(`${JSON.stringify(manifestOf('tamper'))} `)]]))
    await sql`UPDATE mod_version SET files = ${forged} WHERE mod_id = 'tamper' AND hash = ${hash}`
    await data('/mods/tamper', 'PATCH', { enabled: false })
    expect(await refused('/mods/tamper', 'PATCH', { enabled: true })).toMatchObject({ status: 409 })
    expect(await listed('tamper')).toMatchObject({ running: false, problem: FILES_CHANGED })
    await auditEvents.settled()
    expect(await auditEvents.latest('mod.files_changed')).toMatchObject({ actor: 'system', subject_id: 'tamper' })
  })

  it('holds third-party mods off in safe mode and starts them again after', async () => {
    await install(writePackage(manifestOf('quiet')))
    await data('/mods', 'PUT', { safe_mode: true })
    expect(await listed('quiet')).toMatchObject({ running: false, held_by_safe_mode: true })
    await data('/mods', 'PUT', { safe_mode: false })
    expect(await listed('quiet')).toMatchObject({ running: true })
  })

  it('uninstalls with its data, leaving no mod_* row behind', async () => {
    await install(
      writePackage(
        manifestOf('gone', { contributes: { settings: { team: { type: 'string', title: 'Team', default: 'a' } } } }),
      ),
    )
    await data('/mods/gone', 'PATCH', { settings: { team: 'b' } })
    await sql`INSERT INTO mod_data (mod_id, key, value, bytes, updated_at) VALUES ('gone', 'k', '1', 1, now()::text)`
    await data('/mod-admin/mods/gone/uninstall', 'POST', { delete_data: true })
    expect(await listed('gone')).toBeUndefined()
    const tables = ['mod_install', 'mod_version', 'mod_grant', 'mod_data', 'mod_settings', 'mod_state', 'mod_log']
    for (const table of tables) {
      const [row] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ${sql(table)} WHERE mod_id = 'gone'`
      expect(row?.n, table).toBe(0)
    }
    await auditEvents.settled()
    expect(await auditEvents.latest('mod.uninstalled')).toMatchObject({ detail: { mod: 'gone', data_deleted: true } })
  })
})

describe('who may install, grant and approve', () => {
  const agent = { id: randomUUID(), title: 'Mod writer', seti_control: 'full' as const }
  let checked: ModInstallPreview

  beforeAll(async () => {
    await tasks.insert({ ...agent, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
    await data('/mod-admin/dev-mode', 'PUT', { on: true })
    checked = await preview(writePackage(manifestOf('guarded')))
  })

  const ONLY_USER = 'Only the user does this, signed in to Seti with a passkey or on this machine'

  it.each([
    ['/mod-admin/preview', 'POST', { source: { kind: 'folder', path: '/tmp' } }],
    ['/mod-admin/install', 'POST', { mod_id: 'guarded', hash: 'a'.repeat(64) }],
    ['/mod-admin/dev-mode', 'PUT', { on: false }],
    ['/mod-admin/dev', 'POST', { path: '/tmp' }],
    ['/mod-admin/bisect', 'POST', undefined],
    ['/mod-admin/mods/linear/update/apply', 'POST', { hash: 'a'.repeat(64) }],
    ['/mod-admin/mods/linear/rollback', 'POST', { hash: 'a'.repeat(64) }],
    ['/mod-admin/mods/linear/uninstall', 'POST', { delete_data: true }],
  ])('refuses the EA at %s', async (route, method, body) => {
    expect(await refused(route, method, body, EA_AUTH)).toEqual({ status: 403, detail: ONLY_USER })
  })

  it('refuses agents and mods, even at Full', async () => {
    const asSource = [
      async <T>(fn: () => Promise<T>) => asAgent(agent, fn),
      async <T>(fn: () => Promise<T>) => asMod({ id: 'guarded', grants: ['storage'] }, fn),
    ]
    for (const run of asSource) {
      const calls: (() => Promise<unknown>)[] = [
        async () => previewInstall({ kind: 'folder', path: '/tmp' }),
        async () => installMod({ mod_id: checked.mod_id, hash: checked.hash, connections: {} }),
        async () => setDevMode(false),
        async () => rollbackMod('linear', 'a'.repeat(64)),
        async () => uninstallMod('linear', true),
      ]
      for (const call of calls) {
        await expect(run(call)).rejects.toThrow(ONLY_USER)
      }
    }
    expect(await listed('guarded')).toBeUndefined()
  })

  it('names the passkey step-up in one shared refusal the UI recognises', () => {
    expect(STEP_UP_REFUSAL).toBe('Confirm with your passkey')
  })

  it('lets nobody but the user turn a third-party mod on', async () => {
    await install(writePackage(manifestOf('switched')))
    await data('/mods/switched', 'PATCH', { enabled: false })
    expect((await refused('/mods/switched', 'PATCH', { enabled: true }, EA_AUTH)).status).toBe(403)
    expect(await (await request('/mods/switched')).json()).toMatchObject({ data: { enabled: false } })
  })
})
