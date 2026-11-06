import sample from '@seti/mod-sample/seti-mod.json' with { type: 'json' }
import sideChat from '@seti/mod-side-chat/seti-mod.json' with { type: 'json' }
import { modManifest, type ModInfo, type ModList, type TaskListEntry } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { resolveModSlash } from './slash'
import { modAgentActions, modPaletteCommands } from './useModCommands'

vi.mock('@/lib/route', () => ({ navigate: vi.fn() }))

const manifest = modManifest.parse(sample)

const info = (extra: Partial<ModInfo>): ModInfo => ({
  id: 'sample',
  name: 'Sample',
  display_name: 'Sample',
  icon: null,
  version: '1.0.0',
  description: '',
  author: null,
  tier: 'bundled',
  enabled: false,
  running: false,
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
  install: null,
  ...extra,
})

const list = (mod: ModInfo): ModList => ({
  safe_mode: false,
  safe_mode_forced: false,
  dev_mode: false,
  bisect: null,
  unisolated: false,
  mods: [mod],
})

describe('a mod slash command in the composer', () => {
  it('runs the command it names with the agent and the text', () => {
    const resolved = resolveModSlash('/sample hello there', list(info({ enabled: true, running: true })), 'agent-1')
    expect(resolved).toMatchObject({
      kind: 'run',
      command: { id: 'wave' },
      args: { task: 'agent-1', note: 'hello there' },
    })
  })

  it('says a bundled mod that is off is off, and leaves other lines alone', () => {
    expect(resolveModSlash('/sample', list(info({})), 'a')).toMatchObject({ kind: 'off', mod: { name: 'Sample' } })
    expect(resolveModSlash('/compact', list(info({})), 'a')).toBeNull()
    expect(resolveModSlash('hello', list(info({})), 'a')).toBeNull()
    expect(resolveModSlash('/sample', list(info({ tier: 'third-party' })), 'a')).toBeNull()
    expect(resolveModSlash('/sample', list(info({ problem: 'Broken' })), 'a')).toBeNull()
  })
})

describe("mods' palette commands", () => {
  const agent = { id: 'agent-1' } as TaskListEntry
  const route = { section: 'agents', id: 'agent-1', sub: null, detail: null, terminal: null } as const

  it('list a running mod by name, and one on an agent only while an agent is open', () => {
    const commands = modPaletteCommands(list(info({ enabled: true, running: true })), [])
    expect(commands.map((c) => [c.id, c.group, c.detail])).toEqual([
      ['mod.sample.count', 'General', 'Sample'],
      ['mod.sample.wave', 'Current agent', 'Sample'],
    ])
    const wave = commands[1]
    expect(wave?.when?.({ route, agent: null })).toBe(false)
    expect(wave?.when?.({ route, agent })).toBe(true)
  })

  it('list a bundled mod that is off as off', () => {
    expect(modPaletteCommands(list(info({})), []).map((c) => c.detail)).toEqual(['Sample is off', 'Sample is off'])
    expect(modPaletteCommands(list(info({ tier: 'third-party' })), [])).toEqual([])
  })
})

describe("mods' rows in an agent's menu", () => {
  const side = (extra: Partial<ModInfo>) =>
    info({ id: 'side-chat', name: 'Side chat', manifest: modManifest.parse(sideChat), ...extra })

  it('list the menu commands of running mods with their slash command, and none of mods that are off', () => {
    const rows = modAgentActions(list(side({ enabled: true, running: true })), [], 'agent-1')
    expect(rows.map((row) => [row.label, row.detail])).toEqual([['Ask aside', '/btw']])
    expect(modAgentActions(list(side({})), [], 'agent-1')).toEqual([])
    expect(modAgentActions(list(info({ enabled: true, running: true })), [], 'agent-1')).toEqual([])
  })

  it('give a running mod its slash command as the palette shortcut, and an off one none', () => {
    const on = modPaletteCommands(list(side({ enabled: true, running: true })), [])
    expect(on.map((c) => [c.title, c.shortcut, c.group])).toEqual([['Ask aside', '/btw', 'Current agent']])
    expect(modPaletteCommands(list(side({})), [])[0]?.shortcut).toBeUndefined()
  })
})
