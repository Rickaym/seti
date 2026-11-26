import fs from 'node:fs'
import path from 'node:path'
import { modEaReachWarnings, modManifest } from '@seti/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { modLogs } from '../store/mod-logic.js'
import { ModHost } from './host.js'

const MODS_DIR = path.resolve(import.meta.dirname, '../../../mods')

const manifest = (contributes: Record<string, unknown>) => ({
  id: 'reach',
  name: 'Reach',
  version: '1.0.0',
  seti: '^1.25',
  description: 'A mod the tests build',
  contributes,
})

const warningsOf = (contributes: Record<string, unknown>) =>
  modEaReachWarnings(modManifest.parse(manifest(contributes)).contributes)

const hosts: ModHost[] = []

afterEach(() => {
  for (const host of hosts.splice(0)) {
    host.stopAll()
  }
})

describe("a mod's reach for the EA", () => {
  it('asks a command on a user surface to be offered to the EA, or to say why not', () => {
    const palette = { id: 'go', title: 'Go', for: ['palette'] }
    expect(warningsOf({ commands: [palette] })).toEqual([
      'The command go is offered on the palette but not to the EA: add "ea" to its for, or say why in eaReason',
    ])
    expect(warningsOf({ commands: [{ ...palette, for: ['palette', 'ea'] }] })).toEqual([])
    expect(warningsOf({ commands: [{ ...palette, eaReason: 'It arranges this browser' }] })).toEqual([])
    expect(warningsOf({ commands: [{ ...palette, for: ['agents'] }] })).toEqual([])
  })

  it('asks a route that changes something to name its command, or to say why not', () => {
    const command = { id: 'count', title: 'Count', for: ['palette', 'ea'] }
    const route = { method: 'POST', path: '/count' }
    expect(warningsOf({ commands: [command], routes: [route, { method: 'GET', path: '/read' }] })).toEqual([
      'The route POST /count names no command that does the same for the EA: set command, or say why in eaReason',
    ])
    expect(warningsOf({ commands: [command], routes: [{ ...route, command: 'count' }] })).toEqual([])
    expect(warningsOf({ routes: [{ ...route, eaReason: 'Only the user has seen the notes' }] })).toEqual([])
    const quiet = { ...command, for: ['agents'] }
    expect(warningsOf({ commands: [quiet], routes: [{ ...route, command: 'count' }] })).toEqual([
      'The route POST /count names the command count, which is not offered to the EA',
    ])
  })

  it('refuses a manifest whose route names a command the mod does not have', () => {
    const parsed = modManifest.safeParse(manifest({ routes: [{ method: 'POST', path: '/x', command: 'nope' }] }))
    expect(parsed.success ? null : parsed.error.issues[0]?.message).toBe('The route POST /x names no command nope')
  })

  it("writes each warning to the mod's log when the mod starts, and still starts it", async () => {
    const commands = [{ id: 'go', title: 'Go', for: ['palette'] }]
    const host = new ModHost([{ definition: { manifest: manifest({ commands }) }, tier: 'bundled' }])
    hosts.push(host)
    await host.setEnabled('reach', true)
    expect(host.get('reach')?.disposers).not.toBeNull()
    const lines = await modLogs.newest('reach', 10)
    expect(lines.map((line) => [line.level, line.line])).toContainEqual([
      'warn',
      'The command go is offered on the palette but not to the EA: add "ea" to its for, or say why in eaReason',
    ])
  })

  it('holds every bundled mod to it', () => {
    for (const folder of fs.readdirSync(MODS_DIR)) {
      const file = path.join(MODS_DIR, folder, 'seti-mod.json')
      if (fs.existsSync(file)) {
        const parsed = modManifest.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
        expect(modEaReachWarnings(parsed.contributes), folder).toEqual([])
      }
    }
  })
})
