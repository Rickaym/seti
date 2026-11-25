import {
  AUTO_ARCHIVE_DEFAULTS,
  DREAM_SETTINGS_DEFAULTS,
  SETTINGS_SECTIONS,
  modifiedPaths,
  type SettingsDoc,
} from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as access from '../access.js'
import { createApp } from '../app.js'
import { archiveSettings } from '../store/archive.js'
import { dreamSettings } from '../store/dream-nights.js'
import { USER_AUTH } from '../test-auth.js'
import { withBundledMods } from '../test-mods.js'

withBundledMods()

const source = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }))

vi.mock('../access.js', async (importOriginal) => {
  const real = await importOriginal<typeof access>()
  return { ...real, currentRequestSource: () => source.current ?? real.currentRequestSource() }
})

afterEach(() => {
  source.current = null
})

const app = createApp()
const HEADERS = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006', ...USER_AUTH }

type Doc = SettingsDoc & Record<string, Record<string, Record<string, unknown>> | undefined>

async function read(path: string, as: Record<string, unknown> | null = null): Promise<Doc> {
  source.current = as
  const res = await app.request(`/api/settings-doc${path}`, { headers: HEADERS })
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: Doc }).data
}

const texts = (doc: unknown, defaults: unknown) => modifiedPaths(doc, defaults).map((path) => path.join('.'))

describe('settings that differ from their default', () => {
  it('serves defaults that parse against each section', async () => {
    const defaults = await read('/defaults')
    for (const [path, section] of Object.entries(SETTINGS_SECTIONS)) {
      const [group = '', page = ''] = path.split('.')
      const parsed = section.schema.safeParse(defaults[group]?.[page])
      expect(parsed.error?.issues ?? [], path).toEqual([])
    }
  })

  it('marks exactly the settings changed, and keeps only those when asked', async () => {
    const before = texts(await read(''), await read('/defaults'))
    await archiveSettings.set({ ...AUTO_ARCHIVE_DEFAULTS, days: 9 })
    await dreamSettings.set({ ...DREAM_SETTINGS_DEFAULTS, at_once: 2 })
    const doc = await read('')
    const after = texts(doc, await read('/defaults'))
    expect(after.filter((path) => !before.includes(path)).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'agents.lifecycle.auto_archive.days',
      'agents.lifecycle.dreaming.at_once',
    ])
    const modified = await read('?only=modified')
    expect(modified.revision).toBe(doc.revision)
    expect(modified.agents?.lifecycle).toMatchObject({ auto_archive: { days: 9 }, dreaming: { at_once: 2 } })
    expect(Object.keys(modified.agents?.lifecycle?.auto_archive ?? {})).toEqual(['days'])
    await archiveSettings.set({ ...AUTO_ARCHIVE_DEFAULTS })
    await dreamSettings.set({ ...DREAM_SETTINGS_DEFAULTS })
    expect(texts(await read(''), await read('/defaults'))).toEqual(before)
  })

  it('keeps security defaults out of the EA document', async () => {
    const defaults = await read('/defaults', { via: 'ea' })
    expect(defaults.security).toBeUndefined()
    expect(defaults.app?.ea).toBeDefined()
    const modified = await read('?only=modified', { via: 'ea' })
    expect(modified.security).toBeUndefined()
  })
})
