import { manifestProblem, modManifest, type ModManifestInput } from '@seti/shared'
import { describe, expect, it } from 'vitest'

const base: ModManifestInput = {
  id: 'panels',
  name: 'Panels',
  version: '1.0.0',
  seti: '^1.9',
  description: 'Shows agents side by side',
}

const parse = (contributes: ModManifestInput['contributes']) => modManifest.safeParse({ ...base, contributes })
const issue = (contributes: ModManifestInput['contributes']) => {
  const parsed = parse(contributes)
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'invalid')
}
const task = { task: { type: 'string' as const } }

describe('layout, header and chord contributions', () => {
  it('takes a header command on an agent, and refuses one without a task argument', () => {
    expect(issue({ commands: [{ id: 'open', title: 'Open', args: task, for: ['agentHeader'] }] })).toBeNull()
    expect(issue({ commands: [{ id: 'open', title: 'Open', for: ['agentHeader'] }] })).toBe(
      "A command in an agent's header takes a task argument",
    )
  })

  it('takes Alt or Ctrl chords on commands without required arguments, and nothing else', () => {
    const chord = (value: string, args = {}) =>
      issue({ commands: [{ id: 'g', title: 'G', args, for: ['palette'], chord: value }] })
    expect(chord('Alt+G')).toBeNull()
    expect(chord('Ctrl+Shift+Left')).toBeNull()
    expect(chord('G')).toContain('A chord is Alt or Ctrl')
    expect(chord('Shift+G')).toContain('A chord is Alt or Ctrl')
    expect(chord('Alt+F4')).toContain('A chord is Alt or Ctrl')
    const asked = { name: { type: 'string' as const } }
    expect(chord('Alt+G', asked)).toBe('A chord runs a command with no required argument')
  })

  it('keeps layouts, shortcuts and workspace layouts to bundled mods', () => {
    const third = (input: Partial<ModManifestInput>) =>
      manifestProblem(modManifest.parse({ ...base, ...input }), 'third-party', new Set())
    const bundled = (input: Partial<ModManifestInput>) =>
      manifestProblem(modManifest.parse({ ...base, ...input }), 'bundled', new Set())
    const layout = { views: [{ id: 'grid', title: 'Grid', where: 'agentsLayout' as const, phone: false }] }
    const shortcuts = { shortcuts: [{ keys: 'Alt+Arrows', title: 'Move between panels', group: 'agents' as const }] }
    const capabilities = [{ name: 'workspaces.layout' as const }]
    expect(bundled({ contributes: { ...layout, ...shortcuts }, capabilities })).toBeNull()
    expect(third({ contributes: layout })).not.toBeNull()
    expect(third({ contributes: shortcuts })).not.toBeNull()
    expect(third({ capabilities })).toBe('Only mods bundled with Seti may ask for workspaces.layout')
  })

  it("refuses the grid's bundled-only points to a third-party mod, each with its reason", () => {
    const logic = { main: 'logic.js', activation: ['onCommand' as const] }
    const third = (input: Partial<ModManifestInput>) =>
      manifestProblem(modManifest.parse({ ...base, ...input }), 'third-party', new Set())
    const layout = { id: 'grid', title: 'Grid', where: 'agentsLayout' as const, phone: false, entry: 'grid.html' }
    expect(third({ contributes: { views: [layout] } })).toContain('agentsLayout')
    expect(
      third({ ...logic, contributes: { commands: [{ id: 'g', title: 'Grid', for: ['palette'], chord: 'Alt+G' }] } }),
    ).toBe('Grid binds a key chord, which only mods Seti ships do')
    expect(
      third({ ...logic, contributes: { commands: [{ id: 'o', title: 'Open', args: task, for: ['agentHeader'] }] } }),
    ).toBe('Open sits in the agent header, which only mods Seti ships add to')
    expect(third({ contributes: { routes: [{ method: 'GET', path: '/layouts' }] } })).toContain('routes')
    expect(
      third({ ...logic, contributes: { commands: [{ id: 'o', title: 'Open', args: task, for: ['palette'] }] } }),
    ).toBeNull()
  })
})
