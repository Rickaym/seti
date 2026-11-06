import type { ModDetail, ModList } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { auditEvents } from '../store/audit.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'
import { migrateWith } from '../test-migration.js'
import { withBundledMods } from '../test-mods.js'

withBundledMods()

const app = createApp()

async function data<T>(route: string, method = 'GET', body?: unknown, auth = USER_AUTH): Promise<T> {
  const res = await app.request(`/api${route}`, {
    method,
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { data: T }).data
}

const previews = async () => (await data<ModList>('/mods')).mods.find((mod) => mod.id === 'previews')

describe('the Previews mod', () => {
  it('runs by default with every format switch on, and lists the switches that are off', async () => {
    expect(await previews()).toMatchObject({ enabled: true, running: true, off_switches: [] })
    const detail = await data<ModDetail>('/mods/previews', 'PATCH', { settings: { pdf: false } }, EA_AUTH)
    expect(detail.off_switches).toEqual(['pdf'])
    expect(detail.settings.map(({ key, value }) => [key, value])).toEqual([
      ['pdf', false],
      ['sheets', true],
      ['mermaid', true],
    ])
    await auditEvents.settled()
    expect((await auditEvents.latest('mod.settings_changed'))?.detail).toMatchObject({ mod: 'previews', keys: ['pdf'] })
    await data('/mods/previews', 'PATCH', { settings: { pdf: true } })
    expect((await previews())?.off_switches).toEqual([])
  })

  it('keeps each old viewer mod the user turned off as its switch, and retires the old ids', async () => {
    const at = '2026-11-01T00:00:00.000Z'
    const seed = `
      INSERT INTO mod_state (mod_id, enabled, updated_at) VALUES
        ('pdf', false, '${at}'), ('sheets', true, '${at}'), ('mermaid', false, '${at}'), ('vim', true, '${at}');
      INSERT INTO mod_settings (mod_id, key, value, updated_at) VALUES ('mermaid', 'old', 'true', '${at}');
      INSERT INTO mod_data (mod_id, key, value, bytes, updated_at) VALUES ('pdf', 'k', '1', 1, '${at}');
    `
    const outcome = await migrateWith(
      'previews_mod',
      seed,
      async (tx) => ({
        state: await tx<{ mod_id: string }[]>`SELECT mod_id FROM mod_state ORDER BY mod_id`,
        settings: await tx<{ mod_id: string; key: string; value: unknown }[]>`SELECT mod_id, key, value
          FROM mod_settings ORDER BY mod_id, key`,
        data: await tx`SELECT mod_id FROM mod_data`,
      }),
      2,
    )
    expect(outcome.state).toEqual([{ mod_id: 'vim' }])
    expect(outcome.settings).toEqual([
      { mod_id: 'previews', key: 'mermaid', value: false },
      { mod_id: 'previews', key: 'pdf', value: false },
    ])
    expect(outcome.data).toHaveLength(0)
  })
})
