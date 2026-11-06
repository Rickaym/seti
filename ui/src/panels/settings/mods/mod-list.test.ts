import { modManifest, type ModInfo, type ModInstallInfo } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { contributionGroups } from './mod-contributes'
import { filterCounts, inFilter, matchesQuery, modBadges, modsRoute, tabOf, tabsOf } from './mod-list'

const manifest = modManifest.parse({
  id: 'atlas',
  name: 'Atlas',
  displayName: 'Atlas maps',
  version: '1.0.0',
  seti: '^1.10',
  description: 'Draws maps of every agent.',
  categories: ['integrations'],
  contributes: {
    settings: { zoom: { type: 'number', title: 'Zoom', default: 2 } },
    commands: [{ id: 'pin', title: 'Pin a place', for: ['palette', 'ea'] }],
    slashCommands: [{ name: 'map', description: 'Opens the map', command: 'pin' }],
  },
})

const install: ModInstallInfo = {
  source_kind: 'git',
  source: 'https://example.com/atlas.git',
  track: 'main',
  hash: 'a'.repeat(64),
  update_delay_hours: 24,
  pending: null,
  versions: [],
  last_error: null,
  data_bytes: 0,
  settings_count: 0,
}

const mod = (extra: Partial<ModInfo> = {}): ModInfo => ({
  id: 'atlas',
  name: 'Atlas',
  display_name: 'Atlas maps',
  icon: null,
  version: '1.0.0',
  description: manifest.description,
  author: 'Someone',
  tier: 'third-party',
  enabled: true,
  running: true,
  security_sensitive: false,
  required: false,
  restart: false,
  capabilities: [],
  points: [],
  problem: null,
  held_by_safe_mode: false,
  notifications: [],
  settings: [],
  off_switches: [],
  manifest,
  install,
  ...extra,
})

const pending = {
  hash: 'b'.repeat(64),
  version: '1.1.0',
  reason: 'consent' as const,
  since: '2026-11-04T00:00:00Z',
  applies_at: null,
  changes: [],
  bindings: [],
  older: false,
}

describe('the Mods list', () => {
  it('finds a mod by any word of its names, publisher or category', () => {
    for (const query of ['atlas', 'MAPS', 'someone', 'integrations', 'every agent', '']) {
      expect(matchesQuery(mod(), query), query).toBe(true)
    }
    expect(matchesQuery(mod(), 'atlas weather')).toBe(false)
  })

  it('sorts mods into the filters, and counts each', () => {
    const bundled = mod({ id: 'weather', tier: 'bundled', install: null, enabled: false, author: null })
    const updating = mod({ id: 'beta', install: { ...install, pending } })
    const mods = [mod(), bundled, updating]
    expect(filterCounts(mods)).toEqual({ all: 3, enabled: 2, disabled: 1, bundled: 1, installed: 2, updates: 1 })
    expect(inFilter(bundled, 'bundled')).toBe(true)
    expect(inFilter(updating, 'updates')).toBe(true)
    const core = mod({ id: 'previews', tier: 'bundled', install: null, required: true, author: null })
    expect(filterCounts([core])).toEqual({ all: 1, enabled: 1, disabled: 0, bundled: 1, installed: 0, updates: 0 })
  })

  it('badges where a mod came from and what waits on it', () => {
    expect(modBadges(mod({ tier: 'bundled', install: null })).map((badge) => badge.label)).toEqual(['Bundled'])
    expect(modBadges(mod({ tier: 'bundled', install: null, required: true }))).toEqual([
      { label: 'Core', tone: 'muted', hint: 'Part of Seti, so it is always on.' },
    ])
    const busy = mod({
      install: { ...install, source_kind: 'dev', pending, last_error: 'It threw' },
      restart: true,
      held_by_safe_mode: true,
    })
    expect(modBadges(busy).map((badge) => badge.label)).toEqual([
      'Dev',
      'Update available',
      'Restart needed',
      'Safe mode',
      'Error',
    ])
    expect(modBadges(busy).at(-1)?.hint).toBe('It threw')
  })

  it('reads the add page, a mod and its tab from the route', () => {
    expect(modsRoute(null)).toEqual({ kind: 'list' })
    expect(modsRoute('add')).toEqual({ kind: 'add' })
    expect(modsRoute('atlas/permissions')).toEqual({ kind: 'mod', id: 'atlas', tab: 'permissions' })
    expect(tabsOf(mod())).toEqual(['details', 'permissions', 'settings', 'contributes', 'changelog', 'versions'])
    expect(tabsOf(mod({ install: null, manifest: modManifest.parse({ ...manifest, contributes: {} }) }))).toEqual([
      'details',
      'permissions',
      'contributes',
      'changelog',
    ])
    expect(tabOf(mod({ install: null }), 'versions')).toBe('details')
  })

  it('lists what a mod adds, in groups', () => {
    expect(contributionGroups(manifest.contributes)).toEqual([
      { title: 'Commands', items: [{ name: 'Pin a place', detail: 'From the command palette and the EA.' }] },
      { title: 'Slash commands', items: [{ name: '/map', detail: 'Opens the map' }] },
    ])
  })
})
