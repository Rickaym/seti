import type { WorkspaceGrid } from '@seti/mod-api'
import { describe, expect, it } from 'vitest'
import type { Panel } from './grid-layout'
import { EMPTY_LAYOUT, mergeServer, type CachedLayout } from './grid-sync'

const panel = (i: string, agent: string | null, x: number, w = 6): Panel => ({ i, agent, x, y: 0, w, h: 24 })

const PAIR = [panel('p1', 'a', 0), panel('p2', 'b', 6)]

const local = (extra: Partial<CachedLayout> = {}): CachedLayout => ({
  ...EMPTY_LAYOUT,
  panels: PAIR,
  focused: 'p2',
  recent: ['b', 'a'],
  revision: 3,
  ...extra,
})

const row = (workspace_id: string, panels: readonly Panel[], revision: number, locked = false): WorkspaceGrid => ({
  workspace_id,
  layout: { panels: [...panels], locked, perScreen: null },
  revision,
  updated_at: '2026-10-13T10:00:00.000Z',
})

const NONE = new Set<string>()

describe('mergeServer', () => {
  it("takes another device's grid, keeping this device's focus while its panel is there", () => {
    const merged = mergeServer({ w1: local() }, [row('w1', [panel('p2', 'b', 0, 12)], 4, true)], NONE)
    expect(merged.layouts.w1).toEqual({
      panels: [panel('p2', 'b', 0, 12)],
      locked: true,
      perScreen: null,
      focused: 'p2',
      recent: ['b', 'a'],
      revision: 4,
      dirty: false,
    })
    expect(merged.changed).toEqual(new Set(['w1']))
    const moved = mergeServer({ w1: local() }, [row('w1', [panel('p9', 'c', 0)], 5)], NONE)
    expect(moved.layouts.w1?.focused).toBe('p9')
  })

  it('keeps the grid it has when the revision is the same, and changes nothing', () => {
    const own = local()
    const merged = mergeServer({ w1: own }, [row('w1', [], 3)], NONE)
    expect(merged.layouts.w1).toBe(own)
    expect(merged.changed.size).toBe(0)
  })

  it('keeps an edit not yet saved and a grid the user is arranging', () => {
    const dirty = local({ dirty: true })
    const held = local({ revision: 1 })
    const rows = [row('w1', [], 9), row('w2', [], 9)]
    const merged = mergeServer({ w1: dirty, w2: held }, rows, new Set(['w2']))
    expect(merged.layouts).toEqual({ w1: dirty, w2: held })
    expect(merged.changed.size).toBe(0)
  })

  it('sends up a grid the server never had from here, once, when the server has none', () => {
    const legacy = local({ revision: 0 })
    const merged = mergeServer({ w1: legacy, w2: local({ revision: 0, panels: [] }) }, [], NONE)
    expect(merged.layouts).toEqual({ w1: { ...legacy, dirty: true } })
    expect(merged.changed).toEqual(new Set(['w1', 'w2']))
    expect(mergeServer({ w1: legacy }, [row('w1', [], 1)], NONE).layouts.w1).toMatchObject({ panels: [], revision: 1 })
  })

  it('drops a saved grid the server no longer has and takes grids new to this device', () => {
    const merged = mergeServer({ gone: local() }, [row('new', PAIR, 2)], NONE)
    expect(Object.keys(merged.layouts)).toEqual(['new'])
    expect(merged.layouts.new).toMatchObject({ panels: PAIR, focused: 'p1', recent: [], revision: 2 })
  })

  it('settles a stored grid whose panels overlap', () => {
    const merged = mergeServer({}, [row('w1', [panel('p1', 'a', 0), panel('p2', 'b', 3)], 1)], NONE)
    const [first, second] = merged.layouts.w1?.panels ?? []
    expect(first).toEqual(panel('p1', 'a', 0))
    expect(second?.y).toBe(24)
  })
})
